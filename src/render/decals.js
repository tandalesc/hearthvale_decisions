import * as THREE from 'three';
import { patchMaterial, hashId, NOISE } from './shaderlib.js';
import { GROUND_GLSL } from './ground.js';
import { GROUND_AO, GROUND_AO_GLSL, bakeOcclusionSteps, setGroundField, aoDayFactor, bakedWeights } from './occlusion.js';

// Ground decals (design-visual §3.3, §6): what sells "sitting on the table".
//   1. Contact shadows under every building (multiply blend, terrain-following
//      grid so slopes never show a floating edge).
//   2. Contact blobs under every tree (multiply blend, one flat quad each).
//   3. Coloured ground: park lawns with gravel paths, flower gardens for
//      wealthy homes, dirt-and-plank yards around construction (lit Lambert).
//      On High the denser-woods trees, which skip the shadow map, draw a
//      soft cast shadow here instead: an ellipse thrown away from the sun.
// Three draw calls. Instances are rebuilt only when lots change, and so is
// the baked ground occlusion field (occlusion.js) the terrain multiplies in.

// Ground height from the shared height texture (terrain.js), so decals follow
// any terrain seed. Lots and trees never sit in the channel; clamp above water.
const HEIGHT_GLSL = /* glsl */ `
${GROUND_GLSL}
float landHeight(vec2 p) {
  return max(groundHeight(p), 0.03);
}
`;

// Era fill (share of the lot the body covers), as in kit/styles.js.
const FILL = [0.7, 0.76, 0.86, 0.94, 0.94, 0.9];
const KIND = { PARK: 0, GARDEN: 1, YARD: 2 };

// ---------------------------------------------------------------------------
// Multiply-blended contact shadows

const CONTACT_VERT = /* glsl */ `
attribute vec3 iCenter;   // x, ground y (flat quads), z
attribute vec4 iShape;    // half x, half z, strength, chop start time (trees)
                          // (strength < 0: a cast shadow, see below)
uniform float uTime;
uniform vec3 uSunDir;
uniform float uNight;
varying vec2 vLocal;
varying vec2 vHalf;
varying float vStrength;
varying float vFogDepth;
${HEIGHT_GLSL}
void main() {
  #ifdef FOLLOW_TERRAIN
    // Grid spans the footprint plus a soft margin; vertices hug the land.
    vec2 margin = vec2(0.6) + 0.35 * min(iShape.x, iShape.y);
    vec2 local = position.xz * (iShape.xy + margin);
    vec3 world = vec3(iCenter.x + local.x, 0.0, iCenter.z + local.y);
    world.y = landHeight(world.xz) + 0.05;
  #else
    vec2 local = position.xz * iShape.xy;
    vec3 world = vec3(iCenter.x + local.x, iCenter.y + 0.06, iCenter.z + local.y);
    float castK = step(iShape.z, 0.0);
    vec2 halfV = iShape.xy;
    if (castK > 0.5) {
      // A tree that does not draw into the shadow map (the denser woods on
      // High): its crown's shadow as a soft ellipse thrown away from the sun,
      // from the trunk outward, longer as the sun sinks.
      vec2 away = -normalize(uSunDir.xz + vec2(1e-4));
      float crownH = 3.4 * iShape.x / 2.3;
      float reach = crownH * clamp(sqrt(1.0 - uSunDir.y * uSunDir.y) / max(uSunDir.y, 0.2), 0.0, 4.0);
      float halfL = iShape.x * 0.85 + reach * 0.5;
      vec2 side = vec2(-away.y, away.x);
      halfV = vec2(halfL, iShape.y * 0.9);
      local = position.xz * halfV;
      vec2 xz = iCenter.xz + away * (reach * 0.55) + away * local.x + side * local.y;
      world = vec3(xz.x, iCenter.y + 0.06, xz.y);
    }
    // Drape on the shared ground where it exists (slopes, building pads).
    vec2 gHi = uGroundOrigin + (uGroundN - 2.0) * uGroundStep;
    if (all(greaterThan(world.xz, uGroundOrigin + 1.0)) && all(lessThan(world.xz, gHi))) {
      world.y = landHeight(world.xz) + 0.06;
    }
  #endif
  vLocal = local;
  vHalf = iShape.xy;
  #ifndef FOLLOW_TERRAIN
    vHalf = halfV;
  #endif
  // Chopped trees lose their blob as they fall.
  float chop = iShape.w != 0.0 ? clamp((uTime - iShape.w) / 0.6, 0.0, 1.0) : 0.0;
  vStrength = abs(iShape.z) * (1.0 - chop);
  #ifndef FOLLOW_TERRAIN
    // Cast shadows follow the sun: gone at night and with the sun at the horizon.
    if (castK > 0.5) vStrength *= (1.0 - 0.85 * uNight) * smoothstep(0.03, 0.15, uSunDir.y);
  #endif
  vec4 mv = viewMatrix * vec4(world, 1.0);
  vFogDepth = -mv.z;
  gl_Position = projectionMatrix * mv;
}
`;

