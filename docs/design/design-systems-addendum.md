# Hearthvale systems spec — addendum to §5 (decisions)

Note: design-systems.md §5 was already rewritten with these points before the freeze (§5.2 snapshots, §5.3 slicing/pooling/refinement, §5.4 kinds, §5.5 budget; plus `["torn", ...]` in §1.2, `I.tension`, `state.slices`, `state.disagreement`, `snapshots.js`, `pooling.js`). This file is the short reference. Bus-level mechanics (request shapes, cache, batch) live in contract.md.

## A. Share modes

- **town-sliced** — one TownSnapshot (bands only, byte-stable within a year except `season` and `recent` tags), one question per slice value.
- **district-sliced** — one DistrictSnapshot per district (Town + district character/rent/roads/crowding/river/kin bands), one question per slice value per district.
- **proposal-grouped** — one ProposalSnapshot (Town + proposal summary, cost band, helps/hurts), one question per faction.
- **grouped-per-actor** — shared Town or District snapshot, one question per actor with the actor's exact numbers in the short part.
- **individual** — own `state` with exact values (institution ledger, household savings vs cost). Few per year.

Rule: a snapshot many questions share holds bands only; a snapshot asked once may hold exact values.

## B. Kinds: share mode and slice dimensions (weights)

| # | kind | mode | slices (w) / grouping | cadence | yr budget @3k pop |
|---|---|---|---|---|---|
| 1 | resident-routine | district-sliced | district 0.5 × lifeStage 0.4; local: energy/fullness/social | 1 mo (visible only) | 180 |
| 2 | household-stay-move | district-sliced | district 0.4, trade 0.3, wealth 0.3, newcomer 0.3; local: savings vs rent (exact), kin left | 12 | 18 |
| 3 | choose-trade | town-sliced | district 0.3, parents' trade 0.5, wealth 0.3; local: literacy | 12 | 16 |
| 4 | react-to-policy | proposal-grouped + sliced | trade 0.5, wealth 0.3, district 0.3 | per adoption | 32 |
| 5 | faction-stance | proposal-grouped | one question per faction | per draft | 32 |
| 6 | institution-form-support | proposal-grouped | one per faction | per petition | 8 |
| 7 | petition | town-sliced | faction (8) + one per torn intersection | 6 | 16+ |
| 8 | where-to-settle | town (extended with candidate districts) | one per migrant type | per wave | 3 |
| 9 | festival-participation | district-sliced | district 0.4, faithBand 0.6 | per festival | 22 |
| 10 | crime-charity | district-sliced | wealth 0.5, district 0.3, newcomer 0.3 | 12 | 10 |
| 11 | event-response | district-sliced, highStakes | district 0.4, wealth 0.3, faithBand 0.3 | per event | 17 |
| 12 | strike-vote | proposal-grouped + sliced, highStakes | district 0.5, wealth 0.5 (labour only) | per call | 4 |
| 13 | newcomer-integrate | district-sliced | district 0.5, trade 0.5 (newcomers) | 12 | 13 |
| 14 | enterprise-plan | grouped-per-actor (Town) | exact cash, profit, jobs per enterprise | 12 | 120 |
| 15 | enterprise-found | grouped-per-actor (Town) | exact savings; ≤ 20 sampled | 24 | 10 |
| 16 | enterprise-type-for-site | grouped-per-actor (Town) | as 15 | on demand | 10 |
| 17 | choose-site | grouped-per-actor (District) | 4 pre-scored candidates as bands | on demand | 60 |
| 18 | migration-wave | town (single) | — | 12 | 1 |
| 19 | merchant-speculate | town-sliced | district (merchants only) | 12, era ≥ 4 | 5 |
| 20 | institution-draft | individual | body's exact ledger + metrics + last rulings | 6 | 16 |
| 21 | institution-negotiate | individual | as 20 + counter-offer | on demand | 3 |
| 22 | household-home | individual (≤ 40) + trade×wealth sliced fallback | exact savings vs tier cost | 12 | 64 |
| 23 | take-loan | individual | exact cash, monthly cost, debt | 24 | 20 |

Total ≈ 770/yr; refinement (C) adds ~15% → ≈ 900/yr at 3,000 pop, ≈ 1,300/yr at 10,000. Budget `B = 450 × 60 / speed` per sim-year. Drop order when over budget: 1, 9, 10 (reuse last distribution); never drop 5, 20, 21.

## C. Pooling and refinement

- Pool = weighted **average** of slice answers (`p(a|x) = Σ w_i p_i(a) / Σ w_i`), then mask impossible options, then multiply by `exp(λ·f)` for declared local hard facts, renormalise, sample with `rng(state)`. Never more confident than the most confident slice.
- Per slice-combination key `k`: `D_k` = mean pairwise Jensen–Shannon divergence (base 2) of its input slices; `n_k` = people in it.
  - `D_k ≥ 0.25, n_k ≥ 12` → one intersection question for `k` (replaces the pooled answer). Cap 24/sweep, by `D_k·n_k`.
  - `D_k ≥ 0.25, n_k < 12`, or kind is `highStakes` → ask individuals in `k`. Cap 40/sweep.
- Write `state.disagreement[kind][key] = {D, n, year}`; indicator `I.tension = Σ D_k·n_k / pop` over kinds 2, 4, 7, 10.

## D. Disagreement as an emergence condition

DSL: `["torn", kind, dim1, dim2, minD, minN]` — true when some `dim1 × dim2` intersection for `kind` has `D ≥ minD` and `n ≥ minN`; plus `["gte", "I.tension", x]`.

- **Faction split**: a trade slice torn against district or wealth (`D ≥ 0.3, n ≥ 30`) on kind 4 for 2 consecutive adoptions splits (e.g. farmers → hill farmers / riverside farmers), each with its own mood and debate row; merge back after 10 years below `D 0.15`.
- **Petitions**: kind 7 asks an extra question for each torn intersection; grievance = category of the policy that split them.
- **Institutions**: `union` soft term `["torn", 4, "trade", "wealth", 0.3, 40]` (w 2); `watch` `["gte", "I.tension", 0.25]`; `parish`/`arts-society` small bonus when `I.tension ≤ 0.15`.
- **Events**: `schism` requires `["torn", 9, "district", "faithBand", 0.3, 30]`; `strike` chance ×1.5 if `["torn", 4, "trade", "district", 0.25, 30]`; `riot` chance ×(1 + I.tension).
- **UI**: Tensions dashboard lists the top five torn intersections in plain words ("Poor families by the quays are torn. Their trade says stay. Their street says go."); a faction shows `split` on the debate strip when its own intersections disagree.
