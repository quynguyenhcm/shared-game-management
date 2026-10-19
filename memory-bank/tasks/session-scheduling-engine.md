---
slug: session-scheduling-engine
feature: session-scheduling-engine
status: PLANNING_COMPLETE
---

# session-scheduling-engine: Session Scheduling Engine

**Complexity**: Level 4
**Status**: PLANNING_COMPLETE
**Roadmap**: session-scheduling-engine
**Branch**: feature/session-scheduling-engine
**Worktree**: ~/yay-wt/shared-game-management/session-scheduling-engine

## Task Description

Multi-court session setup, costing and recurrence (PRODDUCT-OVERVIEW §4; workflows §4).

- Recurring rules (weekly/fortnightly/monthly, optional `recur_until`); background worker materialises session + court instances
- Single-instance overrides (courts, capacity, times, rates) without breaking the series; rule edits must not overwrite overridden instances
- Session fields: location, full street address, date, cancellation deadline (default 48h before start), `max_players`, `reserved_seats`
- Multi-court fast setup: bulk default start/end times with per-court inline overrides
- Costing: suggested rate `ceil((total_court_cost + extra_expenses) / max_players)` shown in an editable field
- Pricing models: `FLAT`, `BY_SEX`, `BY_SKILL_LEVEL`
- Draft → Published → Completed/Cancelled lifecycle; auto-enroll members on materialisation

**Depends on**: team-banking-and-gst (merged), skill-levels-and-auto-enroll (merged)

**Downstream contracts already handed to this feature** (must be honoured by the spec):
- registration-and-waitlist (in flight, `feature/registration-and-waitlist`): C-SSE-1..5 in `creative/registration-and-waitlist-allocator-architecture.md`; slot contract and page-ownership split in `creative/registration-and-waitlist-registration-user-journey.md` (admin surfaces under `/teams/[teamId]/manage/sessions` belong here; the player session page belongs to registration)
- team-banking-and-gst: publish gate and recurrence materialiser contract (ADR 0016, `creative/team-banking-and-gst-banking-architecture.md`)
- skill-levels-and-auto-enroll: auto-enrol obligations (ADR 0017)
- platform-foundation: `fee_other` default `LEAST(fee_male, fee_female)` for BY_SEX, DST input policy, `recurrence-materialisation` cron job slot (`creative/platform-foundation-algorithm.md`, `-architecture.md`)

**Complexity rationale**: Recurrence engine + override semantics + background workers + complex admin UI; multiple creative phases → Level 4.

## Specification

**Feature Type**: End-User Feature
**Primary Persona**: Team Admin (`TEAM_ADMIN` of one team, APPROVED). Goals: set up the club's regular multi-court nights once, cost them so fees cover court hire, change one night without breaking the series, and open sessions for registration without spreadsheets. Pain points: retyping the same session every week, per-court time differences (Courts 1-2 8-10am, Court 7 8-9am), working out a break-even rate by hand. Secondary: Player (`PLAYER`, APPROVED member), who is auto-enrolled into materialised sessions when Auto Enroll is on and never sees an admin surface here. Also two later features that consume this one's outputs: registration-and-waitlist (seat allocator, player session page) and wallet-and-akahu-billing (bills PUBLISHED sessions and moves them to COMPLETED).
**Creative Exploration Needed**: Yes. Recurrence and override algorithm (monthly rule meaning, rule anchor, horizon, series-edit propagation), materialiser architecture and its concurrency with the publish gate, the auto-enrol seam and the not-yet-built allocator, and the admin UI for multi-court setup and series-versus-instance edits. See "Creative Exploration Needed" below. Ten contract conflicts or schema gaps are listed there for creative to rule on; none was silently resolved.

*Note: the spec cites ADRs 0015 to 0017 on `main`, the registration-and-waitlist branch's creative docs and plan amendments R14 to R18 (commit b8da4b6, unmerged), and the platform-foundation and team-banking-and-gst creative docs. Contract IDs (C-SSE-n, C-SAE-n, C-SKL-1, C-GAME-1, C-ALL-1) are quoted as their owners named them, so they survive an ADR renumber.*

### Invocation Method

- **Location**: a new team-admin area **Sessions** at `/teams/[teamId]/manage/sessions`, added by appending one entry `{ id: 'sessions', label: 'Sessions', segment: 'sessions' }` to `MANAGE_AREAS` in `apps/web/src/lib/teams/manage-areas.ts`. The area nav (`apps/web/src/components/teams/manage-area-nav.tsx`) then shows "People · Banking and GST · Sessions" on every manage page. Ownership of this surface is fixed by registration-and-waitlist's page-ownership decision (`registration-and-waitlist-registration-user-journey.md` "Page ownership decision (Q5)"): admin session surfaces under `/teams/[teamId]/manage/sessions` belong to this feature; the player page `/teams/[teamId]/sessions/[sessionId]` and the "Upcoming sessions" list on `/teams/[teamId]` belong to registration-and-waitlist.
- **Pages** (all under the existing `apps/web/src/app/teams/[teamId]/manage/layout.tsx` shell; each renders `ManageAreaNav current="sessions"` only after its guard passes, like `manage/banking/page.tsx`):

  | URL | Purpose |
  |---|---|
  | `/teams/[teamId]/manage/sessions` | Sessions list. Sections (via `ManageSection`): "Upcoming" (PUBLISHED, not started), "Drafts", "Series" (recurring rules), "Past and cancelled". Primary buttons "New session" and "New recurring series" |
  | `/teams/[teamId]/manage/sessions/new` | One-off session editor (DRAFT until published) |
  | `/teams/[teamId]/manage/sessions/[sessionId]` | Session editor for one session or one instance of a series: details, courts, costing, pricing, capacity; actions "Save", "Publish", "Cancel session" |
  | `/teams/[teamId]/manage/sessions/series/new` | Series (recurring rule) editor |
  | `/teams/[teamId]/manage/sessions/series/[ruleId]` | Series editor plus the list of its materialised instances, each marked "Edited" when `is_instance_overridden`, and the banking notice when instances were saved as drafts by the publish gate |

- **Element**: buttons "New session" and "New recurring series" on the list page; in the editors, a "Courts" fieldset with "Number of courts", "Default start" and "Default end", an "Apply to all courts" button, one row per court (identifier, start, end) that can be edited inline, and "Add court"/"Remove"; a "Costing" fieldset with "Court hire (total)", "Extra expenses", a read-only "Suggested rate per player" line, and an editable "Rate per player" text input pre-filled from the suggestion with a "Use suggested rate" button; a "Pricing" radio group "Flat rate / By sex / By skill level" that reveals the matching fee inputs; "Max players" and "Reserved host seats"; "Cancellation deadline" (pre-filled to 48 hours before the earliest court start). Confirmations (Publish when paid, Cancel session, End series) use the existing `InlineConfirm` disclosure pattern (`apps/web/src/components/teams/inline-confirm.tsx`), never `confirm()` or `<dialog>`.
- **API** (new module `apps/api/src/modules/sessions/{routes,service,repo}.ts` registered in `buildApp` with `prefix: '/teams'`, every route `config: { policy: requireTeamRole('TEAM_ADMIN') }`; shared zod contracts in `packages/shared/src/api/sessions.ts`; MEDIUM confidence on exact paths, final shape set in creative):
  - `GET /teams/:teamId/sessions?view=upcoming|drafts|past` (admin list; `no-store`)
  - `POST /teams/:teamId/sessions` (create a one-off DRAFT, strict body, `createKey` UUID for replay safety like `teams.create_idempotency_key`)
  - `GET|PUT /teams/:teamId/sessions/:sessionId`, `POST /teams/:teamId/sessions/:sessionId/publish`, `POST /teams/:teamId/sessions/:sessionId/cancel`
  - `GET|POST /teams/:teamId/session-series`, `GET|PUT /teams/:teamId/session-series/:ruleId`, `POST /teams/:teamId/session-series/:ruleId/end`
  - Reserved for registration-and-waitlist, never claimed here: `GET /teams/:teamId/sessions/upcoming` (MEMBER) and `/teams/:teamId/sessions/:sessionId/registration*`.
