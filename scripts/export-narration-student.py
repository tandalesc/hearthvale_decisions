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
import re
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


class Blob:
    """The weights file: sections of raw little-endian bytes, each 4-byte aligned."""
    def __init__(self):
        self.parts, self.size = [], 0

    def add(self, array):
        pad = (-self.size) % 4
        if pad:
            self.parts.append(b'\0' * pad)
            self.size += pad
        data = np.ascontiguousarray(array).tobytes()
        offset = self.size
        self.parts.append(data)
        self.size += len(data)
        return offset, len(data)


def export_weight(t, blob, bits=8, group=32):
    """2-D tensors as symmetric integers with an fp16 scale per group of `group` values in a
    row (int8: the whole row); 1-D tensors as fp16. -> (index entry, the weights as exported)."""
    t = t.detach().float().cpu()
    if t.dim() == 2:
        rows, cols = t.shape
        g = cols if bits == 8 else min(group, cols)
        qmax = 127 if bits == 8 else 7
        tp = torch.nn.functional.pad(t, (0, (-cols) % g))
        tg = tp.view(rows, -1, g)
        # Round the scale to fp16 first, so the browser's arithmetic is the same as this.
        scale = (tg.abs().amax(2) / qmax).half().float()
        scale[scale == 0] = 1.0
        q = torch.round(tg / scale[..., None]).clamp(-qmax, qmax).to(torch.int8)
        seen = (q.float() * scale[..., None]).view(rows, -1)[:, :cols]
        qs = q.view(rows, -1)[:, :cols].contiguous().view(-1).numpy()
        if bits == 4:
            nib = (qs.astype(np.int16) & 0x0F).astype(np.uint8)
            if len(nib) % 2:
                nib = np.append(nib, np.uint8(0))
            qs = nib[0::2] | (nib[1::2] << 4)
        off, n = blob.add(qs)
        soff, _ = blob.add(scale.numpy().astype('<f2'))
        return {'shape': [rows, cols], 'dtype': f'i{bits}', 'group': g, 'groups': scale.shape[1], 'offset': off, 'bytes': n, 'scale_offset': soff}, seen
    half = t.half()
    off, n = blob.add(half.numpy().astype('<f2'))
    return {'shape': list(t.shape), 'dtype': 'f16', 'offset': off, 'bytes': n}, half.float()


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
    ap.add_argument('--bits', type=int, choices=[8, 4], help='default: the width the run was trained for (--qat), else 8')
    ap.add_argument('--group', type=int, default=32, help='int4: values per scale')
    ap.add_argument('--keep8', default='', help='regex of weight names kept at int8 when --bits 4 (e.g. the embedding tables)')
    ap.add_argument('--beam', type=int, default=4, help='beam width the runtime decodes with')
    ap.add_argument('--no-repeat', action='store_true', help='the runtime decodes without reusing a content word (notes)')
    ap.add_argument('--task', default=None, help='the fixture\'s prompts from this task only (entity.note for a notes bundle)')
    ap.add_argument('--roles', type=int, default=1, help='role tokens version the run was exported with (src/narration-roles.js); 2 for notes')
    ap.add_argument('--drop', default='', help="fact paths the rows were exported without (narration-student-export.js --drop), e.g. season")
    ap.add_argument('--town', action='store_true', help='the rows carry the town\'s name (facts.town, a role token): the runtime keeps it')
    ap.add_argument('--decode', choices=['beam', 'sample'], default='beam', help='how the runtime decodes notes (src/narration-student.js note)')
    ap.add_argument('--temperature', type=float, default=0.8, help='--decode sample: softmax temperature')
    ap.add_argument('--top-p', type=float, default=0.9, help='--decode sample: nucleus share')
    ap.add_argument('--fixture-out', help='where the parity fixture goes (default OUT with .fixture.json); it is not shipped')
    a = ap.parse_args()

    vocab = json.load(open(f'{a.run}/vocab.json'))
    if a.roles != 1:
        vocab['roles'] = a.roles   # the runtime builds role tokens the way the rows were
    ck = torch.load(f'{a.run}/model.pt', map_location='cpu')
    cfg = ck['config']
    a.bits = a.bits or cfg.get('qat') or 8
    a.group = cfg.get('qat_group', a.group) if cfg.get('qat') == 4 else a.group
    S.MAX_TGT = cfg.get('max_tgt', S.MAX_TGT)
    model = S.NarrationStudent(vocab, d=cfg['d'], e=cfg['e'], layers=cfg['layers'], ff=cfg['ff'], ffn=cfg.get('ffn', 'relu'))
    model.load_state_dict(ck['state'])
    weights, seen, blob = {}, {}, Blob()
    for k, v in model.state_dict().items():
        bits = 8 if a.bits == 4 and a.keep8 and re.match(a.keep8, k) else a.bits
        weights[k], seen[k] = export_weight(v, blob, bits, a.group)
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
        if a.task and r['task'] != a.task:
            continue
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
    cands = S.beam_search(model, b, [e['ban'] for e in exs], C, k=a.beam, no_repeat=a.no_repeat)
    fixture = []
    for j, (ex, cs) in enumerate(zip(exs, cands)):
        seqs = torch.zeros(len(cs), S.MAX_TGT, dtype=torch.long)
        for c, (ids, _) in enumerate(cs):
            seqs[c, :len(ids)] = torch.tensor(ids)
        one = {k: v[j:j + 1].expand(len(cs), *v.shape[1:]) for k, v in b.items()}
        feats = torch.cat([model.score(one, seqs), torch.tensor([[s, ex['unk']] for _, s in cs])], 1)
        fixture.append({'facts': facts[ex['row']['key']],
                        'outputs': [C.detok([vocab['words'][i] for i in ids if i != S.EOS]) for ids, _ in cs],
                        'features': [[round(x, 5) for x in f] for f in feats.tolist()]})

    bundle = {'format': FORMAT, 'version': a.version, 'features': FEATURES_VERSION, **({'task': a.task} if a.task else {}),
              'teacher': 'claude-haiku-5-5', 'config': {**cfg, 'heads': 4, 'max_tgt': S.MAX_TGT, 'max_bag': C.max_bag,
                                                         'beam': a.beam, 'alpha': 0.7, 'block': 3, **({'no_repeat': True} if a.no_repeat else {}),
                                                         **({'drop': a.drop.split(',')} if a.drop else {}),
                                                         **({'town': True} if a.town else {}),
                                                         **({'decode': 'sample', 'temperature': a.temperature, 'top_p': a.top_p} if a.decode == 'sample' else {})},
              'vocab': vocab, 'weights': weights, 'quality': quality, 'bits': a.bits,
              'blob': os.path.basename(a.out).replace('.json', '.bin'), 'blob_bytes': blob.size,
              'params': sum(v.numel() for v in model.state_dict().values())}
    with open(a.out, 'w') as fh:
        json.dump(bundle, fh, separators=(',', ':'))
    with open(a.out.replace('.json', '.bin'), 'wb') as fh:
        fh.write(b''.join(blob.parts))
    fixture_out = a.fixture_out or a.out.replace('.json', '.fixture.json')
    with open(fixture_out, 'w') as fh:
        json.dump({'version': a.version, 'bits': a.bits, 'cards': fixture}, fh, separators=(',', ':'))
    print(f'{a.out}: {os.path.getsize(a.out) / 1024:.0f} KB header + {blob.size / 1024:.0f} KB int{a.bits} weights, '
          f'{bundle["params"]:,} parameters, quality threshold {quality["threshold"]} (most confident {a.share:.0%}); '
          f'fixture ({len(fixture)} cards) -> {fixture_out}')


if __name__ == '__main__':
    main()
