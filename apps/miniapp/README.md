# Mini app

Vite and TypeScript shell with an empty launcher and guest or own private profile.
All visible copy comes from `packages/i18n`; shared theme and controls come from
`packages/ui`. No product modules or public profiles are enabled.

Run `npm run dev:miniapp`. The same-origin `/api` proxy targets the local API on
port 8000. The hosting reverse proxy must provide this route in other environments.
The host must supply Telegram's WebApp bridge before application startup; ordinary
browser launches remain guests. Raw launch credentials stay in the platform adapter
and go only to platform API endpoints, never storage or child applications.

Run `npm run e2e` with `E2E_DATABASE_URL` pointing at a fresh disposable local
PostgreSQL 17 database and `psql` plus Deno on PATH. The runner applies migrations,
provisions restricted fixture logins, starts the real API and built shell, and tests
mobile and desktop Chromium and WebKit. All identities and tokens are synthetic.
The database must be discarded afterward. CI supplies an isolated service database.
Browser emulation does not prove native Telegram keyboard or safe-area behavior;
physical iOS and Android Telegram checks remain required before release.

For separate API hosting set `VITE_API_ORIGIN` to the exact HTTPS API origin at
build time and configure that API's `API_ALLOWED_ORIGINS` for the shell origin.
Only loopback origins may use HTTP for local development. If omitted, the shell
uses the same-origin `/api` route. The official Telegram SDK loads before startup;
tests intercept that script and use a controlled host without external requests.

The profile offers app review only after the protected registry queue authorizes
access. The review screen rechecks access, lists pending versions and requested
permissions, and requires a reason for approval or rejection. Approval does not
publish a release. Preview reuses the SDK sandbox with no granted permissions;
it cannot access identity, request personal-data consent, or perform privileged
actions. Leaving the screen or changing language disposes its preview and ignores
late responses. Reviewer authority comes from the API, independently of membership.
