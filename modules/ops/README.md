# Ops

Owns sanitized operational telemetry in `ops.client_errors` and private import
mappings/checkpoints. Import linkage is restricted to `legacy_import` and is never
exposed by telemetry. See [legacy importer](../../tools/import/README.md).

`POST /v1/client-errors` is unauthenticated because a beacon cannot carry a
signed launch. It accepts at most 4 KB of JSON (`application/json` or
`text/plain`), checks an exact schema (`kind`, `name`, `message`, `frames`,
`build`, `route`), validates diagnostic codes, re-sanitizes metadata, and is limited by one global
in-memory token bucket (60 per minute, no per-client key, no IP). Responses are
`204`, `400`, `413`, `415` or `429`. Rows carry no subject, address, token or IP.

The `message` field contains only one fixed diagnostic code: `unknown`,
`type_error`, `range_error`, `reference_error`, `syntax_error`, `uri_error`,
`eval_error`, `aggregate_error`, `abort_error`, or `timeout_error`. The SDK maps
known error class names to these codes; all other errors and non-error values use
`unknown`. Exception text is never included. Error class name, own-origin frames,
build and route remain available. The API rejects non-allowlisted messages with
`400`, the store drops invalid reports, and a database constraint enforces the
same allowlist. Migration `0039` replaces existing messages with `unknown` while
preserving the remaining report fields. Apply it before deploying the new SDK/API;
older clients sending free-form messages will receive `400`.

The API login has the `ops_service` role: it can execute
`ops.record_client_error(...)` and `ops.purge_client_errors(interval)` only, with
no table access. Retention is 30 days. There is no scheduler yet, so the API
runs `ops.purge_client_errors()` after an insert at most once an hour; when a
scheduler exists, run `SELECT ops.purge_client_errors();` daily.

## Failure digest

An optional hourly Telegram message to the operator, run as a timer inside the API
process (no extra service: it needs the in-process server failure counters, the
ops database login and the bot token the API already holds). It is off unless
`ALERTS_ENABLED=true`, `ALERT_TELEGRAM_CHAT_ID` and `TELEGRAM_BOT_TOKEN` are set.

Each hour it reads new `ops.client_errors` through `ops.client_error_summary(after)`
(counts grouped by kind/name/route; no messages or frames) and the growth of the
server failure counters. If both are zero nothing is sent; otherwise one plain-text
message gives totals and the top 3 groups of each. The client-error watermark is
stored in `ops.alert_state` and advances only after a successful send, so restarts
do not resend. The server-count baseline is in memory (counters reset on restart
too). A failed send logs one sanitized JSON line (`alert_digest_failed`, error
class, HTTP status) and is retried at the next hourly run. Telegram is called with
plain `fetch` and a 10 second timeout.
