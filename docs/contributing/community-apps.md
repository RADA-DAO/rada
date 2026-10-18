# Build a community app

Community apps are immutable HTML artifacts loaded by the
[SDK host](../../packages/platform-sdk/src/app-host.ts). The builder directory is
currently a [placeholder](../../apps/builder/README.md); there is no repository
build/upload command for third-party artifacts. Bundle scripts, styles and data
images into one HTML file; the child cannot fetch remote assets or APIs.

## Manifest

Write `rada.app.json` using the [schema](../../packages/platform-sdk/rada.app.schema.json)
and [runtime parser](../../packages/platform-sdk/src/app-manifest.ts):

```json
{
  "name": "Example app",
  "author": "Example community",
  "designRoute": "standard",
  "permissions": ["identity.self.read", "navigation"],
  "minPlatformVersion": "1.0.0",
  "icon": "icon.png"
}
```

| Field                | Contract                                                                                                                         |
| -------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| `name`, `author`     | Required, 1–64 characters, trimmed, no control characters or `<`/`>`                                                             |
| `designRoute`        | Required: `standard` or `free-style`; a declaration, not an exemption from sandbox policy                                        |
| `permissions`        | Required unique array from `APP_PERMISSIONS`; declarations do not grant capabilities                                             |
| `minPlatformVersion` | Required numeric `major.minor.patch` without leading zeros; parser rejects versions newer than platform `1.0.0`                  |
| `icon`               | Optional relative lowercase PNG/WebP/SVG path, at most three segments, following `APP_ICON_PATH`; square artwork, at most 64 KiB |

Unknown fields are rejected. Omit retired `trustLevel`: only legacy `community`
is accepted on input and is discarded. `official` cannot be author-declared.
The app ID is separate from the manifest: a lowercase letter followed by up to
127 lowercase letters, digits or `_.:-`.

The launcher loads icons from `/artifacts/<html-sha256>/<icon>` on the artifact
origin. The path is reviewed with the manifest; the HTML SHA-256 checks HTML
bytes, not a separate icon digest. See the
[icon loader](../../apps/miniapp/src/app-icon.ts) for byte/type validation and
[launcher](../../apps/miniapp/src/home.ts) for fallback. Square dimensions are an
artwork requirement, not checked by the current loader.

## Capabilities and bridge

The complete permission vocabulary is `APP_PERMISSIONS` in the linked parser;
an accepted permission name does not guarantee a working bridge method.
The [host dispatcher](../../packages/platform-sdk/src/app-host.ts) implements:

| Request                                                               | Requirement / result                                                          |
| --------------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| `rada.member.context.get`                                             | Locale only                                                                   |
| `rada.member.identity.self`                                           | `identity.self.read`; platform subject UUID or null, never Telegram identity  |
| `rada.member.navigation.back`                                         | `navigation`; returns to the platform stack                                   |
| `rada.member.permission.request`                                      | A published consent permission; host-owned prompt                             |
| `rada.member.wallet.address.read`, `rada.member.wallet.balances.read` | Matching published permission, current app consent and server verification    |
| `rada.member.payment.request`, `rada.member.payment.status`           | Published `money.transfer`, host-owned confirmation and server reconciliation |

Inside the child, use the injected bridge:

```js
const { locale } = await window.rada.member.request("rada.member.context.get");
window.rada.member.back();
```

Consent permissions include personal app records, app scores, Telegram username,
wallet address/balances, JPEGPE collection and notifications. Implemented handlers
serve wallet reads, records and scores; the permission vocabulary alone does not
implement other protected reads. Generic signing, exchange, frog-transfer and
governance handlers remain unavailable. See the game capability contract below.
Payment results follow [SDK payment semantics](../../packages/platform-sdk/README.md):
retain the purchase idempotency key, reconcile `unknown`, and treat only server
`paid` as payment proof.

## Submission and review

1. Stage the HTML at the configured artifact origin's
   `/artifacts/<sha256>.html`, and any icon at its hash-scoped path. The API
   derives this URL; it does not build, upload or fetch the artifact on submission.
2. Send `POST /apps/:appId/versions` with `{ "manifest": {...}, "sha256": "..." }`.
   This needs a verified launch within one hour. The author owns that app ID;
   submission atomically records a draft and queues the immutable version.
3. An `apps.reviewer` uses the protected review queue and supplies a reason
   (1–500 characters) to approve or reject. Preview receives no granted
   permissions. Approval and publication are separate transitions.
4. A reviewer publishes the approved version. The registry exposes only its
   live approved release; rollback selects a previously approved version and
   withdrawal removes the live release. Review history is append-only.

