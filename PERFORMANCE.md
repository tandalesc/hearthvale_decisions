> **Historical.** This describes the game before the evolving-city rework (16-question batches, one request in flight, placed buildings). For current numbers and design, see HANDOFF.md.

# Hearthvale performance pass

The game now reuses validated activity distributions, schedules navigation away from input/render work, and batches the town and its residents. The measured 1,000-resident crowd workload renders about three times faster. These results are a local comparison, not a hardware FPS guarantee.

## Measured rendering comparison

Chrome headless on macOS, SwiftShader software rendering, 1164 × 703, device pixel ratio 1, unchanged resolution and camera. Local AI was disabled to isolate simulation/render cost. A fresh browser context loaded the same deterministic crowd fixture for each population. Each run waited 500 ms, then sampled up to 45 animation frames over roughly four seconds. The short sample sizes make these directional measurements rather than a statistical performance guarantee.

| Residents | Median frame before | Median frame after | p95 before | p95 after | Draw calls before → after |
| --- | ---: | ---: | ---: | ---: | ---: |
| 28 | 166.1 ms | 115.9 ms | 173.5 ms | 124.5 ms | 682 → 161 |
| 250 | 219.9 ms | 153.7 ms | 224.1 ms | 160.1 ms | 2,236 → 161 |
| 1,000 | 417.8 ms | 137.8 ms | 424.8 ms | 157.5 ms | 7,486 → 154 |

At 1,000 residents, median frame time fell 67%; draw calls fell 98%. A programmatic pause handler followed by the next animation frame took 508.7 ms before and 138.4 ms after. This measures handler-to-next-frame turnaround, not complete physical input latency. The final worker diagnostics reported all 1,000 initial route requests completed and no pending callbacks.

The fixture deliberately puts extra residents into the original town, exceeding ordinary housing capacity. It isolates resident load rather than simulating a mature economy or sprawling map. At this zoom, all 1,000 figures used simplified animated silhouettes; the 28- and 250-resident runs retained detailed figures. Near residents and active builders retain the detailed model. Software rendering remains slow in absolute terms; large cities, many simultaneous construction sites, and other GPU/browser combinations need further profiling.

## Adaptive model policy

- **Automatic measured-throughput pacing** replaces the original fixed 100-question/sec limit. One network batch runs at a time, with at most 16 questions (also enforced by the server). Batch size targets about 250 ms from an exponential moving average of end-to-end milliseconds/question, halved under >25 ms frame work. Idle time is response duration × (1 − utilization) / utilization, default utilization 80%. The first estimate is 40 ms/question; measured responses replace it gradually. Network admission is checked each animation frame independently of the 100 ms cohort-sampling timer. Rendering cadence, actual demand and cohort coverage can keep achieved throughput below estimated capacity. Manual mode adds a rolling 1–2000 question/real-second ceiling; it never promises that throughput. Cohort identity is independent of the budget.
- Villages of at most 100 residents use individual context keys. Larger villages share by needs bands, savings band, bank/district, routine phase, food/wellbeing pressure, tax and accessible activities. This is approximate context sharing, not proof that all villagers have identical preferences.
- The adapter now retains the service's observed `probabilities` map. Valid high-entropy answers can be used even when the winning activity has confidence below 0.45. Invalid mass, unknown activities and malformed maps are rejected. Legacy winner-only replies remain individual and are never invented into a shared distribution.
- Each resident samples independently and deterministically from the compatible distribution, masking unavailable activities. Builders bypass routine decisions; critical hunger/energy needs use the appropriate available local action. Assignments are stable within a day/context, rather than rerolling on every render frame.
- Unknown/stale contexts receive coverage first. Large uncertain cohorts refresh sooner, using entropy and observed changes between returned distributions. Repeated queries do not establish a claim of improved model accuracy.
- The cache holds at most 512 distributions, valid for at most 12 real seconds and two game days. Changed constraints create a new key. Stale replies and replies from before disabling/resetting the policy cannot apply. Network failures back off while local rules continue.
- Settings shows session model-question and sample counts, context count and coverage. Read-only `window.hearthvale.view()` exposes frame work, navigation mode/queue/cache counts and render batches; `routineStatus()` exposes policy counters. The API key stays on the local Node server.

A deterministic test served 1,000 compatible residents from one returned distribution, producing all four activity choices with separate resident samples. A browser scenario also exercises shared sampling and the request ceiling with a mocked probability response; a separate browser case verifies live local-service application.

## Navigation and simulation work

