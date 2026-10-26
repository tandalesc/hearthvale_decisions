// Prose for docket cards and the chronicle: fact-sheet schemas, prompt lines,
// output guardrails and template fallbacks.
//
// Shared by the server (server/narrator.js validates facts and model output)
// and the browser (src/narrator-client.js builds fallbacks). Pure.
//
//   card facts   from cardFacts(state, cardId)            -> {why, options: {key: text}}
//   year facts   from chronicleFacts(state, {year})       -> {text}
//   end facts    from chronicleFacts(state, {end: true})  -> {eras: {era: text}, closing: [s, s, s]}
//
// The model writes prose only. Titles, labels, costs and effects stay with the
// templates. checkCardProse / checkYearProse / checkEndProse turn model output
// into clean prose or a reason to fall back to the template text.

import {SPEC, checkSpec, FactsError, ERAS, SEASONS, cleanProse, whenText} from './narrative-schema.js';
import {TRADES} from './sim/decisions/kinds.js';

const {int, num, str, oneOf, bool, list, obj, key} = SPEC;

export const CARD_KINDS = ['proposal', 'petition', 'event', 'demand', 'debate', 'report'];
export const EFFECT_ACTS = ['adopt', 'raise', 'lower', 'repeal', 'spend', 'build', 'works', 'form', 'more', 'less',
  'event', 'wait', 'displease', 'delegate', 'negotiate', 'loan', 'nothing'];
export const LEANS = ['for', 'against', 'split', 'indifferent', 'back', 'oppose'];
const ACTS = ['approved', 'refused', 'deferred', 'delegated', 'lapsed', 'heard'];
const YEAR = int(-50, 400);
const prose = (max) => str(max, {prose: true});

export const CARD_FACTS_SCHEMA = obj({
  v: int(1, 1),
  type: oneOf(['card']),
  id: key(16),
  kind: oneOf(CARD_KINDS),
  template: str(60),
  category: str(24),
  title: prose(80),
  year: YEAR,
  season: oneOf(SEASONS),
  era: oneOf(ERAS),
  urgency: int(0, 2),
  grain: bool(),
  asker: obj({name: str(40), role: str(24), traits: list(str(16), 3), body: str(40)}, ['name']),
  why: prose(320),
  trigger: list(prose(90), 5),
  place: obj({district: str(24), road: str(16), traffic: oneOf(['quiet', 'busy', 'very busy'])}),
  options: list(obj({
    key: key(16),
    label: prose(60),
    cost: int(0, 1e9),
    upkeep: int(0, 1e9),
    effects: list(obj({act: oneOf(EFFECT_ACTS), what: str(48)}, ['act']), 5),
    tradeoff: prose(180),
  }, ['key', 'label']), 7),
  stances: list(obj({who: str(24), lean: oneOf(LEANS), p: num(0, 1), where: str(24)}, ['who', 'lean']), 9),
  past: list(obj({year: YEAR, act: oneOf(ACTS), what: str(60)}, ['year', 'act', 'what']), 4),
  record: obj({approved: int(0, 9999), refused: int(0, 9999), deferred: int(0, 9999)}),
  recent: obj({approved: int(0, 999), refused: int(0, 999), deferred: int(0, 999)}),
  helps: list(oneOf(TRADES), 6),
  hurts: list(oneOf(TRADES), 6),
  events: list(obj({year: YEAR, what: str(48)}, ['year', 'what']), 2),
}, ['v', 'type', 'id', 'kind', 'title', 'year', 'options']);

export const YEAR_FACTS_SCHEMA = obj({
  v: int(1, 1),
  type: oneOf(['year']),
  year: YEAR,
  era: oneOf(ERAS),
  archetype: str(24),
  people: obj({start: int(0, 1e7), end: int(0, 1e7)}),
  mood: oneOf(['low', 'fair', 'good']),
  lines: list(prose(180), 5),
  rulings: list(obj({act: oneOf(ACTS), what: str(60), by: str(40)}, ['act', 'what']), 4),
  events: list(str(48), 4),
  rules: list(str(48), 3),
  bodies: list(obj({name: str(40), change: oneOf(['founded', 'dissolved'])}, ['name', 'change']), 3),
  moods: list(obj({who: str(24), mood: oneOf(['angry', 'uneasy', 'content', 'glad']), trend: oneOf(['rising', 'falling'])}, ['who', 'mood', 'trend']), 3),
  template: prose(320),
}, ['v', 'type', 'year']);

