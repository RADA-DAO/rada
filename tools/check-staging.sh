#!/bin/sh
set -eu
export POSTGRES_PASSWORD=synthetic-admin-password AUTH_PASSWORD=synthetic-auth-password SERVICE_PASSWORD=synthetic-service-password
export TELEGRAM_BOT_TOKEN=synthetic-fixture-bot-token
export STAGING_AUTH_MODE=synthetic STAGING_SYNTHETIC_ONLY=true STAGING_API_HOSTNAME=api.staging.example.invalid
unset STAGING_ALLOWED_TELEGRAM_IDS
export API_ALLOWED_ORIGINS=https://staging.example.invalid
docker compose -f infra/compose/staging.yaml config --quiet
VITE_API_ORIGIN=https://api.staging.example.invalid npm run build:miniapp
node tools/validate-staging-assets.mjs
