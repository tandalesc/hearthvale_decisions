// Population-scale decisions by overlapping slices.
//
// A population is cut along several dimensions at once (district, wealth,
// needs...). Each slice value is asked once per sweep, so a sweep costs the
// SUM of the dimension sizes, not their product. A person's distribution is
// the linear pool (weighted mean) of the slices they belong to, then their
// hard personal facts (local terms and masks). Where a person's slices
// disagree, the leftover question budget buys refinement: one question for
// that exact intersection of slices, or individual questions when the group
// is tiny or the decision is high-stakes. See src/decision-pool.js.
//
// SlicedPopulation is generic over kinds and state shapes. AdaptiveRoutinePolicy
// configures it for everyday routines on the legacy town state.
import {pool, normalizedEntropy, tvDistance, membershipSignature, refinementTargets, blendRefinement, normalize, jsDivergence} from './decision-pool.js';
import {getDecisionKind, stateKey} from './decision-kinds.js';

export const ACTIVITIES = ['work', 'rest', 'shop', 'leisure'];

export function normalizeProbabilities(value) {
  if (!value || Array.isArray(value) || typeof value !== 'object' || Object.keys(value).some((k) => !ACTIVITIES.includes(k))) return null;
  let sum = 0;
  const result = {};
  for (const a of ACTIVITIES) {
    const p = value[a] ?? 0;
    if (!Number.isFinite(p) || p < 0 || p > 1) return null;
    result[a] = p;
    sum += p;
  }
  if (sum <= 0 || Math.abs(sum - 1) > 0.05) return null;
  for (const a of ACTIVITIES) result[a] /= sum;
  return result;
}

export function sampleDistribution(distribution, allowed, random) {
  const entries = allowed.map((a) => [a, distribution[a] ?? 0]);
  const total = entries.reduce((n, [, p]) => n + p, 0);
  if (total <= 0) return null;
  let choice = Math.max(0, Math.min(0.999999999, random)) * total;
  for (const [a, p] of entries) {
    choice -= p;
    if (choice < 0) return a;
  }
  return entries.at(-1)?.[0] ?? null;
}

// Deterministic per-person uniform number for (id, day, key).
export function randomFor(id, day, key) {
  let hash = (id * 2654435761 + day * 2246822519) >>> 0;
  for (let i = 0; i < key.length; i++) {
    hash ^= key.charCodeAt(i);
    hash = Math.imul(hash, 16777619) >>> 0;
  }
  hash ^= hash >>> 16;
  return (hash >>> 0) / 4294967296;
}

// Short charset-safe id for any string key.
export function hashId(prefix, key) {
  let a = 2166136261, b = 5381;
  for (let i = 0; i < key.length; i++) {
    const c = key.charCodeAt(i);
    a = Math.imul(a ^ c, 16777619) >>> 0;
    b = (Math.imul(b, 33) ^ c) >>> 0;
  }
  return `${prefix}${a.toString(36)}${b.toString(36)}`;
}

const clock = () => globalThis.performance?.now() ?? Date.now();
const BASELINE = 'town';

