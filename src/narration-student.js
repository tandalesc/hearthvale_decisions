// The narration student in the browser: a card's facts in, the asker's quote out.
// A ~700K-parameter model (scripts/narration-student.py) built on the decision student's
// machinery and kernels (src/decision-student.js):
//   memory   one token per triple (scope parts + attribute + value + num * num_dir, layer-
//            normed); free text as the mean of its words. No encoder.
//   decoder  4 causal layers (ReLU or SwiGLU feed-forward) with cached keys and values, cross-attending to the memory,
//            output tied to the word table. Names, places and numbers are role tokens
//            (src/narration-roles.js) put back afterwards.
//   beam     4 candidates; never a role the card lacks, a number or dramatic word its facts
//            lack, a word twice running, or a three-word phrase twice.
//   checks   each candidate goes through the fluency check, the narrator's own card check
//            and a fact-consistency check (narration-consistency.js), and a small quality head (like the decision student's error head) ranks
//            those that pass. Below the bundle's threshold the caller keeps template text.
//
//   const student = loadNarrationStudent(bundle)
//   await student.quote(facts) -> {why, quality, confident} | null
import {decodeWeight, halfToFloat, lnFlat, linFlat, ffnFlat, attendQ, projectFlat} from './decision-student.js';
import {narrationTriples, NARRATION_FEATURES_VERSION} from './narration-features.js';
import {roleTriples, relex, strayRoles} from './narration-roles.js';
import {CHECKS} from './narrative-prose.js';
import {fluency} from './narration-fluency.js';
import {factProblem} from './narration-consistency.js';

export const NARRATION_STUDENT_FORMAT = 'hearthvale-narration-student';
const PIECE = /<[^<>\s]+>|[A-Za-z]+|'[A-Za-z]+|\d+(?:\.\d+)?|[^\sA-Za-z\d]/g;
const PAD = 0, UNK = 1, EOS = 2, BOS = 3, SPECIALS = 4;
const NUMBER_WORDS = {three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12,
  thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17, eighteen: 18, nineteen: 19, twenty: 20, thirty: 30,
  forty: 40, fifty: 50, sixty: 60, seventy: 70, eighty: 80, ninety: 90, hundred: 100, thousand: 1000, dozen: 12, score: 20};
const DRAMA = new Set(['starve', 'starving', 'starvation', 'die', 'dies', 'dying', 'dead', 'death', 'deaths', 'riot', 'riots',
  'famine', 'plague', 'war', 'burn', 'burning', 'murder', 'ruin', 'ruined', 'collapse', 'hungrier', 'survive']);

// text -> word tokens; a piece joined to the one before it is '##piece' (as the trainer).
export function tokens(text) {
  const out = [];
  for (const chunk of String(text).split(/\s+/).filter(Boolean)) {
    (chunk.match(PIECE) ?? []).forEach((p, i) => out.push(i ? `##${p}` : p));
  }
  return out;
}
export const detok = (toks) => toks.reduce((s, t) => (t.startsWith('##') ? s + t.slice(2) : s ? `${s} ${t}` : t), '');

// Subword tokens (scripts/narration-bpe.py): a piece after a space starts with '▁', role
// tokens stay whole, merges apply in rank order. Same as the trainer's BPE class.
export const SPACE = '\u2581';
export function bpeTokenizer(merges) {
  const rank = new Map(merges.map(([a, b], i) => [`${a}\u0000${b}`, i]));
  const cache = new Map();
  const unit = (u) => {
    let word = cache.get(u);
    if (word) return word;
    if (u.replace(/^\u2581/, '').startsWith('<')) word = [u];
    else {
      word = [...u];
      while (word.length > 1) {
        let best = Infinity, at = -1;
        for (let j = 0; j + 1 < word.length; j++) {
          const r = rank.get(`${word[j]}\u0000${word[j + 1]}`);
          if (r !== undefined && r < best) { best = r; at = j; }
        }
        if (at < 0) break;
        word = [...word.slice(0, at), word[at] + word[at + 1], ...word.slice(at + 2)];
      }
    }
    cache.set(u, word);
    return word;
  };
  const encode = (text) => {
    const out = [];
    for (const chunk of String(text).split(/\s+/).filter(Boolean)) {
      (chunk.match(PIECE) ?? []).forEach((p, i) => out.push(...unit(i ? p : SPACE + p)));
    }
    return out;
  };
  encode.detok = (toks) => toks.join('').replaceAll(SPACE, ' ').trim();
  return encode;
}

