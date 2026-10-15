// The simulation entry point.
//
//   const state = createState(seed)
//   stepTick(state, dtSeconds, services)   // services = {decisions, routes, now} (all optional)
//
// stepTick turns sim seconds into 100 ms ticks. Tick order (design-systems §11.2):
//   every tick:       systems.tick (sim-governance's scheduler flush) -> one queued
//                     rollover job -> people move
//   month rollover:   systems.month (governance: policies, institutions, events; then
//                     world: roads, sites, buildings, works) -> households -> enterprises
//                     -> economy -> pressures.applyDeltas -> indicators -> walkers resync
//   quarter rollover: systems.quarter (docket session)
//   year rollover:    households -> enterprises -> economy -> systems.year (factions,
//                     buildings ageing) -> archetype -> era check -> history -> systems.yearEnd
// Each arrow is a separate job, run on consecutive ticks (see runTick).
//
// sim-world and sim-governance plug in with registerSystem() (see hooks.js).

import {rng} from './rng.js';
import {TICK_SECONDS, advanceTick, monthIndex, rollWeather, ROLL_MONTH, ROLL_QUARTER, ROLL_YEAR} from './clock.js';
import {runPhase, runSystem, systemsWith, findAction} from './hooks.js';
import {householdsMonthly, householdsYearlyLife, householdsYearlyHomes, householdsYearlyMoves, yearSummary} from './households.js';
import {enterprisesMonthly, enterprisesYearly, enterprisesFound, foundingStep} from './enterprises.js';
import {economyMonthlyWork, economyMonthlySpend, economyYearly, chargeProjects} from './economy.js';
import {applyDeltas, computeIndicators, recordHistory, updateArchetype} from './pressures.js';
import {checkEra, applyRestyles} from './eras.js';
import {centreIndicators, centreCharacters} from './centre-stats.js';
import {stepPeople, syncIndividuals, assignBuilders} from './people.js';
import {createState as baseCreateState, useTerrainOf} from './state.js';
import {registerSystem} from './hooks.js';
import {worldSystem} from './world.js';
import {governanceSystem} from './governance.js';

registerSystem(governanceSystem);
registerSystem(worldSystem);

const MAX_TICKS_PER_CALL = 40;      // 4 s of sim time; any backlog beyond that is dropped

export function createState(seed, options = {}) {
  const state = baseCreateState(seed, options);
  computeIndicators(state);
  syncIndividuals(state);
  return state;
}

// Advance the simulation by dt sim seconds. Returns the number of ticks run.
export function stepTick(state, dt, services = {}, options = {}) {
  useTerrainOf(state);
  state.time.acc = (state.time.acc ?? 0) + Math.max(0, dt);
  const ctx = makeCtx(state, services, options);
  let ticks = 0;
  while (state.time.acc >= TICK_SECONDS - 1e-9 && ticks < MAX_TICKS_PER_CALL) {
    state.time.acc -= TICK_SECONDS;
    runTick(state, ctx);
    ticks++;
  }
  if (ticks === MAX_TICKS_PER_CALL) state.time.acc = Math.min(state.time.acc, TICK_SECONDS);
  if (state.time.acc < 0) state.time.acc = 0;
  return ticks;
}

function makeCtx(state, services, options) {
  return {
    services: services ?? {},
    rng: (stream) => rng(state, stream),
    now: services?.now ?? null,
    skipPeople: !!options.skipPeople,
    flags: 0,
    get monthIndex() { return monthIndex(state.time); },
  };
}

// Rollover work is queued as jobs in state.time.jobs and run one per tick, so a month
// or year boundary never lands in a single frame. The order is fixed, so this stays
// deterministic; a month's jobs finish within a few ticks of its start.
function runTick(state, ctx) {
  const flags = advanceTick(state.time);
  if (flags) queueRollover(state, flags);
  ctx.flags = flags;
  runPhase('tick', state, ctx);
  chargeProjects(state);
  const job = state.time.jobs.shift();
  if (job) runJob(state, ctx, job);
  else foundingStep(state);   // the year's founding attempts, one per quiet tick
  if (!ctx.skipPeople) stepPeople(state, ctx, TICK_SECONDS);
}

function queueRollover(state, flags) {
  const jobs = (state.time.jobs ??= []);
  if (flags & ROLL_MONTH) jobs.push(...systemsWith('month').map((id) => `month@${id}`), 'core:month', 'core:economy', 'core:spending', 'core:indicators');
  if (flags & ROLL_QUARTER) jobs.push(...systemsWith('quarter').map((id) => `quarter@${id}`));
  if (flags & ROLL_YEAR) {
    jobs.push('core:year-people', 'core:year-homes', 'core:year-moves', 'core:year-enterprises', 'core:year-found', 'core:year-economy', ...systemsWith('year').map((id) => `year@${id}`), 'core:year-end');
    jobs.push(...systemsWith('yearEnd').map((id) => `yearEnd@${id}`));
  }
}

