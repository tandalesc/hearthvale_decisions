# Hearthvale rework — shared brief

Project: /Users/shishirtandale/Development/relayer_test_game_20261014 (git branch `evolving-city`). Browser 3D town sim, Three.js r180, Vite, plain JS modules, no framework. Current screenshots: scratchpad/shots/desktop.png and scratchpad/shots/phone.png (same folder as this brief).

## The owner's request (paraphrased closely)
- Game about simulating decisions. Player = "System 2" (deliberative leadership: council choices, policies). Residents/actors = "System 1" (everyday choices, made by a local decision model on our GPU server, see below).
- **Player must NOT place buildings or roads.** Influence only through decisions/policies — no playing god. Remove the build toolbar.
- **Procedural roads, not construction.** Roads emerge along the paths people actually walk (desire paths). Heavy traffic wears trails into dirt roads, then better roads; dense path networks may call for "thoughtful road design" (e.g. a council/institution deciding to pave, plan a grid, build a bridge where crossings concentrate). Roads increase movement speed/efficiency; path-finding weights road cost lower than grass/dirt. Should look organic.
- **Evolving city across ~150 years in ~2–3 hours of play** (5–6 eras; a year ≈ 1 minute at 1×). Buildings become more advanced, taller, more sophisticated over time (upgrade in place, densify, new types).
- **Interface grows in complexity with the city.** Example: lots of farm policies + farming trajectory → council asks to create a separate Agricultural Council that tracks profitability and writes its own policies (which the player then rules on). By the end the player manages a complicated city with numerous policy types and tensions being debated.
- **Snowballing, divergent outcomes.** Early choices compound; the end-state city looks and feels different depending on choices. Achieve this by *composing conditions* rather than strictly defining rules. The decision model lets actors weigh multiple factors at once, so the remaining authored parts are (a) the prompts/questions we scaffold, and (b) the rendering layer. These must be coherent.
- More question types, more reactions, more going on. Currently simplistic and mostly about spawning buildings.
- Graphics: polished, animated, considerate. Pretty eye candy but not AAA. Must run on iPhone 15 Pro and M-series MacBooks without taxing them, with thousands of buildings and villagers. Fix water (reflections, nice shaders). Fix shadow glitches (faces shaded wrong). Handcrafted, beautiful, natural sim with emergent design and behaviour.
- Responsive UI; phones should be able to play.
- Language: plain and very easy to understand, leaning toward simplified technical English (short sentences, one idea per sentence, common words, active voice), but NOT rigid ASD-STE100 — keep transitions, lead-ins and natural, warm prose.
- Sound: procedural WebAudio ambience/UI sounds only this pass (no TTS).
- Old saves may be dropped (new save version).

## Decision service (the "System 1" model)
- Local GPU service: POST {"questions":{"<key>":{"instructions":"plain text","criteria":{"optionKey":"label",...}}}} → {"answers":{"<key>":{"type":"choice","choice":"optionKey","confidence":0.76,"probabilities":{...}}}}. It is a classifier-style chooser: it picks among fixed options given instructions and returns a probability distribution. Max 64 questions per request; ~420–460 questions/sec at saturation. Latency ~150 ms per full batch.
- A separate agent is building a generic "decision bus": a registry of question KINDS (each with fixed criteria options, a validated numeric/enum context schema, and an instructions template), micro-batching to 64, several requests in flight. Any non-player actor can ask: residents, households, enterprises, institutions, factions. The model must never make the player's decisions; it can make actors' decisions and draft proposals that the player rules on.
- Budget: ~400 questions/sec total. With thousands of residents use cohorts (shared context keys) and sample from returned distributions.

## Current codebase (what exists)
- src/simulation.js: serializable state {day, treasury, businessCash, food, goods, debt, investor tranches, happiness, policy{tax, growth}, buildings[], projects[], people[], decisions[], history[], ledger, stats}. 6 real seconds per day at 1×. Building types: home, farm, market, park, utility(workshop), road, bridge. Economy: wages, income/property tax, consumption, food/goods production, upkeep, loans/investors. Council proposals: only 4 kinds (housing, river, food, debt), one every 12 days. Resident cooperatives auto-fund homes/farms/markets/workshops every 3 days. Construction with builders walking to sites.
- Residents: needs (energy, fullness, social), tasks (work/rest/shop/leisure/build), A* routes (road cost 0.55, off-road 1.2) in a worker.
- src/world.js: renderer (ACES, PCFSoft 2048 shadow map, static shadow refresh, sun fixed at origin), procedural low-poly buildings merged into static batches, instanced trees and people with LOD, terrain chunks 100×100 with vertex colors, river (flat strip + clearcoat, no reflection), smoke, birds, windmill, fountain, dusk toggle, land-value/pollution overlays.
- src/main.js: one innerHTML template UI: top bar metrics, Council/People/Economy tabs, activity feed, view tools, time controls (pause/1×/3×/8×), build toolbar (to be removed), settings modal (save/export/import/model status).
- src/style.css: warm paper palette (--paper #fafbf2, --ink #334533, --green #526d42), DM Sans/Manrope, grid layout, breakpoints 1200/1000/720/420 px.
