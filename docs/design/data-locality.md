# Data locality in the simulation (investigation)

> **Status** (2026-10-22): investigation. One proof of concept landed with it: the
> scheduler's `homeQuestions` (§3, item 1). It saves about 4 % of a 150-year headless run, and
> towns stay bit-identical. Everything else here is a proposal.

**Question.** Would better memory layout or cache behaviour make headless student towns
(`scripts/distill-collect.js`) and the game's sim worker faster, while keeping every
town bit-identical for a given seed?

**Answer.** Mostly not by changing the layout. Each working set is small enough to stay in cache:
- a 384 × 384 grid is 144 KB as bytes and 576 KB as floats;
- one footprint generation is about 2 MB;
- the student's weights are 0.5 MB, and a question's activations are about 10 × 32 floats.

The time goes on three things:
- walking all 147,456 cells, or every building or household, to find the few that changed;
- rebuilding derived grids from scratch when a patch would give the same values;
- computing rows that nothing reads.

The wins come from touching less memory: dirty regions, early filters and dead-row
elimination. A struct-of-arrays rewrite of buildings, households or people would not
pay for itself. The profile does not show object layout as a cost, and such a rewrite
would touch `serialize`/`restore`, the render mirror and hundreds of call sites.

## 1. How it was measured

- **Town.** `scripts/town-hash.js` (new) grows the same town as `distill-collect.js
  --answer student --player`. It uses the v2 student, index 0, salt 0, and records nothing,
  so the times are the sim and the student only.
- **Profiles.** `node --cpu-prof` of whole runs, aggregated by function (self and inclusive).
  - The 150-year profile ran beside three other towns. Its shares are reliable; its wall
    time (101 s) is not.
  - A solo run of the same town takes 71–83 s, depending on machine load (other sessions
    kept the load average at 3–20).
- **Counts.** Temporary counters, since reverted, in `roads.js` and `decision-student.js`.
  They recorded rebuilds, their times and the student's token shapes, from a solo
  150-year run (83 s).
- **Student replay.** 18,040 student questions were recorded from a 40-year town, then replayed
  through two builds of the student in the same order. Every probability and `expectedKL`
  was compared with `Object.is`, and each build was timed (median of 5).

## 2. Where the time goes

Seed 66, 150 years (pop 2,217):

| | share of run | notes |
|---|---:|---|
| **Student forward pass** (`decision-student.js`) | 37–39 % | `attendFlat` 22.6 %, `ffnFlat` 8.9 % (self, with `linFlat` inlined). 189,813 answers |
| **`footprints()` rebuilds** (`roads.js`) | 13.5 % | **3,200 rebuilds**, avg 719 buildings, 3.5 ms each (11.3 s solo). Biggest parts: `stampWalls` loop 4.7 %, `noteChangedTiles` 3.0 %, `unsealWay` 1.6 %, outlines 1.65 %, `wayIn` 1.4 % |
| **`structuralGrid`** (`roads.js`) | 7.1 % | **1,244 full 147k-cell rebuilds** (4.6 ms each), against 409 patches. 2.5 s of its 5.7 s is the footprint rebuild it triggers |
| **Scheduler `fillWith`** | 9.9 % | `homeQuestions` 4.8 % (now 1.1 %), `askExtra` 1.8 %, own 2.3 % |
| **`proposeSites`** (`sites.js`) | 9.0 % | `scoreLot` 4.1 %, `cachedFrontier` 1.9 %, `footprints` 1.6 % |
| **Monthly road scans** | 1.8 % | `decayAndRetier`, `consolidateWear`, `bridgeGaps`: each walks all 147k cells every month. 4.3 % at 60 years |
| `navigation.js` (`components`, `searchJob`) | 3.2 % | |
| `decision-kinds.js` | 1.9 % | `checkFields`, `canonicalJson`, `validateState` |
| Terrain noise and river (`land.js`, `terrain.js`) | 2.3 % | 4.5 % at 60 years, mostly `sampleRect` → `bankDistance`/`riverX` in site checks |
| Garbage collector | 1.1 % | allocation is not the problem |

At 60 years (13.5 s) the student is 40 % and `roads.js` 17.6 %. The road share grows with
the town, because every rebuild walks every building.

