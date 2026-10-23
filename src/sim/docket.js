// The docket: cards that need the player's ruling (design-systems §9.1).
//
// Card = {id, kind: 'proposal'|'petition'|'event'|'demand'|'debate'|'report',
//   from, templateId, category, title, why, asker: {name, role}, urgency 0..2,
//   createdMonth, surfacedMonth|null, expiresMonth|null, options: [{key, label,
//   tradeoff, cost, upkeep?, effects}], stances: {factionId: {stance, p}},
//   cost, helps, hurts, data, details}
//
// Cards wait in a queue until a quarterly session surfaces them, up to a cap
// per session and per year that grows with the era. Events and demands are
// urgent and surface at once. Surfaced cards last two years.

import {monthIndex} from './clock.js';
import {setTag} from './state.js';
import {delta} from './pressures.js';
import {invalidateCtx} from './conditions.js';
import {POLICIES, TRAITS, ONE_OFF_TRAIT_SCALE, adoptPolicy, levelOf, costScale, fiscalBase} from './policies.js';
import {nudgeMood} from './factions.js';
import {fill, coin, LINES} from './text/voice.js';
import {addChronicle} from './chronicle.js';
const chronicle = addChronicle;
import * as bodies from './institutions.js';
import * as events from './events.js';
import {startWork as startWorldWork, executeWork} from './works.js';
import {pay, payBuilders, takeLoan as economyLoan} from './economy.js';
import {requestBuilding as worldRequestBuilding} from './buildings.js';
import {cardAdded, policyChanged, negotiationRequested} from './decisions/scheduler.js';
import {deriveSubjects, subjectsOf, subjectOpen, subjectInFlight, subjectCooling} from './subjects.js';
import * as budgets from './budgets.js';
import * as advisers from './advisors.js';

export const SESSION_CAP = [1, 1, 2, 2, 2, 3];
export const YEAR_CAP = [2, 3, 3, 4, 4, 4];   // design-systems §9.1
export const CARD_LIFE_MONTHS = 24;
const URGENT = new Set(['event', 'demand']);
const BUTTONS = {not_now: 'Not now', refuse: 'Refuse'};

// ---------------------------------------------------------------------------
// Making and adding cards
// ---------------------------------------------------------------------------

export function makeCard(state, fields) {
  const g = state.governance;
  const card = {
    id: `c${g.nextCardId++}`,
    kind: 'proposal', from: 'moot', templateId: null, category: 'civic',
    title: '', why: '', asker: {name: '', role: ''}, urgency: 0,
    createdMonth: monthIndex(state.time), surfacedMonth: null, expiresMonth: null,
    options: [], stances: {}, cost: 0, helps: [], hurts: [], data: {}, details: [],
    needsProse: true, prose: null,
    ...fields,
  };
  card.options = finishOptions(state, card);
  // What the card is about, so no one asks it again while it is open, under way or settled lately.
  card.subjects = fields.subjects ?? deriveSubjects(card, bodies.bodyOf(state, card.from)?.centreId ?? null);
  return card;
}

// Proposals get Not now / Refuse. Demands lose Refuse and gain Negotiate.
// (Bodies spend their own money through their budgets, not "Let them decide".)
function finishOptions(state, card) {
  const options = card.options.map((o) => ({cost: 0, effects: [], ...o}));
  const keys = new Set(options.map((o) => o.key));
  if (card.kind === 'proposal') {
    if (!keys.has('not_now')) options.push({key: 'not_now', label: BUTTONS.not_now, tradeoff: 'They will ask again later.', cost: 0, effects: []});
    if (!keys.has('refuse')) options.push({key: 'refuse', label: BUTTONS.refuse, tradeoff: 'They will not like it.', cost: 0, effects: []});
  }
  if (card.kind === 'demand') {
    const kept = options.filter((o) => o.key !== 'refuse' && o.key !== 'not_now');
    if (!kept.some((o) => o.key === 'negotiate')) {
      kept.push({key: 'negotiate', label: 'Negotiate', tradeoff: 'Offer half. They may take it, or insist.', cost: 0, effects: []});
    }
    return kept;
  }
  return options;
}

export const cardsFrom = (state, bodyId) => state.docket.filter((c) => c.from === bodyId || c.data?.sides?.includes(bodyId));
export const surfacedCards = (state) => state.docket.filter((c) => c.surfacedMonth != null);
export const queuedCards = (state) => state.docket.filter((c) => c.surfacedMonth == null);

// Only faction complaints share a ruling. Body-formation petitions have their
// own choices and must remain separate even when they are filed together.
const grievanceOf = (card) => card.kind === 'petition' && !card.data?.forms && !card.data?.revive &&
  card.data?.grievance && card.templateId === `grievance:${card.data.grievance}` ? card.data.grievance : null;

function petitionersOf(state, card) {
  if (card.data?.petitioners?.length) return card.data.petitioners;
  const faction = card.data?.faction;
  if (!faction) return [];
  const name = card.data.groupName ?? card.title?.replace(/ petition the council(?: again)?$/i, '') ??
    `The ${state.factions.find((f) => f.id === faction)?.name.toLowerCase() ?? faction}`;
  return [{faction, name, mood: card.data.mood ?? null, again: !!card.data.again,
    helps: card.helps ?? []}];
}

