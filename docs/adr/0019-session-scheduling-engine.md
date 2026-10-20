# ADR 0019: Session scheduling engine, recurrence and the cross-feature contracts it honours and offers

- Status: Accepted (2026-10-20)
- Task: session-scheduling-engine
- Source: [Architecture design, "Draft outline: ADR 0019"](../../memory-bank/creative/session-scheduling-engine-architecture.md) (ARCH); [Recurrence algorithm](../../memory-bank/creative/session-scheduling-engine-recurrence-algorithm.md) (ALG); [Admin user journey](../../memory-bank/creative/session-scheduling-engine-admin-user-journey.md) (UJ); [Binding reconciliation](../../memory-bank/creative/session-scheduling-engine-binding-reconciliation.md) (BIND, wins where the four design docs differ); task file "Deviations" and AC-VERIFY-7. Migration `20261020000100000_session_scheduling.sql` (ledger D-70 to D-83 and D-85; D-84 is reserved and not built).
- Numbering: registration-and-waitlist keeps ADR 0018 and D-62 to D-66 (plus its R2 index). This ADR is 0019 and takes D-70 onwards, as ADR 0017 and ADR 0016 did for their branches.

## Context

Sessions are the producer for three consumers: registration-and-waitlist (registrations and the seat allocator), wallet-and-akahu-billing (completing sessions and charging), and the dashboards. The allocator does not exist on `main` yet, so this feature ships a port, a no-op default and the auto-enrol and waitlist seams, and proves them with a recording double.

Three earlier ADRs fix the rules this feature must follow:

- ADR 0016 (team banking): a paid session is never published for a team without a usable payout destination. That gate runs inside the publishing transaction, before any `game_sessions` lock. The recurrence contract and the manual-publish `returnTo` hand-off are defined there.
- ADR 0017 (skill levels and auto enroll): C-SKL-1 defines the auto-enrol selection, its call sequence and its lock advisory. C-GAME-1 point 3 requires that a COMPLETED session can never be edited, because game counts depend on its `ends_at`.
- Platform foundation: the `fee_other` default, the DST input policy, the 48 hour default cancellation deadline and the whole-dollar rate rule.

## Decision

### 1. Lifecycle, ownership and immutability

- The admin may create, edit, publish and cancel sessions, and create and end series. `COMPLETED` is not reachable from any sessions route. It belongs to billing (C-BIL-1), and billing's transition is the only way a session completes. The sessions routes expose publish and cancel but no completion (`apps/api/src/modules/sessions/routes.ts`).
- Edits and cancels are refused after `starts_at` with 409 `session_started`. That rule lives in TypeScript, because `now()` is kept out of SQL rules (BIND T-11). The API reads its clock after the session lock.
- Closed rows are immutable in the database. `game_sessions_guard_update` (D-75) enforces the lifecycle matrix (DRAFT to PUBLISHED, DRAFT to CANCELLED, PUBLISHED to CANCELLED, PUBLISHED to COMPLETED, SQLSTATE 23000, constraint `game_sessions_status_transition`). COMPLETED and CANCELLED rows are immutable except for their series link being cut, `version` and `updated_at`. Only a DRAFT can be deleted.
- Courts on a COMPLETED or CANCELLED session are immutable too: `session_courts_guard_closed` (D-76, constraint `session_courts_closed_immutable`). This is C-GAME-1 point 3, because the court trigger would otherwise move `ends_at` on a completed session.

### 2. Lock order

The canonical order, extended for this feature, is:

```
teams -> recurring_session_rules -> team_members -> game_sessions -> registrations -> registration_guests -> payments
```

This is `LOCK_ORDER` in `apps/api/src/modules/sessions/locks.ts`. Lock modes per path:

- `teams`: only `KEY SHARE` (`lockTeamKeyShare`, and the publish gate). Never `FOR UPDATE` or `NO KEY UPDATE`, and no `teams` lock is taken after a session lock (ADR 0016).
- `recurring_session_rules`: only `FOR NO KEY UPDATE` (`lockRule`), by the series edit and end, the materialiser's instance transaction and its bookkeeping stamp. Instance edits, publish, cancel and the allocator never lock a rule.
- `team_members`: `FOR SHARE` on the actor re-check (`assertSessionAdmin`) and the allocator's own member gates.
- `game_sessions`: `FOR UPDATE` (`lockSession`, D-14), one row per transaction. The series edit is the one exception: it locks a rule's instances in `(date, id)` order under the rule lock (`lockRuleInstances`). Each series write therefore takes instances in one global order.
- Lower levels only through the allocator.

