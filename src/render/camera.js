import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { heightAt } from '../terrain.js';

// Camera rig: orbit controls with sensible limits, framing that centres the
// scene in the area the UI leaves free (setSceneInsets), eased focus moves,
// and a follow mode that keeps the target on a moving walker.

// OrbitControls' internal states that move the target (pans cancel follow;
// rotating and zooming keep it).
const PAN_STATES = new Set([2, 4, 5]);
// Follow spring stiffness (rad/s): critically damped, settles in ~0.6 s.
const FOLLOW_OMEGA = 6;

const HOME_DIR = new THREE.Vector3(0.62, 0.74, 0.92).normalize();
const BOUNDS = 380; // the sim's region is -384..384

export function createCameraRig(canvas) {
  const camera = new THREE.PerspectiveCamera(40, 1, 0.5, 1600);
  const controls = new OrbitControls(camera, canvas);
  controls.enableDamping = true;
  controls.dampingFactor = 0.08;
  controls.maxPolarAngle = Math.PI * 0.44;
  controls.minPolarAngle = Math.PI * 0.08;
  controls.minDistance = 14;
  controls.maxDistance = 420;
  controls.screenSpacePanning = false;
  controls.zoomToCursor = true;
  controls.mouseButtons = { LEFT: THREE.MOUSE.ROTATE, MIDDLE: THREE.MOUSE.DOLLY, RIGHT: THREE.MOUSE.PAN };
  // On touch, one finger orbits the town; two fingers pinch and pan.
  controls.touches = { ONE: THREE.TOUCH.ROTATE, TWO: THREE.TOUCH.DOLLY_PAN };
  canvas.style.touchAction = 'none';

  const insets = { top: 0, right: 0, bottom: 0, left: 0 };
  const frame = { x: 0, y: 0, tx: 0, ty: 0, w: 1, h: 1 };
  const focusTween = { active: false, t0: 0, ms: 0, from: new THREE.Vector3(), to: new THREE.Vector3(), dist0: 0, dist1: 0 };
  let lastInput = performance.now();
  // Ground height for the orbit target (the renderer's ground texture).
  let groundAt = heightAt;
  const targetY = (x, z) => Math.max(0, groundAt(x, z));
  let changed = true;

  // Follow mode: `followGet(out)` writes the walker's position, false when gone.
  let followGet = null;
  const followVel = new THREE.Vector3();
  const followGoal = new THREE.Vector3();
  const followStep = new THREE.Vector3();

  controls.addEventListener('start', () => {
    focusTween.active = false;
    lastInput = performance.now();
    if (followGet && PAN_STATES.has(controls.state)) followGet = null;
  });
  controls.addEventListener('change', () => { changed = true; lastInput = performance.now(); });

  let townRadius = 70;

  /** Remember how big the town is so home framing fits it on any screen. */
  function setTownRadius(r) {
    townRadius = THREE.MathUtils.clamp(r, 25, 220);
  }

  function home(x = -20, z = 4, distance = null) {
    controls.target.set(x, targetY(x, z), z);
    const d = distance ?? fitDistance();
    camera.position.copy(controls.target).addScaledVector(HOME_DIR, d);
    controls.update();
    changed = true;
  }

  /**
   * Distance that fits the town core (townRadius) into the free area. The
   * visible half-width at the target is about d * tan(fov/2) * aspect, and the
   * tilted view foreshortens depth, so fit the narrower screen direction.
   */
  function fitDistance() {
    const fw = Math.max(160, frame.w - insets.left - insets.right);
    const fh = Math.max(120, frame.h - insets.top - insets.bottom);
    const aspect = fw / fh;
    const halfFov = THREE.MathUtils.degToRad(camera.fov / 2);
    const across = townRadius / (Math.tan(halfFov) * Math.min(1, aspect));
    return THREE.MathUtils.clamp(across * 0.85, 45, 230);
  }

  function resize(width, height) {
    frame.w = width; frame.h = height;
    camera.aspect = width / Math.max(1, height);
    updateOffsetTarget();
    camera.setViewOffset(width, height, frame.x, frame.y, width, height);
    camera.updateProjectionMatrix();
    changed = true;
  }

  function updateOffsetTarget() {
    // Shift the projection so the target sits in the middle of the free area.
    frame.tx = (insets.right - insets.left) / 2;
    frame.ty = (insets.bottom - insets.top) / 2;
  }

  function setInsets(next) {
    Object.assign(insets, next);
    updateOffsetTarget();
    changed = true;
  }

  function focus(point, ms = 900, distance = null) {
    followGet = null;
    focusTween.active = true;
    focusTween.t0 = performance.now();
    focusTween.ms = Math.max(1, ms);
    focusTween.from.copy(controls.target);
    focusTween.to.set(point.x, targetY(point.x, point.z), point.z);
    focusTween.dist0 = camera.position.distanceTo(controls.target);
    focusTween.dist1 = distance ?? Math.min(focusTween.dist0, 120);
  }

  /** Follow a moving point (getPosition(out) -> bool), or stop with null. */
  function follow(getPosition) {
    followGet = getPosition ?? null;
    followVel.set(0, 0, 0);
    if (followGet) focusTween.active = false;
    changed = true;
  }

  /** Critically damped spring of the orbit target toward the walker. */
  function stepFollow(dt) {
    if (!followGet(followGoal)) {
      followGet = null;
      return;
    }
    const h = Math.min(0.05, Math.max(0.001, dt));
    const w = FOLLOW_OMEGA;
    // a = w^2 (goal - x) - 2 w v; semi-implicit Euler is stable at this h.
    followStep.subVectors(followGoal, controls.target).multiplyScalar(w * w).addScaledVector(followVel, -2 * w);
    followVel.addScaledVector(followStep, h);
    followStep.copy(followVel).multiplyScalar(h);
    controls.target.add(followStep);
    camera.position.add(followStep);
    changed = true;
  }

  const offset = new THREE.Vector3();
  function update(dt) {
    // Ease the framing offset so panels sliding in feel smooth.
    const a = 1 - Math.exp(-Math.max(0.001, dt) * 10);
    if (Math.abs(frame.tx - frame.x) > 0.25 || Math.abs(frame.ty - frame.y) > 0.25) {
      frame.x += (frame.tx - frame.x) * a;
      frame.y += (frame.ty - frame.y) * a;
      camera.setViewOffset(frame.w, frame.h, frame.x, frame.y, frame.w, frame.h);
      camera.updateProjectionMatrix();
      changed = true;
    }
    if (focusTween.active) {
      const t = Math.min(1, (performance.now() - focusTween.t0) / focusTween.ms);
      const k = t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2; // easeInOutCubic
      offset.copy(camera.position).sub(controls.target).normalize();
      controls.target.lerpVectors(focusTween.from, focusTween.to, k);
      const d = focusTween.dist0 + (focusTween.dist1 - focusTween.dist0) * k;
      camera.position.copy(controls.target).addScaledVector(offset, d);
      if (t >= 1) focusTween.active = false;
      changed = true;
    }
    if (followGet) stepFollow(dt);
    // Keep the target inside the town and on the ground.
    const t = controls.target;
    const cx = THREE.MathUtils.clamp(t.x, -BOUNDS, BOUNDS);
    const cz = THREE.MathUtils.clamp(t.z, -BOUNDS, BOUNDS);
    if (cx !== t.x || cz !== t.z) {
      camera.position.x += cx - t.x;
      camera.position.z += cz - t.z;
      t.x = cx; t.z = cz;
    }
    controls.update(dt);
    const moved = changed;
    changed = false;
    return moved;
  }

  return {
    camera,
    controls,
    home,
    setGround: (fn) => { groundAt = fn; },
    /** The distance home() frames the town at (for zoom-gated overlays). */
    homeDistance: () => fitDistance(),
    insets,
    setTownRadius,
    focus,
    resize,
    setInsets,
    update,
    distance: () => camera.position.distanceTo(controls.target),
    lastInput: () => lastInput,
    follow,
    isFollowing: () => followGet !== null,
    isTweening: () => focusTween.active || followGet !== null,
    dispose: () => controls.dispose(),
  };
}