// ---------------------------------------------------------------------------
// Generic sliced population
// ---------------------------------------------------------------------------
//
// new SlicedPopulation({
//   client,            decision client (ask, stats)
//   kind,              decision kind id
//   dimensions,        {name: (person, world) => slice value (string) | null}
//   describe(s),       -> {world, state, people}: per-sweep data, the shared
//                      request state and the people to decide for
//   facts(p, world),   -> {allowed: [...], terms?: {option: multiplier}} or
//                      null when the person is not part of this decision
//   sliceContext(dim, value, members, world)          -> question context
//   intersectionContext(memberships, members, world)  -> question context
//   individualContext(person, world)                  -> question context
//   intersectionState?(memberships, members, world, state), individualState?(person, world, state)
//                      optional: the state for refinement questions (default: the shared state)
//   weights            {dim: weight} (default 1 each; `town` = baseline)
//   weightBy           null | 'size' | 'confidence'   extra weight factor
//   combine            'mean' (default) | 'min'
//   baseline           ask one whole-population slice too (default true)
//   ttlMs              base refresh period of a slice answer
//   refine             {threshold, smallGroup, highStakes, blend: 'replace'|'agree'}
//   maxPerPump, pumpMs, now
// })
export class SlicedPopulation {
  constructor(options) {
    Object.assign(this, {
      weights: {}, weightBy: null, combine: 'mean', baseline: true, ttlMs: 6000,
      maxPerPump: 256, pumpMs: 20, now: clock,
    }, options);
    this.refine = {threshold: 0.02, smallGroup: 3, highStakes: false, blend: 'replace', ...(options.refine ?? {})};
    this.options = getDecisionKind(this.kind)?.options ?? [];
    this.slices = new Map();       // sliceKey -> {dim, value, dist, at, stateKey, version, entropy, drift}
    this.refined = new Map();      // signature -> {dist, versions, stateKey}
    this.individuals = new Map();  // person id -> {dist, versions, stateKey}
    this.pooledCache = new Map();  // signature -> {versions, dist}
    this.pending = new Set();      // question keys awaiting answers
    this.generation = 0;
    this.nextPumpAt = 0;
    this.refreshScale = 1;
    this.analysis = null;
    this.stats = {slicesAsked: 0, refinementsAsked: 0, individualsAsked: 0, answered: 0, rejected: 0, slices: 0,
      signatures: 0, eligible: 0, meanDisagreement: 0, refinedShare: 0, pooledComputations: 0, lastSweep: 0, status: 'warming up'};
  }

  reset() {
    this.slices.clear();
    this.refined.clear();
    this.individuals.clear();
    this.pooledCache.clear();
    this.pending.clear();
    this.analysis = null;
    this.generation++;
    this.nextPumpAt = 0;
    this.refreshScale = 1;
  }

  // People -> slice memberships and membership-signature groups.
  analyze(s, now) {
    if (this.analysis && this.analysis.s === s && this.analysis.now === now) return this.analysis;
    const {world, state, people} = this.describe(s);
    const sKey = stateKey(state);
    const sliceMembers = new Map();
    const signatures = new Map();
    const persons = [];
    for (const p of people) {
      const facts = this.facts(p, world);
      if (!facts || !facts.allowed?.length) continue;
      const memberships = {};
      if (this.baseline) memberships[BASELINE] = 'all';
      for (const [dim, of] of Object.entries(this.dimensions)) {
        const value = of(p, world);
        if (value !== null && value !== undefined) memberships[dim] = String(value);
      }
      const signature = membershipSignature(memberships);
      let group = signatures.get(signature);
      if (!group) {
        group = {signature, memberships, members: [], persons: [], sliceKeys: Object.entries(memberships).map(([d, v]) => `${d}=${v}`)};
        signatures.set(signature, group);
      }
      const person = {p, facts, group};
      group.members.push(p);
      group.persons.push(person);
      for (const key of group.sliceKeys) {
        if (!sliceMembers.has(key)) {
          const [dim, value] = splitKey(key);
          sliceMembers.set(key, {key, dim, value, members: []});
        }
        sliceMembers.get(key).members.push(p);
      }
      persons.push(person);
    }
    this.stats.slices = sliceMembers.size;
    this.stats.signatures = signatures.size;
    this.stats.eligible = persons.length;
    this.analysis = {s, now, world, state, stateKey: sKey, sliceMembers, signatures, persons};
    return this.analysis;
  }

  usable(entry, a, now) {
    return entry && entry.stateKey === a.stateKey && now - entry.at < 3 * this.ttlMs;
  }

  versionsOf(group) {
    return group.sliceKeys.map((k) => this.slices.get(k)?.version ?? 0).join(',');
  }

  weightFor(entry, size) {
    let w = this.weights[entry.dim] ?? 1;
    if (this.weightBy === 'size') w *= Math.sqrt(size);
    if (this.weightBy === 'confidence') w *= Math.max(0.05, 1 - entry.entropy);
    return w;
  }

