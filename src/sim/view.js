// View models for the UI (contract §5). Pure functions of state: they read,
// never write. The UI calls them (throttled for heavy panels) and renders.

import {monthIndex} from './clock.js';
import {eraProgress, ERA} from './eras.js';
import {
  POLICIES, CATEGORIES, CATEGORY_ERA, levelOf, againstGrain, upkeepFor, detectTensions, tensionText,
} from './policies.js';
import {INSTITUTIONS, METRICS} from './institutions.js';
import {EVENTS} from './events.js';
import {ERA_NAMES, ARCHETYPE_NAMES, seasonOf, coin} from './text/voice.js';
import {previewSummary} from './chronicle.js';
import {seedCode} from './state.js';
import {opinionOf} from './opinion.js';
import {APPROVAL_SHOWN_ERA} from './approval.js';
import {askOf, grantFor, seasonRoom, grantedThisSeason, budgetsUnlocked, BUDGET_CHOICES, SMALL_SHARE} from './budgets.js';
import {AREAS, MODES, areaOf, adviserById, advisersReady, seatCount, standingScore, SEAT_BODIES} from './advisors.js';

const pct = (x) => Math.round((x ?? 0) * 100);
const r1 = (x) => Math.round((x ?? 0) * 10) / 10;

// ---------------------------------------------------------------------------
// Top bar
// ---------------------------------------------------------------------------

export function selectTopBar(state) {
  const I = state.indicators ?? {};
  const history = state.indicatorHistory?.treasury ?? [];
  const lastYear = state.economy?.lastYear ?? {};
  const coinTrend = Math.round((lastYear.treasuryIncome ?? 0) - (lastYear.treasurySpend ?? 0)) ||
    (history.length >= 2 ? Math.round(history.at(-1) - history.at(-2)) : 0);
  return {
    year: state.time.year,
    month: state.time.month,
    season: seasonOf(state.time.month),
    era: state.era ?? 0,
    eraName: ERA_NAMES[state.era ?? 0],
    people: I.pop ?? 0,
    coin: Math.round(state.treasury ?? 0),
    coinTrend,
    food: Math.round(state.food ?? 0),
    foodMonths: r1(I.foodBalance),
    wellbeing: Math.round(I.wellbeing ?? 0),
    ...approvalTop(state),
    archetype: state.archetype,
    archetypeName: ARCHETYPE_NAMES[state.archetype] ?? state.archetype,
    homes: homesOf(state),
    homesWaiting: (state.households ?? []).filter((h) => h.homeId == null).length,
    seed: seedCode(state.seed),
  };
}

// The top bar's approval figure and its change over the last year (whole points).
function approvalTop(state) {
  const a = state.approval;
  if (a?.overall == null) return {approval: null, approvalChange: null};
  const [prev, last] = [(a.history ?? []).at(-2), (a.history ?? []).at(-1)];
  return {approval: pct(a.overall), approvalChange: prev && last?.y === a.year ? pct(a.overall) - pct(prev.all) : null};
}

const homesOf = (state) => (state.buildings ?? []).reduce((n, b) => n + (b.type === 'home' && (b.built ?? 1) >= 1 ? 1 : 0), 0);

// ---------------------------------------------------------------------------
// Docket
// ---------------------------------------------------------------------------

const STANCE_DIR = {for: 2, against: -2, split: 0, indifferent: 0};
// A petition to form a body asks back / oppose rather than for / against.
const STANCE_ALIAS = {back: 'for', oppose: 'against'};
const stanceOf = (s) => STANCE_ALIAS[s?.stance] ?? s?.stance;
const NO_REACTION = new Set(['not_now', 'refuse', 'neither', 'ok', 'negotiate']);

const factionName = (state, id) => state.factions?.find((f) => f.id === id)?.name ?? id;
const bodyName = (state, id) => state.institutions?.find((b) => b.id === id)?.name ?? INSTITUTIONS[id]?.name ?? 'The Moot';

// Faction chips for one option, from the stances cached on the card. In a
// debate each side's option shows how the factions felt about that side's plan.
function reactionsFor(state, card, option) {
  if (NO_REACTION.has(option.key) || card.kind === 'report') return [];
  const stances = (option.side && card.data?.sideStances?.[option.side]) || card.stances || {};
  const rows = Object.entries(stances)
    .map(([faction, s]) => {
      const stance = stanceOf(s);
      let dir = STANCE_DIR[stance] ?? 0;
      if (dir && (s.p ?? 0) < 0.6) dir = Math.sign(dir);
      return {faction, name: factionName(state, faction), dir, stance, p: s.p ?? 0};
    })
    .filter((r) => r.dir !== 0 || r.stance === 'split')
    .sort((a, b) => Math.abs(b.dir) - Math.abs(a.dir) || b.p - a.p || a.faction.localeCompare(b.faction));
  return rows.slice(0, 3);
}

function debateStrip(state, card) {
  const rows = Object.entries(card.stances ?? {}).map(([faction, s]) => ({faction, name: factionName(state, faction), ...s, stance: stanceOf(s)}));
  const split = new Set(state.factions?.filter((f) => f.split).map((f) => f.id));
  return {
    for: rows.filter((r) => r.stance === 'for').sort((a, b) => b.p - a.p).slice(0, 3).map((r) => ({faction: r.faction, name: r.name, p: r.p, split: split.has(r.faction)})),
    against: rows.filter((r) => r.stance === 'against').sort((a, b) => b.p - a.p).slice(0, 3).map((r) => ({faction: r.faction, name: r.name, p: r.p, split: split.has(r.faction)})),
    split: rows.filter((r) => r.stance === 'split').map((r) => r.faction),
  };
}

