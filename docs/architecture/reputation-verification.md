# Reputation verification

Recorded on 2026-11-13 on a local Mac with Node 26.7 and PostgreSQL 17.11.
All executed checks below use synthetic identities,
missions, rules and results in disposable PostgreSQL 17 databases. No production
parity, DAO policy adoption, live Telegram delivery or financial migration is
established by these checks.

## Recorded results and remaining evidence

| Check                            | Recorded result                                                                                                                                   | Boundary                                                      |
| -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------- |
| Full repository gate             | `npm run check` passed: 330 Node tests, 44 Deno API tests, lint/types/hygiene/protocol; two existing conditional governance/notification DB skips | Separate real PostgreSQL suites below were executed           |
| Bundle gate                      | `check:bundle` passed with the measured default-flag budgets below                                                                                | Initial JavaScript size, not runtime latency                  |
| PostgreSQL store contracts       | 16 passed; real scoped login roles and concurrent sessions                                                                                        | Synthetic database state                                      |
| Migration/isolation checks       | 0066–0075 applied within the full migration sequence; checksum/isolation checks passed                                                            | Disposable PostgreSQL 17                                      |
| Worker database suite            | 13 passed through real worker login                                                                                                               | Lease, policy, permission and cap invariants                  |
| Coordinator/database pipeline    | Four passed: attachment-free Trust commit/dedupe, unknown-rule pending, late-provider deadline and persisted membership identity                  | Real SQL with fake provider/membership responses              |
| Browser flow and reload recovery | Six combinations passed: Chromium and WebKit, each at en/390, en/1280 and uk/390                                                                  | Local HTTP server, real PostgreSQL, synthetic signed launches |
| Store workload                   | 4000 commands across 1000 actors, concurrency 8; p95 command latency 1.969 ms                                                                     | Store/driver workload, not HTTP throughput                    |
| Real HTTP/SSE workload           | 1000 simultaneously open authenticated streams, 100 paced writes offered at 100/s, plus 500-write burst                                           | One local Mac; synthetic data                                 |

The HTTP/SSE run completed 602 unique writes/deliveries, including disconnected
catch-up and unknown-response recovery, 1000 summary checks and 1204 isolation
checks. Paced p95 HTTP acknowledgement was 17.416 ms and write-start-to-event
18.293 ms; burst p95 was 222.186 ms and 241.886 ms respectively. Readers, server
and store closed; no stream/server failures were recorded. These observations
are local measurements and do not guarantee production or mobile latency.

Production-sized historical projections, two real reporting weeks of
full-roster parity, an approved release observation window and production
operator/provider configuration remain required. See [release gates](reputation-release.md).

## Initial bundle accounting

With default build flags, the measured initial gzip entry changed from 48,802 to
49,496 bytes (+694); Brotli changed from 42,331 to 42,908 bytes (+577). The gzip
budget moved from 49,319 to 50,000 bytes and Brotli from 42,676 to 43,500 bytes
to account for the lazy reputation text/loading and SSE support. This is an
explicit measured budget adjustment, not a claim of unchanged JavaScript size.
CSS and fonts were unchanged. Release verification must retain these measurements
and the final repository check result alongside the candidate revision.

## PostgreSQL correctness suites

`tools/reputation-postgres-test.ts` exercises `PostgresReputationStore` through
real authentication/service/operator/ingress logins. It verifies immutable
request recovery, conflicting request payloads, parallel semantic duplicates,
actor privacy, trusted source collisions, exact decimals, correction/outbox
atomicity, future exclusion, appeals, paginated change recovery and Kyiv DST
boundaries. A receipt must already contain its committed score/pending projection.

`tools/reputation-worker-test.ts` adds an opt-in real worker login and verifies
parallel `SKIP LOCKED` claims, lease expiry/reclaim, stale completion rejection,
frozen policy-derived points/category, attachment-free Trust reports, duplicate
semantic occurrences, Kyiv caps across DST/ruleset changes, unknown-rule pending
state, source/lane rejection, immutable lease recovery, preserved corrections,
operator-only requeue and external verified identity. Excluding a previous award
must free active cap capacity while retaining semantic deduplication.

Both suites require `PG_TEST_URL` with a loopback host and a disposable database
named `reputation_test_*`. The caller owns cluster creation, full migrations and
teardown. Random restricted test logins/pools are removed on exit. The worker
suite quarantines earlier synthetic ready/leased jobs in that disposable
database before each sequential scenario so global claims are isolated.

