# Governance

Advisory voting never adopts rules, grants a mandate or moves money.
Proposal state (`created`, `opened`, `closed`, `withdrawn`), advisory tally,
steward decision and execution evidence are independent. Evidence is a steward's
record, not an independently verified payment confirmation.

## Defaults and frozen rules

Verified current members create proposals. `governance.steward` opens voting;
`who_opens` can instead be `author-opens`. No authority is seeded or implied by
membership. An identity operator grants the role separately.

Settings are append-only full versions, changed only by a steward with a public
reason. Every opening pins a settings version: 48 hours, vote changes and
withdrawals allowed, current membership required at voting, membership at open
not required, departed members' votes kept, majority override allowed with a
reason, and a seven-day decision deadline. Settings affect future openings only.
Duration accepts 1–720 hours; the decision deadline accepts 1–365 days.

Votes are `for`, `against`, `abstain`; `null` withdraws. The latest immutable
version per subject/proposal is current. Disabling changes also disables
withdrawal and a second vote. Membership is checked through identity's provider
for every vote, including changes/withdrawals; unavailable fails closed.

The optional opening snapshot checks all previously verified platform accounts
through identity's private worker interface. Accounts unknown to the platform at
opening cannot prove membership at open and are ineligible under that option.
Snapshot checks must complete within 30 seconds; larger rosters need a future
identity snapshot provider. Checks bypass identity's display cache; they are
observations, not a historical Telegram roster. No Telegram data is
persisted by governance. If a close excludes departures, unavailable membership
postpones closure rather than silently excluding anyone. Excluded vote receipts
and a public reason remain in history; default closures need no provider call.

The close scheduler runs at startup and every minute. Voting and closing lock
the same proposal row; closure has a primary key and immutable tally. Parallel
closers return true exactly once. Time checks happen after locking. Late votes
are refused even if the scheduler has not run yet.

A closed proposal awaits an explicit `accept`, `reject` or `defer` decision with
nonempty public reason. After seven days from recorded closure it shows
`decision_pending`; nothing auto-decides. With majority override disabled, accept
requires more `for` than `against`, reject requires the reverse or a tie; defer
is always available. Abstentions count in participation but not that comparison.
Each proposal has one immutable decision. Accepted decisions allow multiple
append-only evidence records (text, optional 64-hex tx hash and HTTPS link).
Withdrawal is available before opening, to author or steward, with a reason.

## HTTP contract

All routes start with `/v1/governance`. Public reads obey the platform staging
guard and live profile rules. Only JPEGPE's still-owned public frog projection
is shown; private people are `null` (anonymous), with an opaque receipt for every
vote version. No subject UUID, Telegram field or membership roster is public.

- `GET /proposals?before=<uuid>`: `{ proposals: [...] }`, descending UUID cursor,
  50 per page. `GET /proposals/:id`: `{ proposal: {...} }`, or 404.
- `GET /proposals/:id/votes?after=<vote_id>`: `{ votes: [...] }`, ascending immutable
  history, 100 per page; each has receipt, choice, current/excluded flags and profile.
- `GET /votes/mine`: `{ votes: [...] }`, caller's current votes including withdrawals.
- `GET /settings`: `{ settings: { version, rules } }`.
- `GET /settings/history`: `{ history: [...] }`, public rules, reasons and profiles.
- `POST /proposals`: `{ title, body }`, returns 201 `{ result: proposal_uuid }`.
- `POST /proposals/:id/open`: `{}`; steward or author according to settings.
- `POST /proposals/:id/withdraw`: `{ reason }`.
- `POST /proposals/:id/vote`: `{ choice: "for" | "against" | "abstain" | null }`;
  returns `{ result: { receipt, proposal_id, choice } }`.
- `POST /proposals/:id/decide`: `{ outcome: "accept" | "reject" | "defer", reason }`.
- `POST /proposals/:id/evidence`: `{ body, tx_hash?, link? }`, 201 evidence UUID.
- `POST /settings`: `{ rules: <complete settings object>, reason }`, steward only.

Other successful writes return `{ result: null }`; settings writes return their
version and rules. Writes require a signed launch within one hour; own reads use
the platform's normal authentication. Unknown fields and malformed text are
rejected. Text is plain, trimmed, paragraph breaks normalized to spaces, with
control characters rejected; no HTML is interpreted. Errors: 400 invalid input,
401 unauthorized, 403 forbidden/ineligible, 404 missing, 409 state conflict,
413 oversized body, 415 content type, 503 membership unavailable.

## Runtime and checks

`GOVERNANCE_SERVICE_DATABASE_URL` enables routes and scheduler. The login inherits
only `governance_service`, with function execution and no base-table access.
`governance_owner` is NOLOGIN. Identity owns authorization and the private
membership input; JPEGPE owns the public profile projection. Migrations 0040–0044
are forward-only. Staging needs a distinct `GOVERNANCE_PASSWORD` before merge.
Staging's unavailable membership intentionally prevents member writes.

Node tests cover validation, routing, provider failure and SQL transaction
contracts. `db/governance.test.sql` contains rolled-back synthetic database
invariants. `api/database.test.ts` has an explicitly gated disposable-local DB
concurrency test; it is never enabled by ordinary unit checks. No database or
external provider is contacted by default tests.

## Mini app screens

The platform DAO tile opens `ui/index.ts` on the shared navigation stack.
Member creation and advisory voting use signed module requests; steward controls
require the authenticated `GET /v1/governance/viewer` response
`{ viewer: { steward: boolean } }`. This reveals only the caller's role, never a
role roster. Writes independently recheck authority and membership.

Proposal lists and vote history are cursor-paginated. Open proposal detail polls
every 15 seconds while visible and no sheet is open, including after loading additional history pages. Each opening's frozen rules
control changes and withdrawals; settings show current values and public version
history. Public names come only from the API's live frog projection. No Telegram
fields or subject identifiers are rendered. Evidence links accept HTTPS only.
