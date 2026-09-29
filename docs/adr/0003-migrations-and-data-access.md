# ADR 0003: Migrations tool, data-access layer and PostgreSQL 17

- Status: Accepted (2026-09-29)
- Task: platform-foundation
- Source: [architecture Q3](../../memory-bank/creative/platform-foundation-architecture.md)

## Context

The schema needs real down migrations, CHECK constraints, triggers and plpgsql functions (invoice numbering, session instants, guest-count guard). ORM-coupled tools handle those poorly. The database version is fixed by the task: **PostgreSQL 17** everywhere (Compose service `postgres:17`, CI service container, `SELECT version()` starts with `PostgreSQL 17.`, database time UTC).

## Decision

node-pg-migrate with plain-SQL migration files (`-- Up Migration` / `-- Down Migration`) in `db/migrations/`, Kysely over node-postgres (`pg`) for data access, and kysely-codegen for types. The generated `apps/api/src/lib/db/types.generated.ts` is committed and drift-checked in `test:integration`. Every difference from `database-design.md` is listed in `db/schema-deviations.md` and checked by a conformance test.

## Consequences

- SQL, including every down section, is written by hand; there is no schema DSL. The deviations ledger and conformance test compensate.
- One driver serves Kysely, pg-boss, node-pg-migrate and OpenTelemetry.
- Codegen needs a migrated database, which `test:integration` already provides.
