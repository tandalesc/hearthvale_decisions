// Does a card quote say something its facts contradict? The narration student can mix up
// details from different parts of a card (whose stance, which past ruling, when), so its
// quotes pass this check as well as the narrator's own before the game shows them.
//
//   factProblem(text, facts) -> null | 'stance: farmers' | 'ruling: alms house' | 'when: ...' | 'count: ...'
//
// It reads three kinds of claim, clause by clause:
//   stances  "<group> ... for it / against it / not much moved"  vs facts.stances (and helps/hurts)
//   rulings  "you approved / refused / put off <thing> [this year / last year / N years ago]"
//            vs facts.past (matched on the thing's content words)
//   counts   "approved / refused / put off <n> of their asks"      vs facts.recent
// Anything it cannot read is left alone: it only rejects what it can see is wrong.

const FOR = /\b(for it|want(s)? it|keen|behind (it|her|him|us|them)|back(s)? it|support(s)? it|in favour|are for|is for|mostly for|cheer)\b/i;
const AGAINST = /\b(against|oppose[sd]?|grumble|will not like|won't like|dislike|resent)\b/i;
const INDIFFERENT = /\b(not much moved|not moved|(do|does)( not|n't) (much )?care|hardly care|either way|indifferent|shrug)\b/i;
const GROUPS = ['farmers', 'labourers', 'merchants', 'makers', 'clergy', 'gentry', 'newcomers', 'clerks', 'scholars', 'sailors', 'fishers',
  'carters', 'smiths', 'weavers', 'traders', 'priests', 'guards', 'boatmen', 'herders', 'miners', 'tanners', 'brewers'];
const NUMBER = {one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, once: 1, twice: 2};
const ACTS = [[/\b(approved|said yes to|backed|granted|agreed to)\b/i, 'approved'], [/\b(refused|turned down|said no to|rejected|denied)\b/i, 'refused'],
  [/\b(put off|deferred|set aside|waited on|delayed)\b/i, 'deferred']];
const STOP = new Set(['their', 'our', 'the', 'a', 'an', 'this', 'that', 'year', 'years', 'last', 'ago', 'budget', 'asks', 'ask', 'one', 'and', 'for', 'with', 'from', 'into', 'more', 'step', 'down', 'up', 'ward', 'town', 'council']);
const LEAN = {for: 'for', back: 'for', against: 'against', oppose: 'against', indifferent: 'indifferent', split: null};

const words = (s) => (String(s).toLowerCase().match(/[a-z]+/g) ?? []).filter((w) => w.length >= 4 && !STOP.has(w));
const groupOf = (who) => String(who).toLowerCase().trim();

function when(clause, now) {
  if (/\bthis year\b/i.test(clause)) return 0;
  if (/\blast year\b/i.test(clause)) return 1;
  const m = /\b(\w+) years? (ago|back)\b/i.exec(clause);
  if (m) return NUMBER[m[1].toLowerCase()] ?? (Number(m[1]) || null);
  const y = /\bin year (\d+)\b/i.exec(clause);
  return y ? now - Number(y[1]) : null;
}

export function factProblem(text, facts) {
  const stances = new Map((facts.stances ?? []).map((s) => [groupOf(s.who), LEAN[s.lean] ?? null]));
  const helps = new Set((facts.helps ?? []).map(groupOf)), hurts = new Set((facts.hurts ?? []).map(groupOf));
  const past = facts.past ?? [];
  const clauses = String(text).split(/[.;!?]|,\s*(?:and|but|while|though|so)\b|\bbut\b/i);
  for (const clause of clauses) {
    const lower = clause.toLowerCase();
    // Stances: one reading per clause; several groups joined by "and" share it.
    const named = GROUPS.filter((g) => new RegExp(`\\b${g}\\b`).test(lower));
    const lean = INDIFFERENT.test(clause) ? 'indifferent' : AGAINST.test(clause) ? 'against' : FOR.test(clause) ? 'for' : null;
    if (named.length && lean && !/\bif\b|\bmay\b|\bmight\b|\bcould\b/.test(lower)) {
      for (const g of named) {
        const known = [...stances.keys()].find((w) => w.startsWith(g.slice(0, 5)) || g.startsWith(w.slice(0, 5)));
        if (known !== undefined) {
          const truth = stances.get(known);
          if (truth && truth !== lean) return `stance: ${g}`;
        } else {
          // A group without a stance in the facts: only "it hurts/helps them" readings are true.
          const hurt = [...hurts].some((h) => g.startsWith(h.slice(0, 4))), help = [...helps].some((h) => g.startsWith(h.slice(0, 4)));
          if ((lean === 'for' && !help) || (lean === 'against' && !hurt) || lean === 'indifferent') return `stance: ${g}`;
        }
      }
    }
    // Counts of recent asks.
    const count = /\b(approved|refused|put off|said yes to|said no to|turned down)\b (\w+) of (their|our|my|her|his) asks/i.exec(clause);
    if (count && facts.recent) {
      const act = ACTS.find(([re]) => re.test(count[1]))[1];
      const n = NUMBER[count[2].toLowerCase()] ?? Number(count[2]);
      if (Number.isFinite(n) && (facts.recent[act] ?? 0) !== n) return `count: ${act}`;
      continue;
    }
    // Rulings: "you <act> <thing>".
    const ruling = /\byou(?: have)?(?: already)? (approved|said yes to|backed|granted|agreed to|refused|turned down|said no to|rejected|denied|put off|deferred|set aside)\b(.*)$/i.exec(clause);
    if (ruling && past.length) {
      const act = ACTS.find(([re]) => re.test(ruling[1]))[1];
      const thing = words(ruling[2]);
      // The past asks that share the most words with the thing named.
      const overlap = past.map((p) => words(p.what).filter((w) => thing.includes(w)).length);
      const most = Math.max(0, ...overlap);
      const matches = most ? past.filter((_, i) => overlap[i] === most) : [];
      if (matches.length) {
        const same = matches.filter((p) => p.act === act);
        if (!same.length) return `ruling: ${thing.slice(0, 3).join(' ')}`;
        const ago = when(clause, facts.year);
        if (ago !== null && !same.some((p) => facts.year - p.year === ago)) return `when: ${thing.slice(0, 3).join(' ')}`;
      }
    }
  }
  return null;
}
