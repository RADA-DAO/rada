# Hello community

A small, dependency-free community app using the injected SDK bridge. It reads
the host locale and returns through host navigation. Its counter stays in the
frame's memory and resets on reopen. It requests no identity, storage, money or
wallet permissions. UI copy lives in the English and Ukrainian locale files.

## Build an immutable artifact

From the repository root, after `npm ci`:

```sh
npm run example:build -- /tmp/rada-example 1
```

The builder validates `rada.app.json`, bundles the client and both locales into
one HTML file, computes its SHA-256 and writes
`/tmp/rada-example/artifacts/<sha256>.html`. Rebuilding identical source yields
the same path. Existing bytes cannot be overwritten with different content.
Revision `2` changes the visible release label, providing an update/rollback
fixture without editing source. There are no network requests from the child.

## Publish, update and roll back locally

Use the [local platform launcher](../../../../docs/contributing/local-development.md)
to start an isolated, synthetic-only database, API, shell and artifact server.
The launcher seeds author `101` and reviewer `102`; these are fixture identities,
not real Telegram users. Run `npm run example:verify` for a fresh disposable
environment and the complete publication lifecycle.
The command uses only `RADA_LOCAL_API_ORIGIN` and `RADA_LOCAL_ARTIFACT_DIR`
exported by that launcher and refuses non-loopback API origins.

The verification creates a fresh example app, submits a pending version,
approves and publishes it, publishes revision 2, rolls back to revision 1 and
withdraws the app. It checks the exact published version and hash at each step,
and rejects unsigned submission, author review/publication/rollback and
publication before approval. Artifacts and append-only registry history remain
in the disposable environment until its normal cleanup; no production upload
or data change takes place.

For actual rendering, run `npm run test:local-platform`, which starts and cleans
its own local environment. Chromium mobile/desktop and WebKit mobile open the full launcher and
run the real artifact through the SDK host at each published revision. The
suite also checks Back, opaque origin, missing Telegram credentials, a tampered
artifact and withdrawal. It uses a local ephemeral HTTPS certificate only;
production HTTPS and hash requirements remain unchanged.

The API records the reviewed manifest and hash; submission does not fetch or
validate the HTML bytes. Integrity is independently enforced by the SDK host
when the person opens the app. This example is a local authoring route, not a
public artifact upload service or the production App Studio pipeline.