**The student's shapes**, averaged over the run:
- 4.0 question triples, 47.5 snapshot triples and 5.8 options per question. The decoder
  therefore runs about 10 rows, and only the 5.8 option rows reach the output.
- The per-snapshot memory cache hits 92 % of the time.
- In the 40-year replay, 18,040 questions held only **7,698 distinct questions** and 822
  distinct states.
- `stateKey` costs 3.4 µs an answer and `decisionTriples` 1.4 µs, against about 86–148 µs
  for the forward pass.

**Bandwidth sanity check** (a microbenchmark on the loaded machine, so approximate):
- comparing two full grids takes 0.4–0.5 ms;
- `new Int32Array(CELLS)` takes 25 µs;
- `slice()` of a float grid takes 65 µs.

A full-grid pass costs far more than a copy. That is why every proposal below shrinks the
set of cells touched rather than rearranging them.

## 3. Proposals, ranked by gain over effort

The gains are shares of the 150-year solo run, unless marked otherwise. "Exact" means each
output value is computed by the same arithmetic as before, so the town hash cannot move.

### 1. `homeQuestions`: filter before building contexts — **done (proof of concept)**

- **Problem.** On every tick with room in the queue, it built a full context object
  (`homeContext`) for every household with a home, then kept only the few within 40 % of
  affording an upgrade.
- **Change.** The savings test now runs first, from `h.savings` and the home's tier, and
  only the households that pass it get a context. The cost formula is shared, so the two
  cannot drift apart. A NaN in savings is still excluded, as before.
- **Gain.** 4.8 % → 1.1 % of the run (about −2.9 s).
- **Effort.** 20 lines in `src/sim/decisions/scheduler.js`.
- **Risk.** None.
- **Bit-identity.**
  - Same households, same contexts and same sort.
  - `scripts/town-hash.js` matches the base commit at all 15 decade checkpoints, for seeds 66
    (`be4164aee983efbb`), 7 (`3e7db767fdc37e89`) and 12 (`be0636aa7e7764e0`).
  - The four test files that touch the scheduler and the student pass (67 tests).

### 2. Student: the last decoder layer computes only the option rows

- **Problem.** `logits` takes `out_norm` of the option rows only, so in the last question layer:
  - the question rows' cross-attention, FFN and residual updates are dead work;
  - their self-attention queries are dead too. Their keys and values are still needed.
- **Change.** In the last layer:
  - run LN1 over all rows for the keys and values;
  - run the queries, cross-attention, LN2, LN3 and the FFN over the option rows only.

  Every one of these steps works row by row, so each kept row's arithmetic is unchanged.
- **Gain (measured).** **0.67×** the student's time (2,665 → 1,790 ms on the replay), about
  **−13 % of a run**. It stacks with the exact answer cache another session is adding: the
  cache removes repeats (7,698 distinct questions out of 18,040), and this speeds up the ones left.
- **Effort.** About 15 lines in `logits`.
- **Risk.** None for identity. Answers differing on the replay: **0 of 18,040**.
- **Prerequisite.** `src/decision-student.js` is being edited by another session now; apply
  this after that lands.
- **Bit-identity.**
  - Replay check: every probability and `expectedKL`, compared with `Object.is`.
  - Then `town-hash.js` on three seeds.
  - Worth adding the replay as a test against the bundle's `fixture`.

### 3. `structuralGrid`: patch on footprint-only changes instead of rebuilding

- **Problem.** The grid's `base` key includes `footprintKey`, so any building change (3,200 in
  150 years) rebuilds all 147,456 cells. `navGrid` already patches instead (`patchFootprints`).
- **Why a patch is enough.** A structural cell's cost is a pure function of:
  - `blocked[i] != 0` and `field[i]`;
  - tier, road adjacency and the fords closed by bridges;
  - the terrain.
- **Change.** When only the footprint changed (same `navRev`, same roads object), recompute
  only the cells whose `blocked`-is-set or `field` changed. Invalidate `comp` by the
  existing rule, and keep `nodesFor` as it is.
- **Gain.** About 3 s of own time → under 0.5 s, about −3.5 %.
- **Effort.** Small to medium, about 40 lines.
- **Risk.** Low.
- **Bit-identity.** For one 150-year run behind a dev flag, build both ways at every change
  and assert that `cost`, `water` and `comp` are equal (shadow mode). Then run `town-hash.js`.

