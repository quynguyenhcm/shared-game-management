# Archive: Registration and Waitlist

## Metadata
- Task: registration-and-waitlist
- Complexity: Level 4
- Started: 2026-10-14 (plan approved; creative 2026-10-16; build held behind session-scheduling-engine until 2026-10-24)
- Completed: 2026-10-30 (archived; reflection 1b2ef5d dated 2026-10-27)
- Duration: 16 calendar days end to end. Plan and creative 2026-10-14 to 2026-10-16; plan amendments 2026-10-20 (R14-R18) and 2026-10-24 (R19-R27); build 2026-10-24 to 2026-10-25 (6 phases, `/yay:build --auto`); post-build human rulings O5 to O8 2026-10-25 to 2026-10-26.
- Roadmap Link: registration-and-waitlist (v1.0.0)
- Branch: feature/registration-and-waitlist, tip 1b2ef5d, 25 commits ahead of `origin/main` (cc324a3), 0 behind. `pr_target` and `metadata_branch` are both `main`.
- Status at archive: final whole-branch review verdict "ready to merge with fixes"; the one Important finding is fixed (O5), the C3 residual is accepted by human ruling (O6), and the reflection lists six Minor findings as open (see Known Issues).

## Executive Summary
Players can now register for a published session with up to two guests, join a first-fit FIFO waitlist when it is full, and withdraw. An early withdrawal is free. A late withdrawal is free if someone takes the place; otherwise the player owes the fee until someone does. Three or more OVERDUE payments block registration. A team ban now really cancels the member's upcoming registrations, through the real `MemberBannedHandler` and a daily reconciliation sweep. The feature also fills session-scheduling-engine's allocator port, so auto-enrol and capacity edits place and promote real people, and it hands billing a money-free, final list of who owes (`listBillableRegistrations`).

The diff is 168 files, +27.9k / -0.4k lines. Final `pnpm run ci` is green: 3197 tests in 215 files, coverage 96.5% statements, 90.33% branches, 98.89% functions, 98% lines. Playwright `registrations.spec.ts` passes 8/8 (4 journeys on desktop and 360 x 740) with axe, a no-horizontal-scroll check and 44 px targets at every state. ADR 0018 records the design and the cross-feature contracts.

## System Overview
### Purpose
Registration is the product's core loop: players claim a place, overflow queues fairly, and a late cancellation is paid by someone. This feature owns every seat change on a session and records liability, so wallet-and-akahu-billing can charge exactly the right people at session start without recomputing history.

