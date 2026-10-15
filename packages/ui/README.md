# UI

Shared design system for platform shells and applications. Import `src/design-system.css` for first paint, then call `compileTheme` and `applyTheme` with the viewer's profile colors. Authored background and accent HEX values remain exact; semantic text and controls meet WCAG AA contrast.

The package exports framework-neutral DOM primitives (`Button`, `Card`, `Sheet`, `EmptyState`, and `ErrorState`). Callers provide visible labels and messages, usually from `@rada/i18n`. The components use native elements and honor reduced-motion preferences in the shared stylesheet.