### 4. Footprints: sparse tile diff and a typed `unsealWay`

- **`noteChangedTiles`** compares all 147k cells of `nearAt` and `walls` against the previous
  generation (3.0 %).
  - **Change.** Each generation keeps the list of cells its stamps wrote: building rects,
    fields and wall/near cells. The diff then visits the union of the two lists.
  - **Why it is exact.** The tile marks and log entries are only ever read as sets
    (`maybeChanged`, `memoCatchUp`), so the visiting order does not matter.
- **`unsealWay`** builds a `Map`, an `Array.from` and a `front` array for each of about
  700 ways in, every rebuild. A corridor also removes cells with
  `wallCells.indexOf` + `splice` (1.6 %).
  - **Change.** Use typed scratch arrays (as `pocketMark` already does). Mark the removed
    cells and filter `wallCells` once at the end, which keeps the same order. `wallCells`
    and `doorCells` are only ever read as sets anyway.
- **Gain.** About −3.5 %.
- **Effort.** Small.
- **Risk.** Low.
- **Bit-identity.** Shadow mode compares `tileGen`, `wallGen`, the log's tile sets and
  `wallCells` as a set. Then run `town-hash.js`.

### 5. Monthly road scans over the active box

- **Problem.** `decayAndRetier`, `consolidateWear` and `bridgeGaps` each walk the whole grid
  every month. Each pass's guard already rejects cells with no wear and no tier, and most of the map
  is such cells.
- **Change.**
  - Keep a bounding box of the cells with `wear > 0 || tier > 0`, grown in `addWearAt` and
    `setTier`. `decayAndRetier` already computes it each month.
  - Scan the box plus a 2-cell margin. `bridgeGaps` and `consolidateWear` read neighbours.
- **Gain.** −1.5 % at 150 years, −3 to 4 % at 60 years. Young towns gain most: the scan costs
  the same, and the box is small.
- **Effort.** Small.
- **Risk.** Low. Cells outside the box fail every guard, so they produce no writes.
- **Bit-identity.** `town-hash.js`. A unit test can also assert that one pass over the box and
  one over the full grid leave the same `wear`, `tier` and `low`.

### 6. The scheduler's per-tick structures

On every tick, `fillWith` does three things:
- builds `new Map(state.households.map(...))` (`byId` already keeps this index);
- builds the `skip` set from `Object.keys(gov.individual.household_home)`;
- makes string keys `p${id}.${variant}` and string signatures for `rt.fresh`.

- **Change.** Use `byId`, keep `skip` up to date when answers are stored, and use numeric
  keys where a string is never read back.
- **Gain.** About −1 to 2 %.
- **Effort.** Small.
- **Risk.** Low.
- **Bit-identity.** The same members are visited in the same order; check with
  `town-hash.js`.

### 7. Student: memoize the option tokens' first-layer work

- **Problem.** Option tokens are constants for a (kind, options) pair (`optionsFlat` already
  memoizes them). So with one question layer, their LN1 output and their Q/K/V projections
  are constants too, yet they are recomputed for every question.
- **Change.** Memoize those next to `optionsFlat`. Only the question rows (about 4 of 10)
  would be projected.
- **Gain.** An estimated −10 % of the student's remaining time, about −3 % of a run.
- **Effort.** Small to medium.
- **Risk.** None for identity: the same arithmetic, done once.
- **Prerequisite.** After item 2 and the other session's edits.
- **Bit-identity.** The replay check from item 2.

### 8. Footprints: copy-on-write with a regional restamp

- **Problem.** Each world bump restamps all ~720 buildings into fresh 147k-cell arrays,
  although usually one building changed.
- **Change.** Copy the previous generation's arrays (a `slice` is about 65 µs). Then clear
  and restamp only a clip rectangle: the changed buildings' old and new reach, plus margin.
  Restamp, in list order, every building whose reach overlaps it.

  Older generations stay intact, which matters because `patchFootprints`, `walkerGrid` and
  `noteChangedTiles` compare against them. The change also yields the changed-cell list
  that items 3 and 4 need.
- **Gain.** Most of the 11 s left after item 4: about −8 to 10 %.
- **Effort.** Large.
- **Risk.** Medium. The per-cell order rules have to be reproduced exactly:
  - `blocked`: the last writer in list order wins;
  - `walls`: the first writer wins, except cells in `keepOpen`;
  - `wayIn` reads its neighbours' `blocked`;
  - `unsealWay` corridors reach up to 400 cells;
  - near lists are kept in stamp order.
