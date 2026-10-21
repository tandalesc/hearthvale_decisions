# Hosting Hearthvale on Cloudflare

How to move Hearthvale to Cloudflare, and where Cloudflare's AI products fit. Written 21 October 2026 against `a5347fc`. This is a plan only: nothing was deployed, no Cloudflare resources were created, and no game code changed. `cloudflare/` holds an untested sketch of the Worker and its config. Every Cloudflare limit and price below was read from developers.cloudflare.com on that date (sources at the end). Prices change, so check them again before you commit.

---

## 1. The short answer

**Do you need a Worker? Yes, one.** That one Worker also serves the game, so you don't need Pages or anything else for hosting.

**Can you just serve the app, since it's JS? No.** The game runs in the browser, but three things must stay on a server you control:

1. **The model key.** The decision service and the narrator need a key. Anything in the bundle is public. A static site would have to ship the key or call an open model endpoint, and either one is an open tap on your GPU or your bill.
2. **The question rendering and checks.** The browser sends `{kind, id, context}`. The server checks every field and writes the actual model prompt (`renderQuestion`), so players can't send the model arbitrary text. The narrator works the same way: the server builds the prompt from checked facts.
3. **The limits and the shared cache.** Per-player and daily caps only work if players can't skip them. The shared answer cache only works if every player goes through it.

**What you need:**

- A Cloudflare account on **Workers Paid** ($5 a month). Free works for a private test, but its 10 ms CPU limit and 50 subrequests per request are tight, and Workers AI past the free daily allowance needs Paid.
- A domain on Cloudflare (or start on `*.workers.dev`).
- **One Worker with static assets** that serves `dist/` and runs `/api/*`.
- **Workers VPC** with a Cloudflare Tunnel on your LAN, so the Worker can reach rrh-llm-1 without giving it a public address.
- **Workers AI** for the narrator, through **AI Gateway** for logs and caching. This one is optional: the narrator can stay on your box.
- A **Rate Limiting binding** and a small **Durable Object** for the caps.
- The decision model **stays on your GPU** (or a rented one). Workers AI can't host d1-3B (section 5).

---

## 2. What the server does today

`server/serve.js` (production), plus the two Vite plugins it mounts, `server/system1.js` and `server/narrator.js`. The same plugins run inside `vite dev` and `vite preview`.

| # | Duty | Where | Details |
|---|---|---|---|
| 1 | **Static files** | `serve.js` `serveStatic` | Serves `dist/`, falls back to `index.html` for unknown paths, gzips text over 1 KB, sets `immutable` on hashed `assets/` and `no-cache` on the rest, and blocks path escapes. GET, HEAD and POST only. |
| 2 | **Secret** | `system1.js` `loadLocalConfig` | `API_KEY` from `local.env` or the environment. Sent upstream only, as `x-litellm-api-key`, for decisions and prose alike. |
| 3 | **Endpoint allowlist** | `loadLocalConfig`, `upstreamUrl` | The upstream must be `http://rrh-llm-1…` or loopback on `/v1/decisions`. Only `/v1/decisions` and `/v1/decisions/batch` are called. Redirects are refused. |
| 4 | **Config file shield** | `system1.js` middleware | Any path naming `local.env` or `.env*` gets 403. |
| 5 | **Decision proxy** | `POST /api/decisions` | Same-origin check, JSON only, 1 MB body cap. Validates groups and questions (64 at most). Renders prompts with positional keys, so client ids never reach the model. Splits and retries on an upstream 413. 15 s upstream timeout, 4 MB answer cap. Normalises answers. |
| 6 | **Concurrency gate** | `createConcurrencyGate` | Decisions: 4 upstream at once, a queue of 8, 1 s wait. Inspector notes: 2 at once. Card and chronicle prose: 1 at once, a queue of 16. A full queue returns 429. |
| 7 | **Answer cache** | `createAnswerCache` | In-memory LRU, 50k answers, shared by every player. Key: kind, canonical state and context. Lossless, because the model returns a distribution the game samples. |
| 8 | **Limits** | `createLimits` | `DECISIONS_CLIENT_QPS`: a token bucket per client IP with 4 s of burst. `DECISIONS_DAILY_CAP`: questions per UTC day for the whole service. Only questions sent upstream count. Past a limit, the player gets 429 or 503 and the town uses local rules. Both are off by default. |
| 9 | **Status** | `GET /api/system1/status` | Probes `/v1/models` with the key (3 s timeout) and reports state, model, in-flight requests and cache stats. The Settings screen calls it. |
| 10 | **Narrator, streamed** | `POST /api/narrate` | 8 KB body cap. Builds the prompt from validated facts. Streams OpenAI-style SSE from `/v1/chat/completions` and re-emits it as `meta`, `data {t}`, `done` and `error` events. Cleans the text as it streams. 6 s timeout. Tries two models in turn. Caches 500 notes and shares one completion between identical taps in flight. |
| 11 | **Card and chronicle prose** | same route, `kind: card \| chronicle` | Non-streamed JSON. Asks for `response_format: json_object` and retries without it on a 400. Checks the reply (`CHECKS`) and retries once with a hint. Falls back to template text. Caches 300 results. 15 s timeout. |
| 12 | **Response hygiene** | throughout | `Cache-Control: no-store`, `nosniff`, `Retry-After` on 429, `X-Accel-Buffering: no` on streams. |