// Kinds the factions are asked about when drafted (scheduler.cardAdded).
const ASKED_KINDS = new Set(['proposal', 'demand', 'debate', 'petition']);

// The town's rough feeling about a card, from the stances already asked
// (src/sim/opinion.js). A debate also reads each side's plan on its own.
function cardOpinion(state, card) {
  const stances = card.stances ?? {};
  if (card.kind === 'report' || (!ASKED_KINDS.has(card.kind) && !Object.keys(stances).length)) return null;
  const sides = card.kind === 'debate' && card.data?.sideStances
    ? (card.data.sides ?? Object.keys(card.data.sideStances)).map((side) => ({
      side, name: bodyName(state, side), option: card.options.find((o) => o.side === side)?.key ?? null,
      ...opinionOf(state, card.data.sideStances[side] ?? {}),
    }))
    : null;
  return {...opinionOf(state, stances), pending: stancesPending(state, card), sides};
}

// The factions are still being asked about this card (queued or in flight).
const STANCE_KINDS = new Set(['faction_stance', 'institution_form_support']);
function stancesPending(state, card) {
  const gov = state.governance ?? {};
  const mine = (x) => STANCE_KINDS.has(x?.kind) && x.meta?.cardId === card.id;
  return (gov.asks ?? []).some(mine) || (gov.inflight ?? []).some(mine);
}

export function cardView(state, card) {
  const m = monthIndex(state.time);
  const expiresInMonths = card.expiresMonth != null ? Math.max(0, card.expiresMonth - m) : null;
  return {
    id: card.id,
    kind: card.kind,
    from: card.from,
    institution: card.from,
    institutionName: bodyName(state, card.from),
    templateId: card.templateId,
    subjects: card.subjects ?? [],
    category: card.category,
    title: card.title,
    why: card.prose?.why ?? card.why,
    templateWhy: card.why,
    prose: card.prose ?? null,
    needsProse: !!card.needsProse,
    asker: card.asker,
    urgency: card.urgency ?? 0,
    cost: card.cost ?? 0,
    upkeep: card.upkeep ?? 0,
    againstGrain: !!card.againstGrain,
    grainNote: card.againstGrain ? 'This goes against the grain of the town. It will cost more and people will grumble.' : null,
    negotiating: !!card.negotiating,
    options: card.options.map((o) => ({
      key: o.key,
      label: o.label,
      tradeoff: card.prose?.options?.[o.key] ?? o.tradeoff,
      templateTradeoff: o.tradeoff,
      cost: o.cost ?? 0,
      ...(o.upkeep ? {upkeep: o.upkeep} : {}),
      affordable: !(o.cost > 0) || (state.treasury ?? 0) >= o.cost,
      reactions: reactionsFor(state, card, o),
    })),
    details: card.details ?? [],
    debate: card.kind === 'debate' || Object.keys(card.stances ?? {}).length ? debateStrip(state, card) : null,
    opinion: cardOpinion(state, card),
    sides: card.data?.sides ?? null,
    ...(card.kind === 'budget' ? {budget: budgetCardView(state, card)} : {}),
    advice: adviceView(state, card),
    expiresInMonths,
    deadlineYear: card.expiresMonth != null ? Math.floor(card.expiresMonth / 12) : null,
    place: card.data?.x != null ? {x: card.data.x, z: card.data.z} : null,
  };
}

const KIND_ORDER = {event: 0, demand: 1, petition: 2, debate: 3, proposal: 4, budget: 4, report: 5};

// A budget card's figures as they stand (struck lines left out of the ask).
const BUDGET_TRADE = {
  approve: (g) => `Grant ${coin(g)} as asked.`,
  trim90: (g) => `Grant ${coin(g)}. The least needed plan may wait.`,
  trim75: (g) => `Grant ${coin(g)}. Plans drop, least needed first. It will be a little sore.`,
  trim50: (g) => `Grant ${coin(g)}. Most plans wait. It will be sore.`,
  same: (g) => `Grant ${coin(g)}, last year's figure.`,
  refuse: () => 'Grant nothing. Everything it wants comes to you as requests. It will be angry.',
};
function budgetCardView(state, card) {
  const b = card.data.budget;
  const asked = askOf(b);
  const grants = Object.fromEntries(BUDGET_CHOICES.map((k) => [k, grantFor(b, k).granted]));
  const last = b.last.granted;
  return {
    year: b.year, asked, last: {...b.last}, delta: last > 0 ? Math.round(((asked - last) / last) * 100) : null,
    lines: b.lines.map((l) => ({id: l.id, kind: l.kind, label: l.label, cost: l.cost, struck: !!l.struck, askFirst: !!l.askFirst, need: l.need ?? null})),
    grants, small: Math.round(SMALL_SHARE * grants.approve),
    outcomes: (b.outcomes ?? []).map((o) => ({...o})), done: [...(b.done ?? [])], rules: (b.rules ?? []).map((r) => ({...r})),
    tradeoffs: Object.fromEntries(BUDGET_CHOICES.map((k) => [k, BUDGET_TRADE[k](grants[k])])),
  };
}

// The cards awaiting a ruling (surfaced by a session), most urgent first.
export function selectDocket(state) {
  // A demand waiting on the body's answer to an offer stays off the table.
  return state.docket
    .filter((c) => c.surfacedMonth != null && !c.negotiating)
    .sort((a, b) => KIND_ORDER[a.kind] - KIND_ORDER[b.kind] || (b.urgency ?? 0) - (a.urgency ?? 0) ||
      (a.expiresMonth ?? 0) - (b.expiresMonth ?? 0) || a.id.localeCompare(b.id))
    .map((c) => cardView(state, c));
}

