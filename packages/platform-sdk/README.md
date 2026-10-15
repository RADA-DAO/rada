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
