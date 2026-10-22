# SPLASH

Owns frog submissions to the pond (the image, the author's subject id, the
append-only state history and the per-author submission limit), the 24-hour
game rounds with their bids and decisions, and the paid claims and burns of
won frogs.

## Why a separate module

JPEGPE owns frogs (colour, ownership, public projections). A submission is not a
frog yet: it is an author's artwork waiting in the pond, with its own
lifecycle (`in_pond`, `archived`, `won`, `claimed`, `burned`), image storage and abuse
limits. Keeping that in SPLASH leaves JPEGPE's tables, roles and colour protocol
untouched. SPLASH reaches other modules only through published SQL functions,
all granted to `splash_owner` alone: `identity.current_subject()`,
`identity.can_steward_splash()`, `jpegpe.public_profile_frog(subject)`,
`jpegpe.username_status(name)`, `jpegpe.hold_username(name, frog_id)`,
`jpegpe.held_username(frog_id)`, `jpegpe.release_username(frog_id)`,
`jpegpe.issue_frog(...)` and `wallet.platform_payment(app_id, intent_id)`. Frog
usernames are JPEGPE's namespace, so SPLASH never stores its own copy of the
naming rule.

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
  `ends_at`, `accepting_bids`) and its frogs with `bidder_count` and
  `author` (a selected, still-owned public profile frog, otherwise `null`).
  No bid amounts or bidder profiles are public while the round is open.
  `round` is `null` before the first round opens.
- `POST /v1/splash/bids` (signed launch within one hour): JSON
  `{ "submission_id", "amount", "name" }`. `201` with the bid and
  `name_contested` (another bidder of the round proposed the same name).
  Errors: `400` (`invalid_body`, `invalid_amount`, `invalid_name`), `401`,
  `403` (`self_bid`), `404` (`not_on_auction`), `409` (`name_taken`,
  `round_closed`), `413`, `429` with `Retry-After`.
- `GET /v1/splash/bids/mine` (signed launch required): the caller's active bid per
  frog with `name_contested` and `status` (`active`, `won`, `lost`); for wins
  also `granted_name`,
  `name_outcome` and `claim_deadline`.
- `GET /v1/splash/names/:name` (signed launch required): `{ name, status }`
  where `status` is `available`, `taken` or `invalid` under JPEGPE's rule
  (`splash.name_status`). It is a hint for the bid sheet, not a hold: the name
  can still be taken before the round closes.
- `GET /v1/splash/rounds/:id/results` (public): decisions of a closed round; `404`
  for unknown or still-open rounds. Each frog has `outcome` (`won`, `archived`),
  `bidder_count` and the winning `amount` (null without a winner). Winners appear
  only as a public profile.

Claims (signed launch; starting needs one within the last hour):

- `POST /v1/splash/claims/:frogId`: JSON `{ "sender", "name" }`. `sender` is one
  of the caller's linked wallets; `name` is needed only when the win has no name.
  `200` with `status` (`ready`, or `paid` when the payment already landed) and
  `payment`, the wallet intent to open in the payment window
  (`/me/payments/:intentId/claim?appId=splash`). Errors: `400` (`invalid_body`,
  `invalid_name`, `name_required`), `401`, `403` (`not_winner`,
  `wallet_not_linked`), `404`, `409` (`already_claimed`, `burned`,
  `claim_expired`, `name_fixed`, `name_taken`, `payment_pending` with the signed
  `payment`, `conflict`), `413`, `503` (`recipient_unset`).
- `GET /v1/splash/claims/:frogId`: the caller's claim after checking its latest
  payment on chain; completes it when paid. `state` is `open`, `expired`,
  `claimed` (with `frog`), `burned` or `needs_manual_review`.
- `GET /v1/splash/claims/reviews` (`splash.steward` only): unsettled review holds
  as `{ claims: [{ submission_id, state: "needs_manual_review" }] }`.
- `GET /v1/splash/claims/mine`: the caller's wins with their claim state.
- `PUT /v1/splash/settings/recipient` (`splash.steward` only): JSON
  `{ "address" }`, a mainnet basechain address that receives claim payments.
  `403` for everyone else.

