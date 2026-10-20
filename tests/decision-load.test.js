// How much the town asks the decision model, and what high speeds cost:
// the client's answer cache, the scheduler's refinement budget, the proxy's
// shared cache and limits, and the sim's frame budget.
import test from 'node:test';
import assert from 'node:assert/strict';
import {createDecisionClient} from '../src/decision-client.js';
import {createDecisionService, createAnswerCache, createLimits} from '../server/system1.js';
import {getDecisionKind} from '../src/decision-kinds.js';
import {stepTick, fixtureState, createState, serialize} from '../src/sim/index.js';
import {KIND_BY_ID} from '../src/sim/decisions/kinds.js';

const uniform = (offered) => Object.fromEntries(offered.map((o) => [o, 1 / offered.length]));
const town = {phase: 'work', food: 'ok', wellbeing: 'good', taxStep: 10};
const routine = (id, energy = 'normal') => ({kind: 'routine', id, context: {slice: 'district', label: 'in the west district', group: 40, energy}});

// A fake upstream for the client: answers every question after a short wait.
function mockFetch() {
  const seen = {requests: 0, questions: 0};
  const fetch = async (url, init) => {
    const body = JSON.parse(init.body);
    seen.requests++;
    const answers = {};
    for (const g of body.groups) {
      for (const q of g.questions) {
        seen.questions++;
        const offered = q.allowed ?? getDecisionKind(q.kind).options;
        answers[q.id] = {kind: q.kind, choice: offered[0], probabilities: uniform(offered)};
      }
    }
    await new Promise((r) => setTimeout(r, 5));
    return {ok: true, status: 200, json: async () => ({answers, model: 'mock'})};
  };
  return {fetch, seen};
}

test('the client answers an exact repeat from its cache, for any asker, without the network', async () => {
  const {fetch, seen} = mockFetch();
  const client = createDecisionClient({fetch});
  const q = routine('a');
  const first = await client.ask(q.kind, 'walker-1', q.context, {state: town});
  assert.ok(first?.probabilities);
  assert.equal(seen.questions, 1);
  // Another walker with the same question over the same state.
  const again = await client.ask(q.kind, 'walker-2', q.context, {state: town});
  assert.deepEqual(again, first);
  assert.equal(seen.questions, 1, 'served from the cache');
  assert.equal(client.stats().cached, 1);
  // A different state or context is a different question.
  await client.ask(q.kind, 'walker-2', q.context, {state: {...town, phase: 'rest'}});
  await client.ask(q.kind, 'walker-2', routine('a', 'low').context, {state: town});
  assert.equal(seen.questions, 3);
  // Switching the model off and on forgets the answers.
  client.reset();
  await client.ask(q.kind, 'walker-3', q.context, {state: town});
  assert.equal(seen.questions, 4);
});

test('the proxy shares answers between players, and its limits fall back to local rules', async () => {
  let upstream = 0;
  const fetcher = async (url, opts) => {
    const body = JSON.parse(opts.body);
    const groups = body.requests ?? [body];
    upstream += groups.reduce((n, g) => n + Object.keys(g.questions).length, 0);
    const answer = (g) => ({answers: Object.fromEntries(Object.keys(g.questions).map((k) => [k, {type: 'choice', choice: 'work', confidence: 0.25, probabilities: uniform(['work', 'rest', 'shop', 'leisure'])}]))});
    return new Response(JSON.stringify(body.requests ? {model: 'fixture', results: body.requests.map(answer)} : {model: 'fixture', ...answer(body)}));
  };
  const service = createDecisionService({loadConfig: async () => ({key: 'k', endpoint: 'http://localhost:4000/v1/decisions'}), fetcher});
  const request = (ids) => ({groups: [{state: town, questions: ids.map((id) => routine(id))}]});
  const a = await service.handle(request(['1', '2']), {client: 'alice'});
  assert.equal(a.status, 200);
  assert.equal(upstream, 2, 'two questions, but the second is identical: both go up this once');
  const b = await service.handle(request(['9']), {client: 'bob'});
  assert.equal(b.status, 200);
  assert.equal(b.body.cached, 1);
  assert.equal(upstream, 2, "bob's question was answered from alice's");
  assert.deepEqual(b.body.answers['9'], a.body.answers['1']);

  // Per-player rate: past the burst the player gets busy (and backs off).
  const limits = createLimits({clientRate: 1, dailyCap: 0, now: () => 0});
  assert.equal(limits.take('x', 4), null);
  assert.equal(limits.take('x', 1)?.status, 429);
  assert.equal(limits.take('y', 1), null, 'another player has their own budget');
  // Daily cap: the whole service stops asking upstream for the day.
  const daily = createLimits({dailyCap: 3, now: () => 0});
  assert.equal(daily.take('x', 3), null);
  assert.equal(daily.take('y', 1)?.status, 503);
  const capped = createDecisionService({loadConfig: async () => ({key: 'k', endpoint: 'http://localhost:4000/v1/decisions'}), fetcher, limits: createLimits({dailyCap: 1}), cache: createAnswerCache(0)});
  const refused = await capped.handle(request(['1', '2']));
  assert.equal(refused.status, 503);
  assert.equal(refused.body.fallback, true);
});

test('refinement has a real-time budget: a town no longer re-asks every walker as fast as answers land', async () => {
  const s = fixtureState('town');
  let individual = 0, total = 0;
  const bus = {
    stats: () => ({state: 'idle', room: 256}),
    async ask(kind, id, context, opts) {
      total++;
      // Walkers' routines: the refresh loop the budget is for (game moments ask individuals too).
      if (opts.tag === 'individual' && kind === 'resident_routine') individual++;
      const offered = opts.allowed ?? Object.keys(KIND_BY_ID[kind].criteria);
      return {kind, choice: offered[0], confidence: 0.5, probabilities: uniform(offered)};
    },
  };
  // 20 real seconds at 1× (5 ticks a second), answers landing at once.
  let now = 1000;
  for (let i = 0; i < 100; i++) {
    stepTick(s, 0.1, {decisions: bus, now, rate: 0.5}, {skipPeople: true});
    now += 200;
    await new Promise((r) => setImmediate(r));
  }
  // 8 a second plus the starting burst of 32, shared with intersections.
  assert.ok(individual <= 8 * 20 + 32, `individual questions: ${individual}`);
  assert.ok(individual > 20, 'walkers are still asked');
  assert.ok(total < 600, `all questions: ${total}`);
});

test('a frame budget stops ticks early and slows the town, but the ticks and the outcome are the same', () => {
  const a = createState(4817);
  const b = createState(4817);
  for (let i = 0; i < 30; i++) stepTick(a, 1);   // 300 ticks, ten at a time
  // b gets the same sim time, but its clock says every frame is over budget.
  let ran = 0;
  for (let calls = 0; calls < 30; calls++) {
    const n = stepTick(b, 1, {}, {until: 0, clock: () => 1});
    assert.equal(n, 1, 'one tick always runs, and only one past the budget');
    assert.ok(b.time.acc <= 1 + 1e-9, 'the carried backlog is capped');
    ran += n;
  }
  assert.equal(ran, 30);
  assert.ok(b.time.tick < a.time.tick, 'the town fell behind instead of stalling');
  // The capped backlog means b fell behind, so finish it without a budget.
  while (b.time.tick < a.time.tick) stepTick(b, 0.1);
  assert.equal(b.time.tick, a.time.tick);
  a.time.acc = b.time.acc = 0;
  assert.equal(serialize(b), serialize(a));
});
