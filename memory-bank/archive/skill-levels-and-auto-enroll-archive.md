# Archive: Skill Levels and Auto Enroll

## Metadata
- Task: skill-levels-and-auto-enroll
- Complexity: Level 3
- Started: 2026-10-17
- Completed: 2026-10-17
- Roadmap Link: skill-levels-and-auto-enroll (v1.0.0)
- Branch: feature/skill-levels-and-auto-enroll (16 commits plus the archive commit)

## Summary
Team admins can now override a member's skill level (recording who and when) and turn Auto Enroll on or off for a member, with an optional inclusive end date. Both controls live in a "Skill and Auto Enroll" panel on each approved row of `/teams/<id>/manage` → Members. A daily `skill-progression` job (05:30 Pacific/Auckland) moves a member up one level (`BEGINNER` → `INTERMEDIATE` → `ADVANCED`) at 40 qualifying games in the trailing 365 days since their last level change.

The feature also delivers the seams two later features consume, and records their contracts in ADR 0017:
- `countQualifyingGames` / `countQualifyingGamesBatch`
- `selectAutoEnrollees`, consumed by session-scheduling-engine's materialiser and gated by registration-and-waitlist's allocator

Nothing in production writes sessions or registrations yet, so game counts read 0 until those features ship.

## Requirements
### Original Requirements
- Admin manual skill override, recording who and when
- Auto-progression at 40 games for a team in the trailing 365 days; define what a "game" is and how overrides interact
- Auto Enroll flag with optional `auto_enroll_until`, consumed by the session materialiser in auto-enroll assignment order

### Success Criteria
- [✓] Override and Auto Enroll saves from the Members-row panel, with the exact success copy ("Skill level for Priya Patel set to Advanced.", "Auto Enroll on for Priya Patel until 30 Nov 2026.")
- [✓] Row shows level, provenance ("Self-assessed" / "Set by …" / "Moved up automatically …"), "N of 40 games toward …" progress, and the Auto Enroll tag
- [✓] Daily progression job, idempotent and race-safe, plus an operator re-run with `pnpm run jobs:trigger skill-progression`
- [✓] Database invariants as CHECKs (D-55..D-61); ban clears Auto Enroll in the same UPDATE
- [✓] Contracts C-GAME-1, C-SKL-1 and C-PRICE-1 written down (ADR 0017) and pinned by contract tests
- [ ] Compose-stack e2e regression of the restructured Members row: **OPEN** (see Follow-up)

### Acceptance-criteria changes (read these before reusing the spec)
The spec's 35 ACs were amended at build time per the task's **Binding Reconciliation** block. Downstream features should treat these as superseded or extended:
- **AC-HAPPY-3**: a same-level save is a no-op even when the panel's expected values are stale.
- **AC-HAPPY-9/10**: an expired Auto Enroll counts as off. Renewing it is a new place at the back of the order (decision 3; new AC-HAPPY-13).
- **AC-VERIFY-3**: the window is `(greatest(now − 365×24h, skill_level_changed_at), now]`, with the upper bound added. Charged late withdrawals are excluded. One predicate builder backs the single count, the batch count and the sweep pre-pass.
- **AC-ASYNC-2 / AC-VERIFY-5**: correctness comes from lock-then-recount plus the guarded UPDATE. The queue's `exclusive` policy only reduces duplicate runs.
- **AC-INTEGRATION-3 and the "no repricing" scope line**: replaced by C-PRICE-1. The registrant's tier is snapshotted at CONFIRMED, and that is an obligation on registration-and-waitlist.
- **Added**:
  - AC-HAPPY-12: consequence lines beside each Save
  - AC-HAPPY-13: expired renewal
  - AC-ERROR-8: member banned while the panel is open
  - AC-ERROR-9: stale override
  - AC-ERROR-10: stale Auto Enroll save, post-review
  - AC-NAV-1

## Implementation
### Approach
Five phases, built with `/yay:build --auto`: schema and shared rules → read seams and contract → admin API → progression job → admin UI and e2e. Every phase passed its review gate first time. A final whole-branch review (Codex) returned "Ready to merge — With fixes". The user then asked for Important #2 and #3 to be fixed before reflect (commit `1aa60e1`).

