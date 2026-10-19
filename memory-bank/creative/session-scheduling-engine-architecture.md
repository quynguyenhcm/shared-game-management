# Architecture Decision: Session Scheduling Engine (materialiser, concurrency, allocator port, lifecycle)

**Created**: 2026-10-20
**Status**: DECIDED
**Decision Type**: Architecture
**Task**: `session-scheduling-engine` (Level 4). **ADR**: 0019. **Ledger**: D-70 onwards.
**Resolves**: Creative questions B1 to B5 and contract conflicts 1, 4, 8 and 9 in `memory-bank/tasks/session-scheduling-engine.md`. Conflict 2 (`autoEnrolInSession` input shape) is confirmed here because the port signature depends on it.
**Siblings (in parallel)**: Algorithm (`session-scheduling-engine-recurrence-algorithm.md`: A1 to A5, conflicts 5, 6, 10) and User Journey (`session-scheduling-engine-admin-user-journey.md`: C2, C3, conflict 3). Where this document needs one of their rulings it designs for every plausible option and lists the assumption under "Hand-offs / assumptions to reconcile".

**Inputs read**: ADR 0004, 0013, 0015, 0016, 0017; `platform-foundation-architecture.md`, `team-banking-and-gst-banking-architecture.md` (Q4 recurrence contract), `skill-levels-and-auto-enroll-seams-architecture.md`; `apps/api/src/app.ts`, `apps/api/src/worker.ts`, `apps/api/src/jobs/{registry,schedules,bootstrap,member-banned,skill-progression,send-email}.ts`, `apps/api/src/lib/jobs/jobs.ts`, `apps/api/src/modules/team-banking/publish-gate.ts`, `apps/api/src/modules/skill-levels/auto-enrol.ts`, `apps/api/src/modules/teams/{transitions,admin-lock,ban-hook}.ts`; migrations `20260929000500000`, `20260929000600000`, `20261013000100000`, `20261016000100000`; `db/schema-deviations.md`; `apps/api/test/{helpers/factories.ts,fixtures/paid-session-matrix.ts,integration/team-banking-gate.int.test.ts}`; registration-and-waitlist branch: `registration-and-waitlist-allocator-architecture.md` (Q2, Q6, C-SSE-1..5, C-SAE-1..2, C-ALL-1) and task file R14 to R18; pg-boss 12.35 queue policy docs (`stately`, `exclusive`); learned rules `job-queues-pgboss`, `api-write-idempotency`, `db-derived-flags-and-gates`, `logging-redaction-global`, `testing-injected-clock`, `testing-integration-db-isolation`.

---

## Decision summary (one line each)

| # | Question | **Chosen** |
|---|---|---|
| SA-1 | B1 + conflict 4: materialiser shape and queueing | Fan-out. The daily sweep on `recurrence-materialisation` (`exclusive`, 03:00, plus once at worker boot and on demand) enqueues one job per active rule on a **new `recurrence-rule` queue with the `stately` policy**, keyed `recurrence-rule:<ruleId>`. Rule create, edit and end enqueue the same per-rule job in their own transaction. Each instance gets its own transaction. Each job reads the clock once, for its window. |
| SA-2 | B2: lock order and serialisation | `teams → recurring_session_rules → team_members → game_sessions → registrations → registration_guests → payments`. Rule writers and the materialiser's instance transaction lock the rule row `FOR NO KEY UPDATE`. Instance edits, publish, cancel and the allocator never lock rules. |
| SA-3 | B2: where auto-enrol runs | **Always in a follow-up transaction** that holds no rule or session lock: inline in the materialiser right after the instance commits, and through a new `session-auto-enrol` job for API publishes and reconciliation. The materialiser never auto-enrols inside the insert transaction. |
| SA-4 | B3 + conflicts 1, 2: allocator port | `SessionAllocatorPort { name, enrols, promoteWaitlist, autoEnrolInSession(entries: {userId, assignedAt}[]) }` (R16 shape confirmed). The no-op default has `enrols: false`. One composition function, `createSessionAllocator()` in `apps/api/src/session-allocator.ts`, is called by both `main.ts` and `worker.ts`, and the port is a **required** dependency of `buildApp` and `registerJobs`. |
| SA-5 | Conflict 1: auto-enrol rollout gap | **(c) A per-session marker.** `game_sessions.auto_enrol_required` and `auto_enrolled_at`. The marker is stamped only when a real allocator (`enrols: true`) ran. The sweep re-offers every pending future PUBLISHED session daily and at worker boot, so registration's deploy enrols the backlog within seconds, with no backfill script and no env flag. |
| SA-6 | B4: optimistic concurrency and replay | Integer `version` columns on `game_sessions` and `recurring_session_rules`, bumped by a DB trigger on any content change. **Every** admin write (edit, publish, cancel, end) carries `expectedVersion`. A save that changes nothing is a 200 no-op. `create_key uuid` with `UNIQUE (team_id, create_key)` on both tables makes creates replay-safe. |
| SA-7 | B5 + conflict 8: lifecycle triggers | `game_sessions_guard_update` (transition matrix, closed-row immutability, immutable `team_id` and rule-instance `date`) and `session_courts_guard_closed` (no court writes on COMPLETED or CANCELLED rows). The TS twin is `modules/sessions/transitions.ts`, checked against the hand-written fixture `test/fixtures/session-transitions.ts`. COMPLETED belongs to billing. Cancel and every edit are allowed only before `starts_at` (enforced in TS: time-relative rules stay out of SQL, per ADR 0017 point 1). |
| SA-8 | Conflict 9: schema gaps | One reversible migration with rule anchor `starts_on`, a `recurring_rule_courts` template table, version and `updated_at` stamps, `create_key`, `deadline_is_default` with a DB-maintained default deadline, C-SSE-1 CHECKs, `UNIQUE (session_id, court_identifier)`, length and amount CHECKs, the auto-enrol marker, the payout-notice claim and materialisation bookkeeping. Ledger D-70 to D-83. |
| SA-9 | Series-edit execution | Synchronous, in **one** series-edit transaction (rule lock, then each affected instance in `(date, id)` order), bounded by the horizon. Valid for every A3 option. Not-yet-materialised dates go to the per-rule job. |
| SA-10 | Gate-before-lock proof | A runtime query-order recorder test (Kysely `log` hook) on every publish path asserts that the gate's `SELECT is_payout_configured ... FOR KEY SHARE` comes before the first `game_sessions` lock or write. Plus a post-lock version re-check, so the fees that were gated are the fees that get published. |

---

## Context

### System Requirements
- Admins create one-off sessions and recurring series with multi-court times, costing and three pricing models. They edit single instances without breaking the series, publish through ADR 0016's gate, and cancel (spec AC-HAPPY-1..11).
- A background materialiser turns series into instances exactly once per `(rule, date)`. It inserts DRAFT plus courts, then publishes when the gate allows, and saves a DRAFT otherwise. It sends at most one admin email per rule per window, retries materialiser drafts later, and auto-enrols members through the allocator (AC-ASYNC-1..4, ADR 0016 recurrence contract 1 to 6, ADR 0017 C-SKL-1).
- Capacity raises on PUBLISHED sessions call `promoteWaitlist` under the session lock in the same transaction (C-SSE-3, C-SSE-5). Cancels leave registrations alone (C-SSE-4).
- The lifecycle matrix and closed-row immutability hold for every writer, including raw SQL (AC-ERROR-6, AC-VERIFY-1, C-GAME-1 point 3).
- Stale saves are refused (AC-ERROR-7), and creates are replay-safe (`createKey`).
- The registration allocator is injected later, through a seam this feature owns (conflict 1).

### Technical Constraints
- PostgreSQL 17, READ COMMITTED, Kysely 0.29, pg-boss 12.35 (queue policies `standard | short | singleton | stately | exclusive`). `singletonKey` dedupes only queued or active jobs, so every handler needs a durable guard (job-queues-pgboss rule).
- The API process is a pg-boss producer only. The worker schedules and works the queues. The cron slot `recurrence-materialisation` (`0 3 * * *` Pacific/Auckland, `exclusive`) already exists with a placeholder handler.
- Existing triggers on `game_sessions`, in firing order (PostgreSQL fires same-event BEFORE triggers in name order): `game_sessions_derive_instants` (D-08) and `game_sessions_paid_requires_payout` (D-49). `session_courts_touch_session` makes every court write `UPDATE` its session row, so a court write always locks the session row.
- ADR 0016: call the gate inside the transaction, before any `game_sessions` lock. It takes `teams FOR KEY SHARE`. Never take `teams FOR UPDATE`, and never take a `teams` lock after a session lock.
- ADR 0017 C-SKL-1 point 5: auto-enrol for a session that already exists runs in a follow-up transaction that has not locked it.
- Registration's allocator takes the caller's transaction. It gates members (`team_members FOR SHARE`, R16 re-check) **before** it locks the session (`FOR UPDATE`, D-14). It sets `lock_timeout` only on its own transactions, never on a caller's.
- The project avoids `now()` in SQL rules (ADR 0017 point 1). Clocks are injected, and lock-then-decide paths read the clock after the lock (testing-injected-clock rule).
- Nothing on `main` writes `game_sessions`, `session_courts` or `recurring_session_rules` yet. Only tests and dev seeds hold rows. Many integration tests insert and publish sessions with raw SQL through `insertSession` (28 raw status writes, including DRAFT → COMPLETED).

### Non-Functional Requirements
- P1: every invariant is in the DB. TS only shapes the error.
- P5: rule-create enqueue and admin emails go in the domain transaction.
- P7: horizon (and lead time, if Algorithm adds one) comes from env, validated with zod.
- C-SSE-5: the session lock is held only for an edit's own statements. Registration uses a 2 s HTTP and 5 s job lock timeout.
- Instances are visible about 5 s after a rule is created (one 2 s poll plus the run). The daily run is at 03:00.
- No `40P01` anywhere in the race matrix (AC-VERIFY-3).
- Coverage ≥ 80% on `apps/api/src/modules/sessions/**` and `packages/shared/src/sessions/**`.
- Logs carry ids only, error codes as `errorCode`, never `code` (logging-redaction-global rule).

### Existing patterns that must be respected
- Module shape `modules/<feature>/{routes,service,repo}.ts`, registered in `buildApp`. Other modules are reached only through their public files: `team-banking/publish-gate.ts`, `skill-levels/auto-enrol.ts`, `teams/admin-lock.ts`.
- Ports with a safe default (ADR 0015 `MemberBannedHandler`), injected in code, never by an env var.
- Transition table as a pure TS function plus a DB trigger, aligned by a hand-written matrix fixture (ADR 0015, `teams/transitions.ts`).
- Durable "claim under lock" for idempotency (D-46 create key, D-54 change keys).
- Sweep plus one job per unit with a `singletonKey` (ADR 0004 post-game billing).

---

## Component Analysis

### Core Components

| Component | Purpose | Responsibilities |
|---|---|---|
| `packages/shared/src/sessions/recurrence.ts` (Algorithm owns semantics) | Pure date generation | `recurrenceDates(rule, window) → LocalDate[]`; no clock, no DB |
| `packages/shared/src/sessions/costing.ts` | Pure costing | `suggestedRate`, `finalFlatRate`, `defaultFeeOther` (Money only) |
| `packages/shared/src/sessions/lifecycle.ts` | Shared status table | `SESSION_TRANSITIONS` (allowed `from → to`), `isTerminal`; used by the API twin and by the web read-only logic |
| `packages/shared/src/api/sessions.ts` | Wire contracts | Strict zod requests and responses (with `version`, `createKey`, `expectedVersion`), error codes |
| `apps/api/src/modules/sessions/routes.ts` | HTTP surface | TEAM_ADMIN policies on every route, team-scoped params, maps service results |
| `apps/api/src/modules/sessions/service.ts` | One-off and instance use cases | create, update, publish, cancel, list, get; capacity raise → `promoteWaitlist` |
| `apps/api/src/modules/sessions/series.ts` | Series use cases | create, update (with synchronous propagation, SA-9), end; enqueues the per-rule job |
| `apps/api/src/modules/sessions/materialise.ts` | Per-rule run | `materialiseRule(deps, { ruleId, teamId, runNow })`: window, missing dates → instance transactions, draft retry, inline auto-enrol follow-ups, bookkeeping |
| `apps/api/src/modules/sessions/auto-enrol.ts` | Auto-enrol follow-up | `runSessionAutoEnrol(deps, { teamId, sessionId })`: selection (`selectAutoEnrollees`), port call, marker stamp |
| `apps/api/src/modules/sessions/allocator-port.ts` | Seam toward registration | `SessionAllocatorPort` types, `noopSessionAllocator` |
| `apps/api/src/modules/sessions/locks.ts` | Lock prologue helpers | `lockTeamKeyShare`, `assertSessionAdmin` (actor re-check `team_members FOR SHARE`), `lockRule`, `lockSession`; documents the canonical order |
| `apps/api/src/modules/sessions/tx.ts` | Transaction policy | `runSessionTransaction(db, policy, fn)`: `SET LOCAL lock_timeout`, whole-transaction retry on `40P01`/`55P03` |
| `apps/api/src/modules/sessions/transitions.ts` | TS twin of the DB matrix | `decideSessionAction(action, state, now)` → next state or refusal code |
| `apps/api/src/modules/sessions/repo.ts` | Kysely queries | All `game_sessions`, `session_courts`, `recurring_session_rules`, `recurring_rule_courts` reads and writes |
| `apps/api/src/modules/sessions/errors.ts` | DB error mapping | `mapSessionDbError` by SQLSTATE plus `err.constraint`, never by message |
| `apps/api/src/jobs/recurrence-materialisation.ts` | Sweep handler | Enqueues `recurrence-rule` per active rule and `session-auto-enrol` per pending session |
| `apps/api/src/jobs/recurrence-rule.ts` | Per-rule handler | Validates the payload, calls `materialiseRule`, classifies failures |
| `apps/api/src/jobs/session-auto-enrol.ts` | Per-session handler | Validates the payload, calls `runSessionAutoEnrol` |
| `apps/api/src/session-allocator.ts` | Composition root for the port | `createSessionAllocator(deps)`. Returns the no-op now; registration-and-waitlist edits this one function |
| DB migration `20261020000100000_session_scheduling.sql` | Invariants | Triggers, CHECKs, columns and tables of SA-8 |

### Component Interactions

