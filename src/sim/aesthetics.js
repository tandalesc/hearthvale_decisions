// How the town looks to the people who live in it.
//
// Yearly, deterministic, no random draws, after landscape.js has tended the
// lots and verges:
//
//   1. Looks. Each home gets a local score (b.looks, 0..1) from what stands
//      within a short walk: derelict and run-down buildings, overgrown yards,
//      smoke, litter on busy crowded streets, crowding and overgrown verges
//      count against it; parks, gardens and kept verges (the landscaping
//      level), water views and landmarks count for it. Districts, factions and the town average their homes.
//   2. Experiences. Per district, a short record of the things people
//      actually live next to (the worst eyesores and the best spots), with
//      how many residents are affected and since when. aestheticComplaints()
//      reads it.
//
// state.aesthetics = {year, town, districts: {id: {looks, residents, ...parts}},
//   factions: {id: looks}, experiences: {id: [{what, ref, x, z, severity,
//   residents, since}]}}. Missing in older saves: readers default to 0.5
// (plain) and nothing else changes until the first yearly pass.

import {buildingsNear, worldToCell} from './sites.js';
import {cellIndex, wearNorm} from './roads.js';
import {bankDistance} from '../terrain.js';
import {factionOf} from './factions.js';
import {levelOf} from './policies.js';
import {yearlyLandscape, landAround, lotLevel} from './landscape.js';

const REACH_CELLS = 12;       // a short walk: 24 units
const REACH = REACH_CELLS * 2;
const PARK_REACH = 40;        // a park counts this far away
const WATER_REACH = 24;
const NO_TEND = new Set(['farm', 'park', 'bridge', 'monument', 'quay', 'quarry']);
const NEUTRAL = 0.5;

const clamp01 = (x) => (x < 0 ? 0 : x > 1 ? 1 : x);
const r2 = (x) => Math.round(x * 100) / 100;

// ---------------------------------------------------------------------------
// Readers (pure; safe on saves from before this existed)

export const townLooks = (state) => state.aesthetics?.town ?? NEUTRAL;
export const districtLooks = (state, id) => state.aesthetics?.districts?.[id]?.looks ?? NEUTRAL;
export const factionLooks = (state, id) => state.aesthetics?.factions?.[id] ?? NEUTRAL;
// Share of a faction's people whose own street is shabby (home looks below SHABBY).
export const factionShabby = (state, id) => state.aesthetics?.shabby?.[id] ?? 0;
export const SHABBY = 0.4;
export const homeLooks = (b) => b?.looks ?? NEUTRAL;

export const looksBand = (x) => (x < 0.4 ? 'shabby' : x < 0.62 ? 'plain' : 'pleasant');

// How much each faction minds what its streets look like (mood weight).
export const LOOKS_CARE = {gentry: 0.3, scholars: 0.22, merchants: 0.16, clergy: 0.1, crafters: 0.08, farmers: 0.05, labourers: 0.06, newcomers: 0.06};

// Plain words for each kind of experience.
const WHAT = {
  derelict: 'a derelict building', rundown: 'run-down homes', overgrown: 'overgrown yards and broken fences', verges: 'weedy, trampled verges',
  litter: 'litter on a busy street', smoke: 'smoke from the works', crowding: 'crowded streets',
  park: 'a park', water: 'the river nearby', gardens: 'tended gardens',
};
const NEGATIVE = new Set(['derelict', 'rundown', 'overgrown', 'verges', 'litter', 'smoke', 'crowding']);

/**
 * The strongest things residents dislike about where they live, worst first:
 * [{what, label, districtId, district, x, z, severity 0..1, residents, years}].
 * Pure: reads the record the yearly pass keeps. With districtId, one district.
 */
export function aestheticComplaints(state, {districtId = null, limit = 8} = {}) {
  const out = [];
  const exp = state.aesthetics?.experiences ?? {};
  const year = state.time?.year ?? 0;
  for (const id of Object.keys(exp).sort((a, b) => a - b)) {
    if (districtId != null && Number(id) !== districtId) continue;
    const name = state.districts?.find((d) => d.id === Number(id))?.name ?? null;
    for (const e of exp[id]) {
      if (!NEGATIVE.has(e.what)) continue;
      out.push({what: e.what, label: WHAT[e.what], districtId: Number(id), district: name, x: e.x, z: e.z,
        severity: e.severity, residents: e.residents, years: Math.max(0, year - e.since), ref: e.ref});
    }
  }
  out.sort((a, b) => b.severity * b.residents - a.severity * a.residents || b.years - a.years || a.districtId - b.districtId);
  return out.slice(0, limit);
}