export const END_FACTS_SCHEMA = obj({
  v: int(1, 1),
  type: oneOf(['end']),
  year: YEAR,
  archetype: str(24),
  eraName: str(16),
  people: int(0, 1e7),
  rules: int(0, 999),
  eras: list(obj({
    era: int(0, 5),
    name: str(16),
    from: YEAR,
    to: YEAR,
    archetype: str(24),
    people: int(0, 1e7),
    moments: list(prose(160), 3),
    founded: list(str(40), 3),
    ruled: obj({approved: int(0, 9999), refused: int(0, 9999)}),
  }, ['era', 'name', 'from', 'to']), 6),
  became: list(prose(180), 4),
  refused: list(str(40), 4),
  // The valley's towns when there are two or more (design-centres §4).
  centres: list(obj({
    id: int(1, 9999),
    name: str(40),
    kind: str(16),
    people: int(0, 1e7),
    character: str(24),
    status: oneOf(['seat', 'merged', 'federated', 'apart']),
    line: prose(180),
  }, ['id', 'name', 'line']), 6),
}, ['v', 'type', 'year', 'eras']);

const SCHEMAS = {card: CARD_FACTS_SCHEMA, year: YEAR_FACTS_SCHEMA, end: END_FACTS_SCHEMA};
export const PROSE_FACTS_BYTES = {card: 2600, year: 2000, end: 4000};

// -> a clean copy, or throws FactsError.
export function validateProseFacts(facts) {
  const schema = SCHEMAS[facts?.type];
  if (!schema) throw new FactsError('facts: unknown type');
  const text = JSON.stringify(facts);
  if (text.length > PROSE_FACTS_BYTES[facts.type]) throw new FactsError('facts too large');
  const out = checkSpec(schema, facts);
  if (out.type === 'card' && new Set(out.options.map((o) => o.key)).size !== out.options.length) throw new FactsError('duplicate option key');
  if (out.type === 'end' && new Set(out.eras.map((e) => e.era)).size !== out.eras.length) throw new FactsError('duplicate era');
  return out;
}

// ---------------------------------------------------------------------------
// Prompt lines
// ---------------------------------------------------------------------------

const EFFECT_WORDS = {
  adopt: (w) => `brings in ${w}`, raise: (w) => `raises ${w}`, lower: (w) => `softens ${w}`, repeal: (w) => `ends ${w}`,
  spend: (w) => `spends ${w || 'town coin'}`, build: (w) => `builds ${w}`, works: (w) => `starts ${w || 'the works'}`,
  form: (w) => `forms ${w}`, more: (w) => `more ${w}`, less: (w) => `less ${w}`, event: (w) => `holds ${w}`,
  wait: (w) => w || 'they ask again later', displease: (w) => `displeases ${w || 'them'}`,
  delegate: (w) => `${w || 'they'} decide and pay from their own purse`, negotiate: () => 'offers half; they may take it or insist',
  loan: (w) => `borrows ${w || 'coin'}`, nothing: () => 'nothing changes',
};
export const LEAN_WORDS = {for: 'for it', against: 'against it', split: 'split', indifferent: 'not much moved', back: 'for it', oppose: 'against it'};
export const ACT_WORDS = {approved: 'you approved', refused: 'you refused', deferred: 'you put off', delegated: 'you let them decide', lapsed: 'you let lapse', heard: 'you heard'};
const countWord = (n) => (n === 1 ? 'one' : n === 2 ? 'two' : n === 3 ? 'three' : `${n}`);
const lower = (s) => (s ? s[0].toLowerCase() + s.slice(1) : s);
export const pct = (p) => (p >= 0.7 ? 'most' : p >= 0.45 ? 'many' : p >= 0.25 ? 'some' : 'a few');

export function effectText(e) {
  return (EFFECT_WORDS[e.act] ?? ((w) => w))(e.what ?? '');
}

