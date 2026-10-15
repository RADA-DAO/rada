# UI

Shared design system for platform shells and applications. Import `src/design-system.css` for first paint, then call `compileTheme` and `applyTheme` with the viewer's profile colors. Authored background and accent HEX values remain exact; semantic text and controls meet WCAG AA contrast.

The package exports framework-neutral DOM primitives (`Button`, `Card`, `Sheet`, `EmptyState`, and `ErrorState`). Callers provide visible labels and messages, usually from `@rada/i18n`. The components use native elements and honor reduced-motion preferences in the shared stylesheet.

`FrogCard` adapts the canonical JPEGPE card renderer with the shared 4:5 cutout
geometry and uppercase `frogCardName`. Authored colours use the shared theme
compiler. Artwork is optional and restricted to content-addressed local PNG/WebP
paths; callers supply translated missing-art copy. No legacy token HUD is rendered.