export const selectDocketCount = (state) => state.docket.filter((c) => c.surfacedMonth != null && c.kind !== 'report').length;

// ---------------------------------------------------------------------------
// Bodies
// ---------------------------------------------------------------------------

function metricRows(state, body) {
  const def = INSTITUTIONS[body.kind];
  return (def?.metrics ?? []).slice(0, 6).map((id) => {
    const m = METRICS[id];
    const series = Array.isArray(body.metrics?.[id]) ? body.metrics[id].slice(-60) : [];
    const value = body.status === 'waning' && series.length ? series.at(-1) : m.read(state);
    const prev = series.length >= 5 ? series.at(-5) : series[0] ?? value;
    return {id, label: m.label, unit: m.unit, value, series, delta: Math.round((value - prev) * 100) / 100};
  });
}

function bodyRules(state, body) {
  return Object.entries(state.policies ?? {})
    .filter(([id, p]) => p.level > 0 && POLICIES[id] && (p.by === body.id || (POLICIES[id].by?.includes(body.kind) && body.kind !== 'moot')))
    .map(([id, p]) => ({id, title: POLICIES[id].title, summary: POLICIES[id].summary, level: p.level, since: p.since}));
}

export function selectBodies(state) {
  return (state.institutions ?? [])
    .filter((b) => b.status !== 'dissolved')
    .map((b) => {
      const def = INSTITUTIONS[b.kind] ?? {};
      const docket = state.docket.filter((c) => c.surfacedMonth != null && (c.from === b.id || c.data?.sides?.includes(b.id)));
      const rules = bodyRules(state, b);
      return {
        id: b.id,
        kind: b.kind,
        name: b.name,
        icon: def.icon ?? 'hall',
        founded: b.foundedYear,
        status: b.status,
        power: Math.round((b.power ?? 0) * 100) / 100,
        patience: Math.round((b.patience ?? 0) * 100) / 100,
        demanding: (b.power ?? 0) >= 0.7 && b.kind !== 'moot',
        area: areaOf(b.kind),
        budgetShare: b.budgetShare ?? 0,
        funds: Math.round(b.funds ?? 0),
        asker: b.asker,
        explainer: def.explainer ?? '',
        metrics: metricRows(state, b),
        docket: docket.map((c) => cardView(state, c)),
        docketCount: docket.filter((c) => c.kind !== 'report').length,
        rules,
        policies: rules,
        rivals: def.rivals ?? [],
        budget: bodyBudget(b),
      };
    });
}

// ---------------------------------------------------------------------------
// Advisers (advisors.js)
// ---------------------------------------------------------------------------

const CHOICE_WORD = {approve: 'approve', trim90: 'trim to 90%', trim75: 'trim to 75%', trim50: 'cut to half', trim: 'trim to fit', same: 'keep last year\'s figure', refuse: 'refuse'};

// The staged (or recommended) answer on a card: who, what, why, when.
function adviceView(state, card) {
  const adv = card.advice;
  if (!adv) return null;
  const adviser = adviserById(state, adv.adviserId);
  if (!adviser) return null;
  const option = card.options.find((o) => o.key === adv.option);
  const verb = card.kind === 'budget' ? CHOICE_WORD[adv.option] ?? adv.option
    : MINOR_VERB[adv.option] ?? `choose "${option?.label ?? adv.option}"`;
  return {
    adviserId: adviser.id, name: adviser.name, option: adv.option, optionLabel: option?.label ?? CHOICE_WORD[adv.option] ?? adv.option,
    verb, factor: adv.factor ?? null, act: !!adv.act,
    inMonths: Math.max(0, adv.dueMonth - monthIndex(state.time)),
    rationale: (adv.rationale ?? []).map((r) => r.text),
  };
}
const MINOR_VERB = {not_now: 'put it off', refuse: 'refuse it', refuse_anyway: 'refuse it', neither: 'back neither side', negotiate: 'offer to negotiate'};

