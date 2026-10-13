# ADR 0007: Hosting constraints

- Status: Accepted (2026-09-29)
- Task: platform-foundation
- Source: [architecture Q10](../../memory-bank/creative/platform-foundation-architecture.md)

## Context

Hosting is decided by a later feature, but the foundation must not make choices that block viable hosts.

## Decision

Binding constraints C1 to C6: long-lived containers for api and worker (scheduler runs in the worker); managed PostgreSQL 17 in AU or NZ with TLS required in production; migrations as a release command (never at boot); secrets from the platform secret store; TLS at the edge; web as a Next.js standalone container. DigitalOcean App Platform (Sydney) with Managed PostgreSQL is the provisional vendor, to be re-verified at deployment.

## Consequences

- Serverless-only hosts are excluded for api and worker.
- The config validator enforces `sslmode` in production.
- Vendor facts (regions, PG17 availability) must be re-checked when deployment is planned.
