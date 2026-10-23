// A small student model that answers decision questions locally, in place of
// the decision model (docs/design/decision-distillation.md). Plain JS, no
// runtime library: it runs in the sim worker, on the main thread and in Node.
//
//   const student = loadStudent(bundle);        // JSON from the trainer's export
//   student.kinds.has('resident_routine');      // which kinds it answers
//   student.answer(kind, snapshot, context, allowed)
//     // -> {kind, choice, confidence, probabilities, model}, the client's answer shape,
//     //    plus expectedKL and unknown when the bundle has a confidence head
//
// `confidence` is the answer's top probability, as the client reports it. How
// far off the student is likely to be is `expectedKL`: a small head trained to
// predict the student's own KL to the teacher (twm/decision/confidence.py),
// in nats. `unknown` counts the question's triples the vocabulary does not know.
//
// Two shapes (the trainer's twm/decision/model.py):
//   'set'  triples (src/decision-features.js) embedded as scope + attribute +
//          value (+ num · num_dir[attribute]). Snapshot triples run through a
//          small self-attention encoder; that memory depends only on the
//          snapshot, so it is cached per state. Question triples and one token
//          per offered option run through decoder layers (self-attention, then
//          attention into the memory); each option token gives one logit.
//   'mlp'  Deep Sets: each triple's scope, attribute and value embeddings side
//          by side through a small per-triple network (phi), summed, an MLP, and
//          a dot product with each option's embedding. (Bundles without phi sum
//          the triple embeddings directly.)
//   'fm'   a factorization machine: pairwise products of the triple embeddings
//          (½((Σe)² − Σe²)) and their sum, each layer-normed and added, then a
//          dot product with each option's embedding. With fm_order 3, every
//          triple of triples too, from a projection f = eW: (p1³ − 3·p1·p2 + 2·p3)/6
//          with p_m = Σ f^m.
// Answers are a softmax over the offered options. The same question always
// gets the same answer, so the client's cache and replay are unaffected.
import {decisionTriples, decisionOptions, FEATURES_VERSION} from './decision-features.js';
import {stateKey} from './decision-kinds.js';
import {KIND_BY_ID} from './sim/decisions/kinds.js';

const STATE_CACHE = 512;

