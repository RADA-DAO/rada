#!/bin/sh
# Disposable local containers only; no proxy listeners or ACME requests.
set -eu
export POSTGRES_PASSWORD=synthetic-admin-password AUTH_PASSWORD=synthetic-auth-password SERVICE_PASSWORD=synthetic-service-password WALLET_PASSWORD=synthetic-wallet-password OPS_PASSWORD=synthetic-ops-password SPLASH_PASSWORD=synthetic-splash-password GOVERNANCE_PASSWORD=synthetic-governance-password
export TELEGRAM_BOT_TOKEN=synthetic-fixture-bot-token
export STAGING_AUTH_MODE=synthetic STAGING_SYNTHETIC_ONLY=true STAGING_API_HOSTNAME=api.staging.example.invalid
unset STAGING_ALLOWED_TELEGRAM_IDS
export API_ALLOWED_ORIGINS=https://staging.example.invalid
export WALLET_APP_ORIGIN=https://staging.example.invalid
compose() { docker compose -p rada-staging-smoke -f infra/compose/staging.yaml "$@"; }
trap 'compose down --volumes --remove-orphans >/dev/null' EXIT
compose config --quiet
compose run --rm --no-deps caddy caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile
compose build api migrate
compose up -d --wait postgres
compose run --rm migrate
compose run --rm migrate
compose up -d --wait api
# Give the process a bounded startup window without exposing any host ports.
compose exec -T api deno eval '
import { signed, assert } from "./apps/api/src/fixtures.ts";
let ready = false;
for (let i = 0; i < 30; i++) {
  try { ready = (await fetch("http://127.0.0.1:8000/health")).ok; } catch {}
  if (ready) break;
  await new Promise(r => setTimeout(r, 1000));
}
assert(ready);
for (const id of [101, 102, 103]) {
  const response = await fetch("http://127.0.0.1:8000/me?subject_id=other", { headers: { authorization: `tma ${await signed({ user: JSON.stringify({id}) })}` } });
  assert(response.status === (id === 103 ? 401 : 200));
  if (id !== 103) {
    const body = await response.json();
    assert(body.subject_id === `00000000-0000-4000-8000-000000000${id}`);
    assert(body.profile.public === null && body.membership.status === "unavailable");
  }
}
assert((await fetch("http://127.0.0.1:8000/me")).status === 401);
console.log("Container health, signed synthetic identity and rejection passed.");
'
compose exec -T postgres psql -X -U postgres -d rada_staging -v ON_ERROR_STOP=1 < modules/identity/db/identity.test.sql
compose run --rm migrate
# Model a tester's persisted state, then rerun real-mode migrations twice.
# The API remains in synthetic mode; no external provider or real identity is used.
compose exec -T postgres psql -X -U postgres -d rada_staging -v ON_ERROR_STOP=1 <<'SQL'
BEGIN;
SET LOCAL ROLE identity_owner;
INSERT INTO identity.subjects(subject_id) VALUES ('00000000-0000-4000-8000-000000000103');
INSERT INTO identity.telegram_accounts(subject_id, telegram_user_id)
VALUES ('00000000-0000-4000-8000-000000000103', 103);
INSERT INTO identity.consents(subject_id, app_id, capability, granted_at)
VALUES ('00000000-0000-4000-8000-000000000103', 'fixture.example', 'wallet.address.read', '2026-01-01T00:00:00Z');
COMMIT;
SQL
export STAGING_AUTH_MODE=allowlist STAGING_SYNTHETIC_ONLY=false
compose run --rm migrate
compose run --rm migrate
compose exec -T postgres psql -X -U postgres -d rada_staging -v ON_ERROR_STOP=1 <<'SQL'
BEGIN;
SET LOCAL ROLE identity_owner;
DO $$ BEGIN
  IF (SELECT count(*) FROM identity.subjects) <> 3
    OR (SELECT count(*) FROM identity.telegram_accounts) <> 3
    OR NOT EXISTS (SELECT FROM identity.telegram_accounts
      WHERE telegram_user_id = 103 AND subject_id = '00000000-0000-4000-8000-000000000103')
    OR (SELECT count(*) FROM identity.consents) <> 1
    OR NOT EXISTS (SELECT FROM identity.consents
      WHERE subject_id = '00000000-0000-4000-8000-000000000103'
        AND app_id = 'fixture.example' AND capability = 'wallet.address.read'
        AND granted_at = '2026-01-01T00:00:00Z' AND revoked_at IS NULL)
  THEN RAISE EXCEPTION 'Staging tester state changed during migration'; END IF;
END $$;
ROLLBACK;
SQL
# Recreate the actual image in allowlist mode, using only signed synthetic identities.
export STAGING_ALLOWED_TELEGRAM_IDS=103
compose up -d --wait --force-recreate api
compose exec -T api deno eval '
import { signed, assert } from "./apps/api/src/fixtures.ts";
for (const id of [101, 103, 104]) {
  const response = await fetch("http://127.0.0.1:8000/me", {
    headers: { authorization: `tma ${await signed({ user: JSON.stringify({id}) })}` },
  });
  assert(response.status === (id === 103 ? 200 : 401));
}
console.log("Allowlisted image authentication and denied persisted/unknown identities passed.");
'
compose exec -T postgres psql -X -U postgres -d rada_staging -v ON_ERROR_STOP=1 <<'SQL'
DO $$ BEGIN
  IF (SELECT count(*) FROM identity.telegram_accounts) <> 3 THEN
    RAISE EXCEPTION 'Denied staging identity reached persistence';
  END IF;
END $$;
SQL