- **Job**: the existing `recurrence-materialisation` slot (`apps/api/src/jobs/schedules.ts`, cron `0 3 * * *` Pacific/Auckland, queue policy `exclusive` in `jobs/registry.ts`) gets a real handler in place of `placeholderHandler`. A rule create or edit also enqueues a materialisation for that rule in the same transaction (workflows §4 "On New Session Rule Creation"; P5). Operator path: `pnpm run jobs:trigger recurrence-materialisation`.
- **Visibility**: the Sessions area and every page and route are TEAM_ADMIN only. A MEMBER, PENDING, BANNED or anonymous caller gets the `NoAccess` page (web) or 403 (API, same answer for an unknown team), matching `manage/banking/page.tsx`. Signed-out visits go through `requireUser(here)` to `/login?returnTo=...`.
- **Navigation**: header "My teams" → `/teams` → team row → `/teams/[teamId]` → "Manage team" (`/teams/[teamId]/manage`) → area nav "Sessions" → `/teams/[teamId]/manage/sessions` → "New session" | "New recurring series" | a session or series row.
- **Confidence**: MEDIUM-HIGH for location and navigation (the registry and the area-page pattern exist and registration's ownership split names this path). MEDIUM for the API paths and page split. LOW for the multi-court editor layout at 360 px and for how series-versus-instance edits are presented (creative UI/UX).

### Success Criteria

- **User sees**:
  - After "Save" on a new session: the editor reloads at `/teams/[teamId]/manage/sessions/[sessionId]` with the banner "Draft saved." and status "Draft".
  - After "Publish": banner "Session published. Members can now register." and status "Published". If the gate refuses: the alert (focused once) "Add your team's bank account details before publishing a paid session." (verbatim from `apps/api/src/lib/http/errors.ts`, code `payout_not_configured`) with the link "Set up banking and GST" to `/teams/[teamId]/manage/banking?returnTo=<url-encoded editor path>`; the draft and every edited field are kept (ADR 0016 "Manual publish and the returnTo hand-off").
  - After creating a series: the series page with "Series created." and its instances listed (dated, NZ format, each "Published" or "Draft"), or while the first materialisation is still running, "We're adding the sessions in this series. Refresh in a moment."
  - After "Cancel session": "Session cancelled." and status "Cancelled". After "End series": "Series ended. No new sessions will be added after {date}."
  - The suggested rate line updates as cost, expenses or max players change: "Suggested: $11.00 per player (court hire + extras ÷ max players, rounded up to the dollar)". Copy is provisional; the creative UI/UX doc owns final wording.
- **Verifiable at**: the Sessions list and editors above; `GET /teams/:teamId/sessions/:sessionId`; the database rows below; `pgboss.job` for the materialisation and email jobs; Mailpit for the admin "banking missing" email; structured logs `session.*`.
- **Data persisted**:
  - `game_sessions` (existing, `db/migrations/20260929000600000_game_sessions_and_courts.sql`): `team_id`, `recurring_rule_id`, `is_instance_overridden`, `location`, `address`, `date`, `cancellation_deadline`, `max_players`, `reserved_seats`, `total_court_cost`, `extra_expenses`, `calculated_rate_per_player`, `custom_player_rate`, `pricing_structure`, the seven `fee_*` columns, `status`; `starts_at`/`ends_at` are trigger-derived (D-08) and never written by the app.
  - `session_courts` (existing): `session_id`, `court_identifier`, `start_time`, `end_time`.
  - `recurring_session_rules` (existing, `20260929000500000_recurring_session_rules.sql`): `frequency`, `day_of_week`, `default_*` columns, pricing and `fee_*` columns, `recur_until`, `is_active`.
  - Expected new schema (one reversible migration, ledger D-70 onwards, open question 7 resolved): CHECKs required by C-SSE-1 (all three skill fees NOT NULL when `BY_SKILL_LEVEL` and PUBLISHED; `fee_flat` NOT NULL when `FLAT` and PUBLISHED); a `game_sessions` status-transition trigger; immutability of COMPLETED and CANCELLED rows; a rule anchor date and a per-court rule template (gap 9); optimistic-concurrency stamps (gap 9). Exact shape decided in creative.
  - `pgboss.job`: `recurrence-materialisation` runs; `send-email` with `idempotencyKey = payout-missing:<ruleId>:<windowStart>` (ADR 0016 recurrence contract point 5).
- **Observable within**: immediate for every admin write (synchronous API). Rule-create materialisation is async: instances visible within about 5 s (one job poll plus the run); the daily run at 03:00 Pacific/Auckland. Auto-enrol registrations appear once registration-and-waitlist's allocator is injected (see conflict 1).

### Acceptance Criteria

#### AC-ENTRY-1: Team admins reach the Sessions area from the manage nav
**Priority**: MUST
**Given** an APPROVED `TEAM_ADMIN` of team T signed in on `/teams/T/manage`
**When** they look at the area nav and choose "Sessions"
**Then** the nav lists "People", "Banking and GST" and "Sessions" (from `MANAGE_AREAS`), "Sessions" opens `/teams/T/manage/sessions` with `aria-current="page"` on its link, and `manage-areas.test.ts` asserts the new entry renders the nav on the sessions page; a MEMBER, PENDING, BANNED or other-team user opening the same URL sees the `NoAccess` page and no session data, and an anonymous user is redirected to `/login?returnTo=%2Fteams%2FT%2Fmanage%2Fsessions`

#### AC-ENTRY-2: The Sessions list shows each lifecycle group and the two create actions
**Priority**: MUST
**Given** team T has one PUBLISHED future session, one DRAFT, one active series and one CANCELLED session
**When** the admin opens `/teams/T/manage/sessions`
**Then** they see the sections "Upcoming", "Drafts", "Series" and "Past and cancelled", each row showing date (NZ format), time range from earliest court start to latest court end, location, court count and status, rows linking to their editor; the buttons "New session" and "New recurring series" are visible; a team with no sessions sees an empty-state line in each section instead of an empty table

#### AC-HAPPY-1: Admin sets up a multi-court one-off session with bulk times and per-court overrides
**Priority**: MUST
**Given** the admin is on `/teams/T/manage/sessions/new`
**When** they complete:
  1. Location "Rosedale Badminton Centre", address "12B John Glenn Avenue, Rosedale, Auckland 0632", a future date
  2. Number of courts 9, default start 08:00, default end 10:00, "Apply to all courts"
  3. Override Court 7 to 08:00-09:00 and Court 9 to 09:00-10:00 inline
  4. Max players 36, reserved host seats 2
  5. "Save"
**Then** one `game_sessions` row exists with `status = 'DRAFT'`, `recurring_rule_id IS NULL`, and nine `session_courts` rows with the entered identifiers and times; `starts_at`/`ends_at` equal the trigger-derived instants of 08:00 and 10:00 on that date; `cancellation_deadline` equals `defaultCancellationDeadline(starts_at)` (absolute minus 48 h, `packages/shared/src/time/time.ts`) because the admin did not change it; the page shows "Draft saved."

#### AC-HAPPY-2: The suggested rate is computed exactly and the final rate is editable
**Priority**: MUST
**Given** the admin is editing a session's Costing fieldset
**When** they enter court hire, extra expenses and max players
**Then** the suggested rate equals `divideByInteger(add(courtCost, extraExpenses), BigInt(maxPlayers), 'CEIL', 'DOLLAR')` from `packages/shared/src/money/money.ts`, computed by one shared pure function used by both the web form and the API (never `Math.ceil` or floats; P2), with the platform-foundation vectors ($120.00 + $12.00, 12 players → $11.00; $130.00 + $12.00, 12 → $12.00; $120.00 + $0, 14 → $9.00; $120.01 + $12.00, 12 → $12.00); the server stores it in `calculated_rate_per_player`; the "Rate per player" input is pre-filled with it and, when changed and saved, the new value is stored in `custom_player_rate` and survives reload; for a FLAT session `fee_flat` equals `custom_player_rate ?? calculated_rate_per_player` (C-SSE-1)

#### AC-HAPPY-3: Admin prices a session FLAT, BY_SEX or BY_SKILL_LEVEL
**Priority**: MUST
**Given** a session or series editor
**When** the admin picks a pricing model and saves
**Then** FLAT stores `fee_flat` as in AC-HAPPY-2; BY_SEX stores `fee_male` and `fee_female` as entered and pre-fills `fee_other` with `min(fee_male, fee_female)` using the `Money` `min` primitive (platform-foundation algorithm Q11, D-06), which the admin can change before saving and which is never overwritten once saved; BY_SKILL_LEVEL stores `fee_beginner`, `fee_intermediate` and `fee_advanced`; fee columns of the other models are saved as NULL; every amount is a 2-dp money string at or above $0.00

#### AC-HAPPY-4: Admin publishes a draft through the publish gate
**Priority**: MUST
**Given** a DRAFT session of team T with at least one court, a start in the future and complete fees, and team T is payout-configured (or the session is free)
**When** the admin chooses "Publish" (confirming in the InlineConfirm when the session is paid)
**Then** in one transaction the service calls `assertTeamCanPublishPaidSession` (`apps/api/src/modules/team-banking/publish-gate.ts`) before taking any `game_sessions` lock, then `SELECT ... FROM game_sessions WHERE id = $1 FOR UPDATE`, copies the final FLAT rate into `fee_flat` (C-SSE-1), and sets `status = 'PUBLISHED'` with a guarded `UPDATE ... WHERE status = 'DRAFT'` (ADR 0016 "Gate contract" points 1-3); the editor shows "Session published. Members can now register."; `session.published` is logged with `teamId`, `sessionId` and `actorId`

#### AC-HAPPY-5: Admin creates a recurring series and sees its instances
**Priority**: MUST
**Given** the admin is on `/teams/T/manage/sessions/series/new`
**When** they choose frequency Weekly, day Wednesday, a first date, an optional "Repeat until" date, the location and address, courts with bulk times and per-court overrides, costing, pricing, max players and reserved seats, then save
**Then** one `recurring_session_rules` row is stored with those defaults (BY_SEX `fee_other` defaulted as in AC-HAPPY-3), a `recurrence-materialisation` job for that rule is enqueued in the same transaction (P5), and within about 5 s the series page lists one instance per matching date from the first date up to the earlier of `recur_until` (inclusive) and the materialisation horizon, each a `game_sessions` row with `recurring_rule_id` set, `is_instance_overridden = false`, courts copied from the series and deadline `starts_at - 48h`; Fortnightly gives every second matching date from the first date and Monthly follows the rule chosen in creative (open question A1)

#### AC-HAPPY-6: Admin edits one instance without breaking the series
**Priority**: MUST
**Given** a series with at least three future instances
**When** the admin opens one instance and changes any of its courts, times, max players, reserved seats, costing or rates, then saves
**Then** that instance's row and courts change and `is_instance_overridden` becomes true; the other instances and the series row are unchanged; the series page marks the edited instance "Edited"; later materialisation runs and later series edits never overwrite it (AC-HAPPY-7)

#### AC-HAPPY-7: Series edits never overwrite edited, past or closed instances
**Priority**: MUST
**Given** a series with a past instance, a COMPLETED or CANCELLED instance, an edited future instance (`is_instance_overridden = true`) and an unedited future instance
**When** the admin changes the series defaults (times, courts, location, costing, pricing, capacity) and saves
**Then** the past, COMPLETED, CANCELLED and edited instances are byte-for-byte unchanged; dates not yet materialised are created with the new defaults; how unedited instances that already exist take the change follows the creative ruling (open question A3), and wherever that ruling changes a PUBLISHED instance, a capacity change follows C-SSE-3 (AC-HAPPY-8) and a free-to-paid change goes through the publish gate (ADR 0016 gate contract point 1); the page tells the admin how many existing sessions were updated and how many were left because they were edited

#### AC-HAPPY-8: A capacity edit on a published session promotes the waitlist in the same transaction
**Priority**: MUST
**Given** a PUBLISHED session that has not started
**When** the admin raises `max_players` or lowers `reserved_seats` and saves
**Then** one transaction takes any `teams`/`team_members` locks it needs, then `SELECT ... FROM game_sessions WHERE id = $1 FOR UPDATE`, then the `UPDATE`, then calls `promoteWaitlist(ctx, { teamId, sessionId })` on the allocator port (C-SSE-3, C-SSE-5; conflict 1); a cut (lower `max_players` or higher `reserved_seats`) is saved and demotes nobody; the session lock is held only for this edit (C-SSE-5); `reserved_seats` stays within `0..max_players` (existing CHECK)

#### AC-HAPPY-9: Admin cancels a session and its registrations are left as they are
**Priority**: MUST
**Given** a DRAFT session, or a PUBLISHED session that has not started
**When** the admin chooses "Cancel session" and confirms in the InlineConfirm
**Then** `status` becomes `CANCELLED` through a guarded `UPDATE` under the session `FOR UPDATE` lock; no `registrations` row is changed and no allocator call is made (C-SSE-4); a cancelled series instance keeps its row, so its `(recurring_rule_id, date)` key stops the materialiser from recreating it (`uq_game_sessions_rule_date`); the page shows "Session cancelled."; `session.cancelled` is logged

#### AC-HAPPY-10: Admin ends a series
**Priority**: MUST
**Given** an active series
**When** the admin chooses "End series", picks the last date (default today) and confirms
**Then** `recur_until` is set to that date (and `is_active` false if the date is today or earlier), no instance after it is materialised by later runs, and existing instances after it are handled per the creative ruling (open question A4); the page shows "Series ended. No new sessions will be added after {date}."

#### AC-HAPPY-11: The cancellation deadline defaults to 48 hours before start and can be changed
**Priority**: MUST
**Given** a session editor
**When** the admin leaves "Cancellation deadline" at its default, or sets another date and time, and saves
**Then** the default is `starts_at - 48h` absolute (`CANCELLATION_DEADLINE_DEFAULT_HOURS`), shown as an NZ local date and time; an explicit value is stored as entered (converted with `DST_POLICY.USER_INPUT`); in both cases `cancellation_deadline <= starts_at` holds (existing CHECK `game_sessions_deadline_before_start`); when courts or the date move the start, a deadline that was still the default moves with it and an explicit one is kept only if it still satisfies the CHECK (otherwise AC-ERROR-2)

#### AC-ASYNC-1: The daily materialiser creates instances once and only once
**Priority**: MUST
**Given** active series whose `recur_until` is NULL or not yet passed
**When** the `recurrence-materialisation` job runs (03:00 daily, on rule create or edit, or `jobs:trigger`), including twice in a row or concurrently with a rule-specific run
**Then** every missing date inside the horizon gets exactly one instance, one instance per transaction (ADR 0016 recurrence contract point 1), inserted as DRAFT with its courts and then published when the gate allows; a re-run creates nothing (`uq_game_sessions_rule_date`, `ON CONFLICT DO NOTHING`); local dates come from `addLocalDays` and instants from `DST_POLICY.DERIVED` (`compatible`), so a 02:30 court on a DST-change day never fails the job; the run logs `session.recurrence.run_completed` with `rulesScanned`, `created`, `published`, `savedAsDraft`, `failed`

#### AC-ASYNC-2: Auto Enroll members are registered when an instance is published
**Priority**: MUST
**Given** team T has members with Auto Enroll on (some with `auto_enroll_until` before, on and after the instance date) and the materialiser publishes an instance of T's series
**When** the publish commits
**Then** after the instance is PUBLISHED the materialiser calls `selectAutoEnrollees(trx, { teamId, sessionDate: game_sessions.date })` (ADR 0017 C-SKL-1 point 1) and passes its result, in the returned order, once per session, to the allocator port's `autoEnrolInSession` with entries `{ userId, assignedAt }` (registration-and-waitlist R16; C-SAE-1, C-SAE-2: no guests, never a direct `registrations` write); in the same transaction when the session row was inserted in it, and in a follow-up transaction that has not locked the session when the session already existed (ADR 0017 C-SKL-1 point 5); per-member refusals are skips and never abort the run; until registration-and-waitlist injects its allocator the port is a no-op that logs `session.auto_enrol.port_noop` with `sessionId` and `candidates` (conflict 1)

#### AC-ASYNC-3: A paid instance blocked by missing banking is saved as a draft and the admin is told once
**Priority**: MUST
**Given** team T is not payout-configured and its series is paid
**When** the materialiser runs
**Then** each new paid instance is checked with `checkTeamCanPublishPaidSession` before it is inserted and before any `game_sessions` lock, and on refusal is inserted as DRAFT, not skipped; this is not a job failure; `session.recurrence.publish_refused` is logged with `teamId`, `ruleId`, `sessionId`, `reason`; at most one `send-email` per rule per run window is enqueued in the same transaction (`idempotencyKey = payout-missing:<ruleId>:<windowStart>`) to every approved admin, linking to `/teams/T/manage/banking`; the series page shows "Some sessions in this series were saved as drafts because your team's bank account isn't set up." with the link "Set up banking and GST" (ADR 0016 recurrence contract points 1, 2, 4, 5)

#### AC-ASYNC-4: Materialiser-created drafts are published on a later run once banking is set up
**Priority**: MUST
**Given** DRAFT instances created by the materialiser after a gate refusal (`is_instance_overridden = false`), still in the future and inside the publish horizon, and the admin has since set up banking
**When** the next materialisation run happens
**Then** each such draft is published through the gate (gate, then session `FOR UPDATE`, then guarded `UPDATE ... WHERE status = 'DRAFT' AND is_instance_overridden = false`), and auto-enrol for it runs in a follow-up transaction (AC-ASYNC-2); drafts an admin has edited are left alone (ADR 0016 recurrence contract point 6)

#### AC-ERROR-1: A refused manual publish keeps the draft and hands off to banking and back
**Priority**: MUST
**Given** a paid DRAFT session and team T without usable payout details
**When** the admin chooses "Publish"
**Then** the API answers 409 `payout_not_configured`; nothing about the session changes and every field the admin edited is still saved or still in the form; the editor shows the API message verbatim in an alert region focused once, with "Set up banking and GST" linking to `/teams/T/manage/banking?returnTo=%2Fteams%2FT%2Fmanage%2Fsessions%2F<sessionId>`; the banking page accepts that `returnTo` (it starts with `/teams/T/` and is not the banking page) and after saving shows "Back to your session", which returns to the editor where "Publish" now succeeds (ADR 0016 manual publish points 1-5)

#### AC-ERROR-2: Invalid session or series input is refused field by field and nothing is saved
**Priority**: MUST
**Given** a session or series editor
**When** the admin submits any of: a court whose end is not after its start or that crosses midnight, no court on publish, `max_players` below 1, `reserved_seats` below 0 or above `max_players`, a blank or over-long location or address, a negative or more-than-2-dp amount, a deadline after the start, a session date in the past, `recur_until` before the first date, or an unknown field
**Then** the API answers 422 `validation_failed` with `fieldErrors` keyed by field (strict zod, shared schema), the database is unchanged, the form keeps every value, focus moves to the error summary, and each field shows its message; the same rules are enforced by DB CHECKs (P1), so a raw-SQL write fails with 23514

#### AC-ERROR-3: A court time that does not exist or happens twice on a DST day is refused with options
**Priority**: MUST
**Given** a session date of 2026-09-27 (DST starts) or 2027-04-04 (DST ends)
**When** the admin enters a court start of 02:30 on either date
**Then** the API answers 422 naming the date and time as nonexistent or ambiguous, with the options the stored model can actually represent (`DST_POLICY.USER_INPUT` = `reject`; platform-foundation algorithm Q7 and its handoff table), nothing is saved, and the form explains the choice; which options are offered is set by creative (conflict 6)

#### AC-ERROR-4: Publishing a session with incomplete pricing or no courts is refused
**Priority**: MUST
**Given** a DRAFT session that is `BY_SKILL_LEVEL` with a missing skill fee, or `FLAT` with no rate, or has no court, or whose start has passed
**When** the admin chooses "Publish"
**Then** the API answers 422 `validation_failed` naming the missing field (or 409 `session_started` for a past start) and the session stays DRAFT; raw SQL setting such a session to PUBLISHED fails on the new CHECKs (C-SSE-1: skill fees NOT NULL when PUBLISHED; FLAT `fee_flat` NOT NULL when PUBLISHED) or the existing `game_sessions_instants_when_live` (C-SSE-2)

#### AC-ERROR-5: Closed and started sessions refuse the edits that would corrupt them
**Priority**: MUST
**Given** a COMPLETED, CANCELLED, or PUBLISHED-and-started session
**When** the admin tries to edit it, change its courts, change its capacity, publish it or cancel it
**Then** COMPLETED and CANCELLED sessions refuse every edit with 409 `session_not_editable` and a DB trigger backs this up, including any `session_courts` insert, update or delete for a COMPLETED session (ADR 0017 C-GAME-1 point 3: `ends_at` must never move after completion); a capacity edit or cancel after `starts_at` is refused with 409 `session_started` (C-SSE-3); the editor shows these sessions read-only with a one-line reason

#### AC-ERROR-6: Illegal lifecycle transitions are impossible
**Priority**: MUST
**Given** any `game_sessions` row
**When** any writer (API, job or raw SQL) changes `status`
**Then** only `DRAFT → PUBLISHED`, `DRAFT → CANCELLED`, `PUBLISHED → CANCELLED` and `PUBLISHED → COMPLETED` are accepted; COMPLETED and CANCELLED are terminal; any other change fails with a named constraint error (P1), and a pure TypeScript transition table gives the API's 409 `session_state_conflict` on the normal path, both kept in step by one shared matrix fixture (the `teams/transitions.ts` pattern); this feature never performs `PUBLISHED → COMPLETED`, which belongs to wallet-and-akahu-billing (C-BIL-1, ADR 0017 C-GAME-1 point 3)

#### AC-ERROR-7: A save based on a stale view is refused, not silently applied
**Priority**: SHOULD
**Given** two admins have the same session or series open
**When** the second saves after the first committed a change
**Then** the second save answers 409 `session_stale` (or `series_stale`) with the current state, writes nothing, and the editor shows "Someone else changed this session. Review the latest version and save again." with the latest values; a save that changes nothing is a no-op so retries are safe (ADR 0017 point 9 pattern)

#### AC-ERROR-8: Every sessions route refuses anyone who is not an admin of that team
**Priority**: MUST
**Given** each route of the sessions module
**When** it is called anonymously, by a MEMBER, by a PENDING or BANNED member, or by an admin of another team, or with an id that belongs to another team
**Then** it answers 401 or 403 (and the same 403 for an unknown team), never reveals another team's session, and `buildApp` refuses to start if any route lacks a `config.policy` (default-deny, ADR 0013)

#### AC-ERROR-9: One bad instance never stops the materialiser
**Priority**: MUST
**Given** a run in which one instance fails (for example a 23514 `game_sessions_paid_requires_payout` reaching the materialiser, which means the gate was skipped, or a lock timeout)
**When** the run continues
**Then** only that instance's transaction rolls back; a trigger error is logged at `error` as `session.recurrence.instance_failed` with `ruleId`, `date`, `sqlState`, `errorCode` (never a field named `code`); the run processes the remaining instances; the job ends failed (and retries with backoff) only when a transient error occurred, and a permanent one ends with `NonRetryableJobError` (ADR 0016 recurrence contract point 3; `job-queues-pgboss` learned rule)

#### AC-VERIFY-1: The schema migration adds the session invariants reversibly and is ledgered
**Priority**: MUST
**Given** the new migration(s) under `db/migrations/`
**When** `schema.int.test.ts` runs migrate, `rollback --all`, migrate
**Then** the schema is identical; `db/schema-deviations.md` has one row per new object with its Source (D-70 onwards); `apps/api/src/lib/db/types.generated.ts` matches codegen; raw-SQL tests prove each new rule: BY_SKILL_LEVEL PUBLISHED without all three skill fees fails 23514, FLAT PUBLISHED without `fee_flat` fails 23514, the status transition matrix of AC-ERROR-6, COMPLETED/CANCELLED immutability including `session_courts`, and any rule-anchor or rule-court CHECK the creative design adds

#### AC-VERIFY-2: Every publish path goes through the gate before the session lock
**Priority**: MUST
**Given** the manual publish, the one-step create-and-publish if offered, the materialiser's publish, the retry of materialiser drafts, and any edit that turns a PUBLISHED session from free to paid
**When** the integration suite runs each against a payout-configured team and an unconfigured team
**Then** the configured team publishes and the unconfigured team is refused (409 for the API, DRAFT for the job) with no trigger error reaching the caller; a structural test asserts the gate call precedes the first `game_sessions` lock in each path (ADR 0016 gate contract points 1-2); the paid rule is `isPaidSession`, never re-implemented here

#### AC-VERIFY-3: Lock order holds and the race matrix has no deadlock
**Priority**: MUST
**Given** the canonical lock order `teams → team_members → game_sessions → registrations → registration_guests → payments` (ADR 0015, ADR 0016, C-ALL-1), extended with the position of `recurring_session_rules` chosen in creative (open question B2)
**When** `sessions-races.int.test.ts` runs, with real connections and `pg_stat_activity` waits (no sleeps): materialiser against a rule edit, materialiser against an instance edit, two materialiser runs on the same `(rule, date)`, a manual publish against a banking removal (in both orders), and a capacity edit against a stand-in registration holding the session lock
**Then** every order ends with one committed outcome and the other either waiting then succeeding, or refused with a mapped 409, and no `40P01` occurs; this feature never takes `teams FOR UPDATE` and never takes a `teams` lock after a `game_sessions` lock (ADR 0016 lock rules)

#### AC-VERIFY-4: Recurrence date generation is a pure, table-tested function
**Priority**: MUST
**Given** a pure function in `packages/shared/src/sessions/` (no clock, no DB) taking the rule (frequency, weekday, anchor, `recur_until`) and a window
**When** the table-driven unit tests run
**Then** it returns the expected `LocalDate`s for Weekly, Fortnightly (parity from the anchor) and Monthly (per the creative ruling, including months without a fifth weekday and the year boundary), treats `recur_until` as inclusive, returns nothing for a window wholly after `recur_until`, and is identical across both DST-change weeks of 2026-27; host time zone has no effect (runs under `TZ=UTC` and `TZ=Pacific/Kiritimati`)

#### AC-VERIFY-5: Money stays exact in costing and pricing
**Priority**: MUST
**Given** all costing, rate and fee code in `packages/shared/src/sessions/`, `apps/api/src/modules/sessions/` and the web sessions components
**When** `pnpm run lint` and the unit tests run
**Then** amounts are `Money`/`MoneyString` only (no `number`, `parseFloat`, `toFixed`, or `Math.*` on amount-like identifiers; existing `eslint.config.mjs` guard), money crosses the wire as 2-dp strings and is stored as `numeric(10,2)`, and the AC-HAPPY-2 vectors pass in both the web helper and the API

#### AC-VERIFY-6: Session events are logged with ids only and carry the trace
**Priority**: MUST
**Given** the events `session.created`, `session.updated`, `session.published`, `session.publish_refused`, `session.cancelled`, `session.series.created`, `session.series.updated`, `session.series.ended`, `session.recurrence.run_completed`, `session.recurrence.instance_created`, `session.recurrence.publish_refused`, `session.recurrence.instance_failed`, `session.auto_enrol.completed`, `session.auto_enrol.port_noop`
**When** tests trigger each
**Then** each line has `teamId` plus the relevant `sessionId`/`ruleId`, `actorId` for admin actions, `traceId` (request or the job's CONSUMER span), no email or bank value, error codes logged as `errorCode`, and the tests assert the logged fields, not only that the event fired (`logging-redaction-global` learned rule); no new redaction key collides with an existing field name

#### AC-VERIFY-7: The feature's ADR records every contract it honours and offers
**Priority**: MUST
**Given** this feature's ADR `docs/adr/0019-session-scheduling-engine.md`
**When** the final review reads it
**Then** it states compliance with C-SSE-1..5, C-SAE-1..2 as amended by R16, C-ALL-1, ADR 0016's gate contract, lock rules, recurrence contract points 1-6 and the manual-publish hand-off, ADR 0017's C-SKL-1 points 1, 3, 5 and 6 and C-GAME-1 point 3, platform-foundation's `fee_other` default, DST policy, 48 h deadline and rate unit; and it records what this feature offers registration-and-waitlist: the allocator port's exact TypeScript signature and injection point, the admin-route namespace and reserved member routes, and acknowledgement of the slot contract (SSE adds nothing to the player page in this feature)

#### AC-VERIFY-8: The admin session pages are accessible on desktop and phone
**Priority**: MUST
**Given** the Compose stack with `AUTH_FAKE_OAUTH=true`
**When** `apps/web/e2e/sessions.spec.ts` scans the list, session editor and series editor with `@axe-core/playwright` on the desktop and 360 x 740 projects
**Then** there are no `critical` or `serious` violations; the per-court table is operable by keyboard and screen reader (each court row has labelled start and end inputs), has no horizontal page scroll at 360 px, and "Apply to all courts" announces how many courts changed through a polite live region

#### AC-INTEGRATION-1: Registration-and-waitlist's assumed outputs hold against real published sessions
**Priority**: MUST
**Given** sessions published through this feature's service (not inserted by fixtures)
**When** `sessions-contracts.int.test.ts` checks the five "Assumed session-scheduling-engine outputs" in the registration-and-waitlist task file and C-SSE-1..5
**Then** every PUBLISHED session has at least one court, set `starts_at`/`ends_at`, `cancellation_deadline <= starts_at`, final `max_players`/`reserved_seats`, and every fee column its pricing structure needs (FLAT `fee_flat` equal to the edited rate after a rate change on a published session too); cancelling changes no registration; a capacity raise calls `promoteWaitlist` exactly once after the session lock, verified with a recording allocator double; the test file header lists these as the contract registration's build gate re-checks

#### AC-INTEGRATION-2: Auto-enrol uses the real selection seam and calls the allocator port exactly as contracted
**Priority**: MUST
**Given** real `team_members` rows seeded through the factories (Auto Enroll on and off, `until` before, on and after the instance date, a non-APPROVED member, tie on `assigned_at`) and a recording allocator double injected through the same seam registration-and-waitlist will use
**When** the materialiser publishes an instance
**Then** the double receives one `autoEnrolInSession` call per published session, after the session is PUBLISHED, with `entries` equal to `selectAutoEnrollees` output in order (`assigned_at ASC, id ASC`), no guests, and the `sessionId` of that instance; a DRAFT (gate-refused) instance triggers no call; a double returning `overdue_payments`, `forbidden`, `already_registered` or `auto_enroll_changed` for some members does not abort the run; re-running the materialiser does not call it again for the same session

#### AC-INTEGRATION-3: An admin sets up, edits and publishes sessions end to end in a real browser
**Priority**: MUST
**Given** the Compose stack, the worker running, Mailpit, and a team admin whose team has no banking details
**When** `apps/web/e2e/sessions.spec.ts` walks: create a 3-court weekly paid series with one per-court override → see instances saved as drafts with the banking notice and the admin email in Mailpit → follow "Set up banking and GST" with `returnTo`, save banking, "Back to your session" → publish one instance → edit another instance's capacity (marked "Edited") → change the series start time and confirm the edited instance kept its values → cancel one instance
**Then** each step shows the copy in Success Criteria, the database matches (statuses, `is_instance_overridden`, courts), and the journey passes on desktop and 360 px; this run is the seed path registration-and-waitlist's E2E uses for "a PUBLISHED session seeded through the session-scheduling-engine admin flow"

### Scope Boundaries

- **In scope**:
  - Admin sessions area (list, one-off editor, instance editor, series editor) and its manage-area registry entry.
  - Sessions API module with TEAM_ADMIN policies, shared zod contracts and error codes (`session_not_editable`, `session_started`, `session_state_conflict`, `session_stale`, `series_stale`, plus DST refusal codes if creative adds them).
  - Costing (suggested rate, editable final rate) and the three pricing models, including the BY_SEX `fee_other` default.
  - Lifecycle DRAFT → PUBLISHED and → CANCELLED, with the DB transition trigger that also admits billing's PUBLISHED → COMPLETED.
  - Publishing through ADR 0016's gate; the manual-publish banking hand-off.
  - The `recurrence-materialisation` handler: horizon, idempotent per-instance transactions, gate-refused drafts, admin email, retry of materialiser drafts, auto-enrol through C-SKL-1 and the allocator port.
  - Single-instance overrides and series edits that respect them; capacity edits per C-SSE-3.
  - The migration(s) for C-SSE-1 CHECKs, lifecycle and immutability triggers, schema gaps; the ADR; unit, integration, race and E2E tests; the new module added to the coverage gate list.
- **Out of scope**:
  - The player session page `/teams/[teamId]/sessions/[sessionId]`, `SessionSummary`, `RegistrationPanel` and the team-page "Upcoming sessions" list (registration-and-waitlist, page-ownership Q5). Per the slot contract, this feature adds no section to the player page. A later "Edit session" admin link after `RegistrationPanel` can be added once that page exists.
  - Any write to `registrations`, `registration_guests` or `payments`; the allocator itself; promotion and auto-enrol emails (registration-and-waitlist R17).
  - The PUBLISHED → COMPLETED transition and billing (wallet-and-akahu-billing, C-BIL-1).
  - Emailing registered players when a session is cancelled or changed (open question C3).
  - Withdrawing registrations on cancel (C-SSE-4 needs a new `withdrawal_kind` through the allocator).
  - A venue library, calendar export, deleting series (End series only), sessions that cross midnight (existing CHECKs), subscription billing, guest pricing rules.
- **Dependencies**:
  - team-banking-and-gst (merged): `publish-gate.ts`, ADR 0016, banking page `returnTo`.
  - skill-levels-and-auto-enroll (merged): `selectAutoEnrollees` (`apps/api/src/modules/skill-levels/auto-enrol.ts`), ADR 0017.
  - team-management (merged): `MANAGE_AREAS`, `ManageAreaNav`, `ManageSection`, `InlineConfirm`, `NoAccess`, `requireTeamRole`, lock order (ADR 0015).
  - platform-foundation (merged): `Money`, `time.ts` (`addLocalDays`, `DST_POLICY`, `defaultCancellationDeadline`), `nz_local_to_utc` and the instants trigger, pg-boss runner, `enqueueEmail`, the `recurrence-materialisation` slot.
  - registration-and-waitlist (in flight, builds after this feature): supplies the real allocator later through the port (conflict 1).
- **Binding contracts honoured** (each re-checked at the build gate and in the ADR):
  - **registration-and-waitlist C-SSE-1** (`fee_flat` = final FLAT rate copied at publish; BY_SKILL fees NOT NULL when PUBLISHED with a CHECK): AC-HAPPY-2, AC-HAPPY-4, AC-ERROR-4, AC-VERIFY-1, AC-INTEGRATION-1.
  - **C-SSE-2** (PUBLISHED implies ≥1 court and `deadline <= starts_at`; lifecycle): AC-ERROR-4, AC-ERROR-6, AC-INTEGRATION-1.
  - **C-SSE-3** (capacity edit: locks, session `FOR UPDATE`, `UPDATE`, `promoteWaitlist` in one tx; a cut never demotes; refused after start): AC-HAPPY-8, AC-ERROR-5.
  - **C-SSE-4** (cancel leaves registrations, no allocator call): AC-HAPPY-9.
  - **C-SSE-5** (session lock `FOR UPDATE`, held briefly): AC-HAPPY-8, AC-VERIFY-3.
  - **C-SAE-1/C-SAE-2 as amended by R16** (`autoEnrolInSession` once per session after PUBLISHED, entries `{ userId, assignedAt }` in order, no guests, refusals are skips): AC-ASYNC-2, AC-INTEGRATION-2.
  - **C-ALL-1** (lock order, READ COMMITTED, no direct `registrations` writes): AC-VERIFY-3.
  - **Page-ownership split and slot contract**: Invocation Method, Scope "Out of scope", AC-VERIFY-7.
  - **ADR 0016** (gate contract 1-5, lock rules, recurrence contract 1-6, manual publish and `returnTo` hand-off): AC-HAPPY-4, AC-ASYNC-3, AC-ASYNC-4, AC-ERROR-1, AC-ERROR-9, AC-VERIFY-2, AC-VERIFY-3.
  - **ADR 0017 C-SKL-1** points 1, 3, 5, 6 (selection, call sequence, follow-up transaction, one-off sessions are this feature's decision): AC-ASYNC-2, AC-INTEGRATION-2, open question C1. **C-GAME-1 point 3** (refuse court edits on COMPLETED): AC-ERROR-5.
  - **platform-foundation**: `fee_other` default `LEAST(fee_male, fee_female)` in the service/UI (AC-HAPPY-3); `DST_POLICY.USER_INPUT` reject with options (AC-ERROR-3); `DERIVED` compatible for materialisation (AC-ASYNC-1); default deadline `starts_at − 48h` (AC-HAPPY-11); rate in whole dollars via `CEIL`/`DOLLAR` (AC-HAPPY-2); `recurrence-materialisation` at `0 3 * * *`, idempotent via `uq_game_sessions_rule_date` (AC-ASYNC-1).
- **NFR implications**:
  - P1: every invariant in the DB, with TS shaping only the error.
  - P2: money exact.
  - P3: UTC inside, NZ at the edges; `date` is the NZ calendar date.
  - P5: rule-create enqueue and admin emails in the domain transaction.
  - P7: horizon setting from env, zod-validated.
  - Accessibility: axe, 360 px.
  - Privacy: venue address is not personal data, but no member names or emails appear in job payloads or logs.
  - Performance: a session edit holds the session row lock only for its own statements (C-SSE-5; registration's 2 s lock timeout); the materialiser's per-instance transactions keep each lock short.
  - Coverage: add `apps/api/src/modules/sessions/**` and `packages/shared/src/sessions/**` to the 80% gate.

### Creative Exploration Needed

Level 4; three creative phases recommended: **Algorithm** (A), **Architecture** (B), **UI/UX + user journey** (C). Conflicts and gaps found while drafting are listed first, because creative must rule on them before build.

**Conflicts and gaps (explicit rulings needed; none was silently resolved):**

1. **The allocator does not exist when this feature is built.** C-SSE-3 and C-SAE-1 require calling `promoteWaitlist` and `autoEnrolInSession`, but registration-and-waitlist is build-gated on this feature merging first. Spec default (MEDIUM): a `SessionAllocatorPort` interface in `modules/sessions/` with a no-op default that logs, injected through `buildApp` deps and `registerJobs(...)` like ADR 0015's `MemberBannedHandler`, with registration's `createAllocator` adapting to it. Follow-on rollout gap: ADR 0017 point 7 says auto-enrol is not retroactive. Sessions materialised and published between this merge and registration's merge would therefore never get their Auto Enroll members unless (a) registration ships a one-time backfill, (b) the v1.0.0 release ships both together and production materialisation is held until then, or (c) this feature records "auto-enrol pending" per session for a later sweep. Needs a decision.
2. **`autoEnrolInSession` input shape.** ADR 0017 C-SKL-1 point 3 and the allocator doc's C-SAE-1 say `userIds`. Registration's later R16 says `entries: { userId, assignedAt }[]` and adds the `auto_enroll_changed` refusal. The spec follows R16, the later and binding one on the allocator's owner. Creative should confirm, and the ADR should record it.
3. **Which sessions trigger auto-enrol.** PRODDUCT-OVERVIEW §2 says auto-enrolled members are registered for "all newly created game sessions". Workflows §4 and ADR 0017 point 6 say only recurrence materialisation, with one-off sessions left open to this feature. The spec covers materialised instances, including materialiser drafts later re-published. Undecided: manually created one-off sessions, and an admin's manual publish of a recurring draft (a follow-up transaction or a `session-auto-enrol` job keyed `session-auto-enrol:<sessionId>`).
4. **Cron cadence.** Workflows §4 says "weekly / on new rule creation". The platform-foundation slot is daily `0 3 * * *`. The spec keeps the daily slot and adds an on-create/on-edit per-rule run, which covers both. Confirm whether the per-rule run uses the same `exclusive` queue (where it would wait behind a running sweep) or its own queue keyed `recurrence-rule:<ruleId>`.
5. **Horizon.** The overview says instances are generated "up to the Until date", but `recur_until` may be NULL or years away. ADR 0016 refers to a "publish horizon" without defining one. Decide the materialisation horizon (env `RECURRENCE_HORIZON_DAYS`, P7; spec placeholder 28 days, LOW), and whether publishing is immediate on materialisation or has a per-series lead time (for example "open registration N days before"). That choice decides when auto-enrol happens, because auto-enrol needs PUBLISHED (C-SAE-1).
6. **DST user-input options against what can be stored.** Platform-foundation asks for a 422 that offers `shiftedForward`/`earlier`/`later`. But `session_courts` stores a local `time`, and `game_sessions_derive_instants` always resolves with `compatible`: earlier for an overlap, shifted forward for a gap. A "later" choice for 02:30 on 2027-04-04 cannot be represented, and accepting 02:30 on 2026-09-27 stores a wall-clock time that never happens. Options: offer only the representable choice, and for a gap rewrite the stored time to 03:30; or add a per-court disambiguation column, which changes the D-08 trigger (shared with billing's `ends_at` sweep).
7. **ADR and ledger numbering.** Registration-and-waitlist R14 has claimed ADR **0018** and ledger **D-62 onwards**, but this feature merges first. ADR 0017's precedent says whichever merges second renumbers, and R14 already re-checks free numbers at its build gate. **RESOLVED (user, 2026-10-20 plan review): this feature renumbers.** It takes ADR **0019** (`docs/adr/0019-session-scheduling-engine.md`) and ledger **D-70 onwards**, leaving registration's reservation (ADR 0018, D-62..D-66 plus its R2 index) untouched. If registration's reservation grows past D-69 before this merges, re-check free numbers at this feature's build gate.
8. **COMPLETED belongs to billing.** The roadmap lists DRAFT → PUBLISHED → COMPLETED|CANCELLED under this feature, but C-BIL-1 and ADR 0017 C-GAME-1 point 3 give PUBLISHED → COMPLETED to wallet-and-akahu-billing. The spec has this feature define and enforce the transition matrix and never perform COMPLETED itself. Until billing ships, ended sessions stay PUBLISHED: show a derived "Ended" label in the admin list. Confirm that cancel is allowed only before `starts_at` (spec default), not until `ends_at`.
9. **Schema gaps in the existing tables.**
   - `recurring_session_rules` has no anchor or start date, which Fortnightly parity, Monthly and "first date" need.
   - It has no per-court template: it has only `default_court_count` plus one start/end time, so a series cannot carry "Court 7 8-9am".
   - It has no `updated_at` or version.
   - `game_sessions` has no `updated_at` or version for optimistic concurrency.
   - Nothing records whether `cancellation_deadline` is still the default (AC-HAPPY-11).
   - There is no `UNIQUE(session_id, court_identifier)` and no length CHECK on location or address.

   Creative should choose the columns or tables, for example `recurring_session_rules.starts_on`, a `recurring_rule_courts` table, version columns and a `deadline_is_default` flag.
10. **Fee edits on a PUBLISHED session reprice existing registrations.** Registration snapshots only the registrant's sex and skill level (R15), and billing charges from the session's `fee_*` at charge time. A fee change after players registered therefore changes what they pay. Choose: refuse fee edits once any active registration exists, allow them with a warning, or snapshot the fee at confirmation (which needs an agreement from registration-and-waitlist and wallet-and-akahu-billing). The free-to-paid direction must also call the gate (ADR 0016 gate point 1).

**A. Algorithm (recurrence and overrides)**
- A1. What "Monthly" means with the existing `day_of_week` column: the same nth weekday as the anchor (and what happens when the anchor is a 5th weekday), or the same day of month (which would make `day_of_week` redundant). LOW.
- A2. Horizon and publish lead time (conflict 5), and window bookkeeping for the one-email-per-rule-per-window key (`<windowStart>`).
- A3. Series-edit propagation to existing unedited instances: (a) only dates not yet materialised plus DRAFTs; (b) also PUBLISHED instances with no active registrations; (c) all future unedited instances, with capacity through C-SSE-3 and free-to-paid through the gate. Also whether override is whole-instance (the existing boolean) or per field.
- A4. Changing a series' day, frequency or anchor, or shortening `recur_until`: what happens to existing future instances on dates that no longer match (cancel, delete a DRAFT, or leave PUBLISHED ones), and how a `(rule, date)` collision with a CANCELLED instance is handled.
- A5. Rate details: the suggestion uses `max_players`, not public capacity (spec text); BY_SEX and BY_SKILL pre-fill from the suggestion or not; `fee_flat` kept equal to `custom ?? calculated` at every save, or only at publish (C-SSE-1 says "copied at publish").

**B. Architecture (materialiser and concurrency)**
- B1. Materialiser shape: one sweep over active rules with one transaction per instance; the per-rule run on create and edit (conflict 4); batching and job expiry (900 s default) for many teams; how the run window is computed from the injected clock (read once per run).
- B2. Where `recurring_session_rules` sits in the canonical lock order (proposed: after `teams`, before `team_members`). How a rule edit, materialiser run and instance edit serialise. Auto-enrol's `team_members FOR SHARE` after inserting the uncommitted session (allowed by ADR 0017 point 5), against the follow-up transaction for existing sessions.
- B3. The allocator port: signature, no-op default, injection, rollout gap (conflict 1), and how capacity edits call `promoteWaitlist` inside the same transaction once the real allocator lands (registration's `SET LOCAL lock_timeout` and retry policy apply to its own transactions only).
- B4. Optimistic concurrency and replay safety for creates and edits (version columns versus `expected*` fields; `createKey`).
- B5. The DB transition and immutability triggers, and their TS twin with a shared matrix fixture.

**C. UI/UX and user journey (admin)**
- C1. Multi-court fast setup at desktop and 360 px: count, defaults, "Apply to all courts", inline per-court overrides, ranges such as "Courts 1-2", and how an override is visibly distinct from the default.
- C2. Series versus instance editing: how the admin knows whether they are editing one date or the whole series, the "Edited" marker, what a series save tells them (counts updated and skipped), and the first-materialisation waiting state.
- C3. Telling players: whether cancelling or changing a PUBLISHED session emails its registrants, which needs a read of `registrations` and copy, and may be deferred to registration-and-waitlist. Also the one-off auto-enrol decision (conflict 3) from the admin's point of view.
- C4. Costing and pricing presentation: the suggested-rate explanation, editable rate, BY_SEX `fee_other` default hint, BY_SKILL inputs, and the publish confirmation for paid sessions.
- C5. List page grouping, the derived "Ended" label (conflict 8), the banking notice placement, and the read-only view of closed sessions.

### Implementation Guide Required

No. Every criterion is verifiable automatically (unit, integration, race and Playwright tests). Operators only need the existing `pnpm run jobs:trigger recurrence-materialisation` line, and the horizon env var goes in `docs/getting-started.md` and `.env.example`.

## Architectural Plan

### Executive Summary
Admins get a Sessions area to create, cost, price, publish and cancel multi-court sessions, and to define recurring series that a background job turns into session instances. The feature builds on tables platform-foundation already created (`game_sessions`, `session_courts`, `recurring_session_rules`). It adds a sessions API module, a real handler for the existing `recurrence-materialisation` slot, one migration for the missing invariants, and admin pages. It is the producer side of contracts already written by team-banking-and-gst (ADR 0016), skill-levels-and-auto-enroll (ADR 0017) and the in-flight registration-and-waitlist (C-SSE-1..5, C-SAE-1/2 per R16, slot contract).

### Business Context
Clubs run the same multi-court night every week. Today admins retype each night and work out a break-even rate by hand. Nothing in v1.0.0 can be registered for, billed or reported until sessions exist: registration-and-waitlist, wallet-and-akahu-billing, player-dashboard and admin-reporting-dashboard all read `game_sessions`. That makes this feature step 5 of the v1.0.0 build order and the critical-path dependency for the rest of the MVP.

### Vision and Goals
- **Vision**: a team admin sets up a recurring multi-court night once and never retypes it. Sessions open for registration on their own, correctly priced, and one-night changes never break the series.
- **Goals**:
  - A one-off 9-court session with per-court overrides is created and published in a single editor visit (AC-HAPPY-1, AC-HAPPY-4).
  - A weekly series produces its instances within about 5 s of creation and daily after that, with zero duplicates under re-runs and races (AC-ASYNC-1, AC-VERIFY-3).
  - Every PUBLISHED session satisfies C-SSE-1..5, proven against sessions created through the real service (AC-INTEGRATION-1).
  - No paid session is ever published for a team without payout details (AC-VERIFY-2).

### Requirements
- **Functional**: AC-ENTRY-1..2, AC-HAPPY-1..11, AC-ASYNC-1..4, AC-ERROR-1..9 (see Specification).
- **Non-functional** (with metrics):
  - Session row lock held only for the edit's own statements; no `40P01` across the race matrix (AC-VERIFY-3).
  - Rule-create instances visible within about 5 s, daily run at 03:00 Pacific/Auckland.
  - Coverage of at least 80% on `apps/api/src/modules/sessions/**` and `packages/shared/src/sessions/**`.
  - No axe `critical`/`serious` findings at desktop and 360 px (AC-VERIFY-8).
  - Exact money (P2).
  - Every invariant enforced in the DB (P1).

### Architectural Principles
1. **DB is the source of truth (P1)**: the lifecycle matrix, C-SSE-1 fee CHECKs and closed-session immutability are triggers or CHECKs. The TS twin only shapes the 409/422.
2. **Gate before lock**: every publish path calls the ADR 0016 gate before the first `game_sessions` lock, and nothing re-implements `isPaidSession`.
3. **Canonical lock order** `teams → [recurring_session_rules: position set in creative B2] → team_members → game_sessions → registrations → …`. This feature never takes `teams FOR UPDATE`.
4. **One instance, one transaction** in the materialiser. Idempotent by `uq_game_sessions_rule_date`, and one bad instance never stops the run.
5. **Ports, not imports, toward registration**: this feature never writes `registrations`. Allocator calls go through `SessionAllocatorPort`, which registration-and-waitlist implements later.
6. **Pure core**: recurrence date generation, costing and lifecycle transitions are pure functions with no clock and no DB, tested from tables.
7. **Config in env (P7)**: horizon, and lead time if creative adds one, come from `config.ts`, validated with zod.

### Architecture Alternatives
Recorded for creative to finalise; the plan assumes the first option where the spec has a MEDIUM default.
- **Materialiser trigger**: (A, default) daily sweep plus a per-rule run enqueued in the rule's transaction, both on the `exclusive` queue. (B) the per-rule run on its own queue keyed `recurrence-rule:<ruleId>`. (C) synchronous materialisation in the rule-create request. C is rejected because it holds rule and session locks across many inserts.
- **Allocator coupling**: (A, default) a `SessionAllocatorPort` with a no-op default injected via `buildApp` deps and `registerJobs`, like ADR 0015's `MemberBannedHandler`. (B) a hard import of registration's allocator. B is impossible because registration builds after this feature. (C) an outbox table that registration drains. C is heavier and breaks C-SSE-3's "same transaction" rule.
- **Series override granularity**: (A, default) whole-instance `is_instance_overridden`, which already exists. (B) per-field override mask. Decided in creative A3.
- **Optimistic concurrency**: (A) integer `version` columns. (B) `expected*` fields as in ADR 0017 point 9. Decided in creative B4.

### Selected Architecture
- **Shared pure modules** in `packages/shared/src/sessions/` (recurrence, costing) and API contracts in `packages/shared/src/api/sessions.ts`.
- **API module** `apps/api/src/modules/sessions/` with these responsibilities:
  - `routes`: TEAM_ADMIN policies.
  - `service`: transactions, gate, locks, port calls.
  - `repo`: Kysely queries.
  - `transitions`: TS twin of the DB matrix.
  - `materialise`: per-rule and per-instance logic.
  - `allocator-port`: interface plus no-op.
  - `errors`.
- **Job wiring**: `apps/api/src/jobs/recurrence-materialisation.ts` replaces `placeholderHandler` and calls `materialise`.
- **Web**: pages under `apps/web/src/app/teams/[teamId]/manage/sessions/**`, plus view and action helpers in `apps/web/src/lib/teams/` and form components in `apps/web/src/components/teams/`.

**Justification**: this reuses every established seam (module shape, manage-area registry, pg-boss runner, gate, `selectAutoEnrollees`, Money and time primitives) and keeps the cross-feature dependency on registration one-directional and testable with a recording double.

### Architecture Documentation
```
Admin (web) ──► /teams/:teamId/sessions*, /session-series*  (requireTeamRole TEAM_ADMIN)
                    │
                    ▼
            sessions.service ──► publish-gate (ADR 0016) ──► game_sessions FOR UPDATE ──► UPDATE
                    │                                                    │
                    │ (capacity raise)                                   ▼
                    └──────────────────────────────────────► SessionAllocatorPort.promoteWaitlist
                    │ (rule create/edit, same tx)
                    ▼
            pgboss: recurrence-materialisation ◄── cron 0 3 * * * Pacific/Auckland
                    │
                    ▼
            materialise(rule): recurrence.dates(window) → per date tx:
                INSERT game_sessions + session_courts ON CONFLICT DO NOTHING
                → gate check → publish | keep DRAFT (+ send-email once per rule/window)
                → selectAutoEnrollees (ADR 0017) → SessionAllocatorPort.autoEnrolInSession
```
- **Integration points**: team-banking `publish-gate.ts`; skill-levels `auto-enrol.ts`; `enqueueEmail` (P5); banking page `returnTo` (already implemented by `bankingReturnTo`); registration-and-waitlist through the port and the reserved member routes.

### Observability Requirements
- **Logging**: the existing pino logger, structured JSON, configured with `LOG_LEVEL`/`LOG_FORMAT`/`LOG_OUTPUT`. The events listed in AC-VERIFY-6 carry ids only, use `errorCode` rather than `code`, and include no email or bank values.
- **Tracing**: W3C Trace Context through the existing OTel setup. API spans per route; the materialiser runs in the job's CONSUMER span with a child span per instance (`session.recurrence.instance`). Port calls happen in-process inside the caller's span.
- **Metrics**: the run summary fields (`rulesScanned`, `created`, `published`, `savedAsDraft`, `failed`) are logged on `session.recurrence.run_completed`. No new metrics backend; an alert-worthy signal is `failed > 0` or `instance_failed` at `error`.
- **Infrastructure**: unchanged (existing collector via `OTEL_EXPORTER_OTLP_ENDPOINT`).

### API Requirements
- **REST API**: Yes. There is no GraphQL.
  - **OpenAPI**: regenerated from the zod contracts (existing pipeline). Build agents MUST load `api-rest-requirements.md`.
  - **Endpoints**: `GET|POST /teams/:teamId/sessions`, `GET|PUT /teams/:teamId/sessions/:sessionId`, `POST …/:sessionId/publish`, `POST …/:sessionId/cancel`, `GET|POST /teams/:teamId/session-series`, `GET|PUT …/session-series/:ruleId`, `POST …/session-series/:ruleId/end`. Reserved for registration: `GET /teams/:teamId/sessions/upcoming` and `…/:sessionId/registration*`.
  - **Auth**: session cookie and `requireTeamRole('TEAM_ADMIN')`; default-deny (ADR 0013).
  - **Errors**: `validation_failed` (422), `payout_not_configured` (409), `session_not_editable`, `session_started`, `session_state_conflict`, `session_stale`, `series_stale` (409), plus DST refusal codes from creative.
  - **Testing**: integration tests for every endpoint (`sessions-api.int.test.ts`).

### Guiding-Principles Check
The plan follows systemPatterns' module shape, P1/P2/P3/P5/P7, default-deny routes, the canonical lock order, and "no DB mocking". There is one documented deviation: the lifecycle includes PUBLISHED → COMPLETED in the DB matrix, but this feature never performs it (C-BIL-1). That is an ownership split, not a principle deviation.

### Risk Assessment
| Risk | L | I | Mitigation |
|---|---|---|---|
| Auto-enrol gap between this merge and registration's merge (conflict 1) | H | M | Creative B3 decides backfill, held rollout or pending marker. Production materialisation can be gated by env until registration ships |
| Registration's contracts change again before its build | M | M | AC-INTEGRATION-1 test file is the shared contract; registration's build gate re-reads this feature as merged |
| Lock-order deadlock between rule edits, materialiser and instance edits | M | H | Creative B2 fixes the order; the AC-VERIFY-3 race matrix uses real connections |
| Series-edit propagation surprises admins (A3/A4) | M | M | Creative rulings, counts shown on save (AC-HAPPY-7), E2E covers the edited-instance case |
| Fee edits reprice registrations (conflict 10) | M | H | Creative ruling before Phase 2 build; default is to refuse fee edits when active registrations exist |
| DST input options not storable (conflict 6) | L | M | Offer only representable options unless creative adds a column |
| Numbering collision with registration | L | L | ADR 0019 and D-70+ (resolved); re-check at the build gate |

## Test Strategy

### Approach
- **Emphasis**: balanced, weighted to integration. The core risks (DB invariants, gate-before-lock, idempotent materialisation, lock order, contract outputs) can only be proven against real PostgreSQL. Pure logic (recurrence dates, costing, transitions) is unit-tested from tables. One Playwright journey covers the admin flow.
- **Target test count**: about 105 across all phases. That is above the 20 default because there are 37 ACs, eight of them structural (schema round-trip, race matrix, contract checks), three pricing models and three recurrence frequencies. The count is in line with skill-levels-and-auto-enroll and registration-and-waitlist.

### File Organization
- **New test files**:
  - `packages/shared/src/sessions/recurrence.test.ts`: date generation tables (AC-VERIFY-4).
  - `packages/shared/src/sessions/costing.test.ts`: suggested-rate vectors and fee defaults (AC-HAPPY-2, AC-HAPPY-3, AC-VERIFY-5).
  - `packages/shared/src/api/sessions.test.ts`: strict zod contracts and field errors (AC-ERROR-2).
  - `apps/api/src/modules/sessions/transitions.test.ts`: TS matrix against the shared fixture (AC-ERROR-6).
  - `apps/api/src/modules/sessions/errors.test.ts`: error-code mapping.
  - `apps/api/test/integration/sessions-schema.int.test.ts`: migration round trip, CHECKs, triggers, immutability (AC-VERIFY-1, AC-ERROR-4/5/6 DB half).
  - `apps/api/test/integration/sessions-api.int.test.ts`: routes, policies, publish and banking refusal, capacity edit, cancel, stale save, DST refusal (AC-HAPPY-1..4, 8, 9, 11; AC-ERROR-1..5, 7, 8).
  - `apps/api/test/integration/sessions-job.int.test.ts`: materialiser idempotency, gate drafts, email, retry, auto-enrol via recording port (AC-ASYNC-1..4, AC-ERROR-9, AC-HAPPY-5..7, 10).
  - `apps/api/test/integration/sessions-races.int.test.ts`: race matrix with `lock-waiters.ts` (AC-VERIFY-3).
  - `apps/api/test/integration/sessions-contracts.int.test.ts`: C-SSE-1..5 and C-SAE outputs (AC-INTEGRATION-1, AC-INTEGRATION-2, AC-VERIFY-2).
  - `apps/api/test/integration/sessions-logs.int.test.ts`: logged fields (AC-VERIFY-6).
  - `apps/web/src/lib/teams/sessions-view.test.ts` and `sessions-actions.test.ts`: view-model and action mapping.
  - `apps/web/src/components/teams/sessions-components.test.tsx`: court table, costing and pricing fieldsets.
  - `apps/web/e2e/sessions.spec.ts`: the journey and axe scans (AC-INTEGRATION-3, AC-VERIFY-8).
- **Extend existing**:
  - `apps/web/src/lib/teams/manage-areas.test.ts`: new area (AC-ENTRY-1).
  - `apps/api/src/jobs/schedules.test.ts` and `registry.test.ts`: handler wired, no placeholder.
  - `apps/api/test/integration/db-codegen.int.test.ts` and `enum-parity.int.test.ts`: drift, if enums change.
  - `apps/api/test/helpers/factories.ts`: session, series and court factories.
  - New helper `apps/api/test/helpers/sessions-scene.ts`, plus a recording allocator double in the same file.

### What NOT to Test
- `types.generated.ts`: checked by tsc and the codegen drift test.
- The publish gate's own rules and `isPaidSession`: covered by `team-banking-gate.int.test.ts`. Here we only test that every path calls the gate first.
- `selectAutoEnrollees` selection semantics: covered by skill-levels tests. Here we only test call order and pass-through.
- `Money`/`time` primitives: covered by platform-foundation tests (vectors are reused, not re-proven).
- The real allocator, promotion and auto-enrol emails: registration-and-waitlist's.
- pg-boss internals and cron parsing: framework.

### Per-Phase Test Guidance
- Phase 1: about 24 tests.
  - Recurrence tables: Weekly, Fortnightly parity, Monthly per A1, `recur_until` inclusive, both DST weeks, TZ independence.
  - Costing vectors and `fee_other` default.
  - The transition matrix fixture in both TS and DB.
  - The migration round trip.
  - CHECKs for C-SSE-1 fees and immutability, including `session_courts` on COMPLETED.
  - Zod strictness.
- Phase 2: about 28 tests.
  - Create, edit and publish a one-off session (FLAT, BY_SEX, BY_SKILL).
  - Gate refusal returns 409 and leaves the draft unchanged.
  - Publish refused for incomplete pricing, no courts, or a past start.
  - Capacity raise calls `promoteWaitlist` once after the lock; a cut demotes nobody; refused after start.
  - Cancel leaves registrations.
  - Deadline default and moving default.
  - DST 422.
  - Stale save returns 409.
  - Every route returns 401/403 for every non-admin.
- Phase 3: about 26 tests.
  - Series create enqueues a run in the same tx; instances are created exactly once under re-run and concurrent run.
  - Gate-refused instances become DRAFT, with one email per rule per window.
  - Retry publishes drafts after banking is set up and skips edited drafts.
  - Auto-enrol is called once per published session with the R16 entries in order, and not for DRAFTs or re-runs.
  - Instance edit sets overridden; series edit skips edited, past and closed instances.
  - End series.
  - One failing instance does not stop the run.
- Phase 4: about 12 tests.
  - The race matrix rows of AC-VERIFY-3 (materialiser vs rule edit, vs instance edit, double run, publish vs banking removal in both orders, capacity edit vs registration stand-in).
  - Log-field assertions for every AC-VERIFY-6 event.
- Phase 5: about 12 tests.
  - Manage-area entry and nav; list grouping and empty states.
  - Court table bulk apply and override, with the live-region count.
  - Costing suggestion updates and editable rate; pricing reveal.
  - Banking refusal alert and `returnTo` link; read-only closed sessions.
- Phase 6: 1 Playwright journey (desktop and 360 px) with axe scans on three pages, plus the AC-INTEGRATION-1 contract header and the coverage-gate update.

## Implementation Roadmap

### New Source Files (pin path + extension)
- [ ] `db/migrations/<utc>_session_scheduling.sql`: C-SSE-1 fee CHECKs, lifecycle transition trigger, COMPLETED/CANCELLED immutability (incl. `session_courts`), gap columns from creative (rule anchor, rule court template, version stamps, `deadline_is_default`, court uniqueness, length CHECKs), ledger D-70 onwards
- [ ] `packages/shared/src/sessions/recurrence.ts`: pure `recurrenceDates(rule, window)`
- [ ] `packages/shared/src/sessions/costing.ts`: `suggestedRate`, `finalFlatRate`, `defaultFeeOther`
- [ ] `packages/shared/src/sessions/lifecycle-matrix.ts`: shared transition fixture used by TS and the DB test
- [ ] `packages/shared/src/sessions/index.ts`: barrel
- [ ] `packages/shared/src/api/sessions.ts`: zod request/response contracts and error codes
- [ ] `apps/api/src/modules/sessions/routes.ts`
- [ ] `apps/api/src/modules/sessions/service.ts`
- [ ] `apps/api/src/modules/sessions/repo.ts`
- [ ] `apps/api/src/modules/sessions/transitions.ts`: TS twin of the DB matrix
- [ ] `apps/api/src/modules/sessions/errors.ts`
- [ ] `apps/api/src/modules/sessions/allocator-port.ts`: `SessionAllocatorPort` plus a no-op default that logs
- [ ] `apps/api/src/modules/sessions/materialise.ts`: per-rule and per-instance materialisation, gate-draft retry, auto-enrol call
- [ ] `apps/api/src/jobs/recurrence-materialisation.ts`: job handler
- [ ] `apps/api/test/helpers/sessions-scene.ts`: scenes plus the recording allocator double
- [ ] `apps/web/src/lib/teams/sessions-view.ts`: list grouping, editor view model, "Ended" label
- [ ] `apps/web/src/lib/teams/sessions-actions.ts`: server actions and API error mapping
- [ ] `apps/web/src/app/teams/[teamId]/manage/sessions/page.tsx`
- [ ] `apps/web/src/app/teams/[teamId]/manage/sessions/new/page.tsx`
- [ ] `apps/web/src/app/teams/[teamId]/manage/sessions/[sessionId]/page.tsx`
- [ ] `apps/web/src/app/teams/[teamId]/manage/sessions/series/new/page.tsx`
- [ ] `apps/web/src/app/teams/[teamId]/manage/sessions/series/[ruleId]/page.tsx`
- [ ] `apps/web/src/components/teams/session-form.tsx`
- [ ] `apps/web/src/components/teams/series-form.tsx`
- [ ] `apps/web/src/components/teams/court-table.tsx`
- [ ] `apps/web/src/components/teams/costing-fieldset.tsx`
- [ ] `apps/web/src/components/teams/pricing-fieldset.tsx`
- [ ] `apps/web/src/components/teams/session-list.tsx`
- [ ] `docs/adr/0019-session-scheduling-engine.md`
- [ ] extend: `apps/api/src/app.ts` (register module, port dep), `apps/api/src/jobs/{registry,schedules,bootstrap}.ts`, `apps/api/src/lib/config/config.ts` (`RECURRENCE_HORIZON_DAYS`), `apps/api/src/lib/http/errors.ts` (new codes), `apps/api/src/lib/db/types.generated.ts` (regen), `packages/shared/src/index.ts`, `apps/web/src/lib/teams/manage-areas.ts`, `apps/api/test/helpers/factories.ts`, `db/schema-deviations.md`, `vitest.config.ts` (coverage include), `.env.example`, `docs/getting-started.md`, `memory-bank/systemPatterns.md` and `techContext.md` (Documentation agent)

### Phases
- [ ] **Phase 1: Schema and shared core.**
  - The migration (D-70+); types regen.
  - Pure `recurrence`, `costing` and lifecycle matrix; zod contracts; error codes; TS transitions.
  - ACs: AC-VERIFY-1, AC-VERIFY-4, AC-VERIFY-5, AC-ERROR-6, AC-HAPPY-2 (pure half), AC-ERROR-4/5 (DB half).
  - Gate: migrate, rollback, migrate is identical; tables pass.
- [ ] **Phase 2: One-off sessions API.**
  - Sessions module (routes, service, repo) and the allocator port with no-op default.
  - Create, edit, publish through the gate, cancel, capacity edit (C-SSE-3), deadline default, DST refusal, stale save, policies.
  - ACs: AC-HAPPY-1..4, 8, 9, 11; AC-ERROR-1 (API), 2, 3, 4, 5, 7, 8; AC-VERIFY-2 (manual path).
  - Gate: `sessions-api.int.test.ts` green; the gate precedes the lock structurally.
- [ ] **Phase 3: Series and materialiser.**
  - Series CRUD and end; series-edit propagation per A3/A4; instance overrides.
  - The `recurrence-materialisation` handler: horizon, per-instance tx, gate drafts, admin email, draft retry, auto-enrol through `selectAutoEnrollees` and the port; per-rule enqueue.
  - ACs: AC-HAPPY-5, 6, 7, 10; AC-ASYNC-1..4; AC-ERROR-9; AC-VERIFY-2 (job paths); AC-INTEGRATION-2.
  - Gate: re-runs create nothing; the recording double sees the R16 calls.
- [ ] **Phase 4: Concurrency and observability.**
  - Lock-order position for `recurring_session_rules` (B2); race matrix; log fields; contract test file for registration's build gate.
  - ACs: AC-VERIFY-3, AC-VERIFY-6, AC-INTEGRATION-1.
  - Gate: no `40P01`, every event asserted.
- [ ] **Phase 5: Admin web UI.**
  - Manage-area entry; list; one-off, instance and series editors; court table; costing and pricing fieldsets; banking refusal and `returnTo`; read-only closed sessions; "Ended" label.
  - ACs: AC-ENTRY-1, AC-ENTRY-2, UI halves of AC-HAPPY-1..11 and AC-ERROR-1..5, 7.
  - Gate: component tests green; manual walk at 360 px.
- [ ] **Phase 6: End-to-end journey, accessibility, ADR and docs (final phase: complete entry-to-success flow).**
  - `sessions.spec.ts` covers the full admin journey from the manage nav to a published series instance with banking hand-off, edited instance and cancel, plus axe scans.
  - ADR 0019 records every contract honoured and offered (port signature, route namespace, slot contract).
  - Coverage gate include; `.env.example` and getting-started docs.
  - ACs: AC-INTEGRATION-3, AC-VERIFY-7, AC-VERIFY-8.

**Build gate (before Phase 1)**: confirm creative rulings for conflicts 1-6, 8-10 and A1-A5/B1-B5/C1-C5 are recorded. Re-check free ADR and D numbers on `main` against registration's reservation. Re-read registration-and-waitlist's C-SSE/C-SAE text at its current branch tip.

## Creative Phases

- [ ] **Algorithm Design** (required): A1-A5 and conflicts 2, 3, 5, 6, 10. Covers the Monthly meaning, rule anchor, horizon and publish lead time, series-edit propagation and override granularity, day/frequency/end changes, DST representable options, fee-edit policy, rate details. Output: `memory-bank/creative/session-scheduling-engine-recurrence-algorithm.md`
- [ ] **Architecture Design** (required): B1-B5 and conflicts 1, 4, 8, 9. Covers materialiser shape and queueing, lock-order position of `recurring_session_rules`, the allocator port and the auto-enrol rollout gap, optimistic concurrency and replay safety, DB transition and immutability triggers with the TS twin, schema gap columns. Output: `memory-bank/creative/session-scheduling-engine-architecture.md`
- [ ] **User Journey Design** (required): C2, C3 and conflict 3 from the admin's view. Covers series-versus-instance editing, the first-materialisation wait, telling players about changes or cancellations, one-off auto-enrol. Output: `memory-bank/creative/session-scheduling-engine-admin-user-journey.md`
- [ ] **UI/UX Design** (required): C1, C4, C5. Covers the multi-court fast setup at desktop and 360 px, costing and pricing presentation, list grouping and "Ended" label, banking notice, read-only closed sessions. Output: `memory-bank/creative/session-scheduling-engine-uiux.md`

---

## Execution State

**Build Status**: RUNNING
**Current Phase**: CREATIVE
**Current Step**: Wave 2 (UI/UX) dispatched
**Step Started**: 2026-10-20
**Last Completed**: Wave 1 creative + binding reconciliation (2026-10-20)
**Can Resume**: YES

### Active Sub-Agents
- Algorithm Design: COMPLETE
- Architecture Design: COMPLETE
- User Journey Design: COMPLETE
- UI/UX Design: DISPATCHED, Started: 2026-10-20

### Completed Steps
- Step 0.1 - task provisioned on feature/session-scheduling-engine, linked to roadmap feature
- Step 3 - Spec Writer Agent (Opus) - COMPLETE; taxonomy lint CLEAN (37 ACs); human approved 2026-10-20
- Decision: conflict 7 (numbering) resolved by user - this feature takes ADR 0019 and ledger D-70 onwards
- Steps 4-6 - codebase analysis, implementation plan (6 phases), Test Strategy (~105 tests), creative phases flagged (Algorithm, Architecture, User Journey, UI/UX)
- Algorithm Creative Design: COMPLETE (2026-10-20) - Output: memory-bank/creative/session-scheduling-engine-recurrence-algorithm.md
- Architecture Creative Design: COMPLETE (2026-10-20) - Output: memory-bank/creative/session-scheduling-engine-architecture.md
- User Journey Creative Design: COMPLETE (2026-10-20) - Output: memory-bank/creative/session-scheduling-engine-admin-user-journey.md
- Binding reconciliation: COMPLETE (2026-10-20) - Output: memory-bank/creative/session-scheduling-engine-binding-reconciliation.md (user rulings P-1 auto-enrol all sessions, P-2 player notification deferred, P-3 series pattern fixed)