export function loadStudent(bundle) {
  if (bundle?.format !== 'hearthvale-decision-student') throw new Error('Not a decision student bundle');
  if (bundle.features !== FEATURES_VERSION) throw new Error(`Student built for features v${bundle.features}, game has v${FEATURES_VERSION}`);
  const cfg = bundle.config;
  const W = Object.fromEntries(Object.entries(bundle.weights).map(([k, v]) => [k, {shape: v.shape, data: decodeWeight(v)}]));
  const voc = bundle.vocab;
  const stateScopes = new Set(voc.state_scopes);
  const d = cfg.d_model;
  const model = `student:${bundle.kinds.length === 1 ? bundle.kinds[0] : 'decisions'}@v${bundle.version}`;
  const memo = new Map();
  let last = null;  // the latest question's option states and unknown count

  const row = (name, i) => W[name].data.subarray(i * d, (i + 1) * d);
  // The MLP's later layers: with dropout modules (mlp.4, mlp.7) or without (mlp.3, mlp.5).
  const [mlpHidden, mlpOut] = W['mlp.7.weight'] ? ['mlp.4', 'mlp.7'] : ['mlp.3', 'mlp.5'];
  const id = (map, key) => map[key] ?? 1;

  // A fact's encoding depends only on the fact (its number included) and these
  // weights, so it is kept across snapshots and questions, in a bounded cache.
  const FACT_CACHE = 20000;
  const factMemo = new Map();
  function factGet(t, make) {
    const key = `${t[0]}\u0001${t[1]}\u0001${t[2]}\u0001${t[3] ?? ''}`;
    let f = factMemo.get(key);
    if (!f) {
      f = make();
      if (factMemo.size >= FACT_CACHE) factMemo.delete(factMemo.keys().next().value);
      factMemo.set(key, f);
    }
    return f;
  }

  // Deep Sets MLP. φ's first layer reads [scope; attribute; value + num · dir],
  // so it folds into one table row per vocabulary entry (made on first use):
  // W0·[s; a; v + num·dir] = W0s·s + W0a·a + W0v·v + num · W0v·dir.
  const phiH = W['phi.0.weight']?.shape[0] ?? 0;
  const folded = {scope: new Map(), attr: new Map(), value: new Map(), dir: new Map()};
  function foldRow(part, table, i, col) {
    let r = folded[part].get(i);
    if (!r) {
      const w = W['phi.0.weight'].data, e = W[table].data;
      r = new Float32Array(phiH);
      for (let o = 0; o < phiH; o++) {
        let sum = 0;
        const base = o * 3 * d + col;
        for (let j = 0; j < d; j++) sum += w[base + j] * e[i * d + j];
        r[o] = sum;
      }
      folded[part].set(i, r);
    }
    return r;
  }
  function phiFact(t) {
    return factGet(t, () => {
      const [scope, attr, value, num] = t;
      const a = id(voc.attrs, attr);
      const b0 = W['phi.0.bias'].data, u = new Float32Array(phiH);
      const rs = foldRow('scope', 'embed.scope.weight', id(voc.scopes, scope), 0);
      const ra = foldRow('attr', 'embed.attr.weight', a, d);
      const rv = foldRow('value', 'embed.value.weight', id(voc.values, value), 2 * d);
      for (let o = 0; o < phiH; o++) u[o] = b0[o] + rs[o] + ra[o] + rv[o];
      if (num !== null && num !== undefined) {
        const rd = foldRow('dir', 'embed.num_dir.weight', a, 2 * d);
        for (let o = 0; o < phiH; o++) u[o] += num * rd[o];
      }
      return linearRaw(W['phi.2.weight'].data, W['phi.2.bias'].data, gelu(u), d);
    });
  }
  // The snapshot's facts summed once per snapshot; each question adds its own.
  function phiPooled(triples, cacheKey) {
    let town = cacheKey ? memo.get(cacheKey) : null;
    if (!town) {
      town = new Float32Array(d);
      for (const t of triples) if (stateScopes.has(t[0])) add(town, phiFact(t));
      if (cacheKey) {
        if (memo.size >= STATE_CACHE) memo.delete(memo.keys().next().value);
        memo.set(cacheKey, town);
      }
    }
    const sum = Float32Array.from(town);
    let unk = 0;
    for (const t of triples) {
      if (id(voc.attrs, t[1]) === 1 || id(voc.values, t[2]) === 1) unk++;
      if (!stateScopes.has(t[0])) add(sum, phiFact(t));
    }
    last = {hidden: null, unk, n: triples.length};
    return sum;
  }

  // Triples -> embedded vectors, split into snapshot and question tokens.
  function embed(triples) {
    const state = [], question = [];
    let unk = 0;
    for (const [scope, attr, value, num] of triples) {
      const a = id(voc.attrs, attr);
      if (a === 1 || id(voc.values, value) === 1) unk++;
      const v = new Float32Array(d);
      add(v, row('embed.scope.weight', id(voc.scopes, scope)));
      add(v, row('embed.attr.weight', a));
      add(v, row('embed.value.weight', id(voc.values, value)));
      if (num !== null && num !== undefined) addScaled(v, row('embed.num_dir.weight', a), num);
      (stateScopes.has(scope) ? state : question).push(v);
    }
    last = {hidden: null, unk, n: triples.length};
    return {state, question};
  }

  function optionVectors(kind, options) {
    return options.map((o) => {
      const v = new Float32Array(d);
      add(v, row('embed.kind_opt.weight', id(voc.kind_options, `${kind}:${o}`)));
      add(v, row('embed.opt.weight', id(voc.options, o)));
      if (cfg.arch === 'set') add(v, W.option_flag.data);
      return v;
    });
  }

  // Triples -> flat (tokens × d) matrices for the snapshot and the question.
  function embedFlat(triples) {
    let sn = 0;
    for (const t of triples) if (stateScopes.has(t[0])) sn++;
    const qn = triples.length - sn;
    const sx = new Float32Array(sn * d), qx = new Float32Array(qn * d);
    let si = 0, qi = 0, unk = 0;
    for (const [scope, attr, value, num] of triples) {
      const state = stateScopes.has(scope);
      const out = state ? sx : qx, at = (state ? si++ : qi++) * d;
      const a = id(voc.attrs, attr), vi = id(voc.values, value);
      if (a === 1 || vi === 1) unk++;
      const ws = W['embed.scope.weight'].data, wa = W['embed.attr.weight'].data, wv = W['embed.value.weight'].data;
      const s0 = id(voc.scopes, scope) * d, a0 = a * d, v0 = vi * d;
      for (let i = 0; i < d; i++) out[at + i] = ws[s0 + i] + wa[a0 + i] + wv[v0 + i];
      if (num !== null && num !== undefined) {
        const wn = W['embed.num_dir.weight'].data;
        for (let i = 0; i < d; i++) out[at + i] += wn[a0 + i] * num;
      }
    }
    return {sx, sn, qx, qn, unk};
  }

  // A kind's option tokens, flat; the same for every question that offers them.
  const optionMemo = new Map();
  function optionsFlat(kind, options) {
    const key = `${kind}|${options.join(',')}`;
    let out = optionMemo.get(key);
    if (!out) {
      out = new Float32Array(options.length * d);
      options.forEach((o, j) => out.set(optionVectors(kind, [o])[0], j * d));
      optionMemo.set(key, out);
    }
    return out;
  }

  // The first question layer's work on the option rows: those rows are the option tokens
  // themselves, so their norm1 and their self-attention queries, keys and values are the
  // same for every question offering them, and are kept with them.
  const firstMemo = new Map();
  function firstOptions(kind, options) {
    const key = `${kind}|${options.join(',')}`;
    let F = firstMemo.get(key);
    if (!F) {
      const p = 'question.layers.0.self_attn';
      const h = lnFlat(optionsFlat(kind, options), options.length, d, W, 'question.layers.0.norm1');
      const {k, v} = projectFlat(W, p, h, options.length, d);
      F = {k, v, q: linFlat(h, options.length, d, W[`${p}.in_proj_weight`].data, W[`${p}.in_proj_bias`].data, d, 0)};
      firstMemo.set(key, F);
    }
    return F;
  }

  // Snapshot tokens -> each question layer's keys and values over the memory.
  // With no snapshot encoder, each memory token is its own fact's (norm, then
  // each question layer's key and value projections): kept per fact, so a new
  // snapshot pays only for facts not seen before. Same arithmetic per row.
  function factMemory(triples, sx, sn) {
    const L = cfg.question_layers;
    const kv = Array.from({length: L}, () => ({k: new Float32Array(sn * d), v: new Float32Array(sn * d), m: sn}));
    let r = 0;
    for (const t of triples) {
      if (!stateScopes.has(t[0])) continue;
      const at = r * d;
      const f = factGet(t, () => {
        const tok = lnFlat(sx.subarray(at, at + d), 1, d, W, 'state_norm');
        return Array.from({length: L}, (_, l) => projectFlat(W, `question.layers.${l}.multihead_attn`, tok, 1, d));
      });
      for (let l = 0; l < L; l++) { kv[l].k.set(f[l].k, at); kv[l].v.set(f[l].v, at); }
      r++;
    }
    return kv;
  }

  function stateMemory(x, n) {
    for (let l = 0; l < cfg.state_layers; l++) {
      const p = `state_encoder.layers.${l}`;
      addInto(x, attendFlat(W, `${p}.self_attn`, lnFlat(x, n, d, W, `${p}.norm1`), n, d, null, cfg.n_heads));
      addInto(x, ffnFlat(W, p, lnFlat(x, n, d, W, `${p}.norm2`), n, d));
    }
    const tokens = lnFlat(x, n, d, W, 'state_norm');
    const kv = [];
    for (let l = 0; l < cfg.question_layers; l++) kv.push(projectFlat(W, `question.layers.${l}.multihead_attn`, tokens, n, d));
    return kv;
  }

  // Option logits for one question. `cacheKey` names its snapshot: the
  // set model's memory depends only on the snapshot triples, so it is kept.
  function logits(kind, triples, options, cacheKey) {
    const {state, question} = cfg.arch === 'set' || phiH ? {} : embed(triples);
    if (cfg.arch === 'fm') {
      const sum = new Float32Array(d), squares = new Float32Array(d);
      for (const v of [...state, ...question]) {
        for (let i = 0; i < d; i++) { sum[i] += v[i]; squares[i] += v[i] * v[i]; }
      }
      const pairs = new Float32Array(d);
      for (let i = 0; i < d; i++) pairs[i] = 0.5 * (sum[i] * sum[i] - squares[i]);
      const [p] = layerNorm([pairs], W, 'pair_norm'), [q] = layerNorm([sum], W, 'sum_norm');
      for (let i = 0; i < d; i++) p[i] += q[i];
      if ((cfg.fm_order ?? 2) >= 3) {
        const p1 = new Float32Array(d), p2 = new Float32Array(d), p3 = new Float32Array(d);
        for (const v of [...state, ...question]) {
          const f = linearRaw(W['third.weight'].data, null, v, d);
          for (let i = 0; i < d; i++) { p1[i] += f[i]; p2[i] += f[i] * f[i]; p3[i] += f[i] * f[i] * f[i]; }
        }
        const t = new Float32Array(d);
        for (let i = 0; i < d; i++) t[i] = (p1[i] ** 3 - 3 * p1[i] * p2[i] + 2 * p3[i]) / 6;
        const [r] = layerNorm([t], W, 'third_norm');
        for (let i = 0; i < d; i++) p[i] += r[i];
      }
      return optionVectors(kind, options).map((o) => dot(p, o));
    }
    if (cfg.arch === 'mlp') {
      let sum;
      if (phiH) {
        sum = phiPooled(triples, cacheKey);
      } else {
        sum = new Float32Array(d);
        for (const v of [...state, ...question]) add(sum, v);
      }
      let h = layerNorm([sum], W, 'mlp.0')[0];
      h = gelu(linear(W, 'mlp.1', h));
      h = gelu(linear(W, mlpHidden, h));
      const z = linear(W, mlpOut, h);
      return optionVectors(kind, options).map((o) => dot(z, o));
    }
    const {sx, sn, qx, qn, unk} = embedFlat(triples);
    let mem = cacheKey ? memo.get(cacheKey) : null;
    if (mem) {
      memo.delete(cacheKey);
    } else {
      // A question with no snapshot attends to its first triple (the kind), as in training.
      mem = !sn ? stateMemory(qx.slice(0, d), 1) : cfg.state_layers === 0 ? factMemory(triples, sx, sn) : stateMemory(sx, sn);
      if (cacheKey && memo.size >= STATE_CACHE) memo.delete(memo.keys().next().value);
    }
    if (cacheKey) memo.set(cacheKey, mem);
    const opts = optionsFlat(kind, options);
    const n = qn + options.length;
    const x = new Float32Array(n * d);
    x.set(qx, 0);
    x.set(opts, qn * d);
    const L = cfg.question_layers, k = options.length;
    // The first layer's self-attention: the question rows' norm1, keys and values worked
    // out, the option rows' taken from firstOptions. Rows are independent, so these are
    // the same numbers a pass over all rows gives.
    let F = null, kv0 = null, hq = null;
    if (L > 0) {
      F = firstOptions(kind, options);
      hq = lnFlat(qx, qn, d, W, 'question.layers.0.norm1');
      const own = projectFlat(W, 'question.layers.0.self_attn', hq, qn, d);
      kv0 = {k: cat(own.k, F.k), v: cat(own.v, F.v), m: n};
    }
    for (let l = 0; l < L - 1; l++) {
      const p = `question.layers.${l}`;
      if (l === 0) {
        const w = W[`${p}.self_attn.in_proj_weight`].data, b = W[`${p}.self_attn.in_proj_bias`].data;
        addInto(x, attendQ(W, `${p}.self_attn`, cat(linFlat(hq, qn, d, w, b, d, 0), F.q), n, d, kv0, cfg.n_heads));
      } else {
        addInto(x, attendFlat(W, `${p}.self_attn`, lnFlat(x, n, d, W, `${p}.norm1`), n, d, null, cfg.n_heads));
      }
      addInto(x, attendFlat(W, `${p}.multihead_attn`, lnFlat(x, n, d, W, `${p}.norm2`), n, d, mem[l], cfg.n_heads));
      addInto(x, ffnFlat(W, p, lnFlat(x, n, d, W, `${p}.norm3`), n, d));
    }
    // The last layer carries on only the option rows, the only ones read after it
    // (keys and values still come from every row). Each step works row by row, so
    // a kept row's arithmetic, and the answer, is exactly what the full pass gives.
    if (L > 0) {
      const p = `question.layers.${L - 1}`;
      const xo = x.subarray(qn * d);
      if (L === 1) {
        addInto(xo, attendQ(W, `${p}.self_attn`, F.q, k, d, kv0, cfg.n_heads));
      } else {
        const h = lnFlat(x, n, d, W, `${p}.norm1`);
        addInto(xo, attendFlat(W, `${p}.self_attn`, h.subarray(qn * d), k, d, projectFlat(W, `${p}.self_attn`, h, n, d), cfg.n_heads));
      }
      addInto(xo, attendFlat(W, `${p}.multihead_attn`, lnFlat(xo, k, d, W, `${p}.norm2`), k, d, mem[L - 1], cfg.n_heads));
      addInto(xo, ffnFlat(W, p, lnFlat(xo, k, d, W, `${p}.norm3`), k, d));
    }
    const out = lnFlat(x.subarray(qn * d), options.length, d, W, 'out_norm');
    const ws = W['score.weight'].data, bs = W['score.bias'].data[0];
    const z = options.map((_, j) => {
      let v = bs;
      for (let i = 0; i < d; i++) v += out[j * d + i] * ws[i];
      return v;
    });
    last = {hidden: out, unk, n: triples.length};
    return z;
  }

  // The confidence head: expected KL to the teacher from the options' final
  // states, the answer's entropy and top probability, and the unknown share.
  function expectedKL(p) {
    if (!head || !last?.hidden) return null;
    const K = p.length, {hidden, unk, n} = last;
    const f = new Float32Array(2 * d + 3);
    for (let i = 0; i < d; i++) {
      let sum = 0, mx = -Infinity;
      for (let j = 0; j < K; j++) { const v = hidden[j * d + i]; sum += v; if (v > mx) mx = v; }
      f[i] = sum / K;
      f[d + i] = mx;
    }
    let ent = 0;
    for (const q of p) if (q > 0) ent -= q * Math.log(q);
    f[2 * d] = ent / Math.log(Math.max(K, 2));
    f[2 * d + 1] = Math.max(...p);
    f[2 * d + 2] = n ? unk / n : 0;
    const h = linear(W, 'err_head.net.0', f);
    for (let i = 0; i < h.length; i++) if (h[i] < 0) h[i] = 0;
    const pred = linear(W, 'err_head.net.2', h)[0];
    return head.scale * Math.max(0, Math.exp(pred) - head.eps);
  }

  function softmax(z) {
    const top = Math.max(...z);
    const e = z.map((v) => Math.exp(v - top));
    const sum = e.reduce((a, b) => a + b, 0);
    return e.map((v) => v / sum);
  }

  const head = cfg.arch === 'set' && bundle.confidence && W['err_head.net.0.weight'] ? bundle.confidence : null;

  // An answer depends only on the question, so identical questions (a town
  // asks most of them two or three times) are answered once and served from a
  // bounded cache; callers get a copy, and sampling happens after, in the game.
  const answers = new Map();
  const ANSWER_CACHE = 20000;
  function answer(kind, snapshot, context, allowed) {
    const sKey = stateKey(snapshot ?? {});
    const key = `${kind}|${sKey}|${JSON.stringify(context ?? null)}|${allowed ? JSON.stringify(allowed) : ''}`;
    let hit = answers.get(key);
    if (!hit) {
      const options = decisionOptions(kind, allowed);
      // The memory depends only on the snapshot's triples, which are the same for
      // every kind sharing a snapshot type: one encode serves them all.
      const p = softmax(logits(kind, decisionTriples(kind, snapshot, context), options, `${KIND_BY_ID[kind]?.share ?? kind}|${sKey}`));
      const probabilities = Object.fromEntries(options.map((o, i) => [o, p[i]]));
      const choice = options.reduce((best, o) => (probabilities[o] > probabilities[best] ? o : best));
      hit = {kind, choice, confidence: probabilities[choice], probabilities, model, unknown: last?.unk ?? 0};
      if (head) hit.expectedKL = expectedKL(p);
      if (answers.size >= ANSWER_CACHE) answers.delete(answers.keys().next().value);
      answers.set(key, hit);
    }
    return {...hit, probabilities: {...hit.probabilities}};
  }

  // For the parity check against the trainer: probabilities straight from
  // triples (cached under `cacheKey` when given).
  const fromTriples = (kind, triples, options, cacheKey = null) => softmax(logits(kind, triples, options, cacheKey));
  // How many of a question's triples the vocabulary does not know (no forward pass).
  function unknownIn(kind, snapshot, context) {
    let n = 0;
    for (const [, attr, value] of decisionTriples(kind, snapshot, context)) if (!(attr in voc.attrs) || !(value in voc.values)) n++;
    return n;
  }

  // Expected KL straight from triples, for the same check.
  const expectedFromTriples = (kind, triples, options) => expectedKL(fromTriples(kind, triples, options));

  // A short fingerprint of the weights, to tell versions apart at a glance.
  let fp = 2166136261;
  for (const v of Object.values(bundle.weights)) {
    const text = v.i8 ?? v.f16 ?? v.f32 ?? '';
    for (let i = 0; i < text.length; i += 7) fp = Math.imul(fp ^ text.charCodeAt(i), 16777619) >>> 0;
  }
  const fingerprint = fp.toString(16).padStart(8, '0');

  // For timing: forget every snapshot, fact and answer (folded tables, made from the weights alone, stay).
  const clearCaches = () => { memo.clear(); factMemo.clear(); answers.clear(); };

  return {kinds: new Set(bundle.kinds), model, version: bundle.version, id: fingerprint, answer, unknownIn, fromTriples, expectedFromTriples, hasConfidence: !!head, clearCaches,
    thresholds: bundle.confidence?.thresholds ?? null, quantiles: bundle.confidence?.quantiles ?? null, fixture: bundle.fixture ?? []};
}