/** The places residents like (parks, water, gardens), best first. Same shape. */
export function aestheticPraise(state, {districtId = null, limit = 8} = {}) {
  const out = [];
  const exp = state.aesthetics?.experiences ?? {};
  for (const id of Object.keys(exp).sort((a, b) => a - b)) {
    if (districtId != null && Number(id) !== districtId) continue;
    for (const e of exp[id]) {
      if (NEGATIVE.has(e.what)) continue;
      out.push({what: e.what, label: WHAT[e.what], districtId: Number(id), x: e.x, z: e.z, severity: e.severity, residents: e.residents});
    }
  }
  out.sort((a, b) => b.severity * b.residents - a.severity * a.residents || a.districtId - b.districtId);
  return out.slice(0, limit);
}

// ---------------------------------------------------------------------------
// Looks

function cleanliness(state) {
  // Bins and sweeping come with the era; a year of public works and clean
  // water help. (No rule of its own: that is for residents to ask for.)
  const era = state.era ?? 0;
  const year = state.time?.year ?? 0;
  let c = [0, 0.1, 0.25, 0.4, 0.5, 0.55][Math.min(5, era)];
  if (state.tags?.['public-works'] != null && year - state.tags['public-works'] <= 2) c += 0.2;
  if (levelOf(state, 'sewers') || levelOf(state, 'clean-water-rule')) c += 0.1;
  return clamp01(c);
}

function maxWearAround(state, x, z, rad) {
  const [cx, cz] = worldToCell(x, z);
  const wear = state.roads?.wear;
  if (!wear) return 0;
  let best = 0;
  for (let dz = -rad; dz <= rad; dz++)
    for (let dx = -rad; dx <= rad; dx++) {
      const j = cellIndex(cx + dx, cz + dz);
      if (j >= 0 && wear[j] > best) best = wear[j];
    }
  return best;
}

const residentsOf = (state) => {
  const occ = new Map();
  for (const h of state.households) if (h.homeId != null) occ.set(h.homeId, (occ.get(h.homeId) ?? 0) + h.size);
  return occ;
};

// Influence fields on 8-unit blocks: every eyesore, garden and landmark
// stamps what it does to the blocks within a short walk, once; each home then
// reads its own block. (Per-home neighbour scans cost ~8 ms on a city.)
const FB = 8;                                    // block size (world units)
const FW = Math.ceil(768 / FB);                  // the 768-unit map
const FR = Math.ceil(REACH / FB);                // stamp radius in blocks
const blockOf = (x, z) => {
  const i = Math.floor((x + 384) / FB), j = Math.floor((z + 384) / FB);
  return i < 0 || j < 0 || i >= FW || j >= FW ? -1 : j * FW + i;
};

function buildFields(state) {
  const n = FW * FW;
  const f = {
    derelict: new Float32Array(n), rundown: new Float32Array(n), overgrown: new Float32Array(n), smoke: new Float32Array(n),
    green: new Float32Array(n), greenN: new Float32Array(n), landmark: new Float32Array(n), built: new Uint16Array(n),
    sources: [],
  };
  for (const b of state.buildings) {
    if (b.type === 'bridge') continue;
    const k0 = blockOf(b.x, b.z);
    if (k0 < 0) continue;
    if (b.type !== 'park') f.built[k0]++;
    const size = Math.min(2, Math.max(0.5, ((b.w ?? 6) * (b.d ?? 6)) / 50));
    const done = (b.built ?? 1) >= 1;
    const tended = !NO_TEND.has(b.type) && done;
    const derelict = b.flags?.derelict ? size * 0.6 : 0;
    const rundown = !derelict && tended && (b.condition ?? 1) < 0.4 ? (0.4 - (b.condition ?? 1)) * 1.5 : 0;
    const overgrown = (b.wild ?? 0) > 0.35 ? b.wild - 0.35 : 0;
    const smoke = (b.smoke ?? 0) > 0.3 && b.type !== 'home' ? b.smoke - 0.3 : 0;
    const landmark = b.type === 'monument' || b.flags?.heritage ? 0.5 : 0;
    if (derelict) f.sources.push({what: 'derelict', b, v: derelict});
    if (rundown) f.sources.push({what: 'rundown', b, v: rundown});
    if (overgrown) f.sources.push({what: 'overgrown', b, v: overgrown});
    if (smoke) f.sources.push({what: 'smoke', b, v: smoke});
    if (!(derelict || rundown || overgrown || smoke || landmark || tended)) continue;
    const bi = k0 % FW, bj = Math.floor(k0 / FW);
    for (let jj = bj - FR; jj <= bj + FR; jj++)
      for (let ii = bi - FR; ii <= bi + FR; ii++) {
        if (ii < 0 || jj < 0 || ii >= FW || jj >= FW) continue;
        const d = Math.hypot((ii + 0.5) * FB - 384 - b.x, (jj + 0.5) * FB - 384 - b.z);
        const w = 1 - d / REACH;
        if (w <= 0) continue;
        const k = jj * FW + ii;
        if (derelict) f.derelict[k] += w * derelict;
        if (rundown) f.rundown[k] += w * rundown;
        if (overgrown) f.overgrown[k] += w * overgrown;
        if (smoke) f.smoke[k] += w * smoke;
        if (landmark) f.landmark[k] += w * landmark;
        if (tended && w > 0.3) { f.green[k] += Math.max(0, lotLevel(b)); f.greenN[k]++; }
      }
  }
  return f;
}

