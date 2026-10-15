#!/bin/sh
set -eu
# Reject ambiguous modes before migrations or bootstrap can write anything.
case "${STAGING_AUTH_MODE:-}:${STAGING_SYNTHETIC_ONLY:-false}" in
  synthetic:true|allowlist:false) ;;
  *) printf '%s\n' 'Invalid staging migration mode' >&2; exit 2;;
esac
deno run --allow-read --allow-env --allow-run tools/db-migrate.mjs
psql -X --no-password -v ON_ERROR_STOP=1 -f staging-bootstrap.sql
if [ "$STAGING_AUTH_MODE" = synthetic ]; then
  psql -X --no-password -v ON_ERROR_STOP=1 -f staging-seed.sql
fi
