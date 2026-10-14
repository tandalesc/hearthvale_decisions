# Hearthvale

A playable browser-based 3D town simulation. You are the deliberative leadership (System 2); residents carry out everyday routines (System 1) under your policies.

## Run

```sh
npm install
npm run dev
```

Open http://127.0.0.1:5173. Requires a browser with WebGL 2. No API key is required for the current local-rules simulation. `npm run build` produces the production bundle in `dist/`.

## Play

- Orbit by dragging, pan with right-drag, zoom by scrolling. The home button returns to the village. On touch screens use one finger to orbit and two fingers to pan/zoom.
- Pick a cottage, farmstead, market, garden, workshop, lane or bridge in the bottom toolbar; click terrain to commission a construction site. Builders travel with supplies, work on the site and finish the building. Capacity and jobs become available only at completion. Escape exits construction mode. The footprint preview turns red when the whole plot cannot fit. Bridges must cross water; other structures cannot occupy the riverbed, another plot or very steep slopes. On narrow phones, swipe the building toolbar sideways to reach all tools.
- On phones and tablets the council starts collapsed to give the town room. Use the Council button to open or close it. The council asks for housing, riverside development, food security and debt-policy decisions. Choosing spends the stated amount and creates actual buildings or changes policies.
- Set household income tax and autonomous building policy in People. Click a building to inspect its location's value and upkeep.
- The map button cycles through land value and pollution overlays. The sun button changes the lighting to dusk.
- Pause, 1×, 3× and 8× change time. A day lasts six real seconds at 1×. Space toggles pause outside form controls.
- Settings offers local save, JSON export/import and a confirmed new-town reset. Autosave runs every 15 seconds. Saves are device/browser-local, not cloud saves.

## Model implemented

`src/simulation.js` owns serializable state and deterministic transitions. Rendering in `src/world.js` and player controls in `src/main.js` consume that state.

**System 1:** residents rest, work, shop and visit gardens. Residents cross the river using a bridge rather than knowingly walking directly through water. Growth is capacity-, food- and happiness-dependent. Residents maintain individual tasks, walk to destinations, spend time working/shopping/resting and replenish basic needs. They do not all abandon their task on a shared short schedule. Resident cooperatives check housing, food and job demand every three days; they fund cottages, farms, markets or workshops from pooled savings while leaving each household a cash reserve. Construction has real worker assignments and progresses only when builders reach the site. Growth policy can stop new private projects. Existing funded commitments continue. A running new town typically begins its first private cottage near day 3; scarcity or low savings can delay later projects. Valid local model activity choices can guide routines, with builders taking priority.

**System 2:** council proposals are generated from town conditions. The player resolves them, sets tax and building policy, and approves financing. The game never delegates leadership decisions to an LLM.

**Placement and movement:** `src/spatial.js` shares full plot bounds between placement, terrain grading and collision checks. Buildings and construction sites retain a foundation height, flatten a generous pad, and blend back into the natural slope. Road strips follow graded terrain; bridge approaches ramp to deck height. `src/navigation.js` uses road-weighted A* with diagonal corner checks and sampled segment clearance. Residents approach accessible points outside plots, replan when construction changes obstacles, and wait when no route exists. Completed bridges are the only river crossings. Version-1 saves receive foundation metadata and discard legacy direct routes without moving existing buildings. This is obstacle avoidance for structures, not crowd separation between villagers.

**Interface:** a shared spacing scale and CSS grid reserve independent header, scene, council, time, building-tool and notification regions. Panels scroll internally; narrow layouts use an on-demand council and a horizontally scrollable tool strip. Camera framing responds to measured scene space. World labels project after camera updates, ease into place, separate overlapping active sites and hide behind panels or beyond safe bounds. Routine counters update in place, preserving policy focus and panel scroll.

