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

Consent permissions include Telegram username, wallet address/balances, JPEGPE
collection and notifications. Only wallet read handlers currently serve that
protected data through this bridge. There are no child storage, generic signing,
exchange, frog-transfer or governance handlers. Unhandled requests are denied.
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
including `money.transfer`; a reviewer approves the version, not a separate
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
requests time out after 10 seconds, payment requests after five minutes. Disposal
aborts outstanding host work. These are bridge limits, not CPU/memory quotas.
