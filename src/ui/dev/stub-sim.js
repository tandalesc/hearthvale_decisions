// Development stand-in for src/sim (contract §3, §5, §6). It keeps the same
// function names and return shapes so the UI can be built, tested and
// screenshotted on 'hamlet', 'town' and 'city' fixtures before the real
// simulation lands. It is deliberately simple: time advances, metrics
// wander, cards arrive each quarter and rulings land in the chronicle.
import {riverX} from '../../terrain.js';
import {BODY_DEFS, CARDS, CHRONICLE, LATER_CARDS} from './stub-content.js';
import {cap, theName} from '../format.js';

const TICKS_PER_MONTH = 50;
const BODY_ORDER = ['moot', 'agri-council', 'trades-guild', 'river-authority', 'parish', 'school-board',
  'health-board', 'planning', 'exchange', 'union', 'watch', 'arts-society'];

const FIXTURES = {
  hamlet: {
    era: 0, year: 2, people: 28, coin: 14200, food: 210, homes: 6, bodies: 1, buildings: 9,
    cards: ['c-cottages'], policies: {},
  },
  town: {
    era: 2, year: 34, people: 640, coin: 3120, food: 4800, homes: 118, bodies: 4, buildings: 150,
    cards: ['c-bridge', 'c-granary', 'c-guild-form'],
    policies: {commons: 1, 'market-charter': 1, 'property-tax': 2, granary: 1, tithe: 1, 'parish-school': 1, apprenticeship: 1, 'feast-days': 1, 'mill-rights': 1},
  },
  city: {
    era: 4, year: 96, people: 3140, coin: 28600, food: 22000, homes: 820, bodies: 12, buildings: 1200,
    cards: ['c-strike', 'c-schooling', 'c-lamps', 'c-wells', 'c-fair', 'c-bridge'],
    policies: {
      enclosure: 2, zoning: 1, 'park-reserve': 1, apprenticeship: 1, 'wage-floor': 2, 'hours-cap': 1, 'market-charter': 2,
      'free-trade': 1, 'property-tax': 2, 'income-tax': 1, tithe: 1, granary: 2, 'grain-import': 1, wells: 2, sewers: 1,
      'smoke-limits': 1, 'parish-school': 1, library: 1, 'press-licence': 1, 'sabbath-rule': 1, 'festival-fund': 1,
      'riverbank-protect': 1, 'mill-rights': 2, 'paving-fund': 2, lamps: 1, 'open-moot': 1,
    },
  },
};

// Seeded RNG kept in state, like the real sim.
function rng(state) {
  state.seed = (Math.imul(state.seed ^ (state.seed >>> 15), 2246822519) + 0x6d2b79f5) >>> 0;
  return state.seed / 4294967296;
}

function series(state, base, drift, n = 60) {
  const out = [];
  let v = base * (1 - drift * n * 0.6);
  for (let i = 0; i < n; i++) {
    v = Math.max(0, v * (1 + drift + (rng(state) - 0.5) * 0.05));
    out.push(Number(v.toFixed(2)));
  }
  const scale = base / (out[out.length - 1] || 1);
  return out.map((x) => Number((x * scale).toFixed(2)));
}

function makeBody(state, id, foundedYear) {
  const def = BODY_DEFS[id];
  return {
    id, kind: id, foundedYear, status: 'active', power: 0.35 + rng(state) * 0.45, patience: 0.4 + rng(state) * 0.6,
    budgetShare: 0.06,
    metrics: def.metrics.map(([key, label, unit, base, drift]) => ({id: key, label, unit, series: series(state, base, drift)})),
  };
}

function cloneCard(card, state) {
  return structuredClone({...card, id: card.id ?? `c-${state.time.tick}-${Math.floor(rng(state) * 1e6)}`, createdTick: state.time.tick});
}

export function createState({seed = 7} = {}) {
  return fixtureState('hamlet', {seed, fresh: true});
}

