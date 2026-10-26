# Handoff: a tiny narration model

Goal: replace Haiku for the narrator's prose with a model under 1 MB that runs in the browser, the way the decision student replaced d1-3B for routine decisions. Written 23 October 2026 on branch `claude/mini-llm-narration-bfaf2b`, commit `e11a990` (main `880429b` merged in). Nothing is pushed and there is no PR.

---

## 1. Where it stands

| Step | State |
|---|---|
| Fact sheets → triples (`src/narration-features.js`) | done, tested |
| Collector (`scripts/narration-collect.js`) | done; 40 seeds collected (225,126 distinct sheets). Resumes a stopped run; asks only for the cards the game narrates (`cardsNeedingProse`) |
| Export to training pairs (`scripts/narration-export.js`) | done; `--prompts` adds held-out cards to quote |
| Trainer (`scripts/narration-train.py`) | first version done, see §1a |
| Checker (`scripts/narration-check.js`) | done: the narrator's checks plus a fluency check |
| Design doc (`docs/design/narration-distillation.md`) | not started |
| JS forward pass, int8 export | not started |

Tests: `tests/narration-features.test.js` passes. In the last full `npm test` run, 2 of 563 tests failed, neither in narration code (see §5).

## 1a. First results (25 October 2026)

Model: a set encoder over the triples' word pieces and a pointer-generator decoder with a task token. Names and numbers are left out of the vocabulary, so the model can copy them but never invent them. 551K parameters, about 540 KB at int8. 2 layers each side, d 96.

Trained 4 epochs (about 12 minutes on MPS) on 32 seeds, with entity notes capped at 60K rows. Tested on 8 held-out seeds, 600 rows per task:

| task | exact match | names/numbers right (precision / recall) |
|---|---|---|
| `card.why` | 87.8% | 99.6% / 97.8% |
| `entity.note` | 73.8% | 96.4% / 93.9% |
| `year.text` | 20.7% | 82% / 71% |
| `card.quote` (Haiku voice, 24 training rows) | — | 20% pass the checks; read as gibberish |

- **The narrator's `CHECKS` pass gibberish.** Before the fluency check was added, 75% of word-salad quotes passed. The checks were written for a fluent model, so a student also needs a fluency gate (no unknown pieces, no word twice running) and a read.
- **24 Haiku quotes are far too few** to learn the voice. The template tasks show the copying machinery works. The voice needs Haiku labels (step 5): likely a few thousand cards.
- **`year.text` is weak because the year line uses facts that aren't in its triples.** For example, "25 more people live here": 25 appears nowhere in the sheet, so the model can't copy it. Either the template derives it or the year sheet drops it. Look at `chronicleFacts` next.
- **The model surfaced template oddities in the game's own text:** "The The ward Ward Council sits…", "a school for the ward: high hill", and "you approved festival Society: budget for year 122."

To reproduce (Python with torch, e.g. `~/Projects/twm-decision-student/.venv`):

```bash
node scripts/narration-collect.js OUT --seeds 40 --years 150
node scripts/narration-export.js OUT --labels OUT/bench-labels.jsonl --prompts
python scripts/narration-train.py OUT/pairs.jsonl --out RUN --epochs 4 --batch-size 96 --max-per-task 60000
node scripts/narration-check.js RUN/samples.jsonl --sheets OUT/sheets.jsonl --labels OUT/bench-labels.jsonl
```

## 1b. Haiku labels and the stability runs (25 October 2026)

**Labels.** 25,968 cards went through the Message Batches API: production's card prompt (`buildProsePrompt`), one attempt each, thinking off. It cost $2.29, with the system prompt served from cache. Script: `scripts/narration-label-batch.js` (`build` runs locally; `send --yes`; `fetch`).
- Only 24% of Haiku's first attempts pass `CHECKS.card` (6,124 of 25,668 training cards; 57 of 300 held-out). The main failures are **too many sentences** (12.5K) and **the asker speaking of themselves by name** (5.2K). Production retries once and then shows template text, so many live cards probably show template text. Worth checking the card prompt or checks against Haiku 5.5.

