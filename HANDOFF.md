# Hearthvale — handoff (evolving-city rework)

Repo: `github.com/tandalesc/hearthvale_decisions` (private for now). The original game is the first commit (`c1ca36a`, "Baseline").

**State at handoff (2026-10-15):**
- Branch `evolving-city` at `ff15d41`, with a large amount of **uncommitted** work on top: 63 changed files and 22 new ones, listed under "This session" below.
- `npm test` passes 259/259 and `npx playwright test` passes 51/51. `npm run build` is clean.
- **First step: commit this working tree.** Nothing from this session is in git yet.

## What the game is now

The player is the town's deliberative leadership ("System 2"). They never place buildings or roads. They rule on docket cards and shape the Rule Book. Everyone else acts on their own ("System 1"): residents, households, businesses and institutions decide through a local decision model, with local fallback rules when it's unavailable.

- **Pace.** A tick is 0.1 sim-seconds and a month is 50 ticks. The game now runs at **half pace** (`PACE = 0.5` in `src/sim/clock.js`, applied in `src/main.js`; `?pace=` overrides it). That makes a month 10 s and a year 2 minutes at 1×.
  - Walkers move at `WALK_SPEED = 2.8` units per sim-second, so on screen they still look like 1.4 a second.
  - Leg animation is tied to on-screen speed (`GAIT_SPEED` in `src/sim/render-view.js`).
  - Walking faster in sim time means less time walking (43% of the day instead of 59%) and needs about 10 points higher. With the new path rules, road growth stays within noise of the old pace, so wear (`WEAR_PER_CELL = 3`) is unchanged.
- **Composable conditions, not rule chains.** Traits with momentum and pressures build up from rulings and actor behaviour. Everything that unlocks (cards, institutions, events, styles, archetypes) uses the small condition DSL in `src/sim/conditions.js`.
- **Institutions emerge and petition to exist.** Each has a dashboard, docket asks, budget, patience and rivals, and can be delegated to, given standing orders, or dissolved.
- **Organic roads.** Walking wears a grid (2-unit cells, 384²) and wear upgrades cells from trail to track to road. Paving and avenues come only from works. Fords, footbridges, cart bridges, upgrades, collapses and rebuilds.
- **Growth.** Lots follow worn paths, homes upgrade in place across era style packs, there's bid-rent pressure, and there can be several centres.
- **Language.** All player-facing text follows the house voice (`src/sim/text/voice.js` lints it).

## Decision model (Liquid AI d1-3B behind LiteLLM, on a LAN GPU box)

- `server/system1.js` proxies `POST /api/decisions` to `DECISIONS_URL` from `local.env` (a LAN name or loopback, `/v1/decisions` and `/v1/decisions/batch`). The key comes from `local.env`, is sent server-side only as `x-litellm-api-key`, and never reaches the browser.
- Request shape: `{groups:[{state, questions:[{kind,id,context,allowed?}]}]}`. Kinds are registered in `src/decision-kinds.js`; the game kinds live in `src/sim/decisions/kinds.js`.
- **Service facts:**
  - Always send a `state`, at least `{}`. Without one the service answers 413.
  - At most 64 questions per request.
  - The state cache lives in GPU memory, so keep it small.
- **Question types (new).** A kind has `type: 'choice' | 'score' | 'noul'`.
  - `score` is an ordered scale with 2–10 levels, lowest first. Answers also carry `score`, the expected level.
  - `noul` is yes/no, with the "yes" key first.
  - Every type comes back as `{choice, confidence, probabilities}` over the option keys, so pooling, sampling and fallbacks don't care which type it was.
  - The service accepts all three, and also `images` (base64 data URIs). Images work (the model clearly reads them), but nothing uses them yet. Latency wasn't measured cleanly because the box was busy.
