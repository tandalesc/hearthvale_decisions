// sim-world's plug-in for the tick (see hooks.js): roads, lots, buildings,
// districts and planned works. src/sim/index.js registers it.
import { TICK_SECONDS } from './clock.js';
import { ensureRoads, tickRoads, monthlyRoads, addWear, placeLamps, navGrid, WALKER_SCALE, WEAR_STEP } from './roads.js';
import { components } from '../navigation.js';
import {
  adoptLots, tickProjects, monthlyBuildings, retryBuildQueue, homesWanted, startHomes, mergeWilling, requestBuilding,
  followOwnerWealth, farmsGiveWay, ageBuildings,
  growBuilding, settleFoundations, settleFoundationsSpan, reportRaised, freeSealedDoors, clearRoadsUnderBuildings, relocateEnterprise, releaseBuilding,
} from './buildings.js';
import { updateDistrictsStep } from './districts.js';
import { ensureCentres, updateCentresStep } from './centres.js';
import { policyModifiers } from './policies.js';
import { spendPavingFund, rebuildOldBridges, yearlyFootbridges, yearlyBridges, collapseBridge, rebuildBridge } from './works.js';
import { rng } from './rng.js';

const FOUNDATIONS_V = 7;
const FOUNDATION_SPAN = 150;

// Year-end work, one step per tick so no single tick carries it all (the
// biggest steps take a few ms on a city). The queue lives in saved state, so
// a restored save carries on exactly where it stopped.
const YEAR_STEPS = {
  wealth: s => followOwnerWealth(s),
  farms: s => farmsGiveWay(s),
  roadsUnder: s => clearRoadsUnderBuildings(s),
  // The walkable regions first (a cache), so the door pass has only its own work.
  regions: s => { components(navGrid(s)); },
  doors: s => freeSealedDoors(s),
  // A few hundred buildings a tick; a cold pass (after a restore) surveys every bank.
  foundations: (s, [from = 0, raised = 0]) => {
    const span = settleFoundationsSpan(s, from, FOUNDATION_SPAN);
    if (span.next != null) return `foundations:${span.next}:${raised + span.raised}`;
    reportRaised(s, raised + span.raised);
  },
  age: s => ageBuildings(s),
  merge: s => mergeWilling(s),
  works: s => {
    spendPavingFund(s);
    yearlyFootbridges(s, () => rng(s));
    yearlyBridges(s);
  },
  districts: (s, [step = 0]) => {
    const next = updateDistrictsStep(s, step);
    if (next != null) return `districts:${next}`;
  },
  centres: (s, [step = 0]) => {
    const next = updateCentresStep(s, step);
    if (next != null) return `centres:${next}`;
  },
};

// A job is a step name, or 'name:arg:arg' for a step part done; a step that
// returns a job string has more to do, and goes first next tick.
function runYearStep(state) {
  const job = state.worldYearJobs?.shift();
  if (!job) return;
  const [name, ...args] = job.split(':');
  const more = YEAR_STEPS[name]?.(state, args.map(Number));
  if (typeof more === 'string') state.worldYearJobs.unshift(more);
}

export const worldSystem = {
  id: 'world',
  order: 20,
  init(state) {
    ensureRoads(state);
    adoptLots(state);
    ensureCentres(state);
  },
  restore(state) {
    ensureRoads(state);
  },
  tick(state, ctx) {
    if (state.worldYearJobs?.length) runYearStep(state);
    // Once per save (and again whenever these rules change): foundations for
    // every building, raising any that stand too close to the river, and
    // doors turned away from walls.
    if ((state.foundationsV ?? 0) < FOUNDATIONS_V) {
      rebuildOldBridges(state);
      freeSealedDoors(state);
      clearRoadsUnderBuildings(state);
      settleFoundations(state);
      state.foundationsV = FOUNDATIONS_V;
    }
    tickRoads(state, ctx);
    tickProjects(state, TICK_SECONDS);
    // One new home every few ticks, so site searches never pile into one frame.
    if (state.homesWanted > 0 && state.time.tick % 4 === 0) startHomes(state, 1);
  },
  month(state, ctx = {}) {
    monthlyRoads(state, ctx);
    monthlyBuildings(state);
    retryBuildQueue(state);
    homesWanted(state);
    // The lamps rule: level 1 lights paved streets, level 2 every graded road.
    const lamps = Math.max(state.policies?.lamps?.level ?? 0, policyModifiers(state).sum('lamps'));
    if (lamps > 0) placeLamps(state, 6, lamps >= 2 ? 3 : 4);
  },
  year(state) {
    state.worldYearJobs = [...(state.worldYearJobs ?? []), ...Object.keys(YEAR_STEPS)];
  },
  // people.js calls this once per cell a walker enters.
  addWear(state, x, z, amount = WEAR_STEP) {
    addWear(state, x, z, amount * WALKER_SCALE);
  },
  // enterprises.js: (state, type, {payer, ownerHouseholdId, reason}) -> {ok, ...}.
  // The older object form (state, {type, ...}) is accepted too.
  requestBuilding(state, type, opts = {}) {
    if (typeof type === 'object') return requestBuilding(state, type.type, type);
    return requestBuilding(state, type, opts);
  },
  // Rising rents (sim-governance's relocate option): move a business to
  // cheaper ground. relocationSites(state, enterprise) in sites.js lists options.
  // sim-governance's bridge-collapse event: (state, bridge or id) -> {ok, bridgeId};
  // its rebuild choices: (state, bridge or id, 'stone' | 'timber', {payer, paid}) -> {ok, projects}.
  collapseBridge(state, bridge) {
    return collapseBridge(state, bridge);
  },
  rebuildBridge(state, bridge, how, opts) {
    return rebuildBridge(state, bridge, how, opts);
  },
  relocateEnterprise(state, enterprise, opts = {}) {
    return relocateEnterprise(state, enterprise, opts);
  },
  // economy.js: a relocated business or a sold site left an empty building.
  // It comes down and its lot goes back to building (homes, shops).
  buildingReleased(state, building) {
    return releaseBuilding(state, building);
  },
  // enterprises.js: an enterprise chose to expand its building.
  requestUpgrade(state, building, opts = {}) {
    return growBuilding(state, building, opts);
  },
};