export function fixtureState(name = 'town', {seed = 11, fresh = false} = {}) {
  const f = FIXTURES[name] ?? FIXTURES.town;
  const state = {
    version: 2, __stub: true, fixture: name, seed,
    settings: {individualCap: 2000},
    time: {tick: f.year * 600 + 60, month: 1, year: f.year},
    era: f.era, archetype: name === 'city' ? 'mill' : 'market-town',
    stats: {people: f.people, coin: f.coin, food: f.food, homes: f.homes, wellbeing: 0.72},
    coinHistory: [],
    bodies: [], docket: [], policies: {}, chronicle: [], cardHistory: [],
    buildings: [], people: [], projects: [], worldEvents: [],
    weather: {rain: 0, wind: [0.4, 0.2], snow: 0},
    deferred: {},
  };
  BODY_ORDER.slice(0, f.bodies).forEach((id, i) => state.bodies.push(makeBody(state, id, i === 0 ? 0 : 6 + i * 7)));
  for (const id of f.cards) state.docket.push(cloneCard(CARDS.find((c) => c.id === id), state));
  for (const [id, level] of Object.entries(f.policies)) {
    state.policies[id] = {level, since: Math.max(1, Math.floor(rng(state) * f.year)), by: rng(state) < 0.6 ? 'player' : state.bodies[Math.floor(rng(state) * state.bodies.length)].id};
  }
  const entries = fresh ? CHRONICLE.slice(0, 1) : CHRONICLE.filter(([y]) => y <= f.year);
  state.chronicle = entries.map(([year, month, kind, text], i) => ({id: i + 1, year, month, kind, text, era: eraAt(year)}));
  layoutTown(state, f.buildings, Math.min(f.people, state.settings.individualCap));
  if (name === 'city') {
    state.centres = [
      {id: 'c1', name: 'Hearthvale', kind: 'city', seat: true, pop: 2140, character: 'mill', characterName: 'Mill town', autonomy: 1, x: -18, z: 4},
      {id: 'c2', name: 'Millbridge', kind: 'town', seat: false, pop: 720, character: 'market-town', characterName: 'Market town', autonomy: 0.46, x: 46, z: -30},
      {id: 'c3', name: 'Eastbank', kind: 'village', seat: false, pop: 280, character: 'garden', characterName: 'Garden village', autonomy: 0.12, x: 52, z: 48},
    ].map((c) => ({...c, popSeries: c.id === 'c3' ? [] : series(state, c.pop, 0.03)}));
    // Lines about one place carry its centre id (Eastbank has no history yet).
    const n = state.chronicle.length;
    state.chronicle.push(
      {id: n + 1, year: 90, month: 4, kind: 'line', text: 'Millbridge opened a covered market by the bridge.', era: eraAt(90), refs: {centreId: 'c2'}},
      {id: n + 2, year: 91, month: 7, kind: 'line', text: 'Eastbank planted a long row of pear trees.', era: eraAt(91), refs: {centreId: 'c3'}},
    );
    state.bodies.push({...makeBody(state, 'moot', 88), id: 'ward:c2', kind: 'ward', centreId: 'c2', foundedYear: 88});
  }
  return state;
}

function eraAt(year) {
  return year >= 90 ? 4 : year >= 55 ? 3 : year >= 25 ? 2 : year >= 6 ? 1 : 0;
}