// One weight from the binary file (scripts/export-narration-student.py): fp16, or int8 / int4
// with an fp16 scale per group of `group` values in a row.
function decodeBinary(meta, blob) {
  if (meta.dtype === 'f16') return Float32Array.from(new Uint16Array(blob, meta.offset, meta.bytes / 2), halfToFloat);
  const [rows, cols] = meta.shape, n = rows * cols, g = meta.group, groups = meta.groups;
  const scales = Float32Array.from(new Uint16Array(blob, meta.scale_offset, rows * groups), halfToFloat);
  const out = new Float32Array(n);
  const q8 = meta.dtype === 'i8' ? new Int8Array(blob, meta.offset, n) : null;
  const q4 = meta.dtype === 'i4' ? new Uint8Array(blob, meta.offset, meta.bytes) : null;
  for (let i = 0; i < n; i++) {
    const r = Math.floor(i / cols), c = i - r * cols;
    let q;
    if (q8) q = q8[i];
    else {
      q = i & 1 ? q4[i >> 1] >> 4 : q4[i >> 1] & 15;
      if (q > 7) q -= 16;
    }
    out[i] = q * scales[r * groups + Math.floor(c / g)];
  }
  return out;
}

// A list item's year field -> years before the sheet's year, else null. As the trainer: the
// triple's num is the offset scaled by narration-features.js (sign·ln(1+|x|) past 1), which the
// model did not read; bundles with vocab.year_ago add a closed "ago:N" scope part instead.
const YEAR_ATTRS = new Set(['year', 'since', 'from', 'to']);
function yearsAgo(scope, attr, num, type) {
  if (type !== 'num' || !YEAR_ATTRS.has(attr) || num === null || num === undefined || !scope.includes(':')) return null;
  const x = Math.abs(Number(num)), k = pyRound(x <= 1 ? x : Math.expm1(x));
  return Number(num) > 0 ? -k : k;
}
// Python's round(): halves to even.
const pyRound = (v) => { const f = Math.floor(v), d = v - f; return d > 0.5 || (d === 0.5 && f % 2 === 1) ? f + 1 : f; };
const agoPart = (k) => (k < 0 ? 'ago:ahead' : k <= 5 ? `ago:${k}` : k <= 10 ? 'ago:6-10' : 'ago:11+');

