// Approval: of the people, how many approve of how you rule
// (docs/design/governance-budgets-advisors.md §5). It is not wellbeing (how
// life is) but how people judge you: their group's mood, how your rulings went
// against what they wanted, how they took the rule changes, and whether they
// think of leaving or of gathering at the hall.
//
// One pass a year (governance year(), after factionsYearly), from data the sim
// already keeps, O(households). Recorded silently from year 0; shown from
// Borough. Version 1 only reports: nothing in the sim reads state.approval.
// No random numbers, so existing runs replay exactly.
//
// state.approval = {
//   year, overall 0..1, strongAgainst 0..1 (share of people in groups below 25%),
//   rows: {dim: {value: {v, n}}}   faction, trade, wealthBand, district, centre,
//                                   lifeStage, faithBand, newcomer (people-weighted)
//   parts: {mood, rulings, reaction, leaving, petitioning}   overall, in score units
//   drivers: [{key, kind, text, about, points}]               why it moved (≤ 3 up, ≤ 3 down)
//   ledger: {'trade=farm': net}     react_to_policy answers, folded 0.7 old + 0.3 new
//   reactions: [{y, policy, change, net, worst, best}]        the latest rule reactions (cap 12)
//   history: [{y, all, f: {factionId: v}}]                   cap 200
//   leavingBy: {wealthBand: share thinking of leaving}
//   base: {slope, f: {id: {mood, target, rules: {}, looks}}, life: {}, unrest, terms: {}}
//                                   last pass's parts, which the next pass compares against
// }

import {POLICIES, activePolicies} from './policies.js';
import {FACTIONS, rootFaction, moodParts} from './factions.js';
import {wellbeingParts} from './pressures.js';
import {addChronicle} from './chronicle.js';
import {memberships, centreSliceName, safe} from './decisions/slices.js';
import {KINDS} from './decisions/kinds.js';

export const APPROVAL_WEIGHTS = {mood: 0.5, rulings: 0.2, reaction: 0.15, leaving: 0.1, petitioning: 0.05};
export const APPROVAL_DIMS = ['faction', 'trade', 'wealthBand', 'district', 'centre', 'lifeStage', 'faithBand', 'newcomer'];
export const APPROVAL_SHOWN_ERA = 3;
const HISTORY_CAP = 200;
const REACTIONS_CAP = 12;
const RULING_YEARS = 3;
const RULING_DECAY = 0.6;
const LEDGER_KEEP = 0.7;
const STRONG_AGAINST = 0.25;
const MOOD_STEP = 0.2;   // factionsYearly moves mood a fifth of the way to its target
const CHRONICLE_POINTS = 5;

const KIND = Object.fromEntries(KINDS.map((k) => [k.id, k]));

// How a ruling sat with a faction: its stance times what you did.
const RULING_SIGN = {accepted: 1, won: 1, enacted: 1, delegated: 1, budget: 1, compromise: 0.5, refused: -1, lost: -1, deferred: -0.5, expired: -0.5};
const STANCE_SIGN = {for: 1, back: 1, against: -1, oppose: -1, split: 0};

const r3 = (x) => Math.round(x * 1000) / 1000;
const r2 = (x) => Math.round(x * 100) / 100;
const logistic = (x) => 1 / (1 + Math.exp(-x));

// A rule reaction's net: welcome counts for, protest, strikes and leaving against.
export function reactionNet(p = {}) {
  return (p.support ?? 0) + (p.accept ?? 0) / 2 - (p.grumble ?? 0) / 2 - (p.protest ?? 0) - (p.strike ?? 0) - (p.leave ?? 0);
}

const emptyApproval = () => ({
  year: null, overall: null, strongAgainst: null, rows: {}, parts: {}, drivers: [], ledger: {}, reactions: [], history: [], base: null,
});

// Fill a missing or partial record (new games, and saves from before approval).
export function initApproval(state) {
  const a = (state.approval ??= emptyApproval());
  for (const [k, v] of Object.entries(emptyApproval())) a[k] ??= v;
  // An older save has no ledger: start it from the slice answers it kept.
  if (!Object.keys(a.ledger).length) {
    for (const [key, row] of Object.entries(state.governance?.sliceAnswers?.react_to_policy ?? {})) {
      if (row?.prev?.probs) a.ledger[key] = reactionNet(row.prev.probs);
      if (row?.probs) a.ledger[key] = fold(a.ledger[key], reactionNet(row.probs));
    }
  }
  // A figure straight away (no trend until the next year's pass).
  if (a.overall == null && state.households?.length) approvalPass(state, {chronicle: false, history: state.time.year > 0});
  return a;
}