// Buildings along a few radiating streets west of the river (and across it
// for larger towns), so the stub renderer has something legible to draw.
function layoutTown(state, count, peopleCount) {
  const types = ['home', 'home', 'home', 'home', 'farm', 'workshop', 'shop', 'home', 'inn', 'market', 'chapel', 'mill'];
  const streets = 7 + Math.floor(count / 120);
  const cx = -18, cz = 4;
  let id = 1, guard = 0;
  while (state.buildings.length < count && guard++ < count * 20) {
    const s = Math.floor(rng(state) * streets);
    const angle = (s / streets) * Math.PI * 2 + 0.3;
    const dist = 6 + Math.pow(rng(state), 0.7) * (16 + Math.sqrt(count) * 5.5);
    const side = rng(state) < 0.5 ? -1 : 1;
    const x = cx + Math.cos(angle) * dist + Math.cos(angle + Math.PI / 2) * side * 4.5;
    const z = cz + Math.sin(angle) * dist + Math.sin(angle + Math.PI / 2) * side * 4.5;
    if (Math.abs(x - riverX(z)) < 9) continue;
    if (state.buildings.some((b) => Math.abs(b.x - x) < 3.4 && Math.abs(b.z - z) < 3.4)) continue;
    const type = types[Math.floor(rng(state) * types.length)];
    const near = dist < 30 ? 1 : 0;
    state.buildings.push({
      id: id++, type, variant: 0, tier: 1 + Math.floor(rng(state) * (state.era + 1)), storeys: 1 + Math.floor(rng(state) * (state.era + 1)) + near,
      x, z, rot: Math.floor(angle / (Math.PI / 2)) & 3, w: type === 'farm' ? 6 : 3, d: type === 'farm' ? 5 : 3,
      styleEra: Math.floor(rng(state) * (state.era + 1)), built: 1, condition: 0.6 + rng(state) * 0.4, wealth: rng(state),
      age: Math.floor(rng(state) * state.time.year),
    });
  }
  for (let i = 0; i < peopleCount; i++) {
    const b = state.buildings[i % state.buildings.length];
    const a = rng(state) * Math.PI * 2;
    state.people.push({id: i + 1, x: b.x + Math.cos(a) * 2, z: b.z + Math.sin(a) * 2, heading: a, speed: 0.6 + rng(state) * 0.8, homeId: b.id, look: {skin: i % 5, cloth: i % 7, hat: i % 3}});
  }
}

export function stepTick(state, dt) {
  if (!(dt > 0)) return;
  const before = state.time.tick;
  state.time.tick += dt * 10;
  const monthNow = Math.floor(state.time.tick / TICKS_PER_MONTH);
  const monthBefore = Math.floor(before / TICKS_PER_MONTH);
  state.time.month = monthNow % 12;
  state.time.year = Math.floor(monthNow / 12);
  for (let m = monthBefore + 1; m <= monthNow; m++) onMonth(state, m);
  movePeople(state, dt);
}

function onMonth(state, m) {
  const s = state.stats;
  s.people = Math.round(s.people * (1 + (rng(state) - 0.4) * 0.006));
  const income = s.people * (2 + state.era) * (0.8 + rng(state) * 0.4) - s.people * 1.7;
  s.coin = Math.round(s.coin + income);
  state.coinHistory.push(income);
  if (state.coinHistory.length > 12) state.coinHistory.shift();
  s.food = Math.max(0, Math.round(s.food + (rng(state) - 0.45) * s.people * 0.4));
  s.wellbeing = Math.min(0.95, Math.max(0.2, s.wellbeing + (rng(state) - 0.5) * 0.02));
  for (const body of state.bodies) {
    for (const metric of body.metrics) {
      const last = metric.series[metric.series.length - 1];
      metric.series.push(Number((last * (1 + (rng(state) - 0.48) * 0.04)).toFixed(2)));
      if (metric.series.length > 60) metric.series.shift();
    }
  }
  if (m % 12 === 0) {
    const grew = Math.round(s.people * 0.02);
    addEntry(state, 'year', `Year ${state.time.year - 1} ends. ${grew > 0 ? `${grew} more people call it home.` : 'A quiet year.'}`);
  }
  if (m % 3 === 0 && state.docket.length < 3 && rng(state) < 0.55) {
    const base = LATER_CARDS[Math.floor(rng(state) * LATER_CARDS.length)];
    state.docket.push(cloneCard({...base, id: undefined}, state));
  }
  if (m % 4 === 1 && rng(state) < 0.4) {
    const lines = ['The harvest came in well.', 'A new path wears in toward the mill.', 'Two families arrived from downriver.', 'Smoke rises from the new kiln.', 'The river ran high this month.'];
    addEntry(state, 'line', lines[Math.floor(rng(state) * lines.length)]);
  }
}

function movePeople(state, dt) {
  for (const p of state.people) {
    if (rng(state) < dt * 0.15) p.heading += (rng(state) - 0.5) * 2.2;
    p.x += Math.cos(p.heading) * p.speed * dt * 0.6;
    p.z += Math.sin(p.heading) * p.speed * dt * 0.6;
    if (Math.abs(p.x - riverX(p.z)) < 7) p.heading += Math.PI;
  }
}

