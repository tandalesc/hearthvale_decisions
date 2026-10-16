// Development stand-in for src/sim/view.js (contract §5). Pure functions of
// the stub state. Shapes here are what the UI consumes; src/ui/model.js
// normalises the real selectors to the same shapes.
import {BODY_DEFS, CATEGORIES, FACTIONS, RULES, TENSION_PAIRS} from './stub-content.js';
import {bodyName} from './stub-sim.js';
import {ERA_NAMES, SEASONS} from '../format.js';

export function selectTopBar(state) {
  const s = state.stats;
  const trend = state.coinHistory.length ? (state.coinHistory.reduce((a, b) => a + b, 0) / state.coinHistory.length) * 12 : 0;
  return {
    year: state.time.year, month: state.time.month, season: Math.floor(state.time.month / 3),
    era: state.era, eraName: ERA_NAMES[state.era],
    people: s.people, coin: s.coin, coinTrend: trend, food: s.food,
    foodMonths: s.food / Math.max(1, s.people * 0.9), wellbeing: s.wellbeing, homes: s.homes,
    approval: state.era >= 3 ? stubApproval(state).value : null, approvalChange: state.era >= 3 ? stubApproval(state).change : null,
  };
}

// A made-up approval history: a slow swell with a dip, the same every time.
function stubApproval(state) {
  const y = state.time.year;
  const at = (k) => Math.round(58 + 9 * Math.sin(k / 7) - 6 * Math.exp(-(((k - y + 6) / 3) ** 2)));
  const history = Array.from({length: Math.min(40, y + 1)}, (_, i) => ({y: y - Math.min(40, y + 1) + 1 + i})).map((p) => ({y: p.y, v: at(p.y)}));
  return {value: history.at(-1).v, change: history.length > 1 ? history.at(-1).v - history.at(-2).v : null, history};
}

export function selectApproval(state) {
  if (state.era < 3) return null;
  const {value, change, history} = stubApproval(state);
  const rows = (pairs) => {
    const total = pairs.reduce((n, [, , p]) => n + p, 0);
    return pairs.map(([id, v, p]) => ({id, name: FACTIONS[id] ?? id, value: v, people: p, share: p / total}));
  };
  return {
    year: state.time.year - 1, value, change, strongAgainst: 6, history,
    tabs: [
      {id: 'faction', label: 'Groups', more: 0, rows: rows([['farmers', 54, 900], ['crafts', 71, 820], ['merchants', 38, 610], ['labour', 49, 480], ['newcomers', 63, 300]])},
      {id: 'wealthBand', label: 'Wealth', more: 0, rows: [['Poor', 52, 0.34], ['Middling', 61, 0.36], ['Wealthy', 44, 0.3]].map(([name, v, share]) => ({id: name.toLowerCase(), name, value: v, people: Math.round(share * 3000), share}))},
      {id: 'district', label: 'Districts', more: 9, rows: [['Mill Row', 47, 0.12], ['Old Ford', 63, 0.1], ['Tanner Bank', 55, 0.08]].map(([name, v, share]) => ({id: name, name, value: v, people: Math.round(share * 3000), share}))},
    ],
    drivers: [
      {text: 'The rent cap: Makers glad, Merchants sore', kind: 'rule', points: 3},
      {text: 'You refused: a guild hall', kind: 'ruling', points: -2},
      {text: 'Families waiting for homes', kind: 'life', points: -1},
    ],
  };
}

export function selectDocket(state) {
  return state.docket.map((card) => ({
    ...card,
    expiresInMonths: Math.max(1, Math.round((card.expiresInMonths ?? 24) - (state.time.tick - (card.createdTick ?? state.time.tick)) / 50)),
  }));
}