const fold = (old, net) => r3(old == null ? net : LEDGER_KEEP * old + (1 - LEDGER_KEEP) * net);

// A react_to_policy sweep finished (scheduler.js finishSweep): fold its slice
// answers into the ledger, so approval remembers more than the newest rule.
export function foldReaction(state, answers, meta = {}, pooled = null) {
  const a = (state.approval ??= emptyApproval());
  a.ledger ??= {};
  let worst = null, best = null;
  for (const ans of answers) {
    const dim = ans.subject?.dim;
    if (!dim) continue;
    const key = `${dim}=${ans.subject.value}`;
    const net = reactionNet(ans.probs);
    a.ledger[key] = fold(a.ledger[key], net);
    if (dim !== 'trade') continue;
    if (!worst || net < worst.net || (net === worst.net && key < worst.key)) worst = {key, net};
    if (!best || net > best.net || (net === best.net && key < best.key)) best = {key, net};
  }
  if (!meta.policy) return;
  (a.reactions ??= []).push({
    y: state.time.year, policy: meta.policy, change: meta.change ?? null,
    net: r3(pooled ? reactionNet(pooled) : 0), worst: worst?.key ?? null, best: best?.key ?? null,
  });
  if (a.reactions.length > REACTIONS_CAP) a.reactions.splice(0, a.reactions.length - REACTIONS_CAP);
}

// The yearly pass. Writes state.approval; returns it.
export function approvalYearly(state) {
  initApproval(state);
  return approvalPass(state, {chronicle: true, history: true});
}

