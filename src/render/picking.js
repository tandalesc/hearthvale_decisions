import * as THREE from 'three';
import { heightAt } from '../terrain.js';
import { styleFor } from './kit/styles.js';

// Tap/click picking without mesh raycasts (design-visual §4.6).
//   people     nearest villager whose body passes within ~14 px of the tap
//              (22 px for touch), computed on the CPU from the people rows
//   buildings  ray against each lot's box
//   ground     ray marched against the ground mirror (terrain + pads)
// A villager wins over a building unless the building is clearly in front.
// A press counts as a pick when it moved less than 6 px and lasted < 600 ms.

const RADIUS_MOUSE = 14;
const RADIUS_TOUCH = 22;
const WATER_Y = 0.025;

export function createPicking({ canvas, camera, buildings, people, ground }) {
  const ray = new THREE.Ray();
  const ndc = new THREE.Vector2();
  const hit = new THREE.Vector3();
  const raycaster = new THREE.Raycaster();
  const sampleGround = ground ? ground.sample : heightAt;
  let down = null;
  let callback = null;
  let context = null;

  function onDown(e) {
    if (e.button !== undefined && e.button !== 0) return;
    down = { x: e.clientX, y: e.clientY, t: performance.now(), id: e.pointerId };
  }

  function onUp(e) {
    if (!down || e.pointerId !== down.id) return;
    const moved = Math.hypot(e.clientX - down.x, e.clientY - down.y);
    const quick = performance.now() - down.t < 600;
    down = null;
    if (moved > 6 || !quick || !callback) return;
    const result = pickAt(e.clientX, e.clientY, e.pointerType);
    if (result) callback(result);
  }

  function setRay(clientX, clientY) {
    const r = canvas.getBoundingClientRect();
    ndc.set(((clientX - r.left) / r.width) * 2 - 1, -((clientY - r.top) / r.height) * 2 + 1);
    raycaster.setFromCamera(ndc, camera);
    ray.copy(raycaster.ray);
    return r;
  }

  /**
   * Pick at client coordinates. Returns {personId} | {buildingId} | {x, z} | null.
   * pointerType 'touch' (or 'pen') widens the tolerance for fingers.
   */
  function pickAt(clientX, clientY, pointerType = 'mouse') {
    const rect = setRay(clientX, clientY);
    const time = context?.()?.time ?? 0;
    const groundHit = marchGround(ray, hit);
    const groundDist = groundHit ? hit.distanceTo(ray.origin) : Infinity;
    const building = pickBuilding(groundDist);
    const buildingDist = building ? building.distance : Infinity;
    // Radians per screen pixel (vertical FOV over the canvas height).
    const pxAngle = THREE.MathUtils.degToRad(camera.fov) / Math.max(1, rect.height);
    const radiusPx = pointerType === 'mouse' ? RADIUS_MOUSE : RADIUS_TOUCH;
    // A person standing in front of (or just at) a wall still wins; one
    // hidden well behind the building does not.
    const person = people?.pick?.(ray, time, { maxDist: Math.min(groundDist, buildingDist + 2.5), radiusPx, pxAngle });
    if (person) return { personId: person.personId };
    if (building) return { buildingId: building.id };
    if (groundHit) return { x: hit.x, z: hit.z };
    return null;
  }

  // Slab test against each building's body box (the lot shrunk by the era's
  // fill, so gardens and yards pick as ground and their villagers stay
  // tappable). Lots are few enough (<= ~3k) to scan.
  const box = new THREE.Box3();
  const p = new THREE.Vector3();
  const found = { id: 0, distance: 0 };
  function pickBuilding(maxDist) {
    let best = null;
    let bestT = maxDist + 0.5;
    const test = (id) => {
      if (!ray.intersectBox(box, p)) return;
      const t = p.distanceTo(ray.origin);
      if (t < bestT) { bestT = t; best = id; }
    };
    for (const lot of buildings.lots.values()) {
      const s = lot.summary;
      if (!s || lot.anim?.kind === 'demolish' || s.type === 'park') continue;
      const top = Math.max(s.top, s.base + 2);
      if (s.type === 'farm') {
        // Farms cover their whole field: the farmhouse and barn stand in a
        // strip along the front; the rest is crops, barely knee high.
        farmStrip(s, top);
        test(s.id);
        box.min.set(s.x - s.w / 2, s.base - 0.5, s.z - s.d / 2);
        box.max.set(s.x + s.w / 2, s.base + 0.8, s.z + s.d / 2);
        test(s.id);
        continue;
      }
      const fill = s.type === 'market' ? 0.9 : styleFor(s.era ?? 0).fill;
      const hw = Math.max(1.7, (s.w * fill) / 2);
      const hd = Math.max(1.7, (s.d * fill) / 2);
      box.min.set(s.x - hw, s.base - 0.5, s.z - hd);
      box.max.set(s.x + hw, top, s.z + hd);
      test(s.id);
    }
    if (best === null) return null;
    found.id = best;
    found.distance = bestT;
    return found;
  }

  /** World box of a farm's front strip (farmhouse and barn, see kit/compose.js). */
  function farmStrip(s, top) {
    const rot = s.rot | 0;
    const lw = rot % 2 ? s.d : s.w;
    const ld = rot % 2 ? s.w : s.d;
    const depth = Math.min(ld, 6.4);
    // Local strip: x in [-lw/2, lw/2], z in [ld/2 - depth, ld/2]; rotate by rot.
    const cz = ld / 2 - depth / 2;
    const a = rot * Math.PI / 2;
    const cx = s.x + cz * Math.sin(a);
    const czw = s.z + cz * Math.cos(a);
    const hx = rot % 2 ? depth / 2 : lw / 2;
    const hz = rot % 2 ? lw / 2 : depth / 2;
    box.min.set(cx - hx, s.base - 0.5, czw - hz);
    box.max.set(cx + hx, top, czw + hz);
  }

  /** March the ray over the ground mirror (water surface where it is higher). */
  function marchGround(r, out, maxDist = 1500) {
    const o = r.origin;
    const d = r.direction;
    const surface = (x, z) => Math.max(sampleGround(x, z), WATER_Y);
    if (o.y - surface(o.x, o.z) < 0) return false;
    let t = 0;
    let prevT = 0;
    let step = 2;
    while (t < maxDist) {
      t += step;
      const x = o.x + d.x * t, z = o.z + d.z * t;
      const above = o.y + d.y * t - surface(x, z);
      if (above <= 0) {
        // Bisect between the last two samples for a precise hit.
        let a = prevT, b = t;
        for (let i = 0; i < 14; i++) {
          const m = (a + b) / 2;
          if (o.y + d.y * m - surface(o.x + d.x * m, o.z + d.z * m) > 0) a = m; else b = m;
        }
        out.copy(d).multiplyScalar((a + b) / 2).add(o);
        return true;
      }
      prevT = t;
      step = Math.min(8, Math.max(0.4, above * 0.6));
    }
    return false;
  }

  canvas.addEventListener('pointerdown', onDown);
  canvas.addEventListener('pointerup', onUp);

  return {
    onPick(cb, ctxFn) { callback = cb; context = ctxFn; },
    pickAt,
    dispose() {
      canvas.removeEventListener('pointerdown', onDown);
      canvas.removeEventListener('pointerup', onUp);
    },
  };
}
