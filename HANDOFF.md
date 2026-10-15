# Hearthvale — handoff (evolving-city rework)

Repo: `github.com/tandalesc/hearthvale_decisions` (private for now). `main` and `evolving-city` point at the same commit. The original game is the first commit (`c1ca36a`, "Baseline").

State at handoff: `npm test` passes 223/223, `npm run build` is clean, and the game boots on the real 3D renderer.

## What the game is now

The player is the town's deliberative leadership ("System 2"). They never place buildings or roads. They rule on docket cards and shape the Rule Book. Everyone else acts on their own ("System 1"): residents, households, businesses and institutions decide through a local decision model, with local fallback rules when it's unavailable.

- **150 years in about 2.5 hours at 1×.** A tick is 100 ms, a month 5 s, a year 60 s. Six eras: Hamlet, Village, Town, Borough, City, Metropolis. Eras are reached by conditions, with time floors and ceilings.
- **Composable conditions, not rule chains.** Traits with momentum (agrarian↔industrial, communal↔market, tradition↔innovation, local↔planned) and pressures (river trade, faith, learning, ecology, health, unrest, prestige) build up from rulings and actor behaviour. Everything that unlocks (cards, institutions, events, building styles, archetypes) uses a small condition DSL (`src/sim/conditions.js`).
- **Institutions emerge and petition to exist** (Agricultural Council, Guild, Exchange, River Authority, School Board, Parish, Health Board, Planning, Union, Watch, Arts Society, ward councils). Each has its own dashboard, docket asks, budget, patience and rivals. They can be delegated to, given standing orders, or dissolved.
- **Organic roads.** Walking wears a grid (2-unit cells, 384²). Wear upgrades cells from trail to track to road; paving and avenues come only from approved works. Fords, footbridges (built by households), council cart bridges, upgrades by traffic and wear, collapses and rebuilds.
- **Growth.** Lots follow worn paths, homes upgrade in place across era style packs, terraces merge, and waterfront buildings stand on piles or quays. Bid-rent pressure moves businesses out of expensive centres. Several centres can grow into downtowns with ward councils, and they can merge, federate or stay apart.
- **Language.** All player-facing text follows the plain, warm house voice (`src/sim/text/voice.js` lints it).

## Decision model (rrh-llm-1)

- Our Vite plugin `server/system1.js` proxies `POST /api/decisions` to `http://rrh-llm-1:4000/v1/decisions` and `/v1/decisions/batch`. The API key is read from `local.env` on the server only, sent as `x-litellm-api-key`, and never reaches the browser.
- Request shape: `{groups:[{state, questions:[{kind,id,context,allowed?}]}]}`. Kinds are registered in `src/decision-kinds.js` (23 game kinds from `src/sim/decisions/kinds.js`, plus `routine`).
- **Two facts about the service, learned the hard way:**
  1. It now rejects a request that has **no `state`** (413 "state too large"). We always send at least `{}`.
  2. It batches **up to 64 questions per request**. `MAX_QUESTIONS_PER_REQUEST = 64` on both client and server.
- The service's state cache uses GPU memory. When it was raised to 4,096 entries, every *new* state started failing (413, or a 500 AcceleratorError) while cached ones still worked. Fixed by restarting the service with a smaller cache.
- Population decisions use **overlapping slices** (district, trade, wealth band, life stage, …). Each slice's distribution is averaged per person (a linear pool, never a product: `src/decision-pool.js`). Leftover throughput is spent on **refinement** where slices disagree (Jensen–Shannon × group size), and on individual questions for small or high-stakes groups.
- The client (`src/decision-client.js`) coalesces questions, groups them by state, keeps 1–4 requests in flight (hill-climbing), and backs off on 429/503. Questions that fail resolve to `null`, and local rules take over.

## LLM prose (narrator)

