# Architecture

RADA has a Telegram Mini App shell, a composed HTTP API and a shared PostgreSQL
17 database. Domains own their code and SQL interfaces. See the
[contributor guide](../contributing/README.md) and [ADRs](../adr/README.md).

## Repository map

| Path                                                              | Responsibility                                                                                                   |
| ----------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| [apps/miniapp](../../apps/miniapp/README.md)                      | Vite shell, navigation, profile, launcher and app review                                                         |
| [apps/api](../../apps/api/src/app.ts)                             | Hono middleware and module router composition; [main.ts](../../apps/api/src/main.ts) configures pools and timers |
| [apps/bot](../../apps/bot/README.md)                              | Telegram entry point placeholder                                                                                 |
| [apps/builder](../../apps/builder/README.md)                      | Isolated community build placeholder                                                                             |
| [apps/workers](../../apps/workers/README.md)                      | Background worker placeholder; current SPLASH and alert timers run in the API                                    |
| [apps/ai-gateway](../../apps/ai-gateway/README.md)                | AI gateway placeholder                                                                                           |
| [modules/identity](../../modules/identity/index.ts)               | Telegram verification, subjects, profile selection, role grants, consents and wallet links                       |
| [modules/apps](../../modules/apps/index.ts)                       | App versions, review, publication and registry tiers                                                             |
| [modules/jpegpe](../../modules/jpegpe/index.ts)                   | Frogs, ownership, usernames, public projections and Color Drop                                                   |
| [modules/wallet](../../modules/wallet/index.ts)                   | Wallet proofs, balances, payment intents and reconciliation                                                      |
| [modules/ops](../../modules/ops/index.ts)                         | Sanitized client errors and operator failure digests                                                             |
| [modules/splash](../../modules/splash/index.ts)                   | Submissions, secret lowest-unique-bid rounds, paid claims and built-in screens                                   |
| [packages/ui](../../packages/ui/README.md)                        | Shared controls, design tokens, theme compiler and component catalog                                             |
| [packages/platform-sdk](../../packages/platform-sdk/src/index.ts) | Telegram adapter, navigation, API clients, app sandbox and payment window                                        |
| [packages/i18n](../../packages/i18n/src/index.ts)                 | Typed English/Ukrainian translations and interpolation                                                           |
| [infra/compose](../../infra/compose/README.md)                    | Local database and separate staging configuration                                                                |

The placeholder apps contain READMEs, not runnable services. Official built-in
screens use a module's `ui/index.ts`; community releases run as sandboxed HTML.
Changing a registry tier does not turn an artifact into a built-in module.

## Request flow

1. Telegram opens the shell with WebApp launch data. The
   [SDK adapter](../../packages/platform-sdk/src/index.ts) keeps the credential
   and sends `Authorization: tma <initData>` to platform endpoints. Ordinary
   browser launches remain guests. Community children never receive this data.
2. The shell uses same-origin `/api` (the local
   [Vite proxy](../../apps/miniapp/vite.config.ts)) or a configured API origin.
   [API composition](../../apps/api/src/app.ts) installs request IDs, no-store,
   CORS, staging guards and module routers.
3. Identity [authentication policy](../../modules/identity/api/policy.ts) and
   [signature verification](../../modules/identity/api/auth.ts) verify the
   canonical bot signature: ordinary launches last 24 hours, privileged launches
   one hour, with at most 120 seconds of future skew. Each route selects its
   authentication policy; public reads and client-error ingestion have separate rules.
4. A module store resolves the verified Telegram ID to a stable UUID using
   `identity.resolve_telegram` on the `identity_auth` pool. On a service
   connection it begins a transaction and sets parameterized, transaction-local
   `rada.subject_id`; see the [identity store](../../modules/identity/api/store.ts).
5. Module SQL functions and row-level policies enforce access. Query, commit or
   rollback happen on that same connection. Subject context is an isolation aid;
   it is trusted only because the server set it after verification.

