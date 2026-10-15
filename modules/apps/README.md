# Apps

Owns app manifests, immutable release versions, review and publication history.
`index.ts` exports the registry store, its types and `registerRegistryRoutes`.
The router owns `/apps/*`; the HTTP composer injects verified authentication.

The store resolves verified Telegram identifiers through identity's public
entry point and uses only apps-owned SQL functions for registry operations.
Reviewer authorization remains the identity-owned SQL function used by the
unchanged historical migration. Manifest permissions do not grant authority.

`db/migrations` contains immutable, globally versioned SQL history.
`db/*.test.sql` verifies the module with synthetic, rolled-back fixtures.
Cross-module TypeScript imports use only the other module's `index.ts`.
