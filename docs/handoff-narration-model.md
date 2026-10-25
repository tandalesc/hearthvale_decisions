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

v3 shows a few more cards but makes more fact errors. The three changes and int4 are confounded. Next: train v3 at int8 (`--qat 0`), and record tokens alone, to see which change hurts. Test pass rates, before pruning: v3 62.8% and 60.5% top, against 65.7% for v2.

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