export function selectBodies(state) {
  const rulesBy = {};
  for (const [id, p] of Object.entries(state.policies)) (rulesBy[p.by] ??= []).push(id);
  return state.bodies.filter((b) => b.status !== 'dissolved').map((b) => ({
    id: b.id, kind: b.kind, centreId: b.centreId, name: bodyName(state, b), founded: b.foundedYear, status: b.status,
    power: b.power, patience: b.patience,
    explainer: b.kind === 'ward' ? ['Millbridge has its own council now.', 'It asks for local works and wants to keep more of its own taxes.'] : BODY_DEFS[b.id]?.explainer,
    metrics: b.metrics.map((m) => {
      const last = m.series[m.series.length - 1];
      const prev = m.series[Math.max(0, m.series.length - 13)];
      return {...m, value: last, delta: prev ? (last - prev) / Math.abs(prev) : 0};
    }),
    docketCount: state.docket.filter((c) => c.from === b.id || (b.id === 'moot' && !state.bodies.some((x) => x.id === c.from))).length,
    rules: rulesBy[b.id] ?? [],
  }));
}

export function selectRuleBook(state) {
  const tensionOf = (id) => TENSION_PAIRS.filter((t) => t[0] === id || t[1] === id).map((t) => (t[0] === id ? t[1] : t[0])).filter((o) => state.policies[o]?.level);
  const bodies = Object.fromEntries(state.bodies.map((b) => [b.id, bodyName(state, b)]));
  return CATEGORIES.map(([id, name]) => ({
    id, name,
    policies: Object.entries(state.policies)
      .filter(([pid, p]) => p.level > 0 && RULES[pid]?.[0] === id)
      .map(([pid, p]) => ({
        id: pid, title: RULES[pid][1], summary: RULES[pid][2], level: p.level, maxLevel: 3, since: p.since,
        by: p.by, byName: p.by === 'player' ? 'You' : bodies[p.by] ?? p.by,
        tensions: tensionOf(pid), againstGrain: pid === 'free-trade' && state.archetype === 'commune',
      })),
  })).filter((c) => c.policies.length || state.era >= 1);
}

export function selectTensions(state) {
  return TENSION_PAIRS
    .filter(([a, b]) => state.policies[a]?.level && state.policies[b]?.level)
    .map(([a, b, text, forA, forB]) => ({
      id: `${a}~${b}`,
      a: {id: a, title: RULES[a][1]}, b: {id: b, title: RULES[b][1]},
      text, forA: forA.map((f) => FACTIONS[f]), forB: forB.map((f) => FACTIONS[f]),
      net: 'Nothing moves while both stand.', upkeep: 120 + a.length * 9,
    }));
}

export function selectFactions(state) {
  const ids = state.era === 0 ? ['farmers', 'newcomers'] : state.era < 3 ? ['farmers', 'crafts', 'merchants', 'clergy', 'newcomers'] : Object.keys(FACTIONS);
  const wants = {
    farmers: 'Good harvests and open commons.', crafts: 'Fair prices and trained hands.', merchants: 'Open roads and low tolls.',
    millers: 'Water rights and cheap labour.', clergy: 'Feast days and a full chapel.', labour: 'Better pay and shorter days.',
    newcomers: 'Homes and work.', gentry: 'Low taxes and quiet streets.', scholars: 'Schools and books.',
  };
  let seed = state.time.year * 31 + 7;
  const r = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  return ids.map((id) => ({
    id, name: FACTIONS[id], size: 0.05 + r() * 0.25, mood: 0.25 + r() * 0.6, trend: (r() - 0.5) * 0.2, wants: wants[id],
  }));
}

export function selectChronicle(state, {limit = 200} = {}) {
  return state.chronicle.slice(-limit).map((e) => ({...e, season: SEASONS[Math.floor((e.month ?? 0) / 3)]}));
}

export function selectEraProgress(state) {
  const next = Math.min(5, state.era + 1);
  const floors = [0, 6, 25, 55, 90, 125];
  const ceilings = [0, 15, 45, 80, 115, 140];
  const pop = state.stats.people;
  const conds = [
    [[`120 people`, pop / 120], ['A first body', state.bodies.length >= 1 ? 1 : 0]],
    [[`450 people`, pop / 450], ['Three bodies', state.bodies.length / 3], ['Forty cells of road', 0.7]],
    [[`1,200 people`, pop / 1200], ['Better homes', 0.64], ['River trade, industry or renown', 0.8]],
    [[`3,000 people`, pop / 3000], ['Six bodies', state.bodies.length / 6], ['Ten rules in force', Object.keys(state.policies).length / 10]],
    [[`6,000 people`, pop / 6000], ['Fine homes', 0.4], ['Good health', 0.55]],
    [],
  ][state.era];
  const conditions = conds.map(([label, p]) => ({label, met: p >= 1, progress: Math.min(1, p)}));
  const span = Math.max(1, ceilings[next] - floors[state.era]);
  return {
    era: state.era, eraName: ERA_NAMES[state.era], nextEra: next, nextName: ERA_NAMES[next],
    floorYear: floors[next], ceilingYear: ceilings[next], year: state.time.year,
    timeProgress: Math.min(1, (state.time.year - floors[state.era]) / span),
    conditions, final: state.era >= 5,
  };
}

