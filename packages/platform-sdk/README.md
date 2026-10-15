# Platform SDK

Framework-neutral shell adapter for Telegram initialization, native Back, theme
chrome, safe areas, viewport and keyboard lifecycle. `initializePlatform` returns
own-profile reading, Back visibility and disposal; it exposes no launch credentials.
The shell owns translated keyboard labels and navigation destinations.

The keyboard, page Back and swipe controllers preserve the existing tested geometry,
focus and gesture behavior. Custom overlays use `data-keyboard-viewport`; bounded
scrolling content uses `data-keyboard-scroll`. Text fields need at least 16px type.
Numeric fields get one translated Done accessory. Enter dismisses ordinary inputs;
textareas retain newlines and IME composition is ignored. Safe-area properties and
viewport geometry remain inherited and live. Dispose controllers when unmounting.

Page routes provide a stable key, parent, explicit Back callback and live blocked
predicate. Native, header and swipe Back share that callback. Active editors and
dialogs retain gesture ownership. A blocked route consumes Back without falling
through. No navigation action submits or writes data.

## Community app host v1

`rada.app.json` follows `rada.app.schema.json`; `parseAppManifest` also validates
it at runtime. Its requested trust level, design route and permissions are
declarations. A trusted registry release must separately provide the allowed
permission subset, artifact URL and SHA-256. The current shell has no release
registry or published apps yet. Its `RadaAppHost.mount` adapter is ready for a
trusted launcher to supply that release record.

The host fetches an immutable HTML artifact without credentials, checks its
size and SHA-256, and only then starts it in an opaque-origin `allow-scripts`
iframe. Child CSP blocks network and storage access; the shell's `frame-src
'none'` policy blocks external frame navigation. The `rada.member.*` bridge
accepts only requests from the current frame and session channel. Children
never receive Telegram launch data, API credentials or a Telegram user ID.
Financial, wallet signature and DAO authority requests fail closed in v1.

Personal-data permissions use a host-owned consent dialog and authenticated
`/me/consents` API. The profile shows active grants and lets the person revoke
them. The API uses the privileged one-hour authentication window for writes and
the existing self-only `identity.consents` policy. This host does not yet serve
the protected personal data; future services must check current consent again
for each read. The sandbox protocol derives from the earlier community app
host, with a new platform-only authentication boundary.
