// The town's voice: small text helpers, shared line templates and a
// dev-time lint for player-facing text (design-systems §10).
//
// The voice is a neighbour who knows the town. Short sentences, one idea
// each, common words, active voice, warm lead-ins. This module has no
// imports so every catalogue can use it.

const SMALL = ['no', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten',
  'eleven', 'twelve'];

// Whole numbers up to twelve read better as words in prose.
export function count(n) {
  const r = Math.round(n);
  return r >= 0 && r < SMALL.length ? SMALL[r] : grouped(r);
}

export function grouped(n) {
  return Math.round(n).toLocaleString('en-GB');
}

export const coin = (n) => `${grouped(Math.max(0, n))} coin`;

export function plural(n, one, many = `${one}s`) {
  return `${count(n)} ${Math.round(n) === 1 ? one : many}`;
}

// ['a', 'b', 'c'] -> 'a, b and c'
export function joinList(items, last = 'and') {
  const list = items.filter(Boolean);
  if (list.length <= 1) return list[0] ?? '';
  return `${list.slice(0, -1).join(', ')} ${last} ${list.at(-1)}`;
}

export const capitalise = (s) => (s ? s[0].toUpperCase() + s.slice(1) : s);

// Fill '{name}' placeholders. Unknown names stay visible so lint catches them.
export function fill(template, vars = {}) {
  return String(template).replace(/\{(\w+)\}/g, (whole, name) =>
    vars[name] === undefined || vars[name] === null ? whole : String(vars[name]));
}

export function yearsText(n) {
  if (n <= 0) return 'this year';
  return n === 1 ? 'next year' : `in ${count(n)} years`;
}

export const SEASONS = ['spring', 'summer', 'autumn', 'winter'];
export const seasonOf = (month) => SEASONS[Math.floor(((month % 12) + 12) % 12 / 3)];

// ---------------------------------------------------------------------------
// Shared lines. Catalogues hold most text; these are the connective pieces.
// ---------------------------------------------------------------------------

export const LINES = {
  bodyFounded: '{name} sits for the first time.',
  bodyRefused: 'You turned down {name}. Its backers will remember.',
  bodyWaning: '{name} has lost heart. It no longer brings plans.',
  bodyDissolved: '{name} is gone. Its seat at the table is empty.',
  bodyDissolvedByYou: 'You closed {name}. Its members go home.',
  bodyRenamed: 'The {old} is now the {name}.',
  bodyDemands: '{name} is strong now. It no longer asks. It demands.',
  ruleAdopted: 'A new rule: {title}.',
  ruleRaised: 'The rule on {title} is stronger now.',
  ruleLowered: 'The rule on {title} is softer now.',
  ruleRepealed: 'The rule on {title} is gone.',
  cardRefused: 'You refused: {title}.',
  cardDeferred: 'You put off: {title}.',
  cardExpired: 'No one ruled on {title}. The moment passed.',
  demandEnacted: '{name} did not wait. It went ahead with {title}.',
  debateWon: '{winner} won the debate. {loser} is sore.',
  report: '{name} reports: {text}',
  againstGrain: 'This goes against the grain of the town. It will cost more and people will grumble.',
  tension: 'Two of your rules pull against each other. {left} and {right}. Nothing moves while both stand.',
  archetype: 'Hearthvale is becoming {archetype}.',
  yearEnd: 'Year {year} ends.',
};

export const ARCHETYPE_NAMES = {
  'market-town': 'a market town',
  mill: 'a mill town',
  port: 'a river port',
  garden: 'a garden town',
  cathedral: 'a cathedral town',
  commune: 'a town of commons',
  exchange: 'a merchant town',
  scholar: 'a town of scholars',
};

export const ERA_NAMES = ['Hamlet', 'Village', 'Town', 'Borough', 'City', 'Metropolis'];

// ---------------------------------------------------------------------------
// Lint. Dev-time only: warns, never throws. Tests assert it stays clean.
// ---------------------------------------------------------------------------

export const MAX_WORDS = 16;