The Dockerfile builds `dist/` and runs `node server/serve.js` on port 3001, with `local.env` bind-mounted. `vite.config.js` allows `hearthvale.ramblerun.net` as a preview host and blocks secrets in the dev file server.

---

## 3. Recommended architecture

```
 Browser (game, sim worker)
   │  https://hearthvale.<your-domain>
   ▼
 ┌──────────────────────── Cloudflare ───────────────────────────┐
 │ Worker "hearthvale"                                            │
 │  ├─ static assets (dist/)  ← served free, no Worker code runs  │
 │  └─ /api/* (run_worker_first)                                  │
 │       ├─ /api/decisions ─ checks, cache, limits ──┐            │
 │       │    Cache API + in-memory LRU              │            │
 │       │    Rate Limiting binding, DailyCap DO     │            │
 │       ├─ /api/narrate ── env.AI.run(stream) ──► AI Gateway ──► Workers AI
 │       └─ /api/system1/status                      │            │
 │  secret: API_KEY                                  │            │
 │                                     VPC Service binding        │
 └──────────────────────────────────────────┬─────────────────────┘
                                            │ Cloudflare Tunnel (outbound only)
 ┌──────────────── your LAN ────────────────┴──────┐
 │ cloudflared ──► http://rrh-llm-1:4000            │
 │                 LiteLLM → d1-3B /v1/decisions    │
 │                 (GPU state cache)                │
 └──────────────────────────────────────────────────┘
```

- **One Worker with static assets, not Pages.** Asset requests are free and unlimited, and they don't run Worker code. Cloudflare's migration guide says Workers has "a distinctly broader set of features" than Pages, including Workers Logs, gradual deployments and source maps. Set `not_found_handling = "single-page-application"` and `run_worker_first = ["/api/*"]`.
- **Decisions go to your box through Workers VPC.** `cloudflared` on the LAN dials out to Cloudflare. A VPC Service binding lets this one Worker reach one host and port: no public hostname, no open port, and no other machine on your network. Workers VPC is in beta and free on all plans for now.
- **The narrator can move to Workers AI** or stay on the box (section 6 and choice 1 in section 10). It goes through AI Gateway for logs, analytics and a cache.
- **The key stays a Worker secret** (`wrangler secret put API_KEY`). Locally it lives in `cloudflare/.dev.vars`, which `.gitignore` must cover.

---

## 4. What maps where

