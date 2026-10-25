#!/usr/bin/env python3
"""Export a trained narration student as a bundle for the browser (src/narration-student.js).

  python scripts/export-narration-student.py RUN_DIR OUT.json --rows STUDENT.jsonl --sheets SHEETS.jsonl
      --held-out 1,2,3 [--version 1] [--fixture 24] [--share 0.9]

Weights as the decision student's bundles carry them (scripts/export_decision_student.py):
2-D tensors as per-row symmetric INT8 with a float32 scale per row, 1-D as fp16, both base64.
The quality head (RUN_DIR/quality.json) stays float32, with the threshold that keeps the most
confident `share` of test cards. The fixture is a few held-out cards quoted by the exported
(rounded) weights, so the browser can check it computes the same thing.
"""
import argparse
import base64
import importlib.util
import json
import os

import numpy as np
import torch

HERE = os.path.dirname(os.path.abspath(__file__))
spec = importlib.util.spec_from_file_location('student', os.path.join(HERE, 'narration-student.py'))
S = importlib.util.module_from_spec(spec)
spec.loader.exec_module(S)

FORMAT = 'hearthvale-narration-student'
FEATURES_VERSION = 1  # src/narration-features.js NARRATION_FEATURES_VERSION


def b64(a):
    return base64.b64encode(np.ascontiguousarray(a).tobytes()).decode('ascii')


def export_weight(t):
    t = t.detach().float().cpu()
    if t.dim() == 2:
        scale = t.abs().amax(1).clamp(min=1e-8) / 127
        q = torch.round(t / scale[:, None]).clamp(-127, 127).to(torch.int8)
        return {'shape': list(t.shape), 'i8': b64(q.numpy()), 'scale': b64(scale.numpy().astype('<f4'))}, q.float() * scale[:, None]
    half = t.half()
    return {'shape': list(t.shape), 'f16': b64(half.numpy().astype('<f2'))}, half.float()


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('run')
    ap.add_argument('out')
    ap.add_argument('--rows', required=True)
    ap.add_argument('--sheets', required=True)
    ap.add_argument('--held-out', required=True)
    ap.add_argument('--version', type=int, default=1)
    ap.add_argument('--fixture', type=int, default=24)
    ap.add_argument('--share', type=float, default=0.9)
    a = ap.parse_args()

    vocab = json.load(open(f'{a.run}/vocab.json'))
    ck = torch.load(f'{a.run}/model.pt', map_location='cpu')
    cfg = ck['config']
    model = S.NarrationStudent(vocab, d=cfg['d'], e=cfg['e'], layers=cfg['layers'], ff=cfg['ff'])
    model.load_state_dict(ck['state'])
    weights, seen = {}, {}
    for k, v in model.state_dict().items():
        weights[k], seen[k] = export_weight(v)
    model.load_state_dict(seen)   # the fixture comes from the weights the browser will have
    model.eval()

    q = json.load(open(f'{a.run}/quality.json'))
    ladder = {round(r['share'], 2): r for r in q['ladder']}
    quality = {'mean': q['mean'], 'std': q['std'], 'weights': {k: {'shape': list(np.shape(v)), 'f32': b64(np.asarray(v, dtype='<f4'))}
                                                              for k, v in q['weights'].items()},
               'threshold': ladder[round(a.share, 2)]['threshold'], 'share': a.share, 'auc': q['auc'], 'ladder': q['ladder']}

    # Fixture: held-out cards, from their facts.
    held = {int(s) for s in a.held_out.split(',')}
    C = S.Codec(vocab)
    rows = []
    for line in open(a.rows):
        if '"source":"prompt"' not in line:
            continue
        r = json.loads(line)
        if r['seeds'] and all(s in held for s in r['seeds']):
            rows.append(r)
        if len(rows) >= a.fixture:
            break
    keys = {r['key'] for r in rows}
    facts = {}
    for line in open(a.sheets):
        s = json.loads(line)
        if s['key'] in keys:
            facts[s['key']] = s['facts']
    exs = [C.example(r) for r in rows]
    b = S.collate(exs, 'cpu')
    cands = S.beam_search(model, b, [e['ban'] for e in exs], C, k=4)
    fixture = []
    for j, (ex, cs) in enumerate(zip(exs, cands)):
        seqs = torch.zeros(len(cs), S.MAX_TGT, dtype=torch.long)
        for c, (ids, _) in enumerate(cs):
            seqs[c, :len(ids)] = torch.tensor(ids)
        one = {k: v[j:j + 1].expand(len(cs), *v.shape[1:]) for k, v in b.items()}
        feats = torch.cat([model.score(one, seqs), torch.tensor([[s, ex['unk']] for _, s in cs])], 1)
        fixture.append({'facts': facts[ex['row']['key']],
                        'outputs': [S.detok([vocab['words'][i] for i in ids if i != S.EOS]) for ids, _ in cs],
                        'features': [[round(x, 5) for x in f] for f in feats.tolist()]})

    bundle = {'format': FORMAT, 'version': a.version, 'features': FEATURES_VERSION,
              'teacher': 'claude-haiku-5-5', 'config': {**cfg, 'heads': 4, 'max_tgt': S.MAX_TGT, 'max_bag': S.MAX_BAG,
                                                         'beam': 4, 'alpha': 0.7, 'block': 3},
              'vocab': vocab, 'weights': weights, 'quality': quality, 'fixture': fixture,
              'params': sum(v.numel() for v in model.state_dict().values())}
    with open(a.out, 'w') as fh:
        json.dump(bundle, fh, separators=(',', ':'))
    print(f'{a.out}: {os.path.getsize(a.out) / 1024:.0f} KB, {bundle["params"]:,} parameters, '
          f'quality threshold {quality["threshold"]} (most confident {a.share:.0%}), fixture {len(fixture)} cards')


if __name__ == '__main__':
    main()
