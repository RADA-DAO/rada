# Visual tests and baselines

The [catalog tests](../../apps/miniapp/visual/catalog.spec.ts) capture guest,
light and dark themes, both the full catalog and an open sheet. The
[Playwright configuration](../../apps/miniapp/playwright.visual.config.ts) runs
Chromium and WebKit at 390×844 and 1280×900, with reduced motion, fixed locale,
timezone and device scale. Any pixel difference fails (`maxDiffPixelRatio: 0`).
The catalog build is enabled only by `CATALOG=true`; its production exclusion is
checked by [catalog.test.mjs](../../tools/catalog.test.mjs).

```sh
npm run test:visual
```

This builds and serves the catalog automatically on port 4174. Baselines live in
[baseline PNGs](../../apps/miniapp/visual/__screenshots__).
Local platform/font differences can differ from CI: canonical renders come from
the pinned Linux Playwright container in [CI](../../.github/workflows/ci.yaml).

For an intentional visual change:

1. Run `npm run test:visual:update` from the root with Docker available. The
   [update script](../../tools/visual-update.sh) copies the checkout into the same
   pinned image as CI, installs locked dependencies and copies PNGs back.
2. Inspect every changed baseline and compare expected, actual and diff images.
   The script tolerates the internal Playwright exit status, so its completion
   message alone does not establish that the test run passed.
3. Run the visual suite in the same Linux image without `--update-snapshots`
   (the CI visual job shows the exact command/environment). Commit reviewed PNGs
   with the change that requires them; do not raise diff tolerance.

When changing the Playwright image, keep the workflow and update script aligned.
Failed CI uploads expected/actual/diff files as the `visual-diff` artifact for
seven days. Review those files before deciding whether to fix rendering or
update the intended baseline.