const CONTACT_FRAG = /* glsl */ `
uniform float fogNear;
uniform float fogFar;
varying vec2 vLocal;
varying vec2 vHalf;
varying float vStrength;
varying float vFogDepth;
void main() {
  float shade;
  #ifdef FOLLOW_TERRAIN
    // Rounded-rect signed distance to the footprint, soft falloff outside.
    vec2 q = abs(vLocal) - vHalf + 0.4;
    float d = length(max(q, 0.0)) + min(max(q.x, q.y), 0.0) - 0.4;
    float fall = 0.5 + 0.28 * min(vHalf.x, vHalf.y);
    shade = 1.0 - smoothstep(-0.3, fall, d);
    shade *= shade;
  #else
    // Round blob, darkest under the trunk.
    float r = length(vLocal / vHalf);
    shade = 1.0 - smoothstep(0.15, 1.0, r);
  #endif
  float fogK = smoothstep(fogNear, fogFar, vFogDepth);
  float k = 1.0 - vStrength * shade * (1.0 - fogK);
  if (k > 0.995) discard;
  // Multiply blending: the framebuffer is scaled by this colour.
  gl_FragColor = vec4(vec3(k), 1.0);
}
`;

function contactMaterial(grade, followTerrain) {
  return new THREE.ShaderMaterial({
    uniforms: {
      ...THREE.UniformsUtils.clone(THREE.UniformsLib.fog),
      uTime: grade.uniforms.uTime,
      uSunDir: grade.uniforms.uSunDir,
      uNight: grade.uniforms.uNight,
      tGround: grade.uniforms.tGround,
      uGroundOrigin: grade.uniforms.uGroundOrigin,
      uGroundStep: grade.uniforms.uGroundStep,
      uGroundN: grade.uniforms.uGroundN,
    },
    vertexShader: CONTACT_VERT,
    fragmentShader: CONTACT_FRAG,
    defines: followTerrain ? { FOLLOW_TERRAIN: 1 } : {},
    transparent: true,
    depthWrite: false,
    blending: THREE.MultiplyBlending,
    premultipliedAlpha: true,
    toneMapped: false,
    fog: true,
    polygonOffset: true,
    polygonOffsetFactor: -2,
    polygonOffsetUnits: -4,
  });
}

/** Flat grid in [-1, 1]^2 on the xz plane (normals up). */
function gridGeometry(segments) {
  const plane = new THREE.PlaneGeometry(2, 2, segments, segments);
  plane.rotateX(-Math.PI / 2);
  const g = new THREE.InstancedBufferGeometry();
  g.index = plane.index;
  g.setAttribute('position', plane.attributes.position);
  g.setAttribute('normal', plane.attributes.normal);
  g.setAttribute('uv', plane.attributes.uv);
  return g;
}

/** Growable instanced attribute set on an InstancedBufferGeometry. */
function instanceSet(geometry, layout, capacity) {
  const set = { capacity: 0, attrs: {} };
  set.ensure = (n) => {
    if (n <= set.capacity) return;
    const cap = Math.max(16, Math.ceil(n * 1.5));
    for (const [name, size] of layout) {
      const old = set.attrs[name];
      const a = new THREE.InstancedBufferAttribute(new Float32Array(cap * size), size);
      if (old) a.array.set(old.array.subarray(0, Math.min(old.array.length, a.array.length)));
      a.setUsage(THREE.DynamicDrawUsage);
      geometry.setAttribute(name, a);
      set.attrs[name] = a;
    }
    set.capacity = cap;
    // Three caches the drawable instance limit per geometry; reset it on growth.
    geometry._maxInstanceCount = undefined;
  };
  set.ensure(capacity);
  set.commit = (count) => {
    geometry.instanceCount = count;
    set.mesh && (set.mesh.visible = count > 0);
    for (const a of Object.values(set.attrs)) {
      a.clearUpdateRanges();
      a.needsUpdate = true;
    }
  };
  return set;
}

