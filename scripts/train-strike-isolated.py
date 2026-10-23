#!/usr/bin/env python3
"""Targeted strike extension: preserve every v6 parameter and shared token mapping.

Uses the vendored recipe's town split, teacher KL, AdamW, clipping, OneCycleLR,
six epochs and replay. Only appended strike-exclusive embedding rows can learn.
The original confidence head and calibration are retained exactly.
"""
from pathlib import Path
import argparse
import json
import math
import sys
import time
import torch

ROOT = Path(__file__).resolve().parent.parent
VENDOR = ROOT / 'cloudflare/training/vendor'
sys.path[:0] = [str(VENDOR / 'src'), str(VENDOR / 'scripts')]
from train_decision_student import warm_start, evaluate, summarize, kind_mean_baseline
from twm.decision.data import DecisionVocab, load_rows, split_by_seed, encode_rows
from twm.decision.model import StudentConfig, build_student, kl_teacher_student

ap = argparse.ArgumentParser()
ap.add_argument('data', nargs='+')
ap.add_argument('--init-from', required=True)
ap.add_argument('--out', required=True)
a = ap.parse_args()
torch.manual_seed(0)
device = torch.device('mps' if torch.backends.mps.is_available() else 'cpu')
rows = load_rows(a.data)
train_rows, test_rows = split_by_seed(rows, .2)
base = torch.load(Path(a.init_from) / 'model.pt', map_location='cpu')
old = DecisionVocab.from_json(base['vocab'])
vocab = DecisionVocab.from_json(base['vocab'])
# Deliberately do not extend shared words (e.g. strike/work/much) or bare
# options: old questions must continue to map every formerly unknown word to UNK.
for attr in ['hardship', 'wages']:
    vocab.attrs.setdefault(attr, len(vocab.attrs))
vocab.values.setdefault('strike_resolve', len(vocab.values))
for opt in ['back_down', 'most', 'solid', 'some']:
    vocab.kind_options.setdefault('strike_resolve:' + opt, len(vocab.kind_options))
cfg = StudentConfig(**base['config'])
model = build_student(vocab, cfg)
warm_start(model, base['state_dict'])
model.to(device)
original = {k: v.to(device) for k, v in base['state_dict'].items()}
trainable = []
for name, param in model.named_parameters():
    before = original[name]
    grows = param.ndim == 2 and param.shape[0] > before.shape[0]
    param.requires_grad_(grows)
    if grows:
        n = before.shape[0]
        param.register_hook(lambda grad, n=n: torch.cat([torch.zeros_like(grad[:n]), grad[n:]], 0))
        trainable.append(param)
assert trainable
train = encode_rows(train_rows, vocab).to(device)
test = encode_rows(test_rows, vocab).to(device)
opt = torch.optim.AdamW(trainable, lr=.001, weight_decay=.01)
steps = math.ceil(len(train) / 1024)
sched = torch.optim.lr_scheduler.OneCycleLR(opt, max_lr=.001, total_steps=6 * steps, pct_start=.1)
best, best_state, history = float('inf'), None, []
t0 = time.time()
for epoch in range(6):
    model.train()
    perm = torch.randperm(len(train), device=device)
    total = 0.
    for s in range(steps):
        b = train.batch(perm[s * 1024:(s + 1) * 1024])
        loss = (kl_teacher_student(model(b), b['target'], b['opt_mask']) * b['weight']).mean()
        opt.zero_grad(set_to_none=True)
        loss.backward()
        torch.nn.utils.clip_grad_norm_(trainable, 1.)
        opt.step()
        # Gradient masking alone is insufficient with AdamW's weight decay.
        with torch.no_grad():
            for name, param in model.named_parameters():
                if param.requires_grad:
                    param[:original[name].shape[0]].copy_(original[name])
        sched.step()
        total += loss.item()
    kl, agree = evaluate(model, test)
    score = float(kl.mean())
    if score < best:
        best = score
        best_state = {k: v.detach().cpu().clone() for k, v in model.state_dict().items()}
    history.append({'epoch': epoch + 1, 'train_kl': total / steps, 'test_kl': score, 'seconds': time.time() - t0})
    print(history[-1], flush=True)
model.load_state_dict(best_state)
kl, agree = evaluate(model, test)
summary = summarize([r['kind'] for r in test_rows], kl, agree, kind_mean_baseline(train_rows, test_rows), [False] * len(test_rows))
# Bitwise preservation includes every existing embedding row and shared layer.
for name, old_param in base['state_dict'].items():
    new = best_state[name]
    assert torch.equal(new[:old_param.shape[0]] if new.shape != old_param.shape else new, old_param), name
out = Path(a.out)
out.mkdir(parents=True, exist_ok=True)
ckpt = {**base, 'vocab': vocab.to_json(), 'state_dict': best_state}
torch.save(ckpt, out / 'model.pt')
(out / 'confidence.json').write_text(json.dumps(base['err_head_report'], indent=2))
report = {'variant': 'strike-exclusive embedding rows; frozen v6 shared model and confidence', 'params': sum(p.numel() for p in model.parameters()), 'new_trainable_parameters': sum(best_state[k].numel() - v.numel() for k, v in base['state_dict'].items()), 'args': {**vars(a), 'kinds': None, 'epochs': 6, 'lr': .001, 'batch_size': 1024}, 'test': summary, 'history': history, 'rows': {'train': len(train_rows), 'test': len(test_rows)}, 'existing_parameters_bitwise_equal': True, 'shared_values_and_bare_options_unchanged': True, 'confidence_unchanged': True}
(out / 'metrics.json').write_text(json.dumps(report, indent=2))
print('saved', out, summary.get('strike_resolve'), flush=True)