  // Pooled slice distribution for a signature group, shared by its members.
  pooledFor(group, a, now) {
    const versions = this.versionsOf(group);
    const cached = this.pooledCache.get(group.signature);
    if (cached && cached.versions === versions && cached.stateKey === a.stateKey) return cached;
    const dists = [], weights = [];
    for (const key of group.sliceKeys) {
      const entry = this.slices.get(key);
      if (!this.usable(entry, a, now)) continue;
      dists.push(entry.dist);
      weights.push(this.weightFor(entry, a.sliceMembers.get(key)?.members.length ?? 1));
    }
    const result = {versions, stateKey: a.stateKey, dists, weights, dist: dists.length ? pool(dists, {weights, combine: this.combine}) : null};
    this.stats.pooledComputations++;
    this.pooledCache.set(group.signature, result);
    return result;
  }

  // A person's final distribution and where it came from, or null (local rules).
  distributionFor(person, a, now) {
    const {p, facts, group} = person;
    const pooled = this.pooledFor(group, a, now);
    const own = this.individuals.get(p.id);
    const refined = this.refined.get(group.signature);
    let base = null, source = 'pool';
    if (own && own.versions === pooled.versions && own.stateKey === a.stateKey) {
      base = own.dist;
      source = 'individual';
    } else if (refined && refined.versions === pooled.versions && refined.stateKey === a.stateKey) {
      base = blendRefinement(pooled.dist, refined.dist, this.refine.blend);
      source = 'refined';
    } else {
      base = pooled.dist;
    }
    if (!base) return null;
    const key = `${group.signature}#${pooled.versions}#${source}`;
    // People with the same memberships, mask and facts share one result.
    const memoKey = source === 'individual' ? null : `${key}|${facts.allowed.join(',')}|${JSON.stringify(facts.terms ?? null)}`;
    a.memo ??= new Map();
    if (memoKey && a.memo.has(memoKey)) return a.memo.get(memoKey);
    const dist = pool([base], {localTerms: facts.terms, allowed: facts.allowed});
    const result = dist && {dist, source, key};
    if (memoKey) a.memo.set(memoKey, result);
    return result;
  }

  refreshMs(entry) {
    return this.ttlMs * this.refreshScale / (1 + 2 * entry.entropy + 3 * entry.drift);
  }

  // Ask what is most valuable within the client's room: stale slices first
  // (the base sweep), then refinement where slices disagree.
  pump(s, now = this.now(), frameMs = 16) {
    if (!this.client || now < this.nextPumpAt) return 0;
    this.nextPumpAt = now + this.pumpMs;
    const net = this.client.stats();
    let room = Math.min(net.room, frameMs > 25 ? this.maxPerPump / 2 : this.maxPerPump);
    if (room <= 0) {
      this.stats.status = net.state === 'backoff' ? 'retrying; local rules active' : net.state === 'capped' ? 'manual cap' : 'pipeline full';
      return 0;
    }
    const a = this.analyze(s, now);
    const asked = this.sweep(a, now, room);
    room -= asked;
    const refinements = room > 0 ? this.refineEdges(a, now, room) : 0;
    this.stats.status = asked || refinements ? 'requesting' : 'covered';
    return asked + refinements;
  }

  sweep(a, now, room) {
    const due = [];
    for (const slice of a.sliceMembers.values()) {
      const qKey = `slice:${slice.key}`;
      if (this.pending.has(qKey)) continue;
      const entry = this.slices.get(slice.key);
      const fresh = entry && entry.stateKey === a.stateKey && now - entry.at < this.refreshMs(entry);
      if (fresh) continue;
      const age = entry ? now - entry.at : this.ttlMs * 4;
      due.push({slice, score: (entry && entry.stateKey === a.stateKey ? 0 : 1000) + age / 100 + Math.log2(slice.members.length + 1)});
    }
    due.sort((x, y) => y.score - x.score || (x.slice.key < y.slice.key ? -1 : 1));
    // Demand-driven refresh: stretch periods when sweeps alone overflow the room.
    this.refreshScale = due.length > room ? Math.min(4, this.refreshScale * 1.1) : Math.max(0.5, this.refreshScale * 0.98);
    const chosen = due.slice(0, room);
    for (const {slice, score} of chosen) {
      const context = slice.dim === BASELINE
        ? this.sliceContext(BASELINE, 'all', slice.members, a.world)
        : this.sliceContext(slice.dim, slice.value, slice.members, a.world);
      this.ask(`slice:${slice.key}`, context, {priority: 100 + score, tag: 'slice', state: a.state}, (answer) => this.acceptSlice(slice, a.stateKey, answer));
    }
    this.stats.slicesAsked += chosen.length;
    this.stats.lastSweep = chosen.length;
    return chosen.length;
  }

