# Reputation verification

The tests assert public behavior rather than matching implementation source.
All people, missions and results are synthetic. No production imports, delivery,
mission activation or scoring-policy adoption is part of this harness.

## PostgreSQL contract suite

`tools/reputation-postgres-test.ts` runs the production `PostgresReputationStore`
against an already migrated, disposable PostgreSQL database. It requires
`PG_TEST_URL` with a loopback host and database named `reputation_test_*`.
The caller owns database/cluster startup and teardown. The runner creates random
login roles, connects separately with their real credentials, and removes those
roles on exit. It never creates a server or touches existing services.

```sh
PG_TEST_URL=postgresql://ADMIN@127.0.0.1:PORT/reputation_test_local \
  node --experimental-strip-types --test tools/reputation-postgres-test.ts
```

`REPUTATION_STORE_PATH` can point to an absolute implementation path during
isolated worktree integration. The normal path is the module's `api/store.ts`.
Run sustained local checks through the shared `rada-heavy-check` launcher.

The reusable factory suites cover:

- Immutable command recovery after a lost response and later writes.
- The mutation receipt already including its committed score/pending projection.
- Conflicting payloads and operation reuse under one request ID.
- Eight concurrent physical-connection requests for one semantic award.
- External checking and attachment-free reports remaining pending.
- Actor isolation across items, command receipts, appeals and change cursors.
- Appeal retry/conflict behavior while accepted scores remain unchanged.
- More than one durable change page and reconnect without missing item IDs.
- Actual SQL calendar bounds across Kyiv spring/autumn DST (167/169-hour weeks).
- Inclusive period start, exclusive end and independent lifetime points.

The runner also races one trusted evidence source across two actors, tests
correction rollback/commit and outbox atomicity through separate sessions, checks
source reuse/conflicts and verifies future results do not enter present totals.
Accepted points survive failed verification and a later explicit exclusion
survives redelivery of earlier evidence.

The runner also denies direct table access and unauthorized worker/operator
functions through real login roles, holds one subject lock while another actor
progresses, and rejects a score requiring more than four decimal places.
The admin connection is used only for synthetic fixture creation and controlled
lock/calendar inspection. Store calls always use the restricted runtime login.
A PGlite run alone cannot establish multi-connection concurrency behavior.

The harness assumes the API identity adapter already verified Telegram identity.
A database service can set transaction-local subject context by design; the
suite does not claim the database authenticates untrusted HTTP actor IDs.
HTTP validation, signed launch policy, SSE transport and browser interaction
need the integrated API/UI checks.

## Bot presentation

`bot/me.ts` is a pure uk/en HTML renderer receiving the shared `Summary` plus a
bounded `Page<ReputationItem>`. It shows exact supplied period/lifetime totals,
processing count, Kyiv period bounds, update time and at most three results.
All result text is escaped, attachment URLs are not interpreted, and truncation
is visible. It performs no scoring, model calls or Telegram delivery.
The caller must fetch both projections for the same authenticated actor and
period; the wire contract does not encode actor IDs in those projections.

```sh
node --experimental-strip-types --test modules/reputation/tests/bot.test.ts \
  modules/reputation/tests/shadow.test.ts
```

## Offline shadow parity

`tools/reputation-shadow.ts LEFT.json RIGHT.json` compares complete synthetic or
sanitized projections. The explicit offline envelope adds `cutoff`, `rulesHash`,
`subjectAlias`, `provenance` and `complete: true`; these are comparison metadata,
not new API fields. Different cutoff/rules/subject aliases are incomparable.
Both sides must include all four category totals, including zeros, and every
selected result with its stable comparison key, disposition and explicit
exclusion reason when excluded/replaced. The tool does not infer scores,
historical weights or which rows should be excluded.

The summary projection includes period, start/end, total/lifetime points,
pending count and categories. Rows include key, exact points, status,
occurredAt, ruleHash and exclusionReason. Revision/update timestamps are omitted
because they identify projection delivery state rather than scoring parity.
Exit codes: 0 equals, 1 differences, 2 invalid/incomparable input. Paginated or
incomplete inputs cannot prove parity. Completeness and sanitization remain
caller attestations; no real production shadow import is provided.

## Bounded synthetic load driver

`tools/reputation-load.ts` uses the same disposable-database guard and actual
login roles. It has no server lifecycle logic: the caller must run the entire
cluster/check/cleanup harness through the shared heavy-check queue.

Defaults are 1000 synthetic actors, four commands per actor, eight concurrent
workers and a 120-second command-plus-verification budget. Setup time is excluded.
`REPUTATION_LOAD_ACTORS` (1–1000), `REPUTATION_LOAD_COMMANDS` (2–20),
`REPUTATION_LOAD_CONCURRENCY` (1–32) and `REPUTATION_LOAD_SECONDS` (1–900)
control the run. Each actor sends two independent requests for one semantic
acknowledgement, then zero or more attachment-free synthetic reports.

The JSON result contains command/verification counts, SQL error counts,
command latency p50/p95/p99, whole-actor verification latency percentiles,
event-loop delay, RSS and measured command throughput. Every actor is checked
for exact score, pending count, item count, revision, durable changes and receipt
replay. Cross-actor reads are checked separately. A timeout, SQL error or failed
invariant exits unsuccessfully. This is a PostgreSQL store/driver workload;
it does not measure HTTP, SSE fan-out, browser rendering or model interpretation.
No performance results are claimed until a recorded run completes.
