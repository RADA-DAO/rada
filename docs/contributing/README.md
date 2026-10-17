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
