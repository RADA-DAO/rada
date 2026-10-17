# JPEGPE

Owns frogs, current ownership, authored colours and ownership events.
`index.ts` exports `readOwnPublicFrog(client, frogId)` and `PublicFrog`.
The caller must supply its existing transaction connection with verified
`rada.subject_id` context; the helper invokes `jpegpe.own_public_frog` and
returns only the public projection or null. Ownership is rechecked by SQL.

Identity's `/me` route composes this projection through the public entry point.
JPEGPE also exposes guarded artwork reads through its runtime router. Selection remains an
identity-owned function; the immutable migration preserves the existing
cross-schema foreign key and ownership-transfer coordination.

`db/migrations` contains immutable, globally versioned SQL history.
`db/*.test.sql` verifies the module with synthetic, rolled-back fixtures.
Cross-module TypeScript imports use public entries only. The strip-safe
`storage.ts` entry exposes the import storage contract and is re-exported by
`index.ts`.

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

Migration 0046 records imported colour provenance through those public functions.
`colour_source = legacy_unverified` preserves authored colours without linked
proofs; `proof` marks colours with linked evidence. Import never fabricates a proof.

## Imported artwork storage

Migration 0048 adds immutable `jpegpe.artwork` bytea storage. The public
`PostgresImageStorage` / `ImageStorage` interface saves and loads artwork inside
the caller's transaction through import-only functions granted to `legacy_import`.
It can later be replaced with an object-store adapter. Runtime roles cannot call
these import functions; migration 0049 adds visibility-checked runtime reads.
PNG artwork is normalized; JPEG originals explicitly carry `needsNormalization`
and await a decoder. This import does not mutate `artwork_path`. See the offline importer's rehearsal
instructions for file validation, mappings and checksums.

## Runtime artwork reads

Migration 0049 exposes `visible_artwork(uuid[])` (metadata only) and
`read_artwork(uuid)` to `identity_service` and `jpegpe_service`. Both recheck
visibility: the selected, still-owned public profile frog (also the projection
used by rankings and SPLASH authors), or a frog with a public SPLASH submission
image. Issued SPLASH frogs without imported artwork use the existing public submission
image through SPLASH's reader. Other collection frogs remain owner-only. No runtime table or import
function access is granted. The API uses the identity service connection and
sets transaction-local subject context only from verified authentication.

`GET` and `HEAD /v1/frogs/:frogId/artwork/:sha256` serve stored PNG or validated
legacy JPEG bytes, with SHA-256 ETags, `nosniff`, a restrictive CSP and
`Cross-Origin-Resource-Policy: cross-origin` for separately hosted shells.
The alias without a hash returns the same bytes and a hashed `Content-Location`.
Only public hashed URLs in production receive one-year immutable caching;
private, unhashed and staging responses use `no-store`. Public immutable copies
may remain cached after a later profile change; access to the origin is always
rechecked. Legacy JPEG validation checks type, dimensions and the complete
marker/scan envelope; it does not decode or normalize pixels.

Reads are capped at 4 MiB, four concurrent requests and 200 attempts per minute
per API process (including misses). Conditional requests check access before
returning 304. Missing, inaccessible, malformed or mismatched artwork returns 404.
Existing profile, collection, SPLASH and ranking HTTP projections gain nullable
`artwork_url` (`artworkUrl` for camel-case ranking projections), relative to the
API origin. Enrichment batches metadata reads and preserves the existing frog
selection and private fields; the legacy `artwork_path` field is unchanged.
