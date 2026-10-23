# Archive: Session Scheduling Engine

## Metadata
- Task: session-scheduling-engine
- Complexity: Level 4
- Started: 2026-10-20 (task provisioned, commit 4c04473)
- Completed: 2026-10-24 (archived; reflection 473c7a5 the same day)
- Duration: 4 calendar days. Plan, creative and all six build phases plus the final review landed on 2026-10-20; reflection and archive on 2026-10-24.
- Roadmap Link: session-scheduling-engine (v1.0.0)
- Branch: feature/session-scheduling-engine (fork point 1ee4520; pr_target and metadata_branch both `main`)
- Status at archive: **Ready to merge WITH FIXES**. Two Important findings and one human decision are open. See "Known Issues / Open Items at Archive".

## Executive Summary
Team admins can now set up one-off and recurring multi-court sessions, cost them, change a single night without breaking its series, and publish them through the team-banking gate. The feature adds a new "Sessions" area at `/teams/[teamId]/manage/sessions`, a `sessions` API module, a pure shared recurrence core, a materialiser (daily sweep plus per-rule jobs), an auto-enrol follow-up queue, and an allocator port that registration-and-waitlist will fill in. ADR 0019 records the contracts honoured and offered.

The engine is complete and heavily tested (1952 unit, 637 integration, 2 Playwright runs; aggregate coverage 96.3% statements / 90.0% branches). The build was not clean: three HALT/remediate cycles, a detached-HEAD incident, and soft TDD discipline. The final whole-branch review found 0 Critical, 2 Important and 8 Minor findings, and none of the Important ones are fixed in this archive. **This archive is written before they are fixed.**

## System Overview
### Purpose
Producer of sessions for three consumers: registration-and-waitlist (registrations and the seat allocator), wallet-and-akahu-billing (bills PUBLISHED sessions and moves them to COMPLETED), and dashboards. It turns "retype the same Wednesday night every week" into a rule that a worker expands into dated sessions with courts.

### Scope
Included:
- Recurring rules (weekly, fortnightly, monthly; optional `recur_until`) and worker materialisation of sessions and courts.
- Single-instance overrides that survive later series edits.
- Session fields (location, address, date, cancellation deadline, `max_players`, `reserved_seats`), multi-court bulk times with per-court overrides.
- Costing (suggested rate) and pricing models `FLAT`, `BY_SEX`, `BY_SKILL_LEVEL`.
- DRAFT, PUBLISHED, CANCELLED lifecycle (COMPLETED exists in the matrix but is reachable only from billing).
- Auto-enrol of members on first publish (P-1), via the allocator port.

Excluded:
- Player-facing session page and "Upcoming sessions" list (registration-and-waitlist).
- Any email to players about a cancel or change (P-2). The admin is shown the registered count instead.
- Registrations, the real allocator, billing and completion.
- Changing a series' day, frequency, monthly week or first date after creation (P-3: end the series and start a new one).

### Key Capabilities
- Sessions list with Upcoming, Drafts, Series and Past/cancelled sections (25 rows per page, keyset paging).
- One-off session editor and series editor with a `CourtTable` (default times, "Apply to all courts", per-court overrides).
- Suggested rate `ceil((court cost + extras) / max_players)` in whole dollars, editable and pinnable.
- Series edits propagate to unedited upcoming sessions in one transaction and report counts.
- Banking publish gate with `returnTo` hand-off; refused series dates are saved as DRAFT and retried.
- Optimistic concurrency (`expectedVersion`) and idempotent creates (`createKey`).

## Architecture
### Overview
Pure recurrence and costing logic lives in `packages/shared` (`sessions/costing.ts`, recurrence dates, `seriesName()`). The API module `apps/api/src/modules/sessions/` owns routes, service, repo, locks, materialiser and the allocator port. Database triggers (D-72 to D-85) enforce invariants under concurrency. The web app adds the Sessions area under the existing manage shell.

### Component Diagram
Text form (no diagram file was produced):

