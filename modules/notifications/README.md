# Notifications

Private Telegram notifications for platform SPLASH and governance events. No
community-app sending API. Only the authenticated subject can read or change
preferences at `GET/POST /v1/notifications/preferences`; writes require a launch
verified within one hour. Categories are `splash` and `governance`, initially off.
An explicit enable records consent time and an audit entry; revoke cancels pending
messages. Re-enabling does not replay events from an earlier consent period.

`POST /v1/notifications/test` accepts a category with active consent and queues
one test per minute per subject. It returns 202 for queued, not delivered, and
429 when consent or the test budget is absent. Tests also obey delivery limits.
Preferences accept `locale` (`en`/`uk`) and nullable `quiet_start`/`quiet_end`
(integer UTC hours; unequal when set). The minimal UI offers 22:00–08:00 UTC.

## Public interfaces

Modules call `notifications.enqueue` or the governance-only `broadcast` SQL
function in their own transaction. Events have unique keys, a fixed template kind,
recipient and expiry, with no arbitrary message payload. SPLASH hooks notify the
winner on won/claimed/burned; its public reminder job emits a deadline notice
within six hours. Governance hooks broadcast opened and decision events to
currently opted-in subscribers; its reminder job emits within twelve hours of
closing. Domain outcomes cancel obsolete pending reminders. There is no backfill
of historic wins or decisions; current due reminders are eligible after opt-in.

Identity publishes a destination lookup restricted to the notifications owner.
`notifications_service` has function execution only, no table access. Domain
owners receive only producer functions. No Telegram identity reaches the UI.

## Delivery

`NOTIFICATIONS_SERVICE_DATABASE_URL` enables routes and the API minute timer.
`NOTIFICATIONS_ENABLED` defaults to false. Synthetic staging never sends; real
staging requires and checks `STAGING_ALLOWED_TELEGRAM_IDS` on each delivery.
Use the canonical `TELEGRAM_BOT_TOKEN`; fetch times out after ten seconds.

One session advisory lock serializes workers across replicas. Each attempt is
persisted before network access. Authorization rechecks live consent under a row
lock held through the send; revocation waits for an already-started bounded send.
Each subject gets at most five attempts per rolling hour and twenty per day,
including retries and tests. Quiet hours defer delivery; expired events cancel.
Known 429/5xx failures retry with exponential backoff (60 seconds initially),
respecting Telegram retry-after, with at most five attempts. Other API failures
are terminal. A timeout, unreadable response, or process loss after reservation
is marked uncertain and never automatically retried: Telegram sendMessage has no
idempotency key, so exactly-once external delivery cannot be guaranteed. Fixed
bilingual templates contain no names, addresses, proposal text or private payloads.

Set the switch false and restart the API to stop delivery. Pending work remains
until expiry. Logs contain only a fixed failure event, never Telegram responses.