```
                          ┌──────────────── apps/web (Sessions area, TEAM_ADMIN) ───────────────┐
                          └───────────────────────────────┬─────────────────────────────────────┘
                                                          │ REST (bearer), expectedVersion / createKey
┌──────────────────────────────── apps/api HTTP (producer) ▼───────────────────────────────────────────┐
│ sessions/routes ─► sessions/service ─┬─► team-banking/publish-gate (KEY SHARE on teams)              │
│                  └► sessions/series  ├─► teams/admin-lock.lockTeamRow                                │
│                                      ├─► sessions/repo ─► game_sessions / session_courts / rules     │
│                                      ├─► SessionAllocatorPort.promoteWaitlist (capacity raise, in tx)│
│                                      └─► enqueue (in tx): recurrence-rule, session-auto-enrol        │
└───────────────────────────────────────────────────────────────────────────────────────────────────────┘
                     │ pgboss.job (same DB, same transaction as the domain write)
┌───────────────────── apps/api worker ▼───────────────────────────────────────────────────────────────┐
│ cron 03:00 / boot / CLI ─► recurrence-materialisation (exclusive) ── sweep: keyset over rules          │
│                                │ enqueue per rule                 │ enqueue per pending session        │
│                                ▼                                  ▼                                    │
│                  recurrence-rule (stately, key per rule)   session-auto-enrol (exclusive, key per sess)│
│                                │                                  │                                    │
│                                ▼                                  ▼                                    │
│        sessions/materialise ─► per-instance tx ──commit──► sessions/auto-enrol (follow-up tx)          │
│                 │  gate, rule lock, insert DRAFT+courts,          │ selectAutoEnrollees (no locks)       │
│                 │  publish | DRAFT + notice email                 └► SessionAllocatorPort.autoEnrolInSession
│                 └► send-email (in tx)                                      (registration's allocator later)
└───────────────────────────────────────────────────────────────────────────────────────────────────────┘
```

Dependency direction: `sessions → team-banking/publish-gate.ts`, `sessions → skill-levels/auto-enrol.ts`, `sessions → teams/admin-lock.ts`. Nothing imports `sessions/` except `app.ts`, `jobs/*`, `session-allocator.ts` and, later, registration's adapter. Registration may import only `sessions/allocator-port.ts` (types). A `sessions/boundaries.test.ts` enforces this, like `skill-levels/boundaries.test.ts`.

---

## Options Explored

### Q1 (B1 + conflict 4): Materialiser shape and queueing

The trap in the spec default: on an `exclusive` queue, a second job with the **same** (or no) `singletonKey` while one is queued or active is not queued behind it. `send` returns `null` and the job is dropped. A per-rule run enqueued on the sweep's queue with no key while the 03:00 sweep is active would be lost, and the new series would show nothing until the next morning.

#### Option 1A: One `exclusive` queue. The per-rule run is the same job with a `{ ruleId }` payload and no key
- **Description**: The spec default. The handler either sweeps or does one rule.
- **Pros**: no new queue.
- **Cons**: a rule created during an active or queued sweep is dropped (`send` → `null`). Two rule creates in a row: the second is dropped while the first is queued. Violates the "within about 5 s" criterion.
- **Technical Fit**: Medium. **Complexity**: Low. **Scalability**: Low.

#### Option 1B: Same `exclusive` queue, per-rule jobs keyed `recurrence-rule:<ruleId>`
- **Description**: The sweep has no key. Per-rule jobs have their own key, so they no longer collide with the sweep.
- **Pros**: no new queue. The sweep and per-rule runs coexist.
- **Cons**: an edit that commits while that rule's job is **active** is dropped (`exclusive` = one queued *or* active per key). The run in progress may have read the old rule, so the edit's new dates wait until 03:00. The sweep still does all rules inline in one long job: one failing rule makes the whole sweep retry, and duration grows with the number of rules against the 900 s expiry.
- **Technical Fit**: Medium. **Complexity**: Low. **Scalability**: Medium.

#### Option 1C: Inline sweep plus a separate per-rule queue
- **Description**: The sweep processes every rule itself. A separate queue handles rule create and edit.
- **Pros**: per-rule runs never collide with the sweep.
- **Cons**: two code paths into the same per-rule logic, with different failure semantics. The sweep is still one long job: expiry risk, retry of everything, and no per-rule backoff.
- **Technical Fit**: Medium. **Complexity**: Medium. **Scalability**: Medium.

#### Option 1D: Fan-out sweep plus a `stately` per-rule queue (**chosen**)
- **Description**: The cron sweep only enumerates active rules (keyset pages of 500) and enqueues one `recurrence-rule` job per rule. Every per-rule run, whether from the sweep, a rule create, edit or end, or the CLI, goes through that one queue and one handler. `stately` allows **one queued and one active job per key**. An edit during an active run queues exactly one trailing run, which reads the latest rule. Further edits collapse into that queued job. The sweep also enqueues `session-auto-enrol` for every pending session (SA-5).
- **Architecture Diagram**:
  ```
  cron 03:00 ─┐
  worker boot ┼─► recurrence-materialisation (exclusive, no key) ─► SELECT active rules (keyset 500)
  CLI trigger ┘                                                     ├─► enqueue recurrence-rule {ruleId}  key recurrence-rule:<ruleId>
                                                                    └─► enqueue session-auto-enrol {sessionId} for pending sessions
  POST/PUT session-series, POST .../end ──(same tx)──────────────────► enqueue recurrence-rule {ruleId}
  recurrence-rule (stately: ≤1 queued + ≤1 active per rule) ─► materialiseRule ─► per-instance tx ─► inline auto-enrol follow-up
  ```
- **Pros**:
  - No dropped runs: the trailing-run semantics are exactly "debounce with a final run".
  - Mirrors ADR 0004's billing design (a sweep enqueues one keyed job per unit).
  - One failing rule retries alone, with backoff.
  - Each job is small and bounded. Worst case is about 13 instances × (an instance transaction plus a follow-up), far below the 900 s expiry. The sweep is one query plus N enqueues (about 30 s for 10,000 rules).
  - Per-rule runs never block on, or are blocked by, the sweep.
  - Parallelism is a later knob (`localConcurrency`) with no redesign.
- **Cons**:
  - One more queue in the registry.
  - `stately` has one less-common edge: an active job failing into `retry` while another job with the same key is queued. This is pinned by an integration test (Risk table). The daily sweep reconciles in any case.
  - Instance counts are reported per rule (`run_completed` per job) plus one sweep summary, not one global line (an AC-VERIFY-6 amendment).
- **Technical Fit**: High. **Complexity**: Medium. **Scalability**: High.

**Batching and expiry**: sweep pages of 500 rules (`ORDER BY id`, keyset, no lock). Pending-session pages of 500 (`idx_game_sessions_auto_enrol_pending`). Default expiry is kept (900 s). Every loop checks `context.signal.aborted` between units, as `skill-progression` does: an aborted sweep throws a transient error and is retried, which is idempotent.

**Clock**: each job reads `runNow = clock.now()` **once at start**. That fixes the materialisation window and `windowStart`, the email claim key (SA-8, D-81), for the whole job. Per-instance transactions read `clock.now()` again **after their locks**, for the "not started" guard and for stamps (testing-injected-clock rule: decisions under a lock use the instant of the write). The job never uses the time the rule's transaction committed.

### Q2 (B2): Where `recurring_session_rules` sits, and how rule edits, the materialiser and instance edits serialise

What needs serialising:
- (i) The materialiser must not create an instance from a rule version that an edit has already replaced.
- (ii) A series edit's propagation must see every instance that exists when it decides.
- (iii) An instance edit and a series edit must not both rewrite one instance.
- (iv) Nothing may add an out-of-order edge to the canonical order.

#### Option 2A: Rules after `teams`, before `team_members`; rule lock `FOR NO KEY UPDATE` by rule writers and by the materialiser's instance transaction (**chosen**)
- **Description**: The order is `teams → recurring_session_rules → team_members → game_sessions → …`. The series edit, series end and each materialiser instance transaction take `SELECT … FROM recurring_session_rules WHERE id = $1 FOR NO KEY UPDATE`, so they are mutually exclusive per rule. Foreign-key inserts of instances take `KEY SHARE` on the rule, which is compatible, so nothing else waits. Instance edits, publish, cancel, the allocator and auto-enrol never lock the rule. They serialise on the session row (D-14), which is enough for (iii).
- **Pros**: (i) and (ii) by mutual exclusion. Under READ COMMITTED, the statements after the lock see the other side's committed instances. The rule lock stays out of every hot path (registration, instance edits). No path takes a rule lock after `team_members` or `game_sessions`.
- **Cons**: a series edit waits for an in-flight instance transaction of the same rule (milliseconds; auto-enrol is not inside it, SA-3).
- **Technical Fit**: High. **Complexity**: Low. **Scalability**: High.

#### Option 2B: Rules after `team_members` (`teams → team_members → rules → game_sessions`)
- **Pros**: lets an admin's actor re-check (`team_members FOR SHARE`) come before the rule lock.
- **Cons**: any path that holds a rule lock and later gates members (same-transaction auto-enrol) would invert the order. It constrains future flows for no gain. The actor re-check can follow the rule lock under 2A.
- **Technical Fit**: Medium. **Complexity**: Low. **Scalability**: High.

#### Option 2C: No rule lock; optimistic rule version stamped on instances
- **Description**: The materialiser records `source_rule_version`. A series edit re-scans after commit, or the materialiser aborts when the version moved.
- **Pros**: no new lock-order edge.
- **Cons**: (ii) fails. A materialiser insert that commits after the edit's scan but carries the old version is invisible to the edit, so the edit needs a second pass or a job, and the admin's "updated N sessions" count is wrong. More code for a weaker guarantee.
- **Technical Fit**: Low. **Complexity**: High. **Scalability**: High.

#### Option 2D: A per-team mutex (`teams FOR NO KEY UPDATE`) for all session writes, materialiser included
- **Pros**: one lock covers everything. It is what moderation and banking already use.
- **Cons**: publishes would wait behind moderation and banking saves, which ADR 0016 Context point 3 forbids ("neither rule makes publishing wait on moderation or banking saves"; the gate deliberately uses `KEY SHARE`). The 03:00 run would hold every team's mutex in turn.
- **Technical Fit**: Low. **Complexity**: Low. **Scalability**: Medium.

**Actor re-check (sub-decision)**: the route guard ran outside the transaction. Inside it, `assertSessionAdmin(trx, teamId, actorId)` reads the actor's `team_members` row `FOR SHARE` and requires `status = 'APPROVED' AND role = 'TEAM_ADMIN'` (else 403 `forbidden`). A demotion or ban of that actor (`UPDATE team_members`) conflicts with the share lock, so the two serialise. It takes no `teams` lock beyond `KEY SHARE`, so admin writes never wait on banking saves or moderation of other members. `assertTeamAdminUnderLock(..., 'noKeyUpdate')` is rejected for publish paths (2D's ADR 0016 conflict). It stays the right tool for moderation and banking.

**Uniform transaction prologue** (every admin write and every materialiser transaction):
```
runSessionTransaction(policy):
  SET LOCAL lock_timeout = policy.lockTimeoutMs         -- 2000 HTTP / 5000 job
  lockTeamRow(trx, teamId, 'keyShare')                  -- teams KEY SHARE (false → 403 / skip)
  [gate: check|assertTeamCanPublishPaidSession]         -- its KEY SHARE is now a no-op; before any game_sessions lock
  [SELECT … recurring_session_rules … FOR NO KEY UPDATE] -- rule writers and materialiser instance tx only
  [assertSessionAdmin: team_members(actor) FOR SHARE]   -- admin paths only
  [SELECT … game_sessions WHERE id = $1 FOR UPDATE]     -- D-14 / C-SSE-5
  writes … [allocator.promoteWaitlist] … [enqueue]
COMMIT
```
Taking `teams KEY SHARE` explicitly first follows ADR 0016 ("take the strongest teams lock you need first"). It is the same lock every FK insert into `game_sessions` takes, so it adds no edge. It also means the free-session gate, which takes no lock, cannot leave `team_members` locked before `teams`.

### Q3 (B2): Where auto-enrol runs relative to the materialiser's insert

#### Option 3A: Same transaction as the insert (allowed by ADR 0017 point 5 and C-SAE-1)
- **Pros**: atomic. The session becomes visible to players already holding its auto-enrolled seats (fair first claim).
- **Cons**:
  - The insert transaction then holds the rule lock (2A), `teams KEY SHARE` and the uncommitted `(rule, date)` index entry while the allocator gates members. That can mean waiting up to 5 s per member behind an admin's Auto Enroll save. Meanwhile a series edit on that rule waits on the rule lock and hits its 2 s HTTP timeout.
  - An allocator error rolls back the instance itself, so a persistent allocator bug stops instance creation for the rule. A savepoint would fix that, at the cost of a more subtle path.
  - Two code paths: new rows here, existing rows in a follow-up.
- **Technical Fit**: Medium. **Complexity**: Medium. **Scalability**: Medium.

#### Option 3B: Always a follow-up transaction (**chosen**)
- **Description**: The instance transaction commits the PUBLISHED session with `auto_enrol_required = true`. Then, in the same run, `runSessionAutoEnrol` opens a fresh transaction. The allocator gates members (`team_members FOR SHARE`), locks the session (`FOR UPDATE`), places members, and the marker is stamped. The API publish path enqueues `session-auto-enrol` in the publish transaction (P5). The sweep re-offers pending sessions (SA-5).
- **Pros**:
  - One code path for new instances, retried drafts, manual publishes and reconciliation.
  - Lock order is canonical by construction: no rule or session lock is held when `team_members` is taken.
  - An allocator failure never undoes or blocks materialisation.
  - The marker makes the step durable and re-runnable (crash between the two commits → the sweep finishes it).
- **Cons**:
  - A window of milliseconds between publish and enrolment in which a player could register first (or longer after a crash, until the next sweep). The worst case is that auto-enrollees are waitlisted behind someone who registered in that gap. Materialiser instances publish at 03:00, so this is accepted and recorded in ADR 0019.
  - Two commits per instance.
- **Technical Fit**: High. **Complexity**: Low. **Scalability**: High.