```
web  /teams/[teamId]/manage/sessions/**   (MANAGE_AREAS entry, ManageAreaNav)
  |  apiFetch (keeps dstOptions, raisedFields)
  v
API  modules/sessions/{routes,series-routes,service,series,repo,locks,gate-step,materialise*,emails}
  |-- teams/team-banking: assertTeamCanPublishPaidSession (before any session lock)
  |-- skill-levels: selectAutoEnrollees (lock-free read, ordered)
  |-- SessionAllocatorPort  <-- createSessionAllocator (apps/api/src/session-allocator.ts; no-op today)
  v
Postgres: game_sessions, session_courts, recurring_session_rules, recurring_rule_courts,
          payout_notice_claims  + triggers D-72..D-85
  ^
pg-boss worker: recurrence-materialisation (sweep) -> recurrence-rule (per rule) ; session-auto-enrol
```

### Data Flow
- **Create series**: POST series (with `createKey`) writes the rule and court template and enqueues one `recurrence-rule` job in the same transaction. The job materialises each date in its own transaction (publish gate first, refused dates saved as DRAFT) and stamps `materialised_version`.
- **Publish**: save (PUT with `expectedVersion`), then POST publish. The publish transaction takes `teams FOR KEY SHARE`, runs the gate, re-checks the actor, locks the session, and enqueues `session-auto-enrol` in the same transaction.
- **Auto-enrol**: the job takes an advisory lock, calls `selectAutoEnrollees`, then calls `autoEnrolInSession` once with ordered `entries`. `auto_enrolled_at` is stamped only if the port's `enrols` is true.
- **Series edit**: one transaction updates the rule, template and each eligible instance in `(date, id)` order, then enqueues a rule run for new dates.

### Integration Points
- team-banking-and-gst (ADR 0016): publish gate, recurrence contract points 1-6, `returnTo` hand-off.
- skill-levels-and-auto-enroll (ADR 0017): C-SKL-1 selection and call sequence (extended to every session by P-1), C-GAME-1 point 3 (closed rows immutable).
- registration-and-waitlist: C-SSE-1..5 and C-SAE-1..2 (as amended by R16), `SessionAllocatorPort`, reserved route names.
- wallet-and-akahu-billing: COMPLETED through the transition matrix only.
- platform-foundation: `fee_other` default, DST input policy, 48 h default deadline, `recurrence-materialisation` cron slot.

## Design Decisions
Precedence when docs disagree: BIND (P-1..P-3, T-1..T-20), then ALG, ARCH, UJ, UI.

### P-1 (user): Auto Enroll applies to every session
- **Decision**: `auto_enrol_required` is true for every session, one-off or series, on first publish.
- **Rationale**: one rule for admins; applies ADR 0017 C-SKL-1 point 6 to all sessions.
- **Alternatives**: series-only auto-enrol.
- **Reference**: `memory-bank/creative/session-scheduling-engine-binding-reconciliation.md`

### P-2 (user): No player emails for cancel or change
- **Decision**: cancel and edit change no registration and send no email. The admin sees the registered count and is told to notify players.
- **Rationale**: notification belongs to a later feature; keeps C-SSE-4 simple.
- **Reference**: binding-reconciliation

### P-3 (user): Series day, frequency, monthly week and first date are fixed
- **Decision**: only "Repeat until" can be extended or cleared. Anything else means end the series and create a new one.
- **Rationale**: avoids re-anchoring existing instances.
- **Reference**: binding-reconciliation

### T-1: Lock order
- **Decision**: `teams -> recurring_session_rules -> team_members -> game_sessions -> registrations -> registration_guests -> payments`. `teams` only `FOR KEY SHARE`; rules only `FOR NO KEY UPDATE`; one session row per transaction except series edit (instances in `(date, id)` order).
- **Rationale**: ADR 0016 and registration's C-ALL-1; proven by a query-order recorder test.
- **Reference**: `memory-bank/creative/session-scheduling-engine-architecture.md`, ADR 0019 section 2

### T-2 / T-19: Auto-enrol in a follow-up transaction, serialised per session
- **Decision**: never inside the session-lock transaction. Inline after commit for new instances, queued for API publishes and pending sessions. Each follow-up takes `pg_advisory_xact_lock(0x5345_4153, hashtext(sessionId))` first.
- **Rationale**: taking `team_members` after a session lock breaks C-ALL-1.
- **Alternatives**: auto-enrol inside the publish transaction (rejected).