export function cardLines(f) {
  const lines = [];
  const a = f.asker ?? {};
  lines.push(`Card: ${f.title} (${f.kind}${f.urgency === 2 ? ', urgent' : ''}).`);
  lines.push(`Asked by ${a.name}${a.role ? `, ${a.role}` : ''}${a.body ? ` of the ${a.body}` : ''}${a.traits?.length ? `. Manner: ${a.traits.join(', ')}` : ''}.`);
  lines.push(`It is ${f.season ?? 'the'} of year ${f.year}. Hearthvale is a ${f.era ?? 'town'}.`);
  if (f.why) lines.push(`Template reason: ${f.why}`);
  for (const t of f.trigger ?? []) lines.push(`Why now: ${t}`);
  if (f.place) lines.push(`Place: ${f.place.district ?? 'the town'}${f.place.road ? `, on ${f.place.road}` : ''}${f.place.traffic ? `, ${f.place.traffic}` : ''}.`);
  if (f.helps?.length) lines.push(`It helps: ${f.helps.join(', ')}.`);
  if (f.hurts?.length) lines.push(`It hurts: ${f.hurts.join(', ')}.`);
  if (f.grain) lines.push('It goes against the grain of the town.');
  for (const s of f.stances ?? []) lines.push(`The ${s.who}${s.where ? ` (most live in ${s.where})` : ''}: ${pct(s.p ?? 0.5)} are ${LEAN_WORDS[s.lean]}.`);
  for (const p of f.past ?? []) lines.push(`Their earlier ask: ${lower(whenText(p.year, f.year))}, ${ACT_WORDS[p.act]} ${p.what}.`);
  if (f.recent) {
    const parts = [['approved', 'approved'], ['refused', 'refused'], ['deferred', 'put off']].filter(([k]) => f.recent[k]).map(([k, w]) => `${w} ${countWord(f.recent[k])}`);
    lines.push(`In the last two years, of their asks you ${parts.join(', ')}.`);
  } else if (f.record) lines.push(`Their record with you: ${f.record.approved ?? 0} approved, ${f.record.refused ?? 0} refused, ${f.record.deferred ?? 0} put off.`);
  for (const e of f.events ?? []) lines.push(`${whenText(e.year, f.year)} in town: ${e.what}.`);
  for (const o of f.options) {
    const effects = (o.effects ?? []).map(effectText).join('; ') || 'nothing changes';
    const money = o.cost ? `costs ${o.cost} coin` : o.upkeep ? `upkeep ${o.upkeep} coin a year` : 'no cost';
    lines.push(`Option ${o.key} "${o.label}": ${effects}; ${money}. Template: ${o.tradeoff ?? ''}`);
  }
  return lines;
}

export function yearLines(f) {
  const lines = [`The year: ${f.year}. Hearthvale is a ${f.era ?? 'town'}${f.archetype ? `, a ${f.archetype}` : ''}.`];
  if (f.people) lines.push(`People: ${f.people.start} at the start, ${f.people.end} at the end.`);
  if (f.mood) lines.push(`Spirits in town: ${f.mood}.`);
  for (const l of f.lines ?? []) lines.push(`Chronicle: ${l}`);
  for (const e of f.events ?? []) lines.push(`Event: ${e}.`);
  for (const r of f.rulings ?? []) lines.push(`Ruling: ${ACT_WORDS[r.act]} ${r.what}${r.by ? `, asked by the ${r.by}` : ''}.`);
  for (const r of f.rules ?? []) lines.push(`New rule: ${r}.`);
  for (const b of f.bodies ?? []) lines.push(`The ${b.name} was ${b.change}.`);
  for (const m of f.moods ?? []) lines.push(`The ${m.who} are ${m.mood}, ${m.trend}.`);
  return lines;
}

export function endLines(f) {
  const lines = [`Year ${f.year}: the chronicle closes. Hearthvale is a ${f.eraName}, a ${f.archetype}, with ${f.people} people and ${f.rules} rules.`];
  for (const e of f.eras) {
    lines.push(`Era ${e.era} (${e.name}), years ${e.from} to ${e.to}${e.archetype ? `, a ${e.archetype}` : ''}${e.people ? `, ${e.people} people at its end` : ''}.`);
    for (const m of e.moments ?? []) lines.push(`  Era ${e.era} moment: ${m}`);
    if (e.founded?.length) lines.push(`  Era ${e.era} new bodies: ${e.founded.join(', ')}.`);
    if (e.ruled) lines.push(`  Era ${e.era} rulings: ${e.ruled.approved} approved, ${e.ruled.refused} refused.`);
  }
  for (const b of f.became ?? []) lines.push(`What it became: ${b}`);
  if (f.refused?.length) lines.push(`Bodies you turned away: ${f.refused.join(', ')}.`);
  for (const c of f.centres ?? []) {
    lines.push(`Town ${c.id}, ${c.name}${c.kind ? `, a ${c.kind}` : ''}${c.people ? ` of ${c.people} people` : ''}${c.character ? `, a ${c.character}` : ''}${c.status ? ` (${c.status})` : ''}: ${c.line}`);
  }
  return lines;
}

// ---------------------------------------------------------------------------
// Guardrails on model output
// ---------------------------------------------------------------------------

