# Hosting the decision model: costs at full game load

What it would cost to serve Hearthvale's "System 1" decision model to the public, and how to host it. Written 20 October 2026 against `fd6e048`. Every price was read from the provider's live page on that date (sources at the end). No game code was changed. The load figures come from a headless measurement of the real sim and decision client (section 2).

---

## 1. Recommendation

**The model isn't what limits scale. The game's question loop is.** The scheduler refills the pipeline with walker routine questions as fast as answers come back (`fillThroughput` in `src/sim/decisions/scheduler.js`). One town or city player against a fast cloud service asks **350–1,240 questions a second**, and 85% of those are byte-identical repeats. The questions the town actually needs (sweeps and game moments) are **1.3 q/s for a hamlet, 6.6 for a town and 18 for a city**. Every host is unaffordable at the first number; at the second the choice of host starts to matter. So:

1. **Before launch, whatever the host** (game-side changes, each small):
   - Add a **server-side, per-session question budget** in the proxy, and set the client's existing manual cap by default. The walker refresh loop has to stop filling to capacity. Start with about 5 q/s at 1× and scale with game speed.
   - Add an **exact answer cache** in the proxy, keyed by `(state, rendered question)`. Answers are distributions the game samples itself, so a cache loses nothing. It removes 45% of essential questions within a player, 85% of walker refresh, and about 35% across players for hamlets (measured with 6 seeds; this rises with player count).
   - Put the proxy behind **session tokens, Turnstile or similar, and a hard daily spend cap**. A public, unauthenticated `/api/decisions` is an open tap on your bill.
   - Lower the **`resident_routine` sweep cadence**. It is ~75% of essentials (3 variants every game month). Halving it, or merging morning/midday/evening into one question, saves the most.
2. **At launch:** use **Liquid AI's hosted `d1`** through the System One API. It costs $0.02 per 1M input tokens with no output charge, and new organisations get $2 of free credit.
   - It is the same family as your d1-3B and the same question types (`noul`, `choice`, `score`), and it returns probabilities natively.
   - `server/system1.js` already builds almost exactly the System One body (`{state, questions:{key:{type, instructions, criteria}}}`). The switch is an endpoint, auth and `model` field change, plus fanning out the `/batch` shape into parallel calls.
   - There is no GPU to run and no idle cost.
   - Keep **Cloudflare Workers AI `clef-flash`** ($0.038/1M, same API, Apache-2.0 open weights) wired as the fallback provider. TypeSafe's **Jev** ($0.042/1M) is the same API too, but it is closed, waitlisted, and it is a model, not a host (section 4.2).
   - **Check before you commit:** hosted `d1` is not d1-3B; Liquid doesn't publish its size. Run your calibration scripts against it (the `migration_wave` and `take_loan` checks in HANDOFF.md). Ask Liquid for rate limits, because none are published.
3. **Switch to self-hosting d1-3B** on rented GPUs once the hosted bill passes about **$1,500–2,000 a month**. That is roughly 95–125 q/s sustained after caching, or about 100–125 concurrent players on the lean budget.
   - Run vLLM or SGLang, which serve `/v1/systemone` for d1-3B per its model card, on an **L40S or H100** from RunPod, Koyeb or Lambda. A **Hetzner GEX45** at €214/month is a cheap always-on floor.
   - Self-hosting wins because you pay for the shared `state` once per group (your service caches it). Hosted APIs bill it again with every question: about 115 tokens a question versus 300.
   - Rent at least two GPUs for redundancy.
   - Keep the LAN box for development and as a last-resort overflow, not as the public backend.
4. **Later, optional:** offer **on-device inference** to players with a capable GPU. There is a community WebGPU build of d1-3B (`onnx-community/d1-3B-ONNX`, 1.76 GB at q4). Every player who opts in costs nothing to serve. The download is too big to make it the default.

**Cost at launch with the lean budget** (about 1 billed q/s per concurrent player after caching, hosted d1): about **$0.02 per player-hour**. That is ~$1.6k/month at 100 average concurrent players (~3k DAU), ~$16k at 1k (~30k DAU) and ~$160k at 10k (~300k DAU). Self-hosting on RunPod L40S cuts that to roughly **$0.6k / $6k / $61k**.

**If nothing changes in the game**, one concurrent player costs **$13–27 per hour** on any hosted API. That loop is most likely also why the LAN box looks like it won't scale: one player already fills it. No provider fixes it.

---

## 2. Workload model (measured from the code)

### 2.1 How the game asks

- The decision scheduler (`src/sim/decisions/scheduler.js`) sends three streams:
  1. **Base sweeps** on each kind's cadence (`SWEEPS`). A population kind asks one question per slice value. `resident_routine` runs every game month, three times (morning, midday, evening). The yearly kinds are spread across the months.
  2. **On-demand questions** at game moments: faction stances on a new card, reactions to a rule, event responses, institution drafts and negotiations.
  3. **Fill-to-capacity refinement** (`fillThroughput`). On every tick (5 a second at 1×) it asks for as much as the client says it has `room` for.
     - First come torn intersections, then **every visible walker's routine, round-robin**, then home upgrades.
     - A walker is asked again as soon as their previous answer lands. Only in-flight duplicates are suppressed.
