# Verified database backups

A host systemd timer runs daily at 03:30 UTC with up to 15 minutes jitter and
catches up after downtime. The host needs the existing Docker engine and Node
22 or later; no npm install or new application dependencies are required.
A timer is preferable to a Compose sidecar: only the administrator host controls
Docker, and no container receives the Docker socket. Deployment does not enable
backups automatically. Staging and future production need separate jobs, networks,
keys, state directories and off-host namespaces.

## Guarantees and limits

The pinned PostgreSQL 17 image adds only age, from an exact Debian package and
signed dated Debian snapshot. A build is selected by immutable local image ID in
`job.env`; rebuild/review deliberately for security updates. Apt uses HTTP with
Debian signature and package hash validation because the base lacks CA certificates.
No external binary, npm package, Python environment or runtime download is used.

A read-only superuser session exports one REPEATABLE READ snapshot and remains
open while `pg_dump` and exact `count(*) FROM ONLY` queries import it. Inventory
covers every non-system ordinary/partitioned table, including empty tables,
partition parents and leaves, schema/name, kind and partition flag. Counts are
decimal strings, never floating point estimates. RLS cannot silently hide rows.
DDL or unsupported extensions may fail the run; do not suppress restore errors.
The stock image must support every installed extension before enabling this job.

The encrypted tar contains a custom-format database dump, inventory/counts,
password-free role evidence, sandbox NOLOGIN role definitions and SHA-256 checksums.
Encryption is decrypted again, byte-compared and checksummed. Only those decrypted
bytes are restored. A disposable Postgres uses `--network none`, no published
ports, Unix sockets, no preload libraries, a tmpfs database and no applications.
`pg_restore --exit-on-error --no-owner` must succeed; inventory and every exact
count must match before copying or publishing. Verification intentionally does not
prove original ownership, login passwords, external services or application health.
Roles are captured separately from the MVCC data snapshot; avoid role/schema
administration during backups. This is daily logical recovery, not PITR or HA.

The off-host hook must succeed before atomic local publication. Retention keeps
the newest backup on each of 14 distinct UTC days plus the newest in each of eight
distinct ISO weeks (overlap allowed). Failed capture, decryption, restore,
comparison or copy never rotates existing archives or replaces the success receipt.
There is one JSON success line and `last-success.json`, containing only version,
status, archive filename and ciphertext hash. Failure prints `RADA_BACKUP_FAILED`.
Private diagnostics overwrite `last-run.log`, capped at 1 MiB; Docker logs are
disabled. Work plaintext and sandbox containers are removed on ordinary failures
and handled termination. Monitor timer failures **and receipt age** externally;
a stopped host cannot report failure. Keep enough RAM for the restored database
(tmpfs defaults to half host RAM), and disk for plaintext, tar round trip and archives.

## VPS setup (operator)

1. Install this reviewed revision at `/opt/rada-backup`. Install/verify Node 22+
   at `/usr/bin/node`, Docker and systemd. Do not run against any old platform DB.
2. Create `/etc/rada-backup` and `/var/lib/rada-backup` as root, mode 0700.
   Keep all configuration/key files mode 0600. Build the image:

   ```sh
   cd /opt/rada-backup
   docker build -f infra/compose/backups/Dockerfile -t rada-backup:reviewed .
   docker image inspect --format '{{.Id}}' rada-backup:reviewed
   ```

3. Generate an age identity using the built image's `age-keygen`, with network
   disabled and `/etc/rada-backup:/config` mounted, writing `/config/identity.txt`.
   Use `age-keygen -y /config/identity.txt` to write `recipients.txt`. Keep the
   decryption identity here for automatic rehearsal, and a tested separate offline
   recovery copy. Add an offline recipient if desired. Never put identities,
   recipients, credentials, logs or archives in Git. Losing all identities loses
   backups. Host compromise can expose the online verification identity.
4. Write `/etc/rada-backup/source.env` as trusted Bash assignments:

   ```sh
   PGHOST=postgres
   PGPORT=5432
   PGUSER=postgres
   PGDATABASE=rada_staging
   PGPASSWORD='REPLACE_PRIVATELY'
   ```

   Use the compose administrator password privately. The script requires a
   superuser for complete RLS-protected data and role evidence. No source writes
   occur. A future production database needs its own configuration. This file is
   executable shell configuration; only root may edit it.

5. Install an executable root-owned copy hook outside Git. Its three arguments
   are ciphertext absolute path, archive basename and SHA-256. Configure a
   placeholder target such as `BACKUP_REMOTE_TARGET` privately; no real endpoint
   is provided here. The hook must upload to a temporary object, verify the remote
   SHA-256, durably publish without overwriting older objects, then return zero.
   Use bounded timeouts and authenticated transport. Never upload plaintext or
   the online identity. Remote retention is the hook/operator's responsibility:
   use the same `retention()` selection from `tools/backup-policy.mjs`, validate
   the complete namespace and rotate only after verified upload, always preserving
   the last good copy. Prefer independent immutable storage/lifecycle protection.
   A missing hook blocks the backup; `/bin/true` is only suitable for local tests.