### T-3 / T-4: Materialiser queueing, horizon and banking-email window
- **Decision**: daily sweep (03:00 Pacific/Auckland, plus every worker boot) fans out `recurrence-rule` jobs (`stately`, one trailing run). Horizon `RECURRENCE_HORIZON_DAYS` (default 28). One banking email per rule per NZ-week window.
- **Reference**: `memory-bank/creative/session-scheduling-engine-recurrence-algorithm.md`

### T-5: Series-edit propagation
- **Decision**: one synchronous transaction; targets are future, unedited DRAFT and PUBLISHED instances whose current and new deadlines are in the future. Each target takes all of the change or none. Response reports `updated`, `unchanged` and `skipped` counts.
- **Rationale**: admins need exact counts and no partial states.

### T-6: End series is one transaction
- **Decision**: set `recur_until`, delete unedited future DRAFTs, optionally cancel PUBLISHED ones, all atomically. An ended series cannot be restarted from the UI.
- **Consequence**: no partial-failure banner (AC-HAPPY-10 amended).

### T-7: Fee edits after registration
- **Decision**: fees can only be lowered once a PUBLISHED session has active registrations (`feesLocked`, trigger `game_sessions_fee_raise_locked`).

### T-8 / T-9: Deadline default and `fee_flat`
- **Decision**: default deadline is `starts_at - 48 h` (absolute hours), kept by trigger while `deadline_is_default`. For FLAT, `fee_flat = custom_player_rate ?? calculated_rate_per_player` on every save.

### T-10: DST
- **Decision**: reject-with-options for gap and overlap times; materialiser shifts gap times forward; a template court wholly inside the 02:00-03:00 gap is refused. The code follows ALG (wholly inside), not the wider BIND wording. ADR 0019 deviation (a).

### T-11 / T-12: Edits after start; stale saves and replay
- **Decision**: TypeScript refuses edits and cancels after `starts_at` (409 `session_started`), clock read after the lock. Every write carries `expectedVersion`; creates carry `createKey`.

### T-13 / T-14 / T-15: Allocator port, AC prefixes, numbering
- **Decision**: `SessionAllocatorPort` with a no-op default and a single composition function; ADR 0019 and ledger D-70 onward; one reversible migration.

### T-17 / T-18: Active-registrations predicate and banking-email claim table
- **Decision**: `game_session_has_active_registrations` ships here (D-85) and registration widens it later. The email claim is the table `payout_notice_claims` (D-81), not a column on the rule, to avoid a rule lock upgrade deadlock.

### T-20: Task file brought in line before build
- **Decision**: ACs and ledger reconciled with the binding rulings before Phase 1.

### UI/UX decisions (summary)
- Fieldset order Details, Courts, Places, Costing, Pricing, Cancellation deadline (Places before Costing, since the suggestion divides by max players).
- Read-only summaries use `dl` and a `<table>`, never disabled inputs. `InlineConfirm` panels replace native dialogs; no Sessions confirm uses a dismiss button named "Cancel".
- Series page lists sessions first; `?edit=details` switches to a form-first mode.
- References: `memory-bank/creative/session-scheduling-engine-uiux.md`, `-admin-user-journey.md`.

## Implementation
### Phases
| Phase | Commit | Outcome |
|-------|--------|---------|
| 1: schema, shared core, contracts | c9291e8 | Migration D-70..D-85, pure recurrence core, zod contracts, fixture fixes (223 tests) |
| 2: one-off API, allocator seam, auto-enrol queue | dae608a | Reviewer found 2 blocking bugs (publishing an edit into the past, malformed cursor 500); fixed. Opened AC-ERROR-8 |
| 3: series API, materialiser, recurrence jobs | dd13c74 | Series CRUD, sweep and per-rule jobs, banking email claim (72 tests). Impl written before tests in part A |
| 4: concurrency, observability, contracts | 2668987, remediation 22002cd | HALT on `teamId` missing from `lock_retry*` logs; `sweep_completed` carve-out ruled by human. Found a real 55P03 lock-order bug in `session_courts_guard_closed`; fixed by amending the unmerged P1 migration |
| 5: admin web UI | 5afa293, remediation c7ffa60 | HALT: Series list derived from loaded rows. Remediation added `GET /session-series` and API-owned `horizonDays`. 360 px walk deferred by human ruling |
| 6: journey, accessibility, ADR, docs | 5ffb7bc | Playwright journey with axe and 360 px; found and fixed 3 product bugs; ADR 0019; discharged the P5 360 px deferral |
| Final review record | 97fd32d | Whole-branch review outcome and status header |
| Reflection | 473c7a5 | `memory-bank/reflection/session-scheduling-engine-reflection.md` |