**Land:** deterministic hilly terrain is generated in 100-unit chunks around the camera. A winding river creates sandy banks. Waterfront proximity, terrain/nature, parks and commerce raise land value; workshops lower it through pollution. There is no separate ocean or beach biome yet. The assessed value contributes a small daily property tax per resident. Existing buildings do not yet upgrade automatically with rising value. Terrain chunks are regenerated deterministically and evicted when far from the camera. Forests use instanced geometry; construction clears surrounding trees. The closer camera, human figures with walking/work animations, detailed buildings, dynamic water, smoke, windmill, fountain, birds and dusk lighting make the village easier to read.

**Economy:** households receive wages from business reserves, pay income/property taxes to the treasury and spend money back into businesses. Public upkeep and construction transfer treasury money to businesses. Payroll is capped by business reserves. Farm/workshop output depends on employment and funded payroll. Food is consumed daily; insufficient reserves lower happiness and prolonged starvation causes residents to leave. Jobs and production are aggregated, not individual business accounts or physical shipments. Goods inventory is tracked but its scarcity does not yet constrain purchasing.

**External flows:** migrants bring savings and emigrants take savings away. Food imports remove money. Loans bring external cash, then remove daily interest (0.08% of balance) and principal (0.2%). Investors supply cash for a permanent 15% share of tax revenue per tranche after 90 days; each tranche has its own grace period. Up to 45% revenue can be assigned. Sandbox infusions create external money with no penalty. Public funds can go negative through upkeep; construction then requires sufficient cash. There is no automatic bankruptcy resolution yet.

**Scale:** no fixed population or map-size cap is imposed. Rendering batches static town surfaces by material/region, uses instanced residents with animated detail scaling, and reuses static shadows. Navigation runs in a bounded worker queue with cooperative fallback and route reuse. Daily property values, building types and resident lookups are indexed. A fixed-geography 1,000-resident crowd benchmark reduced median frame time from 417.8 ms to 137.8 ms in Chrome/SwiftShader at 1164 × 703; it exceeds normal housing capacity and is not a mature-city or hardware FPS guarantee. The full economy still runs on the main thread and JSON/browser storage have practical limits. See [PERFORMANCE.md](PERFORMANCE.md) for measurements, quality tradeoffs and reproduction commands.

## Local rrh-llm-1 service

The game now uses `http://rrh-llm-1:4000/v1/decisions` from its **local Node server**, not from a hosted backend or directly from the browser. The supplied hostname resolves on this local network. Loopback addresses remain configurable for other installations, but they refer to the computer running the game server, not automatically to the named LAN machine.

`server/system1.js` loads `API_KEY` from `local.env`. It is excluded from Git and blocked from browser access, including encoded paths. The key is never placed in a `VITE_` variable, client bundle, game save or diagnostic response. `RRH_DECISIONS_URL` can select the named rrh-llm-1 host or loopback. No arbitrary remote host or credential-bearing URL is accepted.

The live service was inspected locally: `/openapi.json` returned 200; `GET /v1/models` authenticated using the raw key in `x-litellm-api-key`; `POST /v1/decisions` accepted a dictionary of named questions, each with `instructions` and a `criteria` map. A test returned `work` with confidence 0.9883, and the game applied a live batch of 16 intents. The returned model alias is `ramblerun/Decision-AI`; the underlying model weights are not independently verified.

The verified request shape is:

```json
{"questions":{"resident_35":{"instructions":"Choose an everyday activity...","criteria":{"work":"Go to work","rest":"Rest at home","shop":"Visit the market","leisure":"Visit a garden"}}}}
```

The response shape is `{"model":"ramblerun/Decision-AI","answers":{"resident_35":{"type":"choice","choice":"work","confidence":0.9883}}}`.

