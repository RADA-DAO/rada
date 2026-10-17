# Identity

Owns verified Telegram identity resolution, own profiles and selections, role grants,
app-scoped consents, and Telegram membership display. `index.ts` exports the
store, identity router, authentication verifier, membership provider and
`resolveTelegramSubject` for callers holding an auth-only pool.
Wallet links and append-only link/revoke history are identity-owned. Narrow SQL
functions expose only the current subject's active wallets and live app consent
to `wallet_service`; other modules do not read these base tables.

The router owns `/me`, `/me/consents`, `/me/frogs` and `/me/profile-frog`. Profile reads call JPEGPE's public
projection helper on the same subject-scoped transaction connection; identity
never reads JPEGPE tables. Membership conveys no write authority.

`db/migrations` contains immutable, globally versioned SQL history.
`db/*.test.sql` verifies the module with synthetic, rolled-back fixtures.
Cross-module TypeScript imports use only the other module's `index.ts`.

The public authentication policy parses server-only staging modes before startup,
verifies signed launches, and registers a guard over all staging API routes.
Allowlist and synthetic staging modes suppress external membership calls.

`identity.holder_profiles()` publishes selected, still-owned frogs with active
wallet link versions to `rankings_owner`. `identity.holder_wallets()` is a private
worker-only wallet source used through wallet's public TypeScript interface.
Neither function is available to the public ranking reader login.

The offline legacy importer uses restricted `import_person`, state/availability
checks and ownership-checked `import_selection` SQL functions. Only the
`legacy_import` role can execute these functions; it receives no base-table
access or role-grant authority. See [runbook](../../tools/import/README.md).
