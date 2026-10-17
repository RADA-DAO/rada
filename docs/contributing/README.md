# Development guide

- [Local development and test suites](local-development.md)
- [Add a platform module](modules.md)
- [Build a community app](community-apps.md)
- [Review and update visual baselines](visual-tests.md)

Read the [architecture](../architecture/README.md) and the affected component's
README before editing. Keep changes small and within module boundaries. Use
English for code, comments and documentation; put visible UI copy in both
[locale dictionaries](../../packages/i18n/locales), referenced by translation keys.
Use [shared UI components](../../packages/ui/README.md) and the platform navigation
controllers instead of screen-owned styles or gestures.

Use Conventional Commits. Run `npm run check` before submitting a pull request and
report any checks that could not run. See [contribution rules](../../CONTRIBUTING.md)
and [CI](../../.github/workflows/ci.yaml). Never commit credentials, personal data,
database dumps or working notes; use synthetic fixtures in disposable local databases.

Never use production data locally.

## Miniapp size budget

`npm run check:bundle` builds the production miniapp and enforces
[`tools/miniapp-budget.json`](../../tools/miniapp-budget.json) in the required CI
quality job. After `npm run build:miniapp`, use
`npm run check:bundle -- --skip-build` to inspect existing output. Do not reuse a
catalog or mocked build. The table reports bytes per entry: initial JS includes
all static imports (gzip level 9 and Brotli default, compressed per file); CSS
and fonts use raw bytes. Lazy totals include all reachable dynamic imports and
their static dependencies, excluding initial assets and counting shared files
once. Every emitted font, including public assets, counts conservatively for each
entry. Lazy JS files are also listed individually. Externally hosted assets,
including Telegram's bridge, are outside this build budget.

Initial limits are the measured production sizes plus 10% (rounded up); empty
categories have zero limits. To raise a limit deliberately, first inspect the
reported growth and consider removing or deferring the dependency. Edit only the
necessary entry/metric in the JSON, rerun the check, and explain the measured
before/after sizes and user benefit in the pull request. New entries need explicit
budgets. Do not automatically regenerate all limits or bypass the CI gate.