#### Option 3C: Always via a `session-auto-enrol` job, materialiser included
- **Pros**: one path, durable through pg-boss.
- **Cons**: an extra queue round trip per instance (seconds). Run summaries lose the enrolment counts. Still needs the marker for the rollout gap. 3B uses the job only where an inline follow-up is impossible (the API request) or batched (reconciliation).
- **Technical Fit**: High. **Complexity**: Low. **Scalability**: High.

### Q4 (B3 + conflicts 1, 2): The allocator port, its injection, and the rollout gap

#### Port shape
- **4.1 Mirror registration's `Allocator` exactly and import its types**: impossible, because registration builds after this feature.
- **4.2 A narrow SSE-owned port, structurally compatible with registration's `Allocator`, plus `name` and `enrols` (chosen)**: registration supplies a three-line adapter, `createRegistrationsSessionAllocator(allocator)`. That is the ADR 0015 precedent: SSE owns the port, registration owns the adapter.
- **4.3 An outbox table drained by registration (plan alternative C)**: breaks C-SSE-3's "same transaction" for `promoteWaitlist`. Rejected.

#### Injection
- **4.a `AppDeps.sessionAllocator?` and `RegisterJobsOptions.sessionAllocator?`, each defaulting to no-op (ADR 0015 style)**: two independent injection points. Registration could wire the worker and forget the API, so capacity raises would never promote. Nothing fails loudly.
- **4.b One composition function used by both entrypoints, plus required dependencies (chosen)**: `apps/api/src/session-allocator.ts` exports `createSessionAllocator(deps)`. `main.ts` passes its result to `buildApp`; `worker.ts` passes it to `registerJobs`. Both parameters are **required**, so a third entrypoint that forgets them does not compile. Tests pass a no-op or recording double through `test/helpers/app-deps.ts` and `worker-fixture.ts`. Registration changes **one function body**. `session-allocator.test.ts` asserts that both `main.ts` and `worker.ts` call `createSessionAllocator`.
- **4.c An env var selects the adapter**: rejected for ADR 0015's reason (a deployment can keep running the no-op after the real one ships).

#### Rollout gap (conflict 1)

| Option | What happens to sessions published between this merge and registration's merge | Who does what | Verdict |
|---|---|---|---|
| (a) Registration ships a one-time backfill | It enrols members of every future materialised PUBLISHED session | Registration adds a script and an AC to an already-amended plan (R14-R18). An operator must run it. SSE still needs something for the crash gap between publish and follow-up | Rejected: a cross-feature amendment and a manual step for a problem the producer can solve itself |
| (b) Hold production materialisation by env until registration ships | No instances are published, or none are created at all | An env flag (`RECURRENCE_PUBLISH_ENABLED`) must be flipped at the right deploy. That is the ADR 0015 anti-pattern (config can outlive the reason for it) | Rejected. v1.0.0 is still `planning` and ships all 11 features together, so in practice the gap exists only in dev and staging, and an env flag costs more than it saves |
| (c) A per-session "auto-enrol pending" marker plus reconciliation | They stay PUBLISHED with `auto_enrol_required` and `auto_enrolled_at IS NULL`. The first sweep after the real allocator is wired (worker boot, then daily) enrols them | **SSE**: columns, marker discipline, sweep reconciliation, boot sweep, port `enrols` flag. **Registration**: its adapter sets `enrols: true` and it edits `createSessionAllocator`. Nothing else | **Chosen** |
| (d) Accept the loss (ADR 0017 point 7: "not retroactive") | Members are never enrolled into those sessions | Nobody | Rejected: silently wrong for staging data and for the crash gap |

### Q5 (B4): Optimistic concurrency and replay safety

