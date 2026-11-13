# Reputation worker adapters

These are off-request-path building blocks. They install no jobs, missions,
providers, rewards or production configuration and cannot persist an award.

## Frozen policy and interpretation

`freezeRules` validates and deeply freezes a server-owned ruleset hash and rules.
Each rule has a key, canonical exact decimal points, category and an explicit
cap unit/limit. Decimal strings are validated as integer units at scale 10000;
no floating-point scoring or historical-weight inference occurs.

`AttributedEvidence` must come from authenticated persisted attribution. Its
subject, source and occurrence key cannot come from the provider. A completed
self-report under Trust needs a concrete completed classification mapped to a
known rule; attachments are not required. The only contradictory facts are the
explicit server-supplied `contradictions` records. A model cannot manufacture a
dispute or revoke a previous award.

`propose` maps classification to policy-owned score/category and emits a proposal.
Its stable semantic key excludes provider choice, rule key and ruleset version,
so reclassification of one subject/source occurrence cannot award it twice.
The durable consumer must atomically enforce that key, the frozen rules hash,
fresh cap usage, item/decision mutation and its durable change event. Carrying a
cap in a proposal does not establish that historical cap usage is available.

`BoundedEvaluator` only exposes content and available rule keys to a provider.
The provider returns exactly `classification`, `ruleKey` and `reason`; additional
identity, money, score or contradiction fields invalidate the output. An unknown
rule, unclear completion or malformed output needs interpretation. Technical
failures, capacity, deadlines and provider limits request a retry. These states
never imply community dispute, score removal or rejection of a person's work.
Deterministic acknowledgement/membership paths call their trusted adapters and
policy mapping directly; they have no model dependency.

The caller supplies maximum concurrency, token limit per call, worst-case cost
units per call, total cost-unit budget and deadline. Before a provider call the
worker reserves its full worst-case cost; aborted/failed attempts do not refund
it. No unbounded waiting queue is created. A timed-out non-cooperative provider
continues occupying its slot until it settles, preventing repeated timeouts from
creating unbounded hidden work. The concrete provider adapter must actually
apply the token/cost ceilings to its billing API; this interface has no live
provider and makes no claim to measure provider billing.

## Telegram membership

`membershipVerifier(null, client)` remains unconfigured. A trusted configuration
pins one mission occurrence, a numeric channel ID and a public Telegram proof
URL. Inputs contain the already verified platform subject/Telegram identity and
mission ID; channel overrides are rejected. Callers supply an AbortSignal with
a deadline, and durable workers supply their own bounded job concurrency.

The adapter checks bot identity with `getMe`, confirms `getChat` resolves the
expected numeric channel, checks that bot's administrator status there, and only
then calls `getChatMember` for the attributed user. Telegram documents reliable
other-user membership lookup when the bot is an administrator. Member,
administrator and owner statuses establish membership at check time; left or
banned users remain checking. Restricted status belongs to supergroups and does
not establish channel membership. See the official [getChatMember guarantee](https://core.telegram.org/bots/api#getchatmember)
and [ChatMember variants](https://core.telegram.org/bots/api#chatmember).

Failure or missing authority remains checking and cannot revoke an accepted
award. The proof URL is trusted configuration metadata, not independent proof of
membership. The adapter observes membership at request time; it proves neither
long-term subscription nor reading, political participation or a future status.

`telegramReadClient` uses a fixed HTTPS endpoint, three read methods, POST JSON,
redirect rejection, abort propagation and a 64-KiB response limit. Runtime
credentials stay in its closure. It never reads updates or sends messages.
Tests inject fake fetch and synthetic fixtures; no real network is required.

```sh
node --experimental-strip-types --test modules/reputation/tests/worker.test.ts
```
