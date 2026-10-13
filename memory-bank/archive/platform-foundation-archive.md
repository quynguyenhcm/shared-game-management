# Archive: Platform Foundation

## Metadata
- Task: platform-foundation
- Complexity: Level 4 (NFR / Infrastructure)
- Status: COMPLETE (archived locally). **PR pending: push to `origin` is blocked (HTTP 403, wrong git account) and `gh` is not installed, so the PR to `main` cannot be opened yet. AC-VERIFY-4 (a real GitHub Actions run) stays open until the push works.**
- Started: 2026-09-29 (task provisioned, commit `4ab63d0`, 18:13)
- Completed: 2026-09-30 (reflection doc fixes, commit `0fee4cc`, 06:50; archive written 2026-09-30)
- Duration: 2 calendar days. The six build phases, final review and remediation ran in one session on 2026-09-29 (reflection: about 4.5 h wall-clock). No per-phase estimates were recorded, and no session logs exist, so no planned-vs-actual figures can be given.
- Roadmap Link: [platform-foundation] (v1.0.0, first of 11 features)
- Branch: `feature/platform-foundation` (25 commits ahead of local `main`; `git diff --stat main..feature/platform-foundation`: 153 files changed, 22,955 insertions, 96 deletions, which includes the spec docs and memory-bank files)
- Build mode: `/yay:build --auto`, all 6 phases, local-only (commit per phase, never pushed)

## Executive Summary

Platform Foundation is the greenfield scaffold that the other ten v1.0.0 features build on. It contains no domain logic. It delivers a pnpm monorepo (Next.js + Tailwind web, Fastify API, pg-boss worker, shared TypeScript package), a Docker Compose dev stack on PostgreSQL 17, a GitHub Actions workflow, the full PostgreSQL 17 domain schema from `database-design.md` with 26 documented deviations (D-01 to D-26), and the library modules that carry no domain rules: exact money, Pacific/Auckland time, AES-256-GCM column encryption, a notification abstraction, and a job runner. It also delivers 12 ADRs, a getting-started guide, and refreshed `techContext.md` and `systemPatterns.md`.

Outcome:
- 32 acceptance criteria (29 MUST / 3 SHOULD): **25 met, 6 met-with-deviation, 1 open** (AC-VERIFY-4). Source: AC Walk in `memory-bank/tasks/platform-foundation.md`.
- Final whole-branch review (Codex): "Ready with fixes", 0 Critical / 4 Important / 5 Minor. All 4 Important items were fixed in `5ddac39` and re-verified: unit 150/150, integration 63/63, `pnpm run ci` green, `pnpm audit --prod` clean.
- Fresh-clone check at Phase 6 (commit `d384995`): `setup` 4.5 s, cached `docker compose up` healthy in 17.2 s, `ci` green in 67.6 s.
- The Codex design critique before build found 1 critical, 3 high and 1 medium finding (cross-tenant payment ownership, waitlist race, invoice race, `OTHER` sex unbillable, over-promised AC-ASYNC-3). All five were applied before any code was written.
- Ratings from reflection: Task Quality **Good**; Ecosystem Effectiveness **Moderately Effective**.

