// Per-centre numbers and character (sim-core's side of design-centres.md).
// sim-world's centres.js founds centres, assigns centreId to buildings, households and
// districts by travel cost (yearly) and keeps each centre's yearly pop, jobs and rank.
// Here, monthly, each live centre gets c.monthly = {pop, households, homeless, jobs,
// workers, employed, employment, avgWealth, wellbeing, density}, and yearly a local
// character (c.character): the archetype its own mix of work leans to.

import {byId} from './state.js';
import {priceLevel, clamp} from './pressures.js';

const live = (state) => (state.centres ?? []).filter((c) => c.mergedInto == null);

export function centreIndicators(state) {
  const centres = live(state);
  if (!centres.length) return;
  const rows = new Map();
  for (const c of centres) rows.set(c.id, {pop: 0, households: 0, homeless: 0, jobs: 0, workers: 0, employed: 0, wealth: 0, hunger: 0, homes: 0, homeUnits: 0});
  const seat = centres[0].id;
  for (const h of state.households) {
    const r = rows.get(h.centreId) ?? rows.get(seat);
    r.pop += h.size;
    r.households++;
    if (h.homeId == null) r.homeless++;
    r.workers += h.workers ?? 0;
    r.employed += h.employed ?? 0;
    r.wealth += h.wealth;
    r.hunger += (h.hunger ?? 0) * h.size;
  }
  for (const e of state.enterprises) {
    const r = rows.get(e.centreId) ?? rows.get(seat);
    r.jobs += e.jobs;
  }
  const price = priceLevel(state);
  for (const c of centres) {
    const r = rows.get(c.id);
    const employment = r.workers > 0 ? clamp(r.employed / r.workers, 0, 1) : 1;
    const homes = r.households ? 1 - r.homeless / r.households : 1;
    const fed = r.pop ? 1 - clamp(r.hunger / r.pop, 0, 1) : 1;
    c.monthly = {
      pop: r.pop,
      households: r.households,
      homeless: r.homeless,
      jobs: Math.round(r.jobs),
      workers: Math.round(r.workers),
      employed: Math.round(r.employed),
      employment: round2(employment),
      avgWealth: Math.round(r.households ? r.wealth / r.households / price : 0),
      // Mood: the town's wellbeing nudged by this centre's own work, homes and food.
      wellbeing: Math.round(clamp(state.indicators.wellbeing + 20 * (employment - 0.85) + 15 * (homes - 0.95) + 20 * (fed - 1), 0, 100)),
      density: round2(c.density ?? 0),
    };
  }
}

const round2 = (x) => Math.round(x * 100) / 100;

// The character a centre's own work mix leans to. Shares of its jobs by kind of work
// are compared with the whole region's; the most over-represented kind wins if it is
// clearly ahead, otherwise the centre shares the region's archetype.
const CHARACTER_OF = {
  mill: 'mill', factory: 'mill', workshop: 'mill', quarry: 'mill',
  quay: 'port', warehouse: 'port',
  shop: 'market-town', market: 'market-town', inn: 'market-town',
  exchange: 'exchange',
  chapel: 'cathedral',
  school: 'scholar', library: 'scholar',
  farm: 'garden', park: 'garden',
};

export function centreCharacters(state) {
  const centres = live(state);
  if (centres.length < 2) {
    if (centres[0]) centres[0].character = state.archetype;
    return;
  }
  const region = {}, local = new Map(centres.map((c) => [c.id, {}]));
  let regionTotal = 0;
  const totals = new Map();
  for (const e of state.enterprises) {
    const b = byId(state, 'buildings', e.buildingId);
    const kind = CHARACTER_OF[e.type];
    if (!kind || !b) continue;
    const jobs = Math.max(1, e.jobs);
    region[kind] = (region[kind] ?? 0) + jobs;
    regionTotal += jobs;
    const row = local.get(b.centreId);
    if (!row) continue;
    row[kind] = (row[kind] ?? 0) + jobs;
    totals.set(b.centreId, (totals.get(b.centreId) ?? 0) + jobs);
  }
  for (const c of centres) {
    const total = totals.get(c.id) ?? 0;
    if (total < 10 || regionTotal <= 0) {
      c.character = state.archetype;
      continue;
    }
    let best = null, bestLift = 1.25;
    for (const [kind, jobs] of Object.entries(local.get(c.id))) {
      const lift = jobs / total / (region[kind] / regionTotal);
      if (lift > bestLift) {
        best = kind;
        bestLift = lift;
      }
    }
    c.character = best ?? state.archetype;
  }
}