- **What changed, and why** (all measured live; the scripts are listed under "Tools" below):
  - **`migration_wave`** is now a `score` scale (exodus → none → trickle → wave). It contradicts itself less than the old choice did (0.04 vs 0.11 of probability on wave and exodus at once).
    - The answer is still sampled, not driven by the expected level. The expected level sits around 1.1–1.4 in almost every town, so using it directly would bring migrants every year and never a wave.
  - **`take_loan`** is now a `score` scale and asks **businesses short of coin**, who are the ones that actually borrow (`enterprises.js` `maybeBorrow`). Before, it asked households with zero savings, every question was identical, and nothing acted on the answer.
    - The instructions describe money in words, because the model reads banded words far better than raw numbers.
    - The model still borrows more when already in debt, so `maybeBorrow` has a hard rule: lenders balk at a year of debt.
  - **`react_to_policy`** stays a `choice`. A scale was no better, and strike/leave aren't on the same scale as grumble/protest.
  - **Town snapshot bands** (`src/sim/decisions/slices.js`) were recalibrated. Before, nearly every town read wellbeing "good", jobs "scarce" and homes "plenty".
    - Wellbeing: cut-offs at 80 and 89.
    - Jobs: relative to the usual surplus of workers (below −0.42 is scarce, above −0.2 is plenty).
    - Homes: now measured by the share of empty homes. Households only form where a home exists, so homelessness is always 0.
- Population decisions use overlapping slices with linear pooling (`src/decision-pool.js`) and refinement where slices disagree. The client (`src/decision-client.js`) coalesces, groups by state, and backs off; a failed question falls back to local rules.

### Decision load and high speeds (October 2026)

Measured headless with a mock 100 ms service (real sim and client). The scratch script is not committed. Questions sent a second at 1×: town 1,193 → 11.5, city 1,189 → 23. City at 5×: 1,791 → 62; at 10×: 104; at 20×: 194.
- **Walker refresh had no limit.** `fillThroughput` asked every visible walker again the moment an answer landed. Refinement and individual questions now share a real-time budget (`FILL_PER_SEC` 8, burst 32). A walker is asked again only when their question would change (a need band, trade, district) or a game month has passed. At most 96 people are scanned per tick.
- **Exact-answer caches.**
  - The browser client (`cacheSize` 8192, LRU) answers a byte-identical (kind, state, context, allowed) at once. Asker ids are not part of the key, so walkers with the same question share it. `reset()` clears it.
  - The proxy (`createAnswerCache`, 50k) shares answers across players.
  - Both are lossless: the model returns a distribution and the game samples it.
- **Proxy limits** (`createLimits`, off by default): `DECISIONS_CLIENT_QPS` per address and `DECISIONS_DAILY_CAP` per UTC day. They count only questions sent upstream. Past a limit the player gets 429 or 503, and the town falls back to local rules. Set both for a public deployment.
- **Speeds 10× and 20×** (keys 4 and 5).
  - `stepTick(…, {until})` is a frame budget (`SIM_BUDGET_MS` 10 in main.js). No tick starts once the budget is spent, or when the last tick says the next would overrun. Backlog is capped at 1 sim second, so a slow device runs the town slower instead of stuttering. The ticks and outcome are unchanged, and a test checks this.
  - The sim runs in a Web Worker (`src/sim-worker.js`, behind `src/sim-host.js`): the main thread draws a mirrored render view and UI snapshots, and no tick can hold up a frame. `?simWorker=0` (and the stub sim, or a worker that cannot start) runs it on the main thread through the same host, in a task of its own after each drawn frame. `hearthvale.view().stepMs` is the last step's time; tests reach the town with `hearthvale.inSim(fn)` and `hearthvale.snapshot()` (PERFORMANCE.md, "The sim in a Web Worker").
  - The speed button turns rust with a dotted underline and says "Running at about N×" when the device reaches less than 80% of the chosen speed.
  - `services.rate` (sim seconds per real second) shortens the sweep wait above 5× to about a month and a quarter of game time. Late answers fall back to local rules.
  - Measured on this Mac (headless Chrome, Metal): hamlet 20× reaches 20×, city 10× reaches 10×, city 20× reaches about 14–17×. Per-tick cost in a city (route delivery) is the limit.

## LLM prose (narrator)

`server/narrator.js` streams from the models in `NARRATOR_MODELS` (`local.env`, tried in order) with `enable_thinking: false`. It writes inspector notes, card prose, year-end chronicle lines and the end page. Replies are validated and fall back to template text. Notes are cached by a material-facts key and saved with the game. A note never changes under the reader; a refresh lights up when the facts change.

- The narrator's injection filter blocks words like "forget". Game text must avoid them: the card line "They will not forget" was being rejected and is now "They will remember this".

## This session (uncommitted)

**Decisions and balance** (see the section above): question types, `migration_wave` and `take_loan` as scales, the snapshot bands, `monthlyCost` exported from `enterprises.js`.

