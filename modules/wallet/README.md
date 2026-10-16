# Wallet

Owns short lived TON Connect proof challenges and chain balance reads. The
identity module owns the verified subject to address link, revoke history, and
app consent. Each subject can retain up to 16 active wallet links. Wallet SQL uses only identity's published functions. The API obtains
the subject from verified Telegram launch data and never accepts a subject from
the request body.

`POST /me/wallet/challenge` issues a 32 byte, subject bound, single use payload.
`POST /me/wallet/link` verifies mainnet proof and atomically consumes the payload
with the identity link. `GET /me/wallet`, `GET /me/wallet/balances`, and
`POST /me/wallet/revoke` are self only. Community app reads expose only address
or exact balance strings and check current consent on every request.

The chain reader calls fixed TON API endpoints with short deadlines. JPEGPE is
matched against the canonical mainnet jetton master; unknown balances are null.
Amounts remain integer strings. Wallet keys are never accepted.

Payments are wallet-owned intents with a unique subject/app/idempotency key and
one durable claim before TON Connect signing. The platform builds the only
transaction payload. Reconciliation accepts a finalized successful on-chain
receipt matching sender, recipient, token, exact amount and intent-bound purpose;
a wallet response alone never means paid. The receipt hash is unique across
intents. Unknown claims cannot be signed again.

Platform intents are created server-side by a platform module (for example
SPLASH claims) with terms it fixed: amount, recipient and purpose. They need no
app release grant, still need a linked sender wallet, and carry a signing
deadline: the signed message never outlives it and signing stops 30 seconds
before it. A paid intent records the recipient transaction time on chain.
`wallet.platform_payment(app_id, intent_id)` publishes one platform intent to
granted modules (only `splash_owner`). Wallet errors carry stable names
(`PaymentDenied`, `PaymentConflict`, `PaymentExpired`); signing after the
deadline answers `409 payment_expired`.

Payment confirmation includes a numeric sender network fee estimate, obtained by
read-only tonlib emulation of the exact outgoing message against current wallet
state. Quotes expire after 60 seconds. Standard wallet code v1–v5 is pinned to
reviewed SDK implementations; inactive, unknown or signature-disabled wallets
cannot proceed without an estimate. Telegram Wallet trampoline fee estimation is
not supported yet. No external message is broadcast by the estimator. The attached
0.1 TON jetton execution budget is shown separately; it funds downstream execution
and forwarding, and is not a promise of the final fee. The wallet presents its
final estimate before signing.

Receipt checks use TONCenter v3 finalized non-emulated transactions and completed
traces, canonical JPEGPE master-derived wallets and the recipient notification.
A signed BOC or indexer outage never establishes payment. Intent status remains
unknown after any ambiguous signing result; retries reconcile and cannot sign again.