// ---------------------------------------------------------------------------
// Small dense algebra over Float32Array rows
// ---------------------------------------------------------------------------

function add(a, b) {
  for (let i = 0; i < a.length; i++) a[i] += b[i];
}

function addScaled(a, b, s) {
  for (let i = 0; i < a.length; i++) a[i] += b[i] * s;
}

function dot(a, b) {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i] * b[i];
  return s;
}

// Rows of a, then rows of b, in one flat array.
function cat(a, b) {
  const out = new Float32Array(a.length + b.length);
  out.set(a, 0);
  out.set(b, a.length);
  return out;
}

function addInto(a, b) {
  for (let i = 0; i < a.length; i++) a[i] += b[i];
}

function layerNorm(x, W, name) {
  const g = W[`${name}.weight`].data, b = W[`${name}.bias`].data;
  return x.map((v) => {
    let mean = 0;
    for (let i = 0; i < v.length; i++) mean += v[i];
    mean /= v.length;
    let varSum = 0;
    for (let i = 0; i < v.length; i++) varSum += (v[i] - mean) ** 2;
    const inv = 1 / Math.sqrt(varSum / v.length + 1e-5);
    const out = new Float32Array(v.length);
    for (let i = 0; i < v.length; i++) out[i] = (v[i] - mean) * inv * g[i] + b[i];
    return out;
  });
}