// The bench: seats, their advisers, the slate, and the answers waiting for your review.
export function selectAdvisers(state) {
  const a = state.advisers;
  if (!a || !advisersReady(state) || !a.seats?.length) return null;
  const sitting = (state.institutions ?? []).filter((b) => b.kind !== 'moot' && b.status === 'active');
  const staged = state.docket.filter((c) => c.advice?.act && c.surfacedMonth != null);
  const m = monthIndex(state.time);
  const person = (x) => ({
    id: x.id, name: x.name, background: x.background.label, trade: x.background.trade,
    beliefs: {...x.beliefs}, issues: x.issues.map((i) => ({policy: i.policy, stance: i.stance, title: POLICIES[i.policy]?.title ?? i.policy})),
    temper: x.temper, salary: Math.round(x.salary), chips: beliefChips(x),
  });
  const seats = a.seats.map((s) => {
    const x = s.adviserId ? adviserById(state, s.adviserId) : null;
    const bodies = s.area ? sitting.filter((b) => areaOf(b.kind) === s.area).map((b) => ({id: b.id, name: b.name})) : [];
    return {
      id: s.id, area: s.area, areaName: s.area ? AREAS[s.area].name : null, mode: s.mode, bodies,
      adviser: x ? {
        ...person(x), hiredYear: x.hiredYear, years: state.time.year - x.hiredYear,
        answered: x.stats.answered, changed: x.stats.changed, stood: x.stats.stood, spent: Math.round(x.stats.spent),
        overruled: x.stats.answered ? Math.round((x.stats.changed / x.stats.answered) * 100) : 0,
        standing: standingScore(state, x), history: x.stats.byYear.slice(-12).map((y) => ({y: y.y, v: y.standing})),
        waiting: staged.filter((c) => c.advice.adviserId === x.id).map((c) => ({id: c.id, title: c.kind === 'budget' ? `${bodyName(state, c.from)}: budget` : askTitle(c),
          verb: adviceView(state, c)?.verb ?? '', inMonths: Math.max(0, c.advice.dueMonth - m)})),
        recent: (state.cardHistory ?? []).filter((h) => h.advisedBy === x.id).slice(-5).reverse()
          .map((h) => ({title: h.kind === 'budget' ? `${bodyName(state, h.from)}: budget` : h.ask ?? h.title, changed: !!h.overruled, choice: h.label ?? h.choice})),
      } : null,
    };
  });
  const taken = new Set(a.seats.filter((s) => s.adviserId).map((s) => s.area));
  const slate = a.slate ? {
    seatId: a.slate.seatId, year: a.slate.year, canRedraw: a.redrawYear !== state.time.year,
    areas: Object.keys(AREAS).filter((k) => !taken.has(k)).map((k) => ({id: k, name: AREAS[k].name,
      bodies: sitting.filter((b) => areaOf(b.kind) === k).map((b) => b.name)})),
    candidates: a.slate.candidates.map(person),
  } : null;
  const total = seatCount(state);
  const n = sitting.length;
  const next = total >= 3 ? null : total === 1 ? `A second seat opens at ${SEAT_BODIES[1]} sitting bodies (now ${n}) or as a metropolis.` : `A third seat opens in a metropolis with ${SEAT_BODIES[2]} sitting bodies.`;
  return {seats, slate, staged: staged.length, next, modes: MODES, gone: a.roster.filter((x) => x.leftYear != null).slice(-3).map((x) => ({name: x.name, why: x.leftWhy, year: x.leftYear}))};
}

// A card's name for lists: a "Which first?" card by its two plans.
const askTitle = (c) => (c.data?.batch?.length === 2 ? `${c.data.batch[0].title} or ${c.data.batch[1].title.toLowerCase()}` : c.title);

// Short words for an adviser's beliefs (§4.2's chips).
function beliefChips(x) {
  const b = x.beliefs, out = [];
  if (b.authority >= 0.4) out.push('For planning');
  else if (b.authority <= -0.4) out.push('For freedom');
  if (b.innovation >= 0.4) out.push('New ways'); else if (b.innovation <= -0.4) out.push('Old ways');
  if (b.market >= 0.4) out.push('Markets'); else if (b.market <= -0.4) out.push('Commons');
  if (b.industry >= 0.4) out.push('Industry'); else if (b.industry <= -0.4) out.push('Fields');
  if (b.faith <= -0.4) out.push('Cool on the chapel'); else if (b.faith >= 0.4) out.push('Devout');
  if (b.thrift >= 0.4) out.push('Careful with coin'); else if (b.thrift <= -0.3) out.push('Spend it on people');
  for (const i of x.issues) out.push(`${i.stance > 0 ? 'For' : 'Against'} ${(POLICIES[i.policy]?.title ?? i.policy).replace(/^(A|An|The) /, '').toLowerCase()}`);
  out.push(x.temper);
  return out;
}

// A body's yearly budget (budgets.js), when it has one.
function bodyBudget(b) {
  const bud = b.budget;
  if (bud?.mode !== 'annual') return null;
  const spent = bud.spent ?? {};
  return {
    year: bud.year, asked: Math.round(bud.asked ?? 0), granted: Math.round(bud.granted ?? 0), choice: bud.choice,
    spent: {running: Math.round(spent.running ?? 0), plans: Math.round(spent.plans ?? 0), other: Math.round(spent.other ?? 0)},
    lines: (bud.lines ?? []).filter((l) => l.kind === 'plan').map((l) => ({label: l.label, cost: l.cost, started: !!l.started})),
    history: (bud.history ?? []).slice(-5).map((h) => ({y: h.y, granted: h.granted, spent: h.spent})),
    next: bud.next ? {year: bud.next.year, granted: Math.round(bud.next.granted)} : null,
  };
}

// The budget season (months 9-11): every body's ask against the town's room.
export function selectBudgetSeason(state) {
  const season = state.governance?.budgets?.season;
  if (!season) return null;
  const open = state.docket.filter((c) => c.kind === 'budget');
  if (!open.length && state.time.year >= season.year) return null;
  const rows = [];
  for (const b of state.institutions ?? []) {
    const card = open.find((c) => c.from === b.id);
    const next = b.budget?.next?.year === season.year ? b.budget.next : null;
    if (!card && !next) continue;
    const asked = card ? askOf(card.data.budget) : Math.round(next.asked);
    const last = card ? card.data.budget.last.granted : Math.round(b.budget?.granted ?? 0);
    rows.push({id: b.id, name: b.name, cardId: card?.id ?? null, asked, last, delta: last > 0 ? Math.round(((asked - last) / last) * 100) : null,
      answered: !card, granted: next ? Math.round(next.granted) : null, choice: next?.choice ?? null});
  }
  rows.sort((a, b) => Number(a.answered) - Number(b.answered) || b.asked - a.asked || a.id.localeCompare(b.id));
  const asked = rows.filter((r) => !r.answered).reduce((n, r) => n + r.asked, 0);
  const granted = grantedThisSeason(state);
  const room = seasonRoom(state);
  // What the advisers will answer (design §4.7: "Edda: approve 3, trim 1").
  const byAdviser = new Map();
  for (const c of open) {
    if (!c.advice?.act) continue;
    const name = adviserById(state, c.advice.adviserId)?.name;
    if (!name) continue;
    const word = {approve: 'approve', trim90: 'trim', trim75: 'trim', trim50: 'cut', trim: 'trim', same: 'keep', refuse: 'refuse'}[c.advice.option] ?? c.advice.option;
    const row = byAdviser.get(name) ?? {};
    row[word] = (row[word] ?? 0) + 1;
    byAdviser.set(name, row);
  }
  return {
    advisers: [...byAdviser].map(([name, row]) => `${name}: ${Object.entries(row).map(([w, n]) => `${w} ${n}`).join(', ')}`),
    year: season.year, total: rows.length, open: open.length, answered: rows.length - open.length,
    asked, granted, room, left: Math.max(0, room - granted), chest: Math.round(state.treasury ?? 0),
    over: Math.max(0, Math.round(asked + granted - room)), rows,
  };
}

