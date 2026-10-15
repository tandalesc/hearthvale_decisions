import { heightAt, riverX } from '../../terrain.js';

// A local stand-in for sim-core's fixtures + render view (contract §3, §6),
// used by the renderer's dev page until `src/sim/fixtures.js` and
// `src/sim/render-view.js` land. Deterministic: same name, same town.

const CELL = 2;
const W = 256;
const H = 256;
const OX = -256;
const OZ = -256;
export const BRIDGE_DECK_Y = 0.9; // matches BRIDGE_DECK in src/sim/people.js

function makeRng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const FIXTURES = {
  hamlet: { era: 0, buildings: 22, people: 60, seed: 7, archetype: 'market-town' },
  town: { era: 2, buildings: 160, people: 600, seed: 11, archetype: 'market-town' },
  city: { era: 4, buildings: 1200, people: 3000, seed: 23, archetype: 'exchange' },
};

/** Road polylines [points, tier] per fixture. Points are [x, z]. */
function roadPlan(name, rand) {
  const curve = (x0, z0, x1, z1, wob, n = 24) => {
    const pts = [];
    for (let i = 0; i <= n; i++) {
      const t = i / n;
      const x = x0 + (x1 - x0) * t;
      const z = z0 + (z1 - z0) * t + Math.sin(t * Math.PI * 2 + x0) * wob;
      pts.push([x, z]);
    }
    return pts;
  };
  const era = FIXTURES[name].era;
  const main = era >= 4 ? 5 : era >= 2 ? 3 : 2;
  const side = era >= 4 ? 4 : era >= 2 ? 3 : 1;
  const lane = era >= 4 ? 3 : 2;
  const plan = [
    [curve(-120, -8, 4, 5, 5), main],
    [curve(30, 5, 140, 18, 4), name === 'hamlet' ? 1 : main],
    [curve(-46, -2, -64, -150, 6), side],
    [curve(-46, -2, -30, 150, 7), side],
  ];
  if (name === 'hamlet') return plan.slice(0, 4).map(([p, t], i) => [i === 1 ? p.slice(0, 8) : p.slice(0, i > 1 ? 12 : 24), t]);
  // Cross streets for towns and cities.
  const n = name === 'city' ? 14 : 5;
  for (let i = 0; i < n; i++) {
    const z = -110 + (i / (n - 1)) * 220 + (rand() - 0.5) * 8;
    const x0 = -150 + rand() * 30;
    const x1 = -2 - rand() * 6;
    plan.push([curve(x0, z, x1, z + (rand() - 0.5) * 10, 2, 16), i % 3 === 0 ? side : lane]);
  }
  if (name === 'city') {
    for (let i = 0; i < 8; i++) {
      const x = -140 + i * 20 + (rand() - 0.5) * 5;
      plan.push([curve(x, -150, x + (rand() - 0.5) * 10, 150, 3, 20), i % 3 === 0 ? side : lane]);
    }
    for (let i = 0; i < 8; i++) {
      const z = -120 + i * 34;
      plan.push([curve(36, z, 170, z + (rand() - 0.5) * 12, 3, 16), i % 2 ? side : lane]);
    }
    plan.push([curve(70, -150, 80, 150, 4, 24), main]);
    plan.push([curve(120, -140, 115, 150, 4, 24), side]);
  }
  return plan;
}