/** One home's view from the fields: the parts and the score. */
function homeView(state, home, ctx, people) {
  const F = ctx.fields;
  const k = blockOf(home.x, home.z);
  const at = (a) => (k >= 0 ? a[k] : 0);
  const [cx, cz] = worldToCell(home.x, home.z);
  // Gardens next door and the verges and public land around (landscape.js).
  const land = landAround(state, home.x, home.z, 1);
  const lots = at(F.greenN) ? at(F.green) / at(F.greenN) : Math.max(0, lotLevel(home));
  const green = 0.5 * lots + 0.5 * Math.max(0, land);
  const verges = Math.max(0, -land);
  if (verges > 0.15) ctx.touch('verges', 'v', Math.floor(home.x / 24), Math.floor(home.z / 24), home.x, home.z, verges, people, home);
  // Parks reach further than a street.
  let parks = 0;
  for (const p of ctx.parks) {
    const d = Math.hypot(p.x - home.x, p.z - home.z);
    if (d >= PARK_REACH) continue;
    const v = (1 - d / PARK_REACH) * (p.flags?.wild ? 1.1 : 1);
    if (v > parks) parks = v;
    ctx.touch('park', 'b', p.id, 0, p.x, p.z, v, people, home);
  }
  const bank = bankDistance(home.x, home.z);
  const water = bank > 0 && bank < WATER_REACH ? 1 - bank / WATER_REACH : 0;
  if (water > 0.2) ctx.touch('water', 'w', Math.floor(home.z / 32), 0, home.x, home.z, water, people, home);
  // Crowding: buildings in the 3x3 blocks around (an 8-unit block holds 1-3 lots).
  let built = 0;
  if (k >= 0) {
    const bi = k % FW, bj = Math.floor(k / FW);
    for (let jj = bj - 1; jj <= bj + 1; jj++) for (let ii = bi - 1; ii <= bi + 1; ii++) if (ii >= 0 && jj >= 0 && ii < FW && jj < FW) built += F.built[jj * FW + ii];
  }
  const crowd = clamp01((built - 16) / 10);
  if (crowd > 0.3) ctx.touch('crowding', 'c', Math.floor(cx / 8), Math.floor(cz / 8), home.x, home.z, crowd, people, home);
  const busy = wearNorm(maxWearAround(state, home.x, home.z, 2));
  const litter = clamp01(busy * (0.3 + 0.7 * crowd) * (busy > 0.55 ? 1 : 0.4)) * (1 - ctx.clean);
  if (litter > 0.15) ctx.touch('litter', 'l', Math.floor(cx / 6), Math.floor(cz / 6), home.x, home.z, litter, people, home);
  if (green > 0.45) ctx.touch('gardens', 'g', Math.floor(cx / 8), Math.floor(cz / 8), home.x, home.z, green, people, home);
  const parts = {
    derelict: clamp01(at(F.derelict)), rundown: clamp01(at(F.rundown)), overgrown: clamp01(at(F.overgrown) + 0.8 * verges), smoke: clamp01(at(F.smoke)),
    litter, crowding: crowd, green, parks: clamp01(parks), water, landmark: clamp01(at(F.landmark)),
  };
  const looks = clamp01(0.5
    + 0.28 * (parts.green - 0.3) + 0.2 * parts.parks + 0.1 * parts.water + 0.08 * parts.landmark + 0.08 * (ctx.ecology - 0.6)
    - 0.38 * parts.derelict - 0.25 * parts.rundown - 0.2 * parts.overgrown - 0.22 * parts.smoke - 0.2 * parts.litter - 0.12 * parts.crowding);
  return {looks, parts};
}

// The residents each eyesore touches, by district (a few dozen sources).
function touchSources(state, ctx, people) {
  for (const {what, b, v} of ctx.fields.sources) {
    const [cx, cz] = worldToCell(b.x, b.z);
    for (const h of buildingsNear(state, cx, cz, REACH_CELLS)) {
      if (h.type !== 'home' || h === b) continue;
      const w = 1 - Math.hypot(h.x - b.x, h.z - b.z) / REACH;
      if (w > 0) ctx.touch(what, 'b', b.id, 0, b.x, b.z, w * v, people, h);
    }
  }
}

const PART_KEYS = ['derelict', 'rundown', 'overgrown', 'smoke', 'litter', 'crowding', 'green', 'parks', 'water'];
const KEEP_BAD = 3;
const KEEP_GOOD = 2;

