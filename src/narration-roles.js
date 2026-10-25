// Role tokens for the narration student: names, places and numbers in a sheet's
// triples become placeholders such as <asker.body>, <stances:0.where>, <place#1> or
// <options:do.cost>, in the triples and in the text the student learns to write.
// The student then works in a small closed vocabulary, can only name what the sheet
// has (the decoder may not emit a role the sheet lacks), and the game puts the real
// words back with relex().
//
//   const {triples, roles} = roleTriples(narrationTriples(facts))
//   delex(text, roles) -> text with role tokens        (training targets)
//   relex(text, roles) -> text with the real words back (student output)
//
// Spans are matched without regard to case: some game labels lower-case a name
// ("old Ford and Crown Hill").

// Text attributes whose whole value is a name.
const ENTITY_ATTRS = new Set(['name', 'body', 'by', 'where', 'district']);
const ENTITY_SCOPES = new Set(['torn']);
// Two or more capitalised words ("Old Ford", "Town Watch"), inside any text.
const PROPER = /\b[A-Z][a-z']+(?:[ -](?:of |the )?[A-Z][a-z']+)+\b/g;
// Words that start a phrase but are not part of the name: articles, and the verbs that open
// option labels ("Back the Festival Society: a playhouse").
const LEADING = /^((the|a|an|our|their|this|that|most|many|some|back|build|form|fund|keep|make|pave|raise|lower|hold|adopt|clear|merge|plan|open|let|found|ask|give|grant|ban|allow|end|start|set) )+/i;
const NUMBER = /\d+(?:,\d{3})*(?:\.\d+)?/g;
const STOP = new Set(['the', 'a', 'an', 'of', 'and', 'in', 'on', 'at', 'to', 'for', 'family', 'house', 'home', 'town']);
export const ROLE = /<[^<>\s]+>/g;

const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const norm = (n) => String(n).replace(/,/g, '');

export function roleTriples(triples) {
  const roles = {};          // token -> text
  const spans = [];          // [text, token], longest first when used
  const numbers = new Map(); // '1654' -> token
  const add = (text, token) => {
    if (!text || roles[token] || STOP.has(text.toLowerCase())) return;
    roles[token] = text;
    spans.push([text, token]);
  };

  // 1. Whole-value names, by role; a person's first name and a body's last word too.
  for (const [scope, attr, value, , type] of triples) {
    if (type !== 'text' || !(ENTITY_ATTRS.has(attr) || ENTITY_SCOPES.has(scope.split(/[:/]/)[0]))) continue;
    const text = String(value).trim();
    if (!/[A-Za-z]/.test(text)) continue;
    const token = `<${scope}.${attr}>`;
    add(text, token);
    const words = text.split(' ');
    if (words.length >= 2 && attr === 'name') add(words[0], `<${scope}.${attr}:first>`);
    if (words.length >= 2 && (attr === 'body' || attr === 'by')) add(words.at(-1), `<${scope}.${attr}:last>`);
  }
  // 2. Numbers that stand alone in a triple, by role.
  for (const [scope, attr, value, num, type] of triples) {
    if (type === 'num' && /^\d[\d,]*(\.\d+)?$/.test(String(value)) && !numbers.has(norm(value))) numbers.set(norm(value), `<${scope}.${attr}>`);
  }
  // 3. Other proper names and numbers inside text, numbered by first appearance.
  let places = 0, nums = 0;
  const known = (s) => spans.some(([t]) => t.toLowerCase() === s.toLowerCase());
  for (const [, , value, , type] of triples) {
    if (type !== 'text') continue;
    for (const m of String(value).matchAll(PROPER)) {
      const s = m[0].replace(LEADING, '').replace(/^[a-z]/, (c) => c.toUpperCase());
      if (s.includes(' ') && !known(s)) add(s, `<place#${places++}>`);
    }
    for (const m of String(value).matchAll(NUMBER)) {
      if (!numbers.has(norm(m[0]))) numbers.set(norm(m[0]), `<num#${nums++}>`);
    }
  }
  for (const [n, token] of numbers) roles[token] = Number(n).toLocaleString('en-US');
  spans.sort((a, b) => b[0].length - a[0].length);
  const table = {spans, numbers};

  const out = triples.map(([scope, attr, value, num, type]) => {
    const own = `<${scope}.${attr}>`;
    if (roles[own] !== undefined && (type === 'text' || type === 'num')) return [scope, attr, own, num, type === 'num' ? 'num' : 'role'];
    return [scope, attr, type === 'text' ? delexWith(String(value), table) : value, num, type];
  });
  return {triples: out, roles, table};
}

// Replace outside role tokens only, so a token is never rewritten.
const outsideRoles = (text, fn) => text.split(/(<[^<>\s]+>)/).map((part, i) => (i % 2 ? part : fn(part))).join('');

function delexWith(text, {spans, numbers}) {
  let out = text;
  for (const [span, token] of spans) {
    // Several words: any case for the first letter, as game labels sometimes lower-case it.
    // One word: exact case, so "church" stays a word while "Church" is the body.
    const pattern = span.includes(' ') ? `[${span[0].toUpperCase()}${span[0].toLowerCase()}]${esc(span.slice(1))}` : esc(span);
    const re = new RegExp(`(?<![A-Za-z'])${pattern}(?![A-Za-z])`, 'g');
    out = outsideRoles(out, (part) => part.replace(re, token));
  }
  return outsideRoles(out, (part) => part.replace(NUMBER, (m) => numbers.get(norm(m)) ?? m));
}

// Text in the sheet's own words -> text with role tokens.
export function delex(text, roles) {
  const spans = Object.entries(roles).filter(([t]) => !/^<(num#|.*\.(cost|upkeep|year|p|n)>)/.test(t) || !/^\d/.test(roles[t]))
    .map(([token, s]) => [s, token]).filter(([s]) => !/^\d[\d,]*$/.test(s)).sort((a, b) => b[0].length - a[0].length);
  const numbers = new Map(Object.entries(roles).filter(([, s]) => /^\d[\d,]*(\.\d+)?$/.test(s)).map(([t, s]) => [norm(s), t]));
  return delexWith(text, {spans, numbers});
}

// Role tokens -> the sheet's words, with a capital at the start of a sentence and
// "a"/"an" to suit the word that follows.
export function relex(text, roles) {
  let out = text.replace(ROLE, (t, i, s) => {
    const v = roles[t];
    if (v === undefined) return t;
    // "The town crier" mid-sentence reads "the town crier".
    return i > 0 && !/[.!?]\s*$/.test(s.slice(0, i)) ? v.replace(/^The /, 'the ') : v;
  });
  out = out.replace(/(^|[.!?]\s+)([a-z])/g, (m, a, b) => a + b.toUpperCase());
  out = out.replace(/\b([Aa])n? (?=([A-Za-z]))/g, (m, a, c) => `${a}${/[aeiouAEIOU]/.test(c) ? 'n' : ''} `);
  return out;
}

// Role tokens that the text uses but the sheet does not have.
export const strayRoles = (text, roles) => (String(text).match(ROLE) ?? []).filter((t) => roles[t] === undefined);
