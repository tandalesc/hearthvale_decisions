// Districts form where buildings cluster away from existing district centres.
// Each gets a plain name ("Mill End", "Low Quarter") from word lists, picked
// with the seeded RNG and coloured by what stands nearby.
import { rng } from './rng.js';
import { emitChronicle } from './state.js';
import { centreRef } from './centres.js';
import { riverX, heightAt, bankDistance, nearestWaterKind, KIND, bankSide } from '../terrain.js';

const REACH = 56;          // world units: a building this far from every centre is unclaimed
const MIN_NEW = 10;        // unclaimed buildings needed to found a district
const RIVER_PENALTY = 40;  // crossing the river counts as this much extra distance
const SKIP = new Set(['farm', 'bridge', 'park', 'monument']);

const SUFFIXES = ['End', 'Quarter', 'Row', 'Side', 'Green', 'Gate', 'Lane', 'Cross', 'Fields', 'Hill', 'Bank', 'Town'];
const FEATURE_WORDS = {
  river: ['Ford', 'Brook', 'Water', 'Bridge', 'Weir'],
  quay: ['Quay', 'Wharf', 'Dock'],
  mill: ['Mill', 'Wheel', 'Kiln'],
  chapel: ['Chapel', 'Church', 'Bell'],
  market: ['Market', 'Cheap', 'Fair'],
  high: ['High', 'Hill', 'Crown'],
  low: ['Low', 'Marsh', 'Meadow'],
  farm: ['Orchard', 'Barley', 'Barn'],
  craft: ['Tanner', 'Smith', 'Cooper', 'Weaver'],
};
const COMPASS = ['North', 'East', 'South', 'West'];
const BAD_PAIRS = new Set(['Hill Hill', 'Bank Bank', 'Bridge Bank', 'Water Bank', 'Ford Cross', 'Meadow Fields']);

function sideOf(x, z) { return bankSide(x, z) ? 1 : -1; }

function distance(a, b) {
  const d = Math.hypot(a.x - b.x, a.z - b.z);
  return sideOf(a.x, a.z) === sideOf(b.x, b.z) ? d : d + RIVER_PENALTY;
}

function nearestDistrict(districts, p) {
  let best = null, bestD = Infinity;
  for (const d of districts) {
    const dist = distance(d.centroid, p);
    if (dist < bestD) { bestD = dist; best = d; }
  }
  return { district: best, dist: bestD };
}

function nextDistrictId(state) {
  return (state.districts ?? []).reduce((m, d) => Math.max(m, d.id), 0) + 1;
}

// Yearly. Assigns every building, lot and household to its nearest district,
// founds new districts where enough buildings sit beyond reach, and moves
// centres toward their members. Returns the districts founded this call.
export function updateDistricts(state) {
  state.districts ??= [];
  const founded = [];
  const members = assign(state);
  const unclaimed = members.get(null) ?? [];
  if (unclaimed.length >= MIN_NEW) {
    const d = foundDistrict(state, unclaimed);
    founded.push(d);
    assign(state);
  }
  recentre(state);
  syncRecords(state);
  return founded;
}

// The same pass in steps, one a tick (world.js): 0 assign and maybe found,
// 1 reassign after a founding, 2 recentre and sync. Returns the next step or null.
export function updateDistrictsStep(state, step) {
  state.districts ??= [];
  if (step === 0) {
    const unclaimed = assign(state).get(null) ?? [];
    if (unclaimed.length < MIN_NEW) return 2;
    foundDistrict(state, unclaimed);
    return 1;
  }
  if (step === 1) { assign(state); return 2; }
  recentre(state);
  syncRecords(state);
  return null;
}

function assign(state) {
  const groups = new Map();
  // Each district's bank once, not once per building.
  const ds = state.districts.map(d => ({ d, x: d.centroid.x, z: d.centroid.z, side: sideOf(d.centroid.x, d.centroid.z) }));
  const nearest = b => {
    const side = sideOf(b.x, b.z);
    let district = null, dist = Infinity;
    for (const e of ds) {
      const dx = e.x - b.x, dz = e.z - b.z;
      const pen = e.side === side ? 0 : RIVER_PENALTY;
      // Cheap reject before the square root.
      if (pen >= dist || dx * dx + dz * dz >= (dist - pen) * (dist - pen)) continue;
      dist = Math.sqrt(dx * dx + dz * dz) + pen;
      district = e.d;
    }
    return { district, dist };
  };
  for (const b of state.buildings ?? []) {
    const { district, dist } = nearest(b);
    if (SKIP.has(b.type)) {
      b.districtId = district?.id ?? b.districtId ?? null;
      continue;
    }
    const key = district && dist <= REACH ? district.id : null;
    if (key != null) b.districtId = key;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(b);
  }
  return groups;
}

// Founds a district on the largest same-bank group of unclaimed buildings.
function foundDistrict(state, buildings) {
  const banks = { [-1]: [], [1]: [] };
  for (const b of buildings) banks[sideOf(b.x, b.z)].push(b);
  const group = banks[-1].length >= banks[1].length ? banks[-1] : banks[1];
  const centroid = mean(group.length >= MIN_NEW / 2 ? group : buildings);
  const name = nameDistrict(state, centroid, group);
  const d = {
    id: nextDistrictId(state), name, character: characterOf(group), centroid,
    lots: 0, buildings: group.length, tags: [], founded: state.time?.year ?? 0,
  };
  state.districts.push(d);
  emitChronicle(state, { kind: 'line', text: foundingLine(state, d), refs: { districtId: d.id, ...centreRef(state, d.centroid.x, d.centroid.z) } });
  return d;
}