function approvalPass(state, {chronicle, history}) {
  const a = state.approval;
  const y = state.time.year - 1;   // the year that just ended
  const W = APPROVAL_WEIGHTS;
  const factions = new Map((state.factions ?? []).map((f) => [f.id, f]));
  const gov = state.governance ?? {};
  const store = gov.sliceAnswers ?? {};

  const rulings = rulingsByFaction(state, y);
  const stay = store.household_stay_move ?? {};
  const petition = store.petition ?? {};
  const react = KIND.react_to_policy, move = KIND.household_stay_move;

  // Names once per pass, as buildSlices does (without touching its cache).
  const names = new Map((state.districts ?? []).map((d) => [d.id, safe(d.name)]));
  const centres = new Map((state.centres ?? []).map((c) => [c.id, safe(c.mergedInto != null ? centreSliceName(state, c.mergedInto) : c.name)]));

  const rows = Object.fromEntries(APPROVAL_DIMS.map((d) => [d, {}]));
  const sums = {mood: 0, rulings: 0, reaction: 0, leaving: 0, petitioning: 0};
  // Points per unit of score, people-weighted, by faction (for the reasons below).
  const slopeBy = new Map();
  const rootSlope = new Map();
  const terms = {};
  const leaveByWealth = {};
  let people = 0, approve = 0, against = 0, slopeAll = 0;

  for (const h of state.households ?? []) {
    const n = h.size ?? 1;
    if (!(n > 0)) continue;
    const m = memberships(state, h, names, centres);
    const fid = m.faction;
    const root = rootFaction(state, fid);
    const f = factions.get(fid) ?? factions.get(root);
    const mood = (f?.mood ?? 0.6) - 0.5;   // 0.5·(2·mood − 1)
    const rul = rulings.get(root)?.value ?? 0;
    const reaction = pooled(react, m, (key) => a.ledger[key]);
    const leaving = Math.min(1, 5 * pooled(move, m, (key) => {
      const p = stay[key]?.probs;
      return p ? (p.emigrate ?? 0) + (p.move_to_centre ?? 0) : null;
    }));
    const pp = (petition[`faction=${fid}`] ?? petition[`faction=${root}`])?.probs;
    const petitioning = pp ? (pp.gather ?? 0) + (pp.leave ?? 0) : 0;
    const s = W.mood * 2 * mood + W.rulings * rul + W.reaction * reaction - W.leaving * leaving - W.petitioning * petitioning;
    const v = logistic(4 * s);
    const slope = 400 * v * (1 - v);   // approval points per unit of score here

    people += n;
    approve += n * v;
    if (v < STRONG_AGAINST) against += n;
    sums.mood += n * W.mood * 2 * mood;
    sums.rulings += n * W.rulings * rul;
    sums.reaction += n * W.reaction * reaction;
    sums.leaving -= n * W.leaving * leaving;
    sums.petitioning -= n * W.petitioning * petitioning;
    slopeAll += n * slope;
    slopeBy.set(fid, (slopeBy.get(fid) ?? 0) + n * slope);
    rootSlope.set(root, (rootSlope.get(root) ?? 0) + n * slope);
    terms.reaction = (terms.reaction ?? 0) + n * slope * W.reaction * reaction;
    terms.leaving = (terms.leaving ?? 0) - n * slope * W.leaving * leaving;
    terms.petitioning = (terms.petitioning ?? 0) - n * slope * W.petitioning * petitioning;
    const wb = (leaveByWealth[m.wealthBand] ??= {n: 0, x: 0});
    wb.n += n;
    wb.x += n * leaving;
    for (const d of APPROVAL_DIMS) {
      const row = (rows[d][m[d]] ??= {v: 0, n: 0});
      row.v += n * v;
      row.n += n;
    }
  }
  if (!people) return a;

  // The rulings term, card by card.
  for (const [root, entry] of rulings) {
    const S = rootSlope.get(root) ?? 0;
    if (!S) continue;
    for (const [id, c] of entry.cards) terms[`ruling:${id}`] = (terms[`ruling:${id}`] ?? 0) + S * W.rulings * c;
  }
  for (const k of Object.keys(terms)) terms[k] = r2(terms[k] / people);

  const prevAll = a.overall != null && a.year != null && a.year < y ? a.overall : null;
  for (const d of APPROVAL_DIMS) for (const row of Object.values(rows[d])) row.v = r3(row.v / row.n);
  const fRows = Object.fromEntries(Object.entries(rows.faction).map(([id, r]) => [id, r.v]));

  const base = moodBase(state, factions);
  base.slope = r2(slopeAll / people);
  base.terms = terms;
  const drivers = a.base && prevAll != null ? whyItMoved(state, a.base, base, slopeBy, people) : [];

  Object.assign(a, {
    year: y, overall: r3(approve / people), strongAgainst: r3(against / people), rows,
    parts: Object.fromEntries(Object.entries(sums).map(([k, v]) => [k, r3(v / people)])),
    drivers, base,
  });
  a.leavingBy = Object.fromEntries(Object.entries(leaveByWealth).map(([k, r]) => [k, r3(r.x / r.n)]));

  if (history && y >= 0) {
    if (a.history.at(-1)?.y === y) a.history.pop();
    a.history.push({y, all: a.overall, f: fRows});
    if (a.history.length > HISTORY_CAP) a.history.splice(0, a.history.length - HISTORY_CAP);
  }
  const change = prevAll != null ? Math.round((a.overall - prevAll) * 100) : 0;
  if (chronicle && (state.era ?? 0) >= APPROVAL_SHOWN_ERA && Math.abs(change) >= CHRONICLE_POINTS) {
    const top = drivers.find((d) => Math.sign(d.points) === Math.sign(change));
    const pct = Math.round(a.overall * 100);
    addChronicle(state, `Your standing ${change > 0 ? 'rose' : 'fell'} to ${pct}%${top?.about ? `, chiefly over ${top.about}` : ''}.`, 'line', {approval: pct, change});
  }
  return a;
}

// Weighted mean of a kind's slice values for one household's memberships.
function pooled(kind, m, valueOf) {
  let sum = 0, w = 0;
  for (const d of kind.slices) {
    const x = valueOf(`${d}=${m[d]}`);
    if (x == null || !Number.isFinite(x)) continue;
    const wd = kind.weights[d] ?? 0.3;
    sum += wd * x;
    w += wd;
  }
  return w ? sum / w : 0;
}