The auto-enrol advisory lock is the one lock outside this order. `lockSessionAutoEnrol` takes `pg_advisory_xact_lock(SESSION_AUTO_ENROL_LOCK_NAMESPACE, hashtext(sessionId))` as the first statement of its transaction, before any row lock. The namespace constant is `0x5345_4153` (ASCII "SEAS", an int4), defined in `locks.ts` and recorded here so no other feature reuses it. Only `runSessionAutoEnrol` takes it (BIND T-19).

Known deviation from the design text: `lockRuleInstances` orders by `(date, id)`, while the database trigger path orders court moves by `id`. The two never meet on the same rows in one transaction today, so there is no deadlock, but the orders differ and this is noted here rather than hidden.

### 3. Recurrence, materialisation and the queues

- The `recurrence-materialisation` slot runs the sweep at 03:00 Pacific/Auckland (`schedules.ts`, `exclusive`). The sweep fans out one `recurrence-rule` job per active rule, and one `session-auto-enrol` job per pending session. It also runs once at every worker boot (`bootstrap.ts`, `session.recurrence.boot_sweep`) and can be run by hand.
- `recurrence-rule` is the per-rule materialisation job. Its queue policy is `stately`, and its singleton key is `recurrence-rule:<ruleId>`. `stately` allows one queued and one active job per key, so an edit that commits during a run queues exactly one trailing run (the `stately` trailing-run test covers this).
- Each instance is materialised in its own transaction (`materialise-instance.ts`). Following ADR 0016 recurrence contract points 1 to 6:
  1. Each paid instance that would be PUBLISHED calls `checkTeamCanPublishPaidSession` before it is inserted, and before any `game_sessions` lock.
  2. A refused instance is saved as DRAFT, not skipped, so `uq_game_sessions_rule_date` keeps re-runs idempotent.
  3. A 23514 `game_sessions_paid_requires_payout` reaching the materialiser is a bug. It is logged at `error` and rolls back that instance only.
  4. A refusal is not a job failure.
  5. At most one admin email per rule per NZ-week window. The claim is a row in `payout_notice_claims` (D-81), inserted with `ON CONFLICT DO NOTHING` in the instance transaction. The rule row is never updated, because a lock upgrade on it would deadlock concurrent runs. The email is enqueued in the same transaction with the key `payout-missing:<ruleId>:<windowStart>:<recipientId>` (`emails.ts:49`). The recipient is part of the key so that every admin is emailed. The window key alone would send one email to one admin only.
  6. Later runs retry the publish of DRAFT instances the materialiser created (`is_instance_overridden = false`, `materialise-instance.ts:196`). Instances an admin has touched are left to the admin.
- `materialised_version` and `materialised_at` (D-82) record the rule version that the last completed run applied. The series page shows "We're adding the sessions..." while it trails `version`.
- The horizon is `RECURRENCE_HORIZON_DAYS` (7 to 91, default 28, `apps/api/src/lib/config/config.ts:142`), passed to the job through `AppDeps` and `RegisterJobsOptions`. See Deviations.

### 4. Optimistic concurrency and create replay

- `version` and `updated_at` (D-72) are bumped by the database on any content change, by any writer, through `game_sessions_version_bump` (fires last among the BEFORE UPDATE triggers) and `recurring_session_rules_version_bump`. Derived and bookkeeping columns are excluded: `starts_at`, `ends_at`, `auto_enrol_required`, `auto_enrolled_at` on sessions, and `materialised_version`, `materialised_at` on rules. Writers cannot set `version`.
- Every write sends `expectedVersion`. A stale write is refused with 409 and the current row, and a save that changes nothing is a no-op, so retries are safe (AC-ERROR-7).
- Creates send `createKey`, a per-render UUID scoped by team (`create_key`, D-73). A replay finds the existing row.
- Court-only edits do not bump `version` by themselves, because `starts_at` and `ends_at` are excluded from the bump (D-72). The service therefore bumps `updated_at` and `version` explicitly when it edits courts (task Deviations, Phase 2).

### 5. Defaults, C-SSE constraints and the trigger order