// ---------------------------------------------------------------------------
// Coloured ground decals (lit)

const COLOR_HEAD = /* glsl */ `
attribute vec3 iCenter;
attribute vec4 iDecal;   // half x, half z, kind, seed
attribute vec3 iColor;
varying vec2 vDecalLocal;
varying vec2 vDecalWorld;
varying vec4 vDecal;
varying vec3 vDecalColor;
${HEIGHT_GLSL}
`;

const COLOR_FRAG_HEAD = /* glsl */ `
varying vec2 vDecalLocal;
varying vec2 vDecalWorld;
${GROUND_AO_GLSL}
varying vec4 vDecal;
varying vec3 vDecalColor;
${NOISE}
float rrect(vec2 p, vec2 h, float r) {
  vec2 q = abs(p) - h + r;
  return length(max(q, 0.0)) + min(max(q.x, q.y), 0.0) - r;
}
`;

const COLOR_FRAG = /* glsl */ `
  vec2 L = vDecalLocal;
  vec2 H = vDecal.xy;
  float kind = vDecal.z;
  float seed = vDecal.w;
  float d = rrect(L, H, 0.9);
  float m = vnoise(L * 0.7 + seed * 31.0);
  vec3 col = vDecalColor;
  float alpha = 0.0;
  if (kind < 0.5) {
    // Park: mown lawn with a gravel cross and a ring path around the centre.
    alpha = 1.0 - smoothstep(-0.5, 0.15, d);
    col *= 0.92 + 0.14 * m;
    // Mowing stripes, very faint.
    col *= 1.0 + 0.035 * sign(sin(L.x * 1.4));
    float R = min(H.x, H.y) * 0.42;
    float path = min(min(abs(L.x), abs(L.y)), abs(length(L) - R));
    float onPath = 1.0 - smoothstep(0.7, 0.9, path + (m - 0.5) * 0.2);
    // A darker clipped-hedge rim frames the lawn.
    col *= 1.0 - 0.22 * smoothstep(-0.9, -0.4, d);
    vec3 gravel = vec3(0.66, 0.56, 0.36) * (0.9 + 0.2 * hash12(floor(L * 5.0)));
    col = mix(col, gravel, onPath);
  } else if (kind < 1.5) {
    // Cottage garden: brighter grass with dots of flowers, soft edges.
    alpha = (1.0 - smoothstep(-1.2, 0.1, d)) * 0.75;
    col *= 0.9 + 0.2 * m;
    vec2 cell = floor(L * 2.2);
    vec2 f = fract(L * 2.2) - 0.5;
    float h = hash12(cell + seed * 17.0);
    float dot = (1.0 - smoothstep(0.16, 0.26, length(f + (vec2(hash12(cell + 3.1), hash12(cell + 7.7)) - 0.5) * 0.4))) * step(0.55, h);
    vec3 flower = h < 0.66 ? vec3(0.80, 0.30, 0.42) : h < 0.77 ? vec3(0.86, 0.70, 0.18) : h < 0.88 ? vec3(0.88, 0.84, 0.80) : vec3(0.42, 0.34, 0.70);
    col = mix(col, flower, dot * (1.0 - uSnow));
    alpha = max(alpha, dot * (1.0 - smoothstep(-0.8, 0.0, d)));
  } else {
    // Building yard: trodden dirt, a stack of planks in one corner.
    alpha = (1.0 - smoothstep(-1.0, 0.2, d + (m - 0.5) * 1.2)) * 0.85;
    col *= 0.85 + 0.25 * m;
    vec2 c = L - vec2(H.x - 1.6, H.y - 1.2) * (seed < 0.5 ? 1.0 : -1.0);
    float planks = step(abs(c.x), 1.0) * step(abs(c.y), 0.55) * step(0.25, fract(c.y * 3.6));
    col = mix(col, vec3(0.52, 0.38, 0.22), planks);
  }
  // Snow covers lawns and yards like the terrain around them.
  col = mix(col, vec3(0.90, 0.92, 0.94), smoothstep(0.25, 0.8, uSnow) * 0.9);
  if (alpha < 0.01) discard;
  // Lawns and gardens hug the walls: they take the ground's occlusion too.
  col *= groundOcclusion(vDecalWorld);
  diffuseColor = vec4(col * uTint, alpha);
`;

