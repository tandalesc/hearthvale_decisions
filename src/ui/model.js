// Normalises selector output (src/sim/view.js, or the dev stub) into the
// shapes the components render. Keeps components simple and tolerant of
// small differences while the sim evolves.
import {coin, num} from './format.js';

const MINOR = new Set(['later', 'defer', 'not-now', 'not_now', 'notnow', 'wait', 'refuse', 'reject', 'neither']);
export const isMinorKey = (key) => MINOR.has(key);

const frac = (v) => (Number.isFinite(v) ? (v > 1.0001 ? v / 100 : v) : NaN);

export function top(t = {}) {
  return {
    ...t,
    season: Number.isFinite(t.season) ? t.season : Math.floor(((t.month ?? 0) % 12) / 3),
    wellbeing: frac(t.wellbeing),
    homes: Number.isFinite(t.homes) ? t.homes : null,
    coinTrend: Number.isFinite(t.coinTrend) ? t.coinTrend : 0,
  };
}

function costLine(card) {
  if (card.costLine) return card.costLine;
  const parts = [];
  if (card.cost > 0) parts.push(`Costs ${coin(card.cost)}.`);
  if (card.upkeep > 0) parts.push(`Upkeep ${num(card.upkeep)} a year.`);
  return parts.join(' ') || null;
}

export function card(c) {
  const debate = c.debate && (c.debate.for?.length || c.debate.against?.length)
    ? {
      for: (c.debate.for ?? []).map((s) => ({label: s.label ?? s.name ?? s.faction, note: s.note ?? (s.split ? 'split' : ''), p: s.p})),
      against: (c.debate.against ?? []).map((s) => ({label: s.label ?? s.name ?? s.faction, note: s.note ?? (s.split ? 'split' : ''), p: s.p})),
    }
    : null;
  return {
    ...c,
    kind: c.kind ?? 'proposal',
    costLine: costLine(c),
    note: c.grainNote ?? null,
    debate,
    options: (c.options ?? []).map((o) => ({
      ...o,
      reactions: (o.reactions ?? []).map((r) => ({faction: r.faction, name: r.name, dir: r.dir})),
    })),
  };
}

// Relative change across the series window (the dashboard says "last five years").
function change(series, value) {
  const s = (series ?? []).filter(Number.isFinite);
  if (s.length < 2) return null;
  const first = s[0], last = Number.isFinite(value) ? value : s[s.length - 1];
  if (Math.abs(first) < 1e-9) return last === first ? 0 : null;
  return (last - first) / Math.abs(first);
}

function explainerLines(e) {
  if (Array.isArray(e)) return e;
  if (typeof e !== 'string' || !e.trim()) return null;
  const sentences = e.match(/[^.!?]+[.!?]+/g)?.map((x) => x.trim()) ?? [e];
  return [sentences[0], sentences.slice(1).join(' ')].filter(Boolean);
}

export function body(b) {
  return {
    ...b,
    cap: b.cap ?? b.delegateCap ?? 0,
    explainer: explainerLines(b.explainer),
    metrics: (b.metrics ?? []).map((m) => ({...m, unit: m.unit === 'coin' || m.unit === 'level' ? '' : m.unit === 'months' ? ' mo' : m.unit, change: change(m.series, m.value)})),
    rules: (b.rules ?? []).map((r) => (typeof r === 'string' ? {id: r} : r)),
  };
}

export function ruleBook(cats = []) {
  return cats
    .filter((c) => c.open !== false)
    .map((c) => ({
      id: c.id,
      name: c.name ?? c.title,
      blurb: c.blurb,
      policies: (c.policies ?? []).filter((p) => (p.level ?? 0) > 0),
    }));
}

export function tensions(t) {
  if (Array.isArray(t)) return {rules: t, torn: []};
  return {
    rules: (t?.rules ?? []).map((r) => ({
      id: r.id,
      a: {id: r.left?.id, title: r.left?.title},
      b: {id: r.right?.id, title: r.right?.title},
      text: r.text ?? r.reason,
      forA: r.left?.backers ?? [],
      forB: r.right?.backers ?? [],
      net: 'Nothing moves while both stand.',
      upkeep: r.upkeep,
    })),
    torn: (t?.torn ?? []).map((x) => ({id: x.id, text: x.text})),
  };
}

export function era(e) {
  if (!e) return null;
  const final = e.final ?? (e.next == null && e.nextEra == null);
  return {
    ...e,
    final: final || e.era >= 5,
    nextName: e.nextName,
    timeProgress: e.timeProgress ?? e.yearT ?? 0,
    ceilingYear: e.ceilingYear ?? (Number.isFinite(e.yearsToCeiling) && Number.isFinite(e.year) ? e.year + e.yearsToCeiling : undefined),
  };
}

export function chronicle(entries = []) {
  return entries.map((e, i) => ({
    ...e,
    kind: e.yearEnd ? 'year' : e.kind ?? 'line',
    // Keyed on the template text, so prose arriving later does not reshuffle lines.
    key: e.id ?? `${e.year}.${e.month ?? 0}.${(e.templateText ?? e.text ?? '').slice(0, 40)}.${i > 0 && entries[i - 1].text === e.text ? i : ''}`,
  }));
}

export function inspect(m) {
  if (!m) return null;
  return {
    ...m,
    subtitle: m.subtitle ?? (m.storeys ? `${m.storeys} ${m.storeys === 1 ? 'storey' : 'storeys'}` : null),
    at: m.at ?? (Number.isFinite(m.x) ? {x: m.x, z: m.z} : null),
  };
}

const REASONS = {
  'no-coin': 'The chest is short. Pick a cheaper choice, or wait for more coin.',
  'no-card': 'That request has already gone.',
  'no-option': 'That choice is no longer open.',
};

export function actionError(result) {
  return result?.text ?? REASONS[result?.reason] ?? result?.error ?? 'That cannot be done right now.';
}
