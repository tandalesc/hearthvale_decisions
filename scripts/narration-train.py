#!/usr/bin/env python3
"""Train a tiny triples-to-text narration model (docs/handoff-narration-model.md).

  python scripts/narration-train.py PAIRS.jsonl --out DIR [--epochs 6] [--d 96] [--device mps]
      [--test-fraction 0.2] [--quote-weight 20] [--max-rows N] [--max-per-task N]

PAIRS.jsonl comes from scripts/narration-export.js (use --prompts to get cards to quote).

The model:
  memory   one element per word piece of every triple's value, embedded as
           piece + attribute + scope parts + type + place in the value + the
           triple's number. No order between triples: it is a set.
  encoder  a small transformer over the memory.
  decoder  a small transformer, started by a task token, that either writes a
           word from its vocabulary or copies a piece from the memory
           (pointer-generator). Names and numbers are left out of the
           vocabulary, so they can only be copied, never made up.
  glue     a separate bit per piece says whether it joins the piece before it
           ("Croft" + "'s"), so the text round-trips exactly.

Train and test are split by seed, as the decision student is: a row is test only
if every seed that saw its sheet is held out. Model rows (no seeds) split by key.

Writes DIR/model.pt, DIR/vocab.json, DIR/metrics.json, DIR/samples.jsonl.
"""
import argparse
import hashlib
import json
import math
import random
import re
import time
from collections import Counter, defaultdict

import torch
import torch.nn as nn
import torch.nn.functional as F

PIECE = re.compile(r"[A-Za-z]+|'[A-Za-z]+|\d+(?:\.\d+)?|[^\sA-Za-z\d]")
SPECIALS = ['<pad>', '<unk>', '<eos>', '<empty>']
PAD, UNK, EOS, EMPTY = range(4)
TYPES = {'enum': 0, 'num': 1, 'text': 2}
# The narrator refuses numbers the facts never gave and dramatic words the facts never used
# (strayNumber, DRAMA in src/narrative-prose.js); the decoder may not write them either.
NUMBER_WORDS = {'three': 3, 'four': 4, 'five': 5, 'six': 6, 'seven': 7, 'eight': 8, 'nine': 9, 'ten': 10, 'eleven': 11,
                'twelve': 12, 'thirteen': 13, 'fourteen': 14, 'fifteen': 15, 'sixteen': 16, 'seventeen': 17,
                'eighteen': 18, 'nineteen': 19, 'twenty': 20, 'thirty': 30, 'forty': 40, 'fifty': 50, 'sixty': 60,
                'seventy': 70, 'eighty': 80, 'ninety': 90, 'hundred': 100, 'thousand': 1000, 'dozen': 12, 'score': 20}
DRAMA = {'starve', 'starving', 'starvation', 'die', 'dies', 'dying', 'dead', 'death', 'deaths', 'riot', 'riots',
         'famine', 'plague', 'war', 'burn', 'burning', 'murder', 'ruin', 'ruined', 'collapse', 'hungrier', 'survive'}
MAX_POS, MAX_META, MAX_MEM, MAX_TGT = 16, 6, 448, 128


def pieces(text):
    """text -> [(piece, glued)] ; glued means no space before it."""
    out = []
    for chunk in str(text).split():
        for i, p in enumerate(PIECE.findall(chunk)):
            out.append((p, i > 0))
    return out


def detok(ps):
    s = ''
    for p, glued in ps:
        s += p if (glued or not s) else ' ' + p
    return s


def h(s):
    return int(hashlib.sha256(str(s).encode()).hexdigest()[:8], 16)


def is_fact_piece(p):
    return p[:1].isupper() or p[:1].isdigit()


# ---------------------------------------------------------------- data

def load_rows(files, max_rows=None):
    rows = []
    for f in files:
        with open(f) as fh:
            for line in fh:
                if line.strip():
                    rows.append(json.loads(line))
    if max_rows and len(rows) > max_rows:
        random.Random(0).shuffle(rows)
        rows = rows[:max_rows]
    return rows


