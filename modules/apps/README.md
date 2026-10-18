# Apps

Owns app manifests, immutable release versions, review and publication history.
`index.ts` exports the registry store, its types and `registerRegistryRoutes`.
The router owns `/apps/*`; the HTTP composer injects verified authentication.

The store resolves verified Telegram identifiers through identity's public
entry point and uses only apps-owned SQL functions for registry operations.
Reviewer authorization remains the identity-owned SQL function used by the
unchanged historical migration. Manifest permissions do not grant authority. Official status is stored on the
registry (`tier`) with an append-only history and changed only through
`apps.set_tier`, which requires the identity-owned `apps.steward` role.

`db/migrations` contains immutable, globally versioned SQL history.
`db/*.test.sql` verifies the module with synthetic, rolled-back fixtures.
Cross-module TypeScript imports use only the other module's `index.ts`.

Community records, scores and problem reports also belong to this module.
Migrations 0059–0062 expose only checked functions to the existing `apps_service`
role; no new login is needed. Identity serializes consent changes with capability
calls and invokes the apps-owned record deletion interface on revocation.
Personal record keys and CAS versions are scoped to the verified person and app.
Leaderboards publish current JPEGPE public frog names through its projection,
never identity tables. Scores are app-local and grant no governance or payment
rights. Reviewer-only problem reports attach the exact published version and
are listed alongside pending versions. See the community app guide for limits.
