// Card subjects: what a card is about, so the same question is never asked
// twice at once, while it is being built, or soon after it was settled.
//
// A subject is a short key:
//   tpl:<templateId>[@<centreId>]   a body's plan (wards add their centre)
//   work:<kind>                     a kind of public work (pave, bridge, embankment…)
//   build:<type>                    a town building (school, warehouse, moot…)
//   rule:<policyId>                 a rule in the Rule Book
//   event:<eventId>                 a happening (the fair)
//   petition:<faction>:<grievance>  a group's complaint
//   form:<kind>, revive:<bodyId>    a body forming or asking for a fresh start
//
// Every card carries card.subjects (debates and batches take both sides'),
// and every ruling is recorded with them in state.cardHistory. Before any
// source drafts a card (a body, the Moot, a debate, an event, a petition, the
// bridge watch) it asks subjectBlocked().

import {TEMPLATES} from './institutions.js';

// After a ruling, how long the same subject waits (years).
export const SUBJECT_COOLDOWN = {
  accepted: {tpl: 3, work: 3, build: 3, rule: 8, petition: 8, form: 0, revive: 0, event: 0},
  not_now: {tpl: 3, work: 0, build: 0, rule: 3, petition: 4, form: 0, revive: 0, event: 0},
  refuse: {tpl: 6, work: 0, build: 0, rule: 6, petition: 6, form: 0, revive: 0, event: 0},
};
// Any change to a rule, from any source, waits this long before the next ask…
export const RULE_GAP_YEARS = 8;
// …unless the need is sharp, and then at least this long.
export const SHARP_NEED = 0.85;
export const SHARP_GAP_YEARS = 3;

const family = (s) => s.slice(0, s.indexOf(':'));
const workSubject = (kind) => `work:${kind === 'bridge-basic' ? 'bridge' : kind}`;

// What a body's template is about (options: the ones it would offer).
export function templateSubjects(templateId, centreId = null, options = null) {
  const t = TEMPLATES[templateId];
  const out = new Set([`tpl:${templateId}${centreId != null ? `@${centreId}` : ''}`]);
  if (!t) return [...out];
  if (t.work) out.add(workSubject(t.work));
  addEffectSubjects(out, options ?? t.options);
  return [...out];
}

function addEffectSubjects(out, options) {
  for (const o of options ?? []) {
    for (const e of o.effects ?? []) {
      if (e.build) out.add(`build:${e.build}`);
      if (e.policy && e.policy !== 'target') out.add(`rule:${e.policy}`);
      if (e.event) out.add(`event:${e.event}`);
    }
  }
}

// What a card is about, from its fields (cards made before subjects existed too).
export function deriveSubjects(card, centreId = null) {
  const tid = String(card.templateId ?? '');
  const out = new Set();
  if (card.data?.cards?.length || card.data?.batch?.length) {
    for (const sub of card.data.cards ?? card.data.batch) for (const s of sub.subjects ?? deriveSubjects(sub)) out.add(s);
    return [...out];
  }
  if (TEMPLATES[tid]) return templateSubjects(tid, centreId, card.options?.length ? card.options : null);
  const [head, rest] = [tid.slice(0, tid.indexOf(':')), tid.slice(tid.indexOf(':') + 1)];
  if (['adopt', 'raise', 'ease'].includes(head)) out.add(`rule:${rest}`);
  else if (head === 'event') out.add(`event:${rest}`);
  else if (head === 'grievance') out.add(`petition:${card.data?.faction ?? card.faction ?? 'town'}:${rest}`);
  if (card.data?.policy || card.policy) out.add(`rule:${card.data?.policy ?? card.policy}`);
  if (card.data?.forms) out.add(`form:${card.data.forms}`);
  if (card.data?.revive) out.add(`revive:${card.data.revive}`);
  if (!out.size && tid) out.add(`tpl:${tid}`);
  if (card.kind !== 'event') addEffectSubjects(out, card.options);
  return [...out];
}

export const subjectsOf = (card) => card.subjects ?? deriveSubjects(card);

// ---------------------------------------------------------------------------
// The guard
// ---------------------------------------------------------------------------

// Is this subject on the docket now (shown, queued, or inside a debate)?
export function subjectOpen(state, subject, except = null) {
  for (const c of state.docket ?? []) {
    if (c === except || c.kind === 'report') continue;
    if (subjectsOf(c).includes(subject)) return true;
  }
  return false;
}

// Is it under way: a town project of that kind, a town building of that type
// being raised or waiting for a site, a rule changed lately, an event cooling down?
export function subjectInFlight(state, subject, {need = 0} = {}) {
  const fam = family(subject);
  const id = subject.slice(fam.length + 1);
  if (fam === 'work') return worksInFlight(state).has(id);
  if (fam === 'build') return buildsInFlight(state).has(id);
  if (fam === 'rule') {
    const changed = state.governance?.ruleChanged?.[id];
    if (changed == null) return false;
    const gap = state.time.year - changed;
    return gap < (need >= SHARP_NEED ? SHARP_GAP_YEARS : RULE_GAP_YEARS);
  }
  if (fam === 'event') return (state.events?.cooldownUntil?.[id] ?? -1) > state.time.year;
  return false;
}

