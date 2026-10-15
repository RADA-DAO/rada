# Migrations

Forward-only PostgreSQL 17 SQL, applied with `npm run db:migrate` using `psql`.
Use standard libpq environment variables (`PGHOST`, `PGPORT`, `PGUSER`,
`PGDATABASE`, `PGPASSWORD` or a password file). Never commit credentials.
The migration connection needs permission to create schemas and roles, and to
assume the schema owner role. Do not use this credential at runtime.

Sources live in `modules/<owner>/db/migrations/`. The runner discovers module
directories in deterministic order and applies files in global version order.
Ledger names and checksums are independent of source paths. An optional flat
directory argument remains available for isolated negative fixtures.

Name files `NNNN_description.sql`; never edit or remove applied files. Files run
in one serialized transaction and must not contain transaction control or psql
commands. The runner rejects checksum changes, removed files and insertion before
an applied version. Failed batches leave no partial schema or ledger writes.

Run `npm run test:db` against a **fresh disposable** PostgreSQL 17 database. It
applies migrations twice, tests identity constraints and isolation with synthetic
fixtures, and checks rejection of altered or missing migrations. Fixture writes
roll back. `PG_CONTAINER` optionally runs `psql` through `docker exec` for an
isolated local container. Remove that disposable container after verification.

See [identity interface](../README.md) and [migration ADR](../../docs/adr/0002-sql-migrations.md).
