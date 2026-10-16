// Parks: natural spots near homes that the town keeps green for good.
//
// Two ways in, both through governance (the player never places one):
//   - A body (the Moot, the Planning Office or the Festival Society) brings a
//     "keep it green" card naming a place people already walk out to: a
//     riverbank, a hilltop, a quiet meadow between streets (work kind 'park',
//     template 'green-space').
//   - With the Green reserves rule in force, the land system itself sets
//     aside the best such spot each year until the town has enough.
//
// A park is a building of type 'park' with flags.wild (it stays natural:
// nobody builds there, trees and meadow stay; it is tended, with a path, a
// bench or two and mown edges, drawn by the renderer). One right on the water
// is a beach (flags.beach): a sandy bank people gather on in summer.
// Residents value parks: aesthetics.js counts them in every home's looks, and
// leisure walks already go to the nearest park.

import {placeBuilding, costOf, eraMaxTier} from './buildings.js';
import {lotGrid, buildingBins, buildingsNear, lotSlope, prominenceAt, nearestDistrictId} from './sites.js';
import {footprints, terrainGrid, cellIndex, cellCenter, wearNorm, CELL, ORIGIN_X, GRID_W} from './roads.js';
import {bankDistance} from '../terrain.js';
import {emitChronicle} from './state.js';
import {levelOf} from './policies.js';
import {centreRef} from './centres.js';

const STEP = 5;             // anchor spacing (cells)
const MIN_HOMES = 4;        // homes within reach that would use it
const HOME_REACH = 20;      // cells
const APART = 50;           // world units between parks
const MAX_SLOPE = 0.22;

const parkSize = (era) => (era >= 3 ? 7 : 5);

export const parksOf = (state) => (state.buildings ?? []).filter((b) => b.type === 'park');

function districtName(state, x, z) {
  const id = nearestDistrictId(state, x, z);
  return state.districts?.find((d) => d.id === id)?.name ?? null;
}

// Why the rectangle (plus a one-cell margin) cannot be a park, or null.
function blockedRect(state, cx, cz, n, ctx) {
  const {tier, planned} = state.roads;
  for (let z = cz - 1; z <= cz + n; z++)
    for (let x = cx - 1; x <= cx + n; x++) {
      const j = cellIndex(x, z);
      if (j < 0) return true;
      if (ctx.lots[j] || ctx.fp.blocked[j] || ctx.fp.field[j]) return true;
      const inside = x >= cx && z >= cz && x < cx + n && z < cz + n;
      if (!inside) continue;
      if (ctx.water[j] || tier[j] >= 3 || (planned[j] & 3)) return true;
    }
  return false;
}

function quietness(state, cx, cz, n) {
  const wear = state.roads.wear;
  let sum = 0, k = 0;
  for (let z = cz; z < cz + n; z += 2)
    for (let x = cx; x < cx + n; x += 2) {
      const j = cellIndex(x, z);
      if (j >= 0) { sum += wearNorm(wear[j]); k++; }
    }
  return 1 - (k ? sum / k : 0);
}

/**
 * The most attractive natural spots near homes, best first (at most `limit`):
 * work candidates for works.js ({key, kind: 'park', site, x, z, where, place,
 * cost, title, why, options, beach}).
 */
export function parkCandidates(state, {limit = 2} = {}) {
  const era = state.era ?? 0;
  if (era < 1) return [];
  const homes = (state.buildings ?? []).filter((b) => b.type === 'home' && (b.built ?? 1) >= 1);
  if (homes.length < 20) return [];
  const n = parkSize(era);
  const tier = Math.max(1, Math.min(era >= 3 ? 2 : 1, eraMaxTier('park', era)));
  const existing = parksOf(state);
  const {centroid, radius} = buildingBins(state);
  const ctx = {lots: lotGrid(state).cells, fp: footprints(state), water: terrainGrid().water};
  const reach = Math.ceil((radius + 30) / CELL);
  const [ccx, ccz] = [Math.floor((centroid.x - ORIGIN_X) / CELL), Math.floor((centroid.z - ORIGIN_X) / CELL)];
  // Homes per 10-cell bin: only spots with homes around are looked at.
  const BIN = 10, BW = Math.ceil(GRID_W / BIN);
  const homeBins = new Uint16Array(BW * BW);
  for (const b of homes) {
    const i = Math.floor((b.x - ORIGIN_X) / CELL / BIN), j = Math.floor((b.z - ORIGIN_X) / CELL / BIN);
    if (i >= 0 && j >= 0 && i < BW && j < BW) homeBins[j * BW + i]++;
  }
  const homesAround = (mx, mz) => {
    const bi = Math.floor(mx / BIN), bj = Math.floor(mz / BIN);
    let k = 0;
    for (let j = bj - 1; j <= bj + 1; j++) for (let i = bi - 1; i <= bi + 1; i++) if (i >= 0 && j >= 0 && i < BW && j < BW) k += homeBins[j * BW + i];
    return k;
  };
  const found = [];
  for (let cz = ccz - reach; cz <= ccz + reach; cz += STEP)
    for (let cx = ccx - reach; cx <= ccx + reach; cx += STEP) {
      const mx = cx + (n >> 1), mz = cz + (n >> 1);
      const mid = cellIndex(mx, mz);
      if (mid < 0 || homesAround(mx, mz) < MIN_HOMES) continue;
      const {x, z} = cellCenter(mid);
      if (existing.some((p) => Math.hypot(p.x - x, p.z - z) < APART)) continue;
      if (blockedRect(state, cx, cz, n, ctx)) continue;
      const lot = {cx, cz, w: n, h: n};
      const slope = lotSlope(lot);
      if (slope > MAX_SLOPE) continue;
      let users = 0;
      for (const b of buildingsNear(state, mx, mz, HOME_REACH)) if (b.type === 'home') users++;
      if (users < MIN_HOMES) continue;
      const bank = bankDistance(x, z);
      const water = bank > 0 && bank < 30 ? 1 - bank / 30 : 0;
      const beach = bank > 0 && bank < (n * CELL) / 2 + 4;
      const hill = prominenceAt({x, z});
      const quiet = quietness(state, cx, cz, n);
      const rolling = slope > 0.03 && slope < 0.15 ? 1 : 0;
      const beauty = 0.55 * water + 0.5 * hill + 0.3 * quiet + 0.15 * rolling + (beach ? 0.15 : 0);
      const score = beauty * (0.4 + 0.6 * Math.min(1, users / 25));
      found.push({cx, cz, n, x, z, score, beach, hill, water, users});
    }
  found.sort((a, b) => b.score - a.score || a.cz - b.cz || a.cx - b.cx);
  const out = [];
  for (const f of found) {
    if (out.length >= limit) break;
    if (f.score < 0.25) break;
    if (out.some((o) => Math.hypot(o.x - f.x, o.z - f.z) < APART)) continue;
    out.push(describe(state, f, tier));
  }
  return out;
}