**Game-written quotes.** `scripts/narration-compose.js` builds a first-person quote for every card from its facts: the reason, the strongest stance, the last ruling, and a closing. `narration-export.js --composed` adds them, about 29K that pass the checks.

**Decoding and checks.** Beam search (4) that never repeats a word or any three-word phrase, may not write numbers or dramatic words the facts lack, and returns every candidate. `narration-check.js` adds a fluency gate (no unknown words, no repeated words or phrases, no numbers run into words) and reports best-of-N, as the game would pick before falling back to template text. Label smoothing 0.05. Batches are padded to fixed shapes, because MPS compiles a graph per shape and runs out of memory otherwise.

**Results on new held-out cards (600), 651K parameters, 8 epochs on the 3090:**

| training data | cards with a passing quote | notes |
|---|---|---|
| Haiku quotes only (greedy decoding, before) | 17% with the strict fluency gate | repeats phrases |
| Haiku quotes only | 76% | varied, but some broken grammar the checks miss ("wants a metropolis") |
| Haiku + game-written quotes | 97% | 54% are the game-written quote word for word; 95% open with the game's reason |

Training on the 3090: under llm-manager's `training` strategy (GPU 1 free), `~/narration/run.sh` on rrh-llm-1.

## 1c. The narration student (25 October 2026)

Built on the decision student's machinery (`DecisionSetModel` with `state_layers=0`; paper Table 4: dropping the snapshot encoder improved every measure).
- **Input:** one token per triple, scope parts + attribute + value + num·num_dir[attribute], layer-normed. No encoder.
  - Values are closed tables: enums, role tokens and numbers.
  - Free text comes in as the mean of its words' embeddings, shared with the tied output table.
