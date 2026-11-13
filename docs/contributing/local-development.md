# Local development and tests

Run commands from the repository root. The supported toolchain is Node
[24.14.0](../../.node-version), npm and Deno 2.9.7; database tests need PostgreSQL
17 and `psql`. Docker Compose v2 provides the optional database. Playwright uses
Chromium and WebKit. Versions and commands are defined in
[package.json](../../package.json), [API config](../../apps/api/deno.json) and
[CI](../../.github/workflows/ci.yaml).

```sh
npm ci
npm run check
npm run dev:miniapp
```

The [Vite configuration](../../apps/miniapp/vite.config.ts) proxies `/api` to
`127.0.0.1:8000`. Without a Telegram host, the shell opens as a guest. For the
component catalog, use `CATALOG=true npm run dev:miniapp` and open
`/catalog.html?theme=guest` (also `light` or `dark`).

## One-command synthetic platform

After `npm ci`, start the complete disposable local environment:

```sh
npm run dev:local
```

This command needs Node 24, Deno 2.9.7, a local Docker engine and OpenSSL.
The launcher targets macOS and Linux; on Windows, run it inside WSL2 with a
local Docker integration.
Docker Compose and a host `psql` are not needed for this path. It uses the pinned
PostgreSQL 17 image already declared by local infrastructure. A Docker context
can be selected for this command only, for example
`DOCKER_CONTEXT=colima npm run dev:local`; it never changes the global context.
Remote Docker daemons are rejected.

If Colima's shared automatic port forwarding is unavailable, opt into an
independent session-owned tunnel:

```sh
DOCKER_CONTEXT=colima RADA_LOCAL_COLIMA_TUNNEL=true npm run dev:local
```

This reads `colima ssh-config` into a temporary private file and starts one
independent SSH process forwarding a new loopback port to the disposable
container's VM port. It never restarts Colima, changes its shared ControlMaster,
or edits global SSH/Docker configuration. The tunnel is stopped with the session.
The flag is rejected with other Docker contexts.

The launcher creates one uniquely labelled disposable database container with a
random loopback-only port and in-memory data, applies the existing migrations,
and provisions separate restricted identity/auth/registry logins. Synthetic
identity 101 is the author; identity 102 is the reviewer/steward. The normal
server-side Telegram HMAC validator still checks both launches. The browser gets
a local stand-in host only from this development server; no production frontend
or authentication policy is changed. No real Telegram/provider requests,
balances or production database are involved.

- Shell: `http://127.0.0.1:4173`
- API: `http://127.0.0.1:8000`
- Immutable artifacts: `https://127.0.0.1:8443`

Before opening a published example interactively, visit
`https://127.0.0.1:8443/health` and accept this session's self-signed local
certificate in the browser. HTTPS remains required by the registry and SDK.
The launcher never modifies the system trust store; the temporary certificate
and private key are removed on exit. Browser automation may use its isolated
`ignoreHTTPSErrors` context. Never disable TLS verification globally.

Ports must be free: the launcher refuses to reuse or stop existing listeners.
It does not read `.env`, and inherited API/database/provider/Vite configuration
is excluded. Ctrl-C, command failure and normal exit stop only the owned child
process groups and container, verify the ports are released, and remove the
session directory. Every run starts with fresh data; this is not a persistent
backend or a production-like wallet environment.

```sh
npm run dev:local -- --check
npm run dev:local -- --exec node path/to/local-check.mjs
```

`--check` verifies prerequisites and port availability without starting services.
`--exec` starts the same environment, runs a command without a shell, returns its
exit status and then cleans up. The command receives `RADA_LOCAL_API_ORIGIN`,
`RADA_LOCAL_WEB_ORIGIN`, `RADA_LOCAL_ARTIFACT_ORIGIN`,
`RADA_LOCAL_ARTIFACT_DIR` (parent of the `artifacts/` directory),
`RADA_LOCAL_CERTIFICATE` and the disposable `RADA_LOCAL_DATABASE_URL`.
These credentials exist only for that session; never save them in repo files.
Use the [SDK example](../../packages/platform-sdk/examples/hello-community/README.md)
for the creation, review, publication and rollback walkthrough.

## Advanced database and API setup

The following low-level commands are retained for individual module testing.
They are independent of `dev:local`; do not point them at the launcher's database.

```sh
cp .env.example .env
# Set disposable local values in .env.
npm run db:config
npm run db:up
```

[Local Compose](../../infra/compose/local.yaml) starts only PostgreSQL on an
internal network, without published ports. It does not start/migrate the API or
load `.env` into your shell. For migration/SQL tests, obtain its container ID
with `docker compose --env-file .env -f infra/compose/local.yaml ps -q postgres`,
set `PG_CONTAINER` to that ID, and export `PGUSER`/`PGDATABASE` matching `.env`:

```sh
npm run db:migrate
npm run test:db
npm run db:down
```

The runner invokes `psql` inside that container. `db:down` preserves its named
volume; use a fresh disposable database for integration suites, and remove the
disposable volume when finished. See the [migration contract](../../db/migrations/README.md).

For an interactive API, use a disposable PostgreSQL 17 instance reachable from
the API process (the default Compose database is not reachable from host Deno).
Apply migrations using an administrator connection, then provision separate
runtime logins with only the [documented roles](../../db/README.md). Export
`IDENTITY_AUTH_DATABASE_URL`, `IDENTITY_SERVICE_DATABASE_URL` and the bot token
expected by your synthetic launch fixture. Start the API in a separate terminal:

```sh
deno run --allow-env --allow-net --config apps/api/deno.json apps/api/src/main.ts
```

The listener defaults to `127.0.0.1:8000`. For fixtures, set
`STAGING_RUNTIME=true`, `STAGING_AUTH_MODE=synthetic`, and
`STAGING_SYNTHETIC_ONLY=true`; leave `STAGING_ALLOWED_TELEGRAM_IDS` unset. This
still verifies signatures, accepts only fixture IDs 101/102 and suppresses
Telegram membership calls. See the [auth policy](../../modules/identity/api/policy.ts)
and [synthetic fixtures](../../apps/api/src/fixtures.ts). Keep external provider
features disabled or use the existing test doubles for offline development.

Optional modules require additional environment configuration in
[main.ts](../../apps/api/src/main.ts): registry URL plus artifact origin, wallet
URL plus proof origin, SPLASH URL, or client-error URL. See the
[API README](../../apps/api/README.md). Wallet proof origin must be non-loopback
HTTPS; a plain local browser is insufficient for a real wallet proof. There are
no bot, builder, worker or AI gateway processes to start in this checkout.

## Test suites

| Command                      | Scope / requirements                                                                                                                                                        |
| ---------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `npm run check`              | Prettier, ESLint, Deno lint, repository/architecture gates, TypeScript, listed Node tests, Color Drop and API checks                                                        |
| `npm run test:unit`          | Explicit Node test list in `package.json`; no database                                                                                                                      |
| `npm run check:jpegpe-color` | Offline protocol/proof/signature/quorum fixtures                                                                                                                            |
| `npm run check:api`          | Deno type checks and HTTP/auth unit tests; no database                                                                                                                      |
| `npm run test:db`            | Migration checks and discovered module SQL tests against a fresh disposable PostgreSQL 17 database; standard libpq variables or `PG_CONTAINER`                              |
| `npm run test:api:db`        | Deno database integration tests; set `API_TEST_DATABASE_URL` to a disposable administrator connection reachable from Deno                                                   |
| `npm run e2e`                | Real local API/database plus shell in mobile/desktop Chromium/WebKit; set `E2E_DATABASE_URL` to a fresh local PostgreSQL 17 administrator URL; needs Deno, `psql`, browsers |
| `npm run test:visual`        | Catalog screenshots; see [baseline workflow](visual-tests.md)                                                                                                               |
| `npm run build:miniapp`      | Production shell build                                                                                                                                                      |
| `npm run commits`            | Conventional Commit validation; optionally set `COMMIT_RANGE=base..HEAD`                                                                                                    |

Install browser binaries with `npx playwright install chromium webkit` (CI uses
`--with-deps` on Linux). The [E2E runner](../../tools/e2e.mjs) applies migrations,
creates restricted fixture logins, starts/stops the API, and runs the
[browser configuration](../../apps/miniapp/playwright.config.ts). It requires a
loopback database URL. Its configured services include identity, registry, wallet
and client errors; it does not enable SPLASH. Use the API/SPLASH integration
suites for that module. Discard test databases afterward; use synthetic data only.

On Node 22, execute TypeScript tests with
`node --experimental-strip-types --no-warnings --test <test-files>`; `.mjs`
tests can use `node --test`. Tests that spawn Node subprocesses also need
`NODE_OPTIONS="--experimental-strip-types --no-warnings"` so those children can
load TypeScript. This is a local fallback, not the supported CI runtime. Without Deno, the full `npm run check` cannot pass; run and report these
independent checks without changing the gates:

```sh
npx eslint tools packages apps/miniapp modules
node tools/check.mjs
npx tsc
```

Unit entry files are explicitly listed; some import further suites, such as
[check.test.mjs](../../tools/check.test.mjs) importing architecture, staging and
UI tests. Check both the script and its imports when adding coverage. Physical
Telegram keyboard/safe-area verification remains separate from browser emulation.