function joinNames(members) {
  const names = members.map((p) => p.name.replace(/^the /i, 'the '));
  if (names.length <= 1) return names[0] ?? '';
  return names.length === 2 ? `${names[0]} and ${names[1]}` :
    `${names.slice(0, -1).join(', ')} and ${names.at(-1)}`;
}

const petitionNames = (members) => joinNames(members).replace(/^./, (c) => c.toUpperCase());

// One member of the first group speaks for all: "A farmer, with the makers and the merchants".
function groupAsker(state, members) {
  const faction = state.factions.find((f) => f.id === members[0]?.faction);
  const name = faction ? `A ${faction.name.toLowerCase().replace(/s$/, '')}` : 'A petitioner';
  return {name, role: `with ${joinNames(members.slice(1))}`};
}

function mergeGrievance(state, first, second) {
  const members = [...petitionersOf(state, first)];
  let changed = false;
  for (const petitioner of petitionersOf(state, second)) {
    if (members.some((p) => p.faction === petitioner.faction)) continue;
    members.push(petitioner);
    changed = true;
  }
  if (!changed) return first;
  first.data.petitioners = members;
  first.subjects = members.map((p) => `petition:${p.faction}:${first.data.grievance}`);
  first.helps = [...new Set(members.flatMap((p) => p.helps ?? []))];
  first.urgency = Math.max(first.urgency ?? 0, second.urgency ?? 0);
  first.createdMonth = Math.min(first.createdMonth, second.createdMonth);
  if (second.surfacedMonth != null) {
    first.surfacedMonth = first.surfacedMonth == null ? second.surfacedMonth : Math.min(first.surfacedMonth, second.surfacedMonth);
    first.expiresMonth = first.expiresMonth == null ? second.expiresMonth : Math.min(first.expiresMonth, second.expiresMonth);
  }
  const again = members.some((p) => p.again);
  if (second.data?.again && !first.data?.again) first.options = second.options;
  first.data.again = again;
  first.data.grievanceText ??= second.data?.grievanceText ??
    /\bsay ([^.]+)\./.exec(first.why ?? '')?.[1] ?? /\bsay ([^.]+)\./.exec(second.why ?? '')?.[1];
  const who = petitionNames(members);
  first.title = `${who} petition the council${again ? ' again' : ''}`;
  first.why = `${who} bring the same grievance: ${String(first.data.grievanceText ?? 'their concern needs attention').replace(/[.!?]+$/, '')}. ` +
    (again ? 'Some have come before; they want a plan, not a promise.' : 'They want to be heard.');
  first.asker = groupAsker(state, members);
  first.prose = null;
  first.needsProse = true;
  first.proseRevision = (first.proseRevision ?? 0) + 1;
  cardAdded(state, first);
  return first;
}

// Old saves may have separate pending cards for the same grievance. Fold them
// before a monthly/quarterly docket pass, without changing the save schema.
export function coalesceGrievancePetitions(state) {
  const byGrievance = new Map();
  for (const card of [...state.docket]) {
    const grievance = grievanceOf(card);
    if (!grievance) continue;
    // Cards grouped before the asker fix were saved as "The petitioners, petitioner".
    if (card.data.petitioners?.length > 1 && card.asker?.name === 'The petitioners') {
      card.asker = groupAsker(state, card.data.petitioners);
    }
    const first = byGrievance.get(grievance);
    if (!first) byGrievance.set(grievance, card);
    else {
      mergeGrievance(state, first, card);
      removeCard(state, card);
    }
  }
}

// Add a card: a body may pay for it from its budget (budgets.budgetCovers); a
// rival's live proposal turns it into a debate; urgent cards and budgets
// surface immediately; the area's adviser stages its answer (advisors.js),
// and a card it will answer surfaces at once so you can overrule it.
export function addCard(state, card) {
  if (!card) return null;
  const body = bodies.bodyOf(state, card.from);

  const grievance = grievanceOf(card);
  if (grievance) {
    const existing = state.docket.find((c) => grievanceOf(c) === grievance);
    if (existing) return mergeGrievance(state, existing, card);
  }

  if (card.kind === 'proposal' || card.kind === 'demand') {
    const cover = budgets.budgetCovers(state, body, card);
    if (cover?.topUp) return addCard(state, budgets.topUpCard(state, body, card, cover));
    if (cover) {
      settleFromBudget(state, body, card, cover);
      return null;
    }
  }

  // Whoever drafted it, the same question is never on the docket twice.
  if (card.kind !== 'report' && card.kind !== 'event' && card.subjects?.some((s) => subjectOpen(state, s))) return null;
  // An event comes round regardless; a plan still waiting in the queue that
  // asks the same thing is overtaken and leaves quietly.
  if (card.kind === 'event') {
    const asks = new Set((card.subjects ?? []).filter((s) => !s.startsWith('event:')));
    for (const c of [...state.docket]) {
      if (c.surfacedMonth == null && c.kind !== 'event' && c.kind !== 'report' && !c.negotiating && subjectsOf(c).some((s) => asks.has(s))) removeCard(state, c);
    }
  }

  if (card.kind === 'proposal' && body && !card.data?.batch) {
    const rival = rivalCard(state, body);
    if (rival && debateAllowed(state, rival, card)) {
      cardAdded(state, card); // local stances for this side before it merges
      const debate = mergeDebate(state, rival, card);
      state.docket.splice(state.docket.indexOf(rival), 1, debate);
      cardAdded(state, debate);
      if (advisers.adviseCard(state, debate) && debate.surfacedMonth == null) surface(state, debate);
      return debate;
    }
  }

  if (card.kind === 'demand' && body?.kind === 'moot') card.kind = 'proposal';
  // An emergency (a bridge falls) supersedes an open plan on the same subject
  // (its upgrade): the question is asked once, as the emergency.
  if (card.kind === 'event' && card.subjects?.length) {
    const subs = new Set(card.subjects);
    state.docket = state.docket.filter((c) => c.kind === 'event' || c.kind === 'report' || !subjectsOf(c).some((s) => subs.has(s)));
  }
  state.docket.push(card);
  if (URGENT.has(card.kind) || card.salient || card.kind === 'budget') surface(state, card);
  cardAdded(state, card);
  // Budgets are advised once the whole season is on the table (budgets.openSeason).
  if (card.kind !== 'budget' && advisers.adviseCard(state, card) && card.surfacedMonth == null) surface(state, card);
  return card;
}