const NUMBER_WORDS = {
  three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12, thirteen: 13,
  fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17, eighteen: 18, nineteen: 19, twenty: 20, thirty: 30, forty: 40,
  fifty: 50, sixty: 60, seventy: 70, eighty: 80, ninety: 90, hundred: 100, thousand: 1000, dozen: 12, score: 20,
};

// Every number the facts mention (digits in any string, and numeric values), plus one and two.
export function factNumbers(facts) {
  const nums = new Set([0, 1, 2]);
  const words = new Set();
  const walk = (v) => {
    if (typeof v === 'number') nums.add(Math.round(v));
    else if (typeof v === 'string') {
      for (const m of v.matchAll(/\d[\d,]*/g)) nums.add(Number(m[0].replace(/,/g, '')));
      for (const w of v.toLowerCase().match(/[a-z]+/g) ?? []) if (NUMBER_WORDS[w]) words.add(w);
    } else if (Array.isArray(v)) v.forEach(walk);
    else if (v && typeof v === 'object') Object.values(v).forEach(walk);
  };
  walk(facts);
  for (const w of words) nums.add(NUMBER_WORDS[w]);
  return nums;
}

const ONES = ['one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine'];
const COMPOUND = new RegExp(`\\b(twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety)[- ](${ONES.join('|')})\\b`, 'g');

// A number in the text that the facts never gave.
export function strayNumber(text, nums) {
  for (const m of text.matchAll(/\d[\d,]*(\.\d+)?/g)) {
    const n = Number(m[0].replace(/,/g, ''));
    if (!nums.has(Math.round(n))) return m[0];
  }
  let lower = text.toLowerCase();
  for (const m of lower.matchAll(COMPOUND)) {
    if (!nums.has(NUMBER_WORDS[m[1]] + ONES.indexOf(m[2]) + 1)) return m[0];
  }
  lower = lower.replace(COMPOUND, ' ');
  for (const w of lower.match(/[a-z]+/g) ?? []) {
    if (NUMBER_WORDS[w] && !nums.has(NUMBER_WORDS[w])) return w;
  }
  return null;
}