| Today | On Cloudflare | Notes |
|---|---|---|
| 1. Static files from `dist/` | **Workers static assets** (`[assets] directory = "../dist"`) | SPA fallback with `not_found_handling`. Defaults are `max-age=0, must-revalidate` plus an ETag. Add a `dist/_headers` file (from `public/_headers`) to keep `immutable` on `/assets/*`. |
| 2. `API_KEY` | **Worker secret** (`wrangler secret put API_KEY`) | Read as `env.API_KEY`. Secrets Store is the account-wide option, if more Workers ever share it. |
| 3. Endpoint allowlist | **The VPC Service binding** | The binding only reaches the host and port you registered, and the URL host is ignored for routing. Keep the path allowlist (`upstreamUrl`). The LAN hostname moves out of the repo into Cloudflare config. |
| 4. Config file shield | **Not needed** | Only `dist/` is uploaded. Keep `.dev.vars*` and `.env*` in `.gitignore`. |
| 5. Decision proxy | **Worker code**: reuse `createDecisionService` with `fetcher = (url, init) => env.DECISIONS.fetch(url, init)` | Needs the split in step 6 of section 8. The upstream timeout and 413 splitting carry over unchanged. |
| 6. Concurrency gate | **Mostly drop it; keep a small per-isolate gate** | Each Worker isolate has its own memory, so a global "4 at once" is gone. A Worker invocation can wait on 6 connections at once. Your box is now the bottleneck, so cap it at the box: LiteLLM's own parallel-request limit. The per-player limit below does most of the work. |
| 7. Answer cache (50k LRU) | **In-memory LRU per isolate + the Cache API** | The Cache API is per data centre, has no separate charge on the pricing page, and needs a GET key, so hash each question's cache key into a synthetic URL. KV and D1 cost too much at this volume (section 7). |
| 8a. Per-client QPS | **Rate Limiting binding**, keyed by a session id | Counts per Cloudflare location, approximately. Periods are only 10 s or 60 s. Cloudflare advises against keying on IP. Section 7 has the details. |
| 8b. Daily cap | **A `DailyCap` Durable Object** (SQLite, works on Free) | Isolates add up their own counts and send them every few seconds, so the object sees a handful of requests a second instead of every request. |
| 9. Status | **Worker route**: probe `/v1/models` through the VPC binding | Report `cache` stats per isolate only, or drop them. |
| 10. Narrator stream | **`env.AI.run(model, {messages, stream: true}, {gateway: {id}})`** | Returns a `text/event-stream`. The docs don't spell out the event format. If it is `data: {"response": "…"}` and not OpenAI deltas, `readDeltas` needs one more field. Check it on the first test. |
| 11. Card and chronicle prose | **`env.AI.run` without streaming** | `response_format` is listed on the candidate models. Keep the checks, retries and template fallback as they are. |
| 12. Response hygiene | **Worker code** | Unchanged. |
| Dockerfile, `serve.js` | **Not used on Cloudflare** | Keep both for LAN and self-hosting. `vite dev` stays the dev loop. `wrangler dev` checks the Worker. |

---

## 5. The decision model: why it stays on your GPU