- The browser client (`src/decision-client.js`) batches up to 64 questions per request, groups them by identical `state`, and keeps 1–4 requests in flight.
  - Its `room()` is enough to keep every slot busy plus one ready request, capped at about 2 s of measured throughput.
  - So **the faster the service, the more the game asks**. There is no fixed per-player demand today.
- `src/routine-policy.js` (`AdaptiveRoutinePolicy`) is used only by `src/sim/legacy.js` and a performance test. It is not on the main path.
- Settings → Decision pacing already has a **manual mode**: a rolling ceiling of 1–5,000 questions per real second.
  - Sweeps are priority 50 and walker refresh priority 10, so a cap starves walker refresh first.
  - Questions older than 5 s fall back to local rules.
- A hidden tab stops `requestAnimationFrame`, so a backgrounded game asks nothing.

### 2.2 Method

A scratch script (not committed) loads the `hamlet`, `town` and `city` fixtures. It runs the real sim and the real decision client in virtual time at 60 frames a second, with `fetch` replaced by a mock service. The mock answers every question with a uniform distribution after a fixed latency.

- **What it records:** requests, questions, groups and distinct states. It renders each question with the server's own `renderQuestion()`.
- **Tokenizer:** counts use Liquid AI's LFM2 tokenizer (`LiquidAI/LFM2-2.6B`). d1-3B is built on the LFM2.5 backbone, so this is the closest public tokenizer.
- **Fixtures:** hamlet 28 residents (28 walkers), town 774 (774 walkers), city 5,059 (2,000 walkers, the default `individualCap`).
- **"Essentials only":** the same run with the client's `room` forced to 0. Only sweeps and on-demand questions go out, so the town plays as today minus walker refresh.
- **Not measured on the live box:** the LAN box was not used, and latency is a parameter. `node scripts/benchmark-decisions.js` measures the real box.

### 2.3 Questions per player (1× speed, per real second)

**Essentials only** (24 game months, averaged):

| Town | Residents | Questions/s | Requests/s | Questions/request | States/request | Distinct states over 2 years |
|---|---:|---:|---:|---:|---:|---:|
| Hamlet | 28–49 | 1.1–1.3 | 0.4 | 3 | 1.8 | 18–20 |
| Town | 774 | 6.6 | 0.5 | 12 | 8.9 | 141 |
| City | 5,059 | 18.3 | 0.6 | 29 | 25 | 399 |

- **`resident_routine` sweeps dominate:** they are 70–80% of this (city: 14.4 of 18.3 q/s).
- **Bursty:** each game month (10 s) starts with a burst, about 200 routine slice questions in a city. Answering every sweep before the 5 s cutoff needs about 40 q/s of burst capacity for a city.
- **Scales with game speed:** city essentials are about 54 q/s at 3× and 144 q/s at 8×.

**As the code ships today** (auto pacing, fill-to-capacity, 3 game months):

| Town | Latency 50 ms | 100 ms | 250 ms | 500 ms | 1,000 ms |
|---|---:|---:|---:|---:|---:|
| Hamlet (28 walkers) | 140 | 140 | 74 | 50 | 26 |
| Town (774 walkers) | – | 1,237 | 479 | 368 | – |
| City (2,000 walkers) | – | 1,236 | 613 | 354 | – |

- **What drives it:** 99% is walker routine refresh.
  - A hamlet is bound by walkers × 5 ticks a second.
  - Towns and cities are bound by the pipeline: 4 requests × 64 questions ÷ latency.
- **Request shape:** requests carry 56–62 questions over 7 (town) to 25 (city) distinct states.
- **Game speed:** at 3× and 8× the total doesn't rise (city 735 and 694 q/s at 250 ms). It is already pipeline-bound, and sweeps take room from walker refresh.
- **Repeats:** 85% of the uncapped questions are byte-identical repeats (town: 14,362 asked, 2,112 distinct).

**With the existing manual cap** (city, 250 ms):

| Cap (q/s) | Achieved q/s | City routine sweep questions answered by the model |
|---:|---:|---:|
| 5 | 4.9 | 12% (the rest use local rules) |
| 10 | 9.4 | 28% |
| 25 | 23 | 69% |
| 50 | 45 | 98% |

A town is fully served at a cap of 25 and 78% served at 10; a hamlet is fully served at 5.

**Repeats an exact cache would absorb** (essentials, 24 months):
- Within one player, 44% (hamlet), 46% (town) and 48% (city) of questions repeat an earlier byte-identical `(state, question)`.
- Across players, each new hamlet seed found 27–47% of its questions already asked by the previous seeds (1 to 5 earlier seeds). Cities have more distinct states and will share less.

### 2.4 Tokens per question

Counted with the LFM2 tokenizer on more than 5,000 real questions:

| Part | Hamlet | Town | City |
|---|---:|---:|---:|
| Shared `state` (JSON, once per group) | 119 | 204 | 308 (max 365) |
| One question as the service receives it (`{type, instructions, criteria}` JSON) | 117 | 117 | 117 |
| The same question as plain text | 85 | 85 | 85 |

