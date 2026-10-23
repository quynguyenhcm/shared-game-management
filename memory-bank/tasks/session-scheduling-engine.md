---
slug: session-scheduling-engine
feature: session-scheduling-engine
status: COMPLETE
---

# session-scheduling-engine: Session Scheduling Engine

**Complexity**: Level 4
**Status**: COMPLETE
**Archived**: memory-bank/archive/session-scheduling-engine-archive.md
**Completed**: 2026-10-24
**Reflection**: memory-bank/reflection/session-scheduling-engine-reflection.md
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
**Primary Persona**: Team Admin (`TEAM_ADMIN` of one team, APPROVED). Goals: set up the club's regular multi-court nights once, cost them so fees cover court hire, change one night without breaking the series, and open sessions for registration without spreadsheets. Pain points: retyping the same session every week, per-court time differences (Courts 1-2 8-10am, Court 7 8-9am), working out a break-even rate by hand. Secondary: Player (`PLAYER`, APPROVED member), who never sees an admin surface here. A player on Auto Enroll is added to every session, one-off or series, when it is first published (P-1). This feature never emails players about a cancel or change; the admin is shown the registered count instead (P-2). Also two later features that consume this one's outputs: registration-and-waitlist (seat allocator, player session page) and wallet-and-akahu-billing (bills PUBLISHED sessions and moves them to COMPLETED).
**Creative Exploration Needed**: Complete (2026-10-20). Four design docs and a binding reconciliation settle every conflict and creative question the spec raised. See "Creative Exploration Needed" below for each ruling and where it is recorded.

*Note: the spec cites ADRs 0015 to 0017 on `main`, the registration-and-waitlist branch's creative docs and plan amendments R14 to R18 (commit b8da4b6, unmerged), the platform-foundation and team-banking-and-gst creative docs, and this feature's creative docs. Precedence when they disagree: `creative/session-scheduling-engine-binding-reconciliation.md` (BIND: user rulings P-1..P-3, orchestrator rulings T-1..T-16, the wave 2 acceptance, critique rulings T-17..T-20), then the amendment lists of `-recurrence-algorithm.md` (ALG), `-architecture.md` (ARCH), `-admin-user-journey.md` (UJ) and `-uiux.md` (UI). UI's final copy deck replaces earlier provisional copy. Contract IDs (C-SSE-n, C-SAE-n, C-SKL-1, C-GAME-1, C-ALL-1) are quoted as their owners named them, so they survive an ADR renumber.*

### Invocation Method

- **Location**: a new team-admin area **Sessions** at `/teams/[teamId]/manage/sessions`, added by appending one entry `{ id: 'sessions', label: 'Sessions', segment: 'sessions' }` to `MANAGE_AREAS` in `apps/web/src/lib/teams/manage-areas.ts`. The area nav (`apps/web/src/components/teams/manage-area-nav.tsx`) then shows "People · Banking and GST · Sessions" on every manage page. Ownership of this surface is fixed by registration-and-waitlist's page-ownership decision (`registration-and-waitlist-registration-user-journey.md` "Page ownership decision (Q5)"): admin session surfaces under `/teams/[teamId]/manage/sessions` belong to this feature; the player page `/teams/[teamId]/sessions/[sessionId]` and the "Upcoming sessions" list on `/teams/[teamId]` belong to registration-and-waitlist.
- **Pages** (all under the existing `apps/web/src/app/teams/[teamId]/manage/layout.tsx` shell; each renders `ManageAreaNav current="sessions"` inside `ManageProvider` only after its guard passes, like `manage/banking/page.tsx`; titles `"{Page} – {Team} – Shared Game Management"`, `robots: noindex`):

  | URL | Purpose |
  |---|---|
  | `/teams/[teamId]/manage/sessions` | Sessions list. H1 "Sessions for {team name}". Buttons "New session" and "New recurring series". One page-level banking notice under the buttons when banking-refused drafts exist. Sections (via `ManageSection`, 25 rows each with `SectionPager`): "Upcoming" (PUBLISHED, `phase` upcoming or started), "Drafts" (DRAFT with a future start), "Series" (every rule, newest first), "Past and cancelled" (`phase` ended, COMPLETED, CANCELLED, expired drafts) |
  | `/teams/[teamId]/manage/sessions/new` | One-off session form. Nothing is written until "Save draft" or "Save and publish" |
  | `/teams/[teamId]/manage/sessions/[sessionId]` | Session editor for a one-off session or one date of a series. Back link "Back to {series name}" on series dates, then the banner, H1 "{Location}, {Wed 4 Nov 2026}", the scope line, the status line, the form and, below a separator, "Cancel session". Buttons "Save draft" and "Save and publish" (draft) or "Save changes" (published). Started, ended, completed, cancelled and expired-draft sessions render a read-only summary (`dl` groups and a courts `<table>`, never disabled inputs) with a one-line reason |
  | `/teams/[teamId]/manage/sessions/series/new` | Series form, create mode. "Create series" opens a create confirm |
  | `/teams/[teamId]/manage/sessions/series/[ruleId]` | Series page, sessions first: heading, summary line, banking notice (S2b/S2r), "Sessions in this series" with one row per upcoming date ("Edit {Wed 4 Nov}"), the horizon line, a "Past and cancelled sessions in this series ({n})" disclosure, "Series details" with "Change series details", "Publish drafts now" (when banking is now set up and drafts remain) and, last, "End series". `?edit=details` switches to the form-first edit mode, where the sessions list is replaced by the effect line |

- **Element**:
  - Fieldset order in both forms: Details, Courts, Places, Costing, Pricing, Cancellation deadline (UI D2; Places comes before Costing because the suggestion divides by max players).
  - **Details**: "Location", "Address", "Date" (`type="date"`, one-off only). A series date shows its date as text with "To move this night, cancel it and create a one-off session."
  - **Courts** (`CourtTable`, UI D1): hint "Times are New Zealand time."; a defaults block "Number of courts" (applied on blur or Enter, never submits the form; announces "Court table has {n} courts." or "Removed {names}. {n} courts."), "Default start", "Default end" and "Apply to all courts" (announces "Times applied to {n} courts." in one polite live region per form); then one row per court with "Court name", "Start" and "End" (accessible names "{name} start", "{name} end") and a text button "Remove"; a "Not default" tag on rows whose times differ from the defaults; the summary line "{n} courts. {m} use the default times."; "Add court" appends the lowest unused "Court n". Rows are a four-column grid from 640 px and two-line cards below it, with no horizontal scroll at 360 px.
  - **Places**: "Max players" and "Reserved host seats". On a published session the hint "Lowering this won't remove anyone who's already in."
  - **Costing**: "Court hire (total)" (hint "Optional. Leave blank for a free session."), "Extra expenses" and the read-only suggestion line.
  - **Pricing**: a radio group "Flat rate / By sex / By skill level" (`OptionFieldset`) that reveals only the chosen model's inputs. Flat rate shows "Rate per player", which follows the suggestion until the admin types (then pinned) and shows "Use suggested rate" only while pinned. By sex shows "Male", "Female", "Other" ("Starts as the lower of the other two until you change it."); By skill shows "Beginner", "Intermediate", "Advanced"; both offer "Fill all with the suggested rate". When fees are locked (T-7) the radios become static text "Pricing: {model name}" with "Players have registered, so fees can only be lowered."
  - **Cancellation deadline** (`DeadlineFieldset`): a two-option group "Default: 48 hours before the first court starts" (readout "Currently {Mon 2 Nov, 8:00 am}.", sends `cancellationDeadline: null`, T-8) or "A specific date and time" (reveals "Date" and "Time"). The series form shows only "48 hours before the first court starts, for every session in the series."
  - **Repeats** (`PatternFieldset`, series form): "Repeats" (Weekly, Every 2 weeks, Monthly), "First session" (date) and "Repeat until (optional)". The weekday and the monthly ordinal are derived from the first date, never typed. A derived line ("Every Wednesday from 4 Nov 2026", "Every second Wednesday from …", "On the first Wednesday of each month from …"). Only when a Monthly first date is both the 4th and the last of its weekday: "Which one? 4th Wednesday / Last Wednesday". A 5th-weekday first date shows "{29 Nov 2026} is the 5th {Sunday}, so it repeats on the last {Sunday} of each month." After creation, Repeats and First session are read-only rows with "To change the day or how often it repeats, end this series and start a new one." (P-3), and "Repeat until" can only be extended or cleared ("You can extend or clear this date. To stop the series sooner, use End series.").
  - **DST choice** (`DstChoice`, T-10): buttons directly under a time field that failed with a gap or overlap (see AC-ERROR-3).
  - **Confirmations**: `InlineConfirm` gains `dismissLabel` and `children` and a presentational `ConfirmPanel` is extracted from it (UJ H13). Never `confirm()`, `<dialog>` or `beforeunload`. A Sessions confirm never shows a dismiss button named "Cancel":

    | Confirm | Trigger | Confirm button | Dismiss |
    |---|---|---|---|
    | Publish (in-form panel, paid only) | Save and publish | Publish session | Keep editing |
    | Create series (in-form panel) | Create series | Create series | Keep editing |
    | Cancel a draft | Cancel session | Cancel draft / Cancel this date | Keep draft |
    | Cancel a published session | Cancel session | Cancel session | Keep session |
    | End series | End series | End series | Keep series |

- **API** (new module `apps/api/src/modules/sessions/` registered in `buildApp` with `prefix: '/teams'`, every route `config: { policy: requireTeamRole('TEAM_ADMIN') }`, every repo query filtered by `team_id` from the path; shared strict zod contracts in `packages/shared/src/api/sessions.ts`):
  - `GET /teams/:teamId/sessions?view=upcoming|drafts|past&limit&cursor` (admin list, `no-store`, keyset paging with `next`). Returns `isPayoutConfigured`; each row carries `status`, `phase` (`upcoming | started | ended`, computed from the API clock), `draftReason` (`banking | edited | admin | null`), `isInstanceOverridden`, `recurringRuleId`, series name and the start/end range.
  - `POST /teams/:teamId/sessions` (create a one-off DRAFT; strict body; `createKey` UUID; a replay returns 200 with the existing row).
  - `GET /teams/:teamId/sessions/:sessionId` (adds `version`, `deadlineIsDefault`, `activeRegistrationCount`, `feesLocked` (`'raise_only_blocked'` or null)); `PUT /teams/:teamId/sessions/:sessionId`, `POST …/:sessionId/publish`, `POST …/:sessionId/cancel`, each with `expectedVersion`. Write responses carry `version`, `activeRegistrationCount`, `promoted` and `material` (whether a material field changed).
  - `GET|POST /teams/:teamId/session-series` (POST with `createKey`), `GET|PUT /teams/:teamId/session-series/:ruleId` (PUT with `expectedVersion`), `POST …/session-series/:ruleId/end` (`expectedVersion`, `lastDate`, `cancelPublished`), `POST …/session-series/:ruleId/publish-drafts` (202, enqueues the rule job; T-3). The series GET returns the rule, its derived description, instance rows with `seriesChangeEffect` (`will_update | edited | closed | has_registrations`) and `activeRegistrationCount`, `materialisation: { state: 'pending' | 'ready', since }`, `nextDate`/`nextDateAddedOn`, `bankingDrafts`/`editedDrafts`, `isPayoutConfigured` and `version`.
  - Reserved for registration-and-waitlist, never claimed here: `GET /teams/:teamId/sessions/upcoming` (MEMBER) and `/teams/:teamId/sessions/:sessionId/registration*`.
- **Jobs** (T-3, ARCH SA-1):
  - `recurrence-materialisation` (existing slot, `apps/api/src/jobs/schedules.ts`, cron `0 3 * * *` Pacific/Auckland, queue policy `exclusive`) gets a real sweep handler in place of `placeholderHandler`. It is also enqueued once at every worker boot. Operator path: `pnpm run jobs:trigger recurrence-materialisation`.
  - New queue `recurrence-rule` (`stately`, singletonKey `recurrence-rule:<ruleId>`): one per-rule materialisation run. Enqueued by the sweep, and in-transaction by rule create, edit and end and by "Publish drafts now". Operator path: `pnpm run jobs:trigger recurrence-rule '<json>'`.
  - New queue `session-auto-enrol` (`exclusive`, singletonKey `session-auto-enrol:<sessionId>`): the auto-enrol follow-up for API publishes and for pending sessions offered by the sweep.
- **Visibility**: the Sessions area and every page and route are TEAM_ADMIN only. A MEMBER, PENDING, BANNED or anonymous caller gets the `NoAccess` page (web) or 403 (API, same answer for an unknown team), matching `manage/banking/page.tsx`. Signed-out visits go through `requireUser(here)` to `/login?returnTo=...`; a 401 mid-session goes to `sessionExpiredUrl(here)`.
- **Navigation**: header "My teams" → `/teams` → team row → `/teams/[teamId]` → "Manage team" (`/teams/[teamId]/manage`) → area nav "Sessions" → `/teams/[teamId]/manage/sessions` → "New session" | "New recurring series" | a session or series row. Series page → "Edit {Wed 4 Nov}" → session editor → "Back to {series name}".
- **Confidence**: HIGH for location, navigation, page split and API paths (settled in UJ and ARCH, BIND T-3). MEDIUM for exact response field names until Phase 2 fixes the zod contracts.

### Success Criteria

- **User sees** (copy from the UI final copy deck; `{n}` takes a singular form when 1):
  - After "Save draft" on a new session: the editor at `/teams/[teamId]/manage/sessions/[sessionId]` with the banner "Draft saved." and the status "Draft. Members can't see it until you publish it."
  - After "Save and publish": "Session published. Members can now register." and the status "Published. Members can register. Members on Auto Enroll are being added." If the gate refuses: the alert (focused once) "Add your team's bank account details before publishing a paid session." (verbatim from `apps/api/src/lib/http/errors.ts`, code `payout_not_configured`), the line "Your changes are saved as a draft." and the link "Set up banking and GST" to `/teams/[teamId]/manage/banking?returnTo=<url-encoded editor path>` (ADR 0016 "Manual publish and the returnTo hand-off").
  - After creating a series: "Series created." and, while the first run is pending, "We're adding the sessions in this series. Refresh in a moment." with a "Refresh" link; then the instances listed (dated NZ format, labelled "Published", "Draft · bank account needed", "Draft · publishes overnight" or "Draft · Edited") and the horizon line "Sessions are added {28} days ahead. The next one, {Wed 9 Dec}, will be added on {Wed 11 Nov}."
  - After saving a series: "Series saved. {u} upcoming sessions updated. {e} edited sessions kept their own details." with skip lines for started or closed, deadline passed and fee locked.
  - After "Cancel session": "Session cancelled. No one had registered." or "Session cancelled. {n} players were registered. Let them know it's cancelled." ("Draft cancelled." for a draft).
  - After "End series": "Series ended. No new sessions will be added after {date}." plus "{c} sessions after that date were cancelled." and "{n} players were registered for them. Let them know." when they apply.
  - The suggestion line updates as costs or max players change: "Suggested rate: $12.00 per player. Court hire plus extras, divided by max players (18), rounded up to the next dollar."
  - A stale save: "This session changed since you opened it. Review the latest version and save again. Your unsaved changes were not kept." (T-12).
