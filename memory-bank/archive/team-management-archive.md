# Archive: Team Management

## Metadata
- Task: team-management
- Complexity: Level 3
- Status: COMPLETE (archived 2026-10-13). Delivered on PR to `main` from `feature/team-management` (not stacked).
- Started: 2026-10-13 (task provisioned, `132d0ed`)
- Completed: 2026-10-13 (post-build fix `ad7256e`, reflection `45bd997`)
- Duration: one calendar day. Plan → creative → Phase 1 (`/yay:build`) → Phases 2–5 (`/yay:build --auto`) → final review → fix → reflect.
- Roadmap Link: [team-management] (v1.0.0)
- Branch: `feature/team-management`, built in the main clone (no worktree). Task range `origin/main..HEAD`: 15 commits before archive, 117 files changed, +20,477 / −95 (includes spec, creative and memory-bank files).

## Summary

Players can create teams (public or private), find public teams, join through a request with a self-assessed skill level, or reach a private team through a regenerable invite link. Team admins approve or reject requests, promote and demote admins, and ban members. The database enforces the membership state machine, and the feature exposes the ban seam that registration-and-waitlist will plug into: a committed `BANNED` status plus a durable `member-banned` job, a replaceable `MemberBannedHandler` (no-op today), and the `assertApprovedMember` gate.

## Requirements

### Original Requirements (PRODDUCT-OVERVIEW §2)
- Any user can create a team (name, description, `PUBLIC`/`PRIVATE`); the creator becomes `TEAM_ADMIN`.
- "Find a Team" search page `/teams/find` (public teams only).
- Private teams via invite link `/teams/join?code=XYZ` (unique, regenerable).
- Join request with a self-assessed skill level → `PENDING`; admin approve/reject.
- Promote/demote team admins.
- Ban member: revokes access, blocks future registrations, cancels active registrations and triggers waitlist promotion (the cancellation half is a hook for registration-and-waitlist). An admin must be demoted before being banned.

