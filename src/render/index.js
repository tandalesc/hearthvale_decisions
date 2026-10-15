import * as THREE from 'three';
import { heightAt, terrainSeed } from '../terrain.js';
import { createGrade } from './grade.js';
import { TIERS, guessTier, createAutoTuner, loadQualityOverride, saveQualityOverride } from './quality.js';
import { createLights } from './lights.js';
import { createSky } from './sky.js';
import { createRoadSplat } from './roads.js';
import { createTerrain } from './terrain.js';
import { createGround } from './ground.js';
import { createWater } from './water.js';
import { createBuildings } from './buildings.js';
import { createCameraRig } from './camera.js';
import { createPicking } from './picking.js';
import { createPost } from './post.js';
import { createPeople } from './people.js';
import { createTrees } from './trees.js';
import { createDecals } from './decals.js';
import { createParticles } from './particles.js';
import { createProps } from './props.js';
import { createLabels } from './labels.js';

// Hearthvale renderer: createWorld (contract §6). The UI owns the main loop
// and calls world.update(view, timeSeconds, dtSeconds) every animation frame;
// the world decides whether a frame is worth drawing (battery, §4.8).

const OVERLAYS = { none: 0, value: 1, roads: 2, health: 3 };

export function createWorld(canvas, { quality = 'auto' } = {}) {
  const requested = quality === 'auto' ? loadQualityOverride() : quality;
  const probe = canvas.getContext('webgl2', { antialias: true, powerPreference: 'default' });
  let tierName = requested === 'auto' ? guessTier(probe) : requested;
  let tier = { ...TIERS[tierName] };
  let qualityMode = requested;

  const renderer = new THREE.WebGLRenderer({ canvas, context: probe ?? undefined, antialias: true, powerPreference: 'default' });
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.info.autoReset = false;
  renderer.setClearColor('#c9dccb');

  const scene = new THREE.Scene();
  scene.fog = new THREE.Fog('#c9dccb', 150, 440);
  const rig = createCameraRig(canvas);
  const camera = rig.camera;
  scene.add(camera);

  const grade = createGrade();
  // Ground height (terrain + building pads) is shared by every shader through
  // the grade uniforms, and by CPU placement through ground.sample.
  const ground = createGround();
  Object.assign(grade.uniforms, ground.uniforms);
  const lights = createLights({ renderer, scene, grade });
  const sky = createSky({ scene, grade });
  const roads = createRoadSplat();
  let terrain = createTerrain({ scene, grade, roads, quality: tier });
  let water = createWater({ renderer, scene, grade, quality: tier });
  let builtSeed = terrainSeed();
  const buildings = createBuildings({ scene, grade, lights, ground });
  const ctx = {
    renderer, scene, camera, grade, lights, roads, buildings, ground, heightAt: ground.sample, quality: tier,
    townCentre: null, canvas, rig, labelsOn: true,
  };
  rig.setGround(ground.sample);
  const people = createPeople(ctx);
  let trees = createTrees(ctx);
  let decals = createDecals(ctx);
  const particles = createParticles(ctx);
  const props = createProps(ctx);
  const labels = createLabels(ctx);
  const systems = [people, trees, decals, particles, props, labels];

  /**
   * The sim seeds the terrain when it creates or restores a town. If that
   * happens after the world was built (loading a save in place), rebuild
   * everything shaped by the ground: terrain, water, heights, trees, decals.
   */
  function rebuildTerrain() {
    builtSeed = terrainSeed();
    scene.remove(terrain.group);
    for (const m of terrain.meshes) m.geometry.dispose();
    terrain = createTerrain({ scene, grade, roads, quality: tier });
    scene.remove(water.mesh);
    water.mesh.geometry.dispose();
    water.dispose();
    water = createWater({ renderer, scene, grade, quality: tier });
    ground.rebuild();
    trees.dispose();
    decals.dispose();
    trees = createTrees(ctx);
    decals = createDecals(ctx);
    systems[1] = trees;
    systems[2] = decals;
    lights.markDirty();
    homed = false;
  }
  /** Rebuild trees (and the decals that mirror them) for a new town centre. */
  function regrowForest() {
    trees.dispose();
    decals.dispose();
    trees = createTrees(ctx);
    decals = createDecals(ctx);
    systems[1] = trees;
    systems[2] = decals;
    trees.applyQuality?.(tier);
    decals.applyQuality?.(tier);
    lights.markDirty();
  }

  const picking = createPicking({ canvas, camera, buildings, people, ground });
  const post = createPost(renderer);
  const focusNdc = new THREE.Vector3();

  const tuner = createAutoTuner();
  const frame = { time: 0, dt: 0, camera, target: rig.controls.target, distance: 100, tier: tierName };
  const statsState = { fps: 0, frameMs: 0, drawCalls: 0, triangles: 0, frames: 0, windowStart: 0, renderMs: 0 };
  // Smoothed CPU ms per stage, for stats().cpu.
  const cpu = { grade: 0, roads: 0, buildings: 0, people: 0, trees: 0, decals: 0, particles: 0, props: 0, labels: 0, lights: 0, render: 0 };
  const SYSTEM_NAMES = ['people', 'trees', 'decals', 'particles', 'props', 'labels'];
  let mark = 0;
  const lap = (key) => {
    const now = performance.now();
    cpu[key] = cpu[key] * 0.9 + (now - mark) * 0.1;
    mark = now;
  };
  let lastRender = -1;
  let lastYearT = null;
  let forceFrame = true;
  let dayCycle = 'seasonal';
  let disposed = false;
  let lastView = null;
  let homed = false;
  let simSpeed = null; // set by setSimSpeed; null = infer pausing from view.time
  let paced = false; // true while drawing below full rate (paused, idle, battery)
  // Reduced motion: the app's Motion setting ORed with the system preference.
  let reducedSetting = false;
  const reducedQuery = typeof matchMedia === 'function' ? matchMedia('(prefers-reduced-motion: reduce)') : null;
  const syncReduced = () => {
    ctx.reducedMotion = reducedSetting || !!reducedQuery?.matches;
    forceFrame = true;
  };
  reducedQuery?.addEventListener?.('change', syncReduced);
  syncReduced();
  let footVersion = -1; // buildings.version() last rasterised into the road mask
  const homePoint = { x: -20, z: 4 };

  /**
   * Frame the town: the median building position (robust to outlying farms)
   * and the radius that holds 80 % of buildings.
   */
  function townCentre(list) {
    if (!list?.length) return null;
    const xs = list.map((b) => b.x).sort((a, b) => a - b);
    const zs = list.map((b) => b.z).sort((a, b) => a - b);
    const x = xs[xs.length >> 1];
    const z = zs[zs.length >> 1];
    const ds = list.map((b) => Math.hypot(b.x - x, b.z - z)).sort((a, b) => a - b);
    return { x, z, radius: ds[Math.floor(ds.length * 0.8)] + 12 };
  }

  function applyQuality() {
    tier = { ...TIERS[tierName] };
    ctx.quality = tier;
    frame.tier = tierName;
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, tier.pixelRatio));
    lights.applyQuality(tier);
    terrain.applyQuality(tier);
    water.applyQuality(tier);
    buildings.applyQuality(tier);
    for (const s of systems) s.applyQuality?.(tier);
    resize();
    forceFrame = true;
  }

  function resize() {
    const rect = canvas.getBoundingClientRect();
    const w = Math.max(1, Math.round(rect.width || canvas.clientWidth || 1));
    const h = Math.max(1, Math.round(rect.height || canvas.clientHeight || 1));
    renderer.setSize(w, h, false);
    rig.resize(w, h);
    forceFrame = true;
  }
  // Low battery (where the Battery API exists): discharging below 20 % forces
  // the low tier in auto mode and caps drawing at 30 Hz.
  let lowBattery = false;
  navigator.getBattery?.().then((battery) => {
    const check = () => {
      const low = !battery.charging && battery.level < 0.2;
      if (low === lowBattery) return;
      lowBattery = low;
      if (qualityMode === 'auto') {
        tierName = low ? 'low' : guessTier(renderer.getContext());
        applyQuality();
      }
    };
    battery.addEventListener('levelchange', check);
    battery.addEventListener('chargingchange', check);
    check();
  }).catch(() => {});

  const resizeObserver = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(resize) : null;
  resizeObserver?.observe(canvas);
  applyQuality();
  rig.home();

  /** Decide whether this animation frame should draw (battery rules). */
  function wantFrame(view, time, moved) {
    paced = false;
    if (forceFrame || moved || rig.isTweening()) return true;
    const since = time - lastRender;
    const yearT = view?.time?.yearT ?? 0;
    const paused = simSpeed !== null ? simSpeed === 0 : lastYearT !== null && yearT === lastYearT;
    const idleFor = (performance.now() - rig.lastInput()) / 1000;
    paced = true;
    if (paused && idleFor > 2) return since >= 1.0; // ambient only, once a second
    if (idleFor > 20 && (simSpeed ?? 1) <= 1) return since >= 1 / 30 - 0.002; // idle cap at 1x
    if (lowBattery) return since >= 1 / 30 - 0.002;
    paced = false;
    return since >= 1 / tier.maxFps - 0.002;
  }

  function update(view, time, dt) {
    if (disposed) return;
    const t0 = performance.now();
    lastView = view;
    if (terrainSeed() !== builtSeed) rebuildTerrain();
    if (!homed && view?.buildings?.length) {
      homed = true;
      Object.assign(homePoint, townCentre(view.buildings));
      rig.setTownRadius(homePoint.radius);
      // Woods thin out around the real town centre: regrow them once it is known.
      const known = ctx.townCentre;
      if (!known || Math.hypot(known.x - homePoint.x, known.z - homePoint.z) > 20) {
        ctx.townCentre = { x: homePoint.x, z: homePoint.z };
        regrowForest();
      }
      rig.home(homePoint.x, homePoint.z);
    }
    const moved = rig.update(dt);
    if (!wantFrame(view, time, moved)) {
      lastYearT = view?.time?.yearT ?? lastYearT;
      return;
    }
    const frameDt = lastRender < 0 ? dt : Math.min(0.25, time - lastRender);
    lastRender = time;
    lastYearT = view?.time?.yearT ?? lastYearT;
    forceFrame = false;

    frame.time = time;
    frame.dt = frameDt;
    frame.paused = simSpeed === 0;
    // Decorative clock: sails, sway, boats and flags hold still under reduced motion.
    if (!ctx.reducedMotion) grade.uniforms.uDecoTime.value += frameDt;
    frame.distance = rig.distance();

    mark = performance.now();
    grade.update(view, time, frameDt);
    grade.apply({ renderer, scene, hemi: lights.hemi, sun: lights.sun });
    // Fog is atmosphere for the horizon: keep it beyond the town when zoomed out.
    const fogPush = Math.max(0, frame.distance - 110);
    scene.fog.near += fogPush;
    scene.fog.far += fogPush * 1.2;
    renderer.setClearColor(scene.fog.color);
    sky.update(time, renderer.getPixelRatio(), rig.controls.target);
    lap('grade');
    if (view?.roads) roads.update(view.roads, time);
    lap('roads');
    if (view) buildings.update(view, time);
    // Roads stop at doorsteps: refresh the footprint mask when lots change.
    if (buildings.version() !== footVersion && roads.setFootprints(buildings.lots)) footVersion = buildings.version();
    lap('buildings');
    for (let i = 0; i < systems.length; i++) {
      systems[i].update(view, frame);
      lap(SYSTEM_NAMES[i]);
    }
    buildings.events.length = 0;
    ground.flush(time);
    lights.update(rig.controls.target, frame.distance, time);
    lap('lights');

    renderer.info.reset();
    water.setEmbankments(view?.embankments);
    water.beforeRender(camera);
    if (tier.post) {
      // Keep the tilt-shift focus band on the view target, wherever the UI
      // insets have moved it on screen.
      focusNdc.copy(rig.controls.target).project(camera);
      post.render(scene, camera, time, THREE.MathUtils.clamp(focusNdc.y * 0.5 + 0.5, 0.25, 0.75));
    } else {
      renderer.render(scene, camera);
    }
    lap('render');

    const ms = performance.now() - t0;
    statsState.frameMs = statsState.frameMs * 0.9 + ms * 0.1;
    statsState.drawCalls = renderer.info.render.calls;
    statsState.triangles = renderer.info.render.triangles;
    statsState.frames++;
    if (time - statsState.windowStart >= 1) {
      statsState.fps = statsState.frames / (time - statsState.windowStart);
      statsState.frames = 0;
      statsState.windowStart = time;
    }
    // Auto tier: measure the real animation-frame interval, only at full rate.
    if (qualityMode === 'auto' && !paced) {
      const next = tuner.sample(dt * 1000, tierName);
      if (next && !lowBattery) { tierName = next; applyQuality(); }
    }
  }

  function setQuality(mode) {
    qualityMode = mode;
    saveQualityOverride(mode);
    if (mode === 'auto') {
      tierName = guessTier(renderer.getContext());
      tuner.reset();
    } else {
      tierName = mode;
    }
    applyQuality();
  }

  return {
    update,
    setQuality,
    quality: () => tierName,
    setDayCycle(mode) {
      dayCycle = mode;
      grade.setMode(mode);
      if (mode === 'slow') grade.resetDay(frame.time);
      forceFrame = true;
    },
    dayCycle: () => dayCycle,
    setOverlay(mode) {
      grade.uniforms.uOverlay.value = OVERLAYS[mode] ?? 0;
      forceFrame = true;
    },
    focus(point, ms = 900) {
      rig.focus(point, ms);
      forceFrame = true;
    },
    onPick(cb) {
      picking.onPick(cb, () => ({ view: lastView, time: frame.time }));
    },
    /**
     * Highlight a person ({personId}: floating marker over their head) or a
     * building ({buildingId}: gentle brightening); null clears both.
     */
    select(target) {
      // The owner asked to drop selection indicators for now: keep the API,
      // draw nothing (no head marker, no building brightening).
      void target;
      people.setSelected(null);
      buildings.setSelected?.(null);
      forceFrame = true;
    },
    /**
     * Reduced motion (ORed with prefers-reduced-motion): no weather particles
     * or birds; sails, tree sway, boats and flags hold still. The grade,
     * seasons and walkers are unchanged.
     */
    setReducedMotion(on) {
      reducedSetting = !!on;
      syncReduced();
    },
    /** Show or hide world-space name labels (clean view, title cards). */
    setLabelsVisible(on) {
      ctx.labelsOn = !!on;
      forceFrame = true;
    },
    /** The orbit target on the ground: {x, z} (for 'which centre am I over'). */
    cameraTarget() {
      const t = rig.controls.target;
      return { x: t.x, z: t.z };
    },
    /** Keep the camera on a walker (eased); null, a pan or focus() stops it. */
    follow(personId) {
      if (personId == null) {
        rig.follow(null);
      } else {
        // Aim at the body's middle so the walker sits in the frame centre.
        rig.follow((out) => {
          if (!people.positionOf(personId, frame.time, out)) return false;
          out.y += 1;
          return true;
        });
      }
      forceFrame = true;
    },
    stats() {
      return {
        fps: Math.round(statsState.fps * 10) / 10,
        frameMs: Math.round(statsState.frameMs * 100) / 100,
        drawCalls: statsState.drawCalls,
        triangles: statsState.triangles,
        tier: tierName,
        buildings: buildings.lots.size,
        instances: buildings.instanceCount(),
        people: people.count?.() ?? 0,
        cpu: Object.fromEntries(Object.entries(cpu).map(([k, v]) => [k, Math.round(v * 100) / 100])),
      };
    },
    /** Tell the renderer the sim speed (0 = paused) for battery pacing. */
    setSimSpeed(speed) {
      if (speed !== simSpeed) forceFrame = true;
      simSpeed = speed;
    },
    setSceneInsets(insets) {
      rig.setInsets(insets);
      forceFrame = true;
    },
    /** Extras for the UI and tests. */
    resize,
    home: () => { rig.home(homePoint.x, homePoint.z); forceFrame = true; },
    projectPoint(x, z) {
      const v = new THREE.Vector3(x, heightAt(x, z), z).project(camera);
      const r = canvas.getBoundingClientRect();
      return { x: (v.x * 0.5 + 0.5) * r.width, y: (-v.y * 0.5 + 0.5) * r.height };
    },
    requestFrame: () => { forceFrame = true; },
    debug() {
      const u = grade.uniforms;
      return {
        grade: Object.fromEntries(Object.entries(u).map(([k, v]) => [k, v.value?.toArray ? v.value.toArray() : v.value])),
        lastRender, shadowRadius: lights.radius(), distance: frame.distance,
      };
    },
    camera: rig,
    /** Dev and test access (not part of the contract). */
    get internals() {
      return { scene, renderer, grade, lights, buildings, water, terrain, ground };
    },
    dispose() {
      disposed = true;
      resizeObserver?.disconnect();
      picking.dispose();
      rig.dispose();
      water.dispose();
      post.dispose();
      for (const s of systems) s.dispose?.();
      scene.traverse((o) => {
        o.geometry?.dispose?.();
        const m = o.material;
        for (const mm of Array.isArray(m) ? m : m ? [m] : []) mm.dispose();
      });
      renderer.dispose();
    },
  };
}