function colorMaterial(grade) {
  const material = new THREE.MeshLambertMaterial({
    transparent: true,
    depthWrite: false,
    polygonOffset: true,
    polygonOffsetFactor: -1,
    polygonOffsetUnits: -2,
  });
  patchMaterial(material, grade, {
    key: 'decal-color',
    uniforms: GROUND_AO,
    vertexHead: COLOR_HEAD,
    vertexBegin: /* glsl */ `
      vec2 decalLocal = position.xz * iDecal.xy;
      transformed = vec3(iCenter.x + decalLocal.x, 0.0, iCenter.z + decalLocal.y);
      transformed.y = landHeight(transformed.xz) + 0.04;
      vDecalLocal = decalLocal;
      vDecalWorld = transformed.xz;
      vDecal = iDecal;
      vDecalColor = iColor;
    `,
    fragmentHead: COLOR_FRAG_HEAD,
    fragmentColor: COLOR_FRAG,
  });
  return material;
}

// ---------------------------------------------------------------------------
// System

const LAWN = new THREE.Color('#8fbb5f');
const GARDEN = new THREE.Color('#a8c972');
const YARD = new THREE.Color('#9c8460');

export function createDecals(ctx) {
  const { scene, grade } = ctx;
  const group = new THREE.Group();
  group.name = 'decals';
  scene.add(group);

  // Building contact shadows.
  const lotGeo = gridGeometry(4);
  const lotSet = instanceSet(lotGeo, [['iCenter', 3], ['iShape', 4]], 256);
  const lotMesh = new THREE.Mesh(lotGeo, contactMaterial(grade, true));
  // Tree blobs.
  const blobGeo = gridGeometry(2);
  const blobSet = instanceSet(blobGeo, [['iCenter', 3], ['iShape', 4]], 16);
  const blobMesh = new THREE.Mesh(blobGeo, contactMaterial(grade, false));
  // Coloured ground.
  const colorGeo = gridGeometry(6);
  const colorSet = instanceSet(colorGeo, [['iCenter', 3], ['iDecal', 4], ['iColor', 3]], 64);
  const colorMesh = new THREE.Mesh(colorGeo, colorMaterial(grade));
  colorMesh.receiveShadow = true;

  // Coloured ground first, then darkening on top of it.
  colorMesh.renderOrder = 1;
  lotMesh.renderOrder = 1.1;
  blobMesh.renderOrder = 1.1;
  for (const m of [colorMesh, lotMesh, blobMesh]) {
    m.frustumCulled = false;
    m.castShadow = false;
    group.add(m);
  }
  lotSet.mesh = lotMesh;
  blobSet.mesh = blobMesh;
  colorSet.mesh = colorMesh;
  lotGeo.instanceCount = 0;
  blobGeo.instanceCount = 0;
  colorGeo.instanceCount = 0;

  let lastVersion = -1;
  let lastSig = 0;
  let lastCheck = -1;
  let blobsBuilt = false;
  let lastChop = -1;
  let keep = 1;
  let quality = ctx.quality;
  // Baked ground occlusion: rebuilt when footprints change, at most once a
  // second while a town grows (a bake of a large city takes a few ms).
  let aoVersion = -1;
  let aoAt = -Infinity;
  let aoForest = null;

  /** Body footprint estimate (centre and half extents) for a lot summary. */
  function bodies(s, out) {
    out.length = 0;
    const fill = FILL[Math.max(0, Math.min(5, s.era | 0))];
    const rot = s.rot | 0;
    const lw = rot % 2 ? s.d : s.w;
    const ld = rot % 2 ? s.w : s.d;
    const a = rot * Math.PI / 2;
    const ca = Math.cos(a), sa = Math.sin(a);
    const add = (lx, lz, hw, hd) => {
      // Local half extents back to world axes (rot swaps them on odd turns).
      out.push([s.x + lx * ca + lz * sa, s.z - lx * sa + lz * ca, rot % 2 ? hd : hw, rot % 2 ? hw : hd]);
    };
    if (s.type === 'park' || s.type === 'bridge') return out;
    if (s.type === 'farm') {
      const hw = Math.min(6, lw * 0.42), hd = Math.min(5.5, ld * 0.32);
      add(-lw / 2 + hw / 2 + 0.6, ld / 2 - hd / 2 - 0.6, hw / 2, hd / 2);
      const bw = Math.min(7, lw * 0.45), bd = Math.min(5.5, ld * 0.3);
      add(lw / 2 - bw / 2 - 0.6, ld / 2 - bd / 2 - 0.6, bw / 2, bd / 2);
      return out;
    }
    const bw = Math.max(3.4, lw * fill), bd = Math.max(3.4, ld * fill);
    const homeLike = !['market', 'chapel', 'mill', 'factory', 'warehouse', 'quay', 'watch', 'monument'].includes(s.type);
    add(0, homeLike ? ((ld - bd) / 2) * 0.35 : 0, bw / 2, bd / 2);
    return out;
  }

  function rebuildLots() {
    const lots = ctx.buildings.lots;
    lotSet.ensure(lots.size * 2 + 1);
    colorSet.ensure(lots.size + 1);
    const lc = lotSet.attrs.iCenter.array, ls = lotSet.attrs.iShape.array;
    const cc = colorSet.attrs.iCenter.array, cd = colorSet.attrs.iDecal.array, ck = colorSet.attrs.iColor.array;
    let n = 0, c = 0;
    const tmp = [];
    for (const lot of lots.values()) {
      const s = lot.summary;
      if (!s || lot.anim?.kind === 'demolish') continue;
      const built = lot.record?.built ?? 1;
      for (const [x, z, hw, hd] of bodies(s, tmp)) {
        lc[n * 3] = x; lc[n * 3 + 1] = 0; lc[n * 3 + 2] = z;
        ls[n * 4] = hw; ls[n * 4 + 1] = hd; ls[n * 4 + 2] = built < 1 ? 0.28 : 0.5; ls[n * 4 + 3] = 0;
        n++;
      }
      let kind = -1, color = null;
      if (s.type === 'park') { kind = KIND.PARK; color = LAWN; }
      else if (built < 1) { kind = KIND.YARD; color = YARD; }
      else if (s.type === 'home' && (lot.record?.wealth ?? 0) > 0.6) { kind = KIND.GARDEN; color = GARDEN; }
      if (kind < 0) continue;
      const grow = kind === KIND.YARD ? 1.15 : 1;
      cc[c * 3] = s.x; cc[c * 3 + 1] = 0; cc[c * 3 + 2] = s.z;
      cd[c * 4] = (s.w / 2) * grow; cd[c * 4 + 1] = (s.d / 2) * grow; cd[c * 4 + 2] = kind; cd[c * 4 + 3] = hashId(s.id, 91);
      color.toArray(ck, c * 3);
      c++;
    }
    lotSet.commit(n);
    colorSet.commit(c);
  }

  /** Cheap signature of what the decals depend on beyond footprints. */
  function signature() {
    let h = 7;
    for (const lot of ctx.buildings.lots.values()) {
      const r = lot.record;
      if (!r) continue;
      const flag = ((r.built ?? 1) < 1 ? 1 : 0) | ((r.wealth ?? 0) > 0.6 ? 2 : 0);
      h = Math.imul(h ^ (r.id * 4 + flag), 16777619);
    }
    return h;
  }

  function buildBlobs() {
    const shared = ctx.forest;
    if (!shared) return;
    const { forest, chopT } = shared;
    blobSet.ensure(forest.count);
    const c = blobSet.attrs.iCenter.array, s = blobSet.attrs.iShape.array;
    for (let i = 0; i < forest.count; i++) {
      const bush = forest.kind[i] === 3;
      const r = (bush ? 1.1 : forest.kind[i] === 2 ? 1.9 : 2.3) * forest.scale[i];
      c[i * 3] = forest.x[i]; c[i * 3 + 1] = forest.y[i] + 0.12; c[i * 3 + 2] = forest.z[i];
      s[i * 4] = r; s[i * 4 + 1] = r; s[i * 4 + 2] = bush ? 0.28 : 0.36; s[i * 4 + 3] = chopT[i];
      // Denser-woods trees (flag 2) cast no shadow-map shadow: their blob is
      // the cast shadow instead (negative strength).
      if (forest.flags[i] & 2) s[i * 4 + 2] = -(bush ? 0.34 : 0.52);
    }
    blobsBuilt = true;
    lastChop = shared.chopVersion;
    blobSet.commit(Math.round(forest.count * keep));
  }

  function syncChops() {
    const { forest, chopT } = ctx.forest;
    const s = blobSet.attrs.iShape.array;
    for (let i = 0; i < forest.count; i++) s[i * 4 + 3] = chopT[i];
    lastChop = ctx.forest.chopVersion;
    const a = blobSet.attrs.iShape;
    a.clearUpdateRanges();
    a.needsUpdate = true;
  }

  /** Building bodies (pads, or the footprint estimate) and tree crowns for the bake. */
  function bakeGroundAO() {
    const blocks = [];
    const tmp = [];
    for (const lot of ctx.buildings.lots.values()) {
      const s = lot.summary;
      if (!s || lot.anim?.kind === 'demolish' || s.type === 'park' || s.type === 'bridge') continue;
      const h = Math.min(18, Math.max(1, s.bodyH || 3));
      if (s.pads?.length) {
        for (const p of s.pads) blocks.push({ x: p.x, z: p.z, hw: p.w / 2 - 0.3, hd: p.d / 2 - 0.3, h });
      } else {
        for (const [x, z, hw, hd] of bodies(s, tmp)) blocks.push({ x, z, hw, hd, h });
      }
    }
    const trees = [];
    const shared = ctx.forest;
    if (shared) {
      const { forest, chopT } = shared;
      const n = Math.round(forest.count * keep);
      for (let i = 0; i < n; i++) {
        if (forest.kind[i] === 3 || chopT[i]) continue;
        trees.push({ x: forest.x[i], z: forest.z[i], r: (forest.kind[i] === 2 ? 1.7 : 2.1) * forest.scale[i] });
      }
      aoForest = shared;
    }
    // Baked over a few frames (a pass or two each) so no frame carries it all;
    // a newer bake replaces one still running.
    aoBake = bakeOcclusionSteps(blocks, trees);
    stepBake();
  }

  let aoBake = null;
  const AO_BAKE_MS = 2;
  function stepBake() {
    if (!aoBake) return;
    const t0 = performance.now();
    let r;
    do r = aoBake.next(); while (!r.done && performance.now() - t0 < AO_BAKE_MS);
    if (!r.done) return;
    aoBake = null;
    setGroundField(r.value);
  }

  function update(view, frame) {
    const v = ctx.buildings.version();
    let dirty = v !== lastVersion;
    if (!dirty && frame.time - lastCheck > 1) {
      lastCheck = frame.time;
      const sig = signature();
      dirty = sig !== lastSig;
      lastSig = sig;
    }
    if (dirty) {
      lastVersion = v;
      lastSig = signature();
      rebuildLots();
    }
    if (!blobsBuilt) buildBlobs();
    else if (ctx.forest && ctx.forest.chopVersion !== lastChop) syncChops();
    const [wc, ws] = bakedWeights(quality);
    if (wc + ws > 0 && (v !== aoVersion || ctx.forest !== aoForest) && frame.time - aoAt >= 1) {
      aoVersion = v;
      aoAt = frame.time;
      bakeGroundAO();
    } else {
      stepBake();
    }
    const day = aoDayFactor(ctx.grade?.current);
    GROUND_AO.uGroundAO.value.set(wc * day, ws * day);
  }

  function applyQuality(q) {
    quality = q;
    keep = ctx.forest?.keep ?? (q.name === 'low' ? 0.4 : q.name === 'medium' ? 0.7 : 1);
    if (blobsBuilt) blobSet.commit(Math.round(ctx.forest.forest.count * keep));
  }

  return {
    group,
    update,
    applyQuality,
    dispose() {
      for (const m of [lotMesh, blobMesh, colorMesh]) {
        m.geometry.dispose();
        m.material.dispose();
      }
      aoBake = null;
      setGroundField(null);
      GROUND_AO.uGroundAO.value.set(0, 0);
      scene.remove(group);
    },
  };
}
