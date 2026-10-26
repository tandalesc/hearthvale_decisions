"""Binding probe for the narration student, with no generation and no judge.

For each (card, quote), teacher-force the quote and measure how its log-prob moves when the
card's triples are moved along "exchange" directions in triple-embedding space: two records
of the same kind swap one attribute's value (stance leans, past acts, past years, the
approved/refused/deferred counts). The set of values is unchanged; only which record holds
which value changes. A model that binds records loses log-prob; one that reads the card as a
bag of facts does not care. A quote whose log-prob rises was written for the swapped card.
"Read" controls change one record's value with no exchange, to tell a fact the model ignores
from one it reads but does not tie to its record.

  x(alpha) = x + alpha * (x_swapped - x)       (x: the 64-d triple embedding, before up/LN)

  python scripts/narration-probe.py RUN_DIR QUOTES.jsonl PROMPTS.jsonl OUT.jsonl --bits 8|4

QUOTES.jsonl: {model, key, target (role tokens), contradiction}, one per quote to teacher-force;
PROMPTS.jsonl: the cards' prompt rows from narration-student-export.js (key, triples, roles).
--bits rounds the weights as the export will (8, 4, or 0 for float). Each output line has the
quote's log-prob and, per swap, the log-prob change at alpha 0.25 … 1 and the slope at 0.
Results and how to read them: docs/handoff-narration-model.md §1i.
"""
import argparse, importlib.util, json, math, sys
from itertools import combinations

import torch

from pathlib import Path
spec = importlib.util.spec_from_file_location('ns', Path(__file__).with_name('narration-student.py'))
S = importlib.util.module_from_spec(spec)
spec.loader.exec_module(S)

ALPHAS = [0.0, 0.25, 0.5, 0.75, 1.0]


def load(run, bits):
    ck = torch.load(f'{run}/model.pt', map_location='cpu')
    cfg = ck['config']
    vocab = json.load(open(f'{run}/vocab.json'))
    S.MAX_TGT = cfg['max_tgt']
    m = S.NarrationStudent(vocab, d=cfg['d'], e=cfg['e'], layers=cfg['layers'], ff=cfg['ff'], ffn=cfg['ffn'], dropout=0.0)
    m.load_state_dict(ck['state'])
    if bits:
        S.quantize_aware(m, bits, cfg.get('qat_group') or 32)
    m.eval()
    return m, S.Codec(vocab)


def swaps(row):
    """Exchanges between records of one kind: (name, [(i, field, new)])."""
    t = row['triples']
    out = []
    by = {}
    for i, (scope, attr, value, num, typ) in enumerate(t):
        if ':' in scope and '/' not in scope:
            kind = scope.split(':')[0]
            by.setdefault((kind, attr), []).append((i, scope, value, num))
    for (kind, attr), items in by.items():
        field = {('stances', 'lean'): 'value', ('past', 'act'): 'value', ('past', 'year'): 'num'}.get((kind, attr))
        if not field:
            continue
        for (i, si, vi, ni), (j, sj, vj, nj) in combinations(items, 2):
            a, b = (vi, vj) if field == 'value' else (ni, nj)
            if a != b:
                out.append((f'{kind}.{attr}', [(i, field, (vj, nj)), (j, field, (vi, ni))], [si, sj]))
    # Read controls: one record's value changed, no exchange. Large here but small for the
    # exchanges = the model reads the fact but does not tie it to its record.
    LEANS, ACTS = ['for', 'against', 'indifferent'], ['approved', 'refused', 'deferred']
    for i, (scope, attr, value, num, typ) in enumerate(t):
        if ':' not in scope or '/' in scope:
            continue
        kind = scope.split(':')[0]
        if (kind, attr) == ('stances', 'lean') and value in LEANS:
            alt = LEANS[(LEANS.index(value) + 1) % 3]
            out.append(('read:stances.lean', [(i, 'value', (alt, num))], [scope]))
        elif (kind, attr) == ('past', 'act') and value in ACTS:
            alt = ACTS[(ACTS.index(value) + 1) % 3]
            out.append(('read:past.act', [(i, 'value', (alt, num))], [scope]))
        elif (kind, attr) == ('past', 'year') and num is not None:
            out.append(('read:past.year', [(i, 'num', (value, num - 3 if num > -3 else num + 3))], [scope]))
    # The approved/refused/deferred counts, under 'record' and 'recent': exchange two counts.
    for scope in ('record', 'recent'):
        cs = [(i, a, v, n) for i, (s, a, v, n, typ) in enumerate(t) if s == scope and a in ('approved', 'refused', 'deferred')]
        for (i, ai, vi, ni), (j, aj, vj, nj) in combinations(cs, 2):
            if vi != vj:
                out.append((f'{scope}.count', [(i, 'num', (vj, nj)), (j, 'num', (vi, ni))], [scope]))
    return out


