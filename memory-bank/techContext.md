# Technology Context

## Technology Stack

### Runtime Environment
- **Node.js**: 24 LTS (>=24 <25) — JavaScript runtime for API, worker, and CLI
- **pnpm**: 10.34.6 — fast, workspace-aware package manager
- **TypeScript**: 5.9.3 (strict: true) — type safety across entire codebase
- **Docker Compose**: PostgreSQL 17, Mailpit for local development

### Languages & Frameworks
- **Backend Framework**: Fastify 5.12.5 — lightweight REST API with JSON-schema validation via `fastify-type-provider-zod`
- **Frontend Framework**: Next.js 16.3.6 — React 19.3.0 with App Router and server components
- **Styling**: Tailwind CSS v4.3.3 — CSS-first config (`@tailwindcss/postcss`), no `tailwind.config.ts`
- **Type Validation**: zod 4.6.5 — runtime schema validation for API contracts and env config

### Data Layer
- **Primary Database**: PostgreSQL 17 (community support until November 2029)
  - Migrations: node-pg-migrate 9.0.0 — hand-written reversible SQL files (`-- Up Migration` / `-- Down Migration`)
  - **Query Builder**: Kysely 0.29.6 — typed SQL query builder with explicit transaction control
  - **Code Generation**: kysely-codegen 0.20.0 — DB introspection generates `types.generated.ts` (committed, drift-checked)
  - **Driver**: pg (node-postgres) 8.23.0 — shared by Kysely, pg-boss, node-pg-migrate, and OTel instrumentation
- **Job Store**: PostgreSQL (pg-boss schema) — no Redis; jobs, schedules, and failed states live in the database

### Background Jobs & Scheduling
- **Job Runner**: pg-boss 12.35.0
  - Scheduling with Pacific/Auckland timezone via `tz: 'Pacific/Auckland'`
  - Retry strategy: `retryLimit: 3`, `retryDelay: 5s`, `retryBackoff: true` (exponential)
  - Deduplication via `singletonKey` (concurrent duplicates removed; handler must be idempotent for at-least-once delivery)
  - Visibility: job state in SQL (`pgboss.job`, `pgboss.archive`); visible failure tracking
  - **`member-banned` queue** (team-management): policy `exclusive`, `singletonKey = member-banned:<membershipId>`, id-only payload, 7-day retention. Its handler is a no-op until registration-and-waitlist injects the real one via `registerJobs({ memberBannedHandler })`; a permanent failure is logged as `team.member.banned.hook_failed` and re-run with `cli jobs trigger member-banned` (ADR 0015)
  - **Session queues** (session-scheduling-engine, ADR 0019): `recurrence-materialisation` (slot `0 3 * * *` Pacific/Auckland, `exclusive`, also enqueued at every worker boot), `recurrence-rule` (policy `stately`, `singletonKey = recurrence-rule:<ruleId>`, one queued and one active run per series), and `session-auto-enrol` (`exclusive`, `singletonKey = session-auto-enrol:<sessionId>`). Manual runs: `cli jobs trigger recurrence-rule '<json>'` and `cli jobs trigger session-auto-enrol '<json>'`

### API & Communication
- **REST API**: Fastify 5 with zod type provider
  - **Swagger/OpenAPI**: generated to `apps/api/openapi.yaml` via `@fastify/swagger` 9.5.1
  - **Routes**: `apps/api/src/routes/` and per-module `apps/api/src/modules/<feature>/routes.ts`
  - Health check: `GET /health` returns JSON with database connectivity
- **Protocols**: HTTP/HTTPS (web → api); pg wire (api/worker → PostgreSQL); SMTP (worker → Mailpit dev / Postmark prod)
- **Trace Context**: W3C Trace Context (`traceparent`/`tracestate` headers) injected by Next.js and propagated through Fastify

### Encryption & Secrets
- **At-Rest Encryption**: AES-256-GCM via `node:crypto` (no external dependency)
  - **Key material**: env-supplied keyring, key-ID-prefixed envelopes (`v1.<keyId>.<iv>.<ciphertext>.<tag>`)
  - **Encrypted columns**: `teams.bank_account_number`, `teams.bank_account_name` (written by team-banking), `teams.akahu_app_token` and `teams.ird_number` (envelope columns reserved; team-banking never writes them, R1/R2)
  - DB Guard: CHECK constraint on envelope format; corrupted ciphertext fails on decryption with typed error
