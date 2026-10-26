// Game-written card quotes, as training data for the narration student.
//
// The hosted narrator writes a card's quote in the asker's voice. These are the
// same kind of quote built straight from the card's facts: the game's own reason,
// then who leans which way and the leader's last ruling on this body's asks, in
// the narrator's own phrasing (src/narrative-prose.js). They are plain and always
// true to the facts, and there is one for every card, so they give the student
// many steady examples next to the fewer, livelier hosted ones.
// scripts/narration-export.js --composed adds them; they pass the same checks.
import {createHash} from 'node:crypto';
import {LEAN_WORDS, ACT_WORDS, pct} from '../src/narrative-prose.js';
import {whenText} from '../src/narrative-schema.js';

const MAX_SENTENCES = 4, MAX_WORDS = 80;
const sentences = (text) => (String(text).match(/[^.!?]+[.!?]+/g) ?? []).length;
const words = (text) => String(text).split(/\s+/).filter(Boolean).length;
const cap = (s) => s[0].toUpperCase() + s.slice(1);

// A few closings, chosen by the card so the same card always reads the same.
const CLOSINGS = {
  plain: ['We ask you to weigh it.', 'It is your call.'],
  warm: ['I hope you will hear us.', 'We would be glad of your help.'],
  sharp: ['We would rather not wait.', 'Say yes or no, but say it soon.'],
};
const MANNER = {blunt: 'sharp', impatient: 'sharp', fiery: 'sharp', proud: 'sharp', kind: 'warm', gentle: 'warm', generous: 'warm', devout: 'warm'};

function stanceSentence(f) {
  const leaning = (f.stances ?? []).filter((s) => ['for', 'against', 'back', 'oppose'].includes(s.lean));
  const s = leaning.sort((a, b) => (b.p ?? 0) - (a.p ?? 0))[0];
  if (!s) return null;
  return `${cap(pct(s.p ?? 0.5))} of the ${s.who}${s.where ? ` in ${s.where}` : ''} are ${LEAN_WORDS[s.lean]}.`;
}

function pastSentence(f) {
  const p = (f.past ?? [])[0];
  if (!p || !ACT_WORDS[p.act]) return null;
  // Rulings are stored as game labels; only those that read as a plain phrase
  // ("a granary", "forming the Planning Office") go into a sentence.
  if (!/^(a|an|the|forming) /.test(p.what) || /[:;,]| or /.test(p.what)) return null;
  return `${whenText(p.year, f.year)}, ${ACT_WORDS[p.act]} ${p.what}.`;
}

export function composeQuote(f) {
  if (!f?.why) return null;
  const pick = createHash('sha256').update(`${f.id}:${f.year}:${f.title}`).digest()[0];
  const manner = (f.asker?.traits ?? []).map((t) => MANNER[t]).find(Boolean) ?? 'plain';
  const closings = CLOSINGS[manner];
  const extras = [stanceSentence(f), pastSentence(f)].filter(Boolean);
  if (pick & 1) extras.reverse();
  // Questions already end the reason ("Which comes first?"); no closing after one.
  if (!/\?\s*$/.test(f.why)) extras.push(closings[(pick >> 1) % closings.length]);
  let text = f.why.trim();
  for (const e of extras) {
    const next = /\?\s*$/.test(text) ? null : `${text} ${e}`;
    if (!next || sentences(next) > MAX_SENTENCES || words(next) > MAX_WORDS) continue;
    text = next;
  }
  return text === f.why.trim() ? null : text;
}
