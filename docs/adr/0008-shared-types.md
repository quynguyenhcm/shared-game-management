# ADR 0008: Shared-types strategy and enum parity

- Status: Accepted (2026-09-29)
- Task: platform-foundation
- Source: [architecture Q12](../../memory-bank/creative/platform-foundation-architecture.md)

## Context

Web and api need the same enums and DTOs, and the database enums are the source of truth.

## Decision

Hand-written `as const` tuples in `packages/shared/src/types/enums.ts` (in database order) and zod DTO schemas in `packages/shared/src/api/`. Parity is enforced three ways: a runtime enum comparison against `pg_type` (`enum-parity.int.test.ts`), a compile-time `AssertEqual` against the generated types, and codegen and OpenAPI drift checks.

## Consequences

- Adding an enum value touches two files (the migration and `enums.ts`); forgetting either fails the build.
- API DTOs are shared by Fastify routes and the web client with no generator step.
