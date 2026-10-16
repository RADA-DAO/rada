# Platform SDK

Framework-neutral shell adapter for Telegram initialization, native Back, theme
chrome, safe areas, viewport and keyboard lifecycle. `initializePlatform` returns
own-profile reading, consent and reviewer operations, Back visibility and disposal; it exposes no launch credentials.
The shell owns translated keyboard labels and navigation destinations.

The keyboard, page Back and swipe controllers preserve the existing tested geometry,
focus and gesture behavior. Custom overlays use `data-keyboard-viewport`; bounded
scrolling content uses `data-keyboard-scroll`. Text fields need at least 16px type.
Numeric fields get one translated Done accessory. Enter dismisses ordinary inputs;
textareas retain newlines and IME composition is ignored. Safe-area properties and
viewport geometry remain inherited and live. Dispose controllers when unmounting.

Page routes provide a stable key, parent, explicit Back callback and live blocked
predicate. Native, header and swipe Back share that callback. Active editors and
dialogs retain gesture ownership. A blocked route consumes Back without falling
through. No navigation action submits or writes data.

## Official app modules

`moduleApi(name)` gives an official module built into the shell (currently
`splash`) a client limited to plain `/v1/<name>/...` paths. The SDK adds the
launch credential; the module sees only status, parsed body and `Retry-After`.
`connectedWallet()` reports the TON Connect address, and `payIntent(appId,
intent, copy, signal)` opens the platform payment window for an intent the
module's server already prepared: the person still confirms the exact terms,
the connected wallet must be the intent's sender, and the result follows the
same reconciliation rules as payment requests below.

## Community app host v1

`rada.app.json` follows `rada.app.schema.json`; `parseAppManifest` also validates
it at runtime. Its requested trust level, design route and permissions are
declarations. A trusted registry release must separately provide the allowed
permission subset, artifact URL and SHA-256.
The optional `icon` is a relative path to a square PNG, WebP or SVG of at most
64 KB. It is served from `/artifacts/<sha256>/<icon>` on the artifact origin and
is part of the manifest the reviewer approves; the launcher falls back to the
monogram if it is missing, too large or of another type. The current shell has no release
registry or published apps yet. Its `RadaAppHost.mount` adapter is ready for a
trusted launcher to supply that release record.

The host fetches an immutable HTML artifact without credentials, checks its
size and SHA-256, and only then starts it in an opaque-origin `allow-scripts`
iframe. Child CSP blocks network and storage access; the shell's `frame-src
'none'` policy blocks external frame navigation. The `rada.member.*` bridge
accepts only requests from the current frame and session channel. Children
never receive Telegram launch data, API credentials or a Telegram user ID.
Generic wallet-signature and DAO-authority requests remain denied.
Wallet address and balance reads pass through the host only for published app
permissions and current app-scoped consent. Each read calls the server, which
rechecks consent and the verified link before serving data. Balance responses
contain exact integer strings. Published `money.transfer` releases can request
a host-owned payment dialog. The child supplies only token, exact amount,
recipient, purpose and idempotency key; the platform fetches the canonical
intent and signs a server-built transaction. Other signature and transaction
requests remain denied.

Personal-data permissions use a host-owned consent dialog and authenticated
`/me/consents` API. The profile shows active grants and lets the person revoke
them. The API uses the privileged one-hour authentication window for writes and
the existing self-only `identity.consents` policy. This host does not yet serve
the protected personal data; future services must check current consent again
for each read. The sandbox protocol derives from the earlier community app
host, with a new platform-only authentication boundary.

Reviewer methods validate queue responses and decision parameters within the
credential-holding adapter. The queue projection excludes author subject IDs,
validates immutable artifact URLs and hashes, and limits one response to 1,000
versions. An oversized or malformed response fails closed. Preview callers must
supply an empty granted-permission list for versions awaiting approval.

Payment requests use `rada.member.payment.request` and return an intent ID and
`prepared`, `cancelled`, `unknown`, or `paid` status. The app must retain its
idempotency key for that purchase and poll `rada.member.payment.status` with the
intent ID after `unknown`. It must never interpret a wallet BOC as payment proof.
Only the server can produce `paid` after chain reconciliation. A claimed intent
cannot be signed again, including wallet rejection, timeout, reload or network loss.
Confirmation shows the full amount and destination plus an expiring numeric sender
fee estimate. Unknown-wallet fee estimation fails closed. Host disposal cancels
unanswered confirmation; once sent to a wallet, a late transaction may still land
and must be reconciled. The platform blocks Back during the active payment request.
