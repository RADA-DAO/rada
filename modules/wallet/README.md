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
Amounts remain integer strings. No wallet keys, payment or transaction methods
are accepted.
