---
slug: skill-levels-and-auto-enroll
legacy_id:
feature: skill-levels-and-auto-enroll
status: INITIALIZED
---

# skill-levels-and-auto-enroll: Skill Levels and Auto Enroll

**Complexity**: Level 3 (inherited from skill-levels-and-auto-enroll)
**Status**: INITIALIZED
**Roadmap**: skill-levels-and-auto-enroll
**Branch**: feature/skill-levels-and-auto-enroll
**Worktree**: N/A (main checkout)

## Task Description

Member skill management and auto-enrollment (PRODDUCT-OVERVIEW §2).

- Admin manual skill override (records who/when)
- Auto-progression: 40 games for a team in the trailing 365 days moves the member up a level (`BEGINNER` → `INTERMEDIATE` → `ADVANCED`). Define what counts as a "game" (confirmed + completed session) and how admin overrides interact.
- Auto Enroll flag with optional `auto_enroll_until`; consumed by the session materialiser (order by auto-enroll assignment date)

**Depends on**: team-management (COMPLETE)

**Related in-flight / planned work**: `session-scheduling-engine` (planned, owns the session materialiser that consumes Auto Enroll) and `registration-and-waitlist` (in flight, CREATIVE_COMPLETE, owns registration/attendance state that defines a "game").

## Specification

**Feature Type**: End-User Feature
**Primary Persona**: Team Admin (`TEAM_ADMIN` of one team). Goals: keep each member's skill level honest for `BY_SKILL_LEVEL` pricing, and pre-fill sessions for regulars without chasing them. Secondary: Player (an APPROVED member whose level and auto-enrolment this feature changes), and the two later features that consume this one's outputs: session-scheduling-engine (the materialiser calls the auto-enrol selection) and registration-and-waitlist (its allocator performs the actual registration and defines what a completed game is).
**Creative Exploration Needed**: Yes. Game-counting edge cases (no-shows, surplus games), override-versus-auto-progression precedence, the materialiser ordering and hand-off contract, and the row-control layout. See "Creative Exploration Needed".

*Source requirements*: `PRODDUCT-OVERVIEW.md` §2 lines 19 and 21; `workflows_state_machine_architecture.md` §4 (selection predicate and order); `database-design.md` (`team_members` columns). The columns `skill_level`, `skill_level_override_by`, `skill_level_override_at`, `is_auto_enroll`, `auto_enroll_until` and `auto_enroll_assigned_at` already exist on `team_members` (migration `20260929000400000_team_members.sql`); nothing writes the override or auto-enrol columns yet.

