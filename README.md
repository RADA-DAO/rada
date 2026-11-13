# RADA

[![CI](https://github.com/RADA-DAO/rada/actions/workflows/ci.yaml/badge.svg)](https://github.com/RADA-DAO/rada/actions/workflows/ci.yaml)
[![License: AGPL-3.0-only](https://img.shields.io/badge/license-AGPL--3.0--only-blue.svg)](LICENSE)
[![OpenSSF Scorecard](https://api.scorecard.dev/projects/github.com/RADA-DAO/rada/badge)](https://scorecard.dev/viewer/?uri=github.com/RADA-DAO/rada)

RADA is an open platform for community applications and participation.
The project is in early development. Local synthetic development and isolated
staging rehearsals are supported; this is not a production migration.

The default [product surface](docs/contributing/product-surface.md) contains
SPLASH, Treasury, Tasks and Cryptonos, plus My profile. The leaderboard is disabled.
The SDK rehearsal below explicitly opens the internal developer surface.

## Development

Requirements: Node.js 24 (see `.node-version`), npm, Deno 2.9.7, Docker Compose v2.

```sh
npm ci
npm run dev:local
```

The local launcher provisions its own disposable database, restricted API roles,
synthetic identities, HTTPS artifacts and the mini app. It uses no production
credentials. Follow the printed certificate instruction for that session, then
open the loopback URL. Ctrl-C removes only that run's services and data. See the
[local guide](docs/contributing/local-development.md) and
[SDK example](docs/contributing/community-apps.md) for the complete
create, review, publish, update and rollback rehearsal.

Run the repository quality gates separately:

```sh
npm run check
```

Optional local PostgreSQL 17 (no published ports):

```sh
cp .env.example .env
npm run db:up
npm run db:down
```

See [architecture](docs/architecture/README.md), [contributing](CONTRIBUTING.md),
and [security](SECURITY.md).

## License

Software is licensed under [AGPL-3.0-only](LICENSE). RADA and JPEGPE names, logos,
artwork, and other brand assets are not covered by this license.
