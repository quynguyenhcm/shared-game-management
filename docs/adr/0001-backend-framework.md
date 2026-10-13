# ADR 0001: Backend framework

- Status: Accepted (2026-09-29)
- Task: platform-foundation
- Source: [architecture Q1](../../memory-bank/creative/platform-foundation-architecture.md)

## Context

The backend must share types and validation with a Next.js web app, be maintainable by one developer, and provide structured logging for the observability standard. Candidates were Node with NestJS, Node with Fastify, and Python FastAPI. The integrated stack comparison scored the lean TypeScript option highest (Q1 weighted score 4.50).

## Decision

Node 24 LTS, TypeScript (strict) and Fastify 5, with zod contracts through `fastify-type-provider-zod` and `@fastify/swagger` generating `apps/api/openapi.yaml`. The worker is a second entrypoint of the same codebase (see [ADR 0002](0002-monorepo-tooling.md)). The database is PostgreSQL 17 (see [ADR 0003](0003-migrations-and-data-access.md)).

## Consequences

- TypeScript types and zod schemas are shared with the web app directly; pino is built in.
- There is no framework-imposed module or DI system. The feature-plugin convention (`src/modules/<feature>/{routes,service,repo}.ts`, explicit `buildApp(deps)` injection) is recorded in `memory-bank/systemPatterns.md`.
- Money needs an explicit decimal strategy ([ADR 0009](0009-money.md)).