### Key Components
1. **Schema and shared rules**
   - Purpose: the counting baseline `skill_level_changed_at`, 4 CHECKs (override stamps paired, baseline ≥ override, Auto Enroll cleared when off, Auto Enroll only on APPROVED), 2 partial indexes, progression constants and `decideProgression`.
   - Files: `db/migrations/20261017000100000_skill_levels_and_auto_enroll.sql`, `db/schema-deviations.md` (D-55..D-61), `packages/shared/src/skill/{progression,provenance,index}.ts`, `packages/shared/src/api/skill-levels.ts`
2. **Read seams (C-GAME-1, C-SKL-1)**
   - Purpose: one qualifying-games predicate, and a lock-free auto-enrol selection ordered by `auto_enroll_assigned_at, id`.
   - Files: `apps/api/src/modules/skill-levels/{games,auto-enrol}.ts`, `boundaries.test.ts`, `docs/adr/0017-skill-levels-and-auto-enroll.md`
3. **Admin API**
   - Purpose: `PUT /teams/:teamId/members/:userId/skill-level` and `.../auto-enroll`.
   - How they work: each locks the team row, re-checks the actor is still an admin, then locks the member row. Both saves are optimistic: they send the state the panel was showing, and a stale view gets a 409 (`skill_level_stale` / `auto_enroll_stale`) with the current member. Both read the clock after the locks.
   - `TeamMemberRow` gains additive fields built by one shared mapper.
   - Files: `apps/api/src/modules/skill-levels/{routes,service,repo,decisions,errors}.ts`, `apps/api/src/modules/teams/member-read.ts`, `apps/api/openapi.yaml`
4. **Progression job**
   - Purpose: a read-only keyset pre-pass (batches of 500), then one transaction per candidate: lock the member row only, read `now`, recount, decide, then a guarded UPDATE that never sets status or role. Failures are isolated per member, and the run fails when any member failed.
   - Files: `apps/api/src/jobs/{skill-progression,registry,schedules,bootstrap}.ts`, `apps/api/src/modules/skill-levels/progression.ts`
5. **Admin UI**
   - Purpose: read-only row lines, plus a disclosure panel with two independent forms. Each form has its own status line, and the panel stays open after a save.
   - Files: `apps/web/src/components/teams/{member-skill-summary,skill-enroll-panel}.tsx`, `use-skill-panel-action.ts`, `apps/web/src/lib/teams/{skill-levels-view,actions,labels,manage-view}.ts`, `apps/web/e2e/skill-levels.spec.ts`

### Design Decisions
- **Algorithm**:
  - A game is a CONFIRMED registration in a COMPLETED session of the team, timed by `ends_at`. No-shows count; charged late withdrawals don't.
  - An override resets the counting baseline, and surplus games are discarded.
  - The thresholds are shared constants.
- **Architecture**:
  - A new `skill-levels` module with leaf read seams and a teams-owned row mapper.
  - The job locks only the member row.
- **UI/UX**: one panel per row with two forms. The progress line stays on the row, capped at the required count.
- **Human decisions after the design critique**:
  - C-PRICE-1: the skill tier is snapshotted at CONFIRMED.
  - Self-override is allowed.
  - Expired renewal goes to the back of the order.
  - Optimistic concurrency on overrides.
  - The allocator must re-check the opt-out (decision 5).

References:
- `memory-bank/creative/skill-levels-and-auto-enroll-progression-algorithm.md`
- `memory-bank/creative/skill-levels-and-auto-enroll-seams-architecture.md`
- `memory-bank/creative/skill-levels-and-auto-enroll-member-panel-uiux.md`
- `memory-bank/creative/skill-levels-and-auto-enroll-admin-journey-user-journey.md`
- `docs/adr/0017-skill-levels-and-auto-enroll.md`