See the [HTTP routes](../../modules/apps/api/router.ts),
[registry functions](../../modules/apps/db/migrations/0002_apps.sql) and
[current published projection](../../modules/apps/db/migrations/0013_apps_official_tier.sql).
Published grants are requested permissions filtered through the SQL allowlist,
including `money.transfer` and `scores`; a reviewer approves the version, not a separate
per-permission grant form. Other financial/DAO capabilities remain excluded.
Personal-data consent never grants platform roles. Only `apps.steward` can change
the registry tier, independently of review or the sandbox.

## Sandbox limits

The host checks artifact origin, fetches without credentials or redirects, caps
HTML at 1 MiB and verifies SHA-256 before decoding UTF-8. Fetch timeout is 10
seconds. It mounts `srcdoc` in an opaque-origin `sandbox="allow-scripts"` iframe.
Child CSP permits inline scripts/styles and data/blob images; it blocks network
connections, forms, nested frames, objects and remote assets. No same-origin
storage, Telegram launch data or API credentials are provided.

Bridge messages must match the current frame, null origin, session channel and
protocol version. Request IDs are 1–64 alphanumeric/underscore/hyphen characters;
the host allows four pending requests and 30 requests per minute. Ordinary
requests time out after 10 seconds; payment, consent and report sheets after five minutes. Disposal
aborts outstanding host work. These are bridge limits, not CPU/memory quotas.

## Personal records, leaderboards and problem reports

Declare `storage.self` for private records and `scores` for leaderboards. Both
need reviewer approval and live app-scoped consent. Ask with
`rada.member.permission.request` and `{ permission: "storage.self" }` (or
`"scores"`); the platform owns the consent sheet. Revocation in Profile deletes
that person's records for the app, including when another app grant is revoked.
Re-consent starts with empty records. Authors cannot export other people's data.

A score manifest also declares 1–10 boards, for example:

```json
{
  "permissions": ["storage.self", "scores"],
  "boards": { "points": { "min": 0, "max": 100000 } }
}
```

This is a fragment of the full manifest above. Board IDs start with a lower-case
letter and contain up to 32 letters, digits, underscores or hyphens. Bounds are
integers from -1,000,000,000 to 1,000,000,000; `min` must not exceed `max`.
Reviewers see the bounds and approve the immutable manifest, including `scores`.

Call `window.rada.member.request(type, payload)` inside the sandbox:

| Type suffix after `rada.member.` | Payload                   | Result                              |
| -------------------------------- | ------------------------- | ----------------------------------- |
| `records.get`                    | `{ key }`                 | `{ key, value, version }` or `null` |
| `records.list`                   | `{}`                      | Own records ordered by key          |
| `records.put`                    | `{ key, value, version }` | Saved record with a new version     |
| `records.delete`                 | `{ key, version }`        | `{ deleted }`                       |
| `scores.submit`                  | `{ board, score }`        | Board, rows, total and myRank       |
| `scores.list`                    | `{ board, limit? }`       | Board, rows, total and myRank       |
| `scores.rank`                    | `{ board }`               | Board, total, myRank and empty rows |
| `report`                         | `{}`                      | `{ submitted }`                     |

Records allow 100 keys per app/person, each 1–64 ASCII letters, digits, dots,
underscores, colons or hyphens. Each JSON value is limited to 16 KiB in PostgreSQL's
canonical JSON representation (at most 1.6 MiB across 100 records). A new key uses
`version: 0`; subsequent writes and deletes must use the last returned version.
`version_conflict` means reload and resolve the conflict. Versions never repeat
when a key is deleted and recreated. `limit_exceeded` covers count/size limits.
All operations derive the person from verified platform authentication.

Scores keep each person's highest integer result per app/board. Submission is
limited to ten per minute per person/app across boards. The server checks the
current reviewed board bounds; earlier results outside updated bounds are
excluded. Top-N defaults to 10 and caps at 100; equal scores share a rank.
Rows contain only `{ rank, score, name }`: `name: null` means Anonymous, including
for private profiles. They still count in `total` and ranking. `myRank` is
`{ rank, score }` or `null`. Frog names resolve from current public profiles;
no Telegram IDs, subject IDs or wallets appear. Scores are self-reported within
server bounds, not proof of fair play. They grant no DAO authority or money.

`report` needs no manifest permission or stored consent. It opens a platform
sheet for a category and up to 1,000 characters. Child-supplied contents are
ignored. The host attaches its app ID, immutable version ID and artifact hash;
only published versions can receive reports, including after withdrawal.
The app receives only the submission outcome, never the text or reporter ID.
Three submissions per person/hour are allowed across apps. Reviewers see reports
in App review through `/apps/review-queue/reports`; authors have no special access.
Closing the sheet cancels. Report and consent sheets time out after five minutes.

These operations use the existing `apps_service` login and migrations 0059–0062;
no new environment variables or staging credentials are required. The bridge
returns `capability_denied` after withdrawal, permission removal or revocation,
`invalid_request` for invalid scores, and `rate_limited` when a budget is exhausted.