### Invocation Method
- **Location**: the team-admin People area, `/teams/<teamId>/manage`, section "Members" (`apps/web/src/app/teams/[teamId]/manage/page.tsx`, rows rendered by `apps/web/src/components/teams/member-list.tsx`, whose header comment already reserves the row's control list, `memberRowControls` in `apps/web/src/lib/teams/manage-view.ts`, for "a later feature (skill override)"). No new page and no new entry in `MANAGE_AREAS`.
- **Element**: each APPROVED member row (admins included, yourself included) gets a disclosure button "Skill and Auto Enroll" (`aria-label="Skill and Auto Enroll, {fullName}"`, `aria-expanded`, `aria-controls`) that opens a non-modal panel under the row (same disclosure behaviour as `InlineConfirm`: focus moves to the panel, Escape and Cancel return focus to the button, one panel open per section, no native dialog). The panel holds two small forms:
  1. **Skill level**: radio fieldset (`OptionFieldset` with `SKILL_OPTIONS`: Beginner, Intermediate, Advanced; current level preselected) and a "Save skill level" button.
  2. **Auto Enroll**: checkbox "Auto Enroll", a date input "Until (optional)" shown when the box is checked, and a "Save Auto Enroll" button.
  The row itself shows (read-only, no click needed): the current level, a provenance line ("Self-assessed", "Set by {adminName} · 17 Oct 2026", or "Moved up automatically · 3 Nov 2026"), a progress line ("23 of 40 games toward Intermediate", or "Highest level" at Advanced), and an "Auto Enroll until 30 Nov 2026" / "Auto Enroll, no end date" / "Auto Enroll ended 30 Nov 2026" tag.
- **API** (both `config: { policy: requireTeamRole('TEAM_ADMIN') }`, no global-admin override, same as moderation; Fastify module registered under `/teams`; strict zod bodies in `packages/shared/src/api/`; `apps/api/openapi.yaml` regenerated):
  - `PUT /teams/:teamId/members/:userId/skill-level` with `{ skillLevel: 'BEGINNER' | 'INTERMEDIATE' | 'ADVANCED' }` answers `200 { member }`.
  - `PUT /teams/:teamId/members/:userId/auto-enroll` with `{ enabled: boolean, until: 'YYYY-MM-DD' | null }` answers `200 { member }`.
  - `GET /teams/:teamId/members?status=APPROVED` (existing) gains additive fields on `TeamMemberRow`: `skillOverride { byName, at } | null`, `skillChangedAt | null`, `autoEnroll { enabled, until, assignedAt }`, `skillProgress { games, required, nextLevel } | null`. No existing field changes.
- **Background**: one new pg-boss queue and daily schedule slot `skill-progression` (`apps/api/src/jobs/registry.ts`, `schedules.ts`, `bootstrap.ts`), at `30 5 * * *` Pacific/Auckland (after the 02:00-02:59 DST window and the existing 03:00, 04:00 and 05:00 slots). Operator re-run: `cli jobs trigger skill-progression`.
- **Visibility**: only approved admins of that team, through the existing `/teams/<id>/manage` guard (a non-admin already gets the no-access page). Pending, rejected and banned people never get the controls.
- **Navigation**: sign in, "My teams" (`/teams`), a team where the row shows the admin tag, "Manage", then "Members".
- **Confidence**: MEDIUM. The location follows the reserved extension point and the team-management journey. The exact panel layout (one panel with two forms, versus one combined form, versus a separate "Members and levels" manage area) is LOW and flagged for creative. The API shape is HIGH (mirrors the existing moderation routes).

### Success Criteria
- **User sees**: after "Save skill level": "Skill level for Priya Patel set to Advanced." in the Members status region, and the row now reads Advanced with "Set by Aroha Ngata · 17 Oct 2026". After "Save Auto Enroll": "Auto Enroll on for Priya Patel until 30 Nov 2026.", "Auto Enroll on for Priya Patel, with no end date." or "Auto Enroll turned off for Priya Patel.", and the row tag changes to match. After an automatic move: on the next page load the row shows the new level, "Moved up automatically · {date}" and the progress line restarted at "0 of 40".
- **Verifiable at**: the Members section of `/teams/<teamId>/manage`; the `team_members` row; structured log events `team.member.skill_overridden`, `team.member.skill_progressed`, `team.member.auto_enroll_changed` and `skill.progression.completed` (ids and levels only, never names); `pgboss.job` for the `skill-progression` queue; the selection function's output against real rows.
- **Data persisted**: `team_members.skill_level`, `skill_level_override_by` and `skill_level_override_at` (admin overrides only), new `skill_level_changed_at` (any change; the counting baseline), `is_auto_enroll`, `auto_enroll_until` (a date), `auto_enroll_assigned_at`. Nothing is written to `registrations` or `game_sessions`.
- **Observable within**: override and auto-enrol saves are immediate (next page load, revalidated). Automatic progression is observable at the next `skill-progression` run: at most one day after the session is marked `COMPLETED`, or immediately via the CLI trigger.

### Acceptance Criteria

#### AC-ENTRY-1: Admin finds the skill and Auto Enroll controls on each approved member row
**Priority**: MUST
**Given** Aroha is an approved `TEAM_ADMIN` of "Tuesday Smashers" and Priya is an approved member
**When** Aroha opens `/teams/<id>/manage` and looks at the Members section
**Then** Priya's row shows her current level, a provenance line, a progress line, any Auto Enroll tag, and a "Skill and Auto Enroll" button whose accessible name includes "Priya Patel"; activating it opens the panel with the two forms and moves focus into it; Escape closes it and returns focus to the button

#### AC-ENTRY-2: Controls are never offered on rows that are not approved members
**Priority**: MUST
**Given** the team has a pending request, a banned member and an approved member
**When** Aroha views the People page
**Then** only the approved rows in "Members" have "Skill and Auto Enroll"; the "Join requests" and "Banned members" rows do not, and the API refuses the two new routes for those targets (AC-ERROR-2)

#### AC-ENTRY-3: A plain member or a signed-out visitor cannot reach the controls
**Priority**: MUST
**Given** a signed-in approved `MEMBER` of the team, and a signed-out visitor
**When** each opens `/teams/<id>/manage` or calls either `PUT` route
**Then** the member sees the existing no-access page and the API answers 403; the visitor is redirected to sign in and the API answers 401; no member data is returned in either case

#### AC-HAPPY-1: Admin raises a member's level by override
**Priority**: MUST
**Given** Priya is an approved `BEGINNER` and Aroha has the panel open
**When** Aroha selects Advanced and presses "Save skill level"
**Then** the API answers 200; the panel reports "Skill level for Priya Patel set to Advanced."; the row reads Advanced, "Set by Aroha Ngata · {today}", "Highest level"; `skill_level = 'ADVANCED'`, `skill_level_override_by = Aroha`, `skill_level_override_at = now` and `skill_level_changed_at = now` (all from the injected clock); `team.member.skill_overridden` is logged with ids, `from` and `to`

#### AC-HAPPY-2: Admin lowers a member's level by override
**Priority**: MUST
**Given** Priya is an approved `ADVANCED` member who was moved up automatically
**When** Aroha saves Intermediate
**Then** the level becomes `INTERMEDIATE`, the override stamps are Aroha and now, `skill_level_changed_at = now`, and the progress line restarts at "0 of 40 games toward Advanced" (the games before the override no longer count)

#### AC-HAPPY-3: Saving the level a member already has changes nothing
**Priority**: SHOULD
**Given** Priya is `INTERMEDIATE`
**When** Aroha saves Intermediate
**Then** the API answers 200 with the unchanged member, the panel says "Priya Patel is already Intermediate.", and `skill_level_override_by`, `skill_level_override_at` and `skill_level_changed_at` keep their previous values (no baseline reset, no event)

#### AC-HAPPY-4: A member reaching 40 qualifying games moves up one level
**Priority**: MUST
**Given** Priya is `BEGINNER` with exactly 40 qualifying games (AC-VERIFY-3 defines "qualifying") for this team in the trailing 365 days, and a second member Sam has 39
**When** the `skill-progression` job runs
**Then** Priya becomes `INTERMEDIATE` with `skill_level_changed_at = run time`, `skill_level_override_by` and `skill_level_override_at` untouched (still NULL when she was never overridden), and `team.member.skill_progressed` is logged with ids, `from`, `to` and `games = 40`; Sam stays `BEGINNER`; on the next page load Priya's row shows "Moved up automatically · {date}"

#### AC-HAPPY-5: Progression is one level per run and per block of 40 new games
**Priority**: MUST
**Given** Priya is `BEGINNER` with 85 qualifying games
**When** the job runs, and then runs again immediately, and later runs again after she completes 40 more games
**Then** the first run makes her `INTERMEDIATE` only; the second run changes nothing (her baseline is now the first run's time, so her count restarts at 0); the third run, with 40 games completed after the first run, makes her `ADVANCED`; a member at `ADVANCED` is never changed by the job however many games they have

#### AC-HAPPY-6: An admin override resets the progression baseline instead of freezing progression
**Priority**: MUST
**Given** Priya is `BEGINNER` with 38 qualifying games, and Aroha overrides her to `INTERMEDIATE` today
**When** Priya completes 2 more games and the job runs, and later she completes 38 more and the job runs again
**Then** after the first run she is still `INTERMEDIATE` (only 2 games count since the override); after the second run (40 games since the override) she becomes `ADVANCED`; the job never lowers anyone

#### AC-HAPPY-7: Admin turns on Auto Enroll with an end date
**Priority**: MUST
**Given** Priya is an approved member with Auto Enroll off
**When** Aroha ticks "Auto Enroll", enters 30 Nov 2026 in "Until (optional)" and presses "Save Auto Enroll"
**Then** the API answers 200; the panel reports "Auto Enroll on for Priya Patel until 30 Nov 2026."; the row tag reads "Auto Enroll until 30 Nov 2026"; `is_auto_enroll = true`, `auto_enroll_until = 2026-11-30`, `auto_enroll_assigned_at = now`; `team.member.auto_enroll_changed` is logged with ids, `enabled = true` and `hasUntil = true` (the date itself is not needed in the log)

#### AC-HAPPY-8: Admin turns on Auto Enroll with no end date
**Priority**: MUST
**Given** Priya has Auto Enroll off
**When** Aroha ticks "Auto Enroll", leaves "Until" empty and saves
**Then** the panel reports "Auto Enroll on for Priya Patel, with no end date."; `auto_enroll_until IS NULL`, `is_auto_enroll = true`, `auto_enroll_assigned_at = now`; the row tag reads "Auto Enroll, no end date"

#### AC-HAPPY-9: Changing the end date keeps the member's place in the auto-enrol order
**Priority**: MUST
**Given** Priya and Sam both have Auto Enroll on, Priya assigned earlier than Sam
**When** Aroha changes Priya's "Until" date and saves
**Then** Priya's `auto_enroll_assigned_at` is unchanged and she still sorts before Sam in the selection (AC-INTEGRATION-1)

#### AC-HAPPY-10: Turning Auto Enroll off clears it, and turning it on again puts the member at the back
**Priority**: MUST
**Given** Priya has Auto Enroll on with an end date and Sam was assigned later
**When** Aroha unticks "Auto Enroll" and saves, and later ticks it again and saves
**Then** after the first save `is_auto_enroll = false`, `auto_enroll_until IS NULL`, `auto_enroll_assigned_at IS NULL`, the panel reports "Auto Enroll turned off for Priya Patel." and existing registrations are untouched; after the second save her `auto_enroll_assigned_at` is the new time, so she sorts after Sam

#### AC-HAPPY-11: Admin sees how many games a member has toward the next level
**Priority**: SHOULD
**Given** Priya is `BEGINNER` with 23 qualifying games and Sam is `ADVANCED`
**When** Aroha loads the Members section
**Then** Priya's row says "23 of 40 games toward Intermediate" and Sam's says "Highest level"; the figure comes from the same counting function the job uses, so it matches what the next run will decide

#### AC-ERROR-1: A non-admin is refused before the body is read
**Priority**: MUST
**Given** a signed-in approved `MEMBER`, an admin of a different team, a global admin who is not a member, and a signed-out caller
**When** each sends either `PUT` route (with a valid body and with an invalid body)
**Then** the answers are 403, 403, 403 and 401 (never 422 first); no `team_members` column changes; refusals are logged as `team.action.refused` with ids only

#### AC-ERROR-2: A target who is not an approved member is refused with the right code
**Priority**: MUST
**Given** a user with no row in this team, and users who are `PENDING`, `REJECTED` and `BANNED`
**When** an admin sends either `PUT` route for each
**Then** the user with no row gets 404 `not_found`; the other three get 409 `membership_state_conflict`; the web shows the existing stale-list message (`STALE_MESSAGE`) and refreshes; no column changes

#### AC-ERROR-3: Invalid input shows a field error and changes nothing
**Priority**: MUST
**Given** the panel is open
**When** the request carries an unknown `skillLevel`, an unknown extra field, a malformed `until`, `until` in the past (before today in Pacific/Auckland), or `until` with `enabled: false`
**Then** the API answers 422 `validation_failed` with `fieldErrors` (`skillLevel` or `until`); the web shows "Select a skill level." or "Choose today or a later date." next to the field and keeps the typed values; no column changes

#### AC-ERROR-4: An admin who lost admin rights during the request is refused
**Priority**: MUST
**Given** Aroha passed the route guard and Bo demotes her in a concurrent transaction that commits first
**When** her skill-level or Auto Enroll save reaches its transaction
**Then** it re-checks under the team lock that she is still an approved admin and answers 403; nothing is written

#### AC-ERROR-5: A ban removes Auto Enroll and wins over a concurrent toggle
**Priority**: MUST
**Given** Priya is an approved auto-enrolled member
**When** an admin bans her, and separately another admin's "Save Auto Enroll" for her races the ban
**Then** the ban's single `UPDATE` also sets `is_auto_enroll = false`, `auto_enroll_until = NULL`, `auto_enroll_assigned_at = NULL`; selection never returns her; the racing toggle gets 409 `membership_state_conflict` if the ban committed first, and if the toggle committed first the ban still clears the flag

#### AC-ERROR-6: A save that cannot reach the API changes nothing and says so
**Priority**: MUST
**Given** the API is down or answers 5xx
**When** Aroha saves either form
**Then** the panel stays open with the typed values and the message "We couldn't save that. Nothing was changed. Try again." (a new line in `labels.ts` next to `OUTAGE_MESSAGE`); the page is not revalidated and the row is not changed optimistically

#### AC-ERROR-7: One member failing does not stop the progression sweep, and the failure stays visible
**Priority**: MUST
**Given** the sweep covers many members and one member's transaction fails (for example a lock timeout or a constraint violation)
**When** the job runs
**Then** every other eligible member is still processed; the failure is logged as `skill.progression.member_failed` with ids and `errorCode`; at the end the job reports `skill.progression.completed` with `scanned`, `promoted` and `failed`, and when `failed > 0` the job ends failed so it stays visible in `pgboss.job` and retries (safe because it is idempotent)

#### AC-ASYNC-1: Progression appears at the next run, and an operator can run it on demand
**Priority**: MUST
**Given** a session has just become `COMPLETED` and its confirmed registrant now has their 40th qualifying game
**When** the daily `skill-progression` slot fires, or an operator runs `cli jobs trigger skill-progression`
**Then** the member is promoted within that run; until then nothing has changed and nothing is promised in the UI; the run logs `skill.progression.completed` with counts; no email or push is sent in v1 (the admin sees it on the next page load)

#### AC-ASYNC-2: Re-running or concurrently running the job never promotes twice
**Priority**: MUST
**Given** a member who was already promoted, and two runs of the job started at once
**When** both complete (including a redelivery after a worker crash)
**Then** exactly one level was gained; the second run finds the member's baseline reset and changes nothing; the guarded `UPDATE ... WHERE id = $id AND skill_level = $expected` and the queue's `exclusive` policy are the only guards needed

#### AC-ASYNC-3: Auto Enroll ends by itself after its end date
**Priority**: MUST
**Given** Priya has Auto Enroll until 30 Nov 2026
**When** selection runs for a session dated 30 Nov 2026 and for one dated 1 Dec 2026, with no job in between
**Then** she is selected for the first and not for the second; on a page load after 30 Nov her row reads "Auto Enroll ended 30 Nov 2026"; no cleanup job is involved (the flag stays true, the predicate does the work)

#### AC-VERIFY-1: The migration adds the baseline column and database-level invariants, reversibly
**Priority**: MUST
**Given** the new migration `db/migrations/<utc>_skill_levels_and_auto_enroll.sql`
**When** it is applied, rolled back (`db:rollback`) and applied again
**Then** the schema is identical after the round trip; `schema-deviations.md` has one entry per new object (next free D-number at build time; main is at D-54 and the registration-and-waitlist plan also claims D-47 onwards, so renumber on merge), each with a Source; `types.generated.ts` matches codegen; the migration adds `team_members.skill_level_changed_at timestamptz` and these CHECKs: override stamps paired (`(skill_level_override_by IS NULL) = (skill_level_override_at IS NULL)`), `skill_level_changed_at >= skill_level_override_at` when both are set, auto-enrol fields cleared when off (`is_auto_enroll OR (auto_enroll_until IS NULL AND auto_enroll_assigned_at IS NULL)`), and Auto Enroll only on approved rows (`NOT is_auto_enroll OR status = 'APPROVED'`)

#### AC-VERIFY-2: The database refuses each invalid combination on its own
**Priority**: MUST
**Given** a migrated test database
**When** raw SQL (bypassing the service) sets: an override actor without a time or the reverse; `skill_level_changed_at` earlier than the override time; `auto_enroll_until` or `auto_enroll_assigned_at` with `is_auto_enroll = false`; `is_auto_enroll = true` on a `PENDING`, `REJECTED` or `BANNED` row
**Then** each statement fails with SQLSTATE 23514 and the constraint name; the existing `team_members_auto_enroll_assigned` CHECK still fires when the flag is set without an assignment time

#### AC-VERIFY-3: "Qualifying game" is defined once and table-tested
**Priority**: MUST
**Given** the rule: a qualifying game for member M in team T at time `now` is a `registrations` row with `user_id = M`, `team_id = T`, `status = 'CONFIRMED'`, joined to a `game_sessions` row with `status = 'COMPLETED'` and `ends_at > now - 365 days` and `ends_at > coalesce(M.skill_level_changed_at, -infinity)`; guests, party size and payment status are irrelevant (one registration is one game)
**When** a table-driven integration test seeds rows through the existing factories (`insertSession`, `insertRegistration`, then `UPDATE game_sessions SET status`)
**Then** the count excludes `WAITLISTED` and `WITHDRAWN` registrations (early or late), sessions that are `DRAFT`, `PUBLISHED` or `CANCELLED`, other teams' sessions, other members, sessions ended exactly 365 days ago or earlier, and sessions that ended at or before the last level change; it includes the session ended 364 days 23 hours ago and one ended a second after the baseline; one function (`countQualifyingGames`, `apps/api/src/modules/skill-levels/`) is used by the job and by the row's progress line

#### AC-VERIFY-4: The progression decision is a pure table and the constants live in one place
**Priority**: MUST
**Given** `decideProgression({ level, games })` and `SKILL_PROGRESSION_GAMES = 40`, `SKILL_PROGRESSION_WINDOW_DAYS = 365` exported from `packages/shared`
**When** unit tests run every level against 0, 39, 40, 41 and 400 games
**Then** `BEGINNER` and `INTERMEDIATE` move up exactly one level at 40 or more and stay put below; `ADVANCED` never moves; a repo-wide grep test finds the literals 40 and 365 for this rule only in the shared constants and their tests

#### AC-VERIFY-5: Override, progression, ban and the job itself are race-safe
**Priority**: MUST
**Given** deterministic lock-waiter tests (no sleeps, injected clock advanced between sequential steps)
**When** a progression transaction and an admin override of the same member are interleaved both ways, a progression and a ban, and two job runs
**Then** progression re-reads the level, baseline and count under the member-row lock and decides again, so a promotion based on a count taken before an override never lands; the override and the ban never lose to a stale progression write; the final row always satisfies every CHECK from AC-VERIFY-1; lock order is `teams` then `team_members` (the override and auto-enrol saves use the moderation transaction shape: team row `FOR NO KEY UPDATE`, actor re-check, then target row lock; the job locks only the member row)

#### AC-VERIFY-6: New events log ids and levels only, and the redaction rules still hold
**Priority**: MUST
**Given** the events `team.member.skill_overridden`, `team.member.skill_progressed`, `team.member.auto_enroll_changed`, `skill.progression.completed` and `skill.progression.member_failed`
**When** log-capture tests run each path
**Then** the captured fields match the expected set exactly (`teamId`, `actorId`, `userId`, `from`, `to`, `games`, `enabled`, `hasUntil`, counts, `errorCode`); no full name, email or free text appears; no field is named exactly `code` (it is globally redacted); each request line carries `traceId`

#### AC-VERIFY-7: Route policy, contracts and OpenAPI are complete and strict
**Priority**: MUST
**Given** the two new routes and the extended `TeamMemberRow`
**When** `buildApp` boots, the route-policy tests run and `pnpm run openapi` is diffed
**Then** both routes declare `requireTeamRole('TEAM_ADMIN')` with `allowGlobalAdmin` off; request schemas are `z.strictObject` and shared by web and API; existing `/teams/*` responses only gained fields; the OpenAPI drift check passes and documents 401/403/404/409/422 for both routes

#### AC-VERIFY-8: New module is inside the coverage gate and the Playwright journey passes on both viewports
**Priority**: SHOULD
**Given** `apps/api/src/modules/skill-levels/**` added to the gate list in `vitest.config.ts`, and `apps/web/e2e/skill-levels.spec.ts`
**When** `pnpm run test:coverage` and `pnpm run test:e2e` run
**Then** coverage is at least 80% on lines, functions, branches and statements for the new module; the e2e journey (override a level, set and clear Auto Enroll, a validation error, no native dialog) passes on desktop and the 360 x 740 project with no axe violations of impact serious or critical; the panel is keyboard operable and every control has an accessible name

#### AC-INTEGRATION-1: The auto-enrol selection returns exactly the right members in the right order
**Priority**: MUST
**Given** a real database with team T holding approved members with: Auto Enroll assigned on days 1, 2 and 2 (same instant, different ids), one with `until` equal to the session date, one with `until` the day before, one with `until` NULL, plus a banned member, a member of another team, and a member with the flag off
**When** `selectAutoEnrollees(db, { teamId: T, sessionDate: '2026-12-01' })` is called, and again with `'2026-11-30'`
**Then** the result is `ORDER BY auto_enroll_assigned_at ASC, id ASC` over `status = 'APPROVED' AND is_auto_enroll AND (auto_enroll_until IS NULL OR auto_enroll_until >= sessionDate) AND team_id = T`; the `until`-equals-date member is included, the day-before member is excluded; changing `sessionDate` changes the result (not a stub); the function is a plain `SELECT` taking no row locks, so a caller keeps the canonical order `teams -> team_members -> game_sessions` and the allocator's `assertApprovedMember` remains the authoritative gate

#### AC-INTEGRATION-2: Progression works end to end on real registration and session rows
**Priority**: MUST
**Given** real `registrations` and `game_sessions` rows built with the existing factories: member A with 40 confirmed registrations in `COMPLETED` sessions of the team, member B with 40 registrations of which 5 are `WITHDRAWN` and 5 in a `CANCELLED` session
**When** the `skill-progression` handler runs through the real `registerJobs` wiring (an integration test that enqueues and processes the job, like `jobs.int.test.ts`)
**Then** A is promoted and B is not; the result differs when the seeded rows differ; the registry and schedule tests (`registry.test.ts`, `schedules.test.ts`, `handlers.test.ts`) include the new queue and slot, the DST-hour guard passes, and the slot appears in `registerSchedules`

#### AC-INTEGRATION-3: Consumers see the new level at once, and the cross-feature contract is written down and pinned
**Priority**: MUST
**Given** an override has committed for Priya
**When** `assertApprovedMember(trx, teamId, priyaId)` runs (the gate registration-and-waitlist calls for `BY_SKILL_LEVEL` pricing), and an ADR (next free number, `docs/adr/`) is read
**Then** the gate returns the new `skillLevel`; the ADR records the contracts C-GAME-1 (registration-and-waitlist and billing: a game is a `CONFIRMED` registration in a `COMPLETED` session; a `COMPLETED` session's `CONFIRMED` rows are never withdrawn afterwards; sessions become `COMPLETED` only through billing), C-SKL-1 (session-scheduling-engine: the materialiser calls `selectAutoEnrollees` after the session is `PUBLISHED`, then `allocator.autoEnrolInSession` once per session with `userId`s in the returned order, per registration-and-waitlist C-SAE-1 and C-SAE-2) and the no-retroactive-repricing rule; a contract test pins the selection function's signature and return shape and the `TeamMemberRow` additive fields

### Scope Boundaries
- **In scope**:
  - Admin skill-level override (who and when) on approved members, via the two `PUT` routes and the Members-row panel.
  - The counting baseline column `skill_level_changed_at`, the DB invariants, and the `skill-progression` queue, daily schedule, handler and CLI trigger.
  - Auto-progression `BEGINNER -> INTERMEDIATE -> ADVANCED` at 40 qualifying games in the trailing 365 days since the last level change, one level at a time, never downward.
  - Override precedence as drafted: an override always succeeds, never blocks later progression, and restarts counting.
  - Auto Enroll flag and optional end date per member, `auto_enroll_assigned_at` as the order key, and ban clearing it.
  - The seam this feature owns and delivers: `selectAutoEnrollees(db | trx, { teamId, sessionDate })` (read-only, ordered, no locks) and `countQualifyingGames(db | trx, { teamId, userId, now })`, both in `apps/api/src/modules/skill-levels/` with real-database tests, plus the ADR above.
  - Additive `TeamMemberRow` fields, `OpenAPI`, web copy and Server Actions (`apps/web/src/lib/teams/actions.ts`, `labels.ts`, `moderation.ts` kinds).
- **Out of scope**:
  - Creating, publishing or completing sessions, and the recurrence materialiser itself (session-scheduling-engine). The `recurrence-materialisation` slot stays a placeholder. This feature does **not** call the allocator.
  - Writing registrations: registering, waitlisting, withdrawing, the debt gate, and skipping an auto-enrolled member with 3 or more `OVERDUE` payments (registration-and-waitlist, C-SAE-1). The allocator, not this feature, decides capacity versus waitlist for auto-enrolled members.
  - Marking a session `COMPLETED` and billing (wallet-and-akahu-billing).
  - Attendance or no-show tracking (no column exists; a confirmed registration in a completed session counts as a game).
  - Player self-service skill changes after joining, player-facing display of their own level, email or in-app notification of a progression, Auto Enroll requests from players, and changing the approval flow to set a level at approval time.
  - Skill-based session eligibility (sessions carry no skill restriction; `skill_tier` only prices `BY_SKILL_LEVEL`). Repricing existing registrations after a level change (fees are read when registering and billing snapshots them, ADR 0012).
  - A skill-change history table or an override reason field (the log events are the audit trail beyond the last override).
  - Subscription billing, global-admin overrides of team levels, bulk edits, and exports.
- **Dependencies**:
  - team-management (merged): `team_members` state machine, `requireTeamRole`, `assertApprovedMember`, the moderation transaction shape, People page and `memberRowControls`, `InlineConfirm` behaviour, `manage-areas.ts`.
  - The existing schema on main: `registrations` and `game_sessions` tables exist (`20260929000600000`, `20260929000700000`) but no application code writes them yet. Qualifying-game counting is therefore built and proven against factory-seeded real rows, and shows zero games in a real deployment until session-scheduling-engine and registration-and-waitlist ship.
  - registration-and-waitlist (in flight, `feature/registration-and-waitlist`, CREATIVE_COMPLETE, not merged): provides `allocator.autoEnrolInSession` and the registration lifecycle. This spec conforms to its published consumer obligations C-SAE-1 and C-SAE-2 and adds C-GAME-1; if that feature changes the allocator signature, only the documented hand-off in the ADR changes, not this feature's code.
  - session-scheduling-engine (planned, not started): owns the materialiser that will call `selectAutoEnrollees`, and owns the session rows (`date`, `ends_at`, `PUBLISHED`) that registrations and games hang off.
  - wallet-and-akahu-billing (planned): performs the `PUBLISHED -> COMPLETED` transition that makes a game countable (C-BIL-1).
- **NFR implications**:
  - P1: every invariant above is a CHECK, and the counting rule reads only committed rows. P3: all instants are UTC `timestamptz`; `until` is a Pacific/Auckland calendar `date`; "today" for validation is the NZ date from the injected clock; the 365-day window is an absolute `interval` on `ends_at`. P5: progression runs only through the job queue; no work happens in the HTTP request. P7: the 40 and 365 constants are domain rules in `packages/shared`, not environment configuration (see open question 6).
  - Performance: the sweep scans only approved members below `ADVANCED` in keyset batches (about 500), one transaction per member; the count query needs a partial index on `registrations (team_id, user_id) WHERE status = 'CONFIRMED'` (plan to confirm with `EXPLAIN`). The members list computes at most 50 counts per page.
  - Security and privacy: admin-only; names only, never emails; override actor is shown by name to team admins only; no new secret or PII in jobs (the job takes no payload).
  - Accessibility: WCAG 2.1 AA, labelled controls, 360 px layout, no native dialogs (UAT constraint).

### Creative Exploration Needed
Yes. The requirement text fixes the thresholds but leaves several rules open. The spec above commits to a default for each so the ACs are testable; each needs confirmation before build.

1. **Game-counting rule (confidence MEDIUM on the definition, LOW on edges).** Default: `CONFIRMED` registration in a `COMPLETED` session of this team, counted by `ends_at`, guests excluded. Open: do no-shows count (no attendance data exists), does a late withdrawal that was charged count, and is `ends_at` or `date` the right clock for the window.
2. **Override versus auto-progression precedence (LOW).** Default: override always applies, sets `skill_level_changed_at`, and restarts counting; progression never lowers and never touches override stamps. Alternatives: an override permanently pins the level (admin loses progression forever), or an override only blocks progression for a period. Decide, including whether saving the same level should reset the baseline (default: no).
3. **Surplus games after a promotion (LOW).** Default: baseline = the time of the change, so surplus games are discarded and the next level needs 40 new games. Alternative: baseline = end of the 40th counted game so surplus carries over. This changes `skill_level_changed_at` semantics.
4. **Materialiser ordering and hand-off contract (MEDIUM on the selection, LOW on integration).** Default: order `auto_enroll_assigned_at, id`; changing only `until` keeps the place; off-then-on goes to the back; selection is a lock-free read and the allocator remains the gate. Neither sessions nor the allocator exist on main, so the real wiring is untestable here and is deferred to session-scheduling-engine; confirm C-SKL-1 with that feature's owner when it is planned.
5. **Row-control layout (LOW).** One disclosure panel with two forms (drafted), one combined form with a single Save, or a dedicated "Members and levels" area registered in `MANAGE_AREAS`. Also whether "games toward next level" belongs on the row or in the panel.
6. **Constants as code or configuration (MEDIUM).** Default: shared constants (`SKILL_PROGRESSION_GAMES`, `SKILL_PROGRESSION_WINDOW_DAYS`), because they are product rules that tests and the UI copy must agree on. Alternative: environment variables per P7, at the cost of copy that can drift from the rule.
7. **Visibility of progression to players (MEDIUM).** Out of scope here (no notification, no player-facing level). Confirm that the admin-only visibility is acceptable for v1, or add a `mySkillLevel` to team detail and an email through the existing `send-email` job.

**Open questions for the human** (these block no AC wording but change behaviour): (a) Should an approved admin be able to override their own level (drafted: yes, all admins are equal)? (b) Should the admin be able to set a level while approving a join request (drafted: no, override happens afterwards from Members)? (c) Is a one-day lag between a game finishing and a promotion acceptable (drafted: yes, daily job)? (d) The registration-and-waitlist plan and `main` both use D-47 onwards in `schema-deviations.md` and ADR number 0016; confirm who renumbers on merge.

## Test Strategy

_(filled during planning)_

## Implementation Roadmap

_(filled during planning)_

## Creative Phases

_(filled during planning)_

---

## Execution State

**Build Status**: RUNNING
**Current Phase**: PLAN
**Current Step**: Step 3 - Spec Writer Agent - RUNNING
**Step Started**: 2026-10-17
**Can Resume**: YES

### Active Sub-Agents
(none)

### Completed Steps
- Step 0.1: Task provisioned from roadmap feature