- Kinds range from 64 tokens (`faction_stance`) to 122 (`choose_site`) as plain text.
- The answer is a distribution over 2–16 options from one forward pass. Decision APIs bill **0 output tokens**.
- The `rules` text (up to 480 characters) is the biggest single field in a city snapshot.

That gives three per-question budgets:

| How it's served | Input tokens per question | Why |
|---|---:|---|
| Self-hosted d1-3B, today's `/v1/decisions` with GPU state cache | ~115 | Question plus template, with state paid once per group and cached across requests |
| Hosted System One API (Liquid d1, Clef, Jev) | ~300 | Liquid bills "each question … as its own prompt", so the state (~200) is paid again per question |
| Stock chat-completion API with logprobs | ~350 | Template ~60, state ~200, question ~90; ~260 of it is a shared prefix a prompt cache can discount; 1 output token |

### 2.5 Load profiles used for costing

| Profile | Billed q/s per concurrent player | What it means |
|---|---:|---|
| **Lean** | 1 | Essentials of a town, after the exact cache (~50%) and a halved routine cadence. The recommended launch target. |
| **Low** | 5 | Essentials or a cap of 5–10, no cache. Hamlets and towns fully served; cities partly use local rules. |
| **Typical** | 25 | Cap of 25, no cache. Towns fully served, cities ~70%, a trickle of walker refresh. |
| **Peak** | 600 | Today's code, uncapped, against a ~250 ms cloud service. Up to ~1,240 at 100 ms. |

Per concurrent player per month (730 h):

| | Lean | Low | Typical | Peak |
|---|---:|---:|---:|---:|
| Questions | 2.6 M | 13 M | 66 M | 1.58 B |
| Tokens, self-hosted (115/q) | 0.3 B | 1.5 B | 7.6 B | 181 B |
| Tokens, hosted System One (300/q) | 0.8 B | 3.9 B | 20 B | 473 B |

**Concurrent players and daily players.** A browser sim with ~45-minute sessions spread over the day has roughly **3% of DAU online at once on average**. So 100 average concurrent ≈ 3k DAU, 1k ≈ 30k DAU and 10k ≈ 300k DAU. The busiest hour is often 2–3× the average. That matters for GPU sizing and rate limits, not for per-token bills.

---

## 3. What the model needs from a host

- **Today's model:** Liquid AI **d1-3B**, released 7 October 2026 under the LFM Open License v1.0.
  - It has 3.12 B parameters and is built on LFM2.5-VL-3B (an LFM2.5-2.6B backbone plus a SigLIP2 vision encoder), with a 32k context.
  - It reads `state` plus typed questions in one forward pass and returns calibrated probabilities. It generates no text.
  - Liquid quotes 8 ms per warm decision on an RTX 4090.
  - Weights are 6.2 GB in bf16 and 3.8 GB in W8A8.
- **It is a "System One" decision model:**
  - TypeSafe's **Jev**, Liquid's hosted **d1** and **d1-ultra**, and Cloudflare's **Clef**, **Clef-flash** and **Clef-omni** share one request shape (`POST …/v1/systemone`).
  - Your `/v1/decisions` behind LiteLLM is that shape: `{state, questions:{key:{type, instructions, criteria}}}` in, `{answers:{key:{choice, probabilities, confidence | noul | score}}}` out.
  - `/v1/decisions/batch` (`{requests:[…]}`) is your server's extension. The hosted APIs take one state per call.
- **What a host has to provide:**
  1. Either the System One API, or a raw model with **per-token logprobs** (top-k at least as wide as the option list, up to 16) or constrained decoding. Without one of these you get a winner but no distribution, and pooling, sampling and refinement need the distribution.
  2. **Prefix or state caching**, because the state is about two-thirds of every hosted prompt.
  3. **High request rates at low latency.** Questions older than 5 s are dropped, and a city needs bursts of ~40 q/s per player.
  4. For self-hosting, **custom weights**: d1-3B is open weights, so any GPU host works.
- **License:** the LFM Open License is free for commercial use **below US$10 M annual revenue**, including affiliates. Hosted d1 is billed per token, with no licence threshold for the API.

### If the game moved to a stock small model

For a stock 1–4B instruct model, such as Llama 3.2 3B, Qwen 3 4B or LFM2.5-2.6B, with logprobs:

- **Prompt changes:** render each question as a prompt that ends in a numbered option list ("Answer with the number"). Read the first token's `top_logprobs` over "1"…"N", renormalise, and drop leaked mass.
  - `score` and `noul` become choice prompts. Expected level and P(yes) are computed client-side.
- **Lost:** calibration. Logprobs of a chat model are not calibrated probabilities. The HANDOFF calibration work (scales for `migration_wave` and `take_loan`, banded money words) would have to be redone.
- **Server changes:** you'd lose the state cache. Put the state first so the provider's prefix cache can match it. `server/system1.js` would gain a renderer per kind and a logprob parser.
- **Cost:** at ~350 tokens per question, the cheapest stock option (DeepInfra Llama 3.1 8B, $5.6–7.0 per 1M questions) only ties hosted `d1` ($6.0). There is no saving to justify the work.
- **Workers AI** documents no logprobs on its small models, so it can't serve this path at all.