// y = W x + b, with W stored (out, in) row-major as PyTorch does.
function linearRaw(w, b, x, outDim, rowOffset = 0) {
  const inDim = x.length;
  const out = new Float32Array(outDim);
  for (let o = 0; o < outDim; o++) {
    let s = b ? b[rowOffset + o] : 0;
    const base = (rowOffset + o) * inDim;
    for (let i = 0; i < inDim; i++) s += w[base + i] * x[i];
    out[o] = s;
  }
  return out;
}

const linear = (W, name, x) => linearRaw(W[`${name}.weight`].data, W[`${name}.bias`]?.data, x, W[`${name}.weight`].shape[0]);

// Flat (rows × d) versions of the layers the set model runs, one allocation
// per layer rather than per token.

function lnFlat(x, n, d, W, name) {
  const g = W[`${name}.weight`].data, b = W[`${name}.bias`].data;
  const out = new Float32Array(n * d);
  for (let r = 0; r < n; r++) {
    const o = r * d;
    let mean = 0;
    for (let i = 0; i < d; i++) mean += x[o + i];
    mean /= d;
    let varSum = 0;
    for (let i = 0; i < d; i++) varSum += (x[o + i] - mean) ** 2;
    const inv = 1 / Math.sqrt(varSum / d + 1e-5);
    for (let i = 0; i < d; i++) out[o + i] = (x[o + i] - mean) * inv * g[i] + b[i];
  }
  return out;
}

