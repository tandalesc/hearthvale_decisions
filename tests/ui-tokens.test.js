// The Ledger's colour tokens meet WCAG contrast (design-visual §8.9, next-level-review E6):
// text tokens 4.5:1 on the papers they sit on, the focus ring and fills 3:1 (non-text).
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';

const css = readFileSync(new URL('../src/ui/tokens.css', import.meta.url), 'utf8');
const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');

function block(selector) {
  const at = css.indexOf(selector + ' {');
  assert.ok(at >= 0, `tokens.css has ${selector}`);
  const body = css.slice(at, css.indexOf('\n}', at));
  const out = {};
  for (const m of body.matchAll(/--([\w-]+):\s*(#[0-9a-f]{6})\s*;/gi)) out[m[1]] = m[2].toLowerCase();
  return out;
}
const light = block(':root');
const night = {...light, ...block(':root[data-theme="night"]')};

function luminance(hex) {
  const [r, g, b] = [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16) / 255)
    .map(v => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
function contrast(a, b) {
  const [x, y] = [luminance(a), luminance(b)].sort((p, q) => q - p);
  return (x + 0.05) / (y + 0.05);
}

const TEXT = 4.5, NON_TEXT = 3;
// [foreground, background, minimum]
const PAIRS = [
  ['ink', 'paper', TEXT], ['ink', 'paper-2', TEXT], ['ink-2', 'paper', TEXT], ['ink-2', 'paper-2', TEXT],
  ['muted', 'paper', TEXT], ['muted', 'paper-2', TEXT], ['muted', 'paper-card', TEXT],
  ['green', 'paper', TEXT],
  ['green-2-text', 'paper', TEXT], ['green-2-text', 'paper-2', TEXT], ['green-2-text', 'green-soft', TEXT],
  ['river-text', 'paper', TEXT], ['river-text', 'paper-2', TEXT], ['river-text', 'river-soft', TEXT],
  ['rust-text', 'paper', TEXT], ['rust-text', 'paper-2', TEXT], ['rust-text', 'rust-soft', TEXT],
  ['focus', 'paper', NON_TEXT], ['focus', 'paper-2', NON_TEXT], ['focus', 'paper-3', NON_TEXT], ['focus', 'paper-card', NON_TEXT],
  ['green-2', 'paper', NON_TEXT], ['river', 'paper', NON_TEXT], ['rust', 'paper', NON_TEXT],
  ['gold-icon', 'paper', NON_TEXT], ['gold-icon', 'paper-2', NON_TEXT], ['gold-icon', 'paper-3', NON_TEXT], ['gold-icon', 'paper-card', NON_TEXT],
];

for (const [name, theme] of [['light', light], ['night', night]]) {
  test(`${name} theme tokens meet WCAG contrast`, () => {
    const fails = [];
    for (const [fg, bg, min] of PAIRS) {
      assert.ok(theme[fg] && theme[bg], `${name} defines --${fg} and --${bg}`);
      const ratio = contrast(theme[fg], theme[bg]);
      if (ratio < min) fails.push(`--${fg} ${theme[fg]} on --${bg} ${theme[bg]}: ${ratio.toFixed(2)} < ${min}`);
    }
    assert.deepEqual(fails, []);
  });
}

test('the light focus ring also reads as text-grade on paper', () => {
  assert.ok(contrast(light.focus, light.paper) >= TEXT, contrast(light.focus, light.paper).toFixed(2));
});

test('the inline loading screen uses the same paper, ink and muted as tokens.css', () => {
  const boot = /#boot \{([\s\S]*?)\}/.exec(html)[1];
  for (const k of ['paper', 'paper-3', 'ink', 'ink-2', 'muted', 'line', 'green']) {
    const m = new RegExp(`--${k}:\\s*(#[0-9a-f]{6})`, 'i').exec(boot);
    assert.ok(m, `boot defines --${k}`);
    assert.equal(m[1].toLowerCase(), light[k], `boot --${k}`);
  }
});

// components.css colours text with the *-text tokens. The plain --river, --rust and
// --green-2 (3:1) may colour only icons, charts and other non-text marks, and plain
// --gold (2.30:1) colours no icon or text at all: icons take --gold-icon.
const components = readFileSync(new URL('../src/ui/components.css', import.meta.url), 'utf8')
  .replace(/\/\*[\s\S]*?\*\//g, '');
// Non-text marks coloured through currentColor that are not an icon (`.i`).
const NON_TEXT_SELECTORS = new Set(['.tension-pair .pull', '.hchart', '.adv-stats .spark']);
// Decorative glyphs allowed plain --gold.
const GOLD_DECOR = new Set(['.moment-card li::before']);

function rules() {
  const out = [];
  for (const m of components.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    out.push({selectors: m[1].trim().split(',').map((x) => x.trim().replace(/\s+/g, ' ')), body: m[2]});
  }
  return out;
}
const textColour = (body, token) => new RegExp(`(?:^|[;\\s])color:\\s*var\\(--${token}\\)`).test(body);
const isIcon = (sel) => /(^| )\.i$|(^| )svg$/.test(sel.replace(/:[\w-]+(\([^)]*\))?/g, ''));

test('components.css colours text with the text-safe tokens', () => {
  const fails = [];
  for (const {selectors, body} of rules()) {
    for (const token of ['river', 'rust', 'green-2']) {
      if (!textColour(body, token)) continue;
      for (const sel of selectors) if (!isIcon(sel) && !NON_TEXT_SELECTORS.has(sel)) fails.push(`${sel}: color var(--${token}) (use --${token}-text)`);
    }
    if (textColour(body, 'gold')) {
      for (const sel of selectors) if (!GOLD_DECOR.has(sel)) fails.push(`${sel}: color var(--gold) (use --gold-icon)`);
    }
  }
  assert.deepEqual(fails, []);
});

test('the opinion bar hatches its against segment', () => {
  const rule = rules().find((r) => r.selectors.includes('.op-bar .op-against'));
  assert.ok(rule, 'components.css styles .op-bar .op-against');
  assert.match(rule.body, /repeating-linear-gradient/);
});
