// Leisure outings: when a walker's routine picks leisure, sometimes it is not the
// nearest park, inn or monument but something of its own: fishing a calm reach, leaning
// on a bridge rail to watch the water (the sunset, when the light is low), a walk along
// the woods' edge or out along a track, berries in autumn, birds, a picnic by the river,
// a sunbathe in high summer, the chapel steps, a summer evening outside the inn, a turn
// round a nature reserve, children's games in front of home.
//
// outingTarget(state, p, h) -> a task target {type, id, x, z, activity, dwell} or null
// (the ordinary leisure choice stands). Each OUTINGS entry names its activity
// (gatherings.js ACTIVITIES: layout, picker, pose, dwell), the place kind it happens at,
// how far a walker will go for it, a base weight, season, weather and day-phase
// preferences, and who does it (age band, wealth, trade). On top: what is near enough,
// a walker's favourites (a stable per-person habit, so people repeat what they like),
// and a modest share of leisure trips overall (OUTING_SHARE), so the town's motion stays
// mostly ordinary errands and the sim stays cheap.
//
// Deterministic: hashes of the walker, its rev and the tick; the clock's day phase
// (daylight.js simPhase) and season; the saved weather. No random draws are taken.

import {hash32, hashUnit} from './rng.js';
import {byId} from './state.js';
import {season} from './clock.js';
import {simPhase, lowSun, isNight, isEvening, isMorning} from '../daylight.js';
import {placeIndex} from './places.js';
import {densityAt} from './density.js';
import {accessPoint, crowdTolerance} from './people.js';
import {occasionFor, layoutOf, occasionHasRoom} from './gatherings.js';

export const OUTING_SHARE = 0.4;     // of leisure choices, at most, before preferences

const SUMMER = [0.9, 1.5, 0.8, 0.2], WARM = [1, 1.3, 1, 0.4], MILD = [1, 1, 1, 0.6];

// place: 'bank' | 'deck' | 'wood' | 'trail' (places.js), 'park' | 'wildpark' | 'steps' |
// 'inn' | 'home' (buildings); reach: how far a walker goes for it; who(t): may this
// walker; phase(ph): a multiplier by day phase; rain: multiplier at full rain; snow: at
// full snow; frozen: never on icy water.
export const OUTINGS = [
  // Angling: a habit of a few (traitsOf angler), early and late, commoner in a hamlet
  // than a city and rare by a busy, central reach (anglingHere).
  {activity: 'fishing', place: 'bank', reach: 130, weight: 1.0, seasons: [1, 1.6, 1, 0.3], rain: 0.5, frozen: true, angling: true,
    phase: (ph) => (isMorning(ph) || isEvening(ph) ? 1.8 : isNight(ph) ? 0.2 : 0.5), who: () => true, calm: true},
  {activity: 'bridge-fish', place: 'deck', reach: 110, weight: 0.4, seasons: [1, 1.5, 1, 0.3], rain: 0.5, frozen: true, angling: true,
    phase: (ph) => (isMorning(ph) || isEvening(ph) ? 1.8 : isNight(ph) ? 0.2 : 0.5), who: () => true},
  {activity: 'bridge-gaze', place: 'deck', reach: 110, weight: 0.7, seasons: MILD, rain: 0.3,
    phase: (ph) => (lowSun(ph) ? 2.4 : isNight(ph) ? 0.4 : 0.8), who: () => true},
  {activity: 'bank-gaze', place: 'bank', reach: 110, weight: 0.3, seasons: MILD, rain: 0.3,
    phase: (ph) => (lowSun(ph) ? 2.2 : isNight(ph) ? 0.3 : 0.7), who: () => true},
  {activity: 'river-picnic', place: 'bank', reach: 110, weight: 0.5, seasons: SUMMER, rain: 0.1, snow: 0,
    phase: (ph) => (isNight(ph) ? 0.1 : 1), who: (t) => t.household > 1},
  {activity: 'wood-walk', place: 'wood', reach: 190, weight: 0.8, seasons: [1.2, 1, 1.3, 0.5], rain: 0.4,
    phase: (ph) => (isNight(ph) ? 0.1 : 1), who: (t) => t.age !== 'child'},
  {activity: 'berry-pick', place: 'wood', reach: 170, weight: 0.9, seasons: [0, 0.3, 2, 0], rain: 0.5,
    phase: (ph) => (isNight(ph) ? 0 : 1), who: () => true},
  {activity: 'birdwatch', place: 'wood', reach: 170, weight: 0.3, seasons: [1.5, 1, 1, 0.5], rain: 0.3,
    phase: (ph) => (isMorning(ph) ? 1.8 : isNight(ph) ? 0 : 1), who: (t) => t.age !== 'child' && t.quiet},
  {activity: 'trail-walk', place: 'trail', reach: 170, weight: 0.8, seasons: WARM, rain: 0.4,
    phase: (ph) => (isNight(ph) ? 0.1 : lowSun(ph) ? 1.4 : 1), who: (t) => t.age !== 'child'},
  {activity: 'reserve-walk', place: 'wildpark', reach: 140, weight: 0.6, seasons: WARM, rain: 0.5,
    phase: (ph) => (isNight(ph) ? 0.1 : 1), who: () => true},
  {activity: 'lawn-lie', place: 'park', reach: 120, weight: 0.5, seasons: [0.2, 2, 0.2, 0], rain: 0, snow: 0,
    phase: (ph) => (isNight(ph) ? 0 : 1), who: (t) => t.age !== 'elder'},
  {activity: 'steps-sit', place: 'steps', reach: 70, weight: 0.5, seasons: MILD, rain: 0.2,
    phase: (ph) => (isEvening(ph) ? 1.4 : 1), who: () => true},
  {activity: 'mingle', place: 'inn', reach: 90, weight: 0.6, seasons: [0.6, 1.8, 0.8, 0.3], rain: 0.3,
    phase: (ph) => (isEvening(ph) ? 2 : 0.5), who: (t) => t.age === 'adult'},
  {activity: 'tag', place: 'home', reach: 1e9, weight: 1.6, seasons: [1, 1.2, 1, 0.5], rain: 0.2,
    phase: (ph) => (isNight(ph) ? 0 : 1), who: (t) => t.age === 'child'},
];

