# Database interface

Identity uses a stable `subject_id` UUID across applications. Tables belong to
`identity_owner` (NOLOGIN); application logins must never inherit this role.
Community applications receive no database credentials. Provision separate login
credentials for these non-login roles outside migrations:

| Role                | Allowed access                                                                     |
| ------------------- | ---------------------------------------------------------------------------------- |
| `identity_auth`     | Execute `identity.resolve_telegram(bigint)` after verified Telegram authentication |
| `identity_service`  | Read own identity, Telegram link, roles and consents; insert/update own consents   |
| `identity_operator` | Read, insert and delete explicit role grants                                       |

`resolve_telegram` returns the same UUID for repeated verified Telegram IDs;
IDs are unique positive `bigint`. Pass a decimal string through drivers to avoid
JavaScript precision loss. It cannot relink an existing subject. Authentication
credentials are platform-only and must not be reachable through client SQL.

For service queries, begin a transaction and use a parameterized call to
`set_config('rada.subject_id', verifiedSubjectId, true)`. Only the trusted platform
service sets this context after verified authentication. Never derive it from an
unverified request body. Query and commit on the same connection; transaction
scope prevents pooled connections retaining identity. An absent context yields
no rows. The context is an isolation aid, not an authentication mechanism.

- `subjects(subject_id, selected_frog_id, created_at)` is the private own profile.
- `telegram_accounts(subject_id, telegram_user_id, verified_at)` is private.
- `role_grants(subject_id, role_name, granted_at)` contains explicit authority.
  No roles are seeded. Membership evidence belongs to governance, not role grants.
- `consents(subject_id, app_id, capability, granted_at, revoked_at)` records a
  permission per app. Access requires a matching row with `revoked_at IS NULL`.
  Revocation sets `revoked_at`; re-consent updates `granted_at` and clears it only
  after a new platform-controlled confirmation. Consent never grants DAO authority.

`selected_frog_id` reserves a UUID reference without a foreign key until JPEGPE
owns the frog schema. All runtime roles are denied writes to this column. A future
JPEGPE integration must verify current ownership, invalidate selection on transfer,
and provide live public name/theme data before enabling selection or public profile
queries. Until then profiles stay private; there is no public identity listing.
Telegram data must not appear in public profile responses. Other private data
requires an active app-scoped consent checked by the platform on every read.

Use [migrations](migrations/README.md) for schema setup and verification.
