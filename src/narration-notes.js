// Inspector notes (people, households, buildings, bodies): the rules the worker shows a note by,
// and a check that a note does not say what its facts contradict. Shared by the worker
// (cloudflare/narration.js), the narration student's runtime and the training scripts.
//
//   cleanNote(text)          -> the note, unwrapped if Haiku quoted it whole
//   noteOk(text)             -> whether the worker would show it
//   noteProblem(text, facts) -> null | 'material: stone' | 'home: tower' | 'street: paved' | ...
//
// noteProblem reads only claims it can match to a fact field, clause by clause, and leaves a
// clause alone when it is negated or hedged ("not poor", "may grow uneasy"): it rejects only
// what it can see is wrong. The judge's contradictions on 280 held-out notes were mostly these
// slips: the wrong material or kind of building, the wrong street, mood, wealth or work.

// A note wrapped whole in quotation marks ("We are glad of the spring.") loses the marks; one
// that only starts and ends with a quote ("We're short," they say. "We stay.") is left as it is.
// partial: a streamed preview, whose closing mark has not arrived yet.
export function cleanNote(text, {partial = false} = {}) {
  const t = String(text ?? '').trim();
  const whole = /^["“]([^"“”]*)["”]$/.exec(t);
  if (whole) return whole[1].trim();
  if (partial) { const open = /^["“]([^"“”]*)$/.exec(t); if (open) return open[1].trim(); }
  return t;
}

// Whether a finished note is shown (else the client keeps its template note).
export function noteOk(text) {
  text = String(text ?? '').trim();
  return !!text && text.length <= 420 && text.split(/\s+/).length <= 60 && (text.match(/[.!?]+/g) ?? []).length <= 2 && /[.!?]$/.test(text);
}