const sentencesOf = (t) => t.match(/[^.!?]+[.!?]+/g) ?? (t.trim() ? [t] : []);
const wordsOf = (t) => t.trim().split(/\s+/).filter(Boolean).length;
const BAD_TALK = /\b(as an ai|language model|json|the facts|i cannot|i'm sorry|template)\b/i;

// Dramatic words the model reaches for; allowed only when the facts use them too.
const DRAMA = ['starve', 'starving', 'starvation', 'die', 'dies', 'dying', 'dead', 'death', 'deaths', 'riot', 'riots',
  'famine', 'plague', 'war', 'burn', 'burning', 'murder', 'ruin', 'ruined', 'collapse', 'hungrier', 'survive'];

export function factWords(facts) {
  return new Set(JSON.stringify(facts).toLowerCase().match(/[a-z]+/g) ?? []);
}

// A capitalised word inside a sentence that the facts never use: an invented name or place.
const NAME_OK = new Set(['hearthvale', 'i', "i'm", "i'll", "i've", "i'd"]);
function strayName(text, words) {
  for (const sentence of sentencesOf(text)) {
    const tokens = sentence.trim().split(/\s+/).slice(1);
    for (const raw of tokens) {
      const w = raw.replace(/^[^A-Za-z]+|[^A-Za-z']+$/g, '');
      if (!/^[A-Z]/.test(w)) continue;
      const lower = w.toLowerCase().replace(/'s$/, '');
      if (!NAME_OK.has(lower) && !words.has(lower)) return w;
    }
  }
  return null;
}

function checkText(raw, {maxSentences, maxWords, maxChars, nums, words}) {
  if (typeof raw !== 'string') return {reason: 'not text'};
  const text = cleanProse(raw, 2000);
  if (!text) return {reason: 'empty'};
  if (text.length > maxChars) return {reason: 'too long'};
  if (wordsOf(text) > maxWords) return {reason: 'too many words'};
  if (sentencesOf(text).length > maxSentences) return {reason: 'too many sentences'};
  if (!/[.!?]$/.test(text)) return {reason: 'unfinished'};
  if (BAD_TALK.test(text)) return {reason: 'meta talk'};
  const stray = strayNumber(text, nums);
  if (stray) return {reason: `number not in facts: ${stray}`};
  const drama = words && (text.toLowerCase().match(/[a-z]+/g) ?? []).find((w) => DRAMA.includes(w) && !words.has(w));
  if (drama) return {reason: `overstates: ${drama}`};
  const name = words && strayName(text, words);
  if (name) return {reason: `name not in facts: ${name}`};
  return {text};
}

// Words that say which way something moves.
const UP = new Set(['more', 'raise', 'raises', 'raising', 'rise', 'rises', 'grow', 'grows', 'higher', 'stronger', 'strengthen',
  'increase', 'increases', 'lift', 'lifts', 'boost', 'boosts', 'adds', 'add', 'tighten', 'tightens', 'expand', 'expands']);
const DOWN = new Set(['less', 'lower', 'lowers', 'fall', 'falls', 'fewer', 'weaker', 'weaken', 'drop', 'drops', 'cut', 'cuts',
  'reduce', 'reduces', 'ease', 'eases', 'soften', 'softens', 'repeal', 'repeals', 'end', 'ends', 'scrap', 'scraps', 'shrink']);
const DIR_OF = {adopt: 'up', raise: 'up', more: 'up', build: 'up', form: 'up', lower: 'down', repeal: 'down', less: 'down'};
const STOP = new Set(['the', 'a', 'an', 'of', 'and', 'in', 'on', 'for', 'to', 'town', 'rule', 'new']);

// The direction word nearest a noun (before it first, within three words).
function directionNear(tokens, i) {
  for (let d = 1; d <= 3; d++) {
    for (const j of [i - d, i + d]) {
      const t = tokens[j];
      if (UP.has(t)) return 'up';
      if (DOWN.has(t)) return 'down';
    }
  }
  return null;
}

// Does this trade-off text say an effect goes the other way, or misstate the cost?
export function contradiction(text, option) {
  const tokens = text.toLowerCase().match(/[a-z]+/g) ?? [];
  for (const e of option.effects ?? []) {
    const dir = DIR_OF[e.act];
    if (!dir || !e.what) continue;
    const nouns = (e.what.toLowerCase().match(/[a-z]+/g) ?? []).filter((w) => w.length > 3 && !STOP.has(w));
    for (let i = 0; i < tokens.length; i++) {
      if (!nouns.includes(tokens[i])) continue;
      const said = directionNear(tokens, i);
      if (said && said !== dir) return `says ${e.what} goes ${said}`;
    }
  }
  const costs = (option.cost ?? 0) > 0 || (option.upkeep ?? 0) > 0 || (option.effects ?? []).some((e) => e.act === 'spend');
  const lower = text.toLowerCase();
  if (costs && /\b(free|no cost|costs nothing|for nothing|without cost)\b/.test(lower)) return 'says a costly option is free';
  if (!costs && /\b(costs? (coin|money|a lot|much|us)|expensive|we must pay|you must pay)\b/.test(lower)) return 'gives a free option a cost';
  return null;
}

// Stiff, official phrasing the house voice avoids (design-systems §10).
const STIFF = /\b(priority|priorities|prioritise|prioritize|manage|managing|management|resent|resents|ensure|ensures|address the|stakeholders?|initiative|implement|facilitate|regarding|furthermore|moreover|crucial|utili[sz]e|in order to|tracking)\b/i;

const STOPWORDS = new Set(('the a an and or but of to in on at for with by from as is are was were be been it its this that these those ' +
  'we us our you your they them their he she i my me will would could should can may might must not no so if then than ' +
  'there here what who how all any some more most less much many very too just also only now again still yet ' +
  'town coin rule people year years ago last next one two').split(' '));

// The words that carry meaning in a text.
export function contentTokens(text) {
  return new Set((String(text ?? '').toLowerCase().match(/[a-z']+/g) ?? []).map((w) => w.replace(/'s$/, '')).filter((w) => w.length > 2 && !STOPWORDS.has(w)));
}

// Share of the text's content words that the template already had.
export function overlapWithTemplate(text, template) {
  const a = contentTokens(text), t = contentTokens(template);
  if (!a.size) return 1;
  let same = 0;
  for (const w of a) if (t.has(w) || t.has(w.replace(/s$/, '')) || t.has(`${w}s`)) same++;
  return same / a.size;
}

// Concrete words the template cannot know: the place, the road, recent events,
// the factions at stake and where they live, and the player's past rulings.
export function detailTokens(facts) {
  const sources = [facts.place?.district, facts.place?.road, facts.place?.traffic, ...(facts.events ?? []).map((e) => e.what),
    ...(facts.stances ?? []).filter((x) => x.lean !== 'indifferent').flatMap((x) => [x.who, x.where]),
    ...(facts.past ?? []).map((x) => x.what), ...(facts.trigger ?? []), facts.recent ? 'refused turned down put off approved' : ''];
  const template = contentTokens(facts.why);
  const out = new Set();
  for (const src of sources) for (const w of contentTokens(src)) if (!template.has(w)) out.add(w);
  return out;
}

export const MAX_TEMPLATE_OVERLAP = 0.6;

// Why the model's `why` should not replace the template's, or null.
// Worked cards for the prompt (server/narrator.js): the voice to learn, never words to copy.
export const CARD_EXAMPLES = [
  {
    facts: "Pave the lane in Old Ford. Asked by Nell Lark, farmer of the Agricultural Council. Manner: plain-spoken, stubborn. Template reason: The lane turns to mud each spring. Paving would keep carts moving. Place: Old Ford, on a worn track, very busy. Last year in town: a bumper harvest. Earlier ask: last year, you put off a great barn. Options: do (spends town coin; template: It costs coin. Carts move faster.), not_now (template: They will ask again later.), refuse (template: They will not like it.)",
    card: {"why": "The Old Ford track is soup by spring. With last year's big harvest, our carts sank to the axle. You put off our barn. Don't put this off too.", "options": {"do": "It costs coin, but our carts roll again.", "not_now": "They will ask again later.", "refuse": "We'll remember who kept us in the mud."}},
  },
  {
    facts: "A wage floor. Asked by Ivo Holt, steward of the Town Council. Manner: careful, fair-minded. Template reason: Some workers earn too little to eat. A floor would keep families fed. Why now: the gap between rich and poor is high. The labourers (most live in Mill End): most are for it. The merchants: many are against it. Options: do (brings in the wage floor; template: Owners hire fewer hands. Some may buy machines.), not_now (template: They will ask again later.), refuse (template: They will not like it.)",
    card: {"why": "I walked Mill End this winter. Families there work full days and still go short. The labourers want a floor, and the merchants do not. I think it is fair, but it will cost us goodwill somewhere.", "options": {"do": "Families eat better. Owners may take on fewer hands.", "not_now": "The labourers wait another season, and they will grumble.", "refuse": "They will not like it."}},
  },
  {
    facts: "Shorter hours (demand). Asked by Bryn Cobb, mill hand of the Union. Manner: blunt, loyal. Template reason: Long shifts wear people out. Accidents follow. Why now: unrest is high. Last year in town: the workers strike. In the last two years, of their asks you refused two. Options: do (brings in shorter hours; template: Fewer accidents. Owners pay more.), negotiate (template: Offer half. They may take it, or insist.)",
    card: {"why": "You have turned us down twice. Since the strike, the mill floor has stopped asking nicely. Shorter shifts, now.", "options": {"do": "Fewer hands lost to the machines. The owners will pay for it.", "negotiate": "Offer half. We might take it. We might not."}},
  },
  {
    facts: "A summer fair. Asked by Wren Dyer, fiddler of the Festival Society. Manner: merry, restless. Template reason: Summer is coming. A fair would bring traders and lift spirits. Place: the square in Kiln Fields. The merchants (most live in Kiln Fields): most are for it. The clergy: some are against it. Options: do (holds the summer fair; spends town coin; template: Visitors come and spend.), small (holds the summer fair; no cost; template: No cost to the town. A smaller crowd.), refuse (template: They will not like it.)",
    card: {"why": "The square in Kiln Fields is begging for music! The merchants there are already polishing their stalls. The clergy will tut, but they always do.", "options": {"do": "Coin out of the chest, and visitors spending theirs.", "small": "No cost to the town. A smaller crowd.", "refuse": "No fiddles this summer. The Society will sulk."}},
  },
];

const EXAMPLE_WHYS = CARD_EXAMPLES.map((e) => e.card.why).join(' ');

// The asker claiming the leader's rulings as their own ("we put off the quay").
const CLAIMS_RULING = /\bwe (put off|refused|approved|turned down|let lapse|delayed)\b/i;

function whyProblem(text, facts) {
  if (text === facts.why) return 'unchanged game explanation';
  if (STIFF.test(text)) return `stiff phrasing: ${text.match(STIFF)[0]}`;
  if (CLAIMS_RULING.test(text)) return 'claims your rulings as theirs';
  // Shared town names and ordinary words are not copied prose. Require a
  // consecutive phrase from an example that the supplied facts do not contain.
  const exampleWords = EXAMPLE_WHYS.toLowerCase().match(/[a-z']+/g) ?? [];
  const factText = (JSON.stringify(facts).toLowerCase().match(/[a-z']+/g) ?? []).join(' ');
  const textWords = text.toLowerCase().match(/[a-z']+/g) ?? [];
  const examples = exampleWords.join(' ');
  for (let i = 0; i <= textWords.length - 6; i++) {
    const phrase = textWords.slice(i, i + 6).join(' ');
    if (examples.includes(phrase) && !factText.includes(phrase)) return 'copies an example card';
  }
  // 'Ivo thinks we should...' from Ivo himself. Role names ('The town crier') do not count.
  const name = facts.asker?.name?.split(' ')[0];
  if (name && name.length > 2 && !/^(the|a|an)$/i.test(name) && new RegExp(`\\b${name}\\b`).test(text)) return 'speaks of themselves by name';
  // The quote replaces the reason, so repeating its meaning is desirable.
  const details = new Set([...detailTokens(facts), ...contentTokens(facts.why), ...contentTokens(facts.title)]);
  if (details.size && ![...contentTokens(text)].some((w) => details.has(w) || details.has(w.replace(/s$/, '')))) return 'no concrete detail';
  // Batched proposals have x_/y_ keys. A simple lexical guard catches a lost
  // plan, including in previews; this is not a general semantic verifier.
  const plans = facts.options.filter((o) => /^[xy]_/.test(o.key));
  if (plans.some((o) => o.key.startsWith('x_')) && plans.some((o) => o.key.startsWith('y_'))) {
    const spoken = contentTokens(text);
    for (const plan of plans) {
      const subject = plan.label.split(/\b(?:at|in|on|for)\b/i)[0];
      const anchors = [...contentTokens(subject)].filter((w) => !['build', 'form', 'make', 'start', 'hold', 'fund', 'adopt'].includes(w));
      if (anchors.length && !anchors.some((w) => spoken.has(w) || spoken.has(w.replace(/s$/, '')))) return 'omits a competing plan';
    }
  }
  return null;
}

// Why an option line should not replace the template's, or null. A line equal to
// the template passes through unchanged.
function optionProblem(text, option) {
  if (option.tradeoff && text === option.tradeoff) return null;
  if (option.tradeoff && overlapWithTemplate(text, option.tradeoff) >= 0.75) return 'same as the template';
  // A figure in the template line (a purse, a wait) must survive the rewrite.
  const figures = (option.tradeoff ?? '').match(/\d[\d,]*/g) ?? [];
  if (figures.some((n) => !text.includes(n))) return 'drops a figure from the template';
  if (STIFF.test(text)) return `stiff phrasing: ${text.match(STIFF)[0]}`;
  const clash = contradiction(text, option);
  if (clash) return clash;
  const limit = Math.max(12, wordsOf(option.tradeoff ?? '') + 4);
  if (wordsOf(text) > limit) return 'longer than the template line';
  return null;
}

// Model output -> {ok: true, prose, used, reasons} | {ok: false, reason}
//
// Structure must be right (the card's exact option keys). Each field is then
// checked on its own; a field that fails keeps its template text, and `used`
// says which fields are the model's ('llm') and which the template's.
export function checkCardProse(facts, out) {
  if (!out || typeof out !== 'object' || Array.isArray(out)) return {ok: false, reason: 'not an object'};
  if (Object.keys(out).some((k) => k !== 'why' && k !== 'options')) return {ok: false, reason: 'unknown field'};
  const keys = facts.options.map((o) => o.key);
  const given = out.options && typeof out.options === 'object' && !Array.isArray(out.options) ? Object.keys(out.options) : [];
  if (given.length !== keys.length || !keys.every((k) => given.includes(k))) return {ok: false, reason: 'option keys differ'};
  const nums = factNumbers(facts);
  const words = factWords(facts);
  const reasons = {};
  const used = {why: 'template', options: {}};
  const prose = {why: facts.why ?? '', options: {}};

  // Never truncate a quote: the last sentence may contain the actual choice.
  const why = checkText(out.why, {maxSentences: 4, maxWords: 80, maxChars: 560, nums, words});
  const whyBad = why.text ? whyProblem(why.text, facts) : why.reason;
  if (whyBad) reasons.why = whyBad;
  else { prose.why = why.text; used.why = 'llm'; }

  for (const o of facts.options) {
    const t = checkText(out.options[o.key], {maxSentences: 2, maxWords: 24, maxChars: 170, nums, words});
    const bad = t.text ? optionProblem(t.text, o) : t.reason;
    if (bad || !t.text || t.text === o.tradeoff) {
      if (bad && bad !== 'same as the template') reasons[o.key] = bad;
      prose.options[o.key] = o.tradeoff ?? '';
      used.options[o.key] = 'template';
    } else {
      prose.options[o.key] = t.text;
      used.options[o.key] = 'llm';
    }
  }
  return {ok: true, prose, used, reasons};
}

// How many fields of a checked card are the model's.
export const llmFields = (checked) => (checked?.used?.why === 'llm' ? 1 : 0) + Object.values(checked?.used?.options ?? {}).filter((u) => u === 'llm').length;

export function checkYearProse(facts, out) {
  const raw = typeof out === 'string' ? out : out?.text;
  const t = checkText(raw, {maxSentences: 2, maxWords: 45, maxChars: 300, nums: factNumbers(facts), words: factWords(facts)});
  if (!t.text) return {ok: false, reason: t.reason};
  if (STIFF.test(t.text)) return {ok: false, reason: `stiff phrasing: ${t.text.match(STIFF)[0]}`};
  if (facts.template && overlapWithTemplate(t.text, facts.template) > MAX_TEMPLATE_OVERLAP) return {ok: false, reason: 'restates the template'};
  return {ok: true, prose: {text: t.text}};
}

export function checkEndProse(facts, out) {
  if (!out || typeof out !== 'object' || !out.eras || typeof out.eras !== 'object') return {ok: false, reason: 'not an object'};
  const nums = factNumbers(facts);
  const words = factWords(facts);
  const want = facts.eras.map((e) => String(e.era));
  const given = Object.keys(out.eras);
  if (given.length !== want.length || !want.every((k) => given.includes(k))) return {ok: false, reason: 'era keys differ'};
  const eras = [];
  for (const e of facts.eras) {
    const t = checkText(out.eras[String(e.era)], {maxSentences: 4, maxWords: 70, maxChars: 420, nums, words});
    if (!t.text) return {ok: false, reason: `era ${e.era}: ${t.reason}`};
    if (STIFF.test(t.text)) return {ok: false, reason: `era ${e.era}: stiff phrasing: ${t.text.match(STIFF)[0]}`};
    eras.push({era: e.era, text: t.text});
  }
  if (!Array.isArray(out.closing) || out.closing.length !== 3) return {ok: false, reason: 'closing must be three sentences'};
  const closing = [];
  for (const s of out.closing) {
    const t = checkText(s, {maxSentences: 1, maxWords: 30, maxChars: 200, nums, words});
    if (!t.text) return {ok: false, reason: `closing: ${t.reason}`};
    closing.push(t.text);
  }
  const prose = {eras, closing};
  // Each town's line stands or falls on its own: a refused one keeps its template line.
  if (facts.centres?.length) {
    const given = out.centres && typeof out.centres === 'object' && !Array.isArray(out.centres) ? out.centres : {};
    const reasons = {};
    prose.centres = facts.centres.map((c) => {
      const t = checkText(given[String(c.id)], {maxSentences: 2, maxWords: 40, maxChars: 300, nums, words});
      const stiff = t.text && STIFF.test(t.text);
      if (t.text && !stiff) return {id: c.id, text: t.text};
      reasons[c.id] = stiff ? 'stiff phrasing' : t.reason;
      return {id: c.id, text: c.line};
    });
    return {ok: true, prose, ...(Object.keys(reasons).length ? {reasons: {centres: reasons}} : {})};
  }
  return {ok: true, prose};
}

export const CHECKS = {card: checkCardProse, year: checkYearProse, end: checkEndProse};

// ---------------------------------------------------------------------------
// Template fallbacks (used when the model is away or its output is refused)
// ---------------------------------------------------------------------------

export function cardFallback(facts) {
  return {why: facts.why ?? '', options: Object.fromEntries(facts.options.map((o) => [o.key, o.tradeoff ?? '']))};
}

export const yearFallback = (facts) => ({text: facts.template ?? `Year ${facts.year} ends.`});

export function endFallback(facts) {
  const eras = facts.eras.map((e) => {
    const parts = [`From year ${e.from} to year ${e.to}, Hearthvale was a ${e.name.toLowerCase()}${e.archetype ? `, a ${e.archetype}` : ''}.`];
    if (e.moments?.[0]) parts.push(e.moments[0]);
    if (e.founded?.length) parts.push(`The ${e.founded[0]} first sat in these years.`);
    return {era: e.era, text: parts.join(' ')};
  });
  const closing = (facts.became ?? []).slice(0, 3);
  return {eras, closing, ...(facts.centres?.length ? {centres: facts.centres.map((c) => ({id: c.id, text: c.line}))} : {})};
}

export const FALLBACKS = {card: cardFallback, year: yearFallback, end: endFallback};
