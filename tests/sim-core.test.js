import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createState, stepTick, fastForward, serialize, restore, SaveVersionError, SaveFormatError, fixtureState,
  createRenderView, totalMoney, externalNet, pay, payBuilders, takeLoan, immigrate, emigrate, killShare,
  evalCond, holds, softScore, conditionCtx, delta, ERA, setIndividualCap, rng, sampleDist, setTag,
  TICKS_PER_YEAR, TICKS_PER_MONTH, decide, registerSystem, seedCode, setEntityNote, touchEntityNote,
} from '../src/sim/index.js';
import {applyDeltas, lockFor} from '../src/sim/pressures.js';
import {checkEra} from '../src/sim/eras.js';
import {invalidateCtx} from '../src/sim/conditions.js';
import {touchBuilding, removeBuildingRecord, addBuildingRecord} from '../src/sim/state.js';
import {riverClear} from '../src/sim/sites.js';
import {relocateEnterprise} from '../src/sim/buildings.js';
import {groundRent, purseBase, economyYearly} from '../src/sim/economy.js';
import {monthlyRent} from '../src/sim/land.js';
import {createRoutePlanner} from '../src/route-planner.js';

// What enterprises.js does on a 'relocate' choice.
function relocateViaWorld(state, ent) {
  const result = relocateEnterprise(state, ent, {payer: `enterprise:${ent.id}`, reason: 'relocated'});
  if (result.ok) ent.relocatingFrom = ent.buildingId;
  return result;
}

const conserved = (s) => totalMoney(s) - externalNet(s);
const runTicks = (s, n, services = {}, options = {}) => {
  for (let i = 0; i < n; i++) stepTick(s, 0.1, services, options);
};

test('a new hamlet has about 28 people in 7 households, huts, a moot hall and no roads', () => {
  const s = createState(11);
  assert.equal(s.version, 3);
  assert.equal(s.households.length, 7);
  assert.equal(s.indicators.pop, 28);
  assert.equal(s.people.length, 28);
  assert.ok(s.buildings.some((b) => b.type === 'moot'));
  assert.ok(s.buildings.filter((b) => b.type === 'home').length >= 5);
  assert.equal(s.era, 0);
  assert.equal(s.roads.tier.reduce((n, t) => n + (t >= 3 ? 1 : 0), 0), 0);
  assert.ok(s.institutions.some((i) => i.kind === 'moot' && i.status === 'active'));
});

test('new towns get random seeds; every starting building stays off the bank and apart', () => {
  const seeds = new Set();
  for (let i = 0; i < 50; i++) {
    const s = createState();
    seeds.add(s.seed);
    assert.equal(s.terrainSeed, s.seed);
    const bs = s.buildings;
    for (const b of bs) assert.ok(riverClear(s, b, b.type), `seed ${s.seed}: ${b.type} ${b.id} sits in the bank setback`);
    for (let j = 0; j < bs.length; j++) {
      for (let k = j + 1; k < bs.length; k++) {
        const a = bs[j], b = bs[k];
        const apart = Math.abs(a.x - b.x) >= (a.w + b.w) / 2 || Math.abs(a.z - b.z) >= (a.d + b.d) / 2;
        assert.ok(apart, `seed ${s.seed}: ${a.type} ${a.id} overlaps ${b.type} ${b.id}`);
      }
    }
    assert.ok(s.households.length === 7 && s.indicators.pop === 28);
  }
  assert.equal(seeds.size, 50);
  // Seeds round-trip through share codes and text.
  const s = createState('HV3K9Q');
  assert.equal(seedCode(s.seed), 'HV3K9Q');
  assert.equal(createState('Riverbend').seed, createState('Riverbend').seed);
  const r = restore(serialize(s));
  assert.equal(r.terrainSeed, s.terrainSeed);
});

