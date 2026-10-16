# Architecture

One platform with a shared backend and database, organized into modules with
explicit boundaries. Applications use platform services through the SDK; a module
never writes to another module's tables.

| Path                      | Purpose                                                       |
| ------------------------- | ------------------------------------------------------------- |
| `apps/miniapp`            | Telegram Mini App shell                                       |
| `apps/api`                | HTTP middleware, authentication policy and module composition |
| `apps/bot`                | Telegram entry point                                          |
| `apps/workers`            | Background jobs                                               |
| `apps/ai-gateway`         | AI provider access and budgets                                |
| `apps/builder`            | Isolated build pipeline for community applications            |
| `modules`                 | Feature modules                                               |
| `packages`                | UI library, platform SDK, localization                        |
| `modules/*/db/migrations` | Database migration history                                    |
| `infra`                   | Infrastructure as code                                        |

Decisions are recorded in [ADRs](../adr/README.md).

Modules expose cross-domain operations through their public `index.ts` and
owned SQL functions or views. New runtime SQL and migrations must not access
another module's tables directly. The initial 0001–0003 migrations are immutable
historical snapshots, including their existing foreign keys, grants and transfer
coordination; the architecture check verifies their exact hashes.

Public SQL views must be declared as a literal `SQL_PUBLIC_VIEWS` array in the
owner's public `index.ts`, with a matching owned `CREATE VIEW` definition.

The design gate scans runtime `apps/` and `modules/` source with the TypeScript
syntax tree. Colors and dimensions (`px`, `rem`, `em`) must reference UI tokens;
font and spacing numeric constants are rejected too. Local stylesheets, style
injection and foreign CSS imports are forbidden. The only public stylesheet is
`@rada/ui/design-system.css`; `@rada/ui` is the public TypeScript entrypoint.
Private paths, traversal and other `@rada/*` aliases remain forbidden.

Gesture event listeners, event properties, JSX handlers and direct browser
`history.back()` calls belong to the platform SDK. Tests, fixtures and generated
paths are exempt; UI and SDK implementation lives outside the scanned runtime
roots. URL fragments, SQL text, protocol identifiers and comments are not treated
as UI colors. Token references and controller state such as `hidden` or `display`
remain supported. The gate is a static check of source syntax, not a runtime
sandbox for dynamically assembled code.
