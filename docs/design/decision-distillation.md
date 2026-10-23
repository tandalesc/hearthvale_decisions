# Distilling routine decisions into the browser

A plan to answer the town's highest-volume decision questions with a tiny model that runs in the sim worker, so they never reach a GPU. Written 21 October 2026 against `a5347fc`. Nothing here is built yet.

---

## 1. Why

- `resident_routine` is **70–80% of the questions the town needs** (city: 14.4 of 18.3 q/s at 1×; `decision-model-hosting-costs.md` §2.3). It also scales with game speed, which is what saturates the local teacher server at 20×.
- **Every input is categorical.** The context is bands (time of day, energy, food, company, trade, wealth, life stage). The snapshot is bands too, and `rules`, `recent` and `bodies` are built from fixed lists (47 policies, 18 tags, 13 body kinds). 85% of asked questions are exact repeats.
- So the answer is a smooth function over a small input space. A small MLP can learn it from d1-3B's own distributions.
- **What we keep:** the same answer shape (`{choice, confidence, probabilities}`), the same pooling, sampling, fallbacks and `answerLog`. Replay stays exact because answers are logged.
- **What it saves:** the bulk of server and GPU load, for every player, at every speed.

## 2. What runs where

| Step | Where | GPU |
|---|---|---|
| Grow towns, dump questions | Mac or any CPU, headless | none |
| Label distinct questions with d1-3B | Local teacher server, one request in flight | **minutes, once per round** |
| Train | Mac (CPU or MPS) | none |
| Answer in play | sim worker, plain JS | none |

**GPU budget.** The dump script prints the distinct-question count before anything is sent. At the measured ~200 q/s, 100k distinct questions take about 8–9 minutes; a 50 q/s cap stretches that to ~35 minutes and leaves the box usable. Labelling is resumable, so it can run in short windows.

## 3. Pipeline

1. **Features, in JS** (`src/decision-features.js`). One function turns `(kind, snapshot, context, allowed)` into a fixed-length vector. It is the single source of truth: the dump, the trainer and the game all use it, so features can't drift between Python and the browser.
   - One-hot each band; levels for the 47 policies; multi-hot for `recent` and `bodies`; `log(group)`.
   - Drop free-text names (`districtName`, `district`). The teacher sees them; the student can't use them. Measure what that costs in step 6.
   - About 200 inputs for `resident_routine`.
2. **Collect** (`scripts/distill-collect.js`). Grow ~40 seeds across all `waters.js` archetypes to year 150 headless, with local fallback rules answering everything. Record every `resident_routine` question, its feature vector, and how often it was asked. Dedupe on the exact key the client cache uses. Print counts and stop.
3. **Label** (`scripts/distill-label.js`). Send the distinct questions through `requestDecisions` in `server/system1.js`, so prompts are byte-identical to play. Group by state (64 per request) to use the service's state cache. Concurrency 1, optional `--qps` cap. Append to JSONL; skip keys already done. Keep the full distribution and the model revision.
4. **Train** (`scripts/distill-train.py`). MLP 200 → 128 → 64 → 6, masked softmax over `allowed`, loss KL(teacher ‖ student). Weight samples by `sqrt(times asked)`, so common states matter more without drowning rare ones. Split train and test **by seed**, not by row. Minutes on CPU.
5. **Export.** Weights to `public/students/resident_routine.v1.json` (~35k parameters, about 140 KB as float32, ~40 KB as int8). The forward pass is ~20 lines of JS. No runtime library.
6. **Gates.** Ship only if all pass:
   - Held-out seeds: mean KL(teacher ‖ student) under 0.02 nats as a starting bar, worst 1% of cells reported, top-choice agreement and calibration against the teacher.
   - Per band: no single band (e.g. elders, evenings, slums) more than 2× the mean KL.
   - Town outcomes: `scripts/balance.js` on a few seeds, student against a teacher-backed run. Population, years in debt, receivership and the activity shares by time of day should land within seed-to-seed noise (HANDOFF "Open decisions" table).