def split(rows, test_fraction):
    seeds = sorted({s for r in rows for s in r.get('seeds') or []}, key=h)
    test_seeds = set(seeds[:max(1, round(test_fraction * len(seeds)))]) if seeds else set()
    train, test = [], []
    for r in rows:
        ss = r.get('seeds') or []
        if ss:
            is_test = all(s in test_seeds for s in ss)
        else:
            is_test = (h(r['key']) % 1000) < test_fraction * 1000
        (test if is_test else train).append(r)
    return train, test, sorted(test_seeds)


def build_vocab(train):
    tgt = Counter()
    copyable = Counter()
    meta = Counter()
    for r in train:
        surf = set()
        for scope, attr, value, num, typ in r['triples']:
            meta.update(re.split(r'[:/]', scope))
            meta[attr] += 1
            surf.update(p for p, _ in pieces(value))
        for p, _ in pieces(r['target']):
            tgt[p] += 1
            if p in surf:
                copyable[p] += 1
    words = []
    for p, n in tgt.items():
        if n < 3:
            continue
        # Names and numbers the targets nearly always copy are left out: copy only.
        if is_fact_piece(p) and copyable[p] >= 0.9 * n:
            continue
        words.append(p)
    words.sort(key=lambda p: -tgt[p])
    tasks = sorted({r['task'] for r in train})
    metas = ['<pad>', '<unk>'] + sorted(m for m, n in meta.items() if n >= 3)
    return {'words': SPECIALS + words, 'tasks': tasks, 'meta': metas}


class Encoder:
    def __init__(self, vocab):
        self.vocab = vocab
        self.w = {p: i for i, p in enumerate(vocab['words'])}
        self.m = {p: i for i, p in enumerate(vocab['meta'])}
        self.t = {p: i for i, p in enumerate(vocab['tasks'])}
        self.V = len(vocab['words'])

    def memory(self, triples):
        toks, metas, typ, pos, nums, surf = [], [], [], [], [], []
        for scope, attr, value, num, ty in triples:
            ms = [self.m.get(x, 1) for x in re.split(r'[:/]', scope)][: MAX_META - 1] + [self.m.get(attr, 1)]
            ms += [0] * (MAX_META - len(ms))
            ps = pieces(value) or [('<empty>', False)]
            for i, (p, _) in enumerate(ps):
                toks.append(EMPTY if p == '<empty>' else self.w.get(p, UNK))
                metas.append(ms)
                typ.append(TYPES.get(ty, 2))
                pos.append(min(i, MAX_POS - 1))
                nums.append([0.0, 0.0, 0.0] if num is None else [math.tanh(num / 10), math.tanh(num), 1.0])
                surf.append(p)
        n = min(len(toks), MAX_MEM)
        return dict(tok=toks[:n], meta=metas[:n], typ=typ[:n], pos=pos[:n], num=nums[:n], surf=surf[:n])

    def canon(self, surf):
        """Each memory position -> id in the joint [vocab | memory] space."""
        first = {}
        out = []
        for j, p in enumerate(surf):
            if p in self.w and p != '<empty>':
                out.append(self.w[p])
            else:
                first.setdefault(p, j)
                out.append(self.V + first[p])
        return out

    def target(self, text, surf):
        first = {}
        for j, p in enumerate(surf):
            first.setdefault(p, j)
        ids, glue = [], []
        for p, g in pieces(text)[: MAX_TGT - 1]:
            if p in self.w:
                ids.append(self.w[p])
            elif p in first:
                ids.append(self.V + first[p])
            else:
                ids.append(UNK)
            glue.append(1.0 if g else 0.0)
        return ids + [EOS], glue + [0.0]

    def banned(self, triples):
        """Vocabulary words this sheet may not use: numbers and dramatic words its facts lack."""
        nums, text = {0, 1, 2}, []
        for _, _, value, num, _ in triples:
            v = str(value)
            text.append(v.lower())
            nums.update(int(m.replace(',', '')) for m in re.findall(r'\d[\d,]*', v) if m.replace(',', ''))
            nums.update(NUMBER_WORDS[w] for w in re.findall(r'[a-z]+', v.lower()) if w in NUMBER_WORDS)
        words = set(re.findall(r'[a-z]+', ' '.join(text)))
        ban = []
        for w, i in self.w.items():
            lw = w.lower()
            if (lw in NUMBER_WORDS and NUMBER_WORDS[lw] not in nums) or (lw in DRAMA and lw not in words) \
                    or (w.isdigit() and int(w) not in nums):
                ban.append(i)
        return ban

    def example(self, r):
        mem = self.memory(r['triples'])
        ex = dict(mem, canon=self.canon(mem['surf']), task=self.t.get(r['task'], 0), row=r, ban=self.banned(r['triples']))
        ex['tgt'], ex['glue'] = self.target(r['target'], mem['surf']) if r['target'] else ([EOS], [0.0])
        return ex