// ---------------------------------------------------------------------------
// The Rule Book
// ---------------------------------------------------------------------------

export function selectRuleBook(state) {
  const tensions = detectTensions(state);
  const era = state.era ?? 0;
  return CATEGORIES.map((cat) => ({
    id: cat.id,
    title: cat.title,
    blurb: cat.blurb,
    // A category opens with its era, or as soon as any of its rules is in
    // force, since a rule adopted early must still be visible in the book.
    open: era >= (CATEGORY_ERA[cat.id] ?? 0)
      || Object.values(POLICIES).some((p) => p.category === cat.id && levelOf(state, p.id) > 0),
    policies: Object.values(POLICIES)
      .filter((p) => p.category === cat.id)
      .map((p) => {
        const rec = state.policies?.[p.id];
        const level = levelOf(state, p.id);
        return {
          id: p.id,
          title: p.title,
          summary: p.summary,
          level,
          maxLevel: p.maxLevel,
          levelName: level > 0 ? p.levelNames[level - 1] : null,
          since: rec?.since ?? null,
          by: rec?.by ?? null,
          byName: rec?.by && rec.by !== 'player' ? (String(rec.by).startsWith('adviser:') ? adviserById(state, rec.by.slice(8))?.name ?? 'An adviser' : bodyName(state, rec.by)) : null,
          upkeep: level > 0 ? upkeepFor(state, p.id, level) : 0,
          tensions: tensions.filter((t) => t.left === p.id || t.right === p.id).map((t) => (t.left === p.id ? t.right : t.left)),
          againstGrain: level > 0 && againstGrain(state, p.id, level).against,
        };
      }),
  }));
}

// ---------------------------------------------------------------------------
// Tensions: rules that pull against each other, and torn streets
// ---------------------------------------------------------------------------

function backers(state, policyId) {
  const def = POLICIES[policyId];
  return (state.factions ?? []).filter((f) => f.size > 0 && def.helps?.some((t) => f.trades?.includes(t))).map((f) => f.name);
}

const DIM_WORDS = {
  wealthBand: {poor: 'Poor', middling: 'Middling', wealthy: 'Wealthy'},
  trade: {farm: 'farm', craft: 'maker', trade: 'merchant', labour: 'labouring', clerical: 'clerk', clergy: 'clergy', gentry: 'gentry', none: 'idle'},
  lifeStage: {young: 'young', family: 'family', elder: 'elderly'},
};

function tornText(key) {
  const parts = Object.fromEntries(key.split('|').map((p) => p.split('=')));
  const who = [parts.wealthBand && DIM_WORDS.wealthBand[parts.wealthBand], parts.trade && DIM_WORDS.trade[parts.trade],
    parts.lifeStage && DIM_WORDS.lifeStage[parts.lifeStage], 'families'].filter(Boolean).join(' ');
  const where = parts.district ? ` in ${parts.district}` : '';
  const first = who.charAt(0).toUpperCase() + who.slice(1);
  const dims = Object.keys(parts);
  const a = dims[0] === 'district' ? 'street' : dims[0] === 'wealthBand' ? 'purse' : dims[0];
  const b = dims[1] === 'district' ? 'street' : dims[1] === 'wealthBand' ? 'purse' : dims[1];
  return `${first}${where} are torn. Their ${a} and their ${b} point different ways.`;
}

export function selectTensions(state) {
  const rules = detectTensions(state).map((t) => ({
    id: t.id,
    type: 'rules',
    reason: t.why,
    left: {id: t.left, title: POLICIES[t.left].title, backers: backers(state, t.left)},
    right: {id: t.right, title: POLICIES[t.right].title, backers: backers(state, t.right)},
    text: tensionText(t),
    upkeep: upkeepFor(state, t.left) + upkeepFor(state, t.right),
  }));
  const torn = [];
  for (const [kind, rows] of Object.entries(state.disagreement ?? {})) {
    for (const [key, row] of Object.entries(rows)) {
      if (row.D < 0.25) continue;
      torn.push({id: `${kind}:${key}`, type: 'torn', kind, key, D: row.D, n: row.n, text: tornText(key)});
    }
  }
  torn.sort((a, b) => b.D * b.n - a.D * a.n || a.id.localeCompare(b.id));
  return {rules, torn: torn.slice(0, 5), tension: state.indicators?.tension ?? 0};
}

// ---------------------------------------------------------------------------
// Factions, chronicle, era progress
// ---------------------------------------------------------------------------

export function selectFactions(state) {
  return (state.factions ?? [])
    .filter((f) => f.size > 0)
    .map((f) => ({id: f.id, name: f.name, size: f.size, households: f.households ?? 0,
      mood: Math.round((f.mood ?? 0) * 100) / 100, trend: f.trend ?? 0, split: !!f.split,
      approval: state.approval?.rows?.faction?.[f.id] ? pct(state.approval.rows.faction[f.id].v) : null,
      parent: f.parent ?? null, parentName: f.parent ? factionName(state, f.parent) : null}))
    .sort((a, b) => b.size - a.size || a.id.localeCompare(b.id));
}

