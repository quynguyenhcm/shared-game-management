---
slug: platform-foundation
legacy_id:            # only set by the v2 migration for pre-2.0 tasks (e.g., TASK-007)
feature: platform-foundation
status: REFLECTION_COMPLETE
---

# platform-foundation: Platform Foundation

**Complexity**: Level 4 (inherited from platform-foundation)
**Status**: REFLECTION_COMPLETE
**Reflection**: memory-bank/reflection/platform-foundation-reflection.md
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
**Creative Exploration Needed**: Resolved (2026-09-29) — see memory-bank/creative/platform-foundation-architecture.md and -algorithm.md

**Spec interpretations honoured** (already decided, not re-opened here):
- Cancellation: the workflows doc wins (`NOW <= cancellation_deadline` means free). Overview §6 has it inverted. Foundation ships no cancellation logic, but the schema must not encode the inverted rule.
- The wallet $100.00 NZD cap applies to the **balance** (enforced as a DB constraint, AC-VERIFY-10).
- Subscription billing (`MONTHLY_SUBSCRIPTION`, `QUARTERLY_SUBSCRIPTION`) is out of scope for v1.0.0. The enum values are kept to match `database-design.md`, and no code path uses them.

### Verification Method

- **Test method**: Every check runs from one root task-runner entry point: root `package.json` scripts via pnpm 10 workspaces. The required named targets are `setup`, `dev`, `lint`, `typecheck`, `test` (unit), `test:integration`, `db:migrate`, `db:rollback`, `db:reset`, `build` and `ci`. `ci` runs lint, typecheck, unit, integration and build, in that order. Every target is invoked as **`pnpm run <target>`**: `pnpm setup` is a pnpm built-in (it configures `PNPM_HOME`), and `pnpm ci` does not run the root script.
  The chosen stack is Option A with **Fastify** (Node 24 LTS, TypeScript strict), node-pg-migrate SQL migrations + Kysely, pg-boss (Postgres-backed, no Redis). FastAPI (the former Option B) was evaluated and rejected; see the architecture doc §Q1. The concrete commands (architecture doc → Root Commands):

  | Target | Command |
  |---|---|
  | `setup` | `corepack enable && pnpm install --frozen-lockfile && tsx scripts/setup.ts` (copies `.env.example` → `.env`, generates dev `ENCRYPTION_KEYS`) |
  | `dev` | `docker compose up -d --wait postgres mailpit && pnpm run db:migrate && pnpm -r --parallel --filter "./apps/*" dev` |
  | `lint` | `eslint . --max-warnings 0 && prettier --check .` |
  | `typecheck` | `pnpm -r --workspace-concurrency=4 exec tsc --noEmit -p tsconfig.json` (`strict: true` everywhere) |
  | `test` | `vitest run --project unit` (no DB, no network) |
  | `test:integration` | `vitest run --project integration` against real PostgreSQL 17 |
  | `db:migrate` | `pnpm --filter @sgm/api exec tsx src/cli.ts db migrate` (node-pg-migrate up, then pg-boss schema install) |
  | `db:rollback` | `pnpm --filter @sgm/api exec tsx src/cli.ts db rollback` (one step; `-- --count N` or `-- --all` to zero) |
  | `db:reset` | `pnpm --filter @sgm/api exec tsx src/cli.ts db reset` (drops `public` + `pgboss`, migrates; refuses in production) |
  | `build` | `pnpm -r build` (web `next build`; api `tsup` → `dist/{main,worker,cli,instrumentation}.js`) |
  | `ci` | `pnpm run lint && pnpm run typecheck && pnpm run test && pnpm run test:integration && pnpm run build` |

  Shared types: `packages/shared` (`@sgm/shared`) is imported by web and api directly; kysely-codegen output is drift-checked. Extra targets (`db:new`, `db:codegen`, `openapi`, `jobs:trigger`, `test:e2e`, `lint:actions`) are listed in the architecture doc.

  The local stack is `docker compose up -d --wait`, followed by `curl -fsS http://localhost:<API_PORT>/health` and a browser or `curl` check of `http://localhost:3000`. CI is `.github/workflows/ci.yml` on GitHub Actions (the repo remote is GitHub), and `actionlint` validates the workflow file.
- **Success metrics**:
  - `ci` exits 0 with **0 lint errors, 0 lint warnings, 0 type errors, 0 failing tests**. Injecting one deliberate violation of each kind makes it exit non-zero.
  - With images cached, `docker compose up -d --wait` reports every service healthy within **120 s** on a developer laptop.
  - `db:migrate` from an empty Postgres 17 database finishes in **30 s or less**. `pnpm run db:rollback -- --all` (to zero) followed by `db:migrate` again also succeeds (a full down/up round trip).
  - The GitHub Actions `ci` job finishes in **10 min or less** wall-clock (proposed target; the plan may revise it with justification).
  - Line coverage is **80% or more** for the foundation library modules: money, time, crypto, notifications and job-runner wrapper. Proposed threshold; SHOULD.
  - Schema conformance: **100%** of tables, enum types and values, and indexes in `database-design.md` are present in the migrated database. The only exceptions are entries in the schema deviations record, and each of those cites its source requirement (AC-INTEGRATION-1).
  - **0** plaintext occurrences of the test bank account number or Akahu token in the raw column bytes of encrypted fields (AC-VERIFY-13).
- **Observable at**: terminal exit codes and test-runner output; the GitHub Actions run page for the PR; `docker compose ps` (health column); `GET /health` JSON on the API; the Mailpit web UI at `http://localhost:8025` and its REST API `GET http://localhost:8025/api/v1/messages`; the pg-boss job store `pgboss.job` (and `pgboss.archive` if the pinned version archives); and structured stdout logs from `api` and `worker`.
- **Verification frequency**: continuous. `ci` runs on every push and every PR targeting `main`. Developers run it locally before PR. The Compose health check runs on every `docker compose up`.

### Acceptance Criteria

#### AC-VERIFY-1: Monorepo layout exposes web, API, worker and shared-types units behind one root command set
**Priority**: MUST
**Given** a fresh clone of the repository
**When** a developer lists the top-level layout and runs `pnpm run` (which lists the root scripts)
**Then** there is a Next.js + Tailwind web app (`apps/web`), an API service (`apps/api`), a background worker entry point `apps/api/src/worker.ts` (same codebase and image as the API, started with a different command, running as a separate process; there is no `apps/worker`), and a shared-types unit (`packages/shared`). All of the named targets `setup`, `dev`, `lint`, `typecheck`, `test`, `test:integration`, `db:migrate`, `db:rollback`, `db:reset`, `build` and `ci` exist and run as `pnpm run <target>` without "command not found". The directory names are recorded in `memory-bank/techContext.md` → Component Structure and Development Commands.

#### AC-VERIFY-2: Local dev stack starts healthy via Docker Compose on PostgreSQL 17 with UTC database time
**Priority**: MUST
**Given** Docker is running and `.env` has been created from the committed `.env.example`
**When** the developer runs `docker compose up -d --wait`
**Then** all services report healthy within 120 s (images cached): `postgres`, `api`, `worker`, `web`, `mailpit` (no Redis). `SELECT version()` returns a string that starts with `PostgreSQL 17.` and `SHOW timezone` returns `UTC`. `GET /health` on the API returns HTTP 200 with a body that reports database connectivity as ok. `http://localhost:3000` returns HTTP 200 and renders a page styled by Tailwind: the served CSS contains at least one Tailwind utility class that the page uses.
*Amended 2026-09-30 (spec owner, from reflection):* The 120 s budget applies to cached images (measured: 17 s). A first build or `--build` after source changes takes longer (measured: 106.7 s with a partly warm cache). Run `docker compose up -d --build --wait` after pulling changes, because Compose does not rebuild an existing local image.

#### AC-VERIFY-3: Lint, format and type-check gates are strict and actually fail on violations
**Priority**: MUST
**Given** the scaffolded repo with no code violations
**When** `lint` and `typecheck` are run, and then run again after each of three deliberate violations is introduced separately: an unused variable, a mis-formatted file, and a type error (e.g. assigning a string to a numeric field)
**Then** the clean run exits 0 with 0 errors and 0 warnings. Each violation run exits non-zero and names the offending file. TypeScript runs with `strict: true` in every package.

#### AC-VERIFY-4: CI pipeline runs the same gates as local `ci` against a real Postgres 17 service
**Priority**: MUST
**Given** `.github/workflows/ci.yml` is committed
**When** `actionlint` runs on the workflow, and later the branch is pushed or a PR to `main` is opened
**Then** `actionlint` reports 0 findings. The workflow triggers on `push` to `main` and on `pull_request` targeting `main`. It uses a `postgres:17` service container, runs the same `ci` target that developers run locally rather than a divergent step list, caches dependencies, and completes in 10 min or less. A failing test or lint violation marks the run failed. *Note: nothing has been pushed to `origin` yet, so the first real CI run happens at archive or push time. Until then, AC-VERIFY-4 is verified by `actionlint` plus a local `ci` run.*

#### AC-VERIFY-5: Migrations apply cleanly from empty and are reversible on PostgreSQL 17
**Priority**: MUST
**Given** an empty PostgreSQL 17 database
**When** `pnpm run db:migrate`, then `pnpm run db:rollback -- --all` (to version zero), then `pnpm run db:migrate` are run in sequence
**Then** every step exits 0. After the final step the schema is identical to the one after the first step: a `pg_dump --schema-only --schema=public` diff, ignoring ownership and comments, is empty (the `pgboss` schema is owned by the job runner and excluded). The first migrate finishes in 30 s or less. The migrations use core `gen_random_uuid()` and do not depend on `uuid-ossp`, which `database-design.md` creates but never uses. node-pg-migrate supports real down migrations, so no forward-only fallback is needed.

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
- Each guest is a row in `registration_guests` with `position` 1..2 and a `NOT NULL` sex (`user_sex`) and skill level (`skill_tier`), so `BY_SEX` and `BY_SKILL_LEVEL` pricing can resolve a per-guest fee. Position 3 fails with `23514`, and a duplicate `(registration_id, position)` fails with `23505`.
- The stored `guest_count` and the guest rows cannot drift apart: a deferred constraint trigger fails with `23514` at COMMIT when the count differs from the number of rows or the positions are not contiguous. Tests that roll back use `SET CONSTRAINTS … IMMEDIATE` to see the error at the statement.
- `guest_count = 1` with only a position-2 guest (position 2 without position 1) fails with `23514`.
- A registration whose `team_id` differs from its session's team fails with `23503` (composite FK, part of the ownership chain in AC-VERIFY-8).
- Waitlist position uniqueness is covered by AC-VERIFY-19.

