// Number and time formatting in the town's plain voice.

export const SEASONS = ['Spring', 'Summer', 'Autumn', 'Winter'];
export const SEASON_ICONS = ['sprout', 'sun', 'leaf', 'snow'];
export const ERA_NAMES = ['Hamlet', 'Village', 'Town', 'Borough', 'City', 'Metropolis'];
export const ERA_NUMERALS = ['I', 'II', 'III', 'IV', 'V', 'VI'];
// One swatch strip per era for the chronicle timeline (design-visual §1.3 materials).
export const ERA_SWATCHES = [
  ['#b78a5a', '#e6d7b4', '#c9a24a'],
  ['#9b9a8c', '#c46b4a', '#d9cdb4'],
  ['#a5553c', '#e2cfa9', '#5d6670'],
  ['#9e4f3a', '#efe2c8', '#6b7d8c'],
  ['#c9bfa8', '#7b8794', '#e8e0cc'],
  ['#e9e4d6', '#7fa7b5', '#6c8a58'],
];

export function num(n) {
  if (!Number.isFinite(n)) return '–';
  return Math.round(n).toLocaleString('en-GB');
}

// Short form for tight places: 14,200 → 14.2k, 1,250,000 → 1.3m.
export function short(n) {
  if (!Number.isFinite(n)) return '–';
  const a = Math.abs(n);
  if (a >= 1e6) return `${(n / 1e6).toFixed(a >= 1e7 ? 0 : 1)}m`;
  if (a >= 1e4) return `${(n / 1e3).toFixed(a >= 1e5 ? 0 : 1)}k`;
  return num(n);
}

export function signed(n, digits = 0) {
  if (!Number.isFinite(n) || n === 0) return '±0';
  const s = Math.abs(n).toFixed(digits);
  return `${n > 0 ? '+' : '−'}${Number(s).toLocaleString('en-GB')}`;
}

export function pct(v) {
  return Number.isFinite(v) ? `${Math.round(v * 100)}%` : '–';
}

export function coin(n) {
  return `${num(n)} coin`;
}

export function seasonOf(month) {
  return Math.floor(((month ?? 0) % 12) / 3);
}

export function dateLine(year, month) {
  return `Year ${year ?? 0} · ${SEASONS[seasonOf(month)]}`;
}

export function plural(n, one, many = `${one}s`) {
  return `${num(n)} ${n === 1 ? one : many}`;
}

// Months → "this spring", "in 8 months", "in 2 years".
export function inMonths(m) {
  if (!Number.isFinite(m)) return '';
  if (m <= 0) return 'now';
  if (m < 12) return `in ${plural(Math.ceil(m), 'month')}`;
  const y = Math.round(m / 12);
  return `in ${plural(y, 'year')}`;
}

export function moodWord(mood) {
  if (!Number.isFinite(mood)) return 'Unknown';
  if (mood >= 0.75) return 'Content';
  if (mood >= 0.58) return 'Settled';
  if (mood >= 0.42) return 'Uneasy';
  if (mood >= 0.25) return 'Unhappy';
  return 'Angry';
}

export function trendWord(t) {
  if (!Number.isFinite(t) || Math.abs(t) < 0.01) return 'steady';
  return t > 0 ? 'warming' : 'cooling';
}

// "Parish" → "the Parish"; "The Parish" → "the Parish". For use mid-sentence.
export function theName(name = '') {
  return /^the\s/i.test(name) ? `the ${name.slice(4)}` : `the ${name}`;
}

export function cap(text = '') {
  return text.charAt(0).toUpperCase() + text.slice(1);
}
