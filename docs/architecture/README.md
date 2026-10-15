# Architecture

One platform with a shared backend and database, organized into modules with
explicit boundaries. Applications use platform services through the SDK; a module
never writes to another module's tables.

| Path              | Purpose                                            |
| ----------------- | -------------------------------------------------- |
| `apps/miniapp`    | Telegram Mini App shell                            |
| `apps/api`        | Backend                                            |
| `apps/bot`        | Telegram entry point                               |
| `apps/workers`    | Background jobs                                    |
| `apps/ai-gateway` | AI provider access and budgets                     |
| `apps/builder`    | Isolated build pipeline for community applications |
| `modules`         | Feature modules                                    |
| `packages`        | UI library, platform SDK, localization             |
| `db/migrations`   | Database migration history                         |
| `infra`           | Infrastructure as code                             |

Decisions are recorded in [ADRs](../adr/README.md).
