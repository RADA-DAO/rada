# Shared UI and SDK verification

This package aligns the platform's shared primitives with the current RADA OS
design. It is a local UI/SDK integration, not a production rollout or a change
to identity, money, collectible ownership or app publication rules.

## Reference and boundaries

The production source reference for this pass is
`064c32e23c5069d64777e7491a628c13c8d8d77c`, recorded separately from moving main.
The profile is the composition reference. Shared controls use native system
typography, readable 17px fields, 44px minimum touch targets, 46px ordinary
controls and the existing offset corner vocabulary. The semantic theme keeps
authored background/accent HEX values exact and derives readable UI roles.
No decorative continuous motion or new palette belongs to a module.

Canonical frog card geometry, artwork, type treatments and renderer remain
owned by the existing card implementation. They are not recreated inside a
community app or replaced with a second renderer. Profile materials and private
appearance documents are not community-app context.

## Opaque app context

The trusted host supplies locale and a versioned UI projection: a bounded set of
semantic tokens, the iframe's usable viewport, residual safe-area insets and the
reduced-motion preference. Shell-consumed Telegram header clearance is not added
again inside the frame. Updates patch styles and geometry without replacing
focused fields, selection, draft text or an open dialog.

The app cannot read its parent, raw Telegram launch data, wallet data or private
appearance settings. Declaring a design route is not an exemption from sandbox
or capability checks. Context updates retain source-window, session-channel and
bridge-version validation. Disposal ends subscriptions and navigation layers.

The example uses the shared keyboard controller in its own document. A parent
controller cannot control an opaque child document. Modal opening coordinates
one bounded app-owned Back layer with the trusted navigation stack. Native Back
closes the dialog first, restores focus and preserves the draft; the next Back
leaves the app. Escape and explicit close retain the same semantics.

## Device matrix

Run through the disposable local platform:

```sh
npm run test:ui-sdk
```

The suite runs serially with one worker and uses real local registry records,
immutable HTTPS artifacts, launcher and SDK host. It does not mock app releases
or capability responses. The local-only Telegram stand-in emits viewport,
safe-area and Back events; it is excluded from production builds.

| Browser  | Viewport   | Purpose             |
| -------- | ---------- | ------------------- |
| Chromium | 320 × 740  | Narrow phone        |
| WebKit   | 390 × 844  | Phone engine/layout |
| Chromium | 430 × 932  | Wide phone          |
| WebKit   | 768 × 1024 | Portrait tablet     |
| Chromium | 1024 × 768 | Landscape tablet    |
| Chromium | 1280 × 900 | Desktop             |
| WebKit   | 1440 × 900 | Wide desktop        |

Each project checks live dark/light/default/neutral/close-hue/extreme themes,
readability geometry and overflow, live 125% text scaling with draft/caret
retention, safe-area propagation, reduced motion,
overlay and resized keyboard layouts, persisted pagehide/pageshow restoration,
Enter/IME, numeric Done, focused draft and
caret retention, modal-first native Back/Escape, edge Back and repeated reopen
without growing host subscriptions. Screenshots and failure traces stay under
`test-results/ui-sdk`.

These checks emulate browser engines and host events. They do not establish
native Telegram iPhone/Android keyboard, predictive text, fullscreen controls or
physical swipe feel. Record that physical acceptance separately before a
production release; do not label browser emulation as real-device verification.

## Build cost

The baseline package measured 49,267 bytes initial gzip JS and 42,349 bytes
Brotli. Initial UI validation at `b827a9e` measured 49,749 / 42,760 bytes, including stable shell
chrome, shared viewport handling and the conditional readable-surface guard.
The two initial JS ceilings become 50,000 / 43,000 bytes; other budgets stay
unchanged. `npm run check:bundle` reports the exact current head. Embedded UI-context and dialog support remain in the lazy community
app chunk. Removing unused Outfit declarations reduces emitted font bytes;
canonical card fonts and archived font sources/licenses are preserved.
