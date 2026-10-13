# ADR 0009: Money representation and rounding

- Status: Accepted (2026-09-29)
- Task: platform-foundation
- Source: [algorithm Q6](../../memory-bank/creative/platform-foundation-algorithm.md)

## Context

Money is stored and moved by billing, wallet and GST logic. Floating point is unacceptable. Options were `NUMERIC(10,2)` with a decimal library, `BIGINT` cents, a hybrid, and JS `number` cents.

## Decision

`NUMERIC(10,2)` in the database, a 2-decimal string on the wire (`MoneyString`) and branded `bigint` cents in TypeScript (`Money`). Rounding is HALF_UP (identical to PostgreSQL `round(numeric, s)`); the rate suggestion is CEIL to whole dollars. HALF_EVEN is deliberately not offered.

## Consequences

- Zero dependencies in the browser bundle; mixing `Money` with `number` fails at compile time and at runtime, and `JSON.stringify` refuses `bigint`.
- Two representations exist; conversion lives only in the money module, repositories and zod schemas.
- `bigint` cannot be a React Server Component prop, so `MoneyString` crosses every serialisation boundary.
