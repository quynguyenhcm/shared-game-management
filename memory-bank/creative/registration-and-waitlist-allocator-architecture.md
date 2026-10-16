# Architecture Decision: Registration Allocator, Ban Handler and Cross-Feature Contracts

**Created**: 2026-10-16
**Status**: DECIDED
**Decision Type**: Architecture
**Task**: `registration-and-waitlist` (Level 4). Spec: `memory-bank/tasks/registration-and-waitlist.md` on `feature/registration-and-waitlist` (approved 2026-10-14; the 40 ACs are the contract, amended only where listed in [Spec Amendments](#spec-amendments)).
**Resolves**: Creative Q2 (seat allocation and promotion concurrency), Q4 (real ban handler and reconciliation sweep), Q6 (cross-feature contracts), plus the lifecycle migration (ledger D-47 onwards).
**Not decided here**: Q1 (promotion rule) and Q3 (fee semantics) belong to the algorithm creative doc. This design assumes the spec defaults: **first-fit** promotion, and liability decided once at withdrawal in `withdrawal_fee_due` (true iff LATE and the withdrawal promoted nobody). The allocator isolates both rules behind pure functions (`decideAllocation`, `decideLiability`), so the algorithm doc can change them without touching the concurrency design. Q5 (page, copy) belongs to the journey and UI/UX docs.
**Basis**: `main` at `e19fc12` (platform-foundation, auth-and-user-roles, team-management merged). Principles P1–P7 (`memory-bank/systemPatterns.md` on `main`). Binding prior decisions: ADR 0004 (pg-boss), ADR 0012 (fee snapshot and guests), ADR 0015 (ban seam, gate, lock order, handler contract, sweep obligation), ledger D-10..D-14 (D-14 locking contract) and D-40..D-46 (`db/schema-deviations.md`). Code read: `modules/teams/{membership,ban-hook,service,repo,transitions,membership-errors}.ts`, `jobs/{member-banned,bootstrap,registry,schedules,send-email}.ts`, `worker.ts`, `app.ts`, `cli.ts`, `lib/jobs/jobs.ts`, `lib/clock.ts`, migrations `…0600000`, `…0700000`, `…0900000`, `…1000000`, `20261013000100000`, `test/helpers/factories.ts`, `test/integration/{teams-ban-seam,registrations-guests}.int.test.ts`. Learned rules: `logging-redaction-global`, `review-process-plan-claims`, `testing-injected-clock`, `job-queues-pgboss`, `testing-integration-db-isolation`.

---

## Context

### System Requirements
- Every seat change (register, re-register, withdraw, leave waitlist, promote, ban withdrawal, auto-enrol, capacity-edit promotion) is exact under concurrency. Nothing is overbooked, no party is split, positions are never renumbered, and the waitlist invariant holds after every commit (AC-HAPPY-1..9, AC-VERIFY-3/4, AC-INTEGRATION-1).
- Public capacity is `max_players - reserved_seats`. A party of 1–3 is confirmed or waitlisted whole.
- Debt gate: 3 or more `OVERDUE` payments across all of the user's teams block registration (AC-ERROR-1).
- Membership gate: `assertApprovedMember` runs inside the registration transaction before any session lock (ADR 0015, AC-ERROR-7, AC-INTEGRATION-2).
- Ban: replace the no-op `MemberBannedHandler` with a real one that follows the ADR 0015 contract, and ship the reconciliation sweep (AC-HAPPY-10, AC-ERROR-9, AC-ASYNC-2/3).
- Promotion emails are enqueued in the promoting transaction (AC-ASYNC-1, P5).
- Billing hand-off: `listBillableRegistrations` returns exactly what billing must charge, and this feature writes no money rows (AC-INTEGRATION-3, AC-VERIFY-10).
- An exported allocator API is the only coupling to session-scheduling-engine (capacity edits) and skill-levels-and-auto-enroll (auto-enrol).

### Technical Constraints
- **D-14 is binding.** Every enqueue, withdraw and promote first runs `SELECT … FROM game_sessions WHERE id = $1 FOR UPDATE` under READ COMMITTED. Enqueue is `coalesce(max(queue_position), 0) + 1`, promotion scans by ascending `queue_position`, and positions are never renumbered. The partial unique index `uq_registrations_waitlist_position` turns a path that skips the lock into a 23505.
- **Lock order is binding (ADR 0015):** `teams → team_members → game_sessions → registrations → registration_guests → payments`. No `SERIALIZABLE`, no advisory locks (AC-VERIFY-3).
- `UNIQUE(session_id, user_id)` (D-11): one row per member per session for its whole life, so re-registration reuses the row.
- `registration_guests` has a deferred trigger that keeps `guest_count` equal to the guest rows (D-13). Guest rows are `ON DELETE RESTRICT` from `payment_line_items`.
- `payments` cannot be written by this feature: it needs an Akahu link token, GST snapshot and line items (`payment_lines_match_header`).
- The worker's Kysely pool is `max: 2` today (`worker.ts`: "only the health probe uses it"). The member-banned handler and `auth-cleanup` already use it.
- Global redaction (`logging-redaction-global`): a log field named exactly `code`, or any key ending in `token`, is redacted. Error codes are logged as `errorCode` or `sqlState`.
- `pgboss.job` payloads are retained for 7 days, so they carry ids only.
- Existing fixtures that the migration touches: `insertRegistration` inserts `WITHDRAWN` rows with no stamps (`registrations-guests.int.test.ts:42`); `registrations-guests.int.test.ts:183` promotes with a raw `UPDATE` and no `promoted_at`; the ban-seam stand-in withdraws with a raw `UPDATE` and no stamps; `insertSession` creates a **DRAFT** session dated **2026-10-07** (in the past relative to a system clock).

### Non-Functional Requirements
- Register and withdraw p95 under 300 ms at 100 registrations per session (spec NFR). The session lock is held for about 10 short statements.
- Integrity (P1): the database backstops capacity, transitions, stamps, positions and guest counts.
- Async (P5): emails and ban side effects go through pg-boss inside the domain transaction.
- Time (P3): one `clock.now()` per operation, passed down (learned rule `testing-injected-clock`).
- Privacy (NZ Privacy Act 2020): ids only in logs and job payloads; a withdrawer never learns who was promoted.
- No new environment variables (spec NFR, P7).

---

## Component Analysis

### Core Components

| Component | Purpose | Responsibilities |
|-----------|---------|------------------|
| `modules/registrations/allocator.ts` | **The only writer of `registrations.status`, `queue_position` and the lifecycle stamps** | `createAllocator(deps)` returns `registerInSession`, `autoEnrolInSession`, `withdrawFromSession`, `promoteWaitlist`. Takes the D-14 lock, reads state, calls the pure decision, writes through `repo.ts`, enqueues promotion emails, returns typed outcomes |
| `modules/registrations/allocation.ts` | Pure decisions (no I/O) | `decideAllocation` (place or refuse a party, plan promotions; the rule comes from the algorithm doc), `decideLiability` (fee-due rule from the algorithm doc) |
| `modules/registrations/transitions.ts` | TypeScript half of the state machine | `decideTransition(action, current)` → next status or refusal. Mirrors trigger `registrations_guard_update` through one shared matrix fixture |
| `modules/registrations/deadline.ts` | Early or late classification | `classifyWithdrawal(now, cancellationDeadline)` → `EARLY` iff `now <= deadline` (UTC instants) |
| `modules/registrations/tx.ts` | Transaction runner for this module's own entry points | `runAllocatorTransaction(db, policy, work)`: opens a transaction, `SET LOCAL lock_timeout`, retries the whole transaction on 40P01/55P03 |
| `modules/registrations/repo.ts` | SQL | Session lock, state read, row writes, guest replace, debt count, read model, billing hand-off query |
| `modules/registrations/service.ts` + `routes.ts` | HTTP use cases | Maps allocator outcomes to `AppError`s and `registration.*` logs. Read model for `GET …/registration` |
| `modules/registrations/emails.ts` | Promotion email | Builds the message and `idempotencyKey`, calls `enqueueEmail(jobs, msg, { trx })` |
| `modules/registrations/billing-handoff.ts` | Billing contract | `listBillableRegistrations(db, sessionId)` |
| `modules/registrations/ban-handler.ts` | Real `MemberBannedHandler` | `createRegistrationsBanHandler({ db, jobs, clock, webBaseUrl })`: selection by current state, one allocator transaction per session, error classification |
| `modules/registrations/reconcile.ts` + `jobs/ban-reconcile.ts` | Reconciliation sweep | Finds BANNED memberships that still hold active future registrations and re-enqueues `member-banned` with `enqueueMemberBanned` |
| DB migration `<utc>_registration_lifecycle.sql` | P1 backstops | Enum, columns, CHECKs, transition trigger, deferred capacity trigger, partial index (D-47..D-51) |

### Component Interactions

```
HTTP register/withdraw
  routes (requireTeamRole MEMBER, guard before validation)
    -> service -> runAllocatorTransaction(db, HTTP_POLICY) ── per attempt, one transaction:
         SET LOCAL lock_timeout
         allocator.registerInSession / withdrawFromSession
            [register] debt count (payments, no lock)
            [register] assertApprovedMember  (team_members FOR SHARE)
            lockSession  SELECT … FROM game_sessions WHERE id=$s AND team_id=$t FOR UPDATE
            readActive   registrations WHERE session_id=$s AND status IN (CONFIRMED, WAITLISTED)
            decideTransition + decideAllocation (+ decideLiability)      <- pure
            write requester row; replace guests (re-registration)
            promote(plan)  -> UPDATE … WAITLISTED->CONFIRMED, promoted_at=now
                           -> emails.enqueuePromotion(trx) per promoted row
       COMMIT -> deferred triggers: guest count (D-13), capacity (D-50)
    -> service logs registration.* (ids only) and answers

Worker member-banned job (jobs/member-banned.ts validates, re-reads membership)
  -> ban-handler.handle(event)
       now = clock.now(); select sessions by current state (no lock)
       for each session in (starts_at, id) order:
          runAllocatorTransaction(db, JOB_POLICY):
             allocator.withdrawFromSession({ cause: 'ban' })   (same core as HTTP)
       classify failures -> rethrow transient | NonRetryableJobError

Cron 05:30 Pacific/Auckland (+ once at worker boot) registration-ban-reconcile
  -> reconcile.findBannedWithActive(now) -> one transaction: enqueueMemberBanned(...) per membership

session-scheduling-engine capacity edit (its transaction):  lock session FOR UPDATE -> UPDATE capacity
  -> allocator.promoteWaitlist(ctx, { teamId, sessionId })
skill-levels-and-auto-enroll materialiser (its transaction):
  -> allocator.autoEnrolInSession(ctx, { teamId, sessionId, userIds in assignment order })
wallet-and-akahu-billing post-game (its transaction): lock session FOR UPDATE -> COMPLETED
  -> listBillableRegistrations(trx, sessionId) -> payments + line items
```

The allocator never opens, commits or configures a transaction it was handed. Only this module's own entry points (HTTP service, ban handler) use `runAllocatorTransaction`. A caller from another feature owns its transaction, its lock timeout and its retry.

---

## Options Explored

### Q2: Seat allocation and promotion concurrency

#### Option 2A: D-14 session row lock + one allocator + pure decision + DB backstops (spec default)
- **Description**: Every seat-changing path goes through `allocator.ts`, which takes `game_sessions … FOR UPDATE` under READ COMMITTED, reads the session's active registrations, asks the pure `decideAllocation` for a plan, and writes it. The database refuses any state the plan should never produce: a deferred capacity trigger, a transition trigger, stamp CHECKs and the existing unique indexes. `SET LOCAL lock_timeout` plus a bounded whole-transaction retry on 40P01/55P03.
- **Architecture Diagram**:
  ```
  T1 register ──lock S──read──decide──write──COMMIT(deferred checks)
  T2 withdraw ─────────wait S─────────────────────lock S──read(sees T1)──decide──write──COMMIT
  ```
- **Pros**:
  - Fixed by D-14 and ADR 0015, and already the pattern the contract test exercises.
  - The session is the natural unit of contention (all seats of one session), and sessions never block each other.
  - READ COMMITTED takes a fresh snapshot per statement, so a waiter sees the winner's rows as soon as it gets the lock. No serialization failures and no retry storms.
  - The pure decision is table-testable, and the SQL is a thin applier.
- **Cons**:
  - Two encodings of the transition rules (SQL trigger and TS table), as in team-management.
  - Correctness depends on every path taking the lock. This is mitigated by the unique position index, the capacity trigger, which also takes the lock, and a structural test.
- **Technical Fit**: High. **Complexity**: Medium. **Scalability**: High for this domain (contention is per session, at most a few dozen writers).

#### Option 2B: SERIALIZABLE transactions, no explicit lock
- **Description**: Run every allocator transaction under SERIALIZABLE and retry on 40001.
- **Pros**: No lock-order reasoning; Postgres detects anomalies.
- **Cons**:
  - Forbidden by AC-VERIFY-3.
  - `assertApprovedMember` assumes READ COMMITTED (under SERIALIZABLE a concurrent ban surfaces as 40001).
  - A 20-way last-seat race becomes about 19 aborts, each retried. That is worse p95 than queueing on a lock.
  - Predicate locks on `max(queue_position)` cause false-positive aborts.
- **Technical Fit**: Low. **Complexity**: Medium. **Scalability**: Medium.

#### Option 2C: Per-session advisory lock
- **Description**: `pg_advisory_xact_lock(hashtext(session_id))` instead of the row lock.
- **Pros**: Doesn't touch the `game_sessions` row, so it never blocks session edits.
- **Cons**:
  - Forbidden by AC-VERIFY-3 and contradicts D-14.
  - Invisible to session-scheduling-engine's capacity edit, which locks the row. A capacity edit and a registration would not serialise.
  - Hash collisions; lock order is not expressible.
- **Technical Fit**: Low. **Complexity**: Low. **Scalability**: High.

#### Option 2D: Denormalised `game_sessions.seats_taken` counter + CHECK
- **Description**: A trigger maintains `seats_taken` on the session, with `CHECK (seats_taken <= max_players - reserved_seats)`.
- **Pros**: O(1) seat reads; the capacity rule is a plain CHECK.
- **Cons**:
  - The CHECK lives on `game_sessions`, so an admin who cuts capacity below `seats_taken` is refused. The spec requires that a cut is allowed and never demotes anyone.
  - Every registration write updates `game_sessions`, which fires `game_sessions_derive_instants` (it re-reads courts) on every seat change.
  - Two sources of truth for seats.
- **Technical Fit**: Low. **Complexity**: Medium. **Scalability**: High.

#### Q2 sub-decision: capacity backstop

| Option | Behaviour | Admin capacity cut | Verdict |
|---|---|---|---|
| **B1 Deferred constraint trigger `AFTER INSERT OR UPDATE OF status, guest_count … WHEN (NEW.status = 'CONFIRMED')`, row level, `DEFERRABLE INITIALLY DEFERRED`; the function locks the session `FOR UPDATE`, sums `1 + guest_count` over CONFIRMED rows and compares with public capacity** | Checked at COMMIT on the final state, so the order of statements inside a transaction (withdraw then promote, update then guests) doesn't matter. Same shape as D-13 and D-43 | Never blocked: the trigger sits on `registrations`, not on `game_sessions`. The `WHEN` clause means a withdrawal or a waitlist exit from an over-capacity session (after a cut) still commits, because only a write that makes a row CONFIRMED is checked | **Chosen** |
| B2 Immediate `AFTER ROW` trigger | Checked after each statement, so it sees intermediate states. A future "promote then withdraw" ordering would fail spuriously | Same as B1 with the `WHEN` clause | Rejected: order-dependent |
| B3 Statement-level trigger with transition tables | One check per statement per session | Same | Rejected: cannot be deferred; same order issue as B2 |
| B4 None (lock only) | Relies on code | n/a | Rejected: violates P1 |

The trigger takes `FOR UPDATE` on the session itself. In correct paths it already holds that lock, so this costs nothing. If a buggy path skipped the lock, two such transactions serialise at COMMIT and the second one counts the first one's committed rows (plpgsql takes a fresh snapshot per statement under READ COMMITTED), so the backstop is race-proof rather than advisory. This is the same technique as D-43 (`team_members_enforce_last_admin` locks the team row).

#### Q2 sub-decision: transition trigger + TS table
Option 3B from team-management: trigger `registrations_guard_update` (BEFORE UPDATE) + `transitions.ts` + one shared matrix fixture (`test/fixtures/registration-transitions.ts`) run against both. The alternative, an append-only event log with a derived status, was rejected: it duplicates the row that billing's FK targets, and it is out of proportion for three states.

The trigger enforces only what code must never do:

| Rule | Constraint name (23000) |
|---|---|
| Status moves allowed: `WAITLISTED→CONFIRMED`, `CONFIRMED|WAITLISTED→WITHDRAWN`, `WITHDRAWN→CONFIRMED|WAITLISTED`; same-status updates allowed | `registrations_status_transition` |
| `session_id`, `team_id`, `user_id` immutable | `registrations_keys_immutable` |
| Never renumber: a row that stays WAITLISTED keeps its `queue_position` | `registrations_queue_position_stable` |
| `guest_count` changes only on `WITHDRAWN → CONFIRMED|WAITLISTED` (no guest edits while active, per scope) | `registrations_guest_count_frozen` |
| `WAITLISTED→CONFIRMED` sets `promoted_at`; `WITHDRAWN→CONFIRMED` leaves it NULL | `registrations_promotion_stamp` |

INSERT is constrained only by the CHECKs, as in D-42, so fixtures can insert any valid state.

#### Q2 sub-decision: re-registration

| Option | Verdict |
|---|---|
| **R1 Reuse the row**: one `UPDATE` sets `status`, `queue_position`, `guest_count`, `registered_at = now`, and clears `withdrawn_at`, `withdrawal_kind`, `promoted_at` and `withdrawal_fee_due`. Then `DELETE` the old guest rows and `INSERT` the new ones. The deferred D-13 trigger checks the count at COMMIT | **Chosen** (forced by D-11) |
| R2 Delete and re-insert the row | Rejected: breaks history and is impossible once billed (line items RESTRICT) |
| R3 An `attempt` column and `UNIQUE(session_id, user_id, attempt)` | Rejected: changes D-11 and billing's `UNIQUE(registration_id)` key semantics |

Deleting guest rows is safe because payments exist only after the session ends, and registration closes at `starts_at`. If that ever changes, the RESTRICT FK refuses the delete (23503), which is the right failure.

**Open for the reconciliation step:** the spec (AC-HAPPY-8) resets `withdrawal_fee_due` on re-registration. A liable LATE withdrawer whose seat a newcomer then fills could re-register, land on the waitlist and erase the liability. That is a fee-semantics question (algorithm Q3). The `registrations_fee_due_only_late` CHECK below assumes the spec's rule. If the algorithm doc keeps the liability, the fix is to refuse re-registration while `withdrawal_fee_due = true` or to move liability out of the row. Either changes this CHECK, so it must be settled before Phase 1.

#### Q2 sub-decision: lock timeout and retry

| Option | Verdict |
|---|---|
| **L1 `SET LOCAL lock_timeout` as the first statement + whole-transaction retry on 40P01 (deadlock) and 55P03 (lock not available), with jittered backoff** | **Chosen** |
| L2 `FOR UPDATE NOWAIT` with an immediate "busy" answer | Rejected: a 20-way race would refuse 19 people who would have been served in about 300 ms |
| L3 No timeout | Rejected: a stuck session-edit transaction would pin HTTP workers and pool connections indefinitely |

Policies are code constants, like queue retry limits and cron times. They are behaviour, not deployment configuration (P7 unaffected):
- `HTTP_POLICY = { lockTimeoutMs: 2000, attempts: 3, backoffMs: [25, 75] (±50% jitter) }`
- `JOB_POLICY = { lockTimeoutMs: 5000, attempts: 3, backoffMs: [100, 400] }`

`now` is read once per operation, before the first attempt, and reused on every retry. Deadline classification is then the instant the player acted, and a lock wait cannot turn an EARLY withdrawal into a LATE one. Exhausted retries on HTTP surface as 500 (`OUTAGE_MESSAGE`, AC-ERROR-8) with a `registration.lock_retry_exhausted` warn. No new error code. With the lock order respected, 40P01 should not occur; it is retried defensively, and a test asserts no retries in the race suite.

**Debt read placement**: the first statement after `SET LOCAL`, before the gate and with no lock, as AC-VERIFY-3 specifies. It reads `payments` with no row lock, so it cannot join a lock cycle. The `OVERDUE` status changes at most daily, so taking it at the start of the transaction is accurate enough.

**Only `promoteWaitlist` promotes**: every allocator mutation ends with the same internal `promote(ctx, lockedSession, state)`, and `promoteWaitlist` is its exported wrapper. A structural test (AC-VERIFY-3 extension) asserts that `updateTable('registrations')` appears only in `modules/registrations/repo.ts`, and that repo's promotion writer is imported only by `allocator.ts`. Because every mutation ends with `promote`, the first-fit invariant is self-healing: if a caller ever forgot to call `promoteWaitlist`, the next operation on that session restores it.

### Q4: Ban handler and reconciliation sweep

#### Option 4A: one job per membership; handler loops sessions, one transaction each; continue on error; sweep re-enqueues per membership (spec default)
- **Description**:
  - The existing `member-banned` job calls the handler.
  - The handler selects the member's active registrations in the team's future PUBLISHED sessions (current state, one `now`). It then processes each session in `(starts_at, id)` order in its own `runAllocatorTransaction(JOB_POLICY)`, calling `allocator.withdrawFromSession({ cause: 'ban' })`, which re-checks session status and `starts_at` under the lock.
  - Failures are collected per session. Processing continues, and the outcome is classified at the end.
  - The daily sweep finds BANNED memberships that still hold active future registrations and re-enqueues `member-banned` with the same payload and `singletonKey`.
- **Pros**:
  - Exactly ADR 0015 points 1–7. Reuses the job, payload, singleton and contract test.
  - One failing session doesn't hold back the member's other sessions.
  - The sweep and live bans share one idempotent path.
- **Cons**:
  - A transient failure on one session re-runs the whole job. This is harmless: completed sessions select nothing and return `affected` 0.
  - A permanent failure on one session fails the job even though others succeeded. Operators see `hook_failed` and the sweep retries daily.
- **Technical Fit**: High. **Complexity**: Low. **Scalability**: High (a member has a handful of future sessions).

#### Option 4B: fan-out to one job per (membership, session)
- **Description**: The handler enqueues a child job per session on a new queue (`registration-ban-withdraw`, `singletonKey = ban-withdraw:<membershipId>:<sessionId>`).
- **Pros**: Per-session retries and failure visibility.
- **Cons**:
  - A new queue, payload and singleton scheme, and two levels of idempotency.
  - `affected` no longer means anything at the parent, which breaks the contract test's `affected` assertions.
  - The sweep would need to know which level to re-enqueue.
  - More `pgboss.job` rows for no correctness gain.
- **Technical Fit**: Medium. **Complexity**: Medium. **Scalability**: High.

#### Option 4C: one transaction for all of the member's sessions
- **Description**: Lock every affected session (in `(starts_at, id)` order), withdraw and promote, then commit once.
- **Pros**: All or nothing.
- **Cons**:
  - Violates ADR 0015 point 2 (one session per transaction).
  - Holds many session locks at once, which slows registrations on all of them.
  - A failure on one session undoes the rest.
- **Technical Fit**: Low. **Complexity**: Low. **Scalability**: Medium.

#### Sweep options

| Option | Verdict |
|---|---|
| **S-a Cron `registration-ban-reconcile` (`30 5 * * *`, Pacific/Auckland, queue `exclusive`) enqueues `member-banned` per membership with `enqueueMemberBanned` (same payload and `singletonKey`); also enqueued once at worker boot; on demand via `pnpm run jobs:trigger registration-ban-reconcile`** | **Chosen** |
| S-b The sweep withdraws inline (calls the handler directly) | Rejected: a long-running sweep job, bypasses the per-membership singleton (could run concurrently with a live job), duplicates logging |
| S-c Daily cron only (no boot run) | Rejected: leaves the deploy window open up to 24 h. ADR 0015 names that window as a reason for the sweep |

`30 5 * * *` is after `auth-cleanup` (05:00), outside 02:00–02:59, and `assertNoDstHourFirings` covers it. The boot enqueue lives in `worker.ts` after `registerJobs`, not in `registerJobs`, so integration tests that call `registerJobs` never get an unexpected sweep.

**Sweep query and index** (D-51, one partial index serves both the sweep and the handler):
```sql
-- reconcile.findBannedWithActive($now, $limit)
SELECT tm.id, tm.team_id, tm.user_id, tm.banned_by, tm.banned_at
  FROM team_members tm
 WHERE tm.status = 'BANNED'
   AND EXISTS (SELECT 1
                 FROM registrations r
                 JOIN game_sessions s ON s.id = r.session_id
                WHERE r.team_id = tm.team_id AND r.user_id = tm.user_id
                  AND r.status IN ('CONFIRMED', 'WAITLISTED')
                  AND s.status = 'PUBLISHED' AND s.starts_at > $now)
 ORDER BY tm.banned_at, tm.id
 LIMIT $limit;              -- 1000; the rest is picked up by the next run, because handled members drop out

-- ban-handler selection (same predicate, one member)
SELECT r.session_id, s.starts_at
  FROM registrations r JOIN game_sessions s ON s.id = r.session_id
 WHERE r.team_id = $team AND r.user_id = $user AND r.status IN ('CONFIRMED', 'WAITLISTED')
   AND s.status = 'PUBLISHED' AND s.starts_at > $now
 ORDER BY s.starts_at, s.id;

CREATE INDEX idx_registrations_active_member
  ON registrations (team_id, user_id, session_id)
  WHERE status IN ('CONFIRMED', 'WAITLISTED');
```
Rejected index alternatives:
- A full `(team_id, user_id, status)` index: indexes every WITHDRAWN row forever, for no query.
- No index: `idx_registrations_user (user_id, registered_at DESC)` works, but its cost grows with a member's lifetime history.

`team_members WHERE status = 'BANNED'` is a sequential scan of a small table once a day. No index is needed; `idx_team_members_team_status_role` is the upgrade path if that changes.

**Sweep transaction**: one transaction per run reads the candidates and calls `enqueueMemberBanned(jobs, payload, { trx })` for each. Reusing the team module's helper keeps payload validation and the singleton key in one place. On the `exclusive` queue, a membership whose job is already queued or active returns `null` and is counted as `alreadyQueued`. A `failed` job does not block a new one (proven by the existing seam test's operator re-run case). A row that fails `MemberBannedPayload` validation (e.g. `banned_by` became NULL after an account deletion) is skipped and counted, never allowed to abort the sweep.

**Error classification** (`ban-handler.ts`, `classifyBanError`):

| Class | Errors | Handling |
|---|---|---|
| Transient | SQLSTATE `40P01`, `55P03`, `40001`, `57014`, `53300`, class `08` (connection), pool/connection timeouts, `AbortError` from the job signal, any unknown error | Rethrow a plain `Error` after all sessions are attempted. pg-boss retries with backoff (retryLimit 3); after that the job is `failed` and the sweep re-enqueues it |
| Permanent | SQLSTATE class `23` (`registrations_within_capacity`, transition and stamp triggers, unique, FK), `RegistrationInvariantError` (e.g. a selected row whose `team_id` disagrees with its session) | `NonRetryableJobError` if no transient failure occurred in the same run; the job ends `failed` with `team.member.banned.hook_failed` |

Mixed failures throw transient, so the retry re-attempts the transient session and the permanent one fails again, harmlessly. The handler checks `context.signal.aborted` between sessions and stops with a transient error on shutdown.

**Re-check under the lock**: `withdrawFromSession` returns `{ ok: false, reason: 'session_not_open' | 'not_registered' }` when the session moved to COMPLETED or CANCELLED, started, or the row was already withdrawn by a racing player or a redelivery. The handler counts it as skipped (`registration.ban.session_skipped`, `reason`), not as a failure.

**Ban success message**: no architectural need to change it. Release is eventual (seconds normally, up to one sweep in the worst case), so any wording the journey or UI docs choose must be future tense ("will be cancelled"), never past tense ("have been cancelled"). The confirmation prompt wording in AC-HAPPY-10 already satisfies this.

### Q6: Cross-feature contracts

#### Option 6A: in-process TypeScript API taking the caller's transaction; contracts recorded in ADR 0016 and proven by contract tests (spec default)
- **Description**: Other features import `createAllocator` and `listBillableRegistrations` and call them inside their own transactions. The contract is the function signatures plus the lock-order and status preconditions below, and it is re-checked at the build gate.
- **Pros**:
  - One implementation of the seat rules.
  - Callers keep their own atomicity: capacity edit and promotion, or materialisation and auto-enrol, commit together.
  - The pattern matches `assertApprovedMember`.
- **Cons**: Callers must respect the lock order. This is mitigated by documentation, the allocator's own `trx.isTransaction` assertion, and lock-order tests in each consuming feature.
- **Technical Fit**: High. **Complexity**: Low. **Scalability**: High.

#### Option 6B: plpgsql API (`register_in_session(...)`, `promote_waitlist(...)`)
- **Pros**: Callable from any client; the lock order lives in one SQL place.
- **Cons**:
  - Duplicates the pure decision in SQL. The table-driven tests and `decideAllocation` property tests would not cover the real path.
  - The email enqueue (pg-boss) cannot happen from SQL.
- **Technical Fit**: Low. **Complexity**: High. **Scalability**: High.

#### Option 6C: event coupling (capacity edit enqueues `session-capacity-changed`; a worker promotes)
- **Pros**: Loose coupling.
- **Cons**:
  - Promotion becomes eventual. Seats sit empty and a newcomer can take a seat ahead of the waitlist between the edit and the job, which violates FIFO/first-fit.
  - AC-ASYNC-1 expects `promoteWaitlist` in the capacity-change transaction.
- **Technical Fit**: Medium. **Complexity**: Medium. **Scalability**: High.

#### Q6 sub-decision: auto-enrolled member with 3 or more OVERDUE payments

| Option | Verdict |
|---|---|
| **Skip (no row) and report `overdue_payments` to the caller** | **Chosen.** Auto-enrol registers on the member's behalf, so the gate's purpose (no new charges for debtors) applies equally. A skipped member can still register by hand once paid |
| Waitlist them | Rejected: promotion doesn't re-check debt, so they would get in through the back door |
| Ignore the gate for auto-enrol | Rejected: contradicts workflows §1 |

---

## Evaluation Matrix

Scores 1 (poor) to 5 (best).

| Criteria | 2A lock+allocator | 2B SERIALIZABLE | 2C advisory | 2D counter |
|----------|---|---|---|---|
| Scalability | 4 | 3 | 4 | 4 |
| Maintainability | 4 | 3 | 2 | 2 |
| Performance (p95 under a 20-way race) | 4 | 2 | 4 | 4 |
| Security / integrity (P1) | 5 | 4 | 3 | 3 (blocks capacity cuts) |
| Observability | 4 | 3 | 2 | 4 |
| Implementation cost | 4 | 3 | 4 | 2 |
| Fits binding contracts (D-14, ADR 0015, AC-VERIFY-3) | 5 | 1 | 1 | 2 |

| Criteria | 4A per membership | 4B fan-out | 4C one transaction |
|----------|---|---|---|
| Scalability | 4 | 5 | 3 |
| Maintainability | 5 | 3 | 4 |
| Performance (lock hold on others) | 5 | 5 | 2 |
| Integrity | 5 | 5 | 4 |
| Observability | 4 | 5 | 3 |
| Implementation cost | 5 | 2 | 5 |
| Fits ADR 0015 | 5 | 3 | 1 |

| Criteria | 6A TS API | 6B plpgsql | 6C events |
|----------|---|---|---|
| Maintainability | 5 | 2 | 3 |
| Correctness (FIFO, atomicity) | 5 | 4 | 2 |
| Testability | 5 | 2 | 3 |
| Implementation cost | 5 | 2 | 3 |

---

## Observability Architecture

### Logging
- **Library**: the existing pino logger (`lib/logger`). HTTP paths log through `request.log` (carries `traceId`/`spanId`); worker paths through the job context logger (CONSUMER span mixin).
- **Format**: structured JSON with `traceId`, `spanId`, `service`, `version` (existing).
- **Events** (AC-VERIFY-6 names win; see amendment A9). Fields are ids, enums and counts only:

| Event | Level | Fields |
|---|---|---|
| `registration.created` | info | `teamId`, `sessionId`, `userId`, `registrationId`, `status`, `partySize`, `reRegistration`, `source` (`player`/`auto_enrol`) |
| `registration.withdrawn` | info | `teamId`, `sessionId`, `userId`, `registrationId`, `withdrawalKind`, `feeDue`, `wasConfirmed`, `promotedCount` |
| `registration.promoted` | info | `teamId`, `sessionId`, `registrationId`, `userId`, `cause` (`withdrawal`/`ban`/`capacity`/`register`) |
| `registration.refused` | info (warn for `forbidden`) | `teamId`, `sessionId`, `userId`, `reason` |
| `registration.lock_retry` | warn | `path`, `attempt`, `sqlState` |
| `registration.lock_retry_exhausted` | warn | `path`, `attempts`, `sqlState` |
| `registration.invariant_violation` | error | `teamId`, `sessionId`, `sqlState`, `constraint` |
| `registration.ban.session_skipped` | info | `teamId`, `userId`, `sessionId`, `reason` |
| `registration.ban.session_failed` | warn or error | `teamId`, `userId`, `sessionId`, `sqlState`, `permanent` |
| `registration.ban_reconcile.completed` | info | `scanned`, `enqueued`, `alreadyQueued`, `skipped`, `truncated` |

- Never logged: email, full name, guest `display_name`, team name, `ban_reason`, amounts. Error codes go in `sqlState`/`reason`, **never `code`** (global redaction key). No new redaction key is needed. Tests assert the logged fields (learned rule `logging-redaction-global`).
- **Configuration**: existing `LOG_LEVEL`, `LOG_FORMAT`, `LOG_OUTPUT`, `LOG_FILE_PATH`.

### Distributed Tracing
- **SDK**: OpenTelemetry (existing `lib/telemetry`); W3C Trace Context.
- **Service Boundaries**:

  | From | To | Protocol | Propagation Method |
  |------|-----|----------|-------------------|
  | web Server Action | API register/withdraw | HTTP | `traceparent` header (existing `api-client.ts`) |
  | API transaction | `send-email` (promotion) | pg-boss | `payload._meta.traceparent` (existing `jobs.enqueue`) |
  | ban transaction (teams) | `member-banned` | pg-boss | `_meta.traceparent` (existing) |
  | `member-banned` CONSUMER span | `send-email` (promotion after a ban) | pg-boss | `_meta.traceparent` from the active consumer span |
  | cron `registration-ban-reconcile` | `member-banned` | pg-boss | root span per sweep run; re-enqueued jobs carry its trace, so a handled backfill links to its sweep |
  | session-scheduling-engine / auto-enrol transactions | allocator | in-process | caller's active span |

- **Spans**: `RegistrationAllocator.register|withdraw|promote|autoEnrol` internal spans with attributes `registration.session_id`, `registration.outcome`, `registration.retry_attempts`; `RegistrationBanHandler.session` per session. These are optional in v1 because no exporter is configured by default, but they are named here so later spans are consistent.
- **Sampling**: existing `OTEL_TRACES_SAMPLER_ARG` (1.0 dev, 0.1 prod).

### Metrics
No exporter exists yet (ADR 0013/0015 precedent). Names are reserved so a later exporter stays consistent:
- **Standard**: `http_requests_total{method, route, status_code}`, `http_request_duration_seconds{method, route}`
- **Custom**:
  - `registration_outcomes_total{outcome}`: `confirmed|waitlisted|refused_<reason>`
  - `registration_promotions_total{cause}`
  - `registration_lock_retries_total{path, sql_state}`
  - `registration_ban_sessions_total{result}`: `withdrawn|skipped|failed_transient|failed_permanent`
  - `registration_ban_reconcile_enqueued_total`
- No ids in labels.

### Configuration Variables

| Variable | Purpose | Default |
|----------|---------|---------|
| LOG_LEVEL | Log verbosity | info |
| LOG_FORMAT | Output format | json |
| OTEL_EXPORTER_OTLP_ENDPOINT | Collector endpoint | unset (no export) |
| OTEL_SERVICE_NAME | Service identifier | `sgm-api` / `sgm-worker` |
| OTEL_TRACES_SAMPLER_ARG | Sampling ratio | 1.0 (dev) |
| WEB_BASE_URL | Session link in the promotion email (existing, already validated at boot in both processes) | n/a |

No new variables. Lock-timeout policies, the sweep cron and the sweep `LIMIT` are code constants, like `QUEUES` and `SCHEDULES`.

---

## Decision

### Q2: Seat allocation and promotion concurrency

**Chosen**: Option 2A with B1 (deferred capacity trigger with `WHEN (NEW.status = 'CONFIRMED')` that locks the session), a transition trigger plus a TS table, R1 (re-registration reuses the row and replaces guests), and L1 (`SET LOCAL lock_timeout` plus whole-transaction retry on 40P01/55P03, with `now` read once before the first attempt). The debt read comes first with no lock. `promote` is internal and `promoteWaitlist` is its only export.

#### Rationale
D-14 and ADR 0015 already fix the core, and 2A is the only option consistent with both and with AC-VERIFY-3. The remaining choices are about making the database refuse what the TypeScript decision should never produce (P1), without blocking legitimate admin actions:
- **Deferred capacity trigger**: checks the final state at COMMIT and ignores statement order inside the transaction.
- **`WHEN (NEW.status = 'CONFIRMED')` clause**: an admin capacity cut never wedges a session. Withdrawals still commit, and no new seat is granted until seats taken drop below capacity.
- **Locking inside the trigger**: makes the backstop real against a path that skipped the lock.

The retry wrapper is owned by this module's entry points only, so other features keep full control of their transactions.

#### Allocator transaction shape (normative for every path)
```
0. SET LOCAL lock_timeout = <policy>                       -- runAllocatorTransaction only
1. [register, auto-enrol] debt count:  SELECT user_id, count(*) FROM payments
                                       WHERE status = 'OVERDUE' AND user_id = ANY($users) GROUP BY user_id
2. [register, auto-enrol] assertApprovedMember(trx, teamId, userId) for each member, in caller order
3. SELECT id, team_id, status, starts_at, cancellation_deadline, max_players, reserved_seats,
          pricing_structure, fee_* , location, address
     FROM game_sessions WHERE id = $session AND team_id = $team FOR UPDATE
   -> not found or DRAFT: refusal not_found;  COMPLETED/CANCELLED or now >= starts_at: session_not_open
4. SELECT id, user_id, status, guest_count, queue_position FROM registrations
    WHERE session_id = $session AND status IN ('CONFIRMED','WAITLISTED')        -- idx_registrations_session_status
   (+ the caller's own row by (session_id, user_id) when registering or withdrawing)
5. decideTransition -> decideAllocation -> (withdraw) decideLiability            -- pure
6. write the requester row (one UPDATE or INSERT; stamps from `now`)
7. [re-registration] DELETE registration_guests WHERE registration_id = $id; INSERT new guests
8. promote: UPDATE registrations SET status='CONFIRMED', queue_position=NULL, promoted_at=$now, updated_at=$now
             WHERE id = ANY($plan) AND status='WAITLISTED' RETURNING …          -- guarded; rowcount must match
   then read recipient email, team name and session fields; enqueueEmail(jobs, msg, { trx }) per promoted row
COMMIT -> deferred: registration_guest_count_matches (D-13), registrations_within_capacity (D-50)
```
The allocator never `UPDATE`s `game_sessions`, never reads `team_members` except through the gate, and never touches money tables beyond the step-1 count (AC-VERIFY-10).

Refusals are returned as `{ ok: false, reason }` values, never thrown. Throwing would abort a caller's multi-member transaction (auto-enrol). The HTTP service turns them into `AppError`s. Within the allocator, `assertApprovedMember`'s `forbidden` is caught and returned as a refusal. This is safe because it is a JavaScript throw after a successful query, so the transaction is not aborted.

#### Trade-offs Accepted
- **Two encodings of the transition rules.** Accepted as in team-management; the shared matrix fixture keeps them aligned.
- **The capacity trigger re-sums the session's CONFIRMED parties per CONFIRMED row written.** At most a few rows per transaction and about 100 rows per session.
- **After an admin cut, the session can be over capacity in the database.** This is intended: "lowering capacity never demotes". AC-VERIFY-4's "never exceeds" is amended (A5).
- **`now` is reused across retries**, so a stamp can be up to about 4 s older than COMMIT. The classification instant is the request instant, which is the fair reading of the deadline.

### Q4: Ban handler and reconciliation sweep

**Chosen**: Option 4A with sweep S-a (daily `30 5 * * *` Pacific/Auckland plus once at worker boot plus on demand), the partial index `idx_registrations_active_member`, continue-on-error with transient-first classification, re-check under the lock through the shared allocator core, and a future-tense-only constraint on ban copy.

#### Rationale
4A is ADR 0015 verbatim and keeps the contract test meaningful. Running the ban withdrawal through the same `withdrawFromSession` core as a player's withdrawal guarantees the ban handler promotes exactly like everyone else, with `cause: 'ban'` → `withdrawal_kind 'BANNED'`, no fee, and no email to the banned member. The boot run of the sweep closes the deploy window that ADR 0015 names, without depending on someone remembering a runbook step.

#### Handler shape (normative)
```ts
export function createRegistrationsBanHandler(deps: {
  db: Database;
  jobs: Pick<JobRunner, 'enqueue'>;   // the worker runner: promotion emails in the session transaction
  clock: Clock;
  webBaseUrl: string;                 // email link
}): MemberBannedHandler  // name: 'registrations'
```
1. Read `now = clock.now()` once. Select sessions as above (no lock).
2. For each session in `(starts_at, id)` order:
   - If `signal.aborted`, stop and throw a transient error.
   - `runAllocatorTransaction(db, JOB_POLICY, trx => allocator.withdrawFromSession({ trx, now, log }, { teamId, sessionId, userId, cause: 'ban' }))`.
   - `ok` → `affected += 1`. Refusal → skipped and logged.
   - Error → classify, log `registration.ban.session_failed`, continue.
3. If any session failed, throw: a transient error if any failure was transient, else `NonRetryableJobError`. Otherwise return `{ affected }`.

The handler never writes `team_members`, never reads `ban_reason` and never emails the banned member (ADR 0015 point 4). The job wrapper (`jobs/member-banned.ts`, unchanged) logs `team.member.banned.handled` and `hook_failed`.

#### Trade-offs Accepted
- A permanent failure on one session fails the job even though the member's other sessions succeeded. Operators alert on `hook_failed`; the data is still correct for the sessions that succeeded, and the sweep retries daily.
- The worker restarts trigger a sweep each time. It is idempotent and cheap (one indexed query), so this is accepted.
- The worker pool grows from 2 to 5 connections (implementation guideline 9). The handler can hold a connection through a 5 s lock wait, and the health probe must not starve.

### Q6: Cross-feature contracts

**Chosen**: Option 6A. The exported surface, its preconditions and the consumer obligations below go into ADR 0016 (the same ADR as the algorithm doc's fee rules, which already carries "registration-allocation-and-billing-handoff" in its name). Each consumer's plan must re-check them, and this feature's build gate re-checks them against session-scheduling-engine as merged.

#### Exported API (normative)
```ts
// apps/api/src/modules/registrations/allocator.ts
export interface AllocatorDeps {
  readonly jobs: Pick<JobRunner, 'enqueue'>;  // promotion emails are enqueued on the caller's trx
  readonly webBaseUrl: string;
}
export interface AllocatorContext {
  readonly trx: Transaction<DB>;   // must be a transaction (asserted: trx.isTransaction)
  readonly now: Date;              // the operation's single clock reading
  readonly log: Pick<FastifyBaseLogger, 'info' | 'warn' | 'error'>;
}
export interface GuestInput { readonly sex: Sex; readonly skillLevel: SkillTier; readonly displayName: string | null }
export interface PromotedRegistration { readonly registrationId: string; readonly userId: string; readonly promotedAt: Date }

export type RegisterRefusal =
  'not_found' | 'forbidden' | 'overdue_payments' | 'session_not_open' | 'already_registered' | 'party_exceeds_capacity';
export type RegisterOutcome =
  | { ok: true; registrationId: string; status: 'CONFIRMED' | 'WAITLISTED'; queuePosition: number | null;
      waitlistRank: number | null; reRegistration: boolean; promoted: readonly PromotedRegistration[] }
  | { ok: false; reason: RegisterRefusal; overdueCount?: number; publicCapacity?: number };

export type WithdrawCause = 'player' | 'ban';
export type WithdrawOutcome =
  | { ok: true; registrationId: string; withdrawalKind: 'EARLY' | 'LATE' | 'BANNED'; feeDue: boolean;
      wasConfirmed: boolean; promoted: readonly PromotedRegistration[] }
  | { ok: false; reason: 'not_found' | 'session_not_open' | 'not_registered' };

export interface Allocator {
  registerInSession(ctx: AllocatorContext, input: { teamId: string; sessionId: string; userId: string;
                                                    guests: readonly GuestInput[] }): Promise<RegisterOutcome>;
  autoEnrolInSession(ctx: AllocatorContext, input: { teamId: string; sessionId: string;
                                                     userIds: readonly string[] /* assignment order */ })
    : Promise<readonly { userId: string; outcome: RegisterOutcome }[]>;
  withdrawFromSession(ctx: AllocatorContext, input: { teamId: string; sessionId: string; userId: string;
                                                      cause: WithdrawCause }): Promise<WithdrawOutcome>;
  /** The only promotion entry point. Takes the D-14 lock itself (re-entrant). No-op ([]) unless PUBLISHED and now < starts_at. */
  promoteWaitlist(ctx: AllocatorContext, input: { teamId: string; sessionId: string })
    : Promise<readonly PromotedRegistration[]>;
}
export function createAllocator(deps: AllocatorDeps): Allocator;

// apps/api/src/modules/registrations/allocation.ts (pure, exported for tests and for consumers' previews)
export function decideAllocation(input: {
  publicCapacity: number;
  confirmed: readonly { id: string; partySize: number }[];
  waitlist: readonly { id: string; partySize: number; queuePosition: number }[];   // ascending
  request: { kind: 'register'; partySize: number } | { kind: 'withdraw'; registrationId: string } | { kind: 'rebalance' };
}): AllocationPlan;   // { requester?: …, promote: readonly string[], refusal?: 'party_exceeds_capacity' | 'not_registered' }

// apps/api/src/modules/registrations/billing-handoff.ts
export interface BillableRegistration {
  readonly registrationId: string; readonly userId: string; readonly teamId: string;
  readonly reason: 'CONFIRMED' | 'LATE_WITHDRAWAL';
  readonly registrantSex: Sex; readonly registrantSkillLevel: SkillTier;   // users.sex, team_members.skill_level (current)
  readonly guests: readonly { guestId: string; position: 1 | 2; sex: Sex; skillLevel: SkillTier }[];
}
export function listBillableRegistrations(db: Database | Transaction<DB>, sessionId: string)
  : Promise<readonly BillableRegistration[]>;   // ordered by registered_at, id
```

`autoEnrolInSession` runs steps 1 and 2 for all members first (debt counts in one query, then the gate per member in the given order), then takes the session lock once and places members in order. Gating all members before the session lock keeps the canonical order even when the session row already exists and is committed.

#### Consumer obligations (contract IDs referenced at the build gate)

| ID | Consumer | Obligation |
|---|---|---|
| C-SSE-1 | session-scheduling-engine | **`fee_flat` holds the final per-player FLAT rate** (the admin-edited value), copied from `custom_player_rate ?? calculated_rate_per_player` when the session is published. Registration and billing read only the `fee_*` columns. For BY_SKILL_LEVEL, all three skill fees are NOT NULL when PUBLISHED (a CHECK should be added by that feature, mirroring `game_sessions_by_sex_fees_present`) |
| C-SSE-2 | session-scheduling-engine | PUBLISHED implies at least one court (`starts_at`/`ends_at` set) and `cancellation_deadline <= starts_at` (already CHECKed); lifecycle `DRAFT → PUBLISHED → COMPLETED|CANCELLED` |
| C-SSE-3 | session-scheduling-engine | **A capacity edit on a PUBLISHED session** (raise `max_players`, lower `reserved_seats`) runs, in one transaction: any `teams`/`team_members` locks it needs, then `SELECT … FROM game_sessions WHERE id = $1 FOR UPDATE`, then the `UPDATE`, then `allocator.promoteWaitlist(ctx, { teamId, sessionId })`. A cut never demotes. A capacity edit after `starts_at` is refused by that feature (`promoteWaitlist` is a no-op then anyway) |
| C-SSE-4 | session-scheduling-engine | Cancelling a session leaves its registrations as they are (not billed, because billing only bills PUBLISHED → COMPLETED). No allocator call is needed. If that feature later wants to withdraw them, it needs a new `withdrawal_kind` and must go through the allocator |
| C-SSE-5 | session-scheduling-engine | The `game_sessions` row lock is `FOR UPDATE` (D-14). Session edits hold it briefly; they block registrations on that session for that time |
| C-SAE-1 | skill-levels-and-auto-enroll | Auto-enrol calls `allocator.autoEnrolInSession` once per session, inside the materialisation transaction, **after the session is PUBLISHED** in that transaction (or in an earlier one). It passes members in auto-enrol assignment order. Refusals are per member and never abort the transaction: `overdue_payments` → member skipped (no row) and logged; `forbidden` (no longer APPROVED) → skipped; `already_registered` → skipped (idempotent re-run) |
| C-SAE-2 | skill-levels-and-auto-enroll | Auto-enrolled parties have 0 guests. Auto-enrol never writes `registrations` directly |
| C-BIL-1 | wallet-and-akahu-billing | At session end, billing locks the session `FOR UPDATE`, moves it to COMPLETED, and bills exactly `listBillableRegistrations(trx, sessionId)`, one payment per returned registration (`UNIQUE(registration_id)` is the idempotency key). It uses `guests[].guestId` for `payment_line_items.registration_guest_id` |
| C-BIL-2 | wallet-and-akahu-billing | **The debt gate counts `OVERDUE` across all of the user's teams** (`payments.user_id`, any `team_id`), workflows §1. Only billing's `daily-overdue` job writes `OVERDUE`; a paid payment leaves `OVERDUE`. Keep `idx_payments_user_status` |
| C-BIL-3 | wallet-and-akahu-billing | Fee semantics (who pays after a late withdrawal, partial refill) per ADR 0016 from the algorithm doc. `withdrawal_fee_due` is final once written and is never recomputed by billing |
| C-ALL-1 | every consumer | Lock order `teams → team_members → game_sessions → registrations → registration_guests → payments`; READ COMMITTED; no direct writes to `registrations.status`/`queue_position` |

#### Trade-offs Accepted
- Consumers depend on a TypeScript module, not a versioned API. This is acceptable in a monorepo; the contract tests are the version check.
- `autoEnrolInSession` adds a second entry point beyond the spec's `registerInSession`. It is needed so the gate runs before the session lock for a batch (amendment A10).

### Migration (D-47 onwards)

One reversible migration `db/migrations/<utc>_registration_lifecycle.sql`:

```sql
-- Up Migration
-- D-47
CREATE TYPE withdrawal_kind AS ENUM ('EARLY', 'LATE', 'BANNED');

-- D-48 columns + stamp CHECKs. Backfill first: only test/dev rows can exist (no registration code shipped).
ALTER TABLE registrations
  ADD COLUMN promoted_at        timestamptz,
  ADD COLUMN withdrawn_at       timestamptz,
  ADD COLUMN withdrawal_kind    withdrawal_kind,
  ADD COLUMN withdrawal_fee_due boolean NOT NULL DEFAULT false;
UPDATE registrations SET withdrawn_at = updated_at, withdrawal_kind = 'EARLY' WHERE status = 'WITHDRAWN';
ALTER TABLE registrations
  ADD CONSTRAINT registrations_withdrawal_stamps CHECK (
        (status = 'WITHDRAWN') = (withdrawn_at IS NOT NULL)
    AND (status = 'WITHDRAWN') = (withdrawal_kind IS NOT NULL)),
  ADD CONSTRAINT registrations_fee_due_only_late CHECK (
        NOT withdrawal_fee_due OR (status = 'WITHDRAWN' AND withdrawal_kind = 'LATE')),
  ADD CONSTRAINT registrations_promoted_at_not_waitlisted CHECK (
        status <> 'WAITLISTED' OR promoted_at IS NULL);

-- D-49 transition guard (BEFORE UPDATE), 23000 with the constraint names in the Q2 table.
CREATE FUNCTION registrations_guard_update() RETURNS trigger LANGUAGE plpgsql AS $$ … $$;
CREATE TRIGGER registrations_guard_update
  BEFORE UPDATE OF status, queue_position, guest_count, promoted_at, session_id, team_id, user_id
  ON registrations FOR EACH ROW EXECUTE FUNCTION registrations_guard_update();

-- D-50 capacity backstop, checked at COMMIT, only for writes that make a row CONFIRMED.
CREATE FUNCTION registrations_enforce_capacity() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE cap integer; taken integer;
BEGIN
  SELECT max_players - reserved_seats INTO cap FROM game_sessions WHERE id = NEW.session_id FOR UPDATE;
  IF NOT FOUND THEN RETURN NULL; END IF;
  SELECT coalesce(sum(1 + guest_count), 0) INTO taken
    FROM registrations WHERE session_id = NEW.session_id AND status = 'CONFIRMED';
  IF taken > cap THEN
    RAISE EXCEPTION 'session %: % confirmed seats exceed public capacity %', NEW.session_id, taken, cap
      USING ERRCODE = 'check_violation', CONSTRAINT = 'registrations_within_capacity';
  END IF;
  RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER registrations_within_capacity
  AFTER INSERT OR UPDATE OF status, guest_count ON registrations
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
  WHEN (NEW.status = 'CONFIRMED')
  EXECUTE FUNCTION registrations_enforce_capacity();

-- D-51
CREATE INDEX idx_registrations_active_member ON registrations (team_id, user_id, session_id)
  WHERE status IN ('CONFIRMED', 'WAITLISTED');

-- Down Migration (reverse order)
DROP INDEX idx_registrations_active_member;
DROP TRIGGER registrations_within_capacity ON registrations;
DROP FUNCTION registrations_enforce_capacity();
DROP TRIGGER registrations_guard_update ON registrations;
DROP FUNCTION registrations_guard_update();
ALTER TABLE registrations
  DROP CONSTRAINT registrations_promoted_at_not_waitlisted,
  DROP CONSTRAINT registrations_fee_due_only_late,
  DROP CONSTRAINT registrations_withdrawal_stamps,
  DROP COLUMN withdrawal_fee_due, DROP COLUMN withdrawal_kind, DROP COLUMN withdrawn_at, DROP COLUMN promoted_at;
DROP TYPE withdrawal_kind;
```
A `WHEN` clause on a constraint trigger cannot reference `OLD` for an INSERT event. This one uses only `NEW`, so a single trigger covers both events (D-43 needed two triggers only because its `WHEN` read `OLD`).

**Ledger rows (`db/schema-deviations.md`)**. These match the existing key grammar. `enum:`, `column:` and `function:` keys are derived by `schema.int.test.ts`; the others are documentary.

| ID | Objects | Change | Source |
|---|---|---|---|
| D-47 | `enum:withdrawal_kind` | New enum `EARLY`, `LATE`, `BANNED` (mirrored in `packages/shared/src/types/enums.ts`, enum-parity test) | registration-and-waitlist AC-VERIFY-2; Arch Q2 |
| D-48 | `column:registrations.promoted_at` `column:registrations.withdrawn_at` `column:registrations.withdrawal_kind` `column:registrations.withdrawal_fee_due` `constraint:registrations_withdrawal_stamps` `constraint:registrations_fee_due_only_late` `constraint:registrations_promoted_at_not_waitlisted` | Lifecycle stamps and the billing liability marker; stamps set iff WITHDRAWN; fee due only on LATE withdrawals; `promoted_at` NULL while WAITLISTED. Existing WITHDRAWN rows backfilled as EARLY | AC-VERIFY-2; AC-HAPPY-4..8; Algo Q3; Arch Q2 |
| D-49 | `function:registrations_guard_update` `trigger:registrations_guard_update` | Allowed status moves; immutable keys; positions never renumbered; `guest_count` frozen while active; promotion stamp rule (23000) | AC-VERIFY-2; D-14; ADR 0015 point 2; Arch Q2 |
| D-50 | `function:registrations_enforce_capacity` `trigger:registrations_within_capacity` | Deferred: a COMMIT that makes a row CONFIRMED while the session's CONFIRMED seats exceed `max_players - reserved_seats` fails 23514; locks the session `FOR UPDATE`; never blocks a capacity cut or a withdrawal | AC-VERIFY-2; P1; Arch Q2 (B1); pattern D-43 |
| D-51 | `index:idx_registrations_active_member` | Partial `(team_id, user_id, session_id) WHERE status IN ('CONFIRMED','WAITLISTED')` for the ban handler and the reconciliation sweep | AC-ASYNC-2/3; ADR 0015; Arch Q4 |

---

## Implementation Guidelines

1. **Phase 1, migration and fixtures** (before anything else):
   - Write the migration above and ledger D-47..D-51, then regenerate `types.generated.ts`.
   - `insertRegistration` stamps `withdrawn_at = now()` and `withdrawal_kind = 'EARLY'` (overridable) when `status = 'WITHDRAWN'`, and accepts `promotedAt`, `withdrawalKind` and `withdrawalFeeDue`.
   - Fix `registrations-guests.int.test.ts:183` to set `promoted_at = now()`.
   - Add `insertPublishedSession(db, teamId, { now, startsInHours = 72, … })`: date and court times are derived from `now` (no fixed date, so the real-clock worker in the seam test sees a future session); the deadline defaults to `starts_at - 48h`.
   - Run the **whole** integration suite in Phase 1, not only the new files (learned rule `review-process-plan-claims`: global changes break earlier features).
   - Add the shared matrix fixture `test/fixtures/registration-transitions.ts` and run it against the trigger and `transitions.ts`.
2. **`runAllocatorTransaction(db, policy, work)`** in `modules/registrations/tx.ts`:
   - Each attempt is `db.transaction().execute(async trx => { await sql\`SET LOCAL lock_timeout = ${sql.lit(ms)}\`.execute(trx); return work(trx); })`.
   - Retry only on `err.code` `40P01` or `55P03`, logging `registration.lock_retry` with `sqlState`.
   - Rethrow everything else unchanged. The caller maps it.
3. **Error mapping** (`modules/registrations/errors.ts`, wraps the whole transaction because D-50 fires at COMMIT):
   - `23505 uq_registrations_session_user` → `already_registered` (backstop for AC-ERROR-3).
   - Any other class-23 error on a registrations constraint → `registration.invariant_violation` error log, then rethrow (500).
   - Key on SQLSTATE plus `err.constraint`, never on message text.
4. **Allocator writes go through `repo.ts` only.** Add a structural unit test that greps `apps/api/src/**` for `updateTable('registrations')`, `insertInto('registrations')` and `UPDATE registrations` outside `modules/registrations/repo.ts` (test files excluded). It extends AC-VERIFY-10's grep test.
5. **One `now` per operation**: the service reads `clock.now()` once and passes it in `AllocatorContext`. Tests advance the `ManualClock` between the register and withdraw calls of one scenario (`testing-injected-clock`).
6. **Read model** (`GET …/registration`): one SQL statement with CTEs (session, active rows, my row, overdue count), so `seatsLeft`, `waitlistLength` and `waitlistRank` come from a single snapshot (AC-VERIFY-4 last bullet). No lock.
7. **Promotion email**:
   - `idempotencyKey = registration-promoted:<registrationId>:<promotedAt epoch ms>`.
   - The recipient email, team name and session fields are read inside the promoting transaction after the promote `UPDATE`.
   - Enqueued with `enqueueEmail(jobs, msg, { trx })` (not sealed: no secret).
   - Never sent to a member whose withdrawal caused the promotion, nor to a banned member.
8. **Ban handler and sweep wiring**:
   - `worker.ts` builds `createRegistrationsBanHandler({ db, jobs: runner, clock: systemClock, webBaseUrl: config.auth.webBaseUrl })` and passes it to `registerJobs({ memberBannedHandler })`. Confirm the exact config path when building.
   - `QUEUE_NAMES.registrationBanReconcile = 'registration-ban-reconcile'` (policy `exclusive`).
   - `SCHEDULES` slot `30 5 * * *`.
   - `bootstrap.ts` maps the queue to `createBanReconcileHandler({ db, jobs: runner, clock })`, replacing its placeholder.
   - `worker.ts` calls `runner.trigger('registration-ban-reconcile', {})` once after `registerJobs`.
   - The CLI picks the slot up automatically from `SCHEDULES`.
9. **Worker pool**: raise `worker.ts` `createPool({ max: 2 })` to `max: 5` and update the comment (the health probe, `auth-cleanup`, the ban handler with a 5 s lock wait, and the sweep).
10. **Contract test** (`teams-ban-seam.int.test.ts`):
    - Replace the `withdrawActiveRegistrations` stand-in with the real handler: keep the `recording` wrapper and its `behaviour` hook, and let `behaviour` default to `realHandler.handle`.
    - Change `scene()` to `insertPublishedSession` with a future start.
    - Keep the gate-race tests' raw inserts valid: CONFIRMED, PUBLISHED session, within capacity.
    - Every existing assertion stays: payload keys, retry counts, `affected` values, `failed` state, operator re-run.
11. **Lock-order test** (AC-VERIFY-3): `log_statement` capture, or `pg_locks` probes with `waitForLockWaiters` at each step. Include `autoEnrolInSession` with 3 members: all gates before the session lock.
12. **Race suite** (AC-INTEGRATION-1): a dedicated cloned DB with `poolMax ≥ 25`. Also assert `registration.lock_retry` never fired, which shows the lock order holds and no deadlock was retried.
13. **ADR 0016**: copy the Q2 transaction shape, the Q4 handler shape and classification, the Q6 exported API and the C-* table, alongside the algorithm doc's promotion and fee rules. Update `systemPatterns.md` (a new "Registration allocator" pattern) and `techContext.md` (the queue and the slot) in Phase 6.

---

## Validation Checklist

- [x] Meets all system requirements (every seat path through one allocator under D-14; ban handler and sweep per ADR 0015; billing hand-off; promotion emails in the same transaction)
- [x] Respects technical constraints (READ COMMITTED, lock order, D-11/D-13/D-14, no money writes, id-only payloads, global redaction keys)
- [x] Addresses non-functional requirements (p95: a short lock hold; P1 backstops; P3 single `now`; P5 in-transaction enqueue; privacy)
- [x] Technically feasible (every mechanism already used in the repo: deferred constraint triggers D-13/D-43, guarded updates, `enqueueMemberBanned`, `exclusive` singleton)
- [x] Risks identified and acceptable (below)
- [x] Complies with Guiding Principles in systemPatterns.md. No deviation:
  - P1: strengthened. The capacity rule is scoped to "registrations never push seats over capacity", by design.
  - P7: lock timeouts and the sweep schedule are behavioural code constants, as are `QUEUES` and `SCHEDULES`.
- [x] Respects established patterns (module shape, two-encoding state machine, guarded `UPDATE`, error mapping by `err.constraint`, port injection only via `registerJobs`)
- [x] Observability architecture defined
- [x] Trace context propagation across all service boundaries (HTTP, pg-boss `_meta`, cron root span)
- [x] Logging strategy consistent with observability-requirements.md (structured, trace ids, no PII, configurable)
- [x] Metrics strategy follows naming conventions (names reserved; low-cardinality labels)

## Risk Assessment

| Risk | Likelihood | Impact | Mitigation |
|------|------------|--------|------------|
| A consumer feature writes `registrations` directly or locks out of order | M | H | C-ALL-1 in ADR 0016; structural grep test; D-49/D-50 and `uq_registrations_waitlist_position` turn mistakes into errors; each consumer's plan must cite the C-* rows |
| session-scheduling-engine ships a different `fee_flat` meaning or skips `promoteWaitlist` on capacity edits | M | M | Build gate re-check of C-SSE-1..5; the self-healing invariant (every allocator op ends with `promote`) limits the damage of a missed call to "until the next operation" |
| The migration breaks earlier features' fixtures (CHECKs and trigger) | H (known) | M | Guideline 1 lists the three known sites; the full integration suite runs in Phase 1 |
| Re-registration erases a late-withdrawal liability (AC-HAPPY-8 vs Q3) | M | M | Flagged for the reconciliation step; settle before Phase 1 because it changes D-48 |
| Lock waits behind a long session edit cause HTTP 500s | L | M | 2 s timeout plus 3 attempts; C-SSE-5 asks session edits to hold the lock briefly; `registration.lock_retry*` logs make it visible |
| A permanent ban-handler failure repeats daily via the sweep | L | L | `hook_failed` at error level is the operator alert; failed jobs stay visible 7 days; the sweep's `skipped` and `enqueued` counts show repeats |
| The worker pool is exhausted during a long lock wait | L | M | Pool 5; pg-boss runs one job per queue at a time (default concurrency) |
| The boot-time sweep surprises tests | L | L | Enqueued only in `worker.ts`, not in `registerJobs` |
| A password reset holding `users FOR UPDATE` delays a registration's FK check (`FOR KEY SHARE`) | L | L | No lock cycle (auth paths never touch sessions); covered by the lock timeout |

## Next Steps

1. `/yay:creative` reconciliation: apply the Spec Amendments below. Resolve the re-registration liability question with the algorithm doc. Confirm the algorithm doc's `decideAllocation` and `decideLiability` signatures match the `AllocationPlan` shape here.
2. Phase 1: migration D-47..D-51, the fixture changes (guideline 1), the transition matrix, `withdrawal_kind` enum parity, zod contracts and error codes.
3. Phase 2: `allocation.ts`, `transitions.ts`, `deadline.ts`, `tx.ts`, `allocator.ts` (`registerInSession`, `autoEnrolInSession`, `withdrawFromSession`, `promoteWaitlist`), `billing-handoff.ts`, the structural grep test, ADR 0016.
4. Phase 3: service and routes on `runAllocatorTransaction(HTTP_POLICY)`, error mapping, emails, logs.
5. Phase 4: `ban-handler.ts`, `reconcile.ts`, `jobs/ban-reconcile.ts`, queue and slot, worker wiring (pool 5, boot sweep), contract test conversion.
6. Build gate (before Phase 1): re-read the merged session-scheduling-engine against C-SSE-1..5 and record the result in the task file.

---

## Spec Amendments

The task file is not edited here; the `/yay:creative` reconciliation applies these.

- **A1 AC-VERIFY-2 (capacity backstop wording)**: replace the capacity bullet with: "A deferred constraint trigger `registrations_within_capacity` refuses, at COMMIT (23514), any transaction that inserts or updates a row to `CONFIRMED` while the session's CONFIRMED seats exceed `max_players - reserved_seats`. A transaction that only withdraws or leaves the waitlist always commits, even when an admin cut left the session over capacity." Add a test: cut capacity below seats taken, then a withdrawal commits and a registration is waitlisted.
- **A2 AC-VERIFY-2 (transition trigger rules)**: add to the trigger bullet: positions never change while a row stays WAITLISTED (23000 `registrations_queue_position_stable`); `guest_count` changes only on `WITHDRAWN → CONFIRMED|WAITLISTED` (`registrations_guest_count_frozen`); `WAITLISTED → CONFIRMED` requires `promoted_at` and `WITHDRAWN → CONFIRMED` leaves it NULL (`registrations_promotion_stamp`). Ledger rows are **D-47..D-51** as listed above, including the partial index `idx_registrations_active_member` (D-51). Existing WITHDRAWN rows are backfilled as `EARLY`.
- **A3 AC-VERIFY-3 (transaction shape)**: prepend step 0 "`SET LOCAL lock_timeout` (2 s HTTP, 5 s jobs) on this module's own transactions; a whole-transaction retry (3 attempts) only on 40P01/55P03, with `now` read once before the first attempt". For auto-enrol, steps 1–2 run for every member before step 3. Add "the allocator never `UPDATE`s `game_sessions`" and the structural test (Implementation Guideline 4).
- **A4 AC-VERIFY-3 / Architectural Principle 1 (sole promoter)**: "`promoteWaitlist` is the only exported promotion entry point; every allocator mutation ends with the same internal promotion step."
- **A5 AC-VERIFY-4 (seat bound)**: change "never exceeds `max_players - reserved_seats`" to "never exceeds it as a result of a register, promotion or re-registration; after an admin capacity cut it may exceed it until withdrawals bring it below, and no seat is granted meanwhile".
- **A6 AC-ASYNC-2 (handler deps and behaviour)**:
  - Deps become `createRegistrationsBanHandler({ db, jobs, clock, webBaseUrl })` (also in Invocation Method → Jobs).
  - Each session runs through `allocator.withdrawFromSession({ cause: 'ban' })` in its own transaction (5 s lock timeout, 3 attempts).
  - A session that is no longer PUBLISHED and future, or a row already withdrawn, is skipped and logged as `registration.ban.session_skipped`.
  - Failures are per session: processing continues; the run throws transient if any failure was transient, else `NonRetryableJobError`.
  - The handler stops between sessions when the job signal aborts.
- **A7 AC-ERROR-9 (classification)**: transient means SQLSTATE 40P01, 55P03, 40001, 57014, 53300, class 08, aborts and unknown errors. Permanent means class 23 and `RegistrationInvariantError`. Add `registration.ban.session_failed` (`sqlState`, `permanent`; never a field named `code`).
- **A8 AC-ASYNC-3 (sweep)**:
  - The sweep also runs once at worker start (enqueued in `worker.ts`).
  - It enqueues through `enqueueMemberBanned` in one transaction, processes at most 1000 memberships per run (ordered by `banned_at, id`), and skips and counts a membership whose payload fails validation.
  - The completion log is `registration.ban_reconcile.completed` with `scanned`, `enqueued`, `alreadyQueued`, `skipped` and `truncated`.
- **A9 Observability Requirements (event names)**: use the AC-VERIFY-6 names and this doc's table. Delete `registration.waitlisted`, `registration.ban.withdrawn` and `registration.ban.reconcile` from the plan's list. Add `registration.lock_retry`, `registration.lock_retry_exhausted`, `registration.invariant_violation`, `registration.ban.session_skipped` and `registration.ban.session_failed`.
- **A10 Assumed outputs 4–5, Scope "In scope", New Source Files (exported API)**:
  - The allocator is `createAllocator({ jobs, webBaseUrl })`, with methods taking an `AllocatorContext { trx, now, log }`: `registerInSession`, `autoEnrolInSession` (new, batch, gates before the lock), `withdrawFromSession` and `promoteWaitlist(ctx, { teamId, sessionId })`. This replaces `promoteWaitlist(trx, sessionId, now)`.
  - Refusals are returned values, not throws.
  - The pure decision moves to `modules/registrations/allocation.ts`.
  - Add `tx.ts` and `errors.ts`.
  - Record contracts C-SSE-1..5, C-SAE-1..2, C-BIL-1..3 and C-ALL-1 in ADR 0016.
- **A11 Creative Q6 answer (auto-enrol and debt)**: an auto-enrolled member with 3 or more OVERDUE payments is **skipped** (no row, not waitlisted), as is one no longer APPROVED. Auto-enrol runs only on a PUBLISHED session (C-SAE-1).
- **A12 AC-INTEGRATION-3 (hand-off shape)**: each returned guest carries `guestId` and `position` as well as `sex` and `skillLevel`; rows are ordered by `registered_at, id`; `listBillableRegistrations` accepts a transaction, and billing calls it under its own session lock after moving the session to COMPLETED (C-BIL-1).
- **A13 AC-INTEGRATION-2 (contract-test conversion)**:
  - `scene()` uses `insertPublishedSession` with a start in the future relative to the worker's clock.
  - The `withdrawActiveRegistrations` stand-in is removed and `behaviour` defaults to the real handler.
  - The existing fixtures `insertRegistration` (WITHDRAWN stamps) and `registrations-guests.int.test.ts:183` (`promoted_at`) are updated in Phase 1.
- **A14 Test helpers (Specification basis (4), Phase 1)**: `insertPublishedSession` takes a `now` (or `startsAt`) and derives date, court times and deadline from it; no fixed date.
- **A15 New Source Files / extend list**: add `apps/api/src/worker.ts` changes (pool `max: 5`, real handler injection, boot-time sweep trigger) and `apps/api/src/cli.ts` (no change needed; the slot comes from `SCHEDULES`, verify only).
- **A16 Billing boundary / AC-HAPPY-8 (open, for reconciliation with the algorithm doc)**: decide whether re-registration may clear a `withdrawal_fee_due = true` liability (spec today: yes). If not, either refuse re-registration while liable, or change D-48's `registrations_fee_due_only_late` CHECK. This must be settled before Phase 1.
