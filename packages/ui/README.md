# UI

Shared design system for platform shells and applications. Import `@rada/ui/design-system.css` for first paint, then call `compileTheme` and `applyTheme` with the viewer's profile colors. Authored background and accent HEX values remain exact; semantic text and controls meet WCAG AA contrast.

The package exports framework-neutral DOM primitives (`Button`, `Card`, `Sheet`, `EmptyState`, and `ErrorState`). Callers provide visible labels and messages, usually from `@rada/i18n`. The components use native elements and honor reduced-motion preferences in the shared stylesheet.

`FrogCard` adapts the canonical JPEGPE card renderer with the shared 4:5 cutout
geometry and uppercase `frogCardName`. Authored colours use the shared theme
compiler. Artwork is optional and restricted to content-addressed local PNG/WebP
paths; callers supply translated missing-art copy. No legacy token HUD is rendered.

Use `@rada/ui/design-system.css` as the only stylesheet entry in applications.
Its internal stylesheets provide the shared foundations, controls, collectible
card and existing shell recipes. The mini app resolves this public entry through
Vite and TypeScript aliases. Applications must not import internal CSS files.

`tokens.css` is the single source of foundation values.
`RADA_DESIGN_TOKEN_NAMES` exports their names, with `DesignTokenName` and
`DesignTokens` types. `ThemeTokenName` describes the 47
compiler-owned semantic color roles; `RadaTokenName` covers both groups.
Foundations include Onest body and Outfit heading stacks, the spacing and type
scales, offset panel/control/small radii, semantic shadows, motion durations and
curves, and ordered layers. Fonts use local/system fallbacks; this package does
not fetch font files. Reduced motion is honored by the shared recipes.

The guest palette matches `compileTheme(DEFAULT_THEME_BACKGROUND)` at first paint.
Colors remain compiler-owned. Collectible geometry and material tokens resolve
on each card so its own authored colors remain independent of the viewer's theme.
Existing shell typography and dimensions are named migration tokens, preserving
the current composition until the shared component migration. Add future styles
to this library and consume its tokens instead of adding screen stylesheets.

Run `node --test packages/ui/scripts/test-design-tokens.ts` to verify the typed
foundation/CSS contract, canonical anchors, token references and reduced motion.
Run `node packages/ui/scripts/test-theme-compiler.ts` for guest first-paint parity,
exact authored colors and AA contrast across sampled themes, and
`node packages/ui/scripts/test-ui-behavior.ts` for existing DOM behavior.
