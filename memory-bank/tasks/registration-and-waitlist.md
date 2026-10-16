---
slug: registration-and-waitlist
legacy_id:
feature: registration-and-waitlist
status: PLANNING_COMPLETE
---

# registration-and-waitlist: Registration and Waitlist

**Complexity**: Level 4 (inherited from registration-and-waitlist)
**Status**: PLANNING_COMPLETE
**Roadmap**: registration-and-waitlist
**Branch**: feature/registration-and-waitlist
**Worktree**: N/A (main checkout)

## Task Description

Registration, FIFO waitlist, debt control and cancellation rules (PRODDUCT-OVERVIEW §5, §6; workflows §1, §2).

- Public capacity = `max_players - reserved_seats`
- Up to 2 guests per registrant; the group is confirmed or waitlisted together
- FIFO waitlist with sequential `queue_position`; auto-promote when seats free up. Define how a group that doesn't fit is handled (skip or block).
- Debt gate: block registration when the user has 3 or more `OVERDUE` payments
- Cancellation: before the deadline → `WITHDRAWN`, $0, promote; after the deadline → `WITHDRAWN`. If someone is waitlisted, promote them and they take the fee; if not, charge the withdrawing player.
  - NOTE: the overview's §6 wording has the 48h windows reversed; the workflows doc (`NOW <= deadline` → free) is authoritative.
- Concurrency safety (row locks / serializable transactions) for seat allocation and promotion