---

## 4. Providers

### 4.1 Decision-model APIs (System One)

| Provider / model | $ per 1M input | Output | Weights | Logprobs / distribution | Rate limits | Latency |
|---|---:|---|---|---|---|---|
| **Liquid AI `d1`** (hosted) | **0.020** (cached same) | free | closed, size undisclosed | native probabilities | not published | not published |
| Liquid AI `d1-ultra` | 0.042 | free | closed | native | not published | not published |
| **Cloudflare Workers AI `clef-flash`** (9 B, from Qwen3.5-9B) | 0.038 (cut from 0.090 on 9 Oct) | free | **Apache-2.0 open weights** | native | Workers AI text default 300 req/min; Clef not listed separately | 38.8 ms median (vendor) |
| Cloudflare `clef-omni` (30 B MoE, 3 B active) | 0.150 | free | – | native | as above | – |
| Cloudflare `clef` (27 B) | 0.240 | free | – | native | as above | 209 ms median (vendor) |
| **TypeSafe Jev** 1.13 / 1.14 | 0.042 | free | closed | native | per organisation (tokens/s and requests/s), 429/529 | 70–500 ms end to end (vendor) |

- **Liquid `d1`:**
  - Endpoint is `https://api.liquid.ai/decisions/v1/systemone`.
  - The body must be under 4.5 MB.
  - $2 free credit for a new organisation.
  - Also on Vercel AI Gateway at the same price, with a 65,536-token context. Liquid's pricing page also names OpenRouter, but `d1` wasn't in OpenRouter's models API on 20 October.
  - Liquid's d1 launch blog said $0.04; the pricing page now says $0.02.
- **Cloudflare:**
  - Billed as Neurons at $0.011 per 1,000.
  - **10,000 free Neurons a day** covers about 2.9 M input tokens, or about 9,600 hosted-size Clef-flash questions.
  - AI Gateway caching and rate limiting are free.
  - The async batch API has no discount.
  - A Worker could also host the proxy, the per-session budget and the exact-answer cache (KV or Cache API) next to the model.
- **Jev:**
  - 64k tokens per request and 32k per question; no cap on question count.
  - TypeSafe says Jev reads the state once per request. Whether it bills it once isn't stated, so this doc assumes per question.
  - Early access, with a waitlist.
  - Also on OpenRouter (`typesafe/jev-1.13`, `jev-1.14`).

### 4.2 About "jev"

- **"Jev" is a real product, but it is a model, not an inference host.** It is TypeSafe AI's closed decision model, the reference implementation of the System One API ([typesafe.ai](https://typesafe.ai)).
- You can call it from TypeSafe's console, OpenRouter, and reportedly Vercel AI Gateway and Runware.
- You can't self-host it, rent GPUs for it, or fine-tune it.
- No GPU or LLM host by that name was found.
- Use it as an alternative model behind the same proxy, priced like `d1-ultra`, not as the place to run d1-3B.

### 4.3 Stock token APIs (small models)

None of these offer the System One API or host d1-3B. They matter only for the stock-model path in section 3, or as hosts for a dedicated d1-3B deployment.

Prices are $ per 1M tokens (input / output). The cost per 1M questions assumes 350 input tokens and 1 output token (section 2.4), with no cache unless the column says so.