// ---------------------------------------------------------------------------
// Approval (src/sim/approval.js): the figure, its history, who approves and why
// it moved. Percentages are whole numbers.
// ---------------------------------------------------------------------------

const APPROVAL_TABS = [
  ['faction', 'Groups'], ['wealthBand', 'Wealth'], ['district', 'Districts'], ['centre', 'Places'], ['lifeStage', 'Ages'], ['faithBand', 'Faith'],
];
const APPROVAL_NAMES = {
  wealthBand: {poor: 'Poor', middling: 'Middling', wealthy: 'Wealthy'},
  lifeStage: {young: 'Young households', family: 'Families', elder: 'Elders'},
  faithBand: {low: 'Seldom at chapel', mid: 'Some faith', high: 'Devout'},
  newcomer: {yes: 'Newcomers', no: 'Settled families'},
};
const APPROVAL_ROWS = 8;

export function selectApproval(state) {
  const a = state.approval;
  if (a?.overall == null) return null;
  const top = approvalTop(state);
  const tabs = [];
  for (const [dim, label] of APPROVAL_TABS) {
    const rows = Object.entries(a.rows?.[dim] ?? {}).filter(([, r]) => r.n > 0)
      .map(([id, r]) => ({id, name: dim === 'faction' ? factionName(state, id) : APPROVAL_NAMES[dim]?.[id] ?? id, value: pct(r.v), people: r.n}))
      .sort((x, y) => y.people - x.people || x.id.localeCompare(y.id));
    if (rows.length < 2) continue;
    const total = rows.reduce((n, r) => n + r.people, 0) || 1;
    tabs.push({id: dim, label, more: Math.max(0, rows.length - APPROVAL_ROWS),
      rows: rows.slice(0, APPROVAL_ROWS).map((r) => ({...r, share: Math.round((r.people / total) * 1000) / 1000}))});
  }
  return {
    year: a.year,
    value: top.approval,
    change: top.approvalChange,
    strongAgainst: pct(a.strongAgainst),
    history: (a.history ?? []).map((h) => ({y: h.y, v: pct(h.all)})),
    tabs,
    drivers: (a.drivers ?? []).map((d) => ({text: d.text, kind: d.kind, points: Math.sign(d.points) * Math.max(1, Math.round(Math.abs(d.points)))})),
  };
}

export function selectChronicle(state, {limit = 60, kinds = null} = {}) {
  const entries = state.chronicle?.entries ?? [];
  const out = [];
  const ids = entryIds(entries);
  for (let i = entries.length - 1; i >= 0 && out.length < limit; i--) {
    const e = entries[i];
    if (kinds && !kinds.includes(e.kind)) continue;
    out.push({id: ids[i], year: e.year, month: e.month ?? 0, season: seasonOf(e.month ?? 0),
      text: e.prose?.text ?? e.text, templateText: e.text, needsProse: !!e.needsProse,
      kind: e.kind === 'year' ? 'line' : e.kind, era: e.era ?? 0, yearEnd: e.kind === 'year',
      refs: e.refs ?? null, centreId: e.refs?.centreId ?? e.refs?.centre ?? null,
      centreName: centreNameOf(state, e.refs?.centreId ?? e.refs?.centre)});
  }
  return out.reverse();
}

const centreNameOf = (state, id) => (id == null ? null : (state.centres ?? []).find((c) => c.id === id)?.name ?? null);

// Ids for entries written without one: a content hash, with a count when the
// same line appears twice in a month. Cached per entries array and length.
const idCache = new WeakMap();
function entryIds(entries) {
  const cached = idCache.get(entries);
  if (cached?.length === entries.length && cached.first === entries[0]) return cached.ids;
  const seen = new Map();
  const ids = entries.map((e) => {
    if (e.id) return e.id;
    let h = 2166136261;
    const t = `${e.year}:${e.month}:${e.kind}:${e.text}`;
    for (let i = 0; i < t.length; i++) h = Math.imul(h ^ t.charCodeAt(i), 16777619) >>> 0;
    const base = `cx${h.toString(36)}`;
    const n = (seen.get(base) ?? 0) + 1;
    seen.set(base, n);
    return n > 1 ? `${base}-${n}` : base;
  });
  idCache.set(entries, {length: entries.length, first: entries[0], ids});
  return ids;
}

export function selectEraProgress(state) {
  const p = eraProgress(state);
  const def = ERA[state.era ?? 0];
  const entered = state.eraEntered?.[state.era ?? 0] ?? 0;
  const span = p.next != null && p.ceiling != null ? Math.max(1, p.ceiling - entered) : 1;
  return {
    era: state.era ?? 0,
    eraName: def?.name ?? ERA_NAMES[state.era ?? 0],
    next: p.next,
    nextName: p.name,
    yearsToFloor: p.yearsToFloor ?? 0,
    yearsToCeiling: p.yearsToCeiling ?? 0,
    yearT: p.next != null ? Math.max(0, Math.min(1, (state.time.year - entered) / span)) : 1,
    conditions: (p.checks ?? []).map((c) => ({label: c.label, met: !!c.met, progress: Math.round(Math.max(0, Math.min(1, c.progress ?? 0)) * 100) / 100})),
  };
}