**Depends on**: session-scheduling-engine (NOT yet built: no code creates or publishes `game_sessions`), team-management (merged in PR #4).

**Obligations inherited from team-management (ADR 0015, binding)**:
- Call `assertApprovedMember(trx, teamId, userId)` inside the registration transaction, before any `game_sessions` lock (lock order `teams → team_members → game_sessions → registrations`).
- Replace the no-op `MemberBannedHandler` with the real one: withdraw a banned member's CONFIRMED/WAITLISTED registrations in the team's future PUBLISHED sessions as an early withdrawal (no fee, no payment row), one session per transaction under the D-14 session lock, then normal FIFO promotion; no notification to the banned player; `NonRetryableJobError` for permanent failures.
- Ship the reconciliation sweep that re-enqueues `member-banned` for BANNED members who still hold active registrations (covers bans the no-op handled and permanently failed jobs).
- Restore cancellation wording in the ban confirmation once the real handler ships.

**Build gate**: `/yay:build` is held until session-scheduling-engine is merged (decision 2026-10-14: plan and creative now, build later).

## Specification

**Feature Type**: End-User Feature
**Primary Persona**: Player (`PLAYER`, an APPROVED member of the session's team) who registers for a session, optionally with up to two guests, joins the waitlist when it is full, and withdraws. Secondary: Team Admin (`TEAM_ADMIN`), whose ban now cancels the member's upcoming registrations; and the later features that consume this one's outputs: wallet-and-akahu-billing (which registrations to bill and for whom), skill-levels-and-auto-enroll and session-scheduling-engine (the shared seat allocator), player-dashboard (the registration read model).
**Creative Exploration Needed**: Yes (see the Creative Exploration Needed section below). These parts are LOW confidence: the rule for a waitlisted group that doesn't fit, fee semantics for late withdrawals and promotions after the deadline, and the invocation surface, which depends on pages session-scheduling-engine has not built. The concurrency design and the ban handler are MEDIUM, because ADR 0015 and ledger D-14 already fix most of them.

*Note: like team-management, this End-User spec also delivers cross-cutting infrastructure: the seat allocator that auto-enrol and capacity edits will call, the real ban handler, the reconciliation sweep, and the billing hand-off. Those structural checks are written as `AC-VERIFY`, `AC-ASYNC` and `AC-INTEGRATION` criteria.*

*Basis for this draft* (read from `main`, which contains platform-foundation, auth-and-user-roles and team-management):
- **Schema already present, no registration code.** `game_sessions` (`db/migrations/20260929000600000_game_sessions_and_courts.sql`) has `team_id NOT NULL`, `status session_status NOT NULL DEFAULT 'DRAFT'` (`DRAFT|PUBLISHED|COMPLETED|CANCELLED`), `cancellation_deadline timestamptz NOT NULL`, `max_players > 0`, `reserved_seats BETWEEN 0 AND max_players`, `pricing_structure` with `fee_flat`, `fee_male`, `fee_female`, `fee_other`, `fee_beginner`, `fee_intermediate` and `fee_advanced`, plus trigger-derived `starts_at`/`ends_at` (D-08), CHECK `cancellation_deadline <= starts_at` (D-09). `registrations` (`...000700000_registrations_and_guests.sql`) has `status registration_status` (`CONFIRMED|WAITLISTED|WITHDRAWN`), `guest_count NOT NULL 0..2` (D-12), `queue_position` set iff WAITLISTED and >= 1, partial unique `(session_id, queue_position) WHERE status = 'WAITLISTED'` (D-14), `UNIQUE(session_id, user_id)` (D-11), composite FK `(session_id, team_id) -> game_sessions(id, team_id)` (D-10). `registration_guests` has `position 1..2`, `sex user_sex NOT NULL`, `skill_level skill_tier NOT NULL`, optional `display_name varchar(100)`, and a deferred trigger that keeps `guest_count` equal to the guest rows (D-13). **There is no column for when or why a registration was withdrawn, and nothing records that a late withdrawer owes a fee.** This feature adds those columns (see AC-VERIFY-2).
- **D-14 locking contract (binding).** Every enqueue, withdraw and promote first runs `SELECT ... FROM game_sessions WHERE id = $1 FOR UPDATE`. Enqueue assigns `coalesce(max(queue_position), 0) + 1` over the session's WAITLISTED rows, and promotion takes the lowest position. Positions are never renumbered (ADR 0015 handler contract, point 2).
- **Payments cannot be written by this feature.** `payments` (`...000900000_payments_and_invoicing.sql`) requires `payment_link_token varchar(255) UNIQUE NOT NULL` (an Akahu link), `due_date NOT NULL`, the GST snapshot (`pricing_structure`, `gst_registered`, `gst_rate_bps`) and, at COMMIT, line items whose sum equals `amount`, with a registrant line at position 0 (`payment_lines_match_header`). `UNIQUE(registration_id)` is the idempotent billing key, and line items reference `registration_guests` `ON DELETE RESTRICT`. A payment can only be created by wallet-and-akahu-billing, which owns the Akahu link, the wallet decision and the GST snapshot (ADR 0012), at session end (workflows §3). The `OVERDUE` status (`payment_status` enum) is written only by billing's `daily-overdue` job, which today is a placeholder handler (`apps/api/src/jobs/schedules.ts`). Until billing ships, the debt gate counts zero in production, and tests create OVERDUE rows with `insertBilledRegistration`/`insertPayment` followed by `UPDATE payments SET status = 'OVERDUE'` (the immutability trigger allows a status change).
- **Skill levels.** Sessions carry **no skill restriction** (no min or max tier column). `skill_tier` is used only for `BY_SKILL_LEVEL` pricing. Registration therefore checks no skill eligibility. It only captures each guest's `sex` and `skill_level` (`NOT NULL`, needed later to price guests) and reads the registrant's `team_members.skill_level` (returned by `assertApprovedMember`) to show a fee estimate. Skill overrides and auto-progression (skill-levels-and-auto-enroll) are untouched.
- **Reused as is:** `assertApprovedMember(trx, teamId, userId)` (`apps/api/src/modules/teams/membership.ts`, `FOR SHARE`, returns `{ membershipId, role, skillLevel }`); `MemberBannedHandler`, `MemberBannedEvent`, `MemberBannedPayload`, `memberBannedSingletonKey` and `enqueueMemberBanned` (`apps/api/src/modules/teams/ban-hook.ts`); the `member-banned` job (`apps/api/src/jobs/member-banned.ts`, wired in `apps/api/src/jobs/bootstrap.ts` via `RegisterJobsOptions.memberBannedHandler`); `requireTeamRole('MEMBER')` (TEAM_ADMIN satisfies MEMBER, `apps/api/src/lib/auth/policy.ts`); `NonRetryableJobError`; `enqueueEmail(runner, message, { trx })` (`apps/api/src/jobs/send-email.ts`); `Clock`/`createManualClock` (`apps/api/src/lib/clock.ts`); `Money`/`MoneyString`/`formatNZD` (`packages/shared/src/money/money.ts`); `formatNzDateTime` (`packages/shared/src/time/time.ts`); `InlineConfirm` (`apps/web/src/components/teams/inline-confirm.tsx`); `OUTAGE_MESSAGE`, `banPrompt` (`apps/web/src/lib/teams/labels.ts`); test helpers `insertSession`, `insertRegistration`, `insertGuest`, `insertPayment`, `insertBilledRegistration`, `waitForLockWaiters`, `captureLogs`, `createTestDatabase`, `buildAuthTestApp`; the contract test `apps/api/test/integration/teams-ban-seam.int.test.ts`.
- **Document conflicts resolved here:** (1) the cancellation window follows workflows §2 (`now <= cancellation_deadline` is free), not PRODDUCT-OVERVIEW §6. (2) The waitlist starts when the **public capacity** (`max_players - reserved_seats`) is exhausted (workflows §1), not `max_players` (overview §5 wording). (3) The debt gate counts OVERDUE payments across **all** of the user's teams (workflows §1: `COUNT(payments WHERE status = 'OVERDUE' AND user_id = USER)`). (4) The `insertSession` factory creates a DRAFT session dated 2026-10-07 with `max_players 12`, so this feature adds a `insertPublishedSession` factory (status, date, court times, deadline, `max_players`, `reserved_seats` and fees as options).

**Assumed session-scheduling-engine outputs** (this feature consumes them; the build gate holds until they exist):
1. `game_sessions` rows reach `status = 'PUBLISHED'` only with at least one `session_courts` row (so `starts_at`/`ends_at` are set), `cancellation_deadline <= starts_at` (default `starts_at - 48h`, `defaultCancellationDeadline`), final `max_players` and `reserved_seats`, and a fee column filled for every party type of the session's `pricing_structure`: `fee_flat` for FLAT, all three of `fee_male`, `fee_female` and `fee_other` for BY_SEX (already a CHECK), and all three skill fees for BY_SKILL_LEVEL. For a FLAT session, **`fee_flat` holds the final per-player rate** (the admin-edited value, not `calculated_rate_per_player` or `custom_player_rate`). This must be confirmed with session-scheduling-engine (creative question 6).
2. Lifecycle `DRAFT -> PUBLISHED -> COMPLETED | CANCELLED`. Registration is open only while `status = 'PUBLISHED' AND now < starts_at`. Cancelling a session, and what happens to its registrations, belongs to session-scheduling-engine.
3. A player-facing session page that can host the registration panel. Assumed route: `/teams/[teamId]/sessions/[sessionId]`, reached from a team's list of upcoming sessions (and later from the player-dashboard "Currently Opening" tab). If session-scheduling-engine ships no player page, this feature ships that minimal page itself (LOW confidence).
4. Capacity edits on a PUBLISHED session (raising `max_players` or lowering `reserved_seats`) call this feature's exported `promoteWaitlist(trx, sessionId, now)` in the same transaction, under the D-14 lock. Lowering capacity never demotes a CONFIRMED registration.
5. The auto-enrol step of recurrence materialisation (workflows §4, skill-levels-and-auto-enroll) registers members through this feature's exported allocator (`registerInSession`), in auto-enrol assignment order, calling the gate first.

### Invocation Method
- **Location**: Web app (Next.js App Router).
  - **Session page** `/teams/[teamId]/sessions/[sessionId]` (protected; `proxy.ts` `PROTECTED` gains the `/teams/*/sessions/*` pattern, and the page calls `requireUser`). This feature owns a `RegistrationPanel` section (`apps/web/src/components/registrations/registration-panel.tsx`) on that page. The panel shows the session summary it needs (date and time, location, address, seats, fee, cancellation deadline), the caller's registration state, the register form and the withdraw action. If session-scheduling-engine ships no player page, this feature ships the minimal page: heading "{Location}, {Wed 7 Oct 2026}" plus the panel. **LOW confidence**, see creative question 5.
  - **Ban confirmation** in the existing manage area (`/teams/[teamId]/manage`, `banPrompt` in `apps/web/src/lib/teams/labels.ts`). The restored copy is in AC-HAPPY-10.
  - **API** (new Fastify module `apps/api/src/modules/registrations/{routes,service,repo,allocator,ban-handler,reconcile}.ts`, registered in `buildApp`; every route declares a policy, see AC-VERIFY-1; the team guard runs before validation; the service returns 404 `not_found` when `:sessionId` does not belong to `:teamId` or does not exist):
    - `GET /teams/:teamId/sessions/:sessionId/registration` (`requireTeamRole('MEMBER')`) returns `{ session: { id, teamId, location, address, startsAt, endsAt, cancellationDeadline, status, publicCapacity, seatsTaken, seatsLeft, waitlistLength, pricingStructure, fees }, me: { registration: null | { id, status, guestCount, guests: [{ position, sex, skillLevel, displayName }], waitlistRank, registeredAt, promotedAt, withdrawnAt, withdrawalKind, withdrawalFeeDue }, unitFee, estimatedTotal, overdueCount }, canRegister, blockedReason }`. Money is `MoneyString` and instants are ISO-8601 UTC. `waitlistRank` is `1 + count(WAITLISTED rows with a lower queue_position)`, never the raw `queue_position`.
    - `POST /teams/:teamId/sessions/:sessionId/registrations` (`requireTeamRole('MEMBER')`), strict body `{ guests: [{ sex, skillLevel, displayName? }] }` with 0 to 2 items, returns 201 `{ registration }` with `status` `CONFIRMED` or `WAITLISTED` and `waitlistRank`.
    - `POST /teams/:teamId/sessions/:sessionId/registrations/me/withdraw` (`requireTeamRole('MEMBER')`), strict body `{}`, returns 200 `{ registration: { status: 'WITHDRAWN', withdrawalKind, withdrawalFeeDue }, replacedBy: 'waitlist' | 'nobody', feeEstimate }`. `replacedBy` never names the promoted player.
    - COULD: `GET /teams/:teamId/sessions/:sessionId/registrations` (`requireTeamRole('TEAM_ADMIN')`) returns the roster `{ confirmed: [{ userId, fullName, guestCount, registeredAt }], waitlist: [{ userId, fullName, guestCount, waitlistRank }] }`, with no email and no guest names.
  - **Jobs**: the real `MemberBannedHandler` (`apps/api/src/modules/registrations/ban-handler.ts`, `name: 'registrations'`) injected in `apps/api/src/worker.ts` through `registerJobs({ memberBannedHandler })`. A new queue and cron slot `registration-ban-reconcile` (`apps/api/src/jobs/registry.ts`, `schedules.ts`, handler `apps/api/src/jobs/ban-reconcile.ts`), runnable on demand with `pnpm run jobs:trigger registration-ban-reconcile`. Promotion emails go through the existing `send-email` queue.
- **Element**: Panel copy and controls:
  - Seats line: "{seatsLeft} of {publicCapacity} places left", or "Full · {waitlistLength} on the waitlist".
  - Fee line: "Fee: {formatNZD(unitFee)} per person, charged after the game". For BY_SEX and BY_SKILL_LEVEL it reads "Your fee: {amount}" followed by "Guests are charged by their own sex/skill level".
  - Deadline line: "Free cancellation until {Wed 5 Oct, 7:00 pm}", or "The free cancellation deadline has passed."
  - Register form: a `fieldset` with legend "Bringing guests?" and radios "Just me" (preselected), "Me + 1 guest", "Me + 2 guests". For each guest, a `fieldset` with legend "Guest {n}" containing a "Sex" radio group (Male, Female, Other; none preselected), a "Skill level" radio group (Beginner, Intermediate, Advanced; none preselected) and the text field "Name (optional)". Below the fields, the line "Total: {estimatedTotal}". The submit button reads "Register" when the party fits the free seats and "Join waitlist" otherwise. The server decides the outcome.
  - Registered state: "You're in." (CONFIRMED), or "You're on the waitlist (#{waitlistRank}). We'll email you if a place opens up." (WAITLISTED). Buttons "Withdraw" (CONFIRMED) or "Leave waitlist" (WAITLISTED) open an `InlineConfirm` with "Withdraw" / "Leave waitlist" and "Cancel".
  - Withdrawn state: "You withdrew from this session." plus the fee outcome, and the register form again while the session is open.
  - Debt block: "You have {n} overdue payments. Pay them before registering for more sessions." The form is not rendered.
- **Visibility**: The panel is shown only to APPROVED members of the session's team (TEAM_ADMIN included) for a PUBLISHED session. The register form appears when the caller has no active registration, `now < starts_at`, `overdueCount < 3` and the party can ever fit (`1 + guests <= publicCapacity`). "Withdraw" and "Leave waitlist" appear only for an active registration before `starts_at`. After `starts_at`, the panel is read-only and shows "Registration is closed." The API is the real check in every case.
- **Navigation**: Signed-in player: header "My teams" -> `/teams` -> team row -> `/teams/[teamId]` -> upcoming session link (assumed, supplied by session-scheduling-engine) -> `/teams/[teamId]/sessions/[sessionId]` -> "Register". An anonymous visitor to the session URL is sent to `/login?returnTo=%2Fteams%2F<id>%2Fsessions%2F<id>` and returns to it after signing in. A promoted player follows the link in the promotion email to the same page. Later, the player-dashboard "Currently Opening" tab links to the same page.
- **Confidence**: API, allocator, locking, gate and ban handler: HIGH to MEDIUM (fixed by D-14 and ADR 0015, mirrors the teams module). Panel copy and form: MEDIUM. Session page location and the route to it: LOW (pending session-scheduling-engine). Fee semantics after the deadline: LOW (creative question 3).

### Success Criteria
- **User sees**:
  - After "Register" with free seats: "You're in." with seats updated to "{n-party} of {capacity} places left".
  - When full: "You're on the waitlist (#{rank}). We'll email you if a place opens up."
  - After an early "Withdraw": "You've withdrawn. You won't be charged."
  - After a late "Withdraw" when a waitlisted group is promoted: "You've withdrawn. A player from the waitlist took your place, so you won't be charged."
  - After a late "Withdraw" when nobody is promoted: "You've withdrawn. No one could take your place, so the {fee} fee will be charged after the game."
  - A promoted player receives an email "You're in: {Team name}, {Wed 7 Oct}" and sees "You're in." on the session page.
  - An admin who bans a member sees the restored confirmation (AC-HAPPY-10). The member's upcoming registrations become WITHDRAWN within 30 s while the worker runs.
- **Verifiable at**: the session page; the three API routes; the database rows below; `pgboss.job` for `send-email` (promotion), `member-banned` and `registration-ban-reconcile`; Mailpit in dev and CI; structured `registration.*` log events (AC-VERIFY-6).
- **Data persisted**:
  - `registrations`: `status`, `queue_position` (`max + 1` under the session lock; NULL unless WAITLISTED), `guest_count`, `registered_at` (reset when a withdrawn row registers again), `updated_at`, and new columns from one reversible migration (ledger D-47 onwards): `promoted_at timestamptz` (set on WAITLISTED -> CONFIRMED), `withdrawn_at timestamptz`, `withdrawal_kind` (new enum `withdrawal_kind`: `EARLY`, `LATE`, `BANNED`; set iff `status = 'WITHDRAWN'`) and `withdrawal_fee_due boolean NOT NULL DEFAULT false` (true only for `LATE` with nobody promoted; the billing hand-off).
  - `registration_guests`: `position`, `sex`, `skill_level`, `display_name`, replaced only when a withdrawn row registers again.
  - `send-email` jobs for promotions, and `member-banned` jobs re-enqueued by the sweep.
  - **No rows in `payments`, `payment_line_items`, `credit_transactions` or `player_credits`** (AC-VERIFY-10).
- **Observable within**: Immediate for register, withdraw and promotion caused by a withdrawal (all one transaction). A promotion email is enqueued in the promoting transaction and delivered by the worker within 30 s. A ban's registration cancellation is eventual: within 30 s while the worker runs, at most one daily sweep later if a job failed permanently or ran the no-op.

**Billing boundary (binding for wallet-and-akahu-billing).** This feature records liability and writes no money rows. At session end, billing must bill exactly the set returned by the exported `listBillableRegistrations(db, sessionId)` (`apps/api/src/modules/registrations/billing-handoff.ts`):
- (a) every `CONFIRMED` registration, which includes players promoted after the deadline: that is how "the promoted player takes the fee" happens, with nothing written at promotion time;
- (b) every `WITHDRAWN` registration with `withdrawal_fee_due = true`, billed to the withdrawing registrant for the whole party.

Billing computes the fee at charge time from the session's fee columns (registrant: `users.sex`, `team_members.skill_level`; guests: `registration_guests`) and writes the snapshot, line items, wallet deduction or Akahu link per ADR 0012. Ban withdrawals (`BANNED`) and early withdrawals are never billed. Registrations and guest rows are never deleted by this feature, because billing's line items RESTRICT them. Both features read the debt gate's `OVERDUE` status, but only billing writes it.

### Acceptance Criteria

**Entry points**

#### AC-ENTRY-1: An approved member finds the registration panel on a published session's page
**Priority**: MUST
**Given** an APPROVED member of team T and a PUBLISHED session S of T that starts in the future (fixture `insertPublishedSession`)
**When** they open `/teams/[T]/sessions/[S]` (or are returned there after sign-in from `/login?returnTo=...`)
**Then** the page shows the seats line, fee line, deadline line and the register form with "Bringing guests?" ("Just me" preselected) and a "Register" button, all keyboard-reachable. `GET /teams/[T]/sessions/[S]/registration` answers 200 with `me.registration: null` and `canRegister: true`

#### AC-ENTRY-2: Non-members, banned, pending and cross-team callers never see the panel
**Priority**: MUST
**Given** callers who are anonymous, a non-member, PENDING, REJECTED or BANNED in T, an admin of another team, and a GLOBAL_ADMIN who is not a member
**When** they call any registration route of T or open the session page
**Then** the anonymous caller gets 401 (the page redirects to `/login?returnTo=...`). Every other caller gets 403 `forbidden` before body validation (never a 422), and the page shows "You need to be a member of this team to register." with no form. A `:sessionId` of another team, a DRAFT session's id or an unknown id under T returns 404 `not_found` with an identical body

#### AC-ENTRY-3: A registered player finds how to withdraw or leave the waitlist
**Priority**: MUST
**Given** a player with a CONFIRMED (and separately a WAITLISTED) registration for S, before `starts_at`
**When** they open the session page
**Then** they see "You're in." with a "Withdraw" button (or "You're on the waitlist (#{rank})..." with "Leave waitlist"), the deadline line, and no register form. Activating the button opens an inline confirmation (never a native dialog) whose text depends on the deadline (AC-HAPPY-4, AC-HAPPY-6)

**Happy paths**

#### AC-HAPPY-1: A player registers alone and gets a seat
**Priority**: MUST
**Given** S with `max_players 12`, `reserved_seats 2` (public capacity 10), 7 seats taken by CONFIRMED parties, FLAT `fee_flat 17.00`, and a member with 0 OVERDUE payments
**When** they keep "Just me" and click "Register"
**Then** `POST .../registrations` returns 201. One `registrations` row exists with `status 'CONFIRMED'`, `guest_count 0`, `queue_position NULL`, `team_id = T`, and there are no guest rows. The page shows "You're in." and "2 of 10 places left"

#### AC-HAPPY-2: A player registers with two guests and the whole group is confirmed together
**Priority**: MUST
**Given** S with public capacity 10 and 7 seats taken
**When** the player picks "Me + 2 guests", fills Guest 1 (Female, Intermediate, "Ana") and Guest 2 (Male, Beginner, no name), and clicks "Register"
**Then** in one transaction the registration is `CONFIRMED` with `guest_count 2`, and `registration_guests` has positions 1 and 2 with those sex and skill values (`display_name 'Ana'` and NULL). Seats taken become 10, so the page shows "Full · 0 on the waitlist" to the next visitor. The "Total" line showed `$51.00` (3 x $17.00) before submit

#### AC-HAPPY-3: A group that doesn't fit the free seats is waitlisted whole, never split
**Priority**: MUST
**Given** S with public capacity 10, 9 seats taken, and 2 existing WAITLISTED registrations at positions 1 and 2
**When** a player registers with 1 guest (party of 2)
**Then** the registration is `WAITLISTED` with `queue_position 3` (= `max + 1` under the session lock), `guest_count 1` and its guest row, and no seat is taken by any member of the party. The response and page show "You're on the waitlist (#3). We'll email you if a place opens up." A later registrant gets position 4

#### AC-HAPPY-4: Early withdrawal is free and promotes the waitlist in FIFO order
**Priority**: MUST
**Given** S full (10/10) with WAITLISTED parties A (position 1, party 1) and B (position 2, party 1), an injected clock at `now <= cancellation_deadline` (including `now == cancellation_deadline` exactly), and a CONFIRMED player P with party 1
**When** P clicks "Withdraw" and confirms "Withdraw from this session? You won't be charged."
**Then** in one transaction under the D-14 lock P's row becomes `status 'WITHDRAWN'`, `withdrawal_kind 'EARLY'`, `withdrawal_fee_due false`, `withdrawn_at = now`, `queue_position NULL`. A becomes `CONFIRMED` with `queue_position NULL` and `promoted_at = now`. B stays WAITLISTED at position 2 (not renumbered) and its displayed rank becomes 1. A `send-email` job for A is enqueued in the same transaction (AC-ASYNC-1). P sees "You've withdrawn. You won't be charged."

#### AC-HAPPY-5: Late withdrawal with a waitlist transfers the fee to the promoted player
**Priority**: MUST
**Given** the same S, with the injected clock 1 ms after `cancellation_deadline` and before `starts_at`
**When** P withdraws after confirming "The free cancellation deadline has passed. If a waitlisted player takes your place you won't be charged. Otherwise you'll be charged {fee}."
**Then** P's row is `WITHDRAWN`, `withdrawal_kind 'LATE'`, `withdrawal_fee_due false`. A is promoted to `CONFIRMED` exactly as in AC-HAPPY-4, and A's email states the deadline has passed (AC-ASYNC-1). `listBillableRegistrations(S)` contains A and not P. No payment row is written. P sees "You've withdrawn. A player from the waitlist took your place, so you won't be charged."

#### AC-HAPPY-6: Late withdrawal with nobody to promote leaves the withdrawing player liable
**Priority**: MUST
**Given** S after the deadline with a CONFIRMED player P (party 3: P plus 2 guests) and either an empty waitlist or only waitlisted parties larger than the seats P frees (see AC-HAPPY-9)
**When** P withdraws
**Then** P's row is `WITHDRAWN`, `withdrawal_kind 'LATE'`, `withdrawal_fee_due true`, and P's guest rows are kept. No registration is promoted and no payment row is written. `listBillableRegistrations(S)` contains P's registration (party of 3). P sees "You've withdrawn. No one could take your place, so the $51.00 fee will be charged after the game." (the estimate from the session's fees; billing computes the final amount)

#### AC-HAPPY-7: Leaving the waitlist is always free and keeps everyone else's order
**Priority**: MUST
**Given** WAITLISTED parties at positions 1, 2 and 3, before or after the deadline
**When** the player at position 2 clicks "Leave waitlist" and confirms "Leave the waitlist?"
**Then** their row is `WITHDRAWN` with `queue_position NULL`, `withdrawal_fee_due false` and `withdrawal_kind` `EARLY` or `LATE` by the clock. Positions 1 and 3 are unchanged in the database, the third party's displayed rank becomes 2, and nobody is promoted (no seat was freed). The page shows "You've left the waitlist."

#### AC-HAPPY-8: A player who withdrew can register again
**Priority**: SHOULD
**Given** a player whose registration for S is `WITHDRAWN` (EARLY or LATE, with or without `withdrawal_fee_due`), before `starts_at`
**When** they register again (with a different guest count)
**Then** the same row (`UNIQUE(session_id, user_id)`, no second row) becomes `CONFIRMED` or `WAITLISTED` with a new `queue_position = max + 1` when waitlisted, a fresh `registered_at`, `withdrawn_at`, `withdrawal_kind` and `promoted_at` cleared, and `withdrawal_fee_due` reset to false. The old guest rows are replaced by the new ones in the same transaction (the guest-count trigger passes at COMMIT)

#### AC-HAPPY-9: When the head of the waitlist doesn't fit, the first group that fits is promoted (default rule, creative question 1)
**Priority**: MUST
**Given** S full with one free seat about to open, and WAITLISTED parties A (position 1, party 3), B (position 2, party 1), C (position 3, party 1)
**When** a CONFIRMED party of 1 withdraws (freeing 1 seat)
**Then** under the default **first-fit** rule A stays at position 1 (still head of the queue), B is promoted, C is untouched, and seats taken equal public capacity again. When a later withdrawal frees 3 or more seats, A is offered them before any party behind it. After every register, withdraw, promotion or ban withdrawal, the invariant holds: **no WAITLISTED party fits the free seats** (AC-VERIFY-4). If creative chooses the **block** rule instead, this AC is replaced by: nobody is promoted until A fits, and a new registrant is waitlisted whenever the waitlist is non-empty

#### AC-HAPPY-10: A ban cancels the member's upcoming registrations and the confirmation says so
**Priority**: MUST
**Given** an APPROVED member M of T with a CONFIRMED registration in future PUBLISHED session S1 (full, with a waitlisted party W), a WAITLISTED registration in future session S2, and a CONFIRMED registration in a session S0 that has already started
**When** an admin opens "Ban" in `/teams/[T]/manage`, sees the restored prompt "Ban {Full name}? They lose access to this team and can't register for its sessions. Their upcoming registrations will be cancelled." and confirms "Ban member"
**Then** the ban commits as before (team-management AC-HAPPY-11). Within 30 s the real handler makes M's S1 and S2 rows `WITHDRAWN` with `withdrawal_kind 'BANNED'` and `withdrawal_fee_due false` (even when past the deadline) and promotes W in S1 (W gets the promotion email). M's S0 row is untouched, no payment row is written, and M receives no email. `banPrompt` in `apps/web/src/lib/teams/labels.ts`, its unit tests, `manage-components.test.tsx` and `apps/web/e2e/teams.spec.ts` carry the new wording

**Errors and recovery**

#### AC-ERROR-1: Three or more overdue payments block registration with a clear way out
**Priority**: MUST
**Given** a member with 3 payments in `status 'OVERDUE'` (in any team, created in tests with `insertBilledRegistration` and `UPDATE ... SET status = 'OVERDUE'`), and separately a member with exactly 2 OVERDUE plus any number of `PENDING`, `PAID` or `FAILED`
**When** each opens the session page and calls `POST .../registrations`
**Then** the first gets 403 `overdue_payments` ("You have 3 overdue payments. Pay them before registering for more sessions."), no `registrations` or guest row is written, the page shows that message instead of the form, and `GET .../registration` returns `overdueCount 3`, `canRegister false`, `blockedReason 'overdue_payments'`. The second registers normally (the gate is `>= 3` OVERDUE only). Withdrawing is never blocked by debt

#### AC-ERROR-2: Registration is refused for sessions that are not open
**Priority**: MUST
**Given** sessions of T that are `COMPLETED`, `CANCELLED`, or `PUBLISHED` with `now >= starts_at` (injected clock)
**When** a member registers, or withdraws an active registration
**Then** the API returns 409 `session_not_open` ("Registration for this session is closed."), nothing changes, and the page shows "Registration is closed." with no form or withdraw button. A DRAFT session is 404 (AC-ENTRY-2). Registering after the cancellation deadline but before `starts_at` is allowed, and the panel then shows "The free cancellation deadline has passed. If you withdraw later you may be charged." above the button

#### AC-ERROR-3: Double submits and second tabs never make a second registration
**Priority**: MUST
**Given** a member with an active (CONFIRMED or WAITLISTED) registration for S, and separately two concurrent first-time submits from the same member
**When** they submit "Register" again
**Then** the API returns 409 `already_registered` ("You're already registered for this session."), exactly one row exists, no queue position is consumed, and the page shows the current state instead of the form. Of two concurrent submits, exactly one commits and the other gets 409 (serialised by the session lock, backstopped by `uq_registrations_session_user`)

#### AC-ERROR-4: A party that can never fit is refused instead of waitlisted forever
**Priority**: MUST
**Given** S with public capacity 2 (or 0 because `reserved_seats = max_players`)
**When** a member registers with 2 guests (party 3)
**Then** the API returns 422 `party_exceeds_capacity` ("This session has {capacity} public places, so a group of {party} can't register."), nothing is written, and the form keeps the chosen guests. The "Me + 2 guests" option is `aria-disabled` with that hint when the party can never fit

#### AC-ERROR-5: Invalid guest details name the field and keep what was typed
**Priority**: MUST
**Given** the register form with 1 or 2 guests
**When** a guest's sex or skill level is missing ("Choose Guest {n}'s sex." / "Choose Guest {n}'s skill level."), a name is over 100 characters ("Use 100 characters or fewer."), or a direct API call sends 3 guests, an unknown field (`status`, `queuePosition`, `userId`, `teamId`) or a bad enum value
**Then** the API returns 422 `validation_failed` with `fieldErrors` keyed `guests.{i}.sex`/`guests.{i}.skillLevel`/`guests.{i}.displayName`, each message appears beside its field and in the error summary (`aria-describedby`), typed values stay, and nothing is written. The display name is trimmed, and an empty name is stored as NULL

#### AC-ERROR-6: Withdrawing without an active registration is refused, not repeated
**Priority**: MUST
**Given** a member with no registration for S, or a `WITHDRAWN` one (including a second click or a second tab after a withdrawal committed)
**When** they call `POST .../registrations/me/withdraw`
**Then** the API returns 409 `not_registered` ("You're not registered for this session."). Nothing changes: no second promotion, no change to `withdrawal_fee_due` or `withdrawn_at`. The page reloads to the current state

#### AC-ERROR-7: Losing membership between page load and submit is refused inside the transaction
**Priority**: MUST
**Given** a member whose row is banned after the page rendered (the route guard passed, then a ban committed, or a ban is in flight holding the row)
**When** the registration transaction runs `assertApprovedMember` (before the session lock)
**Then** it throws `forbidden`, the API answers 403 `forbidden`, no row is written, and the page shows "You need to be a member of this team to register." A ban in flight makes the gate wait and then refuse (proven in AC-INTEGRATION-2)

#### AC-ERROR-8: An unavailable API never half-applies and keeps the form
**Priority**: MUST
**Given** a player on the session page
**When** the API is unreachable, times out or answers 5xx on register or withdraw
**Then** the page shows `OUTAGE_MESSAGE` ("Something went wrong on our side. Your details are still here. Try again in a minute."), keeps the guest choices and typed names, changes no displayed state optimistically, and doesn't sign the user out. A retried request that committed earlier is answered by AC-ERROR-3 or AC-ERROR-6, never by a duplicate

#### AC-ERROR-9: A failing ban handler never undoes the ban and is visible to operators
**Priority**: MUST
**Given** the real handler hits a transient error (for example, a lock timeout) on one session, and in another run a permanent error (a registration row that violates an invariant)
**When** the `member-banned` job runs
**Then** sessions already processed stay committed (one transaction per session), the transient error is rethrown and retried by the queue's backoff, and a permanent error is thrown as `NonRetryableJobError`, ending in `failed` with `team.member.banned.hook_failed` (`hook: 'registrations'`, ids only). The ban stays committed. The next daily sweep (AC-ASYNC-3) re-enqueues the job while the member still holds an active registration

**Async behaviour**

#### AC-ASYNC-1: Every promotion emails the promoted player, committed with the promotion (P5)
**Priority**: MUST
**Given** any promotion (from a withdrawal, a ban withdrawal, or `promoteWaitlist` called by a capacity change)
**When** the promoting transaction commits
**Then** a `send-email` job for each promoted registrant exists, enqueued with `enqueueEmail(runner, message, { trx })` in that transaction. A rolled-back promotion leaves no job. The `idempotencyKey` is `registration-promoted:<registrationId>:<promoted_at epoch ms>`, so a replay sends once per promotion. The subject is "You're in: {Team name}, {Wed 7 Oct}" and the body includes the time, location, address, a link to the session page, the fee per person and either "Free cancellation until {deadline}." or "The free cancellation deadline has passed. If you can't play, withdraw on the session page: you won't be charged if someone from the waitlist takes your place, otherwise the fee applies." Nobody is emailed about their own register or withdraw (the page tells them), and a banned member is never emailed

#### AC-ASYNC-2: The real ban handler replaces the no-op and follows the ADR 0015 contract
**Priority**: MUST
**Given** `apps/api/src/worker.ts` calls `registerJobs({ ..., memberBannedHandler: createRegistrationsBanHandler({ db, jobs, clock }) })` (the no-op stays only as the `registerJobs` default for tests)
**When** a `member-banned` job is delivered once, then redelivered
**Then** the handler selects by current state: the registrations with `team_id = event.teamId AND user_id = event.userId AND status IN ('CONFIRMED','WAITLISTED')` in sessions with `status = 'PUBLISHED' AND starts_at > now`. It processes one session per transaction in `(starts_at, id)` order, each starting with `SELECT ... FROM game_sessions WHERE id = $1 FOR UPDATE`, then a guarded `UPDATE ... WHERE id = $r AND status IN ('CONFIRMED','WAITLISTED')`, then `withdrawal_kind 'BANNED'` and early semantics (no fee), then the standard promotion and its emails. It never writes `team_members`, never reads `ban_reason`, and logs `team.member.banned.handled` with `affected = n`. The redelivery returns `{ affected: 0 }` and changes nothing

#### AC-ASYNC-3: A daily reconciliation sweep closes the no-op window and failed jobs
**Priority**: MUST
**Given** a BANNED membership whose registrations are still active in future PUBLISHED sessions of its team (because the ban ran the no-op handler before this feature deployed, or its job failed permanently), and another BANNED membership with nothing active
**When** the `registration-ban-reconcile` slot fires (cron `30 5 * * *`, `Pacific/Auckland`, outside the 02:00-02:59 DST window and after `auth-cleanup` at 05:00; queue `exclusive`) or an operator runs `pnpm run jobs:trigger registration-ban-reconcile`
**Then** it enqueues exactly one `member-banned` job for the first membership, with the payload rebuilt from the `team_members` row (`teamId`, `userId`, `membershipId`, `bannedBy = banned_by`, `bannedAt = banned_at`) and `singletonKey member-banned:<membershipId>` (a job already queued is not duplicated), and none for the second. It logs `registration.ban_reconcile.completed` with `enqueued` and `scanned` counts and no PII. Once that job runs, a second sweep enqueues nothing

#### AC-ASYNC-4: A waitlisted player sees their promotion without doing anything
**Priority**: MUST
**Given** a WAITLISTED player who has the session page open, and is then promoted by someone else's withdrawal or a ban
**When** they reload the page or follow the link in the email
**Then** the page shows "You're in." and "You were moved off the waitlist on {date, time}." (from `promoted_at`), with the "Withdraw" action and the deadline line. The registration is in `listBillableRegistrations` from that moment

**Structural, security and grounded checks**

#### AC-VERIFY-1: Every registration route has an explicit policy and the expected one
**Priority**: MUST
**Given** the fully built Fastify app
**When** a test enumerates `listRoutePolicies(app)` for the registration routes
**Then** `GET /teams/:teamId/sessions/:sessionId/registration`, `POST /teams/:teamId/sessions/:sessionId/registrations` and `POST /teams/:teamId/sessions/:sessionId/registrations/me/withdraw` are `teamRole('MEMBER')` with `allowGlobalAdmin: false`. The roster route, if built, is `teamRole('TEAM_ADMIN')`. No registration route is `public` or `optionalSession`, and `:sessionId` is always resolved together with `:teamId` (never by session id alone)

#### AC-VERIFY-2: Registration invariants are enforced by the database, reversibly and ledgered
**Priority**: MUST
**Given** one new migration `db/migrations/<utc-timestamp>_registration_lifecycle.sql`
**When** `pnpm run test:integration` runs
**Then** the migrate, `rollback --all`, migrate round trip is identical, `db/schema-deviations.md` has D-47 onwards (each with a Source) for every new object, `types.generated.ts` matches codegen, and the enum-parity test covers the new `withdrawal_kind` enum (mirrored in `packages/shared/src/types/enums.ts`). Raw SQL proves each rule:
- `withdrawn_at` and `withdrawal_kind` are set iff `status = 'WITHDRAWN'` (23514).
- `withdrawal_fee_due` implies `status = 'WITHDRAWN' AND withdrawal_kind = 'LATE'` (23514).
- `promoted_at` is NULL while WAITLISTED (23514).
- A `BEFORE UPDATE` trigger allows only `WAITLISTED -> CONFIRMED`, `CONFIRMED|WAITLISTED -> WITHDRAWN` and `WITHDRAWN -> CONFIRMED|WAITLISTED`, so `CONFIRMED -> WAITLISTED` (a demotion) fails with 23000. `session_id`, `team_id` and `user_id` are immutable (23000).
- A capacity backstop refuses a COMMIT in which a session's CONFIRMED parties exceed `max_players - reserved_seats` (23514 `registrations_within_capacity`), checked only when registrations change, so a later admin capacity cut is not blocked.
- A pure TypeScript transition table (`modules/registrations/transitions.ts`) mirrors the trigger, kept aligned by one shared matrix fixture (team-management pattern).

#### AC-VERIFY-3: Every seat-changing path follows the canonical lock order and the D-14 contract
**Priority**: MUST
**Given** the register, withdraw, `promoteWaitlist`, ban-handler and auto-enrol entry points (all through `modules/registrations/allocator.ts`)
**When** their SQL is traced in an integration test (pg statement log or a lock-waiter probe via `waitForLockWaiters`)
**Then** each transaction runs, in order:
1. the debt-count read (no lock), register only;
2. `assertApprovedMember` (`team_members FOR SHARE`), register and auto-enrol only, before any session lock;
3. `SELECT ... FROM game_sessions WHERE id = $1 FOR UPDATE`;
4. the `registrations` reads and writes;
5. `registration_guests`.

Enqueue uses `coalesce(max(queue_position), 0) + 1` and promotion scans WAITLISTED rows by ascending `queue_position`. No path takes locks out of this order, uses `SERIALIZABLE` or an advisory lock, or renumbers positions. The transaction reads the clock once (`clock.now()`) and passes that value down (learned rule: testing-injected-clock)

#### AC-VERIFY-4: Seat accounting is exact and the waitlist invariant always holds
**Priority**: MUST
**Given** a pure allocator `decideAllocation({ publicCapacity, confirmedParties, waitlist, request })` (unit-tested, table-driven) and the integration paths that call it
**When** any sequence of registers, withdrawals, ban withdrawals and capacity raises is applied (property test over random sequences, plus fixed cases)
**Then** after each committed step:
- seats taken = `Σ (1 + guest_count)` over CONFIRMED rows, and never exceeds `max_players - reserved_seats`;
- no party is ever split;
- WAITLISTED positions are unique and strictly increasing in registration order;
- under the default first-fit rule, no WAITLISTED party fits the free seats;
- `seatsLeft`, `waitlistLength` and `waitlistRank` returned by `GET .../registration` match a direct SQL count.

#### AC-VERIFY-5: The deadline boundary is exact and time zones never leak in
**Priority**: MUST
**Given** a `ManualClock` and sessions whose `cancellation_deadline` is the default `starts_at - 48h`, including sessions across the NZ DST change (2026-09-27, 2027-04-04)
**When** a CONFIRMED player withdraws at `deadline - 1 ms`, exactly at `deadline`, and at `deadline + 1 ms`
**Then** the first two are `EARLY` (`now <= cancellation_deadline`, free) and the third is `LATE`. All comparisons use UTC `timestamptz` instants and never `date` or local time. The page formats the deadline in Pacific/Auckland with `formatNzDateTime`

#### AC-VERIFY-6: Registration actions are observable and carry no PII
**Priority**: MUST
**Given** `captureLogs()` (`apps/api/test/helpers/log-capture.ts`)
**When** register, withdraw, promotion, the ban handler, the sweep and every refused action run
**Then** each emits one structured event: `registration.created` (`status`, `partySize`), `registration.withdrawn` (`withdrawalKind`, `feeDue`, `promotedCount`), `registration.promoted`, `registration.refused` (`reason`: `overdue_payments`, `session_not_open`, `already_registered`, `party_exceeds_capacity`, `not_registered`, `forbidden`) and `registration.ban_reconcile.completed`. Each carries `teamId`, `sessionId`, `userId`/`registrationId` where relevant and `traceId`. No line contains an email, full name, guest `display_name`, team name, `ban_reason` or session token, and the test asserts the logged fields, not only that the event fired (learned rule: logging-redaction-global). No new global redaction key is added. If one becomes necessary, every existing `log.*` call is grepped for collisions first

#### AC-VERIFY-7: Contracts are shared, strict and documented
**Priority**: MUST
**Given** new zod schemas in `packages/shared/src/api/registrations.ts` (exported from `packages/shared/src/index.ts`) and new error codes `overdue_payments` (403), `session_not_open` (409), `already_registered` (409), `not_registered` (409) and `party_exceeds_capacity` (422) in `packages/shared/src/api/errors.ts` and `ERROR_DEFAULTS`
**When** `pnpm run typecheck`, `pnpm run test` and `pnpm run openapi` run
**Then** the Fastify routes and the web `apiClient` import the same schemas. Request bodies are strict, money crosses every boundary as `MoneyString` (never `number`, P2), and every new code has a safe message that never echoes input. `apps/api/openapi.yaml` is regenerated and passes the drift test

#### AC-VERIFY-8: The registration panel is accessible and works on a phone
**Priority**: MUST
**Given** the Playwright desktop and 360 x 740 projects with `@axe-core/playwright`
**When** the session page is scanned in these states: open, full, registered, waitlisted, withdrawn (fee and no fee), overdue-blocked and closed
**Then** there are no `critical` axe violations, and:
- radio groups are `fieldset`/`legend`;
- guest fieldsets are announced when they appear (focus moves to "Guest 1");
- errors are tied by `aria-describedby`;
- status is never colour-only;
- tap targets are at least 44 px;
- confirmations use `InlineConfirm` (no `window.confirm`);
- no page scrolls horizontally.

#### AC-VERIFY-9: The new module is inside the coverage gate and the root commands stay green
**Priority**: SHOULD
**Given** the 80% gate (`vitest.config.ts`, `apps/api/src/coverage-gate.test.ts`)
**When** `pnpm run ci` runs
**Then** `apps/api/src/modules/registrations/**`, `apps/web/src/lib/registrations/**` and the new shared code are in the measured set at 80% or more for lines, functions, branches and statements, and lint, typecheck, test, coverage and build all pass

#### AC-VERIFY-10: This feature writes no money rows
**Priority**: MUST
**Given** the full integration suite of this feature
**When** every register, withdraw, promotion, ban and sweep scenario has run
**Then** `payments`, `payment_line_items`, `credit_transactions`, `player_credits` and `team_invoice_counters` are unchanged (asserted by row counts per test file), and no source file under `apps/api/src/modules/registrations/` references those tables except the read-only OVERDUE count in the debt gate

#### AC-INTEGRATION-1: Seat allocation and promotion are proven under real concurrency
**Priority**: MUST
**Given** a dedicated cloned database with a pool larger than the parallelism (learned rule: testing-integration-db-isolation) and real HTTP through `buildAuthTestApp`
**When** these run, using lock-waiter probes for ordering (never sleeps):
- (a) 20 members register concurrently for a session with public capacity 10;
- (b) 10 concurrent withdrawals race 5 new registrations on a full session with a waitlist;
- (c) two withdrawals each free one seat while one waitlisted party of 2 waits;
- (d) a withdrawal races the ban handler on the same session.

**Then** the outcomes are:
- (a) exactly 10 seats are CONFIRMED and 10 parties are WAITLISTED at positions 1..10, with no 23505 surfaced to any client;
- (b) after the run, AC-VERIFY-4's invariant holds and every freed seat went to the waitlist in FIFO (first-fit) order before any newcomer;
- (c) the party of 2 is promoted exactly once, by the second withdrawal;
- (d) each registration is withdrawn exactly once and each promotion happens once.

#### AC-INTEGRATION-2: The real handler and registration path pass the team-management contract test
**Priority**: MUST
**Given** `apps/api/test/integration/teams-ban-seam.int.test.ts` with its recording stand-in replaced by the real handler through `registerJobs({ memberBannedHandler })`, and the real `POST .../registrations` route in the gate-race cases
**When** the file runs against a real cloned Postgres and a real pg-boss producer and worker
**Then** every existing assertion still holds: the payload comes from a real `pgboss.job` row, selection is by current state, redelivery is harmless, a transient failure retries to success, a permanent failure ends in `failed`, and in the race a registration that held the gate first is withdrawn by the handler while a registration attempted during the ban is refused. Additional cases cover promotion of the waitlisted party and its email in the same transaction, and the reconciliation sweep picking up a ban handled by the no-op

#### AC-INTEGRATION-3: The billing hand-off returns exactly the rows billing must charge
**Priority**: MUST
**Given** a session at its end containing:
- CONFIRMED parties, including one promoted after the deadline;
- an EARLY withdrawal;
- a LATE withdrawal whose seat was refilled;
- a LATE withdrawal with nobody promoted and 2 guests;
- a BANNED withdrawal;
- a WAITLISTED party that was never promoted.

**When** `listBillableRegistrations(db, sessionId)` runs against real rows
**Then** it returns the CONFIRMED registrations and the fee-due LATE withdrawal. Each row has `registrationId`, `userId`, `teamId`, `reason` (`CONFIRMED` or `LATE_WITHDRAWAL`), the registrant's sex and team skill level, and the guest rows with sex and skill. Nothing else is returned. A test-only billing stand-in can then insert one valid `payments` row with line items per returned registration (`insertPaymentRows`), and it passes the deferred `payment_lines_match_header` check at COMMIT, which proves the hand-off carries enough data for billing

#### AC-INTEGRATION-4: The full journey works in a real browser on both viewports
**Priority**: SHOULD
**Given** the Compose stack with `AUTH_FAKE_OAUTH=true`, the worker running, Mailpit, and a PUBLISHED session seeded through the session-scheduling-engine admin flow (or by a seed script until it exists) with public capacity 2 (`apps/web/e2e/registrations.spec.ts`)
**When** the journey runs:
1. player A registers with 1 guest;
2. player B registers alone and is waitlisted (#1);
3. A withdraws before the deadline;
4. B reloads and sees "You're in.";
5. an email for B appears in Mailpit;
6. an admin bans B;
7. within 30 s B's registration is withdrawn.

**Then** every step shows the copy above, and the run passes on desktop and 360 x 740 with no critical axe violations

### Scope Boundaries
- **In scope**:
  - Registration for a PUBLISHED, not-yet-started session by an APPROVED member, with 0 to 2 guests (sex and skill required, name optional).
  - Capacity = `max_players - reserved_seats`; parties are confirmed or waitlisted whole.
  - The FIFO waitlist with D-14 positions and the first-fit promotion rule (pending creative).
  - The `>= 3 OVERDUE` debt gate.
  - Early, late and ban withdrawal, plus leaving the waitlist.
  - Re-registration after withdrawal.
  - Promotion with emails.
  - The registration lifecycle migration (D-47 onwards).
  - The shared allocator (`registerInSession`, `promoteWaitlist`, `decideAllocation`) exported for auto-enrol and capacity changes.
  - The billing hand-off `listBillableRegistrations`.
  - The real `MemberBannedHandler`, its worker wiring, the `registration-ban-reconcile` sweep, and the restored ban confirmation copy.
  - The registration API module, shared contracts and error codes, `RegistrationPanel`, and the minimal session page if session-scheduling-engine doesn't provide one.
  - `proxy.ts` protection of the session path, OpenAPI regeneration, coverage-gate, ADR and memory-bank doc updates (`systemPatterns.md`, `techContext.md`, ledger).
- **Out of scope**:
  - Creating, editing, publishing or cancelling sessions, the session list on the team page, and cancelling registrations when a session is cancelled (session-scheduling-engine).
  - Any payment, line item, wallet movement, Akahu link, GST computation, invoice, `OVERDUE` transition or reminder (wallet-and-akahu-billing, tax-invoices-and-exports).
  - The dashboard tabs "Currently Opening", "My Registration" and "Payments & Wallet" (player-dashboard). The debt-block message therefore links nowhere yet.
  - Auto-enrol selection and ordering (skill-levels-and-auto-enroll, which calls the allocator), skill eligibility rules, and skill overrides.
  - Editing guests or the guest count of an active registration (withdraw and register again instead).
  - Admin-initiated removal of a player, manual promotion or reordering of the waitlist, use of `reserved_seats` by hosts (they are simply excluded from public capacity in v1), a waitlist expiry, and promotion offers that need acceptance.
  - Notifications other than the promotion email (no "you're registered" email, no admin alerts), the admin roster UI (the API is a COULD), and the admin master report (admin-reporting-dashboard).
  - GLOBAL_ADMIN acting on registrations.
  - Unban and its effect on registrations (BANNED is terminal in v1).
- **Dependencies**:
  - session-scheduling-engine (NOT built; build gate): the five assumed outputs listed above.
  - team-management (merged): gate, ban port, job, ADR 0015, contract test, `InlineConfirm`, labels.
  - auth-and-user-roles (merged): guards, `requireUser`, `proxy.ts`, error shape.
  - platform-foundation (merged): schema D-10 to D-14 and D-19 to D-21, pg-boss, `send-email`, `Clock`, money and time primitives, test harness.
  - Downstream consumers: wallet-and-akahu-billing (`listBillableRegistrations`, `withdrawal_fee_due`, the debt gate's dependency on OVERDUE), skill-levels-and-auto-enroll (allocator), player-dashboard (registration read model).
- **NFR implications**:
  - **Concurrency and integrity (P1):** the session row lock serialises each session's seats, and the DB backstops the capacity, transitions, queue uniqueness and guest counts.
  - **Money (P2):** fee estimates are `Money`/`MoneyString` only, and nothing is persisted.
  - **Time (P3):** UTC instants with an injected clock read once per operation; Pacific/Auckland only at display.
  - **Async (P5):** emails and ban side effects run through pg-boss in the domain transaction.
  - **Security:** default-deny team guard before validation; team-scoped session lookups (no IDOR); strict bodies so a client can't set `status`, `queue_position` or `user_id`.
  - **Privacy (NZ Privacy Act 2020):** guest names are visible only to the registrant (and to admins in the COULD roster); no emails or names in logs or job payloads except the recipient address of the promotion email, as for existing emails; a withdrawer never learns who took their place.
  - **Accessibility:** AC-VERIFY-8.
  - **Performance:** register and withdraw p95 under 300 ms at 100 registrations per session (the lock is held for a few statements only).
  - **Config:** no new environment variables expected. The email link uses `WEB_BASE_URL`, and the sweep time is a code constant like the other schedule slots.

### Creative Exploration Needed
Yes. Questions for `/yay:creative`, in order of risk:
1. **A waitlisted group that doesn't fit (LOW, algorithm).** The ACs assume **first-fit**: when seats free up, scan WAITLISTED parties in `queue_position` order and promote each one that fits, repeating until none fits. The head keeps its position, and a newcomer is confirmed only when no waitlisted party fits. The alternatives are **block** (strict head-of-line: nobody passes a head that doesn't fit, so seats can sit empty right up to start) and **bounded skip** (skip the head at most N times, or stop skipping X hours before start, to prevent starving a party of 3). Decide the rule, the newcomer rule, whether a party is ever split (assumed never), and how the panel explains being passed over. AC-HAPPY-9, AC-VERIFY-4 and AC-INTEGRATION-1(b) depend on the answer.
2. **Seat allocation and promotion concurrency design (MEDIUM, architecture).** D-14 fixes the session row lock under READ COMMITTED. Confirm the design around it:
   - one allocator module with a pure `decideAllocation` used by register, withdraw, the ban handler, auto-enrol and capacity edits;
   - the DB capacity backstop (a deferred constraint trigger vs. an immediate one, and its interaction with an admin cutting capacity);
   - the registrations transition trigger plus a TS table (two encodings, as in team-management);
   - re-registration reusing the `UNIQUE(session_id, user_id)` row and replacing guests;
   - lock timeout and retry policy (`SET LOCAL lock_timeout`, retry on 40P01/55P03), and where the debt read sits;
   - whether `promoteWaitlist` is the only path that may promote.
3. **Fee transfer semantics at and after the deadline (LOW, product and algorithm).** The ACs assume:
   - the liability is decided once, at withdrawal: `withdrawal_fee_due` is true iff the withdrawal is LATE and no waitlisted party was promoted by it;
   - the promoted party "takes the fee" simply by being CONFIRMED and billed at session end;
   - nothing is written at promotion time.

   Still to decide:
   - **(a) Partial refill:** a late party of 3 frees 3 seats and only a party of 1 is promoted. The assumption is no fee; the alternative is a fee for the unfilled seats, which conflicts with line items that require a registrant line.
   - **(b) Later refill:** a new registrant or a later promotion fills a liable withdrawer's seat before start. The assumption is the withdrawer is still charged.
   - **(c) Promotion after the deadline:** a waitlisted player is promoted after the deadline, possibly hours before start, and becomes liable without acting. Options are to promote anyway (the assumption, per workflows §2), stop promoting N hours before start, or require acceptance.
   - **(d) Registration after the deadline:** allowed (the assumption).
   - **(e) After start:** withdrawal is closed (the assumption).
   - **(f) The marker itself:** a column on `registrations` (the assumption) vs. a separate liability table vs. billing deriving liability from history.

   Agree the result with wallet-and-akahu-billing's future plan and record it in an ADR.
4. **Ban handler and reconciliation sweep (MEDIUM, architecture).** Settle these:
   - **Handler structure:** query by current state; one transaction per session; error classification (which errors are permanent); behaviour when the session moves to COMPLETED or CANCELLED between selection and lock (re-check under the lock and skip).
   - **Sweep design:** cadence and time (`30 5 * * *` assumed); one job per membership vs. per (membership, session); the query and its index needs (`registrations (team_id, user_id, status)`?); logging.
   - **Ordering and copy:** how the sweep and live bans interact under the `exclusive` singleton; the final wording of the restored ban confirmation, and whether the success message also changes.
5. **Invocation surface pending session-scheduling-engine (LOW, UI/UX and user journey).** Decide:
   - **The page:** where the session page lives and who owns it (`/teams/[teamId]/sessions/[sessionId]` assumed); whether this feature adds an "Upcoming sessions" list to the team page until session-scheduling-engine or player-dashboard do; how the panel slots into the scheduling engine's page.
   - **The guest form:** whether to ask guest sex and skill even for FLAT sessions (the DB requires both, so the assumption is always ask, with no preselection).
   - **Display and copy:** how waitlist rank and the "passed over" case are shown; the promotion email copy, especially after the deadline; the debt-block message until the payments tab exists.
6. **Cross-feature contract checks (MEDIUM).** Confirm with the session-scheduling-engine plan that `fee_flat` is the final FLAT rate, that capacity edits call `promoteWaitlist`, and that auto-enrol calls `registerInSession` (including how an auto-enrolled member with 3 OVERDUE payments is treated: skipped or waitlisted). Confirm with wallet-and-akahu-billing that the debt gate counts OVERDUE across all teams (assumed, per workflows §1) and not per team.

### Implementation Guide Required
No. Every acceptance criterion is auto-verifiable with fixtures that insert PUBLISHED `game_sessions` directly. The billing hand-off and the fee-transfer rules are recorded in an ADR produced by creative question 3, which wallet-and-akahu-billing must read before its plan.

## Test Strategy

### Approach
- **Emphasis**: integration-heavy. Seat accounting, the waitlist invariant, lock order, the deadline boundary and the ban handler are proven against real PostgreSQL 17 and a real pg-boss queue with multi-connection race tests (P1, P5; `testing-integration-db-isolation`). The pure allocation decision (`decideAllocation`), the transition table, fee estimation and the deadline classification are table-driven unit tests with an injected clock that is advanced between the calls of one operation (`testing-injected-clock`). Playwright covers the register, waitlist, withdraw and promotion journey on desktop and 360 px with axe scans.
- **Target test count**: about 125 across 6 phases. That is above the 20-test guideline because the spec has 40 ACs, and the allocator alone needs a scenario matrix (party sizes 1–3 × free seats 0–3 × waitlist shapes × early/late/ban). The matrix is one table-driven file, and its rows are re-run as integration fixtures so the SQL and the TS decision cannot drift.
- **Load-sensitive tests**: race tests use `waitForLockWaiters`, never sleeps. Wall-clock budgets stay load-tolerant (see `techContext.md` Integration Testing Specifics).

### File Organization
- **New test files**:
  - `packages/shared/src/api/registrations.test.ts`: strict bodies (no `status`, `queue_position`, `user_id`), 0–2 guests, required sex/skill, display-name bounds.
  - `apps/api/src/modules/registrations/allocator.test.ts`: the `decideAllocation` matrix (confirm, waitlist, never split, first-fit promotion per creative Q1, a party that can never fit).
  - `apps/api/src/modules/registrations/transitions.test.ts`: every `(status, action)` pair, plus the withdrawal-kind classification at, before and after the deadline instant.
  - `apps/api/src/modules/registrations/fees.test.ts`: unit fee and estimate per pricing structure, money only.
  - `apps/api/test/integration/registrations-schema.int.test.ts`: the new migration's columns, enum, CHECKs, transition trigger, capacity backstop, migrate/rollback round trip (AC-VERIFY-2).
  - `apps/api/test/integration/registrations-allocator.int.test.ts`: the matrix rows against real rows; lock order and D-14 positions (AC-VERIFY-3, 4).
  - `apps/api/test/integration/registrations-races.int.test.ts`: last seat between N registrants, register vs withdraw, double submit, withdraw vs ban, register vs ban (AC-INTEGRATION-1, AC-ERROR-3, 7).
  - `apps/api/test/integration/registrations-api.int.test.ts`: routes, policies, 404 for cross-team sessions, debt gate, closed sessions, guest validation (AC-HAPPY-1 to 8, AC-ERROR-1 to 8).
  - `apps/api/test/integration/registrations-ban.int.test.ts`: the real handler, the sweep, failure classification (AC-HAPPY-10, AC-ERROR-9, AC-ASYNC-2, 3).
  - `apps/api/test/integration/registrations-billing-handoff.int.test.ts`: `listBillableRegistrations` returns exactly CONFIRMED plus fee-due withdrawals; no money rows written (AC-INTEGRATION-3, AC-VERIFY-10).
  - `apps/api/test/integration/registrations-logs.int.test.ts`: `registration.*` events with ids only; assert the logged fields, not only presence (`logging-redaction-global`).
  - `apps/web/src/lib/registrations/{actions,labels}.test.ts`: Server Action error mapping, copy, typed values kept.
  - `apps/web/e2e/registrations.spec.ts`: AC-INTEGRATION-4 on desktop and 360 px with axe.
- **Extend existing**:
  - `apps/api/test/integration/teams-ban-seam.int.test.ts`: run the contract against the real handler (AC-INTEGRATION-2).
  - `apps/api/src/lib/auth/policy.test.ts`: registration route policies (AC-VERIFY-1).
  - `apps/api/src/lib/http/errors.test.ts`: the new error codes.
  - `apps/api/src/jobs/{registry,schedules}.test.ts`: the `registration-ban-reconcile` queue and slot.
  - `apps/api/src/openapi.test.ts`, `apps/api/src/coverage-gate.test.ts` (AC-VERIFY-9).
  - `apps/api/test/integration/{schema,enum-parity}.int.test.ts`: the new enum and columns.
  - `apps/api/test/helpers/factories.ts`: `insertPublishedSession`.
  - `apps/web/src/lib/teams/labels.test.ts`: restored ban copy.
  - `apps/web/src/proxy.test.ts`, `apps/web/src/lib/api-client.test.ts`.

### What NOT to Test
- Session creation, publication or cancellation: session-scheduling-engine. Fixtures insert PUBLISHED sessions directly.
- Payments, line items, wallet, Akahu, GST, OVERDUE transitions: wallet-and-akahu-billing. Only the hand-off query and the absence of money rows are tested here.
- `requireTeamRole` and `assertApprovedMember` internals: covered by auth and team-management. Here we test that every route and path calls them in the right order.
- Email delivery mechanics: `send-email` is covered by platform-foundation. Here we test that the promotion job is enqueued in the promoting transaction and its content.
- Visual styling: UAT covers it.

### Per-Phase Test Guidance
- **Phase 1** (about 20 tests): migration columns, `withdrawal_kind` enum and set-iff-WITHDRAWN CHECK, `withdrawal_fee_due` only on LATE, transition trigger, capacity backstop, new indexes, migrate/rollback round trip, enum parity, shared zod contracts, new error codes, `insertPublishedSession`.
- **Phase 2** (about 35 tests): the `decideAllocation` matrix; `registerInSession` confirm and waitlist; `promoteWaitlist` first-fit (per creative Q1); withdrawal classification at the exact deadline instant (free) and one microsecond after (late); fee-due marker per creative Q3; re-registration reuses the row and replaces guests; lock order `teams → team_members → game_sessions → registrations`; debt gate at 2 vs 3 OVERDUE; `listBillableRegistrations`; no money rows.
- **Phase 3** (about 25 tests): route policies; guard before validation; cross-team session 404; register 201 with status and rank; withdraw response without the promoted player's identity; closed and not-yet-published sessions; double submit; the promotion email committed with the promotion (rollback leaves neither); log events with asserted fields; OpenAPI drift.
- **Phase 4** (about 18 tests): the real handler withdraws CONFIRMED and WAITLISTED rows in future PUBLISHED sessions of the team as BANNED with no fee, one session per transaction, then promotes; skips sessions that changed under the lock; permanent vs transient errors; the sweep re-enqueues only BANNED members with active registrations and is idempotent; the team-management contract test passes with the real handler; ban vs register race.
- **Phase 5** (about 15 tests): Server Actions error mapping; panel states (open, full, registered, waitlisted, withdrawn, debt-blocked, closed); guest fieldsets with no preselection; proxy protection and `returnTo`; restored ban confirmation copy.
- **Phase 6** (about 12 tests): Playwright: register alone, register with two guests to the waitlist, withdraw early to promote the waitlisted party, promoted player sees "You're in." and the email in Mailpit, late withdrawal message, debt block; axe scans; 360 px; coverage gate.

## Implementation Roadmap

### Architectural Plan

#### Executive Summary
Build registration as the third `modules/<feature>` slice. One allocator module owns every seat change (register, withdraw, promote, ban, and later auto-enrol and capacity edits), serialised per session by the D-14 `game_sessions` row lock under the lock order `teams → team_members → game_sessions → registrations`. The database backstops capacity, transitions and positions (P1). Liability for a late withdrawal is recorded on the registration, and billing reads it later through `listBillableRegistrations`; this feature writes no money rows. The team-management ban seam gets its real handler and the reconciliation sweep that ADR 0015 requires.

#### Business Context
Registration is the core loop of the product: players claim a place, overflow queues fairly, and late cancellations are paid for by someone. Without it, sessions cannot fill and billing has nothing to charge. Fairness (FIFO, whole groups) and exactness (never overbook, never charge twice) matter more than speed. Stakeholders: players (fair access, clear fee rules), team admins (full sessions, bans that actually remove people), and the billing feature (an exact, auditable list of who owes what).

#### Vision and Goals
- **Vision**: a registration that is never wrong: no overbooking, no lost places, no surprise fees.
- **Goals**:
  - Zero overbooking under concurrent registration (proven by a 20-way last-seat race).
  - Withdraw-to-promotion in one transaction; the promoted player's email is committed with it.
  - Deadline classification exact to the microsecond (`now <= cancellation_deadline` is free).
  - Register and withdraw p95 under 300 ms at 100 registrations per session.
  - A banned member's upcoming registrations withdrawn within 30 s while the worker runs, and within one sweep otherwise.

#### Requirements
- **Functional**: the spec's 40 ACs. Key rules: public capacity `max_players - reserved_seats`; parties of 1–3 confirmed or waitlisted whole; FIFO waitlist with D-14 positions and the creative Q1 promotion rule; debt gate at 3+ OVERDUE (all teams); early/late/ban withdrawal; leaving the waitlist is free; re-registration; promotion emails; real ban handler and sweep; billing hand-off.
- **Non-functional**: integrity (P1 DB backstops), money via `Money` only (P2), UTC instants and an injected clock (P3), async side effects through pg-boss in the domain transaction (P5), default-deny team guard before validation, team-scoped session lookups, strict bodies, NZ Privacy Act (guest names visible to the registrant only; a withdrawer never learns who took their place), accessibility (AC-VERIFY-8), p95 under 300 ms.

#### Architectural Principles
1. **One allocator, one lock**: every seat-changing path calls the allocator under the session row lock. No path writes `registrations.status` or `queue_position` directly.
2. **Decide in TS, enforce in SQL**: `decideAllocation` is pure and table-tested; the DB rejects any state the decision should never produce.
3. **Liability is recorded, money is not**: this feature marks who owes; billing alone creates payments.
4. **The deadline is read once**: one `clock.now()` per operation, passed down.
5. **Honour ADR 0015**: the gate before any session lock, the handler idempotent and re-reading state.

#### Architecture Alternatives (to settle in /yay:creative)
- **Promotion rule** (Q1): first-fit (default) vs strict head-of-line vs bounded skip.
- **Capacity backstop** (Q2): deferred constraint trigger vs immediate trigger vs none (lock-only).
- **Liability marker** (Q3): column on `registrations` (default) vs a liability table vs billing derives from history.
- **Ban handler granularity** (Q4): one job per membership looping sessions (default) vs one job per (membership, session).

#### Selected Architecture
Provisional (pending creative): the defaults above. The creative architecture and algorithm docs, and the ADR from creative Q3, become binding for Phases 2 and 4.

#### Architecture Documentation
- Components: `modules/registrations/{routes,service,repo,allocator,transitions,fees,deadline,billing-handoff,ban-handler,reconcile}.ts`; `jobs/ban-reconcile.ts`; shared contracts; the web panel and session page.
- Data flow: web Server Action → API route (team guard) → service opens a transaction → `assertApprovedMember` (FOR SHARE) → debt read → lock `game_sessions` FOR UPDATE → allocator decides → repo writes rows → enqueue promotion emails in the same transaction → commit.
- Integration points: team-management (gate, ban port and job), session-scheduling-engine (sessions, page, `promoteWaitlist` on capacity edits), skill-levels-and-auto-enroll (`registerInSession`), wallet-and-akahu-billing (`listBillableRegistrations`, `withdrawal_fee_due`, OVERDUE).

#### Observability Requirements
- **Applies**: Yes. Reference `context/observability-requirements.md` during build.
- **Logging**: `registration.created` (status, partySize), `registration.waitlisted` (rank), `registration.withdrawn` (kind, feeDue), `registration.promoted` (count), `registration.refused` (reason code), `registration.ban.withdrawn`, `registration.ban.reconcile` (enqueued count). Fields: `teamId`, `sessionId`, `userId`, `registrationId`, `traceId` only. No names, guest names, email addresses or amounts. Tests assert the logged fields.
- **Tracing**: existing HTTP and pg-boss spans; promotion and ban jobs carry `traceparent` from the originating request.
- **Metrics**: none beyond the standard HTTP metrics; reserve names for registrations, promotions and lock waits (no exporter yet, as in ADR 0013/0015).
- **Configuration**: no new environment variables (the email link uses `WEB_BASE_URL`; the sweep time is a code constant).

#### API Requirements - REST
- **Involves REST API**: Yes.
- **OpenAPI Spec Location**: `apps/api/openapi.yaml` (generated, drift-tested). Include 401/403 responses on every guarded route (team-management final-review Minor 5).
- **Endpoints**: `GET /teams/:teamId/sessions/:sessionId/registration`, `POST .../registrations`, `POST .../registrations/me/withdraw`, COULD `GET .../registrations` (admin roster).
- **Auth**: `requireTeamRole('MEMBER')` (roster: `TEAM_ADMIN`), plus `assertApprovedMember` inside the transaction.
- **Build Phase**: load `context/api-rest-requirements.md`.
- **GraphQL**: No.

#### Risk Assessment
- **Risk**: session-scheduling-engine makes different choices (page route, `fee_flat` meaning, capacity-edit hook). **Mitigation**: build is gated on it; creative Q5/Q6 record the contract; the allocator API is the only coupling.
- **Risk**: deadlocks between withdraw, ban handler and register. **Mitigation**: one lock order everywhere, `lock_timeout` plus bounded retry on 40P01/55P03 (creative Q2), deterministic race tests.
- **Risk**: fee rules disputed later by billing or users. **Mitigation**: creative Q3 ADR that billing must read before planning; liability stored explicitly and never recomputed.
- **Risk**: a global change breaks another feature (lesson from team-management). **Mitigation**: phase reviews check shared files (logger, error mapper, proxy, factories) against earlier features' tests.
- **Risk**: the debt gate is inert until billing writes OVERDUE. **Mitigation**: accepted and documented; tests set OVERDUE directly.

### New Source Files (pin path + extension)
- [ ] `db/migrations/<utc>_registration_lifecycle.sql`: `withdrawal_kind` enum, `promoted_at`, `withdrawn_at`, `withdrawal_kind`, `withdrawal_fee_due`, CHECKs, transition trigger, capacity backstop, indexes (D-47 onwards)
- [ ] `packages/shared/src/api/registrations.ts` (+ `.test.ts`): zod contracts
- [ ] `apps/api/src/modules/registrations/routes.ts`
- [ ] `apps/api/src/modules/registrations/service.ts`
- [ ] `apps/api/src/modules/registrations/repo.ts`
- [ ] `apps/api/src/modules/registrations/allocator.ts`: `decideAllocation`, `registerInSession`, `promoteWaitlist` (exported)
- [ ] `apps/api/src/modules/registrations/transitions.ts`
- [ ] `apps/api/src/modules/registrations/fees.ts`
- [ ] `apps/api/src/modules/registrations/deadline.ts`: early/late classification from one `now`
- [ ] `apps/api/src/modules/registrations/billing-handoff.ts`: `listBillableRegistrations` (exported)
- [ ] `apps/api/src/modules/registrations/ban-handler.ts`: the real `MemberBannedHandler`
- [ ] `apps/api/src/modules/registrations/reconcile.ts`: sweep query
- [ ] `apps/api/src/modules/registrations/emails.ts`: promotion email
- [ ] `apps/api/src/modules/registrations/{allocator,transitions,fees}.test.ts`
- [ ] `apps/api/src/jobs/ban-reconcile.ts`
- [ ] `apps/api/test/integration/registrations-{schema,allocator,races,api,ban,billing-handoff,logs}.int.test.ts`
- [ ] `docs/adr/0016-registration-allocation-and-billing-handoff.md`
- [ ] `apps/web/src/lib/registrations/actions.ts`, `labels.ts` (+ `.test.ts`): no JSX, `.ts`
- [ ] `apps/web/src/components/registrations/registration-panel.tsx`
- [ ] `apps/web/src/components/registrations/register-form.tsx`
- [ ] `apps/web/src/components/registrations/guest-fieldset.tsx`
- [ ] `apps/web/src/app/teams/[teamId]/sessions/[sessionId]/page.tsx`: minimal page if session-scheduling-engine ships none (creative Q5)
- [ ] `apps/web/e2e/registrations.spec.ts`
- [ ] extend: `packages/shared/src/api/errors.ts`, `packages/shared/src/index.ts`, `apps/api/src/app.ts`, `apps/api/src/worker.ts`, `apps/api/src/jobs/{registry,bootstrap,schedules}.ts`, `apps/api/src/lib/db/types.generated.ts`, `apps/api/openapi.yaml`, `apps/api/test/helpers/factories.ts`, `apps/api/test/integration/teams-ban-seam.int.test.ts`, `db/schema-deviations.md`, `vitest.config.ts`, `apps/web/src/proxy.ts`, `apps/web/src/lib/api-client.ts`, `apps/web/src/lib/teams/labels.ts`

### Phases
**Build gate**: do not start Phase 1 until session-scheduling-engine is merged, then re-check its contract (creative Q5, Q6) and adjust this plan if needed.
- [ ] **Phase 1: Schema and shared contracts**: the lifecycle migration (D-47 onwards), regenerated types, zod contracts, error codes, `insertPublishedSession`. ACs: AC-VERIFY-2, AC-VERIFY-7.
- [ ] **Phase 2: Allocator core and billing hand-off** (follows the algorithm and architecture creative docs): `decideAllocation`, `registerInSession`, `promoteWaitlist`, withdrawal classification and liability, debt gate, `listBillableRegistrations`, ADR 0016. ACs: AC-HAPPY-1 to 9 (domain side), AC-ERROR-4, AC-VERIFY-3, 4, 5, 10, AC-INTEGRATION-1 and 3.
- [ ] **Phase 3: Registration API and promotion emails**: routes, service, policies, team-scoped lookups, refusals, promotion emails in the promoting transaction, `registration.*` logs, OpenAPI with 401/403. ACs: AC-ERROR-1 to 3 and 5 to 8, AC-ASYNC-1, AC-VERIFY-1 and 6.
- [ ] **Phase 4: Real ban handler and reconciliation sweep** (follows creative Q4): the handler, worker wiring, the `registration-ban-reconcile` queue and slot, the team-management contract test with the real handler. ACs: AC-HAPPY-10 (API side), AC-ERROR-9, AC-ASYNC-2 and 3, AC-INTEGRATION-2.
- [ ] **Phase 5: Web registration panel** (follows the UI/UX and journey creative docs): session page or panel slot, register form with guests, waitlist and withdraw states, debt block, proxy, api-client, Server Actions, restored ban confirmation. ACs: AC-ENTRY-1 to 3, web side of AC-HAPPY-1 to 10, AC-ERROR-5 and 8, AC-ASYNC-4.
- [ ] **Phase 6: E2E, accessibility and docs**: Playwright journeys with axe on both viewports, coverage gate, `systemPatterns.md`/`techContext.md` updates. This phase delivers the complete entry-to-success flow. ACs: AC-VERIFY-8 and 9, AC-INTEGRATION-4.

## Creative Phases

Level 4: creative is required.
- [ ] **Algorithm Design** (required): the promotion rule for a waitlisted group that doesn't fit (Q1) and the fee-transfer semantics at and after the deadline (Q3), recorded in ADR 0016 for wallet-and-akahu-billing. Status: pending.
- [ ] **Architecture Design** (required): allocator and concurrency design (Q2), the ban handler and reconciliation sweep (Q4), and the cross-feature contracts (Q6). Status: pending.
- [ ] **User Journey Design** (required for Level 4): register, waitlist, promotion, withdrawal and ban journeys, including the "passed over" and debt-block cases (Q5). Status: pending.
- [ ] **UI/UX Design** (required): the registration panel, guest form and session page placement pending session-scheduling-engine (Q5). Status: pending.
- **Reconciliation step**: after the parallel creative docs return, write one binding reconciliation section here before build (lesson from team-management).

---

## Execution State

**Build Status**: RUNNING
**Current Phase**: CREATIVE
**Current Step**: Step 4.5 - Adversarial design critique, then reconciliation
**Step Started**: 2026-10-16
**Can Resume**: YES

### Active Sub-Agents
- Algorithm Design: COMPLETE
- Architecture Design: COMPLETE
- User Journey Design: COMPLETE
- UI/UX Design: COMPLETE

### Completed Steps
- Step 0.1: Task provisioned on feature/registration-and-waitlist
- Step 3: Spec Writer Agent (opus) - COMPLETE; taxonomy lint CLEAN; human approved 2026-10-14
- Step 4-5: Codebase analysis and implementation plan - COMPLETE (6 phases, Level 4)
- Algorithm Creative Design: COMPLETE (2026-10-16) - Output: memory-bank/creative/registration-and-waitlist-allocation-algorithm.md
- Architecture Creative Design: COMPLETE (2026-10-16) - Output: memory-bank/creative/registration-and-waitlist-allocator-architecture.md
- User Journey Creative Design: COMPLETE (2026-10-16) - Output: memory-bank/creative/registration-and-waitlist-registration-user-journey.md
- UI/UX Creative Design: COMPLETE (2026-10-16) - Output: memory-bank/creative/registration-and-waitlist-registration-panel-uiux.md
