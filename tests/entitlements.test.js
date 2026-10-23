import test from 'node:test';
import assert from 'node:assert/strict';
import {createLocalAnswerer, createStudentVersions} from '../src/decision-local.js';
import {entitledSpeed, loadEntitlement} from '../src/entitlements.js';
import {nextSpeed} from '../src/ui/components/time.js';

const client = {ask() { throw new Error('unbounded client must not run'); }, stats: () => ({state: 'idle'}), configure() {}, reset() {}, flush() {}};
const state = {era: 'town', season: 'spring', archetype: 'mill', food: 'ok', coin: 'ok', wellbeing: 'fair', jobs: 'balanced', homes: 'scarce', health: 'fair', unrest: 'calm', faith: 'mid', river: 'busy', taxStep: 2, rules: '', recent: '', bodies: '', looks: 'plain'};
const context = {wages: 'low', hardship: 'some', savings: 'thin', mood: 'angry'};

test('free: disabled, missing, unknown and failing students never call live teacher; reports remain bounded', async () => {
  for (const students of [[], [{kinds: ['strike_resolve'], unknownIn: () => 1, answer() { throw new Error('broken'); }}]]) {
    let live = 0;
    const reports = [];
    const bus = createLocalAnswerer({client, students, live: {fetcher: async () => { live++; }}, report: {maxBatch: 1, perSession: 1, fetcher: async (_url, init) => reports.push(JSON.parse(init.body))}});
    assert.equal(await bus.ask('strike_resolve', 'a', context, {state}), null);
    assert.equal(await bus.ask('strike_resolve', 'b', context, {state}), null);
    await Promise.resolve();
    assert.equal(live, 0);
    assert.equal(reports.length, 1);
  }
});

test('paid missing kinds use bounded teacher; budget refusal keeps local fallback available', async () => {
  let calls = 0;
  const bus = createLocalAnswerer({client, entitlement: {tier: 'paid'}, now: () => 0, live: {fetcher: async () => { calls++; return {ok: true, json: async () => ({answers: {0: {kind: 'strike_resolve', probabilities: {solid: 1}}}})}; }}});
  assert.ok(await bus.ask('strike_resolve', 'a', context, {state}));
  assert.ok(await bus.ask('strike_resolve', 'b', context, {state}));
  assert.equal(await bus.ask('strike_resolve', 'c', context, {state}), null);
  assert.equal(calls, 2);
  const refused = createLocalAnswerer({client, entitlement: {tier: 'paid'}, live: {fetcher: async () => ({status: 429, json: async () => ({retryAfterMs: 60000})})}});
  assert.equal(await refused.ask('strike_resolve', 'd', context, {state}), null);
});

test('free speed controls cycle 1/3/5 and sessions reject paid speeds', () => {
  assert.equal(nextSpeed(5), 1);
  assert.equal(nextSpeed(5, {tier: 'paid'}), 10);
  assert.equal(entitledSpeed(20, {tier: 'free'}), 1);
  assert.equal(entitledSpeed(20, {tier: 'paid'}), 20);
  assert.equal(entitledSpeed(0), 0);
});

test('session loading fails closed without blocking offline play', async () => {
  assert.equal((await loadEntitlement(async () => { throw new Error('offline'); })).tier, 'free');
  assert.equal((await loadEntitlement(async () => ({ok: true, json: async () => ({tier: 'paid'})}))).tier, 'paid');
});

test('student version stays fixed during play and refreshes saved towns next session', async () => {
  let latest = 2, manifests = 0;
  const used = [];
  const options = {answerer: {use: async (url) => { used.push(url); return ['strike_resolve']; }}, base: 'https://game.test/api/students/', fetcher: async () => { manifests++; return {ok: true, json: async () => ({latest, versions: {2: 'v2.json', 3: 'v3.json'}})}; }};
  const session = createStudentVersions(options);
  const town = {governance: {studentVersion: 1}};
  assert.equal(await session.start(), '2');
  latest = 3;
  assert.equal(await session.pin(town), '2');
  assert.equal(await session.start(), '2');
  assert.equal(manifests, 1);
  assert.equal(used.length, 1);
  const nextSession = createStudentVersions(options);
  assert.equal(await nextSession.pin(town), '3');
  assert.equal(town.governance.studentVersion, '3');
});

