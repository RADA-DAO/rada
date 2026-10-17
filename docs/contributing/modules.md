# Add a platform module

A module owns a domain's server interface, schema, tests and optional built-in
screens. A [community app](community-apps.md) instead consumes the sandbox bridge.
Use [SPLASH](../../modules/splash/README.md) as a complete module example and
[identity](../../modules/identity/README.md) for subject-scoped transactions.

## Layout and public interface

```text
modules/<name>/
  README.md
  index.ts
  api/
    router.ts
    store.ts
  db/
    migrations/
      NNNN_description.sql
    <name>.test.sql
  ui/                         # optional built-in screens
    index.ts
```

1. Describe the owned data and public operations in the module README. Keep
   server exports explicit in `index.ts`; callers import that entry rather than
   internal files. For examples, see [apps/index.ts](../../modules/apps/index.ts)
   and [SPLASH's UI entry](../../modules/splash/ui/index.ts).
2. Keep module dependencies out of `apps/`. Compose the new router and store in
   [app.ts](../../apps/api/src/app.ts) and [main.ts](../../apps/api/src/main.ts),
   using injected verified authentication and a separate service pool.
3. If adding screens, export them through `ui/index.ts`, consume `@rada/ui`
   and translation keys, and keep server imports out of UI code. Extend the SDK
   deliberately: its [module client](../../packages/platform-sdk/src/module-api.ts)
   currently permits only `splash`, with requests confined to `/v1/splash/*`.

The [architecture checker](../../tools/architecture.mjs) rejects internal
cross-module imports, application dependencies and direct foreign-table SQL.
Use an owner's public TypeScript entry and SQL functions. To publish a SQL view,
export a literal `SQL_PUBLIC_VIEWS` array from the owner's `index.ts`, with a
matching owned `CREATE VIEW` in its SQL. Avoid exposing private columns.

## Migrations and roles

- Create `db/migrations/` even for a module with no SQL yet: the
  [discovery code](../../tools/migrations.mjs) visits every module directory.
  The [database test runner](../../tools/db-test.mjs) also expects `db/`.
- Choose the next unused four-digit version **across all modules**, greater
  than existing versions. Use `NNNN_lower_case_description.sql`. Versions are
  globally unique, not per-module counters.
- Migrations are forward-only. Never edit/remove an applied file or insert one
  before an applied version. The [runner](../../tools/db-migrate.mjs) checks
  names/checksums and applies a serialized transactional batch. Do not include
  transaction control or psql commands. See the [migration contract](../../db/migrations/README.md).
- Follow the [SPLASH schema migration](../../modules/splash/db/migrations/0016_splash_submissions.sql):
  a `NOLOGIN` owner owns the schema and objects; a separate `NOLOGIN` service
  role receives only the required schema/function privileges. Revoke default
  public function execution and set a safe `search_path` on definer functions.
  Provision actual login credentials separately; never grant an owner role to
  a runtime login or embed passwords in a migration.
- Resolve subjects only from verified launch identities. Set `rada.subject_id`
  with `set_config(..., true)` in the same transaction/connection used for
  queries. Enforce subject access in SQL and test missing/foreign context.
- Cross-domain authority needs a narrow owner-provided interface and explicit
  grants. Do not read or write another module's base tables. Historical
  0001–0003 are hash-protected exceptions, not templates for new cross-table access.

## Verification

Add synthetic SQL tests in `db/*.test.sql` with rolled-back fixture writes, and
unit tests for meaningful behavior and authorization failures. The database runner
finds SQL tests automatically. Add new Node/Deno test files to the relevant
explicit scripts in [package.json](../../package.json); API type/lint commands
also use explicit path patterns. Update composition and relevant integration
coverage, then run the [local suites](local-development.md).