test('the same seed gives the same town', () => {
  const a = createState(99), b = createState(99);
  runTicks(a, TICKS_PER_YEAR * 2 + 7);
  runTicks(b, TICKS_PER_YEAR * 2 + 7);
  assert.equal(serialize(a), serialize(b));
  const c = createState(100);
  runTicks(c, TICKS_PER_YEAR * 2 + 7);
  assert.notEqual(serialize(a), serialize(c));
});

test('money is conserved over five sim-years, including transfers, loans and migration', () => {
  const s = createState(5);
  const start = conserved(s);
  for (let year = 0; year < 5; year++) {
    runTicks(s, TICKS_PER_YEAR);
    pay(s, 'treasury', s.households[0], 25, 'test');
    payBuilders(s, 'treasury', 40, 'projects');
    if (year === 1) takeLoan(s, 500, {years: 3});
    if (year === 2) immigrate(s, 6);
    if (year === 3) emigrate(s, s.households[s.households.length - 1]);
    if (year === 4) killShare(s, 0.1);
    assert.ok(Math.abs(conserved(s) - start) < 1e-6 * Math.max(1, Math.abs(start)), `year ${year}: drift ${conserved(s) - start}`);
  }
  for (const h of s.households) assert.ok(h.savings >= -1e-9, 'households never go below zero');
  for (const e of s.enterprises) assert.ok(e.cash >= -1e-9, 'enterprises never go below zero');
});

test('money is conserved in a busy city fixture', () => {
  const s = fixtureState('city');
  const start = conserved(s);
  fastForward(s, 2);
  assert.ok(Math.abs(conserved(s) - start) < 1e-6 * Math.abs(start));
});

test('bodies are funded in a land-tax town: purses from property, income and site tax, then yearly budgets', () => {
  const s = fixtureState('city');
  const start = conserved(s);
  // The city fixture levies no property or income tax: its tax is the site tax.
  assert.equal(s.economy.lastYear.propertyTax ?? 0, 0);
  assert.equal(s.economy.lastYear.incomeTax ?? 0, 0);
  assert.ok(s.economy.lastYear.siteTax > 0);
  // Half a year of taxes, then the year's purses as the rollover pays them:
  // each body its share of the base.
  runTicks(s, TICKS_PER_YEAR / 2, {}, {skipPeople: true});
  const live = s.institutions.filter((b) => b.kind !== 'moot' && b.status === 'active' && b.budgetShare > 0);
  assert.ok(live.length >= 5);
  const shares = Object.fromEntries(live.map((b) => [b.id, b.budgetShare]));
  const base = purseBase(s.economy.year);
  assert.ok(base > 0);
  economyYearly(s);
  for (const b of live) assert.ok(Math.abs(s.economy.lastYear.bodies[b.id] - shares[b.id] * base) < 1e-6, `${b.id} paid ${s.economy.lastYear.bodies[b.id]}`);
  assert.equal(Math.round(s.budget.income.tax), Math.round(base));
  assert.ok(Math.abs(conserved(s) - start) < 1e-6 * Math.abs(start));
  // A City has budgets: after its first season (unanswered, each keeps its
  // purse income), every budget body's money comes from its grant, not a purse.
  fastForward(s, 1);
  runTicks(s, TICKS_PER_MONTH, {}, {skipPeople: true});   // the year's jobs run just after the turn
  const budgeted = s.institutions.filter((x) => x.kind !== 'moot' && x.status === 'active' && x.budget?.mode === 'annual');
  assert.ok(budgeted.length >= 5);
  for (const b of budgeted) {
    assert.ok(b.budget.granted > 0, `${b.id} got no grant`);
    assert.ok(Math.abs(b.budget.granted - Math.round(shares[b.id] * base)) <= 1 || b.budget.choice !== 'lapsed', `${b.id}: grant ${b.budget.granted}, purse ${shares[b.id] * base}`);
    assert.ok(!(s.economy.lastYear.bodies?.[b.id] > 0), `${b.id} also got a purse`);
  }
  assert.ok(Math.abs(conserved(s) - start) < 1e-6 * Math.abs(start));
});