def collate(batch, device):
    B = len(batch)
    # Pad to a few fixed sizes: MPS compiles a graph per shape and never frees them.
    M = -(-max(len(e['tok']) for e in batch) // 64) * 64
    T = -(-max(len(e['tgt']) for e in batch) // 16) * 16
    tok = torch.zeros(B, M, dtype=torch.long)
    meta = torch.zeros(B, M, MAX_META, dtype=torch.long)
    typ = torch.zeros(B, M, dtype=torch.long)
    pos = torch.zeros(B, M, dtype=torch.long)
    num = torch.zeros(B, M, 3)
    canon = torch.zeros(B, M, dtype=torch.long)
    mmask = torch.ones(B, M, dtype=torch.bool)  # True = padding
    tgt = torch.zeros(B, T, dtype=torch.long)
    glue = torch.zeros(B, T)
    tmask = torch.ones(B, T, dtype=torch.bool)
    task = torch.tensor([e['task'] for e in batch])
    for i, e in enumerate(batch):
        m, t = len(e['tok']), len(e['tgt'])
        tok[i, :m] = torch.tensor(e['tok'])
        meta[i, :m] = torch.tensor(e['meta'])
        typ[i, :m] = torch.tensor(e['typ'])
        pos[i, :m] = torch.tensor(e['pos'])
        num[i, :m] = torch.tensor(e['num'])
        canon[i, :m] = torch.tensor(e['canon'])
        mmask[i, :m] = False
        tgt[i, :t] = torch.tensor(e['tgt'])
        glue[i, :t] = torch.tensor(e['glue'])
        tmask[i, :t] = False
    d = dict(tok=tok, meta=meta, typ=typ, pos=pos, num=num, canon=canon, mmask=mmask, tgt=tgt, glue=glue, tmask=tmask, task=task)
    return {k: v.to(device) for k, v in d.items()}


# ---------------------------------------------------------------- model

class NarrationModel(nn.Module):
    def __init__(self, vocab, d=96, heads=4, layers=2, ff=192, dropout=0.1):
        super().__init__()
        V, Mv, Tk = len(vocab['words']), len(vocab['meta']), len(vocab['tasks'])
        self.V = V
        self.word = nn.Embedding(V, d)
        self.meta = nn.Embedding(Mv, d, padding_idx=0)
        self.typ = nn.Embedding(3, d)
        self.pos = nn.Embedding(MAX_POS, d)
        self.num = nn.Linear(3, d)
        self.task = nn.Embedding(Tk, d)
        self.dpos = nn.Embedding(MAX_TGT + 1, d)
        self.glue_in = nn.Embedding(2, d)
        self.copied = nn.Linear(d, d)
        enc = nn.TransformerEncoderLayer(d, heads, ff, dropout, batch_first=True, norm_first=True)
        dec = nn.TransformerDecoderLayer(d, heads, ff, dropout, batch_first=True, norm_first=True)
        self.encoder = nn.TransformerEncoder(enc, layers, enable_nested_tensor=False)
        self.decoder = nn.TransformerDecoder(dec, layers)
        self.enc_norm = nn.LayerNorm(d)
        self.dec_norm = nn.LayerNorm(d)
        self.q = nn.Linear(d, d, bias=False)
        self.k = nn.Linear(d, d, bias=False)
        self.gen = nn.Linear(3 * d, 1)
        self.glue = nn.Linear(3 * d, 1)
        self.smoothing = 0.0

    def encode(self, b):
        x = self.word(b['tok']) + self.meta(b['meta']).sum(2) + self.typ(b['typ']) + self.pos(b['pos']) + self.num(b['num'])
        return self.enc_norm(self.encoder(x, src_key_padding_mask=b['mmask']))

    def embed_out(self, ids, glue, enc):
        """Joint ids -> decoder inputs: a vocab word's embedding, or the copied memory element."""
        B, T = ids.shape
        inv = ids < self.V
        e = self.word(ids.clamp(max=self.V - 1))
        j = (ids - self.V).clamp(min=0)
        c = self.copied(torch.gather(enc, 1, j.unsqueeze(-1).expand(B, T, enc.size(-1))))
        return torch.where(inv.unsqueeze(-1), e, c) + self.glue_in(glue.long())

    def step_dist(self, hdec, xin, enc, b):
        """Decoder states -> log-probs over [vocab | memory], plus the context for glue."""
        logits = hdec @ self.word.weight.t()
        pv = logits.softmax(-1)
        a = (self.q(hdec) @ self.k(enc).transpose(1, 2)) / math.sqrt(enc.size(-1))
        a = a.masked_fill(b['mmask'].unsqueeze(1), -1e9).softmax(-1)
        ctx = a @ enc
        pg = torch.sigmoid(self.gen(torch.cat([hdec, ctx, xin], -1)))
        B, T, M = a.shape
        dist = torch.zeros(B, T, self.V + M, device=hdec.device)
        dist[..., : self.V] = pg * pv
        dist.scatter_add_(2, b['canon'].unsqueeze(1).expand(B, T, M), (1 - pg) * a)
        return torch.log(dist + 1e-9), ctx

    def glue_logit(self, hdec, ctx, ids, enc):
        """Whether the chosen piece joins the one before it, given the piece."""
        e = self.embed_out(ids, torch.zeros_like(ids), enc)
        return self.glue(torch.cat([hdec, ctx, e], -1)).squeeze(-1)

    def decode(self, xin, enc, b):
        T = xin.size(1)
        causal = torch.triu(torch.full((T, T), float('-inf'), device=xin.device), 1)
        x = xin + self.dpos(torch.arange(T, device=xin.device))
        return self.dec_norm(self.decoder(x, enc, tgt_mask=causal, memory_key_padding_mask=b['mmask']))

    def forward(self, b):
        enc = self.encode(b)
        B = enc.size(0)
        start = self.task(b['task']).unsqueeze(1)
        prev = self.embed_out(b['tgt'][:, :-1], b['glue'][:, :-1], enc)
        xin = torch.cat([start, prev], 1)
        hdec = self.decode(xin, enc, b)
        logp, ctx = self.step_dist(hdec, xin, enc, b)
        glue = self.glue_logit(hdec, ctx, b['tgt'], enc)
        nll = -logp.gather(2, b['tgt'].unsqueeze(-1)).squeeze(-1)
        keep = ~b['tmask']
        gl = F.binary_cross_entropy_with_logits(glue, b['glue'], reduction='none')
        tokacc = (logp.argmax(-1) == b['tgt'])[keep].float().mean()
        loss = nll[keep].mean()
        if self.smoothing:  # spread a little mass over the vocabulary: steadier, less overconfident
            loss = (1 - self.smoothing) * loss + self.smoothing * -logp[..., : self.V].mean(-1)[keep].mean()
        return loss + 0.2 * gl[keep].mean(), tokacc

    @torch.no_grad()
    def generate(self, b, max_len=MAX_TGT):
        enc = self.encode(b)
        B = enc.size(0)
        xin = self.task(b['task']).unsqueeze(1)
        out = torch.zeros(B, 0, dtype=torch.long, device=enc.device)
        glues = torch.zeros(B, 0, device=enc.device)
        done = torch.zeros(B, dtype=torch.bool, device=enc.device)
        for _ in range(max_len):
            hdec = self.decode(xin, enc, b)
            logp, ctx = self.step_dist(hdec[:, -1:], xin[:, -1:], enc, b)
            lp = logp[:, 0]
            if out.size(1):  # never the same word twice in a row
                lp = lp.scatter(1, out[:, -1:], -1e9)
            nxt = lp.argmax(-1)
            nxt = torch.where(done, torch.full_like(nxt, EOS), nxt)
            g = (self.glue_logit(hdec[:, -1:], ctx, nxt[:, None], enc)[:, 0] > 0).float()
            out = torch.cat([out, nxt[:, None]], 1)
            glues = torch.cat([glues, g[:, None]], 1)
            done |= nxt == EOS
            if done.all():
                break
            xin = torch.cat([xin, self.embed_out(nxt[:, None], g[:, None], enc)], 1)
        return out.tolist(), glues.tolist()


@torch.no_grad()
def beam_search(model, b, k=4, max_len=MAX_TGT, alpha=0.7, block=3, bans=None):
    """Beam search that never repeats a word twice running or any `block`-word phrase.
    -> per example, up to k (ids, glues, score) sorted best first (score is length-normalised)."""
    enc = model.encode(b)
    B, M, d = enc.shape
    rep = lambda t: t.repeat_interleave(k, 0)
    enc = rep(enc)
    bb = {'mmask': rep(b['mmask']), 'canon': rep(b['canon'])}
    xin = rep(model.task(b['task']).unsqueeze(1))
    scores = torch.full((B, k), -1e9, device=enc.device)
    scores[:, 0] = 0.0
    hist = [[] for _ in range(B * k)]
    glues = [[] for _ in range(B * k)]
    done = [False] * (B * k)
    finished = [[] for _ in range(B)]
    fixed = None
    if bans:
        fixed = torch.zeros(B, model.V, dtype=torch.bool)
        for i, ids in enumerate(bans):
            fixed[i, ids] = True
        fixed = fixed.repeat_interleave(k, 0).to(enc.device)
    for step in range(max_len):
        hdec = model.decode(xin, enc, bb)
        logp, ctx = model.step_dist(hdec[:, -1:], xin[:, -1:], enc, bb)
        lp = logp[:, 0]
        J = lp.size(1)
        ban = torch.zeros_like(lp, dtype=torch.bool)
        if fixed is not None:
            ban[:, : model.V] = fixed
        for i, h in enumerate(hist):
            if done[i]:
                ban[i] = True
                continue
            if h:
                ban[i, h[-1]] = True
            if len(h) >= block - 1:
                tail = tuple(h[-(block - 1):])
                for j in range(len(h) - block + 1):
                    if tuple(h[j: j + block - 1]) == tail:
                        ban[i, h[j + block - 1]] = True
        lp = lp.masked_fill(ban, -1e9)
        total = (scores.view(-1, 1) + lp).view(B, k * J)
        top, idx = total.topk(k, dim=1)
        parent = (idx // J) + torch.arange(B, device=enc.device)[:, None] * k
        tok = idx % J
        pf, tf = parent.view(-1), tok.view(-1)
        g = (model.glue_logit(hdec[pf, -1:], ctx[pf], tf[:, None], enc[pf])[:, 0] > 0).float()
        new_hist, new_glues, new_done = [], [], []
        scores = top.clone()
        for n, (pi, t, gi) in enumerate(zip(pf.tolist(), tf.tolist(), g.tolist())):
            h, gl = hist[pi] + [t], glues[pi] + [gi]
            ex = n // k
            if t == EOS or step == max_len - 1:
                if top.view(-1)[n] > -1e8:
                    finished[ex].append((h, gl, top.view(-1)[n].item() / (len(h) ** alpha)))
                scores.view(-1)[n] = -1e9
                new_done.append(True)
            else:
                new_done.append(top.view(-1)[n].item() <= -1e8)
            new_hist.append(h)
            new_glues.append(gl)
        hist, glues, done = new_hist, new_glues, new_done
        if all(len(f) >= k for f in finished) or all(done):
            break
        nxt = tf.clone()
        nxt[nxt == EOS] = PAD
        xin = torch.cat([xin[pf], model.embed_out(nxt[:, None], g[:, None], enc[pf])], 1)
        enc, bb = enc[pf], {'mmask': bb['mmask'][pf], 'canon': bb['canon'][pf]}
    return [sorted(f, key=lambda c: -c[2])[:k] for f in finished]


def to_text(ids, glues, ex, words, V):
    ps = []
    for i, g in zip(ids, glues):
        if i == EOS:
            break
        p = words[i] if i < V else ex['surf'][i - V]
        ps.append((p, bool(g)))
    return detok(ps)


# ---------------------------------------------------------------- eval

def fact_pieces(text):
    return [p for p, _ in pieces(text) if is_fact_piece(p)]


def score(samples):
    by = defaultdict(lambda: dict(n=0, exact=0, fp=0, fp_ok=0, fr=0, fr_ok=0, stray=0))
    for s in samples:
        t = by[s['task']]
        t['n'] += 1
        if not s['target']:
            continue
        t['exact'] += s['output'] == s['target']
        out, ref = fact_pieces(s['output']), Counter(fact_pieces(s['target']))
        t['fp'] += len(out)
        t['fp_ok'] += sum(1 for p in out if ref[p] > 0)
        o = Counter(out)
        t['fr'] += sum(ref.values())
        t['fr_ok'] += sum(min(n, o[p]) for p, n in ref.items())
    res = {}
    for task, t in by.items():
        r = {'n': t['n']}
        if t['fp'] or t['fr'] or t['exact']:
            r['exact'] = round(t['exact'] / t['n'], 4)
            r['fact_precision'] = round(t['fp_ok'] / t['fp'], 4) if t['fp'] else None
            r['fact_recall'] = round(t['fr_ok'] / t['fr'], 4) if t['fr'] else None
        res[task] = r
    return res


def batches(exs, size, shuffle, rng=None):
    idx = list(range(len(exs)))
    if shuffle:
        rng.shuffle(idx)
    else:
        idx.sort(key=lambda i: len(exs[i]['tok']))
    for i in range(0, len(idx), size):
        if shuffle and i + size > len(idx):
            break  # a short last batch would be one more shape to compile
        yield [exs[j] for j in idx[i: i + size]]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('pairs', nargs='+')
    ap.add_argument('--out', required=True)
    ap.add_argument('--epochs', type=float, default=6)
    ap.add_argument('--d', type=int, default=96)
    ap.add_argument('--ff', type=int, default=192)
    ap.add_argument('--layers', type=int, default=2)
    ap.add_argument('--batch-size', type=int, default=64)
    ap.add_argument('--lr', type=float, default=2e-3)
    ap.add_argument('--device', default='cuda' if torch.cuda.is_available() else 'mps' if torch.backends.mps.is_available() else 'cpu')
    ap.add_argument('--test-fraction', type=float, default=0.2)
    ap.add_argument('--quote-weight', type=int, default=20, help='repeat each model-voice row this many times')
    ap.add_argument('--max-rows', type=int)
    ap.add_argument('--max-per-task', type=int, help='cap training rows per task (entity notes dominate)')
    ap.add_argument('--eval-max', type=int, default=600, help='held-out rows per task to generate')
    ap.add_argument('--seed', type=int, default=0)
    ap.add_argument('--load', help='a trained run dir: skip training and only evaluate its model')
    ap.add_argument('--beam', type=int, default=4, help='beam width; samples keep every finished candidate')
    ap.add_argument('--smoothing', type=float, default=0.05, help='label smoothing over the vocabulary')
    a = ap.parse_args()
    import os
    os.makedirs(a.out, exist_ok=True)
    torch.manual_seed(a.seed)
    rng = random.Random(a.seed)

    rows = load_rows(a.pairs, a.max_rows)
    prompts = [r for r in rows if r['source'] == 'prompt']
    rows = [r for r in rows if r['source'] != 'prompt']
    train, test, test_seeds = split(rows, a.test_fraction)
    _, test_prompts, _ = split(prompts, a.test_fraction) if prompts else ([], [], [])
    test_prompts = [p for p in test_prompts if all(s in test_seeds for s in p.get('seeds') or [])]
    if a.max_per_task:
        rng.shuffle(train)
        seen = Counter()
        train = [r for r in train if (seen.update([r['task']]) or seen[r['task']] <= a.max_per_task)]
    vocab = json.load(open(f'{a.load}/vocab.json')) if a.load else build_vocab(train)
    E = Encoder(vocab)
    print(f'rows {len(rows)} train {len(train)} test {len(test)} prompts {len(test_prompts)} held-out seeds {test_seeds}')
    print(f'vocab {len(vocab["words"])} words, {len(vocab["meta"])} meta, tasks {vocab["tasks"]}')
    print('train by task', dict(Counter(r['task'] for r in train)), 'test by task', dict(Counter(r['task'] for r in test)))

    tr = [E.example(r) for r in train]
    tr += [e for e in tr if e['row']['source'] == 'model'] * (a.quote_weight - 1)
    model = NarrationModel(vocab, d=a.d, layers=a.layers, ff=a.ff).to(a.device)
    model.smoothing = a.smoothing
    nparam = sum(p.numel() for p in model.parameters())
    print(f'params {nparam:,} (~{nparam / 1024:.0f} KB at int8)')

    if a.load:
        ck = torch.load(f'{a.load}/model.pt', map_location=a.device)
        model.load_state_dict(ck['state'])
    steps = 0 if a.load else math.ceil(len(tr) / a.batch_size) * a.epochs
    opt = torch.optim.AdamW(model.parameters(), lr=a.lr, weight_decay=0.01)
    sched = torch.optim.lr_scheduler.OneCycleLR(opt, max_lr=a.lr, total_steps=int(steps) + 1, pct_start=0.05)
    t0, step, ep = time.time(), 0, 0
    model.train()
    while step < steps:
        ep += 1
        for batch in batches(tr, a.batch_size, True, rng):
            if step >= steps:
                break
            loss, acc = model(collate(batch, a.device))
            opt.zero_grad()
            loss.backward()
            nn.utils.clip_grad_norm_(model.parameters(), 1.0)
            opt.step()
            sched.step()
            step += 1
            if step % 200 == 0:
                print(f'ep {ep} step {step}/{int(steps)} loss {loss.item():.3f} tokacc {acc.item():.3f} {time.time() - t0:.0f}s'
                      + (f' mps {torch.mps.driver_allocated_memory() / 2**30:.1f}G' if a.device == 'mps' else ''), flush=True)

    model.eval()
    by_task = defaultdict(list)
    for r in test:
        by_task[r['task']].append(r)
    evalrows = []
    for task, rs in by_task.items():
        rng.shuffle(rs)
        evalrows += rs[: a.eval_max]
    rng.shuffle(test_prompts)
    evalrows += test_prompts[: a.eval_max]
    samples = []
    exs = [E.example(r) for r in evalrows]
    for batch in batches(exs, 64, False):
        cands = beam_search(model, collate(batch, a.device), k=a.beam, bans=[e['ban'] for e in batch])
        for ex, cs in zip(batch, cands):
            r = ex['row']
            outs = [to_text(i, g, ex, vocab['words'], E.V) for i, g, _ in cs] or ['']
            samples.append({'key': r['key'], 'task': r['task'], 'source': r['source'], 'target': r['target'],
                            'output': outs[0], 'outputs': outs})
    metrics = {'params': nparam, 'train_rows': len(train), 'test_rows': len(test), 'held_out_seeds': test_seeds,
               'seconds': round(time.time() - t0), 'tasks': score(samples), 'args': vars(a)}
    print(json.dumps(metrics['tasks'], indent=1))
    with open(f'{a.out}/samples.jsonl', 'w') as fh:
        for s in samples:
            fh.write(json.dumps(s) + '\n')
    json.dump(metrics, open(f'{a.out}/metrics.json', 'w'), indent=1)
    json.dump(vocab, open(f'{a.out}/vocab.json', 'w'))
    torch.save({'state': model.state_dict(), 'config': {'d': a.d, 'layers': a.layers, 'ff': a.ff}}, f'{a.out}/model.pt')


if __name__ == '__main__':
    main()
