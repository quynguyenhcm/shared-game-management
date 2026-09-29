# Architecture Decision: Platform Foundation

**Created**: 2026-09-29
**Status**: DECIDED
**Decision Type**: Architecture
**Task**: `platform-foundation` (Level 4). Spec: `memory-bank/tasks/platform-foundation.md`
**Resolves**: Creative Q1, Q2, Q3, Q4, Q5, Q8, Q10, Q12, plus the file re-pin. Q6, Q7, Q9 and Q11 go to Algorithm Design (see [Constraints handed to Algorithm Design](#constraints-handed-to-algorithm-design)).

> **Governing principles.** `systemPatterns.md` on `main` is still the unfilled template and has no Guiding Principles yet. The binding principles are therefore the seven in the task's Architectural Plan, referred to below as **P1–P7**: P1 Postgres is the system of record, with DB constraints. P2 Money never touches float. P3 UTC `timestamptz` internally, Pacific/Auckland only at the edges. P4 App-level encryption with a key ID. P5 Every async side effect goes through the job runner. P6 One root command set, with the same gates locally and in CI. P7 12-factor env config that fails fast. When build writes `systemPatterns.md`, P1–P7 become its Guiding Principles table.

---

## Context

### System Requirements
- A monorepo with a Next.js + Tailwind web app, an API service, a background worker (a separate process, which may share the API's codebase), and a shared-types unit (AC-VERIFY-1).
- One root command set: `setup`, `dev`, `lint`, `typecheck`, `test`, `test:integration`, `db:migrate`, `db:rollback`, `db:reset`, `build`, `ci` (AC-VERIFY-1, P6).
- PostgreSQL 17 migrations for the full `database-design.md` model plus 11 gap fixes. Migrations must be reversible (AC-VERIFY-5 to -12) and must express enums, CHECKs, triggers, functions and per-team counters.
- A job runner with Pacific/Auckland cron, dedupe keys, at-least-once delivery, retry with backoff, and a visible failed state (AC-ASYNC-1 to -3, AC-ERROR-3).
- Column-level encryption of banking and Akahu secrets with a rotatable key ID (AC-VERIFY-13, AC-ERROR-4).
- A notifier abstraction with SMTP (Mailpit) and in-memory adapters, plus typed delivery errors (AC-VERIFY-16, AC-INTEGRATION-3, AC-ERROR-6).
- Shared enums that match `pg_enum` (AC-INTEGRATION-2).

### Technical Constraints
- Solo developer, greenfield, and no code yet. Operational simplicity outweighs raw throughput.
- GitHub remote. CI runs on GitHub Actions, with `postgres:17` as a service container. The 10-minute budget covers the whole `ci` job.
- The local stack runs on Docker Compose: `postgres`, `api`, `worker`, `web`, `mailpit`, plus `redis` only if unavoidable. It must be healthy within 120 s.
- **PostgreSQL 17** (decided by the spec owner on 2026-09-29, replacing the spec's original PG 15, which reaches community EOL in November 2027). PG 17 is supported until November 2029. The design uses portable SQL; PG 15+ features such as `UNIQUE NULLS NOT DISTINCT` and `MERGE` may be used where they simplify constraints.
- NZ Privacy Act 2020 (IPP 5 security safeguards, IPP 12 cross-border disclosure) and 7-year IRD financial retention.
- Akahu (REST + webhooks) arrives later and must fit the job and crypto primitives without changing them.

### Non-Functional Requirements
- **Correctness/safety:** DB-enforced invariants (P1), exact money (P2), DST-safe instants (P3), no plaintext secrets in the DB or logs (P4, AC-ERROR-4).
- **Performance:** `db:migrate` from empty in 30 s or less, the Compose stack healthy in 120 s or less, and CI in 10 min or less. Runtime load is small: hundreds to low thousands of users and bursty registration opens.
- **Scalability:** horizontal API replicas and at least one worker replica. The job runner must tolerate more than one worker, and schedules must fire only once.
- **Observability:** structured JSON logs, OpenTelemetry wired (no-op by default), W3C `traceparent` carried web → api → job.
- **Maintainability:** strict TypeScript and zero-warning lint. Ten downstream features must be able to follow the established patterns.

---

## Component Analysis

### Core Components

| Component | Purpose | Responsibilities |
|-----------|---------|------------------|
| `apps/web` (`@sgm/web`) | Player and admin UI | Next.js App Router pages; server components call the API through a typed client; Tailwind v4 styling; forwards `traceparent`. No DB access and no secrets. |
| `apps/api` (`@sgm/api`), **HTTP process** (`src/main.ts`) | REST API | Fastify app, zod-validated routes, `/health`, generated OpenAPI; enqueues jobs transactionally; the only writer of domain rows from user actions. |
| `apps/api`, **worker process** (`src/worker.ts`) | Background execution | pg-boss worker and scheduler; runs job handlers (heartbeat now; billing, recurrence and overdue later); has its own `/health` on an internal port. Same image and codebase as the HTTP process, started with a different entrypoint. |
| `apps/api/src/lib/*` | Server platform library | `config` (zod env, fail-fast), `db` (pg Pool + Kysely), `logger` (pino + redaction), `crypto` (AES-256-GCM keyring), `notifications` (Notifier + adapters), `jobs` (pg-boss wrapper), `telemetry` (OTel). |
| `apps/api/src/cli.ts` | Operator CLI | `db migrate / rollback / reset`, `jobs trigger <slot>`, `jobs schedules`. Bundled into the image so production pre-deploy steps can run migrations. |
| `packages/shared` (`@sgm/shared`) | Isomorphic contracts and primitives | Domain enums (`as const`), zod API contracts (e.g. `HealthResponse`), `money`, `time` (Pacific/Auckland). No Node-only APIs, because it runs in the browser too. |
| `db/migrations` | Schema of record | Plain SQL `-- Up Migration` / `-- Down Migration` files run by node-pg-migrate. `db/schema-deviations.md` traces each difference from the draft. |
| PostgreSQL 17 | System of record and job store | Domain schema (`public`), job schema (`pgboss`), migration ledger (`public.pgmigrations`). |
| Mailpit (dev/CI) / Postmark (prod, likely) | Email delivery | SMTP sink with a REST API for tests; production provider behind the adapter. |

### Component Interactions

```
                    Browser
                       │ HTTPS
                       ▼
┌───────────────────────────────────┐   traceparent    ┌──────────────────────────────────────┐
│ web (Next.js, :3000)              │ ───────────────► │ api  HTTP process (Fastify, :4000)   │
│ server components + api-client.ts │  GET /health ... │ routes → services → Kysely           │
└───────────────────────────────────┘ ◄─ JSON (zod) ── │ enqueue(job, {trx}) ─┐               │
                                                       └──────────┬───────────┼───────────────┘
                                                                  │ pg (TLS)  │ same txn
                                                                  ▼           ▼
                                   ┌───────────────────────────────────────────────────────┐
                                   │ PostgreSQL 17   schema public  (domain, pgmigrations) │
                                   │                 schema pgboss  (job, schedule, ...)   │
                                   └───────────────────────────────────────────────────────┘
                                                                  ▲           ▲
                                                 Kysely (domain)  │           │ fetch/complete/fail
                                                                  │           │ (polling, SKIP LOCKED)
                                                       ┌──────────┴───────────┴───────────────┐
                                                       │ worker process (same image)          │
                                                       │ pg-boss scheduler (tz=Pacific/Auck.) │
                                                       │ handlers: heartbeat, 3 slots, ...    │
                                                       │ Notifier ──► adapter                 │
                                                       └──────────────────┬───────────────────┘
                                                                          │ SMTP (dev) / HTTPS API (prod)
                                                                          ▼
                                                        Mailpit :1025/:8025  |  Postmark
```

- **web → api:** HTTP/JSON only. Web never touches Postgres. Response shapes are zod schemas from `@sgm/shared`, validated on both sides. `API_INTERNAL_URL` is used for server-side fetches.
- **api → postgres:** one `pg.Pool` per process, wrapped by Kysely. Every connection is forced to `TimeZone=UTC`. Domain writes and job enqueues share one transaction (pg-boss `send(..., { db })` adapter over the Kysely transaction), so a job exists only if its domain write committed (P5).
- **worker ↔ job store:** pg-boss polls `pgboss.job` with `FOR UPDATE SKIP LOCKED`. The cron scheduler is safe to run in more than one worker: pg-boss singleton-sends each cron tick, so it fires once across replicas.
- **worker → notifier → adapter:** handlers call `notifier.send(message)`. The adapter is chosen by `NOTIFIER_ADAPTER`. Transient errors are rethrown so the job retries. Permanent errors fail the job.
- **Trace context:** web injects `traceparent`. Fastify (`@fastify/otel`) extracts it. The job wrapper stores `traceparent`/`tracestate` in the job payload's `_meta`, and the worker extracts it into a child span `"{queue} process"`.

---

## Options Explored

The questions are coupled: Q1 drives Q3, Q12 and the job runner ecosystem. The first section compares three **integrated stack options** using the template's criteria. The per-question sections then give the weighted evaluation (task weights: maintainability 0.25, correctness/safety 0.25, time to market 0.20, operational simplicity 0.15, cost 0.10, performance 0.05; scores are 1 to 5).

### Option I: Lean TypeScript, all-Postgres (Fastify + Kysely + node-pg-migrate + pg-boss)
- **Description**: One language end to end. The API is Fastify with zod contracts shared with Next.js. Data access uses Kysely (typed SQL builder) over `pg`. Migrations are hand-written reversible SQL run by node-pg-migrate. Jobs use pg-boss inside the same Postgres, so no Redis. The worker is a second entrypoint of the API codebase.
- **Architecture Diagram**: see [Component Interactions](#component-interactions).
- **Pros**:
  - TS types flow from `packages/shared` straight into web and api with no codegen for DTOs.
  - Only two stateful services (Postgres and Mailpit in dev). The job store is transactional with domain writes.
  - Raw SQL migrations express every constraint the spec needs (CHECK, triggers, functions, partial unique indexes) and reverse cleanly.
  - One driver (`pg`) shared by Kysely, pg-boss, node-pg-migrate and OTel instrumentation.
- **Cons**:
  - No batteries-included module or DI system. Structure comes from convention (feature plugin folders).
  - Money needs a decimal library or integer cents in TS (Q6), because JS has no native Decimal.
  - pg-boss polls (default about 2 s latency) and has lower throughput than Redis queues. That is irrelevant at this scale.
- **Technical Fit**: High. Matches the Option A column of the spec's Verification Method and P1–P7.
- **Complexity**: Low to Medium.
- **Scalability**: Medium to High. Stateless API replicas; Postgres-backed queues handle thousands of jobs per minute, far beyond need.

### Option II: Structured TypeScript (NestJS + Prisma + BullMQ/Redis)
- **Description**: NestJS modules and DI, Prisma schema and Migrate, BullMQ on Redis for jobs and repeatable cron.
- **Pros**:
  - Strong conventions for ten features (modules, guards, interceptors), and a large ecosystem.
  - Prisma gives quick CRUD and typed models. BullMQ is mature, fast and has a UI (Bull Board).
- **Cons**:
  - Prisma Migrate is forward-only (AC-VERIFY-5 falls back to reset). CHECKs and triggers are not modelled and need hand-edited SQL that fights drift detection. Decimal comes back as `Decimal.js` objects.
  - Redis is an extra stateful service (dev, CI and prod). Enqueues are not transactional with Postgres writes, so an outbox is needed for P5.
  - Decorator metadata (`emitDecoratorMetadata`) is not supported by esbuild/tsx and needs SWC in Vitest and the build, which adds tooling friction.
- **Technical Fit**: Medium.
- **Complexity**: Medium to High.
- **Scalability**: High.

### Option III: Python backend (FastAPI + SQLAlchemy/Alembic + Procrastinate) with TS web
- **Description**: The spec's Option B. Python 3.12 and uv for api and worker; pnpm for web and shared TS; OpenAPI-generated TS types.
- **Pros**:
  - Native `Decimal`, and a mature SQLAlchemy/Alembic with down migrations.
  - Procrastinate is Postgres-backed, so there is no Redis.
- **Cons**:
  - Two languages, two toolchains, two lint/type stacks and two package managers in `setup` and `ci`. That costs a solo developer time and makes CI slower.
  - Types reach the web only through OpenAPI codegen with a diff gate. Isomorphic helpers (money and time formatting) would have to be implemented twice, once in Python and once in TS.
- **Technical Fit**: Medium.
- **Complexity**: High (dual stack).
- **Scalability**: High.

### Evaluation Matrix (integrated stacks; 1 to 5, higher is better)

| Criteria | Option I: Lean TS, all-PG | Option II: Nest/Prisma/BullMQ | Option III: FastAPI dual-stack |
|----------|------|------|------|
| Scalability | 4 | 5 | 4 |
| Maintainability | 4 | 4 | 3 |
| Performance | 4 | 5 | 4 |
| Security | 5 (AAD crypto, DB CHECK guards) | 4 | 4 |
| Observability | 5 (one OTel/pino stack, job state in SQL) | 4 (queue state in Redis) | 4 |
| Implementation Cost (5 = cheapest) | 5 | 3 | 2 |
| **Unweighted total** | **27** | 25 | 21 |

Option I is the chosen stack. The per-question choices below are its parts, each weighed against real alternatives.

---

### Q1: Backend framework

| Option | Summary |
|---|---|
| **1A NestJS (TS)** | DI, modules, decorators; Express or Fastify adapter. |
| **1B Fastify (TS)** | Plugin encapsulation, built-in pino logging, JSON-schema validation, `fastify-type-provider-zod`, `@fastify/swagger` for OpenAPI. |
| **1C Express 5 (TS)** | Minimal; validation, OpenAPI and logging are all separate add-ons; weaker typing of request lifecycles. |
| **1D FastAPI (Python)** | Spec Option B. |

| Criterion (weight) | 1A Nest | 1B Fastify | 1C Express 5 | 1D FastAPI |
|---|---|---|---|---|
| Maintainability (.25) | 5 | 4 | 3 | 3 |
| Correctness/safety (.25) | 4 | 4 | 3 | 4 |
| Time to market (.20) | 3 | 5 | 4 | 2 |
| Operational simplicity (.15) | 4 | 5 | 5 | 3 |
| Cost (.10) | 4 | 5 | 5 | 4 |
| Performance (.05) | 4 | 5 | 3 | 4 |
| **Weighted** | 4.05 | **4.50** | 3.70 | 3.20 |

Notes: Nest's advantage is structure. We recover most of it with a binding convention: one Fastify plugin per feature under `apps/api/src/modules/<feature>/{routes.ts,service.ts,repo.ts}`, dependencies passed explicitly through `buildApp(deps)`, and auth as a `preHandler` hook. FastAPI's native Decimal matters less than the shared-TS benefit and the dual-toolchain cost.

### Q2: Monorepo tooling and layout

| Option | Summary |
|---|---|
| **2A pnpm workspaces only** | Root scripts call root-level tools (`eslint .`, `prettier`, `vitest` projects) and `pnpm -r` for per-package `typecheck`/`build`. |
| **2B pnpm + Turborepo** | Task graph, local/remote cache, `turbo run`. |
| **2C Nx** | Project graph, generators, affected commands, plugins. |

| Criterion (weight) | 2A pnpm | 2B pnpm+Turbo | 2C Nx |
|---|---|---|---|
| Maintainability (.25) | 4 | 4 | 4 |
| Correctness/safety (.25) | 4 | 4 | 4 |
| Time to market (.20) | 5 | 4 | 3 |
| Operational simplicity (.15) | 5 | 4 | 3 |
| Cost (.10) | 5 | 5 | 4 |
| Performance (.05) | 3 | 5 | 5 |
| **Weighted** | **4.40** | 4.15 | 3.70 |

With three packages, caching saves seconds. Lint, format and tests are single root invocations, so there is no per-package fan-out to cache. Turborepo can be added later without breaking anything: root scripts would switch from `pnpm -r run x` to `turbo run x`. Revisit when there are more than 6 packages or CI goes over 6 min.

**Worker placement sub-decision:**

| Option | Summary | Weighted |
|---|---|---|
| **W1 Second entrypoint of `apps/api`** (`src/worker.ts`), same image, Compose `command` override | Handlers reuse domain services directly, e.g. billing uses the same payment service as the HTTP refund route. One Dockerfile. | **4.45** (4/4/5/5/5/4) |
| W2 Separate `apps/worker` plus a `packages/server-core` library | Clean process boundary, but domain services must move into a package, or apps import apps (an anti-pattern). Two images. | 3.80 (4/4/3/4/4/4) |

### Q3: Migrations tool and data-access layer

| Option | Summary |
|---|---|
| **3A Prisma ORM + Prisma Migrate** | Schema DSL with generated client. |
| **3B Drizzle ORM + drizzle-kit** | TS schema, SQL-like queries, generated migrations. |
| **3C node-pg-migrate (SQL files) + Kysely + kysely-codegen** | Hand-written reversible SQL, typed query builder, DB-introspected types. |
| **3D dbmate (SQL files) + Kysely + kysely-codegen** | Same as 3C with a Go-binary migrator. |

| Capability | 3A Prisma | 3B Drizzle | 3C npm + Kysely | 3D dbmate + Kysely |
|---|---|---|---|---|
| PG enums | Yes | Yes | Yes (raw SQL) | Yes |
| CHECK constraints | Not modelled; hand-edit the SQL | Modelled (`check()`) | Yes | Yes |
| Triggers / plpgsql functions (Q9 counter, guest-count guard) | Hand-edit the SQL; drift fights | Custom SQL migration | Yes, first-class | Yes |
| Down migrations (AC-VERIFY-5) | **No** (forward-only) | **No** (forward-only) | Yes (`-- Down Migration`), programmatic `count: Infinity` | Yes, one step per `rollback` (loop needed) |
| NUMERIC returned as | `Decimal.js` object | string (default mode) | string (pg default) | string |
| Programmatic API for test harness | Limited | Yes | Yes (`runner()`) | Shell out |
| Extra runtime/binary | Query engine or generate step | No | No | Go binary via npm wrapper |
| Concurrency guard | Yes | Partial | Advisory lock | Yes |

| Criterion (weight) | 3A | 3B | 3C | 3D |
|---|---|---|---|---|
| Maintainability (.25) | 3 | 4 | 4 | 4 |
| Correctness/safety (.25) | 2 | 3 | 5 | 5 |
| Time to market (.20) | 4 | 4 | 4 | 4 |
| Operational simplicity (.15) | 3 | 4 | 5 | 4 |
| Cost (.10) | 5 | 5 | 5 | 5 |
| Performance (.05) | 3 | 5 | 5 | 5 |
| **Weighted** | 3.15 | 3.90 | **4.55** | 4.40 |

Kysely is a query builder, not an ORM. SQL stays visible, which suits a schema defined by DB constraints (P1). Transactions are explicit, and `sql` template literals cover function calls and `FOR UPDATE`.

### Q4: Job runner and scheduler

| Option | Summary |
|---|---|
| **4A pg-boss** | Postgres queue; `schedule(name, cron, data, { tz })`; `singletonKey`; `retryLimit`/`retryDelay`/`retryBackoff`; states `created → active → completed / retry / failed / cancelled`; `expireInSeconds` recovers jobs orphaned by a crashed worker; `send(..., { db })` for transactional enqueue. |
| **4B Graphile Worker** | Postgres queue with LISTEN/NOTIFY (low latency), `add_job()` callable from SQL/triggers, `job_key` dedupe, crontab. |
| **4C BullMQ + Redis** | Fast, mature, repeatable jobs with `tz`. |
| **4D Host platform cron → HTTP endpoints** | The platform scheduler POSTs to `/internal/cron/<slot>`. |

| Requirement | 4A pg-boss | 4B Graphile | 4C BullMQ | 4D Platform cron |
|---|---|---|---|---|
| IANA-tz cron (AC-ASYNC-2) | Per schedule `tz` | **No per-entry tz**; follows the process timezone, so it would need `TZ=Pacific/Auckland` on the worker (breaks host-TZ independence) | Per job `tz` | Varies; many are UTC-only |
| Dedupe key (AC-ASYNC-3) | `singletonKey` | `job_key` | `jobId` | None |
| Restart survival after SIGKILL | Via `expireInSeconds`, configurable per queue | Locks of a crashed worker are released only after **about 4 h** (crash recovery is a Pro feature) | Stalled-job checker | N/A (no retry) |
| Retry + visible failed state (AC-ERROR-3) | `state='failed'`, `output`, `retry_count` in SQL | Yes (`attempts`, `last_error`) | Yes, in Redis | No |
| Transactional with domain writes (P5) | Yes (`db` option) | Yes (SQL `add_job`) | **No**; needs an outbox | No |
| Extra service | None | None | Redis | Platform coupling |

| Criterion (weight) | 4A | 4B | 4C | 4D |
|---|---|---|---|---|
| Maintainability (.25) | 4 | 4 | 4 | 3 |
| Correctness/safety (.25) | 5 | 3 | 3 | 2 |
| Time to market (.20) | 4 | 4 | 4 | 3 |
| Operational simplicity (.15) | 5 | 5 | 2 | 3 |
| Cost (.10) | 5 | 5 | 3 | 5 |
| Performance (.05) | 3 | 5 | 5 | 3 |
| **Weighted** | **4.45** | 4.05 | 3.40 | 2.95 |

**Post-game-billing trigger shape:**

| Option | Summary | Weighted |
|---|---|---|
| T1 Periodic sweep only | A cron job every 5 min bills every due session inline. Self-healing, but one slow session delays the rest and one failure retries the whole batch. | 4.40 (4/4/5/5/5/3) |
| T2 Delayed job per session at publish time | `startAfter = ends_at`. Must be cancelled or re-scheduled on every court-time edit, session cancel or override; orphaned or stale jobs bill at the wrong time. Nothing catches a session missed by a bug. | 3.45 (3/3/3/4/5/5) |
| **T3 Sweep → per-session job (hybrid)** | The `post-game-billing` cron (`*/5 * * * *`) selects `status='PUBLISHED' AND ends_at <= now()` and enqueues `bill-session` with `singletonKey = 'bill-session:<session_id>'`. Each session retries and fails on its own. Edits need no job bookkeeping, and the sweep re-finds anything missed. | **4.75** (5/5/4/5/5/4) |

### Q5: Encryption at rest and key management

| Option | Summary |
|---|---|
| **5A App-level AES-256-GCM (`node:crypto`) with an env keyring and key-ID prefix** | No dependencies; 96-bit random IV; 128-bit tag; AAD binds the ciphertext to table, column and row. |
| **5B App-level XChaCha20-Poly1305 (libsodium)** | 192-bit nonce (larger random-nonce margin); native or WASM dependency. |
| **5C `pgcrypto` `pgp_sym_encrypt`** | The key is passed in SQL text or params, so it can reach `pg_stat_statements`, slow-query logs or error logs (violates AC-ERROR-4). |
| **5D Volume/disk encryption only** | Does not meet the column-level requirement (AC-VERIFY-13). **Disqualified**, though still used in production as defence in depth. |

| Criterion (weight) | 5A AES-GCM | 5B XChaCha | 5C pgcrypto |
|---|---|---|---|
| Maintainability (.25) | 4 | 4 | 3 |
| Correctness/safety (.25) | 5 | 5 | 2 |
| Time to market (.20) | 5 | 4 | 4 |
| Operational simplicity (.15) | 4 | 4 | 4 |
| Cost (.10) | 5 | 5 | 5 |
| Performance (.05) | 5 | 5 | 4 |
| **Weighted** | **4.60** | 4.40 | 3.35 |

The AES-GCM nonce budget (about 2³² random-IV encryptions per key) is far above the expected volume, which is a few thousand team rows. Each key rotation also resets it.

**Which columns to encrypt:**

| Column | Decision | Why |
|---|---|---|
| `teams.bank_account_number` | **Encrypt** (MUST) | Financial identifier. |
| `teams.akahu_app_token` | **Encrypt** (MUST) | Credential. |
| `teams.bank_account_name` | **Encrypt** | Often a private individual's name (club treasurer) tied to a bank account, so personal information under IPP 5. Cheap to protect, and never needed in a WHERE clause. |
| `teams.ird_number` | **Encrypt** | A government identifier, possibly an individual's (sole-trader organiser). The observability standard forbids it in logs. |
| `teams.akahu_merchant_id` | **Plaintext** | An identifier, not a secret. Akahu webhook handling will likely look teams up by it, and random-IV ciphertext can't be indexed. |
| `teams.gst_number` | **Plaintext** | Printed on every tax invoice by law, so public by design. |

**Display projection:** add `teams.bank_account_last4 CHAR(4) CHECK (bank_account_last4 ~ '^[0-9]{4}$')`. It holds the last 4 digits of the account body, written by the app together with the ciphertext. The UI shows "Account ending 0123" without decrypting, so decryption happens only on the Akahu routing path. It is recorded as a deviation.

### Q8: Production email provider and adapter contract

| Option | Summary |
|---|---|
| **8A Postmark** | Transactional-only focus, strong deliverability, clear error codes (e.g. 406 inactive recipient, 300 invalid email), message streams, simple REST. US-hosted. |
| **8B AWS SES** | Cheapest, with an ap-southeast-2 region. Needs sandbox exit, SNS bounce/complaint plumbing and more setup. Best only if hosting lands on AWS. |
| **8C Resend** | Simple API with a native `Idempotency-Key` header. Younger, US-hosted. |
| **8D SendGrid** | Mature, but marketing-oriented and noisier deliverability for small senders. |

| Criterion (weight) | 8A Postmark | 8B SES | 8C Resend | 8D SendGrid |
|---|---|---|---|---|
| Maintainability (.25) | 4 | 3 | 4 | 3 |
| Correctness/safety (.25), deliverability and error semantics | 5 | 4 | 4 | 3 |
| Time to market (.20) | 5 | 3 | 5 | 4 |
| Operational simplicity (.15) | 5 | 3 | 5 | 4 |
| Cost (.10) | 4 | 5 | 4 | 4 |
| Performance (.05) | 4 | 5 | 4 | 4 |
| **Weighted** | **4.60** | 3.55 | 4.35 | 3.50 |

Postmark is the **likely** provider. It is not built here, and no account is created. The contract below was checked against the error models of Postmark, SES and Resend, so any of them fits as a single adapter. IPP 12 note: US providers receive names, emails and amounts owed. The privacy policy must disclose this when the production adapter ships (wallet-and-akahu-billing).

### Q10: Hosting target (only as it constrains foundation)

| Option | Summary |
|---|---|
| **10A DigitalOcean App Platform (Sydney) + DO Managed PostgreSQL** | Container services and workers from one image; pre-deploy jobs for migrations; encrypted env secrets; managed PG in-region. |
| **10B AWS ECS Fargate + RDS PostgreSQL (ap-southeast-6 Auckland or ap-southeast-2 Sydney) + KMS + Secrets Manager** | Strongest key management and data residency; heaviest to operate. |
| **10C Fly.io (syd) Machines + managed Postgres** | Simple container deploys; managed-PG region and version availability to be confirmed. |
| **10D Vercel (web) + Render/Railway (api/worker/PG)** | Best Next.js ergonomics; two vendors; backend regions are not in AU/NZ (nearest Singapore); serverless web adds a cross-vendor hop. |

| Criterion (weight) | 10A DO | 10B AWS | 10C Fly | 10D Vercel+X |
|---|---|---|---|---|
| Maintainability (.25) | 4 | 4 | 4 | 3 |
| Correctness/safety (.25), residency, KMS, managed PG17 | 4 | 5 | 3 | 3 |
| Time to market (.20) | 5 | 2 | 4 | 4 |
| Operational simplicity (.15) | 5 | 2 | 4 | 3 |
| Cost (.10) | 4 | 3 | 4 | 3 |
| Performance (.05) | 4 | 5 | 4 | 4 |
| **Weighted** | **4.35** | 3.50 | 3.75 | 3.25 |

The **binding** output of Q10 is a set of hosting constraints (C1–C6, see Decision). The vendor is a **provisional default** (10A). Region lists and managed-PG17 availability must be re-checked when deployment is planned, because these vendor facts were not verified live for this document. 10B is the planned upgrade path if KMS-grade key custody becomes a requirement.

### Q12: Shared-types strategy and enum parity

| Option | Summary |
|---|---|
| **12A Hand-written `as const` enums + zod contracts in `@sgm/shared`, enforced by (i) a runtime `pg_enum` parity integration test and (ii) a compile-time type-equality check against kysely-codegen output** | One intentional, readable source for app code, with two independent drift guards. |
| **12B Enums generated from `pg_enum` into `@sgm/shared`** | One source (the DB), but the web package's source depends on a generated file that needs a running DB to regenerate; the whole DB enum surface leaks to the browser. |
| **12C OpenAPI → TS codegen (`openapi-typescript`) for web** | Needed under Option III, redundant under Option I (web imports the same zod schemas). |

| Criterion (weight) | 12A | 12B | 12C |
|---|---|---|---|
| Maintainability (.25) | 4 | 4 | 3 |
| Correctness/safety (.25) | 5 | 4 | 4 |
| Time to market (.20) | 5 | 4 | 3 |
| Operational simplicity (.15) | 5 | 4 | 4 |
| Cost (.10) | 5 | 5 | 5 |
| Performance (.05) | 5 | 5 | 5 |
| **Weighted** | **4.75** | 4.15 | 3.70 |

---

## Observability Architecture

### Logging
- **Library**: pino, wrapped by `apps/api/src/lib/logger/logger.ts` (`createLogger`, `child`, `withTraceContext`). Fastify uses the same instance as its logger. **Deviation from the observability standard §5.3** (`packages/observability`): there is only one Node backend codebase, so the logger lives in `apps/api/src/lib/logger`. Move it to a package if a second Node service appears.
- **Format**: one JSON object per line: `timestamp` (ISO 8601), `level` (label), `message`, `service` (`api` | `worker`), `version`, `environment`, `traceId`, `spanId`, `requestId` (HTTP), `jobId` + `queue` (jobs). These are the standard's camelCase names. They **supersede** the snake_case list in the task's Observability Requirements (`ts`, `trace_id`, …), which should be edited to match.
- **Redaction** (pino `redact`, censor `[REDACTED]`): `req.headers.authorization`, `req.headers.cookie`, `*.password*`, `*.*_token`, `*.bank_account_*`, `*.ird_number`, `*.akahu_*`, `*.encryptionKeys`, plus `LOG_REDACT_PATTERNS`. The crypto module never logs inputs or outputs, and its errors carry no payload (AC-ERROR-4).
- **Rule**: `console.*` is banned in `apps/api/src` by ESLint (`no-console: error`), except `src/cli.ts`.
- **Configuration**: `LOG_LEVEL` (default `info`, `debug` in dev), `LOG_FORMAT` (`json` | `text`; `text` uses pino-pretty, dev only), `LOG_OUTPUT` (`stdout` | `file` | `both`), `LOG_FILE_PATH` (required if the output includes a file).

### Distributed Tracing
- **SDK**: OpenTelemetry NodeSDK in `apps/api/src/instrumentation.ts`, loaded with `node --import ./dist/instrumentation.js`. Instrumentations: `@fastify/otel`, `@opentelemetry/instrumentation-pg`, `@opentelemetry/instrumentation-http` / undici. Web uses Next.js `src/instrumentation.ts` (`registerOTel`) for server-side fetch spans.
- **Default exporter**: none (`OTEL_TRACES_EXPORTER=none`). `console` in dev on request; `otlp` when `OTEL_EXPORTER_OTLP_ENDPOINT` is set.
- **Propagation**: W3C Trace Context.
- **Service Boundaries**:

  | From | To | Protocol | Propagation Method |
  |------|-----|----------|-------------------|
  | Browser | web | HTTPS | Next.js starts the root span (no inbound header required) |
  | web (server components) | api | HTTP | `traceparent`/`tracestate` injected by `api-client.ts` (`propagation.inject`) |
  | api | PostgreSQL | pg wire | Client spans only (`SELECT game_sessions`); no propagation |
  | api (enqueue) | pgboss.job | SQL (JSONB payload) | `payload._meta.traceparent` / `tracestate` written by the job wrapper |
  | worker (cron tick) | handler | in-process | New root span `"{slot} process"` with `job.type=scheduled`, `job.name` |
  | worker (fetch) | handler | in-process | `propagation.extract(payload._meta)`, child span `"{queue} process"` |
  | worker | Mailpit / Postmark | SMTP / HTTPS | Client span; `X-Trace-Id` header on the message for correlation (not W3C) |

- **Span naming**: `GET /health`, `SELECT pgboss.job`, `heartbeat send`, `heartbeat process`, `Notifier.send`.
- **Sampling**: `OTEL_TRACES_SAMPLER=parentbased_traceidratio`; `OTEL_TRACES_SAMPLER_ARG=1.0` in dev and `0.1` in production (set at deployment).

### Metrics
- Following the task plan, **`/metrics` is off by default** in foundation (`METRICS_ENABLED=false`). The OTel MeterProvider is wired so these names are fixed now and used by downstream features. With `METRICS_ENABLED=true`, the Prometheus exporter serves `METRICS_PORT` (default 9090) at `METRICS_PATH`.
- **Standard Metrics**:
  - `http_requests_total{method, route, status_code}`
  - `http_request_duration_seconds{method, route}`
  - `http_requests_in_flight{method, route}`
  - Process and Node runtime metrics (`process_*`, `nodejs_eventloop_lag_seconds`)
- **Custom Business Metrics** (low-cardinality labels only; never user, session, job or team IDs):
  - `sgm_jobs_total{queue, outcome}` (outcome: `completed|retried|failed|deduplicated`): job throughput and failures
  - `sgm_job_duration_seconds{queue}`: handler latency
  - `sgm_jobs_queue_depth{queue, state}`: backlog (gauge from pg-boss queue size)
  - `sgm_schedule_fires_total{slot}`: cron liveness
  - `sgm_notifications_total{adapter, outcome}` (outcome: `sent|transient_error|permanent_error`)
  - `sgm_crypto_errors_total{reason}` (reason: `unknown_key|auth_failed|malformed`): tamper and misconfiguration signal
  - `sgm_db_health_checks_total{result}`
- **Foundation's required signal** is the job lifecycle log: `job.enqueued|started|completed|retried|failed|deduplicated` with `durationMs`, `attempt` and `queue`, at error level for terminal `failed` (AC-ERROR-3).

### Configuration Variables

| Variable | Purpose | Default |
|----------|---------|---------|
| LOG_LEVEL | Log verbosity | `info` (`.env.example`: `debug`) |
| LOG_FORMAT | `json` or `text` (pretty, dev only) | `json` |
| LOG_OUTPUT | `stdout` / `file` / `both` | `stdout` |
| LOG_FILE_PATH | File sink path (required if output includes file) | none |
| LOG_REDACT_PATTERNS | Extra redaction keys | `password,secret,token,apiKey` |
| OTEL_SDK_DISABLED | Kill switch (tests) | `false` |
| OTEL_SERVICE_NAME | `sgm-api` / `sgm-worker` / `sgm-web` (set per process, not in `.env`) | per process |
| OTEL_TRACES_EXPORTER | `none` / `console` / `otlp` | `none` |
| OTEL_EXPORTER_OTLP_ENDPOINT | Collector endpoint | none |
| OTEL_TRACES_SAMPLER / _ARG | Sampler and ratio | `parentbased_traceidratio` / `1.0` |
| METRICS_ENABLED / METRICS_PORT / METRICS_PATH | Prometheus exporter | `false` / `9090` / `/metrics` |

All variables are validated by zod at boot; an invalid value fails fast (P7).

---

## Decision

**Chosen**: Option I, a lean TypeScript, all-Postgres stack. Per question:

### Q1: Backend framework
**Chosen**: **Node 24 LTS + TypeScript (strict) + Fastify 5**, with zod contracts (`fastify-type-provider-zod`) and `@fastify/swagger` generating `apps/api/openapi.yaml`.
- **Rationale**: highest weighted score (4.50). It shares TS types and zod schemas with Next.js directly, has pino built in (the observability standard's logger), keeps a small surface for one developer, and runs under `tsx`/esbuild with no decorator-metadata tooling.
- **Trade-offs accepted**: no framework-imposed module or DI system. We mitigate with the binding feature-plugin convention (`src/modules/<feature>/{routes,service,repo}.ts`, explicit `buildApp(deps)` injection) written into `systemPatterns.md`. Money needs a TS decimal strategy (Q6).

### Q2: Monorepo tooling and layout
**Chosen**: **pnpm 10 workspaces only** (no Turborepo or Nx). The **worker is a second entrypoint of `apps/api`** (`src/worker.ts`): the same image with a different `command`.
- **Rationale**: 4.40 and 4.45. Three packages don't need a task-graph cache. Root tools run once over the repo, and adding Turborepo later is non-breaking. The single backend codebase avoids cross-app imports and a second Dockerfile.
- **Trade-offs accepted**: no remote cache, and CI re-runs everything. That is acceptable under the 10-minute budget (estimated at about 5 min). `apps/worker/*` pins are **removed** and re-pinned into `apps/api` (see file list).
- **Internal-package mode**: `@sgm/shared` is a *just-in-time* package. `exports` points at `src/index.ts`, and there is no build step. Next.js consumes it with `transpilePackages: ['@sgm/shared']`. The api bundles it with tsup (esbuild), because Node's type stripping refuses `node_modules`.
- **Tailwind v4**: CSS-first config (`@import "tailwindcss"` in `globals.css`, `@tailwindcss/postcss`). **`apps/web/tailwind.config.ts` is dropped** from the pins.

### Q3: Migrations tool and data-access layer
**Chosen**: **node-pg-migrate with plain-SQL migration files** (`-- Up Migration` / `-- Down Migration`, one transaction per file, advisory lock) in `db/migrations/`, plus **Kysely** over **`pg` (node-postgres)** for data access, plus **kysely-codegen**. Its output (`apps/api/src/lib/db/types.generated.ts`) is committed and drift-checked in `test:integration`.
- **Rationale**: 4.55. It is the only option that gives real down migrations (AC-VERIFY-5 as written, no forward-only fallback) and first-class CHECK, trigger and function support (Q9, AC-VERIFY-7) through a programmatic API for the test harness. One driver serves Kysely, pg-boss, node-pg-migrate and OTel.
- **Trade-offs accepted**: SQL is written by hand, including every down section, with no generated DDL. The deviations record and conformance test make up for having no schema DSL. Codegen needs a migrated DB, which already exists in `test:integration`.

### Q4: Job runner and scheduler
**Chosen**: **pg-boss** (current stable major, pinned in the lockfile; the API details below are to be checked against that version at build), running inside the worker process. Scheduling uses `boss.schedule(slot, cron, data, { tz: 'Pacific/Auckland' })`. The **post-game-billing trigger shape is T3**: a 5-minute sweep enqueues one `bill-session` job per due session with `singletonKey = 'bill-session:<session_id>'`.
- **Rationale**: 4.45 and 4.75. It meets AC-ASYNC-1/2/3 and AC-ERROR-3 with no extra service, gives transactional enqueue (P5), and makes job state readable with SQL (`pgboss.job`, and `pgboss.archive` if the pinned version archives).
- **Trade-offs accepted**: polling latency (about 2 s) instead of LISTEN/NOTIFY, and recovery of a crashed worker's jobs is bounded by the queue's `expireInSeconds`, not instant. Both are fine for billing and reminders.
- **Defaults (plan-level)**: `retryLimit: 3`, `retryDelay: 5` s, `retryBackoff: true` (exponential), `expireInSeconds` per queue (heartbeat 60, handlers default 900), completed jobs kept at least 7 days for debugging. Handler concurrency 1 per queue in foundation.
- **Schedule slots** (names are binding per AC-ASYNC-2; handlers are no-ops in foundation):

  | Slot | Cron (Pacific/Auckland) | Later owner |
  |---|---|---|
  | `recurrence-materialisation` | `0 3 * * *` (daily; idempotent via `UNIQUE(recurring_rule_id, date)`) | session-scheduling-engine |
  | `post-game-billing` | `*/5 * * * *` (sweep → `bill-session` jobs) | wallet-and-akahu-billing |
  | `daily-overdue` | `0 4 * * *` | wallet-and-akahu-billing |

  **Rule:** no schedule may fire between 02:00 and 02:59 local time, because that hour is skipped on the day DST starts and repeated on the day it ends.
- **Delivery guarantee**: **at-least-once**. Every handler must be idempotent, backed by a DB unique constraint or a guarded status transition (e.g. `UPDATE … SET status='COMPLETED' WHERE status='PUBLISHED' RETURNING`), not only by `singletonKey`. `singletonKey` removes *concurrent* duplicates (queued or active) only. A duplicate sent after completion runs again unless the handler's own guard stops it.
- **Schema ownership**: pg-boss owns the `pgboss` schema. `db:migrate` installs or upgrades it (pg-boss's own migrator, run once after app migrations). The api and worker start with pg-boss migration disabled, so **no DDL runs at app boot**. `db:reset` drops `public` and `pgboss`. `db:rollback` touches only app migrations.
- **Roles**: the api process uses pg-boss as a producer only (no supervision, no scheduling). The worker process supervises, schedules and works.

### Q5: Encryption at rest and key management
**Chosen**: **5A, app-level AES-256-GCM via `node:crypto`** with an env-supplied keyring and a key-ID-prefixed envelope, AAD bound to table, column and row. Encrypted columns: `bank_account_number`, `akahu_app_token`, `bank_account_name`, `ird_number`. Plaintext: `akahu_merchant_id`, `gst_number`. Projection: `bank_account_last4`.
- **Envelope** (stored as `TEXT`): `v1.<keyId>.<iv_b64url(12B)>.<ciphertext_b64url>.<tag_b64url(16B)>`
- **DB guard (P1)**: every encrypted column has `CHECK (col IS NULL OR col ~ '^v1\.[a-z0-9-]{1,16}\.[A-Za-z0-9_-]{16}\.[A-Za-z0-9_-]*\.[A-Za-z0-9_-]{22}$')`. A plaintext write fails with `23514`, even from raw SQL.
- **AAD**: `sgm:v1:<table>.<column>:<rowId>`. A ciphertext copied to another row or column fails authentication. Callers must supply the row ID, which works because team rows exist before banking details are set.
- **Keyring**: `ENCRYPTION_KEYS="<id>:<base64 32 bytes>[,<id>:<base64>]"` and `ENCRYPTION_ACTIVE_KEY_ID=<id>`. Validation at boot: each key decodes to exactly 32 bytes, IDs match `^[a-z0-9-]{1,16}$`, and the active ID is present. Errors name the variable and key ID only, never key material (AC-ERROR-1). `pnpm run setup` generates a random dev key into the git-ignored `.env`, so no key is ever committed.
- **API**: `encrypt(plaintext, ctx) → Ciphertext` (branded string), `decrypt(ciphertext, ctx) → string`, `needsRotation(ciphertext) → boolean`, `reencrypt(ciphertext, ctx) → Ciphertext`. Errors are a typed `DecryptionError` with `reason: 'unknown_key' | 'auth_failed' | 'malformed'` and a fixed message, with no payload, plaintext or key (AC-ERROR-4).
- **Rotation runbook** (in `docs/getting-started.md`): add a new key, flip `ENCRYPTION_ACTIVE_KEY_ID`, re-encrypt rows where `split_part(col, '.', 2) <> active` (a job owned by team-banking-and-gst), then remove the old key.
- **Production key custody**: the platform's encrypted secret store (C4). The `KeyProvider` interface lets a KMS-unwrapped data-key provider replace the env provider later without changing callers or the envelope.
- **Trade-offs accepted**: no KMS in v1 (the key lives in the process environment), and random-IV ciphertext can't be searched. Both are acceptable for community-club scale and documented as risks.

### Q8: Email provider and notifier contract
**Chosen**: likely provider **Postmark** (not integrated here). A provider-neutral **`Notifier`** contract:

```ts
interface EmailMessage {
  to: EmailAddress;                 // exactly one recipient per send (per-recipient idempotency, suppression, retries)
  subject: string;                  // ≤ 998 chars, no CR/LF (header-injection guard)
  text: string;                     // required plain-text body
  html?: string;
  from?: EmailAddress;              // defaults to EMAIL_FROM
  replyTo?: EmailAddress;
  idempotencyKey: string;           // REQUIRED, e.g. 'overdue-reminder:<payment_id>:<yyyy-mm-dd>' (≤ 255 chars)
  tags?: Record<string, string>;    // low-cardinality metadata (e.g. { template: 'low-credit' }); mapped to provider metadata
}
interface SendResult { providerMessageId: string; acceptedAt: Date; deduplicated: boolean }
interface Notifier { send(msg: EmailMessage): Promise<SendResult> }  // resolves only on provider acceptance

class NotificationError extends Error { readonly retryable: boolean; readonly adapter: string; readonly providerCode?: string }
class TransientDeliveryError   extends NotificationError {} // network, timeout, 5xx, 429 → retryable = true
class PermanentDeliveryError   extends NotificationError {} // invalid/suppressed recipient, 4xx content rejection → false
class NotifierConfigurationError extends NotificationError {} // auth failure / unknown sender → false; log at error
```

- **Adapters**: `smtp` (nodemailer; dev and CI point at Mailpit; also works with provider SMTP relays), `memory` (captures messages for tests, dedupes by `idempotencyKey`, and can be configured to throw each error class). A future `postmark` adapter goes in `adapters/postmark.ts`. Selection is by `NOTIFIER_ADAPTER=smtp|memory[|postmark]` only (AC-VERIFY-16).
- **Idempotency mapping**: Resend uses the `Idempotency-Key` header natively. Postmark and SES have no native key, so dedupe comes from the job layer (`singletonKey = 'notify:<idempotencyKey>'`) plus the notification delivery log that wallet-and-akahu-billing adds later. Every adapter also sets an `X-Idempotency-Key` header, which is visible in Mailpit.
- **Job integration**: `sendEmail` jobs rethrow `TransientDeliveryError` (pg-boss retries). `PermanentDeliveryError` and `NotifierConfigurationError` are logged at error and end the job in `failed` without burning retries where the pinned pg-boss version allows it; otherwise they use the normal `retryLimit`, which is harmless (AC-ERROR-6).
- **Trade-off accepted**: one recipient per call means N calls for N recipients. That is correct for per-player reminders and keeps retry scope minimal.

### Q10: Hosting constraints
**Chosen**: binding constraints **C1–C6**, with **DigitalOcean App Platform (Sydney) + DO Managed PostgreSQL as the provisional vendor** (to be re-verified by the deployment feature).
- **C1**: The host must run **long-lived containers**. The api (HTTP) and worker (no public port, internal `/health`) are two services from one image. The scheduler runs **in the worker process** (pg-boss), not in platform cron. Serverless-only hosts are out for api and worker.
- **C2**: **Managed PostgreSQL 17** in **AU or NZ** (IPP 12 comparable jurisdiction). Must allow the `pgboss` schema and `CREATE` on the app DB. `DATABASE_URL` must include `sslmode=require` (or `verify-full`) when `NODE_ENV=production`, enforced by the config validator.
- **C3**: A **pre-deploy/release command** runs `node dist/cli.js db migrate` once per deploy. Apps never migrate at boot.
- **C4**: **Secrets** (`ENCRYPTION_KEYS`, `DATABASE_URL`, provider tokens) come from the platform's encrypted secret store as env vars. They are never in the image, repo or logs. KMS is optional later through `KeyProvider`.
- **C5**: **TLS** terminates at the platform edge. Internal api ↔ web traffic uses the platform private network or HTTPS.
- **C6**: The web app runs as a Next.js `output: 'standalone'` container on the same platform (one vendor). Moving it to Vercel later is possible because web is stateless and talks only to `API_INTERNAL_URL`.

### Q12: Shared-types strategy
**Chosen**: **12A**. `packages/shared/src/types/enums.ts` exports each DB enum as `export const UserSex = ['MALE','FEMALE','OTHER'] as const; export type UserSex = typeof UserSex[number];` in DB order, including the new `auth_provider`. API DTOs are zod schemas in `packages/shared/src/api/*.ts`, used by Fastify routes and by `apps/web/src/lib/api-client.ts`. Parity is enforced three ways:
1. **Runtime** (`enum-parity.int.test.ts`, AC-INTEGRATION-2): for every mapped `pg_type`, the `enumlabel`s ordered by `enumsortorder` must equal the shared tuple exactly, both ways. The test also fails if a DB enum in `public` has no mapping entry.
2. **Compile time** (`apps/api/src/lib/db/enum-parity.ts`): `AssertEqual<Generated.UserSex, Shared.UserSex>` for each enum, so `typecheck` fails if the generated types and the shared types diverge.
3. **Codegen drift** (`db-codegen.int.test.ts`): it regenerates the kysely-codegen output against the freshly migrated test DB and fails on any diff from the committed `types.generated.ts`. It also fails if `openapi.yaml` differs from the spec generated from the routes (a unit test, no DB).
- **Trade-off accepted**: adding an enum value touches two files (the migration and `enums.ts`). The tests make forgetting either one impossible to merge.

### Trade-offs Accepted (summary)
- Structure by convention, not by framework (Fastify instead of Nest). The convention is written down and reviewed.
- Hand-written SQL, including downs, instead of a schema DSL. This buys exact constraints and real reversibility.
- Polling job runner with expiry-bounded crash recovery instead of Redis speed. This buys transactional enqueue and one fewer service.
- Keys in the platform secret store instead of KMS in v1, with a swappable `KeyProvider`.
- No task-graph cache (no Turborepo) until repo size justifies it.

---

## Repository Layout (final)

```
shared-game-management/
├── package.json                 # root scripts (targets below), packageManager: pnpm@10.x, engines.node: ">=24 <25"
├── pnpm-workspace.yaml          # packages: [apps/*, packages/*]
├── .nvmrc                       # 24
├── tsconfig.base.json           # strict, noUncheckedIndexedAccess, verbatimModuleSyntax, module ESNext, moduleResolution Bundler
├── eslint.config.mjs            # flat config: typescript-eslint (type-checked), eslint-config-next (web), prettier; no-console in api
├── .prettierrc.json  .prettierignore  .editorconfig  .dockerignore  .gitignore  .env.example
├── vitest.config.ts             # projects: unit (*.test.ts) | integration (*.int.test.ts, globalSetup, forks pool)
├── docker-compose.yml           # postgres:17, mailpit, api, worker, web  (no redis)
├── .github/workflows/ci.yml     # actionlint step + `pnpm run ci` with postgres:17 + mailpit service containers
├── scripts/
│   └── setup.ts                 # copies .env.example → .env if missing, generates dev ENCRYPTION_KEYS
├── db/
│   ├── migrations/              # <utc-timestamp>_<name>.sql  (node-pg-migrate SQL format; see file list)
│   └── schema-deviations.md
├── apps/
│   ├── web/                     # @sgm/web: Next.js App Router + Tailwind v4
│   │   ├── package.json  next.config.ts  postcss.config.mjs  tsconfig.json  Dockerfile  playwright.config.ts
│   │   ├── src/app/{layout.tsx,page.tsx,globals.css}
│   │   ├── src/lib/api-client.ts
│   │   ├── src/instrumentation.ts
│   │   └── e2e/smoke.spec.ts
│   └── api/                     # @sgm/api: Fastify HTTP process + pg-boss worker process (same image)
│       ├── package.json  tsconfig.json  tsup.config.ts  Dockerfile  openapi.yaml
│       ├── src/
│       │   ├── main.ts          # HTTP entrypoint
│       │   ├── worker.ts        # worker entrypoint
│       │   ├── app.ts           # buildApp(deps): Fastify factory
│       │   ├── cli.ts           # db migrate|rollback|reset, jobs trigger|schedules
│       │   ├── instrumentation.ts
│       │   ├── openapi.ts       # generate/print OpenAPI from routes
│       │   ├── routes/health.ts
│       │   ├── jobs/{heartbeat.ts,schedules.ts,registry.ts}
│       │   ├── modules/         # (empty; feature plugins land here: modules/<feature>/{routes,service,repo}.ts)
│       │   └── lib/
│       │       ├── config/config.ts (+ config.test.ts)
│       │       ├── db/{pool.ts,kysely.ts,types.generated.ts,enum-parity.ts,migrate.ts}
│       │       ├── logger/logger.ts (+ logger.test.ts)
│       │       ├── crypto/{crypto.ts,keyring.ts} (+ crypto.test.ts)
│       │       ├── notifications/{notifier.ts,errors.ts,adapters/smtp.ts,adapters/in-memory.ts} (+ notifications.test.ts)
│       │       └── jobs/jobs.ts (+ jobs.test.ts)
│       └── test/
│           ├── global-setup.ts  # migrate template DB once per run
│           ├── helpers/test-db.ts
│           ├── fixtures/expected-schema.ts   # hand-written from database-design.md (AC-INTEGRATION-1)
│           └── integration/*.int.test.ts
├── packages/
│   └── shared/                  # @sgm/shared: isomorphic, JIT (exports → src/index.ts)
│       ├── package.json  tsconfig.json
│       └── src/{index.ts, types/enums.ts, api/health.ts, money/money.ts(+test), time/time.ts(+test)}
└── docs/
    ├── getting-started.md
    └── adr/0001-backend-framework.md … 0008-shared-types.md
```

**Source language pins** (for `systemPatterns.md` → Code Organization Patterns): TypeScript only. `.ts` for all logic, `.tsx` only for React components under `apps/web/src/app/**` and `apps/web/src/components/**`, `.sql` for migrations, `.mjs` only for tool configs that require it (`eslint.config.mjs`, `postcss.config.mjs`). No new `.js`/`.jsx`. Tests are co-located as `*.test.ts` (unit) or live in `test/integration/*.int.test.ts` (integration). E2E is `apps/web/e2e/*.spec.ts`.

---

## Root Commands

Invoke every target as **`pnpm run <target>`**. `pnpm setup` is a built-in pnpm command that configures `PNPM_HOME`, and `ci` clashes with pnpm's own `ci` subcommand, so the bare forms don't run our scripts.

| Target | Command (root `package.json`) | Needs DB? |
|---|---|---|
| `setup` | `corepack enable && pnpm install --frozen-lockfile && tsx scripts/setup.ts` | No |
| `dev` | `docker compose up -d --wait postgres mailpit && pnpm run db:migrate && pnpm -r --parallel --filter "./apps/*" dev` (api: `tsx watch src/main.ts` + `tsx watch src/worker.ts`; web: `next dev`) | Yes |
| `lint` | `eslint . --max-warnings 0 && prettier --check .` | No |
| `typecheck` | `pnpm -r --workspace-concurrency=4 exec tsc --noEmit -p tsconfig.json` | No |
| `test` | `vitest run --project unit` (no DB, no network; coverage on foundation modules via `--coverage`) | No |
| `test:integration` | `vitest run --project integration` (needs `DATABASE_URL` to a PG17 server with `CREATEDB`, and `MAILPIT_API_URL`/`SMTP_URL`) | Yes |
| `db:migrate` | `pnpm --filter @sgm/api exec tsx src/cli.ts db migrate` (node-pg-migrate up to latest, then pg-boss schema install/upgrade) | Yes |
| `db:rollback` | `pnpm --filter @sgm/api exec tsx src/cli.ts db rollback` (one step; `-- --count N` or `-- --all` to zero) | Yes |
| `db:reset` | `pnpm --filter @sgm/api exec tsx src/cli.ts db reset` (drops `public` + `pgboss`, recreates, migrates; refuses when `NODE_ENV=production` or the host isn't local unless `--force`) | Yes |
| `build` | `pnpm -r build` (web: `next build`; api: `tsup` producing `dist/{main,worker,cli,instrumentation}.js`; shared: no build) | No |
| `ci` | `pnpm run lint && pnpm run typecheck && pnpm run test && pnpm run test:integration && pnpm run build` | Yes |
| *extra* `db:new` | `pnpm --filter @sgm/api exec node-pg-migrate create --migration-file-language sql -m ../../db/migrations <name>` | No |
| *extra* `db:codegen` | `pnpm --filter @sgm/api exec kysely-codegen --out-file src/lib/db/types.generated.ts` (config maps `numeric` → Money type; see Algorithm constraints) | Yes |
| *extra* `openapi` | `pnpm --filter @sgm/api exec tsx src/openapi.ts > apps/api/openapi.yaml` | No |
| *extra* `jobs:trigger` | `pnpm --filter @sgm/api exec tsx src/cli.ts jobs trigger <slot\|heartbeat> [json]` (AC-ASYNC-2 manual trigger) | Yes |
| *extra* `test:e2e` | `playwright test -c apps/web/playwright.config.ts` against the running Compose stack (not in `ci`; AC-INTEGRATION-4) | Stack |
| *extra* `lint:actions` | `docker run --rm -v "$PWD:/repo" -w /repo rhysd/actionlint:latest` | No |

**CI** (`.github/workflows/ci.yml`): triggers on `push` to `main` and `pull_request` to `main`. One job on `ubuntu-latest`. Services: `postgres:17` (health-cmd `pg_isready`, `-c timezone=UTC`) and `axllent/mailpit`. Steps: checkout, `pnpm/action-setup`, `actions/setup-node` (node 24, `cache: pnpm`), `pnpm install --frozen-lockfile`, actionlint (`raven-actions/actionlint` or the docker image), then `pnpm run ci`. Optional: gitleaks (COULD). The budget estimate is about 5 min, against a limit of 10.

**Compose**: `postgres` (`postgres:17`, `command: postgres -c timezone=UTC`, `pg_isready` healthcheck), `mailpit`, `api` (runs `node dist/cli.js db migrate && node --import ./dist/instrumentation.js dist/main.js`; migrating at startup is a dev-Compose convenience only, and prod uses C3; healthcheck `node -e "fetch('http://localhost:4000/health').then(r=>process.exit(r.ok?0:1))"`), `worker` (same image, `dist/worker.js`, `depends_on: api: service_healthy`, healthcheck on `WORKER_HEALTH_PORT` 4001), `web` (standalone Next, depends on api healthy, healthcheck on `/`).

**Integration DB isolation (AC-VERIFY-17)**: `global-setup.ts` builds a template DB `sgm_tpl_<runId>` once per run (migrations plus pg-boss schema) under a Postgres advisory lock. Each Vitest fork clones `sgm_test_<runId>_<workerId>` from it with `CREATE DATABASE … TEMPLATE …`, which takes under a second, and drops it on teardown. Tests that can use transaction rollback do. Concurrency tests (invoice numbers, jobs) use their own cloned DB. Two concurrent `test:integration` runs don't collide because `runId` is unique per run.

**Worker restart test (AC-ASYNC-3)**: the test spawns `tsx src/worker.ts` as a child process, SIGKILLs it mid-job and respawns it. The test queue uses `expireInSeconds: 5`, so it runs the same way locally and in CI with no Docker-in-Docker. The Compose-level `docker compose kill worker` check is a manual verification step.

---

## New Source Files (confirmed / re-pinned)

Legend: **=** confirmed as provisional; **R** re-pinned or renamed; **+** new; **−** removed.

**Root and tooling**
- = `package.json`, `pnpm-workspace.yaml`, `tsconfig.base.json`, `eslint.config.mjs`, `.prettierrc.json`, `.editorconfig`
- + `.nvmrc`, `.prettierignore`, `.dockerignore`, `vitest.config.ts`, `scripts/setup.ts`
- = `.env.example`, `.gitignore` (extend)
- = `docker-compose.yml` (no redis)
- = `.github/workflows/ci.yml`

**Web**
- = `apps/web/package.json`, `apps/web/next.config.ts`, `apps/web/postcss.config.mjs`, `apps/web/tsconfig.json`, `apps/web/Dockerfile`
- − `apps/web/tailwind.config.ts` (Tailwind v4 uses CSS-first config)
- + `apps/web/src/app/globals.css`
- = `apps/web/src/app/layout.tsx`, `apps/web/src/app/page.tsx`
- = `apps/web/src/lib/api-client.ts`
- + `apps/web/src/instrumentation.ts`
- = `apps/web/playwright.config.ts`, `apps/web/e2e/smoke.spec.ts`

**API and worker (single backend codebase)**
- = `apps/api/package.json`, `apps/api/tsconfig.json`, `apps/api/src/main.ts`, `apps/api/src/app.ts`
- + `apps/api/tsup.config.ts`, `apps/api/Dockerfile` (one image for api and worker)
- = `apps/api/src/routes/health.ts`
- = `apps/api/openapi.yaml` (now **generated** from routes and drift-checked) + `apps/api/src/openapi.ts`
- = `apps/api/src/lib/config/config.ts`
- = `apps/api/src/lib/db/pool.ts` (pg Pool; type parsers: NUMERIC→string, INT8→string, DATE→string, `TimeZone=UTC` per connection)
- + `apps/api/src/lib/db/kysely.ts`, `apps/api/src/lib/db/types.generated.ts`, `apps/api/src/lib/db/enum-parity.ts`, `apps/api/src/lib/db/migrate.ts` (node-pg-migrate runner + pg-boss schema install)
- = `apps/api/src/lib/logger/logger.ts`
- + `apps/api/src/instrumentation.ts` (OTel NodeSDK)
- = `apps/api/src/lib/crypto/crypto.ts` + `apps/api/src/lib/crypto/keyring.ts`
- = `apps/api/src/lib/notifications/notifier.ts`, + `apps/api/src/lib/notifications/errors.ts`
- R `apps/api/src/lib/notifications/adapters/mailpit.ts` → `apps/api/src/lib/notifications/adapters/smtp.ts` (generic SMTP; Mailpit is its dev target)
- = `apps/api/src/lib/notifications/adapters/in-memory.ts`
- = `apps/api/src/lib/jobs/jobs.ts` (createJobRunner, defineQueue, enqueue(trx?), schedule, work; trace `_meta`; lifecycle logs)
- + `apps/api/src/worker.ts` (worker entrypoint + internal `/health` on `WORKER_HEALTH_PORT`)
- + `apps/api/src/cli.ts`
- R `apps/worker/src/jobs/heartbeat.ts` → `apps/api/src/jobs/heartbeat.ts`
- R `apps/worker/src/schedules.ts` → `apps/api/src/jobs/schedules.ts`. **Slot names corrected to AC-ASYNC-2**: `recurrence-materialisation`, `post-game-billing`, `daily-overdue` (the provisional pins used `recurrence-materialise` and `overdue-sweep`).
- + `apps/api/src/jobs/registry.ts` (queue names + per-queue options; single source for worker and producers)
- − `apps/worker/package.json`, `apps/worker/tsconfig.json`, `apps/worker/src/main.ts`, `apps/worker/Dockerfile`
- + `apps/api/test/global-setup.ts`, `apps/api/test/helpers/test-db.ts`, `apps/api/test/fixtures/expected-schema.ts`

**Database**
- R `db/migrations/0001_enums.sql … 0010_indexes.sql` → `db/migrations/<utc-ts>_<name>.sql` (the prefix is whatever `db:new` emits; order preserved). Provisional split (Algorithm may reshape 7 and 9):
  1. `_enums.sql`: the 13 draft enums plus `auth_provider`, and any enum Algorithm adds
  2. `_users_and_auth_identities.sql`
  3. `_teams.sql`: encrypted TEXT columns with envelope CHECKs, `bank_account_last4`
  4. `_team_members.sql`: plus `auto_enroll_assigned_at`
  5. `_recurring_session_rules.sql`
  6. `_game_sessions_and_courts.sql`: plus `UNIQUE(recurring_rule_id, date)`, and session instants per Q7
  7. `_registrations_and_guests.sql`: per Q11
  8. `_wallet.sql`: `player_credits` (0–100 CHECK), `credit_transactions`; RESTRICT FKs
  9. `_payments_and_invoicing.sql`: `team_id`, fee snapshot (Q11), invoice allocator (Q9); RESTRICT FKs
  10. `_indexes.sql`
- = `db/schema-deviations.md`

**Shared**
- = `packages/shared/package.json`, `packages/shared/tsconfig.json`, `packages/shared/src/index.ts`
- = `packages/shared/src/types/enums.ts` (`as const` tuples + union types)
- + `packages/shared/src/api/health.ts` (zod `HealthResponse`)
- = `packages/shared/src/money/money.ts`, `packages/shared/src/time/time.ts`

**Docs and memory bank**
- = `docs/getting-started.md`; R `docs/adr/0001-backend-framework.md … 0008-shared-types.md`, one per architecture question (Q1, Q2, Q3, Q4, Q5, Q8, Q10, Q12), each linking to this document. Algorithm ADRs are numbered after these.
- = `memory-bank/techContext.md`, `memory-bank/systemPatterns.md` (extend)

**Test files (re-pinned)**
- R `apps/worker/test/integration/jobs.int.test.ts` → `apps/api/test/integration/jobs.int.test.ts`
- + `apps/api/test/integration/db-codegen.int.test.ts` (kysely-codegen drift)
- + `apps/api/src/openapi.test.ts` (OpenAPI drift; unit)
- + `apps/api/src/lib/jobs/jobs.test.ts` (wrapper unit: `_meta` injection, option mapping, lifecycle logs)
- + `apps/api/src/lib/logger/logger.test.ts` (redaction, trace fields, level config)
- All other test pins in the task's Test Strategy stay as written.

---

## Implementation Guidelines

1. **Boot order (both processes)**: `instrumentation.ts` (via `--import`), then `loadConfig()` (zod; any error prints `Invalid configuration: <VAR> — <issue>` without the value, then `process.exit(1)`, well within 5 s), then the logger, pool, keyring and notifier, then `listen` or `boss.start()`. Nothing binds a port or fetches a job before config and keyring validation pass (AC-ERROR-1).
2. **`/health`**: `SELECT 1` raced against a 1.5 s timeout, with `connectionTimeoutMillis: 1000` on the pool. It returns `{ status: 'ok'|'degraded', db: 'ok'|'unreachable', version }` with 200 or 503 (AC-ERROR-2). The pool recovers by itself because each checkout opens a new connection if needed.
3. **Pool type parsers** are set once in `pool.ts`: `1700 NUMERIC` → string (the default, kept explicitly), `20 INT8` → string, `1082 DATE` → raw `'YYYY-MM-DD'` string (the node-postgres default builds a local-midnight JS Date, which is host-TZ dependent and violates P3), `1083 TIME` → string, `1184 TIMESTAMPTZ` → `Date`. Every connection gets `options: '-c TimeZone=UTC'`.
4. **Transactional enqueue**: `jobs.enqueue(queue, data, { trx, singletonKey })` adapts the Kysely transaction to pg-boss's `db.executeSql` using `CompiledQuery.raw(text, values)`. Domain code never calls pg-boss directly.
5. **Queue registry**: every queue is declared once in `src/jobs/registry.ts` with `{ name, retryLimit, retryDelay, retryBackoff, expireInSeconds, policy }`. The worker creates queues at start (`createQueue` is idempotent) and the API only produces.
6. **Migrations**: every file has a working `-- Down Migration` section. Enum additions go in their own migration (`ALTER TYPE … ADD VALUE` can't be used in the same transaction). Their down section recreates the type, and `docs/getting-started.md` gives the pattern. Never edit an applied migration. Add a new one and update `db/schema-deviations.md` in the same PR.
7. **Schema dumps for AC-VERIFY-5** use the server's own `pg_dump` (`docker compose exec postgres pg_dump --schema-only --schema=public --no-owner --no-comments`, or the CI service container), so client/server version mismatch never breaks the diff. `pgmigrations` rows are excluded because the dump is schema-only.
8. **Conformance test** ignores `public.pgmigrations` and the `pgboss` schema, and asserts that no column in `public` is `timestamp without time zone` (P3).
9. **Encrypted columns**: domain repositories are the only callers of `crypto.encrypt/decrypt`. They pass `{ table, column, rowId }`. Kysely types for those columns are overridden to `Ciphertext` (branded) in the codegen config, so a raw string can't be inserted without the helper.
10. **Feature module convention**: `apps/api/src/modules/<feature>/{routes.ts, service.ts, repo.ts, jobs.ts?}`. Routes are thin and validate with shared zod schemas. Services hold rules and transactions. Repos hold Kysely queries.
11. **Web**: `page.tsx` is a server component with `export const dynamic = 'force-dynamic'`. It calls `apiClient.health()` (server-side, `API_INTERNAL_URL`) and renders "API: ok / unavailable". The client catches errors and timeouts (2 s) so a stopped api renders "unavailable", not a 500 (AC-INTEGRATION-4).
12. **Env vars** (`.env.example`, all placeholders): `NODE_ENV`, `SERVICE_VERSION`, `API_PORT=4000`, `WORKER_HEALTH_PORT=4001`, `DATABASE_URL`, `DATABASE_POOL_MAX=10`, `ENCRYPTION_KEYS=<generated-by-setup>`, `ENCRYPTION_ACTIVE_KEY_ID=dev1`, `NOTIFIER_ADAPTER=smtp`, `SMTP_URL=smtp://localhost:1025`, `EMAIL_FROM`, `MAILPIT_API_URL=http://localhost:8025`, `API_INTERNAL_URL=http://localhost:4000`, plus the observability variables above. `APP_TIMEZONE` is **not** configurable: `Pacific/Auckland` is a constant in `@sgm/shared/time`.

---

## Constraints handed to Algorithm Design

These are fixed by the architecture choices above. Q6, Q7, Q9 and Q11 must work within them, or explicitly re-open the named decision.

1. **Driver representation (Q6)**: node-postgres returns `NUMERIC` and `INT8`/`BIGINT` as **strings**, and `pool.ts` keeps that. With `DECIMAL(10,2)`, the money module parses the string. With `BIGINT` cents, it parses to `bigint` or a validated safe integer, **never** `Number(str)` without a range check. Either way the conversion lives only in the money module and repositories.
2. **Codegen typing (Q6)**: kysely-codegen maps `numeric` to `ColumnType<string, string | number, string | number>` by default, which would let a JS `number` into an insert. Its config must override money columns (or all `numeric`/money `int8`) to the shared branded Money type, and AC-VERIFY-14's "type-level guard" should be built on that brand. (Codegen option names to be confirmed against the pinned version.)
3. **Isomorphism (Q6, Q7)**: `money` and `time` live in `packages/shared` and run in the browser and in Node 24. No Node-only APIs and no native addons. `Intl` is available. Do not depend on native `Temporal` (availability across target browsers isn't guaranteed); a pure-JS library or polyfill is fine.
4. **Dates and instants (Q7)**: `DATE` comes back as a `'YYYY-MM-DD'` string, `TIME` as `'HH:MM:SS'`, `TIMESTAMPTZ` as a JS `Date`. DB sessions run with `TimeZone=UTC`. `timestamp without time zone` is banned by the conformance test.
5. **Session end instant (Q7 → Q4)**: the chosen T3 billing sweep needs an **indexed, queryable instant**, `game_sessions.ends_at timestamptz` (and probably `starts_at`), with an index on `(status, ends_at)`. If Q7 prefers to derive it in SQL (`(date + max(end_time)) AT TIME ZONE 'Pacific/Auckland'`), note that PostgreSQL's own resolution of nonexistent and ambiguous local times must then match the chosen DST policy exactly. Otherwise the app computes it with the time module and keeps it in sync on every court or date edit.
6. **Migration capabilities (Q9, Q11)**: node-pg-migrate SQL files run as one transaction each. Supported: `CREATE FUNCTION … LANGUAGE plpgsql` with `$$` bodies, triggers (row and statement, `DEFERRABLE INITIALLY DEFERRED` constraint triggers), `INSERT … ON CONFLICT … DO UPDATE … RETURNING`, `STORED` generated columns, partial unique indexes, sequences. Not in the same file: `CREATE INDEX CONCURRENTLY`, or using an enum value added in the same transaction. Every object needs a down section.
7. **Invoice allocation (Q9)**: the allocator must be callable as `sql\`select allocate_invoice_number(${teamId})\`` (or an equivalent single statement) **inside the caller's Kysely transaction**. If it is gapless, it is gapless only because it rolls back with that transaction. AC-VERIFY-9's 20-way test uses 20 separate pool connections, so `DATABASE_POOL_MAX` in the test config must allow at least 21.
8. **Idempotent billing (Q11 → wallet-and-akahu-billing)**: jobs are at-least-once. The fee snapshot / payment model must have a natural unique key that makes a replayed `bill-session` job harmless (e.g. `UNIQUE(registration_id, billing_type)` on payments, or a unique line per registration and guest) and a guarded session status transition.
9. **Financial rows (Q11)**: every new snapshot, line-item or guest table that holds money must use `ON DELETE RESTRICT` toward `users` and `teams` (AC-VERIFY-11), and each is recorded in `db/schema-deviations.md`.
10. **Enums (Q6, Q11)**: any new enum (e.g. an applied-tier enum for the snapshot) must be added to `packages/shared/src/types/enums.ts` in DB order. The three parity guards (runtime, compile time, codegen drift) will enforce it.
11. **Cron and DST (Q7)**: schedules are evaluated by pg-boss with `tz: 'Pacific/Auckland'` through its cron library (cron-parser). Q7's policy for session wall-clock times is separate from, and must not rely on, cron behaviour. No schedule may fire between 02:00 and 02:59 local time.
12. **Encryption does not touch money**: none of the encrypted columns are money or used in arithmetic or ordering. Q6 and Q11 have no crypto interaction.

---

## Validation Checklist

- [x] Meets all system requirements: every AC maps to a component (AC-VERIFY-1 layout and targets; -2 Compose; -3 lint/TS; -4 CI; -5 node-pg-migrate downs; -6 to -12 SQL constraints; -13 and AC-ERROR-4 AES-GCM + CHECK guard; -14/-15 shared money/time (Algorithm); -16 and AC-ERROR-6 Notifier; -17 template-DB isolation; -18 ADRs; AC-INTEGRATION-1 to -4; AC-ASYNC-1 to -3 pg-boss; AC-ERROR-1/2 config and health).
- [x] Respects technical constraints: PG 17, GitHub Actions, Compose without Redis, solo-developer simplicity.
- [x] Addresses non-functional requirements: 30 s migrate (about 10 small SQL files), 120 s Compose, CI about 5 min, encryption at rest, retention via RESTRICT, NZ localisation in shared.
- [x] Technically feasible: every library is mature and actively used. Version-specific API details (pg-boss option names, kysely-codegen overrides, `@fastify/otel`) are flagged for checking against the pinned versions at build.
- [x] Risks identified and acceptable (below).
- [x] Complies with Guiding Principles P1–P7 (no deviations). P1: CHECK/UNIQUE/RESTRICT plus the ciphertext CHECK. P2: string numerics and branded Money. P3: DATE-as-string parser, UTC sessions, `timestamptz`-only check. P4: AES-GCM with key ID and AAD. P5: pg-boss with transactional enqueue. P6: one `ci` target, and CI calls it. P7: zod fail-fast, no DDL at boot, `sslmode` enforced in production.
- [x] Respects established patterns: none exist yet (greenfield). This document establishes them for `systemPatterns.md`.
- [x] Observability architecture defined. One documented deviation: logger location (§5.3).
- [x] Trace context propagation across all service boundaries (web → api header; api → job `_meta`; cron root spans).
- [x] Logging strategy consistent with observability-requirements.md (camelCase fields, redaction, no `console`).
- [x] Metrics strategy follows naming conventions (snake_case, base units, `_total`/`_seconds`, `sgm_` prefix, no ID labels).

## Risk Assessment

| Risk | Likelihood | Impact | Mitigation |
|------|------------|--------|------------|
| pg-boss major-version API drift (queue creation, `singletonKey` semantics, archive table, option names) vs this document | M | M | Pin the version in the lockfile. All access goes through `lib/jobs/jobs.ts`. `jobs.int.test.ts` asserts the behaviours (dedupe, expiry recovery, failed state), not the internals. |
| Crashed-worker recovery takes `expireInSeconds`; a too-short value re-runs a still-healthy long job | M | M | Set expiry per queue to at least 3× the p99 handler time. Handlers are idempotent (at-least-once is documented). Billing is per-session and short. |
| Fastify lacks enforced structure; ten features drift into inconsistent shapes | M | M | Module convention in `systemPatterns.md`; code-review checklist; the first feature (auth) sets the reference implementation. |
| Hand-written down migrations are wrong or incomplete | M | M | AC-VERIFY-5 round-trip dump diff in `test:integration` on every CI run. |
| Keys in platform env (no KMS) leak through a platform or console compromise | L | H | Secrets only in the platform store; `KeyProvider` swap path to KMS (10B); rotation runbook; `sgm_crypto_errors_total` for tamper detection. |
| Managed PG 17 unavailable in the chosen AU/NZ region at deployment | L | M | C2 requires PG 17. Re-check vendor availability at deployment; AWS RDS (Sydney) supports 17 as the fallback. |
| Hosting vendor facts (regions, managed-PG17 availability) change | M | L | Q10 binds only constraints C1–C6. Vendor re-checked at deployment. |
| `pnpm setup` / `pnpm ci` run pnpm built-ins instead of our scripts | H | L | Always document `pnpm run <target>`. CI calls `pnpm run ci`. Getting Started says the same. |
| kysely-codegen output differs across PG minor versions, causing drift-check flakiness | L | L | Generate against the same `postgres:17` image in CI and Compose. The check runs only in `test:integration`. |
| JIT shared package breaks the api production bundle (TS in `node_modules`) | L | M | The api builds with tsup (esbuild bundles `@sgm/shared`). The Docker image runs only `dist/*.js`. `build` is part of `ci`. |

## Suggested spec wording changes

- **AC-VERIFY-16**: `send({ to, subject, text, html? })` → `send({ to, subject, text, html?, idempotencyKey })`. `idempotencyKey` is required by the Q8 contract. Also note "`to` is a single recipient".
- **AC-VERIFY-1 / Verification Method**: state that targets run as `pnpm run <target>`, because `pnpm setup` is a pnpm built-in and `pnpm ci` does not run the root script. Change "Option A: Node (NestJS or Express, TypeScript)" to "Option A: Node (TypeScript; Fastify chosen)", and set the job store observation point to `pgboss.job` (and `pgboss.archive` if the pinned version archives).
- **AC-VERIFY-5**: "`db:rollback` to version zero" → "`pnpm run db:rollback -- --all`". The pg_dump diff is limited to `--schema=public` (the pg-boss schema is owned by the runner).
- **AC-ASYNC-3**: "the worker container is killed … and restarted" → "the worker process is SIGKILLed (container or child process) and restarted; the interrupted job completes after the queue's expiry window (test config: 5 s, so within 30 s)".
- **AC-ERROR-1**: name the key variables: `ENCRYPTION_KEYS` (each key 32 bytes base64) and `ENCRYPTION_ACTIVE_KEY_ID`.
- **AC-VERIFY-13 (optional strengthening)**: add "a ciphertext copied into another row or column fails to decrypt (AAD binding)", and "a plaintext write into an encrypted column fails with `23514`". Record the Q5 column decision (encrypt `bank_account_name` and `ird_number`; keep `akahu_merchant_id` and `gst_number` plaintext; add `bank_account_last4`).
- **Architectural Plan → Observability**: log field names become the standard's camelCase (`timestamp`, `message`, `traceId`, `spanId`, `requestId`, `jobId`), and `LOG_FORMAT` becomes `json|text`.
- **Test Strategy → File Organization**: `apps/worker/test/integration/jobs.int.test.ts` → `apps/api/test/integration/jobs.int.test.ts`. Coverage glob `apps/api/src/lib/{crypto,config,notifications,jobs}` is unchanged.
- **Implementation Roadmap pins**: schedule slot names must be `recurrence-materialisation`, `post-game-billing` and `daily-overdue` (matching AC-ASYNC-2); the provisional pins disagreed.
- **Technical constraint note**: target is PostgreSQL 17 (decided 2026-09-29). AC-VERIFY-2 checks that `SELECT version()` starts with `PostgreSQL 17.`.

## Next Steps

1. Algorithm Design resolves Q6, Q7, Q9 and Q11 within the constraints above, and finalises migration files 6, 7 and 9 and the Money brand.
2. The planner applies the file re-pins and the AC wording changes to `memory-bank/tasks/platform-foundation.md`, then marks Architecture creative complete.
3. Phase 1 build: root workspace, `apps/api` (`main.ts`, `worker.ts`, `cli.ts` skeletons), `packages/shared`, lint, TS and Vitest projects, config fail-fast.
4. Phase 2 build: Compose (no Redis), Dockerfiles (api image with two commands), CI workflow with actionlint and `pnpm run ci`.
5. Phases 3 to 5 follow the task roadmap, using node-pg-migrate SQL, Kysely and codegen, AES-GCM crypto, pg-boss and Notifier as decided.
6. Phase 6: write ADRs 0001 to 0008 from this document, and fill `techContext.md` and `systemPatterns.md` (P1–P7 as Guiding Principles, the module convention and the language pins).