- **Environment Secrets**: 12-factor config via `.env`, validated by zod at boot with fail-fast on invalid values
- **Credential Redaction**: pino redaction patterns ban logging `authorization`, `cookie`, `set-cookie`, any key ending in `token` (snake or camelCase, e.g. `pendingToken`), `sgm_session|pending|oauth|flash`, `client_secret`, `code_verifier`, `x-sgm-internal-auth`, `x-sgm-client-ip`, `x-pending-signup`, `bank_account_*`, `ird_number`, `akahu_*`, the anchored camelCase and snake_case banking keys `/^(bank_?)?account_?(name|number)$/i` (global, so every `log.*` field name is checked for collisions first), `encryptionKeys`, team invite codes (`inviteCode`/`invite_code`, and a log field named exactly `code`); OAuth `code`/`state` query values, the `returnTo` query, and secret query parameters inside error messages are masked
  - **Redaction keys are global**: they apply to every log line in every feature, not only the feature that added them. Before adding a key, grep all `logger.*`/`log.*` calls and log assertions for that field name and rename any harmless field that collides (e.g. error codes are logged as `errorCode`, never `code`). In team-management, the exact-`code` key silently redacted `auth.oauth.link_conflict` error codes until the final review (fixed in ad7256e).
- **Authentication**: argon2id from `node:crypto` (Node >=24.7, no native addon), `jose` 6.x for Google ID-token verification, opaque Postgres sessions (SHA-256 of a 256-bit token); the web owns the session cookie and calls the API with a bearer token. Variables: `WEB_BASE_URL` (also a **build arg** of the web image), `GOOGLE_OAUTH_CLIENT_ID/_SECRET`, `FACEBOOK_OAUTH_APP_ID/_SECRET`, `AUTH_FAKE_OAUTH`, `AUTH_SESSION_*`, `AUTH_RESET_TOKEN_MINUTES`, `AUTH_LOGIN_*`, `AUTH_FORGOT_MAX_PER_ADDRESS`, `AUTH_REGISTER_MAX_PER_ADDRESS`, `API_INTERNAL_SHARED_SECRET`, `WEB_TRUSTED_PROXY_HOPS` (see `docs/getting-started.md`)
  - **Compose internal secret**: `docker-compose.yml` uses its own local-only default (`COMPOSE_API_INTERNAL_SHARED_SECRET`). It is for local stacks only; production validation does **not** yet refuse it (open pre-release item, final-review minor 8).
- **Job payloads**: secret-bearing emails (password reset) are sealed with FieldCrypto before they reach `pgboss.job`; the worker builds `crypto` from the same keyring.

### Logging & Observability
- **Logging**: pino 10.3.1 (structured JSON)
  - **Integration**: Fastify uses the same pino instance via `createLogger` wrapper
  - **Format**: camelCase JSON with `timestamp`, `level`, `message`, `service` (`api` | `worker`), `traceId`, `spanId`, `jobId`, `queue`
  - **Configuration**: `LOG_LEVEL` (default `info`), `LOG_FORMAT` (`json` | `text` for pretty printing in dev), `LOG_OUTPUT` (`stdout` | `file` | `both`), `LOG_FILE_PATH`
