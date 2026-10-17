# UI

Shared design system for platform shells and applications. Import `@rada/ui/design-system.css` for first paint, then call `compileTheme` and `applyTheme` with the viewer's profile colors. Authored background and accent HEX values remain exact; semantic text and controls meet WCAG AA contrast.

The package exports framework-neutral DOM components. Callers provide visible
labels and messages, usually from `@rada/i18n`; every visual value comes from
tokens, controls show focus rings, and motion honors reduced-motion preferences.

- `ScreenHost` and `Screen`: the scrolling surface and one screen (header,
  title, content, footer). Screens never draw Back: the platform owns it
  (Telegram BackButton, browser Back, Escape, swipe).
- `Button` (`primary`, `secondary`, `ghost`; `loading` and `disabled`),
  `setButtonLoading`, `Field` (input, textarea or select with label and error),
  `Tabs`, `List` and `ListItem`, `Card`, `Section`, `Text`, `Actions`, `Group`,
  `LiveRegion`, `Embed`, `Avatar`.
- `Sheet` and `openSheet`: modal bottom sheet. `openSheet` registers one shared
  entry in the platform navigation stack, so Back, swipe and Escape close it
  and focus returns to the opener.
- `EmptyState`, `ErrorState` (with retry) and `Loading`.
- `Picture` (artwork with alt text and a missing-image fallback; `thumb` or
  full size), `FilePicker` (a native file input drawn as a button),
  `Facts` (labelled values as a description list), `Badge` and `Countdown`
  (a `role="timer"` that redraws every second and reports the end once).
  `Field` also takes `inputMode`, a polite `hint` (`setHint`) and `onInput`.
- `AppTile`, `AppGrid` and `Identity`: the home screen launcher. A tile is one
  button named by the app, with its tier mark (official or community; platform
  apps carry none) as its accessible description. A tile shows `iconUrl` when
  given and falls back to the app's monogram if it is absent or fails to load. `Screen({ top })` places the
  identity above the title, and `Embed({ fill: true })` gives a running app the
  rest of the screen.

Applications compose screens only from these components. The design gate in
`tools/design-system.mjs` rejects `createElement` for elements a component
already provides (button, dialog, input, select, textarea, label, nav, header,
lists and headings) outside this package.

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
curves, and ordered layers. OFL-licensed Onest, Outfit, Sora and Unbounded ship as separate WOFF2 assets
with licenses in `src/fonts/`. `fonts.css` declares local URLs, `font-display: swap`
and per-file `unicode-range`; Vite emits hashed assets without inlining. System
font fallbacks remain available while fonts load. Onest is the body/control face, Outfit the
workspace heading face, Unbounded the OS badge, and Sora the collectible name. Reduced motion is honored by the shared recipes.

The committed subsets were produced from the previously embedded variable WOFF2 fonts using temporary FontTools 4.67.0 (`fonttools[woff]`, not a project dependency): `instantiateVariableFont(font, {"wght": weight})`, then `subset.Subsetter` with U+0020–017F, U+0300–036F, U+0400–045F, U+0490–0491, U+2000–206F, U+20AC, U+20B4 and U+2212, saved with `font.flavor = "woff2"`. Static weights are Onest 500/680/720/730/750/800, Outfit 500/730/750, Sora 800 and Unbounded 500/720. Onest 730/750/800 retain only combining marks and Cyrillic for the Outfit/Sora fallback; those two source faces have no Cyrillic. Other files retain supported glyphs from the full selection, including digits and basic punctuation. Original glyph outlines, layout features and metrics are preserved.

The guest palette matches `compileTheme(DEFAULT_THEME_BACKGROUND)` at first paint.
Colors remain compiler-owned. Collectible geometry and material tokens resolve
on each card so its own authored colors remain independent of the viewer's theme.
The shell uses the compiled top/mid/bottom water environment. Panels and tiles
use raised-to-base glass, glints, quiet edges and shadows; fields use soft glass.
The segmented tabs, offset controls and wallet-style sheets share this material.
Screens use compact spacing and reserve safe insets for the platform. Add future styles
to this library and consume its tokens instead of adding screen stylesheets.

Run `node --test packages/ui/scripts/test-design-tokens.ts` to verify the typed
foundation/CSS contract, canonical anchors, token references and reduced motion.
Run `node packages/ui/scripts/test-theme-compiler.ts` for guest first-paint parity,
exact authored colors and AA contrast across sampled themes, and
`node packages/ui/scripts/test-components.ts` for component behavior (a DOM double, no browser) and `node packages/ui/scripts/test-guest-palette.ts` for the `:root` first-paint palette; all run from `npm run test:unit`.

## Component catalog and visual tests

`src/catalog.ts` renders every component in every variant and state (buttons with
loading and disabled, fields with an error, selected tab, loading, empty and error
states, avatars with a picture and with initials, launcher tiles of every tier with an identity, list, card, section, frog cards
with and without artwork, and an open sheet) from fixed data and i18n keys. Open it
at `/catalog.html?theme=guest|light|dark|neutral|close` (add `&sheet=open` for the sheet) from
`npm run dev:miniapp`. The page is a separate Vite entry that only exists when
`CATALOG=true`; the production build never contains it (`tools/catalog.test.mjs`
checks this).

`npm run test:visual` screenshots the catalog in the guest, a light and a dark
profile theme at 390px and 1280px in Chromium and WebKit, with reduced motion.
The contrast gate scrolls both the shell surface and expanded full page, samples
painted background pixels with glyphs hidden, and checks computed text (including
alpha and native form values) at 4.5:1. Water, glass, images and layered materials
are included. The light fixture explicitly authors blue `#2B6CB0` as its accent.
Baselines live in `apps/miniapp/visual/__screenshots__` and must be rendered in
the Linux Playwright image CI uses, never on macOS. Any pixel difference fails CI.

When a design change is intended, run `npm run test:visual:update` (needs Docker;
it uses the pinned `mcr.microsoft.com/playwright` image from
`.github/workflows/ci.yaml`), review the changed PNGs and commit them with the
change. A failed CI run uploads the `visual-diff` artifact with the expected,
actual and diff images. When changing the image, update it in both the script
and the workflow.
