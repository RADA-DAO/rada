#!/bin/sh
# Disposable local containers only; the tunnel service is never started.
set -eu
export POSTGRES_PASSWORD=synthetic-admin-password AUTH_PASSWORD=synthetic-auth-password SERVICE_PASSWORD=synthetic-service-password
export TELEGRAM_BOT_TOKEN=synthetic-fixture-bot-token TUNNEL_TOKEN=synthetic-unusable-tunnel-token
export API_ALLOWED_ORIGINS=https://staging.example.invalid
compose() { docker compose -p rada-staging-smoke -f infra/compose/staging.yaml "$@"; }
trap 'compose down --volumes --remove-orphans >/dev/null' EXIT
compose config --quiet
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
compose exec -T postgres psql -X -U postgres -d rada_staging -v ON_ERROR_STOP=1 < db/identity.test.sql
compose run --rm migrate