function addEntry(state, kind, text) {
  const id = (state.chronicle[state.chronicle.length - 1]?.id ?? 0) + 1;
  state.chronicle.push({id, year: state.time.year, month: state.time.month, kind, text, era: state.era});
  if (state.chronicle.length > 400) state.chronicle.shift();
}

// ---- Actions (contract §5) ----

export function rule(state, cardId, optionKey) {
  const card = state.docket.find((c) => c.id === cardId);
  if (!card) return {ok: false, reason: 'missing'};
  const option = card.options.find((o) => o.key === optionKey);
  if (!option) return {ok: false, reason: 'option'};
  state.docket = state.docket.filter((c) => c !== card);
  state.stats.coin -= option.cost ?? 0;
  state.cardHistory.push({id: card.id, from: card.from, choice: optionKey, year: state.time.year});
  if (card.kind !== 'report') addEntry(state, 'decision', `${card.title}: ${option.label.replace(/\.$/, '')}.`);
  return {ok: true};
}

export function dissolveBody(state, bodyId) {
  const body = state.bodies.find((b) => b.id === bodyId);
  if (!body || body.id === 'moot') return {ok: false};
  body.status = 'dissolved';
  addEntry(state, 'decision', `You dissolved ${theName(bodyName(state, body))}.`);
  return {ok: true};
}

export function bodyName(state, body) {
  if (body.kind === 'ward') return `${state.centres?.find((c) => c.id === body.centreId)?.name ?? 'Ward'} Ward Council`;
  const n = BODY_DEFS[body.id]?.name;
  return Array.isArray(n) ? n[state.era] : n ?? body.id;
}

// ---- Dev helpers (exposed on window.hearthvale.dev) ----

export function devAdvanceEra(state) {
  if (state.era >= 5) return;
  state.era++;
  const names = ['hamlet', 'village', 'town', 'borough', 'city', 'metropolis'];
  addEntry(state, 'moment', `Hearthvale is a ${names[state.era]} now.`);
  devFoundBody(state);
}

export function devFoundBody(state) {
  const next = BODY_ORDER.find((id) => !state.bodies.some((b) => b.id === id));
  if (!next) return;
  state.bodies.push(makeBody(state, next, state.time.year));
  addEntry(state, 'moment', `${cap(theName(bodyName(state, {id: next})))} sits for the first time.`);
  const card = CARDS.find((c) => c.from === next && !state.docket.some((d) => d.id === c.id));
  if (card) state.docket.push(cloneCard(card, state));
}

export function devAddCard(state) {
  const base = LATER_CARDS[Math.floor(rng(state) * LATER_CARDS.length)];
  state.docket.push(cloneCard({...base, id: undefined}, state));
}

// ---- Persistence ----

export function serialize(state) {
  return JSON.stringify(state);
}

export function restore(raw) {
  const data = typeof raw === 'string' ? JSON.parse(raw) : raw;
  if (!data || data.version !== 2) {
    const err = new Error('Old save');
    err.code = 'old-version';
    throw err;
  }
  return data;
}

// ---- Render view (contract §6), minimal ----

export function createRenderView(state) {
  const view = {
    buildings: state.buildings, buildingEvents: [], people: new Float32Array(0), peopleCount: 0, peopleDirty: null,
    roads: null, bridges: [], lamps: [], worldEvents: [], weather: state.weather, projects: [],
    time: {}, era: state.era, archetype: state.archetype,
    sync(s) {
      const n = s.people.length;
      if (view.people.length < n * 16) view.people = new Float32Array(n * 16);
      for (let i = 0; i < n; i++) {
        const p = s.people[i], o = i * 16;
        view.people[o] = p.x; view.people[o + 2] = p.z; view.people[o + 12] = p.look.cloth; view.people[o + 15] = p.heading;
      }
      view.peopleCount = n;
      view.peopleDirty = {start: 0, end: n};
      view.buildings = s.buildings;
      view.era = s.era;
      const yearT = (s.time.tick % 600) / 600;
      view.time = {year: s.time.year, month: s.time.month, season: Math.floor(yearT * 4), seasonT: (yearT * 4) % 1, yearT};
    },
  };
  view.sync(state);
  return view;
}