The routes exist only when `SPLASH_SERVICE_DATABASE_URL` names a login that holds
`splash_service`; claim routes also need `WALLET_SERVICE_DATABASE_URL`.

## Screens

SPLASH is an official app whose screens are built into the shell, not a
sandboxed artifact: it needs its own module API, the viewer's wallet and the
platform payment window, which community artifacts cannot reach. The screens
live in `ui/` (module = screens + API + tables + tests) and are reached only
through `ui/index.ts`. They use `@rada/ui` components, `@rada/i18n` keys and a
platform client limited to `/v1/splash/*` (`platform.moduleApi("splash")`), so
launch credentials stay in the SDK. Screens never import `api/` code.

- Pond: this round's frogs with images, bidder counts, time left in the
  UTC day and the viewer's own bid; the bid sheet takes an amount in JPEGPE and
  a permanent name with a live check (`GET /v1/splash/names/:name`), and says
  that a bid is a promise paid at claim and that unpaid wins burn.
- Submit: picks an image, converts it on the device to a PNG of at most
  1024 px and 2 MiB, previews it, uploads it and shows the stored result.
- My SPLASH: bids, wins with the claim countdown, and the claim through the
  platform payment window (`platform.payIntent`). A payment the chain has not
  confirmed is shown as unconfirmed, never as paid.
- Past rounds: results of closed rounds, newest first.

## Rounds and bids

- A round is one UTC day (00:00 to 24:00). Its frogs are those in the pond, with
  an image, submitted before the round started; frogs submitted later wait for
  the next round. At most one round is unclosed at a time.
- A bid is a positive whole number of JPEGPE, minimum 1 token, stored and sent
  in smallest units (9 decimals). New bids must be multiples of one token and at
  most `2^120 - 1` smallest units. Existing staging rows remain settleable.
  The proposed permanent name must be valid and available under JPEGPE's rule
  (1 to 32 characters, a letter first, then letters, digits or `_`, unique
  ignoring case). Authors cannot bid on their own frogs; any verified person can bid.
- Each bidder has one active bid per frog. Replacements may increase, decrease
  or repeat the amount and name; every version is retained. Name choice time is
  preserved while the name is unchanged ignoring case.
- Bids are secret: the public pond exposes only bidder counts. The viewer sees
  their own amount, name and whether another bidder in this round proposed the
  same name. Losing amounts are never public, including after closing.
- Closing groups active bids per frog by amount. The smallest amount offered by
  exactly one bidder wins. If none is unique, including when there are no bids,
  the frog becomes `archived` (unsold), leaves the pond and never carries over.
  Its image and result remain public.
- Winners requesting the same name have priority by distinct bidder count on
  their frog (descending), winning amount (ascending), name choice time, then
  frog id. JPEGPE holds the name until paid claim (`name_outcome = reserved`).
  A winner who loses a name still wins the frog and chooses a name at claim:
  `conflict` means another winner of this round held it; otherwise `unavailable`.
- A winner pays exactly their winning amount at claim. The frog becomes `won`
  and `claim_deadline` is round end + 24 hours; unpaid wins burn under the safety
  checks below. `readPendingClaim` exposes the winner, amount, name and deadline.
- Past rounds contain only this module's rounds, with each frog, winner's public
  profile (or anonymous), winning amount and bidder count. No legacy history is imported.
- `splash.advance_rounds()` closes every due round and opens the current one. It
  holds an advisory lock, each close locks the round row (bids in flight hold a
  share lock on it and check for a closure after acquiring it) and the closure
  table's primary key rejects a second close, so double or concurrent runs never
  double-close. Each decision is written once to `splash.lot_results`. The API
  runs it at startup and every minute (`startRoundScheduler`); only the service
  login can call it.

## Claims and burns

- Only the winner claims, by paying exactly the winning bid in JPEGPE through a
  wallet platform intent: app `splash`, purpose `splash:<frog id>`, recipient the
  address the `splash.steward` set last (kept in `splash.recipient_settings`;
  never in code). No prizes, no SPARK; the recipient is the only destination.