function rivalCard(state, body) {
  const rivals = new Set(bodies.INSTITUTIONS[body.kind]?.rivals ?? []);
  for (const other of Object.values(bodies.INSTITUTIONS)) {
    if (other.rivals?.includes(body.kind)) rivals.add(other.id);
  }
  // Wards are each other's rivals: two wards after the same thing make a debate.
  const kindOf = (id) => (String(id).startsWith('ward:') ? 'ward' : id);
  return state.docket.find((c) => c.kind === 'proposal' && c.from !== body.id && rivals.has(kindOf(c.from)) && !c.data?.batch &&
    (body.kind !== 'ward' || kindOf(c.from) !== 'ward' || sameAsk(c.templateId, body))) ?? null;
}

// A debate forms only if the rival's plan is still open to argue (not under
// way or settled since it was drafted) and the same pair has not been argued lately.
function debateAllowed(state, rival, card) {
  if (subjectsOf(rival).some((s) => subjectInFlight(state, s) || subjectCooling(state, s))) return false;
  const pair = pairKey(rival.templateId, card.templateId);
  const year = state.time.year;
  for (let i = state.cardHistory.length - 1; i >= 0; i--) {
    const h = state.cardHistory[i];
    if (year - h.year >= DEBATE_GAP_YEARS) break;
    if (h.kind === 'debate' && pairKey(...String(h.templateId).slice(7).split('|')) === pair) return false;
  }
  return true;
}
export const DEBATE_GAP_YEARS = 6;
const pairKey = (a, b) => [String(a), String(b)].sort().join('|');

// Two wards clash when they ask for the same kind of thing.
const sameAsk = (templateId) => String(templateId).startsWith('ward-');

// Two rival bodies with live proposals: one card, both positions.
export function mergeDebate(state, a, b) {
  const nameA = bodies.bodyOf(state, a.from)?.name ?? a.from;
  const nameB = bodies.bodyOf(state, b.from)?.name ?? b.from;
  const pick = (card, prefix) => {
    const main = card.options.find((o) => !['not_now', 'refuse'].includes(o.key));
    return {key: prefix, label: `Back the ${prefix === 'a' ? nameA : nameB}: ${card.title.toLowerCase()}`,
      tradeoff: main.tradeoff, cost: main.cost ?? 0, upkeep: main.upkeep, effects: main.effects, side: card.from};
  };
  return makeCard(state, {
    kind: 'debate', from: a.from, templateId: `debate:${a.templateId}|${b.templateId}`, category: a.category,
    title: `${a.title}, or ${b.title.toLowerCase()}`,
    why: `The ${nameA} and the ${nameB} want different things. You can back one. The other will be sore.`,
    asker: a.asker, urgency: Math.max(a.urgency, b.urgency),
    cost: Math.max(a.cost ?? 0, b.cost ?? 0),
    helps: [...new Set([...(a.helps ?? []), ...(b.helps ?? [])])],
    hurts: [...new Set([...(a.hurts ?? []), ...(b.hurts ?? [])])],
    surfacedMonth: a.surfacedMonth, expiresMonth: a.expiresMonth,
    data: {sides: [a.from, b.from], cards: [stripCard(a), stripCard(b)], policy: a.data?.policy ?? b.data?.policy,
      sideStances: {[a.from]: {...a.stances}, [b.from]: {...b.stances}}},
    options: [pick(a, 'a'), pick(b, 'b'),
      {key: 'neither', label: 'Back neither', tradeoff: 'Both bodies lose patience.', cost: 0, effects: []}],
    stances: {...b.stances, ...a.stances},
  });
}

const stripCard = (c) => ({id: c.id, from: c.from, kind: c.kind, templateId: c.templateId, title: c.title, data: c.data,
  subjects: subjectsOf(c), helps: c.helps, hurts: c.hurts, category: c.category});

