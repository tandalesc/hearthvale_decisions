// The inspector's fact sheet: its strict schema, validation and plain-text rendering.
//
// Shared by the browser (src/narrator-client.js, the inspector's "Why?" list) and
// the server (server/narrator.js, which builds the LLM prompt). Pure: imports
// only the question-kind catalogue, which is plain data.
//
// A fact sheet holds facts only, as enums, bounded numbers and short strings
// from a safe charset. Every string here ends up inside an LLM prompt, so
// validateFacts() rejects unknown keys, long or odd strings and anything that
// reads like an instruction.

import {KIND_BY_ID, TRADES, WEALTH, MOODS} from './sim/decisions/kinds.js';

export const FACTS_VERSION = 1;
export const MAX_STRING = 120;
export const MAX_FACTS_BYTES = 2400;

export const ERAS = ['hamlet', 'village', 'town', 'borough', 'city', 'metropolis'];
export const SEASONS = ['spring', 'summer', 'autumn', 'winter'];
export const TASKS = ['work', 'rest', 'shop', 'leisure', 'worship', 'gather', 'build', 'flee', 'travel'];
export const ROADS = ['grass', 'trail', 'track', 'road', 'paved', 'avenue'];
export const SLICE_DIMS = ['district', 'trade', 'wealthBand', 'lifeStage', 'householdType', 'faction', 'newcomer', 'faithBand', 'centre'];
export const STORY_KINDS = [
  'arrived', 'formed', 'moved', 'trade', 'job', 'lost-job', 'home', 'birth', 'death', 'hungry', 'loan',
  'founded', 'closed', 'protest', 'strike', 'petition', 'displaced',
  'built', 'upgraded', 'extended', 'restyled', 'repaired', 'raised', 'derelict', 'converted', 'damaged', 'owner',
];
export const ACTS = ['approved', 'refused', 'deferred', 'delegated', 'lapsed', 'heard'];
export const EFFECTS = ['helped', 'hurt', 'mixed', 'touched'];
export const STANCES = ['for', 'against', 'split'];
export const BUILDING_TYPES = ['home', 'farm', 'workshop', 'mill', 'shop', 'market', 'inn', 'warehouse', 'chapel', 'school',
  'moot', 'park', 'infirmary', 'watch', 'exchange', 'theatre', 'factory', 'quay', 'bridge', 'monument', 'union-hall',
  'library', 'bathhouse'];
export const CONDITIONS = ['good', 'worn', 'shabby', 'failing'];
export const FLAGS = ['heritage', 'derelict', 'scaffold', 'raised'];

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

const int = (min, max) => ({t: 'int', min, max});
const num = (min, max) => ({t: 'num', min, max});
const str = (max = MAX_STRING, {prose = false} = {}) => ({t: 'str', max, prose});
const oneOf = (values) => ({t: 'enum', values});
const bool = () => ({t: 'bool'});
const list = (of, max) => ({t: 'arr', of, max});
const obj = (fields, required = []) => ({t: 'obj', fields, required});

const YEAR = int(-50, 400);
const BAND = oneOf(['low', 'ok', 'high']);
const TREND = oneOf(['rising', 'steady', 'falling']);
const KIND_ID = oneOf(Object.keys(KIND_BY_ID));
const OPTION = {t: 'key', max: 24};   // also checked against the kind's criteria below