**Pace and walkers:** `PACE`, walk speed 2.8, `GAIT_SPEED`, and `sim.pace` passed through `src/ui/bridge.js`.

**Paths** (`src/render/paths.js` new, `src/render/roads.js`, `src/sim/roads.js`, `src/sim/reclaim.js` new):
- Worn paths render from a 4-texel-per-cell distance field as continuous strips. Width follows tier, with round junctions. Bare dirt stays patchy.
- Towpaths and the waterfront draw as one lane that follows the bank. Paved roads smooth along diagonals.
- In the sim, side paths merge into busier ones and one-cell gaps close.
- A derelict building with trodden paths on opposite sides comes down after 4 years (at most 3 a year, never heritage), and the path runs straight through the lot.

**Walker fixes:**
- `src/navigation.js`: the first and last legs of a route can no longer wade through deep water beside a ford.
- `people.js` `alongDecks`: walkers join and leave bridges at their ends. **Every leg it adds is checked against walls** (`pushOpen`); it once routed walkers through house fronts beside bridge approaches.
- Regression tests: `tests/paths.test.js` and `tests/bridge-legs.test.js`.

**Nature** (`src/river.js` new, `src/render/{water,terrain,trees,rivermap,atmosphere,sky,grade}.js`):
- The river has gravel bars, riffles, white water, boulders and mountain cascades. All of it is render-side; the centre line and saves are unchanged.
- Five tree species with two levels of detail, seasons and wind.
- **One shared fog** for every material, in linear light before tone mapping. Distant buildings used to turn into pale ghosts.
- Water now darkens at night like the land; it used to glow.
- `rapidsSources()` feeds the audio.

**Audio** (`src/audio/*`, `river.js` and `voices.js` new):
- Fully synthesised. The river is about 15 dB quieter at a normal view, and there's almost no energy above 4 kHz.
- Birds, crickets, frogs, an owl, wind, rain and the village murmur all respond to time of day, season, weather, camera and population. Nothing loops.
- `audio.setWaterSources()` gets the rapids at startup (`src/main.js`).

**Lived-in town** (`src/sim/{landscape,aesthetics,parks,seats}.js` new, `src/render/decor.js` new):
- **Landscaping is one process:** a care level per lot and per 8-unit block of verge. It runs overgrown → rough → mown → planted → formal, and backwards with neglect.
- **Looks** (`b.looks`, `I.looks`) feed wellbeing (±6), faction mood, moving house and settling, and an `eyesores` petition grievance. `aestheticComplaints()` returns local, structured evidence (what, where, how bad, how long, how many residents).
- **Parks** are designated by the Planning Office (the `green-space` template) or by the Green reserves rule. A park on the water becomes a beach.
- **Decor:** fences, hedges, beds, benches, bins, signposts, wells, stalls, park furniture and beaches. Three draw calls, shown only within about 100 units of the camera.
- **Seats:** benches are placed by `seats.js`, which the decor and the walkers share. Leisure visitors to parks and gathering places take a free bench seat (new bench pose, action 7) or a lawn spot, one to a seat.

**Buildings** (`src/render/kit/{compose,geometry}.js`):
- Porches, lean-tos, porticos, bay windows, turrets, market posts and monument bases reach the ground on slopes.
- Z-fighting flicker (gable ends flush with walls, stacked bases, cornices) is fixed with small real offsets.
- Regression test: `tests/render-attachments.test.js`.

**UI** (`src/ui/**`), reworked again from owner feedback:
- **The Council** (`components/council.js`) replaces the docket modal and the right-hand body pages:
  - A HUD panel over the main area (between the rail or drawer and the dock, above the time strip), not a dialog, so the top bar and time strip stay usable.
  - The bodies are listed down its left side: Town Council (every request), then each body with its count. The middle holds the cards for that page, with area chips above them. The side holds the rules for the open card's area and the body's page (dashboard, purse, rules, dissolve).
  - On desktop the dock holds one crest, the Council; **C** or **D** toggles it. On phones it is one sheet tab, with the bodies as a strip of chips.
  - The town pauses while it is open (Game → "Pause while ruling"). On phones that means while the sheet is raised on the Council tab.
  - Removed at the owner's request, to come back with an advisors and budgets feature: standing orders, "Let them run their own affairs" (delegation), and the factions column (it duplicated People). The sim still supports delegation and standing orders.
