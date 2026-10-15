#!/bin/sh
set -eu
deno run --allow-read --allow-env --allow-run tools/db-migrate.mjs
psql -X --no-password -v ON_ERROR_STOP=1 -f staging-bootstrap.sql
psql -X --no-password -v ON_ERROR_STOP=1 -f staging-seed.sql
