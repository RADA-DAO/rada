# Product and developer surfaces

The default miniapp exposes SPLASH, Treasury, Tasks and CryptoNos, plus My
profile. The leaderboard is disabled. Profile wallet and collection features
remain part of My profile. Tasks and CryptoNos are separate products opened
through their canonical links.
Tasks opens the existing canonical task app at
`https://t.me/DAORADAbot?startapp=tasker`; its interface has not been ported into
this shell.

`npm run dev:miniapp` and `npm run build:miniapp` use this product surface by
default. Internal registry apps, reviewer tools, DAO, Holders, Community,
launcher arrangement, folders and favourites are excluded from the default
navigation. Changing a URL, query parameter, browser history or local storage
does not enable these screens.

## Internal development

`RADA_DEVELOPER_SURFACE=true` explicitly selects the internal surface when
starting Vite or building a developer artifact. This is a build-time UI switch;
it does not change API authentication, reviewer authorization, app permissions
or database access. Do not use an internal artifact as the default release.

The disposable `npm run dev:local`, `npm run test:local-platform` and
`npm run test:ui-sdk` runners explicitly define the internal surface in their
owned Vite process. Their provider-environment sanitation remains in force.
`npm run e2e` selects the internal surface only for its legacy browser test
artifact; its API process keeps the existing authentication configuration.

## Default surface verification

`npm run test:product-surface` builds a separate default artifact in
`apps/miniapp/dist-product-surface` and runs against a Playwright-managed server
on strict loopback port 4188. It forces the developer switch off, refuses to
reuse an existing server and retains failure traces under
`test-results/product-surface`. Test identities, host events and API responses
are synthetic fixtures. The fixture host changes neither server authentication
nor production state.
The synthetic host uses fullscreen mode with safe-area and content-safe-area
insets measured from the same viewport origin. These overlapping coordinates
use their maximum, not their sum; fullscreen header clearance is checked
separately.

The seven projects cover widths 320, 390, 430, 768, 1024, 1280 and 1440 using
Chromium and WebKit, with one worker. CI runs this gate after the internal SDK
checks and uploads the existing SDK diagnostics artifact on failure.

On the shared Mac, run browser suites and builds through
`~/.local/bin/rada-heavy-check`; the queue must cover the complete server,
checks and cleanup lifecycle. Playwright stops its own temporary server after
the suite. Existing services must remain untouched.