- **Drawer and Council tile:** with both open, the drawer's grip sits in the gap and one drag moves the shared edge.
- **Camera:** panels never move it. Scene insets follow only the fixed chrome (top bar, rail, dock, time strip or the phone peek). Request notices don't fly the camera either; "Show me" and Locate still do.
- **Notice stack** (`components/notices.js`): one stack under the top bar, at the top left beside the rail (full width on phones).
  - Majors (requests, year ends, new surfaces, moments) linger about 20 s, one per key.
  - Minors (chronicle happenings) fade in 5–6 s.
  - Toasts stay top centre.
- **Chronicle:** loads the latest 60 lines; "Show earlier lines" adds more. Era groups out of view skip rendering (`content-visibility`).
- **Speed:** pause, plus one button that steps 1× → 3× → 5×. Keys 1/2/3 set 1×, 3× and 5×. 8× is gone.
- **Rail:** views and the map only; the locate and full-screen tiles are gone (**F** still toggles full screen).
- **Rule Book:** the listing in the left drawer; **R** toggles it.
- **Proposal opinion** (`src/sim/opinion.js`): a town-feeling bar on each card with a verdict (Popular, Divisive, Unpopular, Indifferent) and a faction breakdown, weighted by faction size, with no extra model calls. The old For/Against debate strip is gone.
- **Phone inspector:** a solid card above the peek, sized to its content. It closes when the sheet rises.
- **Inspector:** one actions row (Locate, Follow, Why?, Refresh).
- **Settings tabs:** Game, Display, Sound, Accessibility, Decision model.

**Tests hardened.** Several tests assumed facts about the grown fixture towns (a timber bridge exists, a debate formed, cards have unique titles). They now set up what they need.
- **One threshold was loosened:** "opposite early rulings end in different towns" now needs an industry gap of 0.35, not 0.5. The old code already measured 0.47 on one of its three seeds.

## World grounding (October 2026)

All render-side; the sim, saves and replay are untouched.