const CORE_JOBS = {
  'core:month'(state) {
    rollWeather(state.weather, state.time.month, () => rng(state), monthIndex(state.time));
    householdsMonthly(state);
    enterprisesMonthly(state);
  },
  'core:economy'(state) {
    economyMonthlyWork(state);
  },
  'core:spending'(state) {
    economyMonthlySpend(state);
  },
  'core:indicators'(state, ctx) {
    applyDeltas(state);
    computeIndicators(state);
    centreIndicators(state);
    state.roads.wearAddedMonth = 0;
    if (!ctx.skipPeople) {
      syncIndividuals(state);
      assignBuilders(state);
    }
  },
  'core:year-people'(state) {
    state.time.popAtYearStart = state.indicators.pop;
    householdsYearlyLife(state);
  },
  'core:year-homes'(state) {
    householdsYearlyHomes(state);
  },
  'core:year-moves'(state) {
    householdsYearlyMoves(state);
  },
  'core:year-enterprises'(state) {
    enterprisesYearly(state);
  },
  'core:year-found'(state) {
    enterprisesFound(state);
  },
  'core:year-economy'(state) {
    economyYearly(state);
  },
  'core:year-end'(state) {
    computeIndicators(state);
    updateArchetype(state);
    centreCharacters(state);
    checkEra(state);
    applyRestyles(state);
    recordHistory(state);
    yearSummary(state, state.time.popAtYearStart ?? state.indicators.pop);
  },
};

function runJob(state, ctx, job) {
  const at = job.indexOf('@');
  if (at < 0) {
    CORE_JOBS[job]?.(state, ctx);
    return;
  }
  ctx.phase = job.slice(0, at);
  runSystem(job.slice(at + 1), ctx.phase, state, ctx);
  ctx.phase = null;
}

// Headless fast-forward (tests, fixtures, tools). Walkers are skipped by default.
export function fastForward(state, years, services = {}, {skipPeople = true} = {}) {
  const target = state.time.year + years;
  while (state.time.year < target) stepTick(state, 4, services, {skipPeople});
  return state;
}

// Settings: how many people walk as individuals (300-5,000).
export function setIndividualCap(state, n) {
  state.settings.individualCap = Math.max(300, Math.min(5000, Math.round(n)));
  syncIndividuals(state);
  return state.settings.individualCap;
}

// ---------------------------------------------------------------------------
// Player actions (contract §5). sim-governance registers the implementations through
// its system's `actions`; until then they report that nothing happened.

const callAction = (name) => (state, ...args) => {
  const fn = findAction(name);
  return fn ? fn(state, ...args) : {ok: false, error: 'This is not ready yet.'};
};

export const rule = callAction('rule');
export const setDelegated = callAction('setDelegated');
export const dissolveBody = callAction('dissolveBody');
export const setStandingOrder = callAction('setStandingOrder');
export const setCardProse = callAction('setCardProse');   // the narrator writes card prose

// ---------------------------------------------------------------------------
// Re-exports for the rest of the game.

export {registerSystem, unregisterSystem, decide, decisionDistribution} from './hooks.js';
export {serialize, restore, SaveVersionError, SaveFormatError} from './serialize.js';
export {fixtureState, loadFixture} from './fixtures.js';
export {setEntityNote, touchEntityNote} from './notes.js';
export {createRenderView} from './render-view.js';
export {rng, chance, pick, shuffle, sampleDist, roundRandom} from './rng.js';
export {TICK_SECONDS, TICKS_PER_MONTH, TICKS_PER_YEAR, timeView, monthIndex, season, SEASON_NAMES} from './clock.js';
export {evalCond, holds, softScore, explainCond, makeCtx as conditionCtx, defineOp} from './conditions.js';
export {delta, againstGrain, lockFor, priceLevel, ARCHETYPES, PRESSURES, INSTITUTION_AXES} from './pressures.js';
export {ERA, STYLE_PACKS, eraProgress, eraCondition} from './eras.js';
export {
  addBuildingRecord, removeBuildingRecord, touchBuilding, newSeed, parseSeed, seedCode, useTerrainOf, makeBuilding, byId, nextId, setTag, emitChronicle,
  cellIndex, ROAD_GRID, PLANNED, BRIDGE, FORD, LAMP, HOME_TIERS, TRADES, ENTERPRISE_TYPES, jobsFor, SAVE_VERSION,
} from './state.js';
export {pay, payBuilders, takeLoan, totalMoney, externalNet, buildingValue, taxRate, wageRate, prices, wealthBand} from './economy.js';
export {addStory, immigrate, emigrate, bringKin, killShare, assignTrade, attractiveness, population, occupancy, vacancies, moveInto, homeCapacity} from './households.js';
export {closeEnterprise} from './enterprises.js';
export {doorOf, accessPoint, walkerY, fallbackRoute, ACTION} from './people.js';