- **Verifiable at**: the Sessions list, editors and series page above; `GET /teams/:teamId/sessions/:sessionId` and `GET /teams/:teamId/session-series/:ruleId`; the database rows below; `pgboss.job` for the `recurrence-materialisation`, `recurrence-rule`, `session-auto-enrol` and `send-email` jobs; Mailpit for the admin "bank account needed" email; structured logs `session.*`.
- **Data persisted**:
  - `game_sessions` (existing, `db/migrations/20260929000600000_game_sessions_and_courts.sql`): `team_id`, `recurring_rule_id`, `is_instance_overridden`, `location`, `address`, `date`, `cancellation_deadline`, `max_players`, `reserved_seats`, `total_court_cost`, `extra_expenses`, `calculated_rate_per_player`, `custom_player_rate`, `pricing_structure`, the seven `fee_*` columns, `status`; `starts_at`/`ends_at` are trigger-derived (D-08) and never written by the app.
  - `session_courts` (existing): `session_id`, `court_identifier`, `start_time`, `end_time`.
  - `recurring_session_rules` (existing, `20260929000500000_recurring_session_rules.sql`): `frequency`, `day_of_week` (0 = Sunday), `default_*` columns (kept as the editor's bulk-fill values), pricing and `fee_*` columns, `recur_until`, `is_active`.
  - New schema, one reversible migration `db/migrations/20261020000100000_session_scheduling.sql` (T-15), ledger rows in `db/schema-deviations.md`:
    - D-70: `recurring_session_rules.starts_on date NOT NULL` (anchor and first date) and `monthly_week smallint` (NOT NULL iff MONTHLY, values 1-4 or -1), CHECKs for weekday equal to `day_of_week`, the monthly ordinal, and `recur_until >= starts_on`.
    - D-71: table `recurring_rule_courts` (position, `court_identifier`, `start_time`, `end_time`, unique per rule) plus a deferred "active rule has at least one court" check.
    - D-72: `version` and `updated_at` on `game_sessions` and `recurring_session_rules`, bumped by `sessions_bump_version`.
    - D-73: `create_key` with `UNIQUE (team_id, create_key)` on both tables.
    - D-74: `game_sessions.deadline_is_default` plus trigger `game_sessions_fill_default_deadline`.
    - D-75: `game_sessions_guard_update` (matrix, closed immutability, immutable `team_id` and rule-instance `date`; DELETE allowed only for DRAFT).
    - D-76: `session_courts_guard_closed`.
    - D-77: C-SSE-1 CHECKs `game_sessions_skill_fees_when_live` and `game_sessions_flat_fee_when_live`.
    - D-78: `UNIQUE (session_id, court_identifier)` and a trimmed-identifier CHECK.
    - D-79: location, address and amount CHECKs on both tables; rule capacity and fees-complete CHECKs.
    - D-80: `game_sessions.auto_enrol_required` (true for every session, P-1) and `auto_enrolled_at`, CHECK, index `idx_game_sessions_auto_enrol_pending`.
    - D-81: table `payout_notice_claims (rule_id, window_start, claimed_at, PRIMARY KEY (rule_id, window_start))` (T-18; supersedes ARCH's rule column).
    - D-82: `recurring_session_rules.materialised_version` and `materialised_at`.
    - D-83: dev/test row cleanup before the CHECKs (`NOT VALID` then `VALIDATE`).
    - D-84: reserved (publish lead time, not built).
    - D-85: function `game_session_has_active_registrations(p_session_id uuid)` and trigger `game_sessions_fee_raise_locked` (T-17).
  - `pgboss.job`: `recurrence-materialisation`, `recurrence-rule` and `session-auto-enrol` runs; `send-email` with `idempotencyKey = payout-missing:<ruleId>:<windowStart>:<recipientId>`, enqueued only when a `payout_notice_claims` row was newly claimed.
- **Observable within**: immediate for every admin write, including series-edit propagation to existing instances (one synchronous transaction, T-5). New series dates are async: visible within about 5 s (one 2 s poll plus the run); the daily sweep runs at 03:00 Pacific/Auckland and at every worker boot. Auto-enrol registrations appear once registration-and-waitlist injects an allocator with `enrols: true`; until then sessions stay pending and the first sweep after that deploy enrols them (D-80).

### Acceptance Criteria

#### AC-ENTRY-1: Team admins reach the Sessions area from the manage nav
**Priority**: MUST
**Given** an APPROVED `TEAM_ADMIN` of team T signed in on `/teams/T/manage`
**When** they look at the area nav and choose "Sessions"
**Then** the nav lists "People", "Banking and GST" and "Sessions" (from `MANAGE_AREAS`), "Sessions" opens `/teams/T/manage/sessions` with `aria-current="page"` on its link, and `manage-areas.test.ts` asserts the new entry renders the nav on the sessions page; a MEMBER, PENDING, BANNED or other-team user opening the same URL sees the `NoAccess` page and no session data, and an anonymous user is redirected to `/login?returnTo=%2Fteams%2FT%2Fmanage%2Fsessions`

#### AC-ENTRY-2: The Sessions list groups sessions by what they need and shows the create actions
**Priority**: MUST
**Given** team T is not payout-configured and has one PUBLISHED future session, one PUBLISHED session that has started, one admin DRAFT, one banking-refused materialiser DRAFT, one active series and one CANCELLED session
**When** the admin opens `/teams/T/manage/sessions`
**Then** they see H1 "Sessions for {team name}", the buttons "New session" and "New recurring series" and the hint "Members on Auto Enroll are added to every session when it's published."; the sections "Upcoming" (PUBLISHED with `phase` upcoming or started, soonest first; the started one labelled "Started"), "Drafts" (DRAFT with a future start, labelled "Draft", "Draft · bank account needed", "Draft · publishes overnight" or "Draft · Edited"), "Series" (newest first, status "Active", "Ended {date}" or "Adding sessions…" and "{n} upcoming") and "Past and cancelled" (`phase` ended, COMPLETED, CANCELLED and "Not published · date passed", most recent first); each session row shows date (NZ format), time range from earliest court start to latest court end, location, court count, status label and the tags "Edited" and "Series: {series name}", with one link per row on its first line; labels come from the API's `status`, `phase`, `draftReason`, `isInstanceOverridden` and `isPayoutConfigured`, never the browser clock; the bordered notice "Some sessions weren't published because your team's bank account isn't set up." with "Set up banking and GST" to `/teams/T/manage/banking?returnTo=%2Fteams%2FT%2Fmanage%2Fsessions` appears once, under the buttons; each section pages at 25 rows with `SectionPager` keyset cursors (`?upcoming=`, `?drafts=`, `?past=`); an empty section shows "No upcoming sessions. Published sessions appear here.", "No drafts.", "No recurring series yet." or "Nothing here yet."

#### AC-HAPPY-1: Admin sets up a multi-court one-off session with bulk times and per-court overrides
**Priority**: MUST
**Given** the admin is on `/teams/T/manage/sessions/new`
**When** they complete:
  1. Location "Rosedale Badminton Centre", address "12B John Glenn Avenue, Rosedale, Auckland 0632", a future date
  2. Number of courts 9, default start 08:00, default end 10:00, "Apply to all courts"
  3. Override Court 7 to 08:00-09:00 and Court 9 to 09:00-10:00 inline
  4. Max players 36, reserved host seats 2
  5. "Save draft"
**Then** "Apply to all courts" announced "Times applied to 9 courts.", Courts 7 and 9 show "Not default" and the summary reads "9 courts. 7 use the default times."; one `game_sessions` row exists with `status = 'DRAFT'`, `recurring_rule_id IS NULL`, `auto_enrol_required = true`, `deadline_is_default = true`, `version = 1` and the form's `create_key`, and nine `session_courts` rows with the entered identifiers and times; `starts_at`/`ends_at` equal the trigger-derived instants of 08:00 and 10:00 on that date; `cancellation_deadline` equals `starts_at − 48 h` (absolute), kept by `game_sessions_fill_default_deadline` and equal to `defaultCancellationDeadline(starts_at)` in `packages/shared/src/time/time.ts`; replaying the same POST with the same `createKey` returns 200 with the same row and creates nothing; the page redirects to `/teams/T/manage/sessions/<id>?notice=draft_saved` and shows "Draft saved." and "Draft. Members can't see it until you publish it."

#### AC-HAPPY-2: The suggested rate is computed exactly and the final rate follows it or is pinned
**Priority**: MUST
**Given** the admin is editing a session's Costing and Pricing fieldsets
**When** they enter court hire, extra expenses and max players, and either leave "Rate per player" alone or type a rate
**Then** the suggested rate equals `divideByInteger(add(courtCost, extraExpenses), BigInt(maxPlayers), 'CEIL', 'DOLLAR')` from `packages/shared/src/money/money.ts`, computed by `suggestedRate` in `packages/shared/src/sessions/costing.ts` and used by both the web form and the API (never `Math.ceil` or floats; P2), with the platform-foundation vectors ($120.00 + $12.00, 12 players → $11.00; $130.00 + $12.00, 12 → $12.00; $120.00 + $0, 14 → $9.00; $120.01 + $12.00, 12 → $12.00) and a blank "Court hire (total)" read as $0.00, so $0 + $0 for 20 players gives $0.00 (a free session); the line reads "Suggested rate: {$12.00} per player. Court hire plus extras, divided by max players ({18}), rounded up to the next dollar." ("Enter max players to see a suggested rate." until max players is set; "Reserved host seats aren't charged, so this rate won't quite cover the full cost." when reserved seats > 0); the server always stores it in `calculated_rate_per_player`; a FLAT rate that was never typed shows "Following the suggested rate. It changes when costs or max players change." and is stored as `custom_player_rate = NULL`; a typed rate shows "Custom rate. It won't change when costs change." with "Use suggested rate" (which sends `customPlayerRate: null`) and is stored in `custom_player_rate`, surviving reload; for every save of a FLAT session or rule, DRAFT or PUBLISHED, `fee_flat = custom_player_rate ?? calculated_rate_per_player` (T-9), held by CHECK `game_sessions_flat_fee_when_live` while PUBLISHED or COMPLETED (C-SSE-1)

#### AC-HAPPY-3: Admin prices a session FLAT, BY_SEX or BY_SKILL_LEVEL
**Priority**: MUST
**Given** a session or series editor
**When** the admin picks a pricing model and saves
**Then** FLAT stores `fee_flat` as in AC-HAPPY-2; BY_SEX stores `fee_male` and `fee_female` as entered and, when `feeOther` is omitted and the stored row was not already BY_SEX, `fee_other = min(fee_male, fee_female)` using the `Money` `min` primitive (`defaultFeeOther`; platform-foundation algorithm Q11, D-06); a saved `fee_other` is never overwritten by a later save; BY_SKILL_LEVEL stores `fee_beginner`, `fee_intermediate` and `fee_advanced`; in the form, the first reveal of By sex or By skill fills empty inputs from the current final rate and "Fill all with the suggested rate" fills them all, while `fee_other` shows the lower of male and female until edited (UI only; nothing tracks after save); fee columns of the other models are saved as NULL; every amount is a 2-dp money string at or above $0.00 (CHECK `game_sessions_amounts_non_negative`, D-79)

#### AC-HAPPY-4: Admin saves and publishes a draft through the publish gate
**Priority**: MUST
**Given** a DRAFT session of team T with at least one court, a future start and complete fees, and team T is payout-configured (or the session is free)
**When** the admin chooses "Save and publish" and, for a paid session, confirms "Publish session" in the panel "Publish this session? Members can register straight away, and each player is charged after the game: {fee summary}. Members on Auto Enroll will be added to it."
**Then** the action first saves the form (PUT with `expectedVersion`), then calls `POST …/publish` with the new `expectedVersion`; the publish transaction takes `teams FOR KEY SHARE`, calls `assertTeamCanPublishPaidSession` (`apps/api/src/modules/team-banking/publish-gate.ts`) before any `game_sessions` lock, re-checks the actor (`team_members FOR SHARE`), takes `SELECT … FROM game_sessions WHERE id = $1 FOR UPDATE`, requires the locked `version` to equal the one it gated (else 409 `session_stale`), reads the clock after the lock, sets `fee_flat` to the final FLAT rate (C-SSE-1) and sets `status = 'PUBLISHED'` with a guarded `UPDATE … WHERE status = 'DRAFT'` (ADR 0016 "Gate contract" points 1-3); because `auto_enrol_required` is true it enqueues one `session-auto-enrol` job (`singletonKey session-auto-enrol:<sessionId>`, trigger `publish`) in the same transaction (P-1, T-2); a replayed publish of a PUBLISHED session answers 200 and writes and enqueues nothing; a free session publishes with no confirm; `/new` offers "Save and publish" as create then publish; the editor shows "Session published. Members can now register." and "Published. Members can register. Members on Auto Enroll are being added."; `session.published` is logged with `teamId`, `sessionId`, `actorId`, `paid` and `autoEnrolQueued`

#### AC-HAPPY-5: Admin creates a recurring series and sees its instances
**Priority**: MUST
**Given** the admin is on `/teams/T/manage/sessions/series/new`
**When** they choose "Repeats" (Weekly, Every 2 weeks or Monthly), a "First session" date, an optional "Repeat until" date, the location and address, courts with bulk times and per-court overrides, places, costing and pricing, choose "Create series" and confirm "Create series" in the panel "Create this series? Sessions from {Wed 4 Nov} are added now and published for registration. Members on Auto Enroll are added to each one." (plus "Each player is charged after the game: {fee summary}." for a paid series and "Your team's bank account isn't set up, so the sessions will be saved as drafts until it is." when T is not payout-configured)
**Then** one `recurring_session_rules` row is stored with `starts_on` = the first date, `day_of_week` derived from it (0 = Sunday), `monthly_week` for Monthly (the 1st-4th weekday from `ceil(day/7)`, a 5th weekday stored as -1 "last", and the admin's choice when the date is both 4th and last), the court template in `recurring_rule_courts` and the series defaults (BY_SEX `fee_other` defaulted as in AC-HAPPY-3); one `recurrence-rule` job (`trigger: rule_created`) is enqueued in the same transaction (P5, T-3); a replay with the same `createKey` returns the existing rule and enqueues nothing; the page redirects to the series page with "Series created." and shows the waiting state (AC-ASYNC-6) while `materialised_version` is NULL or below `version`; within about 5 s the series page lists one instance per date from `recurrenceDates` inside `[today, today + RECURRENCE_HORIZON_DAYS]` (default 28) that is on or after `starts_on`, on or before `recur_until` (inclusive) and whose start is still in the future, each a `game_sessions` row with `recurring_rule_id` set, `is_instance_overridden = false`, courts copied from the template, `deadline_is_default = true` and `auto_enrol_required = true`, published as it is created unless the gate refuses (AC-ASYNC-3); Weekly gives every 7th day from `starts_on`, Every 2 weeks every 14th day from `starts_on`, Monthly the `monthly_week`-th (or last) weekday of each month; when no date is inside the horizon yet the page shows "No sessions yet. The first one, {Wed 6 Jan 2027}, will be added on {Wed 9 Dec 2026}."

#### AC-HAPPY-6: Admin edits one date without breaking the series
**Priority**: MUST
**Given** a series with at least three future instances
**When** the admin opens one instance from "Edit {Wed 4 Nov}" and changes any of its courts, times, places, costing, rates or deadline, then saves
**Then** before saving the editor shows "Back to {series name}" and the scope line "One date in {series name}. Changes here apply to {Wed 4 Nov} only. Once you save a change, this date is marked Edited and changes to the series won't overwrite it.", and the date is text, not an input; after saving, that instance's row and courts change, `is_instance_overridden` becomes true and the banner reads "Changes saved for {Wed 4 Nov}. This date is now marked Edited."; the other instances and the series row are unchanged; the series page and list mark it "Edited", and its scope line becomes "Edited. This date has its own details, so changes to {series name} don't apply to it."; a save that changes nothing leaves `is_instance_overridden` false, writes nothing and shows "Nothing to change."; publish and cancel never set the flag; later runs and series edits never overwrite it (AC-HAPPY-7); a request that changes a rule instance's `date` is refused (422, backed by `game_sessions_keys_immutable`)

#### AC-HAPPY-7: A series edit updates its unedited upcoming sessions in one transaction and reports counts
**Priority**: MUST
**Given** a series with a past instance, a COMPLETED or CANCELLED instance, an edited future instance, a PUBLISHED instance whose cancellation deadline has passed, a PUBLISHED instance with active registrations and two other unedited future instances (one DRAFT, one PUBLISHED), opened with "Change series details" (`?edit=details`)
**When** the admin changes the series defaults (times, courts, location, address, places, costing, pricing) and chooses "Save series"
**Then** before saving the form shows the effect line from the GET's per-instance `seriesChangeEffect`: "Your changes will apply to {u} upcoming sessions and to sessions added later. {e} edited sessions keep their own details. {r} published sessions have registered players, so fees on them can only be lowered. Started, past and cancelled sessions don't change."; the save is one transaction (T-5, ARCH SA-9): `teams FOR KEY SHARE`, the gate on the new fees when the change could make a PUBLISHED instance paid (before any `game_sessions` lock), the rule `FOR NO KEY UPDATE`, the `expectedVersion` check, the actor re-check, the rule and template update, then each target instance in `(date, id)` order under `FOR UPDATE` with the eligibility re-read under the lock, under the HTTP lock timeout of 2 s with whole-transaction retry on `40P01`/`55P03` (`tx.ts`), then one `recurrence-rule` job enqueued for new dates; targets are future DRAFT and PUBLISHED instances that are not overridden, and a PUBLISHED instance changes only while both its current and its new cancellation deadline are in the future; each target takes all of the change or none of it, compared against the current rule so a retried save changes nothing more; a public-capacity raise on a PUBLISHED instance calls `promoteWaitlist` once; edited, started, COMPLETED, CANCELLED and deadline-passed instances are byte-for-byte unchanged, and a PUBLISHED instance with active registrations whose fees would rise is skipped as `feeLocked` (T-7); the response is `{ updated, unchanged, skipped: { edited, started, closed, deadlinePassed, feeLocked }, version }` and the banner reads "Series saved. {u} upcoming sessions updated. {e} edited sessions kept their own details." with the skip lines "{n} sessions were left as they are because they have started or closed.", "{n} published sessions were left as they are because their cancellation deadline has passed." and "{n} published sessions kept their current fees because players have registered and fees can only be lowered."; when the gate refuses a free-to-paid change that would reach a PUBLISHED instance, the whole edit is refused with 409 `payout_not_configured`, nothing is saved and the form shows the verbatim alert, "Nothing was saved." and "Set up banking and GST" (DRAFT-only targets are updated without the gate); saving again with no change shows "Nothing to change."

#### AC-HAPPY-8: A capacity edit on a published session promotes the waitlist in the same transaction
**Priority**: MUST
**Given** a PUBLISHED session that has not started
**When** the admin raises `max_players` or lowers `reserved_seats` and saves
**Then** one transaction takes `teams FOR KEY SHARE`, the gate if the edit turns the session paid, the actor `team_members FOR SHARE`, then `SELECT … FROM game_sessions WHERE id = $1 FOR UPDATE`, the version check, the clock after the lock, the `UPDATE`, then calls `promoteWaitlist({ trx, now, log }, { teamId, sessionId })` on the allocator port exactly once when public capacity (`max_players − reserved_seats`) rose (C-SSE-3, C-SSE-5); a cut is saved and demotes nobody, and the editor hints "Lowering this won't remove anyone who's already in."; the session lock is held only for this edit (C-SSE-5); `reserved_seats` stays within `0..max_players` (existing CHECK); when the port reports promotions the banner adds "{k} players moved off the waitlist."

#### AC-HAPPY-9: Admin cancels a session, its registrations are left as they are, and the admin is told the registered count
**Priority**: MUST
**Given** a DRAFT session, or a PUBLISHED session that has not started
**When** the admin chooses "Cancel session" and confirms in the InlineConfirm
**Then** the prompt is "Cancel this draft? It won't be published, and you can't undo this." ("Cancel draft" / "Keep draft"), "Cancel {Wed 4 Nov}? The series won't add this date again, and you can't undo this." ("Cancel this date" / "Keep draft"), "Cancel this session? No one has registered yet. You can't undo this." or "Cancel this session? {n} players are registered. We won't email them, so let them know. No one is charged for it. You can't undo this." ("Cancel session" / "Keep session"); `status` becomes `CANCELLED` through a guarded `UPDATE` under the session `FOR UPDATE` lock with `expectedVersion`; no `registrations` row changes and no allocator call or email is made (C-SSE-4, P-2); a cancelled series instance keeps its row, so its `(recurring_rule_id, date)` key stops the materialiser from recreating it (`uq_game_sessions_rule_date`); the editor reloads read-only with "Draft cancelled.", "Session cancelled. No one had registered." or "Session cancelled. {n} players were registered. Let them know it's cancelled.", the count read after the session lock; `session.cancelled` is logged with `fromStatus`

#### AC-HAPPY-10: Admin ends a series
**Priority**: MUST
**Given** an active series with, after a chosen last date, two unedited DRAFT instances, one edited DRAFT and three PUBLISHED instances with registered players
**When** the admin chooses "End series", picks "Last date" (default today) and confirms "End series"
**Then** the confirm "End this series? No sessions will be added after the last date." shows a polite status that updates on the date's `change` event: "{d} unedited draft sessions after this date will be deleted." and "{e} edited drafts and {p} published sessions after this date will be kept.", and an unticked checkbox "Also cancel the {p} published sessions after this date"; ticked, the status reads "…and the {p} published sessions will be cancelled." plus "{n} players are registered for them. We won't email them, so let them know."; on confirm (with `expectedVersion`) `recur_until` is set to the last date, `is_active` becomes false when that date is today or earlier, unedited DRAFTs after it are deleted, edited DRAFTs and PUBLISHED sessions are kept unless the box was ticked, in which case each PUBLISHED one is cancelled under the cancel rules (AC-HAPPY-9), and one `recurrence-rule` job (`rule_ended`) is enqueued; instances on or before the last date are untouched and no later run materialises after it; the banner reads "Series ended. No new sessions will be added after {date}." plus "{c} sessions after that date were cancelled." and "{n} players were registered for them. Let them know." when they apply; End series is one transaction (T-6), so a failed cancel rolls back the whole end and there is no partial-failure banner (amended at archive 2026-10-24); the series row shows "Ended {date}" and the page "Ended. Last session {date}. To run it again, create a new series." (T-6)

#### AC-HAPPY-11: The cancellation deadline defaults to 48 hours before start, is kept by the DB, and can be set
**Priority**: MUST
**Given** a session editor
**When** the admin leaves "Default: 48 hours before the first court starts" selected, or chooses "A specific date and time" and enters one, and saves
**Then** the default sends `cancellationDeadline: null`, stores `deadline_is_default = true`, and `game_sessions_fill_default_deadline` keeps `cancellation_deadline = starts_at − 48 h` absolute (`CANCELLATION_DEADLINE_DEFAULT_HOURS`) whenever courts or the date move the start, with the readout "Currently {Mon 2 Nov, 8:00 am}."; a specific value is converted with `DST_POLICY.USER_INPUT`, stores `deadline_is_default = false` and is kept as entered while `cancellation_deadline <= starts_at` holds (existing CHECK `game_sessions_deadline_before_start`); a later start move that breaks the CHECK is refused with 422 "The deadline must be before the first court starts." (AC-ERROR-2) (T-8)

#### AC-HAPPY-12: Every session gets its Auto Enroll members once, on its first publish, whatever publishes it
**Priority**: MUST
**Given** team T has members on Auto Enroll, a one-off DRAFT session O, a banking-refused series DRAFT S1 (banking since set up), an edited series DRAFT S2, and a recording allocator double with `enrols: true`
**When** the admin publishes O, S1 and S2 from their editors
**Then** each publish enqueues exactly one `session-auto-enrol` job in its publish transaction; each job runs `runSessionAutoEnrol` (AC-ASYNC-2) and the double receives exactly one `autoEnrolInSession` call per session with `entries` equal to `selectAutoEnrollees(db, { teamId, sessionDate: date })` in order, and `auto_enrolled_at` is stamped; a second publish attempt, a later materialiser run or the sweep makes no further call; the publish confirm of all three contains "Members on Auto Enroll will be added to it."; O's scope line reads "One-off session. When you publish it, members on Auto Enroll are added to it."; a CANCELLED or still-DRAFT session is never auto-enrolled; a series edit that updates already-published dates triggers no auto-enrol (P-1; extends ADR 0017 point 6, recorded in ADR 0019)

#### AC-HAPPY-13: The admin sees how many players are registered when changing or cancelling a published session
**Priority**: MUST
**Given** a PUBLISHED, not-started session with `n` active registrations (CONFIRMED or WAITLISTED stand-in rows), and separately one with none
**When** the admin opens its editor, then saves a material change (date of a one-off, earliest court start, latest court end, location, address, cancellation deadline or fees), saves a non-material change (courts inside the same time range, max players or host seats), or cancels it
**Then** the status line shows "No one has registered yet." or "{n} players are registered." ("1 player is registered."), and with `n > 0` the line above "Save changes" reads "{n} players are registered. We don't email them about changes, so let them know if you change the date, times, place, cancellation deadline or fees."; a material save shows "Changes saved. No one had registered." or "Changes saved. {n} players were registered. Let them know about the change."; a non-material save shows "Changes saved."; cancel follows AC-HAPPY-9; the count comes from the D-85 predicate's count variant read after the session lock and returned in the write response (`activeRegistrationCount`, `material`); no `send-email` job is enqueued for players, no notifier port exists, and no `registrations` row changes (P-2, C-SSE-4)

#### AC-HAPPY-14: The banking hand-off returns to the page it started from
**Priority**: MUST
**Given** a banking refusal shown on the session editor (AC-ERROR-1), on the series page (S2b notice) or on the Sessions list (page-level notice)
**When** the admin follows "Set up banking and GST", saves banking and chooses "Back to your session"
**Then** the link's `returnTo` is that page's own path (`/teams/T/manage/sessions/<id>`, `/teams/T/manage/sessions/series/<ruleId>` or `/teams/T/manage/sessions`), accepted by `bankingReturnTo`; they land back on that page; on the editor "Save and publish" now succeeds; on the series page the S2r notice "Your bank account is set up. {n} sessions in this series are still drafts. They'll be published automatically overnight, or you can publish them now." and "Publish drafts now" are shown, and unedited banking drafts are labelled "Draft · publishes overnight"

#### AC-HAPPY-15: Leaving and returning never loses saved work or the series' waiting state
**Priority**: SHOULD
**Given** the admin saved a draft, or created a series that is still materialising
**When** they open another manage area and come back through the area nav and the list
**Then** the draft opens from "Drafts" exactly as saved, and the series page shows its current state (waiting or listed); unsaved typed values are not kept, and no native "leave page?" dialog appears

#### AC-ASYNC-1: The materialiser creates each series date once and only once
**Priority**: MUST
**Given** active series whose `recur_until` is NULL or not yet passed
**When** the `recurrence-materialisation` sweep runs (03:00 daily, once at every worker boot, or `jobs:trigger`) or a `recurrence-rule` job runs (rule create, edit or end, "Publish drafts now", or `jobs:trigger recurrence-rule '<json>'`), including twice in a row, concurrently, or while a rule edit commits during a run
**Then** the sweep only enumerates active rules in keyset pages of 500 and enqueues one `recurrence-rule` job per rule (`stately`, `singletonKey recurrence-rule:<ruleId>`, so an edit during an active run queues exactly one trailing run that reads the latest rule) and one `session-auto-enrol` job per pending session (AC-ASYNC-5); each per-rule job reads `runNow` once, sets `today` to its NZ date and the window to `[today, today + RECURRENCE_HORIZON_DAYS]` inclusive (`intInRange(7, 91, 28)`), and runs one transaction per missing date: `teams FOR KEY SHARE`, the rule re-read `FOR NO KEY UPDATE` (skip if inactive, ended, or the date is no longer generated), `checkTeamCanPublishPaidSession` before any `game_sessions` lock, `INSERT … status 'DRAFT', auto_enrol_required true, deadline_is_default true … ON CONFLICT (recurring_rule_id, date) DO NOTHING RETURNING id`, courts copied from `recurring_rule_courts`, the clock read after the locks (a date whose start has passed is not published), then publish by guarded `UPDATE … WHERE status = 'DRAFT'` when the gate allows (never `INSERT … 'PUBLISHED'`; ADR 0016 recurrence contract point 1); a re-run creates nothing; a template court time in a DST gap is stored as the real wall time (02:30 becomes 03:30 on 2026-09-27) and an overlap time is stored unchanged and resolves earlier (`DST_POLICY.DERIVED`), so a DST date never fails the job; after the run the rule's `materialised_version`/`materialised_at` are stamped (D-82); the sweep logs `session.recurrence.sweep_completed` with `rulesScanned`, `rulesEnqueued`, `pendingAutoEnrolEnqueued`, `durationMs`, and each rule job logs `session.recurrence.run_completed` with `teamId`, `ruleId`, `trigger`, `windowStart`, `created`, `published`, `savedAsDraft`, `draftsRetried`, `autoEnrolled`, `failed`, `durationMs`

#### AC-ASYNC-2: Auto-enrol runs in a serialised follow-up transaction after each publish
**Priority**: MUST
**Given** team T has members with Auto Enroll on (some with `auto_enroll_until` before, on and after the instance date) and the materialiser has just committed a PUBLISHED instance of T's series
**When** the materialiser runs the inline follow-up `runSessionAutoEnrol`
**Then** it runs in a new transaction that holds no rule or session lock when it starts (T-2); its first statement is `pg_advisory_xact_lock(<sessions-auto-enrol namespace from locks.ts>, hashtext(session_id))`, before any row lock (T-19); after the lock it re-reads `auto_enrol_required`, `auto_enrolled_at`, `status` and `starts_at` and returns when the session is already stamped, not PUBLISHED, not required or started; it calls `selectAutoEnrollees(db, { teamId, sessionDate: game_sessions.date })` (ADR 0017 C-SKL-1 point 1) and passes the result, in the returned order, to `allocator.autoEnrolInSession(ctx, { teamId, sessionId, entries })` with entries `{ userId, assignedAt, membershipId? }` (registration-and-waitlist R16, which supersedes C-SAE-1's `userIds`; no guests; never a direct `registrations` write, C-SAE-1/2); it never calls the allocator with empty `entries` (with a real allocator and no one selected it only stamps); it stamps `auto_enrolled_at` in the same transaction as the allocator call, and only when `allocator.enrols === true`; per-member refusals (`overdue_payments`, `forbidden`, `already_registered`, `auto_enroll_changed` and the rest of `AutoEnrolSkipReason`) are counted skips; a thrown error rolls the follow-up back, logs `session.auto_enrol.failed` and leaves the marker pending while the run continues; with the no-op port it logs `session.auto_enrol.port_noop` with `teamId`, `sessionId`, `candidates` and the marker stays pending; otherwise it logs `session.auto_enrol.completed` with `allocator`, `candidates`, `confirmed`, `waitlisted`, `skipped`

#### AC-ASYNC-3: A paid instance blocked by missing banking is saved as a draft and the admins are emailed at most once a week per series
**Priority**: MUST
**Given** team T is not payout-configured and its series is paid
**When** the materialiser runs
**Then** each new paid instance is checked with `checkTeamCanPublishPaidSession` before any `game_sessions` lock, and on refusal is inserted as DRAFT, not skipped; this is not a job failure; `session.recurrence.publish_refused` is logged with `teamId`, `ruleId`, `sessionId`, `reason`; in the same transaction `INSERT INTO payout_notice_claims (rule_id, window_start) … ON CONFLICT DO NOTHING RETURNING` claims the window, where `windowStart` is the Monday of the run's NZ week (a run on 2026-10-20 gives `2026-10-19`; T-4, T-18), and only when a row comes back is a `send-email` enqueued to every approved admin with `idempotencyKey = payout-missing:<ruleId>:<windowStart>:<recipientId>` (one key per recipient; the claim row stays one per rule per NZ week — amended at archive 2026-10-24), subject "Sessions not published for {team name}: bank account needed", links to `/teams/T/manage/banking` and the series page, and no amounts, bank values or member names; the rule row is never updated by the claim; a second run in the same NZ week sends nothing and a run in the next week sends one; the series page shows "{n} sessions in this series were saved as drafts because your team's bank account isn't set up. Members can't register for them yet." with "Set up banking and GST" (`returnTo` = the series page), and those rows are labelled "Draft · bank account needed" (ADR 0016 recurrence contract points 1, 2, 4, 5)

#### AC-ASYNC-4: Materialiser drafts are published on a later run once banking is set up
**Priority**: MUST
**Given** DRAFT instances created by the materialiser after a gate refusal (`is_instance_overridden = false`), still in the future and inside the horizon, and the admin has since set up banking
**When** the next per-rule run happens (daily sweep, rule edit or "Publish drafts now")
**Then** each such draft is published through the gate: unlocked read of fees and `version`, then a transaction with the gate, session `FOR UPDATE`, `version` unchanged, still DRAFT and not overridden, `starts_at > now` read after the lock, and a guarded `UPDATE … SET status = 'PUBLISHED' WHERE status = 'DRAFT' AND NOT is_instance_overridden`; auto-enrol for it runs in a follow-up transaction (AC-ASYNC-2); drafts an admin has edited are left alone and labelled "Draft · Edited", whose editor says "This date has been edited, so it won't be published automatically. Publish it when it's ready." (ADR 0016 recurrence contract point 6); a refusal on retry is logged and claims no second email in the same week

#### AC-ASYNC-5: Pending auto-enrol is reconciled by the sweep and runs exactly once per session
**Priority**: MUST
**Given** PUBLISHED future sessions with `auto_enrol_required = true` and `auto_enrolled_at IS NULL` (because the no-op port ran during the rollout gap, or a follow-up failed)
**When** the sweep runs (03:00, every worker boot, or `jobs:trigger`), possibly at the same moment as an inline materialiser follow-up and a replayed `session-auto-enrol` job for the same session
**Then** one `session-auto-enrol` job is enqueued per pending session (keyset pages of 500 on `idx_game_sessions_auto_enrol_pending`); past, CANCELLED or already stamped sessions are not offered; with an `enrols: true` allocator each pending session is enrolled once and stamped; the inline follow-up, the sweep job and the replayed job serialise on the advisory lock (T-19), so the recording double receives exactly one `autoEnrolInSession` call and the session one stamp; for a session whose enrolment was deferred, selection happens when enrolment first runs, a bounded exception to ADR 0017 point 7 recorded in ADR 0019 (ARCH SA-5)

#### AC-ASYNC-6: The admin sees a new series' sessions arrive, or knows why they haven't
**Priority**: MUST
**Given** the admin has just created or changed a series
**When** the series page loads before the per-rule run has completed
**Then** the API reports `materialisation.state = 'pending'` while `materialised_version` is NULL or below `version`, and the sessions region shows `role="status"` "We're adding the sessions in this series. Refresh in a moment." with a plain "Refresh" link to the same URL; with JavaScript, `RefreshWhilePending` refreshes the page at about 2 s, 5 s and 10 s and no more, without moving focus, and announces "{n} sessions added." politely when the state becomes ready; if still pending after the last refresh it shows "This is taking longer than usual. Your series is saved and its sessions will appear here. Refresh in a minute." and stops; the list's series row shows "Adding sessions…" meanwhile

#### AC-ASYNC-7: "Publish drafts now" retries banking-refused drafts on demand
**Priority**: SHOULD
**Given** a series with unedited banking-refused DRAFT dates in the future and an edited DRAFT date, after the team has set up banking
**When** the admin opens the series page and chooses "Publish drafts now"
**Then** the page first shows the S2r notice with "{e} edited drafts need you to publish them yourself."; `POST /teams/T/session-series/<ruleId>/publish-drafts` enqueues one `recurrence-rule` job (`trigger: manual`) and answers 202, and a double click leaves one queued job (`stately`); the page shows "We're publishing the drafts in this series. Refresh in a moment." with the bounded refresh; after the run the unedited drafts are PUBLISHED through the gate with auto-enrol (AC-ASYNC-4) and the edited draft stays DRAFT, labelled "Draft · Edited"

#### AC-ERROR-1: A refused manual publish keeps the draft and hands off to banking and back
**Priority**: MUST
**Given** a paid DRAFT session and team T without usable payout details
**When** the admin chooses "Save and publish" and confirms "Publish session"
**Then** the save part commits; the publish answers 409 `payout_not_configured` and nothing else about the session changes; the editor shows the API message "Add your team's bank account details before publishing a paid session." verbatim in an alert region focused once, the line "Your changes are saved as a draft." and "Set up banking and GST" linking to `/teams/T/manage/banking?returnTo=%2Fteams%2FT%2Fmanage%2Fsessions%2F<sessionId>`; the banking page accepts that `returnTo` and after saving shows "Back to your session", which returns to the editor where "Save and publish" now succeeds (ADR 0016 manual publish points 1-5; AC-HAPPY-14)

#### AC-ERROR-2: Invalid session or series input is refused field by field and nothing is saved
**Priority**: MUST
**Given** a session or series editor
**When** the admin submits any of: a court whose end is not after its start or that crosses midnight, a blank or duplicate court name, no court, `max_players` below 1, `reserved_seats` below 0 or above `max_players`, a blank or over-long location (over 255) or address (over 500), a negative or more-than-2-dp amount, a deadline after the start, a session date in the past, a series `recur_until` before `starts_on`, a `starts_on` that does not match the weekday or monthly ordinal (`RecurrenceRuleError`), a series template court wholly between 02:00 and 03:00, or an unknown field
**Then** the API answers 422 `validation_failed` with `fieldErrors` keyed by field (strict zod, shared schema), the database is unchanged, the form keeps every value, focus moves to the error summary, and each field shows its message ("End must be after start.", "Court names must be different.", "Enter a court name.", "Add at least one court.", "Enter an amount like 12.00.", "Amount can't be negative.", "The deadline must be before the first court starts.", and for the 02:00-03:00 template "A court that runs only between 2 and 3 am can't be set up as a series, because that hour is skipped when clocks go forward. Choose different times."); the same rules are enforced by DB CHECKs (P1: D-70, D-71, D-78, D-79 and the existing ones), so a raw-SQL write fails with 23514

#### AC-ERROR-3: A court or deadline time that does not exist or happens twice on a DST day is refused with representable options
**Priority**: MUST
**Given** a session date of 2026-09-27 (DST starts) or 2027-04-04 (DST ends)
**When** the admin enters a court start of 02:30, or an explicit cancellation deadline at 02:30, on either date
**Then** the API answers 422 `validation_failed` with `fieldErrors` `local_time_nonexistent` or `local_time_ambiguous` and a `dstOptions` list of `{ field, date, time, kind, options: [{ choice, localTime, instant }] }`, and nothing is saved (`DST_POLICY.USER_INPUT` = `reject`; T-10); for the gap the message reads "2:30 am doesn't happen on Sun 27 Sep 2026, because clocks go forward an hour at 2 am." with buttons "Use 3:30 am" and "Use 1:30 am", and the client resubmits the chosen real time; for a court time in the overlap the message reads "2:30 am happens twice on Sun 4 Apr 2027, because clocks go back an hour at 3 am. We'll use the first one." with one button "Use the first 2:30 am (NZDT)", resubmitted with a transient `startDisambiguation`/`endDisambiguation: 'earlier'` that is never stored; a deadline in the overlap offers "Use the first 2:30 am (NZDT)" and "Use the second 2:30 am (NZST)", both stored as given; each choice announces its result politely and returns focus to the input; NZDT/NZST comes from the option's instant offset; no stored disambiguation column is added and D-08 is unchanged

#### AC-ERROR-4: Publishing a session with incomplete pricing or no courts is refused
**Priority**: MUST
**Given** a DRAFT session that is `BY_SKILL_LEVEL` with a missing skill fee, or `FLAT` with no rate, or has no court, or whose start has passed
**When** the admin chooses "Save and publish"
**Then** the save part commits and the publish answers 422 `validation_failed` naming the missing field, shown with "Your other changes are saved as a draft." (or 409 `session_started` for a past start, after which the editor shows the read-only "This draft's start time passed before it was published, so it can't be published or changed."), and the session stays DRAFT; raw SQL setting such a session to PUBLISHED fails on `game_sessions_skill_fees_when_live` or `game_sessions_flat_fee_when_live` (D-77, C-SSE-1) or the existing `game_sessions_instants_when_live` (C-SSE-2)

#### AC-ERROR-5: Closed and started sessions refuse every edit and cancel
**Priority**: MUST
**Given** a COMPLETED, CANCELLED, or PUBLISHED-and-started session
**When** the admin tries to edit it, change its courts, change its capacity, publish it or cancel it
**Then** a PUBLISHED session after `starts_at` refuses every edit and cancel with 409 `session_started`, decided in TS by `decideSessionAction` with the clock read after the session lock (T-11; time-relative rules stay out of SQL); COMPLETED and CANCELLED sessions refuse every write with 409 `session_not_editable`, backed by `game_sessions_closed_immutable` (D-75) and `session_courts_closed_immutable` (D-76, any `session_courts` insert, update or delete; ADR 0017 C-GAME-1 point 3), both SQLSTATE 23000; only DRAFT rows can be deleted; a form posted across the boundary reloads the read-only view with the reason as a focused banner ("This session has started, so it can't be changed or cancelled." or "This session can't be changed any more.")

#### AC-ERROR-6: Illegal lifecycle transitions are impossible
**Priority**: MUST
**Given** any `game_sessions` row
**When** any writer (API, job or raw SQL) changes `status`
**Then** only `DRAFT → PUBLISHED`, `DRAFT → CANCELLED`, `PUBLISHED → CANCELLED` and `PUBLISHED → COMPLETED` are accepted; COMPLETED and CANCELLED are terminal; any other change fails with SQLSTATE 23000, constraint `game_sessions_status_transition` (P1), and `SESSION_TRANSITIONS` in `packages/shared/src/sessions/lifecycle.ts` with `decideSessionAction` in `apps/api/src/modules/sessions/transitions.ts` gives the API's 409 `session_state_conflict` on the normal path; both are checked against the hand-written fixture `apps/api/test/fixtures/session-transitions.ts` (16 `(from, to, allowed)` rows plus action × state × time rows); this feature never performs `PUBLISHED → COMPLETED`, which belongs to wallet-and-akahu-billing (C-BIL-1, ADR 0017 C-GAME-1 point 3)

#### AC-ERROR-7: A save based on a stale view is refused, not silently applied
**Priority**: MUST
**Given** a session or series open in the editor, changed afterwards by a co-admin, the materialiser or a series save
**When** the admin saves, publishes, cancels, saves the series or ends the series
**Then** every one of these writes carries `expectedVersion`; under the row lock a write that would change nothing answers 200 with the current row (no-op, safe to retry); otherwise a version mismatch answers 409 `session_stale` (or `series_stale`) with the current row and writes nothing, and `session.stale_refused` is logged with `expectedVersion` and `currentVersion`; the page redirects to itself with `?notice=session_stale` (or `series_stale`, keeping `edit=details`) and shows the focused error banner "This session changed since you opened it. Review the latest version and save again. Your unsaved changes were not kept." (or "This series changed since you opened it. …") with the latest values; `version` is bumped by `sessions_bump_version` on any content change by any writer (D-72; T-12)

#### AC-ERROR-8: Every sessions route refuses anyone who is not an admin of that team
**Priority**: MUST
**Given** each route of the sessions module
**When** it is called anonymously, by a MEMBER, by a PENDING or BANNED member, or by an admin of another team, or with an id that belongs to another team, or by an admin demoted or banned while their write waits
**Then** it answers 401 or 403 (and the same 403 for an unknown team), never reveals another team's session; inside every write transaction `assertSessionAdmin` re-reads the actor's `team_members` row `FOR SHARE` and a demoted or banned actor gets 403 `forbidden`; `buildApp` refuses to start if any route lacks a `config.policy` (default-deny, ADR 0013)

#### AC-ERROR-9: One bad instance never stops the materialiser
**Priority**: MUST
**Given** a run in which one instance fails (for example a 23514 `game_sessions_paid_requires_payout` reaching the materialiser, which means the gate was skipped, or a lock timeout)
**When** the run continues
**Then** only that instance's transaction rolls back; the error is logged as `session.recurrence.instance_failed` with `teamId`, `ruleId`, `date`, `sqlState`, `errorCode`, `transient` (never a field named `code`, never the message), at `error` when permanent and `warn` when transient; the run processes the remaining instances; after the loop the job throws a plain `Error` (pg-boss retries with backoff, idempotently) when any failure was transient (`40P01`, `55P03`, `40001`, class `08`, unknown) and `NonRetryableJobError` when every failure was permanent (23xxx, 22xxx) (ADR 0016 recurrence contract point 3; `job-queues-pgboss` learned rule; `classifySessionError`)

#### AC-ERROR-10: Fees can only go down once a published session has registered players
**Priority**: MUST
**Given** a PUBLISHED session for which `game_session_has_active_registrations(id)` is true (a `registrations` row with `status IN ('CONFIRMED','WAITLISTED')`)
**When** the admin changes its pricing model, raises any applicable fee (free to paid included; NULL counts as $0), or changes costing so that a FLAT rate following the suggestion would rise
**Then** the API answers 409 `session_fee_locked` naming the raised fields (`feeRaised` in `costing.ts`), checked under the session `FOR UPDATE` lock, and nothing is saved; a decrease is accepted; the editor shows the static "Pricing: {model name}", "Players have registered, so fees can only be lowered.", "This is higher than the current fee. Fees can only be lowered once players have registered." under a raised fee, and "Raising court hire or extras would raise a rate that follows the suggestion. Set a custom rate to keep the current fee." under costing; the GET reports `feesLocked: 'raise_only_blocked'`; raw SQL raising a fee on such a row fails 23514 `game_sessions_fee_raise_locked` (D-85; T-7, T-17)

#### AC-ERROR-11: Started, ended, closed and expired sessions are labelled and read-only with a reason
**Priority**: MUST
**Given** sessions that are PUBLISHED and started, PUBLISHED and ended, COMPLETED, CANCELLED, and DRAFT with a past start
**When** the admin opens the Sessions list and each editor
**Then** the API returns `phase` from its clock, and the list labels them "Started" (in Upcoming), "Ended", "Completed", "Cancelled" and "Not published · date passed" (in Past and cancelled); each editor renders `SessionSummary` (`dl` groups under "Details", "Courts", "Places", "Costing", "Pricing", "Cancellation deadline", courts as a three-column `<table>`; no inputs and no Save, Publish or Cancel) with the matching reason in a bordered block: "This session has started, so it can't be changed or cancelled.", "This session has ended, so it can't be changed.", "This session is complete, so it can't be changed.", "This session was cancelled, so it can't be changed." or "This draft's start time passed before it was published, so it can't be published or changed."

#### AC-ERROR-12: A series' pattern is fixed after creation and can only be shortened through End series
**Priority**: MUST
**Given** an existing series
**When** a PUT changes `frequency`, `day_of_week`, `monthly_week` or `starts_on`, or sets `recur_until` earlier than its saved value
**Then** a pattern change is refused with 422 `validation_failed`, field code `series_pattern_fixed`, and a shortened `recur_until` with 422 on `recurUntil` reading "To stop the series sooner, use End series."; nothing is saved; the edit form never offers these changes: Repeats and First session are read-only rows with "To change the day or how often it repeats, end this series and start a new one." and "Repeat until" has its `min` at the saved value (extend or clear only) (P-3, T-6)

#### AC-VERIFY-1: The schema migration adds the session invariants reversibly and is ledgered
**Priority**: MUST
**Given** the migration `db/migrations/20261020000100000_session_scheduling.sql`
**When** `schema.int.test.ts` and `sessions-schema.int.test.ts` run migrate, `rollback --all`, migrate
**Then** the schema is identical; `db/schema-deviations.md` has rows D-70..D-83 and D-85 with their objects and Source, and D-84 marked reserved; `apps/api/src/lib/db/types.generated.ts` matches codegen; an upgrade test seeded with every old dev-row shape passes the D-83 cleanup and the `NOT VALID`/`VALIDATE` CHECKs; `pg_trigger` names on `game_sessions` fire in the documented order `game_sessions_derive_instants` → `game_sessions_fee_raise_locked` → `game_sessions_fill_default_deadline` → `game_sessions_guard_update` → `game_sessions_paid_requires_payout` → `game_sessions_version_bump`; the `interval '48 hours'` literal equals `CANCELLATION_DEADLINE_DEFAULT_HOURS`; raw-SQL tests prove each new rule: the anchor weekday, monthly ordinal and `recur_until >= starts_on` CHECKs; an active rule without template courts fails at COMMIT; BY_SKILL_LEVEL PUBLISHED without all three skill fees and FLAT PUBLISHED without `fee_flat` equal to the final rate fail 23514; the rule fees-complete CHECK; the status matrix of AC-ERROR-6; COMPLETED/CANCELLED immutability including `session_courts`; DRAFT-only deletion; the version bump on content change and not on bookkeeping columns; `UNIQUE (team_id, create_key)`; a fee raise with an active registration fails 23514 `game_sessions_fee_raise_locked` while a decrease succeeds (T-17); `payout_notice_claims` refuses a second row for the same `(rule_id, window_start)` and cascades on rule delete (T-18)

#### AC-VERIFY-2: Every publish path goes through the gate before the session lock
**Priority**: MUST
**Given** the manual publish, the create-and-publish on `/new`, the materialiser's publish, the retry of materialiser drafts, an edit that turns a PUBLISHED session from free to paid, and a series edit that propagates a free-to-paid change onto PUBLISHED instances
**When** the integration suite runs each against a payout-configured team and an unconfigured team
**Then** the configured team publishes and the unconfigured team is refused (409 for the API with nothing saved for a series edit, DRAFT for the job) with no trigger error reaching the caller; a runtime query-order recorder (`apps/api/test/helpers/query-recorder.ts`, Kysely `log` hook) asserts on paid sessions that the gate's `select "is_payout_configured", "payout_blocked_at" from "teams" … for key share` precedes the first statement that locks or writes `game_sessions` or `session_courts` in each path, and on free sessions that no `game_sessions` write precedes the decision; after the session lock each API path requires the gated `version`, so the fees that were gated are the fees published (ADR 0016 gate contract points 1-2; ARCH SA-10); the paid rule is `isPaidSession`, never re-implemented here

#### AC-VERIFY-3: Lock order holds and the race matrix has no deadlock
**Priority**: MUST
**Given** the canonical lock order `teams → recurring_session_rules → team_members → game_sessions → registrations → registration_guests → payments` (T-1, extending ADR 0015, ADR 0016 and C-ALL-1), with `teams` taken only as `KEY SHARE` and `recurring_session_rules` only as `FOR NO KEY UPDATE` by series edit, series end, the materialiser's instance transaction and the bookkeeping stamp
**When** `sessions-races.int.test.ts` runs, with real connections and `waitForLockWaiters` on `pg_stat_activity` (no sleeps), every row in both orders: R1-R14 of the ARCH race matrix (materialiser vs series edit, draft retry vs instance edit, two runs on one `(rule, date)`, manual and materialiser publish vs banking removal, capacity edit vs registration stand-in, series edit vs registration stand-in, instance edit vs series edit, two series edits, auto-enrol follow-up vs cancel, Auto Enroll save vs follow-up, actor demotion vs instance edit, billing stand-in vs raw court write, series end vs materialiser), plus a registration insert against a fee edit under the session lock (T-17), two concurrent instance transactions for the same rule and window (T-18: exactly one email), and an inline follow-up against a sweep job against a replayed `session-auto-enrol` job (T-19: one `autoEnrolInSession` call, one stamp), plus the `stately` trailing-run test
**Then** every order ends with one committed outcome and the other either waiting then succeeding, or refused with a mapped 409, no `40P01` occurs and no `session.lock_retry` is logged; a lock-order grep confirms `modules/sessions/**` never takes `teams FOR UPDATE` and never takes a `teams` lock after a `game_sessions` lock (ADR 0016 lock rules)

#### AC-VERIFY-4: Recurrence date generation is a pure, table-tested function
**Priority**: MUST
**Given** `recurrenceDates(rule, window)` in `packages/shared/src/sessions/recurrence.ts` (no clock, no DB, only `getUTC*`) taking `(frequency, dayOfWeek (0 = Sunday), startsOn, monthlyWeek, recurUntil)` and an inclusive window
**When** the table-driven unit tests run
**Then** it returns the expected `LocalDate`s for vectors V1-V26 and throws or returns `[]` for E1-E5 in the ALG doc: Weekly, Fortnightly (parity from `startsOn`) and Monthly by ordinal including "last", months where the 4th and the last weekday differ (V12, V13), a 5th-weekday anchor stored as -1, the year boundary and leap February; `recurUntil` is inclusive; a window wholly before `startsOn` or after `recurUntil` returns nothing; both DST-change weeks of 2026-27 give the same dates; `defaultMonthlyWeek` matches its four vectors; a property test checks every output is within bounds, ascending, on `dayOfWeek` and, for Fortnightly, on the 14-day parity; host time zone has no effect (runs under `TZ=UTC` and `TZ=Pacific/Kiritimati`)

#### AC-VERIFY-5: Money stays exact in costing and pricing
**Priority**: MUST
**Given** all costing, rate and fee code in `packages/shared/src/sessions/`, `apps/api/src/modules/sessions/` and the web sessions components
**When** `pnpm run lint` and the unit tests run
**Then** amounts are `Money`/`MoneyString` only (no `number`, `parseFloat`, `toFixed`, or `Math.*` on amount-like identifiers; existing `eslint.config.mjs` guard), money crosses the wire as 2-dp strings and is stored as `numeric(10,2)`, and the AC-HAPPY-2 vectors and the ALG costing vectors C1-C13 (`suggestedRate`, `finalFlatRate`, `defaultFeeOther`, `feeRaised`) pass in both the web helper and the API

#### AC-VERIFY-6: Session events are logged with ids only and carry the trace
**Priority**: MUST
**Given** the events `session.created`, `session.updated`, `session.published`, `session.publish_refused`, `session.cancelled`, `session.stale_refused`, `session.series.created`, `session.series.updated`, `session.series.ended`, `session.recurrence.sweep_completed`, `session.recurrence.run_completed`, `session.recurrence.instance_created`, `session.recurrence.publish_refused`, `session.recurrence.instance_failed`, `session.recurrence.rule_skipped`, `session.auto_enrol.completed`, `session.auto_enrol.port_noop`, `session.auto_enrol.failed`, `session.lock_retry`, `session.lock_retry_exhausted`
**When** tests trigger each
**Then** each line has `teamId` (except the cross-team sweep line `session.recurrence.sweep_completed`, which spans all teams) plus the relevant `sessionId`/`ruleId`, `actorId` for admin actions, the fields listed in the ARCH logging table (for example `session.series.updated` carries `updated`, `unchanged` and the skip counts; `session.recurrence.run_completed` carries `trigger` and `windowStart`), `traceId` (request, or the job's CONSUMER span restored from `_meta.traceparent`), no email, name or bank value, error codes logged as `errorCode`, and the tests assert the logged fields, not only that the event fired (`logging-redaction-global` learned rule); no new redaction key collides with an existing field name; no `session.notify.*` event exists (P-2)

#### AC-VERIFY-7: The feature's ADR records every contract it honours and offers
**Priority**: MUST
**Given** this feature's ADR `docs/adr/0019-session-scheduling-engine.md`
**When** the final review reads it
**Then** it follows the ARCH ADR outline and states compliance with C-SSE-1..5, C-SAE-1..2 as amended by R16, C-ALL-1 and the extended lock order, ADR 0016's gate contract, lock rules, recurrence contract points 1-6 and the manual-publish hand-off, ADR 0017's C-SKL-1 points 1, 3, 5 and 6 (extended to every session, P-1) and C-GAME-1 point 3, the bounded exception to ADR 0017 point 7 for deferred auto-enrol, platform-foundation's `fee_other` default, DST policy (and the unsupported second 2:30 am), 48 h deadline and rate unit (with the host-seat under-recovery note); it records the trigger firing order, the `sessions-auto-enrol` advisory-lock namespace constant, and what this feature offers registration-and-waitlist: the `SessionAllocatorPort` TypeScript signature, `noopSessionAllocator`, `createSessionAllocator` in `apps/api/src/session-allocator.ts` and the required `AppDeps`/`RegisterJobsOptions` fields, the `enrols` semantics, the admin-route namespace and reserved member routes, the reserved queue, key and metric names, acknowledgement of the slot contract (SSE adds nothing to the player page), and the hand-offs re-checked at registration's build gate: `CREATE OR REPLACE` of `game_session_has_active_registrations` to count `WITHDRAWN` rows with `withdrawal_fee_due` (ALG R-a, T-17), an existing row in any status treated as `already_registered` (ALG R-b), and the composition function superseding `promoteWaitlist(trx, sessionId, now)` (ARCH H10)

#### AC-VERIFY-8: The admin session pages are accessible on desktop and phone
**Priority**: MUST
**Given** the Compose stack with `AUTH_FAKE_OAUTH=true`
**When** `apps/web/e2e/sessions.spec.ts` scans the list, the session editor (draft, published and read-only), the series page and the series form with `@axe-core/playwright` on the desktop and 360 x 740 projects, including the states with DST choice buttons, the rate follow and pin status, the End series impact text and the publish and create confirm panels
**Then** there are no `critical` or `serious` violations; the court rows are operable by keyboard and screen reader (each row `role="group"` named by its court name, labelled start and end inputs), there is no horizontal page scroll at 360 px, "Number of courts" does not submit the form on Enter, and "Apply to all courts" announces how many courts changed through one polite live region per form; no Sessions confirm has a dismiss button named "Cancel"

#### AC-VERIFY-9: The allocator seam cannot be half-wired
**Priority**: MUST
**Given** `SessionAllocatorPort` in `apps/api/src/modules/sessions/allocator-port.ts` and the composition function `createSessionAllocator()` in `apps/api/src/session-allocator.ts` (T-13)
**When** tsc and the structural tests run
**Then** `buildApp` (`AppDeps.sessionAllocator`) and `registerJobs` (`RegisterJobsOptions.sessionAllocator`) require the port, so an entrypoint that forgets it does not compile; `session-allocator.test.ts` asserts that both `main.ts` and `worker.ts` obtain it from `createSessionAllocator` and neither passes `noopSessionAllocator` directly; `boundaries.test.ts` asserts that `modules/sessions/**` imports other modules only through their public files and never writes `registrations`, and that registration may import only `sessions/allocator-port.ts`

#### AC-INTEGRATION-1: Registration-and-waitlist's assumed outputs hold against real published sessions
**Priority**: MUST
**Given** sessions published through this feature's service (not inserted by fixtures)
**When** `sessions-contracts.int.test.ts` checks the five "Assumed session-scheduling-engine outputs" in the registration-and-waitlist task file and C-SSE-1..5
**Then** every PUBLISHED session has at least one court, set `starts_at`/`ends_at`, `cancellation_deadline <= starts_at`, final `max_players`/`reserved_seats`, and every fee column its pricing structure needs (FLAT `fee_flat` equal to the edited rate after a rate decrease on a published session too); cancelling changes no registration; a capacity raise calls `promoteWaitlist` exactly once after the session lock, verified with a recording allocator double; a pending session moves to stamped once an `enrols: true` double is injected and the sweep runs; the test file header lists these, the port signature and the D-85 predicate as the contract registration's build gate re-checks

#### AC-INTEGRATION-2: Auto-enrol uses the real selection seam and calls the allocator port exactly as contracted
**Priority**: MUST
**Given** real `team_members` rows seeded through the factories (Auto Enroll on and off, `until` before, on and after the instance date, a non-APPROVED member, tie on `assigned_at`) and a recording allocator double injected through `createSessionAllocator`'s required-dependency seam
**When** the materialiser publishes an instance, an admin publishes a one-off session, and an admin publishes a gate-refused series draft by hand
**Then** the double receives one `autoEnrolInSession` call per published session, after the session is PUBLISHED and committed, in a transaction that took the advisory lock first, with `entries` equal to `selectAutoEnrollees` output in order (`assigned_at ASC, id ASC`) as `{ userId, assignedAt }`, no guests, and that session's `sessionId`; a DRAFT (gate-refused) instance triggers no call; an empty selection triggers no call; a double returning `overdue_payments`, `forbidden`, `already_registered` or `auto_enroll_changed` for some members does not abort the run; re-running the materialiser or the sweep does not call it again for the same session; with `enrols: false` the session stays pending, and switching to an `enrols: true` double and running the sweep enrols it exactly once (marker stamped)

#### AC-INTEGRATION-3: An admin sets up, edits and publishes sessions end to end in a real browser
**Priority**: MUST
**Given** the Compose stack, the worker running, Mailpit, and a team admin whose team has no banking details
**When** `apps/web/e2e/sessions.spec.ts` walks:
  1. create a 3-court weekly paid series with one per-court override (Court 3 ending an hour early) through the create confirm
  2. see the waiting line, then drafts labelled "Draft · bank account needed" with the S2b notice, and the admin email in Mailpit
  3. "Set up banking and GST" from the series page, save banking, "Back to your session"
  4. see the S2r notice, choose "Publish drafts now", then see the dates "Published"
  5. edit one date's capacity and see it marked "Edited"
  6. change the series start time and see "… 1 edited session kept its own details."
  7. cancel one date and see "Session cancelled. No one had registered."
  8. create a one-off session with 9 courts (Court 7 ending early) at desktop and 360 px, trigger and resolve a DST gap choice, pin and unpin the rate, and save a draft
  9. end the series with "Also cancel the {p} published sessions after this date" ticked
**Then** each step shows the copy in Success Criteria and the ACs above, the database matches (statuses, `is_instance_overridden`, courts, `deadline_is_default`, `auto_enrol_required`), and the journey passes on desktop and 360 px; this run is the seed path registration-and-waitlist's E2E uses for "a PUBLISHED session seeded through the session-scheduling-engine admin flow"

### Scope Boundaries

- **In scope**:
  - Admin sessions area (list, one-off editor, instance editor, series page and form, read-only summaries) and its manage-area registry entry.
  - Sessions API module with TEAM_ADMIN policies, actor re-check, shared zod contracts and error codes (`session_not_editable`, `session_started`, `session_state_conflict`, `session_stale`, `series_stale`, `session_fee_locked`; field codes `local_time_nonexistent`, `local_time_ambiguous`, `series_pattern_fixed`).
  - Costing (suggested rate, follow or pin), the three pricing models, the BY_SEX `fee_other` default, and decrease-only fees once players have registered (T-7, D-85).
  - Lifecycle DRAFT → PUBLISHED and → CANCELLED, the DB transition trigger that also admits billing's PUBLISHED → COMPLETED, closed-row immutability, and the API-computed `phase`.
  - Publishing through ADR 0016's gate; the manual-publish banking hand-off from the editor, series page and list.
  - The materialiser: the `recurrence-materialisation` sweep (daily, at boot, on demand), the `recurrence-rule` queue, horizon `RECURRENCE_HORIZON_DAYS`, idempotent per-instance transactions, gate-refused drafts, the weekly admin email claimed in `payout_notice_claims`, the draft retry and "Publish drafts now".
  - Auto-enrol for every session on first publish (P-1) through the `session-auto-enrol` queue and handler, the D-80 marker and its sweep reconciliation, and the allocator port with its no-op default and composition function.
  - Single-instance overrides and synchronous series-edit propagation with counts (T-5); End series (T-6); capacity edits per C-SSE-3; the registered-player count on cancel and change (P-2).
  - The migration (D-70..D-83, D-85), ADR 0019, unit, integration, race and E2E tests, the fixes to existing tests broken by the new CHECKs (T-16), and the new module in the coverage gate list.
- **Out of scope**:
  - The player session page `/teams/[teamId]/sessions/[sessionId]`, `SessionSummary` for players, `RegistrationPanel` and the team-page "Upcoming sessions" list (registration-and-waitlist, page-ownership Q5). Per the slot contract, this feature adds no section to the player page. A later "Edit session" admin link after `RegistrationPanel` can be added once that page exists.
  - Any write to `registrations`, `registration_guests` or `payments`; the allocator itself; promotion and auto-enrol emails (registration-and-waitlist R17).
  - The PUBLISHED → COMPLETED transition and billing (wallet-and-akahu-billing, C-BIL-1).
  - Emailing registered players when a session is cancelled or changed, and any session-change notifier port: decided out of scope by P-2. The admin is shown the registered count instead.
  - Withdrawing registrations on cancel (C-SSE-4 needs a new `withdrawal_kind` through the allocator).
  - Changing a series' day, frequency, monthly week or first date (P-3: end it and start a new one); moving a series date (cancel it and create a one-off).
  - "Reset to series" on an edited date and "Skip a future date" (ALG J7; deferred).
  - Changing the People-page Auto Enroll hint in `skill-enroll-panel.tsx` (UJ amendment 9 withdrawn by P-1).
  - Recorded evolution paths, not built: a per-series publish lead time (D-84 reserved) and a per-registration fee snapshot (ALG 10-3).
  - Deliberately unsupported: choosing the second (NZST) 2:30 am for a court time on the DST-end night.
  - A venue library, calendar export, deleting series (End series only), sessions that cross midnight (existing CHECKs), subscription billing, guest pricing rules.
- **Dependencies**:
  - team-banking-and-gst (merged): `publish-gate.ts`, ADR 0016, banking page `returnTo` (`bankingReturnTo` already accepts sessions paths).
  - skill-levels-and-auto-enroll (merged): `selectAutoEnrollees` (`apps/api/src/modules/skill-levels/auto-enrol.ts`), ADR 0017.
  - team-management (merged): `MANAGE_AREAS`, `ManageAreaNav`, `ManageSection`, `SectionPager`, `InlineConfirm`, `NoAccess`, `requireTeamRole`, `teams/admin-lock.ts`, lock order (ADR 0015).
  - platform-foundation (merged): `Money`, `time.ts` (`addLocalDays`, `resolveLocal`, `localToInstant`, `instantToLocal`, `DST_POLICY`, `defaultCancellationDeadline`), `nz_local_to_utc` and the instants trigger, pg-boss runner, `enqueueEmail`, `intInRange`, the `recurrence-materialisation` slot.
  - registration-and-waitlist (in flight, builds after this feature): supplies the real allocator later by editing `createSessionAllocator`; widens the D-85 predicate in its own migration.
- **Binding contracts honoured** (each re-checked at the build gate and in the ADR):
  - **registration-and-waitlist C-SSE-1** (`fee_flat` = final FLAT rate, kept at every save; BY_SKILL fees NOT NULL when PUBLISHED with a CHECK): AC-HAPPY-2, AC-HAPPY-4, AC-ERROR-4, AC-VERIFY-1, AC-INTEGRATION-1.
  - **C-SSE-2** (PUBLISHED implies ≥1 court and `deadline <= starts_at`; lifecycle): AC-ERROR-4, AC-ERROR-6, AC-INTEGRATION-1.
  - **C-SSE-3** (capacity edit: locks, session `FOR UPDATE`, `UPDATE`, `promoteWaitlist` in one tx; a cut never demotes; refused after start): AC-HAPPY-7, AC-HAPPY-8, AC-ERROR-5.
  - **C-SSE-4** (cancel leaves registrations, no allocator call): AC-HAPPY-9, AC-HAPPY-13.
  - **C-SSE-5** (session lock `FOR UPDATE`, held briefly): AC-HAPPY-8, AC-VERIFY-3.
  - **C-SAE-1/C-SAE-2 as amended by R16** (`autoEnrolInSession` once per session after PUBLISHED, entries `{ userId, assignedAt }` in order, no guests, refusals are skips, never empty): AC-ASYNC-2, AC-ASYNC-5, AC-HAPPY-12, AC-INTEGRATION-2.
  - **C-ALL-1** (lock order, READ COMMITTED, no direct `registrations` writes): AC-VERIFY-3, AC-VERIFY-9.
  - **Page-ownership split and slot contract**: Invocation Method, Scope "Out of scope", AC-VERIFY-7.
  - **ADR 0016** (gate contract 1-5, lock rules, recurrence contract 1-6, manual publish and `returnTo` hand-off): AC-HAPPY-4, AC-HAPPY-7, AC-HAPPY-14, AC-ASYNC-3, AC-ASYNC-4, AC-ERROR-1, AC-ERROR-9, AC-VERIFY-2, AC-VERIFY-3.
  - **ADR 0017 C-SKL-1** points 1, 3, 5, 6 (selection, call sequence, follow-up transaction, one-off sessions decided by P-1): AC-ASYNC-2, AC-HAPPY-12, AC-INTEGRATION-2. Point 7 bounded exception: AC-ASYNC-5. **C-GAME-1 point 3** (refuse court edits on COMPLETED): AC-ERROR-5, AC-VERIFY-1.
  - **platform-foundation**: `fee_other` default `LEAST(fee_male, fee_female)` in the service/UI (AC-HAPPY-3); `DST_POLICY.USER_INPUT` reject with options (AC-ERROR-3); `DERIVED` compatible for materialisation (AC-ASYNC-1); default deadline `starts_at − 48h` (AC-HAPPY-11, AC-VERIFY-1); rate in whole dollars via `CEIL`/`DOLLAR` (AC-HAPPY-2); `recurrence-materialisation` at `0 3 * * *`, idempotent via `uq_game_sessions_rule_date` (AC-ASYNC-1).
- **NFR implications**:
  - P1: every state invariant in the DB (matrix, immutability, version, default deadline, C-SSE-1, fee-raise lock), with TS shaping only the error; time-relative rules (after `starts_at`) in TS with the clock read after the lock (ADR 0017 point 1).
  - P2: money exact.
  - P3: UTC inside, NZ at the edges; `date` is the NZ calendar date.
  - P5: rule-create enqueue, `session-auto-enrol` enqueue and admin emails in the domain transaction.
  - P7: `RECURRENCE_HORIZON_DAYS` from env, zod-validated (`intInRange(7, 91, 28)`); lock policies are code constants.
  - Accessibility: axe, 360 px, WCAG 2.2 AA (reflow at 320 px, 44 px targets, status messages).
  - Privacy: venue address is not personal data, but no member names or emails appear in job payloads or logs.
  - Performance: a session edit holds the session row lock only for its own statements (C-SSE-5; registration's 2 s lock timeout); series edits lock at most about 14 instances in `(date, id)` order; the daily run finishes far inside the 900 s job expiry.
  - Coverage: add `apps/api/src/modules/sessions/**`, `packages/shared/src/sessions/**` and `apps/api/src/session-allocator.ts` to the 80% gate.

### Creative Exploration Needed

**Complete (2026-10-20).** All four creative phases ran, followed by a binding reconciliation and an adversarial critique. Read these before build:

- `memory-bank/creative/session-scheduling-engine-binding-reconciliation.md` (BIND): binding; user rulings P-1..P-3, orchestrator rulings T-1..T-16, wave 2 acceptance, critique rulings T-17..T-20.
- `memory-bank/creative/session-scheduling-engine-recurrence-algorithm.md` (ALG): recurrence, horizon, propagation, DST input, fees; test vectors V1-V26, E1-E5, T1-T9, C1-C13 and the reconciliation vectors.
- `memory-bank/creative/session-scheduling-engine-architecture.md` (ARCH): queues, lock order, allocator port, marker, concurrency, triggers, migration and ledger, race matrix R1-R14, ADR 0019 outline.
- `memory-bank/creative/session-scheduling-engine-admin-user-journey.md` (UJ): states, journeys, async handling.
- `memory-bank/creative/session-scheduling-engine-uiux.md` (UI): layouts at desktop and 360 px, components, final copy deck.

**Conflicts and gaps raised by the spec (all resolved):**

1. **Allocator not built yet; rollout gap.** RESOLVED: a required `SessionAllocatorPort` with a no-op default, one composition function `createSessionAllocator()` in `apps/api/src/session-allocator.ts` (T-13, ARCH SA-4); the gap is closed by the per-session marker `auto_enrol_required`/`auto_enrolled_at` (D-80) plus the boot and daily sweep (ARCH SA-5). No backfill script, no env flag.
2. **`autoEnrolInSession` input shape.** RESOLVED: R16 `entries: { userId, assignedAt }[]`, never empty (ALG conflict 2, T-13); ADR 0019 records that it supersedes `userIds`.
3. **Which sessions auto-enrol.** RESOLVED by user ruling P-1: every session, one-off or series, once on its first DRAFT → PUBLISHED, whatever publishes it. Always in a follow-up transaction (T-2), serialised per session by an advisory lock (T-19).
4. **Cron cadence and the per-rule run.** RESOLVED: the `exclusive` sweep fans out to a new `recurrence-rule` queue (`stately`, `recurrence-rule:<ruleId>`); rule create, edit and end enqueue in-transaction (T-3, ARCH SA-1).
5. **Horizon and publish timing.** RESOLVED: `RECURRENCE_HORIZON_DAYS` = `intInRange(7, 91, 28)`, window `[today, today + H]` inclusive; instances publish on creation unless the gate refuses; no lead time, D-84 reserved (T-4, ALG A2).
6. **DST options against what can be stored.** RESOLVED: gap offers 03:30 or 01:30, overlap offers only the first 2:30 am for court times, the materialiser rewrites gap times, rule save refuses courts wholly in 02:00-03:00; D-08 unchanged (T-10, ALG conflict 6).
7. **ADR and ledger numbering.** RESOLVED (user, plan review): ADR 0019, one migration `20261020000100000_session_scheduling.sql`, ledger D-70..D-83 plus D-85, D-84 reserved (T-15, T-17). Re-checked at the build gate against registration's reservation (ADR 0018, D-62..D-66 plus its R2 index).
8. **COMPLETED belongs to billing; cancel window.** RESOLVED: the DB matrix admits PUBLISHED → COMPLETED but this feature never performs it; every edit and every cancel is refused after `starts_at` (`session_started`, TS); the API computes `phase` for the Started and Ended labels (T-11, ARCH SA-7).
9. **Schema gaps.** RESOLVED in ARCH SA-8 and BIND: `starts_on` and `monthly_week` (D-70), `recurring_rule_courts` (D-71), `version`/`updated_at` (D-72), `create_key` (D-73), `deadline_is_default` with a DB-maintained default (D-74, T-8), court uniqueness (D-78) and content CHECKs (D-79).
10. **Fee edits reprice registrations.** RESOLVED: decrease-only once a PUBLISHED session has an active registration; 409 `session_fee_locked`, backed by `game_sessions_fee_raise_locked` using `game_session_has_active_registrations` (T-7, T-17, D-85).

**Creative questions (all resolved):**

- A1 Monthly meaning and anchor: explicit `monthly_week` (1-4 or last) and mandatory `starts_on`, 0 = Sunday (ALG A1).
- A2 Horizon, publish timing, email window: rolling horizon, publish on creation, `windowStart` = Monday of the NZ week, claimed in `payout_notice_claims` (ALG A2, T-4, T-18).
- A3 Series-edit propagation: synchronous single transaction with ALG's target rules and skip reasons, whole-instance override, whole-edit banking refusal (T-5).
- A4 Pattern changes and shortening: pattern fixed after creation (P-3); End series deletes unedited drafts after the last date and keeps the rest unless the admin ticks "Also cancel" (T-6).
- A5 Rate details: divisor `max_players`, NULL custom rate follows the suggestion, `fee_flat` kept at every save (T-9), UI-only pre-fills, `fee_other` defaulted only when switching into BY_SEX, default deadline tracked by `deadline_is_default` (T-8, superseding ALG's inference).
- B1 Materialiser shape: fan-out sweep plus `recurrence-rule`, clock read once per job for the window and after locks for decisions (ARCH SA-1).
- B2 Lock order and auto-enrol placement: `teams → recurring_session_rules → team_members → game_sessions → …`, auto-enrol always in a follow-up transaction (T-1, T-2).
- B3 Allocator port: see conflict 1 (T-13).
- B4 Concurrency and replay: `version`/`expectedVersion` on every write, no-op saves return 200, `createKey` on creates (T-12).
- B5 Triggers and TS twin: `game_sessions_guard_update`, `session_courts_guard_closed`, `SESSION_TRANSITIONS` and the hand-written fixture (ARCH SA-7).
- C1 Multi-court setup: defaults block plus one stacked row per court (UI D1).
- C2 Series versus instance: scope by URL, scope lines, "Edited" tag, effect line before and counts after, bounded waiting refresh (UJ, UI D3).
- C3 Telling players: deferred by P-2; admin sees the registered count.
- C4 Costing and pricing: Costing then Pricing, rate follows or is pinned (UI D2).
- C5 List and notices: four sections, one page-level banking notice, Started in Upcoming, read-only summaries (UI D4, T-11).

**Open items**: none block build. The cross-feature hand-offs (ALG R-a, R-b; ARCH H10; the T-17 predicate widening) are obligations on registration-and-waitlist, recorded in ADR 0019 and re-checked at registration's build gate.

### Implementation Guide Required

No. Every criterion is verifiable automatically (unit, integration, race and Playwright tests). Operators only need the existing `pnpm run jobs:trigger recurrence-materialisation` line and the new `pnpm run jobs:trigger recurrence-rule '<json>'`; `RECURRENCE_HORIZON_DAYS` goes in `docs/getting-started.md` and `.env.example`.

## Architectural Plan

### Executive Summary
Admins get a Sessions area to create, cost, price, publish and cancel multi-court sessions, and to define recurring series that background jobs turn into session instances. The feature builds on tables platform-foundation already created (`game_sessions`, `session_courts`, `recurring_session_rules`). It adds a sessions API module, a sweep handler for the existing `recurrence-materialisation` slot, two new queues (`recurrence-rule`, `session-auto-enrol`), one migration for the missing invariants (D-70..D-83, D-85), an allocator port with a single composition function, and admin pages. It is the producer side of contracts already written by team-banking-and-gst (ADR 0016), skill-levels-and-auto-enroll (ADR 0017) and the in-flight registration-and-waitlist (C-SSE-1..5, C-SAE-1/2 per R16, slot contract). The creative phase is complete; BIND is the reference for every ruling below.

### Business Context
Clubs run the same multi-court night every week. Today admins retype each night and work out a break-even rate by hand. Nothing in v1.0.0 can be registered for, billed or reported until sessions exist: registration-and-waitlist, wallet-and-akahu-billing, player-dashboard and admin-reporting-dashboard all read `game_sessions`. That makes this feature step 5 of the v1.0.0 build order and the critical-path dependency for the rest of the MVP.

### Vision and Goals
- **Vision**: a team admin sets up a recurring multi-court night once and never retypes it. Sessions open for registration on their own, correctly priced, and one-night changes never break the series.
- **Goals**:
  - A one-off 9-court session with per-court overrides is created and published in a single editor visit (AC-HAPPY-1, AC-HAPPY-4).
  - A weekly series produces its instances within about 5 s of creation and daily after that, with zero duplicates under re-runs and races (AC-ASYNC-1, AC-VERIFY-3).
  - A series edit updates every eligible upcoming date in one transaction and tells the admin the counts (AC-HAPPY-7).
  - Every PUBLISHED session satisfies C-SSE-1..5, proven against sessions created through the real service (AC-INTEGRATION-1).
  - No paid session is ever published for a team without payout details (AC-VERIFY-2), and no registered player ever pays more than the fee they saw (AC-ERROR-10).
  - Every session gets its Auto Enroll members exactly once, even across the rollout gap (AC-ASYNC-2, AC-ASYNC-5).

### Requirements
- **Functional**: AC-ENTRY-1..2, AC-HAPPY-1..15, AC-ASYNC-1..7, AC-ERROR-1..12 (see Specification).
- **Non-functional** (with metrics):
  - Session row lock held only for the edit's own statements; series edits lock at most about 14 instances in `(date, id)` order; no `40P01` across the race matrix (AC-VERIFY-3).
  - Series save p95 under 1 s; instance edit p95 under 300 ms (ALG performance).
  - New-series instances visible within about 5 s; daily sweep at 03:00 Pacific/Auckland and at worker boot; a 10x sweep (1,000 rules) under 60 s.
  - Coverage of at least 80% on `apps/api/src/modules/sessions/**`, `packages/shared/src/sessions/**` and `apps/api/src/session-allocator.ts`.
  - No axe `critical`/`serious` findings at desktop and 360 px (AC-VERIFY-8).
  - Exact money (P2). Every state invariant enforced in the DB (P1).

### Architectural Principles
1. **DB is the source of truth (P1)**: the lifecycle matrix, closed-row immutability, version bump, default deadline, C-SSE-1 fee CHECKs and the fee-raise lock are triggers or CHECKs. The TS twin only shapes the 409/422. Time-relative rules (after `starts_at`) live in TS with the clock read after the lock.
2. **Gate before lock**: every publish path calls the ADR 0016 gate before the first `game_sessions` lock, and re-checks `version` after it. Nothing re-implements `isPaidSession`.
3. **Canonical lock order** `teams → recurring_session_rules → team_members → game_sessions → registrations → registration_guests → payments` (T-1). `teams` only as `KEY SHARE`; rules only as `FOR NO KEY UPDATE`, only by series edit, series end, the materialiser's instance transaction and the bookkeeping stamp. Every transaction goes through `runSessionTransaction` (`tx.ts`) and the helpers in `locks.ts`.
4. **One instance, one transaction** in the materialiser. Idempotent by `uq_game_sessions_rule_date`, DRAFT then courts then guarded publish, and one bad instance never stops the run.
5. **Ports, not imports, toward registration**: this feature never writes `registrations`. Allocator calls go through `SessionAllocatorPort`, wired once in `createSessionAllocator`; auto-enrol only from `runSessionAutoEnrol`, never while holding a rule or session lock.
6. **Durable claims, not queue dedupe**: `singletonKey` dedupes only queued or active jobs, so the email uses `payout_notice_claims`, auto-enrol uses the D-80 marker under an advisory lock, and creates use `create_key`.
7. **Pure core**: recurrence dates, instance building, series reconciliation, costing and lifecycle transitions are pure functions with no clock and no DB, tested from tables.
8. **Config in env (P7)**: `RECURRENCE_HORIZON_DAYS` from `config.ts`, validated with zod.

### Architecture Alternatives
Decided in creative; the rejected options are recorded in ARCH and ALG and summarised in ADR 0019.
- **Materialiser trigger**: chosen fan-out sweep plus a `stately` per-rule queue (ARCH 1D). Rejected: one `exclusive` queue with or without per-rule keys (dropped runs), an inline sweep plus a rule queue (two code paths, long job), synchronous materialisation in the request.
- **Auto-enrol placement**: chosen always a follow-up transaction (ARCH 3B, T-2). Rejected: same transaction as the insert (allocator failure undoes materialisation, lock-order risk), always a job (slower, loses run counts).
- **Rollout gap**: chosen per-session marker plus sweep (ARCH SA-5). Rejected: registration backfill, env hold, accepting the loss.
- **Allocator coupling**: chosen a required port with one composition function (ARCH 4.2/4.b). Rejected: a hard import (impossible), an outbox (breaks C-SSE-3), optional injection points (can be half-wired), env selection.
- **Override granularity**: whole-instance `is_instance_overridden` (ALG A3). Rejected: per-field mask.
- **Series-edit execution**: one synchronous transaction (ARCH 8A, T-5). Rejected: per-instance transactions after commit (half-propagated series), async in the job (no counts).
- **Optimistic concurrency**: integer `version` bumped by the DB plus `expectedVersion` (ARCH 5A). Rejected: `expected*` fields, `updated_at`, `xmin`.
- **Email claim**: a dedicated `payout_notice_claims` table (T-18). Rejected: a column on the rule row (deadlock risk, ALG H3).

### Selected Architecture
- **Shared pure modules** in `packages/shared/src/sessions/`: `recurrence.ts` (`recurrenceDates`, `defaultMonthlyWeek`, `assertRecurrenceRule`), `instance.ts` (`buildInstance`, DST normalisation), `reconcile.ts` (`planSeriesReconciliation`, `seriesChangeEffect`, End series plan), `costing.ts` (`suggestedRate`, `finalFlatRate`, `defaultFeeOther`, `feeRaised`), `lifecycle.ts` (`SESSION_TRANSITIONS`, `isTerminal`). API contracts in `packages/shared/src/api/sessions.ts`.
- **API module** `apps/api/src/modules/sessions/`:
  - `routes.ts`: TEAM_ADMIN policies, team-scoped params.
  - `service.ts`: one-off and instance create, update, publish, cancel, list, get; capacity raise → `promoteWaitlist`; publish enqueues `session-auto-enrol`.
  - `series.ts`: series create, update with synchronous propagation, end, publish-drafts; enqueues `recurrence-rule`.
  - `materialise.ts`: `materialiseRule(deps, { ruleId, teamId, runNow })`, per-instance transactions, draft retry, inline auto-enrol follow-ups, bookkeeping stamp.
  - `auto-enrol.ts`: `runSessionAutoEnrol` (advisory lock first, re-read, select, allocator call, stamp).
  - `allocator-port.ts`: `SessionAllocatorPort` types and `noopSessionAllocator`.
  - `locks.ts`: `lockTeamKeyShare`, `assertSessionAdmin`, `lockRule`, `lockSession`, the advisory-lock namespace constant; documents the canonical order.
  - `tx.ts`: `runSessionTransaction(db, policy, fn)` with `SET LOCAL lock_timeout` and whole-transaction retry on `40P01`/`55P03`; `HTTP_POLICY` and `JOB_POLICY` constants.
  - `transitions.ts`: `decideSessionAction`.
  - `repo.ts`: Kysely queries for the four tables plus `payout_notice_claims`.
  - `errors.ts`: `mapSessionDbError` by SQLSTATE and `err.constraint`; `classifySessionError`.
- **Jobs**: `apps/api/src/jobs/recurrence-materialisation.ts` (sweep, replaces `placeholderHandler`), `recurrence-rule.ts` (per-rule handler), `session-auto-enrol.ts` (per-session handler); registry entries for the two new queues; boot enqueue in `worker.ts`; CLI trigger for `recurrence-rule`.
- **Composition**: `apps/api/src/session-allocator.ts` (`createSessionAllocator`), called by `main.ts` and `worker.ts`; required `AppDeps.sessionAllocator` and `RegisterJobsOptions.sessionAllocator`.
- **Web**: pages under `apps/web/src/app/teams/[teamId]/manage/sessions/**`; pure view model, form reducer and Server Actions in `apps/web/src/lib/teams/`; components in `apps/web/src/components/teams/` (UI Component Structure).

**Justification**: this reuses every established seam (module shape, manage-area registry, pg-boss runner and the sweep-plus-per-unit-job pattern, gate, `selectAutoEnrollees`, Money and time primitives, the ADR 0015 port pattern) and keeps the cross-feature dependency on registration one-directional, fail-safe and testable with a recording double.

### Architecture Documentation
```
Admin (web) ──► /teams/:teamId/sessions*, /session-series*  (requireTeamRole TEAM_ADMIN; expectedVersion / createKey)
                    │
                    ▼
     sessions.service / sessions.series ── runSessionTransaction:
         teams KEY SHARE → [gate (ADR 0016)] → [rule FOR NO KEY UPDATE] → actor team_members FOR SHARE
         → game_sessions FOR UPDATE → writes → [promoteWaitlist] → enqueue (same tx):
              recurrence-rule (series create/edit/end, publish-drafts) │ session-auto-enrol (publish)
                    │
cron 03:00 / boot / CLI ──► recurrence-materialisation (exclusive sweep, keyset 500)
                    │ enqueue per active rule              │ enqueue per pending session (D-80)
                    ▼                                      ▼
     recurrence-rule (stately, key per rule)      session-auto-enrol (exclusive, key per session)
                    │                                      │
     materialiseRule: per date tx                          ▼
       teams KEY SHARE → rule FOR NO KEY UPDATE → gate     runSessionAutoEnrol (follow-up tx):
       → INSERT DRAFT + courts ON CONFLICT DO NOTHING        advisory lock (T-19) → re-read marker
       → publish | DRAFT + payout_notice_claims → email      → selectAutoEnrollees (ADR 0017)
       ──commit──► inline runSessionAutoEnrol ───────────►   → SessionAllocatorPort.autoEnrolInSession
       → draft retry → stamp materialised_version            → stamp auto_enrolled_at iff enrols
```
- **Integration points**: team-banking `publish-gate.ts`; skill-levels `auto-enrol.ts`; teams `admin-lock.ts`; `enqueueEmail` (P5); banking page `returnTo` (`bankingReturnTo`); registration-and-waitlist through the port, the D-85 predicate and the reserved member routes.

### Observability Requirements
- **Logging**: the existing pino logger, structured JSON, configured with `LOG_LEVEL`/`LOG_FORMAT`/`LOG_OUTPUT`. The events listed in AC-VERIFY-6 carry ids only, use `errorCode` rather than `code`, and include no email, name or bank values.
- **Tracing**: W3C Trace Context through the existing OTel setup. API spans per route; jobs run in the `"{queue} process"` CONSUMER span restored from `_meta.traceparent` (one trace per nightly sweep, propagated to every `recurrence-rule` and `session-auto-enrol` job it enqueues). Child spans under tracer `@sgm/api/sessions`: `session.recurrence.instance`, `session.recurrence.retry_draft`, `session.auto_enrol`, `session.series.propagate`, `session.publish` (`path`: manual, materialiser, retry, edit). Port calls happen in-process inside the caller's span.
- **Metrics**: run summaries are logged (`sweep_completed`, `run_completed`). Reserved metric names, not emitted until an exporter exists: `session_recurrence_instances_total{outcome}`, `session_recurrence_rule_runs_total{outcome}`, `session_recurrence_rule_run_duration_seconds`, `session_auto_enrol_entries_total{outcome}`, `session_publish_total{path, outcome}`, `session_lock_retries_total{path}`. Alert signals today: `instance_failed` at `error`, `run_completed.failed > 0`, `session.auto_enrol.failed`, pending auto-enrol older than one sweep.
- **Infrastructure**: unchanged (existing collector via `OTEL_EXPORTER_OTLP_ENDPOINT`).

### API Requirements
- **REST API**: Yes. There is no GraphQL.
  - **OpenAPI**: regenerated from the zod contracts (existing pipeline). Build agents MUST load `api-rest-requirements.md`.
  - **Endpoints**: `GET|POST /teams/:teamId/sessions`, `GET|PUT /teams/:teamId/sessions/:sessionId`, `POST …/:sessionId/publish`, `POST …/:sessionId/cancel`, `GET|POST /teams/:teamId/session-series`, `GET|PUT …/session-series/:ruleId`, `POST …/session-series/:ruleId/end`, `POST …/session-series/:ruleId/publish-drafts` (202). Reserved for registration: `GET /teams/:teamId/sessions/upcoming` and `…/:sessionId/registration*`. Fields as in Invocation Method.
  - **Auth**: session cookie and `requireTeamRole('TEAM_ADMIN')`; default-deny (ADR 0013); actor re-check inside every write transaction.
  - **Errors**: `validation_failed` (422; field codes `local_time_nonexistent`, `local_time_ambiguous`, `series_pattern_fixed`, with `dstOptions` for DST), `payout_not_configured` (409), `session_not_editable`, `session_started`, `session_state_conflict`, `session_stale`, `series_stale`, `session_fee_locked` (409, with `raisedFields`), `forbidden` (403). Stale 409s carry the current row.
  - **Testing**: integration tests for every endpoint (`sessions-api.int.test.ts`, `sessions-series.int.test.ts`).

### Guiding-Principles Check
The plan follows systemPatterns' module shape, P1/P2/P3/P5/P7, default-deny routes, the canonical lock order (extended once, at the one place every new path fits), ports with a safe default, transition table plus DB trigger plus hand-written fixture, and "no DB mocking". Two documented points that are not principle deviations: the DB matrix admits PUBLISHED → COMPLETED but this feature never performs it (an ownership split, C-BIL-1); "not started" rules live in TS rather than SQL, following ADR 0017 point 1 (no `now()` in SQL rules).

### Risk Assessment
| Risk | L | I | Mitigation |
|---|---|---|---|
| Auto-enrol gap between this merge and registration's merge (conflict 1) | - | - | RESOLVED: per-session marker plus boot and daily sweep (ARCH SA-5, D-80); serialised by an advisory lock (T-19) |
| Numbering collision with registration | - | - | RESOLVED: ADR 0019, D-70..D-83 and D-85, D-84 reserved (T-15); re-checked at the build gate |
| Fee edits reprice registrations (conflict 10) | - | - | RESOLVED: decrease-only with the D-85 trigger backstop (T-7, T-17) |
| DST input options not storable (conflict 6) | - | - | RESOLVED: representable options only, D-08 unchanged (T-10) |
| New CHECKs and the matrix break existing raw-SQL tests and fixtures (insertable matrix rows, raw DRAFT → COMPLETED updates) | H | M | Fixed in the Phase 1 commit, never weakened: `paid-session-matrix.ts` gains `publishable`, `advanceSessionTo` walks the legal path, `insertSession` gains complete-fee defaults (T-16). Grep every `UPDATE game_sessions SET status` in `apps/api/test/**` first |
| Lock-order deadlock between rule edits, materialiser, instance edits and auto-enrol | L | H | Fixed order (T-1), prologue helpers, race matrix R1-R14 plus the T-17/T-18/T-19 races with real connections (AC-VERIFY-3) |
| Registration wires its adapter in one entrypoint only | M | H | One composition function, required deps, `session-allocator.test.ts` (AC-VERIFY-9) |
| `stately` edge: an active job failing into retry while a sibling is queued | L | M | Pinned by an integration test; the daily sweep and idempotent runs converge anyway |
| Trigger firing order silently changes if a trigger is renamed | L | H | Order documented in the migration and ADR 0019; asserted from `pg_trigger` (AC-VERIFY-1) |
| Gate staleness between the unlocked fee read and the lock | L | H | Post-lock version re-check; fees cannot change without a bump (AC-VERIFY-2) |
| Pending auto-enrol accumulates unnoticed in staging (no-op port) | M | L | Daily `port_noop` logs; operator SQL check on the pending index; self-heals at registration's deploy |
| Series edit hits the 2 s lock timeout behind registrations | L | M | Bounded by the horizon; whole-transaction retry (3 attempts); 500 `OUTAGE_MESSAGE` after that |
| Registration's contracts change again before its build | M | M | `sessions-contracts.int.test.ts` is the shared contract; registration's build gate re-runs it |
| Series-edit propagation surprises admins | L | M | Effect line before save, counts after, E2E covers the edited-instance case (AC-HAPPY-7) |

## Test Strategy

### Approach
- **Emphasis**: balanced, weighted to integration. The core risks (DB invariants, gate-before-lock, idempotent materialisation, durable claims, lock order, contract outputs) can only be proven against real PostgreSQL. Pure logic (recurrence dates, instance building, reconciliation, costing, transitions, view model, form reducer) is unit-tested from tables, using the ALG vectors verbatim. One Playwright journey covers the admin flow with axe scans.
- **Target test count**: about 125 across all phases. ARCH put the plan at about 115 (the original 105 plus race rows R10-R14, the `stately` test, marker reconciliation, wiring, trigger order and 48 h parity); this adds the T-17, T-18 and T-19 race tests, the D-85 raw-SQL pair, and the ACs added in creative (fee lock, read-only labels, fixed pattern, waiting state, "Publish drafts now", registered-count banners). There are 48 ACs, nine of them structural.

### File Organization
- **New test files**:
  - `packages/shared/src/sessions/recurrence.test.ts`: V1-V26, E1-E5, `defaultMonthlyWeek`, property test, two `TZ` values (AC-VERIFY-4).
  - `packages/shared/src/sessions/instance.test.ts`: T1-T5 DST normalisation and deadlines, FLAT `fee_flat` derivation (AC-ASYNC-1, AC-HAPPY-2).
  - `packages/shared/src/sessions/reconcile.test.ts`: the ALG reconciliation vectors (without the pattern-change row, P-3), every skip reason, End series delete-or-keep (AC-HAPPY-7, AC-HAPPY-10).
  - `packages/shared/src/sessions/costing.test.ts`: C1-C13 (AC-HAPPY-2, AC-HAPPY-3, AC-ERROR-10, AC-VERIFY-5).
  - `packages/shared/src/sessions/lifecycle.test.ts`: `SESSION_TRANSITIONS` against the fixture (AC-ERROR-6).
  - `packages/shared/src/api/sessions.test.ts`: strict zod contracts and field errors (AC-ERROR-2, AC-ERROR-12).
  - `apps/api/src/modules/sessions/transitions.test.ts`: `decideSessionAction` against the fixture (AC-ERROR-5, AC-ERROR-6).
  - `apps/api/src/modules/sessions/errors.test.ts`: error-code mapping and failure classification (AC-ERROR-9).
  - `apps/api/src/modules/sessions/boundaries.test.ts`: import and `registrations` boundaries (AC-VERIFY-9).
  - `apps/api/src/session-allocator.test.ts`: both entrypoints call `createSessionAllocator` (AC-VERIFY-9).
  - `apps/api/test/integration/sessions-schema.int.test.ts`: migration round trip, D-83 upgrade test, trigger order, 48 h parity, every CHECK and trigger including D-85 and `payout_notice_claims` (AC-VERIFY-1, DB halves of AC-ERROR-4/5/6/10).
  - `apps/api/test/integration/sessions-api.int.test.ts`: one-off routes, policies and actor re-check, publish and banking refusal, capacity edit, cancel with counts, stale save, DST refusal, fee lock, auto-enrol enqueue on publish (AC-HAPPY-1..4, 8, 9, 11, 13; AC-ERROR-1..8, 10, 11).
  - `apps/api/test/integration/sessions-series.int.test.ts`: series create, edit propagation with counts, whole-edit banking refusal, End series, fixed pattern, publish-drafts (AC-HAPPY-5..7, 10; AC-ERROR-12; AC-ASYNC-7).
  - `apps/api/test/integration/sessions-job.int.test.ts`: sweep fan-out, boot enqueue, window bounds, idempotency, gate drafts and the weekly email claim, draft retry, inline auto-enrol, pending reconciliation, failure classification, waiting-state signal (AC-ASYNC-1..6, AC-ERROR-9).
  - `apps/api/test/integration/sessions-races.int.test.ts`: R1-R14, T-17, T-18, T-19 and the `stately` trailing run with `lock-waiters.ts` (AC-VERIFY-3).
  - `apps/api/test/integration/sessions-contracts.int.test.ts`: C-SSE-1..5, C-SAE (R16), the port and the marker proof, gate-before-lock recorder (AC-INTEGRATION-1, AC-INTEGRATION-2, AC-VERIFY-2).
  - `apps/api/test/integration/sessions-logs.int.test.ts`: logged fields (AC-VERIFY-6).
  - `apps/web/src/lib/teams/sessions-view.test.ts`, `session-form-state.test.ts` and `sessions-actions.test.ts`: labels, sections, scope lines, copy deck, notices, counts; court and pricing reducer; action outcome mapping.
  - `apps/web/src/components/teams/session-components.test.tsx`: court table, costing and pricing fieldsets, deadline, DST choice, pattern fieldset, confirms, list, summary, refresh-while-pending.
  - `apps/web/src/components/teams/inline-confirm.test.tsx` (or cases in `manage-components.test.tsx`): `dismissLabel`, `children`, `ConfirmPanel`, no "Cancel" dismiss on Sessions confirms.
  - `apps/web/e2e/sessions.spec.ts`: the journey and axe scans (AC-INTEGRATION-3, AC-VERIFY-8).
- **New helpers and fixtures**:
  - `apps/api/test/fixtures/session-transitions.ts`: hand-written matrix and action rows.
  - `apps/api/test/helpers/sessions-scene.ts`: scenes plus the recording allocator double (`enrols` switchable).
  - `apps/api/test/helpers/query-recorder.ts`: Kysely `log` hook statement recorder.
- **Extend existing**:
  - `apps/web/src/lib/teams/manage-areas.test.ts`: new area (AC-ENTRY-1).
  - `apps/api/src/jobs/schedules.test.ts` and `registry.test.ts`: sweep wired, no placeholder, two new queues with their policies.
  - `apps/api/test/integration/db-codegen.int.test.ts` and `enum-parity.int.test.ts`: drift, if enums change.
  - `apps/api/test/helpers/factories.ts`: `insertSession` complete-fee defaults and `status`, `advanceSessionTo`, `insertRule`, `insertRuleCourt` (T-16).
  - `apps/api/test/helpers/app-deps.ts` and `worker-fixture.ts`: required `sessionAllocator`.
  - `apps/api/test/fixtures/paid-session-matrix.ts` (`publishable`) and `apps/api/test/integration/team-banking-gate.int.test.ts` (publish `publishable` rows, expect D-77 for the rest) (T-16).
  - skill-levels and banking integration tests: replace raw `DRAFT → COMPLETED` with `advanceSessionTo` (T-16).

### What NOT to Test
- `types.generated.ts`: checked by tsc and the codegen drift test.
- The publish gate's own rules and `isPaidSession`: covered by `team-banking-gate.int.test.ts`. Here we only test that every path calls the gate first.
- `selectAutoEnrollees` selection semantics: covered by skill-levels tests. Here we only test call order, serialisation and pass-through.
- `Money`/`time` primitives: covered by platform-foundation tests (vectors are reused, not re-proven).
- The real allocator, promotion and auto-enrol emails, and the widened D-85 predicate: registration-and-waitlist's.
- pg-boss internals and cron parsing: framework. Only the `stately` trailing-run behaviour this design relies on is pinned.
- Player notification: none exists (P-2); only its absence is asserted.

### Per-Phase Test Guidance
- Phase 1: about 30 tests.
  - Recurrence tables V1-V26 and E1-E5 under two `TZ` values, plus the property test.
  - Instance vectors T1-T5; costing C1-C13; reconciliation vectors and skip reasons.
  - The transition matrix fixture in TS (`lifecycle.ts`, `transitions.ts`).
  - The migration round trip, D-83 upgrade test, trigger order, 48 h parity.
  - Raw-SQL CHECK and trigger tests: anchor, monthly ordinal, template presence, C-SSE-1, rule fees, matrix, immutability incl. `session_courts`, DRAFT-only delete, version bump, `create_key`, D-85 raise refused and decrease allowed, `payout_notice_claims` uniqueness.
  - Zod strictness and field codes.
  - The existing tests fixed by T-16 pass unchanged in intent.
- Phase 2: about 30 tests.
  - Create (with `createKey` replay), edit and publish a one-off session (FLAT, BY_SEX, BY_SKILL); save-then-publish; free without confirm.
  - Gate refusal returns 409 and keeps the draft; publish refused for incomplete pricing, no courts, or a past start.
  - Capacity raise calls `promoteWaitlist` once after the lock; a cut demotes nobody; every edit and cancel refused after start.
  - Cancel leaves registrations and returns the count; material versus non-material change counts; no email enqueued.
  - Default deadline kept by the DB; explicit deadline kept or refused.
  - DST T6-T8 through the API.
  - Fee lock 409 with `raisedFields`; decreases accepted.
  - Stale save 409 with the current row on every write; no-op saves 200.
  - Every route 401/403; actor demotion → 403.
  - Publish enqueues one `session-auto-enrol` job; the handler enrols once with a recording double; `port_noop` with the no-op port.
  - Gate-before-lock recorder for the manual and create-and-publish paths.
- Phase 3: about 30 tests.
  - Series create enqueues `recurrence-rule` in the same tx; waiting signal from `materialised_version`.
  - Window bounds (today and today+H inclusive, started date skipped); instances exactly once under re-run and concurrent run; DST gap normalisation in the job.
  - Gate-refused instances become DRAFT; one email per rule per NZ week via `payout_notice_claims`.
  - Draft retry publishes after banking is set up and skips edited drafts; "Publish drafts now" enqueues once.
  - Inline auto-enrol after commit, R16 entries in order, none for DRAFTs, empty selection or re-runs; pending sessions reconciled by the sweep and at boot.
  - Instance edit sets overridden (no-op does not); series edit propagation with counts, `feeLocked` and deadline-passed skips, `promoteWaitlist` on capacity raise, whole-edit banking refusal; fixed pattern and shortening refused.
  - End series: deletes unedited drafts, keeps or cancels the rest.
  - One failing instance does not stop the run; transient versus permanent job outcome.
  - Gate-before-lock recorder for the materialiser, retry and series-propagation paths.
- Phase 4: about 22 tests.
  - Race matrix R1-R14 of AC-VERIFY-3 in both orders.
  - T-17: registration insert against a fee edit under the session lock.
  - T-18: two concurrent instance transactions for one rule and window enqueue exactly one email.
  - T-19: inline follow-up against the sweep job against a replayed job gives one call and one stamp.
  - The `stately` trailing-run test and the failure-into-retry case.
  - Log-field assertions for every AC-VERIFY-6 event; the contract test file with the marker proof; the allocator wiring and boundary tests.
- Phase 5: about 16 tests.
  - Manage-area entry and nav; list sections, labels, banking notice, paging and empty states.
  - Court table reducer: apply, count change, add, remove, focus targets, live text.
  - Rate follow and pin, pricing reveal and fill, locked pricing; deadline options; DST buttons; pattern fieldset (derived line, 4th-or-last, read-only after creation).
  - `InlineConfirm`/`ConfirmPanel` dismiss labels; cancel and End series prompt variants; read-only summaries; refresh-while-pending bounds; banking `returnTo` from the three pages.
- Phase 6: 1 Playwright journey (desktop and 360 px) with axe scans on the list, editor states, series page and form, plus the AC-INTEGRATION-1 contract header check and the coverage-gate update.

## Implementation Roadmap

### New Source Files (pin path + extension)
- [ ] `db/migrations/20261020000100000_session_scheduling.sql`: D-70..D-83 and D-85 (anchor and `monthly_week`, `recurring_rule_courts`, version stamps and bump trigger, `create_key`, `deadline_is_default` and its trigger, guard triggers, C-SSE-1 CHECKs, court uniqueness, content CHECKs, auto-enrol marker, `payout_notice_claims`, materialisation bookkeeping, dev-row cleanup, `game_session_has_active_registrations` and `game_sessions_fee_raise_locked`); reversible schema, documented trigger order
- [ ] `packages/shared/src/sessions/recurrence.ts`: pure `recurrenceDates`, `defaultMonthlyWeek`, `assertRecurrenceRule`
- [ ] `packages/shared/src/sessions/instance.ts`: pure `buildInstance`, `normaliseDerived` (DST gap rewrite)
- [ ] `packages/shared/src/sessions/reconcile.ts`: pure `planSeriesReconciliation`, `seriesChangeEffect`, End series plan
- [ ] `packages/shared/src/sessions/costing.ts`: `suggestedRate`, `finalFlatRate`, `defaultFeeOther`, `feeRaised`
- [ ] `packages/shared/src/sessions/lifecycle.ts`: `SESSION_TRANSITIONS`, `isTerminal`
- [ ] `packages/shared/src/sessions/index.ts`: barrel
- [ ] `packages/shared/src/api/sessions.ts`: zod request/response contracts, error and field codes, `dstOptions`
- [ ] `apps/api/src/modules/sessions/routes.ts`
- [ ] `apps/api/src/modules/sessions/service.ts`: one-off and instance use cases
- [ ] `apps/api/src/modules/sessions/series.ts`: series create, update with propagation, end, publish-drafts
- [ ] `apps/api/src/modules/sessions/repo.ts`
- [ ] `apps/api/src/modules/sessions/transitions.ts`: `decideSessionAction`
- [ ] `apps/api/src/modules/sessions/errors.ts`: `mapSessionDbError`, `classifySessionError`
- [ ] `apps/api/src/modules/sessions/allocator-port.ts`: `SessionAllocatorPort`, `noopSessionAllocator`
- [ ] `apps/api/src/modules/sessions/auto-enrol.ts`: `runSessionAutoEnrol`
- [ ] `apps/api/src/modules/sessions/locks.ts`: lock helpers and the advisory-lock namespace constant
- [ ] `apps/api/src/modules/sessions/tx.ts`: `runSessionTransaction`, `HTTP_POLICY`, `JOB_POLICY`
- [ ] `apps/api/src/modules/sessions/materialise.ts`: `materialiseRule`, instance transactions, draft retry, bookkeeping
- [ ] `apps/api/src/modules/sessions/boundaries.test.ts`
- [ ] `apps/api/src/jobs/recurrence-materialisation.ts`: sweep handler
- [ ] `apps/api/src/jobs/recurrence-rule.ts`: per-rule handler
- [ ] `apps/api/src/jobs/session-auto-enrol.ts`: per-session handler
- [ ] `apps/api/src/session-allocator.ts`: `createSessionAllocator`
- [ ] `apps/api/src/session-allocator.test.ts`
- [ ] `apps/api/test/fixtures/session-transitions.ts`
- [ ] `apps/api/test/helpers/sessions-scene.ts`: scenes plus the recording allocator double
- [ ] `apps/api/test/helpers/query-recorder.ts`
- [ ] `apps/web/src/lib/teams/sessions-view.ts`: labels, sections, scope lines, copy deck, notices, counts, `plural()`, formatters
- [ ] `apps/web/src/lib/teams/session-form-state.ts`: pure reducer for the controlled form
- [ ] `apps/web/src/lib/teams/sessions-actions.ts`: Server Actions and API error mapping
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
- [ ] `apps/web/src/components/teams/deadline-fieldset.tsx`
- [ ] `apps/web/src/components/teams/dst-choice.tsx`
- [ ] `apps/web/src/components/teams/pattern-fieldset.tsx`
- [ ] `apps/web/src/components/teams/session-list.tsx`
- [ ] `apps/web/src/components/teams/session-summary.tsx`
- [ ] `apps/web/src/components/teams/series-summary.tsx`
- [ ] `apps/web/src/components/teams/end-series-confirm.tsx`
- [ ] `apps/web/src/components/teams/refresh-while-pending.tsx`
- [ ] `apps/web/src/components/teams/use-session-form.ts`
- [ ] `docs/adr/0019-session-scheduling-engine.md`
- [ ] extend:
  - `apps/api/src/app.ts` (register module, required `AppDeps.sessionAllocator`)
  - `apps/api/src/main.ts` (`createSessionAllocator`)
  - `apps/api/src/worker.ts` (`createSessionAllocator`, boot enqueue of `recurrence-materialisation`)
  - `apps/api/src/cli.ts` (`jobs trigger recurrence-rule '<json>'`)
  - `apps/api/src/jobs/registry.ts` (`recurrence-rule` `stately`, `session-auto-enrol` `exclusive`), `schedules.ts`, `bootstrap.ts` (required `RegisterJobsOptions.sessionAllocator`)
  - `apps/api/src/lib/config/config.ts` (`RECURRENCE_HORIZON_DAYS`, `intInRange(7, 91, 28)`)
  - `apps/api/src/lib/http/errors.ts` (new codes)
  - `apps/api/src/lib/db/types.generated.ts` (regen)
  - `packages/shared/src/index.ts`
  - `apps/web/src/lib/teams/manage-areas.ts` (Sessions entry)
  - `apps/web/src/lib/teams/manage-view.ts` (`SectionId` adds `'sessions' | 'session' | 'series'`)
  - `apps/web/src/components/teams/inline-confirm.tsx` (`dismissLabel`, `children`, extracted `ConfirmPanel`, widened `SectionId`)
  - `apps/api/test/helpers/factories.ts` (`advanceSessionTo`, `insertRule`, `insertRuleCourt`, `insertSession` defaults), `app-deps.ts`, `worker-fixture.ts`
  - `apps/api/test/fixtures/paid-session-matrix.ts` (`publishable`), `apps/api/test/integration/team-banking-gate.int.test.ts`, skill-levels and banking integration tests (`advanceSessionTo`)
  - `db/schema-deviations.md` (D-70..D-85), `vitest.config.ts` (coverage include), `.env.example`, `docs/getting-started.md`
  - `memory-bank/systemPatterns.md` and `techContext.md` (Documentation agent)

### Phases
- [x] **Phase 1: Schema, shared core and fixture fixes.**
  - The migration (D-70..D-83, D-85); types regen; ledger rows.
  - Pure `recurrence`, `instance`, `reconcile`, `costing` and `lifecycle`; zod contracts; error codes; `transitions.ts` and the hand-written fixture.
  - Fix the tests the new CHECKs and matrix break, in the same commit (T-16): `publishable`, `advanceSessionTo`, `insertSession` defaults, `insertRule`/`insertRuleCourt`.
  - ACs: AC-VERIFY-1, AC-VERIFY-4, AC-VERIFY-5, AC-ERROR-6, AC-HAPPY-2 (pure half), AC-ERROR-2, AC-ERROR-4, AC-ERROR-5 and AC-ERROR-10 (DB halves).
  - Gate: migrate, rollback, migrate is identical; trigger order and 48 h parity asserted; vector tables pass; the existing suite is green.
- [x] **Phase 2: One-off sessions API, allocator seam and auto-enrol follow-up.**
  - `allocator-port.ts`, `session-allocator.ts` and its wiring in `main.ts`, `worker.ts`, `buildApp` and `registerJobs`; `locks.ts`, `tx.ts`; the query recorder.
  - Sessions module (routes, service, repo, errors): create with `createKey`, edit, save-then-publish through the gate, cancel with counts, capacity edit (C-SSE-3), default deadline, DST refusal, fee lock, `expectedVersion` on every write, actor re-check, policies.
  - Auto-enrol follow-up for API publishes (P-1 makes one-off publishes auto-enrol): `auto-enrol.ts`, the `session-auto-enrol` queue and `jobs/session-auto-enrol.ts`.
  - ACs: AC-HAPPY-1..4, 8, 9, 11, 13; AC-HAPPY-12 (manual paths); AC-ASYNC-2 (handler); AC-ERROR-1 (API), 3, 5, 7, 8, 10; AC-VERIFY-2 (manual paths); AC-VERIFY-9.
  - Gate: `sessions-api.int.test.ts` green; the recorder proves gate before lock on the manual paths; `session-allocator.test.ts` and `boundaries.test.ts` green.
- [x] **Phase 3: Series and materialiser.**
  - Series create, edit with synchronous propagation and counts (T-5), end (T-6), publish-drafts; fixed pattern (P-3); instance overrides.
  - The `recurrence-materialisation` sweep, the `recurrence-rule` queue and handler, `materialise.ts`: window, per-instance transactions, gate drafts, `payout_notice_claims` and the admin email, draft retry, inline auto-enrol, pending reconciliation, bookkeeping stamp; boot enqueue; CLI trigger.
  - ACs: AC-HAPPY-5, 6, 7, 10; AC-HAPPY-12 (materialiser path); AC-ASYNC-1..7; AC-ERROR-9, AC-ERROR-12; AC-VERIFY-2 (job and propagation paths); AC-INTEGRATION-2.
  - Gate: re-runs create nothing; one email per rule per NZ week; the recording double sees exactly one R16 call per session; a series edit reports the right counts.
- [x] **Phase 4: Concurrency, observability and contracts.**
  - Race matrix R1-R14, T-17, T-18, T-19 and the `stately` test; log fields; `sessions-contracts.int.test.ts` for registration's build gate, with the marker proof.
  - ACs: AC-VERIFY-3, AC-VERIFY-6, AC-INTEGRATION-1.
  - Gate: no `40P01` and no lock retry logged; every event's fields asserted; contract file header lists what registration re-checks.
- [x] **Phase 5: Admin web UI.**
  - Manage-area entry; list; one-off, instance and series editors; series page with waiting state, banking notices and End series; court table, costing, pricing, deadline, DST choice and pattern fieldsets; `InlineConfirm`/`ConfirmPanel` changes; read-only summaries; banking `returnTo` from three pages.
  - Build order: `session-form-state.ts` and `sessions-view.ts` first (pure, table-tested from the copy deck), then fieldsets, then forms and pages.
  - ACs: AC-ENTRY-1, AC-ENTRY-2, AC-HAPPY-14, AC-HAPPY-15, AC-ERROR-11, UI halves of AC-HAPPY-1..13, AC-ASYNC-3, AC-ASYNC-6, AC-ASYNC-7, AC-ERROR-1..5, 7, 10, 12.
  - Gate: component and view-model tests green; manual walk at 360 px with no horizontal scroll.
- [x] **Phase 6: End-to-end journey, accessibility, ADR and docs (final phase: complete entry-to-success flow).**
  - `sessions.spec.ts` covers the full admin journey from the manage nav through series creation, banking hand-off, "Publish drafts now", an edited instance, a series edit, a cancel, a one-off with DST and rate pinning, and End series, plus axe scans.
  - ADR 0019 from the ARCH outline: every contract honoured and offered, trigger order, advisory-lock namespace, registration hand-offs.
  - Coverage gate include; `.env.example` and getting-started docs.
  - ACs: AC-INTEGRATION-3, AC-VERIFY-7, AC-VERIFY-8.

**Build gate (before Phase 1)**:
- Creative is complete and BIND is the reference; read it plus the four design docs before Phase 1.
- Re-check that ADR 0019, the migration timestamp `20261020000100000` and ledger D-70..D-85 are still free on `main` against registration-and-waitlist's reservation (ADR 0018, D-62..D-66 plus its R2 index).
- Re-read registration-and-waitlist's C-SSE/C-SAE text and allocator signature at its current branch tip against the port in ARCH SA-4 (`promoteWaitlist(ctx, { teamId, sessionId })`, R16 `entries`).
- Grep every `UPDATE game_sessions SET status` and raw session insert in `apps/api/test/**` before writing the migration, so the T-16 fixes land in the Phase 1 commit.

## Creative Phases

- [x] **Algorithm Design** (required): A1-A5 and conflicts 2, 3, 5, 6, 10. Covers the Monthly meaning, rule anchor, horizon and publish lead time, series-edit propagation and override granularity, day/frequency/end changes, DST representable options, fee-edit policy, rate details. Output: `memory-bank/creative/session-scheduling-engine-recurrence-algorithm.md`
- [x] **Architecture Design** (required): B1-B5 and conflicts 1, 4, 8, 9. Covers materialiser shape and queueing, lock-order position of `recurring_session_rules`, the allocator port and the auto-enrol rollout gap, optimistic concurrency and replay safety, DB transition and immutability triggers with the TS twin, schema gap columns. Output: `memory-bank/creative/session-scheduling-engine-architecture.md`
- [x] **User Journey Design** (required): C2, C3 and conflict 3 from the admin's view. Covers series-versus-instance editing, the first-materialisation wait, telling players about changes or cancellations, one-off auto-enrol. Output: `memory-bank/creative/session-scheduling-engine-admin-user-journey.md`
- [x] **UI/UX Design** (required): C1, C4, C5. Covers the multi-court fast setup at desktop and 360 px, costing and pricing presentation, list grouping and "Ended" label, banking notice, read-only closed sessions. Output: `memory-bank/creative/session-scheduling-engine-uiux.md`
- [x] **Binding reconciliation** (wins over the four docs): `memory-bank/creative/session-scheduling-engine-binding-reconciliation.md`. It holds:
  - user rulings P-1 (Auto Enroll for every session), P-2 (no player emails; the admin sees the registered count) and P-3 (series pattern fixed);
  - orchestrator rulings T-1..T-16;
  - the wave 2 acceptance;
  - critique rulings T-17..T-20.

All creative phases are COMPLETE (2026-10-20). The task file was rewritten to match (T-20), and the taxonomy lint is CLEAN (48 ACs).

## Design Critique (advisory)

- **Backend**: codex (`adversarial-review --scope branch --base origin/main`), 2026-10-20
- **Verdict**: needs-attention. All four findings were resolved before CREATIVE_COMPLETE.
- **Summary**: the binding decisions hadn't reached the executable spec, one invariant depended on schema that doesn't exist yet, and two concurrency designs were unsafe or contradictory.
- **Findings**:
  1. [high] The spec still allowed Auto Enroll to be silently skipped. Fixed by T-20: the task file was rewritten with the follow-up auto-enrol, the D-80 marker, both queues and the sweep catch-up (AC-ASYNC-5).
  2. [high] The fee-lock trigger depended on registration columns that don't exist yet. Fixed by T-17: this feature ships `game_session_has_active_registrations` and the trigger as D-85, and registration widens it later.
  3. [high] The banking-email claim updated the rule row, which contradicted T-4. Fixed by T-18: a separate `payout_notice_claims` table.
  4. [medium] Concurrent runs could call the allocator twice. Fixed by T-19: a per-session advisory transaction lock, a re-read of the marker, and the stamp written in the same transaction.

---

## Execution State

**Build Status**: IDLE
**Current Phase**: COMPLETE
**Reflection Agent**: COMPLETE (2026-10-24) - Output: memory-bank/reflection/session-scheduling-engine-reflection.md (Task Quality: Good; Ecosystem: Moderately Effective)
**Auto-Build Mode**: YES
**Final Review Backend**: AUTO FINAL REVIEW BACKEND: codex — usable (2026-10-20; verdict: ready to merge with fixes — 0 Critical, 2 Important, 8 Minor)
**Current Build**: Phase 6: End-to-end journey, accessibility, ADR and docs (session-scheduling-engine) - COMPLETE
**Phase Number**: 6 of 6
**Is Multi-Phase**: YES
**Can Resume**: NO

### Current Build Step
**Step**: Step 11 - Git completion
**Status**: COMPLETE

### Completed Steps
- Build gate (2026-10-20): ADR 0019, migration 20261020000100000 and D-70..D-85 free on origin/main; registration C-SSE-1..5/C-SAE-1..2 and `promoteWaitlist(ctx, { teamId, sessionId })` re-read at origin/feature/registration-and-waitlist tip b8da4b6 (match ARCH SA-4); raw status updates/inserts in apps/api/test/** grepped and fixed (T-16)
- Step 0.5-2: COMPLETE
- Step 3 TDD (two parallel agents, disjoint files): 1A DB (28 integration tests, RED->GREEN), 1B shared core (195 unit tests, RED->GREEN)
- Step 7 verifier: PASS - unit 1396/1396, integration 465/465, build, lint, typecheck
- Step 8 code review: APPROVED, no blocking issues
- Phase 1 ACs covered: AC-VERIFY-1, AC-VERIFY-4, AC-VERIFY-5, AC-ERROR-6, AC-HAPPY-2 (pure), AC-ERROR-2, AC-ERROR-4/5/10 (DB halves)

- Phase 2 Step 3 TDD: 2A foundation (allocator port/wiring, locks, tx, recorder, AppError extras), 2B sessions API + auto-enrol; RED->GREEN both
- Phase 2 Step 7 verifier: PASS - unit 1459/1459, integration 514/514, build, lint, typecheck
- Phase 2 Step 8 code review (codex + anthropic): CHANGES_REQUIRED x2 blocking (edit PUBLISHED into passed start; malformed cursor 500), fixed via TDD; final unit 1459, integration 518/518, lint/typecheck clean
- Phase 2 ACs covered: AC-HAPPY-1..4, 8, 9, 11, 13; AC-HAPPY-12 (manual); AC-ASYNC-2 (handler); AC-ERROR-1 (API), 3, 5, 7, 8, 10; AC-VERIFY-2 (manual); AC-VERIFY-9
- Phase 3 Step 3 TDD (sequential): 3A materialiser/jobs (53 RED incl. 27 int), 3B series API (19 RED); GREEN both. Part A drafted code before tests; RED proven non-destructively on a `git archive HEAD` copy.
- Phase 3 Step 7 verifier: PASS - unit 1499/1499, integration 559/559, full build, lint, typecheck
- Phase 3 Step 8 code review (anthropic self-review; Codex launch failed: `timeout` missing on macOS): APPROVED, 0 blocking, 6 suggestions
- Phase 3 ACs covered: AC-HAPPY-5, 6, 7, 10; AC-HAPPY-12 (materialiser); AC-ASYNC-1..7; AC-ERROR-9, 12; AC-VERIFY-2 (job and propagation); AC-INTEGRATION-2

- Phase 4 Step 3 TDD (sequential): 4A races/hardening (46 tests: sessions-races 42, lock-order 3, bootstrap 1), 4B logs/contracts/parity (29 integration tests). New race tests are characterization tests, mutation-checked only for contracts/parity; RED proven for bootstrap, court-guard lock order, publishDrafts-ended, retryDraft-inactive, log renames.
- Phase 4 Step 7 verifier: PASS - unit 1503/1503 (one 5 s timeout in time.test.ts under concurrent load; rerun alone passes), integration 630/630, build, lint, typecheck
- Phase 4 Step 8 code review (anthropic; Codex not used - `timeout` missing on macOS): APPROVED, 0 blocking, 8 suggestions
- Phase 4 ACs covered: AC-VERIFY-3, AC-VERIFY-6, AC-INTEGRATION-1; AC-INTEGRATION-2 (gate-refused hand publish), AC-ASYNC-5 (T-19)

- Phase 5 Step 3 TDD (sequential): 5A API additions (seriesName, series name/instances/seriesChangeEffect/draft counts/isPayoutConfigured), 5B pure view models + fieldsets (212 tests), 5C actions, forms, five pages (222 tests); RED observed for each (5A integration tests first run after implementation).
- Phase 5 Step 7 verifier: PASS - unit 1938/1938, integration 633/633, build, lint, typecheck (full suites)
- Phase 5 Step 8 code review (anthropic; Codex not used - `timeout` missing on macOS): APPROVED, 0 blocking, 4 suggestions
- Phase 5 ACs covered (UI halves, component/view-model/static-markup tests only): AC-ENTRY-1, 2, AC-HAPPY-14, 15, AC-ERROR-11, AC-HAPPY-1..13, AC-ASYNC-3, 6, 7, AC-ERROR-1..5, 7, 10, 12. NO browser or 360 px walk was done; owed to Phase 6 Playwright/axe and /yay:uat.

- Phase 6 Step 3 (two agents, disjoint files): e2e TDD (apps/web/e2e/sessions.spec.ts, desktop + 360 px, axe, DB and Mailpit assertions, 3 product fixes with unit tests); documentation (ADR 0019, getting-started, coverage include, systemPatterns, techContext).
- Phase 6 Step 7 verifier: PASS - unit 1952/1952, integration 637/637, coverage gate (aggregate stmt 96.3 / branch 90.0), build, lint, typecheck, Playwright sessions.spec.ts 2/2 (desktop, mobile); re-run after prettier fix; spec re-run 2/2 after review tweaks.
- Phase 6 Step 8 code review (anthropic; Codex not used - `timeout` missing on macOS): APPROVED, 0 blocking; 3 suggestions applied (stale doc lines, config path, `/^Draft ·/` assertion).
- Phase 6 ACs covered: AC-INTEGRATION-3, AC-VERIFY-7 (ADR 0019), AC-VERIFY-8.
- BUILD_COMPLETE: all 6 phases done.

### Sub-Agents
- TDD 1A (migration, fixtures): COMPLETE
- TDD 1B (shared core): COMPLETE
- Verifier: COMPLETE (PASS)
- Code reviewer: COMPLETE (APPROVED)

### Guard & Recovery Log
(see commit guard result in phase commit message)

### Deviations
Carry-forward notes for Phase 2+ (from TDD agents and review, not blockers):
- Court-only edits do not bump `game_sessions.version` (D-72 exclusion of starts_at/ends_at); the service must bump `updated_at`/version explicitly when it edits courts.
- `deadline_is_default` has no auto-flip for raw writers; the service must write the flag with any explicit deadline.
- `advanceSessionTo` cannot yet walk PUBLISHED -> CANCELLED (LIFECYCLE_PATH); fix when a test needs it.
- `session_courts_guard_closed` locks sessions in unsorted [OLD, NEW] order (unlikely deadlock); sort ids if touched.
- Phase 2 `AppError`/handler must carry the extra fields of `SessionErrorResponse` (`dstOptions`, `raisedFields`, `current`).
- D-85 DB trigger alone is not a full guard under READ COMMITTED; Phase 2 session lock plus Phase 4 T-17 cover it.
- Binding T-10 wording ("any court time between 02:00 and 03:00") vs code/ALG ("wholly inside the gap"): code follows ALG; reconcile wording in ADR 0019.
- `apps/api/openapi.yaml` regenerated (error codes are diff-tested).
- Worktree has a gitignored `.env` from `scripts/setup.ts`.

Phase 1 | reviewer-accepted deviations:
- Phase 1 | apps/api/test/integration/sessions-schema.int.test.ts:921-960 | 48 h parity proven by behaviour (SQL default == defaultCancellationDeadline, exactly 2 days across DST, TS constant == 48), not by reading the interval literal.
- Phase 1 | packages/shared/src/api/sessions.ts | AC-ERROR-2 "session date in the past" is clock-relative (T-11 keeps it out of SQL); owed by the Phase 2 service (delivered: 422 `date`).

Phase 2 | reviewer-accepted deviations:
- Phase 2 | service.ts | Cancel on an already CANCELLED session is 409 `session_not_editable` (spec line 307, AC-ERROR-5) rather than an idempotent 200; replayed publish of PUBLISHED is 200.
- Phase 2 | routes | Another team's session id under your own team path is 404 `not_found` (no existence probe); AC-ERROR-8 401/403 applies to the team guard.
- Phase 2 | repo.ts | `activeRegistrationCount` is a TS read of registrations (CONFIRMED, WAITLISTED); registration's widening of the D-85 predicate must widen it too. Add to ADR 0019 hand-off list; consider a TS/SQL parity test in Phase 4.
- Phase 2 | service.ts | An explicit deadline is parked on the default with an extra UPDATE when an edit could trip the non-deferrable `deadline <= starts_at` CHECK; version may bump more than once on such edits.
- Phase 2 | content.ts | List rows carry endsAt and draftReason but no series name (rule table has no name column); revisit in Phase 3/5.
- Phase 2 | service.ts | Edit of a PUBLISHED session into a passed start refused with 409 `session_started` (review fix).
- Phase 2 | not delivered | CLI `jobs trigger session-auto-enrol` is not in TRIGGERABLE; non-blocking.
- Phase 2 | suggestions deferred | split service.ts (823 lines) per use case; double log on stale refusal; `as never` casts in repo.ts need a comment; spot-check openapi.yaml diff (8.7k lines) in the PR.
- Phase 2 | Phase 4 owes | T-17 registration-insert vs fee-edit race under the session lock; Phase 3 adds the `recurrence-rule` queue (bootstrap already accepts sessionAllocator).

Phase 2 | reviewer-accepted deviations (added at Phase 3 start):
- Phase 2 | reviewer-accepted | apps/api/src/modules/sessions/service.ts + routes.ts:40 | AC-ERROR-8 lists "an id that belongs to another team" among 401/403 cases; API answers 404 not_found (non-revealing). Literal departure - human to decide whether to align to 403.
- Phase 2 | reviewer-accepted | service.ts:~322 | `session.stale_refused` logged inside the tx callback; harmless because stale refusals are not retried.
- Phase 2 | DONE_WITH_CONCERNS | build-orchestrator | the two blocking review fixes (PUBLISHED edit into the past -> 409; malformed cursor -> 422) were not re-reviewed and `build` was not re-run after them (tests/lint/typecheck were). Phase 3 verifier ran the full build: PASS.

Phase 3 | reviewer-accepted deviations:
- Phase 3 | emails.ts:49 | AC-ASYNC-3 key `payout-missing:<ruleId>:<windowStart>` became `...:<recipientId>` so every admin is emailed (shared key would dedupe all but the first); claim row stays one per rule per NZ Monday. Update AC text.
- Phase 3 | materialise.ts:171-181 | AC-HAPPY-12: a newly materialised instance's auto-enrol runs inline after commit (BIND T-2 wins), not as an enqueued job in the publish tx; retried drafts do enqueue. Failure is swallowed; sweep/boot re-offers via the D-80 marker.
- Phase 3 | materialise-instance.ts | gate runs before the started-date clock check (one gate read for a started date, nothing created); a refused retry claims the weekly notice (can send the week's first email).
- Phase 3 | materialise.ts | `materialised_version` stamped even when failures are all permanent (clears the waiting state); only transient failure leaves it pending (interpretation of D-82).
- Phase 3 | errors | new 409 `series_ended` code (edit/end on an inactive series); confirm spec/openapi.
- Phase 3 | process | Part A TDD agent wrote implementation before tests; RED proven on a clean archive copy.
- Phase 3 | suggestions deferred | make `webBaseUrl` required in RegisterJobsOptions (bootstrap.ts localhost fallback); publishDrafts on an ended series should 409; retryDraft does not re-check rule active; series.ts is 708 lines (extract `propagate`); `as never` casts in series-repo.ts; stampBookkeeping outside per-date try/catch.
- Phase 3 | carry-forwards | list rows still carry no series name (rule table has no name column; Phase 5 decision); `seriesChangeEffect` not exposed on series GET (Phase 5); GateRequired rerun path untested (Phase 4 race test); `session_courts_guard_closed` unsorted lock order still open; `session.recurrence.*` spans not added; getting-started docs in Phase 6; Codex review pass not run.

Phase 3 | reviewer-accepted deviations (ledger, added at Phase 4 start):
- Phase 3 | reviewer-accepted | series.ts end() | AC-HAPPY-10 mentions a "partial failure" banner, but End series is one transaction (T-6) so there is no partial-failure response; Phase 5 must confirm the UI needs no such banner.
- Phase 3 | reviewer-accepted | emails.ts:49 | idempotency key `:<recipientId>` - AC-ASYNC-3 text should be updated to match.

Phase 4 Part B | log events (AC-VERIFY-6): series events renamed to `session.series.*` (and a stale series save to `session.stale_refused` with `ruleId`) so the AC and ARCH names hold; `version` event fields renamed `sessionVersion`/`ruleVersion` because they shadowed the logger's base service `version`; `series.updated` skip counts are `skippedEdited|Started|Closed|DeadlinePassed|FeeLocked`; `session.series.ended` gained `ruleVersion`. `sweep_completed` carries no `teamId` (cross-team sweep; human ruling 2026-10-20); `lock_retry*` carry `teamId` (remediation). No extra `session.recurrence.*` spans: the job wrapper's CONSUMER span covers sweep and rule runs.

Phase 4 | reviewer-accepted deviations:
- Phase 4 | migration | `session_courts_guard_closed` sorted lock order done by amending the unmerged Phase 1 migration (a forward migration broke four schema round-trip tests); dev/CI databases that applied the old body need `pnpm db:reset`. D-76 updated.
- Phase 4 | logging | series events renamed `session.series.*`; `version` field renamed `sessionVersion`/`ruleVersion` (it shadowed the logger's service `version`); `session.series.updated` logs `skipped*` counts; ARCH table updated. `teamId` is carried on `lock_retry*` (added in Phase 4 remediation: `SessionTxOptions.teamId`); `sweep_completed` keeps no `teamId` because it spans all teams - HUMAN RULING (user, 2026-10-20); AC-VERIFY-6 amended with the sweep carve-out.
- Phase 4 | reviewer-accepted | db/migrations/20261020000100000_session_scheduling.sql | session_courts_guard_closed fix amended in place on the unmerged migration; must remain a single in-place migration through merge; dev/CI DBs need `pnpm db:reset`.
- Phase 4 | spans | no `session.recurrence.*` child spans added: the job wrapper's CONSUMER span carries the trace; ARCH child spans (`instance`, `auto_enrol`, `publish`, `series.propagate`) not required by any AC.
- Phase 4 | suggestions deferred | openapi `publishTeamSeriesDrafts` description lacks 409 `series_ended`; `lockRuleInstances` (date,id) vs trigger (id) order theoretical, note in ADR 0019; `waitForLockWaiters` counts advisory-lock waiters (latent flake, filter by locktype); series.ts 716 lines (extract `propagate`); activeRegistrationCount is `countActiveRegistrations`.

- Phase 4 | DONE_WITH_CONCERNS | remediation 22002cd | teamId fix tests edited with the code (no observed RED); full suites not re-run after the Prettier fix (covered by Phase 5 verifier).

Phase 5 | decisions (carry-forwards from Phase 3/4 resolved):
- Phase 5 | series label | no schema column: shared `seriesName()` derives "Wednesdays at {location}" etc.; exposed as `seriesName` on SessionResponse and `name` on SeriesResponse (UJ copy deck).
- Phase 5 | seriesChangeEffect | exposed API-side on series GET `instances` (will_update|edited|closed|has_registrations; past-deadline maps to closed; fee-locked to has_registrations), with `isPayoutConfigured`, `bankingDrafts`, `editedDrafts`. `nextDate` omitted (not cheap); web hard-codes a 28-day horizon line.
- Phase 5 | AC-HAPPY-10 "partial failure" banner | not built: End series is one transaction (T-6), so the UI has no partial state. AC text should drop it.
- Phase 5 | cancelled/deletedDrafts on session.series.updated | not built: copy does not need them (series save never cancels or deletes; End response carries removedDrafts/cancelledPublished/activeRegistrationCount).
- Phase 5 | AC-ERROR-8 | cross-team id stays 404; UI treats 404 as not-found. Human still to decide on 403.
- Phase 5 | reviewer-accepted | seriesGroups on the list only shows series with a loaded date (no list-series endpoint); a freshly created, still-materialising series has no list row until its first date loads. "Nothing changed" is inferred from version equality.
- Phase 5 | reviewer-accepted | `apiFetch` now keeps `dstOptions`/`raisedFields` from error bodies; two extra notices `publish_incomplete`, `series_already_ended`; Number-of-courts defaults and some copy written where the deck was silent; copy-deck example "27 Sep 2026 is the 5th Sunday" is wrong (it is the 4th and last).
- Phase 5 | process | 5A integration tests first ran after implementation (unit RED observed); no browser/360 px/axe walk performed; unit tests are node-env static markup (no DOM), so focus/Escape/timers are untested until Phase 6.
- Phase 5 | suggestions deferred | note in sessions-paths.ts that helpers take validated UUIDs only; test for series_stale redirect with existing query; "showing first 100" line if instances cap can bite.
- Phase 4/5 | git | Phase 4 commits 2668987 and 22002cd were found on a detached HEAD, not on feature/session-scheduling-engine (branch and origin were still at dd13c74); branch moved to include them at Phase 5 commit and pushed.
- Phase 5 | HUMAN RULING 2026-10-20 | Phase 5 gate | manual 360 px walk deferred to Phase 6 Playwright (360 px viewport + no-horizontal-scroll assertion + axe) and later /yay:uat.
- Phase 5 | reviewer-accepted | AC-HAPPY-10 | no partial-failure banner (End series is one tx, T-6); AC text should drop it.
- Phase 5 | reviewer-accepted | session.series.updated | `cancelled`/`deletedDrafts` fields not built; copy does not use them.
- Phase 5 | reviewer-accepted | seriesName() derived, no schema column; series GET extras (seriesChangeEffect, isPayoutConfigured, bankingDrafts, editedDrafts); 'Nothing changed' inferred from version equality.
- Phase 5 | DONE_WITH_CONCERNS | 5A | API integration tests first run after implementation (no RED observed).
- Phase 5 remediation | resolved | AC-ENTRY-2, AC-ASYNC-6, AC-HAPPY-15 | supersedes the earlier "seriesGroups only shows series with a loaded date" acceptance: `GET /teams/:teamId/session-series` (TEAM_ADMIN, tenant-scoped, active first) returns `{ series: [{ id, name, startsOn, recurUntil, isActive, version, materialising }], horizonDays }` and the Sessions list renders the Series section from it with `seriesStatusLabel()`; `seriesGroups()` is removed. The "{n} upcoming" text still counts only dates on the loaded pages, so it shows only when above zero. Cross-team and non-admin: 403 on the list (admin of another team has no role here); a foreign rule id on the per-series routes stays 404.
- Phase 5 remediation | resolved | 12-factor | `horizonDays` (the API's `RECURRENCE_HORIZON_DAYS`, 7-91) is now on `SeriesResponse` and on the series list; the web constant `SERIES_HORIZON_DAYS` is deleted and `nextSeriesDate`/`horizonLine`/`SeriesForm` take it as a required argument. The new-series page reads it from the series list read (admin-guarded). `nextDate` not exposed (the web still derives it from the pattern and `horizonDays`). `buildApp` takes an optional `recurrenceHorizonDays` (default 28, wired from config in main.ts, same default the worker uses).
- Phase 5 remediation | resolved | copy deck | the 5th-weekday example is now "29 Nov 2026 is the 5th Sunday" in the UI/UX doc and the task plan (27 Sep 2026 is the 4th and last Sunday); the web tests already quoted 29 Nov.
- Phase 5 remediation | process | RED observed for the 4 new API integration tests (404/undefined before implementation) and 13 web tests; the two small `series-view.test.ts` unit tests (`horizonDays`, `toSeriesListItem`) were written alongside the code. Code review: Anthropic reviewer used (codex backend unusable here, `timeout` missing on macOS).

Phase 5 | reviewer-accepted deviations (added at Phase 6):
- Phase 5 | reviewer-accepted | apps/api/src/app.ts:73,210 | `recurrenceHorizonDays` optional in AppDeps, defaulting to 28; main.ts passes config. A future entrypoint that forgets it gets 28 silently - tidy-up candidate.
- Phase 5 | reviewer-accepted | sessions list + new-series pages throw if listSeries fails (fail-fast).
- Phase 5 | reviewer-accepted | series-repo.ts listRules unpaginated (per-team counts small).

Phase 6 | decisions and deviations:
- Phase 6 | product bugs found by the browser journey and fixed: (1) "Publish drafts now" sent a bodiless POST and the API returned 400 (`publishSeriesDrafts` now sends `{}`; API-side `.nullish()` is an optional follow-up); (2) first edit of a published date with a fee move showed bare "Changes saved." (savedNotice); (3) End series confirm defaulted "Last date" to today even when the first session is in the future (`defaultEndDate`). Fix tests written with the code; no RED observed.
- Phase 6 | not verified in a browser: screen reader, full Tab-order walk, moderate/minor axe impacts, confirming the publish panel, the series list "{n} upcoming" text; the End series panel and states other than those listed were scanned at the project viewport only (360 px walk: list, new session, new series, series page, series edit, published editor, read-only summary, draft editor, DST choice, publish/create/cancel confirms). Other e2e specs, not re-run.
- Phase 6 | e2e uses `docker compose pause worker` briefly to observe the waiting line, `E2E_DATABASE_URL` default is the compose dev DB.
- Phase 6 | coverage: branch coverage per file is below 80 on series-view.ts (79.6), series.ts (76.7), materialise-notice.ts (75.0), shared series-name.ts (66.7); the gate is aggregate so it passes. Follow-up candidate.
- Phase 6 | "showing first 100" line not added: SERIES_INSTANCE_LIMIT only bites after ~86 stacked past drafts.
- Phase 6 | open for the human: AC-ERROR-8 404-vs-403 (recorded in ADR 0019); AC text drift (AC-ASYNC-3 email key, AC-HAPPY-10 partial-failure banner).
- Phase 6 | stale notes: Phase 2 `session_courts_guard_closed` unsorted and CLI TRIGGERABLE notes are resolved in code.

### Resumption Notes
**Can Resume**: NO
**Resume From**: none (BUILD_COMPLETE); run /yay:reflect session-scheduling-engine