// The last three years of rulings, by faction: +1 when you did what they
// wanted, −1 when you went against them, decayed 0.6 a year and shrunk toward
// 0 when there are few. Returns root faction id -> {value, cards: Map(id -> share)}.
function rulingsByFaction(state, y) {
  const out = new Map();
  for (const c of state.cardHistory ?? []) {
    if (c.year < y - (RULING_YEARS - 1) || c.kind === 'event' || c.kind === 'report') continue;
    const r = RULING_SIGN[c.outcome];
    if (r == null) continue;
    const w = RULING_DECAY ** Math.max(0, y - c.year);
    for (const [fid, stance] of Object.entries(c.stances ?? {})) {
      const st = STANCE_SIGN[stance];
      if (st == null) continue;
      const e = out.get(fid) ?? {w: 0, sum: 0, raw: []};
      out.set(fid, e);
      e.w += w;
      e.sum += w * st * r;
      if (st) e.raw.push([c.id, w * st * r]);
    }
  }
  for (const e of out.values()) {
    const d = e.w + 1;
    e.value = e.sum / d;
    e.cards = new Map();
    for (const [id, x] of e.raw) e.cards.set(id, (e.cards.get(id) ?? 0) + x / d);
  }
  return out;
}

// What each faction's mood is made of now: its target's parts and where the
// mood stands. The next pass compares against these.
function moodBase(state, factions) {
  const life = wellbeingParts(state);
  const lifeParts = Object.fromEntries(Object.entries(life).map(([k, v]) => [k, v / 200]));
  const policies = activePolicies(state);
  const f = {};
  for (const fac of factions.values()) {
    const parts = fac.moodParts ?? moodParts(state, fac);
    const rules = {};
    for (const p of policies) {
      const def = POLICIES[p.id];
      const n = (def.helps?.some((t) => fac.trades?.includes(t)) ? p.level : 0) - (def.hurts?.some((t) => fac.trades?.includes(t)) ? p.level : 0);
      if (n) rules[p.id] = r3(0.06 * n);
    }
    f[fac.id] = {mood: r3(fac.mood ?? 0.6), target: r3(Math.max(0, Math.min(1, 0.5 + parts.rules + parts.wellbeing + parts.unrest + parts.looks))), rules, looks: r3(parts.looks),
      log: Object.fromEntries(Object.entries(fac.moodLog ?? {}).map(([k, v]) => [k, r3(v)]))};
    // What moved the mood since the last pass has been read: start afresh.
    fac.moodLog = {};
  }
  return {f, life: Object.fromEntries(Object.entries(lifeParts).map(([k, v]) => [k, r3(v)])), unrest: r3(-(state.pressures?.unrest ?? 0) * 0.3)};
}

// ---------------------------------------------------------------------------
// Why it moved: the largest changes against last year, in approval points.
//
// A faction's mood moves a fifth of the way to its target each year, so of
// this year's change in a faction's mood, 0.2 × (each part's change) is the
// new push from that part (a rule, food, homes...), 0.2 × (last year's target
// − last year's mood) is earlier change still sinking in, and the rest is the
// year's rulings and news. The other terms compare their contributions.
// ---------------------------------------------------------------------------

