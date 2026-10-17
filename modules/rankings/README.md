# Rankings

Public holders are people with a selected, still-owned frog and active verified
mainnet wallets. Names are permanent frog usernames. No Telegram data, wallet
addresses or subject IDs leave the public endpoint.

`GET /v1/rankings/holders?token=JPEGPE|TON&limit=50&cursor=...` returns
`{token, entries: [{rank, frogName, frogId, amount, asOf, stale}], nextCursor}`.
Limit is 1–100. Invalid queries return 400; a changed projection invalidates a
cursor with 409. Amounts are smallest-unit integer strings. Order is amount
descending, earliest active verified link, then frog UUID. Ranks are ordinal.

The API runs one refresh at startup and hourly with a database advisory lock
across processes. Wallet reads are sequential, at least two seconds apart.
Each token is summed only if every linked wallet has a known value; the oldest
read time is used. Failed reads retain the prior complete sum, marked stale
once older than six hours. A token with no complete sample is absent, never zero.
Changes to linked wallets invalidate old sums. Clearing selection or losing the
frog hides rows immediately on reads and removes them at the next refresh.

Configure `RANKINGS_SERVICE_DATABASE_URL` (rankings_service) and
`RANKINGS_WORKER_DATABASE_URL` (rankings_worker) together. Neither login has
base-table access. The worker uses wallet's public source and chain reader;
identity and JPEGPE publish narrowly granted SQL functions. Staging's existing
signed-launch guard also covers rankings. No ranking provider runs in staging.