- **Bit-identity.** Shadow mode is required:
  - for whole 150-year runs on several seeds, build both ways at every bump;
  - compare every array, plus the near lists by content, before deleting the full rebuild.

### 9. Validate and key each snapshot once

- **Problem.** Every question re-validates its snapshot (`checkFields` returns a fresh copy)
  and re-hashes it (`canonicalJson` → `stateKey`). The scheduler hands out the same memoized
  snapshot objects (`townSnapshot` per quarter, `districtSnapshot`) many times.
- **Change.** A `WeakMap` from the raw snapshot to `{clean, key}`. Before this is safe, audit
  that snapshots are never mutated after they are handed out.
- **Gain.** About −1 to 2 % now. It becomes the per-answer floor once the answer cache lands.
- **Effort.** Small.
- **Risk.** Medium, until the mutation audit is done.
- **Coordination.** This touches the bus and the student's cache key, which the other
  session is working on, so coordinate with it.

### 10. Render mirror (browser sim worker only)

- **Problem.** `render-mirror.js` `roads()` runs `changedRect` over the whole `wear` grid on
  every step, and over `tier`, `planned` and `low` (byte by byte) whenever the road version
  or the dirty rect changed. That is about 0.1–0.4 ms of worker time a step, or 2–4 % of an
  8–10 ms dawn step at 20×.
- **Change.** Compare 4 bytes at a time through `Uint32Array` views, as `buildNavGrid`
  already does. Better still, keep a wear dirty rect in `addWearAt` and `decayAndRetier`, the
  way `roads.dirty` works for tiers.
- **Effort.** Small.
- **Risk.** No risk to the simulation: render-side only.
- **Check.** `tests/render-mirror.test.js` checks the mirror against the live view field for
  field.

### 11. Terrain noise in site checks

- **Problem.** `sampleRect` walks a rectangle column by column, so each z row is revisited
  once per column. `bankDistance` → `riverX(z)` → `noiseLine` is recomputed at every sample.
- **Change.** A small per-rectangle memo of `riverX` by row, exact for a pure function.
- **Gain.** ≤ 1 to 2 %, more in young towns.
- **Effort.** Small.
- **Risk.** Low.

### Not recommended

- **Typed-array or struct-of-arrays rewrites of buildings, households or people.** The costs
  above come from how often whole collections are walked, not from their layout. People are
  not stepped at all in these headless runs.
- **Reassociating the student's arithmetic** (Float64 accumulators, unrolled sums in a
  different order, WASM SIMD). Answers move in the last bits, and towns diverge. This is
  acceptable only as a deliberate new student version that passes the gates again.
- **Double-buffering the 147k-cell arrays in place.** Consumers hold earlier generations
  and compare against them.

## 4. Keeping towns bit-identical

1. **`scripts/town-hash.js`** prints the `serialize()` hash every ten game years.
   - Run it in the changed checkout and in a `git archive` copy of the base (the script's
     header has the commands). Do this for seeds 66, 7 and 12 over 150 years.
   - The decade checkpoints show when a change breaks identity.
   - Baselines at `914f6aa` with the v2 student: `be4164aee983efbb` (seed 66), `3e7db767fdc37e89`
     (seed 7), `be0636aa7e7764e0` (seed 12).
2. **Student changes** need the replay check as well: the same recorded questions, every
   probability compared with `Object.is`. A town hash catches only the divergences that
   change a choice.
3. **Grid and footprint changes** run in shadow mode behind a dev flag for a full run before
   the old path is deleted: build both ways and compare the arrays at every rebuild.
4. **Existing checks:**
   - `tests/sim-worker.test.js`: worker against inline, by `serialize` hash;
   - `tests/render-mirror.test.js`;
   - `scripts/benchmark-city.js`: hash of the city fixture.

## 5. Suggested order

1. Items 1 (done), 3, 4, 5 and 6 are small and touch only the sim. Together they are about
   −13 % of a 150-year run.
2. Items 2 and 7 come once the student file is free. Together they are about −15 %, on top
   of the answer cache.
3. Item 8 comes last, if the road share still matters after that.
