# Modules

Each domain owns its API, database migrations, SQL tests and public `index.ts`.

- [Identity](identity/README.md): authentication, own profiles, consents and membership.
- [Apps](apps/README.md): release registry and review/publication transitions.
- [JPEGPE](jpegpe/README.md): frogs, ownership and public frog projections.
- [SPLASH](splash/README.md): frog submissions to the pond (images, author, state history).
- [Governance](governance/README.md): advisory votes, steward decisions and execution evidence.
- [Ops](ops/README.md): sanitized client-side failure reports.

Import another module only through its public entry point. Runtime SQL accesses
owned tables or a published SQL function; historical migrations remain immutable.
The [API](../apps/api/README.md) composes routers and HTTP/authentication policy.

[Notifications](notifications/README.md) owns consent-based platform Telegram
preferences, the event outbox and delivery attempts.

[Treasury](treasury/README.md) owns public DAO wallet configuration history and
read-only balances, transaction and signer projections.