| Provider | Cheapest usable small model | $ in / out | $ / 1M questions | Logprobs | Constrained output | Custom weights | Limits, notes |
|---|---|---|---:|---|---|---|---|
| **DeepInfra** | Llama 3.1 8B Turbo | 0.02 / 0.04 (Flex 0.016) | **7.0** (Flex 5.6) | top_logprobs 1–20 (documented; OpenRouter's flags for DeepInfra say no, so test) | json_schema strict | Any HF repo as a private model, scales to zero; A100 $1.49/h, H100 $2.90/h | 200 concurrent requests per model |
| Novita (via OpenRouter too) | Llama 3.1 8B | 0.02 / 0.05 | 7.0 | FAQ says top_logprobs unsupported, API reference says otherwise | json_object | GPU rental | tiered rate limits |
| OpenRouter → Parasail | Gemma 3 4B | 0.04 / 0.05, cached 0.02 | 14.1 (8.9 with prefix cache) | yes (per-endpoint flag) | yes | – | OpenRouter adds routing and fallback across providers |
| AWS Bedrock | Gemma 3 4B | 0.04 / 0.08 (batch 0.02) | 14.1 (batch 7.0, not real-time) | on-demand: undocumented | – | **Custom Model Import**: OpenAI-style API with logprobs and json/regex/choice/grammar; $0.057 per CMU-minute (~$3.43/h per CMU), 5-minute windows, cold restore after idle; no LFM architecture listed | Llama 3.2 3B is $0.15/1M, far dearer |
| Together AI | Tev1 4B Experimental (a classification model: 2–24 options, returns a letter) | 0.04 / free | 14.0 | undocumented for Tev1; `logprobs` exists for other models | json_schema, regex | Serverless LoRA discontinued; dedicated H100 $5.49/h, custom HF models on dedicated endpoints | not published; most small serverless models removed |
| Fireworks AI | <4B tier | 0.10 / 0.10, 50% cached | 35 (22 cached) | up to 5 by default | json_schema, BNF grammar | HF upload for most architectures, on-demand GPUs (H100 $8/h); scales to zero after 1 h idle | 6,000 RPM |
| Google Vertex AI | Gemini 2.5 Flash-Lite | 0.10 / 0.40, cached 0.01 | 35 (12 cached) | 1–20 but deprecated for Gemini 3.x and reportedly disabled on 2.5 Flash | responseSchema, `text/x.enum` | Model Garden self-deploy: 1× L4 $0.98/h, H100 $9.80/h | – |
| Cloudflare Workers AI | Llama 3.2 3B | 0.051 / 0.335 | 18.2 | **none documented** | JSON mode on 6 models, not guaranteed | LoRA only (beta) | 300 req/min |
| Groq | Llama 3.1 8B | 0.05 / 0.08 (third-party; Groq says contact sales) | – | **400 error on logprobs** | strict JSON on a few models | – | – |
| Cerebras, Nebius, SambaNova, Hyperbolic | – | – | – | – | – | – | No serverless model under ~9 B (Hyperbolic has retired serverless) |

- **Only DeepInfra or Novita come close to hosted `d1`** on price ($5.6–7.0 against $6.0 per million questions). Both depend on logprobs that need a direct test.
- **What switching to them would cost:** the prompt rework and lost calibration described in section 3.
- **Most useful role for these providers:** hosting d1-3B as a custom model. DeepInfra (private HF models that scale to zero), Fireworks (HF upload) and Bedrock Custom Model Import can do this, if the System One endpoint can be served in their runtime. That is unconfirmed for all three; vLLM support makes DeepInfra and Fireworks the likeliest.

### 4.4 Running d1-3B yourself on rented GPUs

- **Software:** d1-3B serves `/v1/systemone` from vLLM (≥ 0.23) or SGLang, per its model card. llama.cpp (≥ 0.7.0, GGUF) and Ollama (`d1`) also work. Your LiteLLM front end can stay.
- **Throughput estimate (not measured):** prefill is about 6 GFLOP a token for 3 B parameters. At 30% of dense BF16 throughput:

  | GPU | Prefill tokens/s | Questions/s at 115 tok |
  |---|---:|---:|
  | L4 | ~6k | ~50 |
  | L40S | ~18k | ~155 |
  | H100 | ~49k | ~425 |

  - FP8 roughly doubles these.
  - Above about 100 req/s, the Python server, tokenization and JSON usually limit throughput before the GPU does.
  - Measure on the real box with `scripts/benchmark-decisions.js` before sizing.
- **State memory:** LFM2's KV cache is about 16 KB a token, because only 8 of its 30 layers are attention. A 300-token state is about 5 MB, so thousands of cached states fit in a few GB.

Prices are $/GPU-hour, on demand unless noted:

| Provider | L4 | A10/A10G | L40S | A100 80GB | H100 | Billing, cold start |
|---|---:|---:|---:|---:|---:|---|
| RunPod Pods (community / secure) | 0.44 / 0.59 | – | 0.79 / 1.09 | 1.39 / 1.79 (SXM) | 2.69 / 3.99 (SXM) | Hourly pod, always on |
| RunPod Serverless (flex) | 0.69 | – | 1.75 | 2.72 | 4.79 | Per second; active workers ~30% cheaper (confirmed for the 16 GB tier only); 5 s idle billed |
| Koyeb | 0.70 | – | 1.20 | 1.60 | 2.50 | Serverless, scales to zero |
| Modal | 0.80 | 1.10 (A10) | 1.95 | 2.50 | 3.95 | Per second; $30/month free credit; warm containers billed; 60 s default scale-down |
| Cerebrium | 0.80 | 1.10 | 1.95 | 2.10 | 3.40 | Per second |
| Baseten | 0.85 | 1.21 | – | 4.00 | 6.50 | Per minute; scales to zero (900 s default delay) |
| Beam | – | – | – | from 1.36 | 3.50 serverless / from 1.83 | |
| Lambda | – | 1.29 (A10) | – | 1.99 (40GB) / 2.79 | 3.29 PCIe / 4.29 SXM | On-demand VM |
| AWS us-east-1 | 0.805 (g6.xlarge); 0.524 1-yr RI | 1.006 (g5.xlarge) | 1.861 (g6e.xlarge) | 2.74/GPU (p4d, 40GB) | 6.88/GPU (p5) | VM |
| GCP us-central1 | 0.707 (g2-standard-4); spot 0.42 | – | – | 3.67 (40GB) | 11.06 (a3-highgpu-1g) | VM; third-party figures, official page didn't render |
| OVHcloud | 1.00 | 1.00 | 1.80 | 3.07 | 2.99 (as listed) | VM |
| Replicate (Cloudflare since 1 Dec 2025) | – | – | 3.51 | 5.04 | 5.49 | Private models bill setup and idle time |
| Vast.ai (market snapshot) | ~0.36 | – | ~0.80 | ~0.79 | ~2.1–2.4 | Marketplace hosts, no datacentre SLA |
| **Hetzner GEX45** (RTX PRO 4000 Blackwell 24 GB) | **€214/month** + €209 setup (≈ €0.29/h) | | | | | Dedicated, monthly; throughput not benchmarked |

- **Egress is negligible** if responses stay small: about 1–5 KB a request, or $0.04–0.45 per million requests. Never return full-vocabulary distributions.
- **The cost floor:** an always-on L4 is $320–580/month, an always-on L40S $575–1,400/month, and the Hetzner GEX45 €214/month. Scale-to-zero serverless avoids the floor, but cold starts of tens of seconds would push every waiting question past the 5 s cutoff, so keep one warm worker.

---

## 5. Monthly cost by tier

Assumptions:
- **Hosted APIs:** 300 input tokens a question; Workers AI Llama adds 1 output token at 350 input.
- **Self-hosting:** 115 tokens a question, 30% prefill efficiency, and **60% average utilisation** to allow for daily peaks.
- **Costs are linear in load.** Fixed floors, free tiers and redundancy are ignored. Add about one spare GPU (or ~$600–1,500/month) for redundancy when self-hosting.

**$ per million questions and per player-hour:**

| Option | $ / 1M questions | Lean (1 q/s) $/player-h | Low (5) | Typical (25) | Peak (600) |
|---|---:|---:|---:|---:|---:|
| Liquid `d1` hosted | 6.00 | 0.022 | 0.11 | 0.54 | 12.96 |
| Cloudflare `clef-flash` | 11.40 | 0.041 | 0.21 | 1.03 | 24.62 |
| TypeSafe Jev / Liquid `d1-ultra` | 12.60 | 0.045 | 0.23 | 1.13 | 27.22 |
| Workers AI Llama 3.2 3B (no logprobs, so not usable as is) | 18.18 | 0.065 | 0.33 | 1.64 | 39.28 |
| Self-host L4, RunPod community | 3.90 | 0.014 | 0.07 | 0.35 | 8.43 |
| Self-host L4, AWS g6 on demand | 7.14 | 0.026 | 0.13 | 0.64 | 15.43 |
| **Self-host L40S, RunPod community** | **2.32** | **0.008** | 0.04 | 0.21 | 5.02 |
| Self-host L40S, Modal | 5.74 | 0.021 | 0.10 | 0.52 | 12.39 |
| Self-host H100, RunPod community | 2.92 | 0.011 | 0.05 | 0.26 | 6.31 |
| Self-host H100, Modal | 4.29 | 0.015 | 0.08 | 0.39 | 9.27 |

**Monthly cost at 100 / 1k / 10k average concurrent players** (≈ 3k / 30k / 300k DAU):

| Option | Lean | Low | Typical | Peak |
|---|---|---|---|---|
| Liquid `d1` hosted | $1.6k / $16k / $158k | $7.9k / $79k / $788k | $39k / $394k / $3.9M | $946k / $9.5M / $95M |
| Cloudflare `clef-flash` | $3.0k / $30k / $300k | $15k / $150k / $1.5M | $75k / $749k / $7.5M | $1.8M / $18M / $180M |
| TypeSafe Jev / `d1-ultra` | $3.3k / $33k / $331k | $17k / $166k / $1.7M | $83k / $828k / $8.3M | $2.0M / $20M / $199M |
| Self-host L4, RunPod community | $1.0k / $10k / $103k | $5.1k / $51k / $513k | $26k / $257k / $2.6M | $616k / $6.2M / $62M |
| **Self-host L40S, RunPod community** | **$0.6k / $6.1k / $61k** | $3.1k / $31k / $305k | $15k / $153k / $1.5M | $366k / $3.7M / $37M |
| Self-host L40S, Modal | $1.5k / $15k / $151k | $7.5k / $75k / $754k | $38k / $377k / $3.8M | $904k / $9.0M / $90M |
| Self-host H100, RunPod community | $0.8k / $7.7k / $77k | $3.8k / $38k / $384k | $19k / $192k / $1.9M | $461k / $4.6M / $46M |

**How to read this:**
- Only the **Lean** column is a business that a free or cheap browser game can carry.
- **Low** is workable with a paid tier.
- **Typical and Peak** are what the code does today against a fast service.
- **The switch point to self-hosting:**
  - One L40S at 60% use answers about 250 M questions a month for ~$580. Hosted `d1` would charge ~$1,500 for the same questions.
  - Below about $600/month of hosted spend, a GPU you rent always-on costs more than it saves.
  - Above about $1,500–2,000/month, self-hosting pays for itself, including a second GPU for redundancy.

---

## 6. Cost levers

Ordered by savings for the effort. "Have" means the code already has it.

| Lever | Status | Effect | Notes |
|---|---|---|---|
| Stop fill-to-capacity walker refresh (or cap it per player) | have the cap (manual mode, 1–5,000 q/s); the default is auto | Peak → Low: **÷100** | Make manual the cloud default and enforce it server-side too. Walkers keep sim-core's prior or the pooled slice answer for their group. |
| Server-side per-session budget and spend cap | missing | Hard ceiling per player and in total | Token bucket per session in the proxy; 429 with `retryAfterMs` is already handled by the client. |
| Exact answer cache in the proxy, keyed by (state, question) | missing (the service caches repeats internally, but you still pay for them on a hosted API) | −45% of essentials, −85% of walker refresh, and more across players | Lossless: answers are distributions the game samples locally. Cloudflare KV, Redis or an in-process LRU. |
| Longer `resident_routine` cadence or one variant instead of three | missing | Up to −50% of essentials | 70–80% of essentials. Consider asking once with `timeOfDay` dropped, or every 2 months. |
| Cohort sharing (slices, pooling, refinement) | have | Already the main saving: a city of 5,000 needs 18 q/s, not 5,000 | Keep refinement (`fillThroughput` step 1) bounded by the 12-month cooldown it already has. |
| Local fallback rules | have | Any question can be dropped at zero cost | The game plays without the model. A budget only lowers fidelity, so degrading is safe. |
| Shorter state | partly (bands) | Hosted APIs bill the state with every question; trimming 100 tokens saves ~30% on hosted | `rules` and `bodies` text dominate city snapshots. |
| Smaller batch cadence and fewer states per request | have (64 max, grouped by state) | Fewer requests, better cache hits on self-host | Hosted APIs take one state per call, so fan-out happens in the proxy. |
| On-device inference (WebGPU) | missing | 100% of that player's load | d1-3B q4 is 1.76 GB; `d1-omni-600M` is experimental. Opt-in for capable desktops only. |
| Pace and speed | have | Essentials scale with game speed (8× ≈ 8× load) | Budget per real second, not per tick, so 8× degrades fidelity instead of raising cost. |

---

## 7. Caveats

- **The load figures are measured, but with a mock service:**
  - Uniform answers may change what later sweeps ask (refinement triggers on disagreement), so real refinement load may be a bit higher.
  - Three fixtures and up to 24 game months were measured, not real player sessions.
- **The service's prompt template is unknown.** The tokens your d1-3B server adds around `state` and each question aren't visible from this repo. Billed tokens on a hosted API could be 10–30% higher than counted here. The `usage.input_tokens` field in hosted responses will tell you.
- **Self-host throughput is an estimate from FLOPs, not a benchmark.** Liquid's 8 ms per decision on an RTX 4090 is single-stream; batched throughput should be much higher. Benchmark d1-3B under vLLM or SGLang on one rented L40S before committing.
- **Hosted `d1` is not d1-3B.** Its answers may differ, so re-run the calibration checks. Its rate limits and context limits are unpublished.
- **The concurrency-to-DAU ratio (3%) is a rule of thumb.** Measure it after launch.
- **Prices change.** Clef-flash's price fell 58% on 9 October, and `d1` went from $0.04 to $0.02 between its launch blog and the pricing page. Re-check before signing anything.
- **Not covered:** the narrator LLM (`server/narrator.js`, prose and chronicle) is a separate model with its own cost. It writes far less, but it needs its own estimate.
- **Infrastructure work for any cloud option:** `server/system1.js` only allows LAN or loopback endpoints. It runs as Vite middleware, so production needs a standalone proxy, for example a Node server or a Cloudflare Worker.

---

## 8. Sources

All accessed 20 October 2026.

**Decision models**
- Liquid AI pricing: https://www.liquid.ai/pricing
- Liquid d1 API docs: https://docs.liquid.ai/lfm/models/d1
- Liquid decision-model docs: https://docs.liquid.ai/lfm/models/decision-models.md
- d1-3B model card: https://huggingface.co/LiquidAI/d1-3B and https://docs.liquid.ai/lfm/models/d1-3b
- d1 open release blog: https://www.liquid.ai/blog/d1-open
- d1 launch blog ($0.04): https://www.liquid.ai/blog/d1-decision-model
- d1-ultra blog (per-question billing): https://www.liquid.ai/blog/d1-ultra
- Liquid game example: https://docs.liquid.ai/examples/laptop-examples/build-a-game-with-decision-models.md
- LFM Open License: https://www.liquid.ai/lfm-license and https://docs.liquid.ai/lfm/help/model-license.md
- vLLM deployment for LFM: https://docs.liquid.ai/deployment/gpu-inference/vllm.md
- ONNX and WebGPU: https://docs.liquid.ai/deployment/on-device/onnx.md and https://huggingface.co/onnx-community/d1-3B-ONNX
- LFM2-2.6B tokenizer and config: https://huggingface.co/LiquidAI/LFM2-2.6B
- TypeSafe Jev: https://typesafe.ai, https://docs.typesafe.ai/models.md, https://docs.typesafe.ai/api/errors.md, https://typesafe.ai/blog/introducing-system-one-models-and-jev
- Jev on OpenRouter: https://openrouter.ai/typesafe and https://openrouter.ai/docs/guides/community/typesafe-sdk
- OpenRouter model list: https://openrouter.ai/api/v1/models

**Cloudflare**
- Workers AI pricing (page dated 20 Oct 2026): https://developers.cloudflare.com/workers-ai/platform/pricing/
- Limits: https://developers.cloudflare.com/workers-ai/platform/limits/
- Model catalogue: https://developers.cloudflare.com/workers-ai/models/
- Llama 3.2 3B model page: https://developers.cloudflare.com/workers-ai/models/llama-3.2-3b-instruct/
- JSON mode: https://developers.cloudflare.com/workers-ai/features/json-mode/
- LoRA: https://developers.cloudflare.com/workers-ai/features/fine-tunes/loras/
- Batch API: https://developers.cloudflare.com/workers-ai/features/batch-api/
- Changelog: https://developers.cloudflare.com/changelog/product/workers-ai/
- AI Gateway pricing: https://developers.cloudflare.com/ai-gateway/reference/pricing/
- Clef-flash model card: https://huggingface.co/Cloudflare/clef-flash
- Cloudflare AI platform blog: https://blog.cloudflare.com/ai-platform/
- Replicate acquisition: https://www.businesswire.com/news/home/20251117400765/en/Cloudflare-to-Acquire-Replicate-to-Build-the-Most-Seamless-AI-Cloud-for-developers

**GPUs**
- Modal: https://modal.com/pricing and https://modal.com/docs/guide/cold-start
- Baseten: https://www.baseten.co/pricing/ and https://docs.baseten.co/deployment/autoscaling
- RunPod: https://www.runpod.io/pricing and https://docs.runpod.io/serverless/pricing
- Koyeb: https://www.koyeb.com/pricing
- Cerebrium: https://www.cerebrium.ai/pricing
- Beam: https://www.beam.cloud/pricing
- fal: https://fal.ai/pricing
- Replicate: https://replicate.com/pricing
- Lambda: https://lambda.ai/pricing
- CoreWeave: https://www.coreweave.com/pricing
- Hetzner: https://www.hetzner.com/dedicated-rootserver/matrix-gpu/
- OVHcloud: https://www.ovhcloud.com/en/public-cloud/prices/
- AWS: https://aws.amazon.com/ec2/pricing/on-demand/ and the AWS pricing JSON; reserved prices via https://instances.vantage.sh/aws/ec2/g6.xlarge
- GCP (third-party, built from the Billing API): https://gcloud-compute.com/g2-standard-4.html
- Azure: https://prices.azure.com/api/retail/prices
- Vast.ai offers API: https://vast.ai/pricing
- NVIDIA datasheets for dense TFLOPS: https://www.nvidia.com/en-us/data-center/l4/, https://www.nvidia.com/en-us/data-center/l40s/, https://www.nvidia.com/en-us/data-center/h100/
- LFM2 technical report: https://arxiv.org/pdf/2511.23404

**Stock token APIs**
- DeepInfra: https://deepinfra.com/pricing, https://deepinfra.com/meta-llama/Meta-Llama-3.1-8B-Instruct-Turbo, https://docs.deepinfra.com/chat/log-probs, https://docs.deepinfra.com/private-models/custom-llms, https://docs.deepinfra.com/account/rate-limits
- Novita: https://novita.ai/pricing, https://docs.novita.ai/guides/LLM-FAQ
- OpenRouter endpoints: https://openrouter.ai/api/v1/models, https://openrouter.ai/api/v1/models/meta-llama/llama-3.1-8b-instruct/endpoints
- AWS Bedrock: https://aws.amazon.com/bedrock/pricing/, https://pricing.us-east-1.amazonaws.com/offers/v1.0/aws/AmazonBedrock/current/us-east-1/index.json, https://docs.aws.amazon.com/bedrock/latest/userguide/import-model-calculate-cost.html, https://docs.aws.amazon.com/bedrock/latest/userguide/invoke-imported-model.html
- Together AI: https://www.together.ai/pricing, https://www.together.ai/models/tev1-4b-experimental, https://docs.together.ai/docs/logprobs, https://docs.together.ai/docs/serverless-models, https://docs.together.ai/docs/dedicated-endpoints/custom-models
- Fireworks: https://fireworks.ai/pricing, https://docs.fireworks.ai/serverless/pricing.md, https://docs.fireworks.ai/api-reference/post-chatcompletions, https://docs.fireworks.ai/models/uploading-custom-models, https://docs.fireworks.ai/guides/quotas_usage/rate-limits
- Vertex AI: https://cloud.google.com/vertex-ai/generative-ai/pricing, https://cloud.google.com/vertex-ai/pricing, https://discuss.ai.google.dev/t/missing-logprobs-support-in-the-newest-gemini-models-3-1-pro-3-6-flash-on-vertex-ai-and-ai-studio/176557
- Groq: https://console.groq.com/docs/models, https://console.groq.com/docs/openai
- Cerebras: https://inference-docs.cerebras.ai/models/overview
- Nebius: https://tokenfactory.nebius.com/model-catalog.md
- Hyperbolic: https://hyperbolic.ai/docs/inference/overview
- Vercel AI Gateway listing for d1: https://vercel.com/ai-gateway/models/d1
- Cloudflare's closing of the Replicate acquisition (1 Dec 2025, in its 10-Q): https://www.sec.gov/Archives/edgar/data/0001477333/000147733326000054/cloud-20260630.htm
