# Hosted Hearthvale

The browser runs the simulation, rendering and student model. Cloudflare serves static assets and a small API Worker. SQLite-backed Durable Objects hold accounts, budgets, learning reports and the release pointer. Private R2 stores training inputs, checkpoints and immutable releases. A CPU Container runs the nightly learning job; no developer machine or LAN service participates in production.

The configured custom domain is `hearthvale.shishirtandale.com`. Cloudflare serves it directly; no Tunnel or home server is needed. The domain is registered in the Wrangler configuration and becomes active on deployment.

## Plans and inference limits

- Free: 1×, 3× and 5× speed, browser student decisions, local text, novel-question reports and approved student updates.
- $1/month, shown first; $10/year, the same features: also 10×/20×, on-demand Haiku writing and bounded live Liquid decisions.
- Defaults per paid account per UTC calendar month: 120 narration requests and 1,000 teacher questions. These are conservative launch settings, configurable in `cloudflare/wrangler.toml`.
- Global monthly limits: 10,000 narration requests and 100,000 live teacher questions. Nightly labels have a separate 10,000-question daily cap. Report ingestion is capped separately.

Reaching an inference limit leaves the game running with local decisions and text. Speed never drives automatic writing. Opening a council card requests its optional voice; facts, option labels and effects are already visible and actionable. Inspector notes use the same paid budget. The browser requests SSE and displays complete checked sentences as they arrive. Validated narration appears as an italic, semibold serif quote with quotation marks, replacing the explanation in the card. A swap icon restores the original game explanation; the player’s selection persists while streaming finishes. The game explanation remains visible during loading and returns if a preview is rejected or cancelled. Choices and effects remain unchanged; drafts are transient and only an authoritative final result can be saved. Loading dots and the text transition respect reduced-motion settings. Closing a card or switching towns cancels its request. Narration does not block simulation ticks or UI messages. Automatic annual and end-of-game writing is disabled.

The server independently rejects free live-teacher requests, including requests with the old live header. Disabling the browser student does not grant hosted access. The browser loads the latest approved model at session start and keeps it stable while playing. Existing saved towns receive the current version in their next session. If hosting is unavailable, the shipped manifest is the fallback.

## Credentials and local development

`cloudflare/.dev.vars` is the private, Git-ignored local key file. Never put provider keys in `VITE_*` variables or browser code. Wrangler reads it with this project's configuration. Fill these values:

| Name | Purpose |
| --- | --- |
| `ANTHROPIC_API_KEY` | Direct Anthropic narration; default model `claude-haiku-5-5` |
| `LIQUID_API_KEY` | Direct hosted d1 decisions and nightly labels |
| `STRIPE_SECRET_KEY` | Stripe server API; start in test mode |
| `STRIPE_WEBHOOK_SECRET` | Signature secret for this endpoint, not the Stripe API key |
| `STRIPE_PRICE_MONTH` | Active USD recurring price: 100 cents every one month |
| `STRIPE_PRICE_YEAR` | Active USD recurring price: 1,000 cents every one year |
| `STRIPE_PORTAL_CONFIGURATION` | App-specific customer portal configuration; otherwise Stripe's default is used |
| `EMAIL_FROM` | Bare sender address on a domain onboarded to Cloudflare Email Service |
| `AUTH_SECRET` | Stable random app signing secret, at least 32 characters |
| `LEARNING_ADMIN_SECRET` | Separate random secret for manual training/status |
| `LEARNING_PUBLIC_ORIGIN` | Exact deployed HTTPS origin without a trailing slash |