`server/narrator.js` exposes `POST /api/narrate` and streams from `ramblerun/Reasoning-AI`, with `chat_template_kwargs.enable_thinking: false` (without it the model returns empty content); it falls back to Multimodal-AI. It writes inspector notes for people, buildings, households and bodies, card prose ("why now" plus option trade-offs in the asker's persona), year-end chronicle lines, and the end-of-chronicle page.

- The server validates every reply: no invented numbers, names or places, no effect reversals, no officialese. Anything that fails falls back to the template text.
- Notes are cached by a *material* facts key and saved with the game (`state.notes`).
- **UI rule:** a note never changes under the reader. A quiet refresh icon lights up when the facts change; only a click regenerates.

## Module map (who owns what)

| Area | Files |
|---|---|
| Sim core | `src/sim/{index,state,clock,rng,hooks,conditions,pressures,eras,economy,households,enterprises,land,people,serialize,fixtures,render-view,notes}.js` |
| World | `src/sim/{world,roads,sites,districts,buildings,works,bridges,centres}.js`, `src/navigation*.js`, `src/route-planner.js`, `src/terrain.js` (seeded valleys, fords, hills, mountain ring) |
| Governance | `src/sim/{governance,policies,institutions,docket,subjects,events,factions,chronicle,view}.js`, `src/sim/decisions/*`, `src/sim/text/voice.js` |
| Decisions | `server/system1.js`, `src/decision-{kinds,client,pool}.js`, `src/routine-policy.js` |
| Narrator | `server/narrator.js`, `src/narrator-client.js`, `src/narrative-{schema,prose}.js`, `src/sim/narrative-facts.js` |
| Renderer | `src/render/**` (Three.js r180). A single ground-height texture drapes everything; instanced kit buildings with era style packs; GPU-animated villagers (20-float rows); water ribbon with reflections on high; quality tiers; reduced-motion support |
| UI | `src/ui/**` (no framework), `src/main.js`, `src/audio/**`, `src/save-store.js` |

The sim is deterministic: one seeded RNG, and model answers are applied in key order and logged. Save → restore → continue is byte-identical, and tests check it. Rollover work runs as queued jobs (one per tick) so no tick spikes.

## Saves

The town is saved to **IndexedDB, gzip-compressed** (`src/save-store.js`). `localStorage` filled up on `localhost:5173` and saves failed silently, which made old docket cards keep coming back. An old `localStorage` save is migrated once and deleted. Saving happens 0.4 s after any ruling, every 30 s, when the tab is hidden, on pagehide, and before Vite reloads the page. Only the newest tab writes (BroadcastChannel lock).

## Running and checking

```sh
npm install
npm run dev                      # http://127.0.0.1:5173 (?fixture=hamlet|town|city loads a test town, not saved)
npm test                         # 223 node tests
npm run build
node scripts/boot-check.js       # loads the game and fails on any renderer error
node scripts/balance.js          # headless balance harness (styles × seeds); runs from a frozen copy of src/
node scripts/render-check.js     # screenshots + draw-call/frame stats per fixture and tier
node scripts/benchmark-decisions.js   # live decision throughput (needs LAN access to rrh-llm-1)
npx playwright test              # browser suite (start the dev server first; run with workers=1)
```

## Known gaps and judgement calls

- **Riverbank mismatch, left as is on purpose.** A towpath cell at the water's edge counts as land for navigation while `waterAt` says it's ~0.1 units into the river. The walker test tolerates 0.15.
- **Treasury hoards late in the game.** A real year-169 save held about 1.9 million coin (+286k a year). Early-game spending was fixed; late-game spending wasn't.
- **Too many centres in long games.** That same save had 7 towns in the valley, against a target of 2–5.
- **Bridge load timing.** The first upgrade card comes 15–29 years after a bridge opens (median ~19). Fast-growing towns fill bridges in ~10 years; some bridges never fill because their traffic stays flat.
- **Late growth plateau.** Balanced towns reach ~4,300 people at year 100 and level off (~4,100 at year 140), short of the 6,000–9,000 design target.
- **Port archetype** rarely appears; mercantile play usually becomes an Exchange town.
- **Not measured on a real iPhone.** Frame numbers come from desktop Chrome (Metal) with phone sizes emulated: city at medium is ~3 ms per frame at phone size and ~6–7 ms at desktop size, 50–57 draw calls.
- **Live-dev hazard.** Agents edited the same tree the owner was playing. Multi-file edits briefly broke the 3D view several times. For future parallel work, edit in a separate worktree and apply finished diffs in one step.

## Recent fixes (the end of the session)

- **Bridges:**
  - Capacity is sized per bridge from its own early traffic, so timber wears out over decades.
  - Upgrade cards come 15–29 years after a bridge opens.
  - A bridge that collapses closes until it is repaired or rebuilt (`collapseBridge` / `rebuildBridge`).
- **Duplicate questions:** every card has normalised subjects (`src/sim/subjects.js`). A subject that is open, under way or cooling down is never offered again, whatever its source.
- **Tick spikes:**
  - Yearly world work runs one step per tick.
  - Business founding runs one attempt per tick.
  - New businesses reuse one site search per type each year, stored in state so replay stays exact.
- **Decision service:** requests always carry a `state`, and each request holds at most 64 questions.

## Before making the repo public

1. **Infrastructure names.** The code and docs name `rrh-llm-1:4000` and the `ramblerun/*` models. The decision endpoint answered requests with no key during testing, so either confirm the service is reachable only on the LAN, or make the host configurable-only and scrub the names.
2. **A license.** There isn't one yet.
3. **Secrets.** The API key has never been in any commit (checked across all history).

## Design documents

`docs/design/` holds the specs that guided this work. Code comments refer to their sections (e.g. "design-systems §6.2").

| File | Contents |
|---|---|
| `brief.md` | The owner's original request |
| `contract.md` | The integration contract. It wins where the specs disagree, but later owner feedback (above) wins over it. |
| `design-systems.md` | Systems and policy design |
| `design-systems-addendum.md` | Revisions to the systems design |
| `design-visual.md` | Art direction, rendering and UI |
| `design-centres.md` | Multiple centres |