test('serialize and restore round-trip, typed arrays included', () => {
  const s = fixtureState('town');
  runTicks(s, 75);
  const text = serialize(s);
  const r = restore(text);
  assert.ok(r.roads.wear instanceof Float32Array && r.roads.tier instanceof Uint8Array && r.roads.planned instanceof Uint8Array);
  assert.deepEqual(Array.from(r.roads.wear), Array.from(s.roads.wear));
  assert.deepEqual(Array.from(r.roads.tier), Array.from(s.roads.tier));
  assert.equal(serialize(r), text);
});

test('a restored town continues exactly like the original (every registered system)', () => {
  const s = fixtureState('town');
  runTicks(s, 75);
  const r = restore(serialize(s));
  runTicks(s, 120);
  runTicks(r, 120);
  assert.equal(serialize(r), serialize(s));
});

test('inspector notes are kept in the save, capped and least-recently-seen first out', () => {
  const s = createState(5);
  assert.deepEqual(setEntityNote(s, 'household:7', {key: 'k1', text: 'A family of four.\u0007'}), {ok: true});
  assert.equal(setEntityNote(s, 'nonsense', {key: 'k', text: 't'}).ok, false);
  const r = restore(serialize(s));
  assert.deepEqual(r.notes['household:7'], s.notes['household:7']);
  assert.equal(r.notes['household:7'].text, 'A family of four.');
  for (let i = 0; i < 305; i++) setEntityNote(r, `building:${i}`, {key: 'k', text: 't'});
  // 306 notes went in: the six oldest (household:7, building:0-4) are gone.
  assert.ok(!r.notes['household:7'] && !r.notes['building:4'] && r.notes['building:5']);
  touchEntityNote(r, 'building:5');
  setEntityNote(r, 'person:1', {key: 'k', text: 't'});
  assert.equal(Object.keys(r.notes).length, 300);
  assert.ok(r.notes['building:5'] && !r.notes['building:6'] && r.notes['person:1']);
});

test('ground rent: tenants pay their landlord, owner-occupiers pay site tax, money is conserved', () => {
  const s = fixtureState('town');
  const [tenant, owner] = s.enterprises.filter((e) => !e.public && e.ownerHouseholdId != null);
  const landlord = s.households.find((h) => h.id !== tenant.ownerHouseholdId);
  s.buildings.find((x) => x.id === tenant.buildingId).ownerHouseholdId = landlord.id;
  s.buildings.find((x) => x.id === owner.buildingId).ownerHouseholdId = owner.ownerHouseholdId;
  for (const e of [tenant, owner]) {
    e.landValue = 50;
    e.cash = 10000;
  }
  const start = conserved(s);
  const before = {landlord: landlord.savings, tenant: tenant.cash, owner: owner.cash, treasury: s.treasury};
  const {siteTax} = groundRent(s, 0.1);
  s.treasury += siteTax;   // housingCosts books it to the treasury
  const rent = monthlyRent(s, tenant);
  assert.ok(rent > 0);
  assert.ok(Math.abs(landlord.savings - before.landlord - rent) < 1e-9, 'the landlord gets the full rent');
  assert.ok(Math.abs(before.tenant - tenant.cash - rent) < 1e-9);
  const ownerPaid = before.owner - owner.cash;
  assert.ok(ownerPaid > 0 && ownerPaid < monthlyRent(s, owner), 'owner-occupiers pay only the site tax share');
  assert.ok(Math.abs(conserved(s) - start) < 1e-6 * Math.abs(start));
});