// Settled lately? The last ruling on this subject sets the wait.
// opts.declines false: only an acceptance counts (demand-led plans set their
// own return after Not now).
export function subjectCooling(state, subject, {declines = true, need = 0, mood = null} = {}) {
  const last = historyIndex(state).get(subject);
  if (!last) return false;
  const fam = family(subject);
  const kind = verdict(last);
  if (!kind || (!declines && kind !== 'accepted')) return false;
  let years = SUBJECT_COOLDOWN[kind]?.[fam] ?? 0;
  if (fam === 'rule' && need >= SHARP_NEED) years = Math.min(years, SHARP_GAP_YEARS);
  // A group whose lot has worsened markedly since it was heard may come back.
  if (fam === 'petition' && mood != null && last.mood != null && last.mood - mood > 0.2) return false;
  return state.time.year - last.year < years;
}

// The one question every drafter asks. Returns the reason, or null.
export function subjectBlocked(state, subjects, opts = {}) {
  for (const s of subjects) {
    if (subjectOpen(state, s, opts.except)) return {subject: s, why: 'open'};
    if (subjectInFlight(state, s, opts)) return {subject: s, why: 'in-flight'};
    if (subjectCooling(state, s, opts)) return {subject: s, why: 'cooldown'};
  }
  return null;
}

// How many times this subject has come before the council already.
export function timesAsked(state, subject) {
  return historyIndex(state).get(subject)?.count ?? 0;
}

// A ruling's kind: accepted (it happened), not_now, or refuse.
export function verdict(h) {
  if (h.choice === 'refuse' || h.choice === 'refuse_anyway' || h.outcome === 'refused' || h.outcome === 'lost') return 'refuse';
  if (h.choice === 'not_now' || h.choice === 'planks' || h.outcome === 'deferred' || h.outcome === 'expired' || h.choice == null ||
    h.outcome === 'compromise' || h.outcome === 'withdrawn') return 'not_now';
  if (['accepted', 'won', 'delegated', 'enacted', 'standing-order'].includes(h.outcome)) return 'accepted';
  return null;
}

// Latest ruling per subject (within 25 years), rebuilt when the history changes.
const indexCache = new WeakMap();
function historyIndex(state) {
  const hist = state.cardHistory ?? [];
  const key = `${hist.length}:${hist[0]?.id}:${hist.at(-1)?.id}:${state.time.year}`;
  const cached = indexCache.get(state);
  if (cached?.key === key) return cached.map;
  const map = new Map();
  for (let i = hist.length - 1; i >= 0; i--) {
    const h = hist[i];
    if (state.time.year - h.year > 25) break;
    for (const s of h.subjects ?? deriveSubjects(h)) {
      const seen = map.get(s);
      if (seen) seen.count++;
      else map.set(s, {year: h.year, choice: h.choice, outcome: h.outcome, mood: h.mood ?? null, count: 1});
    }
  }
  indexCache.set(state, {key, map});
  return map;
}

// Paid by the town or one of its bodies (folk laying planks at a ford are not).
const town = (payer) => payer == null || payer === 'treasury' || String(payer).startsWith('body:');

// Town-funded work under way, by kind ('bridge-upgrade' covers repairs and rebuilds).
function worksInFlight(state) {
  return perTick(state, 'works', () => {
    const kinds = new Set();
    for (const p of state.projects ?? []) {
      if (!town(p.payer)) continue;
      kinds.add(p.kind);
      if (p.kind === 'bridge-repair' || (p.kind === 'bridge' && p.data?.replaces)) kinds.add('bridge-upgrade');
    }
    return kinds;
  });
}

// Town buildings being raised, upgraded, or queued for a site (private builds aside).
function buildsInFlight(state) {
  return perTick(state, 'builds', () => {
    const types = new Set();
    const wanted = new Map();
    for (const p of state.projects ?? []) {
      if ((p.kind === 'build' || p.kind === 'upgrade' || p.kind === 'extend') && p.buildingId != null && town(p.payer)) wanted.set(p.buildingId, true);
    }
    if (wanted.size) for (const b of state.buildings ?? []) if (wanted.has(b.id)) types.add(b.type);
    for (const q of state.buildQueue ?? []) if (town(q.payer)) types.add(q.type);
    return types;
  });
}

const tickCache = new WeakMap();
function perTick(state, name, make) {
  let c = tickCache.get(state);
  const key = `${state.time.tick}:${state.projects?.length ?? 0}:${state.buildQueue?.length ?? 0}`;
  if (!c || c.key !== key) tickCache.set(state, c = {key});
  return (c[name] ??= make());
}
