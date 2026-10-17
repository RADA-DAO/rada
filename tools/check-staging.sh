#!/bin/sh
set -eu
export POSTGRES_PASSWORD=synthetic-admin-password AUTH_PASSWORD=synthetic-auth-password SERVICE_PASSWORD=synthetic-service-password WALLET_PASSWORD=synthetic-wallet-password OPS_PASSWORD=synthetic-ops-password SPLASH_PASSWORD=synthetic-splash-password GOVERNANCE_PASSWORD=synthetic-governance-password RANKINGS_PASSWORD=synthetic-rankings-password RANKINGS_WORKER_PASSWORD=synthetic-rankings-worker-password
export NOTIFICATIONS_PASSWORD=synthetic-notifications-password NOTIFICATIONS_ENABLED=false
export RANKINGS_WORKER_ENABLED=false
export TREASURY_PASSWORD=synthetic-treasury-password TREASURY_WORKER_ENABLED=false
export TELEGRAM_BOT_TOKEN=synthetic-fixture-bot-token
export STAGING_AUTH_MODE=synthetic STAGING_SYNTHETIC_ONLY=true STAGING_API_HOSTNAME=api.staging.example.invalid
unset STAGING_ALLOWED_TELEGRAM_IDS
export API_ALLOWED_ORIGINS=https://staging.example.invalid
export WALLET_APP_ORIGIN=https://staging.example.invalid
docker compose -f infra/compose/staging.yaml config --quiet
VITE_API_ORIGIN=https://api.staging.example.invalid VITE_TON_CONNECT_APP_ORIGIN=https://staging.example.invalid npm run build:miniapp
node tools/validate-staging-assets.mjs