function rasterRoads(plan, roads) {
  const { wear, tier } = roads;
  const stamp = (x, z, radius, t, amount) => {
    const r = Math.ceil(radius / CELL);
    const cx = Math.floor((x - OX) / CELL);
    const cz = Math.floor((z - OZ) / CELL);
    for (let dz = -r; dz <= r; dz++) {
      for (let dx = -r; dx <= r; dx++) {
        const gx = cx + dx, gz = cz + dz;
        if (gx < 0 || gz < 0 || gx >= W || gz >= H) continue;
        const wx = OX + (gx + 0.5) * CELL, wz = OZ + (gz + 0.5) * CELL;
        const d = Math.hypot(wx - x, wz - z);
        if (d > radius) continue;
        const i = gz * W + gx;
        if (Math.abs(wx - riverX(wz)) < 6.2) { roads.planned[i] |= 2; }
        wear[i] = Math.max(wear[i], amount * (1 - (d / radius) * 0.4));
        if (d <= radius * 0.8) tier[i] = Math.max(tier[i], t);
      }
    }
  };
  for (const [pts, t] of plan) {
    const radius = [1, 1.3, 1.8, 2.4, 3.0, 4.2][t];
    const amount = [20, 120, 600, 2500, 4000, 6000][t];
    for (let i = 1; i < pts.length; i++) {
      const [x0, z0] = pts[i - 1];
      const [x1, z1] = pts[i];
      const len = Math.hypot(x1 - x0, z1 - z0);
      for (let s = 0; s <= len; s += 0.8) {
        const k = s / len;
        stamp(x0 + (x1 - x0) * k, z0 + (z1 - z0) * k, radius, t, amount);
      }
    }
  }
}

const TYPES_BY_ERA = [
  ['home', 'home', 'home', 'home', 'home', 'farm', 'workshop', 'shop', 'mill', 'chapel', 'inn', 'market'],
  ['home', 'home', 'home', 'home', 'shop', 'workshop', 'inn', 'farm', 'chapel', 'market', 'moot', 'warehouse', 'school', 'park'],
  ['home', 'home', 'home', 'home', 'home', 'shop', 'shop', 'workshop', 'inn', 'warehouse', 'school', 'chapel', 'moot', 'park', 'infirmary', 'watch', 'library'],
  ['home', 'home', 'home', 'home', 'home', 'shop', 'shop', 'factory', 'warehouse', 'school', 'theatre', 'exchange', 'park', 'union-hall', 'infirmary', 'bathhouse'],
  ['home', 'home', 'home', 'home', 'home', 'home', 'shop', 'shop', 'factory', 'exchange', 'theatre', 'library', 'park', 'school', 'infirmary', 'monument', 'union-hall'],
];

function lotSize(type, tier, rand) {
  switch (type) {
    case 'farm': return [14, 16];
    case 'market': return [12, 10];
    case 'park': return [14, 12];
    case 'factory': return [16, 12];
    case 'warehouse': return [12, 9];
    case 'chapel': return tier >= 3 ? [10, 16] : [7, 11];
    case 'exchange': case 'theatre': case 'moot': case 'library': return [12, 12];
    case 'monument': return [6, 6];
    case 'mill': return [8, 8];
    default: {
      const w = tier >= 4 ? 10 : tier >= 3 ? 7 : 6;
      return [w + Math.round(rand() * 2), w + 1 + Math.round(rand() * 2)];
    }
  }
}