test('relocation goes through sim-world: new premises first, then the move, then the old building is cleared', () => {
  const s = fixtureState('town');
  // A business that can find new premises (workshops first): which one is the town's own affair.
  const movers = [...s.enterprises.filter((e) => !e.public && e.type === 'workshop'), ...s.enterprises.filter((e) => !e.public && e.type !== 'workshop')];
  let ent = null, oldId = null, result = null;
  for (const e of movers) {
    oldId = e.buildingId;
    e.cash = 50000;
    result = relocateViaWorld(s, e);
    if (result.ok) { ent = e; break; }
  }
  assert.ok(result?.ok, `relocateEnterprise: ${result?.reason}`);
  const project = s.projects.find((p) => p.data?.enterpriseId === ent.id);
  assert.ok(project);
  for (let k = 0; k < 40 && ent.buildingId === oldId; k++) runTicks(s, TICKS_PER_MONTH);
  assert.notEqual(ent.buildingId, oldId, 'the business moved');
  runTicks(s, TICKS_PER_MONTH + 5);
  assert.equal(ent.relocatingFrom, null);
  assert.equal(s.enterprises.filter((e) => e.buildingId === ent.buildingId).length, 1, 'no second enterprise in the new premises');
});

test('centres: walkers, households and enterprises carry centreId; monthly figures and labels exist', () => {
  const s = fixtureState('city');
  runTicks(s, TICKS_PER_MONTH + 10);
  const live = s.centres.filter((c) => c.mergedInto == null);
  assert.ok(live.length >= 1);
  const pop = live.reduce((n, c) => n + c.monthly.pop, 0);
  assert.equal(pop, s.households.reduce((n, h) => n + h.size, 0));
  assert.ok(s.enterprises.every((e) => e.centreId != null));
  assert.ok(s.people.every((p) => p.centreId != null));
  const view = createRenderView(s);
  view.sync(s, 1);
  assert.equal(view.centres.length, live.length);
  assert.ok(view.centres.every((c) => typeof c.name === 'string' && Number.isFinite(c.x) && c.rank >= 1));
});

test('old and broken saves are refused with clear errors', () => {
  assert.throws(() => restore(JSON.stringify({version: 1, day: 3, buildings: []})), (err) => err instanceof SaveVersionError && err.code === 'old-version');
  assert.throws(() => restore('{not json'), SaveFormatError);
  const s = JSON.parse(serialize(createState()));
  delete s.roads;
  assert.throws(() => restore(JSON.stringify(s)), SaveFormatError);
});

test('condition DSL: comparisons, tags, has, era, logic, soft, ramp and torn', () => {
  const s = createState(3);
  s.pressures.riverTrade = 0.4;
  s.traits.industry = 0.5;
  s.time.year = 20;
  setTag(s, 'flood');
  s.time.year = 26;
  s.policies.tithe = {level: 2, since: 1, by: 'player'};
  s.disagreement = {4: {'district=1|trade=farm': {D: 0.35, n: 40, year: 25}}};
  invalidateCtx(s);
  const ctx = conditionCtx(s);
  assert.equal(evalCond(['gte', 'P.riverTrade', 0.35], ctx), 1);
  assert.equal(evalCond(['lte', 'P.riverTrade', 0.35], ctx), 0);
  assert.equal(evalCond(['between', 'T.industry', 0.2, 0.7], ctx), 1);
  assert.equal(evalCond(['tag', 'flood'], ctx), 1);
  assert.equal(evalCond(['tag', 'flood', 10], ctx), 1);
  assert.equal(evalCond(['tag', 'flood', 3], ctx), 0);
  assert.equal(evalCond(['notag', 'refused:river-authority', 20], ctx), 1);
  assert.equal(evalCond(['has', 'institution', 'moot'], ctx), 1);
  assert.equal(evalCond(['has', 'institution', 'agri-council'], ctx), 0);
  assert.equal(evalCond(['has', 'policy', 'tithe', 2], ctx), 1);
  assert.equal(evalCond(['has', 'policy', 'tithe', 3], ctx), 0);
  assert.equal(evalCond(['has', 'building', 'farm', 2], ctx), 1);
  assert.equal(evalCond(['gte', 'C.home', 7], ctx), 1);
  assert.equal(evalCond(['era', 0], ctx), 1);
  assert.equal(evalCond(['era', 1], ctx), 0);
  assert.equal(evalCond(['and', ['era', 0], ['not', ['era', 2]]], ctx), 1);
  assert.equal(evalCond(['or', ['era', 3], ['gte', 'I.pop', 20]], ctx), 1);
  assert.ok(Math.abs(evalCond(['ramp', 'P.riverTrade', 0.2, 0.6], ctx) - 0.5) < 1e-9);
  // soft: (2*1 + 1*0 + 1*0.5) / 4 = 0.625
  const soft = ['soft', 0.6, [2, ['gte', 'C.farm', 2]], [1, ['era', 3]], [1, ['ramp', 'P.riverTrade', 0.2, 0.6]]];
  assert.ok(Math.abs(softScore(soft, ctx) - 0.625) < 1e-9);
  assert.equal(holds(soft, ctx), true);
  assert.equal(holds(['soft', 0.7, ...soft.slice(2)], ctx), false);
  assert.equal(evalCond(['torn', 4, 'trade', 'district', 0.3, 30], ctx), 1);
  assert.equal(evalCond(['torn', 4, 'trade', 'wealth', 0.3, 30], ctx), 0);
  assert.equal(evalCond(['torn', 4, 'trade', 'district', 0.3, 50], ctx), 0);
  assert.throws(() => evalCond(['nope'], ctx));
});

