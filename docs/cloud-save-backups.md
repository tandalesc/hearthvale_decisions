# Cloud saves and recovery

Cloud saves are available to signed-in players. A free account can create one active cloud town; a Plus account can create ten. Downgrading never deletes or locks existing towns: all remain readable, writable, restorable and deletable. The lower limit applies when adding or reactivating a town. Each compressed save is limited to 16 MiB, its decompressed stream to 64 MiB, and each account to 800 writes and 2 GiB uploaded per UTC day. Local device saves are independent of these limits.

The Worker authenticates the signed `__Host-hearthvale` session, derives the account Durable Object from its server-side account ID, and requires the exact same `Origin` for PUT, POST and DELETE. Every cloud request must send `X-Cloud-Account` equal to the opaque `cloudAccountId` from the current session; a mismatch returns HTTP 409 `account_changed`. R2 objects remain private under `cloud-saves/v1/<account-id>/`, separate from student artifacts. The client never supplies a storage account ID. `GET /api/session` provides `cloudAccountId` for local account separation and `limits.cloudTowns`.

## API

All responses use `Cache-Control: no-store` (or `private, no-store`). UUIDs are required for town IDs and save IDs.

| Request | Purpose |
| --- | --- |
| `GET /api/cloud/towns` | `{towns,recoverable,limit,maxBytes}`; active towns and deleted towns still inside the seven-day recovery window. |
| `PUT /api/cloud/towns/:id` | `application/gzip` body, `If-Match: <revision>` (0 to create), `X-Save-Id: <uuid>`, and `X-Town-Meta: <encodeURIComponent(JSON.stringify(metadata))>`. Metadata requires name, year, month and people; optional era, seed, terrain, archetype are strings. Returns `{town}`. |
| `GET /api/cloud/towns/:id` | Raw gzip bytes (`Content-Type: application/gzip`, no `Content-Encoding`) and `X-Town-Meta` encoded full metadata. |
| `DELETE /api/cloud/towns/:id` | `If-Match: <revision>`; returns `{deleted:true,revision}`. |
| `GET /api/cloud/towns/:id/history` | `{backups}` with `id` equal to `previous` or `YYYY-MM-DD`. Each entry also has `townId`, metadata and `createdAt`. |
| `POST /api/cloud/towns/:id/restore` | JSON `{backupId,baseRevision,saveId}`. Creates a new revision and returns `{town}`. |
| `POST /api/cloud/recover` | Rebuilds an empty account catalog from the newest verified private R2 catalog snapshot, including an intentionally empty snapshot. Returns `{recovered,from}`. Rejects a nonempty catalog. |

On stale writes or deletes, HTTP 409 returns `{code:'conflict',town:<latest>}`; the server never overwrites the latest revision. A repeated save ID returns the original successful result from the recent receipt window. HTTP 409 with `code:'limit'` means the account has no new active slot. HTTP 413 means the compressed request exceeds 16 MiB. A 429 `rate` means the account has used its daily write budget.

## Durability and retention

The account Durable Object serializes all cloud mutations. A PUT first writes a new immutable gzip object to R2, then updates its SQLite catalog. A failed R2 write cannot advance the catalog. Each town also retains a pointer to the previous good revision. The user can restore it without replacing the current revision in place.

The Durable Object alarm runs at 03:00 UTC each day after an account's first cloud mutation. It writes an independent, immutable catalog JSON object in R2 before recording the snapshot in SQLite. The first successful R2 write fixes that day's recovery point; if SQLite bookkeeping fails, a retry reads the existing snapshot rather than replacing it with later progress. Seven daily snapshots are retained; each references immutable town blobs. A per-account sweep removes unreferenced blobs and expired catalog objects after the new snapshot is committed. Cleanup failures emit a redacted warning and are retried on a later alarm. Alarm failure reschedules a retry in one hour. An inactive account's alarm reuses the day's snapshot, so backups do not multiply within a day. The daily snapshots and prior revision do not consume cloud town slots.

A deleted town appears in `recoverable` with its tombstone revision. Its previous revision and any unexpired daily snapshots remain available for recovery. Restoring a deleted town consumes an active slot. Deleted tombstones expire after seven days; expired snapshots and unreferenced blobs are removed by the account alarm. This is a seven-snapshot retention policy, not indefinite archival storage.

## Recovery runbook

1. Have the player sign in and open the account's cloud town list. If a town is present, use its **history** endpoint and restore `previous` or a dated backup with the displayed current revision. Download the result and confirm that its gzip body opens as a town.
2. If the list is empty after a Durable Object catalog loss, issue `POST /api/cloud/recover` in the signed-in browser session with the site's exact `Origin`. This operation refuses to touch a nonempty catalog. It scans the account's private R2 catalog snapshots, verifies every referenced gzip object exists, and indexes the newest valid snapshot. List and download the recovered towns, then check their metadata and contents.
3. If no verified catalog exists, inspect private R2 under `cloud-saves/v1/<account-id>/catalog/` with operator access. Keep original objects intact while investigating. Do not copy or publish blobs to public assets. Contact the player before choosing a different recovery point. The public API intentionally does not accept arbitrary object keys.

`tests/cloud-saves.test.js` runs these paths in workerd with SQLite Durable Objects and private R2. It checks stale writers, idempotent retry, account isolation, limits, restore, bounded gzip, daily catalog creation and catalog recovery.
