# Hearthvale: taking it to the next level

A review of the repository at `a55ce09` (27 October 2026). Five Haiku explorers mapped the decision student, the narration and notes students, the hosted backend, the UI and the sim; two Opus reviewers wrote the ML and UX assessments; the claims below that matter most were checked by hand against the source. Effort: S is a day or less, M is 2 to 5 days, L is a week or more.

## The ten moves that matter most

| # | Move | Why | Effort |
|---|---|---|---|
| 1 | Fix four verified UI bugs (Space can approve a card; keys 4/5 silently drop free players to 1×; Plus players lose the facts toggle; the town's name is hardcoded in three places) | Shipping defects, each under an hour | S |
| 2 | Re-featurize the decision student: parse site, plan and summary prose into triples (A1) | 2,359 of 2,809 vocabulary values are prose strings; value embeddings are 74% of the model, and most of it memorises one-town text that is unknown in any new town. This is why `choose_site` is the worst kind (KL 0.077) | M |
| 3 | Ruling receipts, consequence follow-ups and a "Your rulings" ledger (UX §2) | The sim already records helps, hurts, stances, outcomes and `b.origin.card`; almost none of it reaches the player. Cheapest way to make rulings feel consequential | S + M + M |
| 4 | Per-agent persistent random draws (A2) | People act in character over time at zero ML cost, every gate stays exact by construction, and paired evaluation gets 2× or more tighter | S–M |
| 5 | A designed first 15 minutes (UX §1) | No tutorial; a new player sees an empty HUD and a card that can sit for four minutes | M |
| 6 | Find out what Plus players actually see, then raise Haiku's yield (B1, B2) | Only 24% of batch Haiku card attempts pass the checks, and Plus Quality falls back to the student. Plus cards default to student-first (`prefer: 'fast'`) | S |
| 7 | Fold each past ruling into one memory token and emit derived "when" facts as role tokens (B3, B4) | Rulings and their timing are now the largest narration fault (54 to 66 of ~165 fact-fails); the one binding fix that worked (stance-who) generalises | S–M |
| 8 | Make the learning loop safe to publish on its own (C) | Never run end to end; the trainer verifies its own report; no rollback; the population gate rejects ~a third of neutral candidates | M |
| 9 | The end page at year 150, as a page and a share link (UX §9) | `endSummary` builds the whole payoff and `unlocks.endPage` is set, but no UI reads it | M + M |
| 10 | Offline PWA with self-hosted fonts and a maskable icon (UX §6) | Everything already runs locally; there is no service worker, and fonts load from Google | M |

## Same-day fixes (verified in source)

- **Space can approve a card.** `docket.focus()` ([docket.js:169](../src/ui/components/docket.js)) focuses the first option button. The global Space handler skips focused buttons ([app.js:1024](../src/ui/app.js)), so the browser presses it. Focus the card title (`tabindex=-1`) instead, and treat Space as pause whenever focus is inside `.options`.
- **Keys 4 and 5 drop free players to 1× with no message.** `entitledSpeed` returns 1 for a speed outside the tier ([entitlements.js:4-7](../src/entitlements.js)); clicking a locked menu item does nothing ([time.js:58](../src/ui/components/time.js)). Keep the current speed and say "10× is part of Plus".
- **Plus players can't return from the quote to the facts.** `allowSummaryToggle: !isPaid(...)` ([card.js:162](../src/ui/components/card.js)) hides the toggle for the people who pay.
- **The town's chosen name is ignored** at app.js:568, chronicle.js:17 and popover.js:47.
- **`siteText` truncation.** `.slice(0, 80)` at [sites.js:1148](../src/sim/sites.js) cuts ", by the river" to ", by"; the teacher and the student both see the cut text (7 vocabulary values are affected).

## A. Decision student

- **A1. Stop feeding prose as opaque tokens (FEATURES_VERSION 2).** `PROSE` in [decision-features.js:13](../src/decision-features.js) makes each site string, plan string, summary and type one lowercased token. `siteText` is a fixed band template; parse it back into triples (`site:a access lane`, `site:a landValue high`, ...) and fold each site's band embeddings into its option token, as stance-who did for narration. Put a `<district>` placeholder where a place name appears in plans and summaries, or pass the catalogue template id; split "X, or Y" into two triples. Stored rows keep `context`, so the corpus re-featurizes for free; it needs a from-scratch retrain. *Validate:* `choose_site` KL below 0.04 and `institution_draft` below 0.02; per-kind unknown rate; share of novel reports by kind; vocabulary size; all existing gates. Add a parse → re-render round-trip test so the teacher's text is unchanged. *Effort M, risk medium.*
- **A2. Persistent per-agent random draws.** `decide()` in [hooks.js:103](../src/sim/hooks.js) samples from the shared RNG. Draw `u = Φ(z)` with z an AR(1) Gaussian per (agent, kind), seeded by hash(seed, agentId, kind), ρ ≈ 0.9 per game year; order each kind's options on a designed axis (cautious → bold, idle → industrious). Marginals stay Uniform(0,1), so every answer-level gate is unchanged by construction, but a household keeps choosing like itself (the README's quick-mind idea), and the same mechanism gives common random numbers: today towns diverge once ~2.5% of answers differ (v8 763 vs v7 462 on the same canaries). *Validate:* per-agent choice autocorrelation target 0.5–0.8; exact unchanged-marginals test; canary gates; the 16-town paired log-ratio standard error should at least halve. *Risk:* correlated draws can change dynamics; rerun the 24-run study once, and the town-hash fixtures change once.
- **A3. Root-cause the 1.54× year-150 spread with DAgger on the runaway runs.** No teacher run of that town passes 3,000 people, so states above it are labelled nowhere. Regrow the two runs that pass 9,000, label years 100–150, compare per-kind KL on those states. Suspects: `migration_wave` (feedback through prestige), `household_stay_move` in big towns, enterprise kinds, `choose_site`. Add a gate: no canary's final population above 2× the current version's maximum. *Effort M.*
- **A4. Realism gates beyond KL.** Per kind, a responsiveness ratio (std of student p(option) across contexts ÷ teacher's) within [0.7, 1.3]; about 40 designer-written direction tests run on student and teacher (higher rent → more emigrate; poor food → more shop; more grievance → more solid strikes). Evening work already moves only 0.40× as far as the teacher's. *Effort S.*
- **A5. One teacher.** The cloud loop trains on hosted d1 rows but gates on d1-3B-labelled sets, so the two KL gates pull against each other. Relabel the 460,701 core questions with hosted d1 (~$3), measure KL(d1-3B ‖ d1), train v9 on d1. *Precondition:* [label.js:40](../cloudflare/training/label.js) requires full `probabilities`; confirm hosted d1 returns them, or the cloud loop labels nothing. *Effort M.*
- **A6. Better confidence.** Add log training-frequency of each triple's value (min and mean) to the error head; per-kind conformal thresholds instead of one global p95; optionally three decision layers on the shared embeddings with disagreement as the signal (+26K params, within the 400 µs gate). *Target:* recall of the worst 5% at a 5% flag rate from 46% to ≥65%, also on the 397 strike rows. *Effort S–M.*
- **A7. Strike coverage.** Twelve canaries asked zero strike questions. Add a forced-strike canary and make "active kind coverage" ([loop.js:294](../cloudflare/training/loop.js)) check kinds asked, not kinds present. *Effort S.*
- **Not recommended:** a bigger model. Paper Table 4 shows depth and width buy 5–8% at best; the error is in the features. Spend the ~200 KB of size headroom on A1.

## B. Narration and notes students

- **B1. Measure the live Haiku pass rate, then fix the prompt.** Batch first attempts pass `CHECKS.card` only 24% of the time (too many sentences 12.5K, asker self-naming 5.2K), yet `benchmarks/narration-evaluation.json` shows 11 of 12 live cards accepted. `narration-outcome.js` logs source and category without text; count the live llm/template split from it. Then tighten the Haiku 5.5 prompt (explicit sentence count, no self-naming, one passing example) and add a salvage step that trims to the first passing sentences. *Target:* batch first-pass ≥60% on the same 25.7K cards ($2.25), cutting cost per passing label ~2.5×. *Effort S.*
- **B2. Plus cards Haiku-first by default.** `prefer` defaults to `'fast'`, so student first. Cards cost about $0.0002 live; 7% vs 20.7% contradicted is what players pay for. *Effort S.*
- **B3. Turn timing into copying.** Emit derived text facts such as `<past:2.when>` = "three years ago" and, for bodies, "approved 4 of 5 budgets since 111". The year-ago flag made the model read years 2–3× more but time rulings no better: it has to do arithmetic Haiku's targets rarely show. 49 of 78 building and body note errors are years and ages. Role-token copying round-trips at 99.6%. *Effort S–M.*
- **B4. Fold each ruling into one memory token** (act + what + time), generalising stance-who (bind 1.76 vs 0.16, stance fact-fails −25%). *Validate* with the binding probe, then B6. *Effort S.*
- **B5. Prefix-constrained decoding and index-permutation augmentation.** Once a role for record *i* is emitted in a sentence, mask other records' roles and disagreeing act words; `factProblem` and `noteProblem` prune only at sentence end today. Permuting list indices in the triples with a remapped target is exactly label-preserving and teaches binding by index. *Effort S–M.*
- **B6. A standing judge harness as a gate.** At least 1,000 items × 2 seeds per candidate, paired McNemar, ~$0.10 per 1,000, 2-point non-inferiority margin. At n = 300 every claim in §1h–1k of the handoff, including whether int4 hurts, is inside ±3 points of noise. *Effort S.*
- **B7. Buy 4× the notes labels (~$3.50)** before any architecture change: note loss falls ~0.3 per doubling and has not flattened; bodies are the gap (2.91 vs Haiku 3.20). *Effort S.*
- **B8. A learned sentence verifier** (small cross-attention classifier over sentence and triples, trained on the ~5.4K graded candidates plus ~20K more for ~$2) as a beam reranker, replacing regex `noteProblem`, which caught 6–16% of contradictions. *Effort M.*
- **B9. Year and end prose.** `createProseKeeper` never asks for them, though the worker has a 700-token chronicle prompt. Ship Haiku year lines for Plus (also collects data), fix `chronicleFacts` so derived counts exist (year.text exact match 20.7%), distil later. Leave the end page to Haiku plus a template. *Effort S, then M.*
- **Defer:** int4 QAT for narration (saves download only; weights expand to f32; measured direction worse). Defer the triple encoder and pointer-generator; B3–B5 test the same binding hypothesis for less.

## C. Learning loop: what must be true before it publishes on its own

1. Hosted d1 returns full distributions (A5 precondition).
2. One teacher for training rows and gate sets.
3. Independent verification: `complete()` ([learning.js:175](../cloudflare/learning.js)) trusts a `report.json` the trainer wrote, in a container holding the teacher key with internet access. The Worker should re-run JS parity, size and ~2,000 real-play KL questions against a gate set in R2 the job token cannot write (well under a second of CPU).
4. Rollback and a kill switch: a `previous` pointer, an admin revert endpoint, a `blocked` list in the manifest checked at session start, per-kind flagged/unknown counters by bundle version, and a publish → revert → reload test.
5. A population gate that isn't noise: from the 16-town paired sd, the 4-town −10% geo-mean rule rejects roughly a third of neutral candidates. Use A2's common random numbers, 16 towns, and the lower CI bound of the paired log-ratio above log 0.9.
6. Gate parity: the local loop lacks canary-population and kind-coverage gates, skips held-out new rows below 10 ([distill-loop.js:299](../scripts/distill-loop.js)), and exports int8 by default.
7. One full staging cycle end to end, with an injected bad candidate that must be rejected.
8. Tests on shipped bundles: load `decisions.v{latest}`, check fixture parity and a 40-year student town hash. The notes test pins the v2 fixture, not v3.
9. Update the stale `decision-distillation.md` (it still describes an MLP that was never built).

## D. Browser inference

- **WASM SIMD for narration only, in a worker.** Measured 10–11× per matmul, ~4–6× per item (130–165 ms → 25–35 ms on M-series). Phones are unmeasured; expect 3–8× slower, so notes could take 0.5–1.3 s there, and `createLocalNotes` runs on the main thread today. Move notes into a worker regardless; use the int8 dot kernel so weights stay int8 in memory. *Validate* on the contract's iPhone 15 Pro. *Effort M.*
- **Decisions: no.** 31 µs per answer is ~23% of headless wall time (≤1.3× gain), and float SIMD breaks bit-identical hashes. The sim's cost is pathing.
- **WebGPU: no for both.** Batch-1 decoding at d 96 is dispatch-bound and the renderer owns the GPU budget.

## E. UX and design

### E1. The first session
- Three moments that must land: **"They live without you"** (0–90 s: slow opening camera move, the first card as a centred invitation, "Pause and open" forced for the first three cards, one-time inline hints on the chips); **"My ruling made something I can see"** (2–6 min: make `firstCard` in [governance.js:209](../src/sim/governance.js) pick a template that builds something, a receipt toast with "Watch it go up", a sealed chronicle line "Because you approved it in year 0"); **"The town remembers"** (8–15 min: flag the first returning refused request plainly, and introduce the era bar as the first goal; the popover already lists the conditions). *Effort S–M each.*
- Fix the empty docket dead end ([council.js:47](../src/ui/components/council.js)) with three next actions; rewrite the first explainer ("Nothing changes until you choose" is false: cards lapse).
- Measure drop-off with count-only events on the Worker: founded → first card → first ruling → first inspector tap → year 5 → Village → 15 min → next day. Targets: first ruling under 90 s; ≥60% reach Village.

### E2. Feedback loop
- **Ruling receipt** from `helps`/`hurts` after `rule` returns ([app.js:538](../src/ui/app.js)); move focus to the next card's title. *S.*
- **Consequence follow-ups:** one and five years after an accepted card, compare that area's indicators and add a chronicle line linking back (`cardHistory`, `chronicleYearFacts`); templates first, narrator later. *M.*
- **"Your rulings" ledger** with lapsed, refused, by body; an unanswered card is applied silently ([docket.js:378-400](../src/ui/components/docket.js)) and the player never learns what inattention cost. *M.*
- **Time pressure at speed:** a card lives 24 game months, which is 12 s at 20×. Default "Pause and open" for urgent cards at 10× and above, and a "N requests lapsed" notice that opens the ledger. *S.*
- **Era retrospectives:** `moment.js` accepts `items[]` but the app never passes any; send the three biggest changes and the ruling tally. *S.*
- **Ambitions** offered at Village, written in the conditions DSL, tracked in the era popover, rewarded on the end page. Goals for the player, not orders to the town. *M–L.*
- **Bring approval forward** from Borough (55–80 years in) to Village. *S.*
- Note: there is no "pause while ruling" in code ([app.js:176](../src/ui/app.js)), though HANDOFF and design-visual §8.7 say there is.

### E3. Finding and understanding
- **Search (⌘K or /)** over people, families, buildings, bodies, rules and chronicle lines, from a worker-side name index. *M.*
- **Clickable chronicle lines** (entries carry `refs`). *S.*
- **Families across 150 years:** a Family section in the inspector via `familyId`/`parentId` and `household.story`, plus a "keep an eye on this family" pin. *M.*
- **IA:** Act (Council), Town (People, Places, Tensions, Map), Record (Chronicle, Your rulings, Rule Book); give each rule a "what it has done since year X" line. *S–M.*
- **Overlays:** three exist with no legend; add legend, colour-blind-safe ramp, "Your works" and "Mood". *M.*

### E4. Prose as UX
- **Facts first, voice second.** `card-narration.js` defaults to the quote, hiding the canonical why; with ~20% contradiction, always show the game's explanation and put the quote under it as the asker's own words. *S.*
- **A one-tap "This doesn't fit" flag** on quotes and notes, stored locally and sent by opted-in players: free labelled data and honest about the model. *M.*
- Never show a numeric confidence; move model version hashes out of the Game tab into a collapsed "About the town's models". *S.*
- Per-faction voice (fold a style tag into the facts), petitions as signed letters, better template year lines for free players. *S–M.*

### E5. Deferred capabilities worth surfacing
- **Proposals from lived grievances** (HANDOFF open decision 2): a decision kind that picks (template, district, parameter) from grievance records, narration student writes the card, answers logged for replay; first add the missing upkeep and repair templates. *M–L.*
- **Approval feedback phase 2** (low approval feeds petitions and unrest; high restores patience); without it approval is a scoreboard that doesn't matter. *S sim + M tuning.*
- **Adviser instructions** ("Never raise the tithe"), rebuilt: delegation and standing orders are gone from the sim as well as the UI ([institutions.js:1087](../src/sim/institutions.js) strips them on load), contrary to HANDOFF and governance §2.6. *M.*
- **A forecasting adviser:** run `react_to_policy` and `faction_stance` under each ruling and show the predicted support shift (needs `adviser_answer`). *M.*
- **"Why did this happen?"** by leave-one-fact-out on the student (~1 ms per decision, exact for the policy that ran), rendered by template or the narration student. *M.*
- `closeEnterprise` and `takeLoan` as cards, not player verbs. Defer dogs and image questions for `choose_site`.

### E6. Accessibility and platform
- Tokens: light-theme `--muted` is 3.48:1 on paper (night passes at 5.3:1); `--focus` #bc963f is 2.66:1; `--river` and `--green-2` fail as text. Suggested: `--muted` #66705c, `--focus` #8a6a24, river text #2f7684; hatch the against segment of the opinion bar. Add `@axe-core/playwright` to hud and ui specs. *S.*
- Ruling by keyboard and screen reader: focus the Council heading on open, arrows between options, `[`/`]` between cards, `role="region"`, a live region for "N requests wait". *M.*
- Text size "Large" does not scale SVG overlays, world labels or popovers; add XL. *S–M.*
- Offline PWA: service worker caching the app, `/students/*` (~1.5 MB) and self-hosted Fraunces and DM Sans (Google Fonts breaks offline and leaks visitor IPs); a padded maskable icon; `beforeinstallprompt` after the first session. *M.*
- Phone: one-time gesture hint, a Playwright iPhone project, one real-iPhone pass against the contract target. The browser suite has ~109 tests in 17 specs, all at one desktop viewport.

### E7. Visual design
- Replace the README media (it shows the removed For/Against strip, per-body dock flags and 8×); the README also still advertises delegation and standing orders and says a year is a minute (it is two).
- Make the Ledger physical: a wax-seal stamp on ruling, chronicle lines that ink in, per-era UI tint using `ERA_SWATCHES` and Fraunces' optical axes, paper grain on docket and moment cards. *M.*
- Moment cards should carry content (three changes, an asker portrait). *S.* One typographic voice for numbers (tabular DM Sans; drop the JetBrains Mono request). *S.*

### E8. Monetization
- Sell at moments of intent: the locked 10× item and keys 4/5, the "N requests lapsed at 20×" notice, the end page ("Have your town's history written"). *S.*
- Rewrite benefits copy around what players can see (faster years, Haiku-written notes and quotes, 10 cloud towns, a shareable town page, a chronicle book); "live decisions for your townspeople" is invisible. Prices are hardcoded USD in [account.js:104-107](../src/ui/account.js). *S.*
- New perks: illustrated chronicle book export, public share links (free gets one), yearly timelapse flipbook. Don't gate the explanation toggle, any era or surface, or the end page.

### E9. Retention and sharing
- **End page and share link:** a full-screen page from `endSummary` ([chronicle.js:161-195](../src/sim/chronicle.js)), gated on `unlocks.endPage`; publish a read-only snapshot to R2 at `/t/<id>`. *M + M.*
- "Previously" line on Continue ("Year 42. Two requests waiting. The Guild is angry about the toll"). *S.*
- Weekly valley: one seed for everyone, with the spread of outcomes shown afterwards; pair with ambitions. *M.*
- Chronicle export (Markdown/HTML) for free players. *S.* Yearly flipbook from per-year thumbnails. *M.*

## F. Backend findings worth a ticket

- Sign-in cookies are HMAC-signed for 30 days and cannot be revoked server-side.
- The sign-in mail cap is a single global 1,000 per day, so one actor can lock everyone out; send errors are swallowed.
- `event:` and `trained:` keys never shrink; `ingest` and `trigger` scan every `q:` row (O(N) at 20,000).
- The legacy `server/serve.js` path has rate limits defaulting to 0 and a narrator handler with no tier or origin check; confirm it is not deployed.
- `docs/cloud-save-backups.md` limits are stale (code: 16 MiB gz, 64 MiB inflated, 800 writes and 2 GiB per day). The cost doc predates tiers and omits narration; budgets bound requests, not dollars.
- No live Stripe payment lifecycle has been exercised; `past_due` loses access at once.

## Suggested sequencing

- **Week 1:** the same-day fixes; B1, B2, B6, B7 (all cheap, mostly spend under $10); A4 and A7 as new offline checks; receipts and era retrospectives.
- **Weeks 2–4:** A1 and A2 (one retrain, one dynamics study); B3–B5 judged under B6; the first-session moments; the ledger and follow-ups; the end page.
- **Weeks 5–8:** C1–C8 then one staging cycle; the PWA; search and families; proposals from grievances; WASM narration in a worker, measured on a phone.

## Status after the first sweep (27 October 2026, uncommitted in this worktree)

Done, with tests: the four UI bugs and the stub-sim old-save code; Plus cards Haiku-first by default (B2) and facts-first cards with the quote beneath (E4); collapsed model-version section in Settings; ruling receipts, the lapsed-requests notice, era look-back items, follow-up chronicle lines at +1 and +5 years, and the "Your rulings" ledger (E2); the end page at year 150 with a `/t/<id>` share link (E9); rollback and kill switch, independent bundle verification in the Worker, gate parity between loops, asked-kind coverage, shipped-bundle tests (C); light-theme contrast tokens with a token test, text-safe tokens in components.css, a hatched against-bar, service worker, maskable icon and install prompt (E6); README, HANDOFF and design-doc corrections.

Not merged: per-agent persistent draws (A2) is on branch `worktree-agent-a04949b0d1f7bbdde` at `907605e`. The experiment found that the "marginals stay uniform" argument fails wherever an agent's past choices change its next probabilities, so the shipped compromise mis-calibrates work by about 9% relative and reaches only 0.2 choice correlation for routine; with it on, six deterministic sim tests fail. Household moves and strike walkouts did reach the target range. Keep it as a flag-off experiment or drop it.

Still open from the plan: C1 (hosted d1 probabilities), C2 (relabel gate sets with d1), C5 and C7 (16-town gate, one staging cycle), per-kind telemetry, a forced-strike canary, A1 re-featurization, B1 prompt yield measurement, B3 to B8, WASM narration, self-hosted fonts, keyboard ruling flow, the end page thumbnail and era-popover link.

Verification on the combined tree: node 608 of 609 (the gathering flake), build clean, Playwright 131 of 132 (the inspector-notes spec at narration.spec.js:228 also fails on unmodified HEAD).
