#!/usr/bin/env python3
"""The narration student: card triples in, a quote out (docs/handoff-narration-model.md).

  python scripts/narration-student.py STUDENT.jsonl --out DIR --held-out 1,2,3 [--val-seeds 4]
      [--pretrain-epochs 6] [--finetune-epochs 12] [--device cuda]

STUDENT.jsonl comes from scripts/narration-student-export.js: triples and texts with names,
places and numbers as role tokens (src/narration-roles.js).

Built on the decision student's machinery (twm/decision/model.py, DecisionSetModel with
state_layers=0):
  memory   one token per triple: scope + attribute + value + num * num_dir[attribute],
           layer-normed, no encoder. Values are closed tables (enums, role tokens, numbers);
           free text comes in as the mean of its words' embeddings (the output word table).
           Scopes are paths ("options:do/effects:0"), so their parts are summed. A list
           item's year also adds a closed "years ago" part (ago:0 … ago:11+, vocab year_ago).
           With vocab stance_who, a stance's lean token also carries its group's words
           ("stances:0 lean for" + "farmers"), so who-holds-what sits in one token.
  decoder  a causal transformer over the text, started by a task token, cross-attending to
           the memory. The output layer is tied to the word table. Role tokens are ordinary
           words, so names and numbers are never spelled, only placed.
  decoding beam search; never a role the card lacks, a number or dramatic word its facts lack,
           a word twice running, or a three-token phrase twice.
Training: pretrain on every hosted reply (all quotes and option lines), then fine-tune on the
quotes that pass the narrator's checks. Seeds split train / validation / test; validation
cards train the quality head (scripts/narration-quality.py), test cards are reported.

Writes DIR/model.pt, DIR/vocab.json, DIR/metrics.json, DIR/samples.jsonl ({key, split, roles,
outputs: [text with role tokens], feats: [per candidate]}).
"""
import argparse
import hashlib
import json
import math
import os
import random
import re
import time
from collections import Counter

import numpy as np
import torch
import torch.nn as nn
import torch.nn.functional as F

PIECE = re.compile(r"<[^<>\s]+>|[A-Za-z]+|'[A-Za-z]+|\d+(?:\.\d+)?|[^\sA-Za-z\d]")
PAD, UNK, EOS, BOS = 0, 1, 2, 3
SPECIALS = ['<pad>', '<unk>', '<eos>', '<bos>']
TYPES = {'enum': 1, 'num': 2, 'text': 3, 'role': 4}
NUMBER_WORDS = {'three': 3, 'four': 4, 'five': 5, 'six': 6, 'seven': 7, 'eight': 8, 'nine': 9, 'ten': 10, 'eleven': 11,
                'twelve': 12, 'thirteen': 13, 'fourteen': 14, 'fifteen': 15, 'sixteen': 16, 'seventeen': 17,
                'eighteen': 18, 'nineteen': 19, 'twenty': 20, 'thirty': 30, 'forty': 40, 'fifty': 50, 'sixty': 60,
                'seventy': 70, 'eighty': 80, 'ninety': 90, 'hundred': 100, 'thousand': 1000, 'dozen': 12, 'score': 20}
DRAMA = {'starve', 'starving', 'starvation', 'die', 'dies', 'dying', 'dead', 'death', 'deaths', 'riot', 'riots',
         'famine', 'plague', 'war', 'burn', 'burning', 'murder', 'ruin', 'ruined', 'collapse', 'hungrier', 'survive'}
MAX_TGT, MAX_BAG = 112, 24
YEAR_ATTRS = {'year', 'since', 'from', 'to'}


def years_ago(scope, attr, n, typ):
    """A list item's year field -> how many years before the sheet's year, else None. The
    triple's num is the offset, scaled as narration-features.js scales it (sign·ln(1+|x|)
    past 1), which the model barely reads (handoff 1i); with the vocab's `year_ago` the codec
    also adds a closed value to the triple's scope parts ("ago:2"). Off by default: the
    model read years 2-3x more but timed past rulings no better."""
    if typ != 'num' or attr not in YEAR_ATTRS or n is None or ':' not in scope:
        return None
    x = abs(float(n))
    k = round(x if x <= 1 else math.expm1(x))
    return -k if n > 0 else k


def ago_part(k):
    return 'ago:ahead' if k < 0 else f'ago:{k}' if k <= 5 else 'ago:6-10' if k <= 10 else 'ago:11+'


def tokens(text):
    """text -> word tokens; a piece joined to the one before it is '##piece'."""
    out = []
    for chunk in str(text).split():
        for i, p in enumerate(PIECE.findall(chunk)):
            out.append(p if i == 0 else '##' + p)
    return out


