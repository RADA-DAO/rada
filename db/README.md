# Database interface

Identity uses a stable `subject_id` UUID across applications. Tables belong to
`identity_owner` (NOLOGIN); application logins must never inherit this role.
Community applications receive no database credentials. Provision separate login
credentials for these non-login roles outside migrations:

| Role                | Allowed access                                                                      |
| ------------------- | ----------------------------------------------------------------------------------- |
| `identity_auth`     | Execute `identity.resolve_telegram(bigint)` after verified Telegram authentication  |
| `identity_service`  | Read own identity, Telegram link, roles and consents; insert/update own consents    |
| `identity_operator` | Read, insert and delete explicit role grants                                        |
| `apps_service`      | Execute registry transitions and read the approved live projection only             |
| `jpegpe_service`    | Execute own-frog public projection only                                             |
| `jpegpe_operator`   | Create and transfer frogs through checked functions                                 |
| `wallet_service`    | Own proof challenges and identity-owned wallet link, revoke and consent functions   |
| `splash_service`    | Execute SPLASH submission, pond, image, round, bid, result and claim functions only |
| `ops_service`       | Execute `ops.record_client_error(...)` and `ops.purge_client_errors(interval)` only |

`apps_owner` owns the registry schema and is `NOLOGIN`. The API must use a
separate login inheriting only `apps_service`; it has no base-table writes or
ability to mint `identity.role_grants`. A trusted identity operator grants
`apps.reviewer` to subject UUIDs. The registry reads that grant through a narrow
identity-owned function on every review, publish, rollback and withdrawal.
Registry versions retain immutable manifest, hash and artifact metadata. Review
events are append-only; app state changes lock the app row in one transaction.
The public projection contains only the approved live version and omits private
author subject UUIDs. Manifest requests and user consent do not create platform
authority. Financial and DAO authority capabilities are excluded from release
grants until their services implement separate authorization.

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

`selected_frog_id` has a frog foreign key and is written only by
`identity.select_frog(uuid)`, which locks
and verifies current JPEGPE ownership. A transfer atomically clears the former
owner's selection. `jpegpe.own_public_frog(uuid)` rechecks current ownership on
each read and returns only frog UUID, username and stored authored colours.
JPEGPE usernames are unique ignoring ASCII case and immutable; frog UUIDs are
the stable keys. Ownership events are append-only. There is no public identity
listing, and neither service role has direct access to the other module's tables.
Telegram data must not appear in public profile responses. Other private data
requires an active app-scoped consent checked by the platform on every read.

Use [migrations](migrations/README.md) for schema setup and verification.

Holders rankings use two additional login roles: `rankings_service` may execute
only the public page function; `rankings_worker` may enumerate current public
profiles' verified wallets and execute ranking prune/record functions. Neither
has base-table privileges. Provision separate credentials; never grant the
`rankings_owner` role to an application login.
