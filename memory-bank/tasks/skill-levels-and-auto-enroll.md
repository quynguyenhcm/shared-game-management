---
slug: skill-levels-and-auto-enroll
legacy_id:
feature: skill-levels-and-auto-enroll
status: COMPLETE
---

# skill-levels-and-auto-enroll: Skill Levels and Auto Enroll

**Complexity**: Level 3 (inherited from skill-levels-and-auto-enroll)
**Status**: COMPLETE
**Archived**: memory-bank/archive/skill-levels-and-auto-enroll-archive.md
**Completed**: 2026-10-17
**Reflection**: memory-bank/reflection/skill-levels-and-auto-enroll-reflection.md
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
  - `PUT /teams/:teamId/members/:userId/skill-level` with `{ skillLevel: 'BEGINNER' | 'INTERMEDIATE' | 'ADVANCED', expectedSkillLevel, expectedChangedAt: string | null }` answers `200 { member, changed }` (amended at build, Binding Reconciliation decision 4: optimistic concurrency; 409 `skill_level_stale` carries the current `member`).
  - `PUT /teams/:teamId/members/:userId/auto-enroll` with `{ enabled: boolean, until: 'YYYY-MM-DD' | null }` answers `200 { member, changed }` (`changed: false` for a no-op).
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
**Then** the API answers 200 with the unchanged member and `changed: false`, the panel says "Priya Patel is already Intermediate.", and `skill_level_override_by`, `skill_level_override_at` and `skill_level_changed_at` keep their previous values (no baseline reset, no event). *(Amended at build: a save of the level the member already has is a no-op whatever `expectedSkillLevel`/`expectedChangedAt` say, so a retried save after a lost response is safe; the stale check of AC-ERROR-9 applies only to a different level.)*

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
**Then** Priya's `auto_enroll_assigned_at` is unchanged and she still sorts before Sam in the selection (AC-INTEGRATION-1). *(Amended at build, Binding Reconciliation decision 3: this holds while her assignment is active, `until` today or later or none; an ended assignment renews at the back, AC-HAPPY-13. Off->off and an unchanged on->on are no-ops with no event and `changed: false`.)*

#### AC-HAPPY-10: Turning Auto Enroll off clears it, and turning it on again puts the member at the back
**Priority**: MUST
**Given** Priya has Auto Enroll on with an end date and Sam was assigned later
**When** Aroha unticks "Auto Enroll" and saves, and later ticks it again and saves
**Then** after the first save `is_auto_enroll = false`, `auto_enroll_until IS NULL`, `auto_enroll_assigned_at IS NULL`, the panel reports "Auto Enroll turned off for Priya Patel." and existing registrations are untouched; after the second save her `auto_enroll_assigned_at` is the new time, so she sorts after Sam

#### AC-HAPPY-13: An ended Auto Enroll is shown as off and renews at the back of the order (added at build, Binding Reconciliation decision 3)
**Priority**: MUST
**Given** Priya had Auto Enroll until 30 Nov 2026 and Sam was assigned after her, and today (NZ) is 2 Dec 2026
**When** Aroha loads Members, opens Priya's panel, ticks "Auto Enroll" and saves with no date
**Then** before saving, the API still returns `autoEnroll { enabled: true, until: '2026-11-30' }` (the flag stays set; the view derives "ended" from `until < todayNZ`), the row tag reads "Auto Enroll ended 30 Nov 2026" and the panel shows the box unticked with the ended note; after saving, the message is "Auto Enroll on for Priya Patel, with no end date.", `auto_enroll_assigned_at = now`, and `selectAutoEnrollees` returns Sam before Priya. An `until` equal to today is still active and keeps the place

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
**Then** the ban's single `UPDATE` also sets `is_auto_enroll = false`, `auto_enroll_until = NULL`, `auto_enroll_assigned_at = NULL` (the approved-only CHECK refuses a ban that leaves the flag set); selection never returns her; the racing toggle gets 409 `membership_state_conflict` if the ban committed first, and if the toggle committed first the ban still clears the flag

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

#### AC-ERROR-9: A save based on a stale level is refused, not applied (added at build, Binding Reconciliation decision 4)
**Priority**: MUST
**Given** Aroha opened Priya's panel showing `BEGINNER`, and since then Bo overrode Priya or the `skill-progression` job promoted her
**When** Aroha saves a different level with the `expectedSkillLevel` and `expectedChangedAt` the panel was showing
**Then** under the member-row lock the service compares both (the baseline at millisecond precision, as the API returns it, although the column stores microseconds) and answers 409 `skill_level_stale` with the current `member`; nothing is written; the panel refreshes with "This member's level changed since you opened the panel. Check it and save again."; a save that re-sends the refreshed values applies

