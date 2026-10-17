# Treasury

Read-only DAO treasury: no payment intents, payouts, signing or broadcasting.
The platform launcher loads `ui/index.ts` on demand using RADA OS components.

Apply migrations 0055–0058. A separate login inherits only `treasury_service`;
`treasury_owner` is NOLOGIN and runtime has no table access or identity grants.
An identity operator must explicitly grant `treasury.steward`. No wallet or role
is seeded. `POST /v1/treasury/config` requires a fresh authenticated launch and
exactly `{ address, enabled, reason }`. It normalizes TON addresses and appends
immutable history. Up to 16 distinct DAO wallets can be configured; disabling a
wallet hides its projection without deleting history. Only DAO-owned public
addresses belong in configuration. Never put personal addresses in this endpoint.

Public reads obey the staging guard:

- `GET /v1/treasury/overview`: wallets, balances, as-of times, staleness, signers.
- `GET /v1/treasury/transactions`: descending chain time with an immutable ID cursor `before`, optional
  `direction=in|out` and `token=TON|JPEGPE`, 50 rows and `nextCursor`.
- `GET /v1/treasury/config/history`: append-only configuration, `before` version
  cursor, 50 rows and `nextCursor`.

Amounts are integer strings with nine decimals. Identity resolves live public
frog names at read time; private/revoked/transferred profiles become anonymous.
No provider address books, comments, Telegram data or private addresses are
returned. Transaction hashes link exact governance evidence matches through a
published governance function; evidence is a steward's record, not settlement
proof. The screen opens the associated decision and its execution evidence.

The five-minute worker obtains chain reads only through wallet's public entry.
It serializes replicas with a session advisory lock, paces indexer requests,
checks the configuration version before saving and inserts movements idempotently.
The reader scans a fixed recent 30-day window ending at the trusted index
watermark when available, at most three pages of 100 for each
asset; capped, failed or unavailable coverage remains incomplete. It reuses
wallet's independently checked indexed coverage watermark. This is a recent
activity projection, not a complete ledger or payment reconciliation interface.
TON messages may include execution funding, fees are not categorized as payouts.
Untrusted on-chain comments are omitted; purpose comes from matching governance
execution evidence. Failed or malformed transfers are excluded.

Last-known samples survive outages, with independent balance, signer and history
as-of times. Ten-minute-old data is stale; incomplete coverage is always flagged.
History cursors are stable under refresh; newly discovered records appear on the
next refresh. Raw counterparties are private projection storage with no runtime
SQL table grants, and are never copied to responses.

Set `TREASURY_SERVICE_DATABASE_URL` and explicitly opt in with
`TREASURY_WORKER_ENABLED=true`; default is false, including production. Synthetic
staging never reads external providers. Staging derives the URL from the separate
`TREASURY_PASSWORD`. No secret key or signing credential is required.

Provider contracts: [TONCenter v3](https://toncenter.com/api/v3/index.html).
