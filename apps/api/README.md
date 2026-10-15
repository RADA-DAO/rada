# API

Deno 2.9.7 and Hono provide platform authentication and own identity reads.
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
Published `grantedPermissions` excludes financial and DAO authority capabilities;
personal-data access still requires live app-scoped user consent at the service
that handles the data. The host must verify artifact bytes against SHA-256.

The subject is the authenticated person's stable UUID. Request parameters cannot
select a different identity. If that person has selected a currently owned frog,
`profile` instead contains `{"visibility":"public","public":{"frog_id":"…",
"username":"…","background_color":"#123456","accent_color":"#ABCDEF"}}`.
Colours may be null. Ownership is rechecked on each read, so a transferred frog
immediately makes the former owner's profile private. Telegram fields, proofs and
other private identifiers are never returned. Selection is currently available
through the identity-owned database function, not a client API route.

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
limited to 120 seconds. No financial transaction routes exist in this scaffold.
No logs contain raw initData, Telegram IDs, tokens or database errors.

Run `npm run check` for API types, auth and HTTP unit tests. For the PostgreSQL 17
integration test, apply migrations to an isolated disposable database, set
`API_TEST_DATABASE_URL` to its administrator connection URL, and run
`npm run test:api:db`. The test provisions and removes fixture-only login roles.
It creates synthetic identities and must never target production.

Staging sets `STAGING_SYNTHETIC_ONLY=true` to reject all verified Telegram IDs
except reserved synthetic fixtures 101/102 before persistence. This does not
bypass signature verification. This mode always returns membership `unavailable`
and never calls Telegram, even if a chat ID is configured. The isolated staging
API has no outbound network access. Live membership requires a non-synthetic
runtime with outbound HTTPS to Telegram. See the [staging runbook](../../infra/compose/STAGING.md).
