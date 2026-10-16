# SPLASH

Owns frog submissions to the pond: the image, the author's subject id, the
append-only state history and the per-author submission limit. Rounds, bids and
claims are later changes and will extend this module.

## Why a separate module

JPEGPE owns frogs (colour, ownership, public projections). A submission is not a
frog yet: it is an author's artwork waiting in the auction pond, with its own
lifecycle (`in_pond`, later won, claimed, burned), image storage and abuse
limits. Keeping that in SPLASH leaves JPEGPE's tables, roles and colour protocol
untouched. SPLASH reaches other modules only through published SQL functions:
`identity.current_subject()` and `jpegpe.public_profile_frog(subject)`. The
latter (with `identity.selected_frog_of(subject)`) is added by this change and is
granted to `splash_owner` alone.

## API

- `POST /v1/splash/submissions` (signed launch required): body is a PNG, at most
  2 MiB, 64 to 1024 px per side, 8-bit RGB or RGBA, non-interlaced. Responses:
  `201` with the submission, `400` (`bad_dimensions`, `invalid_image`), `401`,
  `409` (`duplicate_image`), `413`, `415` (`unsupported_type`), `429` with
  `Retry-After`.
- `GET /v1/splash/pond` (public): newest first, at most 100. An `author` object
  (frog id, username, colours) appears only when the author has a public profile,
  i.e. has selected a frog they still own; otherwise it is `null`. Subject ids
  are never returned.
- `GET /v1/splash/submissions/mine` (signed launch required): the caller's
  submissions with their state.
- `GET /v1/splash/submissions/:id/image` (public for frogs in the pond): the
  stored PNG, immutable and cacheable.

The routes exist only when `SPLASH_SERVICE_DATABASE_URL` names a login that holds
`splash_service`.

## Background removal

The old client (`background-removal.worker.ts`) flooded a solid background from
the image border on a canvas. Browsers have a canvas and the server does not, and
no dependency may be added, so the same algorithm and thresholds are ported to
pure TypeScript (`api/cutout.ts`) over a minimal PNG codec (`api/png.ts`, built on
`node:zlib`) and run on the server. The client only has to send a PNG (convert
JPEG or WebP and scale down in the platform SDK before upload). Doing it on the
server means the stored result never depends on a client's claim.

The corners must all be transparent or within a small distance of their average
colour. If they are not, the background is not solid and the image is stored
unchanged (`background_removed: false`). Otherwise border-connected background
pixels become transparent with a soft edge and the frog is recentred on a square
canvas. Every upload is decoded and re-encoded, which drops metadata chunks.

## Storage

Image bytes are stored in `splash.submission_images` (`bytea`, at most 4 MiB,
PNG only, unique `sha256` so an identical image cannot be submitted twice). The
TypeScript `ImageStorage` interface (`api/storage.ts`) and the single reader
`splash.submission_image()` isolate this: moving to object storage replaces the
implementation and that table, not the routes or the submission flow.

## Rules and data

- At most 5 submissions per author in any rolling 24 hours, enforced in
  `splash.submit_frog` under a per-author advisory lock, so concurrent requests
  cannot exceed it.
- Only a subject id identifies the author. `author_of(submission)` /
  `readSubmissionAuthor` give bidding the author id so it can refuse a bid by the
  author; the check itself belongs to the bidding change.
- History is append-only: triggers reject `UPDATE` and `DELETE` on submissions,
  images and events, even for the owner. The state is the latest event.
- `splash_service` has no table privileges and can execute only the published
  functions listed in the migration.
