#!/usr/bin/env python3
"""Quality head for the narration student, like the decision student's error head.

  python scripts/narration-quality.py RUN_DIR --verdicts VERDICTS.jsonl

RUN_DIR/samples.jsonl holds each card's candidates with features (scripts/narration-student.py:
mean and worst token log-probability, mean entropy, length, beam score, unknown share of the
card's triples, and the decoder's mean state). VERDICTS.jsonl says which candidates pass the
narrator's checks (scripts/narration-student-check.js).

The head (features -> 32 -> 1) learns on validation towns to predict whether a candidate
passes. On test towns it picks each card's best candidate, and its score says how far to
trust it. Like decision-local.js: above a threshold the game shows the student's quote,
below it asks the hosted narrator within a budget, else shows template text.

Writes RUN_DIR/quality.json (weights, feature mean/std, thresholds) and prints coverage.
"""
import argparse
import json

import torch
import torch.nn as nn


def load(run, verdicts_file):
    samples = {s['key'] + s['split']: s for s in map(json.loads, open(f'{run}/samples.jsonl'))}
    rows = []
    for v in map(json.loads, open(verdicts_file)):
        s = samples.get(v['key'] + v['split'])
        if s:
            rows.append((v['split'], s['feats'], v['pass']))
    return rows


def auc(scores, labels):
    pairs = sorted(zip(scores, labels))
    pos = sum(labels)
    neg = len(labels) - pos
    if not pos or not neg:
        return None
    rank_sum = sum(i + 1 for i, (_, y) in enumerate(pairs) if y)
    return (rank_sum - pos * (pos + 1) / 2) / (pos * neg)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('run')
    ap.add_argument('--verdicts', required=True)
    ap.add_argument('--epochs', type=int, default=300)
    a = ap.parse_args()
    torch.manual_seed(0)
    rows = load(a.run, a.verdicts)
    val = [(f, p) for s, fs, ps in rows if s == 'val' for f, p in zip(fs, ps)]
    X = torch.tensor([f for f, _ in val])
    Y = torch.tensor([float(p) for _, p in val])
    mean, std = X.mean(0), X.std(0) + 1e-6
    head = nn.Sequential(nn.Linear(X.size(1), 32), nn.ReLU(), nn.Linear(32, 1))
    opt = torch.optim.AdamW(head.parameters(), lr=3e-3, weight_decay=0.01)
    for _ in range(a.epochs):
        loss = nn.functional.binary_cross_entropy_with_logits(head((X - mean) / std).squeeze(-1), Y)
        opt.zero_grad()
        loss.backward()
        opt.step()
    head.eval()
    score = lambda fs: torch.sigmoid(head((torch.tensor(fs) - mean) / std).squeeze(-1)).tolist()

    test = [(fs, ps) for s, fs, ps in rows if s == 'test']
    cand_scores, cand_labels, picks = [], [], []
    for fs, ps in test:
        sc = score(fs)
        cand_scores += sc
        cand_labels += ps
        best = max(range(len(sc)), key=lambda i: sc[i])
        picks.append((sc[best], ps[best], ps[0], any(ps)))
    n = len(picks)
    print(f'validation candidates {len(val)} ({Y.mean():.1%} pass); test cards {n}')
    print(f'candidate AUC on test: {auc(cand_scores, cand_labels):.3f}')
    print(f'test cards passing: top beam {sum(p[2] for p in picks) / n:.1%}, head\'s pick {sum(p[1] for p in picks) / n:.1%}, '
          f'any candidate {sum(p[3] for p in picks) / n:.1%}')
    picks.sort(key=lambda p: -p[0])
    ladder = []
    for share in (0.5, 0.7, 0.8, 0.9, 1.0):
        k = max(1, int(round(share * n)))
        ladder.append({'share': share, 'threshold': round(picks[k - 1][0], 4), 'pass': round(sum(p[1] for p in picks[:k]) / k, 4)})
        print(f'  most confident {share:.0%} of cards: {ladder[-1]["pass"]:.1%} pass (score >= {ladder[-1]["threshold"]:.3f})')
    json.dump({'mean': mean.tolist(), 'std': std.tolist(),
               'weights': {k: v.tolist() for k, v in head.state_dict().items()}, 'ladder': ladder,
               'auc': auc(cand_scores, cand_labels)}, open(f'{a.run}/quality.json', 'w'))


if __name__ == '__main__':
    main()