test('traits: momentum amplifies reinforcing pushes and lock-in damps reversals', () => {
  const push = (start, anchors, amount) => {
    const s = createState(1);
    s.traits.industry = start;
    for (let i = 0; i < anchors; i++) s.institutions.push({id: `a${i}`, kind: 'trades-guild', status: 'active', axis: {industry: 1}, funds: 0, budgetShare: 0});
    for (let m = 0; m < 12; m++) {
      delta(s, 'industry', amount, 'test');
      applyDeltas(s);
    }
    return s.traits.industry - start;
  };
  const fresh = push(0, 0, -0.01);
  const locked = push(0.7, 2, -0.01);
  const reinforcing = push(0.4, 2, 0.005);
  assert.ok(fresh < 0 && locked < 0);
  // lock = 0.6·T² + 0.05·anchors damps the reversal; policies.js adds the coin cost on top.
  assert.ok(Math.abs(locked) < Math.abs(fresh) * 0.75, `locked ${locked} vs fresh ${fresh}`);
  assert.ok(reinforcing > Math.abs(push(0, 0, -0.005)), 'reinforcing pushes go further');
  const s = createState(1);
  s.traits.market = 0.9;
  assert.ok(Math.abs(lockFor(s, 'market') - 0.486) < 1e-9);
  // Pressures decay toward their baseline.
  s.pressures.unrest = 0.5;
  applyDeltas(s);
  assert.ok(s.pressures.unrest < 0.5);
});

test('eras: entry by conditions after the floor, and forced at the ceiling', () => {
  const s = createState(2);
  s.indicators.pop = 130;
  s.time.year = 5;
  invalidateCtx(s);
  assert.equal(checkEra(s), null, 'not before the floor');
  s.time.year = ERA[1].floor;
  s.time.tick++;
  assert.equal(checkEra(s), 1);
  assert.equal(s.tags['era-late:1'], undefined);
  assert.equal(s.chronicle.entries.at(-1).kind, 'moment');
  // Era 2 needs 450 people; a stalled town still moves on at the ceiling.
  s.time.year = ERA[2].floor + 1;
  s.time.tick++;
  assert.equal(checkEra(s), null);
  s.time.year = ERA[2].ceiling;
  s.time.tick++;
  assert.equal(checkEra(s), 2);
  assert.equal(s.tags['era-late:2'], ERA[2].ceiling);
  assert.ok(s.buildings.some((b) => b.restyleAt != null) || s.buildings.length < 20);
});

test('150 headless years without a decision service stay finite and reach era 2', () => {
  const s = createState(8);
  const start = conserved(s);
  const t0 = performance.now();
  fastForward(s, 150);
  const ms = performance.now() - t0;
  assert.equal(s.time.year, 150);
  assert.ok(s.era >= 2, `era ${s.era}`);
  for (const v of [s.treasury, s.food, s.goods, s.indicators.pop, ...Object.values(s.traits), ...Object.values(s.pressures)]) {
    assert.ok(Number.isFinite(v), 'every number stays finite');
  }
  for (const k in s.traits) assert.ok(Math.abs(s.traits[k]) <= 1);
  assert.ok(Math.abs(conserved(s) - start) < 1e-6 * Math.max(1, Math.abs(start)));
  assert.ok(ms < 60000, `took ${ms.toFixed(0)} ms`);
});