7. **On-policy round.** Towns grown with fallback rules visit somewhat different states than towns run by the model. Grow again with the student answering routine, dedupe against what's labelled, and label only the new questions. Usually a small batch. Repeat until new questions are rare.

## 4. Wiring

- `src/decision-local.js`: `createLocalAnswerer({students, client})` wraps the client's `ask`. For a kind with a student it answers at once (`model: 'student:resident_routine@v1'`); otherwise it passes through. The scheduler already wraps `bus.ask` in `Promise.resolve`, so nothing there changes.
- Same fallback order as now: student, then service, then local rules.
- `?student=0` turns it off, like `?simWorker=0`. Settings → Decision model gets a line saying which kinds answer locally.
- `tests/decision-student.test.js`: the bundle loads in Node, answers a stored fixture identically, masks `allowed`, and returns the client's answer shape.

## 5. Why not ONNX, Laya or Kev in the browser

- **The MLP doesn't need ONNX.** onnxruntime-web adds several megabytes of WASM and an async start for a model that is a few matrix multiplies. Plain JS also runs in Node tests and on the main-thread fallback with no extra work.
- **ONNX earns its place only one size up:** if the MLP can't pass the gates, a small transformer over the same features (a few million parameters, a few MB) is the next step, and that is where ONNX or WebGPU make sense.
- **Laya (421M) and Kev-0.8B are too big to download** for a browser game: hundreds of MB to over a GB, like the 1.76 GB d1-3B q4 build. They stay server-side options for the long tail.

## 6. Next kinds, and what stays on the server

- **Next candidates** (banded inputs, fixed options, steady volume): `crime_charity`, `newcomer_integrate`, `festival_participation`, then `household_home` once its savings, income and rent are banded. Check each one's share of traffic before doing it.
- **Stay on the service:** kinds with free-text options that change each time (`choose_site`, `institution_draft`, `where_to_settle`), raw-number kinds (`enterprise_plan`, `institution_negotiate`), and the two scales (`migration_wave`, `take_loan`), whose calibration was tuned against d1-3B. They are low volume, so hosted d1 or Clef-flash covers them cheaply.

## 7. Continual updates

The student can keep learning after launch. It learns from the teacher, never from play.

- **No signal comes from play.** The student copies a distribution of plausible behaviour. Nothing in the game says which answer was right, and training on outcomes (growth, coin, approval) would teach it to chase those numbers instead of acting like people.
- **The loop runs across all players, not in each browser:**
  1. **The student flags what it doesn't know.** Ship a small Bloom filter of the feature keys it was trained on, or two or three tiny MLPs and their disagreement. Either costs microseconds.
  2. **Novel questions are logged, not labelled live.** The student (or the local rules, when it is far off) still answers at once. The proxy appends the question to a log. It holds game state only.
  3. **Label in batches.** Weekly or nightly, dedupe the log against everything labelled and send the rest to d1-3B at low priority (§3, step 3). It shrinks as coverage grows.
  4. **Retrain, run the §3 gates, ship `v(n+1)`.** This is the on-policy round, with players' towns as the source.
- **One teacher only.** Labels come from d1-3B. Hosted d1 or Clef answers from play are not training data; mixing teachers makes the student copy an average of models.
- **Weights are fixed within a save.** A new version loads when a game starts or a save opens, so a town doesn't change temper mid-game. The `answerLog` model id records which version answered.
- **Per-player tuning, if ever.** Only as a small additive residual on the logits, decayed toward the shipped model and trained only on real teacher answers. The shipped weights never change in the browser. Not worth it unless live teacher calls are cheap.

## 8. Open questions

- How much do district names matter to the teacher? Step 6's per-band check will show it. If it's large, add the district's `character` and position features rather than the name.
- Retrain whenever a kind's options, wording or the snapshot bands change. Version the bundle with the kind's wording hash so a stale student is refused, not silently wrong.
- If the teacher changes (hosted d1 or Clef at launch), decide which teacher the student copies. d1-3B is the one all the calibration work was done against.