Planning and creative: 4c04473, 9ed876e (plan); b0a4b4d, 7225ea1, 7e73754 (creative).

### Key Components
1. **Schema** (`db/migrations/20261020000100000_session_scheduling.sql`, ledger D-70..D-85 in `db/schema-deviations.md`): `starts_on`/`monthly_week` and CHECKs on rules; `recurring_rule_courts`; `version`/`updated_at` bumps; `create_key` uniqueness; default-deadline trigger; `game_sessions_guard_update` (lifecycle matrix, closed-row immutability, DELETE only for DRAFT); `session_courts_guard_closed`; C-SSE-1 CHECKs; `auto_enrol_required`/`auto_enrolled_at`; `payout_notice_claims`; `materialised_version`/`materialised_at`; `game_session_has_active_registrations` and `game_sessions_fee_raise_locked`. D-84 is reserved and not built.
2. **Shared core** (`packages/shared/src/sessions/`, `api/sessions.ts`): `suggestedRate` (via `divideByInteger(..., 'CEIL', 'DOLLAR')`), `recurrenceDates`, `defaultFeeOther`, strict zod contracts.
3. **Sessions API** (`apps/api/src/modules/sessions/`): `routes.ts`, `series-routes.ts`, `service.ts` (823 lines), `series.ts` (~716 lines), `repo.ts`, `locks.ts` (`LOCK_ORDER`), `gate-step.ts`, `allocator-port.ts`, `emails.ts`. All routes `requireTeamRole('TEAM_ADMIN')`, every query filtered by path `team_id`.
4. **Materialiser and jobs** (`materialise.ts`, `materialise-instance.ts`, `apps/api/src/jobs/{registry,schedules,bootstrap}.ts`): `recurrence-materialisation` sweep, `recurrence-rule`, `session-auto-enrol`; CLI triggers in `cli.ts`.
5. **Allocator composition** (`apps/api/src/session-allocator.ts`): `createSessionAllocator`, required in `AppDeps` and `RegisterJobsOptions`; `main.ts` and `worker.ts` both call it.
6. **Web UI** (`apps/web/src/app/teams/[teamId]/manage/sessions/**`, `apps/web/src/lib/teams/{manage-areas,sessions-paths,session-form-state}.ts`, `CourtTable`, `DeadlineFieldset`, `PatternFieldset`, `DstChoice`, `ConfirmPanel`), `apps/web/e2e/sessions.spec.ts`.

### Technical Specifications
- **Routes**: `GET|POST /teams/:teamId/sessions`, `GET|PUT /sessions/:sessionId`, `POST .../publish`, `POST .../cancel`; `GET|POST /session-series`, `GET|PUT /session-series/:ruleId`, `POST .../end`, `POST .../publish-drafts` (202). Reserved for registration: `GET /sessions/upcoming`, `/sessions/:sessionId/registration*`.
- **Queues**: `recurrence-materialisation` (`exclusive`, `0 3 * * *` Pacific/Auckland), `recurrence-rule` (`stately`, key `recurrence-rule:<ruleId>`), `session-auto-enrol` (`exclusive`, key `session-auto-enrol:<sessionId>`).
- **Email key**: `payout-missing:<ruleId>:<windowStart>:<recipientId>`, enqueued only when a claim row was newly inserted.
- **Allocator port**: `{ name, enrols, promoteWaitlist(ctx, { teamId, sessionId }), autoEnrolInSession(ctx, { teamId, sessionId, entries }) }`. `noopSessionAllocator` has `enrols: false`, so sessions stay pending until a real allocator ships.
- **Trigger firing order** (by name): `derive_instants`, `fee_raise_locked`, `fill_default_deadline`, `guard_update`, `paid_requires_payout`, `version_bump`. Renaming any changes behaviour.
- **Log events**: `session.stale_refused`, `session.recurrence.{sweep_completed,run_completed,rule_skipped,boot_sweep}`, `session.auto_enrol.{failed,port_noop}`, `session.lock_retry`, `session.published`, `session.cancelled`. Metric names are reserved but not emitted.