// rows × inDim times W(out, in) rows [off, off + outDim), plus bias.
function linFlat(x, n, inDim, w, b, outDim, off = 0) {
  const out = new Float32Array(n * outDim);
  for (let r = 0; r < n; r++) {
    const xr = r * inDim, or = r * outDim;
    for (let o = 0; o < outDim; o++) {
      let s = b ? b[off + o] : 0;
      const base = (off + o) * inDim;
      for (let i = 0; i < inDim; i++) s += w[base + i] * x[xr + i];
      out[or + o] = s;
    }
  }
  return out;
}

function ffnFlat(W, p, x, n, d) {
  const w1 = W[`${p}.linear1.weight`], w2 = W[`${p}.linear2.weight`];
  const h = linFlat(x, n, d, w1.data, W[`${p}.linear1.bias`].data, w1.shape[0]);
  for (let i = 0; i < h.length; i++) if (h[i] < 0) h[i] = 0;
  return linFlat(h, n, w1.shape[0], w2.data, W[`${p}.linear2.bias`].data, d);
}

// Keys and values of nn.MultiheadAttention's packed in_proj (rows q, k, v).
function projectFlat(W, p, x, n, d) {
  const w = W[`${p}.in_proj_weight`].data, b = W[`${p}.in_proj_bias`].data;
  return {k: linFlat(x, n, d, w, b, d, d), v: linFlat(x, n, d, w, b, d, 2 * d), m: n};
}