test('walkers: everyone walks; a test cap promotes and demotes them', () => {
  const s = fixtureState('city');
  const housed = () => s.households.filter((h) => h.homeId != null).reduce((n, h) => n + h.size, 0);
  // (Households move between syncs, so the restored walkers only come close.)
  assert.ok(s.people.length > 2000 && s.people.length <= s.indicators.pop, `${s.people.length} walkers of ${s.indicators.pop}`);
  setIndividualCap(s, 300);
  assert.equal(s.people.length, 300);
  setIndividualCap(s, null);
  assert.equal(s.people.length, housed());
  const ids = new Set(s.people.map((p) => p.id));
  assert.equal(ids.size, s.people.length);
});

test('walkers move, wear the ground and pick tasks without a route service', () => {
  const s = createState(4);
  const before = s.roads.wear.reduce((a, b) => a + b, 0);
  runTicks(s, TICKS_PER_MONTH * 6);
  const after = s.roads.wear.reduce((a, b) => a + b, 0);
  assert.ok(after > before, 'walking wears paths');
  assert.ok(s.people.some((p) => p.task));
  for (const p of s.people) assert.ok(Number.isFinite(p.x) && Number.isFinite(p.z));
});

test('walkers use an asynchronous route planner when one is given', () => {
  const s = createState(4);
  const queue = [];
  const routes = {plan: (state, x0, z0, x1, z1, done) => { queue.push(() => done([x1, z1])); return true; }};
  runTicks(s, 5, {routes});
  assert.ok(queue.length > 0);
  assert.ok(s.people.every((p) => !p.task || p.task.waiting));
  for (const f of queue.splice(0)) f();
  runTicks(s, 5, {routes});
  assert.ok(s.people.some((p) => p.task && !p.task.waiting && p.speed > 0));
});

test('decide uses pooled answers when a system offers them, local priors otherwise', () => {
  const s = createState(1);
  const r = () => rng(s);
  const prior = {a: 1, b: 0, c: 0};
  assert.equal(decide(s, 'test_kind', {}, {prior, rng: r}), 'a');
  const off = registerSystem({id: 'test-pool', distribution: (state, kind) => (kind === 'test_kind' ? {a: 0, b: 1, c: 1} : null)});
  try {
    assert.equal(decide(s, 'test_kind', {}, {prior, mask: ['a', 'b'], rng: r}), 'b', 'pooled answer, then the mask');
    assert.equal(decide(s, 'test_kind', {}, {prior, facts: {b: 0}, rng: r}), 'c', 'local facts scale options');
    assert.equal(decide(s, 'other_kind', {}, {prior, rng: r}), 'a');
  } finally {
    off();
  }
  assert.equal(sampleDist({x: 0, y: 3}, 0.5), 'y');
  assert.equal(sampleDist([0, 0, 1], 0.2), 2);
});

const range = (d) => ({start: d.start, end: d.end});

// What the renderer does after reading a sync.
const consume = (view) => {
  view.peopleDirty = null;
  view.buildingEvents.length = 0;
};

