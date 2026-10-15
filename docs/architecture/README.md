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