- `game_sessions.cancellation_deadline` defaults to `starts_at - 48 hours` while `deadline_is_default` holds (D-74, `game_sessions_fill_default_deadline`). The 48 hour literal is absolute hours, not DST-aware days. A parity test (`sessions-schema.int.test.ts`, the 48 h parity case) checks that the SQL default equals `defaultCancellationDeadline` and that the TypeScript constant `CANCELLATION_DEADLINE_DEFAULT_HOURS` (`packages/shared/src/time/time.ts:319`) is 48.
- The C-SSE constraints are the D-77 publish copy (C-SSE-1: a PUBLISHED or COMPLETED session has every fee column its structure needs, and a FLAT session's `fee_flat` equals its final rate) and the instant derivation on live sessions (C-SSE-2, `game_sessions_instants_when_live`). Together with D-75 they make a raw publish of incomplete pricing or un-derived times fail with 23514.
- The trigger firing order is by name, because PostgreSQL fires same-event BEFORE ROW triggers in name order. The documented order is recorded in the migration header and asserted from `pg_trigger` in `sessions-schema.int.test.ts` (the `fires the BEFORE UPDATE triggers on game_sessions in the documented order` case):
  1. `game_sessions_derive_instants` (D-08): `starts_at` and `ends_at` from the courts
  2. `game_sessions_fee_raise_locked` (D-85): fee and pricing-model raises on a PUBLISHED session with active registrations
  3. `game_sessions_fill_default_deadline` (D-74)
  4. `game_sessions_guard_update` (D-75): matrix, closed-row immutability, immutable keys
  5. `game_sessions_paid_requires_payout` (D-49, ADR 0016)
  6. `game_sessions_version_bump` (D-72): last, so it sees the final row

  Renaming any of these changes behaviour. The `derive_instants` trigger must run before the deadline trigger, because the deadline is computed from the derived start.

- Each `game_sessions` and `recurring_session_rules` write hits these triggers, so an admin write, a raw SQL write and a materialiser write all see the same rules.

### 6. Auto-enrol placement, marker and the rollout gap

- C-SKL-1 point 5 (follow-up transaction): auto-enrol never runs in the transaction that holds the session lock. For a newly materialised instance it runs inline after the instance commits (`materialise.ts`, BIND T-2). A retried DRAFT or an API publish enqueues a `session-auto-enrol` job (`singletonKey = session-auto-enrol:<sessionId>`), so the publish transaction does not wait on the allocator. Every follow-up first takes the advisory lock above.
- C-SKL-1 point 3 (call sequence, amended by R16): `selectAutoEnrollees` (`apps/api/src/modules/skill-levels/auto-enrol.ts`, a lock-free read) returns the members in `(auto_enroll_assigned_at, id)` order. The follow-up then calls `autoEnrolInSession` once per session with `entries` (`{ userId, assignedAt, membershipId? }`) in that order. The allocator is never called with empty entries. `boundaries.test.ts` asserts that `modules/sessions/**` reaches other modules only through their public files.
- The marker is `game_sessions.auto_enrolled_at` (D-80). It is stamped only when the port's `enrols` flag is true. With the no-op port the session stays pending and the port logs `session.auto_enrol.port_noop`. This is the durable form of the obligation: a stamp implies the obligation was met.
- C-SKL-1 point 7 (not retroactive) is bounded for deferred auto-enrol. A session that was pending because no real allocator ran is enrolled later by the sweep (AC-ASYNC-5), because the obligation is durable. Nothing is retroactive for members who turn Auto Enroll on after a session already exists, and turning it off never withdraws anyone.
- P-1 (user ruling): `auto_enrol_required` is true for every session, one-off or series (D-80 default). This applies C-SKL-1 point 6 to all sessions, not only series.

### 7. Contracts honoured

Each contract below is checked by the named code or test.

- **C-SSE-1** (publish copy, D-77): `game_sessions_skill_fees_when_live` and `game_sessions_flat_fee_when_live`. Asserted in `sessions-contracts.int.test.ts` (AC-INTEGRATION-1).
- **C-SSE-2** (instants on live sessions, D-75 and D-08): `game_sessions_instants_when_live`, and the matrix in `game_sessions_guard_update`.
- **C-SSE-3** (capacity raise calls the allocator once, after the session lock): `promoteWaitlist` is called once after `lockSession` and the capacity `UPDATE`, only when public capacity rose on a PUBLISHED, not-started session. The contract test uses a recording double.
- **C-SSE-4** (cancel changes no registration): `sessions-contracts.int.test.ts`.
- **C-SSE-5** (session lock usage): a session edit holds the session row lock only for its own statements. Registration's 2 s lock timeout is therefore not at risk from an admin edit.
- **C-SAE-1 and C-SAE-2 as amended by R16**: once per session, after the session is PUBLISHED, in a transaction holding no session or rule lock. Parties have no guests. Refusals are per-entry results, not throws.
- **C-ALL-1** (canonical order): `LOCK_ORDER` as above (SA-2). The runtime query-order recorder (the "query-recorder gate test", Q7) proves the order on the manual paths and on series propagation.
- **ADR 0016 gate contract points 1 to 5**: `assertTeamCanPublishPaidSession` and `checkTeamCanPublishPaidSession` are called inside the publishing transaction before any session lock (`gate-step.ts`, `materialise-instance.ts`). A refusal logs `team.banking.publish_gate_refused`. The trigger is never used for flow control.
- **ADR 0016 lock rules**: no `teams FOR UPDATE` in this module. No `teams` lock after a session lock.
- **ADR 0016 recurrence contract points 1 to 6**: see section 3.
- **ADR 0016 manual publish and `returnTo` hand-off**: a manual publish that gets `payout_not_configured` keeps the draft, shows the API message in an alert on the editor, and links to `/teams/<teamId>/manage/banking?returnTo=<editor path>`. The web builds the path with `apps/web/src/lib/teams/sessions-paths.ts`, and the banking page validates it with `safeReturnTo` (ADR 0016).
- **ADR 0017 C-SKL-1 points 1, 3, 5 and 6**: section 6. Point 1 uses `selectAutoEnrollees`. Point 3 uses the R16 `entries` shape. Point 5 is the follow-up transaction. Point 6 is extended to every session by P-1.
- **ADR 0017 C-GAME-1 point 3**: section 1 (COMPLETED reached only through billing, immutable closed rows, refused court edits on closed sessions, D-75 and D-76).
- **Bounded exception to ADR 0017 point 7**: deferred auto-enrol for a pending session (section 6, AC-ASYNC-5).
- **Platform foundation**:
  - `fee_other` default: the untouched `fee_other` is the lower of `fee_male` and `fee_female` (`feeOtherText` and `minMoney` in `apps/web/src/lib/teams/session-form-state.ts`). This is the same rule as `LEAST`, and it is shown to the admin before save.
  - DST input policy: `reject` with options. A gap time gets a 422 with `local_time_nonexistent` and two options (03:30 or 01:30). An overlap time gets only the first 2:30 am (`local_time_ambiguous`, option `earlier`). The materialiser rewrites a gap time to the real wall time (`instance.ts`, `shiftedForward`). A second 2:30 am on the DST-end day is not offered, so an overlap time cannot select it. This is the unsupported second 2:30 am.
  - Court save refusal (T-10, see Deviations): a template court wholly inside the 02:00 to 03:00 gap is refused (`isCourtWhollyInDstGap`, `instance.ts`).
  - `DERIVED` pricing is compatible with materialisation.
  - Default deadline: `starts_at - 48 h` (section 5).
  - Rate: whole dollars with `CEIL` (`divideByInteger(..., 'CEIL', 'DOLLAR')`, `costing.ts:55`). Reserved host seats are not billed, so the rate under-recovers by design (`costing.ts:49`, the spec owner's call). That is a known revenue gap, not a bug.
  - Recurrence queue: `recurrence-materialisation` at `0 3 * * *`, idempotent through `uq_game_sessions_rule_date`.
- **DST policy and the 2:30 am**: the policy above. The materialiser never creates a session at a nonexistent time, and an overlap time is only ever the first occurrence.

### 8. Contracts offered

- **`SessionAllocatorPort`** (`apps/api/src/modules/sessions/allocator-port.ts`). Fields: `name: string`, `enrols: boolean`, `promoteWaitlist(ctx, { teamId, sessionId }): Promise<readonly PromotedSeat[]>`, and `autoEnrolInSession(ctx, { teamId, sessionId, entries }): Promise<readonly { userId, outcome }[]>`. The context is `{ trx, now, log }`, and the allocator asserts `trx.isTransaction`. Outcomes are `{ ok: true, status: 'CONFIRMED' | 'WAITLISTED' }` or `{ ok: false, reason }`, with reasons `overdue_payments`, `forbidden`, `already_registered`, `auto_enroll_changed`, `not_found`, `session_not_open` and `party_exceeds_capacity`.
- **`noopSessionAllocator`**: `name: 'noop'`, `enrols: false`. It logs `session.allocator.promote_noop` and returns no seats and no outcomes. It is the default until registration-and-waitlist ships.
- **`createSessionAllocator`** (`apps/api/src/session-allocator.ts`): the single composition point, currently returning the no-op. registration-and-waitlist changes its body only, to return an adapter (`name: 'registrations'`, `enrols: true`) around its allocator. No environment variable selects the adapter.
- **Required fields**: `AppDeps.sessionAllocator` (`app.ts:72`) and `RegisterJobsOptions.sessionAllocator` (`bootstrap.ts:45`) are required, so a missing entrypoint fails to compile. `main.ts:44` and `worker.ts:75` both call `createSessionAllocator`. `session-allocator.test.ts` checks this, and `boundaries.test.ts` checks that `modules/sessions/**` never writes `registrations`.
- **`enrols` semantics**: `true` only for an allocator that really registers members. While `false`, the session stays pending, as in section 6.
- **Route namespace**: `/teams/:teamId/sessions*` (`routes.ts`) and `/teams/:teamId/session-series*` (`series-routes.ts`), all `TEAM_ADMIN`. Reserved for registration-and-waitlist: `GET /teams/:teamId/sessions/upcoming` and `/teams/:teamId/sessions/:sessionId/registration*`.
- **Slot contract acknowledgement**: this feature adds nothing to the player page. The player-facing registration UI is registration-and-waitlist's.
- **Reserved names**:
  - queues `recurrence-rule` (`stately`) and `session-auto-enrol` (`exclusive`), in `apps/api/src/jobs/registry.ts`
  - singleton keys `recurrence-rule:<ruleId>` and `session-auto-enrol:<sessionId>`
  - email key `payout-missing:<ruleId>:<windowStart>:<recipientId>`
  - log events, from AC-VERIFY-6: `session.stale_refused`, `session.recurrence.sweep_completed`, `session.recurrence.run_completed`, `session.recurrence.rule_skipped`, `session.recurrence.boot_sweep`, `session.auto_enrol.failed`, `session.auto_enrol.port_noop`, `session.lock_retry`
  - metric names (not yet emitted, since no exporter exists in this feature): `session_recurrence_instances_total{outcome}`, `session_recurrence_rule_runs_total{outcome}`, `session_recurrence_rule_run_duration_seconds`, `session_auto_enrol_entries_total{outcome}`, `session_publish_total{path,outcome}`, `session_lock_retries_total{path}`
- **CLI triggers**: `jobs trigger recurrence-rule '<json>'`, `jobs trigger session-auto-enrol '<json>'`, and the slot `recurrence-materialisation` (`cli.ts` `TRIGGERABLE`).
- **Hand-offs to registration-and-waitlist's build gate**:
  - `CREATE OR REPLACE` of `game_session_has_active_registrations` to count `WITHDRAWN` rows with `withdrawal_fee_due` (ALG R-a, BIND T-17). The function is at `db/migrations/20261020000100000_session_scheduling.sql`, and it is the one definition of "active" for D-85.
  - An existing row in any status is treated as `already_registered` (ALG R-b).
  - The composition function `createSessionAllocator`, and `promoteWaitlist(trx, sessionId, now)` is superseded by `promoteWaitlist(ctx, { teamId, sessionId })` (ARCH H10).
  - `countActiveRegistrations` in `apps/api/src/modules/sessions/repo.ts` is the TypeScript read of the same predicate. It counts CONFIRMED and WAITLISTED today, and must widen with the SQL function. The parity test `countActiveRegistrations and game_session_has_active_registrations agree (D-85)` in `sessions-parity.int.test.ts` fails if they drift.
- **Obligations on billing**: COMPLETED only through the matrix. The version bump is automatic. A column billing must write on a COMPLETED row needs the D-75 allowlist widened in billing's migration, recorded in billing's ADR.

## Deviations and open questions

These were found while writing this ADR. Each is either recorded in the task file or flagged here for a human ruling.

- **(a) T-10 wording reconciled.** The binding text (BIND T-10) says "a rule save refuses any court time between 02:00 and 03:00". The code refuses only courts wholly inside the gap (`isCourtWhollyInDstGap`: start at or after 02:00 and end at or before 03:00). The code follows ALG, and this ADR adopts the code. A court that starts at 01:30 and runs past 02:00 is not refused by this rule, and the normal gap and overlap rules (`local_time_nonexistent`, `local_time_ambiguous`) apply to its times instead.
- **(b) `countActiveRegistrations` tracks the D-85 predicate.** It is named in section 8 and covered by the parity test named there. Registration widens both at its build gate.
- **(c) `lockRuleInstances` ordering.** `(date, id)` in TypeScript, `id` in the trigger's court move. Theoretical only (section 2).
- **(d) In-place amendment of the unmerged Phase 1 migration.** The `session_courts_guard_closed` lock order was amended inside `20261020000100000_session_scheduling.sql` to lock sessions in ascending id order (D-76). The task file's Phase 2 note that it is "still open" is out of date. Because the migration is unmerged, it was edited in place, which means every dev and CI database that applied the earlier draft must run `pnpm db:reset` after pulling it. There is no separate migration.
- **(e) AC-ERROR-8 open question (human decision).** AC-ERROR-8 lists "an id that belongs to another team" among the 401 and 403 cases. The API answers such ids with 404 `not_found` (the routes do not probe for existence), and a session id belonging to another team, under the caller's own team path, also returns 404 (task Deviations, Phase 2). The task file records this (Phase 2, reviewer-accepted, "Literal departure - human to decide whether to align to 403"). This ADR documents 404 as the implemented behaviour. A human must decide whether to change it to 403.
- **(f) Log `teamId` on sweep and retry events.** `session.recurrence.sweep_completed` carries no `teamId`, because the sweep is cross-team (human ruling 2026-10-20). `session.lock_retry*` events do carry `teamId`.
- **Recurrence horizon default.** `recurrenceHorizonDays` is optional in `AppDeps` (`app.ts:74`) and in `RegisterJobsOptions` (`bootstrap.ts:47`), and it defaults to 28 (`DEFAULT_RECURRENCE_HORIZON_DAYS`). `main.ts:65` and `worker.ts:81` pass it from config. An entrypoint that forgets it does not fail to compile, and silently gets 28. Making it required is a follow-up.
- **5th-weekday copy.** No change is needed. The stored `monthly_week` of -1 already means the last weekday of the month (D-70), and the copy matches.
- **Stale notes in the task file.** The Phase 2 note "CLI `jobs trigger session-auto-enrol` is not in TRIGGERABLE" is out of date, because `cli.ts` includes it. The Phase 3 note about `:<recipientId>` is reflected in section 3 (point 5).
- **Email key.** AC-ASYNC-3 names the key without the recipient. The implemented key includes `<recipientId>` (`emails.ts:49`), so each admin receives the email. The AC text should be updated to match.

## Alternatives considered

The full alternatives are in ARCH and ALG and are not repeated here. In brief:

- **Auto-enrol inside the publish transaction.** Rejected: it would take `team_members` after the session lock, against C-ALL-1. Section 6 is the follow-up form.
- **A trigger that refuses unsupported DST times (ALG H10).** Not adopted (BIND T-10). TypeScript validation and the rewrite of gap times are enough.
- **Cancelling or unpublishing dependent sessions on a banking removal.** Rejected, as in ADR 0016.
- **Rollout options (a), (b) and (d) for the allocator gap.** The no-op port with a durable marker (section 6) was chosen, so no feature needs a flag day.

## Consequences

- Every consumer's plan must cite this ADR. registration-and-waitlist's build gate re-runs `sessions-contracts.int.test.ts` and the D-85 parity test, and widens the predicate and `countActiveRegistrations` together.
- A session pending because no real allocator ran is reconciled by the sweep and by AC-ASYNC-5 (the auto-enrol window between commits is bounded by the marker).
- The admin session pages are covered by axe and the 360 px layout check in `apps/web/e2e/sessions.spec.ts` (AC-VERIFY-8). The spec ships with this feature.
- Two encodings of the DST and deadline rules exist (SQL and TypeScript), plus a parity test for each: the 48 h literal, and the matrix. Changing either requires changing both and their tests.
- The 48 hour literal lives in SQL as well as in `CANCELLATION_DEADLINE_DEFAULT_HOURS`, and the parity test pins them together.
- The horizon default of 28 days is applied by two code paths, with the risk noted above.
- A DB-enforced immutability rule means a completed session's `ends_at` can never move, so game counts (ADR 0017) cannot shift after billing completes a session.