6. Write `/etc/rada-backup/job.env` (systemd assignments):

   ```sh
   BACKUP_CONFIG=/etc/rada-backup
   BACKUP_STATE=/var/lib/rada-backup
   BACKUP_IMAGE=sha256:REPLACE_WITH_BUILT_IMAGE_ID
   BACKUP_NETWORK=rada-staging_database
   BACKUP_COPY_HOOK=/etc/rada-backup/copy-offhost
   ```

   Confirm the actual Compose database network name with `docker network ls`.
   No ports need opening. Keep this installation independent of release-directory
   cleanup. Update the pinned installation/image deliberately after review.

7. Install `infra/compose/backups/rada-backup.{service,timer}` into
   `/etc/systemd/system/`, run `systemctl daemon-reload`, then
   `systemctl start rada-backup.service`. Check its exit status, receipt, private
   log and independent remote object/hash. Only after a successful first run:
   `systemctl enable --now rada-backup.timer`. Check `systemctl list-timers`.
   Set failure/receipt-age monitoring and test offline recovery before relying on it.

After power loss/SIGKILL, stop the service, inspect/remove only leftover
`rada-backup-*` containers, securely remove the state's `work` directory and
remove its `lock` directory after confirming no job is running. Then rerun.
The lock fails closed; never bypass it while a run is active. Host storage should
be encrypted since interrupted work may leave plaintext until cleanup.

## Disaster recovery

1. Stop writers and the timer. Preserve the damaged volume; never restore over
   the only original. Provision a new private Postgres 17 instance with matching
   extensions, no app connections and sufficient disk. Recover ciphertext from
   off-host storage and an offline identity via a trusted channel. Compare its
   SHA-256 with the independently saved receipt/remote metadata.
2. On a trusted isolated recovery host, make a 0700 directory, `umask 077`, and
   decrypt with the pinned image (mount archive, identity and output directory;
   `--network none --entrypoint age`):
   `age -d -i /config/identity.txt -o /recovery/bundle.tar /input/archive.tar.age`.
   Extract only a trusted, checksum-verified backup; run `sha256sum -c SHA256SUMS`
   in the extracted directory. Keep all plaintext private and delete it afterward.
3. Review `roles.sql`. Restore required original NOLOGIN owners and grants before
   the database dump. Do not blindly apply cluster superusers or existing roles;
   original role passwords are deliberately absent. Reprovision separate runtime
   login credentials using the staging bootstrap (or production equivalent),
   with API writers stopped. Create a fresh empty database from `template0`.
4. Run `pg_restore --exit-on-error -U postgres -d RECOVERY_DB database.dump` on
   that new database to preserve original ownership. Abort on errors; restart
   with another empty database after fixing prerequisites. Do not use
   `--no-owner` for final recovery unless ownership is explicitly reconciled.
5. Run `psql -XqAt -v ON_ERROR_STOP=1 -U postgres -d RECOVERY_DB
-f /backup/counts.sql > actual.jsonl` inside the pinned image/container.
   `cmp counts.jsonl actual.jsonl` must succeed. Review migration ledger and
   extensions, then test API authentication, module grants and synthetic flows
   against the recovered DB before switching connection configuration.
6. Rotate compromised credentials if relevant, restart approved writers, verify
   application health and a fresh verified backup/off-host copy, then re-enable
   the timer. Record the recovered archive and new deployment revision privately.

Files/media, external service configuration, environment secrets and age identities
need independent recovery plans; a database archive does not contain them.

## Tests

`node --test tools/backup-policy.test.mjs` tests retention and strict non-secret
receipt parsing. The database CI job runs `node tools/test-backups.mjs` after
`npm run test:db`, using its existing disposable Postgres service container via
`PG_CONTAINER`. It builds the pinned image, creates throwaway age keys, attaches
an internal source-only network, tests partitioned/quoted/empty tables, verifies
an encrypted restore and confirms restore errors, inventory mismatches and a failed copy preserve
archives/receipt.
No production configuration or real server is used. Locally set `DOCKER_CONTEXT`
if needed (on macOS, set `TMPDIR` to a Docker-shared private directory),
start a fresh test Postgres on a disposable internal Docker network,
set `PG_CONTAINER`, `PGDATABASE=rada_test`, run `node tools/db-test.mjs`, then
`node tools/test-backups.mjs`; remove the test source container/network afterward.
The source needs the synthetic password `fixture-password`. The rehearsal is
additive to existing database and API gates.
