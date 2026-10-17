# Local infrastructure

[local.yaml](local.yaml) runs PostgreSQL 17 on an internal Docker network without
published ports. Credentials come from the root `.env` (see `.env.example`).

See the [staging runbook](STAGING.md) for the separate, default-off deployment.

See [verified backups](BACKUPS.md) for daily encrypted database recovery.