function mean(list) {
  let x = 0, z = 0;
  for (const b of list) { x += b.x; z += b.z; }
  return { x: x / list.length, z: z / list.length };
}

function recentre(state) {
  const sums = new Map();
  for (const b of state.buildings ?? []) {
    if (SKIP.has(b.type) || b.districtId == null) continue;
    const s = sums.get(b.districtId) ?? { x: 0, z: 0, n: 0 };
    s.x += b.x; s.z += b.z; s.n++;
    sums.set(b.districtId, s);
  }
  for (const d of state.districts) {
    const s = sums.get(d.id);
    d.buildings = s?.n ?? 0;
    if (!s) continue;
    // Drift a quarter of the way each year, so names stay attached to places.
    d.centroid = { x: d.centroid.x + (s.x / s.n - d.centroid.x) * 0.25, z: d.centroid.z + (s.z / s.n - d.centroid.z) * 0.25 };
  }
}

function syncRecords(state) {
  const homeDistrict = new Map();
  for (const b of state.buildings ?? []) homeDistrict.set(b.id, b.districtId);
  const counts = new Map();
  for (const lot of state.lots ?? []) {
    if (lot.buildingId != null && homeDistrict.has(lot.buildingId)) lot.districtId = homeDistrict.get(lot.buildingId);
    counts.set(lot.districtId, (counts.get(lot.districtId) ?? 0) + 1);
  }
  for (const d of state.districts) d.lots = counts.get(d.id) ?? 0;
  for (const h of state.households ?? []) {
    const id = homeDistrict.get(h.homeId);
    if (id != null) h.districtId = id;
  }
}

// ---------------------------------------------------------------- names

function features(state, centroid, group) {
  const f = [];
  const types = new Map();
  for (const b of group) types.set(b.type, (types.get(b.type) ?? 0) + 1);
  const nearRiver = Math.abs(centroid.x - riverX(centroid.z)) < 30 && nearestWaterKind(centroid.x, centroid.z) === KIND.RIVER;
  if (types.get('quay') || types.get('warehouse')) f.push('quay');
  if (nearRiver) f.push('river');
  if (types.get('mill') || types.get('factory')) f.push('mill');
  if (types.get('chapel')) f.push('chapel');
  if (types.get('market') || (types.get('shop') ?? 0) >= 3) f.push('market');
  if ((types.get('workshop') ?? 0) >= 2) f.push('craft');
  const h = heightAt(centroid.x, centroid.z);
  if (h > 3) f.push('high');
  else if (h < 1) f.push('low');
  if ((state.buildings ?? []).filter(b => b.type === 'farm' && Math.hypot(b.x - centroid.x, b.z - centroid.z) < 50).length >= 2) f.push('farm');
  return f;
}

function compassWord(state, centroid) {
  const others = state.districts ?? [];
  if (!others.length) return 'Old';
  const c = mean(others.map(d => d.centroid));
  const dx = centroid.x - c.x, dz = centroid.z - c.z;
  if (Math.abs(dx) > Math.abs(dz)) return dx > 0 ? COMPASS[1] : COMPASS[3];
  return dz > 0 ? COMPASS[2] : COMPASS[0];
}

export function nameDistrict(state, centroid, group = []) {
  const taken = new Set((state.districts ?? []).map(d => d.name));
  const feats = features(state, centroid, group);
  for (let attempt = 0; attempt < 24; attempt++) {
    const useFeature = feats.length && (attempt < 12 || rng(state) < 0.5);
    const words = useFeature ? FEATURE_WORDS[feats[Math.floor(rng(state) * feats.length)]] : [compassWord(state, centroid), 'New', 'Old'];
    const first = words[Math.floor(rng(state) * words.length)];
    const second = SUFFIXES[Math.floor(rng(state) * SUFFIXES.length)];
    const name = `${first} ${second}`;
    if (!taken.has(name) && !BAD_PAIRS.has(name) && first !== second) return name;
  }
  return `${compassWord(state, centroid)} Quarter ${taken.size + 1}`;
}

function characterOf(group) {
  const n = (t) => group.filter(b => b.type === t).length;
  if (n('mill') + n('factory') + n('workshop') >= 3) return 'works';
  if (n('quay') + n('warehouse') >= 2) return 'waterside';
  if (n('shop') + n('market') + n('inn') >= 3) return 'market';
  return 'homes';
}

function waterWord(x, z) {
  const k = nearestWaterKind(x, z);
  return k === KIND.SEA ? 'sea' : k === KIND.LAKE ? 'lake' : k === KIND.POND ? 'pond' : k === KIND.CREEK ? 'creeks' : 'river';
}

function foundingLine(state, d) {
  const others = state.districts.filter(o => o !== d);
  const across = others.length && others.every(o => sideOf(o.centroid.x, o.centroid.z) !== sideOf(d.centroid.x, d.centroid.z));
  const where = across ? 'across the river'
    : bankDistance(d.centroid.x, d.centroid.z) < 26 ? `by the ${waterWord(d.centroid.x, d.centroid.z)}`
      : heightAt(d.centroid.x, d.centroid.z) > 3 ? 'up on the hill'
        : 'at the edge of town';
  return `A new quarter is growing ${where}. People call it ${d.name}.`;
}

export function districtById(state, id) { return (state.districts ?? []).find(d => d.id === id) ?? null; }