test('render view: rows, extrapolation, dirty ranges and building events', () => {
  const s = fixtureState('town');
  const view = createRenderView(s);
  view.sync(s, {now: 10, speed: 1});
  assert.equal(view.peopleCount, s.people.length);
  assert.deepEqual(range(view.peopleDirty), {start: 0, end: s.people.length});
  assert.equal(view.peopleDirty.count, s.people.length);
  assert.equal(view.buildingEvents.length, s.buildings.length);
  assert.ok(view.buildingEvents.every((e) => e.kind === 'add'));
  assert.equal(view.bridges.length, s.buildings.filter((b) => b.type === 'bridge' && !b.collapsed).length, 'every standing bridge (a fallen one is not drawn)');
  consume(view);

  // Nothing changed in the sim: 16 ms on, the only rows renewed are walkers
  // who reached a corner in between (their waypoint time came due).
  const rows = Float32Array.from(view.people);
  view.sync(s, 10.016);
  for (let i = 0; i < view.peopleCount; i++) {
    const o = i * view.rowFloats;
    let same = true;
    for (let k = 0; k < view.rowFloats; k++) if (view.people[o + k] !== rows[o + k]) same = false;
    if (!same) assert.ok(view.rowFloats > 16 && rows[o + 16] > 10 && rows[o + 16] <= 10.016, `row ${i} renewed with no corner due`);
  }
  if (view.peopleDirty) assert.ok(view.peopleDirty.count < view.peopleCount / 10, 'nothing changed, little to upload');
  assert.equal(view.buildingEvents.length, 0);

  runTicks(s, 30);
  view.sync(s, {now: 13, speed: 1});
  assert.ok(view.peopleDirty && view.peopleDirty.end > view.peopleDirty.start);
  consume(view);
  // A moving walker's row extrapolates to where the sim puts it a moment later.
  const i = s.people.findIndex((p) => p.speed > 0 && p.task && p.task.route.length - p.task.seg >= 2);
  assert.ok(i >= 0);
  const p = s.people[i];
  const o = view.rowOf(p.id) * view.rowFloats;
  const rev = p.rev;
  stepTick(s, 0.1);
  if (p.rev === rev) {
    const t = 13.1 - view.people[o + 6];   // renderer seconds since the row was written (speed 1)
    const x = view.people[o] + view.people[o + 3] * t, z = view.people[o + 2] + view.people[o + 5] * t;
    assert.ok(Math.hypot(x - p.x, z - p.z) < 0.05, 'extrapolated position matches the sim');
  }
  for (let k = 0; k < view.peopleCount * view.rowFloats; k++) assert.ok(Number.isFinite(view.people[k]));

  const b = s.buildings.find((x) => x.type === 'home');
  b.storeys++;
  touchBuilding(s, b);
  const gone = s.buildings.find((x) => x.type === 'shop');
  removeBuildingRecord(s, gone.id);
  view.sync(s, {now: 14, speed: 1});
  assert.deepEqual(view.buildingEvents.map((e) => e.kind).sort(), ['remove', 'update']);
  consume(view);

  // A change nobody announced with touchBuilding still reaches the renderer.
  const quiet = s.buildings.find((x) => x.type === 'home' && x.id !== b.id);
  quiet.banner = 'festival';
  for (let k = 0; k < 40 && !view.buildingEvents.length; k++) view.sync(s, {now: 14 + k * 0.016, speed: 1});
  assert.deepEqual(view.buildingEvents, [{kind: 'update', id: quiet.id}]);
  consume(view);

  // A speed change rewrites every row; pausing zeroes velocities.
  view.sync(s, {now: 15, speed: 0});
  assert.equal(view.peopleDirty.count, s.people.length);
  for (let k = 0; k < view.peopleCount; k++) assert.equal(view.people[k * view.rowFloats + 3], 0);
});

test('fixtures are valid states of the promised size', () => {
  const town = fixtureState('town');
  assert.equal(town.era, 2);
  assert.ok(town.indicators.pop >= 450 && town.indicators.pop <= 1200, `town pop ${town.indicators.pop}`);
  assert.ok(town.buildings.length >= 110, `town buildings ${town.buildings.length}`);
  assert.ok(town.fixture?.version >= 1, 'grown by the real sim');
  assert.ok(town.institutions.length >= 3 && town.docket.length >= 2);
  assert.ok(town.roads.tier.some((t) => t >= 3));
  const city = fixtureState('city');
  assert.equal(city.era, 4);
  assert.ok(city.indicators.pop >= 2500, `city pop ${city.indicators.pop}`);
  assert.ok(city.buildings.length >= 500, `city buildings ${city.buildings.length}`);   // fewer, larger buildings as homes rise
  assert.ok(city.docket.length >= 1 && city.institutions.filter((i) => i.status === 'active').length >= 4);
  for (const s of [town, city]) {
    const r = restore(serialize(s));
    assert.equal(r.buildings.length, s.buildings.length);
    runTicks(r, 60);
    for (const p of r.people) assert.ok(Number.isFinite(p.x) && Number.isFinite(p.z));
  }
});

