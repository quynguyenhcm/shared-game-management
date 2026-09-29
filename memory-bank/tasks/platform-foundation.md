---
slug: platform-foundation
legacy_id:            # only set by the v2 migration for pre-2.0 tasks (e.g., TASK-007)
feature: platform-foundation
status: PLANNING_COMPLETE
---

# platform-foundation: Platform Foundation

**Complexity**: Level 4 (inherited from platform-foundation)
**Status**: PLANNING_COMPLETE
**Roadmap**: platform-foundation
**Branch**: feature/platform-foundation
**Worktree**: N/A (primary checkout)

## Task Description

Scaffold the repo and shared infrastructure every other feature builds on.

- Monorepo layout: Next.js + Tailwind web app, API service, shared types
- **Decide backend**: Node (Express/NestJS) or Python (FastAPI)
- PostgreSQL 17 migrations based on `database-design.md`, fixing the gaps it has against the spec:
  - auth identities table (password hash, Google/Facebook provider IDs)
  - `payments.team_id` (routing, GST, exports) and a per-payment fee snapshot
  - guest attributes (sex, skill level) so BY_SEX and BY_SKILL_LEVEL pricing can apply to guests
  - `UNIQUE(session_id, user_id)` on registrations; unique invoice number sequence per team
  - Akahu credentials and bank details encrypted at rest
- Background job runner / scheduler (recurrence, post-game billing, daily overdue cron)
- Email/notification service abstraction
- Money handling (DECIMAL / integer cents), Pacific/Auckland timezone handling
- Test harness, lint, CI pipeline, local dev via Docker Compose

Source specs: `PRODDUCT-OVERVIEW.md`, `database-design.md`, `workflows_state_machine_architecture.md` (repo root, untracked).

## Specification

**Feature Type**: NFR/Infrastructure
*Note: this is a greenfield scaffold. The "users" are developers and the ten downstream v1.0.0 features. The repo has no source files yet, so none of the paths below exist; every path is a target to be pinned in the plan.*
**Creative Exploration Needed**: Yes: Architecture Design (backend framework, monorepo tooling, migrations tool, job runner, encryption and key management, hosting target, shared-types strategy) and Algorithm Design (money representation and rounding, DST policy for local times, invoice-number allocation). Level 4, so creative is mandatory. See `### Creative Exploration Needed`.

**Spec interpretations honoured** (already decided, not re-opened here):
- Cancellation: the workflows doc wins (`NOW <= cancellation_deadline` means free). Overview §6 has it inverted. Foundation ships no cancellation logic, but the schema must not encode the inverted rule.
- The wallet $100.00 NZD cap applies to the **balance** (enforced as a DB constraint, AC-VERIFY-10).
- Subscription billing (`MONTHLY_SUBSCRIPTION`, `QUARTERLY_SUBSCRIPTION`) is out of scope for v1.0.0. The enum values are kept to match `database-design.md`, and no code path uses them.

### Verification Method

- **Test method**: Every check runs from one root task-runner entry point. Creative picks the runner: root `package.json` scripts via pnpm, or a `Makefile`/`justfile` if the backend is Python. The required named targets are `setup`, `dev`, `lint`, `typecheck`, `test` (unit), `test:integration`, `db:migrate`, `db:rollback`, `db:reset`, `build` and `ci`. `ci` runs lint, typecheck, unit, integration and build, in that order.
  The concrete commands behind those targets depend on the backend option (Creative Q1):

  | Concern | Option A: Node (NestJS or Express, TypeScript) | Option B: Python (FastAPI) |
  |---|---|---|
  | Workspace / install | `pnpm install` (pnpm workspaces, optionally Turborepo) | `pnpm install` (web + shared TS) **and** `uv sync` (api + worker) |
  | Lint + format | `eslint . --max-warnings 0` + `prettier --check .` | web: same as A; api: `ruff check .` + `ruff format --check .` |
  | Type check | `tsc --noEmit` (`strict: true`) in every package | web: `tsc --noEmit`; api: `mypy --strict` or `pyright` (strict) |
  | Unit tests | `vitest run` (or Jest) | web: `vitest run`; api: `pytest -m "not integration"` |
  | Integration tests | `vitest run --project integration` against real Postgres 17 | `pytest -m integration` against real Postgres 17 |
  | Migrations | node-pg-migrate, Drizzle Kit, Prisma Migrate or Knex, **or** tool-neutral `dbmate` (raw SQL) | Alembic **or** tool-neutral `dbmate` (raw SQL) |
  | Shared types | `packages/shared` TS package imported by web and api directly | TS types generated from the API's OpenAPI schema (e.g. `openapi-typescript`); CI fails if regeneration produces a diff |
  | Job runner candidates | pg-boss or Graphile Worker (Postgres-backed); BullMQ (needs Redis) | Procrastinate (Postgres-backed); Celery or arq (need Redis); APScheduler (scheduling only) |

  The local stack is `docker compose up -d --wait`, followed by `curl -fsS http://localhost:<API_PORT>/health` and a browser or `curl` check of `http://localhost:3000`. CI is `.github/workflows/ci.yml` on GitHub Actions (the repo remote is GitHub), and `actionlint` validates the workflow file.
- **Success metrics**:
  - `ci` exits 0 with **0 lint errors, 0 lint warnings, 0 type errors, 0 failing tests**. Injecting one deliberate violation of each kind makes it exit non-zero.
  - With images cached, `docker compose up -d --wait` reports every service healthy within **120 s** on a developer laptop.
  - `db:migrate` from an empty Postgres 17 database finishes in **30 s or less**. `db:rollback` to zero followed by `db:migrate` again also succeeds (a full down/up round trip).
  - The GitHub Actions `ci` job finishes in **10 min or less** wall-clock (proposed target; the plan may revise it with justification).
  - Line coverage is **80% or more** for the foundation library modules: money, time, crypto, notifications and job-runner wrapper. Proposed threshold; SHOULD.
  - Schema conformance: **100%** of tables, enum types and values, and indexes in `database-design.md` are present in the migrated database. The only exceptions are entries in the schema deviations record, and each of those cites its source requirement (AC-INTEGRATION-1).
  - **0** plaintext occurrences of the test bank account number or Akahu token in the raw column bytes of encrypted fields (AC-VERIFY-13).
- **Observable at**: terminal exit codes and test-runner output; the GitHub Actions run page for the PR; `docker compose ps` (health column); `GET /health` JSON on the API; the Mailpit web UI at `http://localhost:8025` and its REST API `GET http://localhost:8025/api/v1/messages`; the job runner's persisted job table or queue (e.g. `pgboss.job`, `graphile_worker.jobs` or `procrastinate_jobs`, depending on Creative Q4); and structured stdout logs from `api` and `worker`.
- **Verification frequency**: continuous. `ci` runs on every push and every PR targeting `main`. Developers run it locally before PR. The Compose health check runs on every `docker compose up`.

### Acceptance Criteria