// A body with two good templates asks "Which first?" in one card.
export function batchCards(state, first, second) {
  const take = (card) => {
    const o = card.options.find((x) => !['not_now', 'refuse'].includes(x.key));
    return {...o, key: `${card === first ? 'x' : 'y'}_${o.key}`, label: card.title, sub: card.templateId};
  };
  return makeCard(state, {
    kind: 'proposal', from: first.from, templateId: first.templateId, category: first.category,
    title: 'Which first?', why: `${first.why} There is a second plan too: ${second.title.toLowerCase()}. Which comes first?`,
    asker: first.asker, urgency: Math.max(first.urgency, second.urgency),
    cost: Math.min(first.cost ?? 0, second.cost ?? 0),
    helps: first.helps, hurts: first.hurts,
    data: {...first.data, batch: [stripCard(first), stripCard(second)]},
    options: [take(first), take(second)],
    details: first.details,
  });
}

// ---------------------------------------------------------------------------
// Sessions and expiry
// ---------------------------------------------------------------------------

const capFor = (table, era) => table[Math.max(0, Math.min(table.length - 1, era ?? 0))];
export const sessionCap = (era) => capFor(SESSION_CAP, era);
export const yearCap = (era) => capFor(YEAR_CAP, era);

function surface(state, card) {
  const m = monthIndex(state.time);
  card.surfacedMonth = m;
  card.expiresMonth = m + (card.kind === 'report' ? 12 : CARD_LIFE_MONTHS);
}

const PRIORITY = {event: 0, demand: 1, petition: 2, debate: 3, proposal: 4, budget: 4, report: 5};

// Every quarter: surface queued cards, up to the caps.
export function docketQuarterly(state) {
  coalesceGrievancePetitions(state);
  const g = state.governance;
  const m = monthIndex(state.time);
  if (g.lastSessionMonth === m) return [];
  g.lastSessionMonth = m;
  pruneStale(state);
  if (state.time.month === 0) g.cardsThisYear = 0;
  const waiting = queuedCards(state).sort((a, b) =>
    PRIORITY[a.kind] - PRIORITY[b.kind] || b.urgency - a.urgency || a.createdMonth - b.createdMonth || a.id.localeCompare(b.id));
  const shown = [];
  let room = sessionCap(state.era);
  for (const card of waiting) {
    if (card.kind === 'report') {
      surface(state, card);
      continue;
    }
    if (room <= 0 || g.cardsThisYear >= yearCap(state.era)) break;
    surface(state, card);
    shown.push(card);
    room--;
    g.cardsThisYear++;
  }
  // Queued proposals too old to matter drop quietly.
  state.docket = state.docket.filter((c) => c.surfacedMonth != null || m - c.createdMonth < 36);
  if (shown.length) g.lastSession = {month: m, cards: shown.map((c) => c.id)};
  return shown;
}

export function docketMonthly(state) {
  coalesceGrievancePetitions(state);
  const m = monthIndex(state.time);
  pruneStale(state);
  // Advisers' answers whose review window has passed are applied, in docket order.
  advisers.applyDue(state, {rule, answerBudget});
  for (const card of [...state.docket]) {
    if (card.expiresMonth == null || m < card.expiresMonth) continue;
    expire(state, card);
  }
}

// A plan overtaken while it waited (the work began, the building went up, the
// event came round) leaves the queue quietly. A rule card whose rule has
// changed since it was drafted goes too, shown or not: it would ask the wrong thing.
function pruneStale(state) {
  for (const card of [...state.docket]) {
    if (card.kind !== 'proposal' && card.kind !== 'demand' && card.kind !== 'debate') continue;
    if (card.negotiating) continue;
    const ruleAsk = /^(adopt|raise):/.test(String(card.templateId)) && card.data?.level != null;
    const stale = (ruleAsk && levelOf(state, card.data.policy) !== card.data.level - 1)
      || (card.surfacedMonth == null && subjectsOf(card).some((s) => !s.startsWith('rule:') && subjectInFlight(state, s)));
    if (stale) removeCard(state, card);
  }
}

function expire(state, card) {
  removeCard(state, card);
  const body = bodies.bodyOf(state, card.from);
  switch (card.kind) {
    case 'event': {
      // Unread, the town muddles through: the event's status-quo choice.
      const lapse = card.options.find((o) => o.key === card.data?.lapse) ?? card.options[0];
      applyEffects(state, card, lapse);
      record(state, card, lapse.key, 'expired');
      break;
    }
    case 'demand': {
      // A strong body may go ahead on its own, within its purse, at most once a decade.
      const first = card.options[0];
      if (body && bodies.maySelfEnact(state, body) && (body.funds ?? 0) >= (first.cost ?? 0)) {
        applyEffects(state, card, {...first, payer: `body:${body.id}`}, {by: body.id});
        bodies.noteSelfEnacted(state, body);
        addChronicle(state, fill(LINES.demandEnacted, {name: `The ${body.name}`, title: card.title.toLowerCase()}), 'line', {card: card.id});
        record(state, card, first.key, 'enacted');
      } else {
        bodies.notePatience(state, card.from, -0.05);
        record(state, card, null, 'expired');
      }
      break;
    }
    case 'report':
      return;
    case 'budget': {
      // Unanswered at the year's turn: last year's figure.
      const outcome = budgets.settleBudget(state, card, 'same', {lapsed: true, record: (c, ch, out) => record(state, c, ch, out)});
      record(state, card, null, outcome);
      break;
    }
    case 'debate':
      for (const side of card.data.sides ?? []) bodies.notePatience(state, side, -0.05);
      record(state, card, null, 'expired');
      break;
    default:
      if (card.kind === 'petition' && card.data?.forms) state.governance.petitionWait[card.data.forms] = monthIndex(state.time) + 36;
      bodies.notePatience(state, card.from, -0.05);
      if (body) body.expired = (body.expired ?? 0) + 1;
      record(state, card, null, 'expired');
      addChronicle(state, fill(LINES.cardExpired, {title: askOf(card)}), 'line', {card: card.id});
  }
}