  // Score every signature by slice disagreement x size; ask the best.
  refineEdges(a, now, room) {
    const groups = [];
    let weighted = 0, people = 0, refinedPeople = 0;
    for (const group of a.signatures.values()) {
      const pooled = this.pooledFor(group, a, now);
      if (pooled.dists.length < 2) continue;
      const done = this.refined.get(group.signature);
      const isDone = done && done.versions === pooled.versions && done.stateKey === a.stateKey;
      const g = {signature: group.signature, size: group.members.length, dists: pooled.dists, weights: pooled.weights};
      const d = jsDivergence(g.dists, g.weights);
      weighted += d * g.size;
      people += g.size;
      const individualsDone = group.members.filter((p) => {
        const own = this.individuals.get(p.id);
        return own && own.versions === pooled.versions && own.stateKey === a.stateKey;
      }).length;
      refinedPeople += isDone ? g.size : individualsDone;
      if (isDone || this.pending.has(`refine:${group.signature}`) || individualsDone === g.size) continue;
      groups.push(g);
    }
    this.stats.meanDisagreement = people ? weighted / people : 0;
    this.stats.refinedShare = a.persons.length ? refinedPeople / a.persons.length : 0;
    const targets = refinementTargets(groups, {budget: room, threshold: this.refine.threshold, smallGroup: this.refine.smallGroup, highStakes: this.refine.highStakes});
    let asked = 0;
    for (const t of targets) {
      if (asked >= room) break;
      const group = a.signatures.get(t.signature);
      const versions = this.versionsOf(group);
      if (t.mode === 'intersection') {
        const context = this.intersectionContext(group.memberships, group.members, a.world);
        const state = this.intersectionState?.(group.memberships, group.members, a.world, a.state) ?? a.state;
        this.ask(`refine:${group.signature}`, context, {priority: 20 + t.score, tag: 'refine', state},
          (answer) => this.acceptRefinement(group.signature, versions, a.stateKey, answer));
        this.stats.refinementsAsked++;
        asked++;
        continue;
      }
      for (const person of group.persons) {
        const {p} = person;
        if (asked >= room) break;
        if (this.pending.has(`person:${p.id}`)) continue;
        const state = this.individualState?.(p, a.world, a.state) ?? a.state;
        this.ask(`person:${p.id}`, this.individualContext(p, a.world), {priority: 10 + t.score, tag: 'individual', state, allowed: person.facts.allowed},
          (answer) => this.acceptIndividual(p.id, versions, a.stateKey, answer));
        this.stats.individualsAsked++;
        asked++;
      }
    }
    return asked;
  }

  ask(qKey, context, opts, onAnswer) {
    const generation = this.generation;
    this.pending.add(qKey);
    const allowed = opts.allowed && opts.allowed.length < this.options.length ? opts.allowed : undefined;
    this.client.ask(this.kind, hashId('q', qKey), context, {...opts, allowed}).then((answer) => {
      if (generation !== this.generation) return;
      this.pending.delete(qKey);
      if (!answer || answer.kind !== this.kind) {
        this.stats.rejected++;
        return;
      }
      onAnswer(answer);
    }, () => this.pending.delete(qKey));
  }

  distOf(answer, requireProbabilities) {
    if (answer.probabilities) return normalize(answer.probabilities, this.options);
    if (requireProbabilities) return null; // a winner alone is never shared across people
    return normalize({[answer.choice]: 1}, this.options);
  }

  acceptSlice(slice, sKey, answer) {
    const dist = this.distOf(answer, true);
    if (!dist) { this.stats.rejected++; return; }
    const previous = this.slices.get(slice.key);
    this.slices.set(slice.key, {
      dim: slice.dim, value: slice.value, dist, at: this.now(), stateKey: sKey,
      version: (previous?.version ?? 0) + 1,
      entropy: normalizedEntropy(dist, this.options.length),
      drift: previous ? tvDistance(previous.dist, dist) : 0,
    });
    this.stats.answered++;
    this.dirty = true;
  }

