# Identity

Owns verified Telegram identity resolution, own profiles and selections, role grants,
app-scoped consents, and Telegram membership display. `index.ts` exports the
store, identity router, authentication verifier, membership provider and
`resolveTelegramSubject` for callers holding an auth-only pool.

The router owns `/me`, `/me/consents`, `/me/frogs` and `/me/profile-frog`. Profile reads call JPEGPE's public
projection helper on the same subject-scoped transaction connection; identity
never reads JPEGPE tables. Membership conveys no write authority.

`db/migrations` contains immutable, globally versioned SQL history.
`db/*.test.sql` verifies the module with synthetic, rolled-back fixtures.
Cross-module TypeScript imports use only the other module's `index.ts`.

The public authentication policy parses server-only staging modes before startup,
verifies signed launches, and registers a guard over all staging API routes.
Allowlist and synthetic staging modes suppress external membership calls.