function buildTown(name) {
  const fx = FIXTURES[name];
  const rand = makeRng(fx.seed);
  const roads = {
    cell: CELL, W, H, ox: OX, oz: OZ,
    wear: new Float32Array(W * H), tier: new Uint8Array(W * H), planned: new Uint8Array(W * H),
    xings: {}, version: 1, dirty: null,
  };
  const plan = roadPlan(name, rand);
  rasterRoads(plan, roads);

  const occupied = [];
  const blocked = (x, z, w, d) => {
    if (Math.abs(x) > 240 || Math.abs(z) > 240) return true;
    for (const [dx, dz] of [[-w / 2, -d / 2], [w / 2, -d / 2], [-w / 2, d / 2], [w / 2, d / 2], [0, 0]]) {
      if (Math.abs(x + dx - riverX(z + dz)) < 9) return true;
      const cx = Math.floor((x + dx - OX) / CELL), cz = Math.floor((z + dz - OZ) / CELL);
      if (cx >= 0 && cz >= 0 && cx < W && cz < H && roads.tier[cz * W + cx] > 0) return true;
    }
    for (const o of occupied) {
      if (Math.abs(o.x - x) < (o.w + w) / 2 + 1 && Math.abs(o.z - z) < (o.d + d) / 2 + 1) return true;
    }
    return false;
  };

  const buildings = [];
  let id = 1;
  const center = [-46, -2];
  const typesFor = (era) => TYPES_BY_ERA[Math.min(era, 4)];
  // Walk the roads and place lots on both sides, facing the road.
  outer: for (let pass = 0; pass < 6; pass++) {
    for (const [pts] of plan) {
      for (let i = 1; i < pts.length; i++) {
        if (buildings.length >= fx.buildings) break outer;
        const [x0, z0] = pts[i - 1];
        const [x1, z1] = pts[i];
        const len = Math.hypot(x1 - x0, z1 - z0);
        const tx = (x1 - x0) / len, tz = (z1 - z0) / len;
        const steps = Math.max(1, Math.floor(len / 9));
        for (let s = 0; s < steps; s++) {
          if (buildings.length >= fx.buildings) break outer;
          if (rand() < 0.25 + pass * 0.05) continue;
          const k = (s + rand()) / steps;
          const side = rand() < 0.5 ? -1 : 1;
          const distC = Math.hypot(x0 - center[0], z0 - center[1]);
          // Old quarter in the middle keeps older styles.
          const styleEra = Math.max(0, Math.min(fx.era, Math.round(fx.era - distC / 70 + (rand() - 0.5) * 1.6 - pass * 0.3)));
          const types = typesFor(styleEra);
          let type = types[Math.floor(rand() * types.length)];
          if (type === 'farm' && distC < 60 && fx.era > 0) type = 'home';
          const tier = type === 'home' ? Math.max(1, Math.min(5, 1 + styleEra + Math.round(rand() * 1.2 - 0.3) - Math.round(distC / 140))) : Math.max(1, Math.min(5, styleEra + 1));
          const [lw, ld] = lotSize(type, tier, rand);
          const nx = -tz * side, nz = tx * side; // outward normal from the road
          const off = 3.5 + ld / 2 + pass * (ld + 2);
          const cx = x0 + (x1 - x0) * k + nx * off;
          const cz = z0 + (z1 - z0) * k + nz * off;
          // Front faces the road: pick the axis closest to -normal.
          const fxv = -nx, fzv = -nz;
          let rot;
          if (Math.abs(fxv) > Math.abs(fzv)) rot = fxv > 0 ? 1 : 3; else rot = fzv > 0 ? 0 : 2;
          const w = rot % 2 ? ld : lw;
          const d = rot % 2 ? lw : ld;
          if (blocked(cx, cz, w, d)) continue;
          occupied.push({ x: cx, z: cz, w, d });
          const storeys = type === 'home' ? [1, 1, 2, 3, 4, 6][tier] : type === 'park' || type === 'farm' || type === 'monument' ? 1 : Math.max(1, Math.min(5, tier));
          const age = Math.round(rand() * 20 + (fx.era - styleEra) * 25);
          const wealth = Math.max(0, Math.min(1, 0.65 - distC / 300 + (rand() - 0.5) * 0.5));
          buildings.push({
            id: id++, type, variant: Math.floor(rand() * 3), tier, storeys, lotId: id,
            x: Math.round(cx * 10) / 10, z: Math.round(cz * 10) / 10, rot, w, d,
            styleEra, archetype: fx.archetype, material: null,
            wealth, condition: Math.max(0.1, Math.min(1, 1 - age / 140 + (rand() - 0.5) * 0.3)), age,
            built: 1, occupied: type === 'home' ? rand() > 0.08 : true, open: true,
            chimney: type !== 'park' && type !== 'monument', smoke: type === 'factory' ? 0.9 : type === 'mill' || type === 'workshop' ? 0.5 : rand() * 0.4,
            banner: null, lit: rand() > 0.15,
            extensions: type === 'home' && rand() < 0.3 ? [{ side: 1 + Math.floor(rand() * 2), w: 3, d: 3 }] : [],
            flags: age > 80 && rand() < 0.2 ? { heritage: true } : {},
          });
        }
      }
    }
  }
  // A handful of construction sites.
  const projects = [];
  const nSites = Math.max(2, Math.round(buildings.length * 0.03));
  for (let i = 0; i < nSites; i++) {
    const b = buildings[Math.floor(rand() * buildings.length)];
    if (b.type === 'park') continue;
    b.built = 0.15 + rand() * 0.75;
    b.flags = { ...b.flags, scaffold: true };
    projects.push({ id: 900 + i, kind: 'build', buildingId: b.id, x: b.x, z: b.z, w: b.w, d: b.d, progress: b.built });
  }
  // Lamps on paved roads (era 3+), every ~12 m.
  const lamps = [];
  if (fx.era >= 3) {
    for (const [pts, t] of plan) {
      if (t < 4) continue;
      let acc = 0;
      for (let i = 1; i < pts.length; i++) {
        const [x0, z0] = pts[i - 1];
        const [x1, z1] = pts[i];
        const len = Math.hypot(x1 - x0, z1 - z0);
        for (let s = 0; s < len; s += 1) {
          acc += 1;
          if (acc < 12) continue;
          acc = 0;
          const k = s / len;
          const tx = (x1 - x0) / len, tz = (z1 - z0) / len;
          const side = lamps.length % 2 ? 1 : -1;
          const r = [0, 0, 0, 0, 3.4, 4.6][t];
          const lx = x0 + (x1 - x0) * k - tz * r * side, lz = z0 + (z1 - z0) * k + tx * r * side;
          if (Math.abs(lx - riverX(lz)) > 7) lamps.push({ x: lx, z: lz });
        }
      }
    }
  }
  const bridges = [{ id: 1, z: 5, x0: riverX(5) - 7.5, x1: riverX(5) + 7.5, style: fx.era >= 4 ? 'iron' : fx.era >= 1 ? 'stone' : 'timber', built: 1 }];
  const worldEvents = [];
  if (fx.era >= 1) worldEvents.push({ id: 1, kind: 'market', x: -46, z: 12, radius: 10, strength: 0.8, t0: 0, t1: 1e9 });
  if (fx.era >= 2) worldEvents.push({ id: 2, kind: 'festival', x: -70, z: -40, radius: 12, strength: 0.7, t0: 0, t1: 1e9 });
  if (fx.era >= 4) worldEvents.push({ id: 3, kind: 'protest', x: -20, z: 60, radius: 9, strength: 0.9, faction: 'workers', t0: 0, t1: 1e9 });
  return { roads, buildings, projects, lamps, bridges, worldEvents, plan, rand };
}