/** The yearly pass: landscaping, then looks, then the experience record. */
export function yearlyAesthetics(state, {landscape = true} = {}) {
  if (landscape) yearlyLandscape(state);
  const year = state.time?.year ?? 0;
  const people = residentsOf(state);
  const parks = state.buildings.filter((b) => b.type === 'park' && (b.built ?? 1) >= 1);
  // sources: district -> key -> {what, ref, x, z, sev, residents}
  const sources = new Map();
  const ctx = {
    parks, clean: cleanliness(state), ecology: state.pressures?.ecology ?? 0.6, fields: buildFields(state),
    touch(what, kind, a, b, x, z, v, occ, home) {
      const n = occ.get(home.id) ?? 0;
      if (!n || v <= 0.02) return;
      const did = home.districtId ?? 0;
      let byWhat = sources.get(did);
      if (!byWhat) sources.set(did, (byWhat = new Map()));
      let m = byWhat.get(what);
      if (!m) byWhat.set(what, (m = new Map()));
      // Small-integer keys (no strings per touch).
      const k = (a + 4096) * 8192 + (b + 4096);
      let s = m.get(k);
      if (!s) m.set(k, (s = {what, ref: b || kind !== 'b' ? `${kind}${a},${b}` : `b${a}`, x, z, sev: 0, w: 0, residents: 0}));
      s.sev += v * n;
      s.w += n;
      s.residents += n;
    },
  };
  const districts = {};
  let townSum = 0, townN = 0;
  const factionSum = {}, factionN = {}, factionBad = {};
  const looksById = new Map();
  for (const b of state.buildings) {
    if (b.type !== 'home' || (b.built ?? 1) < 1) continue;
    const n = people.get(b.id) ?? 0;
    const {looks, parts} = homeView(state, b, ctx, people);
    b.looks = r2(looks);
    looksById.set(b.id, b.looks);
    if (!n) continue;
    const did = b.districtId ?? 0;
    const d = (districts[did] ??= {looks: 0, residents: 0, ...Object.fromEntries(PART_KEYS.map((k) => [k, 0]))});
    d.looks += looks * n;
    d.residents += n;
    for (const k of PART_KEYS) d[k] += parts[k] * n;
    townSum += looks * n;
    townN += n;
  }
  touchSources(state, ctx, people);
  for (const id of Object.keys(districts)) {
    const d = districts[id];
    for (const k of ['looks', ...PART_KEYS]) d[k] = r2(d[k] / Math.max(1, d.residents));
  }
  for (const h of state.households) {
    if (h.homeId == null) continue;
    const l = looksById.get(h.homeId);
    if (l == null) continue;
    const f = factionOf(state, h);
    factionSum[f] = (factionSum[f] ?? 0) + l * h.size;
    factionN[f] = (factionN[f] ?? 0) + h.size;
    if (l < SHABBY) factionBad[f] = (factionBad[f] ?? 0) + h.size;
  }
  const factions = {};
  const shabby = {};
  for (const f of Object.keys(factionSum).sort()) {
    factions[f] = r2(factionSum[f] / factionN[f]);
    shabby[f] = r2((factionBad[f] ?? 0) / factionN[f]);
  }
  const experiences = recordExperiences(state, sources, year);
  state.aesthetics = {year, rev: (state.aesthetics?.rev ?? 0) + 1, town: townN ? r2(townSum / townN) : NEUTRAL, districts, factions, shabby, experiences};
  return state.aesthetics;
}

// Keep the few strongest things per district, remembering since when.
function recordExperiences(state, sources, year) {
  const before = state.aesthetics?.experiences ?? {};
  const out = {};
  for (const did of [...sources.keys()].sort((a, b) => a - b)) {
    const prev = new Map((before[did] ?? []).map((e) => [`${e.what}:${e.ref}`, e.since]));
    const list = [...sources.get(did).values()].flatMap((m) => [...m.values()]).map((s) => ({
      what: s.what, ref: s.ref, x: Math.round(s.x), z: Math.round(s.z),
      severity: r2(clamp01(s.sev / Math.max(1, s.w))), residents: s.residents,
      since: prev.get(`${s.what}:${s.ref}`) ?? year,
    }));
    const rank = (a, b) => b.severity * b.residents - a.severity * a.residents || (a.ref < b.ref ? -1 : a.ref > b.ref ? 1 : 0);
    const bad = list.filter((e) => NEGATIVE.has(e.what) && e.severity >= 0.05).sort(rank).slice(0, KEEP_BAD);
    const good = list.filter((e) => !NEGATIVE.has(e.what)).sort(rank).slice(0, KEEP_GOOD);
    if (bad.length || good.length) out[did] = [...bad, ...good];
  }
  return out;
}