// nn.MultiheadAttention then out_proj; without `kv`, x attends to itself.
function attendFlat(W, p, x, n, d, kv, heads) {
  const w = W[`${p}.in_proj_weight`].data, b = W[`${p}.in_proj_bias`].data;
  kv ??= projectFlat(W, p, x, n, d);
  return attendQ(W, p, linFlat(x, n, d, w, b, d, 0), n, d, kv, heads);
}

// The same from the queries q (n rows), already projected.
function attendQ(W, p, q, n, d, {k, v, m}, heads) {
  const dh = d / heads, scale = 1 / Math.sqrt(dh);
  const out = new Float32Array(n * d), scores = new Float32Array(m);
  for (let r = 0; r < n; r++) {
    for (let h = 0; h < heads; h++) {
      const qo = r * d + h * dh;
      let top = -Infinity;
      for (let j = 0; j < m; j++) {
        const ko = j * d + h * dh;
        let s = 0;
        for (let i = 0; i < dh; i++) s += q[qo + i] * k[ko + i];
        scores[j] = s * scale;
        if (scores[j] > top) top = scores[j];
      }
      let sum = 0;
      for (let j = 0; j < m; j++) sum += (scores[j] = Math.exp(scores[j] - top));
      for (let j = 0; j < m; j++) {
        const a = scores[j] / sum, vo = j * d + h * dh;
        for (let i = 0; i < dh; i++) out[qo + i] += a * v[vo + i];
      }
    }
  }
  const wo = W[`${p}.out_proj.weight`];
  return linFlat(out, n, d, wo.data, W[`${p}.out_proj.bias`].data, d);
}