### Requirements as built
The task's 48 ACs were amended during build. Downstream features must not inherit the obsolete wording:
- **AC-HAPPY-10**: the partial-failure banner is dropped. End series is one transaction (T-6), so a failed cancel rolls back the whole end.
- **AC-ASYNC-3**: the email idempotency key is `payout-missing:<ruleId>:<windowStart>:<recipientId>`, so every admin is emailed.
- **AC-VERIFY-6**: `session.recurrence.sweep_completed` carries no `teamId`, because the sweep is cross-team (human ruling, 2026-10-20). `session.lock_retry*` events do carry `teamId`.
- **AC-ERROR-8**: implemented as 404 for another team's session id; still awaiting a human ruling (see Open Items).
- **T-10 wording**: ADR 0019 adopts "wholly inside the gap" (code and ALG), not "any court time between 02:00 and 03:00".
- **Minor contract drift**: `feesLocked` returns `'none'` where the spec says `null`; series list sort is ascending where the spec says newest-first.
- **Human rulings**: Phase 5's 360 px manual walk was deferred to Phase 6 and discharged there.

## Testing
### Strategy
Pure shared functions get unit tests with the platform-foundation vectors and DST cases. Database invariants, triggers, races and the lock order run against real PostgreSQL (deterministic lock-waiter probes, no sleeps). Contract tests use a recording allocator double. A Playwright journey covers the admin flow with axe and an explicit 360 px pass. TDD discipline was uneven (see Lessons Learned).

### Results
| Test Type | Count | Pass Rate |
|-----------|-------|-----------|
| Unit | 1952 | 100% (1952/1952) |
| Integration | 637 | 100% (637/637) |
| E2E (Playwright `sessions.spec.ts`) | 2 | 100% (desktop and 360x740 mobile) |

Key integration suites: `sessions-schema`, `sessions-contracts` (C-SSE-1..5), `sessions-parity` (D-85 TS/SQL parity), query-order recorder gate test, `stately` trailing-run test, `boundaries.test.ts`, `session-allocator.test.ts`. Phase 4 added 38 race tests (characterization, not RED-first).

### Coverage
Aggregate 96.3% statements, 90.0% branches. Four files are under 80% branch coverage while the aggregate gate passes:
- `series-view.ts` 79.6
- `series.ts` 76.7
- `materialise-notice.ts` 75.0
- `series-name.ts` 66.7

Not verified: screen reader, full Tab order, axe moderate/minor impacts, publish confirm panel. `/yay:uat` was not run. Codex review was unavailable for Phases 3-6 (`timeout` absent on macOS); the final review called Codex directly and it worked.

## Known Issues / Open Items at Archive
**Verdict of the final whole-branch review (Opus, Codex usable): Ready to merge WITH FIXES. 0 Critical, 2 Important, 8 Minor.** None of the following is fixed in this archive.

### Important (open, fix before merge)
1. **A series past `recur_until` still shows Active and can be restarted by PUT.** Derive status server-side and refuse PUT with 409 `series_ended`. Same defect class as the Phase 5 HALT (UI state derived from loaded rows).
2. **The list page's banking notice is computed from the loaded page only.** Serve it from a team-level server read so it does not depend on which 25 rows were loaded.

### Open human decision
3. **AC-ERROR-8: cross-team session id answers 404 or 403?** The API returns 404 `not_found` (routes do not probe for existence). The AC text lists "an id that belongs to another team" among 403 cases. A human must choose, then align the code or the AC.

### Minor and carried items
- 12-factor: `webBaseUrl ?? 'http://localhost:3000'` and `recurrenceHorizonDays` defaulting to 28 in `buildApp`/`RegisterJobsOptions`. Make both required at the composition root.
- "Nothing changed" is inferred from version equality; expose an explicit server flag.
- Fix the four under-80% branch-coverage files.
- Split `service.ts` (823) and extract `propagate` from `series.ts` (716); comment the `as never` casts; the `openapi.yaml` diff is about 8.7k lines.
- `waitForLockWaiters` latent flake: filter by locktype.
- Misleading vitest comments; stale task-file notes.
- Hand-off to registration-and-waitlist's build gate: widen `game_session_has_active_registrations` and `countActiveRegistrations` together (parity test fails if they drift).