| Option | How a stale save is detected | Pros | Cons | Verdict |
|---|---|---|---|---|
| 5A Integer `version` per row, bumped by a DB trigger on any content change; client sends `expectedVersion` | Under the row lock, `locked.version <> expectedVersion` and the save would change something → 409 with the current row | One field for about 25 columns plus courts. Catches every writer (materialiser publish, propagation, billing's COMPLETED, raw SQL) because the DB bumps it. Also closes the gate-staleness hole: fees cannot change without a bump (Q7) | One column and one trigger per table | **Chosen** |
| 5B `expected*` fields (ADR 0017 point 9) | Compare every field the form showed | Field-level merge of unrelated edits | About 25 fields plus a court list per form: heavy, easy to leave a sibling field unguarded (api-write-idempotency rule), and no single token for the publish and cancel actions | Rejected |
| 5C `updated_at` as the version | Timestamp equality | No new column | Millisecond precision and clock-equality matching, which the testing-injected-clock rule warns against | Rejected (kept as a display stamp only) |
| 5D `xmin` | System column | No schema change | Changes on every physical update, including the court-touch trigger and bookkeeping writes. Freezes on vacuum | Rejected |

**Replay of creates**: `create_key uuid` with `UNIQUE (team_id, create_key)` on `game_sessions` and `recurring_session_rules` (the D-46 shape: a plain UNIQUE, NULLs distinct, inferable by `ON CONFLICT`). The form sends a UUID v4 per render. A replay returns the existing row (200 instead of 201) and enqueues nothing. The key is scoped by team so it can never be used to probe another team.

**Replay of updates and actions** (no change-key list is needed): the version is the replay guard. A delayed replay of an old edit carries an old `expectedVersion`. If it would change something, it is refused with 409. If it changes nothing, it is a no-op. A replayed publish or cancel finds the session already in the desired state and answers 200 with no write ("desired-state no-op"). The api-write-idempotency rule ("same guard on every sibling write") is met: edit, publish, cancel, series edit and series end all carry `expectedVersion` and share the same compare, the same 409-with-current-row answer and the same stale-path test.

### Q6 (B5 + conflict 8): DB lifecycle and immutability enforcement

| Option | Description | Verdict |
|---|---|---|
| 6A One BEFORE UPDATE guard trigger on `game_sessions` (matrix, closed immutability, key immutability) plus a BEFORE trigger on `session_courts`; TS twin plus a hand-written fixture | The team-management shape (D-42). Named constraint errors are mapped by `err.constraint` | **Chosen** |
| 6B A CHECK on a `previous_status` column | Needs a writer-maintained shadow column. A CHECK cannot see OLD | Rejected |
| 6C Enforce only in TS | Violates P1. Billing and raw SQL bypass it | Rejected |
| 6D Also put "not started" rules (cancel or edit after `starts_at`) in the trigger with `now()` | `now()` is the transaction start (or statement time), not the injected clock. The project keeps time-relative rules in TS (ADR 0017 point 1). It would make tests depend on wall time | Rejected for the time-relative part. The DB enforces state-only rules |

**Conflict 8 ruling**:
- The DB matrix admits `DRAFT → PUBLISHED`, `DRAFT → CANCELLED`, `PUBLISHED → CANCELLED` and `PUBLISHED → COMPLETED`. Same-status updates are allowed (no transition).
- This feature never performs `PUBLISHED → COMPLETED`. It belongs to wallet-and-akahu-billing (C-BIL-1, ADR 0017 C-GAME-1 point 3).
- **Cancel is allowed only before `starts_at`** (the spec default, confirmed). Reasons:
  - It matches C-SSE-3's "refused after `starts_at`".
  - Registration closes at `starts_at`.
  - The ban handler only acts on future sessions.
  - After start, the billing sweep owns the session's fate. A cancel racing billing's COMPLETED would need a joint protocol that belongs in billing's design.
- **Every edit of a PUBLISHED session after `starts_at` is refused** with 409 `session_started`, not only capacity edits. The spec already wants the editor read-only (AC-ERROR-5), and a court or fee change after start would move `ends_at` or reprice players with billing imminent.
- Until billing ships, ended sessions stay PUBLISHED and the admin list shows the derived "Ended" label (UI/UX).

### Q7: Proving gate-before-lock (AC-VERIFY-2)

| Option | Verdict |
|---|---|
| 7A Static source-order test (AST or grep for the gate call before `forUpdate()`) | Rejected: brittle across helper extraction, and blind to runtime branches |
| 7B Spy on the gate plus a spy on `lockSession` | Weak: misses a lock taken by a court write (the touch trigger) or by an INSERT |
| 7C **Runtime query-order recorder** (chosen): a test Kysely whose `log` hook records each SQL statement per connection. For each publish path (manual publish, create-and-publish if offered, materialiser publish, draft retry, free-to-paid edit, series propagation to PUBLISHED instances), the test asserts that the index of the gate statement (`select "is_payout_configured", "payout_blocked_at" from "teams" … for key share`) is lower than the index of the first statement that locks or writes `game_sessions` (`for update`, `update "game_sessions"`, `insert into "game_sessions"`, `insert/update/delete … "session_courts"`) | **Chosen**. It sees the real statement order, including helper-taken locks. It runs on paid sessions (the free gate issues no statement, so free paths assert "no `game_sessions` write before the decision" instead) |

**Gate staleness closure**: the gate reads fees **before** the session lock (unlocked read, or the request body for an edit). After the lock, the path requires `locked.version = version seen` (API: also `= expectedVersion`). Fees cannot change without a version bump (SA-6 trigger), so the fees that were gated are exactly the fees being published. A mismatch gives 409 `session_stale` (API) or a skip that the next run retries (job). The materialiser's instance transaction gates on the **locked** rule's fees (rule lock before the gate is allowed: rules sit after `teams`), so it needs no re-check.

### Q8: How a series edit reaches existing instances (feeds A3 and A4)

| Option | Description | Verdict |
|---|---|---|
| 8A **Synchronous, one transaction** (chosen) | Prologue → gate on the new fees if propagation could make a PUBLISHED instance paid → rule `FOR NO KEY UPDATE` → version check → actor re-check → `UPDATE` rule and template → for each target instance in `(date, id)` order: `FOR UPDATE`, guarded `UPDATE … WHERE is_instance_overridden = false AND status = ANY($statuses) AND version = $seen`, replace courts, `promoteWaitlist` if public capacity rose on a PUBLISHED instance → enqueue `recurrence-rule` for new dates → COMMIT | **Chosen**. Exact counts for AC-HAPPY-7 in the response. All or nothing. Bounded by the horizon (13 weekly instances at 90 days). Each instance lock is held only for this transaction (tens of ms per instance). Multi-session locking in `(date, id)` order can only meet another multi-session writer of the same rule, and the rule lock serialises those |
| 8B Synchronous, one transaction per instance after the rule commits | A partial failure leaves a half-propagated series. Counts become "best effort" | Rejected |
| 8C Asynchronous in the per-rule job | The response cannot say how many were updated. The UI must poll. A propagation failure is invisible to the admin | Rejected (still used for *new* dates) |

A gate refusal in 8A (series turned paid, team not configured, and propagation would touch PUBLISHED instances) refuses the **whole** edit with 409 `payout_not_configured` and the banking `returnTo` hand-off. Nothing is saved. That matches the instance-edit behaviour. A series edit that touches only DRAFT instances and future dates needs no gate: drafts are gated when they are published.

---

## Evaluation Matrix

Scores 1 (poor) to 5 (best). Only the decisive comparisons are shown.

| Criteria | 1A one queue | 1B keyed exclusive | 1C inline sweep + rule queue | **1D fan-out + stately** |
|---|---|---|---|---|
| Scalability | 2 | 3 | 3 | **5** |
| Maintainability | 4 | 4 | 2 | **4** |
| Performance (rule-create latency) | 1 | 3 | 4 | **5** |
| Correctness (no dropped runs) | 1 | 2 | 4 | **5** |
| Observability | 3 | 3 | 3 | **4** |
| Implementation cost | 5 | 5 | 3 | **4** |

| Criteria | **2A rules before members** | 2B after members | 2C optimistic | 2D team mutex |
|---|---|---|---|---|
| Deadlock safety | **5** | 4 | 5 | 5 |
| Fit with ADR 0016 | **5** | 5 | 5 | 1 |
| Correctness of propagation counts | **5** | 5 | 2 | 5 |
| Hot-path contention | **5** | 5 | 5 | 2 |

| Rollout gap | (a) backfill | (b) env hold | **(c) marker** | (d) accept |
|---|---|---|---|---|
| Correctness | 4 | 4 | **5** | 1 |
| Operational risk | 2 (manual run) | 2 (flag drift) | **5** (self-healing) | 5 |
| Cross-feature cost | 2 | 4 | **4** | 5 |
| Also covers the crash gap between commits | 1 | 1 | **5** | 1 |

| Concurrency | **5A version** | 5B expected* | 5C updated_at | 5D xmin |
|---|---|---|---|---|
| Completeness (all writers) | **5** | 3 | 3 | 2 |
| Maintainability | **5** | 2 | 4 | 2 |
| Security / replay | **5** | 4 | 3 | 2 |

---

## Observability Architecture

### Logging
- **Library**: the existing pino logger (`apps/api/src/lib/logger`), structured JSON, `LOG_LEVEL`/`LOG_FORMAT`/`LOG_OUTPUT`. Request logs carry `traceId`/`spanId` (`registerRequestTracing`). Job logs come from `context.logger`, bound to `jobId`, `queue` and the job's trace.
- **Ids only**: `teamId`, `sessionId`, `ruleId`, `actorId`, `date` (a LocalDate, not personal), counts, `reason`, `errorCode` (never `code`), `sqlState`, `allocator` (port name). Never a member name, email, address of a person, or bank value. No new redaction key is needed. None of the field names below matches an existing redaction pattern; the build grep re-checks this per the logging-redaction-global rule.

| Event | Level | Fields (in addition to trace) |
|---|---|---|
| `session.created` / `session.updated` | info | teamId, sessionId, actorId, version, changed (field-name list), promoted (count) |
| `session.published` | info | teamId, sessionId, actorId, paid (bool), autoEnrolQueued (bool) |
| `session.publish_refused` | info | teamId, sessionId, actorId, reason, errorCode `payout_not_configured` |
| `session.cancelled` | info | teamId, sessionId, actorId, fromStatus |
| `session.stale_refused` | info | teamId, sessionId or ruleId, actorId, expectedVersion, currentVersion |
| `session.series.created` / `.updated` / `.ended` | info | teamId, ruleId, actorId, version; `.updated` adds updated, skippedEdited, skippedClosed, cancelled, deletedDrafts |
| `session.recurrence.sweep_completed` | info | rulesScanned, rulesEnqueued, pendingAutoEnrolEnqueued, durationMs |
| `session.recurrence.run_completed` (per rule job) | info | teamId, ruleId, trigger, windowStart, created, published, savedAsDraft, draftsRetried, autoEnrolled, failed, durationMs |
| `session.recurrence.instance_created` | info | teamId, ruleId, sessionId, date, status |
| `session.recurrence.publish_refused` | info | teamId, ruleId, sessionId, reason |
| `session.recurrence.instance_failed` | error (permanent) / warn (transient) | teamId, ruleId, date, sqlState, errorCode, transient |
| `session.recurrence.rule_skipped` | info | teamId, ruleId, reason (`inactive`, `ended`, `not_found`) |
| `session.auto_enrol.completed` | info | teamId, sessionId, allocator, candidates, confirmed, waitlisted, skipped (map of reason → count) |
| `session.auto_enrol.port_noop` | info | teamId, sessionId, candidates |
| `session.auto_enrol.failed` | warn | teamId, sessionId, allocator, sqlState, errorCode |
| `session.lock_retry` / `session.lock_retry_exhausted` | warn | path, attempt, sqlState |

### Distributed Tracing
- **SDK**: OpenTelemetry (existing setup), W3C Trace Context.
- **Spans**:
  - Per API route: automatic (`@fastify/otel`).
  - Per job: the existing `"{queue} process"` CONSUMER span, restored from `_meta.traceparent`.
  - Children under tracer `@sgm/api/sessions`:
    - `session.recurrence.instance` (attributes `teamId`, `ruleId`, `date`, `outcome`)
    - `session.recurrence.retry_draft`
    - `session.auto_enrol` (`candidates`, `confirmed`, `waitlisted`, `skipped`, `allocator`)
    - `session.series.propagate` (`targets`, `updated`)
    - `session.publish` (`path`: `manual` | `materialiser` | `retry` | `edit`)
  - Errors set the span status to ERROR and add the event with `errorCode` only.
- **Service boundaries**:

  | From | To | Protocol | Propagation Method |
  |---|---|---|---|
  | apps/web | apps/api | HTTP | `traceparent` header (existing api-client) |
  | apps/api request (series create, edit, end) | `recurrence-rule` job | pg-boss in-transaction insert | `_meta.traceparent` (`injectTraceMeta`) |
  | apps/api request (publish) | `session-auto-enrol` job | pg-boss | `_meta.traceparent` |
  | cron or boot | `recurrence-materialisation` | pg-boss scheduler | new root trace (CONSUMER span) |
  | sweep job | `recurrence-rule`, `session-auto-enrol` | pg-boss | `_meta.traceparent` = the sweep's span (one trace per nightly run) |
  | materialiser or API | `SessionAllocatorPort` | in-process | the caller's active span |
  | materialiser | `send-email` | pg-boss | `_meta.traceparent` |

- **Sampling**: `OTEL_TRACES_SAMPLER_ARG`, 1.0 in dev. A production ratio is an operator choice, unchanged.

### Metrics
- **Standard metrics**: `http_requests_total{method, route, status_code}` and `http_request_duration_seconds{method, route}`, through the existing HTTP instrumentation. No new backend; metric emission waits for the exporter, as in ADR 0017.
- **Reserved custom metric names** (not emitted until an exporter exists; a later feature must not repurpose them):
  - `session_recurrence_instances_total{outcome}` (`published`, `draft_refused`, `draft_lead`, `failed`)
  - `session_recurrence_rule_runs_total{outcome}`
  - `session_recurrence_rule_run_duration_seconds`
  - `session_auto_enrol_entries_total{outcome}` (`confirmed`, `waitlisted`, `skipped_<reason>`)
  - `session_publish_total{path, outcome}`
  - `session_lock_retries_total{path}`
  - Labels are low-cardinality: no team, rule, session or user ids.
- **Alert signals today** (logs): `session.recurrence.instance_failed` at `error`, `run_completed.failed > 0`, `session.auto_enrol.failed`, and pending auto-enrol older than one sweep (an SQL check on `idx_game_sessions_auto_enrol_pending`).

### Configuration Variables

| Variable | Purpose | Default |
|---|---|---|
| LOG_LEVEL / LOG_FORMAT / LOG_OUTPUT | Existing | info / json / stdout |
| OTEL_EXPORTER_OTLP_ENDPOINT / OTEL_SERVICE_NAME / OTEL_TRACES_SAMPLER_ARG | Existing | – / sgm-api, sgm-worker / 1.0 (dev) |
| `RECURRENCE_HORIZON_DAYS` | Materialisation horizon (P7, zod int; range and default set by Algorithm A2) | Algorithm |
| `RECURRENCE_PUBLISH_LEAD_DAYS` (only if Algorithm chooses one global lead time) | Days before a date when an instance is published | Algorithm |

Lock policies are **code constants**, like registration's: `HTTP_POLICY = { lockTimeoutMs: 2000, attempts: 3, backoffMs: [25, 75] }` and `JOB_POLICY = { lockTimeoutMs: 5000, attempts: 3, backoffMs: [100, 400] }`. They are behaviour, not deployment config, so P7 is unaffected.

---

## Decision

### SA-1: Materialiser structure and queueing (B1, conflict 4)

**Chosen**: Option 1D. The registry and schedule changes:

```ts
// jobs/registry.ts (additions)
recurrenceRule: 'recurrence-rule',
sessionAutoEnrol: 'session-auto-enrol',
// One queued + one active run per rule (singletonKey `recurrence-rule:<ruleId>`): an edit during a run queues exactly
// one trailing run. Idempotent through uq_game_sessions_rule_date and guarded UPDATEs, never through this policy.
{ ...DEFAULTS, name: QUEUE_NAMES.recurrenceRule, policy: 'stately' },
// Auto-enrol follow-up per session (singletonKey `session-auto-enrol:<sessionId>`); the marker is the durable guard.
{ ...DEFAULTS, name: QUEUE_NAMES.sessionAutoEnrol, policy: 'exclusive' },
```

Payloads are strict zod and ids only:
- `RecurrenceRulePayload = z.strictObject({ ruleId: z.uuid(), teamId: z.uuid(), trigger: z.enum(['sweep', 'rule_created', 'rule_updated', 'rule_ended', 'manual']) })`
- `SessionAutoEnrolPayload = z.strictObject({ sessionId: z.uuid(), teamId: z.uuid(), trigger: z.enum(['publish', 'sweep', 'manual']) })`
- The sweep ignores its payload, like `skill-progression`.
- An invalid payload fails with `NonRetryableJobError`.
- `cli jobs trigger recurrence-rule '<json>'` is validated with the same schema, like `member-banned`.

**Per-rule run (`materialiseRule`)**, with the clock read once per job (`runNow`):
1. Read the rule without a lock. Skip with `rule_skipped` if it is missing, `is_active = false`, or `recur_until` is before the window.
2. `window = materialisationWindow(runNow, env)` and `dates = recurrenceDates(rule, window)` (pure, Algorithm). `windowStart = window.start` (a LocalDate).
3. Read the existing instance dates of this rule in the window (one query on `idx_game_sessions_recurring`). For each missing date, in date order, run one **instance transaction** (`JOB_POLICY`), then an inline auto-enrol follow-up if it was published:
   ```
   SET LOCAL lock_timeout '5s'
   lockTeamRow(keyShare)                                  -- teams
   rule := SELECT … FROM recurring_session_rules WHERE id=$r FOR NO KEY UPDATE   -- re-read, authoritative
     → if inactive, ended, or $date no longer generated by the locked rule (edit in between): skip (no insert)
   publishDue := Algorithm lead-time predicate($date, now)
   gate := publishDue ? checkTeamCanPublishPaidSession(trx, {teamId, pricingStructure, fees: rule fees, log}) : n/a
   id := INSERT INTO game_sessions (…rule defaults…, status 'DRAFT', recurring_rule_id, date, deadline_is_default true,
           auto_enrol_required true)
         ON CONFLICT (recurring_rule_id, date) WHERE recurring_rule_id IS NOT NULL DO NOTHING RETURNING id
     → no row: another run created it → skip
   INSERT INTO session_courts SELECT … FROM recurring_rule_courts WHERE rule_id=$r      -- touch trigger derives instants + default deadline
   if publishDue and gate.ok:
     now := clock.now(); require starts_at > now (else leave DRAFT, outcome 'past')
     UPDATE game_sessions SET status='PUBLISHED', fee_flat = <final FLAT rate if FLAT> WHERE id=$id AND status='DRAFT'
   elif publishDue and not gate.ok:
     log session.recurrence.publish_refused
     claimed := UPDATE recurring_session_rules SET payout_notice_window=$windowStart
                WHERE id=$r AND payout_notice_window IS DISTINCT FROM $windowStart RETURNING id      -- D-81 durable claim
     if claimed: enqueueEmail(..., idempotencyKey 'payout-missing:<ruleId>:<windowStart>', {trx}) per approved admin
   COMMIT
   ```
   The instance row is new and uncommitted, so it needs no `FOR UPDATE` for the publish (nobody else can see it).
4. **Draft retry** (ADR 0016 point 6): for each `DRAFT` with `recurring_rule_id = $r`, `is_instance_overridden = false`, `starts_at > runNow`, inside the publish horizon:
   - Unlocked read of fees and `version`.
   - Transaction: prologue, gate, `SELECT … FOR UPDATE`, require `version` unchanged and still DRAFT and not overridden, `now := clock.now()`, require `starts_at > now`, guarded `UPDATE … SET status='PUBLISHED' WHERE id=$1 AND status='DRAFT' AND NOT is_instance_overridden`. A refused gate is not an error (no extra email: the claim for this window is already taken or gets taken here).
   - Then an inline follow-up.
5. Stamp bookkeeping in a short transaction (rule `FOR NO KEY UPDATE`): `materialised_version = <rule version used>`, `materialised_at = now`. These columns are excluded from the version bump.
6. Log `run_completed`. Failure policy (AC-ERROR-9): each instance transaction is isolated. An error rolls back only that instance and is logged `instance_failed` with `sqlState`/`errorCode`, and the run continues.
   - If any failure was transient (`40P01`, `55P03`, `40001`, connection class `08`, or an unknown error), the job throws a plain `Error` after the loop, so pg-boss retries with backoff and re-runs idempotently.
   - If the only failures are permanent (23xxx, including a `game_sessions_paid_requires_payout` that means the gate was skipped), the job throws `NonRetryableJobError`.

**Sweep (`recurrence-materialisation`)**:
- Keyset over `recurring_session_rules WHERE is_active AND (recur_until IS NULL OR recur_until >= today)`, ordered by `id`, pages of 500. Enqueue `recurrence-rule` for each rule (stately collapses any duplicates).
- Then keyset over pending sessions (SA-5). Enqueue `session-auto-enrol` for each.
- Log `sweep_completed`.
- Also enqueued **once at worker boot**: `worker.ts`, after `registerJobs`, calls `runner.enqueue('recurrence-materialisation', {})`. On the `exclusive` queue this is a no-op if a sweep is already queued or active. This mirrors registration's boot sweep (allocator doc Q4, S-a).

**Rule create, edit and end**: each enqueues `recurrence-rule` (`trigger: rule_created | rule_updated | rule_ended`) in its own transaction (P5). The UI's first-materialisation state reads `materialised_version < version` (D-82).

### SA-2: Lock order (B2)

**Chosen**: Option 2A.

**Canonical order (ADR 0019 restates and extends ADR 0015, ADR 0016 and C-ALL-1)**: `teams → recurring_session_rules → team_members → game_sessions → registrations → registration_guests → payments`.
- `teams` is taken by this feature only as `KEY SHARE`, explicitly first (`lockTeamRow`) and by the gate. It is **never** `FOR UPDATE` or `FOR NO KEY UPDATE`.
- `recurring_session_rules` is taken only as `FOR NO KEY UPDATE`, only by the series edit, series end, the materialiser's instance transaction and the bookkeeping stamp.
- `team_members`: the actor re-check (`FOR SHARE`, admin paths) and the allocator's member gates (`FOR SHARE`, inside the port, follow-up transactions and capacity edits).
- `game_sessions`: `FOR UPDATE` (D-14), one row per transaction, except the series edit, which locks the rule's instances in `(date, id)` order under the rule lock.
- Lower levels (`registrations` and below) only through the allocator.

How the three writers serialise:

| Pair | Mechanism | Outcome |
|---|---|---|
| Materialiser instance tx ↔ series edit or end (same rule) | Rule `FOR NO KEY UPDATE` on both | Whoever is second sees the other's commit: the edit counts the new instance; the materialiser re-reads the rule and skips or re-shapes the date |
| Materialiser draft retry ↔ instance edit | Session `FOR UPDATE` on both, plus guarded `WHERE is_instance_overridden = false AND version = $seen` | An edit first: the retry skips. A retry first: the admin's stale `expectedVersion` → 409 `session_stale` |
| Series edit ↔ instance edit (same instance) | Session `FOR UPDATE` on both. The edit's guarded predicate re-reads `is_instance_overridden` under the lock | Instance edit first → counted "left because edited". Series edit first → instance editor 409 stale |
| Series edit ↔ series edit | Rule lock plus rule `expectedVersion` | The loser gets 409 `series_stale` |
| Any admin write ↔ demotion or ban of the actor | Actor `team_members FOR SHARE` versus the moderation `UPDATE` | Serialised. The demoted actor then gets 403 |

### SA-3: Auto-enrol placement (B2)

**Chosen**: Option 3B, always a follow-up transaction.

```ts
// modules/sessions/auto-enrol.ts
export async function runSessionAutoEnrol(
  deps: { db: Database; clock: Clock; allocator: SessionAllocatorPort; log: JobLogger },
  input: { teamId: string; sessionId: string },
): Promise<{ kind: 'done' | 'noop_port' | 'not_due' | 'no_candidates'; confirmed: number; waitlisted: number; skipped: number }>;
```
1. Unlocked read of the session. Return `not_due` unless it is `PUBLISHED`, `auto_enrol_required`, `auto_enrolled_at IS NULL` and `starts_at > clock.now()`.
2. `entries = selectAutoEnrollees(db, { teamId, sessionDate: session.date })` (C-SKL-1 point 1, no locks), mapped to `{ userId, assignedAt, membershipId }` in the returned order.
3. If `!allocator.enrols`: log `session.auto_enrol.port_noop { teamId, sessionId, candidates }` and return `noop_port`. The marker stays pending (SA-5).
4. `runSessionTransaction(JOB_POLICY)`. If `entries` is non-empty: `results = allocator.autoEnrolInSession({ trx, now: clock.now(), log }, { teamId, sessionId, entries })`. The allocator gates every member first, then locks the session. Then `UPDATE game_sessions SET auto_enrolled_at = $now WHERE id = $sid AND status = 'PUBLISHED' AND auto_enrolled_at IS NULL`. The allocator already holds the row if it placed anyone; otherwise this takes it after the member gates, which is still canonical. COMMIT. The allocator's promotion and auto-enrol emails (R17) are enqueued in this transaction.
5. With empty `entries` and a real allocator: no allocator call, stamp the marker (`no_candidates`).
6. Per-member refusals are counted, never thrown. A thrown error (lock timeout) rolls back. It is logged `session.auto_enrol.failed`, the marker stays pending, and the caller continues: the materialiser carries on, the job retries.

Re-runs never call the allocator twice for one session: the marker is stamped in the same transaction as the placements. Even if the marker were lost, `already_registered` makes a second call harmless.

### SA-4: `SessionAllocatorPort` (B3, conflict 2)

**Chosen**: Option 4.2 with injection 4.b. The exact signature (ADR 0019 "offered" contract):

```ts
// apps/api/src/modules/sessions/allocator-port.ts
import type { Transaction } from 'kysely';
import type { DB } from '../../lib/db/types.generated.ts';
import type { Logger } from '../../lib/logger/logger.ts';

/** The caller's transaction and clock reading. The allocator asserts `trx.isTransaction`. */
export interface SessionAllocatorContext {
  readonly trx: Transaction<DB>;
  /** Read by the caller after its own locks (capacity edit: after the session FOR UPDATE). */
  readonly now: Date;
  readonly log: Pick<Logger, 'info' | 'warn' | 'error'>;
}

/** One `selectAutoEnrollees` row, passed in the returned order (R16; supersedes C-SAE-1's `userIds`). */
export interface AutoEnrolEntry {
  readonly userId: string;
  /** `auto_enroll_assigned_at` as selected; the allocator re-checks it at millisecond precision (R16). */
  readonly assignedAt: Date;
  /** Pass-through for the allocator's logs; optional (R16 "callers may pass through"). */
  readonly membershipId?: string;
}

export type AutoEnrolSkipReason =
  | 'overdue_payments' | 'forbidden' | 'already_registered' | 'auto_enroll_changed'
  | 'not_found' | 'session_not_open' | 'party_exceeds_capacity';

export type AutoEnrolEntryOutcome =
  | { readonly ok: true; readonly status: 'CONFIRMED' | 'WAITLISTED' }
  | { readonly ok: false; readonly reason: AutoEnrolSkipReason };

export interface PromotedSeat {
  readonly registrationId: string;
  readonly userId: string;
  readonly promotedAt: Date;
}

export interface SessionAllocatorPort {
  /** Logged as `allocator` (e.g. `noop`, `registrations`). */
  readonly name: string;
  /**
   * True only for an implementation that really registers members. While false (the no-op), the auto-enrol
   * follow-up leaves `game_sessions.auto_enrolled_at` NULL so a later run with a real allocator enrols the session.
   */
  readonly enrols: boolean;
  /**
   * C-SSE-3: called after the caller's `SELECT … FROM game_sessions … FOR UPDATE` and capacity `UPDATE`, in the same
   * transaction, only when public capacity (max_players − reserved_seats) rose on a PUBLISHED, not-started session.
   * Takes the D-14 lock itself (re-entrant). Returns the promoted seats; [] when nothing changed.
   */
  promoteWaitlist(
    ctx: SessionAllocatorContext,
    input: { readonly teamId: string; readonly sessionId: string },
  ): Promise<readonly PromotedSeat[]>;
  /**
   * C-SAE-1/2 as amended by R16: once per PUBLISHED session, in a transaction that holds no lock on that session or its
   * rule; gates every member (team_members FOR SHARE + opt-out re-check) before taking the session lock; parties have
   * no guests; refusals are returned per entry, never thrown; never called with an empty `entries`.
   */
  autoEnrolInSession(
    ctx: SessionAllocatorContext,
    input: { readonly teamId: string; readonly sessionId: string; readonly entries: readonly AutoEnrolEntry[] },
  ): Promise<readonly { readonly userId: string; readonly outcome: AutoEnrolEntryOutcome }[]>;
}

/** Safe default until registration-and-waitlist ships: logs and changes nothing. */
export const noopSessionAllocator: SessionAllocatorPort; // name 'noop', enrols false; promoteWaitlist → [] (debug log
                                                          // session.allocator.promote_noop); autoEnrolInSession → []
```

```ts
// apps/api/src/session-allocator.ts: the ONE function registration-and-waitlist edits.
export interface SessionAllocatorDeps {
  readonly db: Database;
  readonly jobs: Pick<JobRunner, 'enqueue'>;   // API: producer runner; worker: worker runner (allocator emails on the caller's trx)
  readonly clock: Clock;
  readonly webBaseUrl: string;
}
export function createSessionAllocator(deps: SessionAllocatorDeps): SessionAllocatorPort {
  void deps;
  return noopSessionAllocator;   // registration: return createRegistrationsSessionAllocator(createAllocator({ jobs, webBaseUrl }))
}
```

- `AppDeps.sessionAllocator: SessionAllocatorPort` is **required**. `buildApp` passes it to `createSessionsService`.
- `RegisterJobsOptions.sessionAllocator: SessionAllocatorPort` is **required**. `registerJobs` passes it to the `recurrence-rule` and `session-auto-enrol` handlers.
- `main.ts` and `worker.ts` both call `createSessionAllocator(...)`. `session-allocator.test.ts` asserts it structurally (both entrypoints import and call it, and neither passes `noopSessionAllocator` directly).
- **Compatibility note for registration**: its `Allocator.autoEnrolInSession` (R16 input) and `promoteWaitlist(ctx, { teamId, sessionId })` match these shapes, and its `RegisterOutcome` refusals are a subset of `AutoEnrolSkipReason`. The adapter only adds `name: 'registrations'` and `enrols: true` and narrows the outcome. Registration's "Assumed output 4" text (`promoteWaitlist(trx, sessionId, now)`) is outdated; the allocator doc's `(ctx, { teamId, sessionId })` form is the binding one, and the port follows it.

### SA-5: Rollout gap (conflict 1)

**Chosen**: option (c), the per-session marker.

- `game_sessions.auto_enrol_required boolean NOT NULL DEFAULT false` and `game_sessions.auto_enrolled_at timestamptz`, with CHECK `auto_enrolled_at IS NULL OR auto_enrol_required`. Partial index `idx_game_sessions_auto_enrol_pending (starts_at) WHERE status = 'PUBLISHED' AND auto_enrol_required AND auto_enrolled_at IS NULL`.
- **Set `required`**: true on every materialised instance at insert. For one-off sessions, as the User Journey rules on conflict 3. The default of `false` keeps the ADR 0017 point 6 status quo.
- **Stamp `auto_enrolled_at`**: only inside a follow-up transaction where `allocator.enrols` was true (SA-3).
- **Who drives pending sessions to done**:
  - The materialiser inline, right after each publish.
  - `session-auto-enrol` jobs from API publishes.
  - The sweep (daily 03:00, **at every worker boot**, and on demand) for every pending future PUBLISHED session.
- **During the gap (no-op port)**: sessions stay pending, and each sweep logs `port_noop` per pending session. When registration deploys with its adapter, the worker boot sweep enrols every pending future session within seconds. Players cannot have registered in between, because registration's endpoints ship in the same deploy as the adapter.
- **Semantics recorded in ADR 0019**: for a session whose auto-enrol was deferred, selection happens when enrolment first runs, not at publish. That is a bounded exception to ADR 0017 point 7 ("not retroactive"). It applies only to sessions that never had an auto-enrol run, and never re-enrols a session that had one.
- **Who does what**:
  - SSE: columns D-80, `runSessionAutoEnrol`, sweep reconciliation, boot enqueue, `enrols` flag, a contract test proving pending → done with an `enrols: true` recording double.
  - Registration: the adapter with `enrols: true`, editing `createSessionAllocator`, and re-running `sessions-contracts.int.test.ts` at its build gate.
  - No backfill script. No env flag.

### SA-6: Optimistic concurrency and replay (B4)

**Chosen**: Option 5A plus `create_key`.
- `version integer NOT NULL DEFAULT 1` and `updated_at timestamptz NOT NULL DEFAULT now()` on `game_sessions` and `recurring_session_rules`.
- Trigger `<table>_version_bump`, BEFORE UPDATE, named so it fires **last**. It sets `NEW.version := OLD.version + 1` when `(to_jsonb(NEW) - excluded) IS DISTINCT FROM (to_jsonb(OLD) - excluded)`, otherwise `NEW.version := OLD.version`, so writers cannot set it. It sets `NEW.updated_at := statement_timestamp()` when the content changed and the writer left `updated_at` unchanged (billing, raw SQL). The service writes `updated_at` from its injected clock. A court-only change sets `updated_at`, which counts as content and so bumps.
  - Excluded on `game_sessions`: `version`, `starts_at`, `ends_at` (derived), `auto_enrol_required`, `auto_enrolled_at` (bookkeeping).
  - Excluded on rules: `version`, `payout_notice_window`, `materialised_version`, `materialised_at`.
  - New columns count as content by default, which is the safe direction.
- Every write DTO carries `expectedVersion: number`. Under the row lock:
  - Compute the resulting values. If they equal the current ones, it is a no-op: 200 with the current row, whatever the version.
  - Else, if `locked.version !== expectedVersion`: 409 `session_stale` / `series_stale` with the current row.
  - Else write.
  - Publish and cancel: if already in the target state, 200 no-op.
- `create_key uuid` with `UNIQUE (team_id, create_key)` on both tables (`uq_game_sessions_team_create_key`, `uq_recurring_session_rules_team_create_key`). `INSERT … ON CONFLICT (team_id, create_key) DO NOTHING RETURNING id`. On no row, read by `(team_id, create_key)`, return 200 with the existing row, and enqueue nothing.

### SA-7: Lifecycle and immutability triggers, TS twin (B5, conflict 8)

**Chosen**: Option 6A.

- **`game_sessions_guard_update`** (BEFORE UPDATE OF any column; name sorts after `derive_instants` and `fill_default_deadline`, before `paid_requires_payout` and `version_bump`):
  - `team_id` is immutable, and `date` is immutable when `OLD.recurring_rule_id IS NOT NULL` → `23000`, constraint `game_sessions_keys_immutable`.
  - Status moves outside the matrix → `23000` `game_sessions_status_transition`.
  - `OLD.status IN ('COMPLETED', 'CANCELLED')`: any difference in `to_jsonb(NEW) - '{version, updated_at, recurring_rule_id}'` versus OLD → `23000` `game_sessions_closed_immutable`. `recurring_rule_id` may only become NULL (the FK `ON DELETE SET NULL`). The comparison includes `starts_at`/`ends_at`, which closes C-GAME-1 point 3 even for a raw court write that reaches the touch trigger.
- **`session_courts_guard_closed`** (BEFORE INSERT OR UPDATE OR DELETE on `session_courts`): `SELECT status FROM game_sessions WHERE id = <NEW/OLD.session_id> FOR NO KEY UPDATE`. COMPLETED or CANCELLED → `23000` `session_courts_closed_immutable`. A missing row (a cascade delete in progress) → allow.
  - The lock mode is chosen on purpose: it conflicts with billing's `FOR UPDATE` and any status `UPDATE`, so a raw court write that races a completion waits and then sees COMPLETED.
  - It is the mode the touch trigger's `UPDATE` needs anyway, so there is no SHARE-to-UPDATE upgrade deadlock.
  - Service paths already hold the session `FOR UPDATE` before touching courts, so for them it is a no-op.
- **C-SSE-1 CHECKs** (status `IN ('PUBLISHED', 'COMPLETED')`):
  - `game_sessions_skill_fees_when_live`: all three skill fees NOT NULL when `BY_SKILL_LEVEL`.
  - `game_sessions_flat_fee_when_live`: `fee_flat IS NOT NULL AND fee_flat = coalesce(custom_player_rate, calculated_rate_per_player, fee_flat)` when `FLAT`. The coalesce keeps rows without costing columns (fixtures) valid, while every service-written row, which always has `calculated_rate_per_player`, is held to "fee_flat is the final rate" (AC-INTEGRATION-1).
- **No time-relative rules in SQL**. Cancel and edits before `starts_at` are TS (`decideSessionAction` with the clock read after the lock).
- **TS twin**:
  - `packages/shared/src/sessions/lifecycle.ts` exports `SESSION_TRANSITIONS: Readonly<Record<SessionStatus, readonly SessionStatus[]>>`.
  - `apps/api/src/modules/sessions/transitions.ts` exports `decideSessionAction(action: 'edit' | 'publish' | 'cancel' | 'capacity', state: { status, startsAt }, now)` → `{ ok: true, next }` or `{ ok: false, error: 'session_not_editable' | 'session_started' | 'session_state_conflict' }`.
  - The hand-written fixture `apps/api/test/fixtures/session-transitions.ts` holds the 16 `(from, to, allowed)` rows plus the action × state × time rows. It runs against `SESSION_TRANSITIONS` (unit) and against the trigger (`sessions-schema.int.test.ts`: a raw `UPDATE` from each `from` to each `to`, expecting success or `23000` with the named constraint). Any change to the matrix changes the SQL, the TS and the fixture in one commit (the ADR 0016 discipline).
- **Error mapping** (`mapSessionDbError`, by SQLSTATE plus `err.constraint`):

  | Constraint | API result |
  |---|---|
  | `…status_transition` | 409 `session_state_conflict` |
  | `…closed_immutable` (both) | 409 `session_not_editable` |
  | `game_sessions_deadline_before_start` | 422 `validation_failed` (`cancellationDeadline`) |
  | `uq_session_courts_session_identifier` | 422 (`courts[i].identifier`) |
  | C-SSE-1 CHECKs | 422 naming the fee |
  | `game_sessions_paid_requires_payout` | `mapPublishGateDbError`, logged at `error` (a bug) |
  | `55P03` / `40P01` | handled by the retry wrapper; exhausted → 500 `OUTAGE_MESSAGE` |

### SA-8: Migration shape and ledger (conflict 9)

**Chosen**: one migration, `db/migrations/20261020000100000_session_scheduling.sql` (reversible: the down migration drops everything in reverse order). Sketch:

```sql
-- Up Migration
-- session-scheduling-engine (D-70..D-83). Decision record: memory-bank/creative/session-scheduling-engine-architecture.md.
-- No application code wrote these tables before this feature; dev/test rows are cleaned up first (D-83), then CHECKs.

-- D-83 cleanup (dev/test rows only): anchor backfill, trim, clamp. See the ledger row.
-- D-70 rule anchor
ALTER TABLE recurring_session_rules ADD COLUMN starts_on date;
UPDATE recurring_session_rules SET starts_on = <first date ≥ created_at (NZ) whose extract(dow) = day_of_week>;
-- Convention assumed: day_of_week uses PostgreSQL dow (0 = Sunday … 6 = Saturday); Algorithm/shared recurrence must match (H1).
ALTER TABLE recurring_session_rules
  ALTER COLUMN starts_on SET NOT NULL,
  ADD CONSTRAINT recurring_session_rules_anchor_weekday CHECK (extract(dow FROM starts_on) = day_of_week),
  ADD CONSTRAINT recurring_session_rules_until_after_anchor CHECK (recur_until IS NULL OR recur_until >= starts_on);

-- D-71 per-court template (authoritative for materialisation; default_court_count/start/end stay as the editor's
-- remembered bulk-fill values)
CREATE TABLE recurring_rule_courts (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  rule_id          uuid NOT NULL REFERENCES recurring_session_rules (id) ON DELETE CASCADE,
  position         smallint NOT NULL CHECK (position BETWEEN 1 AND 50),
  court_identifier varchar(50) NOT NULL,
  start_time       time NOT NULL,
  end_time         time NOT NULL,
  created_at       timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT recurring_rule_courts_time_order CHECK (start_time < time '24:00' AND end_time > start_time),
  CONSTRAINT recurring_rule_courts_identifier_trimmed
    CHECK (char_length(court_identifier) BETWEEN 1 AND 50 AND court_identifier = btrim(court_identifier)),
  CONSTRAINT uq_recurring_rule_courts_identifier UNIQUE (rule_id, court_identifier),
  CONSTRAINT uq_recurring_rule_courts_position UNIQUE (rule_id, position)
);
-- deferred: an active rule has ≥ 1 template court at COMMIT (function recurring_rule_courts_present, constraint
-- triggers on recurring_rule_courts AFTER DELETE/UPDATE and on recurring_session_rules AFTER INSERT/UPDATE OF is_active)

-- D-72 version + updated_at (both tables) and the bump trigger (one function, excluded keys via TG_ARGV)
-- D-73 create_key + UNIQUE (team_id, create_key) (both tables)
-- D-74 game_sessions.deadline_is_default boolean NOT NULL DEFAULT true + trigger game_sessions_fill_default_deadline
--      (BEFORE INSERT OR UPDATE; when deadline_is_default AND starts_at IS NOT NULL:
--       cancellation_deadline := starts_at - interval '48 hours'; when starts_at IS NULL keep the writer's value)
-- D-75 game_sessions_guard_update (matrix, closed immutability, keys immutable)
-- D-76 session_courts_guard_closed
-- D-77 C-SSE-1 CHECKs (skill fees, flat fee = final rate) for status IN ('PUBLISHED','COMPLETED')
-- D-78 session_courts: UNIQUE (session_id, court_identifier) + identifier trimmed CHECK
-- D-79 content CHECKs: location/address trimmed lengths (location 1..255, address 1..500) and all amounts ≥ 0 on both
--      tables; rules: default_max_players > 0, default_reserved_seats BETWEEN 0 AND default_max_players,
--      by_skill fees present when BY_SKILL_LEVEL, fee_flat present when FLAT (a rule is always "publishable")
-- D-80 auto_enrol_required / auto_enrolled_at + CHECK + idx_game_sessions_auto_enrol_pending
-- D-81 recurring_session_rules.payout_notice_window date (one admin email per rule per window, claimed in the
--      instance transaction)
-- D-82 recurring_session_rules.materialised_version integer, materialised_at timestamptz
```

**Trigger firing order on `game_sessions`** (same-event BEFORE triggers fire in name order; recorded in the migration header and ADR 0019, because renaming one changes behaviour):
`game_sessions_derive_instants` (D-08) → `game_sessions_fill_default_deadline` (D-74) → `game_sessions_guard_update` (D-75) → `game_sessions_paid_requires_payout` (D-49) → `game_sessions_version_bump` (D-72).

**Draft ledger rows** (Source column abbreviations as in the ledger header; "SSE Arch" = this document):

| ID | Objects | Change | Source |
|---|---|---|---|
| D-70 | `column:recurring_session_rules.starts_on` `constraint:recurring_session_rules_anchor_weekday` `constraint:recurring_session_rules_until_after_anchor` | `starts_on date NOT NULL`: the series' first date and recurrence anchor (Fortnightly parity, Monthly, "first date"). Its weekday must equal `day_of_week`, and `recur_until` (inclusive) cannot precede it. Dev rows backfilled (D-83). Reversible | SSE Arch SA-8; task conflict 9; Algorithm A1 |
| D-71 | `table:recurring_rule_courts` `function:recurring_rule_courts_present` `constraint:uq_recurring_rule_courts_identifier` `constraint:uq_recurring_rule_courts_position` `trigger:recurring_rule_courts_present` | Per-court template of a series (identifier, start, end, position), copied into `session_courts` at materialisation. Deferred check: an active rule has at least one court at COMMIT. `default_court_count`, `default_start_time` and `default_end_time` are kept as the editor's bulk-fill values; the template is authoritative | SSE Arch SA-8; conflict 9 |
| D-72 | `column:game_sessions.version` `column:game_sessions.updated_at` `column:recurring_session_rules.version` `column:recurring_session_rules.updated_at` `function:sessions_bump_version` `trigger:game_sessions_version_bump` `trigger:recurring_session_rules_version_bump` | Optimistic-concurrency stamp bumped by the DB on any content change (derived and bookkeeping columns excluded), so every writer, including billing and raw SQL, invalidates stale editors. Writers cannot set `version` | SSE Arch SA-6; AC-ERROR-7; conflict 9 |
| D-73 | `column:game_sessions.create_key` `column:recurring_session_rules.create_key` `constraint:uq_game_sessions_team_create_key` `constraint:uq_recurring_session_rules_team_create_key` | Create idempotency: a per-render UUID. A replay finds the existing row (the D-46 shape, plain UNIQUE, NULLs distinct) | SSE Arch SA-6; spec Invocation Method |
| D-74 | `column:game_sessions.deadline_is_default` `function:game_sessions_fill_default_deadline` `trigger:game_sessions_fill_default_deadline` | While true, the DB keeps `cancellation_deadline = starts_at − 48 h` (absolute) whenever courts or the date move the start. False = an admin-entered deadline, stored as entered and held by `game_sessions_deadline_before_start`. The 48 h literal is tested equal to `CANCELLATION_DEADLINE_DEFAULT_HOURS` | SSE Arch SA-8; AC-HAPPY-11; platform-foundation Algo (48 h) |
| D-75 | `function:game_sessions_guard_update` `trigger:game_sessions_guard_update` `constraint:game_sessions_status_transition` `constraint:game_sessions_closed_immutable` `constraint:game_sessions_keys_immutable` | Lifecycle matrix (DRAFT→PUBLISHED, DRAFT→CANCELLED, PUBLISHED→CANCELLED, PUBLISHED→COMPLETED). COMPLETED and CANCELLED rows immutable (`recurring_rule_id` may only become NULL). `team_id` immutable, and `date` immutable on rule instances | SSE Arch SA-7; AC-ERROR-6; C-SSE-2; ADR 0017 C-GAME-1 pt 3 |
| D-76 | `function:session_courts_guard_closed` `trigger:session_courts_guard_closed` `constraint:session_courts_closed_immutable` | No court insert, update or delete on a COMPLETED or CANCELLED session. Locks the session `FOR NO KEY UPDATE` so a raw write racing a completion sees it | SSE Arch SA-7; AC-ERROR-5; C-GAME-1 pt 3 |
| D-77 | `constraint:game_sessions_skill_fees_when_live` `constraint:game_sessions_flat_fee_when_live` | PUBLISHED or COMPLETED: all three skill fees present for BY_SKILL_LEVEL; for FLAT, `fee_flat` present and equal to the final rate (`custom ?? calculated`, when set) | registration C-SSE-1; AC-ERROR-4; AC-VERIFY-1 |
| D-78 | `constraint:uq_session_courts_session_identifier` `constraint:session_courts_identifier_trimmed` | One court identifier per session, trimmed and 1 to 50 characters | conflict 9 |
| D-79 | `constraint:game_sessions_location_trimmed` `constraint:game_sessions_address_trimmed` `constraint:game_sessions_amounts_non_negative` `constraint:recurring_session_rules_location_trimmed` `constraint:recurring_session_rules_address_trimmed` `constraint:recurring_session_rules_amounts_non_negative` `constraint:recurring_session_rules_capacity` `constraint:recurring_session_rules_fees_complete` | Content limits enforced in the DB (AC-ERROR-2 "a raw-SQL write fails with 23514"). A rule's fees are always complete for its structure | AC-ERROR-2; AC-HAPPY-3; P1 |
| D-80 | `column:game_sessions.auto_enrol_required` `column:game_sessions.auto_enrolled_at` `constraint:game_sessions_auto_enrol_stamp` `index:idx_game_sessions_auto_enrol_pending` | Durable auto-enrol obligation per session: set for materialised instances (and one-offs, per the journey ruling), stamped only when a real allocator ran. Closes the rollout gap and the crash gap between publish and enrolment | SSE Arch SA-5; conflict 1; ADR 0017 C-SKL-1 pt 5 |
| D-81 | `column:recurring_session_rules.payout_notice_window` | Durable claim for "at most one banking-missing email per rule per window" (`singletonKey` only dedupes concurrent jobs) | ADR 0016 recurrence contract pt 5; SSE Arch SA-1 |
| D-82 | `column:recurring_session_rules.materialised_version` `column:recurring_session_rules.materialised_at` | The rule version the last completed per-rule run applied. The series page shows "We're adding the sessions…" while it trails `version` | SSE Arch SA-1; spec Success Criteria |
| D-83 | `cleanup:recurring_session_rules` `cleanup:game_sessions` `cleanup:session_courts` | Dev/test rows reshaped before the CHECKs (anchor backfill, trimmed text, duplicate court identifiers renumbered, negative amounts → 0). New CHECKs added `NOT VALID` then `VALIDATE`, with an upgrade test seeded with every old shape (db-derived-flags-and-gates rule). Not reversible (data), schema reversible | db-derived-flags-and-gates rule |
| D-84 (reserved) | `column:recurring_session_rules.publish_lead_days` | Only if Algorithm A2 chooses a per-series lead time | Algorithm A2 |

### SA-9: Series-edit execution

**Chosen**: Option 8A, as specified in Q8.

Target set and statuses are parameters fed by the Algorithm's A3/A4 ruling:
- `targets = future, not overridden, status ∈ S`, where S is `{DRAFT}` for A3(a), `{DRAFT, PUBLISHED without active registrations}` for A3(b), `{DRAFT, PUBLISHED}` for A3(c).
- A4 actions per instance are `update`, `delete DRAFT`, `cancel PUBLISHED`, or `leave`.
- The response returns `{ updated, skippedEdited, skippedClosed, cancelled, deletedDrafts, version }` for AC-HAPPY-7's copy.

### SA-10: Module layout, structural tests

**Chosen**: the plan's layout, confirmed with these additions:
- `series.ts` (series use cases, split from `service.ts` to keep each file focused)
- `auto-enrol.ts`, `locks.ts`, `tx.ts`
- `jobs/recurrence-rule.ts`, `jobs/session-auto-enrol.ts`
- `apps/api/src/session-allocator.ts`
- `sessions/boundaries.test.ts`

Structural tests:
- (i) Gate-before-lock query recorder (Q7).
- (ii) `session-allocator.test.ts` (wiring).
- (iii) `boundaries.test.ts` (imports only public surfaces; nothing writes `registrations`, through a grep for `registrations` in `modules/sessions/**` except type-only port files).
- (iv) Lock-order grep: `forUpdate()` on `teams` never appears in `modules/sessions/**`.

### Rationale (overall)
- **SA-1 and SA-3** remove the two ways the spec defaults could lose work: dropped `exclusive` enqueues, and an allocator failure undoing materialisation. They put the system on patterns already proven in this codebase (sweep plus per-unit job; the ADR 0015 port).
- **SA-2** extends the canonical order at the one place every new path fits (rules sit between `teams` and `team_members`). Rule locks stay off the registration hot path, and ADR 0016's promise that publishing never waits on moderation or banking holds.
- **SA-4 and SA-5** make the allocator seam fail-safe in both directions. A forgotten wiring is a compile error or a failing structural test. A missing allocator leaves a durable, self-healing obligation, not a silent loss.
- **SA-6 and SA-7** keep P1: the DB bumps versions, enforces the matrix and immutability, and guards courts. TS shapes the error and owns only time-relative policy, as ADR 0017 already established.
- **SA-8** answers every gap with the smallest durable column, following existing ledger patterns (D-46, D-54, D-42, D-53).

### Trade-offs Accepted
- **A millisecond window (or a crash-length window) in which a player could register before auto-enrollees are placed** (SA-3). Accepted: publishes are at 03:00, the marker bounds the window, and lock order plus allocator isolation matter more.
- **Selection at first enrolment, not at publish, for deferred sessions** (SA-5). This is a documented, bounded exception to ADR 0017 point 7.
- **A series edit holds up to about 13 session locks for one transaction** (SA-9). Each is held tens of milliseconds, in a fixed order, with the rule lock serialising competitors. C-SSE-5 ("briefly") is honoured per session. Registration's 2 s timeout and retry absorb the wait.
- **One more queue and one more job type** (`recurrence-rule`, `session-auto-enrol`). Accepted for correctness (no dropped runs) and for one auto-enrol code path.
- **The 48 h default lives in SQL and TS.** A parity test pins it (D-74).
- **Existing tests change** (Amendments): the paid-session matrix publish suite, `insertSession` defaults, and DRAFT → COMPLETED shortcuts in skill-levels and banking tests. The new CHECKs and matrix legitimately refuse those shapes.

---

## Sequence diagrams

### S1. Per-rule run: one instance, then its auto-enrol follow-up
```
recurrence-rule job        DB                                   publish-gate        port (allocator)
   │ runNow=clock.now() once; window, windowStart; dates=recurrenceDates(rule, window)
   │ existing = SELECT date FROM game_sessions WHERE rule=$r AND date IN window
   │── BEGIN; SET LOCAL lock_timeout 5s ─────────────►│
   │── SELECT teams KEY SHARE ───────────────────────►│
   │── SELECT rule FOR NO KEY UPDATE (re-read) ──────►│  (series edit waits here, or we wait for it)
   │── checkTeamCanPublishPaidSession ───────────────────────────────►│ (KEY SHARE no-op; reads is_payout_configured)
   │── INSERT game_sessions DRAFT … ON CONFLICT DO NOTHING RETURNING ─►│ (none → skip)
   │── INSERT session_courts FROM recurring_rule_courts ►│ touch → derive instants → fill default deadline
   │   gate ok:   now=clock.now(); UPDATE … SET status PUBLISHED, fee_flat=final WHERE status='DRAFT'
   │   gate refused: claim payout_notice_window; enqueueEmail(trx) per admin
   │── COMMIT ───────────────────────────────────────►│
   │ if published: runSessionAutoEnrol
   │   entries = selectAutoEnrollees(db,{teamId, date})  (no locks)
   │   port.enrols? no → log port_noop (marker stays pending)
   │── BEGIN; SET LOCAL lock_timeout 5s
   │── autoEnrolInSession(ctx,{entries}) ─────────────────────────────────────────────────────►│
   │                                                  │◄── team_members FOR SHARE (each, R16 re-check)
   │                                                  │◄── game_sessions FOR UPDATE; INSERT registrations; emails
   │── UPDATE game_sessions SET auto_enrolled_at=now WHERE status='PUBLISHED' AND auto_enrolled_at IS NULL
   │── COMMIT
```

### S2. Manual publish (API)
```
admin ─POST /publish {expectedVersion}─► service
  s0 = SELECT session (team-scoped, no lock)        → v0 ≠ expected and not already PUBLISHED → 409 session_stale
  BEGIN; SET LOCAL lock_timeout 2s
  lockTeamRow(keyShare)                              -- teams
  assertTeamCanPublishPaidSession(trx, fees(s0))     -- 409 payout_not_configured (draft kept) on refusal
  assertSessionAdmin(actor)                          -- team_members(actor) FOR SHARE
  s = SELECT … FOR UPDATE                            -- game_sessions
  s.version ≠ v0 → 409 session_stale;  now = clock.now();  decideSessionAction('publish', s, now)
  validate courts ≥1, fees complete (C-SSE-1), starts_at > now (409 session_started)
  UPDATE … SET status='PUBLISHED', fee_flat=final WHERE id=$1 AND status='DRAFT'
  if auto_enrol_required: enqueue session-auto-enrol {sessionId} (trx, key session-auto-enrol:<id>)
  COMMIT → 200 { session, version }   log session.published
```

### S3. Capacity raise on a PUBLISHED session (C-SSE-3)
```
BEGIN; SET LOCAL lock_timeout 2s
lockTeamRow(keyShare) → [gate on requested fees if free→paid] → assertSessionAdmin(actor)
SELECT … FROM game_sessions WHERE id=$1 FOR UPDATE           -- D-14
version check; now=clock.now(); starts_at > now else 409 session_started
UPDATE game_sessions SET max_players, reserved_seats, …, updated_at=now   (trigger bumps version)
if (max − reserved) increased: allocator.promoteWaitlist({trx, now, log}, {teamId, sessionId})   -- exactly once
COMMIT
```

### S4. Series edit with propagation (SA-9)
```
BEGIN; SET LOCAL lock_timeout 2s
lockTeamRow(keyShare)
[gate(new fees) if propagation can make a PUBLISHED instance paid]            -- before every game_sessions lock
SELECT rule FOR NO KEY UPDATE; version ≠ expected (and change ≠ no-op) → 409 series_stale
assertSessionAdmin(actor)
UPDATE rule …; replace recurring_rule_courts
targets = SELECT … FROM game_sessions WHERE rule=$r AND date >= today AND NOT is_instance_overridden
          AND status = ANY($S) ORDER BY date, id        (no lock: candidate list)
for t in targets:  SELECT … FOR UPDATE; re-check predicate under lock (skip → counted); apply A3/A4 action;
                   replace courts; if PUBLISHED and public capacity rose → promoteWaitlist
enqueue recurrence-rule {ruleId, trigger 'rule_updated'} (trx)
COMMIT → 200 { rule, version, updated, skippedEdited, skippedClosed, cancelled, deletedDrafts }
```

---

## Race matrix for AC-VERIFY-3 (`sessions-races.int.test.ts`)

Real connections. Order is set with `waitForLockWaiters` on `pg_stat_activity` (no sleeps). Every row runs in both orders. A global assertion: no `40P01`, and no retry was logged (`session.lock_retry` absent).

| # | Holder (opens first, holds) | Contender | Order A outcome | Order B outcome |
|---|---|---|---|---|
| R1 | Materialiser instance tx (rule held) | Series edit, same rule | Edit waits, then counts and propagates to the new instance | Materialiser waits, re-reads the rule, creates the date with new defaults or skips it |
| R2 | Materialiser draft retry (session held) | Instance edit of that draft | Edit waits, then 409 `session_stale` (version bumped by publish) | Retry waits, sees `is_instance_overridden`, skips |
| R3 | Materialiser run A on `(rule, date)` | Run B, same `(rule, date)` (bypassing stately, called directly) | B waits on the rule, then the insert finds a conflict → skip; one row | symmetric |
| R4 | Manual publish (gate KEY SHARE held) | Banking removal (API) | Removal → 409 `banking_in_use` | Publish → 409 `payout_not_configured`, draft unchanged |
| R5 | Materialiser publish (gate held) | Banking removal (raw SQL) | Removal → 23514 `teams_banking_in_use` | Materialiser → DRAFT plus notice, no trigger error |
| R6 | Registration stand-in (session `FOR UPDATE`) | Capacity edit | Edit waits, then commits and calls `promoteWaitlist` once (recording double) | Stand-in waits, then sees the new capacity |
| R7 | Series edit (rule plus instance locks) | Registration stand-in on one instance | Stand-in waits ≤ the edit; both commit | Edit waits on that instance, then continues |
| R8 | Instance edit (session held) | Series edit touching it | Series edit skips it, counted `skippedEdited` | Instance edit → 409 `session_stale` |
| R9 | Series edit | Series edit, same rule | Second → 409 `series_stale` | symmetric |
| R10 | Auto-enrol follow-up (allocator stand-in holding member SHARE plus session) | Cancel | Cancel waits, then commits; registrations untouched | Follow-up gets `session_not_open` for all, marker not stamped on CANCELLED |
| R11 | Admin Auto Enroll save (member row NKU) | Auto-enrol follow-up | Follow-up waits (≤5 s), then the re-check refuses (`auto_enroll_changed` in the double) | Save waits for the follow-up |
| R12 | Demotion of the acting admin (`team_members` UPDATE) | Instance edit by that admin | Edit waits, then 403 `forbidden` | Demotion waits for the edit |
| R13 | Billing stand-in (session `FOR UPDATE`, status COMPLETED) | Raw court UPDATE | Court write waits, then 23000 `session_courts_closed_immutable` | Completion waits; court change committed before COMPLETED |
| R14 | Series end (rule held) | Materialiser instance for a date after the new `recur_until` | Materialiser waits, then skips the date | End waits; instance created, then handled by A4 on end |

Also pinned (not a race): `stately` trailing run. Start a per-rule job, enqueue two edits while it is active, and assert exactly one trailing job ran and applied the latest version. Failure-into-retry with a queued sibling: assert the instances still converge.

---

## Implementation Guidelines

1. **Prologue discipline**: every transaction in `modules/sessions/**` goes through `runSessionTransaction(policy, fn)` and the helpers in `locks.ts`, in the order of SA-2. No raw `forUpdate()` on `teams`. `lockRule` only from `series.ts` and `materialise.ts`. Session locks only through `lockSession`.
2. **Read the clock after the locks** for every decision and stamp. The job's `runNow` is used only for the window and `windowStart`.
3. **The gate first, then the version re-check after the session lock.** Never call the gate after a `game_sessions` lock. Never infer "paid" yourself: use `isPaidSession` through the gate only.
4. **Instance insert shape**: DRAFT, then courts, then guarded publish, in that order (ADR 0016 "Database backstops"). Never `INSERT … status 'PUBLISHED'`.
5. **Allocator calls only through the port**, with `ctx.now` read after the caller's locks. `promoteWaitlist` only when public capacity rose on a PUBLISHED, not-started session. `autoEnrolInSession` only from `runSessionAutoEnrol`, never with empty entries, never while holding a rule or session lock.
6. **Failure classification** (one helper, `classifySessionError`):
   - Transient: `40P01`, `55P03`, `40001`, class `08`, unknown non-PG errors.
   - Permanent: 23xxx and 22xxx.
   - Logged as `sqlState` plus `errorCode`, never as `code`, never with the message (it may echo row data).
7. **Factories and fixtures** (in Phase 1, the same commit as the migration):
   - `insertSession` gains `status`, `calculatedRate` and complete-fee defaults per structure.
   - New `advanceSessionTo(db, id, status)` walks the legal path (`DRAFT → PUBLISHED → COMPLETED`).
   - New `insertRule` and `insertRuleCourt`.
   - `paid-session-matrix.ts` gains `publishable` (insertable and C-SSE-1 complete), and `insertable` now excludes negative fees.
   - `team-banking-gate.int.test.ts` publishes `publishable` rows and expects the D-77 CHECK for the rest.
   - Skill-levels and banking tests replace raw `DRAFT → COMPLETED` with `advanceSessionTo`.
   - Grep every `UPDATE game_sessions SET status` in `apps/api/test/**` first (db-derived-flags-and-gates rule).
8. **`recurrence-rule` handler** mirrors `member-banned.ts`: strict payload parse, re-read by id, outcome log, error classification. **Sweep** mirrors `skill-progression.ts`: keyset pages, abort checks, summary log.
9. **Copy of the 48 h default**: `fill_default_deadline` uses a literal `interval '48 hours'`. `sessions-schema.int.test.ts` asserts it equals `CANCELLATION_DEADLINE_DEFAULT_HOURS`.
10. **Coverage include**: `apps/api/src/modules/sessions/**`, `packages/shared/src/sessions/**`, `apps/api/src/session-allocator.ts`.

---

## Validation Checklist

- [x] Meets all system requirements (AC-HAPPY, AC-ASYNC, AC-ERROR, AC-VERIFY, AC-INTEGRATION mapped in Amendments)
- [x] Respects technical constraints (pg-boss policy semantics, READ COMMITTED, existing trigger order, producer and worker roles)
- [x] Addresses non-functional requirements (P1 triggers and CHECKs; P5 in-transaction enqueue; P7 env horizon; C-SSE-5 short locks; 5 s visibility)
- [x] Technically feasible (pg-boss 12.35 `stately` verified in `types.d.ts`; Kysely `Transaction<DB>`, `log` hook)
- [x] Risks identified and acceptable (table below)
- [x] Complies with Guiding Principles. P1: DB matrix, immutability, version, default deadline, C-SSE-1. P2: Money only. P3: UTC stamps, LocalDate window. P5: enqueue in the transaction. P7: horizon from env. The time-relative "not started" rules in TS are not a P1 deviation (ADR 0017 point 1 precedent: no `now()` in SQL rules; state invariants stay in the DB)
- [x] Respects established patterns (module shape, ports with a safe default, transition table plus fixture, claim under lock, sweep plus per-unit job)
- [x] Observability architecture defined (events, spans, reserved metrics)
- [x] Trace context propagation across all boundaries (HTTP header; `_meta.traceparent` for each enqueue; in-process port)
- [x] Logging strategy consistent with observability requirements (structured JSON, ids only, `errorCode`)
- [x] Metrics follow naming conventions (`_total`, `_seconds`, low-cardinality labels)

## Risk Assessment

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| `stately` edge: an active job failing into `retry` while a sibling is queued behaves unexpectedly | L | M | Integration test pins it. The daily sweep plus idempotent per-rule run converge anyway |
| New CHECKs and the matrix break existing raw-SQL tests and fixtures (insertable matrix rows, DRAFT → COMPLETED shortcuts) | H | M | Guideline 7: factory options and `advanceSessionTo` in the Phase 1 commit. Grep first. Never weaken a test |
| Trigger firing order silently changes if a trigger is renamed | L | H | Order documented in the migration and ADR 0019. `sessions-schema.int.test.ts` asserts `pg_trigger` names in order |
| Registration wires its adapter in one entrypoint only | M | H | One composition function, required deps, `session-allocator.test.ts` |
| Pending auto-enrol accumulates unnoticed (no-op port in staging) | M | L | Daily `port_noop` logs. An operator SQL check on the pending index. Self-heals at registration's deploy |
| Series edit with many instances hits the 2 s lock timeout behind registrations | L | M | Bounded by the horizon. Whole-transaction retry (3 attempts). 500 `OUTAGE_MESSAGE` after that. Admin retries |
| Gate staleness between the unlocked fee read and the lock | L | H | Post-lock version re-check (Q7). Fees can't change without a bump |
| Default-deadline trigger fights an explicit deadline after a court move | L | M | `deadline_is_default = false` once an admin sets one. CHECK `deadline_before_start` refuses invalid → 422 (AC-HAPPY-11) |
| A cross-team id passed to a sessions route | L | H | Every repo query filters `team_id = :teamId` from the path. Same 403 for unknown or other-team ids (AC-ERROR-8) |
| Registration's contracts shift before its build | M | M | `sessions-contracts.int.test.ts` header lists C-SSE-1..5, C-SAE (R16) and the port. Registration's build gate re-runs it |

---

## Draft outline: ADR 0019 (`docs/adr/0019-session-scheduling-engine.md`)

1. **Status, Task, Source**: this document, the Algorithm and Journey docs, the task file's Creative Reconciliation, migration `20261020000100000_session_scheduling.sql` (D-70..D-83). Numbering note: registration-and-waitlist keeps ADR 0018 and D-62..D-66 plus its R2 index.
2. **Context**: producer of sessions for registration, billing and dashboards. The allocator does not exist yet. Cross-feature contracts already written.
3. **Decision**:
   - 3.1 Lifecycle matrix and ownership (COMPLETED is billing's). Cancel and edits only before `starts_at`. Closed immutability including courts.
   - 3.2 Canonical lock order extended with `recurring_session_rules`, and lock modes per path.
   - 3.3 Materialiser: sweep fan-out, `recurrence-rule` (`stately`), `session-auto-enrol`. Instance transaction shape. Failure classification. Boot sweep.
   - 3.4 Optimistic concurrency (`version`, `expectedVersion`, no-op saves) and `create_key`.
   - 3.5 Default deadline in the DB. C-SSE-1 CHECKs. Trigger firing order.
   - 3.6 Auto-enrol placement (follow-up only) and the marker. The rollout gap and deferred-selection semantics.
4. **Contracts honoured** (each with the code or test that proves it):
   - registration: C-SSE-1 (D-77, publish copy), C-SSE-2 (D-75, `instants_when_live`), C-SSE-3 (S3, recording double), C-SSE-4 (cancel), C-SSE-5 (session lock usage); C-SAE-1/2 as amended by R16 (SA-3/SA-4); C-ALL-1 (SA-2).
   - ADR 0016: gate contract points 1 to 5 (Q7 recorder test), lock rules (never `teams FOR UPDATE`, no `teams` lock after a session lock), recurrence contract points 1 to 6 (SA-1, D-81), manual publish and `returnTo` hand-off.
   - ADR 0017: C-SKL-1 points 1, 3 (R16 shape), 5 (follow-up), 6 (one-off ruling from the Journey doc); C-GAME-1 point 3 (D-75, D-76).
   - platform-foundation: `fee_other` default `LEAST`, DST input `reject` with options (Algorithm), `DERIVED` = compatible, 48 h deadline (D-74), whole-dollar `CEIL` rate, the `recurrence-materialisation` slot.
5. **Contracts offered**:
   - `SessionAllocatorPort` (exact TS above), `noopSessionAllocator`, the injection point `createSessionAllocator` in `apps/api/src/session-allocator.ts`, required `AppDeps` and `RegisterJobsOptions` fields, `enrols` semantics.
   - Admin route namespace `/teams/:teamId/sessions*` and `/teams/:teamId/session-series*` (TEAM_ADMIN). Reserved for registration: `GET /teams/:teamId/sessions/upcoming`, `/teams/:teamId/sessions/:sessionId/registration*`.
   - Acknowledgement of the slot contract: this feature adds nothing to the player page.
   - Obligations on billing: COMPLETED through the matrix, `version` bump automatic, closed rows immutable (billing adds any COMPLETED-time column to the guard's allowlist in its own ADR).
   - Reserved names: queues `recurrence-rule` and `session-auto-enrol`; singleton keys `recurrence-rule:<ruleId>` and `session-auto-enrol:<sessionId>`; email key `payout-missing:<ruleId>:<windowStart>`; metric names.
6. **Alternatives considered**: 1A to 1C, 2B to 2D, 3A and 3C, rollout options (a), (b) and (d), 5B to 5D, 6B to 6D, 7A and 7B, 8B and 8C.
7. **Consequences**: two encodings of the matrix plus the fixture; the 48 h literal in SQL; changed test fixtures; the auto-enrol window between commits; registration's build gate re-runs `sessions-contracts.int.test.ts`.

---

## Hand-offs / assumptions to reconcile

| # | With | Assumption made here | If the sibling rules otherwise |
|---|---|---|---|
| H1 | Algorithm A1 | The anchor `starts_on` falls on `day_of_week` for every frequency (CHECK D-70). `day_of_week` uses PostgreSQL `dow` numbering (0 = Sunday), and the shared recurrence function must use the same | If Monthly means "same day of month", drop or relax `recurring_session_rules_anchor_weekday` for MONTHLY |
| H2 | Algorithm A2, conflict 5 | Horizon from `RECURRENCE_HORIZON_DAYS`. `windowStart` = `window.start` (a LocalDate), stored in `payout_notice_window`. Lead time is either global env or per-series column D-84 | The claim column stores whatever LocalDate identifies the window. Add D-84 only if per-series |
| H3 | Algorithm A3 | Propagation is synchronous in the series-edit transaction (SA-9) for any target set S. Free-to-paid propagation to PUBLISHED instances is gated up front, and a refusal refuses the whole edit | If A3 wants a partial save on gate refusal ("save rule, leave PUBLISHED instances free, count them"), only the 409 branch changes |
| H4 | Algorithm A4 | `date` is immutable for rule instances (D-75). DRAFT instances may be deleted. A CANCELLED instance's `(rule, date)` row blocks recreation (`ON CONFLICT DO NOTHING`, no resurrection) | If instances may move dates, an `occurrence_date` key column replaces `date` in `uq_game_sessions_rule_date` (new ledger row) |
| H5 | Algorithm A5 | `fee_flat = custom ?? calculated` whenever FLAT and live (CHECK D-77), so a rate edit on a PUBLISHED session updates `fee_flat` in the same statement | If A5 says "copy only at publish and never after", the CHECK must narrow (I recommend keeping it: AC-INTEGRATION-1 requires equality after a rate change) |
| H6 | Algorithm, conflict 10 | Any fee-edit policy works. "Refuse once active registrations exist" counts `registrations` **after** the session `FOR UPDATE` (stable: only the allocator writes them, under the same lock) | none |
| H7 | Algorithm, conflict 6 | No new per-court disambiguation column. `session_courts` stays local `time` and the derive trigger is unchanged | A disambiguation column changes D-08 and needs its own ledger row and billing sign-off |
| H8 | User Journey, conflict 3 | `auto_enrol_required = true` for every materialised instance, so a manual publish of a recurring draft also auto-enrols (via the `session-auto-enrol` job). One-offs: `false` unless the Journey rules otherwise | Only the default of `auto_enrol_required` on one-off creates changes. The mechanism is the same |
| H9 | User Journey C2 | "We're adding the sessions in this series" shows while `materialised_version < version` (or is NULL). Series save returns the propagation counts | none |
| H10 | registration-and-waitlist | Ships `createRegistrationsSessionAllocator(allocator)` (name `registrations`, `enrols: true`), edits `createSessionAllocator`, re-runs `sessions-contracts.int.test.ts`. Its "Assumed output 4" signature text is superseded by the allocator doc's `(ctx, { teamId, sessionId })`. `autoEnrolInSession` is never called with empty entries | Raise at registration's build gate |
| H11 | wallet-and-akahu-billing | COMPLETED only through the matrix. The version bump is automatic. Any column billing must write on a COMPLETED row needs the D-75 allowlist widened in billing's migration | Billing's ADR |
| H12 | UI/UX (wave 2) | All writes send `expectedVersion`, and creates send `createKey`. A 409 `session_stale` / `series_stale` body carries the current row. A started PUBLISHED session is read-only | none |

---

## Next Steps

1. Orchestrator reconciles H1 to H9 with the Algorithm and Journey docs and records the binding outcome in the task file's Creative Reconciliation.
2. Phase 1: migration D-70..D-83 (+ D-84 if needed), types regen, shared `lifecycle.ts`, the transitions twin and fixture, factory and fixture updates (Guideline 7), trigger-order test.
3. Phase 2: `allocator-port.ts`, `session-allocator.ts` plus wiring in `main.ts` and `worker.ts`, `locks.ts`, `tx.ts`, the sessions service and routes with version and create-key guards, the query-recorder gate test for the manual paths.
4. Phase 3: registry entries, the sweep, `recurrence-rule` and `session-auto-enrol` handlers, `materialise.ts`, `auto-enrol.ts`, series propagation, boot enqueue, CLI trigger for `recurrence-rule`.
5. Phase 4: race matrix R1 to R14 plus the stately test, log-field assertions, `sessions-contracts.int.test.ts` (with the pending → done marker proof).
6. Phase 6: ADR 0019 from the outline above.

---

## Amendments to the task file

(Proposed. The orchestrator applies them after reconciliation; this document does not edit the task file.)

**Acceptance criteria**
- **AC-HAPPY-4**: add "`expectedVersion` is checked under the session lock. A replayed publish of a PUBLISHED session is a 200 no-op. When `auto_enrol_required`, a `session-auto-enrol` job is enqueued in the publish transaction."
- **AC-HAPPY-5**: the enqueued job is `recurrence-rule` (`stately`, key `recurrence-rule:<ruleId>`), not a second `recurrence-materialisation` job. The waiting copy is driven by `materialised_version < version`.
- **AC-HAPPY-7**: the series save is one transaction, and the response carries `updated`, `skippedEdited`, `skippedClosed`, `cancelled`, `deletedDrafts`. A free-to-paid propagation onto PUBLISHED instances is gated before any session lock and, if refused, answers 409 `payout_not_configured` with nothing saved (pending H3).
- **AC-HAPPY-11**: "the default deadline is maintained by the DB (`deadline_is_default`, D-74)". An explicit deadline sets the flag false.
- **AC-ASYNC-1**: "the run" is a per-rule job. The sweep logs `session.recurrence.sweep_completed { rulesScanned, rulesEnqueued, pendingAutoEnrolEnqueued }`. Each per-rule job logs `session.recurrence.run_completed` with `ruleId`, `created`, `published`, `savedAsDraft`, `draftsRetried`, `autoEnrolled`, `failed`. The sweep also runs once at worker boot.
- **AC-ASYNC-2**: replace "in the same transaction when the session row was inserted in it" with "always in a follow-up transaction that holds no lock on the session or its rule (inline in the materialiser after the instance commits; via `session-auto-enrol` for API publishes)". Add: "the marker `auto_enrolled_at` is stamped in that transaction only when the port's `enrols` is true; with the no-op port it stays pending and the port logs `session.auto_enrol.port_noop`; the allocator is not called when `selectAutoEnrollees` returns no one."
- **AC-ASYNC-3**: "at most one email per rule per window" is guaranteed by the durable claim `recurring_session_rules.payout_notice_window` (D-81) in the instance transaction, not by `singletonKey` alone.
- **AC-ERROR-5**: "every edit (not only capacity) of a PUBLISHED session after `starts_at` → 409 `session_started`". Court-write immutability on COMPLETED and CANCELLED is `session_courts_closed_immutable` (D-76).
- **AC-ERROR-6**: the DB error is SQLSTATE `23000`, constraint `game_sessions_status_transition` (team-management precedent). The fixture is `apps/api/test/fixtures/session-transitions.ts`.
- **AC-ERROR-7**: optimistic concurrency uses `version` / `expectedVersion` on **every** write (edit, publish, cancel, series edit, series end). A 409 returns the current row. A change-nothing save is a no-op.
- **AC-VERIFY-1**: list the new objects D-70..D-83. Add the trigger-order assertion, the upgrade test for D-83, and the 48 h parity assertion.
- **AC-VERIFY-2**: "structural test" = the runtime query-order recorder (Q7). Paths include series propagation onto PUBLISHED instances. Add the post-lock version re-check.
- **AC-VERIFY-3**: lock order is `teams → recurring_session_rules → team_members → game_sessions → …`. The race matrix is R1 to R14 plus the `stately` trailing-run test.
- **AC-VERIFY-6**: add `session.stale_refused`, `session.recurrence.sweep_completed`, `session.recurrence.rule_skipped`, `session.auto_enrol.failed`, `session.lock_retry`.
- **AC-INTEGRATION-2**: the recording double is injected through `createSessionAllocator`'s required-dependency seam. Add: "with `enrols: false` the session stays pending; switching to an `enrols: true` double and running the sweep enrols it exactly once (marker stamped)."
- **New AC-ASYNC-5 (MUST)**: *Pending auto-enrol is reconciled.* Given PUBLISHED future sessions with `auto_enrol_required` and no `auto_enrolled_at` (no-op port, or a follow-up that failed), when the sweep runs (03:00, worker boot or CLI), then a `session-auto-enrol` job is enqueued per session. With a real allocator each is enrolled once and stamped. Sessions that are past, cancelled or already stamped are not offered.
- **New AC-VERIFY-9 (MUST)**: *The allocator seam cannot be half-wired.* `buildApp` and `registerJobs` require `sessionAllocator`. `main.ts` and `worker.ts` both obtain it from `createSessionAllocator` (`session-allocator.test.ts`). `modules/sessions/**` never writes `registrations` (`boundaries.test.ts`).

**Plan and roadmap**
- New source files:
  - `apps/api/src/modules/sessions/{series,auto-enrol,locks,tx}.ts`
  - `apps/api/src/modules/sessions/boundaries.test.ts`
  - `apps/api/src/jobs/{recurrence-rule,session-auto-enrol}.ts`
  - `apps/api/src/session-allocator.ts` plus test
  - `packages/shared/src/sessions/lifecycle.ts` (replaces the planned `lifecycle-matrix.ts`; the hand-written fixture moves to `apps/api/test/fixtures/session-transitions.ts`)
  - `apps/api/test/helpers/query-recorder.ts`
- Extend:
  - `apps/api/src/worker.ts` (boot sweep enqueue, `sessionAllocator`) and `apps/api/src/main.ts` (`sessionAllocator`)
  - `apps/api/src/cli.ts` (`jobs trigger recurrence-rule '<json>'`)
  - `jobs/registry.ts` (two queues)
  - `test/helpers/{factories,app-deps,worker-fixture}.ts`
  - `test/fixtures/paid-session-matrix.ts` (`publishable`) and `test/integration/team-banking-gate.int.test.ts`
  - skill-levels and banking integration tests (`advanceSessionTo`)
- Phase 1 gains the fixture and factory changes and the trigger-order test. Phase 2 gains the port composition and the query recorder. Phase 3 gains both new queues, the boot sweep and the marker. Phase 4 gains R1 to R14 and AC-ASYNC-5 and AC-VERIFY-9.
- Test count: about +10 (race rows R10 to R14, stately, marker reconciliation, wiring, trigger order, 48 h parity), so the target becomes about 115.
- Risk table: replace "Auto-enrol gap … Creative B3 decides" with "Resolved: per-session marker plus boot and daily sweep (SA-5)". Add the "existing raw-SQL tests break on new CHECKs" row (H, M; Guideline 7).
- Build gate: re-check that D-70..D-84 are still free on `main` against registration's reservation. Re-read registration's allocator signature against SA-4.