The private file created during implementation already contains generated signing/admin secrets. Keep them stable. A Cloudflare account login is separate from these provider keys. Cloudflare Email Sending supports transactional sign-in links and includes 3,000 messages per month on Workers Paid; further sends cost $0.35 per 1,000. See [Email Service pricing](https://developers.cloudflare.com/email-service/platform/pricing/) and [domain setup](https://developers.cloudflare.com/email-service/get-started/send-emails/). Local sending is simulated unless a remote binding is explicitly enabled.

The production deployment uses live Stripe billing; see “Installed-app sign-in and live billing” below for validation and limitations. For a new deployment, start with test-mode credentials, prices, portal and webhook, and verify the flow before switching to live mode. Never commit credential files or provisioning state.

```sh
npm ci
npm test
npm run build
npm run dev:cloudflare
```

The Cloudflare development command requires a Docker-compatible engine for the configured training container. Ordinary `npm run dev` still serves the browser and optional legacy local providers; it does not emulate hosted billing or authentication. `tests/hosted-runtime.test.js` exercises the Worker and real Durable Object RPC/SQLite locally without running the training image.

## Cloudflare and Stripe setup

1. Enable Workers Paid, R2, Containers, and Email Sending on the Cloudflare account. Run Docker or Podman locally to build the training image, or build it in CI and configure a digest-pinned Cloudflare registry image. The production nightly run itself does not need this machine.
2. Run `npx wrangler login`. Create the private bucket with `npx wrangler r2 bucket create hearthvale-students`. Do not enable a public R2 URL: only release bundles are exposed by the Worker.
3. Choose the deployment hostname. In Cloudflare Email Service → Email Sending, onboard a domain managed by Cloudflare DNS and complete its sending DNS records. Set `LEARNING_PUBLIC_ORIGIN` and `EMAIL_FROM` (a bare address on that domain). The native `EMAIL` binding sends sign-in mail without a separate email API key. The Wrangler config includes the Worker, assets, three SQLite DO bindings, private R2, and the container; no separate Cloudflare D1 database is needed.
4. Create the two Stripe prices above. Configure the customer portal. Register `https://YOUR_HOST/api/billing/webhook` for `customer.subscription.created`, `customer.subscription.updated`, `customer.subscription.deleted`, `checkout.session.completed`, and `checkout.session.async_payment_succeeded`.
5. Run `npm run check:cloudflare`. This is a dry run, but Cloudflare still builds the Dockerfile-backed Linux AMD64 training image. With Podman running, use `WRANGLER_DOCKER_BIN="$PWD/scripts/wrangler-podman.mjs" npm run check:cloudflare`; the adapter removes Docker-only build flags. Set `PODMAN_BIN` if Podman is not on your PATH. This command does not deploy or upload secrets.
6. Once the setup is reviewed, deploy with `npm run deploy:cloudflare -- --secrets-file cloudflare/.dev.vars` to upload the filled server values with the Worker version. With Podman, use the same `WRANGLER_DOCKER_BIN` adapter setting for deployment and local development. Do not upload empty placeholders. Values already configured as Wrangler vars must be moved to secrets or omitted from the secrets file, because a binding name cannot be both.
7. Complete a Stripe test checkout, check verified-webhook access, cancel it and check expiry, and test email sign-in from another browser. Switching to live billing requires live-mode prices, API key and webhook secret.

Checkout return URLs do not grant access. Signed webhooks reconcile the customer's current subscriptions, and paid access expires at the paid-through time. Checkout creation is serialized and idempotent. Sign-in links are single-use and expire after 15 minutes. Do not log request bodies, cookies or sign-in tokens.

## Bootstrap and nightly learning

The nightly Cron runs at 07:00 UTC. It starts a job and returns; the container runs independently under an expiring lease. An alarm enforces the job timeout, including while new reports arrive. Manual and scheduled runs share one coordinator and cannot train/publish concurrently.

Before the first cloud run, stage a private copy of the existing recipe's checkpoint, replay corpus, frozen evaluation rows/questions, baseline and reference snapshots. Prepare an input config for `scripts/hosted-training-bootstrap.js` (its header documents the shape): all asset paths must be relative to one staging root. The checkpoint and bundle version must match the shipped/current release, and the bundle must contain `strike_resolve`.

```sh
node scripts/hosted-training-bootstrap.js data/loop/bootstrap-source.json data/loop/hosted-bootstrap
# Review config.json and the generated upload.sh, then upload the private assets:
BUCKET=hearthvale-students sh data/loop/hosted-bootstrap/upload.sh
```

The preparation script does not train, contact a provider or upload anything. When the bootstrap bundle was trained with the legacy local teacher, explicitly include the top-level field `teacherMigration: {approved: true, from: ["<the bundle's actual teacher field>"], to: "d1"}` in its input config. The script rejects an undeclared teacher change. Upload `bootstrap/config.json` only after its content-addressed assets. It references cloud object keys, not developer-machine paths. Subsequent successful jobs carry forward the new checkpoint and replay corpus automatically.

The accepted v7 candidate's private bootstrap staging directory is `data/strike-training/bootstrap-v7-isolated-r2/`. Its large JSONL assets are gzip-compressed, checksummed, and decoded by the training container. Review `config.json` and `upload.sh`, then run `BUCKET=hearthvale-students sh data/strike-training/bootstrap-v7-isolated-r2/upload.sh` once the bucket is ready. These private files are ignored by Git. Both earlier `bootstrap-r2` and `bootstrap-v7-r2` staging directories are superseded.

V7 extends the actual production v6 with `strike_resolve`. Full retraining passed the old gates but reduced population in paired canaries, so that candidate was rejected. The accepted variant keeps the original weights, shared vocabulary mappings and confidence calibration fixed, training only 288 new strike-specific parameters with the established six-epoch loss and optimizer. All 21 existing heads match v6 exactly over 39,261 evaluation rows; all 12 town trajectories also match. Strike held-out top-choice agreement is 93.45%, with KL 0.01492 across 397 rows. The canary towns contain no strike events, so strike quality is supported by held-out teacher labels rather than those town outcomes. See `benchmarks/strike-resolve-v7.json` for the full evidence and limitations.

The container labels only missing questions, reuses trusted paid answers, warm-starts for six epochs, retrains confidence, and applies the existing KL, per-kind, bias, tail, JS parity, size/speed and simulated-town gates plus held-out new-row and strike coverage checks. Hosted Liquid `d1` is a new teacher relative to the old local teacher: its identity is retained on new labels, and the frozen evaluation gates protect against silent distribution drift. Insufficient data, a provider failure, or a failed gate leaves the published version unchanged.

Candidate artifacts are immutable. Only a valid completion for the current job and base version can atomically advance the release counter and manifest. Deferred reports remain eligible for a later run; consumed questions are remembered to avoid paying to label them again. Release artifacts and private training data are never served by the same unrestricted path.

Automatic publication also requires complete canary population measurements for every scheduled seed in both the current and candidate runs. The candidate’s geometric mean final population must stay within a 10% decline from the current model; missing, nonpositive, nonfinite, duplicate, or mismatched measurements fail this guard. A candidate can pass every existing model and work-share gate and still be held for investigation by this population guard.

To trigger an ad hoc job or inspect status, use a trusted HTTP client against `POST /api/learning/trigger` or `GET /api/learning/status` with `Authorization: Bearer <LEARNING_ADMIN_SECRET>`. Keep that value out of command history. A manual update increments the version only after successful validation and publication, just like the nightly job.

## Validation before launch

The original test deployment was available at `https://hearthvale.shishirtandale.com`. On 2026-10-23, live checks verified email delivery, both exact Stripe test prices, checkout plan switching, the customer portal, and actual Stripe subscription webhooks granting and revoking paid access. An isolated test subscription was cancelled and its customer deleted after verification. A paid Liquid request succeeded through the Worker; an Anthropic request completed but its prose used the validated template fallback. No real payment was collected. Email remains the sign-in method; see the code sign-in update below.

Sign-in is available on the main menu and through in-game Settings, with a toolbar entry on larger screens. The account flow separates email entry, link confirmation, plan selection and subscription management. Plan selection persists across email sign-in, checkout requires an explicit confirmation, and return URLs never grant access without a server-confirmed paid session. The speed popup lists every speed; free accounts see 10× and 20× as inactive Plus options, with a separate link to plans.

Provider requests use `redirect: 'manual'` and reject non-success responses: workerd rejects `redirect: 'error'` before sending the request. The runtime regression exercises all three clients inside workerd and verifies redirects never forward credentials.

The private v7 bootstrap was uploaded and its configuration read back successfully, and the AMD64 CPU training image passed a local smoke check. A complete cloud training-and-publication cycle has not yet been exercised. The nightly schedule is deployed; status checks do not constitute a completed training run.

Local automated checks cover entitlements, demand-only narration, provider response validation, secure sessions, billing reconciliation, budgets, report ingestion, job leases and release gates. The Cloudflare runtime test checks actual SQLite and RPC wiring. A passing build or those tests does not establish that the container image, uploaded bootstrap, external keys, webhook configuration or deployed job works: run a full hosted training cycle and verify its report before launch.

The current configuration starts a `standard-4` container only for a training job. Runtime, memory and corpus growth still need measurement on the deployed image. Review budgets after actual usage; they bound provider requests rather than guaranteeing a dollar total for every future provider price.

### Narration acceptance and streaming

The 2026-10-23 evaluation used simulation-generated card facts. The baseline accepted 3/6 live responses. The revised prompt omits the speaker name, canonical reason, options, and numeric stance scores from generation input, while validation still uses full facts. It requests one short sentence with a concrete supplied detail. Complete leading sentences can be retained only after passing the existing checks. Example-copy detection now requires a six-word copied phrase absent from the supplied facts, avoiding false positives from ordinary shared fact words. Cache revision 2 avoids reusing older fallback results.

The final 12-call live sample accepted 11/12; its remaining rejection was the example-copy false positive. All 12 saved outputs passed offline replay after that correction, and the fresh six-case subset accepted 6/6 live. These are small, overlapping samples, not a production success-rate guarantee. The final 12 calls used 9,993 input and 673 output tokens, with median upstream first text 614 ms and completion 845.5 ms. The fresh six had median first checked preview 828.5 ms; browser/network display latency is additional. The complete record, including unsuccessful intermediate prompts, is in `benchmarks/narration-evaluation.json`. `scripts/evaluate-hosted-narration.js` is dry-run by default; `--live` explicitly spends provider tokens.

`Accept: text/event-stream` opts into `meta`, checked replacement `delta`, and authoritative `done` events; JSON remains supported. The client clears drafts on failure/cancellation and never writes previews into saves. Cache hits stream without another provider call or inference charge. Production `narration_result` logs contain only source, timings, and a fixed rejection category—no generated text, facts, emails or account identifiers. Cache hits are separate from provider acceptance measurements.

A subsequent live Worker smoke check accepted the generated card prose and delivered one checked SSE preview at 1,480 ms, followed by the final response at 1,525 ms (client-observed, including network time). The cached repeat completed in 171 ms with no preview/provider call. An isolated Stripe test subscription gained paid access through the real webhook, then was cancelled; free access was verified and the test customer deleted. No email was sent. These timings describe one live request, not a latency percentile.

### Installed-app sign-in and live billing

Sign-in emails include both a six-digit code and a link. The code can be entered in the installed app, with `autocomplete="one-time-code"` and paste support. Pending sign-ins survive an app reload without saving the code. “I already have a code” accepts the email and newest code without requesting another email. Credentials expire after 15 minutes; redeeming a code or its link invalidates both in one SQLite transaction. Five wrong guesses lock that code, with a separate IP attempt cap. Stored codes use a keyed hash; neither codes nor tokens are logged.

Live Stripe prices are $1/month and $10/year. Live billing state uses separate Durable Object names so test customers, checkout locks, events and paid entitlements are not carried into production. Stripe event and price modes must match the active key. Test subscriptions do not grant live paid access; existing town saves and sign-ins remain valid. Private live credentials are in the ignored `cloudflare/.dev.vars` and the former test configuration is retained in `.dev.vars.test-backup`. `scripts/setup-stripe-live.mjs` can provision/recover the live prices, portal and webhook using `.dev.vars.live-key`; it never creates a payment or subscription.

Live readiness verification on 2026-10-23 confirmed both exact recurring checkout prices (`livemode: true`), plan switching, portal creation, and the deployed webhook signing secret. The two unsubmitted checkout sessions were expired and their temporary live customer deleted. No card charge or subscription was created; this did not exercise a real paid subscription lifecycle. Authentication checks passed in Chrome and workerd/SQLite, including cross-browser email+code entry, one-use redemption, expiry, attempt caps and pending-state recovery. One user-authorized test email was requested, with its code left unused for phone verification.