#### AC-ERROR-10: A stale Auto Enroll save cannot re-enrol a member another admin turned off (added after the final review, 2026-10-17)
**Priority**: MUST
**Given** Aroha opened Priya's panel showing "Auto Enroll until 30 Nov", and since then Bo turned Priya's Auto Enroll off
**When** Aroha saves a new end date with the `expectedEnabled`, `expectedUntil` and `expectedAssignedAt` the panel was showing (the stored state, so an ended assignment still reads enabled)
**Then** under the member-row lock the service compares all three and answers 409 `auto_enroll_stale` with the current `member`; nothing is written and no event is logged; the panel refreshes with "This member's Auto Enroll changed since you opened the panel. Check it and save again."; a save that would change nothing is still a no-op on a stale view (retries stay safe); a save from the refreshed panel applies. Both admin saves read the injected clock after their locks, so a save that waited across NZ midnight is validated against the date it writes on

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
**Then** the schema is identical after the round trip; `schema-deviations.md` has one entry per new object (D-55 to D-61 as built; main was at D-54 and the registration-and-waitlist plan also claims D-47 onwards, so whichever merges second renumbers), each with a Source; `types.generated.ts` matches codegen; the migration adds `team_members.skill_level_changed_at timestamptz`, these named CHECKs: `team_members_override_stamps_paired` (`(skill_level_override_by IS NULL) = (skill_level_override_at IS NULL)`), `team_members_changed_after_override` (`skill_level_override_at IS NULL OR (skill_level_changed_at IS NOT NULL AND skill_level_changed_at >= skill_level_override_at)`, stricter than "when both are set" so provenance is always derivable), `team_members_auto_enroll_cleared_when_off` (`is_auto_enroll OR (auto_enroll_until IS NULL AND auto_enroll_assigned_at IS NULL)`) and `team_members_auto_enroll_approved_only` (`NOT is_auto_enroll OR status = 'APPROVED'`), and two partial indexes: `idx_registrations_confirmed_member (team_id, user_id, session_id) WHERE status = 'CONFIRMED'` and `idx_team_members_auto_enroll_order (team_id, auto_enroll_assigned_at, id) WHERE is_auto_enroll` (named `_order` because the draft `idx_team_members_auto_enroll` already exists and is kept); the Up migration first raises a readable error if an existing row would break a CHECK

#### AC-VERIFY-2: The database refuses each invalid combination on its own
**Priority**: MUST
**Given** a migrated test database
**When** raw SQL (bypassing the service) sets: an override actor without a time or the reverse; `skill_level_changed_at` earlier than the override time, or an override time with no `skill_level_changed_at`; `auto_enroll_until` or `auto_enroll_assigned_at` with `is_auto_enroll = false`; `is_auto_enroll = true` on a `PENDING`, `REJECTED` or `BANNED` row
**Then** each statement fails with SQLSTATE 23514 and the constraint name; the existing `team_members_auto_enroll_assigned` CHECK still fires when the flag is set without an assignment time

#### AC-VERIFY-3: "Qualifying game" is defined once and table-tested
**Priority**: MUST
**Given** the rule: a qualifying game for member M in team T at time `now` is a `registrations` row with `user_id = M`, `team_id = T`, `status = 'CONFIRMED'`, joined to a `game_sessions` row with `status = 'COMPLETED'` and `ends_at` in `(greatest(now - SKILL_PROGRESSION_WINDOW_MS, coalesce(M.skill_level_changed_at, -infinity)), now]` (window start computed in TS and bound as a parameter; charged late withdrawals are WITHDRAWN and so excluded; no-shows count); guests, party size and payment status are irrelevant (one registration is one game)
**When** a table-driven integration test seeds rows through the existing factories (`insertSession`, `insertRegistration`, then `UPDATE game_sessions SET status`)
**Then** the count excludes `WAITLISTED` and `WITHDRAWN` registrations (early or late), sessions that are `DRAFT`, `PUBLISHED` or `CANCELLED`, other teams' sessions, other members, sessions ended exactly 365 days ago or earlier, and sessions that ended at or before the last level change; it includes the session ended 364 days 23 hours ago and one ended a second after the baseline; a completed session ending after `now` is excluded; one predicate builder (`qualifyingGamesQuery`, `apps/api/src/modules/skill-levels/games.ts`) backs the single-member count (`countQualifyingGames`), the per-page batch count (`countQualifyingGamesBatch`) and the sweep pre-pass, with a single-versus-batch parity test

#### AC-VERIFY-4: The progression decision is a pure table and the constants live in one place
**Priority**: MUST
**Given** `decideProgression({ level, games })` and `SKILL_PROGRESSION_GAMES = 40`, `SKILL_PROGRESSION_WINDOW_DAYS = 365` and the derived `SKILL_PROGRESSION_WINDOW_MS` exported from `packages/shared` (`decideProgression` returns `{ kind: 'promote', from, to }` or `{ kind: 'none', reason: 'highest_level' | 'below_threshold' }`)
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
**Then** the result (a readonly `{ userId, membershipId, assignedAt }[]`, `sessionDate` a `LocalDate`, in `auto-enrol.ts`) is `ORDER BY auto_enroll_assigned_at ASC, id ASC` over `status = 'APPROVED' AND is_auto_enroll AND (auto_enroll_until IS NULL OR auto_enroll_until >= sessionDate) AND team_id = T`; the `until`-equals-date member is included, the day-before member is excluded; changing `sessionDate` changes the result (not a stub); the function is a plain `SELECT` taking no row locks, so a caller keeps the canonical order `teams -> team_members -> game_sessions` and the allocator's `assertApprovedMember` remains the authoritative gate

#### AC-INTEGRATION-2: Progression works end to end on real registration and session rows
**Priority**: MUST
**Given** real `registrations` and `game_sessions` rows built with the existing factories: member A with 40 confirmed registrations in `COMPLETED` sessions of the team, member B with 40 registrations of which 5 are `WITHDRAWN` and 5 in a `CANCELLED` session
**When** the `skill-progression` handler runs through the real `registerJobs` wiring (an integration test that enqueues and processes the job, like `jobs.int.test.ts`)
**Then** A is promoted and B is not; the result differs when the seeded rows differ; the registry and schedule tests (`registry.test.ts`, `schedules.test.ts`, `handlers.test.ts`) include the new queue and slot, the DST-hour guard passes, and the slot appears in `registerSchedules`

