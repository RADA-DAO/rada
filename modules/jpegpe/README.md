# JPEGPE

Owns frogs, current ownership, authored colours and ownership events.
`index.ts` exports `readOwnPublicFrog(client, frogId)` and `PublicFrog`.
The caller must supply its existing transaction connection with verified
`rada.subject_id` context; the helper invokes `jpegpe.own_public_frog` and
returns only the public projection or null. Ownership is rechecked by SQL.

There is currently no standalone JPEGPE HTTP route. Identity's `/me` route
composes this projection through the public entry point. Selection remains an
identity-owned function; the immutable migration preserves the existing
cross-schema foreign key and ownership-transfer coordination.

`db/migrations` contains immutable, globally versioned SQL history.
`db/*.test.sql` verifies the module with synthetic, rolled-back fixtures.
Cross-module TypeScript imports use only the other module's `index.ts`.