function whyItMoved(state, prev, now, slopeBy, people) {
  const items = new Map();
  const add = (key, x, fid = null) => {
    const it = items.get(key) ?? {p: 0, by: {}};
    items.set(key, it);
    it.p += x;
    if (fid) it.by[fid] = (it.by[fid] ?? 0) + x;
  };
  for (const [fid, cur] of Object.entries(now.f)) {
    const was = prev.f?.[fid];
    const S = (slopeBy.get(fid) ?? 0) / people;
    if (!was || !S) continue;
    let pushed = 0;
    const push = (key, d, step = MOOD_STEP) => { if (d) { add(key, S * step * d, fid); pushed += step * d; } };
    for (const id of new Set([...Object.keys(cur.rules), ...Object.keys(was.rules ?? {})])) push(`rule:${id}`, (cur.rules[id] ?? 0) - (was.rules?.[id] ?? 0));
    // Wellbeing is town-wide: each of its parts (food, homes, work...) pushes
    // alike on every faction. Rounding and clamping are left to the news.
    for (const k of Object.keys(now.life)) push(LIFE_KEY[k] ?? `life:${k}`, (now.life[k] ?? 0) - (prev.life?.[k] ?? 0));
    push('unrest', (now.unrest ?? 0) - (prev.unrest ?? 0));
    push('looks', cur.looks - (was.looks ?? 0));
    // Nudges through the year (rulings, reactions to rules, displacements,
    // events) carry into the yearly step at 1 − 0.2.
    for (const [source, v] of Object.entries(cur.log ?? {})) push(LOG_KEY[source] ?? 'news', v, 1 - MOOD_STEP);
    const catchup = MOOD_STEP * ((was.target ?? was.mood) - was.mood);
    if (catchup) add('catchup', S * catchup, fid);
    add('news', S * (cur.mood - was.mood - pushed - catchup), fid);
  }
  for (const key of new Set([...Object.keys(now.terms ?? {}), ...Object.keys(prev.terms ?? {})])) {
    const d = (now.terms?.[key] ?? 0) - (prev.terms?.[key] ?? 0);
    if (d) add(key, d);
  }
  const ranked = [...items].map(([key, it]) => [key, it.p, it.by]).filter(([, p]) => Math.abs(p) >= 0.5)
    .sort((x, z) => Math.abs(z[1]) - Math.abs(x[1]) || (x[0] < z[0] ? -1 : 1));
  const up = ranked.filter(([, p]) => p > 0).slice(0, 3), down = ranked.filter(([, p]) => p < 0).slice(0, 3);
  return [...up, ...down].sort((x, z) => Math.abs(z[1]) - Math.abs(x[1]) || (x[0] < z[0] ? -1 : 1))
    .map(([key, p, by]) => ({key, kind: key.split(':')[0], points: r2(p), ...describe(state, key, p, prev, now, by)}));
}

const LIFE_KEY = {looks: 'looks', calm: 'unrest'};
const LOG_KEY = {rulings: 'rulings', reactions: 'reaction', displaced: 'displaced', events: 'events'};

const lowerFirst = (s) => (s ? s[0].toLowerCase() + s.slice(1) : s);
const TRADE_GROUP = Object.fromEntries(FACTIONS.flatMap((f) => f.trades.map((t) => [t, f.name])));
const groupOfTrades = (state, trades) => (state.factions ?? [])
  .filter((f) => !f.parent && f.size > 0 && f.trades?.some((t) => trades?.includes(t)))
  .sort((a, b) => b.size - a.size).slice(0, 2).map((f) => f.name);

const LIFE_WORDS = {
  food: ['Fuller stores', 'Food ran short', 'food'],
  homes: ['More families housed', 'Families waiting for homes', 'homes'],
  work: ['More work to be had', 'Fewer jobs to be had', 'work'],
  health: ['Better health', 'More sickness', 'sickness'],
  calm: ['Calmer streets', 'Unrest on the streets', 'the unrest'],
  hunger: ['No one goes hungry now', 'Hunger in town', 'hunger'],
  extra: ['Feasts and fairs', 'Fewer feasts and fairs', 'the feasts'],
  other: ['Life got easier', 'Life got harder', 'how life is'],
};

// The faction a reason moved most in its own direction.
function mostMoved(state, by, up) {
  const [fid] = Object.entries(by ?? {}).filter(([, x]) => (up ? x > 0 : x < 0)).sort((a, b) => Math.abs(b[1]) - Math.abs(a[1]) || (a[0] < b[0] ? -1 : 1))[0] ?? [];
  return fid ? state.factions?.find((f) => f.id === fid)?.name ?? null : null;
}