### Success Criteria
44 ACs (43 from the spec writer plus AC-ERROR-15 from the design critique), each assigned to one of five phases; all five phases checked and each passed verifier, code review and phase review. Source: Specification in `memory-bank/tasks/team-management.md`.
- [x] Entry (ENTRY-1 to 5), happy paths (HAPPY-1 to 12), errors (ERROR-1 to 12, 15), async (ASYNC-1 to 3), verify (VERIFY-1 to 8), integration (INTEGRATION-1 to 3).
- [x] Met with deviation: AC-ERROR-7. When two admins demote each other at the same instant, the loser gets 403 (Amendment A10's actor re-check) rather than 409; one admin always remains.
- [x] Met with scope note: the ban's "cancels active registrations" is honestly deferred. The UI says "They lose access to this team and can't register for its sessions." registration-and-waitlist owns cancellation (ADR 0015).
- [x] AC-INTEGRATION-3 (SHOULD): Playwright 8/8 on desktop and 360×740, run natively against a temporary DB rather than the Compose stack; not part of `ci`. The 5xx keep-panel path and self-demote success are unit-tested only.

## Implementation

### Approach
Schema and contracts first (Phase 1); teams API for create, discovery and joining (Phase 2); moderation and the ban seam (Phase 3); web discovery, create and join pages (Phase 4); team-admin area, end-to-end journeys and docs (Phase 5). Postgres is the system of record (P1): admin-must-be-approved, status transitions, stamp columns and the last-admin rule are constraints and triggers. Every admin-changing transaction locks the team row first.

### Key Components
1. **Schema**: `db/migrations/20261013000100000_team_membership_invariants.sql`; ledger `db/schema-deviations.md` D-40 to D-46 (CHECKs, `team_members_guard_update` transition trigger, deferred last-admin triggers, name/description/invite-code checks, `idx_teams_public_name`, `idx_team_members_team_status_role`, create idempotency key D-46).
2. **Shared contracts**: `packages/shared/src/api/teams.ts` (strict zod bodies, cursors, `MEMBERS_PAGE_SIZE = 50`), 7 new error codes in `packages/shared/src/api/errors.ts`.
3. **Teams API module**: `apps/api/src/modules/teams/` (`routes.ts`, `service.ts`, `repo.ts`, `transitions.ts`, `invite-code.ts`, `membership.ts` with `assertApprovedMember`, `membership-errors.ts` keyed on `err.constraint`, `ban-hook.ts`). 14 `/teams*` routes with explicit policies.
4. **Ban seam**: `apps/api/src/jobs/member-banned.ts`, queue `member-banned` (exclusive, `singletonKey member-banned:<membershipId>`), handler injected only via `registerJobs({ memberBannedHandler })`; CLI `jobs trigger member-banned`. Contract in `docs/adr/0015-team-membership-and-ban-seam.md`.
5. **Logging**: `apps/api/src/lib/logger/logger.ts` redacts `inviteCode`/`invite_code`, a field named exactly `code`, and the `returnTo` query; error logs use `errorCode`.
6. **Web**: `apps/web/src/app/teams/**` (find, My teams, new, team page, join, manage), `apps/web/src/components/teams/**` (SkillLevelField, InlineConfirm, member/request/banned lists, invite panel, pagers), `apps/web/src/lib/teams/**` (Server Actions, labels/copy, `manage-areas.ts` registry), `proxy.ts` protections (no-store, no-referrer), header links.

### Design Decisions
- **Ban seam (1B)**: BANNED row and job commit together; no-op handler; `assertApprovedMember` FOR SHARE gate; lock order `teams → team_members → game_sessions → registrations`; no sweeper here, registration-and-waitlist must ship one. Cancellation semantics for that feature: `WITHDRAWN`, no fee.
- **State machine (3B)**: re-request after rejection with no cooldown; `BANNED` terminal; ban only `APPROVED` members; all admins equal.
- **Invite code (4A)**: one rotating 256-bit code. Joins lock the team row FOR SHARE and compare the code under the lock, so a regenerate wins (critique fix).
- **Search (5A)**: ILIKE over a partial `(lower(name), id)` index, two-way cursor.
- **Create idempotency**: hidden per-render key, unique on `(created_by, create_idempotency_key)` (critique fix).
- **Admin UI**: one "People" page with jump list inside `manage/layout.tsx`, a registry where banking/sessions plug in later, InlineConfirm instead of native dialogs.
- **Journey**: one status table drives team page, invite page, Find tags and My teams; My teams stands in for notifications.

References: `memory-bank/creative/team-management-membership-architecture.md`, `memory-bank/creative/team-management-team-admin-uiux.md`, `memory-bank/creative/team-management-teams-user-journey.md`; binding rulings in the task file's "Creative Reconciliation" section.

## Testing
- Unit: 473 → 763 (about +290 across phases, including about 160 web tests).
- Integration: 199 → 275 (`teams-schema`, `teams-api`, `teams-moderation`, `teams-ban-seam`, `teams-logs` suites, plus extended auth/schema suites).
- E2E: `apps/web/e2e/teams.spec.ts` 8/8 (desktop and 360 px, axe scans).
- Coverage gate passes (97.65% lines on the measured set; `modules/teams/**` and `lib/teams` included).
- Deterministic race tests (lock-waiters, no sleeps): join vs regenerate, create replay (5-way), approve vs reject, mutual demote, 20-way self-demote, ban vs approved-member gate.
- All passing: ✅ (lint, typecheck, build, OpenAPI drift included).

## Files Changed (by area)
- `apps/api/src/modules/teams/` (16 files), `apps/api/src/jobs/` (6), `apps/api/test/integration/` (8), `apps/api/src/lib/{logger,http,auth,db}/`
- `apps/web/src/components/teams/` (21), `apps/web/src/lib/teams/` (14), `apps/web/src/app/teams/**`, `apps/web/e2e/teams.spec.ts`, `apps/web/src/proxy.ts`
- `packages/shared/src/api/{teams,errors}.ts`, `db/migrations/20261013000100000_team_membership_invariants.sql`, `db/schema-deviations.md`, `apps/api/openapi.yaml`, `docs/adr/0015-team-membership-and-ban-seam.md`
- `apps/api/src/modules/auth/oauth-service.ts`: post-build fix renaming the `link_conflict` log field to `errorCode`.

## Lessons Learned
- A scoped adversarial design critique (`--base origin/main --scope branch`) found three real defects before any code was written. The default working-tree scope reviewed nothing.
- Parallel creative agents produced about 40 overlapping amendments; a single binding reconciliation section kept build consistent.
- The one escaped defect was a global change: the logger's exact-`code` redaction hid auth `link_conflict` error codes. Per-phase reviews missed it; the final whole-branch review caught it. Tests now assert logged fields.
- DST/pg-boss timing tests time out under parallel CPU load; re-run sequentially before treating as a regression.

Consolidated into: `agent-rules/_learned/logging-redaction-global.md` (new), `review-process-plan-claims.md` (evidence 3, promoted to medium), `testing-injected-clock.md` (evidence 2); `techContext.md` updated (global redaction note, inline env vars, load-sensitive tests).

Reference: `memory-bank/reflection/team-management-reflection.md`

## References
- Task: `memory-bank/tasks/team-management.md`
- Reflection: `memory-bank/reflection/team-management-reflection.md`
- Creative: `memory-bank/creative/team-management-{teams-user-journey,membership-architecture,team-admin-uiux}.md`
- ADR: `docs/adr/0015-team-membership-and-ban-seam.md`

## Follow-up
- **registration-and-waitlist must**: implement the real `MemberBannedHandler`, call `assertApprovedMember` before any session lock, ship the reconciliation sweep that re-enqueues bans the no-op handled, and restore cancellation wording in the ban confirmation (ADR 0015).
- Open minors from the final review:
  - A refusal from the in-transaction re-check logs `team.action.refused` twice.
  - A create replay with a different body returns the original team.
  - A team name of control characters can overflow the Find cursor limit.
  - The admin routes' OpenAPI omits 401/403.
  - Small refactors: `callManageApi`, the `listMembers` builder, and a per-user InlineConfirm id.
- Run `teams.spec.ts` once under the Compose stack if CI adopts e2e.
- Consider a jsdom/Testing Library harness for interactive components.
