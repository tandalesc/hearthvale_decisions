// Where people sit: bench seats and lawn spots, shared by the sim (walkers on a
// leisure visit pick one) and the renderer (render/decor.js draws the benches
// here), so a walker always sits on a bench that is drawn.
//
// Pure: a function of the building alone, so a save replays exactly.
//
//   seatsOf(b) -> [{key, x, z, yaw, bench}]
//     key    stable id of the seat ('<building>:<n>')
//     yaw    the direction a sitter faces (atan2 of x, z, as walker headings)
//     bench  true: sit on a bench; false: sit on the grass
//   benchesOf(b) -> [{x, z, yaw}]   the benches themselves (render/decor.js)

import {riverX} from '../terrain.js';

// Same integer hash as render/shaderlib.js hashId (decor's instance jitter):
// bench placement must match what decor drew before this module existed.
export function hashId(id, salt = 0) {
  let h = (id * 374761393 + salt * 668265263) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

// Places people gather at, with a pair of benches by the door.
export const GATHER = new Set(['chapel', 'inn', 'moot', 'school', 'library', 'theatre', 'bathhouse']);

// Two sitters to a bench, a little either side of its middle, just forward of the back.
const SLOTS = [-0.35, 0.35];
const SEAT_FORWARD = 0.05;

export function benchesOf(b) {
  if (b.type === 'park') return parkBenches(b);
  if (GATHER.has(b.type) && b.occupied !== false) return doorBenches(b);
  return [];
}

// Benches on the park's path ring, facing in (a beach's face the water).
function parkBenches(b) {
  const id = b.id | 0;
  const hw = b.w / 2, hd = b.d / 2;
  const r = Math.min(hw, hd) * 0.55;
  const toRiver = Math.sign(riverX(b.z) - b.x) || 1;
  const n = 2 + Math.floor(hashId(id, 61) * 2);
  const out = [];
  for (let i = 0; i < n; i++) {
    const a = Math.PI / 4 + (i / n) * Math.PI * 2;
    const x = b.x + Math.cos(a) * (r + 0.9), z = b.z + Math.sin(a) * (r + 0.9);
    const yaw = b.flags?.beach ? (toRiver > 0 ? Math.PI / 2 : -Math.PI / 2) : Math.atan2(b.x - x, b.z - z);
    out.push({x, z, yaw});
  }
  return out;
}

// A bench either side of the door, facing the street.
function doorBenches(b) {
  const rot = (((b.rot ?? 0) % 4) + 4) % 4, angle = (rot * Math.PI) / 2;
  const ld = rot % 2 ? b.w : b.d;
  return [-1, 1].map((s) => {
    const lx = s * 2.2, lz = ld / 2 + 1.1;
    return {x: b.x + lx * Math.cos(angle) + lz * Math.sin(angle), z: b.z - lx * Math.sin(angle) + lz * Math.cos(angle), yaw: angle + Math.PI};
  });
}

export function seatsOf(b) {
  const out = [];
  for (const bench of benchesOf(b)) {
    const c = Math.cos(bench.yaw), s = Math.sin(bench.yaw);
    for (const lx of SLOTS) {
      out.push({key: `${b.id}:${out.length}`, x: bench.x + lx * c + SEAT_FORWARD * s, z: bench.z - lx * s + SEAT_FORWARD * c, yaw: bench.yaw, bench: true});
    }
  }
  // Parks: spots on the mown middle too, scattered, facing every way.
  if (b.type === 'park') {
    const id = b.id | 0;
    const hw = b.w / 2, hd = b.d / 2;
    const r = Math.min(hw, hd) * 0.55;
    const n = 4 + Math.floor(hashId(id, 66) * 4);
    for (let i = 0; i < n; i++) {
      const a = hashId(id * 17 + i, 67) * Math.PI * 2, d = (0.25 + 0.6 * hashId(id * 17 + i, 68)) * r;
      out.push({key: `${b.id}:${out.length}`, x: b.x + Math.cos(a) * d, z: b.z + Math.sin(a) * d, yaw: hashId(id * 17 + i, 69) * Math.PI * 2, bench: false});
    }
  }
  return out;
}