SPACE = '\u2581'


class BPE:
    """Subword tokens (scripts/narration-bpe.py): a piece after a space starts with '▁';
    role tokens stay whole; merges apply in rank order."""
    def __init__(self, spec):
        self.rank = {(a, b): i for i, (a, b) in enumerate(spec['merges'])}
        self.cache = {}

    def unit(self, u):
        if u in self.cache:
            return self.cache[u]
        if u.lstrip(SPACE).startswith('<'):
            word = [u]
        else:
            word = list(u)
            while len(word) > 1:
                r, i = min((self.rank.get((word[j], word[j + 1]), math.inf), j) for j in range(len(word) - 1))
                if r == math.inf:
                    break
                word = word[:i] + [word[i] + word[i + 1]] + word[i + 2:]
        self.cache[u] = word
        return word

    def tokens(self, text):
        out = []
        for chunk in str(text).split():
            for i, p in enumerate(PIECE.findall(chunk)):
                out += self.unit(p if i else SPACE + p)
        return out

    @staticmethod
    def detok(toks):
        return ''.join(toks).replace(SPACE, ' ').strip()


def detok(toks):
    s = ''
    for t in toks:
        s += t[2:] if t.startswith('##') else (' ' if s else '') + t
    return s


def h(x):
    return int(hashlib.sha256(str(x).encode()).hexdigest()[:8], 16)


# ---------------------------------------------------------------- data

def stream(path):
    with open(path) as fh:
        for line in fh:
            if line.strip():
                yield json.loads(line)


def part_of(r, held_out, val):
    ss = r.get('seeds') or []
    if ss and all(s in held_out for s in ss):
        return 'test'
    if ss and all(s in val for s in ss):
        return 'val'
    if not any(s in held_out or s in val for s in ss):
        return 'train'
    return None


def split_rows(rows, held_out, n_val):
    seeds = sorted({s for r in rows for s in r.get('seeds') or []}, key=h)
    rest = [s for s in seeds if s not in held_out]
    val = set(rest[:n_val])
    part = {'train': [], 'val': [], 'test': []}
    for r in rows:
        ss = r.get('seeds') or []
        if ss and all(s in held_out for s in ss):
            part['test'].append(r)
        elif ss and all(s in val for s in ss):
            part['val'].append(r)
        elif not any(s in held_out or s in val for s in ss):
            part['train'].append(r)
    return part, sorted(val)


def build_vocab(train, bpe=None, records=False, year_ago=False, stance_who=False):
    words, scopes, attrs, values = Counter(), Counter(), Counter(), Counter()
    for r in train:
        if not bpe:
            words.update(tokens(r['target']))
        for scope, attr, value, num, typ in r['triples']:
            scopes.update(re.split(r'[:/]', scope))
            if records and ':' in scope:
                scopes[scope] += 1   # the record itself ("past:0"); off by default: it hurt (handoff 1h)
            if year_ago and (k := years_ago(scope, attr, num, typ)) is not None:
                scopes[ago_part(k)] += 1
            attrs[attr] += 1
            if typ != 'text':
                values[f'{typ}:{value}'] += 1
    keep = lambda c, n: [k for k, v in sorted(c.items(), key=lambda kv: -kv[1]) if v >= n]
    if bpe:
        roles = [f for r in bpe['roles'] for f in (r, SPACE + r)]
        vocab_words = SPECIALS + [w for w in dict.fromkeys(roles + bpe['symbols']) if w not in SPECIALS]
    else:
        vocab_words = SPECIALS + [w for w in keep(words, 3) if w not in SPECIALS]
    return {'words': vocab_words, **({'record_scopes': True} if records else {}), **({'year_ago': True} if year_ago else {}), **({'stance_who': True} if stance_who else {}), **({'bpe': {'merges': bpe['merges']}} if bpe else {}),
            'scopes': ['<pad>', '<unk>'] + keep(scopes, 1), 'attrs': ['<pad>', '<unk>'] + keep(attrs, 1),
            'values': ['<pad>', '<unk>'] + keep(values, 3), 'tasks': ['card.quote', 'card.option']}


