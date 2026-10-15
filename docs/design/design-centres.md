# Many centres: a region, not just a town

Owner request: "There should be a way for multiple city centres to develop, or multiple downtowns. Think different areas of a region, both densely populated; they can develop into regional powers all by themselves."

Goal: the valley can grow one dominant city, or a polycentric region of rival towns, or anything in between. That outcome is a major source of divergence, decided by geography, early choices and actor decisions. It is not scripted.

## 1. Centres are first-class (sim-world owns `src/sim/centres.js`)

`state.centres[] = {id, name, x, z, founded (year), kind: 'hamlet'|'village'|'town'|'borough'|'city', character (archetype id, per centre), pop, jobs, density, coreValue, marketId, hallId, autonomy: 0..1, rank, parentId|null, mergedInto|null}`

- The starting hamlet is centre 1 (the "seat").
- Every household, lot and building gets `centreId`, its nearest centre by travel cost (not straight-line), recomputed yearly. Districts nest inside centres.
- **Land value is multi-peak.** Each centre adds a core bump scaled by its pop, jobs and market (`coreValue`), falling off with travel cost. Density targets and building height follow the local peak, so each centre grows its own downtown with taller buildings at its core.

## 2. How a new centre is born (composed conditions, no script)

Each year, test seed points: crossroads of high wear, bridge heads and fords, mill sites, quays, discoveries (quarry, coal, spring), the far bank, and the end of a long road. Each point gets a score:

```
seed = w1·(travel cost to the nearest centre's core, ramp 60..140 units)
     + w2·(households already within 12 cells whose commute is long)
     + w3·(a local draw: ford/bridge head, mill, quay, mine, crossroads traffic)
     + w4·(cheap land vs the seat's high land value)
     − w5·(slope/flood risk)
```

Above a threshold, sustained for 2 years, a new centre is founded. A chronicle line marks it ("Folk at the mill ford now call their lanes Millbridge."). Its first market stall and a meeting place follow soon after. Cap: in practice at most ~1 new centre per 10 years, limited by the score rather than a hard number.

## 3. How centres grow and compete

- **Settlement choice** (`where_to_settle`, sim-governance kind): incoming households choose among up to 4 candidate centres. Each centre is a distinct state snapshot (rent band, jobs band, character, prestige, kin present, distance to work); this is a natural fit for /v1/decisions/batch. A household already living in one centre may also move to another (`household_move` gains `move_to_centre`).
- **Enterprises** choose a centre by demand and labour (enterprise_found includes a centre choice).
- **Agglomeration:** jobs and markets attract more of the same, so leaders can pull ahead. **Congestion and rents** push growth outward, so second centres can catch up. These loops decide whether the region becomes monocentric or polycentric.
- **Inter-centre traffic:** commuting between centres wears a main road. High traffic → the Planning Office proposes a turnpike or avenue; on opposite banks → a bridge between them. Over time a corridor forms and the towns may grow together (conurbation).
- **Rank:** `rank` by pop × jobs × prestige. If a second centre overtakes the seat, a chronicle moment fires and the seat's council faces a "Where should the town hall be?" card later.

## 4. Governance: regional power (sim-governance)

- **Ward councils:** when a centre reaches ~600 people, or ~300 with a strong character, it petitions for its own council (a new institution kind `ward:<centreId>`, named "<Centre> Ward Council", with its own docket asks for local works, a market charter, a local school, its own rates). Refuse or accept as with other bodies.
- **Autonomy** (0..1) grows with its own council, its own market charter, its own tax take, and a distinct character from the seat. High autonomy means its body drafts more, it keeps more of its own taxes, and its residents' stance on regional rules leans local.
- **Rivalry cards:** "Which centre gets the new bridge/hospital/college?", "Millbridge wants to keep its own tolls", "Rates are unfair to the east bank". These are debate cards with factions per centre (slices gain a `centre` dimension, so centre-vs-centre tension shows up naturally through slice disagreement).
- **End-game choice (era ≥ 3), as composed conditions:** when two centres touch (their built areas within ~10 cells) or their councils clash often, offer **Merge** (one city, councils unify, a single tax rate; a big prestige and efficiency gain, but the smaller centre's autonomy is lost and it grumbles), **Federate** (a regional council over the ward councils; they keep their autonomy, with some coordination cost), or **Stay apart** (rivalry continues; their tension can shape later events). Different choices make very different end states.
- **Archetype per centre:** each centre computes its own character from its local mix (mill-heavy, port, market, scholar…). The town archetype becomes the region's dominant one, or "a region of many towns" when centres differ strongly. The end-of-chronicle summary describes each major centre.

## 5. Region size

The town area grows to a region: the buildable/road grid expands to ~768 × 768 units (384² cells at 2 units), with the mountain ring beyond ~±400. If performance allows, sim-world may make the grid grow with need (chunked). The renderer's terrain chunks already stream. Keep navigation cheap: inter-centre trips use a coarse road graph (hierarchical: a local grid near the endpoints, a centre-to-centre road graph between them).

## 6. Rendering (artisan-render)

- Each centre's core reads as a downtown: taller buildings, a market square or hall, denser roofs. These fall out of the multi-peak density, but check them visually.
- Floating name labels for centres at mid and far zoom (sized by rank), fading near the ground.
- Corridors between centres read as main roads, with avenues and trees when upgraded.

## 7. UI (artisan-ui)

- A **Places** view (unlocks when a second centre exists): a list of centres with name, kind, pop, character, autonomy and a sparkline, plus "Go there" (world.focus). The top bar shows region totals, and a centre chip shows where the camera is.
- Ward-council tabs appear like other bodies. Rivalry and merge cards use the debate strip with per-centre factions.
- The chronicle groups entries by centre when helpful.

## 8. Decision-model fit

- `where_to_settle` with up to 4 centre snapshots per question group goes through /batch with distinct states (cache-friendly: centre snapshots are banded and change slowly).
- A `centre` slice dimension for population kinds, with JS divergence across centres feeding `I.tension` and rivalry cards.

## 9. Acceptance

- Headless, 10 seeds × 3 styles to year 120: at least 40% of runs grow ≥ 2 centres above 800 people; some runs stay monocentric; at least one run per 10 shows a second centre overtaking the seat or a merge.
- Each centre has its own visible core in the renders.
- Tests: centre founding needs sustained conditions; centreId follows travel cost; ward petitions fire on thresholds; merge, federate and stay-apart each change state as designed; money is conserved.
