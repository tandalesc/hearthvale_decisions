# Hearthvale — Systems & Policy Design Spec

Target: plain JS, deterministic (one seeded LCG in state, every random draw goes through `rng(state)`), fully JSON-serializable state, thousands of residents simulated as overlapping population slices with a few hundred "visible" individuals.

## 0. Time base (replaces 6 s/day)

- `tick` = 100 ms of sim time at 1×. **1 month = 50 ticks (5 s)**, **1 year = 12 months = 600 ticks (60 s)**. 150 years = 90,000 ticks ≈ 2.5 h at 1×.
- Cadences in this doc are in months unless stated. `state.time = {tick, month (0-11), year (0-149)}`. Day/night is purely visual: one day-night cycle per month.
- Decision budget per sim-year: `B = 450 × 60 / speed` questions (27,000 at 1×, 3,375 at 8×). Every cadence below is multiplied by `speed` when `speed > 1` (slices are asked less often, individuals are sampled from the last pooled answer).

---

## 1. Core model: composable conditions

### 1.1 Traits, pressures, indicators, tags

**Traits** `state.traits` — bipolar, range [-1, 1], slow, with momentum. These are the town's "character".

| key | −1 pole | +1 pole |
|---|---|---|
| `industry` | agrarian | industrial |
| `market` | communal / cooperative | market / private |
| `innovation` | tradition | innovation |
| `authority` | consensus / local | central / planned |

**Pressures** `state.pressures` — unipolar [0, 1], accumulate from decisions and actor behaviour, decay toward a baseline.

| key | meaning | baseline | decay/month |
|---|---|---|---|
| `riverTrade` | share of goods moving by river, ports, ferries | 0.05 | 0.004 |
| `faith` | religious/ritual life | 0.2 | 0.002 |
| `learning` | literacy, schools, printing | 0.05 | 0.002 |
| `ecology` | land and water health (1 = pristine) | 0.9 | +0.003 toward baseline (recovers) |
| `health` | sanitation, medicine, nutrition | 0.4 | 0.003 |
| `unrest` | grievance stock | 0.0 | 0.02 |
| `prestige` | fame, pilgrims, visitors, grand buildings | 0.0 | 0.005 |

**Indicators** `state.indicators` — derived every month from the world; recomputed, not accumulated (cached for the UI).

`pop`, `households`, `tension` (slice disagreement, §5.3), `density` (homes per 100 cells of built lots, 0–1 normalised at 60/100), `inequality` (Gini over household wealth), `housingPressure` (households waiting / households, 0–1), `foodBalance` (months of food on hand, clamp 0–24), `jobBalance` (open jobs − jobseekers, as fraction of workforce, −1..1), `treasuryYears` (treasury / yearly net spend, clamp 0–10), `avgWealth`, `traffic` (sum of wear added this month / pop), `literacy` (0–1), `avgHomeTier` (1–5).

**History tags** `state.tags: {[name]: year}` — e.g. `flood`, `mill-built`, `guild:millers`, `refused:river-authority`, `plague`, `fair-held`, `bridge:1`. A tag stores the *last* year it was set; `state.tagCounts[name]` stores how many times.

### 1.2 Condition DSL

Conditions are JSON s-expressions evaluated by `evalCond(expr, ctx)`; `ctx` exposes `T.*`, `P.*`, `I.*`, `tags`, `year`, `era`, `institutions`, `policies`, `rng`. Ops:

```
["gte", "P.riverTrade", 0.35]      ["lte", "I.foodBalance", 2]
["between", "T.industry", 0.2, 0.7]
["tag", "mill-built"]              // ever set
["tag", "flood", 10]               // set within the last 10 years
["notag", "refused:river-authority", 20]
["has", "institution", "agri-council"]  ["has", "policy", "tithe", 2]  // level >= 2
["era", 3]                         // era index >= 3
["and", ...] ["or", ...] ["not", x]
["soft", 0.6, [w1, pred1], [w2, pred2], ...]   // Σ w_i·sat_i / Σ w_i >= 0.6
["ramp", "I.housingPressure", 0.3, 0.8]        // returns 0..1 linear (for soft)
["torn", 4, "trade", "district", 0.3, 30]      // a slice intersection disagrees (§5.3)
```

`soft` is the workhorse. Hard predicates are satisfied 0/1; `ramp` returns a fraction. Every unlockable thing (proposal template, institution, building variant, event, era) has `when:` (a cond) and `chance:` (per-month probability when `when` is true, default 1). This is the whole rule engine; nothing else may branch on game state directly.

### 1.3 Pressure deltas

Every source of change emits `delta(key, amount, source)` into `state.deltaLog` for the month; `applyDeltas()` sums them at month end. Sources: passed policies (per month while active), institution activity, actor decisions (pooled slice answers × slice size × per-choice delta), events, buildings (per building per month, e.g. a mill: `industry +0.0015, ecology −0.001`).

Trait update with momentum and lock-in:

```
v[k] = v[k]*0.8 + Σdeltas[k]           // velocity, state.traitVel
lock = min(0.75, 0.6*T[k]^2 + 0.05*anchors[k])   // anchors = live institutions on this axis
T[k] += v[k] * (sign(v[k]) == sign(T[k]) ? 1 + 0.5*lock : 1 - lock)
T[k] = clamp(T[k], -1, 1)
```

Reinforcing movement is amplified (snowball); counter-movement is damped (path dependence). A town at `industry = 0.7` with two industrial bodies needs ~3× the policy effort to move back that a fresh town needs.

**Reversal cost**: a policy whose pressure delta opposes the sign of a trait with |T| > 0.4 has upkeep × `(1 + 2|T|)` and generates `unrest +0.01/month` while active ("the town resists"). The UI shows this as "This goes against the grain of the town. It will cost more and people will grumble."

**Pressures** update plainly: `P[k] = clamp(P[k] + Σdeltas − decay·(P[k] − baseline))`.

### 1.4 Trajectory archetype

Computed yearly, stored as `state.archetype` (string) with a score; drives era flavour and building style. First match wins:

| archetype | condition |
|---|---|
| `cathedral` | `P.faith ≥ 0.6 and P.prestige ≥ 0.3` |
| `mill` | `T.industry ≥ 0.45` |
| `port` | `P.riverTrade ≥ 0.55` |
| `garden` | `P.ecology ≥ 0.7 and T.innovation ≥ 0.2 and I.pop ≥ 400` |
| `commune` | `T.market ≤ −0.35 and T.authority ≤ 0` |
| `exchange` | `T.market ≥ 0.4` |
| `scholar` | `P.learning ≥ 0.6` |
| `market-town` | default |

Archetype changes are rare by construction (traits are locked in); when one changes, emit a chronicle entry: "Hearthvale is becoming a mill town."

---

## 2. Eras

Six eras. Entry is condition-gated with a time floor and a time ceiling (so a stalled town still moves on, visibly weaker).

| # | name | floor yr | entry condition (any of, plus floor) | ceiling yr |
|---|---|---|---|---|
| 0 | Hamlet | 0 | start | — |
| 1 | Village | 6 | `I.pop ≥ 120 and institutions ≥ 1` | 15 |
| 2 | Town | 25 | `I.pop ≥ 450 and institutions ≥ 3 and roads tier≥3 ≥ 40 cells` | 45 |
| 3 | Borough | 55 | `I.pop ≥ 1200 and I.avgHomeTier ≥ 2.2 and (P.riverTrade ≥ 0.4 or T.industry ≥ 0.3 or P.prestige ≥ 0.4)` | 80 |
| 4 | City | 90 | `I.pop ≥ 3000 and institutions ≥ 6 and policies active ≥ 10` | 115 |
| 5 | Metropolis | 125 | `I.pop ≥ 6000 and I.avgHomeTier ≥ 3.5 and P.health ≥ 0.5` | 140 |

Entering via the ceiling sets tag `era-late:<n>`; the chronicle says "The town moves into a new age, but it is behind its neighbours."

What changes per era (`ERA[n]` table consumed by other modules):

