// Wind exposure, shared by the sim (windmills are sited by it) and anything drawn
// that wants to know where the wind blows. Pure: no Three.js, no state; it reads only
// the terrain and the woodland field, so a valley's windy places never change.
//
// windExposureAt(x, z) is 0..1:
//   + height over the ground around (a knoll 20 units out, a rise 60 out), the
//     upwind side counting most;
//   + open fetch: water upwind lets the wind come in unbroken (a lake, the sea, a
//     wide river reach);
//   - shelter: woods upwind (woodField past WOOD_OUT), and higher ground upwind
//     (the lee of a hill).
// The prevailing wind comes from WIND_FROM, the side the renderer's default uWind
// (0.6, 0.3) blows from.
import { heightAt, bankDistance, terrainKey } from './terrain.js';
import { woodField, WOOD_OUT } from './woodland.js';

const WL = Math.hypot(0.6, 0.3);
export const WIND_FROM = [-0.6 / WL, -0.3 / WL];

const DIRS = Array.from({ length: 8 }, (_, k) => [Math.cos(k * Math.PI / 4), Math.sin(k * Math.PI / 4)]);
// Upwind directions count up to twice as much as downwind ones.
const WEIGHT = DIRS.map(([dx, dz]) => 1 + 0.5 * (dx * WIND_FROM[0] + dz * WIND_FROM[1]));
const WEIGHT_SUM = WEIGHT.reduce((a, b) => a + b, 0);
const FETCH_AT = [12, 30, 55];
const WOOD_AT = [10, 24];

/** 0..1: how much wind reaches a point (see the header). */
export function windExposureAt(x, z) {
  const h = heightAt(x, z);
  let lift = 0, lee = 0, fetch = 0, wood = 0;
  for (let k = 0; k < 8; k++) {
    const [dx, dz] = DIRS[k], w = WEIGHT[k];
    const near = heightAt(x + dx * 20, z + dz * 20), far = heightAt(x + dx * 60, z + dz * 60);
    lift += w * (0.6 * (h - near) + 0.4 * (h - far));
    // Ground rising well above the point blocks the wind from that side.
    lee += w * Math.min(1, Math.max(0, Math.max(near, far) - h - 2) / 8);
    for (const r of FETCH_AT) if (bankDistance(x + dx * r, z + dz * r) < 0) fetch += w / FETCH_AT.length;
    for (const r of WOOD_AT) wood += w * Math.min(1, Math.max(0, woodField(x + dx * r, z + dz * r) - WOOD_OUT) / 0.15) / WOOD_AT.length;
  }
  lift /= WEIGHT_SUM; lee /= WEIGHT_SUM; fetch /= WEIGHT_SUM; wood /= WEIGHT_SUM;
  // 8 units above the ground around is a real hilltop (as prominenceAt in sites.js).
  const e = 0.45 + 0.5 * Math.max(-1, Math.min(1, lift / 8)) + 0.35 * fetch - 0.35 * wood - 0.4 * lee;
  return Math.max(0, Math.min(1, e));
}

// The same, on a 4-unit grid, memoised per valley: site searches score thousands of
// overlapping lots, and the field is smooth at that scale.
const GRID = 4;
let memoKey = null;
const memo = new Map();

export function windExposure(x, z) {
  const key = terrainKey();
  if (key !== memoKey) { memo.clear(); memoKey = key; }
  const gx = Math.round(x / GRID), gz = Math.round(z / GRID);
  const k = gx * 4096 + gz;
  let v = memo.get(k);
  if (v === undefined) {
    v = windExposureAt(gx * GRID, gz * GRID);
    memo.set(k, v);
  }
  return v;
}
