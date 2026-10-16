# Modules

Each domain owns its API, database migrations, SQL tests and public `index.ts`.

- [Identity](identity/README.md): authentication, own profiles, consents and membership.
- [Apps](apps/README.md): release registry and review/publication transitions.
- [JPEGPE](jpegpe/README.md): frogs, ownership and public frog projections.
- [Ops](ops/README.md): sanitized client-side failure reports.

Import another module only through its public entry point. Runtime SQL accesses
owned tables or a published SQL function; historical migrations remain immutable.
The [API](../apps/api/README.md) composes routers and HTTP/authentication policy.