// GELU with erf (PyTorch's default), erf by Abramowitz–Stegun 7.1.26.
function gelu(x) {
  const out = new Float32Array(x.length);
  for (let i = 0; i < x.length; i++) {
    const z = x[i] / Math.SQRT2, s = Math.sign(z), a = Math.abs(z);
    const t = 1 / (1 + 0.3275911 * a);
    const erf = s * (1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-a * a));
    out[i] = 0.5 * x[i] * (1 + erf);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Weights: base64 INT8 rows with a scale per row, fp16 or float32
// (the trainer's scripts/export_decision_student.py).
// ---------------------------------------------------------------------------

function bytes(b64) {
  const text = atob(b64);
  const out = new Uint8Array(text.length);
  for (let i = 0; i < text.length; i++) out[i] = text.charCodeAt(i);
  return out;
}

function halfToFloat(h) {
  const sign = h & 0x8000 ? -1 : 1, exp = (h >> 10) & 0x1f, frac = h & 0x3ff;
  if (exp === 0) return sign * 2 ** -14 * (frac / 1024);
  if (exp === 31) return frac ? NaN : sign * Infinity;
  return sign * 2 ** (exp - 15) * (1 + frac / 1024);
}

function decodeWeight(entry) {
  if (entry.f32) return new Float32Array(bytes(entry.f32).buffer);
  if (entry.f16) return Float32Array.from(new Uint16Array(bytes(entry.f16).buffer), halfToFloat);
  const q = new Int8Array(bytes(entry.i8).buffer), scale = new Float32Array(bytes(entry.scale).buffer);
  const cols = entry.shape[1], out = new Float32Array(q.length);
  for (let i = 0; i < q.length; i++) out[i] = q[i] * scale[Math.floor(i / cols)];
  return out;
}