export const FACT_SCHEMA = obj({
  v: int(1, 1),
  kind: oneOf(['person', 'household', 'building', 'body']),
  name: str(40),
  year: YEAR,
  season: oneOf(SEASONS),
  era: oneOf(ERAS),
  who: obj({
    stage: oneOf(['young', 'family', 'elder']),
    trade: oneOf(TRADES),
    role: str(60),
    district: str(24),
    home: str(40),
    family: int(1, 60),
    newcomer: bool(),
    since: YEAR,
  }),
  now: obj({
    doing: oneOf(TASKS),
    place: str(40),
    wealth: oneOf(WEALTH),
    wealthTrend: TREND,
    mood: oneOf(MOODS),
    moodTrend: TREND,
    moodOf: str(24),
    energy: BAND,
    food: BAND,
    company: BAND,
    work: oneOf(['working', 'short', 'idle', 'none']),
    hungry: bool(),
    rent: oneOf(['none', 'light', 'heavy']),
  }),
  building: obj({
    type: oneOf(BUILDING_TYPES),
    variant: str(24),
    tier: int(1, 5),
    storeys: int(1, 12),
    age: int(0, 400),
    built: num(0, 1),
    condition: oneOf(CONDITIONS),
    wealth: oneOf(WEALTH),
    material: str(16),
    style: oneOf(ERAS),
    road: oneOf(ROADS),
    roadThen: oneOf(ROADS),
    nearRiver: bool(),
    flags: list(oneOf(FLAGS), 4),
    owner: str(40),
    origin: str(80),
  }, ['type']),
  business: obj({
    type: str(24),
    jobs: int(0, 100000),
    filled: int(0, 100000),
    profit: oneOf(['losing', 'even', 'making']),
    cash: oneOf(['short', 'steady', 'flush']),
    automated: bool(),
    since: YEAR,
  }),
  residents: obj({
    households: int(0, 500),
    people: int(0, 5000),
    families: list(str(40), 3),
    trades: list(oneOf(TRADES), 3),
  }),
  body: obj({
    founded: YEAR,
    status: oneOf(['petition', 'active', 'waning', 'dissolved', 'suspended']),
    power: BAND,
    patience: BAND,
    delegated: bool(),
  }),
  leans: list(obj({
    k: KIND_ID, about: str(48), top: list(obj({o: OPTION, p: num(0, 1)}, ['o', 'p']), 3),
    shift: obj({o: OPTION, dir: oneOf(['up', 'down'])}, ['o', 'dir']),
  }, ['k', 'top']), 4),
  torn: list(obj({
    k: KIND_ID,
    about: str(48),
    a: obj({dim: oneOf(SLICE_DIMS), value: str(24), o: OPTION}, ['dim', 'value', 'o']),
    b: obj({dim: oneOf(SLICE_DIMS), value: str(24), o: OPTION}, ['dim', 'value', 'o']),
  }, ['k', 'a', 'b']), 2),
  story: list(obj({year: YEAR, kind: oneOf(STORY_KINDS), text: str(60), group: str(24)}, ['year', 'kind']), 6),
  rulings: list(obj({
    year: YEAR, act: oneOf(ACTS), what: str(60), fx: oneOf(EFFECTS), by: str(40), stance: oneOf(STANCES),
  }, ['year', 'act', 'what']), 5),
  rules: list(obj({what: str(48), fx: oneOf(['helps', 'hurts']), since: YEAR, by: str(40)}, ['what', 'fx']), 4),
  events: list(obj({year: YEAR, what: str(48)}, ['year', 'what']), 3),
}, ['v', 'kind', 'name', 'year']);

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