#### AC-VERIFY-8: Payments carry team routing and an immutable per-payment fee snapshot
**Priority**: MUST
**Given** the migrated schema
**When** the integration test inserts a payment
**Then**:
- `payments.team_id` is `NOT NULL` with an FK to `teams`, and an insert without it fails with `23502`.
- An index supports team-scoped export and report queries by paid date and status (e.g. `(team_id, paid_at, status)`).
- The `payments` header and its `payment_line_items` (one per party, position 0 = registrant) store a snapshot of what was charged at charge time: pricing structure, applied basis (`fee_basis`: flat, sex or skill), the unit fee for the registrant and each guest, whether the team was GST-registered, and the GST rate. `gst_amount` and `subtotal_amount` are STORED generated columns (GST on $17.00 at 1500 bps = 2.22, subtotal 14.78).
- A later change to the session's fee columns does not change any existing payment's stored amounts. The test updates `game_sessions.fee_flat` and re-reads the payment. Updating a snapshot column of a payment fails with `23000` (`integrity_constraint_violation`, raised by the immutability trigger), and updating or deleting a line item fails with `23000`.
- A second payment for the same registration fails with `23505` (`UNIQUE(registration_id)`, the idempotent billing key).
- **Ownership chain**: a payment whose `user_id` differs from its registration's user fails with `23503`, and one whose `team_id` differs from its registration's (and so its session's) team fails with `23503` (composite FK `(registration_id, user_id, team_id)`). The same two checks apply to a `credit_transactions` row that references a registration.
- **BY_SEX and sex `OTHER`**: a BY_SEX session (or recurring rule) with any of `fee_male`, `fee_female` or `fee_other` NULL fails with `23514`. An OTHER registrant and an OTHER guest are each billed `fee_other` with basis `SEX_OTHER`. The default `fee_other = LEAST(fee_male, fee_female)` is applied by session-scheduling-engine, not by the DB.

#### AC-VERIFY-9: Per-team sequential invoice numbers are unique and concurrency-safe
**Priority**: MUST
**Given** two teams A and B in the migrated schema
**When** `assign_invoice_number(payment_id)` is called concurrently for 20 distinct team-A payments (20 parallel connections) and for 3 team-B payments, and separately two connections call it concurrently for the **same** payment
**Then**:
- Team A receives exactly the set {1..20} with no duplicates and team B receives {1, 2, 3}.
- Numbering is gapless: a transaction that assigns a number and rolls back returns it, so the next assignment reuses it.
- In the same-payment race, one call succeeds and the other raises an error (`23000`, `payments_invoice_number_set_once`), the team's counter advances by exactly 1, and the next payment gets the next number (no gap).
- `UNIQUE(team_id, invoice_number)` exists, so inserting a duplicate for the same team fails with `23505`, while the same number for a different team is accepted.
- The display form is `INV-000001` (zero-padded to 6 digits, never truncated).
- IRD requires neither gapless numbering nor any invoice number (checked 2026-09-29 on ird.govt.nz). Gapless is our choice. Accountant confirmation is pending before tax-invoices-and-exports ships.
Only the assignment mechanism is in scope. When invoices are issued, and their PDF output, belong to tax-invoices-and-exports.

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
- The encrypted columns are `bank_account_number`, `akahu_app_token`, `bank_account_name` and `ird_number`. `akahu_merchant_id` and `gst_number` stay plaintext. A new `bank_account_last4 CHAR(4)` holds the display projection.
- The encryption key is never stored in the database, in the repo or in logs.
- *(Optional, COULD)* A ciphertext copied into another row or column fails to decrypt, because the AAD binds table, column and row.
- *(Optional, COULD)* A plaintext write into an encrypted column fails with `23514` (envelope-format CHECK).

#### AC-VERIFY-14: Money primitives are exact and never pass through binary floating point
**Priority**: MUST
**Given** the foundation money module
**When** its unit tests run
**Then**:
- Storage is `NUMERIC(10,2)` for every money column. In TS, money is `Money`, a branded `bigint` of cents. The DB and JSON form is `MoneyString`, a 2-dp string (`"17.50"`).
- Parsing `"17.50"` and formatting it back yields `$17.50`.
- Summing `0.10` three times equals exactly `0.30`.
- `99999999.99`, the maximum for `NUMERIC(10,2)`, round-trips through an insert and select against real Postgres with no loss. The DB driver returns numerics as strings, never floats.
- Every ratio operation takes a required rounding mode: `HALF_UP` (half away from zero), `CEIL` or `FLOOR`. Vectors: GST on $17.00 → `2.22` (subtotal `14.78`); GST on $16.00 → `2.09` (subtotal `13.91`); rate suggestion ($120 + $12) / 12 players → `$11.00` (`CEIL`, whole dollars); `-0.025` with `HALF_UP` → `-0.03` (matches PostgreSQL `round`).
- `JSON.stringify` of a `Money` value throws, so money can only leave TS as a `MoneyString`. A lint rule and the type brand stop a raw `number` being passed where money is expected.
- Conformance: every `numeric` column in `public` is `numeric(10,2)`, and no `real`/`double precision` column exists.
- GST calculation itself belongs to team-banking-and-gst and tax-invoices-and-exports.

#### AC-VERIFY-15: Timezone helpers convert Pacific/Auckland local time correctly across DST, independent of host timezone
**Priority**: MUST
**Given** the foundation time module, with the test process run under `TZ=UTC` and again under `TZ=America/New_York`
**When** it converts local date and time in `Pacific/Auckland` to UTC instants and back
**Then** both runs produce identical results:
- `2026-07-01 19:00` (NZST) → `2026-07-01T07:00:00Z`
- `2026-10-07 19:00` (NZDT) → `2026-10-07T06:00:00Z`
- The disambiguation policy is explicit per call: `reject` for user input (typed `NonexistentLocalTimeError` / `AmbiguousLocalTimeError`) and `compatible` for derived times.
- `2026-09-27 02:30` (does not exist; DST starts at 02:00): `compatible` → `2026-09-26T14:30:00Z`; `reject` → `NonexistentLocalTimeError`. It is never silently mapped to an arbitrary offset.
- `2027-04-04 02:30` (ambiguous; DST ends at 03:00 NZDT): `compatible` → `2027-04-03T13:30:00Z` (the earlier instant); `reject` → `AmbiguousLocalTimeError`.
- The default cancellation deadline is an absolute 48 h: 48 hours before `2027-04-05 19:00` NZST (`2027-04-05T07:00:00Z`) is `2027-04-03T07:00:00Z`, which displays as `03/04/2027 8:00 pm` NZDT. The same-wall-clock-2-days-earlier primitive gives `2027-04-03T06:00:00Z` for the same input.
- Display dates use NZ format `DD/MM/YYYY`.
- A TS↔SQL parity test shows `nz_local_to_utc` in PostgreSQL 17 returns the same instants as the TS module for the vector table (`compatible` and `reject`).
All persisted instants are `TIMESTAMP WITH TIME ZONE`. Local conversion happens only in this module, its SQL mirror `nz_local_to_utc` (parity-tested) and the UI.

#### AC-VERIFY-16: Notification service is an abstraction with swappable dev and test adapters
**Priority**: MUST
**Given** the foundation notification module
**When** it is configured once with the `smtp` adapter (Mailpit in dev) and once with the `memory` test adapter, and `send({ to, subject, text, html?, from?, replyTo?, tags?, idempotencyKey })` is called with a single recipient in `to`
**Then** the calling code is identical under both configurations, and `send` resolves to `{ providerMessageId, acceptedAt, deduplicated }`. Failures are typed as `TransientDeliveryError`, `PermanentDeliveryError` or `NotifierConfigurationError`. The adapter is selected only by configuration (`NOTIFIER_ADAPTER=smtp|memory`). The memory adapter exposes the sent messages to tests. Adding a production provider (likely Postmark) means adding an adapter, with no change to callers. No domain templates (low credit, overdue reminder) ship in foundation.

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

#### AC-VERIFY-19: Waitlist queue positions are unique per session and FIFO-safe under concurrency
**Priority**: MUST
**Given** the migrated schema with one session and several users
**When** the integration test inserts WAITLISTED registrations, including two separate connections that each insert a WAITLISTED registration with the same `queue_position` for the same session and then both COMMIT
**Then**:
- A partial unique index `UNIQUE (session_id, queue_position) WHERE status = 'WAITLISTED'` exists. A second WAITLISTED row with the same position fails with `23505`, while non-WAITLISTED rows are not constrained by it.
- A WAITLISTED row without a `queue_position`, or a non-WAITLISTED row with one, fails with `23514`.
- In the two-connection race, exactly one insert commits and the other fails with `23505`.
- The locking contract that registration-and-waitlist must follow is documented in the algorithm doc (§Q11) and `db/schema-deviations.md`: every enqueue, withdraw and promote first locks the `game_sessions` row `FOR UPDATE`; enqueue assigns `max(queue_position) + 1` under that lock; promotion takes the lowest position. Foundation ships only the index and the documented constraint. The allocator belongs to registration-and-waitlist.

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
**Then** every DB enum used by the app has a shared-type counterpart with the identical value set, including the enums added by gap fixes such as the auth provider. The test fails if a value is added to either side only. A compile-time check compares the shared enums with the kysely-codegen output, and `test:integration` also fails when regenerating the kysely-codegen types produces a diff (Q12, option 12A).

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
*Amended 2026-09-30 (spec owner, from reflection):* The architecture rule that no schedule fires between 02:00 and 02:59 local time applies to wall-clock (daily) schedules. Fixed-interval sweeps such as `post-game-billing` (`*/5 * * * *`, flagged `intervalSweep`) are exempt, because they are not affected by DST. The daily slots stay guarded and tested.

#### AC-ASYNC-3: Concurrent duplicates are suppressed, delivery is at-least-once, and jobs survive a worker kill
**Priority**: MUST
**Given** the worker is running
**When** (i) a job is enqueued twice with the same `singletonKey` while the first is still queued or active; (ii) a job is enqueued again with the same key after the first has completed; and (iii) a long-running test job is enqueued and the worker process is SIGKILLed mid-execution (container or child process) and restarted
**Then**:
- (i) The duplicate enqueued while a job with the same `singletonKey` is queued or active is suppressed, and the handler runs once.
- (ii) The replay after completion **does** reach the handler (at-least-once). The test handler neutralises it with a durable domain idempotency key (a unique row) or a guarded status transition, so the side effect happens exactly once.
- (iii) The interrupted job is recovered within the queue's expiry window (test config `expireInSeconds: 5`) and reaches completed within 30 s of the kill, so jobs are not lost.
- The delivery guarantee (at-least-once; `singletonKey` suppresses only concurrent duplicates) is documented so downstream handlers know they must be idempotent.

#### AC-ERROR-1: Missing or invalid required configuration fails fast and names the problem
**Priority**: MUST
**Given** the API or worker starting up
**When** `DATABASE_URL` is unset, or `ENCRYPTION_KEYS` is missing or holds a key that does not decode to 32 bytes, or `ENCRYPTION_ACTIVE_KEY_ID` is missing or names a key not in `ENCRYPTION_KEYS`
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
*Amended 2026-09-30 (spec owner, from reflection):* "retried" applies to transient failures (`TransientDeliveryError`), which retry with backoff per AC-ERROR-3. Permanent and configuration failures (`PermanentDeliveryError`, `NotifierConfigurationError`) fail the job immediately with 0 retries via `NonRetryableJobError`, and still end in a visible failed state with an error log.

**AC summary**: 19 × AC-VERIFY, 4 × AC-INTEGRATION, 3 × AC-ASYNC, 6 × AC-ERROR (32 total; 29 MUST, 3 SHOULD).

### Scope Boundaries

- **In scope**:
  - The monorepo scaffold: the Next.js + Tailwind web app with one placeholder page, the API service with `/health`, a worker process and shared types.
  - The root task runner, ESLint/Prettier and strict type checking.
  - The unit and integration test harness, GitHub Actions CI, Docker Compose local dev (postgres:17, api, worker, web, Mailpit; no Redis), `.env.example`, and Dockerfiles for api (one image, also runs the worker) and web.
  - PostgreSQL 17 migrations for the **full domain model** in `database-design.md`, plus these gap fixes: auth identities; `payments.team_id` and the fee snapshot; guest sex and skill; `UNIQUE(session_id, user_id)`; `guest_count` range 0–2; per-team invoice-number assignment keyed by payment; encrypted bank details and Akahu credentials; balance range 0–100.00; FK changes that preserve financial records; `UNIQUE(recurring_rule_id, date)`; the auto-enrol assignment timestamp; the payment ownership chain (composite FKs); the partial unique waitlist-position index; `fee_other` and the `SEX_OTHER` basis for BY_SEX pricing. A schema deviations record traces each one.
  - Library modules with no domain rules: money, Pacific/Auckland time, crypto (encrypt/decrypt, key ID), the notification abstraction (`smtp`/Mailpit and `memory` adapters), and the job-runner wrapper (enqueue, schedule, retry, dedupe) with three named no-op schedule slots and a `heartbeat` job.
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
  - Node.js 24 LTS and pnpm 10.
  - The `postgres:17` and `axllent/mailpit` images.
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
  - Correctness under concurrency: invoice numbers (AC-VERIFY-9), waitlist positions (AC-VERIFY-19) and job dedupe (AC-ASYNC-3).

### Creative Exploration Needed

Level 4, so creative is mandatory. Each question lists the options and the ACs it unblocks. The tag in brackets is the creative agent that owns it. The numbers are referenced from the ACs above.

1. **[Architecture] Backend framework**: Node (NestJS vs Express, TypeScript) or Python (FastAPI). Criteria: shared types with the Next.js web app (Node shares TS directly; FastAPI needs OpenAPI codegen), the job-runner ecosystem, Decimal/money ergonomics, team familiarity and hosting fit. This drives the command column used in Verification Method and AC-VERIFY-3, AC-VERIFY-17 and AC-INTEGRATION-2. Confidence: LOW (genuinely open in productBrief). → Resolved: Node 24 + TypeScript strict + Fastify 5; NestJS and FastAPI rejected (`memory-bank/creative/platform-foundation-architecture.md` §Q1).
2. **[Architecture] Monorepo tooling and layout**: pnpm workspaces alone, pnpm + Turborepo, or Nx. If Option B: pnpm + uv with a Makefile/justfile as the root runner. This settles the directory names (`apps/web`, `apps/api`, `apps/worker`, `packages/shared`, or similar) and whether the worker is a separate app or a second entry point of the API. Unblocks AC-VERIFY-1. → Resolved: pnpm 10 workspaces only; `apps/web`, `apps/api` (worker = `src/worker.ts`, same image), `packages/shared` (`memory-bank/creative/platform-foundation-architecture.md` §Q2).
3. **[Architecture] Migrations tool and data-access layer**: an ORM-coupled tool (Prisma, Drizzle, Alembic) vs raw-SQL, stack-neutral tooling (dbmate, node-pg-migrate). Trade-offs: expressiveness for enums, CHECK constraints, triggers and per-team sequence functions; down-migration support (AC-VERIFY-5); and whether an ORM, a query builder (e.g. Kysely, SQLAlchemy Core) or raw SQL is used for data access. → Resolved: node-pg-migrate plain-SQL migrations with real downs + Kysely over `pg` + kysely-codegen (`memory-bank/creative/platform-foundation-architecture.md` §Q3).
4. **[Architecture] Job runner and scheduler**: Postgres-backed (pg-boss, Graphile Worker, Procrastinate) vs Redis-backed (BullMQ, Celery, arq), or host-platform cron triggering HTTP endpoints. Criteria: timezone-aware cron (AC-ASYNC-2), dedupe keys and at-least-once delivery (AC-ASYNC-3), retry and failed-state visibility (AC-ERROR-3), and one fewer service to run if Postgres-backed. Also decide the **post-game-billing trigger shape**: a periodic sweep (e.g. every 5 min for sessions whose max court `end_time` has passed) or a delayed job scheduled per session at publish time. → Resolved: pg-boss with `tz: 'Pacific/Auckland'` schedules; billing trigger T3 (5-min sweep → per-session `bill-session` job) (`memory-bank/creative/platform-foundation-architecture.md` §Q4).
5. **[Architecture] Encryption at rest and key management**: application-level AEAD (e.g. AES-256-GCM or libsodium secretbox) with a key-ID prefix and env-supplied key in dev and KMS in prod, vs `pgcrypto` `pgp_sym_encrypt`, where the key travels through SQL and risks appearing in logs, vs relying on disk or volume encryption only (does not meet the column-level requirement). Also decide which columns beyond `bank_account_number` and `akahu_app_token` to encrypt (`bank_account_name`, `akahu_merchant_id`, `ird_number`), and whether to store a non-sensitive display projection (e.g. last 2–4 digits of the account) for UI masking. Unblocks AC-VERIFY-13 and AC-ERROR-4. → Resolved: app-level AES-256-GCM, env keyring with key-ID envelope and AAD; also encrypt `bank_account_name`, `ird_number`; add `bank_account_last4` (`memory-bank/creative/platform-foundation-architecture.md` §Q5).
6. **[Algorithm] Money representation and rounding**: keep `DECIMAL(10,2)` (matches the draft; needs Decimal types end-to-end and string-returning drivers) or switch to `BIGINT` integer cents (simpler arithmetic; diverges from the draft and is recorded as a deviation). Also choose the rounding mode for ratio operations (half-up vs banker's rounding) to be used later for the GST 3/23 split and `ceil` rate suggestion. Unblocks AC-VERIFY-14 and AC-ERROR-5. → Resolved: `NUMERIC(10,2)` in DB, `MoneyString` on the wire, branded bigint cents in TS; HALF_UP / CEIL / FLOOR explicit per call (`memory-bank/creative/platform-foundation-algorithm.md` §Q6).
7. **[Algorithm] DST policy for local wall-clock times**: how a nonexistent local time (`2026-09-27 02:30`) and an ambiguous one (`2027-04-04 02:30`) resolve: shift forward or reject, earlier or later instant. Also whether "cancellation deadline defaults to 48 h prior" means absolute hours (the AC-VERIFY-15 vector) or the same local wall-clock time two days earlier; the two differ by 1 h across a DST change. Foundation provides both primitives, and session-scheduling-engine applies the chosen rule. Also decide whether sessions should store a computed `starts_at`/`ends_at timestamptz`, because the draft has only `date` + per-court `TIME` with no zone, and post-game billing needs an instant. Unblocks AC-VERIFY-15. → Resolved: `reject` for user input, `compatible` for derived times; absolute 48 h; trigger-maintained `starts_at/ends_at` via `nz_local_to_utc` (`memory-bank/creative/platform-foundation-algorithm.md` §Q7).
8. **[Architecture] Production email provider and adapter contract**: productBrief lists the provider as "TBD". Options include Postmark, SendGrid, AWS SES and Resend. Only the adapter interface and the dev (Mailpit) and test adapters are built here. The choice matters now only so the `send()` contract (fields, error types, idempotency key) fits the likely provider. Unblocks AC-VERIFY-16 and AC-ERROR-6. → Resolved: Postmark likely (not built); single-recipient `send()` with required `idempotencyKey` and three typed errors (`memory-bank/creative/platform-foundation-architecture.md` §Q8).
9. **[Algorithm] Invoice-number allocation**: a gapless counter table (`SELECT ... FOR UPDATE`, serialises per team) vs a per-team sequence that allows gaps. IRD requires unique, identifiable invoices, not strictly gapless ones, so confirm. Also the display format (e.g. `<TEAM-PREFIX>-000123`). Unblocks AC-VERIFY-9. → Resolved: gapless per-team counter via `assign_invoice_number(payment_id)` (payment-locked); display `INV-000123`; IRD requires no numbering (`memory-bank/creative/platform-foundation-algorithm.md` §Q9).
10. **[Architecture] Hosting target**, only as far as it constrains foundation: for example Fly.io, Render, Railway, AWS ECS + RDS, or Vercel for web plus a separate API and worker host. This affects whether the scheduler runs in-process or uses platform cron, where encryption keys live (KMS vs platform secrets), TLS termination, and the managed Postgres 17 choice. Deployment itself is out of scope. → Resolved: binding constraints C1–C6; DigitalOcean App Platform (Sydney) + managed PG 17 as provisional vendor (`memory-bank/creative/platform-foundation-architecture.md` §Q10).
11. **[Algorithm] Fee snapshot and guest model shape**: snapshot columns on `payments` vs a `payment_line_items` child table (one line per registrant and guest) vs JSONB; a `registration_guests` child table vs positional columns on `registrations`. The workflows doc bills per confirmed registration including guests, so line items are likely, but that is not decided here. Unblocks AC-VERIFY-7 and AC-VERIFY-8. → Resolved: `registration_guests` child table + `payments` header with `payment_line_items`, generated GST, ownership composite FKs, `fee_other` (`memory-bank/creative/platform-foundation-algorithm.md` §Q11).
12. **[Architecture] Shared-types strategy**: hand-written TS enums in a shared package vs types generated from the DB schema (e.g. Kysely codegen, Drizzle inference) vs types generated from OpenAPI. This is tightly coupled to Q1 and Q3, and determines how AC-INTEGRATION-2 parity is enforced. → Resolved: 12A, hand-written `as const` enums + zod in `@sgm/shared`, with runtime `pg_enum` parity, compile-time codegen equality and a codegen drift check (`memory-bank/creative/platform-foundation-architecture.md` §Q12).

**Confidence by section**:
- Verification Method: HIGH. Metrics, observation points and commands are concrete (Option A with Fastify, resolved 2026-09-29).
- Schema gap ACs (AC-VERIFY-6 to AC-VERIFY-12, AC-INTEGRATION-1): HIGH. They are taken directly from `database-design.md`, the task gap list, the workflows doc and productBrief. The column and table shape is pending Q11.
- Library ACs (money, time, crypto, notifications, jobs): HIGH for behaviour and test vectors, and LOW for the representation and policy choices (Q4–Q9), which are flagged above rather than guessed.
- CI/local dev: HIGH for GitHub Actions and Compose. The 120 s, 30 s and 10 min thresholds are proposed and have not been measured, since no code exists yet.

### Implementation Guide Required
Yes. Downstream developers need a short `README` or `docs/` "Getting started" covering prerequisites, `setup`, `docker compose up -d --wait`, the root targets, how to add a migration and update the deviations record, how to register a job or schedule, how to add a notification adapter, and how to encrypt a new sensitive column. AC-VERIFY-1 and AC-VERIFY-2 cannot fully verify onboarding on their own.

## Test Strategy

### Approach
- **Emphasis**: balanced. Library modules (money, time, crypto, config, notifications) are unit-heavy. Schema, jobs and health checks are integration tests against a real Postgres 17, because the ACs are mostly about DB constraints and job-store behaviour that mocks cannot prove. One smoke E2E test covers web → API.
- **Target test count**: about 86 in total (was about 62). This is above the 20 guideline because the task covers 32 ACs across 6 library modules (money, time, crypto, config, logger, notifications) plus the job wrapper, a full domain schema with 11 gap fixes, and a job runner. The 2026-09-29 revisions add about 24 tests: the architecture's drift and wrapper tests (codegen, OpenAPI, jobs, logger), and negative tests for the critique fixes (ownership chain, waitlist race, same-payment invoice race, BY_SEX + OTHER, AC-ASYNC-3 replay), each of which a mock can't prove. The count averages under 3 tests per AC. The schema tests are split across several files so each stays near the 6–12 per-module guideline.
- **Coverage gate**: 80% or more line coverage on `packages/shared/src/{money,time}` and `apps/api/src/lib/{crypto,config,notifications,jobs}` (SHOULD, per Success metrics).

### File Organization
- **New test files** (confirmed by the architecture doc):
  - `packages/shared/src/money/money.test.ts`: exact arithmetic, parse/format, rounding, invalid input
  - `packages/shared/src/time/time.test.ts`: Pacific/Auckland conversions, DST gap and overlap vectors, host-timezone independence
  - `apps/api/src/lib/config/config.test.ts`: fail-fast on missing or invalid env
  - `apps/api/src/lib/crypto/crypto.test.ts`: round trip, key-ID prefix, rotation, tamper and wrong-key errors, no plaintext in errors
  - `apps/api/src/lib/notifications/notifications.test.ts`: adapter contract, in-memory adapter, typed delivery errors
  - `apps/api/src/lib/logger/logger.test.ts`: redaction, camelCase trace fields, level and format config
  - `apps/api/src/lib/jobs/jobs.test.ts`: wrapper unit tests (`_meta` trace injection, option mapping, lifecycle logs)
  - `apps/api/src/openapi.test.ts`: generated OpenAPI equals the committed `apps/api/openapi.yaml`
  - `apps/api/test/integration/health.int.test.ts`: `/health` returns 200 with the DB up and 503 with the DB down
  - `apps/api/test/integration/schema.int.test.ts`: migrate up/down/up, conformance to `database-design.md` plus the deviations record, auth identities, balance range, retention, recurrence uniqueness
  - `apps/api/test/integration/db-codegen.int.test.ts`: regenerated kysely-codegen output equals the committed `types.generated.ts`
  - `apps/api/test/integration/registrations-guests.int.test.ts`: `UNIQUE(session_id, user_id)`, guest count and positions, registration team = session team, waitlist position uniqueness and the two-connection race (AC-VERIFY-19)
  - `apps/api/test/integration/payments-snapshot.int.test.ts`: fee snapshot, generated GST, immutability, idempotency key, ownership chain negatives, BY_SEX + OTHER billing
  - `apps/api/test/integration/invoice-number.int.test.ts`: concurrent assignment is unique and gapless per team; same-payment race
  - `apps/api/test/integration/money-roundtrip.int.test.ts`: `99999999.99` round trip, overflow `22003`
  - `apps/api/test/integration/time-parity.int.test.ts`: `nz_local_to_utc` equals the TS module on the DST vector table
  - `apps/api/test/integration/session-instants.int.test.ts`: trigger-maintained `starts_at/ends_at`
  - `apps/api/test/integration/crypto-columns.int.test.ts`: raw column bytes contain no plaintext
  - `apps/api/test/integration/enum-parity.int.test.ts`: shared TS enums equal `pg_enum` values
  - `apps/api/test/integration/mailpit.int.test.ts`: a message sent via the dev adapter appears in the Mailpit API
  - `apps/api/test/integration/jobs.int.test.ts`: enqueue → complete lifecycle, concurrent dedupe vs replay after completion, SIGKILL restart survival, retry → failed, Pacific/Auckland cron registration
  - `apps/web/e2e/smoke.spec.ts`: the page renders data from the live API `/health` (Playwright)
- **Extend existing**: none. This is a greenfield repo.

### What NOT to Test
- Framework boilerplate (Next.js routing, the framework's own HTTP server): framework guarantees it
- Pure type definitions in `packages/shared/src/types`: covered by `tsc --strict` plus the enum-parity integration test
- Domain rules owned by later features (pricing, waitlist, billing, GST split): out of scope. Only the schema shape that supports them is tested.
- The production email provider and Akahu API: not integrated in this feature
- Docker Compose and CI YAML themselves: verified by running them (`docker compose up --wait`, `actionlint`, a green CI run), not by unit tests

### Per-Phase Test Guidance
- Phase 1: 9 tests. Config fail-fast, including `ENCRYPTION_KEYS`/`ENCRYPTION_ACTIVE_KEY_ID` (4); API `/health` unit happy path (1); each root target runs (1 script-level check); logger redaction, camelCase trace fields and level/format config (3). A deliberate lint, type or test violation makes `ci` fail (verified manually and recorded in the phase notes).
- Phase 2: 4 tests. `/health` 200 vs 503 with the DB stopped (2); web smoke E2E (1); OpenAPI drift (1). `actionlint` is clean, and a CI run on a local `act`-free dry run is replaced by the first real run when pushing is re-enabled.
- Phase 3: 34 tests. Migrate up, down and up again with identical schema dumps (1); conformance to the design doc and deviations record, including numeric(10,2)-only and no float columns (1); auth identities, one user with 3 providers (2); `UNIQUE(session_id, user_id)` and `guest_count` 0–2 (3); guest sex and skill attributes (1); position 2 without position 1 (1); `payments.team_id` NOT NULL and the fee snapshot is immutable (2); invoice numbers unique and gapless under concurrency (2); same-payment invoice race and already-invoiced payment → `23000` (2); balance CHECK 0.00–100.00 (2); financial FKs RESTRICT deletes (3); `UNIQUE(recurring_rule_id, date)` and the auto-enrol timestamp (2); enum parity (1); codegen drift (1); ownership chain: payment user mismatch, payment team mismatch, registration team ≠ session team, credit transaction mismatch → `23503` (4); waitlist: duplicate position `23505`, position iff WAITLISTED, two-connection race (3); BY_SEX + OTHER: missing `fee_other` → `23514`, OTHER registrant billed `fee_other`, OTHER guest billed `fee_other` (3).
- Phase 4: 26 tests. Money (10): add/sub/multiply-ratio exact, 0.1+0.2, parse `"17.50"`, NZD format, GST and CEIL rate vectors, HALF_UP negative tie, reject floats, NaN and over-precision, `JSON.stringify(Money)` throws, `99999999.99` DB round trip. Time (9): the 2026-09-27 gap, the 2027-04-04 overlap, 48 h absolute vs same wall-clock, host `TZ=UTC` vs `TZ=America/New_York` give the same result, `DD/MM/YYYY` format, reject a nonexistent time under the strict policy, TS↔SQL `nz_local_to_utc` parity (integration), trigger-maintained session instants (integration). Crypto (7): round trip, key-ID prefix plus rotation-read of an old key, tampered ciphertext throws, wrong key throws without plaintext in the message, raw column bytes contain no plaintext (integration), ciphertext copied to another row fails (AAD), plaintext write → `23514` (integration).
- Phase 5: 13 tests. Notifications (4): contract, in-memory capture, typed failure, arrives in Mailpit. Jobs (9): lifecycle states observable, concurrent duplicate suppressed by `singletonKey`, replay after completion reaches the handler and is neutralised by a domain idempotency key, survives a SIGKILL (recovered within the 5 s expiry, completes within 30 s), retry with backoff ends in the failed state, cron registered in Pacific/Auckland fires at the right UTC instant across DST, `heartbeat` job completes, wrapper `_meta` trace injection and option mapping (2, unit).
- Phase 6: 3 checks. Full `ci` is green from a fresh clone; `docker compose up -d --wait` finishes in 120 s or less; Getting Started steps are followed verbatim on a clean checkout. Coverage gate reported.

## Architectural Plan

### Executive Summary
This task builds the monorepo, local stack, CI, full PostgreSQL 17 domain schema (with the 11 gap fixes) and the stateless library modules that all ten later v1.0.0 features depend on. It contains no domain logic.

### Architectural Principles
1. **Postgres is the system of record.** Constraints (CHECK, UNIQUE, FK RESTRICT) enforce invariants in the database, not only in app code.
2. **Money never touches binary floating point.** One money module is used everywhere.
3. **Store instants in UTC (`timestamptz`) and convert to Pacific/Auckland only at the edges.** DST policy lives in one algorithm: it exists once in TS (`@sgm/shared/time`) and once as its SQL mirror `nz_local_to_utc`, and the two are parity-tested.
4. **Secrets and sensitive columns are encrypted at the application level with a key-ID prefix,** so keys can be rotated. Plaintext never appears in logs or errors.
5. **Every async side effect goes through the job runner** (idempotent, deduplicated, retried, observable).
6. **One root command set and the same gates locally and in CI.**
7. **12-factor config:** env only, validated at boot, fail fast.

### Architecture Alternatives
Resolved by `/yay:creative` on 2026-09-29 (chosen: Option I, lean TypeScript all-Postgres: Fastify + node-pg-migrate + Kysely + pg-boss). The 12 questions in `### Creative Exploration Needed` list the options for each decision, with Q1 (backend), Q3 (migrations/data access), Q4 (job runner) and Q5 (encryption) the most important. The selection, weighted evaluation and justification are recorded in `memory-bank/creative/platform-foundation-architecture.md` and `memory-bank/creative/platform-foundation-algorithm.md`. Suggested weights: maintainability 0.25, correctness/safety 0.25, time to market 0.2, operational simplicity 0.15, cost 0.1, performance 0.05.

### Observability Requirements
- **Logging**: structured JSON to stdout from `api` and `worker` (pino). Fields (camelCase): `timestamp`, `level`, `message`, `service`, `traceId`, `spanId`, `requestId`, `jobId`. Configured by `LOG_LEVEL` and `LOG_FORMAT` (`json|text`). Redacted: `authorization`, `cookie`, `password*`, `*_token`, `bank_account_*`, `ird_number`, `akahu_*`.
- **Tracing**: OpenTelemetry SDK wired but exporting to console or no-op by default (`OTEL_EXPORTER_OTLP_ENDPOINT` optional). W3C `traceparent` is propagated from web → API, and from API → job payloads (trace context stored in job metadata).
- **Metrics**: `/metrics` is deferred. The foundation logs job lifecycle events (`job.enqueued|started|completed|failed`, with duration). A metrics backend is decided with hosting (Q10).
- **Infrastructure**: none in foundation beyond stdout. The collector and backends come with hosting.

### API Requirements
- **REST API**: yes, minimal. `GET /health` returns `{status, db, version}` with 200, or 503 when the DB is unreachable. OpenAPI spec at `apps/api/openapi.yaml` (generated from the routes by `pnpm run openapi` and drift-checked; later features extend it). Build agents MUST load `context/api-rest-requirements.md`.
- **GraphQL**: no.
- **Auth**: none in foundation (arrives with auth-and-user-roles).
- **API testing**: integration tests for `/health` (Phase 2).

### Risk Assessment
| Risk | Likelihood | Impact | Mitigation |
| --- | --- | --- | --- |
| Version-specific API drift in pinned libraries (pg-boss, kysely-codegen, `@fastify/otel`) vs the creative docs | Medium | Medium | Backend choice (Q1) is resolved and pins are confirmed. All access goes through the foundation wrappers, and tests assert behaviour, not internals (architecture doc → Risk Assessment). |
| The schema gets locked in before domain features learn their needs | Medium | High | The deviations record plus reversible migrations. Later features add additive migrations only. |
| DST and money bugs surface late, in billing | Medium | High | Test vectors are fixed in Phase 4 (2026-09-27 gap, 2027-04-04 overlap). One module owns each concern. |
| Encryption key handling leaks plaintext | Low | High | Encryption is AEAD at the app level, and tests check raw bytes and error messages (AC-ERROR-4). |
| CI can't run while GitHub push is blocked (403) | High (now) | Medium | Run `ci` locally. The first GitHub Actions run happens once access is fixed; AC-VERIFY-4 stays open until then. |

## Implementation Roadmap

### New Source Files (pin path + extension)
<!-- Confirmed / re-pinned by memory-bank/creative/platform-foundation-architecture.md → New Source Files, plus the algorithm doc's files. -->
- [ ] `package.json`, `pnpm-workspace.yaml`, `tsconfig.base.json`, `eslint.config.mjs`, `.prettierrc.json`, `.prettierignore`, `.editorconfig`, `.nvmrc`, `.dockerignore`, `vitest.config.ts`: root workspace, strict TS, lint, format and Vitest projects (unit | integration)
- [ ] `scripts/setup.ts`: copies `.env.example` → `.env` if missing and generates dev `ENCRYPTION_KEYS`
- [ ] `.env.example`, `.gitignore` (extend): documented env vars, with no secrets
- [ ] `docker-compose.yml`: postgres:17, mailpit, api, worker, web (no Redis), with health checks
- [ ] `apps/api/Dockerfile` (one image for api and worker), `apps/web/Dockerfile`
- [ ] `.github/workflows/ci.yml`: actionlint + `pnpm run ci` with postgres:17 and Mailpit service containers
- [ ] `apps/web/package.json`, `apps/web/next.config.ts`, `apps/web/postcss.config.mjs`, `apps/web/tsconfig.json` (Tailwind v4 CSS-first; no `tailwind.config`)
- [ ] `apps/web/src/app/layout.tsx`, `apps/web/src/app/page.tsx`, `apps/web/src/app/globals.css`: placeholder page that shows API health
- [ ] `apps/web/src/lib/api-client.ts`: typed fetch wrapper (injects `traceparent`)
- [ ] `apps/web/src/instrumentation.ts`: Next.js OTel registration
- [ ] `apps/web/playwright.config.ts`, `apps/web/e2e/smoke.spec.ts`
- [ ] `apps/api/package.json`, `apps/api/tsconfig.json`, `apps/api/tsup.config.ts`, `apps/api/src/main.ts`, `apps/api/src/app.ts`: HTTP entrypoint and `buildApp(deps)` Fastify factory
- [ ] `apps/api/src/worker.ts`: worker entrypoint (pg-boss) with internal `/health` on `WORKER_HEALTH_PORT`
- [ ] `apps/api/src/cli.ts`: `db migrate|rollback|reset`, `jobs trigger|schedules`
- [ ] `apps/api/src/instrumentation.ts`: OTel NodeSDK
- [ ] `apps/api/src/routes/health.ts`: `GET /health`
- [ ] `apps/api/openapi.yaml` (generated, drift-checked), `apps/api/src/openapi.ts`
- [ ] `apps/api/src/lib/config/config.ts`: zod env schema plus fail-fast validation
- [ ] `apps/api/src/lib/db/pool.ts`: pg Pool (NUMERIC/INT8/DATE/TIME as strings, `TimeZone=UTC` per connection)
- [ ] `apps/api/src/lib/db/kysely.ts`, `apps/api/src/lib/db/types.generated.ts`, `apps/api/src/lib/db/enum-parity.ts`, `apps/api/src/lib/db/migrate.ts`: Kysely, committed codegen output, compile-time enum parity, node-pg-migrate runner + pg-boss schema install
- [ ] `apps/api/src/lib/logger/logger.ts`: pino with redaction and camelCase trace fields
- [ ] `apps/api/src/lib/crypto/crypto.ts`, `apps/api/src/lib/crypto/keyring.ts`: AES-256-GCM with key ID, AAD and rotation
- [ ] `apps/api/src/lib/notifications/notifier.ts`, `apps/api/src/lib/notifications/errors.ts`, `apps/api/src/lib/notifications/adapters/smtp.ts`, `apps/api/src/lib/notifications/adapters/in-memory.ts`
- [ ] `apps/api/src/lib/jobs/jobs.ts`: createJobRunner, defineQueue, enqueue (transactional), schedule (Pacific/Auckland), work; trace `_meta`; lifecycle logs
- [ ] `apps/api/src/jobs/heartbeat.ts`, `apps/api/src/jobs/schedules.ts`, `apps/api/src/jobs/registry.ts`: heartbeat job, 3 named no-op schedule slots (`recurrence-materialisation`, `post-game-billing`, `daily-overdue`) and the queue registry
- [ ] `apps/api/test/global-setup.ts`, `apps/api/test/helpers/test-db.ts`, `apps/api/test/fixtures/expected-schema.ts`: template-DB isolation and the hand-written expected schema
- [ ] `db/migrations/<utc-ts>_<name>.sql` (node-pg-migrate SQL format, order preserved): 1 `_enums` (13 draft enums + `auth_provider` + `fee_basis` incl. `SEX_OTHER`); 2 `_users_and_auth_identities`; 3 `_teams` (encrypted TEXT columns with envelope CHECKs, `bank_account_last4`); 4 `_team_members` (`auto_enroll_assigned_at`); 5 `_recurring_session_rules` (`fee_other`, BY_SEX fees CHECK); 6 `_game_sessions_and_courts` (`UNIQUE(recurring_rule_id, date)`, `UNIQUE(id, team_id)`, `fee_other`, `nz_local_to_utc`, trigger-maintained instants); 7 `_registrations_and_guests` (`registrations.team_id` + composite FK, `UNIQUE(id, user_id, team_id)`, waitlist partial unique index, `registration_guests`); 8 `_wallet` (ownership composite FKs); 9 `_payments_and_invoicing` (ownership composite FK, fee snapshot + line items, `assign_invoice_number`); 10 `_indexes`
- [ ] `db/schema-deviations.md`: every deviation from `database-design.md`, with its source requirement
- [ ] `packages/shared/package.json`, `packages/shared/tsconfig.json`, `packages/shared/src/index.ts` (JIT package; `exports` → `src/index.ts`)
- [ ] `packages/shared/src/types/enums.ts`: domain enums mirrored from the DB (`as const` tuples)
- [ ] `packages/shared/src/api/health.ts`: zod `HealthResponse`
- [ ] `packages/shared/src/money/money.ts`, `packages/shared/src/money/zod.ts`: exact NZD money and wire schemas
- [ ] `packages/shared/src/time/time.ts`: Pacific/Auckland conversion and DST policy
- [ ] `packages/shared/src/invoice/invoice.ts`: `formatInvoiceNumber` (`INV-000123`)
- [ ] `docs/getting-started.md`; `docs/adr/0001-backend-framework.md` … `docs/adr/0008-shared-types.md` (architecture Q1, Q2, Q3, Q4, Q5, Q8, Q10, Q12); `docs/adr/0009-money.md`, `docs/adr/0010-time-dst.md`, `docs/adr/0011-invoice-numbering.md`, `docs/adr/0012-fee-snapshot-and-guests.md` (algorithm Q6, Q7, Q9, Q11)
- [ ] `memory-bank/techContext.md`, `memory-bank/systemPatterns.md` (extend): record the chosen stack, commands and conventions

### Phases
- [x] Phase 1: Workspace scaffold and quality gates (AC-VERIFY-1, AC-VERIFY-3, AC-VERIFY-17, AC-ERROR-1)
  - Components: root `package.json` targets and `scripts/setup.ts`, apps/web placeholder, apps/api with `/health` plus `src/worker.ts` and `src/cli.ts` skeletons, packages/shared, lint/format/strict TS, Vitest unit + integration projects, config fail-fast, logger
  - Milestone: `lint`, `typecheck` and `test` pass locally; deliberate violations fail each gate
- [x] Phase 2: Local dev stack and CI (AC-VERIFY-2, AC-VERIFY-4, AC-ERROR-2, AC-INTEGRATION-4)
  - Components: `docker-compose.yml` (no Redis), Dockerfiles (one api image with two commands, plus web), `.env.example`, `.github/workflows/ci.yml`, DB-aware `/health`, generated OpenAPI, web → API smoke E2E
  - Milestone: `docker compose up -d --wait` is healthy in 120 s or less; `/health` gives 503 with the DB stopped; the web page shows live API data; `actionlint` is clean
- [x] Phase 3: Domain schema and migrations (AC-VERIFY-5 to AC-VERIFY-12, AC-VERIFY-19, AC-INTEGRATION-1, AC-INTEGRATION-2)
  - Components: node-pg-migrate SQL migrations 1–10, Kysely + kysely-codegen, full schema from `database-design.md` plus all gap fixes (including the ownership composite FKs, waitlist partial unique index, `fee_other`/`SEX_OTHER` and `assign_invoice_number`), `db/schema-deviations.md`, shared enums with parity tests
  - Milestone: migrate, rollback and migrate again from empty in 30 s or less with identical dumps; conformance plus the deviations record is at 100%
- [x] Phase 4: Money, time and crypto libraries (AC-VERIFY-13, AC-VERIFY-14, AC-VERIFY-15, AC-ERROR-4, AC-ERROR-5)
  - Components: `packages/shared` money (+ zod), time and invoice format, `nz_local_to_utc` parity tests, `apps/api` crypto and keyring, encrypted columns wired to the crypto module
  - Milestone: all DST and money test vectors pass; no plaintext in the raw bytes of encrypted columns
- [x] Phase 5: Job runner and notifications (AC-VERIFY-16, AC-ASYNC-1, AC-ASYNC-2, AC-ASYNC-3, AC-ERROR-3, AC-ERROR-6, AC-INTEGRATION-3)
  - Components: pg-boss wrapper `apps/api/src/lib/jobs/jobs.ts`, `apps/api/src/jobs/` (`heartbeat`, 3 schedule slots, registry), notifier with `smtp` (Mailpit) and `memory` adapters
  - Milestone: job lifecycle is observable in the job store; a Mailpit message is received; retry ends in the failed state
- [x] Phase 6: Documentation, decision records and full-gate verification (AC-VERIFY-18; end-to-end verification of all ACs)
  - Components: `docs/getting-started.md`, ADRs `docs/adr/0001`–`0012` (architecture Q1–Q5, Q8, Q10, Q12; algorithm Q6, Q7, Q9, Q11), updated `techContext.md` and `systemPatterns.md`
  - Milestone: **a fresh clone → `setup` → `docker compose up -d --wait` → `ci` runs green with 0 errors or warnings**, following Getting Started verbatim. The GitHub Actions run (AC-VERIFY-4) is confirmed once pushing is re-enabled.

## Creative Phases

- [x] Architecture design → COMPLETE (`memory-bank/creative/platform-foundation-architecture.md`) (Q1 backend, Q2 monorepo, Q3 migrations/data access, Q4 job runner and billing trigger, Q5 encryption/keys, Q8 email contract, Q10 hosting constraints, Q12 shared types; also re-pin files if Option B)
- [x] Algorithm design → COMPLETE (`memory-bank/creative/platform-foundation-algorithm.md`) (Q6 money representation and rounding, Q7 DST policy and session instants, Q9 invoice-number allocation, Q11 fee snapshot and guest model)

## Design Critique (advisory)

- **Backend**: codex (`CREATIVE CRITIQUE: codex — usable`), 2026-09-29
- **Verdict**: needs-attention. Codex's summary: the foundation plan allows cross-team financial corruption, leaves FIFO ordering unsafe under concurrency, makes some valid users unbillable, and overstates the async and invoice-number guarantees.
- **Findings**:
  1. critical · Payment ownership is not tied to the registration's user or team (algorithm doc §Q11 payments DDL). Enforce the chain in the DB with composite FKs or a deferred trigger, and add negative tests.
  2. high · FIFO waitlist order is not guaranteed under concurrency. Needs a partial `UNIQUE(session_id, queue_position) WHERE status='WAITLISTED'` plus a per-session allocator or lock.
  3. high · Gapless invoice allocation leaks a number when two issuers race on the same payment. Lock the payment first, require exactly 1 affected row, and roll back otherwise.
  4. high · BY_SEX pricing makes `OTHER` users unbillable (the `fee_basis` enum only has MALE and FEMALE). Needs a product rule.
  5. medium · AC-ASYNC-3 promises exactly-once, but pg-boss `singletonKey` only suppresses concurrent duplicates. Reword it as concurrent dedupe plus at-least-once delivery with domain idempotency.
- **Disposition (spec owner, 2026-09-29)**: all 5 applied — 1 ownership composite FKs; 2 waitlist partial unique index + session-row lock contract; 3 payment-locked invoice assignment; 4 `fee_other` rate + `SEX_OTHER` basis (default LEAST(male,female)); 5 AC-ASYNC-3 reworded.

---

## Execution State

**Build Status**: IDLE
**Current Phase**: REFLECT → ARCHIVE
**Current Step**: Step 4 - Git Commit - COMPLETE
**Can Resume**: NO
**Build Result**: COMPLETE
**Final Review Backend**: AUTO FINAL REVIEW BACKEND: codex — usable (base: local main; verdict: Ready to merge with fixes — 0 Critical, 4 Important, 5 Minor)
**Current Phase**: 6 of 6
**Auto-Build Mode**: YES
**Last Completed**: Phase 6 (2026-09-29)
**Creative Critique**: CREATIVE CRITIQUE: codex — usable (needs-attention, 5 findings, all applied)

### Resumption Notes
**Can Resume**: NO
**Resume From**: (build complete; run /yay:reflect platform-foundation)
**Notes**: Local-only run. Commit per phase, never push (spec owner, 2026-09-29; GitHub push blocked with a 403). Local services: Docker 29.5 on Colima, postgres:17 image, pnpm via Corepack (pin pnpm@10 through packageManager).

### Current Build Step
**Step**: Step 11 - Git completion (Phase 6)
**Status**: COMPLETE
**Completed**: 2026-09-29

### Halt State
(none)

### Deviations
<!-- Per entry: - Phase <N> | <file:line/artifact> | <rationale> -->
- Phase 1 | package.json typecheck | added --include-workspace-root plus root tsconfig.json so scripts/ and vitest.config.ts are type-checked
- Phase 1 | apps/api/src/lib/logger/logger.ts | formatter-based deep key redaction instead of wildcard pino redact paths (fast-redact lacks partial wildcards); pino.transport destination
- Phase 1 | package.json versions | TypeScript pinned 5.9.3 (typescript-eslint peer range); eslint 9.39; zod 4; vitest 5; next 16
- Phase 1 | apps/api/src/routes/health.ts, main.ts | /health takes injected checkDb (503 degraded when false); default true with TODO(Phase 2) until pool wired
- Phase 1 | review advisories carried forward | A1 redact child-logger bindings; A2 redact DSN/url keys, set-cookie, x-api-key, Buffers (+tests); A4 URL-validate SMTP_URL/MAILPIT_API_URL/API_INTERNAL_URL; A3 optional HOST config; drop @fastify/swagger if Phase 2 does not use it; verify coverage globs match in Phases 3-5
- Phase 1 | apps/api/src/cli.ts:25 | `db migrate|rollback|reset` validate config then exit 1 "not implemented until Phase 3". The targets exist; `pnpm run ci` and `db:migrate` fail until Phase 3 (phase review, accepted).
- Phase 1 | package.json:17 | `test:integration` uses `--passWithNoTests`; there is no example integration test until Phase 2/3 (phase review, accepted).
- Phase 1 | vitest.config.ts:29 | Coverage `include` lists money/time/crypto/notifications/jobs, which don't exist yet; the 80% gate only covers `lib/config` for now (phase review, accepted).
- Phase 2 | .github/workflows/ci.yml | AC-VERIFY-4 partially verified: actionlint (rhysd/actionlint:latest via docker) reports 0 findings and the local `pnpm run ci` is green, but the real GitHub Actions run stays open until pushing is re-enabled (403). Deviation, not failure. actionlint runs in CI as a `docker://rhysd/actionlint:latest` step.
- Phase 2 | docker-compose.yml api command | api runs `node --import ./dist/instrumentation.js dist/main.js` without the design's `db migrate &&` prefix, because `cli db migrate` is a Phase 3 stub that exits 1. TODO(Phase 3): restore `node dist/cli.js db migrate && ...`.
- Phase 2 | apps/*/Dockerfile | no BuildKit `--mount=type=cache` (Colima docker has no buildx); portable classic-builder Dockerfiles. `pnpm deploy --legacy` for the api runtime image.
- Phase 2 | package.json test:integration | dropped `--passWithNoTests` now that `health.int.test.ts` exists; vitest.config.ts loads `.env` via process.loadEnvFile so local integration runs see DATABASE_URL.
- Phase 2 | AC-ERROR-2 test | `health.int.test.ts` simulates the outage with a pool pointed at a closed port (503 in under 3 s); the real `docker compose stop postgres` / start recovery was verified manually (503 in 267 ms, 200 again without restarting the api).
- Phase 2 | build pipeline | phase implemented directly by the orchestrator (no separate TDD sub-agent dispatch) to save context; tests written alongside code; verifier and code-review agents still dispatched.
- Phase 2 | carried advisories | A1 (child-binding redaction via wrapped `child`, since pino resets the bindings formatter for children), A2 (DSN/URL keys, userinfo in any string, set-cookie, x-api-key, proxy-authorization, res headers, Buffers/typed arrays), A4 (URL validation) done with tests; @fastify/swagger kept because the generated OpenAPI uses it; checkDb TODO replaced by the real pool check. A3 (optional HOST) still open, low priority.
- Phase 2 | review (CHANGES_REQUIRED then fixed) | blocking ReDoS in URL_USERINFO regex bounded + timing test; `err` serializer now redacted; compose ports bound to 127.0.0.1. Open advisories: pin CI actions/actionlint tag, query-string secret masking in req.url, CI postgres cannot take `-c timezone=UTC` (pool forces UTC), vitest.config loadEnvFile also affects unit project.
- Phase 2 | process | TDD sub-agent not dispatched; no RED→GREEN evidence. The reviewer confirmed the tests cover the ACs (health.int.test.ts:34-72). Accepted; Phase 3+ must dispatch the TDD sub-agent.
- Phase 2 | apps/web/e2e/smoke.spec.ts | The Tailwind-class and "API: ok" checks are in Playwright, which `pnpm run ci` doesn't run. The "API: unavailable" state and the AC-ERROR-2 recovery without an API restart were verified manually only (phase review, accepted).
- Phase 2 | .github/workflows/ci.yml | Actions are tag-pinned, not SHA-pinned; `rhysd/actionlint:latest` isn't reproducible; the postgres:17 service has no `-c timezone=UTC` (the pool forces UTC per connection). Advisory.
- Phase 3 | push | local-only run; nothing pushed.
- Phase 3 | AC-VERIFY-5 dumps | identical-dump check compares a catalog snapshot always, plus the server's pg_dump via `docker compose exec` only when compose postgres is reachable (CI service container has no matching pg_dump client).
- Phase 3 | test isolation | one cloned DB per test file from template `sgm_tpl_<runId>` (stronger than one per worker); concurrency tests get their own DB.
- Phase 3 | payments.gst_amount/subtotal_amount | NOT NULL GENERATED STORED, typed read-only in codegen rather than GeneratedAlways.
- Phase 3 | extra constraints | owner-column NOT NULLs, audit timestamps, team_members_auto_enroll_assigned, credit_transactions amount<>0 and balance 0-100, registration_guests move guard, billing_type in payment immutability set; all in db/schema-deviations.md (D-01..D-26).
- Phase 3 | brands | MoneyString/LocalDate/LocalTime live as brand-only types in packages/shared/src/types/brands.ts; Phase 4 must re-export them. Ciphertext brand override for encrypted columns deferred to Phase 4.
- Phase 3 | docker-compose.yml api command | `db migrate &&` restored (Phase 2 deviation closed); `pnpm run ci` fully green (Phase 1 stub deviation closed). Running api container not recreated.
- Phase 3 | review APPROVED, advisories | A1 no production guard on `db rollback`; A2 reset host check bypass via `?host=` and `postgres` hostname; A3 MIGRATIONS_DIR unvalidated; A4 invoice_number can be set directly NULL->n and assign_invoice_number does not require PAID (tax-invoices feature to enforce); A5 sessions must be inserted DRAFT then published after courts; A6 template DB leaks if migrate fails in global-setup, no stale sweeper; A7 template1 lock-key mismatch flake; A8 dev-only esbuild advisory via tsup.
- Phase 3 | documentation agent | not dispatched; techContext/systemPatterns not updated this phase (deferred to Phase 6 docs).
- Phase 3 | apps/api/test/integration/schema.int.test.ts:52-66 | The AC-VERIFY-5 identical-dump check always compares a catalog snapshot, and runs `pg_dump --schema-only` only when compose postgres is reachable (phase review, accepted).
- Phase 3 | db/migrations/…payments_and_invoicing.sql:136-159 | `assign_invoice_number` doesn't require PAID, and invoice_number can be set directly from NULL; tax-invoices-and-exports must enforce both (hand-off, accepted).
- Phase 3 | db/migrations/…game_sessions_and_courts.sql | Sessions must be inserted as DRAFT and published after their courts, because the starts_at/ends_at triggers need the courts (hand-off to session-scheduling-engine).
- Phase 4 | push | local-only run; nothing pushed.
- Phase 4 | TDD | RED: 5 unit files failed on missing modules (40 tests defined) plus 2 integration files (8 tests); GREEN: unit 80/80, integration 50/50; coverage money/time/crypto 94-100% (overall lines 99.4%); review APPROVED (0 blocking, 7 advisory).
- Phase 4 | packages/shared/package.json | exports map extended (./money, ./money/zod, ./time, ./time/dst-vectors, ./invoice); dst-vectors.ts is a test fixture exposed through the exports map for the apps/api parity test.
- Phase 4 | error codes | divideByInteger: INVALID_RATIO for negative divisor, DIVISION_BY_ZERO for zero; TimeValidationError INVALID_INSTANT for non-integer hours/days; isMoneyString('-0.00') true (design regex verbatim), parseMoney gives 0.
- Phase 4 | eslint.config.mjs | added money no-restricted-syntax guard (Identifier args only; Math.round(row.amount) evades it) and a time/** ban on local-zone Date accessors.
- Phase 4 | codegen | Ciphertext | null override for the 4 encrypted teams columns; regenerated against scratch DB sgm_codegen_tmp (dropped); drift test green.
- Phase 4 | review advisories | A1 AAD delimiter ambiguity for '.'/':' in table/column; A2 non-canonical base64url accepted; A3 moneyFromCents lacks runtime bigint guard; A4 addHours overflow gives Invalid Date; A5 T24:00:00Z accepted; A6 ms lost in sameWallClockDaysBefore; A7 lint selectors Identifier-only.
- Phase 4 | documentation agent | not dispatched; techContext/systemPatterns deferred to Phase 6.
- Phase 4 | apps/api/src/lib/crypto/crypto.ts:55 | The AAD `sgm:v1:<table>.<column>:<rowId>` has delimiter ambiguity if an identifier contains '.' or ':'. Identifiers are code constants and the copy-to-another-row/column test passes. Hardening (length-prefix or validate) deferred (phase review, accepted).
- Phase 4 | eslint.config.mjs | The money and time lint selectors match Identifier arguments only, so `Math.round(row.amount)` evades them. Hardening gap; the type brand still guards (phase review, accepted).
- Phase 5 | push | local-only run; nothing pushed.
- Phase 5 | 02:00-02:59 rule vs `post-game-billing` `*/5 * * * *` | the sweep necessarily fires in hour 02; kept as specified with an `intervalSweep` flag exempting only that idempotent slot; the two daily slots are guarded (tested). Spec owner may prefer `*/5 0-1,3-23 * * *`.
- Phase 5 | pg-boss 12.35 facts | `singletonKey` dedupes only on `exclusive`-policy queues; crash recovery needs both superviseIntervalSeconds and monitorIntervalSeconds (set together from JOBS_SUPERVISE_INTERVAL_SECONDS); backoff = retryDelay * 2^(n+1)/2 * (1+rand). Permanent/config notifier errors fail the job with zero retries via NonRetryableJobError -> deadletter disposition.
- Phase 5 | env knobs | JOBS_EXPIRE_SECONDS_OVERRIDE, JOBS_SUPERVISE_INTERVAL_SECONDS, JOBS_POLL_INTERVAL_SECONDS added to config and .env.example.
- Phase 5 | tracing | (superseded by final-review remediation: OTel now wired) no OTel API dependency yet; trace context carried in `_meta.traceparent` via AsyncLocalStorage helpers in jobs.ts.
- Phase 5 | cron-parser | not imported directly; DST fire times asserted through the runner's `previewSchedule` (pg-boss's cron-parser wrapper).
- Phase 5 | notifier | subject/recipient validation failures throw PermanentDeliveryError (providerCode invalid_message); queue named `send-email`.
- Phase 5 | logger | carried Phase 2 advisory done: query-string secret masking in req.url (+2 tests).
- Phase 5 | env clock skew | postgres container clock ~7-8 s behind host; tests use performance.now() and DB-clock startAfter. Recovery after SIGKILL measured 9-13 s (limit 30 s).
- Phase 5 | coverage | lib/jobs + lib/notifications covered by unit tests (overall 99% lines/93% branches); src/jobs/* outside coverage include.
- Phase 5 | review APPROVED, advisories | A1 nodemailer disableFileAccess/disableUrlAccess + html string check; A2 validate raw (untrimmed) address; A3 intervalSweep flag could exempt any cron; A4 non-notification error text unredacted in job output; A5 no production guard on JOBS_EXPIRE_SECONDS_OVERRIDE; A6 payload casts/zod parse in send-email; A8 SIGTERM during startup; A9 PII in pgboss.job.data for 7 days (document in Phase 6); A11 friendlier bad-JSON error in `jobs trigger`.
- Phase 5 | RED evidence | 5 new unit files failed to load (module missing) + 3 assertion failures (config jobs x2, logger query masking); both integration files failed to load. GREEN: 130 unit, 63 integration, lint/typecheck/build clean.
- Phase 5 | apps/api/src/jobs/schedules.ts:29-31 | The `intervalSweep` flag exempts post-game-billing (`*/5 * * * *`) from the 02:00–02:59 no-fire rule, since a fixed interval isn't affected by DST. The daily slots are still guarded. The alternative `*/5 0-1,3-23 * * *` is left to the spec owner (phase review, accepted).
- Phase 5 | apps/api/src/jobs/send-email.ts, lib/jobs/jobs.ts:404 | Permanent and configuration notifier errors fail the job with 0 retries (NonRetryableJobError). Transient errors retry per AC-ERROR-3. This is a literal-reading departure from AC-ERROR-6's "is retried" (phase review, accepted).
- Phase 5 | apps/api/test/integration/jobs.int.test.ts:352 | The unreachable-SMTP case is asserted on a direct `send` only; the job-wrapped failure uses the memory adapter (phase review, accepted).
- Phase 5 | pgboss.job.data | Job payloads may carry PII (email addresses) for pg-boss's 7-day retention. Document this in Phase 6 (hand-off).
- Phase 6 | push | local-only run; nothing pushed.
- Phase 6 | git worktree | the worktree had been on a detached HEAD since Phase 4, so `feature/platform-foundation` still pointed at 169e868 while Phases 4-6 were committed on the detached head. Fixed by fast-forwarding the branch to HEAD (`git checkout -B`); the branch now carries every phase commit.
- Phase 6 | docker-compose.yml / docs | a stale local `sgm-api:dev` image (Phase 2, with the `db migrate` stub) made plain `docker compose up -d --wait` fail on the fresh clone; compose does not rebuild an existing image. getting-started now says to use `--build` after pulling changes. With `--build` (layers partly cached) up took 106.7 s; a plain cached `up` took 17.2 s.
- Phase 6 | AC-VERIFY-2 wording | the AC says `docker compose up -d --wait`; on a machine with no image it builds first (uncached build time not measured; the 120 s budget is stated for cached images).
- Phase 6 | documentation agent | Haiku agent dispatched; it produced inaccuracies (static export, per-test transactions, a telemetry dir, custom metrics) that were corrected by hand, and it later overwrote systemPatterns.md with a second version after the commit; that version was discarded in favour of the verified committed one.
- Phase 6 | metrics | only METRICS_* config variables exist; no Prometheus exporter or custom metrics are implemented (techContext states this).
- Phase 6 | fresh-clone verification | clone of feature/platform-foundation at d384995 in the session scratchpad: `pnpm run setup` 4.5 s; compose up healthy; `pnpm run ci` green in 67.6 s: lint 0 errors/0 warnings, typecheck 0 errors, unit 130/130 (16 files), integration 63/63 (13 files), build ok; coverage lines 99.41%, statements 99.28%, branches 93.69%, functions 99.32%. Postgres reports 17.x and timezone UTC. The clone's containers were stopped afterwards (the compose project name `sgm` and its `pgdata` volume are shared with the main worktree; the volume was kept).
- Phase 6 | curl checks | `curl` of /health and :3000 was blocked by the sandbox in the verification shell; health and web are covered by compose healthchecks (which call /health) and by health.int.test.ts.
- Phase 6 | docs/adr/0005, 0006, 0008, 0010, 0012 | These ADRs name the chosen option without listing the alternatives. The alternatives are in the linked creative docs (phase review, accepted).
- Phase 6 | memory-bank/techContext.md (Unit Testing Specifics) | RESOLVED 2026-09-30. The text overstated some test facts: "fresh Node process per test" and "exit on first failure" aren't configured, and test:e2e needs the compose stack rather than `dev`. Minor, to fix in a later pass (phase review, accepted).
- Final review | Important (remediated, spec owner approved 2026-09-29; commit 'fix(platform-foundation): final-review remediation') | I1 FIXED: @sgm/api `dev` now runs dev:api and dev:worker in parallel (test in scripts/root-targets.test.ts; getting-started updated). I2 FIXED: OTel NodeTracerProvider + @fastify/otel in api/worker (no-op unless OTEL_EXPORTER_OTLP_ENDPOINT/console), traceId/spanId in logs, web api-client sends traceparent, job _meta.traceparent restored as worker span parent; techContext made accurate. Remaining: pg/http client spans not wired; buffered OTLP spans not flushed on SIGTERM; web has no SDK. I3 FIXED: nodemailer disableFileAccess/disableUrlAccess, html type check, zod strict send-email payload (NonRetryableJobError). I4 FIXED: `db rollback` refused under NODE_ENV=production; `db reset` host check now covers ?host= (closes Phase 3 A2).
- Final review | Minor (remediation) | fixed: api/web compose ports bound to 127.0.0.1; vitest comment and coverage include (logger, telemetry). Still deferred: credit_transactions append-only; snake_case-only redaction keys; lib/db coverage; SMTP error text in job.output; reviewer nits (logger mixin bindings() cost, send-email JSDoc order, duplicated traceparent regex, SIGTERM flush); res.statusCode null in request-completed log.

### AC Walk (32 ACs, 2026-09-29, after Phase 6)
- AC-VERIFY-1 met (layout, root targets, techContext Component Structure lists the directories)
- AC-VERIFY-2 met-with-deviation (Phase 2/6 ledger: Playwright checks outside `ci`; --build note)
- AC-VERIFY-3 met (Phase 1 violation checks)
- AC-VERIFY-4 open until push is re-enabled (actionlint clean, local ci green; no real Actions run)
- AC-VERIFY-5 met-with-deviation (Phase 3: pg_dump compared only when compose postgres is reachable; catalog snapshot always)
- AC-VERIFY-6 met
- AC-VERIFY-7 met
- AC-VERIFY-8 met
- AC-VERIFY-9 met (advisory: assign_invoice_number does not require PAID; hand-off to tax-invoices-and-exports)
- AC-VERIFY-10 met
- AC-VERIFY-11 met
- AC-VERIFY-12 met
- AC-VERIFY-13 met (advisory: AAD delimiter ambiguity, Phase 4)
- AC-VERIFY-14 met (advisory: lint guard matches Identifier arguments only)
- AC-VERIFY-15 met
- AC-VERIFY-16 met
- AC-VERIFY-17 met
- AC-VERIFY-18 met (ADRs 0001-0012, techContext, systemPatterns, getting-started)
- AC-VERIFY-19 met
- AC-INTEGRATION-1 met (D-01..D-26 in db/schema-deviations.md)
- AC-INTEGRATION-2 met
- AC-INTEGRATION-3 met
- AC-INTEGRATION-4 met-with-deviation (Phase 2: Tailwind and "API: ok" checks in Playwright, outside `ci`)
- AC-ASYNC-1 met
- AC-ASYNC-2 met-with-deviation (Phase 5: `intervalSweep` exemption for post-game-billing in hour 02)
- AC-ASYNC-3 met (recovery after SIGKILL measured 9-13 s)
- AC-ERROR-1 met
- AC-ERROR-2 met-with-deviation (Phase 2: outage simulated with a closed-port pool; real stop/start verified manually)
- AC-ERROR-3 met
- AC-ERROR-4 met
- AC-ERROR-5 met
- AC-ERROR-6 met-with-deviation (Phase 5: permanent and configuration errors fail with 0 retries; job-wrapped unreachable-SMTP asserted with the memory adapter)

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
- 2026-09-29 Step 4.5: Codex adversarial critique — needs-attention, 5 findings (1 critical, 3 high, 1 medium)
- 2026-09-29 Critique disposition (spec owner): all 5 findings applied; `fee_other` rate added for BY_SEX; AC wording changes from the design agents applied. Taxonomy CLEAN, 32 ACs (29 MUST / 3 SHOULD); target ~86 tests
- 2026-09-29 Phase 1 build: COMPLETE - 36 unit tests (RED->GREEN), lint/typecheck/build/ci green, review APPROVED, AC-VERIFY-3 violation checks and AC-ERROR-1 exit check verified. Push skipped (local-only run).
- 2026-09-29 Phase 2 build: COMPLETE - compose stack healthy in 17 s (cached), /health 200/503/200 verified, web shows live API status and Tailwind CSS, Playwright smoke green, actionlint clean, local ci green. Push skipped (local-only run).
- 2026-09-29 Phase 3 build: COMPLETE - TDD RED 38 failing -> GREEN 38/38; integration 42/42, unit 40/40, ci green; review APPROVED (0 blocking, 8 advisory). Push skipped (local-only run).
- 2026-09-29 Phase 4 build: COMPLETE - TDD RED (5 unit + 2 int files failed on missing modules) -> GREEN unit 80/80, integration 50/50; coverage 94-100%; lint/typecheck/build green; review APPROVED (0 blocking, 7 advisory). Push skipped (local-only run).
- 2026-09-29 Phase 6 build: COMPLETE - getting-started, ADRs 0001-0012, techContext/systemPatterns; fresh-clone setup -> compose up -> ci green (130 unit, 63 integration, coverage 99.4% lines). Push skipped (local-only run). BUILD_COMPLETE.
- 2026-09-29 Final-review remediation: COMPLETE - I1-I4 fixed via TDD (20 new tests RED->GREEN), code review APPROVED (0 blocking), pnpm audit --prod clean. Push skipped (local-only run).
- 2026-09-29 Remediation review: PROCEED (I1–I4 fixed and tested, commit 5ddac39); independent `pnpm run ci` green (unit 150/150, integration 63/63)
- 2026-09-29 Reflection Agent: COMPLETE - Output: memory-bank/reflection/platform-foundation-reflection.md (Task Quality: Good; Ecosystem: Moderately Effective)
- 2026-09-30 Doc fixes from reflection: techContext Development Commands + Unit Testing Specifics corrected; systemPatterns checked (no residue of the discarded doc-agent version); Observability already accurate; AC-ERROR-6, AC-ASYNC-2, AC-VERIFY-2 amended with dated notes (original text kept)
