#!/bin/sh
set -eu
export POSTGRES_PASSWORD=synthetic-admin-password AUTH_PASSWORD=synthetic-auth-password SERVICE_PASSWORD=synthetic-service-password
export TELEGRAM_BOT_TOKEN=synthetic-fixture-bot-token TUNNEL_TOKEN=synthetic-unusable-tunnel-token
export API_ALLOWED_ORIGINS=https://staging.example.invalid
docker compose -f infra/compose/staging.yaml config --quiet
VITE_API_ORIGIN=https://api.staging.example.invalid npm run build:miniapp