def apply(row, edits):
    t = [list(x) for x in row['triples']]
    for i, field, (v, n) in edits:
        if field == 'value':
            t[i][2] = v
        else:
            t[i][2], t[i][3] = v, n
    return {**row, 'triples': t}


def memory_x(m, b):
    real = (b['bag'] > 0).unsqueeze(-1)
    bag = m.word(b['bag']) * real
    n = real.sum(2).clamp(min=1)
    return m.scope(b['sc']).sum(2) + m.attr(b['at']) + m.value(b['va']) + bag.sum(2) / n \
        + (b['num'] * b['hasn']).unsqueeze(-1) * m.num_dir(b['at'])


def token_lp(m, b, x):
    mem = m.state_norm(m.up(x))
    _, logits = m.run(b['tgt'][:, :-1], b['task'], mem, b['mmask'])
    lp = logits.log_softmax(-1).gather(2, b['tgt'].unsqueeze(-1)).squeeze(-1)
    return lp * (b['tgt'] != S.PAD)


def probe(m, codec, row, target):
    r = {**row, 'target': target}
    sw = swaps(r)
    exs = [codec.example(r)] + [codec.example(apply(r, e)) for _, e, _ in sw]
    b = S.collate(exs, 'cpu')
    with torch.no_grad():
        x = memory_x(m, b)
    x0, d = x[:1], x[1:] - x[:1]                       # swap directions in triple-embedding space
    out = {'n_tok': int((b['tgt'][0] != S.PAD).sum()), 'swaps': []}
    with torch.no_grad():
        base = token_lp(m, {k: v[:1] for k, v in b.items()}, x0)[0]
    out['lp'] = float(base.sum())
    if not sw:
        return out
    K = len(sw)
    bk = {k: v[:1].expand(K, *v.shape[1:]) for k, v in b.items()}
    curve = []
    with torch.no_grad():
        for a in ALPHAS[1:]:
            curve.append(token_lp(m, bk, x0 + a * d).sum(1) - base.sum())
    # Slope at alpha 0: one backward through a scalar alpha per swap.
    alpha = torch.zeros(K, 1, 1, requires_grad=True)
    tl = token_lp(m, bk, x0 + alpha * d)
    tl.sum().backward()
    slope = alpha.grad.view(-1)
    with torch.no_grad():
        full = token_lp(m, bk, x0 + d)
        drop = (full - base.unsqueeze(0))              # per-token change at alpha 1
    words = [codec.v['words'][t] for t in b['tgt'][0].tolist() if t != S.PAD]
    for k, (name, _, recs) in enumerate(sw):
        dk = drop[k][: len(words)]
        worst = int(dk.argmin())
        out['swaps'].append({'kind': name, 'records': recs, 'slope': float(slope[k]),
                             'curve': [0.0] + [float(c[k]) for c in curve],
                             'tok_min': float(dk.min()), 'tok_max': float(dk.max()),
                             'worst': ''.join(words[max(0, worst - 2): worst + 1])})
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('run'); ap.add_argument('judged'); ap.add_argument('prompts'); ap.add_argument('out')
    ap.add_argument('--bits', type=int, default=8)
    ap.add_argument('--models', default='')
    ap.add_argument('--limit', type=int, default=0)
    a = ap.parse_args()
    torch.set_num_threads(4)
    m, codec = load(a.run, a.bits)
    rows = {}
    for l in open(a.prompts):
        r = json.loads(l)
        rows[r['key']] = r
    keep = set(a.models.split(',')) if a.models else None
    judged = [json.loads(l) for l in open(a.judged)]
    judged = [j for j in judged if keep is None or j['model'] in keep]
    if a.limit:
        judged = judged[: a.limit]
    with open(a.out, 'w') as f:
        for n, j in enumerate(judged):
            res = probe(m, codec, rows[j['key']], j['target'])
            f.write(json.dumps({'model': j['model'], 'key': j['key'], 'contradiction': j['contradiction'], **res}) + '\n')
            if n % 100 == 0:
                print(n, file=sys.stderr, flush=True)


if __name__ == '__main__':
    main()