## Deployment
### Procedures
1. Merge as **one migration**: `db/migrations/20261020000100000_session_scheduling.sql` was amended in place before merge (D-76, `session_courts_guard_closed` lock order). It must reach `main` as a single migration, not as an original plus a follow-up.
2. **Every dev or CI database that applied an earlier body of this migration must run `pnpm db:reset`** after pulling.
3. Run the migration, deploy API and worker, then the web app.
4. **The worker must run.** It carries the `recurrence-materialisation` sweep (at every boot and daily at 03:00 Pacific/Auckland) and the `session-auto-enrol` and `recurrence-rule` queues. Without it, series never materialise and auto-enrol never runs.
5. Operator paths: `pnpm run jobs:trigger recurrence-materialisation`, `pnpm run jobs:trigger recurrence-rule '<json>'`, and `session-auto-enrol` (in `TRIGGERABLE`).

### Configuration
- `RECURRENCE_HORIZON_DAYS`: integer 7 to 91, default 28 (`apps/api/src/lib/config/config.ts`), passed to the API and worker through `AppDeps` and `RegisterJobsOptions`.
- Web base URL for banking links is read from config; the localhost fallback is a known 12-factor miss (see Open Items).
- No environment variable selects the allocator adapter.

### Rollback
- Migration `down` plus revert of the feature commits.
- The allocator is a **no-op until registration-and-waitlist ships** (`enrols: false`): sessions stay pending (`auto_enrolled_at` NULL), and nothing registers members. Rolling this feature back therefore loses no registrations. Rolling back after registration ships requires rolling registration back first, since it widens D-85 and replaces the allocator body.
- Draft sessions and rules created in the meantime are lost with the tables.

## Maintenance
### Monitoring
- Structured logs `session.*` (see Technical Specifications), especially `session.auto_enrol.failed`, `session.lock_retry` (and `_exhausted`), `session.recurrence.rule_skipped` and `team.banking.publish_gate_refused`.
- `pgboss.job` for `recurrence-materialisation`, `recurrence-rule`, `session-auto-enrol`, `send-email`.
- A pending-session backlog (`auto_enrol_required` true, `auto_enrolled_at` NULL) is expected until registration ships, and abnormal afterwards.
- Reserved metric names exist but no exporter emits them yet.

### Common Issues
| Issue | Resolution |
|-------|------------|
| Series page stuck on "We're adding the sessions..." | `materialised_version` trails `version`. Check the worker is running; trigger `recurrence-rule '<json>'`. |
| Series dates saved as drafts ("bank account needed") | Team has no payout destination. Set up banking; next sweep publishes unedited drafts, or use "Publish drafts now". |
| Sessions never get Auto Enroll members | Allocator is the no-op (`enrols: false`). Expected until registration-and-waitlist ships; the sweep enrols pending sessions afterwards. |
| 409 `session_stale` / `series_stale` | Another write bumped `version`. Reload and re-save. |
| 409 `payout_not_configured` on a series edit | Edit would make a PUBLISHED instance paid. Set up banking first; nothing was saved. |
| Dev or CI schema tests fail after pulling | DB applied an earlier migration body. Run `pnpm db:reset`. |
| Court edit hits 55P03 or deadlock | Session lock order violated. Check `LOCK_ORDER` and the trigger lock order (D-76); HTTP path retries `40P01`/`55P03` once. |
| `timeout: command not found` when launching Codex review | macOS lacks `timeout`; use `gtimeout` or call the Codex runtime directly. |

### Operational Procedures
- Renaming any `game_sessions` BEFORE UPDATE trigger changes behaviour; the order test asserts it.
- The 48 h default deadline and the lifecycle matrix each exist in SQL and TypeScript with a parity test. Change both together.
- Auto-enrol advisory-lock namespace `0x5345_4153` is reserved; do not reuse it.
- Do not add a lock on `teams` stronger than `FOR KEY SHARE`, and never take one after a session lock.
- Billing needing to write a new column on a COMPLETED row must widen the D-75 allowlist in its own migration.