**Workers AI can't host d1-3B today.**
- Custom weights on Workers AI means **LoRA adapters** only. They are in open beta, need rank 32 or less, files under 300 MB, and a `mistral`, `gemma` or `llama` base. d1-3B is a full model on Liquid's LFM2.5 backbone, not an adapter on one of those bases.
- **Bring-your-own-model** (Replicate's Cog containers) is "in development" in Cloudflare's April 2026 AI platform post. No self-serve date has been announced. Today custom models run on dedicated Enterprise instances, through the "Custom Requirements Form".
- The custom `/v1/decisions/batch` API and the **GPU state cache** are features of your server. A hosted model wouldn't have them.

**The nearest Cloudflare model is `@cf/cloudflare/clef-flash`.** It is a 9B decision model with the same System One shape:
- It takes `state` plus 1–64 typed `noul`, `choice` or `score` questions and returns probabilities. That is what `buildDecisionPayload` sends for a single group. It also has a 24,576-token context.
- It costs **$0.038 per million input tokens, with no output charge.**
- It works as a **fallback**, but not as the main path, for three reasons:
  1. **It isn't your model.** Its calibration differs, so the `migration_wave` and `take_loan` checks in HANDOFF.md would have to be redone.
  2. **It takes one state per call.** A town's request carries about 9 states and a city's about 25 (`decision-model-hosting-costs.md` §2.3). One city player would need about 15 calls a second.
  3. **Rate limits.** Workers AI's default for text generation is **300 requests a minute** (5 a second) per account. The limits page doesn't list Clef separately. If Clef shares that limit, one city player would exceed it alone. You would need a raised limit from Cloudflare first.

**How to reach your box, best first:**
1. **Workers VPC (recommended).** Create the tunnel in the Workers VPC dashboard and run its `cloudflared` command on a LAN machine that can reach rrh-llm-1. Register an HTTP VPC Service for `rrh-llm-1` on port 4000 and bind it to the Worker. There is no public hostname, and the service can't be used to reach other hosts.
2. **A public tunnel hostname behind Cloudflare Access.** Run `cloudflared tunnel route dns` to something like `decisions.<domain>`, and add an Access application with a **Service Auth** policy. The Worker then sends `CF-Access-Client-Id` and `CF-Access-Client-Secret` (both as Worker secrets). Use this if you want AI Gateway in front of the decision box, because AI Gateway custom providers need a public **HTTPS** `base_url`. Cloudflare's Access product page says the free plan suits teams under 50 users. The service-token docs don't cover pricing.
3. **Don't** open port 4000 to the internet.

**Fix the box either way.** HANDOFF.md says the LAN service answered without a key. Through the tunnel, anything that reaches `cloudflared` reaches LiteLLM. Turn on LiteLLM's master-key check, and test that a request without `x-litellm-api-key` gets 401.

**AI Gateway in front of the decision model: not at first.** Its cache key is the whole request body. Decision requests mix many questions, so a whole request rarely repeats, and the Worker's per-question cache does better. Its rate limits count requests, not questions. Its logs would help, but only through option 2's public hostname. Add it later if you want dashboards or a clef-flash fallback route.

---

## 6. The narrator on Workers AI

**It can run there.** The narrator is plain chat completion. Nothing about it needs your fine-tune. Candidate models and their prices:

| Model | Input $/M | Output $/M | Notes |
|---|---:|---:|---|
| `@cf/google/gemma-4-26b-a4b-it` | 0.100 | 0.300 | MoE with 4B active and a 256k context. Lists `response_format`. It is listed as a reasoning model, so check that thinking can be turned off (`chat_template_kwargs` is listed but not documented). The first one to try. |
| `@cf/meta/llama-3.2-3b-instruct` | 0.051 | 0.335 | Not a reasoning model, and the cheapest. Card JSON and voice may suffer at 3B. |
| `@cf/zai-org/glm-4.7-flash` | 0.0605 | 0.400 | Reasoning model, described as "fast". Same thinking question as Gemma. |
| `@cf/meta/llama-3.1-8b-instruct-fp8` | 0.152 | 0.287 | Plain instruct model at 8B. Costs more for this input-heavy load. |

The pricing page still lists `llama-3.1-8b-instruct-fp8-fast` at $0.045/$0.384, but its model page now redirects to "model not available". Don't plan on it.

- **Billing.** Workers AI bills in Neurons at **$0.011 per 1,000**, with **10,000 Neurons free a day**.
- **Streaming.** Streaming works from a Worker: `env.AI.run(model, {messages, stream: true})` returns a stream you hand straight to `new Response(stream, {headers: {'content-type': 'text/event-stream'}})`. The Worker keeps running while it streams, and wall time has no limit while the client stays connected. Waiting on the model doesn't count as CPU time.
- **AI Gateway.** Pass `{gateway: {id: 'hearthvale'}}` as the third argument to get logs, analytics and a cache. The cache key is the whole request. Inspector notes for the same material facts repeat across players, so the gateway cache helps there. Your Worker should still keep the in-memory LRU and the in-flight sharing. AI Gateway's core features are free. A gateway made after 24 September 2026 keeps its logs in Workers Logs, priced separately.
- **What to change in `narrator.js`:**
  - Make `NARRATOR_MODELS` configurable.
  - Call `env.AI.run` through an adapter in place of `fetch(completionsUrl(config))`.
  - Teach `readDeltas` the Workers AI event field, if it turns out to differ.
  - Run the voice checks (`CHECKS`, the house-voice lint) on a sample of real cards before switching. A new model will write differently.
  - The narrator's injection filter (HANDOFF.md) belongs to the old service. Check what blocks "forget"-style words on the new path.
- **Or keep the narrator on your box.** It is the same tunnel and the same key, so the Worker just proxies the stream. That costs nothing per token, but prose competes with decisions for the one GPU. Section 9 shows why this matters as you grow.

---

## 7. The cache and the limits, in detail

**Answer cache.** Today one process holds 50k answers. On Workers, each isolate is short-lived and each data centre is separate.

- **Tier 1: an in-memory LRU per isolate.** Reuse `createAnswerCache(5000)` at module scope. It's free, and it catches repeats from the same player, who is usually routed to the same data centre.
- **Tier 2: the Cache API.** `caches.default` with a synthetic GET URL such as `https://cache.hearthvale/a/<sha256 of the key>`. Store the answer JSON with `Cache-Control: max-age=86400`. It is shared by every player in that data centre.
  - It needs a custom domain; the docs only promise it there.
  - It is per data centre, so players on different continents don't share.
  - A request with 64 questions means up to 64 `match` calls. That is fine on Paid; on Free it may hit the 50-subrequest limit.
- **Not KV.** One read per question at a city's ~23 questions a second is 83k reads per player-hour. At 100 concurrent players that is about 6 billion reads a month, or roughly **$3,000 a month** at $0.50 per million. Writes ($5 per million) are worse, and KV is eventually consistent anyway (up to 60 s).
- **Not D1.** Reads are cheap ($0.001 per million rows), but every upstream answer is a row write at $1 per million. At 100 players and 5 questions a second each, that is about 1.3 billion writes, or **~$1,300 a month**. D1 also has one primary region, which adds latency.
- The browser client already has its own 8,192-answer cache for repeats within a player. The server cache only adds sharing across players, so a lossy edge cache costs little.

**Per-player limit.** Today it is a token bucket per IP.

- **Rate Limiting binding** (`[[ratelimits]]`, `period` of 10 or 60 s). It counts calls, not questions. Two ways to fit it:
  - (a) limit requests: for example 30 requests per 10 s. Each request holds at most 64 questions, so this caps questions per player roughly; or
  - (b) call `limit()` once per started batch of 16 upstream questions.
- **The key.** Counts are per location and eventually consistent, and Cloudflare advises against IP keys. Issue each player a session id: an HMAC-signed cookie, with the HMAC key as a Worker secret. Key on that, and add a looser per-IP limit as a backstop.
- **Strict alternative.** For a strict limit, Cloudflare recommends a Durable Object per player holding the bucket. That is an exact port of `createLimits`, but every upstream request then costs a DO request ($0.15 per million).
- **Code change for a DO bucket.** `createDecisionService` calls `limits.take()` without `await`. An async limit needs an `await` there. The binding avoids this by checking before `handle()`, as the sketch does. That also counts requests the cache answers in full, which is fine for a coarse limit.

**Daily cap.**

- **A single `DailyCap` Durable Object.** Its soft limit is 1,000 requests a second per object, so don't call it once per player request.
- **Each isolate keeps a running count** and sends it with `ctx.waitUntil` every ~5 s. The object answers with today's total, and the isolate refuses once the total passes the cap.
- **Overshoot.** The cap can overshoot by a few seconds of traffic, which is fine for a spending guard. The cost is close to nothing: a few requests a second and well within the 400,000 GB-s of duration included on Paid.

**Concurrency.** There is no global gate any more. Protect the box at the box: LiteLLM `max_parallel_requests`, plus a queue timeout below the Worker's 15 s upstream timeout. A busy box then answers 429 quickly, and the game already falls back to local rules.

---

## 8. Setup checklist

Do these in order. Nothing here was run for this document.

**Accounts and tools**
1. Create a Cloudflare account, add your domain (or skip it and use `*.workers.dev` at first), and subscribe to **Workers Paid**.
2. Install Wrangler 4.36 or later as a dev dependency (`npm i -D wrangler`), then run `npx wrangler login`. The Rate Limiting binding needs 4.36.

**Lock down the box first**
3. On rrh-llm-1, require a LiteLLM key. Confirm that a request without one gets 401.
4. Cap LiteLLM's parallel requests to what `node scripts/benchmark-decisions.js` says the box can take.

**Code changes (one PR, before any deploy)**
5. Split `server/system1.js`. Move everything above `system1Plugin` that has no `node:fs`/`node:util`/`node:path` use into `server/decision-service.js`, and leave `loadLocalConfig` and the Vite plugin in `system1.js`. Do the same for `narrator.js`: keep the service and the prompts, and move the plugin and `readBody` out. The Worker then imports only plain JS. (`nodejs_compat` lists `node:fs` and `node:util`, but don't depend on `util.parseEnv` existing in workerd.)
6. Keep `limits.take` synchronous. The sketch checks the per-player limit before `handle()`, and its daily cap reads a local copy of the day's total, which the `DailyCap` object refreshes every few seconds. Add `await` to `limits.take()` only if you later move to a Durable Object per player.
7. Make `NARRATOR_MODELS` and the narrator transport configurable. Accept the Workers AI stream format in `readDeltas` if it differs.
8. Move `_headers` into `public/` so `dist/` ships it:
   ```
   /assets/*
     Cache-Control: public, max-age=31536000, immutable
   ```
9. Finish `cloudflare/worker.js`, the sketch in this PR. It still needs the session cookie, the Cache API tier and a test run. `.gitignore` now covers `.dev.vars*` and `.wrangler/`.

**Tunnel and VPC**
10. In the dashboard, under Workers VPC, create a tunnel. Run the `cloudflared` install command it gives you on a LAN machine that can reach `rrh-llm-1:4000`, ideally as a service so it restarts.
11. Create the VPC Service:
    ```bash
    npx wrangler vpc service create hearthvale-decisions --type http --tunnel-id <TUNNEL_ID> --hostname rrh-llm-1 --http-port 4000
    ```
    Put the service id it prints into `cloudflare/wrangler.toml` under `[[vpc_services]]`. (This needs the Connectivity Directory Admin role, which an account owner has.)

**AI Gateway and Workers AI**
12. In the dashboard, create an AI Gateway called `hearthvale`. Turn on caching (a TTL of a day or so) and log collection. Set a gateway rate limit as a coarse backstop.
13. Nothing to create for Workers AI. The `[ai]` binding is enough.

**Bindings and secrets**
14. In `cloudflare/wrangler.toml`, pick a unique `namespace_id` for `[[ratelimits]]`. The `DailyCap` Durable Object migration is already in the sketch.
15. Set the secrets:
    ```bash
    npx wrangler secret put API_KEY -c cloudflare/wrangler.toml
    ```
    ```bash
    npx wrangler secret put SESSION_SECRET -c cloudflare/wrangler.toml
    ```
    Add `CF_ACCESS_CLIENT_ID` and `CF_ACCESS_CLIENT_SECRET` too, only if you chose the public hostname plus Access route.

**Try it, then ship**
16. `npm run build`, then `npx wrangler dev -c cloudflare/wrangler.toml`. With `remote = true` on the VPC binding, local dev reaches the real box. Play a town at 1× and at 10×. Watch `/api/system1/status` and the AI Gateway logs.
17. `npx wrangler deploy -c cloudflare/wrangler.toml`.
18. **DNS.** In the dashboard, add a Custom Domain to the Worker (for example `hearthvale.<domain>`). Cloudflare creates the DNS record and certificate. Then update `preview.allowedHosts` in `vite.config.js`, or drop it.

**Before going public**
19. Set the caps (the daily cap var and the rate limit numbers). Scrub `rrh-llm-1` and `ramblerun/*` from code and docs, since the hostname now lives in Cloudflare config. Add a licence (HANDOFF.md, "Before making the repo public").

---

## 9. Costs

**Assumptions:**
- **Player counts.** Average concurrent players, as in `decision-model-hosting-costs.md`. 10, 100 and 1,000 concurrent is about 300, 3k and 30k daily players, or 7.3k, 73k and 730k player-hours a month.
- **Worker requests.** About **1 a second per player**. Decision requests run 0.4–0.6 a second for essentials, and the 11.5–23 questions a second in HANDOFF.md batch to about 12–29 questions per request. Narration adds a little. Asset requests are free.
- **Worker CPU.** About **2 ms per request** for validation, canonical JSON and hashing. Measure it with `wrangler dev` and Workers Logs.
- **Narration per player-hour at 1×.**
  - About 60 inspector notes (~700 tokens in, ~80 out).
  - About 100 card prose calls, including retries (~1,700 in, ~300 out). Eras give 1–4 cards a game year, and a year is 2 minutes.
  - About 30 year lines (~600 in, ~60 out).
  - Total: ~230k tokens in and ~37k out. These counts are **estimates, not measured**.

**Fixed and Worker costs (Workers Paid):**

| | 10 concurrent | 100 | 1,000 |
|---|---:|---:|---:|
| Base plan | $5 | $5 | $5 |
| Requests (10M included, then $0.30/M) | 26M → $5 | 263M → $76 | 2.6B → $785 |
| CPU (30M ms included, then $0.02/M ms) | $0.5 | $10 | $105 |
| Static assets, Cache API, AI Gateway core, Workers VPC (beta), Tunnel | $0 | $0 | $0 |
| DailyCap DO (batched) | ~$0 | ~$0 | ~$0 |
| **Worker subtotal** | **~$10** | **~$90** | **~$895** |

**Narrator** (per player-hour, then per month):

| Model | $/player-hour | 10 | 100 | 1,000 |
|---|---:|---:|---:|---:|
| Llama 3.2 3B | ~$0.024 | ~$175 | ~$1.7k | ~$17k |
| Gemma 4 26B A4B | ~$0.034 | ~$250 | ~$2.5k | ~$25k |
| Llama 3.1 8B fp8 | ~$0.045 | ~$330 | ~$3.3k | ~$33k |
| Kept on your box | $0 on Cloudflare | – | – | – |

The free 10,000 Neurons a day is about $0.11, or about 4–5 player-hours of narration a day. **Card prose is about three-quarters of these tokens.** Count real narration calls per player-hour before trusting this row.

**Decisions:**

| Where | What you pay | Fits |
|---|---|---|
| **rrh-llm-1 through Workers VPC** | $0 on Cloudflare. Power and the box. | Friends and a soft launch, with caps on. The cost doc found one uncapped player can fill it. Measure with the benchmark. |
| Rented d1-3B GPU, same Worker and VPC (or a public tunnel plus Access) | About $3.90–7.14 per million questions (`decision-model-hosting-costs.md` §5), and $320–580 a month per always-on L4 | The path past about 100 concurrent players |
| `clef-flash` on Workers AI | $11.40 per million questions (~300 tokens each, state paid per question): **$0.21/player-hour at a 5 q/s cap**, $0.47 at 11.5 q/s, $0.94 at 23 q/s | A fallback only, unless Cloudflare raises the 300 req/min limit |

**Putting it together**, for the recommended setup with the decisions on your own GPU and the narrator on Workers AI (Llama 3.2 3B to Gemma 4):

| Concurrent players | Cloudflare bill a month | Plus |
|---|---:|---|
| 1–3 (you and friends) | $5 (Free would almost do) | your box |
| 10 | ~$185–260 | your box |
| 100 | ~$1.8k–2.6k | rented GPU(s) for decisions, ~$600–1,500 |
| 1,000 | ~$18k–26k | GPU fleet, per the cost doc |

With the narrator kept on your box, the Cloudflare bill is just the Worker subtotal: about $10, $90 and $895.

At 10× and 20× a city asks about 104–194 questions a second (HANDOFF.md). The per-player limit is what keeps those players from costing 5–10× more. Scale the limit with game speed, as the cost doc suggests, rather than lifting it.

---

## 10. Risks and open choices

**Risks**
- **Workers VPC is beta.** Its APIs may change, and "free during beta" may end. The fallback is option 2 in section 5 (public tunnel hostname plus Access), which is generally available.
- **Your box is a single point of failure.** If it or the LAN goes down, every town runs on local rules. That is safe, but it's a worse game. `cloudflared` can run several connectors for one tunnel, but they all point at the same GPU.
- **Home uplink.** Every decision crosses your home connection twice. The bodies are small (1–5 KB per request), but latency adds to the 5 s question cutoff. Measure from a phone off your Wi-Fi.
- **Rate limits are approximate.** The binding counts per location and syncs late. A determined player can go past the per-player rate. The daily cap is the real spending guard.
- **A narrator model swap changes the voice.** The checks and template fallback keep the game safe, but run the house-voice lint on real output before switching.
- **The Cache API needs a custom domain.** The docs only promise it on one, so on `workers.dev` the shared cache may do nothing.
- **Unverified details** (test them on the first deploy):
  - the Workers AI SSE event format;
  - whether AI Gateway custom providers pass `CF-Access-*` headers through;
  - Rate Limiting binding pricing (not on the pricing page);
  - whether Clef shares the 300 requests-a-minute text limit.

**Choices for you**
1. **Narrator: Workers AI or your box?** Workers AI frees the GPU for decisions and has no hardware to run, but it costs about $0.02–0.04 per player-hour, which is the biggest line on the bill. The box is free per token but shares the GPU. My suggestion: keep the narrator on the box while you're small. Try Gemma 4 26B A4B on Workers AI in parallel, and switch once its voice passes and decisions need the GPU.
2. **Decisions past the box.** Rented d1-3B (keeps your calibration), Liquid's hosted d1 (per the cost doc), or clef-flash once its limits allow. All three sit behind the same Worker, so this can wait.
3. **Strict or approximate per-player limits.** The binding is cheap and approximate. A Durable Object per player is exact and costs about $0.15 per million requests.
4. **Bot protection.** A session cookie stops casual scripting but not a determined one. Cloudflare Turnstile is the usual next step; it wasn't researched here.
5. **Cloudflare Containers** could run `serve.js` unchanged. They weren't researched here, and the Worker port is small enough that they aren't needed.

---

## Sources

All read on 21 October 2026.

**Workers**
- Limits: https://developers.cloudflare.com/workers/platform/limits/
- Pricing (Workers, static assets, KV, Durable Objects, D1): https://developers.cloudflare.com/workers/platform/pricing/
- Static assets: https://developers.cloudflare.com/workers/static-assets/
- Static assets headers (`_headers`, defaults): https://developers.cloudflare.com/workers/static-assets/headers/
- Migrate from Pages to Workers: https://developers.cloudflare.com/workers/static-assets/migration-guides/migrate-from-pages/
- Rate Limiting binding: https://developers.cloudflare.com/workers/runtime-apis/bindings/rate-limit/
- Cache API: https://developers.cloudflare.com/workers/runtime-apis/cache/
- Secrets: https://developers.cloudflare.com/workers/configuration/secrets/
- Node.js compatibility: https://developers.cloudflare.com/workers/runtime-apis/nodejs/
- KV, how it works: https://developers.cloudflare.com/kv/concepts/how-kv-works/
- Durable Objects limits: https://developers.cloudflare.com/durable-objects/platform/limits/

**Workers VPC and Tunnel**
- Workers VPC: https://developers.cloudflare.com/workers-vpc/
- Get started: https://developers.cloudflare.com/workers-vpc/get-started/
- VPC Services: https://developers.cloudflare.com/workers-vpc/configuration/vpc-services/
- Cloudflare Tunnel: https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/
- Locally managed tunnel: https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/do-more-with-tunnels/local-management/create-local-tunnel/
- Access service tokens: https://developers.cloudflare.com/cloudflare-one/identity/service-tokens/
- Access plans (Cloudflare product page, not docs): https://www.cloudflare.com/products/cloudflare-access

**Workers AI**
- Pricing: https://developers.cloudflare.com/workers-ai/platform/pricing/
- Limits: https://developers.cloudflare.com/workers-ai/platform/limits/
- Model catalogue: https://developers.cloudflare.com/workers-ai/models/
- clef-flash: https://developers.cloudflare.com/workers-ai/models/clef-flash/
- gemma-4-26b-a4b-it: https://developers.cloudflare.com/workers-ai/models/gemma-4-26b-a4b-it/
- glm-4.7-flash: https://developers.cloudflare.com/workers-ai/models/glm-4.7-flash/
- LoRA adapters: https://developers.cloudflare.com/workers-ai/features/fine-tunes/loras/
- OpenAI compatibility: https://developers.cloudflare.com/workers-ai/configuration/open-ai-compatibility/
- Cloudflare AI platform post (bring-your-own-model status, 16 April 2026): https://blog.cloudflare.com/ai-platform/

**AI Gateway**
- Overview: https://developers.cloudflare.com/ai-gateway/
- Pricing: https://developers.cloudflare.com/ai-gateway/reference/pricing/
- Caching: https://developers.cloudflare.com/ai-gateway/features/caching/
- Custom providers: https://developers.cloudflare.com/ai-gateway/configuration/custom-providers/
- Workers AI binding with a gateway: https://developers.cloudflare.com/ai-gateway/integrations/aig-workers-ai-binding/

**In this repo:** `cloudflare/wrangler.toml` and `cloudflare/worker.js` (an untested sketch of the plan above), `HANDOFF.md` ("Decision model", "Decision load and high speeds", "LLM prose", "Before making the repo public") and `docs/design/decision-model-hosting-costs.md`.
