#!/bin/sh
set -eu
case "${1:-}" in *[!0-9a-f]*|'') exit 2;; esac
[ "${#1}" -eq 40 ] || exit 2
cd "/srv/rada-staging/releases/$1"
export COMPOSE_PROJECT_NAME=rada-staging
compose() { docker compose --env-file /srv/rada-staging/staging.env -f infra/compose/staging.yaml "$@"; }
compose config --quiet
compose build api migrate
compose up -d --wait postgres
compose run --rm migrate
compose up -d --wait api
compose up -d tunnel
printf '%s\n' "$1" > /srv/rada-staging/current-sha