## Lessons Learned
- **Same defect class three times**: UI state derived from the rows already loaded (Phase 5 Series list, final-review Important 1 and 2). Each list, count or banner AC must name its authoritative read at plan time.
- **Spec-reading phase reviewer separate from code reviewers** caught real AC gaps (P2 blockers, P5 unsatisfiable ACs). The Opus final review caught two more cross-phase issues. Keep both.
- **TDD slipped repeatedly**: implementation before tests in 3A, characterization-only race tests in P4, no observed RED in P4 remediation, 5A and the three P6 fixes. "RED proven afterwards" was accepted each time; the gate is advisory.
- **Unverified git handoff**: Phase 4 commits sat on a detached HEAD and the phase claimed a push that did not happen. The orchestrator must verify the branch and that `origin/<branch>` contains HEAD.
- **Late fixes shipped unverified**: P2 and P4 fixes were not followed by a full re-run. The Documentation agent was skipped in P2-P5, causing AC text drift and stale notes.
- **Browser journey inside the build** found 3 product bugs that 1952 unit tests missed (bodiless Publish POST gave 400; bare "Changes saved."; End-series default date).
- **Real race tests** found a lock-order bug unit tests could not.
- Silent config defaults repeated an earlier 12-factor miss in smaller form.

Learning consolidation done at archive:
- Evidence added to `_learned/git-worktree-attached-head.md`, `_learned/review-process-plan-claims.md` and `_learned/testing-integration-db-isolation.md`.
- New rule `_learned/config-composition-root.md`.

Reference: `memory-bank/reflection/session-scheduling-engine-reflection.md`

## References
- Reflection: `memory-bank/reflection/session-scheduling-engine-reflection.md`
- Task: `memory-bank/tasks/session-scheduling-engine.md` (Specification, ACs, Execution State, `### Deviations` ledger)
- ADR: `docs/adr/0019-session-scheduling-engine.md`
- Architecture doc: `memory-bank/creative/session-scheduling-engine-architecture.md`
- All creative docs:
  - `memory-bank/creative/session-scheduling-engine-binding-reconciliation.md`
  - `memory-bank/creative/session-scheduling-engine-recurrence-algorithm.md`
  - `memory-bank/creative/session-scheduling-engine-architecture.md`
  - `memory-bank/creative/session-scheduling-engine-admin-user-journey.md`
  - `memory-bank/creative/session-scheduling-engine-uiux.md`
- Schema ledger: `db/schema-deviations.md` (D-70..D-85)
- Upstream ADRs: 0016 (team banking), 0017 (skill levels and auto enroll)
- Implementation Timeline: `git log main..feature/session-scheduling-engine` (fork point 1ee4520)

## Future Considerations
1. **Before merge**: fix the two Important findings and obtain the AC-ERROR-8 ruling, then re-run the full suites. Run `/yay:uat` (Level 4, strongly recommended) and the unverified accessibility items.
2. **registration-and-waitlist** (in flight): replace the body of `createSessionAllocator` with an adapter (`name: 'registrations'`, `enrols: true`); `CREATE OR REPLACE` `game_session_has_active_registrations` to count `WITHDRAWN` rows with `withdrawal_fee_due` (ALG R-a, T-17) and widen `countActiveRegistrations` with a parity run; treat an existing row in any status as `already_registered` (ALG R-b); re-run `sessions-contracts.int.test.ts` at its build gate. `promoteWaitlist(trx, sessionId, now)` is superseded by `promoteWaitlist(ctx, { teamId, sessionId })`.
3. **wallet-and-akahu-billing**: COMPLETED only through the matrix; widen the D-75 allowlist in its own migration if it writes new columns.
4. **Notifying registered players** about cancels and changes is deferred (P-2) and needs its own feature and notifier port.
5. **Known revenue gap by design**: reserved host seats are not billed, so the suggested rate under-recovers court cost.
6. **Technical debt**: required `webBaseUrl` and `recurrenceHorizonDays`; split `service.ts` and `series.ts`; trim the `openapi.yaml` diff for review; reconcile `feesLocked` `'none'` vs `null`; series list sort order; metrics emission once an exporter exists; `lockRuleInstances` ordering `(date, id)` vs trigger `id` ordering (theoretical).
7. **Memory bank corrections** (from reflection): add pre-merge in-place migration amendment and no-silent-config-defaults to `systemPatterns.md`; add the macOS `timeout` note to `techContext.md`; add a plan-time rule that every list, count or banner AC names its authoritative read.