| | 0 Hamlet | 1 Village | 2 Town | 3 Borough | 4 City | 5 Metropolis |
|---|---|---|---|---|---|---|
| max home tier | 1 hut/cottage | 2 | 3 townhouse | 4 terrace/tenement | 5 apartments | 5 + tower variant |
| max storeys | 1 | 2 | 3 | 4 | 6 | 9 |
| materials | timber, thatch | timber, tile | brick, tile | brick, stone, slate | stone, iron, glass | concrete, steel, glass |
| max road tier (organic / planned) | 2 / 2 | 2 / 3 | 3 / 4 | 3 / 4 | 3 / 5 | 3 / 5 |
| new actor types | households, farms | enterprises, chapel | guilds, merchants, school | union, health board, planners | press, factories, exchange | utilities, transit, parks dept |
| new question kinds | routine, move, build | job, petition, react | expand, faction, site | strike, migrate-wave, charity | automate, speculate | (all) |
| UI surfaces | Chronicle, 1 docket card | Policies book (3 cats), People | Institutions panel, Overlays | Debates view, Delegation | Budget, Tensions dashboard | End-of-chronicle preview |
| decision cards/yr target | 1–2 | 2–3 | 3 | 3–4 (with delegation) | 4 | 4 |

### 2.1 Era flavour by archetype

Flavour = `(era, archetype) → style pack`. The renderer only needs the style pack id and per-building hooks (§7.5). Examples at era 3–4:

- **mill**: terraces in rows along the mill lane, chimneys, canal cut, soot tint on walls (`wearTint 0.3`), a Union Hall; events lean to strikes and booms.
- **market-town / exchange**: a wide market square (planned avenue tier 5 around it), arcaded shopfronts (`frontage: 'arcade'`), Exchange hall with dome, coaching inns at road entries.
- **garden**: detached and semi-detached homes with gardens (lot padding 2 cells), tree-lined avenues (planted trees instanced along tier ≥ 4 roads), parks every 40 cells by Planning Office template.
- **cathedral**: chapel upgrades to church to cathedral (3 tiers, height 12 → 22 → 40), pilgrim inns, cloister school, festivals every year.
- **port**: quays (planted stone riverbank), warehouses (tall windowless gables), two or three bridges, Customs House.
- **commune**: courtyard housing (shared lots of 4–6 homes around a common), granaries, a Moot Hall that stays the central building, few tier-5 buildings.
- **scholar**: college quads, printing houses, bookshops along one street, lamps on roads earlier (era 3).

---

## 3. Institutions

An institution is `{id, kind, foundedYear, status: 'petitioning'|'active'|'waning'|'dissolved', budgetShare (0–0.25 of yearly tax), power (0–1), patience (0–1), metrics: {...}, lastProposalMonth, delegated: bool}`.

Rules common to all:
- **Emergence**: when `when` holds and `chance` fires (per month), the body **petitions** to form (a docket card: *Form* / *Not now* / *Refuse*). *Not now* retries after 3 years. *Refuse* sets `refused:<id>` tag, blocks for 15 years, `unrest +0.03`, and the supporters' faction weight shifts (§5). The Village Moot exists from the start.
- **Budget**: the player grants `budgetShare` on formation (options Small 3% / Standard 6% / Generous 10%); bodies may petition for more. Budget caps the cost of proposals they can self-fund when delegated.
- **Power**: `power = 0.3 + 0.4·(accepted/(accepted+refused+1)) + 0.3·supportShare` (share of the population in its faction). Power ≥ 0.7 lets it issue *demands* (cards with no "refuse", only "yes / negotiate at a cost").
- **Patience** drops 0.15 per refusal, 0.05 per card that expires unread, recovers 0.1/year. At 0: the body goes `waning` (stops drafting, metrics freeze). Waning for 5 years → `dissolved` (tag `dissolved:<id>`), or the player can dissolve any body at any time (card: costs `unrest +0.05` if power ≥ 0.5).
- **Conflicts**: pairwise `rivalry` table; when two rival bodies both have live proposals, they are merged into one **debate card** (§4.3) with both positions.
- **Drafting**: each active body asks the decision model one `institution-draft` question (§5, kind 20) every 6 months (×speed) choosing among its templates whose `when` holds; the chosen template becomes a docket card. Delegated bodies self-resolve their own cards within budget and only report.

