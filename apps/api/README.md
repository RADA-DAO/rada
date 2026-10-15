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
before starting. No Telegram HTTP requests or profile data persistence are needed.
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
not enable publication. Telegram fields are never returned. Governance membership
is unavailable; explicit role grants are not membership evidence.

Missing, invalid or expired authentication returns `401 {"error":"unauthorized"}`;
backend failures return `503 {"error":"unavailable"}`. Responses are not cached.
Ordinary routes accept initData for 24 hours; the privileged authentication policy
is one hour and must be used by future privileged routes. Future clock skew is
limited to 120 seconds. No privileged or financial routes exist in this scaffold.
No logs contain raw initData, Telegram IDs, tokens or database errors.

Run `npm run check` for API types, auth and HTTP unit tests. For the PostgreSQL 17
integration test, apply migrations to an isolated disposable database, set
`API_TEST_DATABASE_URL` to its administrator connection URL, and run
`npm run test:api:db`. The test provisions and removes fixture-only login roles.
It creates synthetic identities and must never target production.

Staging sets `STAGING_SYNTHETIC_ONLY=true` to reject all verified Telegram IDs
except reserved synthetic fixtures 101/102 before persistence. This does not
bypass signature verification. See the [staging runbook](../../infra/compose/STAGING.md).
