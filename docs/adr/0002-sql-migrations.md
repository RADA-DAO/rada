# ADR 0002: SQL migrations

## Context

The platform needs reproducible schema changes and database access boundaries
before application services begin writing data.

## Decision

Use numbered, forward-only SQL files and a small Node.js runner invoking `psql`.
One transaction and an advisory lock serialize the complete migration batch.
A restricted ledger records each filename and SHA-256 checksum. Missing, changed,
or out-of-order applied files fail verification. Migration files must contain
transactional DDL without transaction control or psql commands. Fixes use new files.

Separate the migration credential from runtime credentials. Identity has a
non-login owner, authentication, service, and operator roles. Runtime roles have
no ownership or membership in each other. Forced RLS restricts service reads and
consent writes to the authenticated subject. Only authentication can resolve a
verified Telegram identity; only the operator can grant or revoke roles.

## Consequences

No migration framework dependency is needed; Node.js and PostgreSQL 17 `psql`
are required. Deployments must provision role memberships explicitly, with no
runtime membership in the owner or migration role. Transactional batches cannot
use operations such as concurrent index creation. CI exercises a fresh real
PostgreSQL 17 database, repeat runs, checksum rejection, and authorization denial.