class Codec:
    def __init__(self, vocab):
        self.v = vocab
        self.w = {t: i for i, t in enumerate(vocab['words'])}
        self.sc = {t: i for i, t in enumerate(vocab['scopes'])}
        self.at = {t: i for i, t in enumerate(vocab['attrs'])}
        self.va = {t: i for i, t in enumerate(vocab['values'])}
        self.tk = {t: i for i, t in enumerate(vocab['tasks'])}
        self.bpe = BPE(vocab['bpe']) if 'bpe' in vocab else None
        self.records = bool(vocab.get('record_scopes'))
        self.year_ago = bool(vocab.get('year_ago'))
        self.stance_who = bool(vocab.get('stance_who'))
        self.tok = self.bpe.tokens if self.bpe else tokens
        self.detok = BPE.detok if self.bpe else detok
        self.max_bag = 40 if self.bpe else MAX_BAG
        bare = (lambda t: t[1:] if t.startswith(SPACE) else None) if self.bpe else (lambda t: t)
        self.bare = [bare(t) if i >= len(SPECIALS) else None for i, t in enumerate(vocab['words'])]
        self.number_words = {i: NUMBER_WORDS[b.lower()] for i, b in enumerate(self.bare) if b and b.lower() in NUMBER_WORDS}
        self.drama = {i for i, b in enumerate(self.bare) if b and b.lower() in DRAMA}
        if self.bpe:   # numbers in the facts come as role tokens; any other digits are banned
            self.digits = {i for t, i in self.w.items() if i >= len(SPECIALS) and re.search(r'\d', t) and not t.lstrip(SPACE).startswith('<')}
        else:
            self.digits = {i for t, i in self.w.items() if t.lstrip('#').isdigit()}
        self.roles = {i for t, i in self.w.items() if t.lstrip(SPACE).startswith('<') and i >= len(SPECIALS)}
        # Word keys for repeat blocking, as the fluency check sees words: no punctuation, any case.
        self.key = [None] * len(vocab['words'])
        self.ids_of = {}
        for t, i in self.w.items():
            k = (self.bare[i] or '').lower() if self.bpe else t.lstrip('#').lower()
            if i >= len(SPECIALS) and re.match(r"^(<.*>|[a-z0-9']+)$", k):
                self.key[i] = k
                self.ids_of.setdefault(k, []).append(i)

    def words_of(self, ids):
        """The words written so far, as the fluency check sees them."""
        if not self.bpe:
            return [self.key[t] for t in ids if self.key[t]]
        return re.findall(r"<[^<>\s]+>|[a-z0-9']+", self.detok([self.v['words'][t] for t in ids]).lower())

    def example(self, r, compact=False):
        """compact: numpy arrays only, no bans and no row (training rows; memory matters)."""
        sc, at, va, bag, num, hasn, unk = [], [], [], [], [], [], 0
        facts_text, agos = [], []
        # A stance's group, to fold into its lean token (stance_who): the model read leans but
        # did not tie them to their groups across tokens (handoff 1i).
        who = {sc: v for sc, at, v, _, ty in r['triples'] if at == 'who' and ty == 'text' and sc.startswith('stances:')} if self.stance_who else {}
        for scope, attr, value, n, typ in r['triples']:
            parts = [self.sc.get(p, 1) for p in re.split(r'[:/]', scope)][:4]
            if self.records and ':' in scope:
                parts.append(self.sc.get(scope, 1))
            if self.year_ago and (k := years_ago(scope, attr, n, typ)) is not None:
                parts.append(self.sc.get(ago_part(k), 1))
                agos.append(k)
            parts = parts[:5]
            sc.append(parts + [0] * (5 - len(parts)))
            at.append(self.at.get(attr, 1))
            if typ == 'text':
                ids = [self.w.get(t, UNK) for t in self.tok(value)][:self.max_bag] or [UNK]
                va.append(0)
                bag.append(ids)
                unk += sum(i == UNK for i in ids) / len(ids)
                facts_text.append(str(value).lower())
            else:
                vid = self.va.get(f'{typ}:{value}', 1)
                va.append(vid)
                g = who.get(scope) if attr == 'lean' else None
                bag.append(([self.w.get(t, UNK) for t in self.tok(g)][:self.max_bag] or [UNK]) if g else [])
                unk += vid == 1
            num.append(float(n) if n is not None else 0.0)
            hasn.append(1.0 if n is not None else 0.0)
        tgt = [self.w.get(t, UNK) for t in self.tok(r['target'])][: MAX_TGT - 1] + [EOS] if r['target'] else [EOS]
        # What this card may not say: roles it lacks, numbers and dramatic words its facts lack.
        nums = {0, 1, 2} | {k for k in agos if 0 < k <= 12}   # "three years ago" when it was
        for t in ' '.join(facts_text + list(r.get('roles', {}).values())).split():
            t = t.strip('.,;:!?').replace(',', '')
            if t.isdigit():
                nums.add(int(t))
            if t in NUMBER_WORDS:
                nums.add(NUMBER_WORDS[t])
        text = set(re.findall(r'[a-z]+', ' '.join(facts_text)))
        roles = r.get('roles', {})
        ban = [i for i in self.roles if self.v['words'][i].lstrip(SPACE) not in roles]
        ban += [i for i, n in self.number_words.items() if n not in nums]
        ban += [i for i in self.drama if self.bare[i].lower() not in text]
        ban += list(self.digits) if self.bpe else [i for i in self.digits if int(self.v['words'][i].lstrip('#')) not in nums]
        return {'sc': sc, 'at': at, 'va': va, 'bag': bag, 'num': num, 'hasn': hasn, 'tgt': tgt,
                'task': self.tk.get(r['task'], 0), 'unk': unk / max(1, len(at)), 'ban': ban, 'row': r}

    def compact(self, r):
        e = self.example(r)
        i16 = lambda x: np.asarray(x, dtype=np.int16)
        return {'sc': i16(e['sc']), 'at': i16(e['at']), 'va': i16(e['va']),
                'bag_flat': i16([t for b in e['bag'] for t in b]), 'bag_len': i16([len(b) for b in e['bag']]),
                'num': np.asarray(e['num'], dtype=np.float32), 'hasn': np.asarray(e['hasn'], dtype=np.float32),
                'tgt': i16(e['tgt']), 'task': e['task'], 'unk': e['unk']}


