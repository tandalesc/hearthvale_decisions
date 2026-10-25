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
           Scopes are paths ("options:do/effects:0"), so their parts are summed.
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


def tokens(text):
    """text -> word tokens; a piece joined to the one before it is '##piece'."""
    out = []
    for chunk in str(text).split():
        for i, p in enumerate(PIECE.findall(chunk)):
            out.append(p if i == 0 else '##' + p)
    return out


def detok(toks):
    s = ''
    for t in toks:
        s += t[2:] if t.startswith('##') else (' ' if s else '') + t
    return s


def h(x):
    return int(hashlib.sha256(str(x).encode()).hexdigest()[:8], 16)


# ---------------------------------------------------------------- data

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


def build_vocab(train):
    words, scopes, attrs, values = Counter(), Counter(), Counter(), Counter()
    for r in train:
        words.update(tokens(r['target']))
        for scope, attr, value, num, typ in r['triples']:
            scopes.update(re.split(r'[:/]', scope))
            attrs[attr] += 1
            if typ != 'text':
                values[f'{typ}:{value}'] += 1
    keep = lambda c, n: [k for k, v in sorted(c.items(), key=lambda kv: -kv[1]) if v >= n]
    return {'words': SPECIALS + [w for w in keep(words, 3) if w not in SPECIALS],
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
        self.number_words = {i: NUMBER_WORDS[t.lower()] for t, i in self.w.items() if t.lower() in NUMBER_WORDS}
        self.drama = {i for t, i in self.w.items() if t.lower() in DRAMA}
        self.digits = {i for t, i in self.w.items() if t.lstrip('#').isdigit()}
        self.roles = {i for t, i in self.w.items() if t.startswith('<') and i >= len(SPECIALS)}
        # Word keys for repeat blocking, as the fluency check sees words: no punctuation, any case.
        self.key = [None] * len(vocab['words'])
        self.ids_of = {}
        for t, i in self.w.items():
            k = t.lstrip('#').lower()
            if i >= len(SPECIALS) and re.match(r"^(<.*>|[a-z0-9']+)$", k):
                self.key[i] = k
                self.ids_of.setdefault(k, []).append(i)

    def example(self, r):
        sc, at, va, bag, num, hasn, unk = [], [], [], [], [], [], 0
        facts_text = []
        for scope, attr, value, n, typ in r['triples']:
            parts = [self.sc.get(p, 1) for p in re.split(r'[:/]', scope)][:4]
            sc.append(parts + [0] * (4 - len(parts)))
            at.append(self.at.get(attr, 1))
            if typ == 'text':
                ids = [self.w.get(t, UNK) for t in tokens(value)][:MAX_BAG] or [UNK]
                va.append(0)
                bag.append(ids)
                unk += sum(i == UNK for i in ids) / len(ids)
                facts_text.append(str(value).lower())
            else:
                vid = self.va.get(f'{typ}:{value}', 1)
                va.append(vid)
                bag.append([])
                unk += vid == 1
            num.append(float(n) if n is not None else 0.0)
            hasn.append(1.0 if n is not None else 0.0)
        tgt = [self.w.get(t, UNK) for t in tokens(r['target'])][: MAX_TGT - 1] + [EOS] if r['target'] else [EOS]
        # What this card may not say: roles it lacks, numbers and dramatic words its facts lack.
        nums = {0, 1, 2}
        for t in ' '.join(facts_text + list(r.get('roles', {}).values())).split():
            t = t.strip('.,;:!?').replace(',', '')
            if t.isdigit():
                nums.add(int(t))
            if t in NUMBER_WORDS:
                nums.add(NUMBER_WORDS[t])
        text = set(re.findall(r'[a-z]+', ' '.join(facts_text)))
        roles = r.get('roles', {})
        ban = [i for i in self.roles if self.v['words'][i] not in roles]
        ban += [i for i, n in self.number_words.items() if n not in nums]
        ban += [i for i in self.drama if self.v['words'][i].lower() not in text]
        ban += [i for i in self.digits if int(self.v['words'][i].lstrip('#')) not in nums]
        return {'sc': sc, 'at': at, 'va': va, 'bag': bag, 'num': num, 'hasn': hasn, 'tgt': tgt,
                'task': self.tk.get(r['task'], 0), 'unk': unk / max(1, len(at)), 'ban': ban, 'row': r}


def collate(batch, device):
    B = len(batch)
    T = -(-max(len(e['at']) for e in batch) // 16) * 16
    L = -(-max([len(b) for e in batch for b in e['bag']] + [1]) // 8) * 8
    Y = -(-max(len(e['tgt']) for e in batch) // 16) * 16
    sc = torch.zeros(B, T, 4, dtype=torch.long)
    at = torch.zeros(B, T, dtype=torch.long)
    va = torch.zeros(B, T, dtype=torch.long)
    bag = torch.zeros(B, T, L, dtype=torch.long)
    num = torch.zeros(B, T)
    hasn = torch.zeros(B, T)
    mmask = torch.ones(B, T, dtype=torch.bool)
    tgt = torch.zeros(B, Y, dtype=torch.long)
    for i, e in enumerate(batch):
        n = len(e['at'])
        sc[i, :n] = torch.tensor(e['sc'])
        at[i, :n] = torch.tensor(e['at'])
        va[i, :n] = torch.tensor(e['va'])
        for j, b in enumerate(e['bag']):
            if b:
                bag[i, j, :len(b)] = torch.tensor(b)
        num[i, :n] = torch.tensor(e['num'])
        hasn[i, :n] = torch.tensor(e['hasn'])
        mmask[i, :n] = False
        tgt[i, :len(e['tgt'])] = torch.tensor(e['tgt'])
    task = torch.tensor([e['task'] for e in batch])
    d = dict(sc=sc, at=at, va=va, bag=bag, num=num, hasn=hasn, mmask=mmask, tgt=tgt, task=task)
    return {k: v.to(device) for k, v in d.items()}


# ---------------------------------------------------------------- model

class NarrationStudent(nn.Module):
    def __init__(self, vocab, d=96, e=64, heads=4, layers=4, ff=192, dropout=0.1):
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
        layer = nn.TransformerDecoderLayer(d, heads, ff, dropout, batch_first=True, norm_first=True)
        self.decoder = nn.TransformerDecoder(layer, layers)
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
        hdec = self.out_norm(self.decoder(x, mem, tgt_mask=causal, memory_key_padding_mask=mmask))
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
            words = [codec.key[t] for t in hst if codec.key[t]]
            banned = set()
            if words:
                banned.add(words[-1])          # no word twice running
            if len(words) >= block - 1:        # no three-word phrase twice
                tail = words[-(block - 1):]
                for j in range(len(words) - block + 1):
                    if words[j: j + block - 1] == tail:
                        banned.add(words[j + block - 1])
            for w in banned:
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
    ap.add_argument('--smoothing', type=float, default=0.05)
    ap.add_argument('--beam', type=int, default=4)
    ap.add_argument('--eval-max', type=int, default=600)
    ap.add_argument('--device', default='cuda' if torch.cuda.is_available() else 'mps' if torch.backends.mps.is_available() else 'cpu')
    ap.add_argument('--seed', type=int, default=0)
    ap.add_argument('--load', help='a trained run dir: skip training and only quote cards with its model')
    a = ap.parse_args()
    os.makedirs(a.out, exist_ok=True)
    torch.manual_seed(a.seed)
    rng = random.Random(a.seed)

    rows = [json.loads(l) for l in open(a.rows) if l.strip()]
    held = {int(s) for s in a.held_out.split(',')}
    part, val_seeds = split_rows(rows, held, a.val_seeds)
    train = [r for r in part['train'] if r['source'] != 'prompt']
    vocab = json.load(open(f'{a.load}/vocab.json')) if a.load else build_vocab(train)
    C = Codec(vocab)
    print(f'rows {len(rows)}; train {Counter((r["task"], r["source"]) for r in train)}')
    print(f'vocab {len(vocab["words"])} words ({len(C.roles)} roles), {len(vocab["values"])} values, '
          f'{len(vocab["scopes"])} scope parts, {len(vocab["attrs"])} attrs; val seeds {val_seeds}')

    model = NarrationStudent(vocab, d=a.d, e=a.e, layers=a.layers, ff=a.ff).to(a.device)
    model.smoothing = a.smoothing
    nparam = sum(p.numel() for p in model.parameters())
    print(f'params {nparam:,} (~{nparam / 1024:.0f} KB at int8)')

    t0 = time.time()
    if a.load:
        model.load_state_dict(torch.load(f'{a.load}/model.pt', map_location=a.device)['state'])
        a.pretrain_epochs = a.finetune_epochs = 0
    pre = [C.example(r) for r in train] if a.pretrain_epochs else []
    train_phase(model, pre, a.pretrain_epochs, a.lr, a, rng, 'pretrain')
    fine = [C.example(r) for r in train if r['source'] == 'model']
    train_phase(model, fine, a.finetune_epochs, a.lr * 0.3, a, rng, 'finetune')

    # Held-out loss on passing quotes, then quotes for validation and test cards.
    model.eval()
    held_loss = {}
    for name in ('val', 'test'):
        exs = [C.example(r) for r in part[name] if r['source'] == 'model']
        ls = [model(collate(bt, a.device))[0].item() for bt in batches(exs, 128, False)]
        held_loss[name] = round(sum(ls) / max(1, len(ls)), 4)
    print('held-out loss on passing quotes', held_loss)
    samples = []
    for name in ('val', 'test'):
        prompts = [r for r in part[name] if r['source'] == 'prompt']
        rng.shuffle(prompts)
        exs = [C.example(r) for r in prompts[: a.eval_max]]
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
                                'outputs': [detok([vocab['words'][i] for i in ids if i != EOS]) for ids, _ in cs],
                                'feats': [[round(x, 4) for x in f] for f in feats.tolist()]})
        print(f'{name}: {sum(s["split"] == name for s in samples)} cards quoted', flush=True)
    with open(f'{a.out}/samples.jsonl', 'w') as fh:
        for s in samples:
            fh.write(json.dumps(s) + '\n')
    metrics = {'params': nparam, 'held_out_loss': held_loss, 'seconds': round(time.time() - t0),
               'val_seeds': val_seeds, 'held_out': sorted(held), 'args': vars(a)}
    json.dump(metrics, open(f'{a.out}/metrics.json', 'w'), indent=1)
    json.dump(vocab, open(f'{a.out}/vocab.json', 'w'))
    torch.save({'state': model.state_dict(), 'config': {k: getattr(a, k) for k in ('d', 'e', 'layers', 'ff')}}, f'{a.out}/model.pt')
    print(json.dumps(metrics))


if __name__ == '__main__':
    main()