// What a card asks, for lines and reasons: a "Which first?" card by its two plans.
export function askOf(card) {
  const batch = card.data?.batch;
  if (batch?.length === 2) return `${batch[0].title.toLowerCase()} or ${batch[1].title.toLowerCase()}`;
  return card.title.toLowerCase();
}

const removeCard = (state, card) => {
  const at = state.docket.indexOf(card);
  if (at >= 0) state.docket.splice(at, 1);
};

function record(state, card, choice, outcome, extra = {}) {
  const label = card.options?.find((o) => o.key === choice)?.label ?? null;
  // A decided debate records each side (won or lost) on its own; "Which first?"
  // records the chosen plan as done and the other as deferred.
  let subjects = subjectsOf(card);
  if (card.kind === 'debate' && outcome !== 'expired') subjects = [];
  const batch = card.data?.batch;
  if (batch?.length === 2 && /^[xy]_/.test(choice ?? '')) {
    const [mine, other] = choice[0] === 'x' ? batch : [batch[1], batch[0]];
    subjects = subjectsOf(mine);
    record(state, {...other, options: []}, 'not_now', 'deferred');
  }
  const stances = {};
  for (const [f, s] of Object.entries(card.stances ?? {})) if (s.stance && s.stance !== 'indifferent') stances[f] = s.stance;
  state.cardHistory.push({
    helps: card.helps ?? [], hurts: card.hurts ?? [], label: label ? label.slice(0, 60) : null, stances,
    id: card.id, from: card.from, kind: card.kind, templateId: card.templateId, title: card.title,
    choice, outcome, year: state.time.year, month: state.time.month, category: card.category,
    policy: card.data?.policy ?? null, ...(card.data?.faction ? {faction: card.data.faction} : {}),
    ...(card.data?.petitioners?.length ? {
      factions: card.data.petitioners.map((p) => p.faction),
      moods: Object.fromEntries(card.data.petitioners.map((p) =>
        [`petition:${p.faction}:${card.data.grievance}`, p.mood])),
    } : {}),
    ...(card.data?.workId ? {place: card.data.workId} : {}),
    ...(card.data?.demand != null ? {demand: card.data.demand} : {}),
    ...(card.data?.mood != null ? {mood: card.data.mood} : {}),
    ...(card.data?.batch || /\?$/.test(card.title ?? '') ? {ask: askOf(card)} : {}),
    ...(card.kind === 'budget' ? budgetRecord(state, card) : {}),
    ...extra,
    subjects,
  });
  if (state.cardHistory.length > 3000) state.cardHistory.splice(0, 500);
}

// A budget answer's figures (asked, granted) in the history.
function budgetRecord(state, card) {
  const next = bodies.bodyOf(state, card.from)?.budget?.next;
  return {asked: Math.round(next?.asked ?? budgets.askOf(card.data.budget)), granted: Math.round(next?.granted ?? 0), budgetYear: card.data.budget.year};
}

// ---------------------------------------------------------------------------
// Rulings
// ---------------------------------------------------------------------------

// Player action (opts.adviser: an adviser applies its staged answer).
// Returns {ok, outcome} or {ok: false, reason}.
export function rule(state, cardId, optionKey, opts = {}) {
  const card = state.docket.find((c) => c.id === cardId);
  if (!card) return {ok: false, reason: 'no-card'};
  if (card.kind === 'report') {
    removeCard(state, card);
    advisers.noteRuling(state, card, 'ok', {byAdviser: !!opts.adviser});
    return {ok: true, outcome: 'noted'};
  }
  const option = card.options.find((o) => o.key === optionKey);
  if (!option) return {ok: false, reason: 'no-option'};
  if ((option.cost ?? 0) > 0 && (state.treasury ?? 0) < option.cost) {
    return {ok: false, reason: 'no-coin'};
  }
  removeCard(state, card);
  const body = bodies.bodyOf(state, card.from);
  const adviser = opts.adviser ? advisers.adviserById(state, opts.adviser) : null;
  const patience = body?.patience;
  const outcome = settle(state, card, option, body, adviser);
  // A tactful adviser softens a refusal: the body loses 30% less patience.
  if (adviser?.temper === 'Tactful' && body && body.patience < patience && body.status === 'active') body.patience += 0.3 * (patience - body.patience);
  const note = advisers.noteRuling(state, card, optionKey, {byAdviser: !!adviser});
  record(state, card, optionKey, outcome, note ? {advisedBy: note.adviserId, ...(note.changed ? {overruled: true} : {})} : {});
  // A top-up you turned down: the plan itself comes to you as an ordinary card.
  if (card.data?.topUp && (outcome === 'deferred' || outcome === 'refused') && card.data.plan) {
    addCard(state, {...card.data.plan, data: {...card.data.plan.data, escalated: true}});
  }
  invalidateCtx(state);
  return {ok: true, outcome};
}