// bundle: the JSON header; blob: the weights file's bytes (ArrayBuffer) when the header names one.
export function loadNarrationStudent(bundle, blob = null) {
  if (bundle?.format !== NARRATION_STUDENT_FORMAT) throw new Error('Not a narration student bundle');
  if (bundle.features !== NARRATION_FEATURES_VERSION) throw new Error(`Narration features v${bundle.features}, game has v${NARRATION_FEATURES_VERSION}`);
  if (bundle.blob && !(blob instanceof ArrayBuffer)) throw new Error(`Narration weights ${bundle.blob} missing`);
  const cfg = bundle.config, voc = bundle.vocab;
  const W = Object.fromEntries(Object.entries(bundle.weights).map(([k, v]) => [k, {shape: v.shape, data: bundle.blob ? decodeBinary(v, blob) : decodeWeight(v)}]));
  const bpe = voc.bpe ? bpeTokenizer(voc.bpe.merges) : null;
  const tok = bpe ?? tokens, untok = bpe ? bpe.detok : detok;
  const Q = Object.fromEntries(Object.entries(bundle.quality.weights).map(([k, v]) => [k, {shape: v.shape, data: decodeWeight(v)}]));
  const d = cfg.d, e = cfg.e, L = cfg.layers, heads = cfg.heads, V = voc.words.length;
  const index = (list) => new Map(list.map((t, i) => [t, i]));
  const w = index(voc.words), sc = index(voc.scopes), at = index(voc.attrs), va = index(voc.values), tk = index(voc.tasks);
  const row = (name, i, n = e) => W[`${name}.weight`].data.subarray(i * n, (i + 1) * n);

  // Word facts for bans and repeat blocking.
  const roleIds = [], numberWords = [], drama = [], digits = [];
  const key = new Array(V).fill(null), idsOf = new Map();
  voc.words.forEach((t, i) => {
    if (i < SPECIALS) return;
    // As the trainer: whole words are '▁word' tokens with BPE; with words, the token as written.
    const word = bpe ? (t.startsWith(SPACE) ? t.slice(1) : null) : t;
    const lower = bpe ? word?.toLowerCase() : t.replace(/^#+/, '').toLowerCase();
    if (t.replace(/^\u2581/, '').startsWith('<')) roleIds.push(i);
    if (word && Object.hasOwn(NUMBER_WORDS, word.toLowerCase())) numberWords.push(i);
    if (word && DRAMA.has(word.toLowerCase())) drama.push(i);
    if (bpe ? /\d/.test(t) && !t.replace(/^\u2581/, '').startsWith('<') : /^\d+$/.test(t.replace(/^#+/, ''))) digits.push(i);
    if (lower && /^(<.*>|[a-z0-9']+)$/.test(lower)) {
      key[i] = lower;
      if (!idsOf.has(lower)) idsOf.set(lower, []);
      idsOf.get(lower).push(i);
    }
  });

  function encode(triples, roles) {
    const n = triples.length, x = new Float32Array(n * e);
    let unk = 0;
    const factsText = [], agos = [];
    // vocab.stance_who: a stance's lean token also carries its group's words, as the trainer.
    const who = voc.stance_who ? new Map(triples.filter(([s, a, , , t]) => a === 'who' && t === 'text' && s.startsWith('stances:')).map(([s, , v]) => [s, v])) : null;
    triples.forEach(([scope, attr, value, num, type], r) => {
      const o = r * e, add = (vec, s = 1) => { for (let i = 0; i < e; i++) x[o + i] += vec[i] * s; };
      const parts = scope.split(/[:/]/).slice(0, 4).map((p) => sc.get(p) ?? UNK);
      if (voc.record_scopes && scope.includes(':')) parts.push(sc.get(scope) ?? UNK);
      const k = voc.year_ago ? yearsAgo(scope, attr, num, type) : null;
      if (k !== null) {
        parts.push(sc.get(agoPart(k)) ?? UNK);
        agos.push(k);
      }
      for (const p of parts.slice(0, 5)) add(row('scope', p));
      const a = at.get(attr) ?? UNK;
      add(row('attr', a));
      if (type === 'text') {
        let ids = tok(value).map((t) => w.get(t) ?? UNK).slice(0, cfg.max_bag);
        if (!ids.length) ids = [UNK];
        for (const id of ids) add(row('word', id), 1 / ids.length);
        unk += ids.filter((id) => id === UNK).length / ids.length;
        factsText.push(String(value).toLowerCase());
      } else {
        const id = va.get(`${type}:${value}`) ?? UNK;
        add(row('value', id));
        if (id === UNK) unk++;
        const g = attr === 'lean' ? who?.get(scope) : undefined;
        if (g) {
          let ids = tok(g).map((t) => w.get(t) ?? UNK).slice(0, cfg.max_bag);
          if (!ids.length) ids = [UNK];
          for (const i of ids) add(row('word', i), 1 / ids.length);
        }
      }
      if (num !== null && num !== undefined) add(row('num_dir', a), Number(num));
    });
    const mem = lnFlat(linFlat(x, n, e, W['up.weight'].data, null, d), n, d, W, 'state_norm');

    // What this card may not say.
    const nums = new Set([0, 1, 2, ...agos.filter((k) => k > 0 && k <= 12)]);   // "three years ago" when it was
    for (let t of [...factsText, ...Object.values(roles)].join(' ').split(/\s+/)) {
      t = t.replace(/^[.,;:!?]+|[.,;:!?]+$/g, '').replace(/,/g, '');
      if (/^\d+$/.test(t)) nums.add(Number(t));
      if (Object.hasOwn(NUMBER_WORDS, t)) nums.add(NUMBER_WORDS[t]);
    }
    const text = new Set(factsText.join(' ').match(/[a-z]+/g) ?? []);
    const ban = new Uint8Array(V);
    for (const i of [PAD, UNK, BOS]) ban[i] = 1;
    const bare = (i) => (bpe ? voc.words[i].replace(/^\u2581/, '') : voc.words[i]);
    for (const i of roleIds) if (roles[bare(i)] === undefined) ban[i] = 1;
    for (const i of numberWords) if (!nums.has(NUMBER_WORDS[bare(i).toLowerCase()])) ban[i] = 1;
    for (const i of drama) if (!text.has(bare(i).toLowerCase())) ban[i] = 1;
    // With BPE, numbers in the facts come as role tokens and any other digits are banned.
    for (const i of digits) if (bpe || !nums.has(Number(voc.words[i].replace(/^#+/, '')))) ban[i] = 1;
    return {mem, n, unk: unk / Math.max(1, n), ban};
  }

  // One decoder step for one beam: x is its input row (d); cache holds its keys and values.
  function step(x, t, cache, cross) {
    let h = x.slice();
    const pos = W['pos.weight'].data;
    for (let i = 0; i < d; i++) h[i] += pos[t * d + i];
    for (let l = 0; l < L; l++) {
      const p = `decoder.layers.${l}`;
      const sa = `${p}.self_attn`, wq = W[`${sa}.in_proj_weight`].data, bq = W[`${sa}.in_proj_bias`].data;
      const a = lnFlat(h, 1, d, W, `${p}.norm1`);
      const k = linFlat(a, 1, d, wq, bq, d, d), v = linFlat(a, 1, d, wq, bq, d, 2 * d);
      cache[l].k.set(k, t * d);
      cache[l].v.set(v, t * d);
      const self = attendQ(W, sa, linFlat(a, 1, d, wq, bq, d, 0), 1, d, {k: cache[l].k, v: cache[l].v, m: t + 1}, heads);
      for (let i = 0; i < d; i++) h[i] += self[i];
      const ca = `${p}.multihead_attn`, b2 = lnFlat(h, 1, d, W, `${p}.norm2`);
      const q2 = linFlat(b2, 1, d, W[`${ca}.in_proj_weight`].data, W[`${ca}.in_proj_bias`].data, d, 0);
      const crossOut = attendQ(W, ca, q2, 1, d, cross[l], heads);
      for (let i = 0; i < d; i++) h[i] += crossOut[i];
      const ff = feedForward(p, lnFlat(h, 1, d, W, `${p}.norm3`));
      for (let i = 0; i < d; i++) h[i] += ff[i];
    }
    h = lnFlat(h, 1, d, W, 'out_norm');
    const z = linFlat(h, 1, d, W['down.weight'].data, null, e);
    const logits = linFlat(z, 1, e, W['word.weight'].data, W.out_bias.data, V);
    let top = -Infinity;
    for (let i = 0; i < V; i++) if (logits[i] > top) top = logits[i];
    let sum = 0;
    for (let i = 0; i < V; i++) sum += Math.exp(logits[i] - top);
    const lse = top + Math.log(sum);
    let ent = 0;
    for (let i = 0; i < V; i++) {
      const lp = (logits[i] -= lse);
      ent -= Math.exp(lp) * lp;
    }
    return {lp: logits, ent, h};
  }

  // ReLU (linear1/linear2) or SwiGLU (gate/up/down, no biases), as the bundle was trained.
  function feedForward(p, x) {
    if (!W[`${p}.gate.weight`]) return ffnFlat(W, p, x, 1, d);
    const hdim = W[`${p}.gate.weight`].shape[0];
    const g = linFlat(x, 1, d, W[`${p}.gate.weight`].data, null, hdim), u = linFlat(x, 1, d, W[`${p}.up.weight`].data, null, hdim);
    for (let i = 0; i < hdim; i++) g[i] = (g[i] / (1 + Math.exp(-g[i]))) * u[i];
    return linFlat(g, 1, hdim, W[`${p}.down.weight`].data, null, d);
  }

  // The words written so far, as the fluency check sees them.
  const wordsOf = (ids) => (bpe ? untok(ids.map((i) => voc.words[i])).toLowerCase().match(/<[^<>\s]+>|[a-z0-9']+/g) ?? [] : ids.map((i) => key[i]).filter(Boolean));

  const inputRow = (tok) => linFlat(row('word', tok), 1, e, W['up.weight'].data, null, d);

  // check (optional): text so far -> true when it says something the card contradicts; such a
  // beam is dropped at the end of a sentence, so the others get the room.
  async function beam(encoded, task, {k = cfg.beam, alpha = cfg.alpha, block = cfg.block, pause, check} = {}) {
    const {mem, n, ban} = encoded, maxT = cfg.max_tgt;
    const cross = Array.from({length: L}, (_, l) => projectFlat(W, `decoder.layers.${l}.multihead_attn`, mem, n, d));
    const fresh = () => Array.from({length: L}, () => ({k: new Float32Array(maxT * d), v: new Float32Array(maxT * d)}));
    let beams = [{toks: [], score: 0, cache: fresh(), sumLp: 0, minLp: Infinity, sumEnt: 0, sumH: new Float32Array(d)}];
    const finished = [];
    for (let t = 0; t < maxT && beams.length; t++) {
      const options = [];
      for (const b of beams) {
        const x = t === 0 ? W['task.weight'].data.slice(task * d, (task + 1) * d) : inputRow(b.toks[t - 1]);
        const out = step(x, t, b.cache, cross);
        b.out = out;
        const lp = out.lp.slice();
        for (let i = 0; i < V; i++) if (ban[i]) lp[i] = -1e9;
        const words = wordsOf(b.toks);
        const banned = new Set(words.length ? [words.at(-1)] : []);
        if (words.length >= block - 1) {
          const tail = words.slice(-(block - 1)).join(' ');
          for (let j = 0; j + block - 1 < words.length; j++) if (words.slice(j, j + block - 1).join(' ') === tail) banned.add(words[j + block - 1]);
        }
        for (const wd of banned) for (const i of idsOf.get(wd) ?? []) lp[i] = -1e9;
        // Only the best k of this beam can make the overall best k.
        const best = [];
        for (let i = 0; i < V; i++) {
          const s = b.score + lp[i];
          if (best.length < k || s > best.at(-1).s) {
            best.push({s, tok: i});
            best.sort((p, q) => q.s - p.s);
            if (best.length > k) best.pop();
          }
        }
        for (const o of best) options.push({...o, parent: b});
      }
      options.sort((p, q) => q.s - p.s);
      const next = [];
      const taken = new Set();
      for (const o of options.slice(0, k)) {
        if (o.s <= -1e8) continue;
        const p = o.parent, tokLp = p.out.lp[o.tok];
        const child = {toks: [...p.toks, o.tok], score: o.s, sumLp: p.sumLp + tokLp, minLp: Math.min(p.minLp, tokLp),
          sumEnt: p.sumEnt + p.out.ent, sumH: p.sumH.map((v, i) => v + p.out.h[i])};
        if (check && o.tok !== EOS && /[.!?]$/.test(voc.words[o.tok]) && check(untok(child.toks.map((i) => voc.words[i])))) continue;
        if (o.tok === EOS || t === maxT - 1) finished.push({...child, norm: o.s / child.toks.length ** alpha});
        else {
          // The first child takes its parent's cache; others copy only the rows filled so far.
          if (!taken.has(p)) { taken.add(p); child.cache = p.cache; }
          else child.cache = p.cache.map((c) => {
            const k2 = new Float32Array(maxT * d), v2 = new Float32Array(maxT * d), used = (t + 1) * d;
            k2.set(c.k.subarray(0, used)); v2.set(c.v.subarray(0, used));
            return {k: k2, v: v2};
          });
          next.push(child);
        }
      }
      beams = finished.length >= k ? [] : next;
      if (pause) await pause();
    }
    return finished.sort((p, q) => q.norm - p.norm).slice(0, k).map((c) => {
      const len = c.toks.length;
      return {toks: c.toks.filter((x) => x !== EOS), norm: c.norm,
        feats: [c.sumLp / len, c.minLp, c.sumEnt / len, len / cfg.max_tgt, ...c.sumH.map((v) => v / len), c.norm]};
    });
  }

  function quality(feats) {
    const z = feats.map((f, i) => (f - bundle.quality.mean[i]) / bundle.quality.std[i]);
    const h = linFlat(Float32Array.from(z), 1, z.length, Q['0.weight'].data, Q['0.bias'].data, Q['0.weight'].shape[0]);
    for (let i = 0; i < h.length; i++) if (h[i] < 0) h[i] = 0;
    const o = linFlat(h, 1, h.length, Q['2.weight'].data, Q['2.bias'].data, 1)[0];
    return 1 / (1 + Math.exp(-o));
  }

  // The card's quote, or null when no candidate passes. `pause` (optional, async) runs
  // between decoding steps so a caller on the main thread can yield.
  // Greedy first (a third of the time); the full beam only when that quote is not confident.
  async function quote(facts, {pause, beam: width = cfg.beam, adaptive = true} = {}) {
    const {triples, roles} = roleTriples(narrationTriples(facts));
    const encoded = encode(triples, roles);
    const check = (text) => !!factProblem(relex(text, roles), facts);
    if (adaptive && width > 1) {
      const first = await pick(facts, roles, encoded, await beam(encoded, tk.get('card.quote'), {pause, k: 1, check}));
      if (first?.confident) return first;
    }
    return pick(facts, roles, encoded, await beam(encoded, tk.get('card.quote'), {pause, k: width, check}));
  }

  function pick(facts, roles, encoded, cands) {
    const options = Object.fromEntries((facts.options ?? []).map((o) => [o.key, o.tradeoff ?? '']));
    let best = null;
    for (const c of cands) {
      const text = untok(c.toks.map((i) => voc.words[i]));
      if (strayRoles(text, roles).length) continue;
      const words = relex(text, roles);
      if (fluency(words)) continue;
      const checked = CHECKS.card(facts, {why: words, options});
      if (checked.used?.why !== 'llm' || factProblem(checked.prose.why, facts)) continue;
      const q = quality([...c.feats, encoded.unk]);
      if (!best || q > best.quality) best = {why: checked.prose.why, quality: q};
    }
    return best && {...best, confident: best.quality >= bundle.quality.threshold};
  }

  return {version: bundle.version, params: bundle.params, quote, encode, beam, tokens: tok, detok: untok, words: voc.words, threshold: bundle.quality.threshold};
}

// Fetch the newest narration student through /api/students/narration/ (static assets as a fallback).
export async function fetchNarrationStudent({base = '/api/students/', fallbackBase = '/students/', fetcher = (...a) => globalThis.fetch(...a)} = {}) {
  for (const root of [base, fallbackBase]) {
    try {
      const dir = new URL('narration/', new URL(root, globalThis.location?.href ?? 'http://localhost/'));
      const manifest = await (await fetcher(new URL('manifest.json', dir).href)).json();
      const file = manifest.versions?.[manifest.latest];
      if (!file) continue;
      const response = await fetcher(new URL(file, dir).href);
      if (!response.ok) continue;
      const bundle = await response.json();
      const blob = bundle.blob ? await (await fetcher(new URL(bundle.blob, dir).href)).arrayBuffer() : null;
      return loadNarrationStudent(bundle, blob);
    } catch {
      // Try the next root.
    }
  }
  return null;
}

// A lazy local narrator for the prose keeper: the bundle is fetched the first time a card
// needs a quote, and never again if it is missing. yieldEvery (main thread only) lets the
// page breathe every few decoding steps. narrate.info() -> {state: 'idle' | 'loading' |
// 'ready' | 'missing', version} for the settings panel.
export function createLocalNarration({base, fallbackBase, fetcher, yieldEvery = 0} = {}) {
  let loading = null, info = {state: 'idle', version: null};
  let steps = 0;
  const pause = yieldEvery ? () => (++steps % yieldEvery ? null : new Promise((resolve) => setTimeout(resolve, 0))) : undefined;
  const narrate = async (facts) => {
    if (!loading) {
      info = {state: 'loading', version: null};
      loading = fetchNarrationStudent({base, fallbackBase, fetcher}).catch(() => null)
        .then((student) => { info = student ? {state: 'ready', version: student.version} : {state: 'missing', version: null}; return student; });
    }
    const student = await loading;
    return student ? student.quote(facts, {pause}) : null;
  };
  narrate.info = () => info;
  return narrate;
}