## Testing
- Unit and integration: the final combined run (`pnpm run test:coverage` with the DB env) had 1607 tests. After the post-review fix, 1606 passed and 1 failed: a test-expectation miss in `skill-levels-logs.int.test.ts`, which was fixed, and the skill-levels integration suites were re-run 26/26.
- New integration suites: `skill-levels-{schema,games,api,logs,job,races}.int.test.ts`, real PostgreSQL, deterministic races (lock-waiter probe and advisory-lock trigger, no sleeps).
- Coverage gate: `apps/api/src/modules/skill-levels/**` was added. Lines were 97.6% at Phase 3.
- e2e: `apps/web/e2e/skill-levels.spec.ts` passed on desktop and 360×740 against `next dev` and a local API (axe serious/critical = 0). It has not been run on the Compose stack.
- Typecheck, lint and build pass.

## Files Changed
79 files, +12,638 / −160 (including memory-bank docs and the regenerated `openapi.yaml`). New source files are listed under Key Components. Modified files include:
- `apps/api/src/modules/teams/repo.ts`: the ban clears Auto Enroll, and the mapper moved to `member-read.ts`
- `apps/api/src/app.ts`, `apps/api/src/cli.ts` (usage text), `vitest.config.ts`
- `apps/web/src/components/teams/member-list.tsx`: the row was restructured into a column (info and controls row, plus a full-width panel)
- `docs/getting-started.md`: the operator command

## Lessons Learned
- The creative critique and the binding reconciliation caught a cross-feature pricing hole before any code was written.
- Per-phase reviews missed two issues only the final review caught: a sibling write without the guard its neighbour had, and the clock read before the lock. The learned rule existed but was not an enumerated reviewer check.
- Nested agents need a non-final hand-back handshake. In Phase 3 the build orchestrator escalated while its TDD agent was still running.
- The verifier needs named environment preconditions (`DATABASE_URL`, `.env`, Compose) so it doesn't report FAIL.

Learned-rule consolidation from this task:
- Evidence added to `api-write-idempotency` (renamed "Same guard on every sibling write"; glob now includes `actions.ts`), `testing-injected-clock` (promoted to medium), `review-process-plan-claims`, and `testing-integration-db-isolation` (promoted to medium).
- No rules were merged, retired or pruned.

Reference: `memory-bank/reflection/skill-levels-and-auto-enroll-reflection.md`

## References
- Task: `memory-bank/tasks/skill-levels-and-auto-enroll.md` (Specification, Binding Reconciliation, Deviations ledger)
- Reflection: `memory-bank/reflection/skill-levels-and-auto-enroll-reflection.md`
- Creative: the four `memory-bank/creative/skill-levels-and-auto-enroll-*.md` docs
- ADR: `docs/adr/0017-skill-levels-and-auto-enroll.md`

## Follow-up
1. **Before merge**: run `pnpm run test:e2e` on the Compose stack (needs a `.env`). The `teams.spec.ts` promote, demote and ban steps after line 241 have not run against the restructured Members row.
2. **registration-and-waitlist** (in flight) must:
   - add the registrant skill-tier snapshot at CONFIRMED and bill from it (C-PRICE-1);
   - make `autoEnrolInSession` re-check `is_auto_enroll`, `until` and `assigned_at` under its member-row lock (C-SKL-1 point 4).

   Both branches target ADR 0017 and D-55+. Whichever merges second renumbers.
3. **session-scheduling-engine**: call `selectAutoEnrollees` after PUBLISHED, then the allocator in returned order. Follow the lock-order advisory (ADR 0017 C-SKL-1 point 5).
4. **Minor findings left open**:
   - Per-member failure span events do nothing until `lib/jobs/jobs.ts` makes the run span active.
   - 503 `service_unavailable` is not in the route schemas or OpenAPI.
   - Deploy the API before or with the web app, since the web app requires the new `TeamMemberRow` fields.
   - The `skill_level_override_by` RESTRICT FK blocks a future user-deletion feature.
   - Phase 5 UI nits: the off-hint is not in `aria-describedby`; the success line stays after a re-edit; 502/504 copy; `todayNz` goes stale across NZ midnight.
   - Recurring flakes need a tracking task: the pg-boss `previewSchedule` timeout, the DST-guard timeout and a node-pg-migrate `checkOrder` error.
5. `systemPatterns.md` / `techContext.md` should mention the optimistic-concurrency token pattern, the leaf-module boundary test, the `skill-progression` queue and its 05:30 slot, and the `test:coverage` / `test:e2e` environment requirements.