// A budget answered with a trim to fit (budgets.trimAllToFit): factor of the ask.
// opts.adviser: an adviser applies its staged answer.
export function answerBudget(state, cardId, choice, {factor = null, adviser = null} = {}) {
  const card = state.docket.find((c) => c.id === cardId && c.kind === 'budget');
  if (!card) return {ok: false, reason: 'no-card'};
  if (factor == null) return rule(state, cardId, choice, {adviser});
  removeCard(state, card);
  const outcome = budgets.settleBudget(state, card, 'trim', {factor, record: (c, ch, out) => record(state, c, ch, out)});
  const note = advisers.noteRuling(state, card, 'trim', {byAdviser: !!adviser});
  record(state, card, 'trim', outcome, note ? {advisedBy: note.adviserId, ...(note.changed ? {overruled: true} : {})} : {});
  invalidateCtx(state);
  return {ok: true, outcome};
}

function settle(state, card, option, body, adviser = null) {
  const key = option.key;
  if (card.kind === 'budget') return budgets.settleBudget(state, card, key, {record: (c, ch, out) => record(state, c, ch, out)});
  // An adviser's answer reads as theirs in the chronicle, and its rules are enacted by them.
  const by = adviser ? `adviser:${adviser.id}` : 'player';
  const addChronicle = (state, text, ...rest) => chronicle(state, adviser ? text.replace(/^You /, `${adviser.name} `) : text, ...rest);
  if (key === 'not_now') {
    if (card.data?.forms) {
      state.governance.petitionWait[card.data.forms] = monthIndex(state.time) + 36;
    } else if (card.data?.revive) {
      return 'deferred';
    } else {
      bodies.notePatience(state, card.from, -0.05);
    }
    addChronicle(state, fill(LINES.cardDeferred, {title: askOf(card)}), 'decision', {card: card.id});
    return 'deferred';
  }
  if (key === 'refuse_anyway') {
    if (body) body.refused++;
    bodies.notePatience(state, card.from, -0.3);
    delta(state, 'unrest', 0.04, `refused:${card.from}`);
    moodShift(state, card.helps, -0.1);
    addChronicle(state, fill(LINES.cardRefused, {title: card.title.toLowerCase()}), 'decision', {card: card.id});
    return 'refused';
  }
  if (key === 'refuse') {
    if (card.data?.forms) {
      bodies.refuseBody(state, card.data.forms);
    } else if (body) {
      body.refused++;
      bodies.notePatience(state, body.id, -0.15);
      moodShift(state, card.helps, -0.05);
      addChronicle(state, fill(LINES.cardRefused, {title: card.title.toLowerCase()}), 'decision', {card: card.id});
    }
    return 'refused';
  }
  if (key === 'negotiate') {
    negotiationRequested(state, card);
    card.negotiating = true;
    card.options = card.options.filter((o) => o.key !== 'negotiate');
    state.docket.push(card);
    return 'negotiating';
  }
  if (key === 'neither' && card.kind === 'debate') {
    for (const side of card.data.sides) bodies.notePatience(state, side, -0.1);
    for (const sub of card.data.cards ?? []) record(state, sub, 'refuse', 'lost');
    addChronicle(state, `You backed neither side: ${card.title.toLowerCase()}.`, 'decision', {card: card.id});
    return 'refused';
  }

  // An accepted option.
  if (card.kind === 'debate') {
    const winner = bodies.bodyOf(state, option.side);
    const loserId = card.data.sides.find((s) => s !== option.side);
    const loser = bodies.bodyOf(state, loserId);
    if (winner) winner.accepted++;
    bodies.notePatience(state, loserId, -0.08);
    for (const sub of card.data.cards ?? []) record(state, sub, sub.from === option.side ? 'do' : 'refuse', sub.from === option.side ? 'won' : 'lost');
    applyEffects(state, card, option, {by});
    addChronicle(state, fill(LINES.debateWon, {winner: `The ${winner?.name ?? 'one side'}`, loser: `The ${loser?.name ?? 'other side'}`}), 'decision', {card: card.id});
    return 'accepted';
  }
  if (body && body.kind !== 'moot' && card.kind !== 'event') body.accepted++;
  if (body && card.kind !== 'event') bodies.notePatience(state, body.id, 0.03);
  applyEffects(state, card, option, {by});
  moodShift(state, card.helps, 0.04);
  moodShift(state, card.hurts, -0.04);
  if (card.data?.faction) {
    const who = card.data.petitioners?.length > 1 ? 'petitioning groups' :
      state.factions.find((x) => x.id === card.data.faction)?.name.toLowerCase() ?? 'petitioners';
    addChronicle(state, `You heard the ${who} and promised action.`, 'decision', {card: card.id});
  } else if (!card.data?.policy && card.kind !== 'event' && !option.effects.some((e) => e.form || e.policy)) {
    addChronicle(state, `You chose to ${lowerFirst(option.label)}.`, 'decision', {card: card.id});
  }
  return 'accepted';
}