- **Role tokens** (`src/narration-roles.js`): names, places and numbers become placeholders such as `<asker.body>`, `<stances:0.where>`, `<place#0>` and `<options:do.cost>`, in the triples and in the targets. `relex()` puts the words back, and 99.6% of Haiku quotes round-trip exactly. The decoder may not emit a role the card lacks, so it can only name what is there.
- **Decoder:** 4 layers, d 96, 64-dim factorised word table. 721K parameters, about 704 KB at int8; the vocabulary is 3,284 words at min count 3.
- **Data** (`scripts/narration-student-export.js`): pretrain on every Haiku reply (26K quotes, passing or not, and 84K option lines), then fine-tune on the 6,181 passing quotes.
- **Quality head** (`scripts/narration-quality.py`): the decision student's error-head idea. It learns on 4 validation towns which candidates pass, from log-probability, entropy, length, beam score, unknown share and the decoder state.
- **Checking:** `scripts/narration-student-check.js` (relex, then the fluency gate and the narrator's checks).

Results on 600 cards from the 8 held-out towns (the same towns as every earlier run):

| | top candidate passes | quality head: most confident 90% |
|---|---|---|
| no pretraining | 75.8% | 83.9% pass |
| pretrained on all Haiku text | **91.8%** | **97.4% pass** (AUC 0.91) |

None of the 600 quotes copies a training quote. They read as grammatical, in the house voice. Remaining faults seen by reading: occasional contradictions ("most makers are for it, and the makers are not much moved"), occasional garbles, and some quotes that end "Which comes first?" without naming the second plan (the checks catch those).

## 1d. Shipped pipeline and quality check (25 October 2026)

**In the game.**
- Bundle: `public/students/narration/narration.v1.json`, 1.2 MB. Served through the new student-family routes (`src/student-families.js`, `cloudflare/learning.js`), where decisions keep their paths and narration has `/students/narration/`.
- Runtime: `src/narration-student.js` runs on the decision student's kernels (exported from `src/decision-student.js`).
- Routing (`createProseKeeper` in `src/narrator-client.js`): free players get the student's quote when it is confident. Plus players get Haiku, and the student when Haiku's reply is refused or unreachable. Otherwise template text. Free players had no card quotes before.
- The bundle loads lazily in the sim worker, or on the main thread when the page runs the sim inline (yielding every 4 steps). `?narrator=hosted` turns it off on the inline path.

**Parity and speed.**
- The JS top quote matches Python on 23 of 24 fixture cards (`tests/narration-student.test.js`). The one miss is an int8 rounding near-tie.
- Adaptive decoding tries a single candidate first and runs the beam only when that one is not confident: 56 ms per card in Node on an M-series Mac (was 119 ms), without the fact check.
- Two trainer bugs were fixed on the way: padding rows were not zero, and the tied word table leaked its padding row into the memory.

**Grammar judge** (`scripts/narration-judge.js`, Haiku, $0.035, 300 student quotes vs Haiku's 57 passing held-out quotes):

| | grammar clean / minor / broken | point conveyed | contradicts the facts |
|---|---|---|---|
| student | 66.7% / 32.7% / 0.7% | 98.7% | **54%** |
| Haiku | 96.5% / 3.5% / 0% | 100% | 7% |

The student mixes up details from different parts of a card: which past ruling, when, whose stance, how many asks. A past ruling is three separate triples (year, act, what), and with no encoder, triples never attend to each other, so the decoder has to bind them itself. The decision student never needed such binding, so its no-encoder result does not carry over fully.

**Fact check** (`src/narration-consistency.js`, now in the runtime): it rejects a quote that gives a group a stance the facts do not, gets a past ruling's act or timing wrong, or gets an ask count wrong. It catches 100 of the judge's 162 flags and rejects 3 of Haiku's 57. With it, the student shows a quote on 61 of 100 held-out cards (90 without it). About a third of those still carry a slip by the judge's measure. Latency is about 105 ms.

**Next (v2):**
- Let triples bind: one memory token per record (a past ask, a stance) instead of one per attribute, a 1-layer triple encoder, or a prefix-LM.
- 3–4 Haiku samples per card (about $2).
- SwiGLU, thinner and deeper layers with shared weights, EMA, and early stopping.
- Feed the judge's labels into the quality head.

## 1e. Feed-forward, BPE and int4 (25 October 2026)

All runs: 4 decoder layers, d 96, pretrain 6 + fine-tune 30 epochs. Scored on 600 held-out test cards, counting a pass only when the narrator's checks, the fluency check and the fact check all pass. Two seeds each; seed noise is about ±3 points, and more for BPE-2048.

| model | params | int8 weights | top / any of 4 pass (seed 0; seed 1) | JS median |
|---|---|---|---|---|
| words, ReLU (v1) | 721K | 731 KB | 59.2 / 63.2; 55.5 / 61.3 | 142 ms |
| words, SwiGLU (ff 128) | 720K | 729 KB | 60.2 / 63.7; 61.7 / 66.3 | 137 ms |
| BPE-2048, SwiGLU | 652K | 660 KB | 51.8 / 55.5; 62.0 / 66.0 | 136–145 ms |
| BPE-1024, SwiGLU | 586K | 592 KB | 45.3 / 49.8; 50.0 / 53.5 | 133–139 ms |

- **SwiGLU beats ReLU** on held-out loss for both seeds (about −0.02) at the same size. It is now the default.
- **BPE-2048** matches the word model at its best seed with 68K fewer parameters and no unknown words, but its seeds disagree. It is the base for scaling data; relearn the merges on the bigger corpus.
- **BPE-1024** is clearly worse here.
- **Binary bundles** (`export-narration-student.py --bits 8|4`): a JSON header, a `.bin` file of raw int8/int4 weights with fp16 scales, and the parity fixture in a separate file. v1 is about 800 KB instead of 1.2 MB.
- **int4 after training** costs 7–14 points out of 100: 408 KB with groups of 32, 452 KB with groups of 16, 526 KB with int8 embeddings. Needs quantization-aware training.
- **Trainer memory:** rows now stream into compact numpy examples, 2 GB per run instead of 7.3 GB. Four runs at 7.3 GB ran rrh-llm-1 out of memory once. `~/narration/runs.sh` refuses to start without 12 GB free.

## 1f. Four times the Haiku data (25 October 2026)

Three more Batch runs, one reply each for the 25,668 training cards ($2.26 + $2.23 + $2.26). About 25% pass the checks each time, so there are now about 25K passing quotes (was 6.2K). Pretraining covers about 103K quotes and 335K option lines. BPE-2048 was relearned on this corpus. Trained with BPE-2048 + SwiGLU, 3 pretrain + 12 fine-tune epochs, on the same held-out towns:

| | params | held-out loss | test top / any of 4 pass | JS: shown of 100, median |
|---|---|---|---|---|
| seed 0 | 652K | 1.687 | **66.7% / 70.5%** | 64, 132 ms |
| seed 1 | 652K | 1.672 | **65.7% / 70.5%** | 67, 129 ms |
| before (1× data, BPE-2048) | 652K | 1.87–1.88 | 51.8–62.0% / 55.5–66.0% | 49–60 |

More data helped more than any architecture change, and the two seeds now agree. Not yet re-judged with Haiku for fact errors; the earlier rate was 54% before the fact check. The runs are on rrh-llm-1 (`~/narration/scale-s*`), and the int8 bundles are in this session's scratchpad, not in the game.

## 1g. Quantization-aware training (25 October 2026)

`narration-student.py --qat 4` is the default for future runs:
- Pretraining runs in full precision; fine-tuning sees every 2-D weight rounded as the int4 export rounds it (groups of 32, fp16 scales), with gradients passed straight through.
- Evaluation runs on the rounded weights, and float weights are saved.
- The export picks int4 from the run's config.

v2's setup (seed 1) with QAT:

| | weights | test top / any pass (600) | JS: passing / shown of 100, median |
|---|---|---|---|
| v2, int8, no QAT | 660 KB | 65.7% / 70.5% | 72 / 67, 130 ms |
| QAT, int4 | **370 KB** | 62.7% / 67.2% | 76 / 72, 119 ms |

Rounding to int4 after training cost 7–14 points; with QAT it costs about 3, inside seed noise. Not shipped yet.

## 1h. v3 attempt: fact fixes with QAT int4. Not shipped (25 October 2026)

Three changes at once, trained with QAT int4:
1. Fine-tune only on Haiku quotes that also pass the fact check (23,912 of about 25.3K).
2. A record token per list item (`past:0`), added to the triple's scope parts (`vocab.record_scopes`).
3. The runtime beam drops a beam whose text, at the end of a sentence, fails the fact check.

Pruning lives in the runtime, so v2 gets it too.

Judged the same way (the runtime's shown quotes for 450 held-out cards, 300 judged):

| | shown of 450 | contradicts the facts | grammar clean |
|---|---|---|---|
| v2, int8 (shipped) | 332 | **19.7%** | **76.0%** |
| v3, seed 0, int4 QAT | 341 | 26.0% | 71.7% |

v3 shows a few more cards but makes more fact errors. Two follow-ups, judged the same way:
- **QAT int4 alone** (v2's data): 22.7% contradicted.
- **v4 = v3 without record tokens** (seed 1; seed 0 passed only 54.0% of test cards against seed 1's 63.5%): 24.7% contradicted, 67.3% grammar clean.

At 300 judged quotes each number is about ±2.5 points. int4 costs a few points against int8, record tokens perhaps one more, and the fact-clean filter shows no gain. Record tokens are now off by default (`--record-scopes`). To separate these properly, judge about 1,000 quotes per model (about 10 cents each) across both seeds. The three changes and int4 are confounded. Next: train v3 at int8 (`--qat 0`), and record tokens alone, to see which change hurts. Test pass rates, before pruning: v3 62.8% and 60.5% top, against 65.7% for v2.

## 1i. A binding probe, and readable years. Not shipped (25 October 2026)

**The probe** (`scripts/narration-probe.py`) measures, without generating or judging anything, how a model's belief in a quote depends on which record holds which fact.
- It teacher-forces a quote through a checkpoint, then moves the card's 64-d triple embeddings (before `up` and the layer norm) along a direction, `x + α·(x_swapped − x)`, at α = 0.25 … 1, and takes the slope at 0.
- **Exchange:** two records of one kind swap a value (two stances' leans, two past rulings' acts or years, two of the approved/refused/deferred counts). The card's set of values is unchanged; only who holds what changes.
- **Read control:** one record's value changes, with no exchange.
- It runs on CPU in about two minutes per model for 1,200 quotes, and rounds weights as the export does (`--bits 8|4`).

Run on the 1,200 Haiku-judged quotes of §1h, scoring only the records each quote mentions (log-prob drop in nats at α = 1; higher means more sensitive):

| | read | exchange (bind) |
|---|---|---|
| stance lean | 1.1–1.5 | 0.12–0.30 |
| past ruling's act | 0.8–1.0 | 0.65–0.76 |
| past ruling's year | **0.04–0.09** | **≈ 0.00** |

- **Stance leans are read but barely bound:** the model knows which leans the card has, not which group holds which. This is the "makers are for it… makers are not moved" fault.
- **Past rulings' years were ignored outright.** The year triple's value is a role token (`<past:2.year>`), so the only time signal was a log-scaled offset on one shared `num_dir[year]` direction.
- **Rounding:** v2 rounded to int4 after training loses lean reading (1.42 → 1.18) and act binding (0.76 → 0.66). QAT keeps both.
- **Halfway blends score worse than a straight line** between the ends, so gradients at α = 0 mislead. Use the discrete swaps.
- **Against the judge:**
  - Per quote, the probe adds almost nothing to log-prob as a contradiction detector (cross-validated AUC 0.665 → 0.674).
  - Per model, lean read sensitivity orders the four judged models as the judge did: v2 1.42, QAT 1.34, v4 1.08, v3 0.13 against 19.7 / 22.7 / 24.7 / 26.0% contradicted. Four points only.
  - It predicts that scale-s0 (0.39) contradicts more than v2 and v3 seed 1 (0.87) less than seed 0. Judging those two would test it (about $0.07); not done.

**Readable years** (`--year-ago`, vocab `year_ago`): a list item's year field also adds a closed scope part, `ago:0` … `ago:5`, `ago:6-10`, `ago:11+`, derived in the codec from the existing offset (Python `years_ago`/`ago_part`, JS `yearsAgo`/`agoPart`; they agree on all 37,272 year triples of the test cards). With it, number words for those offsets are allowed ("three years ago"). Bundles without the flag (v2) are unchanged, and the parity test passes. Trained with v2's setup, 652,848 parameters:

| run | held-out loss | test top / any pass | timed past rulings with the time wrong | year read / bind |
|---|---|---|---|---|
| v2 seed 0 / seed 1 | 1.687 / 1.672 | 66.7 / 70.5; 65.7 / 70.5 | 9.7% / 14.4% | 0.04–0.08 / 0.00 |
| year-ago seed 0 / seed 1 | 1.683 / 1.682 | 66.0 / 71.2; 57.7 / 63.8 | 13.1% / 13.1% | 0.21, 0.14 / 0.04–0.05 |
| QAT int4 seed 1: v2 / year-ago | 1.693 / 1.707 | 62.7 / 67.2; 60.3 / 65.0 | 12.0% / 11.4% | 0.08 / 0.13 |

The model reads years 2–3× more but times past rulings no better, and seed 1 lost 8 points. **The input was not the bottleneck,** so the flag is off by default. Likely next: Haiku's own quotes and the template text rarely time a ruling, so there is little to learn from. Count how often passing quotes state a time, and whether it is right, before changing the model again. Runs: rrh-llm-1 `~/narration/year-*`.

## 1k. Stances bound in one token: better on both seeds. Not shipped yet (25 October 2026)

`--stance-who` (vocab `stance_who`) adds a stance's group words to its lean token: `stances:0 lean for` also carries the mean embedding of "farmers". The group is then in the same memory token as its lean, and the decoder no longer has to link two tokens. No new parameters. Mirrored in `src/narration-student.js` `encode`; bundles without the flag are unchanged. v2's setup (int8, no QAT, no year-ago), 600 held-out test cards, against v2's two seeds:

| run | held-out loss | stance fact-fails | all fact-fails | top / any of 4 pass | lean read / bind (probe) |
|---|---|---|---|---|---|
| v2 seed 0 | 1.687 | 61 | 175 | 66.7 / 70.5% | 0.39 / 0.22 |
| v2 seed 1 (shipped) | 1.672 | 62 | 172 | 65.7 / 70.5% | 1.42 / 0.16 |
| **stance-who seed 0** | **1.679** | **48** | **159** | **69.7 / 75.0%** | **1.98 / 1.76** |
| **stance-who seed 1** | **1.659** | **44** | **169** | **67.0 / 70.2%** | 0.95 / 0.48 |

- **Stances bind:** exchanging two groups' leans now costs 3–11× more log-prob than in v2. Stance fact-fails fall by about a quarter on both seeds, and held-out loss improves on both.
- **Other faults are unchanged,** as expected: rulings, timing and counts. On seed 1, rulings dropped and counts rose.
- **Bundles** (`export-narration-student.py`, int8, same size as v2):
  - Parity: 23/24 (seed 0) and 24/24 (seed 1); 18 of the 24 fixture cards have two or more stances.
  - Shown on 100 held-out cards: 78 and 73 (v2: 76).
  - Median latency: 34 ms and 131 ms (v2: 127). Seed 0's quality head trusts its first candidate more often, so it skips the beam.
- **Haiku judge, seed 0, runtime quotes judged as for v2** (333 of 450 cards shown, 300 judged, $0.029): 20.7% contradict the facts against v2's 19.7%. Grammar clean 78.3% (v2 76.0%); point conveyed 100% (99.3%).
  - The 1-point gap is 62 quotes against 59, well inside noise (about ±3.3 points for a difference at n = 300). Still, it missed the shipping bar of "no worse than v2", so it is **not shipped**.
  - By rough claim type (regex buckets that overlap; the judge does not say which claim was wrong): quotes stating a stance were contradicted 23% (v2 28%), and quotes stating counts or numbers more often (16% and 32%, against 7% and 25%).
  - To settle it: judge about 1,000 quotes for each of v2 and stance-who seed 0, plus seed 1, at about $0.10 per 1,000. Judge file: that session's scratchpad, `judge-who0.jsonl`.
- Runs: rrh-llm-1 `~/narration/who-s*`. Bundles are in that session's scratchpad (`bundles/who-s*.json`).
- The same idea could carry a past ruling's `what` words into its act token. Rulings are now the largest fault (54–66 of 159–169).

## 1j. Side results: speed, and an int4 decision student (25 October 2026)

**Would WebAssembly help?** Measured with hand-assembled WASM kernels on narration v2's layer shapes (515K multiply-adds per beam step, Node 24, M-series Mac):

| matmul kernel | µs per beam step | vs today |
|---|---|---|
| JS float (`linFlat`) | 362 | 1× |
| WASM f32x4 SIMD | 36 | 10.1× |
| WASM int8 dot (`i32x4.dot_i16x8_s`), activations quantized per call | 33 | 11.1× |

- **Narration:** 93% of a quote's time is the network's math (profile of 100 held-out cards): weight matmuls ~60–65%, attention ~24%. Moving all of it would give an estimated 4–6× per quote (140 ms → 25–35 ms), not measured.
- **Decision student:** about 23% of a 40-year town's wall time (0.7 of 3.0 s, ~31 µs per answer). At most a 1.3× faster sim, and float SIMD reorders sums, which breaks the bit-identical town hashes.
- int4 storage does not speed anything up today: both runtimes expand weights to float32 at load.

**An int4 decision student (v8 candidate).** v7's training data is on this Mac: the Cloudflare bootstrap staging folder, `data/strike-training/bootstrap-v7-isolated-r2/assets/`, stores it gzipped by sha256 (`config.json` maps paths to hashes). It holds `train-a.jsonl`, `onpolicy-1.jsonl`, the novel rows for v2–v7, `realplay-test.jsonl` and the gate questions. The shipped v7 is the `v7-isolated` run; `data/strike-training/v7/` is the rejected full fine-tune.
- int4 QAT (groups of 32 = one fp16 scale per row, as the narration export) from v7's float weights on the trainer's train towns, with each candidate saved with its rounded weights and scored by the loop's own `eval_decision_student.py`:

| candidate | test KL (47,548 rows) | real-play KL: per question / by traffic |
|---|---|---|
| v7, int8 (shipped) | 0.02033 | 0.01990 / 0.01092 |
| int4 after training | 0.02622 | 0.02551 / 0.01749 |
| int4 QAT, 4 epochs (2 min, CPU) | 0.02075 | 0.02055 (+3.3%) / 0.01122 (+2.8%) |
| int4 QAT, 10 epochs | 0.02044 | 0.02018 (+1.4%) / 0.01133 (+3.8%) |
| int4 QAT, 10 epochs, loss weighted by traffic share | 0.02092 | 0.02062 (+3.6%) / 0.01095 (+0.3%) |
| **int4 QAT, 10 epochs, half traffic-weighted, half uniform** | 0.02071 | **0.02033 (+2.1%) / 0.01071 (−1.9%)** |

- Uniform weighting fails the traffic limit, and traffic-only weighting fails the per-question limit.
  - Traffic weighting gives each kind's rows a total weight in proportion to its share of real-play traffic (resident_routine goes from 9% of the weight to 73%), with a floor of 0.05%. The shares come from the gate's question counts, not its labels.
- **The half-and-half mix passes both,** and is a little better than v7 by traffic.
  - It also passes the loop's other offline gates: no busy kind worse (worst: festival_participation +13.6%, against 1.2× + 0.002); largest busy option bias 0.017 (limit 0.05; v7 0.019); no rare option outside 0.67–1.5.
**v8 int4, exported and gated (not published).** `export_decision_student.py --bits 4 --group 32` (trainer repo, and its vendored copy in `cloudflare/training/vendor/scripts/`) stores 2-D matrices as `{shape, i4, scale16, group}`: two values a byte, low nibble first, fp16 scales rounded before quantizing, as the narration export. `decodeWeight` in `src/decision-student.js` reads them (test in `tests/decision-student.test.js`). The confidence head was retrained (`train_error_head.py`: rank correlation 0.543 on real-play rows). Re-exporting the QAT weights is lossless (KL 1.4e-8 against float). The loop's post-export gates, run by hand:

| gate | v7 (shipped) | v8 int4 | limit |
|---|---|---|---|
| JS parity, largest difference | 1.6e-7 | 2.8e-7 | < 1e-4 |
| size: weights + vocab (weights alone) | 335 KB (189) | **249 KB (103)** | ≤ 450 |
| cached latency | 68 µs | 63 µs | ≤ 400 |
| young-town bias (household_stay_move: stay) | −0.024 | −0.029 | ≤ 0.05 |
| canary work share, 4 towns | 13.9% | 14.7% | within 3 points |

- **Population** (reported, not gated) differed on the 4 canary towns: v8 763, v7 462 (geometric means).
  - Over 16 towns it was 479 against 383, with a paired log-ratio of 0.22 ± 0.16 (v8 larger in 11 of 16). That is noise: towns diverge once ~2.5% of answers differ.
  - Work share over 16 towns: 15.1% against 14.5%.
- **Not run:** the held-out novel-rows gate. It scores a cycle's new rows, and this candidate has none.
- **Published size, with the fixture trimmed to 8 rows as the loop does:** 270 KB, 100 KB gzipped (v7: 356 KB, 167 KB gzipped). It is `decisions.v8.published.json` in the candidate folder, and it passes parity too (9.6e-8).
- **To publish,** copy that bundle to `public/students/decisions.v8.json` and add it to `manifest.json`.
- The candidate (run, bundle, scripts, README) is in `data/strike-training/v8-int4-candidate/`, which git ignores.

## 2. What we learned

- **The game only asks the narrator for two things today:** Council card quotes (`card.why`, on request from the open view) and inspector notes for people, households, buildings and bodies. The prose keeper never asks for year or end-page prose (`createProseKeeper` in `src/narrator-client.js` has no clock-driven work).
- **End of game:** the end summary is written at year 150 (`END_YEAR`, `src/sim/chronicle.js`). The Chronicle panel shows its preview from year 140 or the Metropolis era (`src/sim/view.js`). Play doesn't stop at 150.
- **Haiku's output isn't kept anywhere reusable.**
  - Production logs record only a result category and timings, on purpose (`cloudflare/narration-outcome.js`).
  - The per-account Durable Object keeps one `narration-cache` row for 24 hours.
  - Resolved cards drop their `prose`.
  - Inspector notes and chronicle prose do stay in saves, but those are players' saves.
  - The only Haiku text on hand is 46 outputs in `benchmarks/narration-*.json`; **28 pass the narrator's checks**.
- **The domain is small.**
  - Card reasons come from about 87 templates, with 120 distinct "why" texts and a vocabulary of about 450 words.
  - Entity fact lines use about 430 words.
  - About 71% of the content words in Haiku's accepted quotes appear in the facts it was given. The model mostly selects facts and copies them; it doesn't need to invent text.
- **Logging Haiku output going forward** would give free training data, but it reverses the current no-text logging rule. That's the user's call.

## 3. The data

**Triples.** `narrationTriples(facts, {drop})` walks any sheet against its schema and gives `[scope, attribute, value, num, type]`:
- `type` is `enum`, `num` or `text`.
- Text keeps its case so the model can copy names, places and labels.
- Year fields carry their offset from the sheet's year in `num`.
- List items are scoped by key or index (`options:x_do`, `stances:0`).

**Two sources of prose, told apart by `task`:**

| task | source | target | left out of the triples |
|---|---|---|---|
| `card.why` | template | the card's reason | `card.why` |
| `year.text` | template | the chronicle's year line | `year.template` |
| `entity.note` | template | `fallbackNote(facts)` | nothing |
| `card.quote` | model (`--labels`) | the asker's quote, checked by `CHECKS.card` | nothing |
| `year.prose` | model | checked by `CHECKS.year` | nothing |
| `entity.prose` | model | ≤ 60 words, ends a sentence | nothing |

Template rows are unlimited and free. They teach copying and keeping the facts straight. Model rows teach the voice. At runtime the game would ask for the model task.

**Sizes measured.**
- One seed to year 40: 1,340 distinct sheets in 3 s.
- One seed to year 150: 5,600–6,600 sheets in 2–6 minutes.
- The stopped run's 16 seeds hold about 96,600 sheets before cross-seed dedupe: 24k body, 19k building, 19k household, 19k person, 13k card, 2.4k year, 16 end.
- Those 16 seed files are in the other session's scratchpad (`/private/tmp/claude-501/…graphics-optimization-handoff-3f536a/c532a6f3-…/scratchpad/nc40/parts/`). They may be gone after a reboot, so plan to rerun.

## 4. Next steps

1. **Collect** (about 25–40 minutes for 40 seeds). Run it alone; it will compete with anything else for CPU.
   ```bash
   node scripts/narration-collect.js OUT --seeds 40 --years 150
   ```
   ```bash
   node scripts/narration-export.js OUT --labels OUT/bench-labels.jsonl
   ```
   For `bench-labels.jsonl`, walk `benchmarks/narration-*.json` for rows with both `raw` and `facts`, parse `raw` as JSON, and write `{facts, field: 'why', text: raw.why, model: 'claude-haiku-5-5'}` per line. The export keeps only rows that pass the checks.
2. **Design doc** `docs/design/narration-distillation.md`, in the style of `decision-distillation.md`.
3. **Trainer.**
   - Model: a triple-set encoder (reuse the decision student's set encoder) and a small decoder that can copy tokens straight from text triples. About 0.5M parameters: under 600 KB at int8, about 350 KB at 4-bit.
   - A task token selects the template or the model voice.
   - Pretrain on template rows, then fine-tune on model rows.
   - Split train and test by seed, as the decision student does.
4. **Gates.**
   - On held-out seeds, the student's `CHECKS` pass rate is at least Haiku's (11 of 12 live in the benchmark).
   - No stray names or numbers.
   - A side-by-side read of a sample.
5. **More Haiku labels** cost API money. Ask before any live calls. The Batch API would roughly halve the cost; the benchmark measured about 830 input and 56 output tokens per card.

## 5. Loose ends

- **Two unit test failures from the last full run**, neither in narration code:
  - `150 headless years … stay finite and reach era 2` failed its time limit (85 s) while the collection was using the CPU.
  - `household members at a gathering end up near each other` also failed before main was merged in.

  Neither has been rerun on its own yet.
- **The handed-off session** "Narration dataset and tiny triples-to-text model" (branch `claude/friendly-fermi-562b8c`) has the same commit. It kept restarting the collection after it was stopped, so it was stopped again. Archive it, or tell it plainly what to do, before relying on it.