- **Distributed Tracing**: OpenTelemetry tracing SDK (`@opentelemetry/sdk-trace-node` `NodeTracerProvider`, AsyncLocalStorage context manager, W3C TraceContext propagator from `@opentelemetry/core`) started by `apps/api/src/lib/telemetry/telemetry.ts`
  - Loader: `node --import ./dist/instrumentation.js` (compose) / `tsx watch --import ./src/instrumentation.ts` (`pnpm run dev`) for both api and worker; service name `sgm-api` / `sgm-worker` unless `OTEL_SERVICE_NAME` is set
  - **Instrumentation wired**: `@fastify/otel` only (request + handler spans, `instrumentHooks: false`, continues an incoming `traceparent`). **Not wired**: `@opentelemetry/instrumentation-pg`, http/undici (they need ESM loader hooks); the web app registers no SDK
  - **Default exporter**: none (spans are created, never exported); `console` via `OTEL_TRACES_EXPORTER=console`; OTLP/HTTP (`@opentelemetry/exporter-trace-otlp-http`) only when `OTEL_EXPORTER_OTLP_ENDPOINT` is set (validated as an http(s) URL; `OTEL_TRACES_EXPORTER=otlp` without it is a config error). `OTEL_SDK_DISABLED=true` registers nothing
  - **Sampler**: `OTEL_TRACES_SAMPLER` (validated enum, default `parentbased_traceidratio`) with `OTEL_TRACES_SAMPLER_ARG` (1.0 default; 0.1 in prod at deployment)
  - **Propagation**: web `api-client.ts` sends `traceparent` on every server-side API call (active span, else the incoming request's trace, else a new root); Fastify request logs bind `traceId`/`spanId`; `jobs.enqueue` writes the active trace to `payload._meta.traceparent`; the worker restores it as the parent of a `"{queue} process"` CONSUMER span, and a pino mixin adds `traceId`/`spanId` to every log line inside it
  - Spans buffered by the OTLP batch processor are not flushed on SIGTERM (known gap)
- **Metrics**: configuration variables only (`METRICS_ENABLED`, `METRICS_PORT`, `METRICS_PATH`, default off); no exporter or custom metrics are implemented in the foundation

### External Services
- **Email**: SMTP adapter for Mailpit (dev/CI) or Postmark (prod, likely)
  - **Provider contract**: idempotency keys, low-cardinality tags, typed error semantics (transient vs permanent)
  - No integration built in foundation; adapter contract stable for downstream billing features
- **Google OAuth 2.0 / OpenID Connect** and **Facebook Login** (Graph API, pinned `v26.0`, refresh within two years): sign-in providers; credentials in env, setup steps in `docs/getting-started.md`. A manual real-credentials smoke test is a pre-release item (CI uses recorded fixtures and the fake provider).
- **Akahu** (Open Banking, NZ): arrives in wallet-and-akahu-billing phase; crypto and job primitives already in place. Platform Akahu credentials are owned by wallet-and-akahu-billing (server configuration). team-banking stores no Akahu credentials per team: `teams.akahu_merchant_id` and `teams.akahu_app_token` are reserved and never read or written by this feature, and no Akahu client exists yet. "Configured" means the bank account is present and passes the NZ checks; no Akahu call is made at save time.
- **NZ validators** (`packages/shared/src/nz/`): `bank-account.ts` (bank ID table and weighted modulus, no branch ranges), `ird-number.ts` (range 10,000,000 to 200,000,000 inclusive; secondary weights only when the primary result is 10), `gst.ts` (`GST_RATE_BPS = 1500`, the single GST rate constant). Source: IRD *Payroll Calculations & Business Rules Specification 2026-27* (s7). Tables are reviewed every April, when IRD republishes the specification (ADR 0016).

### Development Tools
- **Build**: tsup 8.5.1 (esbuild) for API/worker bundling
- **Testing**: vitest 5.0.2
  - **Unit tests**: `**/*.test.ts` (no DB, no network, Node environment)
  - **Integration tests**: `**/*.int.test.ts` against real PostgreSQL 17 (forks pool, SKIP LOCKED job polling)
  - **Coverage provider**: v8, threshold 80% for money/time/invoice/auth shared code, the api platform libraries, `apps/api/src/modules/auth/**` and `apps/web/src/lib/**`; measured over unit and integration tests together (`pnpm run test:coverage`)
  - **E2E tests**: Playwright 1.63.0 (`apps/web/e2e/smoke.spec.ts`, `auth.spec.ts`, `teams.spec.ts`) on a desktop and a 360 x 740 project, `@axe-core/playwright` for accessibility scans; needs the Compose stack with `AUTH_FAKE_OAUTH=true` and Chromium (`playwright install chromium`)
  - **Team journeys** (`teams.spec.ts`): run against a production `next start` build, with the worker running so the `member-banned` queue is drained. Not part of `pnpm run ci`
  - **Banking journeys** (`apps/web/e2e/team-banking.spec.ts`, 7 journeys per project, 14/14 passing): desktop and 360 x 740 with axe. Like the team journeys, it is not part of `pnpm run ci`. It runs natively against a temporary database with the API, the worker and a production `next start` (`AUTH_FAKE_OAUTH=true`); seeding (a published paid session, a failed payout, an unreadable saved name) needs the stack's database URL in `E2E_DATABASE_URL`, and those journeys are skipped without it. Recipe:
    1. Create and migrate a temporary database (`pnpm run db:migrate` with `DATABASE_URL` pointing at it, a generated `ENCRYPTION_KEYS`, and `ENCRYPTION_ACTIVE_KEY_ID`).
    2. Start the API (`tsx src/main.ts`), the worker (`tsx src/worker.ts`) and `next build && next start -p 3000`, with `AUTH_FAKE_OAUTH=true`, `WEB_BASE_URL=http://localhost:3000`, `API_INTERNAL_URL=http://localhost:4000`, a 32+ character `API_INTERNAL_SHARED_SECRET` and `WEB_TRUSTED_PROXY_HOPS=0`.
    3. Run `E2E_DATABASE_URL=<that database> pnpm run test:e2e apps/web/e2e/team-banking.spec.ts`.
    4. Re-run it after any change to the banking or GST page.
- **Linting & Formatting**: ESLint 9.39.5 + TypeScript support, Prettier 3.9.9
  - **Type checking**: `tsc --noEmit` strict mode (no `any`, explicit return types)
  - **Code quality**: `no-console` error in `apps/api/src` (except `cli.ts`); bans on unsafe money operations (parseFloat, toFixed); host-TZ independence rules in `packages/shared/src/time/`
- **macOS tooling**: macOS has no GNU `timeout`. Scripts and agent wrappers that need one should use `gtimeout` (`brew install coreutils`) or call the tool directly; the Codex companion works when invoked without `timeout`. In session-scheduling-engine the per-phase Codex reviews for Phases 3–6 were silently lost to this.
- **CI/CD**: GitHub Actions (`.github/workflows/ci.yml`), PostgreSQL 17 service container, 10-minute budget

## Component Structure

| Component | Type | Purpose | Key Subdirectories/Files |
|-----------|------|---------|--------------------------|
| `apps/web` | Next.js App Router | Player and admin UI | `src/app/`, `src/components/`, `src/lib/api-client.ts` (typed Fetch wrapper with `traceparent` injection), `e2e/` (Playwright smoke tests) |
| `apps/api` | Fastify service | REST API and job orchestration | `src/main.ts` (HTTP process), `src/worker.ts` (background worker), `src/cli.ts` (operator CLI: migrations, job triggers), `src/instrumentation.ts` (OTel setup) |
| `apps/api/src/lib` | Server platform library | Shared infrastructure for API and worker | `config/` (zod env validation, fail-fast), `db/` (pg Pool, Kysely wrapper, migrations), `logger/` (pino setup, redaction), `crypto/` (AES-256-GCM keyring), `notifications/` (Notifier abstraction, adapters), `jobs/` (pg-boss wrapper, handler registry) |
| `apps/api/src/modules` | Feature modules | Domain logic and handlers | One dir per feature; `<feature>/{routes.ts, service.ts, repo.ts}` convention (established for future features). `teams/` holds the membership state machine (`transitions.ts`), invite codes, the approved-member gate (`membership.ts`), the ban port (`ban-hook.ts`) and the shared admin lock helpers (`admin-lock.ts`). `team-banking/` holds the banking and GST routes, the publish gate (`publish-gate.ts`) and the error mapping (`errors.ts`) |
| `apps/api/src/routes` | HTTP handlers | Request/response handlers `health.ts` (GET /health); cross-cutting routes land here, feature routes in modules |
| `apps/api/src/jobs` | Job handlers | Background job implementations | `registry.ts` (queues), `schedules.ts` (cron slots), `bootstrap.ts`, `heartbeat.ts`, `send-email.ts`; billing/recurrence handlers are no-op placeholders until their features |
| `apps/api/test` | Integration test harness | Real-DB test environment | `global-setup.ts` (migrations, pg-boss setup), `integration/` (*.int.test.ts files with real connections) |
| `packages/shared` | Isomorphic library | Domain contracts, primitives, and enums | `src/index.ts` (main export), `src/api/` (zod schemas for HTTP contracts), `src/money/` (Money type, decimal arithmetic), `src/time/` (Pacific/Auckland helpers), `src/invoice/` (invoice types), `src/types/` (domain enums) |
| `db` | Schema & migrations | PostgreSQL source of record | `migrations/` (node-pg-migrate SQL files, one transaction each), `schema-deviations.md` (deviation record with AC cites) |
| `scripts` | Build/setup helpers | Development automation | `setup.ts` (generates dev `.env`, copies `.env.example` → `.env`), `root-targets.test.ts` (verifies all root scripts exist) |
| `docs` | Developer documentation | Setup and architecture | `getting-started.md` (local dev walkthrough, encryption key rotation runbook), `adr/` (architecture decision records) |
| `.github/workflows` | CI configuration | GitHub Actions pipeline | `ci.yml` (lint, typecheck, test, integration, build; PostgreSQL 17 service container) |

## Development Commands

All commands are run from the repository root as `pnpm run <target>` (note: `pnpm setup` and `pnpm ci` are pnpm built-ins; the custom script names are the targets below).

| Target | Command | Purpose |
|--------|---------|---------|
| `setup` | `corepack enable && pnpm install --frozen-lockfile && tsx scripts/setup.ts` | Initial setup: enable corepack, install deps, copy `.env.example` → `.env`, generate dev encryption key |
| `dev` | `docker compose up -d --wait postgres mailpit && pnpm run db:migrate && pnpm -r --parallel --filter "./apps/*" dev` | Start local stack (Postgres, Mailpit), run migrations, start Next.js dev server and API dev server in parallel |
| `lint` | `eslint . --max-warnings 0 && prettier --check .` | Check code style, fail on any ESLint warning or format violation |
| `typecheck` | `pnpm -r --include-workspace-root --workspace-concurrency=4 exec tsc --noEmit -p tsconfig.json` | Type-check all packages with strict mode, run in parallel (4 at a time) |
| `test` | `vitest run --project unit` | Run unit tests (*.test.ts, no DB); the fast loop, no coverage |
| `test:coverage` | `vitest run --coverage` | Run unit and integration tests together and enforce the 80% coverage gate (the DB-backed auth code is covered by integration tests); needs the Compose `postgres` |
| `test:integration` | `vitest run --project integration` | Run integration tests (*.int.test.ts) against real PostgreSQL 17, 30-second timeout, fork pool isolation |
| `db:migrate` | `pnpm --filter @sgm/api exec tsx --env-file-if-exists=../../.env src/cli.ts db migrate` | Apply pending migrations (node-pg-migrate), then install/upgrade pgboss schema |
| `db:rollback` | `pnpm --filter @sgm/api exec tsx --env-file-if-exists=../../.env src/cli.ts db rollback` | Roll back one migration step (or `-- --count N` for multiple, `-- --all` to zero) |
| `db:reset` | `pnpm --filter @sgm/api exec tsx --env-file-if-exists=../../.env src/cli.ts db reset` | Drop public and pgboss schemas, re-migrate from scratch; refuses if `NODE_ENV=production` |
| `db:new` | `pnpm --filter @sgm/api exec node-pg-migrate create --migration-file-language sql --migration-filename-format utc -m ../../db/migrations` | Generate a new timestamped SQL migration file in `db/migrations/` |
| `db:codegen` | `pnpm --filter @sgm/api exec node --env-file-if-exists=../../.env node_modules/kysely-codegen/dist/cli/bin.js` | Introspect migrated PostgreSQL and regenerate `apps/api/src/lib/db/types.generated.ts` |
| `build` | `pnpm -r build` | Build all packages: Next.js standalone output (web), tsup bundle (api, outputs `dist/{main,worker,cli,instrumentation}.js`) |
| `openapi` | `pnpm --filter @sgm/api exec tsx src/openapi.ts > apps/api/openapi.yaml` | Generate OpenAPI spec from Fastify router |
| `jobs:trigger` | `pnpm --filter @sgm/api exec tsx --env-file-if-exists=../../.env src/cli.ts jobs trigger <slot>` | Manually trigger a scheduled job (e.g., `jobs:trigger recurrence-materialisation`) |
| `test:e2e` | `playwright test -c apps/web/playwright.config.ts` | Run the Playwright journeys (requires the Compose stack: `AUTH_FAKE_OAUTH=true docker compose up -d --build --wait`); not part of `ci` |
| `ci` | `pnpm run lint && pnpm run typecheck && pnpm run test:coverage && pnpm run build` | Full CI pipeline: lint, type-check, unit + integration tests with the coverage gate, build; must all pass |

## Test Strategy

### Test Organization

| Scope | Location | Pattern | Framework | Environment |
|-------|----------|---------|-----------|-------------|
| **Unit** | co-located with source, `src/**/*.test.ts` | One test file per module; shallow describe blocks | vitest 5 | Node, no DB, no network |
| **Integration** | `apps/api/test/integration/**/*.int.test.ts` | Feature or service-level scenarios | vitest 5 | Node, real PostgreSQL 17, fork pool |
| **E2E** | `apps/web/e2e/**/*.spec.ts` | Smoke tests (health check, homepage load) | Playwright 1.63.0 | Browser, full stack running |

### Unit Testing Specifics
- **Naming**: `*.test.ts` (not `.spec.ts`); vitest discovers them automatically
- **Isolation**: unit tests share vitest's default worker pool, and state is kept per test via factories. Only the integration project sets `pool: 'forks'`, and each integration test file gets its own database cloned from a template.
- **Scope**: Test logic, algorithms, validation rules, and error paths; no DB, no HTTP mocking
- **Mocking**: Dependency injection via function parameters; test doubles for adapters (e.g., in-memory Notifier for email tests)
- **Assertion style**: `expect(value).toBe(expected)`, `expect(fn).toThrow(Error)`, etc.
- **Fixtures**: Shared setup via `describe.each()` or factory functions; no global `beforeAll` for state

### Integration Testing Specifics
- **Naming**: `*.int.test.ts`; run in a separate vitest project
- **Database**: Real PostgreSQL 17 database (created fresh by `global-setup.ts`)
  - Migrations run once per test run into a template database
  - Each test file gets its own database cloned from the migrated template (`createTestDatabase()`), so tests may COMMIT
  - `SKIP LOCKED` polling for job tests (pg-boss behavior)
- **Scope**: End-to-end workflows (enqueue → fetch → process → verify), migration safety, constraint enforcement, enum parity with code
- **Timeout**: 30 seconds per test, 60 seconds for hooks
- **Example**: `apps/api/test/integration/jobs.int.test.ts` verifies pg-boss schedule firing and idempotency
- **Environment**: integration runs, `db:migrate` and `test:coverage` read `.env` (created by `pnpm run setup`). In a checkout without `.env`, pass the variables inline: `DATABASE_URL=postgres://sgm:sgm@localhost:5432/sgm ENCRYPTION_KEYS="dev1:<base64 of 32 random bytes>" ENCRYPTION_ACTIVE_KEY_ID=dev1 API_INTERNAL_SHARED_SECRET=<32+ chars>`.
- **Load-sensitive tests**: the DST/schedule unit tests and the pg-boss `previewSchedule` integration checks (1000 ms) can time out when other heavy processes share the CPU (e.g. parallel agents). If only those time out, re-run the failing files sequentially on a quiet machine before treating it as a regression.

### Coverage & Quality Gates

| Module | Target | Notes |
|--------|--------|-------|
| `packages/shared/src/money/**` | 80% | Decimal arithmetic, rounding, formatting |
| `packages/shared/src/time/**` | 80% | Pacific/Auckland conversion, DST safety |
| `packages/shared/src/invoice/**` | 80% | Invoice type logic |
| `apps/api/src/lib/crypto/**` | 80% | Encryption, decryption, key rotation |
| `apps/api/src/lib/notifications/**` | 80% | Notifier adapter contract, error types |
| `apps/api/src/lib/jobs/**` | 80% | pg-boss wrapper, schedule safety |
| `apps/api/src/lib/config/**` | 80% | Env validation, fail-fast |
| `apps/api/src/lib/db/**` | Integration only | Tested via `test:integration` |
| `apps/api/src/lib/{logger,telemetry,http,auth}/**`, `apps/api/src/lib/clock.ts` | 80% | Redaction, trace context, error mapper, Origin and internal-auth hooks, route policy and guards |
| `packages/shared/src/auth/**` | 80% | Email normalisation, `safeReturnTo`, OAuth binding codec |
| `apps/api/src/modules/auth/**` | 80% | Auth services, repo, sessions, throttle, providers (mostly through integration tests) |
| `apps/web/src/lib/**` | 80% | Web config, api-client, auth actions, cookies, landing and messages |
| `apps/api/src/modules/team-banking/**` | 80% | Banking routes, service, publish gate (added by team-banking-and-gst) |
| `packages/shared/src/nz/**` | 80% | NZ bank-account, IRD and GST validators |
| Other modules, generated types | Not required | Coverage gate applies only to listed modules |

Coverage is checked via `vitest run --coverage` (`pnpm run test:coverage`, both projects) with the v8 provider; thresholds are `lines: 80, functions: 80, branches: 80, statements: 80`. Unit tests alone cover about 76% of the listed files because the DB-backed auth services are exercised by the integration project.

### What Is NOT Tested

- **Type definitions** (`*.d.ts`, `types.generated.ts`) — shape and accuracy verified by tsc
- **Framework boilerplate** (Next.js page components, Fastify lifecycle hooks) — tested via E2E
- **Generated OpenAPI spec** — verified by human review and `@fastify/swagger` internal tests
- **Migration reversibility** is covered by `schema.int.test.ts` (migrate, rollback --all, migrate; identical schema)
- **Job handler business logic** — tested via integration tests that enqueue and process real jobs
- **External adapters** (Postmark, Akahu) — mocked in unit tests; integration with real services in later features (wallet-and-akahu-billing)

### Test Execution in CI

The `.github/workflows/ci.yml` runs:
1. `pnpm run lint` — ESLint and Prettier on all files
2. `pnpm run typecheck` — TypeScript strict mode
3. `pnpm run test:coverage` — Unit and integration tests (real Postgres 17 service container) with the coverage gate
4. `pnpm run build` — Full build (web and api)

(`pnpm run ci` runs these four in order; `pnpm run test` and `pnpm run test:integration` remain for a single project.)

Total time: ~5 min (varies with cache and Postgres startup). Each step must exit 0 for the job to pass.

## Recent Technology Changes

### 2026-10-20 - Session scheduling engine (session-scheduling-engine)
- **What Changed**: no new libraries or infrastructure. Migration `20261020000100000` (ledger D-70 to D-83 and D-85): series anchor and court template, optimistic-concurrency `version`, lifecycle and immutability triggers, the 48 hour default deadline, content CHECKs and the fee-raise lock. New env var `RECURRENCE_HORIZON_DAYS` (7 to 91, default 28, read by api and worker). Three new pg-boss queues (see Background Jobs & Scheduling).
- **Reason**: sessions and recurring series need a horizon-based materialiser that runs in the worker, and database-enforced rules for completed and closed sessions (`docs/adr/0019-session-scheduling-engine.md`).
- **Impact**: the sweep and boot sweep need a running worker to create series sessions. The `game_sessions` triggers run in name order (see `systemPatterns.md`). The vitest coverage gate now also covers `modules/sessions`, the session jobs, `session-allocator.ts` and `packages/shared/src/sessions`.
- **Migration Notes**: the migration was amended in place before merge. Any dev or CI database that applied the earlier draft must run `pnpm run db:reset`.

### 2026-10-16 - Team banking and GST (team-banking-and-gst)
- **What Changed**: no new libraries or infrastructure. Two migrations (`20261016000100000` invariants and generated `is_payout_configured`; `20261016000200000` change keys, D-47 to D-54). Team bank account name and number are stored through the existing `FieldCrypto`. Shared NZ validators in `packages/shared/src/nz/`. Logger redaction gained anchored banking-key patterns.
- **Reason**: payout destination and GST settings for paid sessions (ADR 0016).
- **Impact**: `is_payout_configured` is now a generated column (it cannot be written). Team inserts can briefly wait during a banking removal (`FOR UPDATE`).
- **Migration Notes**: existing partial banking blocks, GST registrations without a number, and malformed GST numbers are cleaned up in the first migration before the CHECKs validate.