// The valley's centres for the Places view (design-centres §7).
const CENTRE_KIND_NAMES = {hamlet: 'hamlet', village: 'village', town: 'town', borough: 'borough', city: 'city'};
export function selectCentres(state) {
  const centres = state.centres ?? [];
  const live = centres.filter((c) => c.mergedInto == null);
  const rows = centres.map((c, i) => {
    const ward = (state.institutions ?? []).find((b) => b.kind === 'ward' && b.centreId === c.id && b.status !== 'dissolved');
    return {
      id: c.id, name: c.name, kind: CENTRE_KIND_NAMES[c.kind] ?? 'hamlet', seat: i === 0,
      pop: c.monthly?.pop ?? c.pop ?? 0, popSeries: (c.popSeries ?? c.history?.pop ?? []).slice(-60),
      character: c.character ?? state.archetype, characterName: ARCHETYPE_NAMES[c.character ?? state.archetype] ?? c.character,
      autonomy: c.autonomy ?? 0, rank: c.rank ?? i + 1, x: c.x, z: c.z,
      bodyId: ward?.id ?? null, mergedInto: c.mergedInto ?? null, federated: !!c.federated,
    };
  });
  return {region: {people: state.indicators?.pop ?? 0, centres: live.length}, centres: rows};
}

// Which surfaces the UI shows (design-systems §2 'UI surfaces', §9.2).
export function selectUnlocks(state) {
  const era = state.era ?? 0;
  const bodies = (state.institutions ?? []).filter((b) => b.status === 'active').length;
  return {
    chronicle: true,
    docket: true,
    ruleBook: era >= 1 || Object.keys(state.policies ?? {}).length > 1,
    ruleCategories: CATEGORIES.filter((c) => era >= (CATEGORY_ERA[c.id] ?? 0)).map((c) => c.id),
    people: era >= 1,
    bodies: era >= 2 || bodies >= 2,
    bodyTabs: bodies >= 2,
    overlays: era >= 2,
    debates: era >= 3 || state.docket.some((c) => c.kind === 'debate'),
    tensions: era >= 3,
    approval: era >= APPROVAL_SHOWN_ERA && state.approval?.overall != null,
    tensionsDashboard: era >= 4,
    budget: era >= 4,
    budgets: budgetsUnlocked(state),
    budgetSeason: state.docket.some((c) => c.kind === 'budget'),
    advisers: advisersReady(state) && (state.advisers?.seats?.length ?? 0) > 0,
    compass: era >= 4,
    endPreview: era >= 5 || state.time.year >= 140,
    endPage: !!state.chronicle?.summary,
    places: (state.centres ?? []).filter((c) => c.mergedInto == null).length >= 2,
  };
}

// ---------------------------------------------------------------------------
// Inspect a building or a person
// ---------------------------------------------------------------------------

const TYPE_NAMES = {
  home: 'Home', farm: 'Farm', workshop: 'Workshop', mill: 'Mill', shop: 'Shop', market: 'Market', inn: 'Inn',
  warehouse: 'Warehouse', chapel: 'Chapel', school: 'School', moot: 'Moot hall', park: 'Park', infirmary: 'Infirmary',
  watch: 'Watch house', exchange: 'Exchange', theatre: 'Playhouse', factory: 'Factory', quay: 'Quay', bridge: 'Bridge',
  monument: 'Monument', 'union-hall': 'Union hall', library: 'Library', bathhouse: 'Bathhouse',
};

const conditionWord = (c) => (c >= 0.8 ? 'Well kept' : c >= 0.5 ? 'Worn' : c >= 0.25 ? 'Shabby' : 'Falling down');
const TASK_WORDS = {work: 'Working', rest: 'Resting', shop: 'Shopping', leisure: 'Taking it easy', worship: 'At prayer',
  gather: 'In the crowd', build: 'Building', flee: 'Fleeing', travel: 'On the road'};

export function selectInspect(state, {buildingId, personId} = {}) {
  if (buildingId != null) {
    const b = state.buildings.find((x) => x.id === buildingId);
    if (!b) return null;
    const owner = b.ownerHouseholdId != null ? state.households.find((h) => h.id === b.ownerHouseholdId) : null;
    const residents = state.households.filter((h) => h.homeId === b.id);
    const ent = state.enterprises.find((e) => e.buildingId === b.id);
    const district = state.districts?.find((d) => d.id === b.districtId);
    const rows = [
      {label: 'Built', value: b.built >= 1 ? `${Math.round(b.age ?? 0)} years ago` : `${Math.round((b.built ?? 0) * 100)} in 100 done`},
      {label: 'State', value: conditionWord(b.condition ?? 1)},
    ];
    if (residents.length) rows.push({label: 'Lives here', value: `${residents.reduce((n, h) => n + h.size, 0)} people`});
    if (ent) rows.push({label: 'Work', value: `${ent.filled ?? 0} of ${ent.jobs} jobs filled`});
    if (owner) rows.push({label: 'Owner', value: `A ${owner.trade === 'none' ? 'family' : `${owner.trade} family`}`});
    if (district) rows.push({label: 'Quarter', value: district.name});
    return {
      kind: 'building', id: b.id, type: b.type, title: TYPE_NAMES[b.type] ?? b.type, variant: b.variant,
      tier: b.tier, storeys: b.storeys, rows: rows.slice(0, 6), banner: b.banner ?? null,
      flags: b.flags ?? {}, x: b.x, z: b.z,
    };
  }
  if (personId != null) {
    const p = state.people.find((x) => x.id === personId);
    if (!p) return null;
    const h = state.households.find((x) => x.id === p.householdId);
    const faction = h ? state.factions.find((f) => f.trades?.includes(h.trade)) : null;
    const task = typeof p.task === 'string' ? p.task : p.task?.kind;
    return {
      kind: 'person', id: p.id, title: h ? `A ${h.trade === 'none' ? 'neighbour' : `${h.trade} worker`}` : 'A neighbour',
      rows: [
        {label: 'Doing', value: TASK_WORDS[task] ?? 'Walking'},
        ...(h ? [{label: 'Household', value: `${h.size} people`}, {label: 'Savings', value: coin(h.savings ?? 0)}] : []),
        ...(faction ? [{label: 'Mood of their kind', value: moodWord(faction.mood)}] : []),
      ],
      needs: p.needs ?? null, x: p.x, z: p.z,
      objective: objectiveOf(state, p),
    };
  }
  return null;
}

