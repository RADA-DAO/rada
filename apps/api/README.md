# API

Deno 2.9.7 and Hono compose HTTP middleware and module routers.
Domain logic lives in [identity](../../modules/identity/README.md),
[apps](../../modules/apps/README.md) and [JPEGPE](../../modules/jpegpe/README.md).
The [wallet](../../modules/wallet/README.md) module handles proof challenges and chain reads.
Dependencies are pinned in `deno.json`, `deno.lock`, and the root npm lockfile
(the npm lockfile supplies dependency license review).

```sh
deno run --allow-env --allow-net --config apps/api/deno.json apps/api/src/main.ts
```

The PostgreSQL driver also reads standard process environment defaults, so the
runtime needs environment permission.

Supply one canonical platform `TELEGRAM_BOT_TOKEN` and separate
`IDENTITY_AUTH_DATABASE_URL` / `IDENTITY_SERVICE_DATABASE_URL` credentials with
only the corresponding [database roles](../../db/README.md). Apply migrations
before starting. Membership is disabled unless `DAO_TELEGRAM_CHAT_ID` is
configured; no Telegram profile data is persisted.
Enable wallet endpoints with a `wallet_service` login in `WALLET_SERVICE_DATABASE_URL`
and the exact HTTPS shell origin in `WALLET_APP_ORIGIN`. These settings must be
provided together; the origin hostname is the only accepted proof domain.
The API rejects loopback proof domains. The shell build uses the same origin in
`VITE_TON_CONNECT_APP_ORIGIN` to emit `tonconnect-manifest.json`.
The listener defaults to `127.0.0.1:8000`; `API_HOST` can override the bind address.
Set `API_ALLOWED_ORIGINS` to comma-separated exact HTTP(S) origins for browser
clients. An empty value disables cross-origin reads. Credentials are not enabled.

- `GET /health` returns `{"status":"ok"}` for process liveness; it does not probe DB readiness.
- `GET /me` requires `Authorization: tma <raw Telegram initData>` and returns:

```json
{
  "subject_id": "00000000-0000-4000-8000-000000000001",
  "profile": { "visibility": "private", "public": null },
  "membership": { "status": "unavailable" }
}
```

`GET /me/consents` returns only the authenticated person's active app grants.
`PUT /me/consents` accepts `{ "appId": "app.slug", "capability":
"wallet.address.read", "granted": true }` for one supported personal-data
permission. Writes require the privileged one-hour launch signature. Revoking
marks the existing row inactive; it does not select another subject or erase
the audit timestamp. Manifest declarations alone cannot grant access.

Enable the registry with a separate `APPS_SERVICE_DATABASE_URL` credential and
an exact HTTPS `APP_ARTIFACT_ORIGIN`; both settings are required together.
Authors submit a manifest and SHA-256; the API derives
`/artifacts/<sha256>.html` under that origin. The artifact must already be staged
there. A submission creates a private draft and advances it to the review queue
atomically. Registry writes and review-queue reads require a signed launch
within one hour.

- `POST /apps/:appId/versions`: `{ "manifest": {...}, "sha256": "64 hex digits" }`.
- `GET /apps/review-queue`: reviewer-only pending versions.
- `POST /apps/:appId/versions/:versionId/approve` or `/reject`: `{ "reason": "..." }`.
- `POST /apps/:appId/versions/:versionId/publish`: `{}`.
- `POST /apps/:appId/rollback`: `{ "versionId": "approved earlier version UUID" }`.
- `POST /apps/:appId/withdraw`: `{ "reason": "..." }`.
- `GET /apps/published`: approved live releases for a future launcher.

Review and publication require the `apps.reviewer` grant in
`identity.role_grants`. The registry login cannot issue role grants. A review
records the actor and reason; the public projection omits private subject IDs.
Published `grantedPermissions` includes reviewer-approved `money.transfer`;
other financial and DAO authority capabilities remain excluded.
personal-data access still requires live app-scoped user consent at the service
that handles the data. The host must verify artifact bytes against SHA-256.