const STEPS = ['chapel', 'moot', 'library', 'school', 'union-hall'];

/** A walker's traits: age band (stable per walker within its household), household
 * size, wealth band 0..2, trade, whether it likes quiet, and whether it is one of the
 * few who fish (more of the old and the young, of labourers and farmers). */
export function traitsOf(state, p, h) {
  const kids = h && (h.householdType ?? h.type) === 'family-with-children' && (h.size ?? 1) > 2;
  const age = h?.lifeStage === 'elder' ? 'elder' : kids && hashUnit((p.id * 2246822519) >>> 0) < 0.4 ? 'child' : 'adult';
  const bands = state.bands?.wealth;
  const wealth = !h || !bands ? 1 : h.wealth < bands[0] ? 0 : h.wealth < bands[1] ? 1 : 2;
  const trade = h?.trade ?? 'none';
  const share = (ANGLERS[age] ?? 0.1) + (trade === 'farm' || trade === 'labour' ? 0.12 : 0);
  return {age, household: h?.size ?? 1, wealth, trade, quiet: crowdTolerance(p, h) < 0.45, angler: hashUnit((p.id * 7451 + 3) >>> 0) < share};
}
const ANGLERS = {elder: 0.3, child: 0.25, adult: 0.1};

/** How much a settlement fishes: a pastime (and a supper) in a hamlet, rare in a city. */
export function settlementAngling(state) {
  const pop = state.indicators?.pop ?? state.people?.length ?? 0;
  return pop < 150 ? 3 : pop < 1000 ? 1.2 : pop < 3000 ? 0.5 : 0.3;
}

/** How fishable a place is for how busy and central it is: walkers about (density.js)
 * and the middle of town keep anglers away. */
export function anglingHere(state, x, z, town) {
  const busy = 1 / (1 + densityAt(state, x, z) / 1.5);
  const central = Math.hypot(x - town.x, z - town.z) < town.radius * 0.5 ? 0.25 : 1;
  return busy * central;
}

// A walker's favourite outings: a stable habit (indices into OUTINGS).
export function favourites(p) {
  const h = hash32((p.id * 2654435761) >>> 0);
  return [h % OUTINGS.length, (h >>> 8) % OUTINGS.length];
}

/** How much this walker wants outing o now (before distance), 0 if not at all. */
export function outingWeight(state, o, t, fav, i) {
  if (!o.who(t)) return 0;
  const s = season(state.time.month);
  let w = o.weight * (o.seasons?.[s] ?? 1) * (o.phase ? o.phase(simPhase(state.time)) : 1);
  const rain = state.weather?.rain ?? 0, snow = state.weather?.snow ?? 0;
  if (rain > 0 && o.rain != null) w *= 1 + (o.rain - 1) * Math.min(1, rain);
  if (snow > 0 && o.snow != null) w *= 1 + (o.snow - 1) * Math.min(1, snow);
  if (o.frozen && frozen(state)) w = 0;
  // Who tends to: the well-off fish and walk more, labourers more often take the steps
  // and the inn; favourites three times over.
  if (t.wealth === 2 && (o.place === 'wood' || o.place === 'trail')) w *= 1.3;
  if (o.angling) w *= (t.angler ? 2.5 : 0.03) * settlementAngling(state);
  if ((t.trade === 'labour' || t.trade === 'craft') && (o.place === 'inn' || o.place === 'steps')) w *= 1.3;
  if (fav[0] === i) w *= 3;
  else if (fav[1] === i) w *= 1.6;
  return w;
}

/** Ice on the water: a snowy winter (the renderer draws an ice rim under snow). */
export const frozen = (state) => season(state.time.month) === 3 && (state.weather?.snow ?? 0) > 0.2;

