# Staging

Deployment stays off unless `STAGING_DEPLOY_ENABLED=true`. The first deployment
is performed by the operator after approval. Use the existing `rada-staging`
Cloudflare Worker with static assets and the existing separate test bot. Never
use production credentials or import production data.

## Server

Use a dedicated `/srv/rada-staging` directory, deployment login/key and database
volume. Pin the SSH host key through a trusted channel. Keep `staging.env` outside
release directories with mode 0600. Docker access is administrator-equivalent.

Server environment:

- `POSTGRES_PASSWORD`, `AUTH_PASSWORD`, `SERVICE_PASSWORD`, `WALLET_PASSWORD`, `OPS_PASSWORD`: distinct high-entropy
  hexadecimal passwords; runtime logins receive only their respective module role.
- `TELEGRAM_BOT_TOKEN`: the test bot token, server only; no bot update changes.
- `STAGING_AUTH_MODE=allowlist`, `STAGING_SYNTHETIC_ONLY=false`.
- `STAGING_ALLOWED_TELEGRAM_IDS`: nonempty comma-separated positive decimal IDs of
  approved testers. Keep actual IDs only here; never in frontend assets or logs.
- `STAGING_API_HOSTNAME`: the host's public sslip.io hostname, without a scheme,
  path or port. The container entrypoint rejects whitespace, configuration syntax,
  invalid DNS labels and overlong names before Caddy validation or startup. Keep
  the actual host address outside the repository.
- `API_ALLOWED_ORIGINS` and `WALLET_APP_ORIGIN`: the exact existing Worker HTTPS
  origin, no trailing slash. The wallet proof accepts only this server-configured
  HTTPS domain; local domains are rejected.

Missing, empty or malformed allowlists and conflicting modes prevent API startup.
Only signed launches for allowed testers reach persistence. Every staging API
route, including `/apps/published`, requires authentication except `/health` and
CORS preflight. The static Worker shell can load for guests. Ordinary signatures
last 24 hours; writes and review reads require signatures within one hour.
Staging membership remains `unavailable` and makes no external provider calls.

Caddy provides [automatic HTTPS](https://caddyserver.com/docs/quick-starts/https).
Before deployment, the operator must confirm DNS resolves to the server and open
inbound TCP 80/443 in UFW and the provider firewall. Only Caddy publishes ports;
API and PostgreSQL remain inside Docker. Caddy has internet egress for ACME. The API has egress for fixed TON public
endpoints used for wallet proofs and balances; no additional ports are published.
Certificates and configuration persist in dedicated volumes. There is no tunnel
or tunnel token requirement. Verify certificate issuance before phone testing;
never fall back to insecure HTTP.

## GitHub and Worker

Create/review the protected `staging` environment restricted to `main` before
activation. Environment secrets:

- `STAGING_SSH_HOST`, `STAGING_SSH_USER`, `STAGING_SSH_KEY`.
- `STAGING_SSH_KNOWN_HOSTS`: trusted complete known_hosts line.
- `STAGING_CLOUDFLARE_ACCOUNT_ID`, `STAGING_CLOUDFLARE_API_TOKEN`: scoped to the
  staging account with Workers Scripts: Edit permission.

Repository variables: `STAGING_API_ORIGIN` (exact public HTTPS API origin),
`STAGING_APP_ORIGIN` (exact existing Worker HTTPS origin, matching server wallet
configuration), and
`STAGING_DEPLOY_ENABLED` (absent/false until approved). API origin is a public build
value; `STAGING_APP_ORIGIN` generates the public TON Connect manifest. Credentials and tester IDs are server configuration only.

The workflow accepts successful push CI for an exact main SHA, checks out that
revision, builds with Node 24.14.0, uploads the same source, migrates/bootstraps
before API startup, then publishes static assets with Wrangler 4.151.0:

```sh
wrangler deploy --assets apps/miniapp/dist --config infra/cloudflare/wrangler.jsonc
```

This updates the existing named Worker; it does not create a Pages project.
The build copies `_headers` into assets, preserving `frame-src 'none'` protection
for the sandboxed app host. See [Workers assets](https://developers.cloudflare.com/workers/static-assets/)
and [asset headers](https://developers.cloudflare.com/workers/static-assets/headers/).

## Validation and rollback

Run `sh tools/check-staging.sh` for configuration/build checks and
`sh tools/test-staging.sh` for disposable database/API verification. CI fixes
synthetic mode to signed fixtures 101/102 and rejects 103; no real bot is used.
Caddy validation runs without host ports, ACME or live DNS. These checks never
start a public proxy. Synthetic seed reruns enforce two fixture identities and
no role grants, consents or frog selection. Seeding runs only in explicit synthetic
mode. Allowlist migrations preserve existing testers and consents; the smoke test
checks a third synthetic tester and consent survive two migration reruns.

After approval, deploy the exact checked SHA using the workflow, or run
`sh infra/compose/deploy-staging.sh FULL_SHA` from its server release directory.
That server command records only `api-pending-sha`; it does not mean the frontend
published. After the matching Worker publishes successfully, the workflow calls
`sh infra/compose/finalize-staging.sh FULL_SHA`. This verifies the pending SHA and
atomically updates `current-sha` for the paired release. A manual deployment must
complete Worker publication successfully before invoking that finalizer.
Check HTTPS `/health`, guest shell, exact-origin CORS, allowed test-bot launches,
and denied accounts. Never log initData, identifiers, tokens or database errors.

For rollback, disable deployment first, stop only staging API/Caddy, choose a
recorded compatible SHA and review migrations before deploying it. Restore the
matching previous Worker version in Cloudflare. Keep all persistent volumes;
never use `down --volumes` for rollback. Record API and Worker SHAs together and
repair partial publication before testing resumes. Forward-only schema changes
may require a compatible forward fix.
