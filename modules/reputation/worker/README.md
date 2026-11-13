# Reputation worker and pure adapters

The pure policy/evaluator/membership adapters prepare proposals or verification
results. `ReputationCoordinator` can persist audited proposals and complete
awards through `PostgresReputationWorkerStore`. Neither construction nor module
import starts a worker. No provider, rule selector, trusted fact source, mission
mapping or production reward configuration is installed automatically.

## Frozen policy and interpretation

`freezeRules` validates/deeply freezes server-owned ruleset hashes and rules.
Each rule has a key, canonical exact decimal points, category and cap unit/limit.
Integer units at scale 10000 preserve exact arithmetic. No adapter infers
historical weights or financial entitlements.

`AttributedEvidence` comes from authenticated persisted attribution. Subject,
source and occurrence keys are trusted server inputs. A completed self-report
under Trust can map to a known rule without a mandatory attachment. Only
explicit server-supplied contradictory facts can prevent that path; the model
cannot invent a contradiction, create a dispute or revoke accepted points.

`BoundedEvaluator` sends only content, known rule keys and execution limits to a
provider. The output must contain exactly `classification`, `ruleKey` and
`reason`; identity, money, score and contradiction overrides invalidate it.
Unknown/unclear/malformed classification needs interpretation. Provider errors,
limits, timeouts and capacity require retry. Deterministic acknowledgement and
membership paths have no model dependency.

The evaluator reserves worst-case cost units before calls and bounds concurrency,
tokens, total cost units and deadlines. Failed/aborted attempts do not refund a
reservation. A non-cooperative timed-out provider occupies its slot until it
settles; no unbounded waiting queue is created. A concrete provider adapter must
honor billing/token ceilings itself. No live provider implementation is enabled.

`propose` derives score/category from frozen policy and hashes subject/source
occurrence independently of rule key/version. The proposal itself does not write
an award. The database re-reads the frozen rule instead of trusting proposed
points/category, enforces source attribution and semantic uniqueness, and commits
the item, decision, exact projection, revision, durable change and receipt
atomically. A later ruleset hash cannot bypass the same rule's Kyiv day/week cap.
Caps count currently accepted awards; operator exclusion frees active capacity,
while the immutable semantic journal still prevents rewarding the old occurrence.

## Durable jobs and coordinator

`PostgresReputationWorkerStore` uses a login inheriting `reputation_worker` only.
`claim` uses bounded leases and `SKIP LOCKED`; expired work can be reclaimed, and
stale tokens cannot complete new work. `rules`, `saveProposal`, `retry`,
`commitReport` and `finalizeExternal` are narrow database interfaces. Completion
receipts replay after a lost response without overwriting later corrections.
Exhausted attempt budgets block operational work without disputing the result;
only an operator can requeue a pending blocked item with an audited reason.

`ReputationCoordinator` requires explicit dependencies:

- `rulesHash(job, signal)` selects an authorized server-owned policy snapshot.
- `facts(job, signal)` supplies stable occurrence identity, completed claim and
  actual contradictory facts from trusted persisted sources.
- `evaluatorFactory(rules)` provides the bounded classification adapter.
- `externalVerifiers` maps configured mission IDs to trusted verifiers.
- Runtime limits bound concurrency, deadlines, retry delay, policy cache and batches.

Callers explicitly invoke `runNext` or `runBoundedBatch`; there is no startup
scheduler or API timer for reputation jobs. Preparation/model/network work occurs
outside database transactions. Before commit the coordinator checks attribution,
semantic key and policy identity. An unclear proposal is audited and retried;
lease loss or storage failure does not erase an accepted result. Cached evaluators
are not silently evicted because eviction would reset budgets/occupied slots.
External jobs alone receive a verified Telegram ID through the narrow
identity-owned 0075 interface; interpretation jobs do not expose it.

The runtime owner must configure finite pool acquisition, connection and SQL
statement timeouts. Coordinator preparation deadlines do not cancel an already
running database statement. Provider budgets are reserved per coordinator
instance; production process counts and provider-account ceilings must enforce
the aggregate budget before activation.

## Telegram membership adapter

`membershipVerifier(null, client)` is unconfigured. Trusted configuration pins a
mission occurrence, numeric channel ID and public Telegram proof URL. Inputs use
already verified subject/Telegram identity; channel overrides are rejected.
The caller supplies a deadline AbortSignal and bounded job concurrency.

The adapter calls `getMe`, checks `getChat` matches the configured channel,
confirms bot administrator authority there, then calls `getChatMember` for the
attributed user. Telegram documents reliable other-user lookup when the bot is
an administrator. Member/administrator/owner status establishes membership at
check time; left/banned or unavailable checks remain checking. Restricted status
belongs to supergroups and does not establish channel membership. See official
[getChatMember](https://core.telegram.org/bots/api#getchatmember) and
[ChatMember variants](https://core.telegram.org/bots/api#chatmember).

The proof URL is trusted metadata, not separate proof of membership. This proves
neither continued subscription nor reading or political participation. Failures
cannot revoke earlier awards. `telegramReadClient` uses a fixed HTTPS endpoint,
three read methods, POST JSON, redirect rejection, abort propagation and a
64-KiB response bound. Credentials remain in its closure. It never reads updates
or sends messages. Subscription missions/rewards remain unconfigured.

Fake-provider/fake-fetch unit tests require no network. Actual worker database
and release evidence are tracked in
[verification](../../../docs/architecture/reputation-verification.md) and
[release gates](../../../docs/architecture/reputation-release.md).