test('performance: stepTick at 3,000 walkers stays under budget', () => {
  const s = fixtureState('city');
  setIndividualCap(s, 3000);
  assert.equal(s.people.length, 3000);
  // Routes come from the planner, as in play; in the browser its A* runs in a worker
  // and every route arrives, so here the planner's full slice cap runs each tick
  // (a clock that never advances). Only stepTick itself is timed.
  const routes = createRoutePlanner({worker: false, clock: () => 0});
  const services = {routes};
  for (let i = 0; i < 100; i++) {   // warm up
    stepTick(s, 0.1, services);
    routes.tick?.(s);
  }
  // CPU time of this process, measured against a fixed reference job (serialising
  // this city without its walkers, whose routes are typed arrays that save quickly)
  // in the same run: a busy or slower machine stretches both alike, so the budget
  // holds anywhere and still catches a stepTick that got twice as slow.
  // (On an M5 Pro: stepTick about 0.42 of the reference on average, 1.2 at p95.)
  const cpuMs = () => { const u = process.cpuUsage(); return (u.user + u.system) / 1000; };
  const reference = () => { const t = cpuMs(); for (let k = 0; k < 3; k++) serialize({...s, people: []}); return (cpuMs() - t) / 3; };
  const ref0 = reference();
  const times = [];
  for (let i = 0; i < 600; i++) {
    const t0 = cpuMs();
    stepTick(s, 0.1, services);
    times.push(cpuMs() - t0);
    routes.tick?.(s);
  }
  const ref = (ref0 + reference()) / 2;
  times.sort((a, b) => a - b);
  const mean = times.reduce((a, b) => a + b, 0) / times.length;
  const p95 = times[Math.floor(times.length * 0.95)];
  const msg = (what, v, limit) => `${what} ${v.toFixed(2)} ms of CPU, ${(v / ref).toFixed(3)} of the reference (${ref.toFixed(1)} ms); limit ${limit}`;
  assert.ok(mean < 0.8 * ref, msg('mean', mean, 0.8));
  assert.ok(p95 < 2.2 * ref, msg('p95', p95, 2.2));
});

test('walkers keep their routes as Float32Arrays, and a version 2 save opens with them so', async () => {
  const {restore, serialize} = await import('../src/sim/serialize.js');
  const {createRoutePlanner} = await import('../src/route-planner.js');
  const s = fixtureState('town');
  const routes = createRoutePlanner({worker: false, clock: () => 0});
  for (let i = 0; i < 120; i++) { routes.tick(s, 1e9); stepTick(s, 0.1, {routes}); }
  const walking = s.people.filter((p) => p.task?.route?.length >= 4);
  assert.ok(walking.length > 20);
  assert.ok(walking.every((p) => p.task.route instanceof Float32Array));
  const text = serialize(s);
  const again = restore(text);
  assert.equal(serialize(again), text, 'round trip');
  // The same town written as version 2 did: routes as plain lists of numbers.
  const old = JSON.parse(text, (k, v) => (v && v.$typed === 'Float32Array' && k === 'route' ? Array.from(new Float32Array(Uint8Array.from(Buffer.from(v.b64, 'base64')).buffer)) : v));
  old.version = 2;
  const opened = restore(JSON.stringify(old, (k, v) => (ArrayBuffer.isView(v) ? {$typed: v.constructor.name, b64: Buffer.from(v.buffer, v.byteOffset, v.byteLength).toString('base64')} : v)));
  assert.equal(opened.version, 3);
  assert.equal(serialize(opened), text, 'migrated to the same town');
});