// The place for outing o nearest the walker (anglers weigh calm water too), within
// reach and with room laid out there (its activity's layout has spots): {target, d}, or
// null. Of the PLACE_TRIES best by score.
const PLACE_TRIES = 3;
const candScratch = [];
function placeFor(state, o, p, idx, world, avoid = null) {
  candScratch.length = 0;
  const layout = layoutOf(o.activity);
  const keep = (type, id, x, z, building, score, d) => {
    if (avoid && avoid.includes(id)) return;
    let i = candScratch.length;
    while (i > 0 && candScratch[i - 1].score > score) i--;
    if (i >= PLACE_TRIES) return;
    candScratch.splice(i, 0, {type, id, x, z, building, score, d});
    if (candScratch.length > PLACE_TRIES) candScratch.length = PLACE_TRIES;
  };
  if (o.place === 'bank' || o.place === 'deck' || o.place === 'wood' || o.place === 'trail') {
    const list = o.place === 'bank' ? idx.banks : o.place === 'deck' ? idx.decks : o.place === 'wood' ? idx.woods : idx.trails;
    for (const pl of list) {
      const d = Math.hypot(pl.x - p.x, pl.z - p.z);
      if (d <= o.reach) keep('place', pl.id, pl.x, pl.z, null, o.calm ? d - 40 * pl.calm + 15 * Math.min(3, densityAt(state, pl.x, pl.z)) : d, d);
    }
  } else if (o.place === 'home') {
    const home = p.homeId != null ? byId(state, 'buildings', p.homeId) : null;
    if (home) keep('building', home.id, home.x, home.z, home, 0, Math.hypot(home.x - p.x, home.z - p.z));
  } else {
    const types = o.place === 'steps' ? STEPS : o.place === 'inn' ? ['inn'] : ['park'];
    for (const t of types)
      for (const b of world.byType.get(t) ?? []) {
        if (o.place === 'wildpark' && !b.flags?.wild) continue;
        const d = Math.hypot(b.x - p.x, b.z - p.z);
        if (d <= o.reach) keep('building', b.id, b.x, b.z, b, d, d);
      }
  }
  for (const c of candScratch) {
    const occ = occasionFor(state, layout, c.type, c.id);
    if (!occ || !occasionHasRoom(occ)) continue;
    const at = c.building ? accessPoint(c.building) : {x: c.x, z: c.z};
    return {target: {type: c.type, id: c.id, x: at.x, z: at.z, building: c.building ?? undefined}, d: c.d};
  }
  return null;
}

const pickScratch = [];

/** Maybe an outing instead of the ordinary leisure visit (see the header). */
export function outingTarget(state, p, h, world) {
  const u = hashUnit((p.id * 2971 + (p.rev | 0) * 131 + state.time.tick * 7) >>> 0);
  if (u >= OUTING_SHARE) return null;
  const t = traitsOf(state, p, h), fav = favourites(p);
  const idx = placeIndex(state);
  pickScratch.length = 0;
  let total = 0;
  for (let i = 0; i < OUTINGS.length; i++) {
    const o = OUTINGS[i];
    let w = outingWeight(state, o, t, fav, i);
    if (w <= 0) continue;
    const at = placeFor(state, o, p, idx, world);
    if (!at) continue;
    // Nearer is likelier, but a favourite is worth the walk.
    w *= 1 - 0.6 * Math.min(1, at.d / o.reach);
    if (o.angling) w *= anglingHere(state, at.target.x, at.target.z, idx.town);
    total += w;
    pickScratch.push({o, at, w});
  }
  if (!pickScratch.length) return null;
  let x = hashUnit((p.id * 613 + (p.rev | 0) * 29 + state.time.tick) >>> 0) * total;
  let pick = pickScratch[pickScratch.length - 1];
  for (const c of pickScratch) if ((x -= c.w) < 0) { pick = c; break; }
  return {...pick.at.target, activity: pick.o.activity, outing: true};
}

/** Another place for a full outing (people.js alternativeTarget): the nearest other
 * one of its kind with room laid out, not one already tried; or null. */
// When a bridge's rails are full: the same thing from the bank instead.
const FALLBACK = {'bridge-gaze': 'bank-gaze', 'bridge-fish': 'fishing'};

export function alternativeOuting(state, p, task, world) {
  const avoid = [...(task.avoid ?? []), task.targetId];
  for (const activity of [task.activity, FALLBACK[task.activity]]) {
    const o = activity && OUTINGS.find((x) => x.activity === activity);
    if (!o || (o.frozen && frozen(state))) continue;   // not on to another reach of ice
    const at = placeFor(state, o, p, placeIndex(state), world, avoid);
    if (at) return {...at.target, activity, outing: true};
  }
  return null;
}

// Tools and tests: the nearest place for a given outing activity, as a task target (or
// null), whatever the walker's taste, the season or the hour.
export function outingFor(state, p, activity, world = null) {
  const o = OUTINGS.find((x) => x.activity === activity);
  if (!o) return null;
  const at = placeFor(state, o, p, placeIndex(state), world ?? buildingsByType(state));
  return at ? {...at.target, activity, outing: true} : null;
}

function buildingsByType(state) {
  const byType = new Map();
  for (const b of state.buildings) {
    if ((b.built ?? 1) < 1) continue;
    if (!byType.has(b.type)) byType.set(b.type, []);
    byType.get(b.type).push(b);
  }
  return {byType};
}
