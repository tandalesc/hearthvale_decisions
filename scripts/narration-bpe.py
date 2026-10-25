#!/usr/bin/env python3
"""Learn a BPE vocabulary for the narration student.

  python scripts/narration-bpe.py STUDENT.jsonl --out BPE.json --size 1024 --held-out 1,2,3

Text is first split as the word-level student splits it (src/narration-student.js tokens):
pieces of words, numbers and punctuation, a piece that follows a space marked with a leading
"▁". Role tokens (<asker.body>, ...) never split: they are whole symbols, with and without the
"▁". BPE learns merges over the characters of every other piece, from the training rows'
target texts and the text values of their triples (held-out towns left out).

BPE.json: {"merges": [["a", "b"], ...], "symbols": [...], "roles": [...]}. Encoding applies
the merges in rank order, the same in Python (narration-student.py) and JS (narration-student.js).
"""
import argparse
import json
import re
from collections import Counter

from tokenizers import Tokenizer, models, pre_tokenizers, trainers

PIECE = re.compile(r"<[^<>\s]+>|[A-Za-z]+|'[A-Za-z]+|\d+(?:\.\d+)?|[^\sA-Za-z\d]")
SPACE = '▁'


def units(text):
    out = []
    for chunk in str(text).split():
        for i, p in enumerate(PIECE.findall(chunk)):
            out.append(p if i else SPACE + p)
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('rows')
    ap.add_argument('--out', required=True)
    ap.add_argument('--size', type=int, default=1024, help='BPE vocabulary size, roles not counted')
    ap.add_argument('--held-out', required=True)
    a = ap.parse_args()
    held = {int(s) for s in a.held_out.split(',')}
    counts, roles = Counter(), set()
    for line in open(a.rows):
        r = json.loads(line)
        if r['seeds'] and all(s in held for s in r['seeds']):
            continue
        texts = [r['target']] if r['source'] != 'prompt' else []
        texts += [str(v) for _, _, v, _, t in r['triples'] if t == 'text']
        for text in texts:
            for u in units(text):
                if u.lstrip(SPACE).startswith('<'):
                    roles.add(u.lstrip(SPACE))
                else:
                    counts[u] += 1
        for _, _, v, _, t in r['triples']:
            if t == 'role':
                roles.add(str(v))
    tok = Tokenizer(models.BPE())
    tok.pre_tokenizer = pre_tokenizers.WhitespaceSplit()
    alphabet = sorted({c for u in counts for c in u})
    trainer = trainers.BpeTrainer(vocab_size=a.size, min_frequency=2, initial_alphabet=alphabet, show_progress=False)
    # Real frequencies matter (common words should stay whole); scaled down so training is quick.
    scale = max(1, sum(counts.values()) // 5_000_000)
    tok.train_from_iterator((u for u, n in counts.items() for _ in range(max(1, n // scale))), trainer=trainer)
    model = json.loads(tok.to_str())['model']
    merges = [m.split(' ') if isinstance(m, str) else list(m) for m in model['merges']]
    symbols = sorted(model['vocab'], key=lambda s: model['vocab'][s])
    roles = sorted(roles)
    json.dump({'merges': merges, 'symbols': symbols, 'roles': roles}, open(a.out, 'w'))
    print(f'{len(symbols)} symbols, {len(merges)} merges, {len(roles)} roles, {len(alphabet)} characters -> {a.out}')


if __name__ == '__main__':
    main()
