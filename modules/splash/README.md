# SPLASH

Owns frog submissions to the pond (the image, the author's subject id, the
append-only state history and the per-author submission limit) and the 24-hour
auction rounds with their bids and decisions. Claims and payment are a later
change and will extend this module.

## Why a separate module

JPEGPE owns frogs (colour, ownership, public projections). A submission is not a
frog yet: it is an author's artwork waiting in the auction pond, with its own
lifecycle (`in_pond`, later won, claimed, burned), image storage and abuse
limits. Keeping that in SPLASH leaves JPEGPE's tables, roles and colour protocol
untouched. SPLASH reaches other modules only through published SQL functions:
`identity.current_subject()`, `jpegpe.public_profile_frog(subject)`,
`jpegpe.username_status(name)` and `jpegpe.reserve_username(name, frog_id)`, all
granted to `splash_owner` alone. Frog usernames are JPEGPE's namespace, so SPLASH
never stores its own copy of the naming rule.

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

Rounds (amounts are smallest JPEGPE units as decimal strings; no funds are locked,
a bid is a promise paid at claim):

- `GET /v1/splash/round` (public): the current round (`round_id`, `starts_at`,
  `ends_at`, `accepting_bids`) and its frogs with `top_amount`, `bidder_count`,
  `author` and `leader`. Author and leader appear only as a public profile
  (a selected, still-owned frog), otherwise `null`. `round` is `null` before the
  first round opens.
- `POST /v1/splash/bids` (signed launch within one hour): JSON
  `{ "submission_id", "amount", "name" }`. `201` with the bid and
  `name_contested` (another frog of the round has a bid proposing the same
  name). Errors: `400` (`invalid_body`, `invalid_amount`, `invalid_name`), `401`,
  `403` (`self_bid`), `404` (`not_on_auction`), `409` (`name_taken`,
  `bid_too_low`, `bid_unchanged`, `round_closed`), `413`.
- `GET /v1/splash/bids/mine` (signed launch required): the caller's active bid per
  frog with `status` (`active`, `won`, `lost`); for wins also `granted_name`,
  `name_outcome` and `claim_deadline`.
- `GET /v1/splash/rounds/:id/results` (public): decisions of a closed round; `404`
  for unknown or still-open rounds. Winners appear only as a public profile.

The routes exist only when `SPLASH_SERVICE_DATABASE_URL` names a login that holds
`splash_service`.

## Rounds and bids

- A round is one UTC day (00:00 to 24:00). Its frogs are those in the pond, with
  an image, submitted before the round started; frogs submitted later wait for
  the next round. At most one round is unclosed at a time.
- A bid is a positive integer amount and a proposed permanent name. The name must
  be valid and free under JPEGPE's rule (1 to 32 characters, a letter first, then
  letters, digits or `_`; unique ignoring case, including reserved names). The
  author cannot bid on their own frog. Any verified person may bid; owning a frog
  is not required.
- One active bid per bidder per frog: a new bid replaces it and every version is
  kept. A replacement cannot lower the amount; the same amount is accepted only
  with a different name. The amount time (for ties) is kept while the amount is
  unchanged; the name choice time is kept while the name is unchanged (ignoring
  case).
- Closing: per frog the highest amount wins; on a tie the bidder who reached that
  amount first wins. Winners then claim names in order of amount (higher first),
  then earlier name choice, then earlier bid. Each name is reserved permanently in
  JPEGPE for the frog id (`jpegpe.username_reservations`). A winner whose name is
  already taken still wins the frog, without a name: `name_outcome` is `conflict`
  when another winner of the same round took it and `unavailable` otherwise; the
  name is then chosen at claim. This follows the old SPLASH settlement, where a
  losing username left the frog "needs choice".
- A win is a pending claim until the end of the next round (`claim_deadline` =
  round end + 24 hours). The frog leaves the pond (state `won`) and its image stays
  public. `readPendingClaim` gives the claim change the winner, amount, name and
  deadline. Frogs without bids stay in the pond for the next round.
- `splash.advance_rounds()` closes every due round and opens the current one. It
  holds an advisory lock, each close locks the round row (bids in flight hold a
  share lock on it and check for a closure after acquiring it) and the closure
  table's primary key rejects a second close, so double or concurrent runs never
  double-close. Each decision is written once to `splash.lot_results`. The API
  runs it at startup and every minute (`startRoundScheduler`); only the service
  login can call it.

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
- History is append-only for rounds, lots, bids, closures and results too.
- `splash_service` has no table privileges and can execute only the published
  functions listed in the migrations.
