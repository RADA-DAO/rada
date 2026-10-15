# ADR 0001: Platform foundation

## Context

RADA needs a foundation that supports platform services and independently owned
feature modules while keeping development, operations, and data handling
understandable. Applications need a consistent contract for identity, access,
localization, and testing.

## Decision

Use a single monorepo for platform applications, packages, modules, database
migrations, and infrastructure. Organize features as modules with explicit
interfaces; a module accesses its own data through its service boundary and
does not write to another module's tables.

Use one PostgreSQL database with schemas for platform and feature modules.
Database roles and service APIs enforce module boundaries. Platform services
own cross-cutting capabilities and authority, including identity, authorization,
governance, and shared operations. Official applications use those services
through the platform contract. Community applications receive only the
capabilities explicitly granted to them; application origin or presentation
does not confer platform authority.

The supported interface locales are English (`en`) and Ukrainian (`uk`). User
facing text is supplied through localization resources.

Use a staged verification path: local development with synthetic fixtures, CI,
staging, then production. Staging contains synthetic data only. Production
promotion requires human approval and verification of the release artifact and
its data changes.

Treat legacy data explicitly as one of three outcomes: transfer into an active
module, retain as a restricted read-only archive, or leave with the legacy
system. Every transfer uses a consistent source snapshot and documented
source-to-target mapping. Reconcile the complete agreed scope, including
records, relationships, ownership, event history, and exact monetary amounts;
unexplained differences block completion.

## Consequences

The monorepo and shared database simplify local setup and coordinated changes,
while requiring clear module APIs, schema ownership, and database permissions.
Platform authority remains centralized in platform services; official and
community applications cannot create authority by bypassing those services.
Localization resources and synthetic staging data make interface and release
checks repeatable. Data transfers require explicit mappings and full-scope
reconciliation, while archived and legacy data remain outside active module
behavior until separately adopted.