### Scope
Included:
- Register (alone or with 1 to 2 guests, whole party confirmed or waitlisted together), withdraw, leave the waitlist, re-register.
- First-fit FIFO waitlist with D-14 positions (never renumbered) and promotion on every seat change.
- Debt gate (3+ OVERDUE payments across all the user's teams).
- Early, late and ban withdrawal classification; the late-fee liability flag and its release on refill.
- Registrant pricing snapshot (sex, skill level) on every transition into CONFIRMED (C-PRICE-1, R15).
- Auto-enrol through SSE's port, with the opt-out re-checked under the member lock (C-SKL-1, R16), labelled "Added automatically (Auto Enroll)" and emailed (R17).
- Promotion and auto-enrol emails, committed with the placing transaction.
- Real ban handler, the `registration-ban-reconcile` sweep, and the restored ban-confirmation copy.
- The player session page `/teams/[teamId]/sessions/[sessionId]` with a stacked registration panel, and an "Upcoming sessions" section on the team page.
- The billing hand-off `listBillableRegistrations`.

Excluded:
- Writing any money row (`payments`, line items, credits). Billing owns all of it (AC-VERIFY-10).
- Writing OVERDUE (billing's `daily-overdue` job). Until billing ships the debt gate counts zero in production.
- Notifying players of a session cancel or edit (SSE P-2). The page shows "This session has been cancelled." as the only signal.
- Skill restrictions on sessions (none exist).

### Key Capabilities
- `GET /teams/:teamId/sessions/:sessionId/registration`: read model (seats, waitlist length and rank, fee per person and party estimate, `me.feeLevel`, `blockedReason`).
- `POST .../registrations` (201, CONFIRMED or WAITLISTED) and `POST .../registrations/me/withdraw` (body `{ expectLate }`, 409 `cancellation_terms_changed` if the deadline passed while the confirmation was open).
- `GET /teams/:teamId/sessions/upcoming` (next 10 sessions for members).
- Refusals: `overdue_payments` 403, `session_not_open` 409, `already_registered` 409, `not_registered` 409, `party_exceeds_capacity` 422, `late_withdrawal_fee_due` 409, `cancellation_terms_changed` 409.

## Architecture
### Overview
A `modules/registrations` slice with one pure decision function and one writer. Every seat change goes through `createAllocator` (register, auto-enrol, withdraw, promote) under the single `game_sessions FOR UPDATE` lock (D-14), calls the pure `decideAllocation` in `allocation.ts`, and applies the result through guarded writes in `repo.ts`, the only file allowed to write `registrations` and `registration_guests` (enforced by `boundaries.test.ts`). The database backstops every rule: a transition trigger, stamp CHECKs, a deferred capacity trigger that takes the session row `NOWAIT`, and a one-way liability flag.

### Component Diagram
Text form (no diagram file was produced):

```
web  /teams/[teamId]/sessions/[sessionId]  (player page, RegistrationPanel, PlayerSessionSummary)
     /teams/[teamId]                        (Upcoming sessions section)
  |  Server Actions (lib/registrations/actions.ts) -> apiClient
  v
API  modules/registrations/{routes,service,read-model,access,errors}
  |     -> allocator.ts (createAllocator) -> allocation.ts (pure decideAllocation)
  |                                        -> repo.ts (only writer) -> emails.ts (enqueueEmail in trx)
  |-- teams/membership.assertApprovedMember (FOR SHARE, before the session lock)
  |-- session-allocator-adapter.ts  ==> SSE SessionAllocatorPort (createSessionAllocator returns it)
  |-- billing-handoff.ts listBillableRegistrations  ==> wallet-and-akahu-billing (future)
  v
Postgres: registrations (+ D-62..D-69 columns, triggers, CHECKs), registration_guests,
          game_sessions.auto_enrol_notify (D-86), game_session_has_active_registrations (D-68)
  ^
pg-boss worker: member-banned (real handler, ban-handler.ts)
                registration-ban-reconcile (45 5 * * * Pacific/Auckland, boot, on demand)
                session-auto-enrol / recurrence sweeps (SSE) -> port -> allocator
                send-email (promotion, auto-enrol)
```

### Data Flow
- **Register**: route guard (`requireTeamRole('MEMBER')`) -> team-scoped lock-free session header read (404 for unknown, DRAFT or foreign ids) -> transaction: debt count (no lock) -> `assertApprovedMember` (`team_members FOR SHARE`) -> `game_sessions FOR UPDATE` -> read now -> `decideAllocation` -> repo writes (row, guests, snapshot, releases of older owed fees) -> promotion/auto-enrol emails enqueued -> commit -> one `registration.*` log event from the allocator.
- **Withdraw**: session lock -> classify EARLY (`now <= cancellation_deadline`) or LATE -> `settle` promotes every waitlisted party that fits (first-fit) -> if LATE and nobody was promoted, `withdrawal_fee_due = true`.
- **Ban**: team-management commits the ban and enqueues `member-banned` -> the real handler selects the member's active rows in future PUBLISHED sessions, one transaction per session in `(starts_at, id)` order, withdraws with kind BANNED (no fee, no email to the member) and promotes. The daily sweep re-enqueues any BANNED member who still holds an active registration.
- **Auto-enrol and capacity edits**: SSE's transaction calls the port with `ctx.now`; the adapter opens no transaction, takes no extra lock, reads no clock.
- **Billing (future)**: at or after `starts_at`, inside a transaction, `listBillableRegistrations(trx, sessionId, now)` locks the session `FOR SHARE` and returns every CONFIRMED row and every WITHDRAWN row whose fee is still owed, with the pricing snapshot, minus registrants BANNED in the team with `banned_at <= starts_at` (O6).

### Integration Points
- **team-management (ADR 0015)**: `assertApprovedMember` inside the transaction before the session lock; real `MemberBannedHandler` replaces the no-op; reconciliation sweep; restored ban copy ("Their upcoming registrations will be cancelled."). `teams-ban-seam.int.test.ts` now runs the real handler.
- **session-scheduling-engine (ADR 0019)**: fills `SessionAllocatorPort` (`promoteWaitlist(ctx, { teamId, sessionId })`, `autoEnrolInSession(ctx, { teamId, sessionId, entries, notify })`); widens D-85; owns the player page SSE did not ship; routes registered before SSE's so the static `upcoming` segment wins.
- **skill-levels-and-auto-enroll (ADR 0017)**: C-PRICE-1 snapshot; C-SKL-1 opt-out re-check under the member lock (`auto_enroll_changed`); R17 label and email.
- **team-banking-and-gst (ADR 0016)**: tests use payout-configured teams (`insertPublishedSession`, R18); no change to the publish gate.
- **wallet-and-akahu-billing (future)**: `listBillableRegistrations` contract (ADR 0018 C-BIL-1 to C-BIL-3), OVERDUE read by the debt gate.

## Design Decisions
Precedence when docs disagree: Plan Amendment 2026-10-24 (R19-R27, O1-O4), then Plan Amendment 2026-10-20 (R14-R18), then Creative Reconciliation (R1-R13), then the owning creative doc, then the ACs. Post-build rulings O5-O8 override all of these where they apply.

### R1: First-fit promotion
- **Decision**: after every change, scan WAITLISTED parties in `queue_position` order and promote each one that fits; an unfit party keeps its place. Nothing is promoted at or after `starts_at`. Parties are never split.
- **Rationale**: a large group at the head of the queue would otherwise block every smaller party and leave seats empty.
- **Alternatives Considered**: strict head-of-line blocking; bounded skip.
- **Reference**: `memory-bank/creative/registration-and-waitlist-allocation-algorithm.md`

### R2 / R3 / O7: Late fee is a releasable liability, not a payment row (user)
- **Decision**: `withdrawal_fee_due` is set only when a LATE withdrawal promotes nobody, and may only go true -> false (trigger). Any later step before `starts_at` that confirms seats releases the oldest owed fees first, whole parties. Re-registering while a fee is owed is allowed only if the new party is confirmed at once and is at least as large (409 `late_withdrawal_fee_due` otherwise). O7 (2026-10-26) confirmed the all-or-nothing release: any refill releases the oldest owed fee whole.
- **Rationale**: keeps this feature money-free and gives billing a deterministic, final hand-off.
- **Alternatives Considered**: always charge the late withdrawer; a separate liability table; billing derives liability from history; per-unfilled-seat liability (rejected in O7).
- **Reference**: algorithm doc option 3B; ADR 0018 section 4

### R4 / R5: Concurrency
- **Decision**: one session row lock per operation (D-14), lock order `teams -> team_members -> game_sessions -> registrations -> registration_guests -> payments` (a slice of SSE's `LOCK_ORDER`), READ COMMITTED, `SET LOCAL lock_timeout` (2 s HTTP, 5 s jobs), 3 attempts on 40P01/55P03 with `now` read once. The deferred capacity trigger (D-65) takes the session row `FOR UPDATE NOWAIT`, so a writer that skipped the allocator fails at once instead of forming a reverse-order wait.
- **Alternatives Considered**: SERIALIZABLE; advisory locks; an immediate capacity trigger; no DB backstop.
- **Reference**: `memory-bank/creative/registration-and-waitlist-allocator-architecture.md` option 2A

### R6: Ban handler granularity and sweep
- **Decision**: one job per membership, one transaction per session, continue past a failed session, transient vs permanent classification (`NonRetryableJobError`). Sweep at `45 5 * * *` Pacific/Auckland (O4), at every worker boot, and on demand (`pnpm run jobs:trigger registration-ban-reconcile`), paging by keyset `(banned_at, id)` in pages of 500.
- **Reference**: architecture doc option 4A; ADR 0018 sections 10-11

### R8 / R23: Page ownership
- **Decision**: this feature owns the player session page and the "Upcoming sessions" section (SSE shipped none). The player summary component is `PlayerSessionSummary`, distinct from SSE's admin `SessionSummary`.
- **Reference**: `memory-bank/creative/registration-and-waitlist-registration-user-journey.md`

### R9: Deadline passing while the confirmation is open
- **Decision**: withdraw takes `{ expectLate }`; if the in-transaction classification is LATE and the client expected EARLY, 409 `cancellation_terms_changed` and the page re-opens with the late wording.

### R11: Panel UI
- **Decision**: stacked, state-driven panel (`panelView`), Server Components with client islands; focus stays put when guest fieldsets appear and moves to the error summary on failure; impossible party sizes are natively `disabled` with a visible hint; confirmations use `ConfirmDisclosure` extracted from `InlineConfirm`.
- **Reference**: `memory-bank/creative/registration-and-waitlist-registration-panel-uiux.md`

### R15 / R16 / R17: Skill-levels obligations
- **Decision**: `registrant_sex` and `registrant_skill_level` are snapshotted in the update that makes a row CONFIRMED and never changed while it stays CONFIRMED or becomes WITHDRAWN. Auto-enrol re-checks the opt-out under the member row lock. `registrations.source` (`MEMBER`, `AUTO_ENROL`) drives the label and the auto-enrol email.

### R19-R27 and O1-O4: Session-scheduling-engine merge obligations (2026-10-24)
- **O1**: split the counts. `countActiveRegistrations` / `game_session_has_active_registrations` (fee lock) also count a WITHDRAWN row with a fee owed; the display count `countRegisteredPlayers` stays CONFIRMED + WAITLISTED. Every SSE call site switched; the parity test keeps SQL and TS equal.
- **O2**: registration's member routes keep 404 for another team's session id (SSE's admin routes answer 403); ADR 0018 section 10 records why.
- **O3**: accept and document, no session-version check on registration writes.
- **O4**: sweep slot `45 5 * * *`, after `auth-cleanup` (05:00) and `skill-progression` (05:30).
- **R19 / R22**: the adapter is built in Phase 2 but wired in Phase 3 only once both emails exist, so the branch never enrolled anyone silently.

### O5: Auto-enrol adds nobody after the cancellation deadline (human ruling 2026-10-25)
- **Decision**: once `now > cancellation_deadline` (locked row), every auto-enrol path skips every member with reason `deadline_passed`; SSE still stamps the D-80 marker. Manual registration and waitlist promotion are unchanged. The auto-enrol email never carries the "deadline has passed" wording.
- **Rationale**: auto-enrol after the deadline would create registrations that are already liable for a late fee. Final review Important 1.
- **Reference**: ADR 0018 section 6; commit 2184ce4

### O6: Ban residual C3 accepted, with a billing skip (human ruling 2026-10-26)
- **Decision**: (a) a ban concurrent with a promotion and (b) a banned member still CONFIRMED (or owing a late fee) at start because the hook and sweep never succeeded before `starts_at` are accepted, not fixed in locking. `listBillableRegistrations` leaves out every row whose registrant is BANNED in the session's team with `banned_at <= starts_at`. The `team_members` read is a plain unlocked `NOT EXISTS`, because locking it after the session lock would invert `LOCK_ORDER`, and `banned_at` has a single guarded writer.
- **Trade-off**: the DB does not forbid a later `banned_at` write, so a future ban-date correction feature must respect billing finality. The exclusion is silent (no logger in the function), documented in the contract comment.
- **Reference**: ADR 0018 C-BIL-1 (bans), Consequences C3; commits 313b906, 9ecf2d0

### O8: Silent first run of the auto-enrol backlog (human ruling 2026-10-26)
- **Decision**: PUBLISHED sessions SSE left pending auto-enrol before this feature existed are enrolled at the first worker boot sweep without R17 emails. Migration `20261026000100000_auto_enrol_silent_backlog.sql` (D-86) adds `game_sessions.auto_enrol_notify` (default true), backfills false on that backlog, and re-creates SSE's `game_sessions_version_bump` with the column as bookkeeping, so the backfill bumps neither `version` nor `updated_at`. The port input `notify` is required; when false only the email is skipped. Supersedes the R27 "burst at deploy" line.
- **Reference**: ADR 0018 section 6; commits 313b906, 9ecf2d0

## Implementation
### Phases
| Phase | Commits | Outcome |
|-------|---------|---------|
| Plan | 23ac906, f5744b5 | Task provisioned, spec (Opus spec writer) approved 2026-10-14, 6 phases |
| Creative | fe1c2a7, 3859360 | 4 design docs; Codex critique (3 high, 1 medium) resolved in the binding Creative Reconciliation (R1-R13) |
| Plan amendments | 6faa06f, 8fffe13 | R14-R18 (numbering, pricing snapshot, auto-enrol re-check and email, team-banking rules); R19-R27 after the SSE merge, O1-O4 ruled |
| 1: Schema and shared contracts | 401c243 | Migration `20261024000100000_registration_lifecycle.sql` (D-62..D-69), O1 count split, shared contracts and error codes, `insertPublishedSession`, fixture fixes. Review (Codex + Anthropic): 2 major, 5 minor fixed |
| 2: Allocator core and billing hand-off | 330dfd2; remediation 7549d00, 2f9ee56 | `decideAllocation`, allocator, repo, deadline, fees, `listBillableRegistrations`, port adapter (unwired), ADR 0018. **HALT**: a fee-due re-registrant spent one seat budget twice (cleared its own fee and released another owed fee, under-billing). Fixed test-first: release budget is `seatsConfirmed - liablePriorPartySize` (floor 0); property invariant I14 |
| 3: Registration API and promotion emails | 1516a22, 28cc007 | Routes, service, read model, access, emails, `registration.*` logs, OpenAPI with 401/403, `createSessionAllocator` returns the real adapter. Codex P2: a debtor got 403 instead of 404 for unknown/DRAFT/foreign sessions; fixed test-first |
| 4: Real ban handler and sweep | 85f939c, d53a268 | `ban-handler.ts`, `reconcile.ts`, `jobs/ban-reconcile.ts`, queue and slot, boot enqueue, worker pool 2 -> 5, ban-seam contract test on the real handler, runbook paragraph |
| 5: Web registration panel | 4267b7d, 5a2dcde; remediation 56a2768 | Player page, `RegistrationPanel`, Upcoming sessions, Server Actions, proxy, restored ban copy, R17 label, party Total line, SSE page-absence tripwire flipped. **HALT**: R15 missing (fee line named the level only from the snapshot). Fixed test-first with additive `me.feeLevel` |
| 6: E2E, accessibility and docs | 4373d36, 0576f5e, 60d96dc | `registrations.spec.ts` (4 journeys x 2 projects), axe, no horizontal scroll, 44 px targets (width and text inputs), docs pass |
| Final review record | b7fe84c | Anthropic only (Codex out of credits): 0 Critical, 1 Important, 8 Minor |
| Post-build O5 | 2184ce4 | Auto-enrol skips everyone after the deadline |
| Post-build O6-O8 | 313b906, 9ecf2d0 | Billing ban skip, O7 docs, silent backlog migration D-86 |
| Reflection | 1b2ef5d | `memory-bank/reflection/registration-and-waitlist-reflection.md` |

### Key Components
1. **Schema** (`db/migrations/20261024000100000_registration_lifecycle.sql`, ledger D-62..D-69): enums `withdrawal_kind` and `registration_source`; columns `promoted_at`, `withdrawn_at`, `withdrawal_kind`, `withdrawal_fee_due`, `registrant_sex`, `registrant_skill_level`, `source`; stamp and snapshot CHECKs (D-63); `registrations_guard_update` transition trigger with extra rules (queue position stable, guest count frozen, promotion stamp, fee due one way, snapshot and source immutable) (D-64); deferred capacity trigger `registrations_within_capacity` with `NOWAIT` (D-65); indexes `idx_registrations_active_member` and `idx_registrations_fee_due` (D-66, D-67); `CREATE OR REPLACE game_session_has_active_registrations` (D-68, down migration restores SSE's body); backfill (D-69). `db/migrations/20261026000100000_auto_enrol_silent_backlog.sql` (D-86).
2. **Allocator** (`apps/api/src/modules/registrations/allocation.ts`, `allocator.ts`, `repo.ts`, `tx.ts`, `deadline.ts`, `transitions.ts`): pure decision, one writer, returned refusals, one `now` per operation.
3. **API** (`routes.ts`, `service.ts`, `read-model.ts`, `access.ts`, `errors.ts`): routes registered before `sessionsRoutes`; read model in a `REPEATABLE READ READ ONLY` transaction.
4. **Hand-off and adapter** (`billing-handoff.ts`, `session-allocator-adapter.ts`, `apps/api/src/session-allocator.ts`).
5. **Jobs** (`ban-handler.ts`, `reconcile.ts`, `apps/api/src/jobs/ban-reconcile.ts`, `registry.ts`, `schedules.ts`, `bootstrap.ts` `enqueueBootSweeps`, `worker.ts`).
6. **Emails** (`emails.ts`): promotion key `registration-promoted:<registrationId>:<promoted_at epoch ms>`; auto-enrol key `auto-enrol:<registrationId>:<registered_at ISO>`.
7. **Shared** (`packages/shared/src/api/registrations.ts`, `packages/shared/src/registrations/fees.ts`, error codes in `api/errors.ts`, `withdrawal_kind` in `types/enums.ts`).
8. **Web** (`apps/web/src/app/teams/[teamId]/sessions/[sessionId]/page.tsx`, `apps/web/src/components/registrations/**`, `apps/web/src/components/teams/confirm-disclosure.tsx`, `apps/web/src/lib/registrations/{actions,labels,total,validation,outcome,paths,view}.ts`, `apps/web/e2e/registrations.spec.ts`).

### Technical Specifications
- **Log events** (single emitter, `allocator.ts`, enforced by `boundaries.test.ts`): `registration.created`, `registration.withdrawn`, `registration.promoted`, `registration.refused`; plus `registration.ban.session_skipped`, `registration.ban.session_failed`, `registration.ban_reconcile.completed` (`scanned`, `enqueued`, `alreadyQueued`, `invalid`), `team.member.banned.handled`, `session.auto_enrol.completed` (`silent` count for O8 sessions). Ids only, no PII.
- **Queues**: `member-banned` (team-management queue, real handler), `registration-ban-reconcile` (`exclusive`, `45 5 * * *` Pacific/Auckland, boot, `TRIGGERABLE`).
- **Port reasons**: `already_registered` (row in any status), `auto_enroll_changed`, `deadline_passed` (O5), plus the allocator's refusals.
- **Billing contract**: call only at or after `starts_at`, inside a transaction (`not_in_transaction`, `before_start` errors otherwise); empty for sessions that are not PUBLISHED or COMPLETED.

### Requirements as built
Downstream features must not inherit obsolete AC wording:
- **AC-HAPPY-9**: first-fit only; the "block" fallback is dropped (R1).
- **AC-HAPPY-6 / 6b**: the late-fee copy is conditional ("...unless someone takes your place before the game"), and a released fee drops out of the hand-off (R2).
- **AC-HAPPY-8**: re-registering while a fee is owed is constrained (R3, 409 `late_withdrawal_fee_due`).
- **AC-VERIFY-8**: focus does not move to "Guest 1" (R11); the impossible party option is natively `disabled` (R11), not `aria-disabled` as AC-ERROR-4 says.
- **AC-ASYNC-2**: `createRegistrationsBanHandler` also takes `webBaseUrl` (for the promotion link).
- **AC-ASYNC-3**: slot `45 5 * * *` (O4); the sweep pages by keyset instead of a single `LIMIT 1000`.
- **AC-VERIFY-5**: the page uses `formatDayShort` + `formatClock`, not `formatNzDateTime`.
- **AC-HAPPY-11**: no "deadline has passed" wording (O5); no email for the O8 backlog.
- **AC-INTEGRATION-3**: billing skips registrants BANNED with `banned_at <= starts_at` (O6).
- **AC-INTEGRATION-4**: e2e uses capacity 3 (A + 1 guest, then a party of three waitlisted and promoted whole).
- **Withdraw body** is `{ expectLate: boolean }` (R9), not `{}`.

## Testing
### Strategy
Pure rules (`decideAllocation`, transitions, fees, access, panel view) are table-tested, with a property test over random register/withdraw/ban/capacity sequences and an invariant list (I1-I14). Database rules, triggers, races and lock order run against real PostgreSQL 17 with per-file databases and lock-waiter probes (no sleeps). AC-INTEGRATION-1 races run through the allocator, again over HTTP, and again through the real ban handler. SSE's suites (`sessions-contracts`, `sessions-parity`, `sessions-schema`) were re-run at the build gate and updated deliberately for D-85. Playwright journeys run against the Compose stack, creating and publishing sessions through SSE's admin API. Every remediation and post-build ruling recorded an observed RED before the fix.

### Results
| Test Type | Count | Pass Rate |
|-----------|-------|-----------|
| Unit + integration (`pnpm run ci`, final) | 3197 tests in 215 files | 100% |
| E2E (Playwright `registrations.spec.ts`) | 8 (4 journeys x desktop and 360 x 740) | 100% |

The split between unit and integration at the last full run is not recorded separately; at Phase 2 it was 2121 unit and 782 integration.

### Coverage
Aggregate (gate is 80%, aggregate over `vitest.config.ts` `coverage.include`, which now includes `modules/registrations/**`, `jobs/ban-reconcile.ts`, `packages/shared/src/registrations/**` and `apps/web/src/lib/**`): 96.5% statements, 90.33% branches, 98.89% functions, 98% lines.

Not verified: `/yay:uat` (no `ux-patterns.md`), screen reader walk, axe moderate/minor impacts beyond the critical/serious gate.

## Known Issues / Open Items at Archive
**Final whole-branch review (Opus, Anthropic only; Codex workspace out of credits): ready to merge with fixes. 0 Critical, 1 Important, 8 Minor.**

### Important (RESOLVED)
1. Auto-enrol could place members after the cancellation deadline, creating instantly late registrations. Fixed by human ruling O5 (2184ce4).

### Residual (ACCEPTED)
- ADR 0018 C3: a ban concurrent with a promotion can still promote that member (one possible false promotion email), and a member whose ban was never processed before start stays CONFIRMED. Accepted by O6, with the billing skip as mitigation.

### Minor findings left open (as recorded in the reflection)
1. The ban handler's fixed selection clock can promote or release a fee after `starts_at` if a run spans the start.
2. `registration.*` log events are emitted before the transaction commits.
3. Promotion and auto-enrol emails show only the per-person fee.
4. Withdraw has no in-transaction member re-check.
5. Worker database pool `max: 5` is a hardcoded literal in `apps/api/src/worker.ts` (`WORKER_DB_POOL_MAX` follow-up).
6. E2E SQL writes (the three OVERDUE rows) have no guard against a non-localhost database.

These six are open. The other two Minors were ADR 0018 doc errors: the C3(b) sentence about an unlocked member gate (a case that cannot happen) and the section 5 snapshot-lock claim. Both were fixed with O5 in 2184ce4.

### Other open items
- `autoEnrolInSession` reloads state per member (about 6 queries each); measure when auto-enrol batches grow.
- `waitlistRank` counts hidden banned rows (cosmetic).
- HTTP race tests depend on the 2 s `lock_timeout` (CI flake watch item).
- `memory-bank/ux-patterns.md` does not exist; run `/yay:ux-ingest`, then `/yay:uat` for the registration journeys.
- ADR 0018 is "Proposed until merge"; set it to Accepted when the PR merges.

## Deployment
### Procedures
1. Merge. Both migrations reach `main` as written: `20261024000100000_registration_lifecycle.sql` was committed once (Phase 1, 401c243) and not amended in place afterwards; `20261026000100000_auto_enrol_silent_backlog.sql` is new (313b906, header comment touched in 9ecf2d0). A dev or CI database that applied an uncommitted local draft of either file must run `pnpm db:reset`; databases built from branch commits need nothing extra.
2. **Run the migrations (release command) before the new worker boots.** D-86 marks exactly the sessions pending auto-enrol at migration time as silent. A session published by the old build after the migration but before the new worker boots is emailed as normal.
3. Deploy API and worker, then web. The worker must run: it carries the real `member-banned` handler, the `registration-ban-reconcile` sweep (boot and 05:45 daily) and SSE's sweeps, which now enrol through the real adapter.
4. At first worker boot, expect SSE's sweep to enrol the pre-deploy backlog silently (`session.auto_enrol.completed` with a `silent` count) and the ban sweep to re-enqueue `member-banned` for every member banned while the no-op handler ran.
5. Operator paths: `pnpm run jobs:trigger registration-ban-reconcile`; see `docs/getting-started.md` "Ban reconciliation".

**Support consequences of O8**: backlog members get no "added" email. A waitlisted backlog member's first contact may be a later promotion email. A confirmed backlog member who misses the "Added automatically (Auto Enroll)" label before the cancellation deadline can owe a late fee (bounded by O5: nobody is auto-enrolled after the deadline).

### Configuration
- No new environment variables. Email links use `WEB_BASE_URL`; the sweep time and lock timeouts are code constants; the worker pool size is a hardcoded literal (open Minor 5).

### Rollback
- Roll back this feature **before** session-scheduling-engine: it widens SSE's D-85 function and replaces the allocator body. The down migration of `20261024000100000` restores SSE's original `game_session_has_active_registrations`; the down migration of `20261026000100000` drops `auto_enrol_notify` and restores SSE's `game_sessions_version_bump`.
- Rolling back after registrations exist loses the new columns (liability, snapshot, source). Bill or export first if billing has shipped.
- Reverting to the no-op `createSessionAllocator` leaves new sessions pending auto-enrol again (SSE's expected pre-registration state).

## Maintenance
### Monitoring
- `registration.refused` by `reason` (a spike in `overdue_payments` after billing ships; `party_exceeds_capacity` signals bad session setup).
- `team.member.banned.hook_failed` (`hook: 'registrations'`) and `registration.ban.session_failed`.
- `registration.ban_reconcile.completed` `enqueued` should be near zero once steady; persistent non-zero means handler jobs are failing.
- `session.lock_retry` / `_exhausted` on registration paths.
- `pgboss.job` for `member-banned`, `registration-ban-reconcile`, `send-email`.

### Common Issues
| Issue | Resolution |
|-------|------------|
| Banned member still CONFIRMED in an upcoming session | Check `member-banned` job state; run `pnpm run jobs:trigger registration-ban-reconcile`. If the session already started, O6 keeps them out of billing. |
| 55P03 from `registrations_within_capacity` | A writer touched `registrations` without the allocator's session lock. Route the write through `createAllocator`. |
| 23000 from `registrations_guard_update` | An illegal transition (e.g. demotion) or a change to an immutable column; fix the caller, never the trigger. |
| Late fee not released after a refill | Check the refill happened before `starts_at` and through the allocator; releases are oldest-first, whole parties. |
| Fees locked on a session nobody is registered for | A WITHDRAWN row still owes a late fee (D-68 counts it). Expected. |
| Player says they were added without an email | O8 backlog session (`auto_enrol_notify = false`). Expected. |
| HTTP race tests fail with `lock_retry` on slow CI | 2 s `lock_timeout` watch item; re-run, then consider raising the test policy. |
| `timeout: command not found` when launching Codex | macOS lacks `timeout`; call the companion directly or use `gtimeout`. Check Codex credits before a long auto-build. |

### Operational Procedures
- Only `repo.ts` writes `registrations` and `registration_guests`; only `allocator.ts` emits `registration.created|withdrawn|promoted|refused`. `boundaries.test.ts` enforces both.
- `game_session_has_active_registrations` (SQL) and `countActiveRegistrations` (TS) change together; the parity test fails otherwise.
- `game_sessions_version_bump` is now re-created by this feature (D-86). Any later change to SSE's bookkeeping list must keep `auto_enrol_notify` in it.
- `banned_at` must stay single-writer; a ban-date correction feature must respect billing finality (O6).
- Billing must call `listBillableRegistrations` at or after `starts_at`, inside a transaction.

## Cross-feature obligations honoured
**session-scheduling-engine (ADR 0019 and its archive's hand-off):**
- D-85 widened in SQL (`game_session_has_active_registrations` counts fee-due WITHDRAWN rows) and in TS (`countActiveRegistrations`) together, with the parity test; display count `countRegisteredPlayers` split off (O1) and every SSE call site switched.
- `createSessionAllocator` body returns `createRegistrationsSessionAllocator` (`name: 'registrations'`, `enrols: true`); the real-adapter marker proof runs through SSE's sweep, capacity `PUT` and series propagation (AC-INTEGRATION-6).
- `already_registered` for an existing row in any status (ALG R-b).
- Port calls run inside SSE's transactions with `ctx.now`; no new session lock out of `(date, id)` order.
- `feesLocked` null/`'raise_only_blocked'` contract untouched; fee-lock copy reworded because a fee-due withdrawal now locks fees.
- Another team's session id: SSE's admin routes keep 403; registration's member routes keep 404 (O2, ADR 0018 section 10).
- Player page ownership taken; SSE's page-absence check in `sessions-contracts.int.test.ts` flipped to assert the page.

**team-management (ADR 0015):** gate inside the transaction before the session lock; real handler; sweep; restored ban copy (`banPrompt`, unit tests, `manage-components.test.tsx`, `teams.spec.ts`).

**skill-levels-and-auto-enroll (ADR 0017):** C-PRICE-1 snapshot, C-SKL-1 point 4 re-check, auto-enrol label and email.

## Lessons Learned
- **Product policy hides in technical decisions.** Four rulings (O5-O8) surfaced only after the build: auto-enrol at the deadline, ban vs billing, the fee-release rounding rule, and the deploy-time email burst. Each was a product rule that the spec or creative phase could have forced into the open.
- **Rule interactions need conservation invariants.** The Phase 2 double waiver came from two individually correct rules (R2 release, R3 re-registration) sharing one seat budget; the property invariant I14 was added only after the HALT.
- **Amendments that change UI copy must rewrite the AC.** R15 lived only in a phase-mapping clause and was missed until the Phase 5 HALT.
- **Residuals marked "pending human sign-off" age.** C3 was flagged in Phase 2 and ruled only post-build (O6).
- **The spec-reading phase reviewer and the pre-build critique paid for themselves**: they caught the only money bug, the missed amendment and three high design issues before code existed.
- **Single-model final review on money code is a risk.** Codex ran out of credits mid-build.
- **Verifier sub-agents ran a destructive `git checkout`** (wiped a regenerated `openapi.yaml`) and once ran in the primary checkout.

Learning consolidation done at archive:
- Evidence and a nuance bullet added to `_learned/db-derived-flags-and-gates.md` (one-way liability flags with a netting rule and a conservation property).
- Two bullets and evidence added to `_learned/review-process-plan-claims.md` (re-flag pending residuals at each gate; product-policy rulings before build).
- A bullet and evidence added to `_learned/git-worktree-attached-head.md` (verifier safety), promoted to `priority: medium` (evidence 3).

Reflection corrections applied at archive: `systemPatterns.md` (O6 billing ban skip in the hand-off contract, the liability-flag convention, order-inverting reads and the `NOWAIT` backstop rule); `techContext.md` (check Codex credits before a long auto-build). The Test Scope Preferences fix from Phase 6 was confirmed present. The canonical lock order and the macOS `timeout` note were already in the memory bank.

Reference: `memory-bank/reflection/registration-and-waitlist-reflection.md`

## References
- Reflection: `memory-bank/reflection/registration-and-waitlist-reflection.md`
- Task: `memory-bank/tasks/registration-and-waitlist.md` (Specification, ACs, Creative Reconciliation R1-R13, Plan Amendments R14-R27, rulings O1-O8, Execution State, Guard & Recovery Log, Deviations ledger)
- ADR: `docs/adr/0018-registration-allocation-and-billing-handoff.md`
- Architecture doc: `memory-bank/creative/registration-and-waitlist-allocator-architecture.md`
- All creative docs:
  - `memory-bank/creative/registration-and-waitlist-allocation-algorithm.md`
  - `memory-bank/creative/registration-and-waitlist-allocator-architecture.md`
  - `memory-bank/creative/registration-and-waitlist-registration-user-journey.md`
  - `memory-bank/creative/registration-and-waitlist-registration-panel-uiux.md`
- Schema ledger: `db/schema-deviations.md` (D-62..D-69, D-86)
- Upstream ADRs: 0015 (team management ban seam), 0016 (team banking), 0017 (skill levels and auto enroll), 0019 (session scheduling engine)
- Implementation Timeline: `git log main..feature/registration-and-waitlist` (base cc324a3)

## Future Considerations
1. **wallet-and-akahu-billing**: consume `listBillableRegistrations` at or after `starts_at` inside a transaction; price from the snapshot, never current `users.sex` / `team_members.skill_level`; write OVERDUE so the debt gate becomes live.
2. **Open Minors**: fixed selection clock past start, logs before commit, party total in emails, withdraw member re-check, `WORKER_DB_POOL_MAX`, e2e non-localhost guard.
3. **UX**: run `/yay:ux-ingest`, then `/yay:uat` on the registration journeys (Level 4, strongly recommended).
4. **Player notifications** for SSE cancels and edits remain deferred (SSE P-2).
5. **Performance**: measure `autoEnrolInSession` per-member reloads and register/withdraw p95 at 100 registrations per session.
6. **Process (plugin, not memory bank)**: a product-rulings gate before build (money rounding, automated actors at each time boundary, deploy-time backlog effects, billing-ban interactions); verifier prompts that forbid `git checkout/restore/stash/reset` and assert the worktree; a reviewer-backend health preflight.
