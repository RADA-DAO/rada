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

`readOwnFrogs(client)` exposes the current person's collection through
`jpegpe.own_frogs()`. Its five-field projection adds nullable `artwork_path`
to the public frog metadata; creator/owner IDs and proofs remain private.
Artwork paths are immutable, content-addressed local PNG/WebP references under
`/media/jpegpe/`. Existing frogs have no imported artwork. Asset ingestion and
hosting are outside this change; missing or failed artwork has an accessible
fallback. This self-only metadata does not change the public identity projection.

## Usernames

Frog usernames are one platform-wide namespace: 1 to 32 characters, a letter
first, then letters, digits or `_`, unique ignoring case, and immutable.
A hold keeps a name for a frog that does not exist yet (a SPLASH auction win
before its paid claim). `jpegpe.hold_username(name, frog_id)` holds an available
name, `jpegpe.held_username(frog_id)` reads it, `jpegpe.release_username(frog_id)`
frees it again, and `jpegpe.issue_frog(...)` confirms it by issuing the frog
under that name, created by the creator and transferred to the owner, with
colours and Color Drop proofs. A frog name is permanent, so a confirmed name
never returns. `jpegpe.username_status(name)` returns `invalid`, `taken` (a frog
or an active hold) or `available`; all are granted to `splash_owner` only, and
`jpegpe.create_frog` refuses held names. Holds and their single end
(`confirmed` or `released`) are append-only. Earlier permanent reservations were
converted to holds.

## Color Drop protocol

`color-protocol/` preserves JPEGPE Color Drop v1. It derives a uniformly
selected 24-bit sRGB colour from a committed future drand Quicknet round and
separates background and accent drops with a fixed purpose byte. The frozen
technical classifier has six chromatic classes and three neutral classes;
the product mapping combines the neutral classes into one faction. Both
classifications happen after the exact colour is derived.

The public `index.ts` exports the dependency-free derivation and classification
API, plus `drawFrogColors` and `committedColorRound` (`api/color-drop.ts`): both
colours of a new frog from one committed round's quorum-verified beacon. `color-protocol/verify.ts` verifies issued proof fixtures offline,
including the Quicknet BLS signature. `mirror-quorum.ts` retains the pinned
three-relay, two-matching-verified-beacon rule used when a new proof is built.
Tests use the published synthetic fixtures and injected relay results; they do
not contact drand. Run `npm run check:jpegpe-color` for protocol, proof,
signature and quorum compatibility checks.

The offline [legacy importer](../../tools/import/README.md) uses restricted public
`import_frog` and `import_frog_state` SQL functions. Imported display names are
stored separately from permanent usernames. Imported ownership events carry an
immutable `imported` flag and unique source key; import never replays settlement
or payments. Only `legacy_import` can call these import functions.
