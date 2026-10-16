# Ops

Owns operational telemetry that must stay free of personal data. Today that is
sanitized client-side failure reports in `ops.client_errors`.

`POST /v1/client-errors` is unauthenticated because a beacon cannot carry a
signed launch. It accepts at most 4 KB of JSON (`application/json` or
`text/plain`), checks an exact schema (`kind`, `name`, `message`, `frames`,
`build`, `route`), re-sanitizes everything, and is limited by one global
in-memory token bucket (60 per minute, no per-client key, no IP). Responses are
`204`, `400`, `413`, `415` or `429`. Rows carry no subject, address, token or IP.

The API login has the `ops_service` role: it can execute
`ops.record_client_error(...)` and `ops.purge_client_errors(interval)` only, with
no table access. Retention is 30 days. There is no scheduler yet, so the API
runs `ops.purge_client_errors()` after an insert at most once an hour; when a
scheduler exists, run `SELECT ops.purge_client_errors();` daily.