// What a walker is up to, in a few plain words: on the way, or there.
// {text, moving, placeId}; placeId is the building it is going to or at.
const EVENT_WORDS = {market: 'the market', festival: 'the festival', protest: 'the protest', wedding: 'a wedding',
  funeral: 'a funeral', strike: 'the strike', procession: 'the procession'};
function objectiveOf(state, p) {
  const t = p.task;
  if (!t || typeof t !== 'object') return {text: 'Standing about', moving: false, placeId: null};
  const b = t.targetType === 'building' && t.targetId != null ? state.buildings.find((x) => x.id === t.targetId) : null;
  const home = b && b.id === p.homeId;
  const name = b ? `the ${(TYPE_NAMES[b.variant] ?? TYPE_NAMES[b.type] ?? String(b.variant || b.type || 'building').replace(/-/g, ' ')).toLowerCase()}` : null;
  const event = t.eventKind ? EVENT_WORDS[t.eventKind] ?? `the ${t.eventKind}` : null;
  const arrived = (t.dwell ?? 0) > 0 || (!t.waiting && (t.route?.length ?? 0) > 0 && t.seg >= t.route.length);
  const moving = !arrived;
  const placeId = b?.id ?? null;
  const say = (going, there) => ({text: moving ? going : there, moving, placeId});
  if (t.waiting && !arrived) return {text: home ? 'Setting off home' : name ? `Setting off for ${name}` : 'Setting off', moving: true, placeId};
  switch (t.kind) {
    case 'work': return name ? say(`On the way to work at ${name}`, `Working at ${name}`) : say('On the way to work', 'At work');
    case 'rest': return home || !name ? say('Heading home', 'Resting at home') : say(`Heading to ${name} for a rest`, `Resting at ${name}`);
    case 'shop': return name ? say(`Off to ${name}`, `Shopping at ${name}`) : say('Going shopping', 'Shopping');
    case 'worship': return name ? say(`On the way to ${name}`, `At prayer in ${name}`) : say('On the way to prayer', 'At prayer');
    case 'leisure':
      if (t.seat) return say(`Off for a sit ${name ? `by ${name}` : ''}`.trim(), t.seat.bench ? `Sitting on a bench ${name ? `by ${name}` : ''}`.trim() : `Sitting on the grass ${name ? `by ${name}` : ''}`.trim());
      return name ? say(`Off to ${name} to take it easy`, `Taking it easy at ${name}`) : say('Out for a stroll', 'Taking in the air');
    case 'gather': return say(`Joining ${event ?? 'the crowd'}`, `In the crowd at ${event ?? 'the gathering'}`);
    case 'build': return say('Off to the building work', 'Building');
    case 'flee': return say('Running for home', 'Sheltering at home');
    case 'travel': return say('On the road', 'On the road');
    default: return say(name ? `Walking to ${name}` : 'Walking', name ? `At ${name}` : 'Standing about');
  }
}

const moodWord = (m) => (m < 0.35 ? 'Angry' : m < 0.55 ? 'Uneasy' : m < 0.75 ? 'Content' : 'Glad');

// ---------------------------------------------------------------------------
// Extras for later eras
// ---------------------------------------------------------------------------

// The four-axis compass (era 4+): today's traits and the path so far.
export function selectCompass(state) {
  return {now: {...state.traits}, path: state.governance?.traitPath ?? []};
}

// Budget sheet (era 4+): last year's money in and out, by account.
export function selectBudget(state) {
  const ly = state.economy?.lastYear ?? {};
  return {
    income: {tax: Math.round(state.budget?.income?.tax ?? 0), tolls: Math.round(state.budget?.income?.tolls ?? 0), total: Math.round(ly.treasuryIncome ?? 0)},
    spend: {
      rules: Math.round(state.budget?.spend?.policies ?? 0),
      bodies: Object.entries(state.budget?.spend?.bodies ?? {}).map(([id, n]) => ({id, name: bodyName(state, id), coin: Math.round(n)})),
      total: Math.round(ly.treasurySpend ?? 0),
    },
    // Bodies on yearly budgets: this year's grant and what they have spent of it.
    budgets: (state.institutions ?? []).filter((b) => b.budget?.mode === 'annual' && b.status !== 'dissolved').map((b) => ({
      id: b.id, name: b.name, granted: Math.round(b.budget.granted ?? 0),
      spent: Math.round((b.budget.spent?.running ?? 0) + (b.budget.spent?.plans ?? 0) + (b.budget.spent?.other ?? 0)),
    })),
  };
}

export const selectEndPreview = (state) => state.chronicle?.summary ?? previewSummary(state);

// Live events; titleCard marks the ones that deserve a moment card.
export const selectEvents = (state) => (state.events?.active ?? [])
  .filter((a) => EVENTS[a.event] && !a.mods)
  .map((a) => ({id: a.id, event: a.event, title: EVENTS[a.event].title, icon: EVENTS[a.event].icon,
    titleCard: !!EVENTS[a.event].titleCard, startedMonth: a.startedMonth}));

export const TITLE_CARD_EVENTS = Object.keys(EVENTS).filter((id) => EVENTS[id].titleCard);