  acceptRefinement(signature, versions, sKey, answer) {
    const dist = this.distOf(answer, true);
    if (!dist) { this.stats.rejected++; return; }
    this.refined.set(signature, {dist, versions, stateKey: sKey});
    this.stats.answered++;
    this.dirty = true;
  }

  acceptIndividual(id, versions, sKey, answer) {
    this.individuals.set(id, {dist: this.distOf(answer, false), versions, stateKey: sKey});
    this.stats.answered++;
    this.dirty = true;
  }
}

function splitKey(key) {
  const i = key.indexOf('=');
  return [key.slice(0, i), key.slice(i + 1)];
}

// ---------------------------------------------------------------------------
// Everyday routines on the legacy town state
// ---------------------------------------------------------------------------

const BANDS = ['critical', 'low', 'normal', 'high'];
const band = (n) => (n < 20 ? 0 : n < 40 ? 1 : n < 70 ? 2 : 3);
const bank = (x, z) => (x - (17 + Math.sin(z / 23) * 7 + Math.sin(z / 51) * 5) < 0 ? 0 : 1);
const wealthBand = (w) => (w < 40 ? 'poor' : w < 150 ? 'middling' : 'wealthy');

export function routineWorld(s) {
  const homes = new Set(), access = [new Set(), new Set()];
  const builders = new Set((s.projects ?? []).slice(0, 2).flatMap((p) => p.workers));
  let bridge = false;
  for (const b of s.buildings) {
    if (b.type === 'home') homes.add(b.id);
    if (b.type === 'bridge') bridge = true;
    access[bank(b.x, b.z)].add(b.type);
  }
  const both = new Set([...access[0], ...access[1]]);
  return {homes, access, reachable: bridge ? [both, both] : access, builders, bridge};
}

// Hard personal facts: what a resident can do, and what their body insists on.
export function routineFacts(s, p, world) {
  if (world.builders.has(p.id) || p.task?.kind === 'build') return null;
  const types = world.reachable[bank(p.x, p.z)];
  const allowed = [];
  if (types.has('farm') || types.has('utility')) allowed.push('work');
  if (world.homes.has(p.home)) allowed.push('rest');
  if (types.has('market') && s.food > 0) allowed.push('shop');
  if (types.has('park') || types.has('market')) allowed.push('leisure');
  const terms = {};
  if ((p.fullness ?? 75) < 20) terms.shop = 8;   // hungry: strongly prefer the market
  if ((p.energy ?? 75) < 20) terms.rest = 8;     // exhausted: strongly prefer home
  return {allowed, terms};
}

const DISTRICT = (p) => `${bank(p.x, p.z) ? 'east' : 'west'} ${Math.floor(p.x / 32)} ${Math.floor(p.z / 32)}`;
// Work type: which workplaces a resident can reach. The legacy state has no
// trade or life stage; the v2 resident_routine kind slices by lifeStage.
const workType = (p, world) => {
  const types = world.reachable[bank(p.x, p.z)];
  const farm = types.has('farm'), shop = types.has('utility');
  return farm && shop ? 'farm or workshop' : farm ? 'farm' : shop ? 'workshop' : 'none';
};
const ROUTINE_DIMENSIONS = {
  district: (p) => DISTRICT(p),
  work: (p, world) => workType(p, world),
  wealth: (p) => wealthBand(p.wealth ?? 0),
  energy: (p) => BANDS[band(p.energy ?? 75)],
  fullness: (p) => BANDS[band(p.fullness ?? 75)],
  social: (p) => BANDS[band(p.social ?? 65)],
};
const LABELS = {
  district: (v) => `in the ${v.split(' ')[0]} district ${v.split(' ').slice(1).join(' ')}`,
  wealth: (v) => `with ${v} savings`,
  work: (v) => (v === 'none' ? 'with no workplace nearby' : `near a ${v}`),
};

export function routineState(s) {
  const perHead = s.food / Math.max(1, s.people.length) * 10;
  return {
    phase: ['rest', 'work', 'shop', 'leisure'][s.day % 4],
    food: perHead < 40 ? 'low' : perHead < 70 ? 'ok' : 'plenty',
    wellbeing: s.happiness < 40 ? 'poor' : s.happiness < 70 ? 'fair' : 'good',
    taxStep: Math.max(0, Math.min(25, Math.round(s.policy?.tax ?? 0))),
  };
}