Runtime logins inherit narrowly scoped `*_service` roles, never `*_owner`.
Owner roles are `NOLOGIN`; migration credentials can assume them and must remain
separate from runtime credentials. The auth role only resolves identities;
`identity_operator` manages explicit grants, and `jpegpe_operator` invokes frog
creation/transfer functions. Community apps have no database credentials.
See [database roles](../../db/README.md) and the owning
[migrations](../../db/migrations/README.md) for exact privileges.

## Trust and authority

- Registry tiers are `community` (default) and `official`. Only an explicit
  `apps.steward` grant can change tier, with an append-only reason and actor
  history. The [tier migration](../../modules/apps/db/migrations/0013_apps_official_tier.sql)
  implements this independently of review.
- `apps.reviewer` authorizes review, publish, rollback and withdrawal through
  the [registry functions](../../modules/apps/db/migrations/0002_apps.sql).
  `apps.steward` is a [separate identity grant](../../modules/identity/db/migrations/0012_identity_apps_steward.sql).
  `splash.steward` controls the claim recipient via a
  [separate check](../../modules/identity/db/migrations/0020_identity_splash_steward.sql).
- Manifest permissions are requests. Published permissions come from the
  registry's allowlist; personal-data access also needs current app-scoped
  consent. `money.transfer` uses the platform payment flow; generic wallet
  signing and governance authority are not exposed by the sandbox.
  See [community apps](../contributing/community-apps.md).
- Telegram membership is display evidence, not a role or write permission:
  [provider](../../modules/identity/api/membership.ts). Owning or selecting a
  frog does not grant reviewer or steward authority. The
  [identity migration](../../modules/identity/db/migrations/0001_identity.sql)
  seeds no role grants.

## CI contracts

[CI](../../.github/workflows/ci.yaml) requires quality, database, end-to-end and
visual jobs, plus dependency review on pull requests.
[package.json](../../package.json) defines the check commands.

| Contract                                                                                                                                                                                         | Enforcing source                                                                                                           |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------- |
| Cross-module imports use `index.ts` or `ui/index.ts`; modules cannot import application composition; module screens cannot import API code                                                       | [architecture checker](../../tools/architecture.mjs)                                                                       |
| Runtime/new migration SQL uses owned relations or public SQL functions/views; 0001–0003 retain exact hashes                                                                                      | [architecture checker](../../tools/architecture.mjs)                                                                       |
| Public SQL views require an owned definition and literal exported `SQL_PUBLIC_VIEWS` list                                                                                                        | [architecture checker](../../tools/architecture.mjs)                                                                       |
| Code files have at most 400 lines, excluding tests, fixtures and generated code                                                                                                                  | [code-size check](../../tools/architecture.mjs)                                                                            |
| English outside locales; visible UI literals require translation keys; Markdown, relative links, path hygiene and dependency licenses are checked                                                | [repository checker](../../tools/check.mjs)                                                                                |
| Runtime `apps/` and `modules/` use shared UI components/tokens, public UI imports and stylesheet; local CSS/style injection, raw colors/dimensions and gesture ownership violations are rejected | [design-system gate](../../tools/design-system.mjs)                                                                        |
| Catalog screenshots match exactly in Chromium/WebKit at mobile/desktop sizes                                                                                                                     | [visual configuration](../../apps/miniapp/playwright.visual.config.ts), [tests](../../apps/miniapp/visual/catalog.spec.ts) |

Architecture, i18n and design checks are static source checks, not a runtime
sandbox. Their scopes and exceptions are defined in the linked code. The
400-line CI rule covers code extensions; contributor documentation also stays
within 400 lines per file.

CI additionally runs migration/isolation tests, synthetic browser flows, Compose
and staging checks, Conventional Commit validation and Gitleaks history/file scans.
See [local checks](../contributing/local-development.md) and
[visual baselines](../contributing/visual-tests.md).
