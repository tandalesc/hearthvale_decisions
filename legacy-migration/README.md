# Old Hearthvale origin migration

The page in this directory is deployed at `https://hearthvale.ramblerun.net/`,
with a static migration page served from the original app container.
It reads the old origin's IndexedDB `hearthvale` / `saves` object store and the
older `localStorage['hearthvale-save']` key without changing either. Version 2
exports are the exact JSON that the new site's importer accepts. Other versions
are exportable but marked unsupported.

On the host, the original files are backed up at
`/opt/hearthvale/legacy-migration/backup-source-index.html` and
`/opt/hearthvale/legacy-migration/backup-dist-index.html`. The original image
is tagged `hearthvale:pre-migration-20261023`; the migration image is tagged
`hearthvale:migration-20261023` and `hearthvale:latest`. The running container
has the same two static files copied into its writable layer. The source
`/opt/hearthvale/index.html` and `/opt/hearthvale/public/migration.js` also
hold the migration files so a normal build keeps the entry page.

Rollback, if needed, from an authorized deployment account on the old host:

```sh
cp /opt/hearthvale/legacy-migration/backup-source-index.html /opt/hearthvale/index.html
rm /opt/hearthvale/public/migration.js
sudo docker cp /opt/hearthvale/legacy-migration/backup-dist-index.html hearthvale:/app/dist/index.restore.html
sudo docker exec hearthvale mv /app/dist/index.restore.html /app/dist/index.html
sudo docker exec hearthvale rm -f /app/dist/migration.js
sudo docker image tag hearthvale:pre-migration-20261023 hearthvale:latest
```

The live server reads static files per request; no restart is required. Its API
middleware, training service, mounts, and container configuration were not
changed. Public Cloudflare requests from automated clients may receive a
managed challenge before reaching the origin.

Run `node legacy-migration/test.mjs` from the repository root to test an
isolated browser with synthetic IndexedDB and localStorage saves. It also
captures `migration-desktop.png` and `migration-phone.png` for visual review.
