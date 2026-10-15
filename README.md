# RADA

RADA is an open platform for community applications and participation.
The project is in early development; nothing is deployable yet.

## Development

Requirements: Node.js 24 (see `.node-version`), npm, Deno 2.9.7, Docker Compose v2.

```sh
npm ci
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