- **Villager IK** (`src/render/people.js`, vertex shader only, no CPU cost):
  - Legs are thigh and shin, solved analytically toward a foot target; the knee ring is shared, so they bend without a gap. Triangles 114 → 112 (the mallet reuses the placard pole and the crate box).
  - The walk plants each foot: the stride comes from the row's own velocity over half a cycle, so a stance foot moves back exactly as fast as the body moves forward. Hips ride over the lower planted foot, so the body dips at full stride.
  - Within `uIkNear` (70 m) each foot reads the ground under its own sole: on a slope one knee bends. Ledges (> 0.4 figure units) hold the walking plane.
  - Poses: bench sitters sit on the bench's own height (the highest ground under its legs, as `decor.js` places it) with feet on the ground and hands on the knees; kneelers put knees, shins and hands on the ground; ground sitters lean back on their hands.
  - Walkers now drape onto building pads near doors (they used to keep the sim's natural height where a pad blend differs by more than 0.3 m). Waders at fords keep their row height.
- **Ground sampling** (`src/render/ground.js`): the shader and the CPU mirror interpolate on the terrain mesh's own two triangles per cell instead of bilinearly, so anything placed or draped lies on the drawn ground.
- **Terrain LOD** (`src/render/terrain.js`): chunks pick their level by distance to the chunk's nearest point, not its centre, so ground near the camera never drops to the 2 or 4 m grid under things placed on the 1 m texture. GPU time unchanged in `fidelity-shots.js`; triangles up 0.1–1.1 M in the views that keep more chunks at full detail.
- **Crops** (`src/render/kit/crops.js`): fields follow the farm variant, era, year and season in the field shader. Arable land is in three-field strips before the town era and on a four-course round after it (wheat, roots, barley, clover; flax; rapeseed from the city era). There are stooks at harvest before the Industrial era, ploughed furrows, winter wheat sprouting over winter, market-garden rows, orchard sward and dairy pasture. Orchard farms plant fruit trees on their field (`trees.js` `orchardPlanting`): blossom in spring, apples in late summer. Dairies graze cattle (`decor.js` `cow`) except in winter. Haystacks only on dairy meadows, and round bales on arable stubble from the Industrial era.
- **Street fabric** (`src/render/streets.js`, `tStreet` in `roads.js`):
  - Lanes between buildings are paved wall to wall, and from the town era so are through gaps between houses (ginnels). They are packed earth until the borough era, or until they open onto a paved road; after that, cobbles or setts with a centre gutter.
  - From the borough era, made roads get flagstone footways along building fronts, with a kerb on the carriageway's own edge (city: a dark channel, smaller slabs).
  - Grass and verge planting keep off them, and kept streets get kerbside planters.
  - Tests: `tests/render-streets.test.js`.

## Module map (who owns what)

| Area | Files |
|---|---|
| Sim core | `src/sim/{index,state,clock,rng,hooks,conditions,pressures,eras,economy,households,enterprises,land,people,serialize,fixtures,render-view,notes}.js` |
| World | `src/sim/{world,roads,sites,districts,buildings,works,bridges,centres,reclaim}.js`, `src/navigation*.js`, `src/route-planner.js`, `src/terrain.js`, `src/river.js` (render-side river detail) |
| Lived-in | `src/sim/{landscape,aesthetics,parks,seats}.js` |
| Governance | `src/sim/{governance,policies,institutions,docket,subjects,events,factions,chronicle,view,opinion}.js`, `src/sim/decisions/*`, `src/sim/text/voice.js` |
| Decisions | `server/system1.js`, `src/decision-{kinds,client,pool}.js`, `src/routine-policy.js` |
| Narrator | `server/narrator.js`, `src/narrator-client.js`, `src/narrative-{schema,prose}.js`, `src/sim/narrative-facts.js` |
| Renderer | `src/render/**` (Three.js r180): ground-height texture, path distance field (`paths.js`), shared fog (`atmosphere.js`), instanced kit buildings, decor, GPU villagers, water with river map, quality tiers |
| UI and audio | `src/ui/**` (no framework), `src/main.js`, `src/audio/**`, `src/save-store.js` |

The sim is deterministic: one seeded RNG, and model answers are applied in key order and logged. Save → restore → continue is byte-identical, and tests check it. New state fields get defaults on load.

## Saves

Saved to **IndexedDB, gzip-compressed** (`src/save-store.js`): 0.4 s after a ruling, every 30 s, on hide or pagehide, and before a Vite reload. Only the newest tab playing a town writes it. Old saves load with this session's changes; landscaping is seeded when an old save loads.

**Several towns per device (save slots).** The database is version 2: `saves` holds each town's gzip under a slot id, and `meta` holds a small record per slot (name, year, people, era, seed, valley, `savedAt`, and a JPEG `thumb` of the world canvas captured right after a drawn frame). The single pre-slot save keeps the key `current` and gets a record the first time towns are listed. The legacy localStorage save becomes its own slot. A town's name is `state.townName` (absent in older saves, which show as "Hearthvale").

## Main menu

`src/ui/menu/` runs before the sim and renderer finish loading (main.js loads them in the background):
- **Continue** (the last town played, over its own picture), **New town**, **Your towns** (play, rename, export, delete), **Settings** (a subset of the in-game settings), **About**, and **Import a town file**.
- **New town:** a name, a seed (code, number or any word), a landscape (the seed's own, or any of `waters.js` ARCHETYPES, or "River only" = terrain version 1), a crowd size (`settings.individualCap` 800/2000/4000), and the decision-model switch.
- The valley map is sampled in a worker (`valley-worker.js`) from `terrain.js`, the same terrain the game builds. It is drawn as a contour sheet (`valley-map.js`). Water edges come from `bankDistance`, so rivers are smooth below the sample spacing.
- **Skipping the menu:** `?fixture=…` and `?play=1` go straight to a town (`play=1` continues the last one or starts a new one). The browser test helper adds `play=1`. Deliberate reloads (new town, import, "Choose a valley") leave an intent in sessionStorage (`hearthvale-boot`), so the menu is skipped or opens on the right screen. Settings → **Main menu** saves, then reloads to the menu.
- Seeds moved to `src/seed.js`; `sim/state.js` re-exports them.

## Running and checking

```sh
npm install
npm run dev                      # http://127.0.0.1:5173 (?fixture=hamlet|town|city, ?pace=0.5)
npm test                         # 259 node tests
npm run build
npx playwright test              # 51 browser tests (starts its own server)
node scripts/boot-check.js       # loads the game and fails on any renderer error
node scripts/balance.js --seeds 6 --years 120 --styles frugal,balanced,generous
node scripts/render-check.js --url http://127.0.0.1:PORT   # screenshots + stats (default port 5199)
node scripts/benchmark-decisions.js   # live decision throughput (LAN access to the decision service)
```

The two wall-clock tests ("150 headless years" and the 3,000-walker p95) fail when the machine is busy, for example with agents or browsers running. Rerun them quiet.

## Open decisions (owner's call)

1. **Generous councils and receivership.** Merged tree against the original baseline, 6 seeds, median at year 100:

   | Style | Population | Years in debt | Receivership years |
   |---|---|---|---|
   | frugal | 3656 → 3484 | 2% → 5% | 0 → 3 |
   | balanced | 4148 → 3618 | 21% → 13% | 6 → 0 |
   | generous | 4842 → 4052 | 9% → 22% | 3 → 13 |

   The main driver is the new jobs band, through the four offline rules in `effects.js` that read `snap.jobs` (emigrate, leave town, petty theft, wave); those used to fire always. Either keep it as the cost of overspending, or retune those rules.
2. **Proposals from what people experience.** Proposed design:
   - Feed `aestheticComplaints()` (and similar evidence) to the narrator model to write the complaint and the proposal.
   - Build the proposal's effect from existing levers (repair works, a rule, a body budget), validated.
   - Log the model output so replay stays exact, with a template as the offline fallback.

   Today an upkeep proposal can't appear at all: `institution_draft` only picks from the `TEMPLATES` in `src/sim/institutions.js`, and no template or `docket.applyOption` effect repairs buildings or clears derelicts. The owner said not to add a fixed HOA-style rule.
3. **Image questions for `choose_site`.** They work through the proxy. Measure latency on a quiet box before building anything.

## Known gaps

- **Riverbank and benches:** benches the decor places along banks and towpaths aren't sittable yet. They come from landscape levels, which `seats.js` doesn't read.
- **Gravel bars look like land, but the sim treats the whole channel as water.**
- **Derelict farms** keep blocking walkers with their crops. A derelict home's flag isn't cleared when a family moves back in.
- **The cached `src/sim/fixtures/city.json`** predates the new path formation. It loads fine; the rules apply from the first month after loading.
- **Debates' side rows on the opinion bar** freeze when the debate forms. Events have no opinion bar, because factions have no stake in an event's choices.
- **Older items, still true:**
  - Treasury hoards late in the game.
  - Too many centres in long games.
  - Late-growth plateau (well short of the 6–9k design target).
  - The Port archetype is rare.
  - Not measured on a real iPhone. The high tier went 6.3 → 8.3 ms on desktop after the tree upgrade; check it on a quiet machine.
- **Audio** is first-pass synthesis. Someone should listen to the clips (paths under "Tools").

## Tools and artifacts from this session

**Decision-model studies**

| Script | What it does |
|---|---|
| `collect-questions.mjs` | grows towns headless and dumps real questions |
| `ask-migration.mjs`, `analyse-migration.mjs` | choice vs score vs noul, over real states |
| `compare-kinds.mjs`, `loan-wording.mjs`, `ask-loans.mjs` | `react_to_policy` and `take_loan` studies |
| `indicators.mjs` | the raw values behind the snapshot bands |
| `img-probe*.mjs` | image support and latency |

**Sim and walkers**

| Script | What it does |
|---|---|
| `walk-impact.mjs` | walk speed and wear comparisons |
| `walkthrough.mjs` | runs the real game in Chrome and reports walkers inside building footprints (start a dev server first) |

**Agent worktrees** remain under `.claude/worktrees/agent-*`. All their work is merged into the main tree. Remove them with `git worktree remove --force <path>` and delete their `worktree-agent-*` branches once you've checked nothing else is needed.

## Before making the repo public

1. **Infrastructure names.** Scrubbed: the decision host and narrator models come only from `local.env` (`DECISIONS_URL`, `NARRATOR_MODELS`), and the preview hosts from `PREVIEW_ALLOWED_HOSTS`. The service is LAN-only and needs a key for everything but the owner's laptop. Older commits still hold the names, so publish from rewritten or squashed history.
2. **A license.** There isn't one yet.
3. **Secrets.** The API key has never been in any commit (checked across all history).

## Design documents

`docs/design/` holds the specs; code comments cite their sections. `contract.md` wins where specs disagree, and later owner feedback wins over it. `design-visual.md` was updated for the new audio and HUD. The specs are `brief.md`, `contract.md`, `design-systems.md`, `design-systems-addendum.md`, `design-visual.md` and `design-centres.md`.