function describe(state, f, tier) {
  const where = districtName(state, f.x, f.z) ?? 'the town';
  const kind = f.beach ? 'beach' : f.water > 0.4 ? 'bank' : f.hill > 0.25 ? 'hill' : 'meadow';
  const place = {
    beach: `the sandy bank by ${where}`, bank: `the riverbank by ${where}`,
    hill: `the hill above ${where}`, meadow: `the meadow by ${where}`,
  }[kind];
  const front = cellIndex(f.cx + (f.n >> 1), f.cz + f.n);
  const site = {type: 'park', tier, cx: f.cx, cz: f.cz, w: f.n, h: f.n, rot: 0, front, x: f.x, z: f.z,
    districtId: nearestDistrictId(state, f.x, f.z)};
  const cost = Math.round(costOf('park', tier, state.era ?? 0) * 0.6);
  const cap = place.charAt(0).toUpperCase() + place.slice(1);
  return {
    key: `park:${Math.floor(f.cx / 16)},${Math.floor(f.cz / 16)}`, kind: 'park', site, x: f.x, z: f.z, where, place, cost,
    beach: f.beach, spot: kind,
    title: `Keep ${place} green`,
    why: `${cap} is a lovely spot. Families walk out to it on rest days. Keep it green for good, with a path and a bench or two.`,
    options: [{key: 'build', cost}, {key: 'wait', cost: 0}],
  };
}

const NAME_END = {beach: 'Strand', bank: 'Water Green', hill: 'Hill Park', meadow: 'Green'};

// "Mill Row Green", "Weir End Strand": the district and the kind of spot,
// never a name already taken ("Water Green" gets a Park, not a Green Green).
function parkName(state, work) {
  const where = work.where === 'the town' ? 'Town' : work.where;
  const taken = new Set(parksOf(state).map((p) => p.parkName).filter(Boolean));
  const last = where.split(' ').at(-1);
  const ends = [NAME_END[work.spot] ?? 'Green', 'Park', 'Gardens', 'Common', 'Fields', 'Walk'];
  for (const end of ends) {
    const name = `${where} ${end}`;
    if (!taken.has(name) && !end.split(' ').includes(last)) return name;
  }
  return `${where} Park ${taken.size + 1}`;
}

/** Set the spot aside: a park nobody may build on. Returns {ok, building, project}. */
export function designatePark(state, work, {payer = 'treasury', paid = false, via = 'council'} = {}) {
  const site = work.site;
  const tier = site.tier ?? 1;
  const {building, project} = placeBuilding(state, site, {
    type: 'park', tier, variant: tier >= 2 ? 'park' : 'green', payer, paid, cost: work.cost, reason: 'park',
  });
  building.flags.wild = 1;
  if (work.beach) building.flags.beach = 1;
  building.parkName = parkName(state, work);
  project.data.workKey = work.key;
  const how = via === 'rule' ? 'The green reserve rule keeps' : 'The town will keep';
  emitChronicle(state, {kind: 'line', text: `${how} ${work.place} green. People call it ${building.parkName}.`,
    refs: {buildingId: building.id, ...centreRef(state, building.x, building.z)}});
  return {ok: true, building, project, projects: [project]};
}

// How many parks the Green reserves rule asks for: more with each level, and
// more as the town grows.
export function reserveTarget(state) {
  const level = levelOf(state, 'park-reserve');
  if (!level) return 0;
  const pop = state.indicators?.pop ?? 0;
  return Math.min(14, level * (1 + Math.floor(pop / 1500)));
}

/** Yearly: under Green reserves, the land system sets aside one spot a year until there are enough. */
export function yearlyParkReserve(state) {
  const target = reserveTarget(state);
  if (!target || parksOf(state).length >= target) return null;
  const [best] = parkCandidates(state, {limit: 1});
  if (!best) return null;
  return designatePark(state, best, {payer: 'treasury', paid: true, via: 'rule'});
}