function describe(state, key, points, prev, now, by) {
  const up = points > 0;
  const [kind, ref] = [key.split(':')[0], key.slice(key.indexOf(':') + 1)];
  if (kind === 'rule') {
    const def = POLICIES[ref];
    const title = def?.title ?? ref;
    const glad = groupOfTrades(state, def?.helps), sore = groupOfTrades(state, def?.hurts);
    const who = [glad.length ? `${glad.join(' and ')} glad` : '', sore.length ? `${sore.join(' and ')} sore` : ''].filter(Boolean).join(', ');
    return {ref, text: who ? `${title}: ${who}` : title, about: lowerFirst(title)};
  }
  if (kind === 'ruling') {
    const c = [...(state.cardHistory ?? [])].reverse().find((x) => x.id === ref);
    // A question ("Which first?") is never quoted: it is named by the answer
    // chosen, else by what it asked (cardHistory's ask), else as a choice of plans.
    const question = /\?$/.test(c?.title ?? '');
    const title = !question ? c?.title ?? 'a request' : c?.label ?? c?.ask ?? 'a choice between two plans';
    const t = lowerFirst(title);
    const fading = Math.abs(now.terms?.[key] ?? 0) < Math.abs(prev.terms?.[key] ?? 0);
    const did = {accepted: 'You approved', won: 'You approved', enacted: 'You approved', compromise: 'You met halfway on', refused: 'You refused', lost: 'You refused',
      deferred: 'You put off', expired: 'You let lapse', delegated: 'A body saw to', budget: 'A body saw to'}[c?.outcome] ?? 'You ruled on';
    // An adviser's answer you let stand reads as theirs.
    const adviser = c?.advisedBy && !c.overruled ? state.advisers?.roster?.find((x) => x.id === c.advisedBy)?.name ?? 'Your adviser' : null;
    const said = adviser ? did.replace(/^You /, `${adviser} `) : did;
    return {ref, text: fading ? `Older rulings fade: ${t}` : `${said}: ${t}`, about: t};
  }
  if (kind === 'life') {
    const [good, bad, about] = LIFE_WORDS[ref] ?? LIFE_WORDS.other;
    return {ref, text: up ? good : bad, about};
  }
  if (kind === 'unrest') return {text: up ? 'Tempers cooling' : 'Anger in the streets', about: 'the unrest'};
  if (kind === 'looks') return {text: up ? 'Finer streets' : 'Shabbier streets', about: 'the look of the streets'};
  if (kind === 'catchup') return {text: up ? 'Earlier good news still sinking in' : 'Earlier troubles still sinking in', about: 'earlier years'};
  if (kind === 'rulings') {
    const who = mostMoved(state, by, up);
    return {text: up ? `Your rulings pleased the ${who ? who.toLowerCase() : 'town'}` : `Your rulings angered the ${who ? who.toLowerCase() : 'town'}`, about: 'your rulings'};
  }
  if (kind === 'displaced') return {text: up ? 'Fewer businesses pushed out' : 'Businesses pushed out of the centre', about: 'businesses pushed out'};
  if (kind === 'events') return {text: up ? 'Good times this year' : 'Hard times this year', about: 'the year\'s troubles'};
  if (kind === 'news') return {text: up ? 'Glad of the year\'s rulings and news' : 'Sore at the year\'s rulings and news', about: 'the year\'s rulings'};
  if (kind === 'reaction') {
    const y = state.time.year - 1;
    const recent = (state.approval?.reactions ?? []).filter((r) => r.y >= y).sort((a, b) => (up ? b.net - a.net : a.net - b.net));
    const r = recent[0];
    const title = r ? lowerFirst(POLICIES[r.policy]?.title ?? r.policy) : null;
    if (!r) return {text: up ? 'Anger over rule changes fading' : 'Rule changes still rankle', about: 'the rule changes'};
    const slice = up ? r.best : r.worst;
    const who = slice?.startsWith('trade=') ? TRADE_GROUP[slice.slice(6)] ?? 'People' : 'People';
    return {ref: r.policy, text: up ? `${who} welcomed ${title}` : `${who} ${r.net < -0.3 ? 'protested at' : 'grumbled at'} ${title}`, about: title};
  }
  if (kind === 'leaving') {
    const by = state.approval?.leavingBy ?? {};
    const band = Object.entries(by).sort((a, b) => b[1] - a[1])[0]?.[0];
    const who = {poor: 'Poor families', middling: 'Middling families', wealthy: 'Wealthy families'}[band] ?? 'Families';
    return {text: up ? 'Fewer families think of leaving' : `${who} think of leaving`, about: 'families leaving'};
  }
  if (kind === 'petitioning') return {text: up ? 'Fewer gather at the hall to be heard' : 'Groups gather at the hall to be heard', about: 'grievances'};
  return {text: key, about: null};
}
