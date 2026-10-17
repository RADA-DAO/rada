# Legacy people and frogs importer

This is an offline orchestration tool, not an application module. It belongs in
`tools/import` because it composes identity, JPEGPE and ops public contracts.
Identity and JPEGPE migrations own their import functions; only ops owns the
private mappings and checkpoints. No module writes another module's tables.
All files and fixtures here are synthetic. Only disposable synthetic databases are used during development.

## Preparation by the orchestrator

Use Node 22 with `--experimental-strip-types` (or the repository's Node 24),
`npm ci`, PostgreSQL 17 and two **separate disposable databases**. Restore the
legacy copy in an isolated network with legacy writers, cron, queues, Telegram,
payment workers and outbound network access disabled. Keep it frozen throughout
all rehearsals. This tool does not create a backup, perform cutover, fence source
writers or download media. Never supply a production, staging or backup URL.

Apply the repository migrations to the empty target through `tools/db-migrate.mjs`
using the repository's `PGHOST`, `PGUSER`, `PGPASSWORD`, `PGDATABASE` convention.
The migrations add a `legacy_import` NOLOGIN role with no membership in runtime,
owner, wallet, payment or governance roles. A database administrator provisions a
short-lived target LOGIN and grants it **only** `legacy_import`. Do not use the
API login. Revoke the membership and remove that login after rehearsal.

Provision a separate source LOGIN with SELECT on the allowlisted columns used in
`source.ts` and `inventory.ts`, and sufficient SELECT privileges for `count(*)`
on all user tables and `count(column)` on excluded columns. On a Supabase-style
restore this source reader **must have BYPASSRLS**: RLS can otherwise silently
return zero rows. The importer sets `row_security = off` to fail on policy-filtered
reads, and fails if the people projection is empty while its exact inventory count
is non-zero. The restored PostgreSQL server must listen on **TCP** on the isolated
interface (`listen_addresses`); a Unix socket alone cannot serve the source URL.
Set its default transaction mode to read only. It needs no writes or function execution.
Inventory counts cover all user schemas, not just public. Missing permissions
fail the run; a missing table never becomes a fabricated zero count.
Use the same restricted source login for dry run, import and verification.

For a completely synthetic rehearsal, create a new source database and load:

```sh
psql "$IMPORT_SOURCE_URL" -X -v ON_ERROR_STOP=1 -f tools/import/fixture.sql
```

Load the fixture as its provisioning administrator before granting the source
reader access. It contains 30 synthetic rows, including eight distinct people,
a person without Telegram, identical display names, a frog transferred twice,
an obsolete profile selection, case-insensitive name collisions, colour proof,
balance rows, wallet evidence, sessions, challenges and admin roles.

## Exact run procedure

Supply URLs through a protected environment, never in committed files or logs:

```sh
export IMPORT_SOURCE_URL='postgresql://source_reader:REPLACE@isolated-source/legacy_copy'
export IMPORT_TARGET_URL='postgresql://target_importer:REPLACE@isolated-target/rada_rehearsal'
export IMPORT_ISOLATED_RESTORE=yes
export IMPORT_BATCH_SIZE=100
export IMPORT_REPORT=/private/rehearsal/report-dry.json
node --experimental-strip-types --no-warnings tools/import/main.ts dry-run
export IMPORT_REPORT=/private/rehearsal/report-import.json
node --experimental-strip-types --no-warnings tools/import/main.ts import
export IMPORT_REPORT=/private/rehearsal/report-verify.json
node --experimental-strip-types --no-warnings tools/import/main.ts verify
```

The acknowledgement is an operator guard, not proof of isolation. The operator
must validate both hosts before invocation. Source reads use one repeatable-read,
read-only transaction. Dry run and verification use read-only target transactions
and perform no INSERT, UPDATE or DELETE, including temporary or rolled-back writes.
Dry run reports projected counts and checksums, not evidence of completed writes.
JSON goes to stdout and optionally `IMPORT_REPORT`; short text goes to stderr.
Exit codes: 0 = ok, 2 = conflicts/mismatches, 1 = unexpected failure. Do not
accept a rehearsal unless import **and** subsequent verify exit 0.
The collision fixture deliberately exits 2. Resolve the synthetic names on the
isolated source, then rerun; the importer never invents replacement names.

To resume a failed run, rerun `import` with the same frozen source and batch size.
Each batch commits domain rows, mappings and its checkpoint atomically. A failed
batch rolls back. Replayed rows are checked against the stored source hash and
actual target state, rather than blindly skipped. Checkpoints mark scanned
batches; reported conflicts remain retryable even when a checkpoint exists.
An advisory session lock serializes importer runs. Keep other target writers
disabled too. Verification checks all imported records, not a sample. Unexpected
mappings, source changes, missing rows and changed target contents prevent `ok`.

## Data contract

- People retain their legacy UUID, recorded in the bijective
  `(FAIRGROUND, public.ecosystem_users, id) -> subject_id` mapping. Telegram IDs
  stay exact decimal strings in Node and become verified links. Existing target
  links or duplicate source Telegram IDs cause conflicts, never person merges.
  People without Telegram still receive a subject. Display names and wallets are
  never identity keys.
- Owned frogs retain their UUID, separate creator and owner, display name,
  authored colour strings and linked proof JSON. Authored colours lacking either
  linked proof are imported with `colour_source = legacy_unverified`, counted per
  frog under `legacy_colour_without_proof`. No proof is fabricated; other colours
  retain `colour_source = proof`. Permanent usernames remove the
  legacy leading `@` because the target stores the bare handle. Case, remaining
  spelling and authored colour bytes are unchanged. JPEGPE's public import
  function uses its public username-hold protocol, including case-insensitive
  uniqueness, validation and active holds. Collisions block both source frogs.
- Sold listings, accepted offers, accepted barter legs, old filled buy orders,
  new buy-order fills and SPLASH wins contribute only ownership evidence:
  source key, frog, sender, recipient and timestamp. Financial columns are never
  read as values or copied. Old filled orders overlapping fill request IDs are
  excluded to avoid recording one transfer twice. Chains must start at the
  creator and end at the current owner, in timestamp/source-key order.
- `frog.transferred` notifications with exactly `frogId`, `frogName`,
  `frogUsername` and `level` have no ownership endpoints. They are skipped under
  `transfer_notification_without_endpoints`; the frogs table remains authoritative
  for the current owner. Payloads with sender/recipient fields or other unknown
  shapes remain `unrecognized_transfer_payload_requires_adapter` conflicts.
- Every frog gets an imported genesis event (`NULL -> creator`). Without any
  transfer evidence, a different current owner gets one synthetic imported
  `creator -> owner` event at creation time; that time is a fallback, not a
  claimed transfer date. For creator-owned frogs the genesis is the only event,
  avoiding a self-transfer. All imported events are immutable, carry
  `imported=true` and a stable unique `import_key`. No history is overwritten.
- Selection comes from `jpegpe_profile_appearances.document.profile.frogId` and
  is imported only while the mapped subject owns the imported frog. Identity
  rechecks ownership at write time. Other profile JSON is excluded.

No balances, financial amounts, active wallet links, wallet evidence, roles,
admin rights, consents, sessions, nonces, challenges or delivery queues are
imported. Unowned `splash` and `archived` frogs are counted and skipped: the target
requires an owner, so the importer does not invent one. Media bytes, presentation
skins, inventory and legacy workflows are outside this importer.

Reports list full-source counts, eligible planned counts, actual/projected
counts, conflicts with hashed source keys, skipped whole tables with row counts,
and excluded fields with non-null counts. Counts can overlap across excluded
fields; never add them as a distinct-person total. Mixed history tables also
retain all non-selected records on the source. Each entity checksum is SHA-256
of sorted source keys plus canonical values, including colours, proofs, owners
and timestamps with microsecond precision. Ownership events have a separate
checksum. No raw identities, names, Telegram IDs, wallet values or credentials
are printed. Protect reports anyway; hashes are not anonymization.
The source plan is held in memory; batch size bounds target transactions, not
source memory. This is intended for the small legacy dataset, not a streaming ETL.

## Verification and remaining legacy questions

The CI database job explicitly runs `tools/import/import.database.test.ts` after
`npm run test:db`, before the API database tests. It creates and drops a separate
synthetic source, checks read-only planning, real import, interrupted-batch
rollback/resume, unchanged rerun, collisions, exclusions, checksums, selection
ownership, immutable history and restricted target privileges. No local database
or real data is required to develop the tool.

```sh
node --experimental-strip-types --no-warnings --test tools/import/model.test.ts
# CI only, with the explicit disposable PostgreSQL service URL:
node --experimental-strip-types --no-warnings --test tools/import/import.database.test.ts
```

The supplied domain migrations reference `ecosystem_users` but do not define its
original DDL. This adapter requires its documented `id`, `telegram_id` and
`created_at` columns. Confirm that contract on the isolated restore before use.
No single complete ownership ledger exists in those migrations. A reserved
`frog.transferred` notification type has no defined transfer producer/payload;
apart from the reviewed notification-only shape above, these events block `ok`
until a reviewed adapter is added. Incomplete or contradictory market/SPLASH chains also block import rather than
inventing missing historical transfers. Confirm same-time event ordering
and pre-market transfers on that copy. Archived frogs need
a separate archive contract. These questions require isolated evidence, not
access to a live database.
