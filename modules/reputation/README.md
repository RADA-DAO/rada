# Reputation and tasks

This module owns attributed results, exact point decisions, personal summaries
and durable interpretation/verification jobs. The Mini App and pure bot renderer
consume the same `Summary` contract. A live bot command is not wired here.
Reputation grants no political rights and creates no money or financial state.
Migration fixtures and example weights are not adopted reward policy.

## API contract

The API base is `/v1/reputation`; the shell uses `/api/v1/reputation` through its
platform adapter. `contract.ts` defines the shared JSON types.

| Method and path                                           | Result                                                  |
| --------------------------------------------------------- | ------------------------------------------------------- |
| GET `/overview?view=tasks\|history&period=...&cursor=...` | `Overview`: `{summary, page}`                           |
| GET `/detail/:id?period=...`                              | `Detail`: `{summary, item, appeals}`                    |
| GET `/summary?period=...`                                 | `{summary: Summary}`                                    |
| GET `/missions?cursor=...`                                | `Page<Mission>`                                         |
| GET `/items?period=...&cursor=...`                        | `Page<ReputationItem>`                                  |
| GET `/items/:id`                                          | `{item: ReputationItem}`                                |
| POST `/missions/:id/verify`                               | `CommandResult` (200 completed, 202 checking)           |
| POST `/reports`                                           | `CommandResult` (202 pending interpretation)            |
| GET `/commands/:requestId`                                | Original `CommandResult` (200/202), or 404              |
| POST `/items/:id/appeals`                                 | `{appeal: Appeal}`                                      |
| GET `/appeals/commands/:requestId`                        | Original `{appeal: Appeal}`, or 404                     |
| GET `/items/:id/appeals`                                  | `{appeals: Appeal[]}`                                   |
| GET `/changes?after=revision`                             | `Changes`                                               |
| GET `/stream?after=revision`                              | Authenticated SSE; `changes` event containing `Changes` |

Periods are `today`, `week`, `previous_week` and `all`. Overview defaults to
`tasks`/`today`; detail defaults to `today`; summary and item lists default to
`all`. Overview and detail read their projections in a consistent database
snapshot. Pages default to at most 30 entries. SSE also accepts `Last-Event-ID`
when `after` is absent; callers reconnect from their last applied revision.
The durable changes feed recovers missed delivery hints.

GET authenticates ordinary Telegram launches; POST uses privileged launch age
policy. The platform verifies identity server-side and sets transaction-local
subject context. Actor IDs, points and completion booleans are not authoritative
request fields. Unknown JSON fields are rejected. Reads, commands, appeals and
stream cursors are scoped to the authenticated subject.

Scores are canonical exact decimal strings with at most four fractional places,
stored as integer units at scale 10000. Calendar periods use Europe/Kyiv and UTC
instants with inclusive start/exclusive end. Future results do not inflate
present totals. `totalPoints` is period-filtered; `lifetimePoints` is independent
of the selected period. History preserves excluded and replaced results.

A mutation receipt is immutable, including its original summary. If its response
is lost, recover by the same request ID; a receipt need not reflect later
corrections. Appeal recovery uses its own endpoint above. Reusing one request ID
for different payloads or command kinds is a conflict. The UI retains a bounded
recovery journal and checks receipts after a full reload before retrying.

## Ownership and migrations

Migrations are forward-only and run through the platform migration ledger.

| Versions  | Owner and purpose                                                                                           |
| --------- | ----------------------------------------------------------------------------------------------------------- |
| 0066–0069 | Reputation schema/roles, exact projections, scoped reads, atomic commands and trusted ingress/corrections   |
| 0070–0071 | Consistent overview/detail projections and appeal receipt recovery                                          |
| 0072      | Durable jobs, leases, proposal audit, immutable completion receipts and operator requeue                    |
| 0073–0074 | Immutable rule configuration, rule snapshots, semantic deduplication, active caps and atomic job completion |
| 0075      | Identity-owned narrow verified Telegram lookup for external worker jobs                                     |

0066–0074 live under this module's `db/migrations`; 0075 lives under
`modules/identity/db/migrations`. Runtime logins inherit capability roles and
never the owner role. `reputation_service` serves authenticated reads/commands;
`reputation_worker` claims and completes leased jobs; `reputation_ingress`
accepts trusted external evidence; `reputation_operator` configures missions and
rules, makes explicit corrections and requeues blocked work with a reason.
The worker cannot configure policy, correct scores or access base tables.

The migrations seed no missions, reward rules or providers. They create durable
jobs for pending inputs, including existing pending items, without starting a
consumer. API composition optionally uses `REPUTATION_SERVICE_DATABASE_URL`;
there is no automatically started reputation coordinator or configured provider.

## Worker and decision rules

`PostgresReputationWorkerStore` and `ReputationCoordinator` are public server
interfaces. An explicitly constructed coordinator requires trusted rule-hash and
fact selectors, an evaluator factory, external verifier mappings and bounded
runtime limits. Construction starts no work; callers explicitly invoke
`runNext` or `runBoundedBatch`. See [worker responsibilities](worker/README.md).

The provider classifies content using known rule keys. It cannot supply points,
subject identity, money or invented contradictory facts. SQL re-reads the frozen
rule and derives exact points/category when committing. A concrete completed
self-report under Trust needs no mandatory attachment. Unclear interpretation,
unknown rules, unavailable providers and retries do not create a community
dispute or revoke accepted points.

One semantic occurrence awards once per subject. Daily/weekly caps use Kyiv
calendar boundaries and remain effective across ruleset hash changes for the
same rule key. A correction excluding an old award frees active cap capacity;
the permanent semantic journal still prevents rewarding that occurrence again.
Appeals preserve scores. Completion, decision, projection, revision, durable
change and receipt commit together. Expired leases cannot complete new work;
replaying a committed lease returns its immutable receipt.

An acknowledgement proves its signed statement only. External missions stay
checking until a trusted adapter succeeds. The membership adapter checks the
configured channel, bot authority and attributed Telegram user; subscription
rewards and mission mappings remain unconfigured.

## Verification and release

[Verification evidence](../../docs/architecture/reputation-verification.md)
separates measured synthetic checks from outstanding real-source evidence.
The [release gates](../../docs/architecture/reputation-release.md) require two
real weeks of full-roster shadow comparison and explicit cutover approval.
The offline shadow tool compares prepared source projections; it does not import
production history or establish production parity by itself. The shared bot
renderer formats supplied projections without scoring, delivery or live routing.
