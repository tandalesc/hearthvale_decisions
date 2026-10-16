// Town opinion: a rough read of how the whole town feels about a card, built
// from the faction stances already on it (card.stances, and per side in a
// debate). No new questions: each faction's stance probabilities are weighted
// by its share of the people. Pure; reads state, never writes.
//
// opinionOf(state, stances) -> {
//   verdict: 'popular' | 'divisive' | 'unpopular' | 'indifferent' | 'forming',
//   word, for, against, indifferent, split (shares 0..1, for + against + indifferent = 1),
//   controversy 0..1 (twice the smaller camp, plus half the split share),
//   heard 0..1 (share of the people whose faction has a stance on record),
//   factions: [{faction, name, share, stance, for, against, indifferent}] (largest first)
// }

// A faction that is split counts half for and half against.
const ALIAS = {for: 'for', back: 'for', against: 'against', oppose: 'against', split: 'split', indifferent: 'indifferent'};

export const VERDICT_WORDS = {
  popular: 'Popular', divisive: 'Divisive', unpopular: 'Unpopular', indifferent: 'Indifferent', forming: 'Opinion forming…',
};

// Below this share of the people heard, the read is still forming.
const MIN_HEARD = 0.5;

const r2 = (x) => Math.round(x * 100) / 100;

// Probabilities over for / against / split / indifferent, from either the full
// distribution or (older saves) just the top stance and its weight.
function leanOf(s) {
  const out = {for: 0, against: 0, split: 0, indifferent: 0};
  if (s?.probs && Object.keys(s.probs).length) {
    for (const [k, v] of Object.entries(s.probs)) {
      const to = ALIAS[k];
      if (to && Number.isFinite(v) && v > 0) out[to] += v;
    }
  } else {
    const top = ALIAS[s?.stance];
    if (!top) return null;
    const p = Number.isFinite(s.p) ? Math.max(0, Math.min(1, s.p)) : 0.6;
    out[top] = p;
    const rest = Object.keys(out).filter((k) => k !== top);
    for (const k of rest) out[k] = (1 - p) / rest.length;
  }
  const total = out.for + out.against + out.split + out.indifferent;
  if (!(total > 0)) return null;
  for (const k of Object.keys(out)) out[k] /= total;
  return out;
}

// The stance that speaks for a faction: its own, or (if it split after the
// card was drawn up) its parent's, or (if it merged back) its parts' averaged.
function stanceFor(state, f, stances) {
  if (stances[f.id]) return stances[f.id];
  if (f.parent && stances[f.parent]) return stances[f.parent];
  const parts = Object.keys(stances).filter((id) => id.startsWith(`${f.id}:`));
  if (!parts.length) return null;
  const probs = {};
  for (const id of parts) {
    const lean = leanOf(stances[id]);
    if (!lean) continue;
    for (const [k, v] of Object.entries(lean)) probs[k] = (probs[k] ?? 0) + v / parts.length;
  }
  return {probs};
}

// Most factions that a plan barely touches still lean a little each way, so
// the bar is judged on the gap between the camps, not on their ratio.
export function verdictOf({for: F, against: A, indifferent: I, split: S = 0}) {
  if (I >= 0.5 || F + A < 0.4) return 'indifferent';
  if (Math.abs(F - A) < 0.08 || Math.min(F, A) >= 0.3 || S >= 0.25) return 'divisive';
  return F > A ? 'popular' : 'unpopular';
}

export const controversyOf = ({for: F, against: A, split: S = 0}) => Math.min(1, 2 * Math.min(F, A) + S / 2);

export function opinionOf(state, stances = {}) {
  const factions = (state.factions ?? []).filter((f) => (f.size ?? 0) > 0);
  const people = factions.reduce((n, f) => n + f.size, 0);
  let F = 0, A = 0, I = 0, S = 0, heardPeople = 0;
  const rows = [];
  for (const f of factions) {
    const s = stanceFor(state, f, stances ?? {});
    const lean = s && leanOf(s);
    if (!lean) continue;
    heardPeople += f.size;
    const w = f.size;
    F += w * (lean.for + lean.split / 2);
    A += w * (lean.against + lean.split / 2);
    I += w * lean.indifferent;
    S += w * lean.split;
    const stance = ALIAS[s.stance] ?? Object.keys(lean).reduce((a, b) => (lean[b] > lean[a] ? b : a), 'indifferent');
    rows.push({faction: f.id, name: f.name ?? f.id, share: people ? r2(f.size / people) : 0, stance,
      for: r2(lean.for + lean.split / 2), against: r2(lean.against + lean.split / 2), indifferent: r2(lean.indifferent)});
  }
  rows.sort((a, b) => b.share - a.share || a.faction.localeCompare(b.faction));
  const heard = people ? heardPeople / people : 0;
  if (!heardPeople || heard < MIN_HEARD) {
    return {verdict: 'forming', word: VERDICT_WORDS.forming, for: 0, against: 0, indifferent: 0, split: 0,
      controversy: 0, heard: r2(heard), factions: rows};
  }
  const shares = {for: F / heardPeople, against: A / heardPeople, indifferent: I / heardPeople, split: S / heardPeople};
  const verdict = verdictOf(shares);
  return {verdict, word: VERDICT_WORDS[verdict], for: r2(shares.for), against: r2(shares.against),
    indifferent: r2(Math.max(0, 1 - r2(shares.for) - r2(shares.against))), split: r2(shares.split),
    controversy: r2(controversyOf(shares)), heard: r2(heard), factions: rows};
}