Open items at archive: no real GitHub Actions run (AC-VERIFY-4), accountant confirmation of IRD invoice numbering, and the downstream hand-offs listed under [Future Considerations](#future-considerations).

## System Overview

### Purpose
Give every downstream feature a shared, tested base: one command set that behaves the same locally and in CI, a database that enforces financial and concurrency invariants itself, and small library modules (money, time, crypto, notifications, jobs) so no feature re-invents them.

### Scope
Included (task file → Scope Boundaries):
- Monorepo scaffold: `apps/web` (one placeholder page showing live API health), `apps/api` (Fastify, `/health`, worker entry `src/worker.ts`, operator CLI `src/cli.ts`), `packages/shared`.
- Root task runner, ESLint/Prettier, strict TypeScript, Vitest unit and integration projects, GitHub Actions CI, Docker Compose (postgres:17, api, worker, web, Mailpit; no Redis), `.env.example`, Dockerfiles.
- PostgreSQL 17 migrations for the full domain model plus the gap fixes (auth identities, `payments.team_id` and fee snapshot, guest attributes, `UNIQUE(session_id, user_id)`, per-team invoice numbers, encrypted bank and Akahu columns, wallet balance range, FK changes that preserve financial records, recurrence uniqueness, auto-enrol timestamp, ownership composite FKs, waitlist partial unique index, `fee_other` and `SEX_OTHER`).
- Library modules with no domain rules, ADRs, getting-started guide.

Excluded: all domain behaviour owned by later features (auth, team management, banking and GST logic, skill levels, session scheduling, registration and waitlist rules, wallet and Akahu, dashboards, invoices and exports); operational tables owned by those features; email templates and a production email account; production deployment, IaC, monitoring; seed data; subscription billing logic (enum values kept); native mobile.

### Key Capabilities
- One root command set, invoked as `pnpm run <target>`: `setup`, `dev`, `lint`, `typecheck`, `test`, `test:integration`, `db:migrate`, `db:rollback`, `db:reset`, `build`, `ci` (plus `db:new`, `db:codegen`, `openapi`, `jobs:trigger`, `test:e2e`).
- Database-enforced invariants: no cascade delete of financial rows, wallet balance 0.00 to 100.00, unique per-session registrations, FIFO-safe waitlist positions, gapless per-team invoice numbers, immutable per-payment fee snapshot with generated GST.
- Exact money (`NUMERIC(10,2)` in the DB, `MoneyString` on the wire, branded bigint cents in TypeScript).
- DST-correct Pacific/Auckland conversion in TypeScript and an SQL mirror (`nz_local_to_utc`), parity-tested.
- Rotatable application-level encryption with a key-ID envelope and AAD binding.
- pg-boss job runner: Pacific/Auckland cron, `singletonKey` dedupe, retry with backoff, visible failed state, recovery after worker SIGKILL.
- `Notifier` abstraction with `smtp` (Mailpit) and `memory` adapters and typed delivery errors.

## Architecture

### Overview
Chosen stack (Option I in `memory-bank/creative/platform-foundation-architecture.md`, unweighted total 27 vs 25 for NestJS/Prisma/BullMQ and 21 for FastAPI): Node 24 LTS, TypeScript 5.9 strict, Fastify 5, Next.js 16 with Tailwind v4, PostgreSQL 17, node-pg-migrate (plain SQL with real down migrations), Kysely 0.29 with kysely-codegen, pg-boss 12, pino, OpenTelemetry, Vitest 5, Playwright. Versions are from `memory-bank/techContext.md`.

Governing principles (P1 to P7, in `memory-bank/systemPatterns.md`): Postgres is the system of record; money never touches binary float; UTC `timestamptz` inside and Pacific/Auckland only at the edges; application-level encryption with a key ID; every async side effect goes through the job runner; one root command set with the same gates locally and in CI; 12-factor config that fails fast.

### Component Diagram

```
                    Browser
                       | HTTPS
                       v
 +-----------------------------------+  traceparent   +-----------------------------------+
 | web (Next.js, :3000)              | -------------> | api HTTP process (Fastify, :4000) |
 | server components, api-client.ts  | <- JSON (zod)  | routes -> services -> Kysely      |
 +-----------------------------------+                | enqueue(job, {trx}) in same txn   |
                                                      +----------------+------------------+
                                                                       | pg (UTC session)
                                                                       v
                          +--------------------------------------------------------------+
                          | PostgreSQL 17   schema public (domain, pgmigrations)         |
                          |                 schema pgboss (job store, schedules)         |
                          +--------------------------------------------------------------+
                                                                       ^
                                                                       | fetch / complete / fail
                                                      +----------------+------------------+
                                                      | worker process (same image,       |
                                                      | src/worker.ts): pg-boss scheduler |
                                                      | tz=Pacific/Auckland, handlers,    |
                                                      | Notifier -> adapter               |
                                                      +----------------+------------------+
                                                                       | SMTP (dev) / provider API (later)
                                                                       v
                                                              Mailpit :1025/:8025
```

| Component | Location | Role |
|---|---|---|
| web | `apps/web` (`@sgm/web`) | Next.js App Router UI; calls the API only; sends `traceparent` on server-side calls |
| api (HTTP) | `apps/api/src/main.ts`, `app.ts`, `routes/health.ts` | Fastify with zod contracts, generated `apps/api/openapi.yaml` (drift-checked) |
| worker | `apps/api/src/worker.ts`, `apps/api/src/jobs/` | pg-boss worker and scheduler; heartbeat plus three named no-op schedule slots |
| operator CLI | `apps/api/src/cli.ts` | `db migrate / rollback / reset`, `jobs trigger`, `jobs schedules` |
| platform library | `apps/api/src/lib/{config,db,logger,crypto,notifications,jobs,telemetry}` | Shared infrastructure for api and worker |
| shared package | `packages/shared` (`@sgm/shared`) | Enums, zod contracts, `money`, `time`, `invoice`; isomorphic, no build step |
| migrations | `db/migrations/*.sql` (10 files), `db/schema-deviations.md` | Schema of record and deviation trace |
| docs | `docs/getting-started.md`, `docs/adr/0001` to `0012` | Onboarding and decisions |

### Data Flow
- **Request path**: browser to web, web (server component) to API `GET /health` with `traceparent`, API checks the DB pool and returns `{status, db, version}` (200, or 503 when the DB is unreachable).
- **Job path**: a domain write and `jobs.enqueue(..., {db: trx})` commit in one transaction, so a job exists only if its write committed. The enqueue writes the active trace to `payload._meta.traceparent`. The worker fetches with `FOR UPDATE SKIP LOCKED`, restores the trace as parent of a `"{queue} process"` span, runs the handler, and completes or fails. Retries use exponential backoff; terminal failure is visible in `pgboss.job` with the error and retry count.
- **Notification path**: handler calls `notifier.send(msg)`; adapter chosen by `NOTIFIER_ADAPTER`; transient errors retry, permanent and configuration errors fail the job with zero retries via `NonRetryableJobError`.
- **Encryption path**: repository calls `encrypt(plaintext, {table, column, rowId})`, stores the `v1.<keyId>.<iv>.<ciphertext>.<tag>` envelope, and a CHECK constraint rejects plaintext writes even from raw SQL.
- **Billing shape (designed here, built later)**: `post-game-billing` cron every 5 minutes selects PUBLISHED sessions with `ends_at <= now()` and enqueues one `bill-session` job per session with `singletonKey = 'bill-session:<session_id>'`.

### Integration Points
- **PostgreSQL 17**: single system of record and job store. One driver (`pg`) is shared by Kysely, pg-boss and node-pg-migrate; every connection is forced to `TimeZone=UTC`.
- **Mailpit** (dev and CI): SMTP sink with REST API at `:8025`, used by AC-INTEGRATION-3.
- **GitHub Actions**: `.github/workflows/ci.yml` runs actionlint and `pnpm run ci` against a `postgres:17` service container. Not yet run for real (see AC-VERIFY-4).
- **Production email provider**: Postmark is likely but not integrated; only the adapter contract is fixed.
- **Akahu**: not integrated; crypto and job primitives are ready for wallet-and-akahu-billing.
- **Downstream features**: all ten other v1.0.0 features depend on this one (see hand-offs).

## Design Decisions

Full option scoring is in the two creative documents. Each decision below lists the choice, why, and the trade-off accepted.

### Q1 Backend framework
- **Decision**: Node 24 + TypeScript strict + Fastify 5, zod contracts, `@fastify/swagger` for OpenAPI.
- **Rationale**: highest weighted score (4.50); shares TypeScript types with Next.js directly; pino built in; small surface for a solo developer.
- **Alternatives Considered**: NestJS (4.05), Express 5 (3.70), FastAPI (3.20). FastAPI needs two toolchains and OpenAPI codegen.
- **Trade-off**: no framework-imposed structure; a binding `modules/<feature>/{routes,service,repo}.ts` convention replaces it.
- **Reference**: `memory-bank/creative/platform-foundation-architecture.md` §Q1; `docs/adr/0001-backend-framework.md`

### Q2 Monorepo tooling and layout
- **Decision**: pnpm 10 workspaces only. Worker is a second entry point of `apps/api` (same image, different command). `@sgm/shared` is a just-in-time package. Tailwind v4 CSS-first (no `tailwind.config.ts`).
- **Rationale**: 4.40 vs Turborepo 4.15 and Nx 3.70; three packages do not need a task-graph cache. Worker as entry point (4.45 vs 3.80) lets handlers reuse domain services directly.
- **Trade-off**: no remote cache. Revisit when there are more than 6 packages or CI passes 6 minutes.
- **Reference**: architecture doc §Q2; `docs/adr/0002-monorepo-tooling.md`

### Q3 Migrations and data access
- **Decision**: node-pg-migrate plain SQL (`-- Up Migration` / `-- Down Migration`) plus Kysely over `pg` plus committed, drift-checked kysely-codegen output.
- **Rationale**: 4.55. Only option with real down migrations (AC-VERIFY-5 as written) and first-class CHECKs, triggers and functions. Prisma and Drizzle migrations are forward-only.
- **Trade-off**: every SQL statement, including downs, is hand-written; the deviations record and conformance test compensate for having no schema DSL.
- **Reference**: architecture doc §Q3; `docs/adr/0003-migrations-and-data-access.md`

### Q4 Job runner and post-game-billing trigger
- **Decision**: pg-boss with `tz: 'Pacific/Auckland'` schedules. Billing trigger T3: a 5-minute sweep enqueues a per-session `bill-session` job. Defaults: `retryLimit: 3`, `retryDelay: 5` s, exponential backoff. Delivery is at-least-once, and handlers must be idempotent.
- **Rationale**: 4.45 (Graphile Worker 4.05, BullMQ 3.40, platform cron 2.95). No Redis, transactional enqueue, job state readable in SQL. T3 scored 4.75 vs a plain sweep 4.40 and delayed per-session jobs 3.45.
- **Alternatives rejected**: Graphile Worker (no per-entry timezone; crash recovery about 4 h), BullMQ (extra service, no transactional enqueue).
- **Trade-off**: about 2 s polling latency; crash recovery is bounded by `expireInSeconds`.
- **Reference**: architecture doc §Q4; `docs/adr/0004-job-runner.md`

### Q5 Encryption at rest
- **Decision**: application-level AES-256-GCM (`node:crypto`), env keyring, key-ID-prefixed envelope, AAD `sgm:v1:<table>.<column>:<rowId>`. Encrypted: `bank_account_number`, `akahu_app_token`, `bank_account_name`, `ird_number`. Plaintext: `akahu_merchant_id`, `gst_number`. Display projection `bank_account_last4`. Envelope-format CHECK on each encrypted column.
- **Rationale**: 4.60 vs libsodium 4.40 and pgcrypto 3.35 (pgcrypto passes the key through SQL, which can leak to logs). Volume-only encryption does not meet the column-level requirement.
- **Trade-off**: no KMS in v1 (a `KeyProvider` interface allows one later); random-IV ciphertext cannot be searched.
- **Reference**: architecture doc §Q5; `docs/adr/0005-encryption-at-rest.md`

### Q8 Email provider and notifier contract
- **Decision**: Postmark is the likely provider (not integrated). `Notifier.send()` takes one recipient and a required `idempotencyKey`, resolves to `{providerMessageId, acceptedAt, deduplicated}`, and fails with `TransientDeliveryError`, `PermanentDeliveryError` or `NotifierConfigurationError`.
- **Rationale**: Postmark 4.60, Resend 4.35, SES 3.55, SendGrid 3.50. Contract checked against Postmark, SES and Resend error models.
- **Trade-off**: N calls for N recipients, which keeps retry scope minimal. US-hosted providers need an IPP 12 disclosure when the production adapter ships.
- **Reference**: architecture doc §Q8; `docs/adr/0006-email-provider-and-notifier.md`

### Q10 Hosting constraints
- **Decision**: binding constraints C1 to C6 (long-lived containers; managed PostgreSQL 17 in AU or NZ with `sslmode=require` in production; migrations as a pre-deploy step, never at boot; platform secret store; TLS at the edge; web as a standalone container). Vendor is provisional: DigitalOcean App Platform (Sydney) with managed PostgreSQL. The vendor facts were not verified live.
- **Alternatives Considered**: AWS ECS + RDS (3.50, planned upgrade path if KMS custody is required), Fly.io (3.75), Vercel plus Render/Railway (3.25).
- **Reference**: architecture doc §Q10; `docs/adr/0007-hosting-constraints.md`

### Q12 Shared types and enum parity
- **Decision**: hand-written `as const` enums and zod contracts in `@sgm/shared`, guarded three ways: runtime `pg_enum` parity test, compile-time equality against codegen output, and a codegen drift check.
- **Rationale**: 4.75 vs generated-from-DB 4.15 and OpenAPI codegen 3.70.
- **Reference**: architecture doc §Q12; `docs/adr/0008-shared-types.md`

### Q6 Money representation and rounding
- **Decision**: `NUMERIC(10,2)` in the DB, 2-dp string on the wire, branded `bigint` cents in TypeScript. Rounding modes `HALF_UP` (half away from zero, equals PostgreSQL `round`), `CEIL` and `FLOOR`, each passed explicitly. Rate suggestion uses `CEIL` to whole dollars.
- **Rationale**: no schema deviation for money columns; `bigint` cannot mix with `number` and `JSON.stringify` refuses it, so a float cannot reach the wire. GST 3/23 never produces a rounding tie (the denominator is odd).
- **Alternatives Considered**: big.js/decimal.js (6A), `BIGINT` cents in the DB (6B, about 25 deviations), safe-integer `number` cents (6D, `Math.round(-2.5)` disagrees with PostgreSQL).
- **Trade-off**: two representations (string for I/O, bigint for arithmetic); `bigint` cannot be a React Server Component prop, so `MoneyString` crosses every serialisation boundary.
- **Reference**: `memory-bank/creative/platform-foundation-algorithm.md` §Q6; `docs/adr/0009-money.md`

### Q7 DST policy, deadline default and session instants
- **Decision**: hand-rolled `Intl` offset probe in `@sgm/shared/time` (7A). Explicit disambiguation per call: `reject` for user input, `compatible` for derived times. Default cancellation deadline is an absolute `starts_at - 48 h`. `game_sessions.starts_at/ends_at` are maintained by database triggers through `nz_local_to_utc`, a plpgsql port of the same algorithm, guarded by a TS-to-SQL parity test.
- **Rationale**: 0 kB in the browser, ports line for line to plpgsql, and native PostgreSQL resolves an ambiguous time to the later instant, which conflicts with the chosen `compatible` (earlier) policy, so the SQL mirror overrides it. DB-maintained instants mean no code path can forget to recompute.
- **Alternatives Considered**: `temporal-polyfill`, Luxon and `@date-fns/tz` (no per-call disambiguation), app-computed stored columns, query-time computation.
- **Trade-off**: the conversion exists in two ports, not one (a justified refinement of P3); courts may not cross midnight except `end_time = '24:00'`.
- **Reference**: algorithm doc §Q7; `docs/adr/0010-time-dst.md`

### Q9 Invoice-number allocation
- **Decision**: gapless per-team counter row, `assign_invoice_number(payment_id)` inside the caller's transaction. It locks the payment row first, refuses a payment that already has a number, derives the team from the payment, bumps the counter, and verifies exactly one row updated. `UNIQUE(team_id, invoice_number)` plus a set-once guard. Display `INV-000123`.
- **Rationale**: only option that is unique, gapless, transactional and visible in the schema. This was revised after the design critique (finding 3): the original team-keyed function leaked a number when two issuers raced on the same payment.
- **Alternatives rejected**: sequence per team (gaps on rollback, runtime DDL), `MAX()+1` under an advisory lock (convention-only correctness), `MERGE ... RETURNING` (no speculative insert; can raise `23505` on first allocation).
- **Note**: the IRD taxable-supply rules (checked 2026-09-29 on ird.govt.nz) list no invoice-number or gapless requirement, so gapless is our choice. Accountant sign-off is still pending (UNVERIFIED-LEGAL).
- **Reference**: algorithm doc §Q9; `docs/adr/0011-invoice-numbering.md`

### Q11 Fee snapshot and guest model
- **Decision**: `registration_guests` child table (position 1 to 2, sex, skill tier) with a deferred count check against `registrations.guest_count`; `payments` header plus `payment_line_items` (one per party); GST and subtotal as STORED generated columns; ownership chain enforced by composite FKs; partial unique index for waitlist positions; `fee_other` and `SEX_OTHER` for BY_SEX pricing.
- **Rationale**: per-party lines fit FLAT, BY_SEX and BY_SKILL_LEVEL and print on a tax invoice. GST is computed once per payment on the inclusive total, so rounded lines cannot disagree with the rounded total. Idempotency comes from `UNIQUE(payments.registration_id)`.
- **Alternatives Considered**: positional guest columns, JSONB guests, snapshot columns on `payments`, JSONB snapshot (stores money as a JSON number, violating P2).
- **Trade-off**: two deferred constraint triggers report at COMMIT, so rollback-isolated tests must use `SET CONSTRAINTS ... IMMEDIATE`.
- **Reference**: algorithm doc §Q11; `docs/adr/0012-fee-snapshot-and-guests.md`

### Design critique dispositions (Codex, 2026-09-29, "needs-attention")
| # | Severity | Finding | Applied change |
|---|---|---|---|
| 1 | critical | Payment ownership not tied to registration user/team | Composite FKs `(registration_id, user_id, team_id)` on `payments` and `credit_transactions` |
| 2 | high | FIFO waitlist unsafe under concurrency | Partial unique index on `(session_id, queue_position) WHERE status='WAITLISTED'`, plus a documented session-row lock contract |
| 3 | high | Invoice number leaks on same-payment race | Payment-locked `assign_invoice_number`, exactly-one-row check |
| 4 | high | BY_SEX makes `OTHER` unbillable | `fee_other` column and `SEX_OTHER` basis (default `LEAST(male, female)` applied by scheduling) |
| 5 | medium | AC-ASYNC-3 promised exactly-once | Reworded as concurrent dedupe plus at-least-once with domain idempotency |

## Implementation

### Phases
Phase durations were not recorded in the plan or ledger, so none are stated. Commit SHAs are from `git log main..feature/platform-foundation`.

| Phase | Code commit | Outcome |
|-------|-------------|---------|
| 1 Workspace scaffold and quality gates | `6339d53` (review `ffb76f3`) | 36 unit tests RED to GREEN; strict lint, format and typecheck gates with deliberate-violation checks; config fail-fast; logger with deep key redaction |
| 2 Local dev stack and CI | `8e7b2c4` (review `d94c891`) | Compose healthy in 17 s (cached); `/health` 200/503/200; Playwright smoke; actionlint clean. Reviewer first returned CHANGES_REQUIRED (ReDoS in URL-userinfo regex, unredacted `err` serializer, ports on 0.0.0.0), fixed in-phase. TDD sub-agent was not dispatched this phase |
| 3 Domain schema and migrations | `2c8e399` (review `4843eff`) | RED 38 failing to GREEN 38/38; integration 42/42; 26 documented deviations; per-test-file template-cloned databases; APPROVED with 8 advisories |
| 4 Money, time, crypto | `169e868` (review `87854e2`) | RED (5 unit + 2 integration files failing) to unit 80/80, integration 50/50; coverage 94-100% on the modules; APPROVED with 7 advisories. Commits from here landed on a detached HEAD |
| 5 Job runner and notifications | `33cff32` (review `48ec2e6`) | 130 unit / 63 integration; real SIGKILL recovery 9-13 s (limit 30 s); APPROVED with advisories |
| 6 Docs, ADRs, memory bank | `d384995` (`ecea3d2`, review `5eb9c50`) | Getting-started, ADR 0001-0012, techContext, systemPatterns; fresh-clone verification green; branch ref repaired with `git checkout -B` |
| Final review and remediation | `dd9db81` (review record), `5ddac39` (fix), `662944c` (remediation review) | Codex: 0 Critical / 4 Important / 5 Minor; I1-I4 fixed with 20 new tests RED to GREEN; PROCEED |
| Reflection and doc fixes | `b0b80ce`, `98b260e`, `0fee4cc` | Reflection written; techContext corrected; AC-ERROR-6, AC-ASYNC-2, AC-VERIFY-2 amended with dated notes |

Planning and creative commits: `4ab63d0` (provision), `a53f690` (plan), `65a6977` (creative), `72969e1` (critique fixes), `7883208` (source specs), `9be101d` (build start).

### Key Components

- **Config** (`apps/api/src/lib/config/config.ts`): zod-validated environment. `DATABASE_URL`, `ENCRYPTION_KEYS` (each key decodes to 32 bytes) and `ENCRYPTION_ACTIVE_KEY_ID` are required; failure exits non-zero before listening or taking jobs, naming the variable and never printing a value (AC-ERROR-1).
- **Database** (`apps/api/src/lib/db/`): `pg` pool (NUMERIC, INT8, DATE, TIME returned as strings; `TimeZone=UTC` per connection), Kysely wrapper, committed `types.generated.ts` with `MoneyString`, `LocalDate`, `LocalTime` and `Ciphertext` overrides, compile-time `enum-parity.ts`, migration runner that installs the pg-boss schema after app migrations. No DDL runs at app boot.
- **Migrations** (`db/migrations/`, 10 files, 2026-09-29): enums; users and auth identities; teams; team members; recurring session rules; game sessions and courts; registrations and guests; wallet; payments and invoicing; indexes. Every difference from `database-design.md` is in `db/schema-deviations.md` as D-01 to D-26, each with a cited source.
- **Money** (`packages/shared/src/money/`): `parseMoney`, `toMoneyString`, `formatNZD`, `add`, `sum`, `multiplyByRatio(m, n, d, mode)`, `divideByInteger(m, divisor, mode, unit)`, typed `MoneyValidationError` codes, zod schemas that use strings on the wire.
- **Time** (`packages/shared/src/time/`): `resolveLocal`, `localToInstant(date, time, disambiguation)`, `instantToLocal`, `defaultCancellationDeadline`, `addLocalDays`, `formatNzDate` (`DD/MM/YYYY`), typed `NonexistentLocalTimeError` and `AmbiguousLocalTimeError`. The DST vector table is exposed as the `dst-vectors` fixture for the parity test.
- **Crypto** (`apps/api/src/lib/crypto/`): `encrypt`, `decrypt`, `needsRotation`, `reencrypt`; typed `DecryptionError` with `unknown_key`, `auth_failed` or `malformed` and a fixed message.
- **Notifications** (`apps/api/src/lib/notifications/`): `Notifier`, error classes, `smtp` (nodemailer with file and URL access disabled) and `memory` adapters.
- **Jobs** (`apps/api/src/lib/jobs/jobs.ts`, `apps/api/src/jobs/`): runner wrapper (`enqueue`, `schedule`, `work`, `previewSchedule`), `NonRetryableJobError`, `heartbeat` queue, `send-email` queue, three schedule slots.
- **Telemetry** (`apps/api/src/lib/telemetry/telemetry.ts`, `src/instrumentation.ts`): OpenTelemetry `NodeTracerProvider` plus `@fastify/otel`; added in the final-review remediation.
- **CI** (`.github/workflows/ci.yml`): actionlint step plus `pnpm run ci`, `postgres:17` service container, 10-minute budget.

### Technical Specifications

**Schedule slots** (names binding per AC-ASYNC-2; handlers are no-ops in foundation):

| Slot | Cron (Pacific/Auckland) | Later owner |
|---|---|---|
| `recurrence-materialisation` | `0 3 * * *` | session-scheduling-engine |
| `post-game-billing` | `*/5 * * * *` (flagged `intervalSweep`) | wallet-and-akahu-billing |
| `daily-overdue` | `0 4 * * *` | wallet-and-akahu-billing |

Rule: no wall-clock schedule fires between 02:00 and 02:59 local time. The fixed-interval `post-game-billing` sweep is exempt (AC-ASYNC-2 amended 2026-09-30).

**Encryption envelope**: `v1.<keyId>.<iv_b64url(12 bytes)>.<ciphertext_b64url>.<tag_b64url(16 bytes)>`, stored as `TEXT`. Keyring: `ENCRYPTION_KEYS="<id>:<base64 32 bytes>[,...]"` with `ENCRYPTION_ACTIVE_KEY_ID`. Rotation runbook is in `docs/getting-started.md`.

**Money vectors** (unit-tested): GST on $17.00 = $2.22 (subtotal $14.78); GST on $16.00 = $2.09 (subtotal $13.91); ($120 + $12) / 12 players, `CEIL` whole dollars = $11.00; `-0.025` with `HALF_UP` = `-0.03`; `0.10 + 0.10 + 0.10 = 0.30`; `99999999.99` round-trips through PostgreSQL.

**Time vectors** (unit and TS-to-SQL parity tested, also under `TZ=UTC` and `TZ=America/New_York`): `2026-09-27 02:30` does not exist (`compatible` gives `2026-09-26T14:30:00Z`, `reject` throws); `2027-04-04 02:30` is ambiguous (`compatible` gives `2027-04-03T13:30:00Z`, the earlier instant); 48 h before `2027-04-05 19:00` NZST is `2027-04-03T07:00:00Z`, displayed `03/04/2027 8:00 pm`.

**pg-boss 12.35 facts found empirically** (Phase 5 ledger): `singletonKey` dedupes only on `exclusive`-policy queues; crash recovery needs both `superviseIntervalSeconds` and `monitorIntervalSeconds` (both set from `JOBS_SUPERVISE_INTERVAL_SECONDS`); backoff is `retryDelay * 2^(n+1)/2 * (1+rand)`.

**Environment knobs added beyond the design**: `JOBS_EXPIRE_SECONDS_OVERRIDE`, `JOBS_SUPERVISE_INTERVAL_SECONDS`, `JOBS_POLL_INTERVAL_SECONDS`.

**Logging**: pino JSON with camelCase fields (`timestamp`, `level`, `message`, `service`, `traceId`, `spanId`, `requestId`, `jobId`, `queue`). These supersede the snake_case field list in the original plan. Redaction is formatter-based deep key redaction (pino wildcard paths were insufficient), `console.*` is banned in `apps/api/src` except `cli.ts`.

**Observability actually built**: structured logs; OpenTelemetry tracing (no exporter unless `OTEL_EXPORTER_OTLP_ENDPOINT` is set, or `OTEL_TRACES_EXPORTER=console`); `traceparent` from web to API to job payload to worker span. **Not built**: metrics exporter (only `METRICS_*` config variables), `pg` and http client spans, the web SDK, OTLP flush on SIGTERM.

## Testing

### Strategy
Balanced. Library modules are unit-heavy; schema, jobs and health are integration tests against real PostgreSQL 17, because the ACs concern database constraints and job-store behaviour that mocks cannot prove.
- **Unit**: co-located `*.test.ts`, no DB and no network (`vitest run --project unit --coverage`).
- **Integration**: `apps/api/test/integration/*.int.test.ts` against real PostgreSQL 17. `global-setup.ts` migrates a template database once per run; each test file gets its own database cloned from it, and concurrency tests get a separate clone. This allows tests to COMMIT. Two deferred constraint triggers require `SET CONSTRAINTS ... IMMEDIATE` in rollback-style tests.
- **E2E**: Playwright smoke test `apps/web/e2e/smoke.spec.ts`, run against the Compose stack, outside `ci`.
- **Behavioural verification** for failure-mode ACs: real `docker compose stop postgres` then restart (503 in 267 ms, 200 again without restarting the API); real worker SIGKILL recovery (9-13 s); ReDoS timing test; fresh clone at a pinned commit.
- **TDD evidence**: RED then GREEN recorded in Phases 1, 3, 4, 5 and the remediation. Phase 2 has no RED evidence (see reflection).

### Results
Final state after remediation (commit `5ddac39`, independently re-run in the remediation review):

| Test Type | Count | Pass Rate |
|-----------|-------|-----------|
| Unit | 150 | 100% (150/150) |
| Integration | 63 | 100% (63/63) |
| E2E (Playwright smoke, outside `ci`) | 1 spec file | Passed in Phase 2; not part of `ci`, not re-run after remediation per the ledger |

The plan targeted about 86 tests; 213 were delivered. Lint 0 errors and 0 warnings, typecheck 0 errors, build OK (Phase 6 and remediation records). Test counts by phase from the ledger: 36 unit (P1), 40 unit + 42 integration (P3), 80 unit + 50 integration (P4), 130 unit + 63 integration (P5/P6), 150 unit + 63 integration after 20 remediation tests.

### Coverage
- Gate: 80% lines, functions, branches and statements on `packages/shared/src/{money,time,invoice}` and `apps/api/src/lib/{crypto,notifications,jobs,config}`; remediation added `logger` and `telemetry` to the include list.
- Measured at Phase 6 fresh clone (130 unit tests): lines 99.41%, statements 99.28%, branches 93.69%, functions 99.32%.
- Measured at Phase 4: money, time and crypto each 94-100%.
- Reflection reports about 97-99% lines at the end; the post-remediation coverage table was not recorded in the ledger. `telemetry.ts` is reported at about 71% in the reflection.
- Not gated: `apps/api/src/lib/db` (integration only), generated types, `apps/api/src/jobs/*`.

### AC outcome (32 ACs)

| Status | ACs |
|---|---|
| Met (25) | AC-VERIFY-1, -3, -6, -7, -8, -9, -10, -11, -12, -13, -14, -15, -16, -17, -18, -19; AC-INTEGRATION-1, -2, -3; AC-ASYNC-1, -3; AC-ERROR-1, -3, -4, -5 |
| Met with deviation (6) | AC-VERIFY-2 (Playwright checks outside `ci`; budget applies to cached images: 17 s cached, 106.7 s with a partly warm `--build`); AC-VERIFY-5 (catalog snapshot always, `pg_dump` only when compose Postgres is reachable); AC-INTEGRATION-4 (Tailwind and "API: ok" checks in Playwright, outside `ci`); AC-ASYNC-2 (`intervalSweep` exemption for `post-game-billing`); AC-ERROR-2 (outage simulated with a closed-port pool in tests, real stop/start verified manually); AC-ERROR-6 (permanent and configuration errors fail with 0 retries; job-wrapped unreachable SMTP asserted with the memory adapter) |
| Open (1) | AC-VERIFY-4: `actionlint` reports 0 findings and local `ci` is green, but no real GitHub Actions run exists because the push is blocked |

The wording of AC-VERIFY-2, AC-ASYNC-2 and AC-ERROR-6 was amended on 2026-09-30 by the spec owner (dated notes in the task file; original text kept). AC-VERIFY-9 and AC-VERIFY-13/14 carry advisories (see Future Considerations).

## Deployment

Production deployment is out of scope for this feature (task file → Out of scope). This section records the local and CI procedures that exist, and the constraints deployment must follow.

### Procedures
**Local (from `docs/getting-started.md`)**:
1. Prerequisites: Docker with Compose v2, Node 24, Corepack (pnpm 10 is pinned by `packageManager`).
2. `pnpm run setup` (enables Corepack, installs with a frozen lockfile, copies `.env.example` to `.env`, generates a dev `ENCRYPTION_KEYS`).
3. `docker compose up -d --wait --build` (plain `up` reuses an existing image, so use `--build` after pulling changes).
4. `pnpm run ci` to run the full gate set.
5. Day-to-day: `pnpm run dev` starts Postgres and Mailpit, runs `db:migrate`, then runs web, api and worker (fixed in remediation I1).

**CI**: `.github/workflows/ci.yml` triggers on `push` to `main` and `pull_request` to `main`, runs actionlint and `pnpm run ci` with `postgres:17`. First real run is pending the push.

**Production constraints** (hosting decision C1-C6): run api and worker as two services from one image; run `node dist/cli.js db migrate` as a pre-deploy step once per deploy; provide secrets from the platform's encrypted store; managed PostgreSQL 17 in AU or NZ with `sslmode=require`; TLS at the edge.

### Configuration
`.env.example` lists every required variable with a non-secret placeholder; `.env` is git-ignored. Key variables: `DATABASE_URL`, `ENCRYPTION_KEYS`, `ENCRYPTION_ACTIVE_KEY_ID`, `NOTIFIER_ADAPTER` (`smtp` | `memory`), `SMTP_URL`, `MAILPIT_API_URL`, `API_INTERNAL_URL`, `EMAIL_FROM`, `LOG_LEVEL`, `LOG_FORMAT`, `LOG_OUTPUT`, `LOG_FILE_PATH`, `OTEL_*`, `METRICS_*`, `JOBS_*`, `WORKER_HEALTH_PORT`. The exact list is in `.env.example` and `apps/api/src/lib/config/config.ts`. Compose binds api and web ports to 127.0.0.1.

### Rollback
- Schema: `pnpm run db:rollback` (one step; `-- --count N`, or `-- --all` to version zero). Every migration has a tested down section (migrate, rollback --all, migrate gives an identical schema). `db:rollback` is refused when `NODE_ENV=production` (remediation I4).
- `pnpm run db:reset` drops `public` and `pgboss` and re-migrates; it refuses in production and its host check covers `?host=` (remediation I4).
- Code: revert the merge commit on `main`. Encrypted columns and the `pgboss` schema are unaffected by a code revert; rolling back the migration that created encrypted columns drops their data.
- Encryption keys: never remove an old key from `ENCRYPTION_KEYS` until every row is re-encrypted (`split_part(col, '.', 2) <> active`).

## Maintenance

### Monitoring
Foundation ships logs and traces only; there is no metrics backend or alerting.
- Container health: `docker compose ps` (health column); `GET /health` on the API (200 with DB ok, 503 when unreachable) and the worker's internal health port.
- Jobs: read `pgboss.job` (and `pgboss.archive`) for state, `retry_count` and error output. Terminal `failed` emits an error-level log line. Lifecycle log events: `job.enqueued|started|completed|retried|failed|deduplicated`.
- Manual job check: `pnpm run jobs:trigger <slot|heartbeat>`; `jobs schedules` lists registered schedules.
- Mail in dev: Mailpit UI `http://localhost:8025`.
- Not available yet: Prometheus metrics, OTLP export by default, SIGTERM span flush.

### Common Issues
| Issue | Resolution |
|-------|------------|
| Port already in use (3000, 4000, 5432, 8025, 1025) | Stop the other stack with `docker compose down` |
| `docker compose up` fails on a stale image from an older checkout (for example the old `db migrate` stub) | Run `docker compose up -d --wait --build` |
| Integration tests cannot connect | Check `docker compose ps` shows `postgres` healthy; `DATABASE_URL` must point to PostgreSQL 17 with `CREATEDB` |
| API or worker exits at startup naming an env variable | Fix the named variable (`DATABASE_URL`, `ENCRYPTION_KEYS`, `ENCRYPTION_ACTIVE_KEY_ID` must decode to 32 bytes and match a key); values are never printed |
| Jobs enqueue but never run in local dev | Confirm the worker is running (`pnpm run dev` starts it since remediation I1; under Compose check the `worker` service) |
| Job replay ran the side effect twice | `singletonKey` only suppresses concurrent duplicates; handler needs a domain idempotency key or guarded status transition |
| Deferred constraint error appears only at COMMIT in a rollback-style test | Use `SET CONSTRAINTS ALL IMMEDIATE` in the test |
| Leaked `sgm_tpl_*` template databases after a failed global setup | Drop them manually; there is no sweeper (deferred) |
| Decryption error | Check `reason`: `unknown_key` (key missing from the keyring), `auth_failed` (tampered data or wrong table/column/row AAD), `malformed` (not an envelope) |

### Operational Procedures
- **Add a migration**: `pnpm run db:new`, write reversible SQL, run `pnpm run db:codegen`, add a `db/schema-deviations.md` entry for any difference from `database-design.md`, mirror any new enum in `packages/shared/src/types/enums.ts`.
- **Register a job or schedule**: see `docs/getting-started.md`; handlers must be idempotent; do not schedule wall-clock jobs in 02:00-02:59 local time.
- **Add a notification adapter**: implement `Notifier` under `apps/api/src/lib/notifications/adapters/` and select it with `NOTIFIER_ADAPTER`.
- **Encrypt a new column**: use the crypto helper with the row ID as AAD input, add the envelope CHECK, add a `Ciphertext` codegen override.
- **Rotate the encryption key**: add a new key, flip `ENCRYPTION_ACTIVE_KEY_ID`, re-encrypt old rows (job owned by team-banking-and-gst), then remove the old key.
- **Pin refresh**: CI actions are tag-pinned and actionlint runs as `rhysd/actionlint:latest`; pin both by SHA/digest (open advisory).

## Lessons Learned

Reference: `memory-bank/reflection/platform-foundation-reflection.md`

**What worked**
- Adversarial critique between design and build was the highest-value single step: it removed a critical ownership hole and three race or billing defects before any code existed.
- Whole-branch review by a different model family (Codex) found two Important issues that six same-family phase reviews missed.
- Enforcing invariants in PostgreSQL (CHECK, UNIQUE, FK RESTRICT, triggers) and testing them with real concurrent transactions.
- Behavioural verification for failure-mode ACs (stop the DB, kill the worker, fresh clone), recording any weaker fallback as a named deviation.
- A template database cloned per test file for integration isolation.
- One DST algorithm in two ports with a parity test; a stable-ID deviation record (D-01 to D-26) that made AC-INTEGRATION-1 auditable.

**What went wrong**
- Planned OpenTelemetry tracing was asserted in `techContext.md` and the plan but not built in Phase 5; the ledger noted "no OTel API dependency yet" and no phase review escalated it (found as Important I2 at final review). Phase reviewers check the phase diff against the phase's ACs and do not diff plan or documentation claims against the tree.
- `pnpm dev` started only the API, not the worker (I1).
- Phase 2 skipped the TDD sub-agent to save context and produced the only blocking phase finding; forcing TDD by prompt worked from Phase 3.
- Phases 4-6 were committed on a detached HEAD unnoticed; repaired at Phase 6.
- The Haiku documentation agent invented facts and overwrote `systemPatterns.md` after the commit; corrected by hand.
- Environment was absent at start (no Docker, Postgres or pnpm; `gh` missing; push blocked), found mid-run.
- AC text drifted from reality when ACs could not be met literally; fixed on 2026-09-30 by dated amendments.

**Learned rules created at archive** in `memory-bank/agent-rules/_learned/` (4 files): `review-process` (diff plan and documentation claims against the built tree at each phase review), `testing-patterns` (per-file template databases, separate clone for concurrency tests), `git-workflow` (assert HEAD is attached to the feature branch and the ref matches the last commit at phase start and end), `job-queues` (pg-boss supervise plus monitor intervals, exclusive queues for `singletonKey`, non-retryable errors for permanent failures).

## References
- Reflection: `memory-bank/reflection/platform-foundation-reflection.md`
- Architecture Docs: `memory-bank/creative/platform-foundation-architecture.md`
- All Creative Docs: `memory-bank/creative/platform-foundation-architecture.md` (Q1, Q2, Q3, Q4, Q5, Q8, Q10, Q12), `memory-bank/creative/platform-foundation-algorithm.md` (Q6, Q7, Q9, Q11)
- Task file (spec, 32 ACs, plan, Design Critique, Deviations ledger, AC Walk): `memory-bank/tasks/platform-foundation.md`
- ADRs: `docs/adr/0001-backend-framework.md`, `0002-monorepo-tooling.md`, `0003-migrations-and-data-access.md`, `0004-job-runner.md`, `0005-encryption-at-rest.md`, `0006-email-provider-and-notifier.md`, `0007-hosting-constraints.md`, `0008-shared-types.md`, `0009-money.md`, `0010-time-dst.md`, `0011-invoice-numbering.md`, `0012-fee-snapshot-and-guests.md`
- Schema deviations (D-01 to D-26): `db/schema-deviations.md`; migrations: `db/migrations/`
- Onboarding guide: `docs/getting-started.md`
- Stack and conventions: `memory-bank/techContext.md`, `memory-bank/systemPatterns.md`
- Source specs (repo root): `PRODDUCT-OVERVIEW.md`, `database-design.md`, `workflows_state_machine_architecture.md`
- Implementation Timeline: `git log main..feature/platform-foundation` (25 commits, `4ab63d0` to `0fee4cc`)

## Future Considerations

### Hand-offs to downstream features
| Feature | Hand-off |
|---|---|
| tax-invoices-and-exports | Require the payment to be PAID before `assign_invoice_number` and block direct `invoice_number` writes (both are currently possible); get accountant confirmation of IRD invoice numbering before shipping (foundation's gapless scheme is our choice, not an IRD requirement); voiding and credit notes must not reuse numbers; may add an optional frozen `teams.invoice_prefix` additively |
| session-scheduling-engine | Insert sessions as DRAFT and publish after their courts exist (the `starts_at/ends_at` triggers need courts); apply the default `fee_other = LEAST(fee_male, fee_female)` for BY_SEX; validate admin-entered times with `reject` and derive recurrence times with `compatible`; apply the absolute 48 h cancellation default |
| wallet-and-akahu-billing | Create the `player_credits` row before the first credit transaction; consider making `credit_transactions` append-only at the DB level; billing handlers must be idempotent (`bill-session`, guarded `PUBLISHED` to `COMPLETED` transition, `UNIQUE(registration_id)` on payments); disclose the US email provider under IPP 12 when the production adapter ships |
| registration-and-waitlist | Follow the session-row lock contract (every enqueue, withdraw and promote first locks `game_sessions ... FOR UPDATE`; enqueue assigns `max(queue_position)+1`; promotion takes the lowest); handle the re-registration-after-late-fee case |
| all features | Redaction keys are snake_case only (camelCase variants are not redacted); job payloads (`pgboss.job.data`) may carry PII such as email addresses for pg-boss's 7-day retention |

### Open items and technical debt (from reflection and ledger)
- **High**: re-enable push access (correct git account or install `gh`) and run the real GitHub Actions pipeline to close AC-VERIFY-4; open the PR to `main`.
- **Medium**:
  - Narrow `intervalSweep` to `post-game-billing`, or split the cron as `*/5 0-1,3-23 * * *`.
  - Extend redaction beyond snake_case keys, redact SMTP error text in job output, flush OTLP on SIGTERM, add `pg` and http spans, raise `telemetry.ts` coverage.
  - AAD delimiter hardening (length-prefix or validate identifiers), non-canonical base64url acceptance, `moneyFromCents` runtime bigint guard, `addHours` overflow.
  - Money and time lint guards match Identifier arguments only, so `Math.round(row.amount)` evades them; the type brand is the real defence.
  - Pin CI actions by SHA and the actionlint image.
- **Low**: `dst-vectors` fixture exposed through the shared exports map; template database sweeper for leaked `sgm_tpl_*`; `lib/db` coverage; `res.statusCode` null in the request-completed log; reviewer nits (logger mixin `bindings()` cost, `send-email` JSDoc order, duplicated traceparent regex).
- Five ADRs (0005, 0006, 0008, 0010, 0012) name the chosen option without listing alternatives; the alternatives are in the linked creative docs.
- Spec/AC hygiene: when an AC is met with deviation, amend the AC text as well as the ledger.

### Ecosystem recommendations (reflection, none implemented here)
Plan-versus-delivered reconciliation in each phase review; branch-ref assertion at phase start and end; RED evidence as a hard gate; restrict the documentation agent (no weak model for architecture docs, citations required, no writes to guidance files after commit); build preflight for toolchain, remote and `gh`; a first-class local-only mode; a Guard & Recovery Log section in the task template; per-phase timestamps and estimates; session logs persisted at write time.

### Scope deliberately deferred
Metrics exporter and custom metrics (names were designed in the architecture doc), a production email adapter, KMS-backed key custody (`KeyProvider` interface is in place), Turborepo (revisit above 6 packages or CI over 6 minutes), overnight sessions (`end_day_offset`), operational tables owned by later features (auth sessions and refresh tokens, Akahu webhook log, notification delivery log).