```sh
node --experimental-strip-types --test tools/reputation-postgres-test.ts
node --experimental-strip-types --test tools/reputation-worker-test.ts
```

Use the shared `rada-heavy-check` launcher for the whole sustained
cluster/check/cleanup harness, with one test worker. Existing services are not
part of the harness. Admin queries are bounded fixture/lease setup and audit
inspection; runtime behavior uses actual restricted logins. A PGlite-only run
would not prove concurrent PostgreSQL lock behavior. Database subject context
assumes the platform already verified Telegram identity; HTTP/browser tests
exercise the signed-launch boundary separately.

## Browser, load and realtime reproduction

`tools/reputation-browser.ts` uses real API composition and PostgreSQL through
`tools/reputation/browser-server.ts`. It covers tasks, result detail/evidence,
self-report, appeals, locale rendering, mobile/desktop layouts and a committed
report whose HTTP response is lost before a full reload. The UI must recover the
same request rather than create a second result. Screenshots use
`test-results/reputation`; they are synthetic test evidence.

`tools/reputation-load.ts` defaults to 1000 actors, four commands per actor,
eight workers and a 120-second measured budget. Its two distinct verify requests
per actor target one semantic acknowledgement; later commands are self-reports.
`REPUTATION_LOAD_ACTORS`, `REPUTATION_LOAD_COMMANDS`,
`REPUTATION_LOAD_CONCURRENCY` and `REPUTATION_LOAD_SECONDS` bound the run.
It verifies exact totals, pending counts, receipts, revisions and durable changes.

`tools/reputation-realtime.ts` defaults to 1000 real HTTP/SSE connections,
100 paced writes and a 120-second total budget. `REPUTATION_REALTIME_BURST=500`
adds the burst; `REPUTATION_REALTIME_ACTORS`, `REPUTATION_REALTIME_WRITES` and
`REPUTATION_REALTIME_SECONDS` provide smaller bounded runs. The caller needs a
file-descriptor limit of at least 4096 for client/server sockets in one process.
The harness records actual open connections, HTTP and emission p50/p95/p99,
dispatch lag, event-loop delay, counts, failures and cleanup. It checks
cross-actor isolation, saved-cursor reconnect and immutable recovery after a
lost response. Finally it aborts/awaits readers and closes its server/store.
These workloads call no real provider or Telegram endpoint.

## Shared bot projection

`modules/reputation/bot/me.ts` is a pure uk/en HTML renderer of the same `Summary`
and bounded `Page<ReputationItem>` used by other clients. It displays supplied
exact totals, period bounds, Kyiv timezone, freshness, pending count and at most
three escaped result snippets. It performs no scoring or delivery. A live bot
route/consumer is still separate integration work; the caller must fetch both
projections for the same authenticated subject and period.

## Full-roster offline shadow comparison

For release evidence use the independent expected-roster manifest as the third
argument:

```sh
node --experimental-strip-types tools/reputation-shadow.ts \
  LEGACY.json CANDIDATE.json EXPECTED-ROSTER.json
```

The manifest is an array of sanitized aliases, including zero-activity members.
Each side is a `RosterShadow` with `version`, `cutoff`, `rulesHash`, `roster` and
`members`. Each member is a `ShadowSnapshot`: `version`, `provenance`,
`subjectAlias`, `cutoff`, `rulesHash`, `complete: true`, `summary` and `rows`.
The tool rejects omitted/duplicate participants, mismatched rosters, mixed
cutoffs/rules and incomplete pages. Two-argument comparison remains available
for a single member but cannot satisfy the roster release gate.

Summary fields are period, start/end, total/lifetime points, pending count and
all four category totals, including explicit zeros. Each row includes `key`,
`category`, `evidenceKeys`, exact `points`, `status`, `occurredAt`, `ruleHash` and
`exclusionReason`. Evidence keys are stable sanitized identifiers, not raw
private evidence. Row/evidence order is normalized; exclusions must be explicit.
Accepted row/category/summary totals and pending counts must reconcile exactly.
Revision/update timestamps are omitted from score parity because they describe
delivery state. Exit codes are 0 equal, 1 different and 2 invalid/incomparable.

The tool compares supplied source projections and validates internal consistency;
it does not discover missing source events, adopt historical weights, import
production records or prove that two identically incomplete producers are
correct. Source extraction, sanitization, independent roster/event manifests and
reconciliation of real discrepancies are part of F4.