// Letters, digits, spaces and light punctuation. No quotes, brackets for code,
// markup, newlines or symbols a prompt could be steered with.
const SAFE = /^[A-Za-z0-9 ,.'()\-/:;&]*$/;
// Catalogue sentences (a card's template text) may also ask and exclaim.
const PROSE_SAFE = /^[A-Za-z0-9 ,.'()\-/:;&?!]*$/;

// Instruction-shaped text has no place in a fact.
const INJECTION = [
  /\b(ignore|disregard|forget|override)\b/i,
  /\b(system|assistant|developer|user)\s*(prompt|message|role|:)/i,
  /\b(instruction|instructions|prompt|jailbreak|pretend|roleplay)\b/i,
  /\byou (are|must|will|should) (now|always|never)\b/i,
  /\b(respond|reply|answer|output|print|say) (only|with|in)\b/i,
  /https?:|www\./i,
];

export class FactsError extends Error {}

export const safeText = (s, {max = MAX_STRING, prose = false} = {}) =>
  typeof s === 'string' && s.length <= max && (prose ? PROSE_SAFE : SAFE).test(s) && !INJECTION.some((re) => re.test(s));

// Make a string fit the charset (used when building facts, never on the server).
export function clean(s, max = 40) {
  return String(s ?? '').replace(/[^A-Za-z0-9 ,.'()\-/:;&]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
}

// Like clean(), keeping ? and ! and straightening curly quotes.
export function cleanProse(s, max = 300) {
  return String(s ?? '').replace(/[‘’]/g, "'").replace(/[“”"]/g, '').replace(/[^A-Za-z0-9 ,.'()\-/:;&?!]/g, ' ')
    .replace(/\s+/g, ' ').trim().slice(0, max);
}

// Schema builders and the checker, for the other fact sheets (src/narrative-prose.js).
export const SPEC = {int, num, str, oneOf, bool, list, obj, key: (max = 24) => ({t: 'key', max})};
export const checkSpec = (spec, value, path = 'facts') => check(spec, value, path);

function check(spec, value, path) {
  const fail = (why) => { throw new FactsError(`${path}: ${why}`); };
  switch (spec.t) {
    case 'int':
      if (!Number.isInteger(value) || value < spec.min || value > spec.max) fail('bad integer');
      return value;
    case 'num':
      if (typeof value !== 'number' || !Number.isFinite(value) || value < spec.min || value > spec.max) fail('bad number');
      return value;
    case 'str':
      if (!safeText(value, {max: spec.max, prose: spec.prose})) fail('bad text');
      return value;
    case 'key':
      if (typeof value !== 'string' || value.length > spec.max || !/^[a-z0-9_]+$/.test(value)) fail('bad key');
      return value;
    case 'enum':
      if (!spec.values.includes(value)) fail('unknown value');
      return value;
    case 'bool':
      if (typeof value !== 'boolean') fail('bad flag');
      return value;
    case 'arr':
      if (!Array.isArray(value) || value.length > spec.max) fail('bad list');
      return value.map((v, i) => check(spec.of, v, `${path}[${i}]`));
    case 'obj': {
      if (!value || typeof value !== 'object' || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) fail('bad object');
      const out = {};
      for (const key of Object.keys(value)) {
        if (!Object.hasOwn(spec.fields, key)) fail(`unknown key ${key.slice(0, 20)}`);
        if (value[key] === undefined) continue;
        out[key] = check(spec.fields[key], value[key], `${path}.${key}`);
      }
      for (const key of spec.required) if (out[key] === undefined) fail(`missing ${key}`);
      return out;
    }
    default:
      return fail('bad schema');
  }
}

// Options must belong to their kind's catalogue.
function checkOptions(facts) {
  const known = (k, o) => Object.hasOwn(KIND_BY_ID[k].criteria, o);
  for (const lean of facts.leans ?? []) {
    for (const {o} of lean.top) if (!known(lean.k, o)) throw new FactsError(`leans: unknown option ${o}`);
    if (lean.shift && !known(lean.k, lean.shift.o)) throw new FactsError('leans: unknown shift option');
  }
  for (const t of facts.torn ?? []) {
    if (!known(t.k, t.a.o) || !known(t.k, t.b.o)) throw new FactsError('torn: unknown option');
  }
}

// -> a clean copy of the facts, or throws FactsError.
export function validateFacts(facts) {
  const text = JSON.stringify(facts ?? null);
  if (!text || text.length > MAX_FACTS_BYTES) throw new FactsError('facts too large');
  const out = check(FACT_SCHEMA, facts, 'facts');
  checkOptions(out);
  return out;
}

// Stable text for hashing: keys sorted at every level.
export function canonicalFacts(facts) {
  const sort = (v) => {
    if (Array.isArray(v)) return v.map(sort);
    if (v && typeof v === 'object') return Object.fromEntries(Object.keys(v).sort().map((k) => [k, sort(v[k])]));
    return v;
  };
  return JSON.stringify(sort(facts));
}

// ---------------------------------------------------------------------------
// Words
// ---------------------------------------------------------------------------

export const TRADE_WORDS = {
  farm: 'farmers', craft: 'makers', trade: 'merchants', labour: 'labourers', clerical: 'clerks',
  clergy: 'clergy', gentry: 'gentry', none: 'out of a trade',
};
const STAGE_WORDS = {young: 'a young household', family: 'a family in its prime', elder: 'an older household'};
const ALONE_WORDS = {young: 'young and living alone', family: 'living alone', elder: 'older and living alone'};
const DOING_WORDS = {
  work: 'at work', rest: 'resting at home', shop: 'shopping', leisure: 'taking it easy', worship: 'at prayer',
  gather: 'in a crowd', build: 'building', flee: 'fleeing', travel: 'on the road',
};
const WORK_WORDS = {working: 'in work', short: 'short of work', idle: 'out of work', none: 'not working'};
const FEEL_WORDS = {energy: {low: 'tired', high: 'full of energy'}, food: {low: 'hungry', high: 'well fed'}, company: {low: 'lonely', high: 'in good company'}};
const CONDITION_WORDS = {good: 'well kept', worn: 'worn', shabby: 'shabby', failing: 'falling down'};
const ROAD_WORDS = {grass: 'open grass', trail: 'a faint trail', track: 'a worn track', road: 'a gravel road', paved: 'a paved street', avenue: 'an avenue'};
const FLAG_WORDS = {heritage: 'It is a treasured old building', derelict: 'It stands empty', scaffold: 'Builders are at work on it', raised: 'It stands raised against floods'};
const PROFIT_WORDS = {losing: 'losing money', even: 'breaking even', making: 'making money'};
const ACT_WORDS = {approved: 'you approved', refused: 'you refused', deferred: 'you put off', delegated: 'you let them decide on', lapsed: 'you let lapse', heard: 'you heard'};
const FX_DONE = {helped: 'It helped them.', hurt: 'It hurt them.', mixed: 'It cut both ways for them.', touched: 'Their own body asked for it.'};
const FX_UNDONE = {helped: 'It would have helped them.', hurt: 'It would have hurt them.', mixed: 'It would have cut both ways for them.', touched: 'Their own body asked for it.'};
const STANCE_WORDS = {for: 'backed it', against: 'opposed it', split: 'were split on it'};
const DIM_WORDS = {
  district: (v) => `their quarter, ${v}`, trade: (v) => `${TRADE_WORDS[v] ?? v}`, wealthBand: (v) => `${v} households`,
  lifeStage: (v) => `${v === 'family' ? 'families' : `${v} households`}`, householdType: (v) => `${v} households`,
  faction: (v) => `the ${v}`, newcomer: (v) => (v === 'yes' ? 'newcomers' : 'old families'), centre: (v) => `folk of ${v}`, faithBand: (v) => `${v === 'high' ? 'devout' : v === 'low' ? 'less devout' : 'churchgoing'} folk`,
};
const STORY_WORDS = {
  arrived: 'came to Hearthvale', formed: 'set up their own household', moved: 'moved house', trade: 'changed trade',
  job: 'found work', 'lost-job': 'lost work', home: 'worked on their home', birth: 'welcomed a child', death: 'lost one of their own',
  hungry: 'went hungry', loan: 'took a loan', founded: 'started a business', closed: 'closed a business',
  protest: 'joined a protest', strike: 'joined a strike', petition: 'petitioned the council', displaced: 'was pushed out',
  built: 'was built', upgraded: 'was upgraded', extended: 'was extended', restyled: 'was refitted in a new style',
  repaired: 'was repaired', raised: 'was raised against floods', derelict: 'fell empty', converted: 'changed use', damaged: 'was damaged', owner: 'changed hands',
};
export const KIND_ABOUT = {
  resident_routine: 'their day', household_stay_move: 'staying or going', choose_trade: 'what the young ones will do',
  react_to_policy: 'the newest rule', faction_stance: 'the open proposal', institution_form_support: 'a new body',
  petition: 'speaking up', festival_participation: 'the festivities', crime_charity: 'getting by',
  event_response: 'hard times', strike_resolve: 'a strike', newcomer_integrate: 'settling in', enterprise_plan: 'the year ahead',
  enterprise_found: 'starting a business', household_home: 'their home', take_loan: 'money troubles', merchant_speculate: 'their coin',
  farm_land: 'their land',
};

// 'Stay in their home.' -> 'stay in their home'
export function optionPhrase(kind, option) {
  const s = KIND_BY_ID[kind]?.criteria?.[option] ?? option.replace(/_/g, ' ');
  return s.replace(/\.$/, '').replace(/^./, (c) => c.toLowerCase());
}

export function chanceWord(p) {
  return p >= 0.75 ? 'very likely to' : p >= 0.5 ? 'likely to' : p >= 0.3 ? 'may' : p >= 0.12 ? 'some chance to' : 'unlikely to';
}

const lower = (s) => (s ? s[0].toLowerCase() + s.slice(1) : s);
const sentence = (s) => (s ? s.replace(/^./, (c) => c.toUpperCase()).replace(/[.]?$/, '.') : '');
const joinAnd = (xs) => (xs.length <= 1 ? xs[0] ?? '' : `${xs.slice(0, -1).join(', ')} and ${xs[xs.length - 1]}`);

// ---------------------------------------------------------------------------
// Rendering: facts -> short plain lines (the prompt body and the "Why?" list)
// ---------------------------------------------------------------------------

const NUMBER_WORDS = ['no', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten', 'eleven', 'twelve'];

// Years as the reader feels them: 'This year', 'Last year', 'Five years ago', 'In year 3'.
export function whenText(year, now) {
  const ago = now - year;
  if (ago <= 0) return 'This year';
  if (ago === 1) return 'Last year';
  if (ago <= 12) return `${NUMBER_WORDS[ago].replace(/^./, (c) => c.toUpperCase())} years ago`;
  return `In year ${year}`;
}

// durable: leave out the passing moment (season, current activity, needs), for
// notes that are kept until something material changes.
export const factLines = (facts, options) => taggedLines(facts, options).map((l) => l.text);

// What a reader most wants to see first in the "Why?" list: your rulings, what
// happened to them, where they are torn and how they are struggling. Identity
// and the date come last; the subject line is left out (it is the panel title).
const WHY_ORDER = ['ruling', 'story', 'torn', 'hard', 'rule', 'business', 'now', 'lean', 'building', 'residents', 'body', 'event', 'who', 'head'];

export function whyOrder(facts, {limit = Infinity} = {}) {
  return taggedLines(facts)
    .map((l, i) => ({...l, i}))
    .filter((l) => l.tag !== 'subject')
    .sort((a, b) => WHY_ORDER.indexOf(a.tag) - WHY_ORDER.indexOf(b.tag) || a.i - b.i)
    .slice(0, limit)
    .map((l) => l.text);
}

// Fact lines, each tagged with the kind of fact it states (see WHY_ORDER).
export function taggedLines(facts, {durable = false} = {}) {
  const f = facts;
  const lines = [];
  const when = (y) => whenText(y, f.year);
  let tag = 'subject';
  const add = (s, as = tag) => s && lines.push({text: sentence(s), tag: as});
  const subject = {person: 'Person', household: 'Household', building: 'Building', body: 'Town body'}[f.kind];
  add(`${subject}: ${f.name}`);
  tag = 'head';
  // Never the season: a note is kept until something material changes, and a writer told
  // "It is spring" opens with the weather ("Spring has come to Hearthvale") whatever the month
  // the reader meets it in.
  add(`It is year ${f.year}${f.era ? `. Hearthvale is a ${f.era}` : ''}`);

  tag = 'who';
  const w = f.who ?? {};
  const whoParts = [];
  if (w.trade) whoParts.push(w.trade === 'none' ? 'without a trade' : `one of the ${TRADE_WORDS[w.trade]}`);
  if (w.role) whoParts.push(w.role);
  if (w.family === 1) whoParts.push(ALONE_WORDS[w.stage] ?? 'living alone');
  else if (w.stage) whoParts.push(`${STAGE_WORDS[w.stage]}${w.family ? ` of ${w.family}` : ''}`);
  else if (w.family) whoParts.push(`a household of ${w.family}`);
  if (whoParts.length) add(`They are ${joinAnd(whoParts)}`);
  if (f.kind === 'building' || f.kind === 'body') {
    if (w.district) add(`It stands in ${w.district}`);
  } else if (w.district || w.home) add(`They live${w.home ? ` in ${w.home}` : ''}${w.district ? ` in ${w.district}` : ''}`);
  if (w.newcomer) add(`They are newcomers${w.since != null ? `, here since ${lower(when(w.since))}` : ''}`);
  else if (w.since != null) add(`Their household was set up ${f.year - w.since > 12 ? `in year ${w.since}` : lower(when(w.since))}`);

  tag = 'now';
  const n = f.now ?? {};
  if (n.doing && !durable) add(`Right now: ${DOING_WORDS[n.doing]}${n.place && !(n.doing === 'rest' && n.place === 'home') ? ` at ${n.place}` : ''}`);
  if (n.work) add(`Work: ${WORK_WORDS[n.work]}`, n.work === 'idle' || n.work === 'short' ? 'hard' : 'now');
  if (n.wealth) add(`Wealth: ${n.wealth}${n.wealthTrend ? `, ${n.wealthTrend}` : ''}`, n.wealth === 'poor' || n.wealthTrend === 'falling' ? 'hard' : 'now');
  if (n.mood) add(`Mood of ${n.moodOf ?? 'their people'}: ${n.mood}${n.moodTrend ? `, ${n.moodTrend}` : ''}`, n.mood === 'angry' || n.mood === 'uneasy' ? 'hard' : 'now');
  // energy, food and company are levels (src/sim/people.js decayNeeds runs them down): low is
  // tired, hungry or lonely. "Needs: energy high" read as the opposite, to Haiku and to us.
  const feel = ['energy', 'food', 'company'].filter((k) => n[k] === 'low' || n[k] === 'high').map((k) => FEEL_WORDS[k][n[k]]);
  if (feel.length && !durable) add(`They feel ${feel.length > 1 ? `${feel.slice(0, -1).join(', ')} and ${feel.at(-1)}` : feel[0]}`,
    ['energy', 'food', 'company'].some((k) => n[k] === 'low') ? 'hard' : 'now');
  if (n.hungry) add('They are going hungry', 'hard');
  if (n.rent && n.rent !== 'none') add(`Rent weighs ${n.rent === 'heavy' ? 'heavily' : 'lightly'} on them`, n.rent === 'heavy' ? 'hard' : 'now');

  tag = 'building';
  const b = f.building;
  if (b) {
    add(`It is a ${b.variant ?? b.type}${b.tier ? `, tier ${b.tier}` : ''}${b.storeys ? `, ${b.storeys} ${b.storeys === 1 ? 'storey' : 'storeys'}` : ''}${b.material ? `, in ${b.material}` : ''}`);
    if (b.built != null && b.built < 1) add(`It is still being built, ${Math.round(b.built * 100)} in 100 done`);
    else if (b.age != null) add(`It is ${b.age} years old and ${CONDITION_WORDS[b.condition] ?? 'standing'}`);
    if (b.wealth) add(`It is a ${{poor: 'modest', middling: 'decent', wealthy: 'fine'}[b.wealth]} property`);
    if (b.road) {
      const then = b.roadThen && b.roadThen !== b.road ? `. When it was built, it faced ${ROAD_WORDS[b.roadThen]}` : '';
      add(`It faces ${ROAD_WORDS[b.road]}${b.nearRiver ? ' near the river' : ''}${then}`);
    }
    if (b.owner) add(`Owner: ${b.owner}`);
    if (b.origin) add(`How it came to be: ${b.origin}`);
    for (const flag of b.flags ?? []) add(FLAG_WORDS[flag], flag === 'derelict' ? 'hard' : 'building');
  }
  tag = 'business';
  const biz = f.business;
  if (biz) {
    add(`Business: a ${biz.type}${biz.since != null ? `, open since year ${biz.since}` : ''}, ${biz.filled ?? 0} of ${biz.jobs ?? 0} jobs filled`);
    if (biz.profit) add(`It is ${PROFIT_WORDS[biz.profit]}${biz.cash ? `, cash ${biz.cash}` : ''}`, biz.profit === 'losing' ? 'hard' : 'business');
    if (biz.automated) add('It runs on machines');
  }
  tag = 'residents';
  const r = f.residents;
  if (r && r.households) {
    add(`Living here: ${r.people} people in ${r.households} household${r.households === 1 ? '' : 's'}${r.families?.length ? ` (${r.families.join(', ')})` : ''}`);
    if (r.trades?.length) add(`Their trades: ${joinAnd(r.trades.map((t) => TRADE_WORDS[t]))}`);
  }
  tag = 'body';
  const body = f.body;
  if (body) {
    add(`Founded in year ${body.founded}; it is ${body.status}`);
    if (body.power) add(`Its power is ${body.power}; its patience is ${body.patience ?? 'ok'}`);
    if (body.delegated) add('You let it decide for itself');
  }

  tag = 'lean';
  for (const lean of f.leans ?? []) {
    const parts = lean.top.map(({o, p}) => `${chanceWord(p)} ${optionPhrase(lean.k, o)}`);
    add(`On ${KIND_ABOUT[lean.k] ?? lean.k}${lean.about ? ` (${lean.about})` : ''}: ${parts.join('; ')}`);
    if (lean.shift) add(`${lean.shift.dir === 'up' ? 'More' : 'Fewer'} of their kind lean to ${optionPhrase(lean.k, lean.shift.o)} than before`);
  }
  tag = 'torn';
  for (const t of f.torn ?? []) {
    const side = (s) => `${DIM_WORDS[s.dim]?.(s.value) ?? s.value} lean to ${optionPhrase(t.k, s.o)}`;
    add(`They are torn on ${KIND_ABOUT[t.k] ?? t.k}${t.about ? ` (${t.about})` : ''}: ${side(t.a)}, but ${side(t.b)}`);
  }
  tag = 'story';
  for (const s of f.story ?? []) {
    const joiner = /^(about|against|from|to|within|settling|for)\b/.test(s.text ?? '') ? ' ' : ', ';
    const what = s.kind === 'home' && s.text ? s.text.replace(/\bit\b/, 'their home') : `${STORY_WORDS[s.kind]}${s.text ? `${joiner}${s.text}` : ''}`;
    add(`${when(s.year)}, ${s.group ? `the ${s.group}` : f.kind === 'building' ? 'it' : 'they'} ${what}`);
  }
  for (const x of f.rulings ?? []) {
    let line = `${when(x.year)}, ${ACT_WORDS[x.act]} ${x.what}${x.by ? `, asked by the ${x.by}` : ''}.`;
    if (x.fx) line += ` ${(x.act === 'approved' || x.act === 'heard' ? FX_DONE : FX_UNDONE)[x.fx]}`;
    if (x.stance) line += ` Their people ${STANCE_WORDS[x.stance]}.`;
    lines.push({text: sentence(line), tag: 'ruling'});
  }
  tag = 'rule';
  for (const x of f.rules ?? []) {
    const since = x.since != null ? ` ${lower(when(x.since))}` : '';
    add(`Rule in force: ${x.what}${x.by ? `, set by ${x.by}${since}` : since}. It ${x.fx} them`);
  }
  for (const e of f.events ?? []) add(`${when(e.year)} in town: ${e.what}`, 'event');
  return lines;
}

// ---------------------------------------------------------------------------
// Material key: what a kept note depends on
//
// Only salient, slowly changing facts: identity, wealth and mood bands, household
// size, work, story entries, rulings, rules and events (all with absolute years).
// Needs, current activity, place, season, leanings, trends, hunger and rent are
// left out, so a note stays valid until something that matters changes.
// ---------------------------------------------------------------------------

const pick = (o, keys) => {
  if (!o) return undefined;
  const out = {};
  for (const k of keys) if (o[k] !== undefined) out[k] = o[k];
  return Object.keys(out).length ? out : undefined;
};

export function materialFacts(f) {
  return {
    kind: f.kind, name: f.name, era: f.era,
    who: pick(f.who, ['stage', 'trade', 'role', 'district', 'home', 'family', 'newcomer', 'since']),
    // Monthly noise (hunger, rent share, short hours) stays out; the story ring
    // records hunger and lost work as they happen.
    now: pick({...f.now, work: f.now?.work === 'short' ? 'working' : f.now?.work}, ['wealth', 'mood', 'moodOf', 'work']),
    building: pick(f.building, ['type', 'variant', 'tier', 'storeys', 'condition', 'wealth', 'material', 'style', 'road', 'flags', 'owner', 'origin']),
    business: pick(f.business, ['type', 'jobs', 'profit', 'automated', 'since']),
    residents: pick(f.residents, ['households', 'families', 'trades']),
    body: f.body,
    story: f.story, rulings: f.rulings, rules: f.rules, events: f.events,
  };
}

// FNV-1a over the canonical material facts: short, stable, and the same in browser and server.
export function hashText(text) {
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 16777619);
  let g = 5381;
  for (let i = 0; i < text.length; i++) g = Math.imul(g, 33) ^ text.charCodeAt(i);
  return `${(h >>> 0).toString(36)}${(g >>> 0).toString(36)}`;
}

export const materialText = (facts) => canonicalFacts(materialFacts(facts));
