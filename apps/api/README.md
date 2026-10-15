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

The subject is the authenticated person's stable UUID. Request parameters cannot
select a different identity. Profiles remain private until JPEGPE supplies verified
current ownership and a live public projection. A selected frog UUID alone does
not enable publication. Telegram fields are never returned.

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
is one hour and must be used by future privileged routes. Future clock skew is
limited to 120 seconds. No privileged or financial routes exist in this scaffold.
No logs contain raw initData, Telegram IDs, tokens or database errors.

Run `npm run check` for API types, auth and HTTP unit tests. For the PostgreSQL 17
integration test, apply migrations to an isolated disposable database, set
`API_TEST_DATABASE_URL` to its administrator connection URL, and run
`npm run test:api:db`. The test provisions and removes fixture-only login roles.
It creates synthetic identities and must never target production.