const HEDGE = /\b(not|no longer|never|nor|n't|if|may|might|could|would|hope|fear|unless|once was|used to)\b/i;
const clausesOf = (text) => String(text).split(/[.;!?]|,\s*(?:and|but|while|though|yet|so)\b|\bbut\b/i).map((c) => c.trim()).filter(Boolean);

// Building and home words: specific enough to contradict (a "house" or "home" can be anything).
const DWELLINGS = ['hut', 'cottage', 'terrace', 'tenement', 'tower', 'townhouse', 'villa', 'apartment', 'flat', 'mansion', 'farmstead', 'windmill', 'smithy', 'chapel', 'church', 'inn', 'school', 'dairy', 'workshop'];
const MATERIALS = {timber: /\b(timber|wooden|wood)\b/, stone: /\bstone\b/, brick: /\bbrick\b/, concrete: /\bconcrete\b/, thatch: /\bthatch(ed)?\b/};
const ROADS = {paved: /\bpaved\b/, avenue: /\bavenue\b/, road: /\bgravel\b/, track: /\btrack\b/, trail: /\btrail\b/, grass: /\b(open grass|grassy)\b/};

const NUMBERS = {one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12, twenty: 20, thirty: 30, forty: 40, fifty: 50};
const num = (w) => NUMBERS[w] ?? (/^\d+$/.test(w) ? Number(w) : null);

function building(c, b, name) {
  const age = /\b(\w+) years? old\b/.exec(c);
  if (age && num(age[1]) !== null && Number.isFinite(b.age) && Math.abs(num(age[1]) - b.age) > 1) return `age: ${b.age}`;
  const m = String(b.material ?? '').toLowerCase();
  for (const [mat, re] of Object.entries(MATERIALS)) {
    if (!re.test(c) || m === mat) continue;
    if (mat === 'thatch' && (m === 'timber' || m === 'stone')) continue;   // a thatched roof on timber or stone
    if (m) return `material: ${mat}`;
  }
  const kind = `${b.variant ?? ''} ${b.type ?? ''} ${name ?? ''}`.toLowerCase();
  for (const w of DWELLINGS) if (new RegExp(`\\b${w}s?\\b`).test(c) && !kind.includes(w)) return `building: ${w}`;
  for (const [road, re] of Object.entries(ROADS)) {
    if (re.test(c) && b.road && road !== b.road && road !== b.roadThen) return `street: ${road}`;
  }
  const bad = /\b(shabby|run-down|rundown|crumbling|falling (down|apart)|tumbledown|decaying|derelict)\b/.test(c) || (/\bworn\b/.test(c) && !/\bworn track\b/.test(c));
  if (bad && b.condition === 'good') return 'condition: worn';
  if (/\b(well kept|well-kept|good repair|good shape|good condition)\b/.test(c) && (b.condition === 'shabby' || b.condition === 'failing')) return 'condition: well kept';
  return null;
}

function people(c, who = {}, now = {}) {
  // "Needs: energy high" means they need rest; reading it as "full of energy" is the slip.
  if (now.energy === 'high' && /\b(full of energy|plenty of energy|energy to spare|so much energy|full of beans|well rested|rested|lively|bright and|raring to go)\b/.test(c)) return 'energy: tired';
  if (now.energy === 'low' && /\b(tired|weary|worn out|exhausted)\b/.test(c)) return 'energy: rested';
  const home = String(who.home ?? '').toLowerCase();
  if (home && !/no home/.test(home)) for (const w of DWELLINGS) if (new RegExp(`\\b(our|their|my|his|her) (little |humble |old |small |new )?${w}\\b`).test(c) && !home.includes(w)) return `home: ${w}`;
  const work = now.work;
  if (work === 'working' && /\b(out of work|no work|without work|jobless|idle|short of work|little work|work is (thin|scarce|short|hard to find))\b/.test(c)) return 'work: working';
  if ((work === 'idle' || work === 'none') && /\b(in work|steady work|plenty of work|good work|(we|they|i) (have|has) work)\b/.test(c)) return `work: ${work}`;
  const wealth = now.wealth;
  if (wealth && wealth !== 'poor' && /\b(poor|money'?s tight|money is tight|hard up|scraping by|penniless)\b/.test(c)) return `wealth: ${wealth}`;
  if (wealth === 'poor' && /\b(wealthy|rich|well off|well-off|prosperous)\b/.test(c)) return 'wealth: poor';
  const mood = now.mood;
  if ((mood === 'angry' || mood === 'uneasy') && /\b(content|cheerful|happy|in good spirits|at ease)\b/.test(c)) return `mood: ${mood}`;
  if ((mood === 'content' || mood === 'glad') && /\b(angry|uneasy|worried|troubled|restless|bitter|discontented|unhappy)\b/.test(c)) return `mood: ${mood}`;
  const heavy = /\b(rent (weighs|sits|presses|bears) (heavy|heavily|hard)|heavy rent|rent is (heavy|high|a burden))\b/.test(c);
  const light = /\b(rent (weighs|sits|rests) (light|lightly)|light rent|rent is (light|low|easy))\b/.test(c);
  if (heavy && now.rent !== 'heavy') return `rent: ${now.rent ?? 'none'}`;
  if (light && now.rent === 'heavy') return 'rent: heavy';
  if (/\b(hungry|going hungry|starv\w*|empty bellies|short of (food|bread)|cupboard is bare)\b/.test(c) && !now.hungry && now.food !== 'low') return 'food: fed';
  return null;
}

function body(c, b = {}) {
  if (/\b(dissolved|disbanded|no more)\b/.test(c) && b.status && b.status !== 'dissolved') return `status: ${b.status}`;
  if (/\b(still (meets|sits|works)|meets (each|every))\b/.test(c) && b.status === 'dissolved') return 'status: dissolved';
  if (/\bpatience\b.*\b(thin|short|low|running out|wearing|frayed)\b/.test(c) && b.patience === 'high') return 'patience: high';
  if (/\bpatience\b.*\b(holds|high|long|steady|plenty)\b/.test(c) && b.patience === 'low') return 'patience: low';
  return null;
}

// Past rulings on the sheet (a body's budgets and asks, a household's petitions), as the card
// check reads a card's past asks (src/narration-consistency.js), in any phrasing a note uses:
// "the council has backed …", "the school that was put off last year", "budget for year 60".
const ACTS = [[/\b(approved|said yes to|backed|granted|agreed to|passed)\b/, 'approved'], [/\b(refused|turned down|said no to|rejected|denied)\b/, 'refused'],
  [/\b(put off|deferred|set aside|delayed|waited on)\b/, 'deferred']];
const RULING_STOP = new Set(['their', 'year', 'years', 'last', 'budget', 'budgets', 'asks', 'ask', 'ward', 'town', 'council', 'this', 'that', 'with', 'from', 'have', 'been',
  'every', 'since', 'again', 'still', 'them', 'they', 'were', 'once', 'ago', 'back', 'approved', 'backed', 'refused', 'deferred', 'granted', 'passed', 'turned', 'down', 'said']);
const content = (s) => (String(s).toLowerCase().match(/[a-z]+/g) ?? []).filter((w) => w.length >= 4 && !RULING_STOP.has(w));
const SMALL = {one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10};
const budgetYear = (what) => Number((/budget for year (\d+)/.exec(String(what)) ?? [])[1]) || null;

function rulingProblem(c, facts) {
  const rulings = facts.rulings ?? [];
  if (!rulings.length) return null;
  const now = facts.year;
  // A budget named by its year must be one of the sheet's.
  const named = /\bbudget (?:for|of) (?:year )?(\d+)\b/.exec(c);
  if (named && !rulings.some((r) => budgetYear(r.what) === Number(named[1]))) return `budget: year ${named[1]}`;
  const act = ACTS.find(([re]) => re.test(c));
  if (!act) return null;
  const thing = content(c);
  const overlap = rulings.map((r) => content(r.what).filter((w) => thing.includes(w)).length);
  const most = Math.max(0, ...overlap);
  // No shared word: a budget ruling is still the one meant when the clause speaks of a budget.
  const matches = most ? rulings.filter((_, i) => overlap[i] === most) : /\bbudgets?\b/.test(c) ? rulings.filter((r) => budgetYear(r.what)) : [];
  if (!matches.length) return null;
  const same = matches.filter((r) => r.act === act[1]);
  if (!same.length) return `ruling: ${act[1]}`;
  // When: "this year", "last year", "N years ago", "in year N", "since year N".
  let ago = null, exact = null;
  if (/\bthis year\b/.test(c)) ago = 0;
  else if (/\blast year\b/.test(c)) ago = 1;
  else { const m = /\b(\w+) years? (ago|back)\b/.exec(c); if (m) ago = SMALL[m[1]] ?? (Number(m[1]) || null); }
  const y = /\b(?:in|since) years? (\d+)\b/.exec(c);
  if (y) exact = Number(y[1]);
  if (ago !== null && !same.some((r) => now - r.year === ago)) return `when: ${ago} years ago`;
  if (exact !== null && !same.some((r) => r.year === exact || budgetYear(r.what) === exact)) return `when: year ${exact}`;
  return null;
}

export function noteProblem(text, facts) {
  if (!facts) return null;
  // A garble that names the same people twice running ("the Fairweathers and the Fairweathers").
  if (/\b((?:the )?[A-Z][a-z]+s?),? and (?:the )?\1\b/.test(String(text))) return 'garble: repeated name';
  for (const raw of clausesOf(text)) {
    if (HEDGE.test(raw)) continue;
    const c = raw.toLowerCase();
    const p = (facts.kind === 'building' ? building(c, facts.building ?? {}, facts.name)
      : facts.kind === 'body' ? body(c, facts.body)
        : people(c, facts.who, facts.now)) ?? rulingProblem(c, facts);
    if (p) return p;
  }
  return null;
}