test('failed hosted manifest or bundle uses shipped manifest without changing versions mid-session', async () => {
  for (const failure of ['manifest', 'bundle']) {
    const loads = [];
    const session = createStudentVersions({base: 'https://game.test/api/students/', fallbackBase: 'https://game.test/students/', answerer: {use: async (url) => { loads.push(url); return url.includes('/api/') ? null : ['strike_resolve']; }}, fetcher: async (url) => ({ok: !url.includes('/api/') || failure !== 'manifest', json: async () => ({latest: url.includes('/api/') ? 3 : 2, versions: {2: 'v2.json', 3: 'v3.json'}})})});
    assert.equal(await session.start(), '2');
    assert.equal(await session.pin({}), '2');
    assert.equal(loads.at(-1), 'https://game.test/students/v2.json');
  }
});

test('simulation session enforces speed independently of UI and free card prose stays local', async () => {
  const {createSimSession} = await import('../src/sim-session.js');
  for (const tier of ['free', 'paid']) {
    let elapsed = 0, proseCalls = 0;
    const session = createSimSession({entitlement: {tier}, sim: {createState: () => ({}), stepTick: (_state, time) => { elapsed = time; return 1; }}, startProse: () => ({requestCard: async () => { proseCalls++; return 'text'; }, stop() {}})});
    await session.init({kind: 'new'});
    session.step(1, 0, 20);
    assert.equal(elapsed, tier === 'paid' ? 20 : 1);
    await session.requestCardProse('card');
    assert.equal(proseCalls, tier === 'paid' ? 1 : 0);
    session.dispose();
  }
});

test('narration previews cross UI snapshots but never enter saved simulation state', async () => {
  const {createSimSession} = await import('../src/sim-session.js');
  for (const tier of ['free', 'paid']) {
    let preview = {why: 'A checked sentence.', pending: true};
    const card = {id: 'c1', why: 'Canonical reason.', options: []};
    const view = new Proxy({selectDocket: state => state.docket}, {get: (target, key) => target[key] ?? (() => null)});
    const session = createSimSession({entitlement: {tier}, sim: {createState: () => ({docket: [card]}), serialize: JSON.stringify, view},
      startProse: () => ({peekCard: () => preview, stop() {}})});
    await session.init({kind: 'new'});
    assert.deepEqual(session.ui().docket[0].streamingProse, tier === 'paid' ? preview : undefined);
    assert.equal(card.streamingProse, undefined);
    assert.equal(session.save().text.includes('streamingProse'), false);
    preview = undefined;
    assert.equal(session.ui().docket[0].streamingProse, undefined);
    session.dispose();
  }
});

test('switching towns stops old narration while a failed restore preserves it', async () => {
  const {createSimSession} = await import('../src/sim-session.js');
  const keepers = [];
  const view = new Proxy({selectDocket: state => state.docket}, {get: (target, key) => target[key] ?? (() => null)});
  const session = createSimSession({entitlement: {tier: 'paid'}, sim: {
    createState: () => ({docket: [{id: 'same-card-id'}]}),
    restore: () => { throw new Error('invalid'); }, view,
  }, startProse: () => {
    const keeper = {preview: undefined, stopped: false, peekCard() { return this.preview; }, stop() { this.stopped = true; this.preview = undefined; }};
    keepers.push(keeper);
    return keeper;
  }});
  await session.init({kind: 'new'});
  keepers[0].preview = {why: 'Old town draft.', pending: true};
  assert.deepEqual(await session.init({kind: 'raw', raw: 'bad'}), {error: 'invalid'});
  assert.equal(keepers[0].stopped, false);
  assert.equal(session.ui().docket[0].streamingProse.why, 'Old town draft.');
  await session.init({kind: 'new'});
  assert.equal(keepers[0].stopped, true);
  assert.equal(keepers.length, 2);
  assert.equal(session.ui().docket[0].streamingProse, undefined);
  session.dispose();
});
