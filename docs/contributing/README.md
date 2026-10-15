# Development guide

```sh
npm ci
npm run check     # formatting, Markdown, links, repository hygiene, UI text rules, types, unit tests
npm run commits   # Conventional Commits; set COMMIT_RANGE=base..HEAD for a range
```

CI also scans files and history for secrets (Gitleaks), validates Compose, and reviews
dependency changes and licenses on pull requests.

Never use production data locally.