- Each start reuses the open unsigned intent when the wallet and recipient are
  unchanged, otherwise cancels it first. A signed intent blocks a new one until
  it is resolved, so at most one attempt can be paid. Every attempt is kept with
  its terms (`splash.claim_attempts`).
- Deadline: the end of the next round (`claim_deadline`). Starting closes 5
  minutes before it and the wallet stops signing 2 minutes before it.
- A payment counts when the wallet verified it final on chain (`paid`) and its
  recipient transaction time is strictly before the deadline, with the exact
  winner, token, amount, recipient, sender and purpose. When it is processed does
  not matter: a payment confirmed at 23:59:59 completes even if seen at 00:20.
- Completion (`splash.complete_claim`) runs once under a per-frog lock and the
  outcome primary key: JPEGPE issues the frog under the held name (now
  permanent), created by the author and transferred to the winner, with Color
  Drop background and accent colours. Their committed round is the first
  Quicknet round after the payment's on-chain time, the request id is the intent
  id, and the proofs are stored with the frog.
- Burn (`splash.burn_claim`): no earlier than 30 minutes after the deadline (time
  for late chain confirmation), never while a payment confirmed before the
  deadline exists. The frog's state becomes `burned`, the held name is released,
  history stays. Before burning, the service re-checks every signed attempt on
  chain under the per-frog lock; each unresolved attempt needs a complete
  negative scan. Missing index coverage or an incomplete read defers the burn.
  Timer batches select frog ids first and include every attempt of those frogs.
- Wallet negative evidence additionally requires the configurable index safety
  margin (ten minutes by default beyond the grace). A missing or disagreeing
  watermark never authorizes a burn.
- After 24 hours beyond the grace, settlement puts an unresolved frog into
  `needs_manual_review` instead of burning, even if negative evidence becomes
  available then. Configure `SPLASH_CLAIM_MAX_DEFERRAL_SECONDS` in API deployments
  or the `ClaimService` constructor's `maxDeferralMs`. Migration 0045 adds an
  append-only review hold and a steward-only queue; a hold prevents all automatic
  burns in SQL, retains the held name, and is excluded from timer batches so it
  cannot starve newer claims. Winner claim reads expose the review state.
  A subsequently verified payment before the deadline can still complete through
  the winner's status read. Review holds grant no manual burn or payment override.
- The round timer (`startRoundScheduler`) runs claim settlement right after the
  round job every minute; double or concurrent runs settle each frog once.
- Claimed and burned frogs keep a public image, so round results stay complete.

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

- Processing admission allows 10 attempts per verified subject per 24-hour window,
  including invalid images and duplicates, before reading the image. At most 4
  uploads are in flight per API process; a shared 200-attempt/minute budget also
  bounds admission. The accepted-submission quota remains separate.
- Bid attempts allow 20 per subject and lot per minute and 200 globally per minute,
  including refused attempts. SQL admission counters expire after their window;
  exhausted budgets return `429` with `Retry-After`. Accepted history stays immutable.
- At most 5 submissions per author in any rolling 24 hours, enforced in
  `splash.submit_frog` under a per-author advisory lock, so concurrent requests
  cannot exceed it.
- Only a subject id identifies the author. `author_of(submission)` /
  `readSubmissionAuthor` give bidding the author id so it can refuse a bid by the
  author; the check itself belongs to the bidding change.
- History is append-only: triggers reject `UPDATE` and `DELETE` on submissions,
  images and events, even for the owner. The state is the latest event.
- History is append-only for rounds, lots, bids, closures and results too, and
  for recipient settings, claim attempts and claim outcomes.
- `splash_service` has no table privileges and can execute only the published
  functions listed in the migrations.

The strip-safe public `png.ts` entry exposes the bounded PNG codec for offline
imports and is re-exported by `index.ts`. Its decoder caps RGBA allocation at
256 MiB before inflation; the submission API keeps its existing upload limits.