The synchronous reference benchmark's first step took 174.81 ms for 28 residents, 1,257.50 ms for 250, and 5,044.47 ms for 1,000. Those bursts initialized all routes on the calling thread.

Browser route searches now run in a dedicated worker. A* yields every 32 expansions; worker work is sliced, the main thread admits at most 128 pending callbacks, and route requests coalesce/reuse up to 256 cached paths. Topology changes invalidate cached paths. Results apply only to the still-current actor task. A failed/unavailable worker uses cooperative 2 ms planning slices on the main thread.

An 80-step cooperative fallback run at 1,000 residents had a 1.79 ms first step and a 3.91 ms maximum step. **Work was deferred:** 128 callbacks were still pending at the end of that short CPU run. This demonstrates bounded interactive steps, not an equivalent-work throughput speedup. A separate fallback regression runs the queue until residents move and checks collision safety.

Building/type lookups, household property values and daily counts are indexed/cached by spatial revision. Builder assignment avoids sorting the whole population and repeated resident scans. Pending navigation tasks are safely replanned on save/reload.

## Rendering changes

Detailed villagers share eight instance batches. Tiny crowd figures use a separate animated silhouette batch with hysteresis around the detail threshold. Frustum checks omit off-screen figures. Instance buffers grow geometrically and upload only the used range.

Static building/road surfaces merge by material, shadow mode and 100-unit region. Source geometry remains available for accurate picking. Windmills, smoke, fountains, windows, construction animations and overlays remain active. Static shadow maps are reused; construction shadows refresh at a bounded cadence. These changes do not reduce canvas resolution.

## Reproduce and inspect

Start `npm run dev -- --strictPort` in a terminal with access to the local decision service. Then:

```sh
npm test
npm run build
npx playwright test
node scripts/benchmark-simulation.js
node scripts/benchmark-simulation.js --budgeted
BENCH_LABEL=repeat node scripts/benchmark-browser.js
```

The browser benchmark uses local Chrome (or `CHROME_PATH`) with SwiftShader. It writes its JSON and screenshots to `/tmp`; the simulation benchmark prints JSON. Benchmark fixtures use isolated browser contexts and never replace the user's actual saved town. `scripts/load-fixture.js` documents the dense-crowd fixture. Absolute timing varies with hardware and concurrent load.

Validation: 43 Node tests and the production build pass. All ten Chrome scenarios passed across the complete suite and targeted reruns, including the 1,000-resident mocked-cohort case, real local-service application, and navigation with workers disabled. Raw measured JSON is saved in `benchmarks/`.

## Accelerated simulation correction

A deterministic delayed-route reproduction found that renewing the same work intent on the next game day replaced all 28 pending tasks and doubled route submissions from 28 to 56. Task revision included the intent expiry date. Faster game days amplified unnecessary route cancellation, independently of model throttling or probability sampling.

Routine advice now applies at natural task boundaries. Renewal, changed advice and expiration preserve pending routes and ongoing trips; critical needs and builder assignments can interrupt. Deterministic regression coverage checks repeated renewals and alternating advice across seven days, then expiry and natural task completion. Simulation and route planning continue independently of AI request admission.

Server admission now bounds concurrency instead of enforcing the old arbitrary QPS ceiling. Busy responses carry a 250 ms retry; the client does not turn this into a 15-second outage. Failed requests release the policy slot and retry after one second without contributing successful-throughput samples. Completed throughput includes valid HTTP responses even if their game-day snapshot has aged out; that separates service performance from useful decision coverage.

Settings → Decision pacing exposes automatic/manual modes, 25/50/80/100% service utilization, and an optional manual ceiling. Observed completions use a trailing five-second window; capacity is an estimate from response costs, not a guaranteed service rate. The resident breakdown distinguishes route waits and blocked paths from travel and time spent at activities. Preferences persist in local storage.

The controller is single-flight and approximate. It does not infer unlimited service capacity, guarantee full AI coverage at 8×, or synchronize utilization across multiple browser tabs. A shared busy server asks competing clients to retry. Existing crowd GPU benchmarks above remain historical measurements of the prior rendering pass, not new FPS claims for this correction.

Verification for this correction: 46 Node tests and the production build pass. All 12 Chrome scenarios passed; after separating network admission from the sampling timer, the four affected AI scenarios were checked again (live service, 1,000-resident cohort sharing, delayed 250-resident playback at 8×, and 1×/3×/8× plus busy recovery and persistent mobile controls). The playback test compares existing resident IDs so village growth does not invalidate its movement measurement. Sampled resident counts include legitimate activity time and occasional blocked routes; these are not classified as model throttling.