// Design-systems §2 'UI surfaces' row and §9.2.
export function selectUnlocks(state) {
  const e = state.era;
  return {
    chronicle: true, docket: true,
    ruleBook: e >= 1, people: e >= 1,
    bodies: e >= 2, overlays: e >= 2,
    debates: e >= 3, tensions: e >= 3, approval: e >= 3,
    budget: e >= 4, compass: e >= 4,
    endPreview: e >= 5,
    places: (state.centres?.length ?? 0) >= 2,
  };
}

export function selectInspect(state, {buildingId, personId} = {}) {
  if (buildingId != null) {
    const b = state.buildings.find((x) => x.id === buildingId);
    if (!b) return null;
    const names = {home: 'Cottage', farm: 'Farmstead', workshop: 'Workshop', shop: 'Shop', inn: 'Inn', market: 'Market hall', chapel: 'Chapel', mill: 'Mill'};
    const styles = ['hearth', 'stone', 'guild', 'terrace', 'civic', 'glass'];
    return {
      kind: 'building', id: b.id, title: names[b.type] ?? b.type,
      subtitle: `Built in year ${Math.max(0, state.time.year - b.age)} · ${styles[b.styleEra]} style`,
      rows: [
        {label: 'Storeys', value: String(b.storeys)},
        {label: 'Condition', value: b.condition > 0.8 ? 'Good' : b.condition > 0.5 ? 'Worn' : 'Poor'},
        {label: 'Value', value: b.wealth > 0.66 ? 'High' : b.wealth > 0.33 ? 'Middling' : 'Low'},
      ],
      text: b.type === 'home' ? 'A family of five lives here. They work at the mill.' : 'People come and go all day.',
      at: {x: b.x, z: b.z},
    };
  }
  if (personId != null) {
    const p = state.people.find((x) => x.id === personId);
    if (!p) return null;
    return {kind: 'person', id: p.id, title: 'Wren Ashby', subtitle: 'Weaver · 34 years', rows: [{label: 'Doing', value: 'Walking to work'}, {label: 'Mood', value: 'Content'}], text: 'Wren wants a shorter walk to the mill.', at: {x: p.x, z: p.z}};
  }
  return null;
}

export function selectBudget(state) {
  const bodies = state.bodies.filter((b) => b.id !== 'moot').map((b, i) => ({id: b.id, name: bodyName(state, b), coin: 120 + ((i * 97) % 380)}));
  const spend = bodies.reduce((n, b) => n + b.coin, 0) + 640;
  return {income: {tax: 5200, tolls: 600, total: 5800}, spend: {rules: 640, bodies, total: spend}};
}

export function selectCompass(state) {
  return {now: {industry: 0.42, market: 0.18, innovation: -0.12, authority: 0.3}, path: []};
}

export function selectEndPreview(state) {
  return {
    people: state.stats.people, rules: Object.keys(state.policies).length, institutions: state.bodies,
    sentences: ['Hearthvale became a mill town, loud and busy by the river.', 'The mills made some families rich, and many tired.', 'The land bore the marks of its growth.'],
  };
}

export function selectCentres(state) {
  const centres = (state.centres ?? []).map((c) => ({...c, bodyId: state.bodies.find((b) => b.centreId === c.id && b.status !== 'dissolved')?.id ?? null}));
  return {region: {people: centres.reduce((n, c) => n + c.pop, 0) || state.stats.people, centres: centres.length}, centres};
}