The subject is the authenticated person's stable UUID. Request parameters cannot
select a different identity. If that person has selected a currently owned frog,
`profile` instead contains `{"visibility":"public","public":{"frog_id":"…",
"username":"…","background_color":"#123456","accent_color":"#ABCDEF"}}`.
Colours may be null. Ownership is rechecked on each read, so a transferred frog
immediately makes the former owner's profile private. Telegram fields, proofs and
other private identifiers are never returned. `GET /me/frogs` returns only the authenticated person's collection, with frog UUID,
username, colours and nullable `artwork_path`. It never accepts an owner selector.
`PUT /me/profile-frog` accepts exactly `{ "frogId": "UUID" }` or `{ "frogId": null }`;
selection requires current ownership and a launch within one hour. A stale or foreign
frog returns 409. Clearing selection makes the profile private. Selection and transfer
serialize through the existing owner functions. Collection reads retain the 24-hour window.

Membership is checked in the configured closed DAO Telegram chat, using the
same canonical bot token as authentication. `membership.status` is `member`,
`not_member` or `unavailable`. Without `DAO_TELEGRAM_CHAT_ID`, it is `unavailable`.
Supply the private chat's negative decimal ID only through the environment.
The bot must be an administrator for reliable checks of other users, as required
by [getChatMember](https://core.telegram.org/bots/api#getchatmember). Creator,
administrator and member statuses count as membership; restricted users count
only when `is_member` is true. Left and kicked users are not members. Unknown
responses, errors and two-second timeouts produce `unavailable`, preserving the
private identity response. Membership does not grant DAO authority or write roles.

Successful membership results are cached for 30 seconds, with a maximum of 1,024
identities per provider instance bound to one bot and chat. Expired results are
never served; unavailable results are not cached. A membership change can take up
to 30 seconds to appear. Future privileged operations must revalidate their own
authorization rules rather than treating this display flag as authority.

Missing, invalid or expired authentication returns `401 {"error":"unauthorized"}`;
backend failures return `503 {"error":"unavailable"}`. HTTP responses are not cached.
Ordinary routes accept initData for 24 hours; the privileged authentication policy
is one hour and applies to consent and registry writes. Future clock skew is
limited to 120 seconds. Payment creation, claim and cancellation require the
privileged one-hour launch; reconciliation is self-only. `/me/payments` never
accepts arbitrary transaction messages. The payment dialog shows exact amounts
and the wallet estimates its own network fee before signing. A claim is
single-use, including after an unknown wallet outcome.
Every response carries a server-generated `request-id` header (client values are
ignored). A failed request writes one JSON line to stdout with time, request id,
method, matched route pattern, error class, optional error code and duration;
nothing else (no URL, headers, bodies, messages or IPs). Failure counts per route
since start are served at `GET /health/errors` with `Authorization: Bearer
$API_OPS_TOKEN`; without a configured token, or with a wrong one, it returns 404.
No logs contain raw initData, Telegram IDs, tokens or database errors.

Run `npm run check` for API types, auth and HTTP unit tests. For the PostgreSQL 17
integration test, apply migrations to an isolated disposable database, set
`API_TEST_DATABASE_URL` to its administrator connection URL, and run
`npm run test:api:db`. The test provisions and removes fixture-only login roles.
It creates synthetic identities and must never target production.

Staging sets `STAGING_RUNTIME=true` and `STAGING_AUTH_MODE=allowlist`, with a
nonempty server-only `STAGING_ALLOWED_TELEGRAM_IDS` list. Every staging data route,
including public registry reads, rejects unsigned or unlisted launches before
persistence/provider calls. Invalid or conflicting configuration prevents startup.
CI instead sets `STAGING_AUTH_MODE=synthetic` and `STAGING_SYNTHETIC_ONLY=true`:
only signed fixtures 101/102 are accepted. Both staging modes return membership
`unavailable` without Telegram calls. Production keeps normal verified identity
and configured membership behavior. See the [staging runbook](../../infra/compose/STAGING.md).