#### AC-INTEGRATION-3: Consumers see the new level at once, and the cross-feature contract is written down and pinned
**Priority**: MUST
**Given** an override has committed for Priya
**When** `assertApprovedMember(trx, teamId, priyaId)` runs (the gate registration-and-waitlist calls for `BY_SKILL_LEVEL` pricing), and an ADR (next free number, `docs/adr/`) is read
**Then** the gate returns the new `skillLevel`; the ADR records the contracts C-GAME-1 (registration-and-waitlist and billing: a game is a `CONFIRMED` registration in a `COMPLETED` session; a `COMPLETED` session's `CONFIRMED` rows are never withdrawn afterwards; sessions become `COMPLETED` only through billing), C-SKL-1 (session-scheduling-engine: the materialiser calls `selectAutoEnrollees` after the session is `PUBLISHED`, then `allocator.autoEnrolInSession` once per session with `userId`s in the returned order, per registration-and-waitlist C-SAE-1 and C-SAE-2) C-PRICE-1 (registrant skill tier snapshotted at CONFIRMED; a level change never reprices an existing registration) and the decision-5 allocator re-check under its member-row lock; a contract test pins the selection function's signature and return shape and the `TeamMemberRow` additive fields

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

### Approach
- **Emphasis**: integration-heavy (balanced per systemPatterns.md, but most rules here are DB invariants, row-lock races and SQL counting, which must be proven on real PostgreSQL 17). Pure decisions (`decideProgression`, labels, view mapping) stay unit tests.
- **Target test count**: ~60 across 5 phases. Above the 10-20 multi-component guideline because the spec has 35 ACs, 4 new CHECKs that each need an isolated refusal test (AC-VERIFY-2), and a table-driven counting rule (AC-VERIFY-3); table rows inside one `it.each` count as one test.

### File Organization
- **New test files**:
  - `packages/shared/src/skill/progression.test.ts`: `decideProgression` table, constants grep guard (AC-VERIFY-4)
  - `packages/shared/src/api/skill-levels.test.ts`: strict request schemas, `TeamMemberRow` additive fields
  - `apps/api/test/integration/skill-levels-schema.int.test.ts`: migration round trip, CHECK refusals (AC-VERIFY-1, AC-VERIFY-2)
  - `apps/api/test/integration/skill-levels-games.int.test.ts`: `countQualifyingGames` table, `selectAutoEnrollees` order/predicate, contract pin (AC-VERIFY-3, AC-INTEGRATION-1, AC-ASYNC-3, AC-INTEGRATION-3)
  - `apps/api/test/integration/skill-levels-api.int.test.ts`: routes, policy, error codes, `assertApprovedMember` sees the new level (AC-HAPPY-1..3, 7..10, AC-ERROR-1..4, AC-VERIFY-7)
  - `apps/api/test/integration/skill-levels-races.int.test.ts`: override vs progression, ban vs toggle, double job run, using `lock-waiters.ts` (AC-VERIFY-5, AC-ERROR-5, AC-ASYNC-2)
  - `apps/api/test/integration/skill-levels-job.int.test.ts`: end-to-end job through `registerJobs`, per-member failure isolation (AC-HAPPY-4..6, AC-ASYNC-1, AC-ERROR-7, AC-INTEGRATION-2)
  - `apps/api/test/integration/skill-levels-logs.int.test.ts`: exact log field sets (AC-VERIFY-6)
  - `apps/web/src/lib/teams/skill-levels-view.test.ts`: provenance, progress and Auto Enroll tag copy
  - `apps/web/e2e/skill-levels.spec.ts`: admin journey on desktop + 360 x 740 with axe (AC-ENTRY-1..3, AC-ERROR-6, AC-VERIFY-8)
- **Extend existing**:
  - `apps/api/src/jobs/registry.test.ts`, `schedules.test.ts`, `handlers.test.ts`: new queue and slot, DST guard
  - `apps/api/test/integration/teams-ban-seam.int.test.ts`: ban clears Auto Enroll in the same `UPDATE`
  - `apps/web/src/lib/teams/actions.test.ts`, `labels.test.ts`, `manage-view.test.ts`, `moderation.test.ts`: new Server Actions, copy, row controls
  - `apps/web/src/components/teams/manage-components.test.tsx`: panel disclosure, focus return, field errors
  - `apps/api/test/integration/db-codegen.int.test.ts` / `schema.int.test.ts`: drift picks up the new column automatically (no new assertions unless they fail)

### What NOT to Test
- `types.generated.ts`: checked by tsc and the codegen drift test.
- The materialiser calling `selectAutoEnrollees` and `allocator.autoEnrolInSession`: neither exists on main; deferred to session-scheduling-engine (the contract test pins the seam instead).
- Session completion and billing transitions: owned by wallet-and-akahu-billing; tests seed `COMPLETED` directly with `UPDATE game_sessions SET status`.
- pg-boss internals (exclusive policy semantics, cron parsing): framework; the job test only proves our handler is idempotent.
- Notifications: none are sent in v1.

### Per-Phase Test Guidance
- Phase 1: ~12 tests. Migration round trip, one refusal per new CHECK plus the existing `team_members_auto_enroll_assigned` CHECK, ban clears Auto Enroll, `decideProgression` table, constants guard, strict schemas.
- Phase 2: ~10 tests. Qualifying-game table (each inclusion/exclusion row), selection predicate and order, `until` boundary, contract pin, partial index used (`EXPLAIN` assertion or documented check).
- Phase 3: ~16 tests. Both routes happy paths, same-level no-op, policy and refusal codes (401/403/404/409/422), actor demoted mid-request, ban vs toggle race, `assertApprovedMember` sees the new level, `TeamMemberRow` additive fields and progress, log fields, OpenAPI drift.
- Phase 4: ~10 tests. Job promotes at 40 and not at 39, one level per run, override resets baseline, double run and redelivery promote once, override vs progression interleaved both ways, one member failing does not stop the sweep, registry/schedule/handler wiring, CLI trigger.
- Phase 5: ~12 tests. View-model copy (provenance, progress, tags, "ended"), Server Actions and error mapping, panel disclosure and focus, e2e journey on both viewports with axe.

## Implementation Roadmap

### Overview
Admin skill override and Auto Enroll on the existing People page, a daily `skill-progression` job that promotes at 40 qualifying games, and the two read seams (`countQualifyingGames`, `selectAutoEnrollees`) that registration-and-waitlist and session-scheduling-engine will consume. No session or registration writes. The order is DB first, read seams, then API, then the job, then UI, so each phase is testable against real rows before anything consumes it.

### Component Analysis
- **New**: `apps/api/src/modules/skill-levels/` (routes, service, repo, games); the `skill-progression` job; shared `skill` primitives and API schemas; the web panel component and view model; ADR 0017.
- **Affected**: `team_members` (migration), `apps/api/src/modules/teams/repo.ts` (ban `UPDATE` clears Auto Enroll; members list gains fields), `teams/routes.ts` or `buildApp` registration, `jobs/registry.ts`, `schedules.ts`, `bootstrap.ts`, the CLI trigger list, `member-list.tsx`, `manage-view.ts` (`memberRowControls`), `actions.ts`, `labels.ts`, `moderation.ts`, `vitest.config.ts` coverage list, `apps/api/openapi.yaml`, `db/schema-deviations.md`.
- **Interactions**: web Server Action → `PUT` route (`requireTeamRole('TEAM_ADMIN')`) → service (moderation transaction shape: lock `teams` `FOR NO KEY UPDATE`, re-check actor, lock target row) → `team_members`. Job: sweep approved non-`ADVANCED` members in keyset batches → per member: lock row, recount via `countQualifyingGames`, `decideProgression`, guarded `UPDATE`. Consumers: `assertApprovedMember` (reads `skill_level`), future materialiser → `selectAutoEnrollees`.

### Dependencies & Risks
- Risk: registration-and-waitlist (in flight) also claims D-47+ and ADR 0016 → Mitigation: this task uses the next free numbers on main (D-55+, ADR 0017); whichever branch merges second renumbers (user decision 2026-10-17).
- Risk: game counts are zero in production until session-scheduling-engine and registration-and-waitlist ship → Mitigation: prove counting on factory-seeded real rows; state it in the ADR and the UI progress line copy is still accurate ("0 of 40").
- Risk: creative outcomes (override precedence, surplus carry-over) could change `skill_level_changed_at` semantics → Mitigation: Phase 1 migration is built only after `/yay:creative` locks those rules.
- Risk: lock-order deadlock between override (teams → team_members) and job (team_members only) → Mitigation: the job never locks `teams`; race tests interleave both orders (AC-VERIFY-5).
- Risk: count query cost on the members list (up to 50 counts per page) → Mitigation: partial index `registrations (team_id, user_id) WHERE status = 'CONFIRMED'`; check with `EXPLAIN` in Phase 2.

### Observability Requirements
- **Applies**: Yes → reference `context/observability-requirements.md` during build.
- **Logging**: business events `team.member.skill_overridden`, `team.member.auto_enroll_changed` (request path, with `traceId`), `team.member.skill_progressed`, `skill.progression.completed`, `skill.progression.member_failed` (job path). Ids, levels, counts and booleans only; no names or emails; no field named `code`.
- **Tracing**: existing Fastify and pg-boss instrumentation; one custom span per progression run, with per-member child spans only on failure.
- **Metrics**: none new beyond the run-summary log counts (promoted, unchanged, failed).
- **Configuration**: no new env vars (thresholds are shared constants, pending creative Q6).

### API Requirements - REST
- **Involves REST API**: Yes
- **OpenAPI Spec Location**: `apps/api/openapi.yaml` (generated by `pnpm run openapi`, drift-checked)
- **Endpoints Affected**: `PUT /teams/:teamId/members/:userId/skill-level` (new), `PUT /teams/:teamId/members/:userId/auto-enroll` (new), `GET /teams/:teamId/members` (additive response fields)
- **Build Phase**: load `context/api-rest-requirements.md`

### New Source Files (pin path + extension)
- [ ] `db/migrations/<utc>_skill_levels_and_auto_enroll.sql`: `skill_level_changed_at`, 4 CHECKs, partial index (Up/Down)
- [ ] `packages/shared/src/skill/progression.ts`: `SKILL_PROGRESSION_GAMES`, `SKILL_PROGRESSION_WINDOW_DAYS`, `decideProgression`, `nextSkillLevel`
- [ ] `packages/shared/src/skill/index.ts`: barrel (re-exported from `packages/shared/src/index.ts`, extend)
- [ ] `packages/shared/src/api/skill-levels.ts`: strict zod bodies, response shapes, error codes
- [ ] `apps/api/src/modules/skill-levels/games.ts`: `countQualifyingGames`, `selectAutoEnrollees` (read-only, no locks)
- [ ] `apps/api/src/modules/skill-levels/repo.ts`: guarded override, Auto Enroll and progression `UPDATE`s, keyset sweep query
- [ ] `apps/api/src/modules/skill-levels/service.ts`: override and Auto Enroll transactions (moderation shape), progression of one member
- [ ] `apps/api/src/modules/skill-levels/routes.ts`: the two `PUT` routes
- [ ] `apps/api/src/modules/skill-levels/errors.ts`: refusal codes and HTTP mapping (mirrors `team-banking/errors.ts`)
- [ ] `apps/api/src/jobs/skill-progression.ts`: job handler (sweep + per-member isolation + summary log)
- [ ] `apps/web/src/components/teams/skill-enroll-panel.tsx`: disclosure panel with the two forms
- [ ] `apps/web/src/lib/teams/skill-levels-view.ts`: provenance, progress and Auto Enroll tag copy
- [ ] `docs/adr/0017-skill-levels-and-auto-enroll.md`: C-GAME-1, C-SKL-1, no-retroactive-repricing
- [ ] extend: `db/schema-deviations.md` (D-55+), `apps/api/src/lib/db/types.generated.ts` (codegen), `apps/api/src/modules/teams/repo.ts`, `apps/api/src/app.ts` (`buildApp` registration), `apps/api/src/jobs/{registry,schedules,bootstrap}.ts`, `apps/api/src/cli.ts` (job trigger list), `apps/api/openapi.yaml`, `vitest.config.ts`, `apps/web/src/components/teams/member-list.tsx`, `apps/web/src/lib/teams/{manage-view,actions,labels,moderation}.ts`, `docs/getting-started.md` (CLI trigger)

### Phases
- [x] Phase 1: Schema and shared rules. Migration (`skill_level_changed_at`, paired-override, baseline >= override, auto-enrol-cleared-when-off and approved-only CHECKs, partial index), schema-deviation entries D-55+, codegen, ban `UPDATE` clears Auto Enroll, shared constants + `decideProgression` + strict API schemas. ACs: AC-VERIFY-1, AC-VERIFY-2, AC-VERIFY-4, AC-ERROR-5 (DB half).
- [x] Phase 2: Read seams and contract. `countQualifyingGames` and `selectAutoEnrollees` with table-driven real-DB tests, contract pin test, ADR 0017. ACs: AC-VERIFY-3, AC-INTEGRATION-1, AC-ASYNC-3, AC-INTEGRATION-3 (ADR + pin).
- [x] Phase 3: Admin API. `skill-levels` module (override and Auto Enroll routes with the moderation transaction shape), `TeamMemberRow` additive fields incl. `skillProgress`, log events, OpenAPI, coverage gate entry. ACs: AC-HAPPY-1..3, AC-HAPPY-7..11 (API half), AC-ERROR-1..5, AC-VERIFY-6, AC-VERIFY-7, AC-INTEGRATION-3 (`assertApprovedMember`).
- [x] Phase 4: Progression job. `skill-progression` queue, 05:30 Pacific/Auckland slot, handler with keyset sweep, per-member lock-recount-decide-update, failure isolation, CLI trigger, race tests. ACs: AC-HAPPY-4..6, AC-ASYNC-1, AC-ASYNC-2, AC-ERROR-7, AC-VERIFY-5, AC-INTEGRATION-2.
- [x] Phase 5: Admin UI and end-to-end journey. Members-row read-only lines, "Skill and Auto Enroll" disclosure panel, Server Actions, status-region success messages, field and network errors, Playwright journey on both viewports with axe. Delivers the full entry-to-success flow: `/teams/<id>/manage` → Members → "Skill and Auto Enroll" → Save → "Skill level for Priya Patel set to Advanced." ACs: AC-ENTRY-1..3, AC-HAPPY-1/2/7..11 (UI half), AC-ERROR-3, AC-ERROR-6, AC-VERIFY-8.

## Creative Phases

- [x] Algorithm design → COMPLETE. Game-counting edges (no-shows, charged late withdrawals, `ends_at` vs `date`), override vs auto-progression precedence and same-level saves, surplus-game carry-over and `skill_level_changed_at` semantics (spec Creative Q1-Q3, Q6).
- [x] Architecture design → COMPLETE. Cross-feature contracts C-GAME-1 / C-SKL-1 with registration-and-waitlist (C-SAE-1/2) and session-scheduling-engine, selection seam shape, lock order, job sweep design (spec Creative Q4, Q7).
- [x] UI/UX design → COMPLETE. Members-row layout: one panel with two forms vs a combined form vs a separate manage area, and where the progress line sits (spec Creative Q5).

All four phases are COMPLETE (2026-10-17):
- [x] Algorithm → `memory-bank/creative/skill-levels-and-auto-enroll-progression-algorithm.md`
- [x] Architecture → `memory-bank/creative/skill-levels-and-auto-enroll-seams-architecture.md`
- [x] UI/UX → `memory-bank/creative/skill-levels-and-auto-enroll-member-panel-uiux.md`
- [x] User Journey (required at Level 3) → `memory-bank/creative/skill-levels-and-auto-enroll-admin-journey-user-journey.md`

### Binding Reconciliation (supersedes the spec and any single design doc where they conflict)

Build agents read this block first. Where an AC above says otherwise, this block wins and the AC is amended at build time to match.

**Human decisions (2026-10-17, after the design critique):**
1. **Pricing is snapshotted at CONFIRMED (C-PRICE-1).** A registrant's `BY_SKILL_LEVEL` tier is fixed when the registration becomes `CONFIRMED` and billing charges from that snapshot. A level change never reprices an existing registration. This is an obligation on registration-and-waitlist (it currently reads the level at charge time; it must add e.g. `registrations.registrant_skill_level`). It is recorded in ADR 0017 and flagged to that branch. This feature writes no registrations, so it does not implement the snapshot. The "existing fees don't change" copy (user journey) stays.
2. **Self-override stays allowed** (decision (a) unchanged): it is safe under decision 1.
3. **An expired Auto Enroll counts as off** (user journey A3 wins over architecture's "on→on keeps place"). When `auto_enroll_until < todayNZ`, the panel shows the box unticked with the "ended" note. An `enabled: true` save on such a row is a new assignment (`auto_enroll_assigned_at = now`, back of the order). An `until` of today keeps the place. Add AC-HAPPY-13 (as drafted in the journey doc) and a contract test for expired renewal ordering.
4. **Overrides use optimistic concurrency.** `PUT .../skill-level` body becomes `{ skillLevel, expectedSkillLevel, expectedChangedAt: string | null }`. Under the row lock the service compares both. On mismatch (another admin, or the job promoted) it answers `409 skill_level_stale` with the current `member`, and the panel refreshes with "This member's level changed since you opened the panel. Check it and save again." This replaces the user-journey "accepted trade-off" of a stale panel undoing a promotion. Add AC-ERROR-9.

**Adopted from the critique without a separate decision:**
5. **Auto Enroll opt-out is authoritative at registration time (C-SKL-1 obligation).** The allocator's `autoEnrolInSession` transaction must re-check `is_auto_enroll`, `auto_enroll_until >= session date` and `auto_enroll_assigned_at` equal to the selected value, under its member-row lock, before it creates a registration. Recorded in ADR 0017 and pinned by the contract test header. A deterministic race test lands with whichever feature ships the allocator.

**Doc conflicts resolved by the orchestrator:**
6. Success messages go in a per-form `role="status"` line under each Save (UI/UX). The Members section status region is only for stale, gone and no-access results (panel closes, focus to `#members-heading`).
7. The operator command is `pnpm run jobs:trigger skill-progression` (wraps `cli.ts jobs trigger`). `cli.ts` gets a usage-text change only.

**Design amendments accepted (apply to ACs and the file list at build time):**
- Algorithm: counting window `ends_at` in `(greatest(now − SKILL_PROGRESSION_WINDOW_MS, skill_level_changed_at), now]`, with the window computed in TS and bound as a parameter. Charged late withdrawals are excluded and no-shows count. One predicate builder backs the single-member count, the per-page batch count and the sweep pre-pass, with a parity test. Index `registrations (team_id, user_id, session_id) WHERE status='CONFIRMED'`. An override writes one `$now` to both `skill_level_override_at` and `skill_level_changed_at`. Surplus games are discarded. Constants include `SKILL_PROGRESSION_WINDOW_MS`.
- Job: a read-only keyset pre-pass (500), then one transaction per candidate. Each runs `lock_timeout 5s` → `FOR NO KEY UPDATE` on the member row only → read `now` → recount → decide → UPDATE guarded on `status`, `skill_level` and `skill_level_changed_at`, never setting `status` or `role`. The run fails when `failed > 0`. Summary log: `scanned, candidates, promoted, skipped, failed, durationMs`. Per-member failures are span events.
- Architecture: new `skill-levels` module (`routes, service, repo, games, auto-enrol, progression, decisions, errors`, plus `boundaries.test.ts`). `teams/member-read.ts` owns `TeamMemberRow` mapping, with required additive fields computed in one query per page. Shared `packages/shared/src/skill/provenance.ts` (`deriveSkillProvenance`). PUTs use `lock_timeout 2s`, `assertTeamAdminUnderLock(..., 'noKeyUpdate')` and the member row `FOR NO KEY UPDATE`. The ban UPDATE explicitly clears the three Auto Enroll columns. The migration pre-checks that no non-APPROVED row has Auto Enroll set, and adds partial index `idx_team_members_auto_enroll`. `selectAutoEnrollees(db, { teamId, sessionDate: LocalDate })` returns `{ userId, membershipId, assignedAt }[]`, takes no locks, and has a non-blocking proof test. Auto Enroll is not retroactive. Off→off and unchanged on→on are no-ops with no event. Responses signal `changed: false` for no-ops.
- UI/UX: `member-skill-summary.tsx`, `skill-enroll-panel.tsx`, `use-skill-panel-action.ts`, `skill-levels-view.ts` with `formatCalendarDate` (UTC, never `formatManageDate`), third-person `SKILL_OVERRIDE_OPTIONS`, the panel stays open after save, the progress line is capped at `required`, and date input handling (`min=todayNz`, `badInput`, "Clear date").
- Journey: an indeterminate network failure uses "We couldn't confirm that was saved. Try again; saving the same change twice is safe." Stale copy is member-specific. Consequence lines go beside each Save (AC-HAPPY-12). AC-ERROR-8 covers a member banned while the panel is open. AC-NAV-1. ADR 0017 records the later obligations: priced fees name the level used, and auto-enrolled registrations are labelled and emailed to the player.
- Player visibility (Q7): admin-only, no notification in v1.
- Numbering: ADR 0017 and D-55+. registration-and-waitlist may also target 0017; whichever merges second renumbers.

### Design Critique (advisory)
- **Backend**: codex (usable). **Verdict**: needs-attention.
- **Summary**: pricing authority, the Auto Enroll opt-out race, a fee-stability promise and expired-renewal semantics were unresolved. All are now resolved by decisions 1–5 above.
- **Findings**: [high] admins can manipulate their own billable tier → decision 1; [high] UI promises fee stability the architecture didn't provide → decision 1; [high] turning Auto Enroll off can still register and charge → decision 5; [medium] incompatible expired-renewal ordering → decision 3; [medium] last-writer-wins overrides → decision 4.

**Resolved at plan review (2026-10-17)**: spec approved as drafted, with creative flagged. New schema deviations and the ADR use the next free numbers on main (D-55+, ADR 0017); whichever of this branch and `feature/registration-and-waitlist` merges second renumbers. Open questions (a) to (c) keep their drafted defaults unless creative changes them.

---

## Execution State

**Build Status**: IDLE
**Current Step**: Archive - COMPLETE (2026-10-17)
**Auto-Build Mode**: YES
**Current Phase**: COMPLETE (5 of 5 phases built, reflected, archived)
**Final Review Backend**: AUTO FINAL REVIEW BACKEND: codex — usable (verdict: Ready to merge — With fixes; 0 Critical, 3 Important: Compose e2e regression on Members row, Auto Enroll PUT last-writer-wins, clock read before lock in both admin saves)
**Post-review fixes (2026-10-17, user-requested)**: Important #2 fixed (Auto Enroll optimistic concurrency, 409 `auto_enroll_stale`, AC-ERROR-10). Important #3 fixed (both saves read `clock.now()` after `lockMemberRow`). Important #1 (Compose e2e regression) is still OPEN: run `pnpm run test:e2e` on the Compose stack before merge.
**Resume From**: n/a (COMPLETE)
**Pre-Flight Plan Scan**: clean (spec/design conflicts pre-resolved by Binding Reconciliation; ACs amended at build time per that block)
**Previous Phase**: CREATIVE → BUILD
**Last Completed**: CREATIVE (2026-10-17)
**Can Resume**: NO
**Creative Critique**: CREATIVE CRITIQUE: codex — usable (verdict needs-attention; resolved by human decisions 1-4 and adopted fix 5)

### Active Sub-Agents
(none)

### Completed Steps
- Step 0.1: Task provisioned from roadmap feature
- Step 3: Spec Writer Agent (Sonnet) - COMPLETE; taxonomy lint CLEAN; human approved with creative flagged
- Step 4-5: Codebase analysis and 5-phase implementation plan - COMPLETE
- Step 6: Validation gate passed; status PLANNING_COMPLETE
- Algorithm Creative Design: COMPLETE (2026-10-17) - Output: memory-bank/creative/skill-levels-and-auto-enroll-progression-algorithm.md
- Architecture Creative Design: COMPLETE (2026-10-17) - Output: memory-bank/creative/skill-levels-and-auto-enroll-seams-architecture.md
- UI/UX Creative Design: COMPLETE (2026-10-17) - Output: memory-bank/creative/skill-levels-and-auto-enroll-member-panel-uiux.md
- User Journey Creative Design: COMPLETE (2026-10-17) - Output: memory-bank/creative/skill-levels-and-auto-enroll-admin-journey-user-journey.md

- Phase 1 Build: COMPLETE (2026-10-17) - migration 20261017000100000 (D-55..D-61), shared progression constants + decideProgression + strict request schemas, ban UPDATE clears Auto Enroll; 28 shared unit tests, 16 schema integration tests + 1 ban-seam test; verifier PASS (unit flake on timing only), review APPROVED

- Phase 2 Build: COMPLETE (2026-10-17) - countQualifyingGames/Batch (one predicate builder), selectAutoEnrollees (auto-enrol.ts), ADR 0017; 30 integration tests + 2 boundary tests; see commit

- Phase 3 Build: COMPLETE (2026-10-17) - skill-levels module (routes/service/repo/decisions/errors), teams member-read.ts, SkillProvenance, skill_level_stale, OpenAPI regenerated, coverage gate entry; 35 RED tests -> unit 1092, integration 423, combined coverage gate PASS; lint/typecheck/build PASS; review APPROVED

- Phase 4 Build: COMPLETE (2026-10-17) - skill-progression queue (exclusive, 05:30 Pacific/Auckland), handler with 500-keyset pre-pass, progressMember (lock_timeout 5s, member row FOR NO KEY UPDATE, recount, guarded UPDATE with microsecond baseline), failure isolation, CLI usage text, getting-started docs; 6 job + 6 race integration tests plus registry/schedules/handlers unit tests; unit 1094, integration 435, combined coverage gate PASS (after one flake fix); lint/typecheck/build PASS; review APPROVED

- Phase 5 Build: COMPLETE (2026-10-17) - member-skill-summary, skill-enroll-panel (two forms, per-form status lines), use-skill-panel-action, skill-levels-view (+33 tests), Server Actions setSkillLevelAction/setAutoEnrollAction, api-client, labels, manage-view skillControl, page todayNz; unit 1156, combined coverage run 1591/1591 PASS (gate PASS), lint/typecheck/build PASS; review APPROVED; e2e skill-levels.spec.ts passed desktop + 360x740 against next dev + local API
- Post-review fixes: COMPLETE (2026-10-17) - commit 1aa60e1 (final review Important #2 and #3)
- Reflection Agent: COMPLETE (2026-10-17) - Output: memory-bank/reflection/skill-levels-and-auto-enroll-reflection.md
- Archive: COMPLETE (2026-10-17) - Output: memory-bank/archive/skill-levels-and-auto-enroll-archive.md; learned rules consolidated (additive: 4 rules reinforced, 2 promoted)

### Guide & Recovery Log
(empty: commit guard passed first try)

### Deviations
- Phase 1 | db/migrations/20261017000100000_skill_levels_and_auto_enroll.sql | `team_members_changed_after_override` is stricter than the AC wording (override time requires a baseline), so provenance is always derivable (D-57)
- Phase 1 | db/migrations/20261017000100000_skill_levels_and_auto_enroll.sql | the selection index is named `idx_team_members_auto_enroll_order` because the draft index `idx_team_members_auto_enroll` already exists; the count index is `idx_registrations_confirmed_member` (D-60, D-61)
- Phase 1 | packages/shared/src/api/skill-levels.ts | `TeamMemberRow` additive fields, `skill_level_stale` error code and `toSkillProgress`/`deriveSkillProvenance` are deferred to Phase 3 (they ship with the API that fills them); Phase 1 delivers only the request schemas
- Phase 2 note | `skill_level_changed_at` is returned as a millisecond ISO string and stored with microseconds: the stale-compare under the row lock must compare at ms precision or the writer must always bind a JS Date from the injected clock
- Phase 2 | apps/api/src/modules/skill-levels/auto-enrol.ts | `selectAutoEnrollees` lives in `auto-enrol.ts` (architecture leaf split), not `games.ts`; batch fn is `countQualifyingGamesBatch`
- Phase 2 | apps/api/test/integration/skill-levels-games.int.test.ts:306 | partial-index check is an EXPLAIN with seq scans discouraged: proves the index is usable, not that the planner picks it at scale (plan allowed "EXPLAIN or documented check")
- Phase 2 (DONE_WITH_CONCERNS) | verifier | verifier reported jobs.int.test.ts and teams-ban-seam.int.test.ts FAIL on the pg-boss previewSchedule timeout (schedules.ts:85) under load; the builder's later full integration run passed 404/404; pre-existing flake not touched by this branch, not re-run in isolation
- Phase 3 | decisions.ts | same-level save is a no-op even when expected values are stale, so retries are safe (AC-HAPPY-3 amended)
- Phase 3 | service.ts | invalid_until 422 is checked after target-row checks, so a non-APPROVED target with a past date gets 409
- Phase 3 | errors.ts | lock timeout 55P03 maps to 503 service_unavailable (not declared in route response schemas/OpenAPI; non-blocking review note)
- Phase 3 | progression.ts | skillProgress.games is capped at required
- Phase 3 | member-read.ts | no-N+1 means 2 queries per page (list plus one grouped count)
- Phase 3 | teams/service.ts | skillOverride.byName falls back to ''
- Phase 3 | skill-levels-api.int.test.ts | flake risk: 2s HTTP lock_timeout in race tests could give 503 under heavy load
- Phase 3 | shared/api/skill-levels.ts | no request-schema change was needed
- Phase 3 | verify | `pnpm run test:coverage` needs DATABASE_URL (it runs the integration project); unit-only coverage of skill-levels/** is low by design, the gate passes on the combined run
- Phase 4 | test/integration/skill-levels-races.int.test.ts | clock is synchronous, so races suspend the job mid-transaction with a throwaway BEFORE UPDATE trigger waiting on a test-held advisory lock (no production hooks)
- Phase 4 | jobs/skill-progression.ts | span events use trace.getActiveSpan()?.addEvent; lib/jobs/jobs.ts does not make the run span active, so they are no-ops until it does (member_failed log and failed job state carry visibility)
- Phase 4 | jobs/skill-progression.ts | on abort the handler logs the summary then throws
- Phase 4 | modules/skill-levels/repo.ts | baseline read as ::text under the lock and bound back as text so microsecond precision is exact
- Phase 4 | jobs/schedules.test.ts | DST-hour guard test given a 30s timeout; it timed out at 5s under full coverage load (pre-existing flake family)
- Phase 4 note | skill-levels-schema.int.test.ts:351 failed once with a node-pg-migrate checkOrder error inside one combined coverage run; passed alone and on two later full coverage runs
- Phase 5 (DONE_WITH_CONCERNS) | e2e | skill-levels.spec.ts ran against `next dev` and a local API (no .env, Compose api/web could not start), not the Compose stack; teams.spec.ts private-team journey failed on desktop+mobile at line 241 (dev server sends cache-control no-cache not no-store), so its promote/demote/ban steps did not run against the new row layout. Re-run `pnpm run test:e2e` on the Compose stack
- Phase 5 | skill-enroll-panel.tsx | forms use onSubmit + startTransition (not form action) because React 19 resets forms after the action and wiped typed values on failure; Auto Enroll form is noValidate. Both need JS
- Phase 5 | skill-levels-view.ts | status 0 and offline TypeError use UNCONFIRMED_MESSAGE; 503 and other failures use SAVE_FAILED_MESSAGE; moderation.ts not edited (mapping lives in skill-levels-view.ts toSkillResult)
- Phase 5 | manage-view.ts | memberRowControls gained skillControl; MemberList requires todayNz (page computes via instantToLocal)
- Phase 5 review notes (non-blocking) | off-hint not in checkbox aria-describedby; success line persists after re-edit; 502/504 says "Nothing was changed"; todayNz stale across NZ midnight
- Phase 5 review | apps/web/e2e/teams.spec.ts:241 | failure judged an environment artefact (proxy.ts cache-control under next dev; page/proxy untouched by this branch), but the promote/demote/ban steps after line 241 were NOT exercised against the new member-list.tsx row layout: re-run `pnpm run test:e2e` on the Compose stack before merge
