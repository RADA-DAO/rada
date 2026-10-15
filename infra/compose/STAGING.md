# Staging

Preparation only. Deployment is off until `STAGING_DEPLOY_ENABLED=true` and the
protected GitHub `staging` environment approves a successful main CI revision.
Create that environment with required reviewers, prevent self-review, restrict
it to main, and confirm protection is supported by the repository's plan before
enabling. First deployment needs explicit approval and a separate test bot.

## Provisioning

Use a dedicated host directory `/srv/rada-staging`, database volume, test bot,
named Cloudflare Tunnel and Pages Direct Upload project. Never import production
data or use production tokens. Pin the SSH host key from a trusted channel.
Create a dedicated deployment SSH key/login with access only to this staging
host; Docker access is administrator-equivalent. Store the private key in GitHub,
not this repository. Keep `staging.env` mode 0600 outside release directories.

Create the named tunnel in Cloudflare's dashboard and route only the chosen API
HTTPS hostname to `http://api:8000`; leave unmatched ingress returning 404.
Do not route PostgreSQL or add host port mappings. The connector alone joins an
egress network; API and database networks are internal. Validate DNS and outbound
[port 7844](https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/configure-tunnels/tunnel-with-firewall/)
before starting: QUIC uses UDP, HTTP/2 uses TCP, both on 7844. HTTPS 443 alone
cannot carry this tunnel. Image pulls and Pages uploads also require HTTPS egress.

Create a separate Pages Direct Upload project with production branch `main` and
no Git integration or automatic preview deployment. Record its HTTPS origin for
CORS. Set `STAGING_API_ORIGIN` to the exact HTTPS API origin; this public build
variable contains no token. Keep all bot and database credentials on the API host.

## Configuration

Protected GitHub environment secrets:

- `STAGING_SSH_HOST`, `STAGING_SSH_USER`, `STAGING_SSH_KEY`
- `STAGING_SSH_KNOWN_HOSTS` (trusted complete known_hosts line)
- `STAGING_CLOUDFLARE_ACCOUNT_ID`, `STAGING_CLOUDFLARE_API_TOKEN` (Pages edit only)

Repository variables: `STAGING_DEPLOY_ENABLED` (absent/false until approved),
`STAGING_API_ORIGIN`, `STAGING_PAGES_PROJECT` (letters, digits and hyphens only).

Host `staging.env` keys: `POSTGRES_PASSWORD`, `AUTH_PASSWORD`, `SERVICE_PASSWORD`,
`TELEGRAM_BOT_TOKEN`, `TUNNEL_TOKEN`, `API_ALLOWED_ORIGINS`.
Generate distinct high-entropy hexadecimal database passwords (URL-safe).
`API_ALLOWED_ORIGINS` is the exact Pages HTTPS origin, without a trailing slash.
The runtime receives only `staging_auth` and `staging_service` login credentials.
The administrator credential is confined to PostgreSQL and the one-off migration
container. Migrations create NOLOGIN module roles; bootstrap grants each runtime
login only its respective role. Password rotation requires rerunning migration
bootstrap and recreating the API; changing the administrator environment alone
does not rotate an existing PostgreSQL volume password.

## Start and verify

After approval, deploy an exact main SHA using the workflow. It waits for CI,
builds the shell, uploads that revision, runs migrations/bootstrap/seed once,
starts API/tunnel and publishes Pages. The host needs Docker with Compose v2;
all build tools are pinned in containers. Never start API before migration succeeds.
The shell is built with Node 24.14.0 and published with Wrangler 4.151.0.
Run `sh tools/check-staging.sh` for configuration/build validation and
`sh tools/test-staging.sh` for disposable image/database/API verification.
These tests use synthetic credentials and never start a tunnel.
For a manual approved run, place that revision in its release directory and run
`sh infra/compose/deploy-staging.sh FULL_SHA` from there.

Check named tunnel health, public `/health`, guest shell loading and CORS against
the exact Pages origin. `/health` is liveness, not database readiness. The seed
asserts exactly two synthetic subjects/Telegram links, stable UUIDs, no role
grants, consents or frog selection. Reapplying it must preserve these invariants.
Do not log initData, tokens, identifiers or database errors.

`STAGING_SYNTHETIC_ONLY=true` is fixed in Compose: only signed fixture IDs 101/102
can reach persistence. Sign fixtures only in isolated tests with a synthetic token.
There is no public test login, forged production authentication or frontend token.
Real test-bot sessions are rejected before database access, so native manual
checks are guest-only pending a separate privacy decision. Restrict staging bot
access and ensure these reserved fixture identifiers are never assigned to testers.

## Rollback

Set `STAGING_DEPLOY_ENABLED=false` first. Stop only this project's API and tunnel,
select the previous recorded full SHA, and review migration compatibility before
running its deploy script. Restore the matching previous Pages deployment in the
Cloudflare dashboard. Keep the named database volume; never use `down --volumes`
as rollback. Forward-only migrations require a compatible forward fix, not an
old binary on an incompatible schema. Record API and Pages SHAs together; a
partial publication must be repaired or rolled back before testing resumes.
