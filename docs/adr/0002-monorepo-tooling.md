# ADR 0002: Monorepo tooling and layout

- Status: Accepted (2026-09-29)
- Task: platform-foundation
- Source: [architecture Q2](../../memory-bank/creative/platform-foundation-architecture.md)

## Context

Three packages (web, api, shared) and a background worker. The question was whether a task-graph tool (Turborepo, Nx) is justified, and whether the worker is its own app.

## Decision

pnpm 10 workspaces only, run through Corepack. Layout: `apps/web`, `apps/api` (with the worker as `src/worker.ts`, same image, different command) and `packages/shared` (`@sgm/shared`, a just-in-time package: `exports` points at source, consumed by Next.js through `transpilePackages` and bundled into the api by tsup). Tailwind v4 uses CSS-first config. All root commands run as `pnpm run <target>`.

## Consequences

- No remote build cache; CI re-runs everything (well inside the 10-minute budget). Turborepo can be added later without breaking changes.
- One backend codebase and one Dockerfile; no cross-app imports.
- No `apps/worker` directory and no `tailwind.config.ts`.