#### AC-VERIFY-1: Monorepo layout exposes web, API, worker and shared-types units behind one root command set
**Priority**: MUST
**Given** a fresh clone of the repository
**When** a developer lists the top-level layout and runs the root task runner's help or list command
**Then** there is a Next.js + Tailwind web app, an API service, a background worker entry point (it may share the API's codebase but runs as a separate process), and a shared-types unit. All of the named targets `setup`, `dev`, `lint`, `typecheck`, `test`, `test:integration`, `db:migrate`, `db:rollback`, `db:reset`, `build` and `ci` exist and run without "command not found". The chosen directory names are pinned in the plan and recorded in `memory-bank/techContext.md` → Component Structure and Development Commands.

#### AC-VERIFY-2: Local dev stack starts healthy via Docker Compose on PostgreSQL 17 with UTC database time
**Priority**: MUST
**Given** Docker is running and `.env` has been created from the committed `.env.example`
**When** the developer runs `docker compose up -d --wait`
**Then** all services report healthy within 120 s (images cached): `postgres`, `api`, `worker`, `web`, `mailpit`, plus `redis` only if Creative Q4 picks a Redis-backed runner. `SELECT version()` returns a string that starts with `PostgreSQL 17.` and `SHOW timezone` returns `UTC`. `GET /health` on the API returns HTTP 200 with a body that reports database connectivity as ok. `http://localhost:3000` returns HTTP 200 and renders a page styled by Tailwind: the served CSS contains at least one Tailwind utility class that the page uses.

#### AC-VERIFY-3: Lint, format and type-check gates are strict and actually fail on violations
**Priority**: MUST
**Given** the scaffolded repo with no code violations
**When** `lint` and `typecheck` are run, and then run again after each of three deliberate violations is introduced separately: an unused variable, a mis-formatted file, and a type error (e.g. assigning a string to a numeric field)
**Then** the clean run exits 0 with 0 errors and 0 warnings. Each violation run exits non-zero and names the offending file. TypeScript runs with `strict: true`. If Option B is chosen, Python type checking runs in strict mode.

#### AC-VERIFY-4: CI pipeline runs the same gates as local `ci` against a real Postgres 17 service
**Priority**: MUST
**Given** `.github/workflows/ci.yml` is committed
**When** `actionlint` runs on the workflow, and later the branch is pushed or a PR to `main` is opened
**Then** `actionlint` reports 0 findings. The workflow triggers on `push` to `main` and on `pull_request` targeting `main`. It uses a `postgres:17` service container, runs the same `ci` target that developers run locally rather than a divergent step list, caches dependencies, and completes in 10 min or less. A failing test or lint violation marks the run failed. *Note: nothing has been pushed to `origin` yet, so the first real CI run happens at archive or push time. Until then, AC-VERIFY-4 is verified by `actionlint` plus a local `ci` run.*

#### AC-VERIFY-5: Migrations apply cleanly from empty and are reversible on PostgreSQL 17
**Priority**: MUST
**Given** an empty PostgreSQL 17 database
**When** `db:migrate`, then `db:rollback` to version zero, then `db:migrate` are run in sequence
**Then** every step exits 0. After the final step the schema is identical to the one after the first step: a `pg_dump --schema-only` diff, ignoring ownership and comments, is empty. The first migrate finishes in 30 s or less. The migrations use core `gen_random_uuid()` and do not depend on `uuid-ossp`, which `database-design.md` creates but never uses. If the chosen tool is forward-only, the plan must justify that, and the check becomes `db:reset` + `db:migrate` producing the identical dump.

#### AC-VERIFY-6: Auth identities table supports password, Google and Facebook sign-in for one user
**Priority**: MUST
**Given** the migrated schema and one `users` row
**When** the integration test inserts identities for that user
**Then** a `PASSWORD` identity with a non-null password hash, a `GOOGLE` identity and a `FACEBOOK` identity (each with a provider subject ID) can all coexist for the same user. Inserting a second identity with the same `(provider, provider_subject)` fails with SQLSTATE `23505`. A `PASSWORD` identity with a null password hash, or a `GOOGLE`/`FACEBOOK` identity with a non-null password hash, fails with `23514`. An identity without a user fails with `23502`. The password hash column fits a modern encoded hash string (argon2id/bcrypt, 255 chars or more). Hashing itself belongs to auth-and-user-roles.

#### AC-VERIFY-7: Registrations are unique per session and user, and guests carry sex and skill attributes
**Priority**: MUST
**Given** the migrated schema with one session and one user
**When** the integration test inserts registrations and guests
**Then**:
- A second registration for the same `(session_id, user_id)` fails with `23505`.
- `guest_count` values of `-1` and `3` fail with `23514` (the draft's `CHECK (guest_count <= 2)` allowed negatives).
- Each guest is stored with a sex (`user_sex`) and a skill level (`skill_tier`), so `BY_SEX` and `BY_SKILL_LEVEL` pricing can resolve a per-guest fee.
- A registration cannot have more than 2 guest records. Whether this is enforced by a CHECK on a positional column (1 or 2) or by a trigger is decided in the plan.
- The stored guest count and the number of guest records cannot drift apart. The plan either derives the count or enforces equality.

#### AC-VERIFY-8: Payments carry team routing and an immutable per-payment fee snapshot
**Priority**: MUST
**Given** the migrated schema
**When** the integration test inserts a payment
**Then**:
- `payments.team_id` is `NOT NULL` with an FK to `teams`, and an insert without it fails with `23502`.
- An index supports team-scoped export and report queries by paid date and status (e.g. `(team_id, paid_at, status)`).
- The payment row, or its child rows, stores a snapshot of what was charged at charge time: pricing structure, applied tier (flat, sex or skill), the unit fee for the registrant and each guest, whether the team was GST-registered, and the GST amount.
- A later change to the session's fee columns does not change any existing payment's stored amounts. The test updates `game_sessions.fee_flat` and re-reads the payment.

#### AC-VERIFY-9: Per-team sequential invoice numbers are unique and concurrency-safe
**Priority**: MUST
**Given** two teams A and B in the migrated schema
**When** 20 invoice numbers are allocated concurrently for team A (20 parallel connections) and 3 are allocated for team B
**Then** team A receives exactly the set {1..20} with no duplicates and team B receives {1, 2, 3}. `UNIQUE(team_id, invoice_number)` exists, so inserting a duplicate for the same team fails with `23505`, while the same number for a different team is accepted. Only the allocation mechanism (a DB function or sequence-per-team table) is in scope. When invoices are issued, and their PDF output, belong to tax-invoices-and-exports. Whether numbering must be gapless is Creative Q9.

#### AC-VERIFY-10: Wallet balance is constrained to 0.00–100.00 NZD at the database level
**Priority**: MUST
**Given** the migrated schema and one `player_credits` row
**When** the test sets `balance` to `-0.01`, `0.00`, `100.00` and `100.01`
**Then** `-0.01` and `100.01` fail with `23514`, and `0.00` and `100.00` succeed. This applies the "cap on balance" interpretation. Top-up flow logic is not in scope.

#### AC-VERIFY-11: Financial records cannot be cascade-deleted (7-year IRD retention)
**Priority**: MUST
**Given** a user and a team, each with at least one `payments` row and one `credit_transactions` row
**When** the test deletes the user, and separately the team
**Then** each delete fails with `23503` (FK `ON DELETE RESTRICT`, or an equivalent that keeps the rows). The draft's `ON DELETE CASCADE` from `users` and `teams` into `payments`, `credit_transactions` and `player_credits` is removed, and the deviations record documents the change with the productBrief retention NFR as its source. Account deletion and anonymisation flows belong to later features.

#### AC-VERIFY-12: Schema supports idempotent recurrence materialisation and ordered auto-enrol
**Priority**: SHOULD
**Given** the migrated schema
**When** the test inserts two `game_sessions` rows with the same `(recurring_rule_id, date)`, and inspects `team_members`
**Then** the duplicate session fails with `23505`, so a re-run of the materialisation job cannot create duplicate instances. Sessions with a null `recurring_rule_id` (one-offs) are not constrained. `team_members` has a timestamp recording when auto-enrol was assigned, because the workflows doc (§4) orders enrolment by "Auto-Enroll Assignment Date" and the draft has no column for it.

#### AC-VERIFY-13: Bank details and Akahu credentials are encrypted at rest with a rotatable key
**Priority**: MUST
**Given** a team with bank account number `12-3456-7890123-00` and Akahu app token `test_akahu_token_ABC123` written through the foundation crypto helper
**When** the test reads the raw column values with plain SQL (no decryption) and then reads them through the helper
**Then**:
- The raw bytes contain neither plaintext string, nor its hex or base64 encoding.
- Decrypting through the helper returns both values exactly.
- Encrypting the same plaintext twice produces different ciphertexts (random nonce/IV).
- Each ciphertext carries a key identifier so rotation can re-encrypt row by row.
- At minimum `bank_account_number` and `akahu_app_token` are encrypted. Whether to also encrypt `bank_account_name`, `akahu_merchant_id` and `ird_number` is decided in Creative Q5.
- The encryption key is never stored in the database, in the repo or in logs.

#### AC-VERIFY-14: Money primitives are exact and never pass through binary floating point
**Priority**: MUST
**Given** the foundation money module
**When** its unit tests run
**Then**:
- Parsing `"17.50"` and formatting it back yields `$17.50`.
- Summing `0.10` three times equals exactly `0.30`.
- `99999999.99`, the maximum for `DECIMAL(10,2)`, round-trips through an insert and select against real Postgres with no loss. The DB driver is configured to return numerics as string or Decimal, not float.
- Multiplying by a ratio (e.g. `3/23`) needs an explicit rounding mode and gives a deterministic 2-dp result.
- A lint rule or type-level guard stops a raw `number`/`float` being passed where a money value is expected.
- The storage representation, `DECIMAL(10,2)` as in the draft or `BIGINT` cents, is Creative Q6. The chosen one is applied consistently to every money column. GST calculation itself belongs to team-banking-and-gst and tax-invoices-and-exports.

#### AC-VERIFY-15: Timezone helpers convert Pacific/Auckland local time correctly across DST, independent of host timezone
**Priority**: MUST
**Given** the foundation time module, with the test process run under `TZ=UTC` and again under `TZ=America/New_York`
**When** it converts local date and time in `Pacific/Auckland` to UTC instants and back
**Then** both runs produce identical results:
- `2026-07-01 19:00` (NZST) → `2026-07-01T07:00:00Z`
- `2026-10-07 19:00` (NZDT) → `2026-10-07T06:00:00Z`
- `2026-09-27 02:30` (does not exist; DST starts at 02:00) is resolved by the explicit policy chosen in Creative Q7 (shift forward to `2026-09-26T14:30:00Z`, or reject). It is never silently mapped to an arbitrary offset.
- `2027-04-04 02:30` (ambiguous; DST ends at 03:00 NZDT) is resolved by the explicit policy chosen in Creative Q7 (`2027-04-03T13:30:00Z` if the earlier instant is chosen, or `2027-04-03T14:30:00Z` if the later).
- "48 hours before" `2027-04-05 19:00` NZST (`2027-04-05T07:00:00Z`), computed as an absolute duration, is `2027-04-03T07:00:00Z`, which displays as `03/04/2027 8:00 pm` NZDT.
- Display dates use NZ format `DD/MM/YYYY`.
All persisted instants are `TIMESTAMP WITH TIME ZONE`. Local conversion happens only in this module and in the UI.

#### AC-VERIFY-16: Notification service is an abstraction with swappable dev and test adapters
**Priority**: MUST
**Given** the foundation notification module
**When** it is configured once with the dev adapter (SMTP to Mailpit) and once with the in-memory test adapter, and `send({ to, subject, text, html? })` is called
**Then** the calling code is identical under both configurations. The adapter is selected only by configuration (env var). The in-memory adapter exposes the sent messages to tests. Adding a production provider (Creative Q8) means adding an adapter, with no change to callers. No domain templates (low credit, overdue reminder) ship in foundation.

#### AC-VERIFY-17: Test harness separates unit and integration suites and isolates the integration database
**Priority**: MUST
**Given** the scaffolded harness
**When** `test` and `test:integration` are run, including two integration suites in parallel
**Then** `test` needs no running database and finishes without network access. `test:integration` runs against real PostgreSQL 17 (the Compose service or Testcontainers) with migrations applied. Each test or suite is isolated, by transaction rollback or a per-suite database/template, so parallel runs do not see each other's rows. At least one example test of each kind exists, so downstream features have a pattern to follow. Coverage is reported for the foundation library modules, with a target of 80% or more (see Success metrics).

#### AC-VERIFY-18: Stack decisions are recorded and the memory bank reflects the built foundation
**Priority**: MUST
**Given** creative and build are complete
**When** a reviewer opens the creative architecture decision document under `memory-bank/creative/` and `memory-bank/techContext.md`/`memory-bank/systemPatterns.md`
**Then**:
- The backend framework decision (Node or FastAPI) and every other Creative Q1–Q12 outcome are recorded with the options considered and the rationale.
- `techContext.md` lists the actual stack, Component Structure, Development Commands and Test Strategy. No `[To be added]` placeholders remain.
- `systemPatterns.md` → Code Organization Patterns pins the source language and file extension for each directory, and Testing Patterns describes the harness.

#### AC-INTEGRATION-1: Migrated schema is grounded in `database-design.md`, with every deviation traced to a source requirement
**Priority**: MUST
**Given** the migrated database and the repo's schema deviations record (location pinned in the plan)
**When** a conformance test queries `information_schema.columns`, `pg_type`/`pg_enum` and `pg_indexes`, and compares them with the expected set derived from `database-design.md`
**Then**:
- All 10 draft tables are present: `users`, `teams`, `team_members`, `recurring_session_rules`, `game_sessions`, `session_courts`, `registrations`, `player_credits`, `credit_transactions`, `payments`.
- All 13 draft enum types are present with exactly their draft values, in the same order.
- All 11 draft indexes, or equivalents with the same leading columns, are present.
- Every difference (new tables, new columns, changed FK actions, money representation, encrypted column types, any dropped item) appears in the deviations record with a citation to its source (task description gap list, productBrief NFR, workflows doc section, or creative decision).
- The expected set is written by hand from `database-design.md`. It is not generated from the migrations under test.

#### AC-INTEGRATION-2: Shared type enums match the real database enums
**Priority**: MUST
**Given** the migrated database and the shared-types package
**When** a parity test reads each enum's values from `pg_enum` and compares them with the corresponding exported enum or union in shared types
**Then** every DB enum used by the app has a shared-type counterpart with the identical value set, including the enums added by gap fixes such as the auth provider. The test fails if a value is added to either side only. If Q12 picks generated types (always the case under Option B), CI also fails when regenerating the types produces a diff.

#### AC-INTEGRATION-3: A notification sent through the dev adapter actually arrives in Mailpit
**Priority**: MUST
**Given** the Compose stack is running with the dev notification adapter
**When** an integration test sends a message with a unique subject token (e.g. `foundation-smoke-<uuid>`)
**Then** Mailpit's API (`GET http://localhost:8025/api/v1/messages`) returns exactly one message with that subject and the expected recipient within 5 s. A "sent" log line or the adapter's own return value does not count as passing.

#### AC-INTEGRATION-4: Web app renders data fetched from the running API
**Priority**: SHOULD
**Given** the Compose stack is running
**When** a developer loads `http://localhost:3000`
**Then** the placeholder home page shows the API's health status, fetched from the running API's `/health` at request time rather than hard-coded. Stopping the `api` container and reloading changes the displayed status to unavailable. This shows the web → API wiring, base URL config and shared types work end to end.

#### AC-ASYNC-1: A background job's lifecycle is observable from enqueue to completion
**Priority**: MUST
**Given** the Compose stack is running with the worker up
**When** a test or developer enqueues the foundation `heartbeat` job with a unique payload
**Then** the job's persisted record moves from queued to active to completed (or the runner's equivalent states) within 10 s, the handler's side effect is observable (e.g. a row written or a structured log line with the payload), and the job's final state can be read from the job store with SQL or the runner API.

#### AC-ASYNC-2: Recurring schedules are registered in Pacific/Auckland time and fire correctly across DST
**Priority**: MUST
**Given** the scheduler is configured with the three named schedule slots that downstream features will fill: `recurrence-materialisation`, `post-game-billing` and `daily-overdue`, each wired to a no-op placeholder handler that logs when it is invoked
**When** the test asks the scheduler (or its cron library) for the next fire times of a daily `04:00` `Pacific/Auckland` schedule starting from `2026-09-25T16:00:01Z`, and separately from `2027-04-02T15:00:01Z`
**Then** the next fire times are `2026-09-26T15:00:00Z` (04:00 NZDT on the day DST starts) and `2027-04-03T16:00:00Z` (04:00 NZST on the day DST ends). All three slots are registered and visible in the runner's schedule list, and each placeholder's invocation can be triggered manually and observed. Domain behaviour (materialising sessions, billing, marking overdue) is out of scope. The post-game-billing trigger shape (a periodic sweep or a per-session delayed job) is Creative Q4.

#### AC-ASYNC-3: Jobs are deduplicated by key and survive a worker restart (at-least-once)
**Priority**: MUST
**Given** the worker is running
**When** the same job is enqueued twice with the same idempotency or singleton key, and separately a long-running test job is enqueued and the worker container is killed mid-execution and restarted
**Then** the deduplicated job runs exactly once. The interrupted job is picked up again after the restart and reaches completed, so jobs are not lost. The runner's delivery guarantee (at-least-once) is documented so downstream handlers know they must be idempotent.

#### AC-ERROR-1: Missing or invalid required configuration fails fast and names the problem
**Priority**: MUST
**Given** the API or worker starting up
**When** `DATABASE_URL` is unset, or the encryption key is missing or the wrong length
**Then** the process exits non-zero within 5 s, before it listens on a port or takes jobs. The error names the offending variable and never prints any secret value. `.env.example` lists every required variable with a non-secret placeholder, and `.env` is git-ignored.

#### AC-ERROR-2: API health reports a database outage instead of reporting healthy
**Priority**: MUST
**Given** the Compose stack is running
**When** the `postgres` container is stopped and `GET /health` is called
**Then** the API responds within 3 s with HTTP 503 and a body that marks the database as unreachable. After `postgres` restarts, `/health` returns 200 again without restarting the API.

#### AC-ERROR-3: Failing jobs are retried with backoff and end in a visible failed state
**Priority**: MUST
**Given** a test job handler that always throws
**When** it is enqueued
**Then** it is retried the configured number of times (the default is set in the plan, e.g. 3) with increasing delay. It then ends in a terminal failed state in the job store, with the error message and attempt count recorded, and an error-level structured log line is emitted. It is never silently dropped or marked completed.

#### AC-ERROR-4: Decryption failures are loud and plaintext never leaks
**Priority**: MUST
**Given** a value encrypted with key K1
**When** the helper tries to decrypt it with a different key, with a tampered ciphertext, or with an unknown key ID
**Then** each attempt raises a typed error. It never returns garbage, an empty string or the raw ciphertext as if it were plaintext. Error messages and logs contain neither the plaintext nor the key. The test also captures logs during a successful encrypt and decrypt and asserts the plaintext does not appear.

#### AC-ERROR-5: Invalid money and local-time inputs are rejected explicitly
**Priority**: MUST
**Given** the money and time modules
**When** they receive `"17.505"` (more than 2 dp), `"abc"`, `NaN` or `Infinity`, or a float literal where a money value is expected, or an invalid time-zone name
**Then** each input raises a typed validation error. None is silently rounded, truncated or coerced to zero. A DST-nonexistent or ambiguous local time follows the explicit policy from Creative Q7 and is covered by AC-VERIFY-15.

#### AC-ERROR-6: Notification delivery failures surface to the caller
**Priority**: SHOULD
**Given** the dev SMTP adapter pointed at an unreachable host, or the test adapter configured to fail
**When** `send(...)` is called directly, and separately from inside a job
**Then** the direct call surfaces a typed delivery error (thrown or returned as a failed result, never reported as success). The job-wrapped call is retried and ends in a failed state per AC-ERROR-3.

**AC summary**: 18 × AC-VERIFY, 4 × AC-INTEGRATION, 3 × AC-ASYNC, 6 × AC-ERROR (31 total; 28 MUST, 3 SHOULD).

### Scope Boundaries

- **In scope**:
  - The monorepo scaffold: the Next.js + Tailwind web app with one placeholder page, the API service with `/health`, a worker process and shared types.
  - The root task runner, ESLint/Prettier (plus Ruff and mypy/pyright if Option B) and strict type checking.
  - The unit and integration test harness, GitHub Actions CI, Docker Compose local dev (postgres:17, api, worker, web, Mailpit, and Redis only if required), `.env.example`, and Dockerfiles for api, worker and web.
  - PostgreSQL 17 migrations for the **full domain model** in `database-design.md`, plus these gap fixes: auth identities; `payments.team_id` and the fee snapshot; guest sex and skill; `UNIQUE(session_id, user_id)`; `guest_count` range 0–2; per-team invoice-number allocation; encrypted bank details and Akahu credentials; balance range 0–100.00; FK changes that preserve financial records; `UNIQUE(recurring_rule_id, date)`; the auto-enrol assignment timestamp. A schema deviations record traces each one.
  - Library modules with no domain rules: money, Pacific/Auckland time, crypto (encrypt/decrypt, key ID), the notification abstraction (Mailpit and in-memory adapters), and the job-runner wrapper (enqueue, schedule, retry, dedupe) with three named no-op schedule slots and a `heartbeat` job.
  - Architecture decision records, and updates to `techContext.md` and `systemPatterns.md`.
- **Out of scope**:
  - Every domain behaviour owned by later features:
    - Sign-up, login and OAuth flows, password hashing, session/JWT handling and RBAC guards (auth-and-user-roles)
    - Team CRUD, discovery, invites and bans (team-management)
    - Banking and GST settings UI, GST 3/23 calculation (team-banking-and-gst)
    - Skill progression and auto-enrol logic (skill-levels-and-auto-enroll)
    - Recurrence expansion, overrides and rate suggestion (session-scheduling-engine)
    - The registration gatekeeper, waitlist and cancellation rules (registration-and-waitlist)
    - Wallet, Akahu API and webhook integration, post-game billing, overdue marking, reminders (wallet-and-akahu-billing)
    - Dashboards (player-dashboard, admin-reporting-dashboard)
    - Invoice issuing, PDFs and CSV/Excel exports (tax-invoices-and-exports)
  - Operational tables owned by those features, added later as additive migrations: auth sessions and refresh tokens, Akahu webhook event log, notification delivery log.
  - Email templates and a production email provider account.
  - Production deployment/CD, infrastructure-as-code, hosting provisioning, monitoring and alerting. Hosting is only *decided* in creative (Q10) insofar as it constrains the job runner and key management.
  - Seed or demo data beyond test fixtures.
  - Subscription billing logic (the enum values are kept).
  - Native mobile.
- **Dependencies**:
  - Docker and Docker Compose v2 on developer machines.
  - Node.js LTS and pnpm. With Option B, also Python 3.12+ and uv.
  - The `postgres:17` and `axllent/mailpit` images, plus `redis:7` only if a Redis-backed runner is chosen.
  - GitHub Actions on `github.com/quynguyenhcm/shared-game-management` (the remote exists; nothing is pushed yet).
  - No other roadmap features. All ten other v1.0.0 features depend on this one.
- **NFR implications**:
  - Security (productBrief):
    - Encryption at rest for bank details and Akahu credentials (AC-VERIFY-13, AC-ERROR-4).
    - No committed secrets (AC-ERROR-1). A secret-scanning step in CI (e.g. gitleaks) is COULD.
    - TLS in transit is a hosting concern (Q10).
  - Data retention: 7-year financial retention (AC-VERIFY-11).
  - NZ Privacy Act 2020: minimises plaintext PII in logs (AC-ERROR-4).
  - Localisation: NZD, `DD/MM/YYYY`, Pacific/Auckland (AC-VERIFY-14, AC-VERIFY-15).
  - Correctness under concurrency: invoice numbers (AC-VERIFY-9) and job dedupe (AC-ASYNC-3).

### Creative Exploration Needed

Level 4, so creative is mandatory. Each question lists the options and the ACs it unblocks. The tag in brackets is the creative agent that owns it. The numbers are referenced from the ACs above.

1. **[Architecture] Backend framework**: Node (NestJS vs Express, TypeScript) or Python (FastAPI). Criteria: shared types with the Next.js web app (Node shares TS directly; FastAPI needs OpenAPI codegen), the job-runner ecosystem, Decimal/money ergonomics, team familiarity and hosting fit. This drives the command column used in Verification Method and AC-VERIFY-3, AC-VERIFY-17 and AC-INTEGRATION-2. Confidence: LOW (genuinely open in productBrief).
2. **[Architecture] Monorepo tooling and layout**: pnpm workspaces alone, pnpm + Turborepo, or Nx. If Option B: pnpm + uv with a Makefile/justfile as the root runner. This settles the directory names (`apps/web`, `apps/api`, `apps/worker`, `packages/shared`, or similar) and whether the worker is a separate app or a second entry point of the API. Unblocks AC-VERIFY-1.
3. **[Architecture] Migrations tool and data-access layer**: an ORM-coupled tool (Prisma, Drizzle, Alembic) vs raw-SQL, stack-neutral tooling (dbmate, node-pg-migrate). Trade-offs: expressiveness for enums, CHECK constraints, triggers and per-team sequence functions; down-migration support (AC-VERIFY-5); and whether an ORM, a query builder (e.g. Kysely, SQLAlchemy Core) or raw SQL is used for data access.
4. **[Architecture] Job runner and scheduler**: Postgres-backed (pg-boss, Graphile Worker, Procrastinate) vs Redis-backed (BullMQ, Celery, arq), or host-platform cron triggering HTTP endpoints. Criteria: timezone-aware cron (AC-ASYNC-2), dedupe keys and at-least-once delivery (AC-ASYNC-3), retry and failed-state visibility (AC-ERROR-3), and one fewer service to run if Postgres-backed. Also decide the **post-game-billing trigger shape**: a periodic sweep (e.g. every 5 min for sessions whose max court `end_time` has passed) or a delayed job scheduled per session at publish time.
5. **[Architecture] Encryption at rest and key management**: application-level AEAD (e.g. AES-256-GCM or libsodium secretbox) with a key-ID prefix and env-supplied key in dev and KMS in prod, vs `pgcrypto` `pgp_sym_encrypt`, where the key travels through SQL and risks appearing in logs, vs relying on disk or volume encryption only (does not meet the column-level requirement). Also decide which columns beyond `bank_account_number` and `akahu_app_token` to encrypt (`bank_account_name`, `akahu_merchant_id`, `ird_number`), and whether to store a non-sensitive display projection (e.g. last 2–4 digits of the account) for UI masking. Unblocks AC-VERIFY-13 and AC-ERROR-4.
6. **[Algorithm] Money representation and rounding**: keep `DECIMAL(10,2)` (matches the draft; needs Decimal types end-to-end and string-returning drivers) or switch to `BIGINT` integer cents (simpler arithmetic; diverges from the draft and is recorded as a deviation). Also choose the rounding mode for ratio operations (half-up vs banker's rounding) to be used later for the GST 3/23 split and `ceil` rate suggestion. Unblocks AC-VERIFY-14 and AC-ERROR-5.
7. **[Algorithm] DST policy for local wall-clock times**: how a nonexistent local time (`2026-09-27 02:30`) and an ambiguous one (`2027-04-04 02:30`) resolve: shift forward or reject, earlier or later instant. Also whether "cancellation deadline defaults to 48 h prior" means absolute hours (the AC-VERIFY-15 vector) or the same local wall-clock time two days earlier; the two differ by 1 h across a DST change. Foundation provides both primitives, and session-scheduling-engine applies the chosen rule. Also decide whether sessions should store a computed `starts_at`/`ends_at timestamptz`, because the draft has only `date` + per-court `TIME` with no zone, and post-game billing needs an instant. Unblocks AC-VERIFY-15.
8. **[Architecture] Production email provider and adapter contract**: productBrief lists the provider as "TBD". Options include Postmark, SendGrid, AWS SES and Resend. Only the adapter interface and the dev (Mailpit) and test adapters are built here. The choice matters now only so the `send()` contract (fields, error types, idempotency key) fits the likely provider. Unblocks AC-VERIFY-16 and AC-ERROR-6.
9. **[Algorithm] Invoice-number allocation**: a gapless counter table (`SELECT ... FOR UPDATE`, serialises per team) vs a per-team sequence that allows gaps. IRD requires unique, identifiable invoices, not strictly gapless ones, so confirm. Also the display format (e.g. `<TEAM-PREFIX>-000123`). Unblocks AC-VERIFY-9.
10. **[Architecture] Hosting target**, only as far as it constrains foundation: for example Fly.io, Render, Railway, AWS ECS + RDS, or Vercel for web plus a separate API and worker host. This affects whether the scheduler runs in-process or uses platform cron, where encryption keys live (KMS vs platform secrets), TLS termination, and the managed Postgres 17 choice. Deployment itself is out of scope.
11. **[Algorithm] Fee snapshot and guest model shape**: snapshot columns on `payments` vs a `payment_line_items` child table (one line per registrant and guest) vs JSONB; a `registration_guests` child table vs positional columns on `registrations`. The workflows doc bills per confirmed registration including guests, so line items are likely, but that is not decided here. Unblocks AC-VERIFY-7 and AC-VERIFY-8.
12. **[Architecture] Shared-types strategy**: hand-written TS enums in a shared package vs types generated from the DB schema (e.g. Kysely codegen, Drizzle inference) vs types generated from OpenAPI. This is tightly coupled to Q1 and Q3, and determines how AC-INTEGRATION-2 parity is enforced.

**Confidence by section**:
- Verification Method: MEDIUM. Metrics and observation points are concrete, and the commands are concrete for each option but are pending Q1–Q3.
- Schema gap ACs (AC-VERIFY-6 to AC-VERIFY-12, AC-INTEGRATION-1): HIGH. They are taken directly from `database-design.md`, the task gap list, the workflows doc and productBrief. The column and table shape is pending Q11.
- Library ACs (money, time, crypto, notifications, jobs): HIGH for behaviour and test vectors, and LOW for the representation and policy choices (Q4–Q9), which are flagged above rather than guessed.
- CI/local dev: HIGH for GitHub Actions and Compose. The 120 s, 30 s and 10 min thresholds are proposed and have not been measured, since no code exists yet.

### Implementation Guide Required
Yes. Downstream developers need a short `README` or `docs/` "Getting started" covering prerequisites, `setup`, `docker compose up -d --wait`, the root targets, how to add a migration and update the deviations record, how to register a job or schedule, how to add a notification adapter, and how to encrypt a new sensitive column. AC-VERIFY-1 and AC-VERIFY-2 cannot fully verify onboarding on their own.

## Test Strategy

### Approach
- **Emphasis**: balanced. Library modules (money, time, crypto, config, notifications) are unit-heavy. Schema, jobs and health checks are integration tests against a real Postgres 17, because the ACs are mostly about DB constraints and job-store behaviour that mocks cannot prove. One smoke E2E test covers web → API.
- **Target test count**: about 62 in total. This is above the 20 guideline because the task covers 31 ACs across 5 library modules, a full domain schema with 11 gap fixes, and a job runner. The count averages about 2 tests per AC. Each module stays within the 6–12 per-module guideline.
- **Coverage gate**: 80% or more line coverage on `packages/shared/src/{money,time}` and `apps/api/src/lib/{crypto,config,notifications,jobs}` (SHOULD, per Success metrics).

### File Organization
- **New test files** (paths are provisional under Option A; if creative picks FastAPI, re-pin the api/worker files as `apps/api/tests/test_<module>.py`):
  - `packages/shared/src/money/money.test.ts`: exact arithmetic, parse/format, rounding, invalid input
  - `packages/shared/src/time/time.test.ts`: Pacific/Auckland conversions, DST gap and overlap vectors, host-timezone independence
  - `apps/api/src/lib/config/config.test.ts`: fail-fast on missing or invalid env
  - `apps/api/src/lib/crypto/crypto.test.ts`: round trip, key-ID prefix, rotation, tamper and wrong-key errors, no plaintext in errors
  - `apps/api/src/lib/notifications/notifications.test.ts`: adapter contract, in-memory adapter, typed delivery errors
  - `apps/api/test/integration/health.int.test.ts`: `/health` returns 200 with the DB up and 503 with the DB down
  - `apps/api/test/integration/schema.int.test.ts`: migrate up/down/up, conformance to `database-design.md` plus the deviations record, all constraint and gap-fix checks
  - `apps/api/test/integration/invoice-number.int.test.ts`: concurrent allocation is unique per team
  - `apps/api/test/integration/crypto-columns.int.test.ts`: raw column bytes contain no plaintext
  - `apps/api/test/integration/enum-parity.int.test.ts`: shared TS enums equal `pg_enum` values
  - `apps/api/test/integration/mailpit.int.test.ts`: a message sent via the dev adapter appears in the Mailpit API
  - `apps/worker/test/integration/jobs.int.test.ts`: enqueue → complete lifecycle, dedupe, restart survival, retry → failed, Pacific/Auckland cron registration
  - `apps/web/e2e/smoke.spec.ts`: the page renders data from the live API `/health` (Playwright)
- **Extend existing**: none. This is a greenfield repo.

### What NOT to Test
- Framework boilerplate (Next.js routing, the framework's own HTTP server): framework guarantees it
- Pure type definitions in `packages/shared/src/types`: covered by `tsc --strict` plus the enum-parity integration test
- Domain rules owned by later features (pricing, waitlist, billing, GST split): out of scope. Only the schema shape that supports them is tested.
- The production email provider and Akahu API: not integrated in this feature
- Docker Compose and CI YAML themselves: verified by running them (`docker compose up --wait`, `actionlint`, a green CI run), not by unit tests

### Per-Phase Test Guidance
- Phase 1: 6 tests. Config fail-fast (4); API `/health` unit happy path (1); each root target runs (1 script-level check). A deliberate lint, type or test violation makes `ci` fail (verified manually and recorded in the phase notes).
- Phase 2: 3 tests. `/health` 200 vs 503 with the DB stopped (2); web smoke E2E (1). `actionlint` is clean, and a CI run on a local `act`-free dry run is replaced by the first real run when pushing is re-enabled.
- Phase 3: 20 tests. Migrate up, down and up again with identical schema dumps (1); conformance to the design doc and deviations record (1); auth identities, one user with 3 providers (2); `UNIQUE(session_id, user_id)` and `guest_count` 0–2 (3); guest sex and skill attributes (1); `payments.team_id` NOT NULL and the fee snapshot is immutable (2); invoice numbers unique under concurrency (2); balance CHECK 0.00–100.00 (2); financial FKs RESTRICT deletes (3); `UNIQUE(recurring_rule_id, date)` and the auto-enrol timestamp (2); enum parity (1).
- Phase 4: 20 tests. Money (8): add/sub/multiply-ratio exact, 0.1+0.2, parse `"17.50"`, NZD format, rounding mode, reject floats, NaN and over-precision. Time (7): the 2026-09-27 gap, the 2027-04-04 overlap, 48 h absolute vs same wall-clock, host `TZ=UTC` vs `TZ=America/New_York` give the same result, `DD/MM/YYYY` format, reject a nonexistent time under the strict policy. Crypto (5): round trip, key-ID prefix plus rotation-read of an old key, tampered ciphertext throws, wrong key throws without plaintext in the message, raw column bytes contain no plaintext (integration).
- Phase 5: 10 tests. Notifications (4): contract, in-memory capture, typed failure, arrives in Mailpit. Jobs (6): lifecycle states observable, dedupe key, survives a worker restart, retry with backoff ends in the failed state, cron registered in Pacific/Auckland fires at the right UTC instant across DST, `heartbeat` job completes.
- Phase 6: 3 checks. Full `ci` is green from a fresh clone; `docker compose up -d --wait` finishes in 120 s or less; Getting Started steps are followed verbatim on a clean checkout. Coverage gate reported.

## Architectural Plan

### Executive Summary
This task builds the monorepo, local stack, CI, full PostgreSQL 17 domain schema (with the 11 gap fixes) and the stateless library modules that all ten later v1.0.0 features depend on. It contains no domain logic.

### Architectural Principles
1. **Postgres is the system of record.** Constraints (CHECK, UNIQUE, FK RESTRICT) enforce invariants in the database, not only in app code.
2. **Money never touches binary floating point.** One money module is used everywhere.
3. **Store instants in UTC (`timestamptz`) and convert to Pacific/Auckland only at the edges.** DST policy lives in one time module.
4. **Secrets and sensitive columns are encrypted at the application level with a key-ID prefix,** so keys can be rotated. Plaintext never appears in logs or errors.
5. **Every async side effect goes through the job runner** (idempotent, deduplicated, retried, observable).
6. **One root command set and the same gates locally and in CI.**
7. **12-factor config:** env only, validated at boot, fail fast.

### Architecture Alternatives
Deferred to `/yay:creative` (mandatory at Level 4). The 12 questions in `### Creative Exploration Needed` list the options for each decision, with Q1 (backend), Q3 (migrations/data access), Q4 (job runner) and Q5 (encryption) the most important. The selection, weighted evaluation and justification are recorded in `memory-bank/creative/platform-foundation-architecture.md` and `memory-bank/creative/platform-foundation-algorithm.md`. Suggested weights: maintainability 0.25, correctness/safety 0.25, time to market 0.2, operational simplicity 0.15, cost 0.1, performance 0.05.

### Observability Requirements
- **Logging**: structured JSON to stdout from `api` and `worker` (pino under Option A, structlog under Option B). Fields: `ts`, `level`, `msg`, `service`, `trace_id`, `span_id`, `request_id`, `job_id`. Configured by `LOG_LEVEL` and `LOG_FORMAT` (json|pretty). Redacted: `authorization`, `cookie`, `password*`, `*_token`, `bank_account_*`, `ird_number`, `akahu_*`.
- **Tracing**: OpenTelemetry SDK wired but exporting to console or no-op by default (`OTEL_EXPORTER_OTLP_ENDPOINT` optional). W3C `traceparent` is propagated from web → API, and from API → job payloads (trace context stored in job metadata).
- **Metrics**: `/metrics` is deferred. The foundation logs job lifecycle events (`job.enqueued|started|completed|failed`, with duration). A metrics backend is decided with hosting (Q10).
- **Infrastructure**: none in foundation beyond stdout. The collector and backends come with hosting.

### API Requirements
- **REST API**: yes, minimal. `GET /health` returns `{status, db, version}` with 200, or 503 when the DB is unreachable. OpenAPI spec at `apps/api/openapi.yaml` (created here; later features extend it). Build agents MUST load `context/api-rest-requirements.md`.
- **GraphQL**: no.
- **Auth**: none in foundation (arrives with auth-and-user-roles).
- **API testing**: integration tests for `/health` (Phase 2).

### Risk Assessment
| Risk | Likelihood | Impact | Mitigation |
| --- | --- | --- | --- |
| Backend choice (Q1) flips file pins and commands | Medium | Medium | Pins are provisional under Option A. Creative re-pins them before `/yay:build`. |
| The schema gets locked in before domain features learn their needs | Medium | High | The deviations record plus reversible migrations. Later features add additive migrations only. |
| DST and money bugs surface late, in billing | Medium | High | Test vectors are fixed in Phase 4 (2026-09-27 gap, 2027-04-04 overlap). One module owns each concern. |
| Encryption key handling leaks plaintext | Low | High | Encryption is AEAD at the app level, and tests check raw bytes and error messages (AC-ERROR-4). |
| CI can't run while GitHub push is blocked (403) | High (now) | Medium | Run `ci` locally. The first GitHub Actions run happens once access is fixed; AC-VERIFY-4 stays open until then. |

## Implementation Roadmap

### New Source Files (pin path + extension)
<!-- Provisional under Option A (Node/TypeScript backend) — /yay:creative MUST confirm or re-pin before /yay:build.
     If Option B (FastAPI) is chosen: apps/api/src/**.ts -> apps/api/src/app/**.py, apps/worker -> apps/api/src/app/worker/*.py,
     migrations stay raw SQL if dbmate (else apps/api/alembic/versions/*.py). Web and packages/shared pins are unaffected. -->
- [ ] `package.json`, `pnpm-workspace.yaml`, `tsconfig.base.json`, `eslint.config.mjs`, `.prettierrc.json`, `.editorconfig`: root workspace, strict TS, lint and format config
- [ ] `.env.example`, `.gitignore` (extend): documented env vars, with no secrets
- [ ] `docker-compose.yml`: postgres:17, api, worker, web, mailpit (plus redis only if Q4 requires it), with health checks
- [ ] `apps/api/Dockerfile`, `apps/worker/Dockerfile`, `apps/web/Dockerfile`
- [ ] `.github/workflows/ci.yml`: lint → typecheck → unit → integration (postgres:17 service) → build
- [ ] `apps/web/package.json`, `apps/web/next.config.ts`, `apps/web/tailwind.config.ts`, `apps/web/postcss.config.mjs`, `apps/web/tsconfig.json`
- [ ] `apps/web/src/app/layout.tsx`, `apps/web/src/app/page.tsx`: placeholder page that shows API health
- [ ] `apps/web/src/lib/api-client.ts`: typed fetch wrapper
- [ ] `apps/web/playwright.config.ts`, `apps/web/e2e/smoke.spec.ts`
- [ ] `apps/api/package.json`, `apps/api/tsconfig.json`, `apps/api/src/main.ts`, `apps/api/src/app.ts`: server bootstrap
- [ ] `apps/api/src/routes/health.ts`: `GET /health`
- [ ] `apps/api/openapi.yaml`
- [ ] `apps/api/src/lib/config/config.ts`: env schema plus fail-fast validation
- [ ] `apps/api/src/lib/db/pool.ts`: Postgres pool, with NUMERIC parsed as a string
- [ ] `apps/api/src/lib/logger/logger.ts`: structured logger with redaction
- [ ] `apps/api/src/lib/crypto/crypto.ts`: AEAD encrypt/decrypt with key ID and rotation
- [ ] `apps/api/src/lib/notifications/notifier.ts`, `apps/api/src/lib/notifications/adapters/mailpit.ts`, `apps/api/src/lib/notifications/adapters/in-memory.ts`
- [ ] `apps/api/src/lib/jobs/jobs.ts`: enqueue, schedule (Pacific/Auckland cron), dedupe and retry wrapper
- [ ] `apps/worker/package.json`, `apps/worker/tsconfig.json`, `apps/worker/src/main.ts`: worker bootstrap
- [ ] `apps/worker/src/jobs/heartbeat.ts`, `apps/worker/src/schedules.ts`: heartbeat job plus 3 named no-op schedule slots (`recurrence-materialise`, `post-game-billing`, `overdue-sweep`)
- [ ] `db/migrations/0001_enums.sql` … `db/migrations/0010_indexes.sql`: full domain schema plus gap fixes (raw SQL, with the file split finalised in creative Q3)
- [ ] `db/schema-deviations.md`: every deviation from `database-design.md`, with its source requirement
- [ ] `packages/shared/package.json`, `packages/shared/tsconfig.json`, `packages/shared/src/index.ts`
- [ ] `packages/shared/src/types/enums.ts`: domain enums mirrored from the DB
- [ ] `packages/shared/src/money/money.ts`: exact NZD money
- [ ] `packages/shared/src/time/time.ts`: Pacific/Auckland conversion and DST policy
- [ ] `docs/getting-started.md`, `docs/adr/0001-backend-framework.md` … `docs/adr/00NN-*.md`: implementation guide and decision records
- [ ] `memory-bank/techContext.md`, `memory-bank/systemPatterns.md` (extend): record the chosen stack, commands and conventions

### Phases
- [ ] Phase 1: Workspace scaffold and quality gates (AC-VERIFY-1, AC-VERIFY-3, AC-VERIFY-17, AC-ERROR-1)
  - Components: root runner and targets, apps/web placeholder, apps/api with `/health`, apps/worker bootstrap, packages/shared, lint/format/strict TS, unit + integration harness, config fail-fast
  - Milestone: `lint`, `typecheck` and `test` pass locally; deliberate violations fail each gate
- [ ] Phase 2: Local dev stack and CI (AC-VERIFY-2, AC-VERIFY-4, AC-ERROR-2, AC-INTEGRATION-4)
  - Components: `docker-compose.yml`, Dockerfiles, `.env.example`, `.github/workflows/ci.yml`, DB-aware `/health`, web → API smoke E2E
  - Milestone: `docker compose up -d --wait` is healthy in 120 s or less; `/health` gives 503 with the DB stopped; the web page shows live API data; `actionlint` is clean
- [ ] Phase 3: Domain schema and migrations (AC-VERIFY-5 to AC-VERIFY-12, AC-INTEGRATION-1, AC-INTEGRATION-2)
  - Components: the migration tool (Q3), full schema from `database-design.md` plus all gap fixes, `db/schema-deviations.md`, shared enums with a parity test
  - Milestone: migrate, rollback and migrate again from empty in 30 s or less with identical dumps; conformance plus the deviations record is at 100%
- [ ] Phase 4: Money, time and crypto libraries (AC-VERIFY-13, AC-VERIFY-14, AC-VERIFY-15, AC-ERROR-4, AC-ERROR-5)
  - Components: `packages/shared` money and time, `apps/api` crypto, encrypted columns wired to the crypto module
  - Milestone: all DST and money test vectors pass; no plaintext in the raw bytes of encrypted columns
- [ ] Phase 5: Job runner and notifications (AC-VERIFY-16, AC-ASYNC-1, AC-ASYNC-2, AC-ASYNC-3, AC-ERROR-3, AC-ERROR-6, AC-INTEGRATION-3)
  - Components: job wrapper (Q4), worker with `heartbeat` plus 3 schedule slots, notifier with Mailpit and in-memory adapters
  - Milestone: job lifecycle is observable in the job store; a Mailpit message is received; retry ends in the failed state
- [ ] Phase 6: Documentation, decision records and full-gate verification (AC-VERIFY-18; end-to-end verification of all ACs)
  - Components: `docs/getting-started.md`, ADRs for Q1–Q12, updated `techContext.md` and `systemPatterns.md`
  - Milestone: **a fresh clone → `setup` → `docker compose up -d --wait` → `ci` runs green with 0 errors or warnings**, following Getting Started verbatim. The GitHub Actions run (AC-VERIFY-4) is confirmed once pushing is re-enabled.

## Creative Phases

- [x] Architecture design → COMPLETE (`memory-bank/creative/platform-foundation-architecture.md`) (Q1 backend, Q2 monorepo, Q3 migrations/data access, Q4 job runner and billing trigger, Q5 encryption/keys, Q8 email contract, Q10 hosting constraints, Q12 shared types; also re-pin files if Option B)
- [x] Algorithm design → COMPLETE (`memory-bank/creative/platform-foundation-algorithm.md`) (Q6 money representation and rounding, Q7 DST policy and session instants, Q9 invoice-number allocation, Q11 fee snapshot and guest model)

---

## Execution State

**Build Status**: RUNNING
**Current Phase**: CREATIVE
**Current Step**: Step 4.5 - Adversarial design critique
**Step Started**: 2026-09-29
**Last Completed**: PLAN (2026-09-29)
**Can Resume**: YES

### Active Sub-Agents
- Architecture Design: COMPLETE
- Algorithm Design: COMPLETE

### Completed Steps
- 2026-09-29 Step 0.1: task provisioned and linked to roadmap feature
- 2026-09-29 Step 3: spec written (Opus Spec Writer). Taxonomy CLEAN, 31 ACs. Human approved, with the 3 extra schema fixes kept.
- 2026-09-29 Step 5: test strategy (~62 tests), architectural plan and 6-phase roadmap written
- 2026-09-29 Architecture Creative Design: COMPLETE - Output: memory-bank/creative/platform-foundation-architecture.md
- 2026-09-29 Algorithm Creative Design: COMPLETE - Output: memory-bank/creative/platform-foundation-algorithm.md
- 2026-09-29 Decision (spec owner): target PostgreSQL 17 instead of 15; spec, plan, architecture doc, roadmap feature and techContext updated