The browser sends at most 16 context representatives per batch, with one batch in flight on both client and server. Automatic pacing measures end-to-end batch response time, learns milliseconds per question, adapts batch size toward 250 ms of work (smaller under frame pressure), and inserts idle time for the chosen service utilization (80% by default). There is no fixed 100-question/sec ceiling. Settings also offers a manual rolling real-time ceiling of 1–2000 questions/sec; concurrency and batch limits still apply. Settings shows observed completions over five seconds, estimated capacity, response latency, AI pacing/retry state, and residents travelling, active, routing or blocked. Small towns use individual context keys; larger towns share distributions by needs, savings, location, accessible activities and town constraints. Each villager samples independently. Unknown/stale contexts get coverage first; uncertain/changing large cohorts refresh sooner. Critical needs and builders use local priorities. Cached distributions have bounded size and age; changed constraints or disabled/reset policy prevent stale application.

The service returns a `probabilities` map alongside its winning choice. Valid probability maps are retained even when winner confidence is below 0.45. Malformed maps and unknown activities are rejected; legacy winner-only responses still require 0.45 confidence and remain individual. Masked activities are rechecked before sampling. Only work/rest/shop/leisure are permitted; model choices cannot spend money, construct buildings, change policy, or resolve council proposals.

Requests time out and back off on failure while local routines continue. Settings shows context coverage, session question/sample counts, the model-routine toggle and authenticated connection check. The key stays on the local server. The adapter also works with Vite preview. The local Node process needs LAN access to reach rrh-llm-1.

## Verification

```sh
npm test
npm run build
# start npm run dev in another terminal first
npx playwright test
```

The Node tests cover initialization; construction money conservation and placement constraints; property values; daily money conservation; reserve-limited payroll; loan service and investor tranche timing; one-time council resolution; unaffordable proposals; save validation; and a 600-day finite-state run. Additional tests cover builder travel and completion, construction funding, autonomous housing/business development, server credential handling, endpoint restrictions, authenticated status, the verified API contract, intent validation, timeouts and separation from leadership decisions.

Chrome browser tests cover council choices, financing confirmation, taxes, growth policy, click-to-build, overlays, save/reload, desktop errors and mobile controls/overflow, council visibility at 1164×703, private-file blocking, the connection status/retry UI, actual resident construction and live local-model intent application. Chrome is automatically used on macOS when installed. Else install Playwright Chromium (`npx playwright install chromium`) or set `CHROME_PATH` to a local Chrome executable. The test runner assumes the local dev server is already running. Set HEARTHVALE_TEST_URL to test another local port (for example http://127.0.0.1:5174). The live model test requires the local service and key; ordinary UI tests disable model calls for deterministic checks.

Desktop, phone, compact and landscape layouts are checked in the browser. Very large city performance and physical traffic/logistics remain unverified; live local model decisions are verified on the supplied host.

## Implementation reference

3D rendering uses the official [Three.js WebGLRenderer](https://threejs.org/docs/pages/WebGLRenderer) and [OrbitControls](https://threejs.org/docs/pages/OrbitControls). All terrain, buildings and foliage are generated with geometry; no raster assets are required. Fonts use Google Fonts with system fallbacks.

Spatial regressions additionally check full foundation margins on slopes, road cross-sections and bridge ramps, dry-land footprints, building detours and diagonal corners, incomplete bridges, newly blocked routes, safe resident positions during development, and legacy save migration. Browser checks measure non-overlapping interface regions at 1440×1000, 1164×703, 1024×600, 768×1024, 390×844, 320×568 and 844×390, plus stationary construction labels and policy focus/scroll across simulation updates.

Performance regressions cover independent shared-distribution sampling, context/constraint changes, stale and malformed replies, adaptive batch sizes, cache limits, adjustable rolling ceilings, throughput adaptation, busy-service recovery, accelerated-speed trip preservation, one in-flight server batch, sliced A*, worker-disabled navigation, pending-task restore and pickable static batches. The heavy-crowd browser scenario uses a mocked distribution; the separate live-model case still calls the supplied local service. Benchmark JSON snapshots are in `benchmarks/`.

Routine renewals and changed or expired AI advice no longer cancel current travel or activities. New advice is used at the next task boundary; critical needs and construction can interrupt. AI cooldowns never pause simulation or local routines. Server-busy replies retry after 250 ms; outages after one second. Settings pacing preferences persist independently of town saves.