// Clerk words the town never uses. Matched as whole words, any case.
export const BANNED = [
  'stakeholder', 'stakeholders', 'allocate', 'allocation', 'implement', 'implementation',
  'utilise', 'utilize', 'facilitate', 'optimise', 'optimize', 'leverage', 'paradigm',
  'insufficient', 'expenditure', 'revenue', 'municipal', 'initiative', 'metrics', 'metric',
  'sector', 'morbidity', 'mortality', 'infrastructure', 'commence', 'aforementioned',
  'pursuant', 'henceforth', 'stakeholding', 'synergy', 'deliverable', 'parameters',
  'institution', 'institutions', 'policy', 'policies', 'cohort', 'demographic', 'indicator',
  'detected', 'adversely', 'attributable', 'densification',
];

const BANNED_RE = new RegExp(`\\b(${BANNED.join('|')})\\b`, 'i');

// Split prose into sentences. Abbreviation-free text keeps this simple.
export function sentences(text) {
  return String(text)
    .split(/(?<=[.!?])\s+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

export const wordCount = (sentence) => sentence.split(/\s+/).filter((w) => /[A-Za-z0-9]/.test(w)).length;

// -> [{text, issue}] ; empty when the text is fine.
export function lintText(text, {maxWords = MAX_WORDS} = {}) {
  const issues = [];
  if (typeof text !== 'string' || !text.trim()) return issues;
  if (/\{\w+\}/.test(text)) issues.push({text, issue: 'unfilled placeholder'});
  for (const s of sentences(text)) {
    const words = wordCount(s);
    if (words > maxWords) issues.push({text: s, issue: `long sentence (${words} words)`});
    const banned = s.match(BANNED_RE);
    if (banned) issues.push({text: s, issue: `jargon "${banned[1]}"`});
  }
  return issues;
}

// Keys whose string values are shown to the player.
const TEXT_KEYS = new Set(['title', 'summary', 'why', 'pitch', 'tradeoff', 'label', 'text', 'name',
  'petition', 'grumble', 'report', 'line', 'outcome', 'blurb', 'role', 'sentence', 'levelNames',
  'explainer', 'lines', 'done']);

// Walk a catalogue and collect player-facing strings with their paths.
export function collectText(value, path = '', out = [], key = '') {
  if (typeof value === 'string') {
    if (TEXT_KEYS.has(key)) out.push({path, text: value});
  } else if (Array.isArray(value)) {
    value.forEach((v, i) => collectText(v, `${path}[${i}]`, out, key));
  } else if (value && typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) collectText(v, path ? `${path}.${k}` : k, out, k);
  }
  return out;
}

// Lint a whole catalogue. Placeholders are replaced with sample values so
// a filled sentence is what gets measured.
export function lintCatalogue(catalogue, sample = SAMPLE_VARS, opts) {
  const issues = [];
  for (const {path, text} of collectText(catalogue)) {
    for (const issue of lintText(fill(text, sample), opts)) issues.push({path, ...issue});
  }
  return issues;
}

export const SAMPLE_VARS = {
  name: 'the Agricultural Council', old: 'Village Moot', title: 'common grazing', year: 12,
  archetype: 'a mill town', left: 'The wage floor', right: 'Free trade', winner: 'The Guild',
  loser: 'The Exchange', text: 'three wells were dug', cost: '1,600 coin', coin: '300 coin',
  months: 'three', farms: 'six', count: 'four', place: 'the mill ford', district: 'the Low Quarter',
  faction: 'the farmers', people: '120', percent: '12', years: 'three', body: 'the Health Board',
  level: 'two', rate: '10', homes: 'twelve', families: 'twelve', what: 'a bridge', grievance: 'food',
  share: 'a third', season: 'spring', rule: 'The tithe', centre: 'Millbridge', centreId: '2', state: 'worn and creaking',
};

// In development, warn once per catalogue at load time.
export function devLint(label, catalogue) {
  const dev = typeof process !== 'undefined' ? process.env?.NODE_ENV !== 'production'
    : typeof import.meta !== 'undefined' && import.meta.env?.DEV;
  if (!dev) return [];
  const issues = lintCatalogue(catalogue);
  if (issues.length && typeof console !== 'undefined') {
    console.warn(`[voice] ${label}: ${issues.length} text issue(s)`, issues.slice(0, 5));
  }
  return issues;
}
