#!/usr/bin/env python3
"""Pick each entity's note as the runtime does: of the candidates that pass the game's rules,
the one a confidence head (RUN/quality.json, scripts/narration-quality.py) scores highest.

  python scripts/narration-note-pick.py RUN --rules VERDICTS.jsonl --split test --out PICKS.jsonl [--quality FILE]

VERDICTS.jsonl comes from scripts/narration-note-verdicts.js (its `rules` and `texts`, e.g.
with --rules-only). Writes {key, text, score} per entity (text null when none passes).
"""
import argparse
import json

import torch
import torch.nn as nn


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('run')
    ap.add_argument('--rules', required=True)
    ap.add_argument('--split', default='test')
    ap.add_argument('--quality', default=None)
    ap.add_argument('--out', required=True)
    a = ap.parse_args()
    q = json.load(open(a.quality or f'{a.run}/quality.json'))
    w = {k: torch.tensor(v) for k, v in q['weights'].items()}
    head = nn.Sequential(nn.Linear(w['0.weight'].shape[1], w['0.weight'].shape[0]), nn.ReLU(), nn.Linear(w['2.weight'].shape[1], 1))
    head.load_state_dict(w)
    mean, std = torch.tensor(q['mean']), torch.tensor(q['std'])
    samples = {s['key']: s for s in map(json.loads, open(f'{a.run}/samples.jsonl')) if s['split'] == a.split and s.get('task') == 'entity.note'}
    out = []
    for v in map(json.loads, open(a.rules)):
        s = samples.get(v['key'])
        if v['split'] != a.split or not s:
            continue
        with torch.no_grad():
            sc = torch.sigmoid(head((torch.tensor(s['feats']) - mean) / std).squeeze(-1)).tolist()
        ok = [i for i, r in enumerate(v['rules']) if r]
        best = max(ok, key=lambda i: sc[i]) if ok else None
        out.append({'key': v['key'], 'text': v['texts'][best] if best is not None else None, 'score': round(sc[best], 5) if best is not None else 0.0})
    with open(a.out, 'w') as fh:
        for r in out:
            fh.write(json.dumps(r) + '\n')
    print(f'{len(out)} {a.split} entities; a note passing the rules for {sum(1 for r in out if r["text"])}')


if __name__ == '__main__':
    main()