/**
 * Builds a view object shaped like `createRenderView(state)` (contract §6).
 * `sync(time)` animates people along the roads and advances the year.
 */
export function createStandinView(name = 'town', { yearT = 0.38, yearSpeed = 1 / 60 } = {}) {
  const fx = FIXTURES[name] ?? FIXTURES.town;
  const town = buildTown(name in FIXTURES ? name : 'town');
  const count = fx.people;
  const people = new Float32Array(count * 16);
  const legs = []; // per person: polyline index, segment, direction, end time
  const rand = town.rand;
  const segments = [];
  for (const [pts, t] of town.plan) for (let i = 1; i < pts.length; i++) segments.push({ a: pts[i - 1], b: pts[i], t });

  const view = {
    buildings: town.buildings,
    buildingEvents: town.buildings.map((b) => ({ kind: 'add', id: b.id })),
    people,
    peopleCount: count,
    peopleDirty: { start: 0, end: count },
    roads: town.roads,
    bridges: town.bridges,
    lamps: town.lamps,
    worldEvents: town.worldEvents,
    weather: { rain: 0, wind: [0.7, 0.3], snow: 0 },
    time: { year: fx.era * 25 + 3, month: 0, season: 0, seasonT: 0, yearT },
    era: fx.era,
    archetype: fx.archetype,
    projects: town.projects,
    sync,
  };

  const deckY = (x, z) => (Math.abs(x - riverX(z)) < 7.5 ? BRIDGE_DECK_Y : heightAt(x, z));

  function startLeg(i, time) {
    const leg = legs[i];
    const seg = segments[leg.seg];
    const [ax, az] = leg.dir > 0 ? seg.a : seg.b;
    const [bx, bz] = leg.dir > 0 ? seg.b : seg.a;
    const lane = leg.lane;
    const len = Math.hypot(bx - ax, bz - az) || 1;
    const nx = -(bz - az) / len, nz = (bx - ax) / len;
    const sx = ax + nx * lane, sz = az + nz * lane;
    const speed = leg.speed;
    const o = i * 16;
    people[o] = sx; people[o + 1] = deckY(sx, sz); people[o + 2] = sz;
    people[o + 3] = ((bx - ax) / len) * speed; people[o + 4] = 0; people[o + 5] = ((bz - az) / len) * speed;
    people[o + 6] = time;
    people[o + 8] = 1;
    people[o + 15] = Math.atan2(bx - ax, bz - az);
    leg.end = time + len / speed;
  }

  // Seed people: most walk; some stand at events with actions.
  for (let i = 0; i < count; i++) {
    const o = i * 16;
    legs.push({ seg: Math.floor(rand() * segments.length), dir: rand() < 0.5 ? 1 : -1, lane: (rand() - 0.5) * 2.2, speed: 1.1 + rand() * 0.5, end: 0 });
    people[o + 7] = rand() * 6.283;
    people[o + 11] = Math.floor(rand() * 6);
    people[o + 12] = Math.floor(rand() * 12);
    people[o + 13] = rand() < 0.35 ? 1 + Math.floor(rand() * 3) : 0;
    people[o + 14] = 0.92 + rand() * 0.16;
    people[o + 10] = 0;
    const ev = town.worldEvents.length && rand() < 0.15 ? town.worldEvents[Math.floor(rand() * town.worldEvents.length)] : null;
    if (ev) {
      const a = rand() * Math.PI * 2, r = Math.sqrt(rand()) * ev.radius;
      const x = ev.x + Math.cos(a) * r, z = ev.z + Math.sin(a) * r;
      people[o] = x; people[o + 1] = heightAt(x, z); people[o + 2] = z;
      people[o + 9] = ev.kind === 'protest' ? 5 : ev.kind === 'festival' ? (rand() < 0.5 ? 6 : 4) : (rand() < 0.3 ? 1 : 0);
      people[o + 15] = Math.atan2(ev.x - x, ev.z - z);
      legs[i].end = Infinity;
      continue;
    }
    // Builders at construction sites.
    if (town.projects.length && rand() < 0.04) {
      const p = town.projects[Math.floor(rand() * town.projects.length)];
      const a = rand() * Math.PI * 2;
      const x = p.x + Math.cos(a) * (p.w / 2 + 1), z = p.z + Math.sin(a) * (p.d / 2 + 1);
      people[o] = x; people[o + 1] = heightAt(x, z); people[o + 2] = z;
      people[o + 9] = 2;
      people[o + 15] = Math.atan2(p.x - x, p.z - z);
      legs[i].end = Infinity;
      continue;
    }
    if (rand() < 0.15) people[o + 9] = 1; // carrying
    startLeg(i, 0);
    // Start partway along so the crowd is spread out.
    const back = rand() * (legs[i].end - 0);
    people[o + 6] = -back;
    people[o] -= people[o + 3] * back; people[o + 2] -= people[o + 5] * back;
    legs[i].end -= back;
  }

  let lastTime = null;
  function sync(time) {
    if (lastTime === null) lastTime = time;
    const dt = Math.max(0, Math.min(0.25, time - lastTime));
    lastTime = time;
    view.time.yearT = (view.time.yearT + dt * yearSpeed) % 1;
    view.time.season = Math.floor(view.time.yearT * 4);
    view.time.seasonT = (view.time.yearT * 4) % 1;
    view.time.month = Math.floor(view.time.yearT * 12);
    let lo = Infinity, hi = -1;
    for (let i = 0; i < count; i++) {
      const leg = legs[i];
      if (time < leg.end) continue;
      leg.dir = -leg.dir;
      startLeg(i, time);
      lo = Math.min(lo, i); hi = Math.max(hi, i + 1);
    }
    if (hi > 0) view.peopleDirty = view.peopleDirty ? { start: Math.min(view.peopleDirty.start, lo), end: Math.max(view.peopleDirty.end, hi) } : { start: lo, end: hi };
  }

  return view;
}

export const STANDIN_FIXTURES = Object.keys(FIXTURES);