const capital = (s) => s.charAt(0).toUpperCase() + s.slice(1);
const lowerFirst = (s) => s.charAt(0).toLowerCase() + s.slice(1);

function moodShift(state, trades, amount) {
  if (!trades?.length) return;
  for (const f of state.factions) {
    if (f.trades?.some((t) => trades.includes(t))) nudgeMood(f, Math.max(0, Math.min(1, f.mood + amount)), 'rulings');
  }
}

// A body pays for a plan in its budget (or a small thing) from its own purse.
function settleFromBudget(state, body, card, {option, line}) {
  applyEffects(state, card, {...option, payer: `body:${body.id}`}, {by: body.id});
  body.accepted++;
  budgets.noteBudgetSpend(state, body, line, option.cost ?? 0);
  const what = budgets.planTitle(card, option).toLowerCase();
  body.report.push(`It began: ${what}.`);
  record(state, card, option.key, 'budget');
  addChronicle(state, `The ${body.name} began: ${what}.`, 'line', {card: card.id, budget: body.id});
}

// A body's own requests still waiting on you whose plans its new budget
// approved: they go ahead from the grant (not small things: those you were asked).
export function settleOpenFromBudget(state, body) {
  for (const card of [...state.docket]) {
    if (card.from !== body.id || card.kind !== 'proposal' || card.negotiating) continue;
    const cover = budgets.budgetCovers(state, body, card);
    if (!cover?.line || cover.topUp) continue;
    removeCard(state, card);
    settleFromBudget(state, body, card, cover);
  }
}

// ---------------------------------------------------------------------------
// Effects
// ---------------------------------------------------------------------------

// Effects of a chosen option. option.payer ('treasury' or 'body:<id>') pays
// for spends, buildings and works.
// opts.by: who enacts rules ('player' unless a body acts on its own).
export function applyEffects(state, card, option, {by = 'player'} = {}) {
  const payer = option.payer ?? 'treasury';
  const builds = (option.effects ?? []).some((e) => e.build);
  const spent = (option.effects ?? []).some((e) => e.spend !== undefined);
  for (const e of option.effects ?? []) {
    if (e.spend !== undefined) {
      const amount = e.spend === 'cost' ? card.cost : e.spend === 'half' ? Math.round(card.cost / 2) : e.spend;
      spend(state, amount, `card:${card.templateId}`, {from: payer, build: builds || !!e.local});
    }
    if (e.policy) changeRule(state, card, e, by);
    if (e.build) requestBuilding(state, e.build, {variant: e.variant, payer, paid: spent, ...(e.at ? {near: events.placeFor(state, e.at)} : {})});
    if (e.work) startWork(state, card, e, payer);
    if (e.deltas) {
      for (const [k, v] of Object.entries(e.deltas)) delta(state, k, v * (TRAITS.includes(k) ? ONE_OFF_TRAIT_SCALE : 1), `card:${card.templateId}`);
    }
    if (e.tag) setTag(state, e.tag);
    if (e.event) events.startEvent(state, e.event, {choice: e.choice, from: card.id});
    if (e.form) {
      if (String(e.form).startsWith('ward:')) bodies.formWard(state, e.form, e.budget ?? 0.04);
      else bodies.formBody(state, e.form, e.budget ?? 0.06);
    }
    if (e.union) bodies.settleUnion(state, e.union.centre, e.union.choice);
    if (e.refuseBody) bodies.refuseBody(state, e.refuseBody);
    if (e.wait) state.governance.petitionWait[card.data?.forms] = monthIndex(state.time) + e.wait;
    if (e.revive) bodies.reviveBody(state, e.revive);
    if (e.topUp && card.data?.topUp) {
      // The chest tops the body's purse up; its plan then goes ahead from it.
      const t = card.data.topUp;
      const body = bodies.bodyOf(state, t.body);
      if (body && pay(state, 'treasury', `body:${body.id}`, t.amount, 'budget-topup') > 0 && card.data.plan) addCard(state, card.data.plan);
    }
    if (e.budget && !e.form && budgets.isAnnual(bodies.bodyOf(state, card.from))) {
      budgets.raiseGrant(state, bodies.bodyOf(state, card.from), e.budget);
    } else if (e.budget && !e.form) {
      const body = bodies.bodyOf(state, card.from);
      if (body) {
        body.grantShare = Math.min(0.25, (body.grantShare ?? body.budgetShare ?? 0) + e.budget);
        bodies.balancePurses(state);
      }
    }
    if (e.loan) takeLoan(state, e.loan);
    if (e.food) adjustFood(state, e.food);
    if (e.focus) bodies.focusBody(state, e.focus.body, e.focus.category, e.focus.boost);
    if (e.eventEffect) events.applyEventEffect(state, card, e.eventEffect);
  }
}