export class AdaptiveRoutinePolicy extends SlicedPopulation {
  constructor({client = null, now = clock, ...rest} = {}) {
    super({
      client, now, kind: 'routine', dimensions: ROUTINE_DIMENSIONS, ...rest,
      describe: (s) => ({world: routineWorld(s), state: routineState(s), people: s.people}),
      facts: (p, world) => routineFacts(this.town, p, world),
      sliceContext: (dim, value, members) => {
        const context = {slice: dim, group: members.length};
        if (LABELS[dim]) context.label = LABELS[dim](value);
        if (dim === 'energy' || dim === 'fullness' || dim === 'social') context[dim] = value;
        return context;
      },
      intersectionContext: (m, members) => ({
        slice: 'intersection', group: members.length,
        label: [m.district && LABELS.district(m.district), m.wealth && LABELS.wealth(m.wealth), m.work && LABELS.work(m.work)].filter(Boolean).join(', ').slice(0, 80),
        ...(m.energy ? {energy: m.energy} : {}), ...(m.fullness ? {fullness: m.fullness} : {}), ...(m.social ? {social: m.social} : {}),
      }),
      individualContext: (p) => ({
        slice: 'individual', energy: ROUTINE_DIMENSIONS.energy(p), fullness: ROUTINE_DIMENSIONS.fullness(p),
        social: ROUTINE_DIMENSIONS.social(p), wealth: Math.max(0, p.wealth ?? 0),
      }),
    });
    this.assigned = new Map();
    this.dirty = false;
    Object.assign(this.stats, {sampled: 0, covered: 0, questions: 0});
  }

  analyze(s, now) {
    this.town = s;
    return super.analyze(s, now);
  }

  reset() {
    super.reset();
    this.assigned.clear();
    this.stats.covered = 0;
  }

  pump(s, now = this.now(), frameMs = 16) {
    const asked = super.pump(s, now, frameMs);
    this.stats.questions = this.stats.slicesAsked + this.stats.refinementsAsked + this.stats.individualsAsked;
    this.observe();
    return asked;
  }

  // Routine intents for residents whose distribution changed since their last
  // assignment today. Each resident samples independently and
  // deterministically from (id, day, kind).
  sample(s, now = this.now()) {
    this.dirty = false;
    const a = this.analyze(s, now);
    const alive = new Set(s.people.map((p) => p.id));
    for (const id of this.assigned.keys()) if (!alive.has(id)) this.assigned.delete(id);
    const intents = [];
    let covered = 0;
    for (const person of a.persons) {
      const result = this.distributionFor(person, a, now);
      if (!result) continue;
      const stamp = `${s.day}:${result.key}`;
      covered++;
      if (this.assigned.get(person.p.id) === stamp) continue;
      const activity = sampleDistribution(result.dist, person.facts.allowed, randomFor(person.p.id, s.day, this.kind));
      if (!activity) continue;
      const probabilities = Object.fromEntries(ACTIVITIES.map((o) => [o, result.dist[o] ?? 0]));
      intents.push({personId: person.p.id, activity, confidence: probabilities[activity], probabilities, contextKey: person.group.signature, source: result.source});
      this.assigned.set(person.p.id, stamp);
      this.stats.sampled++;
    }
    this.stats.covered = covered;
    return intents;
  }

  // Mirrors the shared client's network figures for the settings diagnostics.
  observe() {
    const n = this.client?.stats() ?? {};
    Object.assign(this.stats, {
      mode: n.mode ?? 'auto', limit: n.cap ?? null, observedRate: n.observedRate ?? 0, capacity: n.capacity ?? 0,
      latencyMs: n.latencyMs ?? 0, inFlight: n.inFlight ?? 0, queueDepth: n.queueDepth ?? 0, concurrency: n.concurrency ?? 0,
      batchSize: n.batchSize ?? 0, network: n.state ?? 'offline', pending: this.pending.size, refreshScale: this.refreshScale,
    });
    return this.stats;
  }
}