Catalogue (metrics shown as the body's small dashboard):

| id | name | emerges when | tracks | drafts | rivals | declines when |
|---|---|---|---|---|---|---|
| `moot` | Village Moot → Town Council | start | treasury, pop, happiness | general taxes, loans, festivals, forming other bodies | — | never (renames per era) |
| `agri-council` | Agricultural Council | `soft 0.6: [2, farms≥6], [2, has policy in land/food ≥2], [1, T.industry ≤ 0.1], [1, I.foodBalance ≤ 4]` | farm count, yield/farm, food months, farm income | granary, drainage, common grazing, seed exchange, tithe barn, enclosure (pulls market+) | `trades-guild`, `planning` (land) | farms < 4 or `T.industry ≥ 0.6` |
| `trades-guild` | Craft/Trades Guild | `enterprises ≥ 5 and T.market ≥ −0.2` | enterprise count, goods output, apprentices | guild hall, apprenticeship rule, price floor (market−), quality mark (prestige+), licence limits | `exchange`, `union` | enterprises < 3 |
| `exchange` | Merchant Exchange | `T.market ≥ 0.3 and (P.riverTrade ≥ 0.3 or I.pop ≥ 800)` | trade volume, prices, merchant wealth | exchange hall, market charter, toll cuts, warehouses, speculation rules | `trades-guild`, `union`, `commune bodies` | `T.market ≤ 0` |
| `river-authority` | River Authority | `P.riverTrade ≥ 0.25 or tag flood within 8` | crossing demand, flood risk, quay length, ferry traffic | bridge, quay, embankment, dredging, ferry licence, water mill rights | `agri-council` (water), `health-board` (effluent) | riverTrade < 0.1 for 10 yrs |
| `school-board` | School Board | `I.pop ≥ 300 and (P.learning ≥ 0.15 or T.innovation ≥ 0.2)` | literacy, pupils, teachers, school count | school, free schooling (tax), library, printing licence, scholarships | `parish` (who teaches), `union` (child labour) | literacy stalls < 0.2 for 15 yrs |
| `parish` | Chapel → Church → Cathedral Chapter | `P.faith ≥ 0.3` | attendance, tithe, feast days, alms | chapel upgrade, feast day, alms house, sabbath rule, tithe level | `school-board`, `exchange` (sabbath trading) | `P.faith < 0.15` for 10 yrs |
| `health-board` | Health Board | `I.pop ≥ 600 and (P.health ≤ 0.35 or tag plague within 10)` | sickness rate, wells, sewers, infirmary beds | wells, sewer lines, infirmary, quarantine rule, slaughterhouse ban, smoke limits | `trades-guild`/mills (smoke), `exchange` (quarantine) | health ≥ 0.75 and no events 15 yrs (becomes a department: still active, drafts rarely) |
| `planning` | Planning Office | `I.traffic ≥ 0.4 and era ≥ 2, or T.authority ≥ 0.3` | road tiers, crossing demand, lot vacancy, land value spread | pave route, widen, bridge, ring road, square, zoning (density caps/floors), park reserve | `agri-council`, `commune` (private commons), `exchange` (zoning) | `T.authority ≤ −0.4` |
| `union` | Workers' Union | `T.industry ≥ 0.3 and I.inequality ≥ 0.4 and enterprises with ≥ 20 jobs ≥ 2` | wages, hours, strikes, accidents | wage floor, hours cap, sick pay, union hall, strike (event) | `exchange`, `trades-guild` owners | inequality < 0.25 for 10 yrs |
| `watch` | Town Watch | `P.unrest ≥ 0.3 or I.pop ≥ 1000` | crime rate, patrols, lamps | watch house, lamps, curfew (authority+, unrest− short, −happiness), licensing | `union` (strikes), `parish` (festivals) | unrest < 0.1 for 10 yrs |
| `arts-society` | Festival & Arts Society | `P.prestige ≥ 0.2 and I.avgWealth ≥ 150` | festivals, visitors, theatre seats | fair, theatre, bandstand, monument, carnival week | `parish` (profane), `watch` | avgWealth falls below 100 |

Each body also carries `axis` (its trait anchor, used in lock-in): agri-council → industry −, trades-guild → market −0.5/innovation −, exchange → market +, planning → authority +, union → market −, parish → innovation −, school-board → innovation +, arts → prestige.

---

## 4. Policies

`state.policies: {[policyId]: {level, since (year), by (institution id | 'player')}}`. Levels 0–3 (0 = not in force). Each policy has `category, levels[], upkeepPerLevel (per year, as % of tax income or flat), deltas (per month per level), weights (actor-option weight modifiers, §5), requires (cond), tension (list of policy ids it pulls against)`.

Upkeep model: `yearlyUpkeep = Σ upkeepPerLevel[level]`; policies cannot exceed `treasuryYears ≥ 0.5` on adoption.

Catalogue (level 1 → 3 effects; weights are multipliers on named question-option scores):

**Land** — `commons` (common grazing: market −0.004/−0.012; weight `build.home ×1.1`, `enterprise.expand ×0.9`), `enclosure` (market +, inequality via wealth transfer to top 20% households 1%/yr; farms yield +10%/+30%; tension: `commons`), `zoning` (density floor/cap set by Planning; authority +0.003; weight `site.*` via density target), `park-reserve` (reserve lots: ecology +0.004, land value +; costs lots).

**Labour** — `apprenticeship` (innovation −0.002; goods quality +; weight `job.craft ×1.3`), `wage-floor` (wages +8/+16/+25%; enterprise expand ×0.8; inequality −0.01/yr; tension `free-trade`), `hours-cap` (health +0.003; output −5%/−12%; union support), `child-labour-ban` (learning +0.003; farm/mill output −4%; requires school-board).

**Trade** — `market-charter` (market +0.004; trade volume +15%; needs 1 market), `tolls` (treasury +; riverTrade −0.003; tension `free-trade`), `free-trade` (market +0.006; goods price −; riverTrade +0.004; tension `tolls`, `wage-floor`, `price-floor`), `price-floor` (guild: market −0.003; enterprise close ×0.7).

**Tax** — `property-tax` (slider 4–20%: treasury; weight `move.leave` ×(1+0.03·(rate−10))), `income-tax` (slider 0–25%), `tithe` (faith +0.004 per level; treasury −; tension `free-schooling`), `land-value-tax` (replaces property tax at Planning request: inequality −; density +).

**Food** — `granary` (foodBalance buffer +3 months per level; famine event chance ×0.3), `grain-import` (treasury −; food +; riverTrade +0.002), `fast-days` (faith +, food consumption −6%), `market-gardens` (ecology +0.002, food +5%, needs garden archetype or park-reserve).

**Health** — `wells`, `sewers` (health +0.006/+0.012/+0.02; upkeep high; requires era ≥ 2), `infirmary` (plague mortality ×0.5), `smoke-limits` (ecology +0.004, industry −0.002; mill output −5%; tension `mill-rights`), `quarantine` (unrest +0.01 while plague; mortality ×0.6).

**Education** — `parish-school` (learning +0.002; faith +0.001), `free-schooling` (learning +0.006; treasury −; tension `tithe`, `child-labour`), `library` (learning +0.002, prestige +0.001), `press-licence` (innovation +0.004; unrest ±: increases `faction` activity 20%).

**Faith/Culture** — `feast-days` (faith +0.003, happiness +, output −2%), `sabbath-rule` (faith +0.004; trade −6%; tension `market-charter`), `festival-fund` (prestige +0.003, happiness +; arts), `monument` (one-off, prestige +0.1).

**Environment** — `riverbank-protect` (flood damage ×0.5; ecology +0.002), `woodland-reserve`, `mill-rights` (water mills allowed: industry +0.005, ecology −0.003), `clean-water-rule` (health +0.004; mills −3% output).

**Infrastructure** — `paving-fund` (planning auto-paves top wear segments yearly, budgeted), `lamps` (unrest −0.005, watch), `bridge-fund`, `drainage` (floods ×0.6, farms +8%).

**Civic rights** — `open-moot` (authority −0.004; proposals from residents' petitions appear 2× more; unrest −0.005), `guild-vote` (guild power +0.2), `curfew` (unrest −0.02 immediate, happiness −; authority +0.004), `charter-of-rights` (one-off, era ≥ 3: unrest −0.1, authority −0.1; locks `curfew` out).

### 4.1 Tensions and debate surface

`TENSIONS`: explicit pairs above plus the implicit rule: two active policies whose monthly deltas on the same trait have opposite signs with |sum| < 0.3·|either| are flagged "pulling against each other" (wasted upkeep). The Tensions dashboard (era ≥ 4) lists each live tension as a row: left policy, right policy, which factions back each, net effect, and a one-line "Nothing moves while both stand."

**Debate card**: when a proposal touches a tension or a rivalry, the card shows *For* and *Against* with the two or three factions (§5.1) with the largest stake, each faction's expected reaction (from the `faction-stance` question, kind 5, asked at draft time), and a probability bar: "Millers: likely to protest (62%)". Factions' answers are cached on the card so they are deterministic per card.

---

## 5. Actors and question kinds

### 5.1 Actor layers

- **Residents** (visible individuals, ≤ 600 rendered; the rest are counts inside households) — carry `householdId` and slice keys.
- **Households** `state.households[]` (~pop/4): wealth, homeId, rent, size, trade, lifeStage, district, loyalty to factions.
- **Slices** — overlapping population groups: `district`, `trade`, `wealthBand`, `lifeStage`, `householdType`, `faction`, `newcomer`. Population-scale questions are asked once per slice, not per person (§5.3).
- **Enterprises** `state.enterprises[]`: type, buildingId, jobs, cash, owner household. Always individual actors.
- **Factions** `state.factions[]`: derived yearly from slices (farmers, crafters, merchants, labourers, clergy, scholars, gentry, newcomers). A faction is the `trade`/`newcomer` slice plus a `mood`.
- **Institutions** (§3). An institution's constituency is a named slice (agri-council → `trade=farm`; union → `trade=labour ∧ wealthBand=0..1`; parish → `faction=clergy ∪ worshippers`).

### 5.2 Request shapes and the state cache

The service reads one structured `state` per request and answers many short questions against it; identical states are cached for an hour and cost ~35% less; exact repeats are near free. So the design rule is: **one snapshot, many questions; snapshots coarse and stable; actor detail in the short question part.** Target ≤ 150 distinct snapshots per hour of play (there are ~60 sim-years per hour at 1×, so about 2–3 new snapshots per year).

Three snapshot kinds, all built by `snapshots.js`, all keyed by a content hash so an unchanged snapshot is byte-identical:

```js
TownSnapshot = {
  era: 'town', season: 'spring', archetype: 'mill',
  food: 'low|ok|plenty', coin: 'debt|tight|ok|rich', wellbeing: 'poor|fair|good',
  jobs: 'scarce|balanced|plenty', homes: 'scarce|balanced|plenty',
  health: 'poor|fair|good', unrest: 'calm|uneasy|angry', faith: 'low|mid|high',
  taxStep: 0..4,                       // property tax in 4-point steps
  rules: ['commons','granary','tithe:2', ...],   // sorted active policy ids with level if >1
  recent: ['flood','fair'],            // tags set in the last 3 years, sorted, max 4
  bodies: ['moot','agri-council', ...] // sorted active institution ids
}
DistrictSnapshot = TownSnapshot + {
  district: { name, character: 'farms|mill|market|quays|garden|old-town|new-quarter|slum',
              rent: 'low|mid|high', roads: 'paths|tracks|roads|paved', crowding: 'loose|snug|packed',
              nearRiver: bool, kinPresence: 'few|some|many' } }
ProposalSnapshot = TownSnapshot + { proposal: { id, from, category, summary: 'one short sentence', costBand, helps: ['farm','merchant'], hurts: ['labour'] } }
```

Bands are tertiles of the town's own distribution, recomputed yearly (not monthly) so snapshots change at most once a year except for `season` and `recent`. Snapshot churn per year: Town ≈ 4 (seasons) × ~1 (slow fields); District ≈ districts × 1–2; Proposal ≈ cards drafted (~4). Comfortable.

Per-question part: `instructions` ≤ 40 words, mostly the actor's own bands or exact numbers; `criteria` = the kind's fixed option list (identical strings every time, so the model sees stable labels).

Request routing by `scheduler.js`:
- All questions sharing one snapshot go in one `POST /v1/decisions` (no hard cap; keep ≤ 512 per request so a 150 ms batch stays predictable).
- Questions for different snapshots due in the same tick go in one `POST /v1/decisions/batch` (≤ 64 requests).
- Individual-state questions (§5.4) each form their own `{state, questions}` item; they are the expensive ones, so they are rate-limited first.

### 5.3 Population slicing and pooling

Slice dimensions and typical counts for a 3,000-pop town:

| dimension | values | count |
|---|---|---|
| `district` | per district | 3–6 |
| `trade` | farm, craft, trade, labour, clerical, clergy, gentry, none | 8 |
| `wealthBand` | 0 poor, 1 middling, 2 wealthy | 3 |
| `lifeStage` | young, family, elder | 3 |
| `householdType` | single, couple, family-with-children, kin-group | 4 |
| `faction` | 8 | 8 |
| `newcomer` | yes (≤ 10 yrs), no | 2 |

A population-scale kind declares `slices: [dim, ...]`. One question per slice value per sweep, each against the relevant snapshot (district-sliced questions use the DistrictSnapshot; others the TownSnapshot). Questions per sweep = Σ slice counts (e.g. district 5 + trade 8 + wealth 3 = 16), never per person.

**Pooling** (`pooling.js`) is a weighted **average** (linear opinion pool), never a product. For a person or household `x` with option set `A`:

```
p(a|x) = mask_x(a) · Σ_i w_i · p_i(a) / Σ_i w_i          // over the slices x belongs to
then local hard facts: p(a|x) ∝ p(a|x) · exp(λ_j · f_j(a, x)) for each declared f_j
renormalise over the unmasked options; sample with rng(state)
```

- `p_i` = the answer for slice `i` that `x` is in; `w_i` = the kind's weight for that dimension (declared per kind: district 0.4, trade 0.4, wealth 0.3, lifeStage 0.2, faction 0.3 by default).
- A joint distribution is never more confident than its most confident slice; averaging blurs where slices disagree. That blur is intended; it is where refinement happens.
- `mask_x` removes options the person cannot take (`−∞`), e.g. `rebuild-up` when `wealth < 0.6·cost`. `f_j` are the kind's local facts: `move.emigrate` gets `λ = −2` if `savings < 1 month rent`, `+1.5` if a kin household left last year.
- Pooled distributions are computed once per (slice-combination) key and cached for the sweep; thousands of residents reduce to a few hundred distinct keys.

**Refinement at disagreement edges.** For each (slice-combination) key `k` with `n_k` people, compute the Jensen–Shannon divergence `D_k` between the slice answers that feed it (pairwise mean, base-2, 0–1). The bus then:

1. `D_k ≥ 0.25 and n_k ≥ 12` → ask one **intersection question** for `k` (e.g. "farmers who are poor and live by the river"), against the DistrictSnapshot, with the intersection described in the short part. Its answer replaces the pooled one for that key (weight 1.0). Cap: 24 intersection questions per sweep, highest `D_k · n_k` first.
2. `D_k ≥ 0.25 and n_k < 12`, or the kind is marked `highStakes` (2 stay-move when `emigrate` is live, 12 strike-vote, 11 event-response during plague/fire) → ask the **individuals** in `k` (one question each, exact facts in the short part, same shared snapshot). Cap 40 per sweep.
3. Otherwise keep the pooled answer.

Budget effect: refinement adds at most 64 questions per sweep and typically 10–20, so the totals in §5.5 rise by ~15%.

**Disagreement as a game signal.** `pooling.js` writes `state.disagreement = { [kind]: { [key]: { D, n, year } } }` and the monthly indicator `I.tension = Σ_k D_k·n_k / pop` over the last sweep of kinds 2, 4, 7 and 10 (0–1, typically 0.05–0.3). Exposed to the condition DSL as `I.tension` and `["torn", kind, dim1, dim2, minD, minN]` (true when any intersection of `dim1 × dim2` for `kind` has `D ≥ minD` and `n ≥ minN`). Uses:

- **Factions split**: a `trade` slice whose intersections with `district` or `wealth` are torn (`D ≥ 0.3, n ≥ 30`) on kind 4 for 2 consecutive adoptions splits into two factions (e.g. `farmers` → `hill farmers` / `riverside farmers`), each with its own mood and stance row on debate cards. Factions merge back after 10 years below `D 0.15`.
- **Petitions**: kind 7 fires an extra `petition` question for any torn intersection (the group that is torn between its trade and its street is the one that organises). Its `top grievance` is the policy category of the kind-4 sweep that produced the disagreement.
- **Institution emergence**: `union` adds `["torn", 4, "trade", "wealth", 0.3, 40]` as a soft term (w 2); `watch` adds `["gte", "I.tension", 0.25]`; `arts-society` and `parish` get `["lte", "I.tension", 0.15]` as a small bonus (calm towns build culture).
- **Events**: `schism` requires `["torn", 9, "district", "faithBand", 0.3, 30]`; `strike` chance ×1.5 when `["torn", 4, "trade", "district", 0.25, 30]`; `riot` chance ×(1 + I.tension).
- **UI**: the Tensions dashboard (era ≥ 4) lists the top five torn intersections in plain words: "Poor families by the quays are torn. Their trade says stay. Their street says go." The debate strip shows a faction as `split` when its own intersections disagree, instead of a flat percentage.

### 5.4 Question kinds

Format: **id** — asker · **grouping** (`town-sliced` / `district-sliced` / `proposal-grouped` / `institution` / `individual`) · cadence (months, ×speed) · shared snapshot · per-question part · options → effect · budget (questions per sim-year at 1×, 3,000 pop, 5 districts, 120 enterprises, 8 factions, 8 institutions).

**Population-scale (sliced)**

1. **resident-routine** — visible residents · district-sliced × lifeStage (w: district 0.5, lifeStage 0.4) · every 1 month · DistrictSnapshot · "People who are {young/family/elder} here, {morning/evening}." Local terms: energy/fullness/social bands of the individual (λ 1.0 each toward rest/shop/leisure) · `work | rest | shop | leisure | worship | gather` → sets the visible person's task; `gather` only unmasked when a petition, protest or festival is live. 5×3×12 = 180/yr.
2. **household-stay-move** — households · district × trade × wealth × newcomer (w 0.4/0.3/0.3/0.3) · every 12 · DistrictSnapshot · "Households of {trade}, {wealthBand}, {newcomer?}." Local: `rent/savings` exact ratio → `emigrate` λ −2 if savings < rent; `move-within` masked if no vacant lot in town; `bring-kin` masked if homes scarce · `stay | move-within | emigrate | bring-kin` → `move-within` triggers kind 10 for that household; `emigrate` removes household; `bring-kin` +1–3 pop next year. (5+8+3+2) = 18/yr.
3. **choose-trade** — young adults · district × trade-of-parents × wealth (w 0.3/0.5/0.3) · every 12 · TownSnapshot (jobs field carries the signal; add `openJobs: {farm:'many', craft:'few', ...}` to the snapshot once a year) · "Young people from {trade} families, {wealth}." Local: literacy band of the household (`clerical` λ −3 if illiterate; `clergy` masked without parish) · `farm | craft | trade | labour | clerical | clergy | leave-town` → assigns trade, shifts slice sizes. 16/yr.
4. **react-to-policy** — residents · trade × wealth × district (w 0.5/0.3/0.3) · once per adoption/change · ProposalSnapshot (the adopted rule as `proposal`) · "People of {trade}, {wealth}." · `support | accept | grumble | protest | strike | leave` → mood ±0.2 per faction, unrest ±0.02 × share; `protest` ≥ 25% in any slice spawns a crowd with banners for 1 month; `strike` only unmasked for labour. 16 per adoption × ~2/yr = 32/yr. The per-slice result is what the debate strip shows.
5. **faction-stance** — factions · proposal-grouped: one ProposalSnapshot, 8 questions (one per faction) · at draft time · "The {faction}: mood {band}, size {band}." · `for | against | split | indifferent` → cached on the card. 8 × 4 cards = 32/yr.
6. **institution-form-support** — factions · proposal-grouped (the petition as proposal) · on petition · `back | oppose | indifferent`. 8 × 1 = 8/yr.
7. **petition** — factions · town-sliced by faction (8) · every 6 · TownSnapshot · "The {faction}: mood {band}, top grievance {enum: housing|food|wages|roads|flood|health|faith|schooling|tolls|crime}, their body {exists/none}." · `wait | petition-moot | petition-body | gather | leave` → `petition-*` creates a docket card; `gather` → crowd at the moot hall; `leave` → emigration bias. 16/yr.
8. **where-to-settle** — incoming migrant cohort · district-sliced inverted: one TownSnapshot extended with the 2–4 candidate districts' bands, 1 question per migrant type (poor-family, craftsman, merchant) · per wave · `D1 | D2 | D3 | D4 | pass-by` → distributes households. 3/yr.
9. **festival-participation** — residents · district × faith-band (w 0.4/0.6; faith band is a household field) · on festival events · DistrictSnapshot · `join | watch | ignore | protest` → crowd size, happiness, prestige. 15 × 1.5 = 22/yr.
10. **crime-charity** — residents · wealth × district × newcomer (w 0.5/0.3/0.3) · every 12 · DistrictSnapshot · "Households that are {wealth}, {newcomer?}; watch {present/absent}; alms {available/none}." · `honest | petty-theft | join-gang | seek-alms | give-alms` → crime rate, unrest; `give-alms` masked unless wealth 2. 10/yr.
11. **event-response** — affected residents · district × wealth × faith-band (w 0.4/0.3/0.3) · on flood/fire/plague/riot · DistrictSnapshot + `recent` carries the event tag · `help | flee | hoard | pray | blame-council` → crowd size, hoarding (food −), faith +, unrest +, Moot patience −. 11 × ~1.5 events = 17/yr.
12. **strike-vote** — labour households · district × wealth (w 0.5/0.5) · when the union calls · ProposalSnapshot (the strike call) · `strike | work | partial`. 8 × 0.5 = 4/yr.
13. **newcomer-integrate** — newcomer households · district × trade (w 0.5/0.5) · yearly · DistrictSnapshot · `assimilate | cluster | move-on` → clustering creates a quarter. 13/yr.

**Grouped but one question per actor (shared snapshot, cheap)**

14. **enterprise-plan** — enterprises · grouped under the TownSnapshot (all enterprises in one request); each question carries the enterprise's own exact facts · every 12 · "A {type} with {jobs} workers, cash {exact coin}, yearly profit {exact}, demand for its goods {band}, {labour available/short}, rules touching it: {wage-floor, smoke-limits}." · `hold | expand | automate | diversify | close` → expand: +jobs, +storey/annex (project); automate (era ≥ 3): jobs −30%, output +40%, industry +0.003, union mood −; diversify → kind 16; close → vacant lot. 120/yr. Stays per-enterprise because profit vs cash is exact and decides it; the shared snapshot keeps it cheap.
15. **enterprise-found** — wealthy households (wealthBand 2) without an enterprise · grouped under TownSnapshot, one question per candidate household (≤ 20/yr sampled) · every 24 · "Savings {exact}; short goods in town: {list}; river trade {band}." · `none | farm | workshop | shop | inn | mill | warehouse | school | chapel-donation` → creates enterprise + kind 17 site choice. 10/yr.
16. **enterprise-type-for-site** — variant of 15 for `diversify`. 10/yr.
17. **choose-site** — any builder · grouped under the DistrictSnapshot of the frontier district (so one request per district per sweep); each question lists its 4 pre-scored candidates (§7.1) as bands: access (road tier), land value band, same-type neighbours, pollution, river · on demand · `A | B | C | D | wait` → places lot. 60/yr. The model supplies taste, not geometry.
18. **migration-wave** — the "outside world" · one TownSnapshot question · every 12 · "Prestige {band}; last year {tags}; neighbours {quiet/troubled} (fixed slow sine)." · `none | trickle | wave | exodus-pull` → +1%, +4%, +10% pop or −3%. 1/yr.
19. **merchant-speculate** — merchant slice (wealth 2 ∩ trade) · one TownSnapshot question per district with merchants · every 12, era ≥ 4 · `invest-build | invest-trade | hoard | lend-to-town` → boom/bust pressure. 5/yr.

**Individual (own precise state; no sharing)**

20. **institution-draft** — each active body · `state` = the body's own snapshot: `{kind, year, budget: exact coin, spentThisYear, patience, power, metrics: {exact values from its dashboard}, lastRulings: ['accepted','refused','accepted'], rivalsLive: [...], town: TownSnapshot}` · every 6 · options = the 4–6 template ids whose `when` holds (+ `none`); each criteria label is the template title · → docket card. 8 bodies × 2 = 16/yr. Individual because it reacts to this year's exact ledger; 16/yr is trivial.
21. **institution-negotiate** — on a `negotiate` ruling · same body state + the player's counter-offer (exact) · `accept-half | insist | withdraw`. 3/yr.
22. **household-home** — households with `wealth ≥ 0.6·nextTierCost` · individual state `{savings, income, rent, homeTier, homeCondition, lotCanExtend, neighboursAvgTier, eraMaxTier, densityHere, town: TownSnapshot}` · every 12, sampled to ≤ 40/yr by priority (richest-vs-tier gap first); the rest reuse last year's slice-level distribution from a trade×wealth sweep (a 24-question sliced fallback) · `keep | repair | extend | rebuild-up | buy-second` → repair resets age; extend +1 storey; rebuild-up → tier +1 project paid by household; buy-second (gentry) → inequality +. 40 + 24 = 64/yr. Individual because exact savings vs cost is the decision.
23. **take-loan** — enterprises/households with cash below one month's costs · individual `{cash, monthlyCost, debt, rateBand}` · every 24 · `borrow-small | borrow-large | sell-up | hold`. 20/yr.

### 5.5 Budget

Total ≈ 770 questions/yr for the 3,000-pop town; ~55% share a Town or District snapshot, ~30% a Proposal/Town-grouped snapshot with per-actor detail, ~15% individual. At 450 q/s the budget per sim-year is `B = 450 × 60 / speed` = 27,000 at 1×, 3,375 at 8× — still 4× headroom at 8×. Scale check at 10,000 pop: slices do not grow (counts fixed), enterprises grow to ~400 (kind 14 → 400/yr), individual household-home stays capped at 40; total ≈ 1,100/yr. Over-budget rule unchanged: drop kinds 1, 9, 10 first and reuse the last distribution; the scheduler never drops 20, 21, 5 (player-facing).

Refinement (§5.3) adds ~15%, giving ≈ 900/yr at 3,000 pop and ≈ 1,300/yr at 10,000.

Snapshot churn: Town ~5/yr and District ~8/yr are the shared, heavily reused snapshots (~13 new states per sim-year, ~800 per hour at 1×, each reused by dozens of questions within its year). Proposal (~6/yr) and Institution (~16/yr) snapshots are asked once or a few times and then discarded, so they may carry exact numbers. Rule for engineers: a snapshot many questions share holds bands only and must be byte-identical between sweeps; a snapshot asked once may hold exact values.

Each option carries a `deltas` block (pressure deltas × slice share × pop / 1000) so actor behaviour feeds the traits: e.g. kind 14 `automate` → `industry +0.003, innovation +0.002`; kind 3 `clergy` → `faith +0.001`; kind 2 `emigrate` → `unrest +0.002`.
---

## 6. Emergent roads

### 6.1 Wear field

`state.roads = {cell: 2, w: Int32Array|Array (W×H, wear 0–10000), tier: Uint8Array, planned: Uint8Array (bitmask: planned, bridge, lamp), xings: Map<zBand, count>}` over the whole terrain at **2-unit cells**. Stored as base64 in saves.

- Each visible resident moving adds `wear += 3` to the cell it is in, once per cell entered. Invisible residents are aggregated: every month, for each (district, trade) group, add `wear += 3 · groupSize · 0.1` along the group's **representative route** (home centroid → work centroid), recomputed when either changes. This keeps the field proportional to real traffic without walking everyone.
- Decay: monthly `wear = floor(wear · 0.985)` for tiers 0–2; tiers ≥ 3 do not decay below their threshold.
- Rain events ×1.3 wear on tier 0–1 (mud), and that's the cue for the "pave the lane" proposal.

### 6.2 Tiers

| tier | name | upgrade when (wear) | downgrade | A* cost | speed × | how |
|---|---|---|---|---|---|---|
| 0 | grass/field | — | — | 1.20 | 1.00 | — |
| 1 | trail | ≥ 60 | wear < 20 for 24 months | 0.95 | 1.10 | organic |
| 2 | track (dirt) | ≥ 300 | wear < 100 for 36 months | 0.75 | 1.25 | organic |
| 3 | road (graded, gravel) | ≥ 1200 **and** era ≥ 1 | never | 0.55 | 1.50 | organic (or planned) |
| 4 | paved / cobbled | planned only | never | 0.42 | 1.75 | Planning / Moot proposal |
| 5 | avenue / boulevard | planned only, era ≥ 3 | never | 0.35 | 1.90 | Planning proposal |

Road-adjacent cells (8-neighbourhood of tier ≥ 3) take A* cost 0.9 so paths hug roads; this creates frontage. Bridges: a bridge cell is tier 3+ over water; water cells are otherwise impassable except marked **fords** (shallow `heightAt` band) at cost 2.5 — fords are what generate crossing demand.

### 6.3 Crossing demand and planned works

Every route that uses a ford or that is rejected because no crossing exists within 40 cells records `xings[zBand(8 cells)] += 1`. Planning Office (or River Authority) templates:

- **Pave a lane**: top 3 contiguous tier-3 segments by wear (≥ 2000 avg, ≥ 12 cells). Cost `90/cell` era-scaled. Options: pave / pave half (cheapest 50%) / wait.
- **Build a bridge**: `max(xings) ≥ 400/yr and no bridge within 30 cells of that band`. Options: timber bridge (cheap, 60-year life, tier 3), stone bridge (3× cost, tier 4, prestige +0.02), ferry licence (River Authority: no bridge, riverTrade +0.01, cost 0).
- **Widen to avenue**: a tier-4 route with wear ≥ 6000 avg and era ≥ 3; costs demolition of frontage lots (list them: "4 homes must move; the town pays them").
- **Ring road**: `I.traffic ≥ 0.6 and ≥ 40% of all wear passes within 12 cells of the centroid`. The sim proposes a ring at radius `r = 1.3 × built radius`; cost high; through-traffic rerouted.
- **Lay out a square**: era ≥ 2, archetype market/exchange/cathedral; clears a 6×6 cell block at the highest-wear junction into tier 5 pavement + fountain/cross; land value +30% within 15 cells.
- **Grid a district**: when a new district forms (kind 13 `cluster`, or a migration wave with no housing), Planning offers to pre-lay tier 3 roads in a grid before houses come ("plan the new quarter") vs letting it grow organically.

Planned works become `projects` with builders walking to them (existing construction system). Pavement rendering: tier → material (`dirt | gravel | cobble | setts`), width (`1 | 1.5 | 2 | 3 cells`), lamp posts at tier ≥ 4 with `lamps` policy, trees at tier 5 in garden/scholar archetypes.

### 6.4 Settlement follows paths

Candidate sites (§7.1) score `access = max tier within 2 cells` heavily, so homes line trails before they become roads; roads then harden because the homes add traffic. This positive loop is the organic look. To prevent ribbon sprawl: `density` term and Planning's zoning caps.

---

## 7. Building growth

### 7.1 Lots and candidate sites

A **lot** is `{id, cells: [cx, cz, w, h], buildingId|null, districtId, landValue, frontageTier}`. Lots are created on demand by `proposeSites(need)`:

1. Collect frontier cells: tier ≥ 1 road cells within 30 cells of any building, plus ring around existing lots.
2. For each frontier cell, try lot sizes allowed for the need (home t1: 2×2 cells, t3: 3×3, mill: 5×4 near water, farm: 6×6 on flat grass with slope < 0.08).
3. Score: `S = 2.0·access + 1.2·landValueNorm + 0.8·sameTypeNeighbours(≤3) − 1.0·pollution − 0.6·slope − 0.5·(density − target)² + archetypeBias` where `archetypeBias` e.g. garden: `+0.4·treesNear`; port/warehouse: `+1.0·riverAdjacent`; mill: `+1.5·riverAdjacent·mill-rights`.
4. Keep the top 4 distinct candidates (≥ 6 cells apart); send to kind 17 with band descriptions; the chosen one becomes a lot + project.

Land value (existing function) gains terms: `+ roadTier·6`, `+ proximity to square/exchange/cathedral`, `− distance to centroid·0.3`.

### 7.2 Home tiers

| tier | name | storeys | capacity | min era | lot | cost (era-0 units) |
|---|---|---|---|---|---|---|
| 1 | hut / cottage | 1 | 5 | 0 | 2×2 | 500 |
| 2 | house | 2 | 7 | 1 | 2×2 | 1100 |
| 3 | townhouse | 3 | 10 | 2 | 2×3 | 2200 |
| 4 | terrace (mill) / tenement (port, exchange) / villa-row (garden) / courtyard (commune) | 3–4 | 16 | 3 | 3×3 or 2×6 strip | 4200 |
| 5 | apartments / mansion block / tower (era 5) | 5–9 | 30–60 | 4 | 4×4 | 9000 |

Upgrades happen **in place** via kind 22 (`rebuild-up`) when: household wealth ≥ 0.6·cost, era allows, and `density` target not exceeded, or via **merge**: two adjacent tier ≤ 2 lots whose owners both choose rebuild-up within 2 years merge into one tier-4 lot (this is how terraces appear). Tenements appear when `housingPressure ≥ 0.5 and I.inequality ≥ 0.45` (a landlord enterprise builds them: quality `wealth` low, capacity high, health −0.001 each).

Density rules: `targetDensity(era, archetype)` = 0.3, 0.4, 0.55, 0.7, 0.85, 0.95 (garden ×0.7, commune ×0.8, port/exchange ×1.1). Zoning policy can override per district.

Non-home types and variants: farm (field, orchard, market-garden, dairy), workshop → manufactory → factory, shop/stall → arcade shop → department store, inn → coaching inn → hotel, chapel → church → cathedral, moot hall → town hall → city hall, school → college, mill (water, then steam at era 3 with chimney), warehouse, quay, exchange, infirmary → hospital, theatre, bathhouse, watch house, union hall, library, bandstand, monument.

### 7.3 Age, wealth, decay

Buildings have `age` (years), `condition` (0–1, −0.01/yr, repair resets), `wealth` (owner wealth band 0–1 at last repair/build). Condition < 0.4 → visibly shabby (`wearTint`), `health −0.0005`; < 0.2 → "slum" tag on district; a Health Board template clears slums.

### 7.4 Era transitions in place

On entering an era, 20% of buildings (chosen by rng, weighted toward wealthy owners) get a `restyle` flag over the next 5 years: same tier, new material/style pack. That is how the skyline visibly shifts without rebuilding.

### 7.5 Renderer hooks (per building)

`{type, variant, tier, storeys, footprint: {w, h}, rotation (toward frontage road), stylePack (archetype×era id), material: 'timber'|'thatch'|'tile'|'brick'|'stone'|'slate'|'iron'|'glass'|'concrete', wealth (0–1 → trim, windows, garden), condition (0–1 → tint, missing shingles), age (→ moss, soot), chimney: bool, smoke: 0–1 (active mills/factories), banner: null | 'protest' | 'festival' | 'plague', lit: bool (lamps/inhabited at night)}`. All fields are already in state; the renderer never derives game rules.

---

## 8. Events

Each event: `when` cond, `chance` per month, `cooldown` years, choices (or none), world effects and visible reactions. "Crowd" = N visible residents switch task to `gather` at a location with banners for the duration.

| id | when / chance | choices | effects | visible |
|---|---|---|---|---|
| `flood` | spring months, `P.ecology ≤ 0.8 or no riverbank-protect` · 0.02 (×0.5 with protect, ×0.6 drainage) · cd 4 | Rebuild at cost / Let households rebuild / Relocate the lowest street | lots within 6 cells of river lose condition −0.4; food −10%; `riverTrade −0.05`; `unrest +0.03`; tag `flood` | water level +0.6 for 2 months, muddy tint, crowds on banks |
| `bumper-harvest` | `I.foodBalance trend rising`, autumn · 0.08 | — (notification) | food +25%, happiness +, farmers mood + | carts, festival small crowd |
| `blight` | `farms ≥ 8 and I.foodBalance ≤ 5` · 0.03 · cd 6 | Import grain (cost) / Fast days (faith) / Do nothing | food −30%; `unrest +0.04`; migration-wave bias | brown fields, queue at granary |
| `fire` | `density ≥ 0.5 and material timber share ≥ 0.5` · 0.015·density · cd 3 | Rebuild in brick (cost, material rule) / Rebuild as before / Open the lots to newcomers | 3–12 adjacent buildings → condition 0; `health −0.05` | smoke columns, crowd with buckets |
| `plague` | `I.pop ≥ 500 and P.health ≤ 0.4` · 0.01·(1−health) · cd 15 | Quarantine (unrest +, deaths ×0.6) / Infirmary (cost) / Pray (faith +) | pop −5..−15%; `health −0.1` then Health Board petitions; tag `plague` | fewer walkers, closed doors, bells |
| `fair` | arts-society or market-charter, summer · 0.25 · cd 1 | Fund (prestige ++) / Allow / Refuse | prestige +0.03, treasury ± , visitors +pop·0.05 for a month | stalls, bunting, crowd at square |
| `feast-day` | parish, `feast-days` policy · 1 (yearly) | — | faith +0.01, happiness +, output −2% | procession along main road |
| `strike` | union, `wages band low and unrest ≥ 0.3` · 0.1 · cd 3 | Side with workers (wage-floor+1) / Side with owners (watch; unrest +) / Mediate (cost) | output −40% for 2 months; mood shifts | crowd at mill gates, banners, no smoke |
| `migration-wave` | from kind 18 `wave` | Welcome (housing pressure) / Quota (half) / Turn away (prestige −, unrest −) | pop +4..10%; newcomers faction + | carts arriving on the entry road |
| `exodus` | kind 18 `exodus-pull` or happiness < 30 for 2 yrs | — | pop −3..−8% | carts leaving |
| `discovery-clay` / `-coal` / `-spring` | once each; `discovery-clay`: era ≥ 1 · 0.01; `coal`: era ≥ 2 and industry ≥ 0.2 · 0.01; `spring`: ecology ≥ 0.7 · 0.01 | Open it (industry +, ecology −) / License it to a guild / Leave it | enables brick kiln / coal pit / bathhouse variants | pit, kiln smoke, bathhouse |
| `schism` | parish, `P.faith ≥ 0.5 and T.innovation ≥ 0.3` · 0.02 · cd 20 | Tolerate (second chapel) / Side with the chapter / Side with reformers | faith −0.05 then +; factions split clergy; a second chapel appears | two processions |
| `boom` | exchange active, `merchant-speculate invest-*` ≥ 60% · 0.05 · cd 8 | — | enterprise cash +30%, building wave, inequality +0.05; schedules `bust` check in 5–10 yrs | cranes (scaffold), busy roads |
| `bust` | 5–10 yrs after boom, `rng < 0.5 + 0.4·inequality` | Bail out the exchange (debt) / Let it fail / Public works (treasury −, roads +) | enterprises close 20%, unrest +0.1, emigration | closed shutters, crowd at exchange |
| `royal-visit` | `P.prestige ≥ 0.5` · 0.02 · cd 25 | Host (cost, prestige +0.1) / Decline | prestige, a monument offer | parade on avenue |
| `drought` | summer, `P.ecology ≤ 0.6` · 0.03 | Ration / Dig wells (health board) | food −15%, mills −20% | yellow terrain tint, low river |
| `bridge-collapse` | timber bridge age ≥ 60 · 0.05/yr | Rebuild in stone / Rebuild timber / Ferry | crossing demand spikes | missing span, crowd |
| `riot` | `P.unrest ≥ 0.7` · 0.2 · cd 5 | Concede top grievance / Send the watch (unrest −0.3 now, +0.01/month 2 yrs, authority +) / Call a moot (open-moot) | buildings condition −, prestige −0.1 | large crowd, torches, banners |
| `scholar-arrives` | `P.learning ≥ 0.3` · 0.03 · cd 10 | Fund a college (learning ++) / Welcome | learning +0.05, innovation + | — |
| `founders-jubilee` | year 50, 100 (fixed) | Festival / Quiet | prestige, happiness; chronicle recap | fireworks (particles) |
| `press-arrives` | era ≥ 3 and learning ≥ 0.3 | Licence it / Ban it (authority +, innovation −) | innovation +0.05; petitions 2× | newspaper boys (visible task) |

Reactions always route through kind 11 (`event-response`) for the affected slices; the sim converts the distribution into crowd size, hoarding (food −), prayer (faith +), and `blame-council` (unrest +, Moot patience −).

---

## 9. Player loop and pacing

### 9.1 Docket

`state.docket: Card[]`, `Card = {id, kind: 'proposal'|'petition'|'event'|'demand'|'debate'|'report', from (institution id), templateId, createdMonth, expiresMonth, options[], stances[], cost, delegatedDefault?}`.

- **Target rate**: era 0–1: 1–3 cards/year; era 2–3: 3–4; era 4–5: 4 (no more). Bodies that would exceed the cap are queued; the Moot presents them in the next **session**.
- **Sessions**: every quarter (15 s at 1×) the docket surfaces up to 3 cards as a stack; a soft chime, no auto-pause at 1×. At 3×/8× the game pauses on session open (configurable). On phones, a single card at a time with swipe.
- **Expiry**: cards last 2 years. Expired `proposal` → the body loses patience 0.05 and the status quo holds. Expired `demand` → the body enacts its own choice within budget. Expired `event` → the default (first) choice applies.
- **Delegation** (era ≥ 3, or when a body has ≥ 4 accepted and 0 refused): per body, a toggle "Let them run their own affairs" with a spend cap; the body's cards become `report` cards (read-only, one per year, "The Health Board dug 3 wells this year"). The player can revoke anytime. Delegation also unlocks **standing orders** per category: "Always fund paving under 400 coin", "Never raise tithe". These are evaluated as conds on cards.
- **Batching**: a body with two eligible templates in a session issues one card with both as options ("Which first?") rather than two cards.

### 9.2 What the player sees per era

- Hamlet: Chronicle (feed), one docket card, three numbers (people, food, coin).
- Village: Policy book (Land, Food, Tax), People panel with factions and moods.
- Town: Institutions panel (dashboards), overlays (wear/roads, land value, health).
- Borough: Debate cards, Delegation, Tensions list.
- City: Budget sheet (per body), Tensions dashboard, trait compass (4 axes).
- Metropolis: End-of-chronicle preview ("How will the chronicle read?").

### 9.3 Soft fails and recovery

No game over. Each fail is an event with a recovery path:
- **Insolvency** (`treasury < −2 yrs net`): "Receivership" — a Steward body takes 50% of docket decisions for 5 years (cards become reports), taxes rise 3 points, prestige −0.2. Ends when treasury ≥ 0.
- **Famine** (`foodBalance = 0` for 3 months): pop −10%, exodus, agri-council forms or demands.
- **Plague**, **riot**, **bust**: as §8.
- **Depopulation** (`pop < 60`): "The hamlet" — eras can regress one step visually (no new tiers), chronicle notes it; migration-wave bias +.

### 9.4 End of chronicle (year 150)

A generated page: archetype arc (list of archetype changes with years), the trait compass drawn as a path, 8–12 chronicle highlights (events with the largest |Δ happiness| or |Δ pop|), the institutions roll (founded, dissolved, refused), the policy book size, three "what the town became" sentences built from templates keyed on archetype × era-late tags × inequality band × ecology band, and a final flyover of the city. Save the summary into `state.chronicle.summary` so it can be shared.

---

## 10. Language guide

Voice: a neighbour who knows the town, not a clerk. Short sentences. One idea each. Common words. Active voice. Say who wants what and why now. Give the trade-off plainly. Allow a warm lead-in or a connector ("Good news.", "Here is the problem.", "So,"). No jargon, no numbers the player cannot act on. Prefer "people", "homes", "coin", "the river".

Before → after:

1. *"Insufficient treasury to allocate funds for proposed infrastructure expansion."* → *"The town cannot pay for this yet. We have 300 coin. The bridge costs 1,600."*
2. *"Agricultural sector stakeholders request formation of a dedicated oversight body."* → *"The farmers want their own council. It would track the harvest and bring you farm plans. Shall we form it?"*
3. *"Resident satisfaction metrics indicate a negative trend attributable to housing scarcity."* → *"People are unhappy. There are not enough homes. Twelve families are waiting."*
4. *"Implementation of tolls may adversely impact riverine commerce volumes."* → *"Tolls bring coin. But boats will come less often. The merchants will not like it."*
5. *"Policy conflict detected: wage-floor vs free-trade."* → *"Two of your rules pull against each other. The wage floor raises pay. Free trade pushes it down. Nothing moves while both stand."*
6. *"Spontaneous pedestrian desire path densification observed at river crossing."* → *"Many people cross the river at the ford by the mill. A bridge there would save them an hour a day."*
7. *"The Health Board has registered elevated morbidity in District 3."* → *"The Health Board is worried. More people are sick in the Low Quarter. They want to dig two wells."*
8. *"Era transition: Borough."* → *"Hearthvale is a borough now. Houses can rise to four storeys. The streets can be paved."*

**Proposal card template**

```
[Title: 3–6 words, a noun phrase]        e.g.  A bridge at the mill ford
[Who asks]                                 River Authority · Tamsin Ode
[Why now: 1–3 sentences]                   Many people cross at the mill ford. In spring it floods. A bridge would save time and lives.
[What it costs / affects: one line]        Costs 1,600 coin. Upkeep 5 a year.
[Options: 2–4, each = verb phrase + one trade-off sentence]
  Build in timber     Cheap. It will need replacing in sixty years.
  Build in stone      Three times the cost. It lasts and looks fine.
  License a ferry     No cost. Slower, and the ferryman takes a fee.
  Not now             The Authority will ask again in three years.
[Debate strip, if any]  For: merchants (likely), farmers (split). Against: millers — they fear losing water rights (62%).
```

Labels: `People`, `Homes`, `Food`, `Coin`, `Roads`, `Bodies` (not "Institutions" in UI), `Rules` (not "Policies" in UI; the book is "The Rule Book"), `Chronicle`. Button verbs: `Do it`, `Not now`, `Refuse`, `Let them decide`.

---

## 11. State schema and module split

### 11.1 State additions (save `version: 2`)

```js
state.time        = { tick, month, year, speed }
state.seed        // existing LCG; ALL randomness via rng(state)
state.traits      = { industry, market, innovation, authority }        // number [-1,1]
state.traitVel    = { industry, market, innovation, authority }
state.pressures   = { riverTrade, faith, learning, ecology, health, unrest, prestige } // [0,1]
state.indicators  = { pop, households, tension, density, inequality, housingPressure, foodBalance, jobBalance, treasuryYears, avgWealth, traffic, literacy, avgHomeTier } // cache, recomputed monthly
state.indicatorHistory = { [key]: number[] }   // one sample per year, for trends and the end summary
state.tags        = { [name]: lastYear }        // e.g. 'flood': 42
state.tagCounts   = { [name]: n }
state.deltaLog    = [ { key, amount, source } ] // cleared each month
state.era         = 0..5
state.eraEntered  = number[]                    // year of entry per era
state.archetype   = 'market-town' | 'mill' | 'port' | 'garden' | 'cathedral' | 'commune' | 'exchange' | 'scholar'

state.households  = [ { id, homeId, size, wealth, trade: 'farm'|'craft'|'trade'|'labour'|'clerical'|'clergy'|'gentry'|'none', lifeStage: 'young'|'family'|'elder', householdType, rent, savings, faithBand: 0|1|2, districtId, newcomerUntil: year|null, loyalty: {factionId: 0..1} } ]
state.slices      = { [dim]: { [value]: { size, lastAnswer: { [kind]: { probs, month } } } } }   // district, trade, wealthBand, lifeStage, householdType, faction, newcomer
state.disagreement = { [kind]: { [sliceKey]: { D, n, year } } }   // last sweep's torn intersections
state.bands       = { [indicator]: [t1, t2] }   // yearly tertile thresholds used by snapshot builders
state.enterprises = [ { id, type, variant, buildingId, ownerHouseholdId, jobs, cash, output, wagesBand, automated: bool, since } ]
state.factions    = [ { id, size, mood, stances: { [cardId]: 'for'|'against'|'split'|'indifferent' } } ]
state.institutions= [ { id, kind, foundedYear, status, budgetShare, power, patience, metrics: {}, lastProposalMonth, delegated, standingOrders: Cond[] } ]
state.policies    = { [policyId]: { level, since, by } }
state.docket      = [ Card ]            // see §9.1
state.cardHistory = [ { id, from, templateId, choice, year } ]   // rulings; feeds power/patience and the end summary
state.events      = { active: [ { id, startedMonth, endsMonth, data } ], cooldownUntil: { [id]: year } }
state.roads       = { cell: 2, w: number, h: number, originX, originZ, wear: string (base64 Int32), tier: string (base64 Uint8), planned: string (base64 Uint8), xings: { [zBand]: count }, routesCache: { [districtId_trade]: [cellIndex...] } }
state.lots        = [ { id, cx, cz, w, h, buildingId, districtId, landValue, frontageTier } ]
state.districts   = [ { id, name, centroid: {x,z}, lots: n, tags: [] } ]
state.buildings[] += { tier, storeys, variant, stylePack, material, wealth, condition, age, lotId, chimney, smoke, banner, lit, restyleAt }
state.people[]    += { householdId, visible: bool, task: 'work'|'rest'|'shop'|'leisure'|'worship'|'gather'|'build'|'flee', gatherAt: {x,z}|null }
state.chronicle   = { entries: [ { year, month, text, kind, refs } ], summary: null | {...} }
state.budget      = { income: { tax, tolls, tithe }, spend: { upkeep, policies, bodies: { [id]: n }, projects } }   // last-year totals
```

Everything is plain numbers, strings, arrays, objects. No Maps/Sets in state (use objects keyed by id; build Maps as transient indexes in a `WeakMap` as the current code does). Typed arrays are base64-encoded on `serialize()` and decoded on `restore()`.

### 11.2 Module split (`src/sim/`)

| module | owns | depends on |
|---|---|---|
| `rng.js` | `rng(state)`, `pick`, `sampleDist(probs, r)`, `shuffle` | — |
| `clock.js` | tick → month/year rollovers, emits `onMonth`, `onYear`, `onQuarter` hooks | — |
| `conditions.js` | `evalCond(expr, ctx)`, `makeCtx(state)`, `soft`, `ramp`, `tag` ops | — |
| `pressures.js` | `delta()`, `applyDeltas()`, trait momentum/lock-in, decay, `computeIndicators()`, archetype | conditions |
| `eras.js` | `ERA[]` table, entry check yearly, restyle scheduling, chronicle entry | pressures, conditions |
| `policies.js` | `POLICIES` catalogue, adopt/change, upkeep, monthly deltas, `weightsFor(kind)`, tension detection | pressures |
| `institutions.js` | `INSTITUTIONS` catalogue, petition/form/wane/dissolve, power/patience, drafting via `institution-draft`, delegation, standing orders | conditions, policies, docket, decisions |
| `docket.js` | cards, sessions, expiry, debate merging, rulings → `cardHistory` | institutions, factions |
| `decisions/kinds.js` | the 23 question kinds: slice declarations, local terms, options, per-option effects/deltas (data) | pressures |
| `decisions/snapshots.js` | Town/District/Proposal/Institution snapshot builders, yearly band thresholds, content hashing for cache-stable states | pressures |
| `decisions/pooling.js` | linear opinion pool of slice answers, masks, local terms, JSD per intersection, refinement requests, `state.disagreement` | rng |
| `decisions/scheduler.js` | cadences ×speed, groups questions by snapshot into /v1/decisions and /v1/decisions/batch requests, budget guard, applies pooled answers | kinds, snapshots, pooling |
| `households.js` | households, slice membership, wealth, births/deaths/ageing (yearly slice maths), move/emigrate/bring-kin | decisions |
| `enterprises.js` | enterprise lifecycle, jobs, output, wages, automation, found/close | households, decisions |
| `factions.js` | yearly faction derivation, moods, stances, petitions | households |
| `roads.js` | wear field, decay, tiers, crossing demand, (district, trade) representative routes, A* cost provider (`costAt(cell)`), planned works | clock |
| `sites.js` | lots, districts, `proposeSites()`, land value terms, density targets | roads |
| `buildings.js` | tiers/variants table, upgrade/merge/restyle, condition/age, renderer hook fields | sites, eras |
| `events.js` | `EVENTS` catalogue, monthly roll, choices, world effects, reaction routing | conditions, docket, decisions |
| `chronicle.js` | entries, year summaries, end-of-chronicle generator | everything (read-only) |
| `text/voice.js` | templated strings, card template renderer, language lint (sentence length ≤ 14 words warn) | — |
| `serialize.js` | `serialize`, `restore`, typed-array base64, version migration (drop v1) | — |

**Tick order** (inside `stepTick`): clock → (if month rolled) policies.monthly → institutions.monthly → events.roll → roads.monthlyAggregate+decay → pressures.applyDeltas → pressures.computeIndicators → (if quarter) docket.session → (if year) households.yearly → enterprises.yearly → factions.yearly → eras.check → chronicle.year. Every tick: scheduler.flush (send due questions, apply returned answers in arrival order **but** apply them deterministically by sorting answers by question key before applying, so replay with the same answers is identical), people movement, roads.wearFromVisible.

**Determinism note**: the decision model is an external source of randomness. Record every applied answer distribution in a ring buffer `state.answerLog` (last 2,000) so a save-and-reload continues identically, and so a replay mode can re-feed answers.

**Performance budget** per tick at 10,000 pop: ≤ 2 ms sim on an M-series laptop, ≤ 4 ms on iPhone 15 Pro. Individuals: only `visible` people (≤ 600) get movement and A*. Everything else is slice arithmetic once a month. Wear aggregation runs over one cached route per (district, trade) pair (≤ 40) per month. `computeIndicators` is O(households + buildings) once a month.

### 11.3 Parallel work packages

1. **Core** — `rng`, `clock`, `conditions`, `pressures`, `eras`, `serialize` (one engineer, day 1; everyone else codes against the schema above).
2. **Decisions** — `kinds`, `scheduler`, integration with the decision bus; `households`, `factions`.
3. **Bodies & rules** — `policies`, `institutions`, `docket`, `events`, `text/voice`.
4. **World** — `roads`, `sites`, `buildings`, `enterprises`, renderer hook contract with `world.js`.
5. **UI** — docket cards, rule book, bodies panel, tensions, chronicle, end page, responsive.

Package 1 ships stubs (`evalCond` returning true, `rng`) within hours so the others can integrate immediately.