def collate(batch, device):
    B = len(batch)
    T = -(-max(len(e['at']) for e in batch) // 16) * 16
    lens = lambda e: e['bag_len'] if 'bag_len' in e else [len(b) for b in e['bag']]
    L = -(-max([int(n) for e in batch for n in lens(e)] + [1]) // 8) * 8
    Y = -(-max(len(e['tgt']) for e in batch) // 16) * 16
    sc = torch.zeros(B, T, 5, dtype=torch.long)
    at = torch.zeros(B, T, dtype=torch.long)
    va = torch.zeros(B, T, dtype=torch.long)
    bag = torch.zeros(B, T, L, dtype=torch.long)
    num = torch.zeros(B, T)
    hasn = torch.zeros(B, T)
    mmask = torch.ones(B, T, dtype=torch.bool)
    tgt = torch.zeros(B, Y, dtype=torch.long)
    for i, e in enumerate(batch):
        n = len(e['at'])
        sc[i, :n] = torch.as_tensor(np.asarray(e['sc'], dtype=np.int64))
        at[i, :n] = torch.as_tensor(np.asarray(e['at'], dtype=np.int64))
        va[i, :n] = torch.as_tensor(np.asarray(e['va'], dtype=np.int64))
        if 'bag_flat' in e:
            off = 0
            for j, k in enumerate(e['bag_len'].tolist()):
                if k:
                    bag[i, j, :k] = torch.as_tensor(e['bag_flat'][off: off + k].astype(np.int64))
                off += k
        else:
            for j, b in enumerate(e['bag']):
                if len(b):
                    bag[i, j, :len(b)] = torch.as_tensor(np.asarray(b, dtype=np.int64))
        num[i, :n] = torch.as_tensor(np.asarray(e['num'], dtype=np.float32))
        hasn[i, :n] = torch.as_tensor(np.asarray(e['hasn'], dtype=np.float32))
        mmask[i, :n] = False
        tgt[i, :len(e['tgt'])] = torch.as_tensor(np.asarray(e['tgt'], dtype=np.int64))
    task = torch.tensor([e['task'] for e in batch])
    d = dict(sc=sc, at=at, va=va, bag=bag, num=num, hasn=hasn, mmask=mmask, tgt=tgt, task=task)
    return {k: v.to(device) for k, v in d.items()}


# ---------------------------------------------------------------- model

class FakeQuant(nn.Module):
    """Quantization-aware training: the weight as the int4/int8 export will store it (symmetric,
    an fp16 scale per `group` values of a row; int8 one per row), gradients passed straight
    through. Applied as a parametrization, so every use of the weight sees the rounded one."""
    def __init__(self, bits, group):
        super().__init__()
        self.qmax, self.bits, self.group = (127 if bits == 8 else 7), bits, group

    def forward(self, w):
        rows, cols = w.shape
        g = cols if self.bits == 8 else min(self.group, cols)
        wp = F.pad(w, (0, (-cols) % g)).view(rows, -1, g)
        scale = (wp.detach().abs().amax(2, keepdim=True) / self.qmax).half().float()
        scale = torch.where(scale == 0, torch.ones_like(scale), scale)
        q = torch.clamp(torch.round(wp / scale), -self.qmax, self.qmax) * scale
        return (wp + (q - wp).detach()).view(rows, -1)[:, :cols]


def quantize_aware(model, bits, group, on=True):
    """Add (or remove, keeping the float weights) fake quantization on every 2-D weight."""
    from torch.nn.utils import parametrize
    modules = list(model.modules())   # registering adds modules: list them first
    for module in modules:
        if on:
            for name, p in list(module.named_parameters(recurse=False)):
                if p.dim() == 2 and not parametrize.is_parametrized(module, name):
                    parametrize.register_parametrization(module, name, FakeQuant(bits, group))
        elif parametrize.is_parametrized(module):
            for name in list(module.parametrizations.keys()):
                parametrize.remove_parametrizations(module, name, leave_parametrized=False)


class DecoderLayer(nn.Module):
    """Pre-norm decoder layer, named as nn.TransformerDecoderLayer names its weights.
    ffn 'relu': linear2(relu(linear1 x)); 'swiglu': down(silu(gate x) * up x), no biases."""
    def __init__(self, d, heads, ff, dropout, ffn):
        super().__init__()
        self.self_attn = nn.MultiheadAttention(d, heads, dropout=dropout, batch_first=True)
        self.multihead_attn = nn.MultiheadAttention(d, heads, dropout=dropout, batch_first=True)
        self.norm1, self.norm2, self.norm3 = nn.LayerNorm(d), nn.LayerNorm(d), nn.LayerNorm(d)
        self.drop = nn.Dropout(dropout)
        self.ffn = ffn
        if ffn == 'swiglu':
            self.gate = nn.Linear(d, ff, bias=False)
            self.up = nn.Linear(d, ff, bias=False)
            self.down = nn.Linear(ff, d, bias=False)
        else:
            self.linear1 = nn.Linear(d, ff)
            self.linear2 = nn.Linear(ff, d)

    def forward(self, x, mem, causal, mmask):
        a = self.norm1(x)
        x = x + self.drop(self.self_attn(a, a, a, attn_mask=causal, need_weights=False)[0])
        a = self.norm2(x)
        x = x + self.drop(self.multihead_attn(a, mem, mem, key_padding_mask=mmask, need_weights=False)[0])
        a = self.norm3(x)
        if self.ffn == 'swiglu':
            h = self.down(self.drop(F.silu(self.gate(a)) * self.up(a)))
        else:
            h = self.linear2(self.drop(F.relu(self.linear1(a))))
        return x + self.drop(h)

class NarrationStudent(nn.Module):
    def __init__(self, vocab, d=96, e=64, heads=4, layers=4, ff=192, dropout=0.1, ffn='relu'):
        super().__init__()
        V = len(vocab['words'])
        self.V = V
        # The decision student's triple embedding, in a small space shared with the words.
        self.word = nn.Embedding(V, e, padding_idx=0)
        self.scope = nn.Embedding(len(vocab['scopes']), e, padding_idx=0)
        self.attr = nn.Embedding(len(vocab['attrs']), e, padding_idx=0)
        self.value = nn.Embedding(len(vocab['values']), e, padding_idx=0)
        self.num_dir = nn.Embedding(len(vocab['attrs']), e, padding_idx=0)
        self.up = nn.Linear(e, d, bias=False)
        self.state_norm = nn.LayerNorm(d)
        self.task = nn.Embedding(len(vocab['tasks']), d)
        self.pos = nn.Embedding(MAX_TGT + 1, d)
        self.decoder = nn.Module()
        self.decoder.layers = nn.ModuleList([DecoderLayer(d, heads, ff, dropout, ffn) for _ in range(layers)])
        self.out_norm = nn.LayerNorm(d)
        self.down = nn.Linear(d, e, bias=False)
        self.out_bias = nn.Parameter(torch.zeros(V))
        for t in (self.word, self.scope, self.attr, self.value, self.num_dir):
            nn.init.normal_(t.weight, 0, 0.1)
            # Padding must stay zero: a card reads the same whatever else is in its batch.
            with torch.no_grad():
                t.weight[0].zero_()
        self.smoothing = 0.0

    def memory(self, b):
        # Padding is masked, not just zeroed: the word table is tied to the output layer, so
        # its padding row is trained and would leak a batch-dependent amount into the card.
        real = (b['bag'] > 0).unsqueeze(-1)
        bag = self.word(b['bag']) * real                             # B T L e
        n = real.sum(2).clamp(min=1)
        x = self.scope(b['sc']).sum(2) + self.attr(b['at']) + self.value(b['va']) + bag.sum(2) / n \
            + (b['num'] * b['hasn']).unsqueeze(-1) * self.num_dir(b['at'])
        return self.state_norm(self.up(x))

    def run(self, prev, task, mem, mmask):
        x = torch.cat([self.task(task).unsqueeze(1), self.up(self.word(prev))], 1)
        T = x.size(1)
        x = x + self.pos(torch.arange(T, device=x.device))
        causal = torch.triu(torch.full((T, T), float('-inf'), device=x.device), 1)
        for layer in self.decoder.layers:
            x = layer(x, mem, causal, mmask)
        hdec = self.out_norm(x)
        return hdec, self.down(hdec) @ self.word.weight.t() + self.out_bias

    def forward(self, b):
        mem = self.memory(b)
        hdec, logits = self.run(b['tgt'][:, :-1], b['task'], mem, b['mmask'])
        keep = b['tgt'] != PAD
        loss = F.cross_entropy(logits[keep], b['tgt'][keep], label_smoothing=self.smoothing)
        acc = (logits.argmax(-1) == b['tgt'])[keep].float().mean()
        return loss, acc

    @torch.no_grad()
    def score(self, b, seqs):
        """Teacher-forced pass over finished candidates -> per-candidate features."""
        mem = self.memory(b)
        hdec, logits = self.run(seqs[:, :-1], b['task'], mem, b['mmask'])
        lp = logits.log_softmax(-1)
        tok = lp.gather(2, seqs.unsqueeze(-1)).squeeze(-1)
        keep = (seqs != PAD).float()
        ent = -(lp.exp() * lp).sum(-1)
        n = keep.sum(1).clamp(min=1)
        mean_lp = (tok * keep).sum(1) / n
        min_lp = (tok + (1 - keep) * 1e9).min(1).values
        mean_ent = (ent * keep).sum(1) / n
        hmean = (hdec * keep.unsqueeze(-1)).sum(1) / n.unsqueeze(-1)
        return torch.cat([torch.stack([mean_lp, min_lp, mean_ent, n / MAX_TGT], 1), hmean], 1)


@torch.no_grad()
def beam_search(model, b, bans, codec, k=4, alpha=0.7, block=3):
    mem = model.memory(b)
    B = mem.size(0)
    mem, mmask, task = mem.repeat_interleave(k, 0), b['mmask'].repeat_interleave(k, 0), b['task'].repeat_interleave(k, 0)
    fixed = torch.zeros(B, model.V, dtype=torch.bool)
    for i, ids in enumerate(bans):
        fixed[i, ids] = True
    fixed[:, [PAD, UNK, BOS]] = True
    fixed = fixed.repeat_interleave(k, 0).to(mem.device)
    scores = torch.full((B, k), -1e9, device=mem.device)
    scores[:, 0] = 0
    hist = [[] for _ in range(B * k)]
    finished = [[] for _ in range(B)]
    prev = torch.zeros(B * k, 0, dtype=torch.long, device=mem.device)
    for step in range(MAX_TGT):
        _, logits = model.run(prev, task, mem, mmask)
        lp = logits[:, -1].log_softmax(-1).masked_fill(fixed, -1e9)
        for i, hst in enumerate(hist):
            words = codec.words_of(hst)
            banned = set()
            if words:
                banned.add(words[-1])          # no word twice running
            if len(words) >= block - 1:        # no three-word phrase twice
                tail = words[-(block - 1):]
                for j in range(len(words) - block + 1):
                    if words[j: j + block - 1] == tail:
                        banned.add(words[j + block - 1])
            for w in banned:
                if w in codec.ids_of:
                    lp[i, codec.ids_of[w]] = -1e9
        total = (scores.view(-1, 1) + lp).view(B, -1)
        top, idx = total.topk(k, 1)
        parent = (idx // model.V) + torch.arange(B, device=mem.device)[:, None] * k
        tok = idx % model.V
        pf, tf = parent.view(-1), tok.view(-1)
        scores = top.clone()
        new_hist = []
        for n, (pi, t) in enumerate(zip(pf.tolist(), tf.tolist())):
            hs = hist[pi] + [t]
            s = top.view(-1)[n].item()
            if (t == EOS or step == MAX_TGT - 1) and s > -1e8:
                finished[n // k].append((hs, s / len(hs) ** alpha))
                scores.view(-1)[n] = -1e9
            new_hist.append(hs)
        hist = new_hist
        if all(len(f) >= k for f in finished) or (scores <= -1e8).all():
            break
        prev = torch.cat([prev[pf], tf.clamp(max=model.V - 1).masked_fill(tf == EOS, PAD)[:, None]], 1)
    return [sorted(f, key=lambda c: -c[1])[:k] for f in finished]


def batches(exs, size, shuffle, rng=None):
    idx = list(range(len(exs)))
    if shuffle:
        rng.shuffle(idx)
    for i in range(0, len(idx), size):
        if shuffle and i + size > len(idx):
            break
        yield [exs[j] for j in idx[i: i + size]]


def train_phase(model, exs, epochs, lr, a, rng, label):
    if not exs or epochs <= 0:
        return
    steps = int(math.ceil(len(exs) / a.batch_size) * epochs)
    opt = torch.optim.AdamW(model.parameters(), lr=lr, weight_decay=0.01)
    sched = torch.optim.lr_scheduler.OneCycleLR(opt, max_lr=lr, total_steps=steps + 1, pct_start=0.05)
    step, t0 = 0, time.time()
    model.train()
    while step < steps:
        for batch in batches(exs, a.batch_size, True, rng):
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
                print(f'{label} step {step}/{steps} loss {loss.item():.3f} tokacc {acc.item():.3f} {time.time() - t0:.0f}s', flush=True)


def main():
    global MAX_TGT
    ap = argparse.ArgumentParser()
    ap.add_argument('rows')
    ap.add_argument('--out', required=True)
    ap.add_argument('--held-out', required=True, help='test seeds, comma-separated (the earlier runs\' held-out towns)')
    ap.add_argument('--val-seeds', type=int, default=4)
    ap.add_argument('--pretrain-epochs', type=float, default=6)
    ap.add_argument('--finetune-epochs', type=float, default=12)
    ap.add_argument('--lr', type=float, default=2e-3)
    ap.add_argument('--batch-size', type=int, default=128)
    ap.add_argument('--d', type=int, default=96)
    ap.add_argument('--e', type=int, default=64)
    ap.add_argument('--layers', type=int, default=4)
    ap.add_argument('--ff', type=int, default=192)
    ap.add_argument('--ffn', choices=['relu', 'swiglu'], default='relu', help='feed-forward kind; swiglu at --ff 128 matches relu at 192 in size')
    ap.add_argument('--smoothing', type=float, default=0.05)
    ap.add_argument('--beam', type=int, default=4)
    ap.add_argument('--eval-max', type=int, default=600)
    ap.add_argument('--device', default='cuda' if torch.cuda.is_available() else 'mps' if torch.backends.mps.is_available() else 'cpu')
    ap.add_argument('--seed', type=int, default=0)
    ap.add_argument('--max-tgt', type=int, default=MAX_TGT, help='longest text in tokens (BPE text is longer)')
    ap.add_argument('--qat', type=int, choices=[0, 4, 8], default=4, help='quantization-aware fine-tuning for this export width (0: off)')
    ap.add_argument('--qat-group', type=int, default=32)
    ap.add_argument('--record-scopes', action='store_true', help='add a token per list item ("past:0"); hurt fact accuracy in v3')
    ap.add_argument('--stance-who', action='store_true', help="fold each stance's group words into its lean token")
    ap.add_argument('--year-ago', action='store_true', help='add a closed "years ago" part to list items\' years; read 2-3x more, no gain (handoff 1i)')
    ap.add_argument('--bpe', help='subword vocabulary from scripts/narration-bpe.py (default: whole words)')
    ap.add_argument('--load', help='a trained run dir: skip training and only quote cards with its model')
    a = ap.parse_args()
    MAX_TGT = a.max_tgt
    os.makedirs(a.out, exist_ok=True)
    torch.manual_seed(a.seed)
    rng = random.Random(a.seed)

    # Three passes over the rows file, keeping compact examples only: the file is large.
    held = {int(s) for s in a.held_out.split(',')}
    seeds = set()
    for r in stream(a.rows):
        seeds.update(r.get('seeds') or [])
    val = set([s for s in sorted(seeds, key=h) if s not in held][: a.val_seeds])
    val_seeds = sorted(val)
    is_train = lambda r: r['source'] != 'prompt' and part_of(r, held, val) == 'train'
    vocab = json.load(open(f'{a.load}/vocab.json')) if a.load else build_vocab((r for r in stream(a.rows) if is_train(r)), json.load(open(a.bpe)) if a.bpe else None, a.record_scopes, a.year_ago, a.stance_who)
    C = Codec(vocab)
    pre, fine, held_ex, prompts, counts = [], [], {'val': [], 'test': []}, {'val': [], 'test': []}, Counter()
    for r in stream(a.rows):
        p = part_of(r, held, val)
        if p == 'train' and r['source'] != 'prompt':
            counts[(r['task'], r['source'])] += 1
            if not a.load:
                ex = C.compact(r)
                pre.append(ex)
                if r['source'] == 'model':
                    fine.append(ex)
        elif p in held_ex and r['source'] == 'model':
            held_ex[p].append(C.compact(r))
        elif p in prompts and r['source'] == 'prompt':
            prompts[p].append(r)
    print(f'train {dict(counts)}')
    print(f'vocab {len(vocab["words"])} words ({len(C.roles)} roles), {len(vocab["values"])} values, '
          f'{len(vocab["scopes"])} scope parts, {len(vocab["attrs"])} attrs; val seeds {val_seeds}')

    model = NarrationStudent(vocab, d=a.d, e=a.e, layers=a.layers, ff=a.ff, ffn=a.ffn).to(a.device)
    model.smoothing = a.smoothing
    nparam = sum(p.numel() for p in model.parameters())
    print(f'params {nparam:,} (~{nparam / 1024:.0f} KB at int8)')

    t0 = time.time()
    if a.load:
        model.load_state_dict(torch.load(f'{a.load}/model.pt', map_location=a.device)['state'])
        a.pretrain_epochs = a.finetune_epochs = 0
    train_phase(model, pre if a.pretrain_epochs else [], a.pretrain_epochs, a.lr, a, rng, 'pretrain')
    if a.qat:   # fine-tune (and evaluate) with the weights as the export will round them
        quantize_aware(model, a.qat, a.qat_group)
    train_phase(model, fine, a.finetune_epochs, a.lr * 0.3, a, rng, 'finetune')

    # Held-out loss on passing quotes, then quotes for validation and test cards.
    model.eval()
    held_loss = {}
    for name in ('val', 'test'):
        exs = held_ex[name]
        ls = [model(collate(bt, a.device))[0].item() for bt in batches(exs, 128, False)]
        held_loss[name] = round(sum(ls) / max(1, len(ls)), 4)
    print('held-out loss on passing quotes', held_loss)
    samples = []
    for name in ('val', 'test'):
        rng.shuffle(prompts[name])
        exs = [C.example(r) for r in prompts[name][: a.eval_max]]
        for bt in batches(exs, 64, False):
            b = collate(bt, a.device)
            cands = beam_search(model, b, [e['ban'] for e in bt], C, k=a.beam)
            for j, (ex, cs) in enumerate(zip(bt, cands)):
                if not cs:
                    continue
                seqs = torch.zeros(len(cs), MAX_TGT, dtype=torch.long, device=a.device)
                for c, (ids, _) in enumerate(cs):
                    seqs[c, :len(ids)] = torch.tensor(ids)
                one = {k: v[j:j + 1].expand(len(cs), *v.shape[1:]) for k, v in b.items()}
                feats = model.score(one, seqs)
                feats = torch.cat([feats, torch.tensor([[s, ex['unk']] for _, s in cs], device=a.device)], 1)
                samples.append({'key': ex['row']['key'], 'split': name, 'roles': ex['row']['roles'],
                                'outputs': [C.detok([vocab['words'][i] for i in ids if i != EOS]) for ids, _ in cs],
                                'feats': [[round(x, 4) for x in f] for f in feats.tolist()]})
        print(f'{name}: {sum(s["split"] == name for s in samples)} cards quoted', flush=True)
    with open(f'{a.out}/samples.jsonl', 'w') as fh:
        for s in samples:
            fh.write(json.dumps(s) + '\n')
    metrics = {'params': nparam, 'held_out_loss': held_loss, 'seconds': round(time.time() - t0),
               'val_seeds': val_seeds, 'held_out': sorted(held), 'args': vars(a)}
    json.dump(metrics, open(f'{a.out}/metrics.json', 'w'), indent=1)
    json.dump(vocab, open(f'{a.out}/vocab.json', 'w'))
    if a.qat:   # save the float weights; the export rounds them exactly as training did
        quantize_aware(model, a.qat, a.qat_group, on=False)
    torch.save({'state': model.state_dict(), 'config': {k: getattr(a, k) for k in ('d', 'e', 'layers', 'ff', 'ffn', 'max_tgt', 'qat', 'qat_group')}}, f'{a.out}/model.pt')
    print(json.dumps(metrics))


if __name__ == '__main__':
    main()