function changeRule(state, card, e, by) {
  const id = e.policy;
  const before = levelOf(state, id);
  const level = e.level === '+1' ? before + 1 : e.level === '-1' ? before - 1 : e.level;
  const change = adoptPolicy(state, id, level, by);
  if (change && state.policies[id] && card.from && card.from !== 'moot') state.policies[id].draftedBy = card.from;
  if (!change) return;
  const title = POLICIES[id].title.toLowerCase();
  const line = {adopted: LINES.ruleAdopted, raised: LINES.ruleRaised, lowered: LINES.ruleLowered, repealed: LINES.ruleRepealed}[change];
  addChronicle(state, fill(line, {title}), 'decision', {policy: id, card: card.id});
  policyChanged(state, id, change, card);
}

// Coin moves only through the economy's accounts, so money is conserved.
// A negative amount is income (a licence fee, sold rights).
export function spend(state, amount, reason, {from = 'treasury', build = false} = {}) {
  if (!Number.isFinite(amount) || amount === 0) return 0;
  if (amount < 0) return pay(state, 'external', 'treasury', -amount, reason);
  return build ? payBuilders(state, from, amount, reason) : pay(state, from, 'external', amount, reason);
}

function takeLoan(state, amount) {
  economyLoan(state, Math.round(amount * costScale(state)), {years: 10});
}

function adjustFood(state, frac) {
  state.food = Math.max(0, (state.food ?? 0) * (1 + frac));
}

// The sim picks the site; we only say what and who pays. When the option
// spent the cost up front the project is marked paid; otherwise the economy
// charges the payer as the work proceeds.
export function requestBuilding(state, type, opts) {
  const r = worldRequestBuilding(state, type, opts);
  // Nothing to build up yet: raise a new one instead (on its chosen ground).
  if (r && !r.ok && r.reason === 'none' && opts.variant === 'upgrade') return worldRequestBuilding(state, type, {...opts, variant: null});
  return r;
}

function startWork(state, card, e, payer) {
  const workId = card.data?.workId;
  if (!workId) return null;
  const paid = !!e.paid;
  // A basic bridge was found at a lower crossing threshold than sim-world's
  // default list, so it is carried on the card and executed directly.
  const stored = card.data?.work;
  if (stored) {
    const work = [...bodies.basicBridges(state), ...bodies.bridgeUpgrades(state)].find((w) => w.id === workId) ?? stored;
    const key = work.options?.some((o) => o.key === e.variant) ? e.variant : work.options?.[0]?.key;
    return executeWork(state, work, key, {payer, paid});
  }
  return startWorldWork(state, workId, {variant: e.variant ?? null, payer, paid});
}

// Player-facing prose written by the narrator (cosmetic; mechanics never read it).
// prose = {why?: string, options?: {optionKey: tradeoff}, source?: string}
const PROSE_TEXT = /[^\S ]+/g;
export function setCardProse(state, cardId, prose = {}) {
  const card = state.docket.find((c) => c.id === cardId);
  if (!card || !prose || typeof prose !== 'object') return {ok: false, reason: 'no-card'};
  const clean = (t, max) => (typeof t === 'string' && t.trim() ? t.replace(PROSE_TEXT, ' ').trim().slice(0, max) : null);
  const options = {};
  for (const o of card.options) {
    const t = clean(prose.options?.[o.key], 200);
    if (t) options[o.key] = t;
  }
  card.prose = {why: clean(prose.why, 600), options, source: clean(prose.source, 40) ?? 'narrator'};
  card.needsProse = false;
  return {ok: true};
}

// Answer to an institution_negotiate question.
export function applyNegotiation(state, cardId, choice) {
  const card = state.docket.find((c) => c.id === cardId);
  if (!card) return;
  const body = bodies.bodyOf(state, card.from);
  card.negotiating = false;
  if (choice === 'accept_half') {
    // The body settles for a promise and a small grant; nothing is enacted.
    removeCard(state, card);
    const grant = Math.round(Math.max(card.cost ?? 0, 0.05 * fiscalBase(state)) / 2);
    if (body && grant > 0) pay(state, 'treasury', `body:${body.id}`, grant, 'body-grant');
    bodies.notePatience(state, card.from, 0.1);
    record(state, card, 'negotiate', 'compromise');
    addChronicle(state, `The ${body?.name ?? 'body'} took a grant of ${coin(grant)} instead.`, 'decision', {card: card.id});
  } else if (choice === 'withdraw') {
    removeCard(state, card);
    bodies.notePatience(state, card.from, -0.1);
    record(state, card, 'negotiate', 'withdrawn');
    addChronicle(state, `The ${body?.name ?? 'body'} withdrew its demand.`, 'line', {card: card.id});
  } else {
    // They insist: the player may still refuse, at a price.
    card.why = `${card.why} They will not settle for less.`;
    if (!card.options.some((o) => o.key === 'refuse_anyway')) {
      card.options.push({key: 'refuse_anyway', label: 'Refuse anyway', tradeoff: 'They will be furious. Their backers will make trouble.', cost: 0, effects: []});
    }
  }
}

