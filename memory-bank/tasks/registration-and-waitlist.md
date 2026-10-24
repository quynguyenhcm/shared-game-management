---
slug: registration-and-waitlist
legacy_id:
feature: registration-and-waitlist
status: BUILD_COMPLETE
---

# registration-and-waitlist: Registration and Waitlist

**Complexity**: Level 4 (inherited from registration-and-waitlist)
**Status**: BUILD_COMPLETE
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

**Build gate**: `/yay:build` is held until session-scheduling-engine is merged (decision 2026-10-14: plan and creative now, build later). **Update 2026-10-24:** session-scheduling-engine merged to `main` (PR #7, merge cc324a3; ADR 0019). The gate is now the re-check list under § Phases, amended by R19-R27.

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
5. The auto-enrol step of recurrence materialisation (workflows §4, skill-levels-and-auto-enroll) registers members through this feature's exported allocator (`autoEnrolInSession` with `{ userId, assignedAt }` entries, re-checked under the member lock, R16), in auto-enrol assignment order, calling the gate first.

*Checked 2026-10-24 against `main` (ADR 0019, `apps/api/test/integration/sessions-contracts.int.test.ts` header points 1.1-1.5).* All five hold, with these corrections: item 3, SSE ships no player page, so this feature owns it unconditionally (R8, R23); item 4, the call is `promoteWaitlist(ctx, { teamId, sessionId })` through the `SessionAllocatorPort`, also from series propagation (R19, R22); item 5, auto-enrol runs in SSE's follow-up transaction on every published session, one-offs included (ADR 0019 §6, P-1; R22, R27).

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
  - `registrations`: `status`, `queue_position` (`max + 1` under the session lock; NULL unless WAITLISTED), `guest_count`, `registered_at` (reset when a withdrawn row registers again), `updated_at`, and new columns from one reversible migration (ledger D-62 onwards): `promoted_at timestamptz` (set on WAITLISTED -> CONFIRMED), `withdrawn_at timestamptz`, `withdrawal_kind` (new enum `withdrawal_kind`: `EARLY`, `LATE`, `BANNED`; set iff `status = 'WITHDRAWN'`) and `withdrawal_fee_due boolean NOT NULL DEFAULT false` (true only for `LATE` with nobody promoted; the billing hand-off).
  - `registrations` (added 2026-10-20, R15-R17): `registrant_skill_level skill_tier` and `registrant_sex sex`, the registrant's pricing snapshot, written in the update that makes the row CONFIRMED (register, promotion, auto-enrol, confirmed re-registration). They are never changed while the row stays CONFIRMED or becomes WITHDRAWN, and are re-taken when a withdrawn row is CONFIRMED again; NULL only on a row that has never been CONFIRMED. `source registration_source NOT NULL DEFAULT 'MEMBER'` (new enum: `MEMBER`, `AUTO_ENROL`), set by the entry point that created or re-activated the row.
  - `registration_guests`: `position`, `sex`, `skill_level`, `display_name`, replaced only when a withdrawn row registers again.
  - `send-email` jobs for promotions, and `member-banned` jobs re-enqueued by the sweep.
  - **No rows in `payments`, `payment_line_items`, `credit_transactions` or `player_credits`** (AC-VERIFY-10).
- **Observable within**: Immediate for register, withdraw and promotion caused by a withdrawal (all one transaction). A promotion email is enqueued in the promoting transaction and delivered by the worker within 30 s. A ban's registration cancellation is eventual: within 30 s while the worker runs, at most one daily sweep later if a job failed permanently or ran the no-op.

**Billing boundary (binding for wallet-and-akahu-billing).** This feature records liability and writes no money rows. At session end, billing must bill exactly the set returned by the exported `listBillableRegistrations(db, sessionId)` (`apps/api/src/modules/registrations/billing-handoff.ts`):
- (a) every `CONFIRMED` registration, which includes players promoted after the deadline: that is how "the promoted player takes the fee" happens, with nothing written at promotion time;
- (b) every `WITHDRAWN` registration with `withdrawal_fee_due = true`, billed to the withdrawing registrant for the whole party.

Billing computes the fee at charge time from the session's fee columns and the stored pricing attributes (registrant: the `registrant_sex` and `registrant_skill_level` snapshot taken when the row became CONFIRMED, never `users.sex` or `team_members.skill_level` at charge time, per ADR 0017 C-PRICE-1 and R15; guests: `registration_guests`) and writes the snapshot, line items, wallet deduction or Akahu link per ADR 0012. Ban withdrawals (`BANNED`) and early withdrawals are never billed. Registrations and guest rows are never deleted by this feature, because billing's line items RESTRICT them. Both features read the debt gate's `OVERDUE` status, but only billing writes it.

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
**Then** the anonymous caller gets 401 (the page redirects to `/login?returnTo=...`). Every other caller gets 403 `forbidden` before body validation (never a 422), and the page shows "You need to be a member of this team to register." with no form. A `:sessionId` of another team, a DRAFT session's id or an unknown id under T returns 404 `not_found` with an identical body (2026-10-24: ADR 0019 (e) answers 403 for another team's id on SSE's admin routes. Registration's member routes keep 404, by human ruling 2026-10-24 (O2, R24), and ADR 0018 records why)

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
**Then** the API returns 409 `session_not_open` ("Registration for this session is closed."), nothing changes, and the page shows "Registration is closed." with no form or withdraw button. A DRAFT session is 404 (AC-ENTRY-2). For a CANCELLED session the page shows the journey doc A10 copy "This session has been cancelled." even when the caller's row is still CONFIRMED or WAITLISTED: SSE's cancel leaves registrations untouched and emails no player (ADR 0019 C-SSE-4, user ruling P-2), so this page is the player's only signal (R27). Registering after the cancellation deadline but before `starts_at` is allowed, and the panel then shows "The free cancellation deadline has passed. If you withdraw later you may be charged." above the button

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
**Given** any promotion (from a withdrawal, a ban withdrawal, or `promoteWaitlist` called by a capacity change: SSE's session `PUT` or series propagation, through the port, ADR 0019 C-SSE-3, R19)
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
**When** the `registration-ban-reconcile` slot fires (cron `45 5 * * *`, `Pacific/Auckland`, outside the 02:00-02:59 DST window, after `auth-cleanup` at 05:00 and `skill-progression` at 05:30, O4 human ruling 2026-10-24; queue `exclusive`) or an operator runs `pnpm run jobs:trigger registration-ban-reconcile`
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
**Then** `GET /teams/:teamId/sessions/:sessionId/registration`, `POST /teams/:teamId/sessions/:sessionId/registrations` and `POST /teams/:teamId/sessions/:sessionId/registrations/me/withdraw` are `teamRole('MEMBER')` with `allowGlobalAdmin: false`. The roster route, if built, is `teamRole('TEAM_ADMIN')`. No registration route is `public` or `optionalSession`, and `:sessionId` is always resolved together with `:teamId` (never by session id alone). `GET /teams/:teamId/sessions/upcoming` (R8) is `teamRole('MEMBER')`, and a MEMBER request to it reaches registration's handler, not SSE's `TEAM_ADMIN` route `GET /teams/:teamId/sessions/:sessionId` (R23)

#### AC-VERIFY-2: Registration invariants are enforced by the database, reversibly and ledgered
**Priority**: MUST
**Given** one new migration `db/migrations/<utc-timestamp>_registration_lifecycle.sql`
**When** `pnpm run test:integration` runs
**Then** the migrate, `rollback --all`, migrate round trip is identical (the down migration restores SSE's original body of `game_session_has_active_registrations`, never drops it, R20), `db/schema-deviations.md` has D-62 onwards (D-62..D-69 only; D-70..D-85 are SSE's, R25), each with a Source, for every new object, `types.generated.ts` matches codegen, and the enum-parity test covers the new `withdrawal_kind` enum (mirrored in `packages/shared/src/types/enums.ts`). Raw SQL proves each rule:
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

Enqueue uses `coalesce(max(queue_position), 0) + 1` and promotion scans WAITLISTED rows by ascending `queue_position`. No path takes locks out of this order, uses `SERIALIZABLE` or an advisory lock, or renumbers positions. The transaction reads the clock once (`clock.now()`) and passes that value down (learned rule: testing-injected-clock).

Amended 2026-10-24 (R22): the order above is a slice of ADR 0019's `LOCK_ORDER` (`apps/api/src/modules/sessions/locks.ts:25`, `teams → recurring_session_rules → team_members → game_sessions → registrations → registration_guests → payments`), and registration code never locks `recurring_session_rules`. Registration code takes no advisory lock; the auto-enrol entry runs inside SSE's `runSessionAutoEnrol` transaction, whose first statement is SSE's advisory lock (`SESSION_AUTO_ENROL_LOCK_NAMESPACE`, `locks.ts:39`). Port calls (`promoteWaitlist`, `autoEnrolInSession`) use `ctx.now`, read by the caller after its own locks, and never read the clock themselves. A `promoteWaitlist` call may run in a transaction that already holds several session locks (series propagation, `series-propagate.ts:167`), and the trace must show it takes no new session lock out of `(date, id)` order

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
**Then** the first two are `EARLY` (`now <= cancellation_deadline`, free) and the third is `LATE`. All comparisons use UTC `timestamptz` instants and never `date` or local time. The page formats the deadline in Pacific/Auckland with the NZ formatter (`formatDayShort` + `formatClock`)

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
**Then** it returns the CONFIRMED registrations and the fee-due LATE withdrawal. Each row has `registrationId`, `userId`, `teamId`, `reason` (`CONFIRMED` or `LATE_WITHDRAWAL`), the registrant's snapshotted sex and skill level (`registrant_sex`, `registrant_skill_level`, R15; a level override or promotion after the row was confirmed does not change them), and the guest rows with sex and skill. Nothing else is returned. A test-only billing stand-in can then insert one valid `payments` row with line items per returned registration (`insertPaymentRows`), and it passes the deferred `payment_lines_match_header` check at COMMIT, which proves the hand-off carries enough data for billing

#### AC-INTEGRATION-4: The full journey works in a real browser on both viewports
**Priority**: SHOULD
**Given** the Compose stack with `AUTH_FAKE_OAUTH=true`, the worker running, Mailpit, and a PUBLISHED session with public capacity 2 created through session-scheduling-engine's admin API (`POST /teams/:teamId/sessions` then `.../publish`; it exists on `main` since 2026-10-24, so no seed script) (`apps/web/e2e/registrations.spec.ts`)
**When** the journey runs:
1. player A registers with 1 guest;
2. player B registers alone and is waitlisted (#1);
3. A withdraws before the deadline;
4. B reloads and sees "You're in.";
5. an email for B appears in Mailpit;
6. an admin bans B;
7. within 30 s B's registration is withdrawn.

**Then** every step shows the copy above, and the run passes on desktop and 360 x 740 with no critical axe violations

**Added 2026-10-20 (plan amendment, R14-R18; obligations from ADR 0016 team-banking and ADR 0017 skill-levels-and-auto-enroll)**

#### AC-VERIFY-11: The registrant's pricing attributes are snapshotted when a registration becomes CONFIRMED (C-PRICE-1)
**Priority**: MUST
**Given** Priya is an approved INTERMEDIATE, FEMALE member of a team whose PUBLISHED session prices `BY_SKILL_LEVEL`
**When** she is confirmed by each entry point in turn (an immediate register, a waitlist promotion, an auto-enrol, a confirmed re-registration after an early withdrawal), and afterwards an admin overrides her level to ADVANCED (a raw `UPDATE team_members` in the test, since the override route is not a dependency) and her `users.sex` changes
**Then** each CONFIRMED row stores `registrant_skill_level = 'INTERMEDIATE'` and `registrant_sex = 'FEMALE'`, written in the same `UPDATE` that sets `status = 'CONFIRMED'`. The later changes leave the snapshot and `listBillableRegistrations` unchanged. A WAITLISTED row that was never confirmed has both NULL. A CHECK refuses a CONFIRMED row, or a WITHDRAWN row with `withdrawal_fee_due`, that has either column NULL (SQLSTATE 23514). A withdrawn row confirmed again re-takes the snapshot from the values at that moment. The fee line on the session page names the level it is based on ("Your fee ({level}): {amount}"), per ADR 0017's later obligation.

#### AC-INTEGRATION-5: Auto-enrol re-checks the opt-out under the member lock and never registers a member who turned it off (C-SKL-1 point 4)
**Priority**: MUST
**Given** three approved members with Auto Enroll on, passed to `autoEnrolInSession` as `{ userId, assignedAt }` entries in `selectAutoEnrollees` order. Between selection and the call, one has Auto Enroll turned off, one has `auto_enroll_until` set to the day before the session's `date`, and one was turned off and on again (a new `auto_enroll_assigned_at`). The test sets these columns with raw SQL; it does not depend on skill-levels code being merged.
**When** `autoEnrolInSession` runs. It also runs while another connection holds the member row `FOR NO KEY UPDATE` (an admin save in flight), released after the allocator is seen waiting.
**Then**:
- Under its `team_members FOR SHARE` lock, and before the session lock, the allocator re-checks `is_auto_enroll`, `auto_enroll_until IS NULL OR auto_enroll_until >= game_sessions.date`, and `auto_enroll_assigned_at` equal to the entry's `assignedAt`.
- Each of the three members is skipped with reason `auto_enroll_changed` and no `registrations` row. Valid members in the same call are placed in order.
- When the waiting save turns Auto Enroll off and commits first, that member is skipped.
- The canonical lock order (ADR 0016 team-banking: `teams` → `team_members` → `game_sessions` → `registrations`) holds. Nothing takes `teams FOR UPDATE`.
- (R21, ADR 0019 §8, ALG R-b) A member who already has a `registrations` row for the session in any status, WITHDRAWN included (EARLY, LATE with or without `withdrawal_fee_due`, BANNED), is skipped with `already_registered`. The row is unchanged: no re-activation, no `source` change, no email.

#### AC-HAPPY-11: An auto-enrolled player sees it was automatic and is emailed (ADR 0017 later obligation)
**Priority**: MUST
**Given** `autoEnrolInSession` placed Priya in "Tuesday Smashers" on Wed 4 Nov, CONFIRMED or WAITLISTED
**When** the transaction commits, and Priya opens the session page
**Then**:
- The row has `source = 'AUTO_ENROL'`.
- A `send-email` job is enqueued in the placing transaction. Its subject is "You've been added to {Team name}, {Wed 4 Nov}" (or "...added to the waitlist for..."). The body gives the status, the fee line, and the cancellation deadline. It says: "Your team admin turned on Auto Enroll for you. Withdraw on the session page if you can't play." (O5, 2026-10-25: auto-enrol never places anyone after the deadline, so the body states "Free cancellation until {deadline}" and never the "deadline has passed" wording.)
- The session page's status area shows "Added automatically (Auto Enroll)" beside "You're in." or the waitlist line.
- A member re-registering through the panel sets `source = 'MEMBER'`.
- The email and the label never appear for a `MEMBER` row.
- Logs carry `source`, never the email address.

**Added 2026-10-24 (plan amendment, R19-R27; session-scheduling-engine merged, ADR 0019)**

#### AC-VERIFY-12: The D-85 fee-lock predicate and its TypeScript twin are widened together, and the admin's "registered" count is split off (ADR 0019 §8, BIND T-17, O1 ruling)
**Priority**: MUST
**Given** the lifecycle migration, `countActiveRegistrations` (the fee-lock twin, `apps/api/src/modules/sessions/repo.ts:98`) and the new display count `countRegisteredPlayers` (R20)
**When** `pnpm run test:integration` runs, including `sessions-parity.int.test.ts`, `sessions-schema.int.test.ts` and `sessions-contracts.int.test.ts`
**Then**:
- `game_session_has_active_registrations(uuid)` is replaced by `CREATE OR REPLACE` in this feature's migration and is true for a CONFIRMED or WAITLISTED row, or a WITHDRAWN row with `withdrawal_fee_due`. It is false for a WITHDRAWN row without it, and for none.
- `countActiveRegistrations` (fee lock) counts the same rows. The parity test's hand-written table (`sessions-parity.int.test.ts:24`) gains the WITHDRAWN-with-fee-due case, and the TS count and the SQL predicate agree on every case.
- `game_sessions_fee_raise_locked` (23514) refuses a fee raise on a PUBLISHED session whose only registration is a fee-due withdrawal, and allows it once the fee is released (R2).
- `rollback --all` restores SSE's original function body (CONFIRMED and WAITLISTED), so SSE's migration still owns the function.
- (O1 resolved, human ruling 2026-10-24.) `countRegisteredPlayers` counts only CONFIRMED and WAITLISTED rows, and drives SSE's `activeRegistrationCount`: the admin's "{n} players are registered", the edit banner, and the cancel and end-series counts. The fee-lock count drives only `feesLocked`, the 409 `session_fee_locked` and the series `fee_locked` skip. Each SSE call site is classified in R20.
- A late withdrawer who still owes the fee is in the fee-lock count and not in the display count. On a PUBLISHED session whose only row is a LATE withdrawal with `withdrawal_fee_due`:
  - `countActiveRegistrations` = 1 and the SQL predicate is true;
  - `countRegisteredPlayers` = 0;
  - the admin `GET /teams/:teamId/sessions/:sessionId` returns `activeRegistrationCount 0` and `feesLocked 'raise_only_blocked'`;
  - a fee raise through `PUT` is 409 `session_fee_locked`;
  - a cancel answers `activeRegistrationCount 0`.
  - After the fee is released (R2), the lock lifts.

#### AC-INTEGRATION-6: The registrations adapter fills session-scheduling-engine's allocator port end to end
**Priority**: MUST
**Given** `createSessionAllocator` (`apps/api/src/session-allocator.ts:26`) returning registration's adapter (`name: 'registrations'`, `enrols: true`), a real cloned Postgres and a real pg-boss worker
**When**:
1. a PUBLISHED session that was pending under the no-op (`auto_enrol_required` true, `auto_enrolled_at` NULL) is offered by SSE's `recurrence-materialisation` sweep;
2. an admin raises public capacity on a full PUBLISHED session with a waitlist through SSE's `PUT /teams/:teamId/sessions/:sessionId`;
3. the same raise arrives through a series edit that propagates to that instance.

**Then**:
- (1) The session is enrolled once in `selectAutoEnrollees` order through the real allocator, rows get `source 'AUTO_ENROL'`, the AC-HAPPY-11 emails are enqueued in that transaction, and `auto_enrolled_at` is stamped in the same transaction. A second sweep enrols nobody. This is the real-adapter counterpart of SSE's marker proof (`sessions-contracts.int.test.ts:731`, which uses a recording double).
- (2) and (3) `promoteWaitlist` promotes first-fit inside SSE's edit transaction, releases owed fees (R2), and enqueues the AC-ASYNC-1 emails on that transaction. SSE's response `promoted` equals the number of returned `PromotedSeat`s.
- A rolled-back edit leaves no promotion, release or email.
- `session-allocator.test.ts` asserts the adapter's `name` and `enrols` (it no longer expects `noopSessionAllocator`). `sessions-contracts.int.test.ts` stays green with its contract points 1.1-1.5, C-SSE-1..5, the port signature and the D-85 items re-checked (R26).

### Scope Boundaries
- **In scope**:
  - Registration for a PUBLISHED, not-yet-started session by an APPROVED member, with 0 to 2 guests (sex and skill required, name optional).
  - Capacity = `max_players - reserved_seats`; parties are confirmed or waitlisted whole.
  - The FIFO waitlist with D-14 positions and the first-fit promotion rule (pending creative).
  - The `>= 3 OVERDUE` debt gate.
  - Early, late and ban withdrawal, plus leaving the waitlist.
  - Re-registration after withdrawal.
  - Promotion with emails.
  - The registration lifecycle migration (D-62 onwards).
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
  - session-scheduling-engine (merged 2026-10-24, PR #7; ADR 0019): the five assumed outputs listed above, as corrected there, and the hand-offs in R19-R27.
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
   - **Sweep design:** cadence and time (`30 5 * * *` assumed; now `45 5 * * *`, O4 human ruling 2026-10-24); one job per membership vs. per (membership, session); the query and its index needs (`registrations (team_id, user_id, status)`?); logging.
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
- **Phase 2** (about 41 tests; +6 from the 2026-10-20 amendment: snapshot on each of the 4 CONFIRMED transitions plus a CHECK refusal, auto-enrol re-check skips and the held-lock race): the `decideAllocation` matrix; `registerInSession` confirm and waitlist; `promoteWaitlist` first-fit (per creative Q1); withdrawal classification at the exact deadline instant (free) and one microsecond after (late); fee-due marker per creative Q3; re-registration reuses the row and replaces guests; lock order `teams → team_members → game_sessions → registrations`; debt gate at 2 vs 3 OVERDUE; `listBillableRegistrations`; no money rows.
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
- Integration points: team-management (gate, ban port and job), session-scheduling-engine (sessions, page, `promoteWaitlist` on capacity edits), skill-levels-and-auto-enroll (`autoEnrolInSession`, R16-R17; ADR 0017), wallet-and-akahu-billing (`listBillableRegistrations`, `withdrawal_fee_due`, OVERDUE).

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
- [ ] `db/migrations/<utc>_registration_lifecycle.sql`: `withdrawal_kind` enum, `promoted_at`, `withdrawn_at`, `withdrawal_kind`, `withdrawal_fee_due`, CHECKs, transition trigger, capacity backstop, indexes (D-62 onwards)
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
- [ ] `docs/adr/0018-registration-allocation-and-billing-handoff.md`
- [ ] `apps/web/src/lib/registrations/actions.ts`, `labels.ts` (+ `.test.ts`): no JSX, `.ts`
- [ ] `apps/web/src/components/registrations/registration-panel.tsx`
- [ ] `apps/web/src/components/registrations/register-form.tsx`
- [ ] `apps/web/src/components/registrations/guest-fieldset.tsx`
- [ ] `apps/web/src/app/teams/[teamId]/sessions/[sessionId]/page.tsx`: minimal page if session-scheduling-engine ships none (creative Q5)
- [ ] `apps/web/e2e/registrations.spec.ts`
- [ ] extend: `packages/shared/src/api/errors.ts`, `packages/shared/src/index.ts`, `apps/api/src/app.ts`, `apps/api/src/worker.ts`, `apps/api/src/jobs/{registry,bootstrap,schedules}.ts`, `apps/api/src/lib/db/types.generated.ts`, `apps/api/openapi.yaml`, `apps/api/test/helpers/factories.ts`, `apps/api/test/integration/teams-ban-seam.int.test.ts`, `db/schema-deviations.md`, `vitest.config.ts`, `apps/web/src/proxy.ts`, `apps/web/src/lib/api-client.ts`, `apps/web/src/lib/teams/labels.ts`

### Phases
**Build gate**: do not start Phase 1 until session-scheduling-engine is merged. Then re-check:
- its contract (creative Q5, Q6);
- ADR 0016 (team-banking) and, once PR #6 is merged, ADR 0017 (skill-levels: C-PRICE-1, C-SKL-1, C-SAE input shape);
- the free ADR/D numbers on `main` (R14).

Adjust this plan if needed.

*Gate status 2026-10-24:* session-scheduling-engine is merged (PR #7, cc324a3). The re-check is done in R19-R27. Before Phase 1 also:
- re-run `apps/api/test/integration/sessions-contracts.int.test.ts` and `sessions-parity.int.test.ts` on the branch (both green on `main`);
- re-confirm that ADR 0018, D-62..D-69 and no migration newer than `20261020000100000` are on `main` (R25);
- O1-O4 are RESOLVED (human ruling 2026-10-24; R20, R24, R27).
- O5 RESOLVED (human ruling 2026-10-25, from the final whole-branch review, Important 1): once `now > game_sessions.cancellation_deadline`, auto-enrol adds nobody (neither CONFIRMED nor WAITLISTED) on every path: SSE's `session-auto-enrol` job, the recurrence sweep, the boot sweep, and capacity-edit or series-propagation calls through the port. Members can still register by hand, and waitlist promotion is unchanged. Port reason `deadline_passed`; SSE still stamps the D-80 marker. ADR 0018 section 6 records it.
- [x] **Phase 1: Schema and shared contracts**: the lifecycle migration (D-62 onwards, including R15/R17 columns), regenerated types, zod contracts, error codes (incl. `auto_enroll_changed` refusal reason), `insertPublishedSession` (payout-configured team, R18). (R20, R25, R26) The same migration `CREATE OR REPLACE`s `game_session_has_active_registrations`, and `countActiveRegistrations` in `apps/api/src/modules/sessions/repo.ts` widens in the same phase as the fee-lock twin. The new display count `countRegisteredPlayers` is added, and every SSE call site is switched per the R20 table (O1 ruling). The D-85 cases in `sessions-parity`, `sessions-schema` and `sessions-contracts` are updated deliberately, the factory fixes cover SSE's suites, and every `sessions-*` integration suite is re-run. ACs: AC-VERIFY-2, AC-VERIFY-7, AC-VERIFY-11 (schema half), AC-VERIFY-12.
- [x] **Phase 2: Allocator core and billing hand-off** (follows the algorithm and architecture creative docs): `decideAllocation`, `registerInSession`, `autoEnrolInSession` (R16 opt-out re-check, R17 source), `promoteWaitlist`, the R15 pricing snapshot on every transition into CONFIRMED, withdrawal classification and liability, debt gate, `listBillableRegistrations`, ADR 0018. (R19, R21, R22) The port adapter `createRegistrationsSessionAllocator` (`modules/registrations/session-allocator-adapter.ts`), tested directly and through SSE's `runSessionAutoEnrol` and capacity edit with the adapter injected; `already_registered` for an existing row in any status; port calls inside SSE's transactions. ADR 0018 cites ADR 0019. ACs: AC-HAPPY-1 to 9 (domain side), AC-ERROR-4, AC-VERIFY-3, 4, 5, 10, AC-INTEGRATION-1, 3 and 5, AC-VERIFY-11, AC-HAPPY-11 (domain side), AC-INTEGRATION-6 (domain half).
- [x] **Phase 3: Registration API and promotion emails**: routes, service, policies, team-scoped lookups, refusals, promotion emails and the R17 auto-enrol email in the placing transaction, `registration.*` logs, OpenAPI with 401/403. (R19, R23, R24) The body of `createSessionAllocator` now returns the adapter, once both emails exist. `session-allocator.test.ts` is updated, and the real-adapter marker proof and capacity-edit cases run through SSE's routes and sweep. `GET /teams/:teamId/sessions/upcoming` resolves ahead of SSE's `/:sessionId` route. Another team's session id stays 404 (O2 ruling). ACs: AC-ERROR-1 to 3 and 5 to 8, AC-ASYNC-1, AC-VERIFY-1 and 6, AC-HAPPY-11 (email), AC-INTEGRATION-6.
- [x] **Phase 4: Real ban handler and reconciliation sweep** (follows creative Q4): the handler, worker wiring, the `registration-ban-reconcile` queue and slot (`45 5 * * *`, O4 human ruling 2026-10-24), the team-management contract test with the real handler. ACs: AC-HAPPY-10 (API side), AC-ERROR-9, AC-ASYNC-2 and 3, AC-INTEGRATION-2.
- [x] **Phase 5: Web registration panel** (follows the UI/UX and journey creative docs): session page or panel slot, register form with guests, waitlist and withdraw states, debt block, proxy, api-client, Server Actions, restored ban confirmation, the R17 "Added automatically (Auto Enroll)" label and the R15 fee line naming the level. (R23, R27) The player page at `apps/web/src/app/teams/[teamId]/sessions/[sessionId]/page.tsx`, which flips SSE's page-absence check (`sessions-contracts.int.test.ts:448-455`) to assert this page. The player summary component is named apart from SSE's admin `SessionSummary` (`components/teams/session-summary.tsx`). The cancelled-session copy (P-2). ACs: AC-ENTRY-1 to 3, web side of AC-HAPPY-1 to 10, AC-ERROR-2 and 5 and 8, AC-ASYNC-4, AC-HAPPY-11 (label).
- [x] **Phase 6: E2E, accessibility and docs**: Playwright journeys with axe on both viewports, coverage gate, `systemPatterns.md`/`techContext.md` updates. (R27) The e2e session is created and published through SSE's admin API, with no seed script. This phase delivers the complete entry-to-success flow. ACs: AC-VERIFY-8 and 9, AC-INTEGRATION-4.

## Creative Phases

Level 4: creative is required.
- [x] **Algorithm Design** (required): Q1 and Q3. Status: complete, `memory-bank/creative/registration-and-waitlist-allocation-algorithm.md` (first-fit; late fee released on refill; ADR 0018 draft inside).
- [x] **Architecture Design** (required): Q2, Q4, Q6. Status: complete, `memory-bank/creative/registration-and-waitlist-allocator-architecture.md` (options 2A, 4A, 6A).
- [x] **User Journey Design** (required for Level 4): Q5 journey. Status: complete, `memory-bank/creative/registration-and-waitlist-registration-user-journey.md` (Dashboard + Detail; this feature owns the player session page and the Upcoming sessions list).
- [x] **UI/UX Design** (required): Q5 UI. Status: complete, `memory-bank/creative/registration-and-waitlist-registration-panel-uiux.md` (stacked state-driven panel).
- **Reconciliation step**: after the parallel creative docs return, write one binding reconciliation section here before build (lesson from team-management).

### Design Critique (advisory)
- **Backend**: codex (`adversarial-review --base origin/main --scope branch`), 2026-10-16. Log: `.claude-logs/codex-critique-20261016.log` (local).
- **Verdict**: needs-attention. The fee-release model isn't wired into the architecture, re-registration can erase an owed fee depending on which doc wins, and the deferred capacity trigger takes locks in reverse order.
- **Findings**:
  - high · The allocator transaction never reads or clears owed fees (architecture doc, lines 462-471).
  - high · AC-HAPPY-8 lets a late withdrawer erase an owed fee by re-registering onto the waitlist (task file, lines 172-176).
  - high · The deferred capacity trigger locks registration then session, the reverse of the canonical order (architecture doc, lines 156-165).
  - medium · The withdrawn-state copy presents a provisional fee as final (UI/UX doc, lines 493-494).
- **Resolution**: see Creative Reconciliation.

### Creative Reconciliation (binding for build)

Where this section and a creative doc or an AC disagree, this section wins. Build agents apply these rulings when they reach the affected AC; the ACs above are not rewritten line by line. Human decisions taken 2026-10-16 are marked **(user)**.

**R1 · Promotion rule (Q1): first-fit.** Algorithm doc. After every change, scan WAITLISTED parties in `queue_position` order and promote each party that fits; a party that doesn't fit keeps its position. A newcomer is placed after the whole scan, so it is confirmed only if it still fits. Nothing is promoted at or after `starts_at`. Parties are never split. AC-HAPPY-9 drops its "block" fallback sentence; AC-HAPPY-3's existing waitlisted parties must be size 2 or more.

**R2 · Late fee is released when the place is refilled (Q3b) (user).** Algorithm doc option 3B, overriding the spec's "still charged" assumption. `withdrawal_fee_due` means "currently owed".
- It is set true only in the update that withdraws the row (LATE, nobody promoted in that step), and afterwards may only go true → false (trigger rule).
- Any later step before `starts_at` that confirms seats (newcomer, any promotion, ban-triggered promotion, auto-enrol, `promoteWaitlist` after a capacity edit) releases the oldest owed withdrawals first, whole parties, while seats confirmed in that step remain. A release is never undone, sends no email, and stops at `starts_at`.
- `decideAllocation` takes `openLiabilities` (owed withdrawals, oldest first) and returns `releasedLiabilities`. **Fixes critique high #1:** the architecture's normative transaction (architecture doc lines 462-471) also reads owed WITHDRAWN rows for the session under the session lock and applies a guarded `UPDATE ... SET withdrawal_fee_due = false WHERE id = ANY($released) AND withdrawal_fee_due`. A partial index on `(session_id, withdrawn_at) WHERE withdrawal_fee_due` supports the read.
- New AC-HAPPY-6b (MUST): a released fee drops out of `listBillableRegistrations`; tests cover release by a newcomer, a promotion, a capacity-edit promotion, a ban promotion and auto-enrol.
- **Copy (fixes critique medium #4):** never present the fee as final before start. AC-HAPPY-6 success: "You've withdrawn. No one could take your place yet, so the {fee} fee for your group applies unless someone takes your place before the game." Late-withdraw prompt, empty waitlist: "...so you'll be charged {fee} unless someone takes your place before the game. Withdraw anyway?"

**R3 · Re-registration while a fee is owed (Q3g) (user).** Allowed only when the new registration is CONFIRMED immediately with a group at least as large as the owed one; it then takes over the place and the fee flag is cleared. Otherwise 409 `late_withdrawal_fee_due` ("You owe the late-withdrawal fee for this session. You can register again only if there's a place for your whole group right now."), nothing written, refusal logged. Replaces AC-HAPPY-8's unconditional reset (**fixes critique high #2**). New error code goes into AC-VERIFY-7 and the `registration.refused` reasons. The journey doc's `fee_due_waitlist_refused` name is not used.

**R4 · Capacity backstop lock order (fixes critique high #3).** The deferred `registrations_within_capacity` trigger takes the session lock with `SELECT ... FOR UPDATE NOWAIT`. Allocator paths already hold that lock, so it succeeds at once. A writer that skipped the allocator and finds the lock held fails immediately with 55P03 instead of forming a registration → session wait cycle. Add a deterministic race test: an out-of-allocator promotion against each allocator path ends with the bypass refused and the allocator committed.

**R5 · Allocator and concurrency (Q2).** Architecture doc option 2A is binding:
- `createAllocator({ jobs, webBaseUrl })` with `registerInSession`, `autoEnrolInSession`, `withdrawFromSession`, `promoteWaitlist`, each taking `{ trx, now, log }`.
- Pure rules in `allocation.ts`; refusals are returned values.
- `SET LOCAL lock_timeout` (2 s HTTP, 5 s jobs) and a 3-attempt retry on 40P01/55P03 for this module's own transactions, with `now` read once before the first attempt.
- Only `promoteWaitlist` promotes; only `repo.ts` writes `registrations` (grep test).
- Migration ledger D-62..D-66, plus the R2 index.
- Worker pool goes from 2 to 5.
- This replaces the spec's `promoteWaitlist(trx, sessionId, now)` signature.

**R6 · Ban handler and sweep (Q4).** Architecture doc option 4A: one job per membership, one transaction per session through `withdrawFromSession({ cause: 'ban' })`, continue past a failed session, transient vs permanent classification as listed there. Sweep at `45 5 * * *` Pacific/Auckland (moved from `30 5 * * *` by R27/O4, human ruling 2026-10-24), once at worker start, and on demand, capped at 1000 memberships. Ban-triggered promotions release owed fees (R2).

**R7 · Cross-feature contracts (Q6).** Architecture doc option 6A: consumer obligations C-SSE-1..5, C-SAE-1..2, C-BIL-1..3, C-ALL-1 go into ADR 0018 and are re-checked at the build gate. C-BIL is extended: billing reads the hand-off at or after `starts_at`, when the fee flag is final; the list is empty for a CANCELLED or unpublished session. Guest rows carry `guestId` and `position`.

**R8 · Page ownership and entry (Q5).** User journey doc: this feature owns the player session page `/teams/[teamId]/sessions/[sessionId]` and an "Upcoming sessions" section on `/teams/[teamId]` (APPROVED members only), backed by a new `GET /teams/:teamId/sessions/upcoming` (`teamRole('MEMBER')`, next 10 sessions). New AC-ENTRY-4; add the route to AC-VERIFY-1. session-scheduling-engine owns admin pages under `/teams/[T]/manage/sessions` and follows the slot contract (`SessionSummary` + `RegistrationPanel`, only the panel changes a registration), recorded in ADR 0018. Phase 3 gains the endpoint, Phase 5 the section.

**R9 · Deadline passing while the confirmation is open.** Use the journey doc's API-side check, not the UI/UX doc's web re-check. The withdraw body becomes strict `{ expectLate: boolean }`; when the classification inside the transaction is LATE and `expectLate` is false, the API returns 409 `cancellation_terms_changed` and the page re-opens the confirmation with the late wording. New AC-ERROR-10.

**R10 · Ban copy.** The prompt is the AC-HAPPY-10 wording. The ban success message is unchanged: the journey and architecture docs agree, and the cancellation is eventual. The UI/UX doc's present-continuous success line is not used.

**R11 · Panel UI.** UI/UX doc option 1 is binding (stacked, state-driven panel, `panelView`, Server Components with client islands), with these rulings:
- **Focus:** focus does not move when guest fieldsets appear. On a failed submit, focus goes to the error summary. This replaces AC-VERIFY-8's "focus moves to Guest 1".
- **Confirmations:** extract `components/teams/confirm-disclosure.tsx` from `InlineConfirm`, keeping `InlineConfirm`'s behaviour.
- **Party option:** an option the party can never fit is natively `disabled` with visible hint text, not `aria-disabled` (AC-ERROR-4).
- **Fee estimate:** `estimateTotal` is shared in `packages/shared/src/registrations/fees.ts`.
- **Persisted withdrawn state:** derive the text from `withdrawalKind` and `withdrawalFeeDue`, as the journey doc proposes. EARLY, BANNED, or LATE with no fee due: "You won't be charged." LATE with a fee due: the R2 conditional copy.
- **Leave-waitlist prompt:** the UI/UX doc's wording.
- **Debt block:** "You have {n} overdue payments across your teams. Pay them before registering for more sessions. If you think this is wrong, ask your team admin."
- **Copy precedence:** the UI/UX copy table is final unless this section overrides it.
- **SHOULD:** `me.lateWithdrawalPreview` (journey doc A6), computed by a dry run of `decideAllocation`.

**R12 · Phase 1 fixture fixes.** These existing fixtures break under the new triggers and are fixed in Phase 1, followed by a full integration-suite run:
- `insertRegistration` writes WITHDRAWN rows with no stamps;
- `registrations-guests.int.test.ts:183` promotes with no `promoted_at`;
- the ban-seam stand-in withdraws with no stamps;
- `insertSession` makes a DRAFT session.

`insertPublishedSession` takes `now` and derives its dates from it (architecture doc A14).

**R13 · Other amendments adopted as written in the creative docs:**
- architecture doc: A1-A9 and A11-A15;
- algorithm doc: A4, A5, A7-A13 (the 1 ms deadline boundary, the open check before the early/late check, `liabilitiesReleased` on log events);
- journey doc: A4, A7, A8, A10, A12-A14 (A12 wording superseded by R11);
- UI/UX doc: 3-5, 10, 12-14, 16.

Where these overlap, the order of precedence is R1-R12, then the owning doc for that question (algorithm: Q1/Q3; architecture: Q2/Q4/Q6; journey: Q5 ownership; UI/UX: Q5 layout and copy).

### Plan Amendment 2026-10-20 (binding; supersedes R1-R13 and the creative docs where they conflict)

This amendment follows the rebase onto `main` (team-banking-and-gst merged; ADR 0016 is team-banking's) and the obligations skill-levels-and-auto-enroll recorded in its ADR 0017. That ADR is on PR #6, which is not merged yet. The user decided on 2026-10-20 to amend this plan rather than re-plan from scratch, to base it on `main` only (no stacked PR), to include the Auto Enroll labelling and email now, and to snapshot sex as well as skill level.

**R14 · Numbering.**
- This feature's ADR is **0018** (`docs/adr/0018-registration-allocation-and-billing-handoff.md`), and its ledger starts at **D-62**.
- ADR 0016 is team-banking's, and ADR 0017 with D-55..D-61 belong to skill-levels-and-auto-enroll (PR #6).
- Every "ADR 0016" written in this feature's creative docs means this feature's own ADR, now 0018.
- Re-check at the build gate: if PR #6 has not merged by then, or other numbers were taken, take the next free numbers on `main` and update this file.

**R15 · Registrant pricing snapshot (ADR 0017 C-PRICE-1; user: sex too).**
- New `registrations.registrant_skill_level skill_tier` and `registrations.registrant_sex sex`.
- They are written only by `repo.ts`, in the same `UPDATE` or `INSERT` that makes a row CONFIRMED, read from `team_members.skill_level` and `users.sex` under the member gate's `FOR SHARE` lock that the allocator already holds. Both registrant and auto-enrol paths gate the member before the session lock (architecture doc step 2), so no new lock is needed.
- A CHECK requires both to be non-NULL when `status = 'CONFIRMED'` or `withdrawal_fee_due`. A transition-trigger rule forbids changing them except on a transition into CONFIRMED.
- `listBillableRegistrations` returns the snapshot, and C-BIL gains "bill from the snapshot".
- `decideAllocation` stays pure: the snapshot values are inputs carried with each gated member.
- The fee estimate shown before confirmation uses the current level and names it. The level used for the charge is the one at confirmation.
- New AC-VERIFY-11. AC-INTEGRATION-3 is amended.

**R16 · Auto-enrol opt-out re-check (ADR 0017 C-SKL-1 point 4).**
- `autoEnrolInSession` input becomes `{ teamId, sessionId, entries: readonly { userId, assignedAt }[] }`, with entries in `selectAutoEnrollees` order (the selection also returns `membershipId`, which callers may pass through). This replaces C-SAE-1's `userIds`.
- In the gate step, under the `team_members FOR SHARE` row lock and before the session lock, the allocator re-checks `is_auto_enroll`, `auto_enroll_until IS NULL OR auto_enroll_until >= game_sessions.date`, and `auto_enroll_assigned_at = entry.assignedAt`, compared at millisecond precision. Any mismatch is a returned refusal `auto_enroll_changed`, a skip, never a throw.
- The session row's `date` is read without a lock for this comparison; the session lock still comes after all member gates.
- New AC-INTEGRATION-5, plus a deterministic race test against a held `FOR NO KEY UPDATE`.
- `auto_enroll_changed` joins the `registration.refused` reasons.
- C-SAE-1 in ADR 0018 is updated to match, including ADR 0017's lock-order advisory: auto-enrol for a session that already existed runs in a follow-up transaction that has not locked it.

**R17 · Auto-enrolled registrations are labelled and emailed (ADR 0017 later obligation; user: include now).**
- New enum `registration_source` (`MEMBER`, `AUTO_ENROL`) and `registrations.source NOT NULL DEFAULT 'MEMBER'`. `autoEnrolInSession` sets `AUTO_ENROL`, and any panel register or re-register sets `MEMBER`.
- A `send-email` job is enqueued in the placing transaction for each auto-enrolled member who was placed (CONFIRMED or WAITLISTED), never for skips. The template goes in `modules/registrations/emails.ts` beside the promotion email, with an idempotency key of `auto-enrol:<registrationId>:<registered_at ISO>`.
- The session page shows "Added automatically (Auto Enroll)".
- New AC-HAPPY-11.

**R18 · Team-banking obligations (ADR 0016 team-banking, binding).** Cite ADR 0016 in ADR 0018 and re-check at the build gate:
- **Lock order:** the canonical order is `teams` → `team_members` → `game_sessions` → `registrations` → `registration_guests`/`payments`. `teams FOR UPDATE` is reserved for leaf transactions (invite regenerate, banking removal). This feature never takes it, and never takes any `teams` lock after locking `game_sessions` or `registrations`.
- **Fixtures:** `insertPublishedSession` creates its team with `insertTeam({ payoutConfigured: true })`. This adds to R12's fixture list.
- **Publish gate:** this feature does not publish sessions. It must not bypass or re-implement the publish gate. A PUBLISHED session is assumed to have passed it.
- **C-BIL-PAY:** this is billing's (`teams FOR KEY SHARE` and a configuration check before a payment insert). The hand-off list stays money-free (AC-VERIFY-10).

**New source files / extends from this amendment:**
- The lifecycle migration gains `registration_source`, `source`, `registrant_skill_level`, `registrant_sex`, and their CHECKs and trigger rules (D-62 onwards).
- `emails.ts` gains the auto-enrol template.
- Extend `apps/api/test/helpers/factories.ts` (`insertPublishedSession` with `payoutConfigured: true`, auto-enrol column setters).
- `registrations-allocator.int.test.ts` and `registrations-races.int.test.ts` gain AC-INTEGRATION-5. `registrations-billing-handoff.int.test.ts` gains AC-VERIFY-11.

**Phase mapping:**
- Phase 1: R14 numbering, R15/R17 columns and CHECKs, R18 fixture.
- Phase 2: R15 snapshot writes, R16 re-check, R17 source on auto-enrol, the AC-VERIFY-11 and AC-INTEGRATION-5 domain halves, ADR 0018.
- Phase 3: R17 auto-enrol email.
- Phase 5: the R17 label and the R15 fee-line level.
- Phase 6: e2e unchanged; auto-enrol has no UI entry, so it is covered by integration tests.

### Plan Amendment 2026-10-24 (binding; session-scheduling-engine merged, ADR 0019)

This amendment follows the rebase onto `main` after session-scheduling-engine (SSE) merged (PR #7, merge cc324a3). SSE's ADR 0019 §8 "Contracts offered" and its hand-offs to this feature's build gate are binding here. Each item was checked against the code on `main`. Where this section and R1-R18 or a creative doc disagree, this section wins. The open decisions **O1-O4** were RESOLVED by human ruling on 2026-10-24, and each ruling is recorded where its item was raised. **Status: APPROVED (2026-10-24).**

**R19 · The allocator port and its single composition point (ADR 0019 §8; ARCH H10).**
- **Port.** SSE owns `SessionAllocatorPort` (`apps/api/src/modules/sessions/allocator-port.ts:50-80`); this feature owns the adapter.
  - `name: string`, `enrols: boolean`.
  - `promoteWaitlist(ctx, { teamId, sessionId }): Promise<readonly PromotedSeat[]>`, where `PromotedSeat` is `{ registrationId, userId, promotedAt }` (`:44-48`).
  - `autoEnrolInSession(ctx, { teamId, sessionId, entries }): Promise<readonly { userId, outcome }[]>`, where `entries` is `readonly { userId, assignedAt: Date, membershipId? }[]` (`:23-29`).
  - The outcome is `{ ok: true, status: 'CONFIRMED' | 'WAITLISTED' }` or `{ ok: false, reason }`. The reason is one of `overdue_payments | forbidden | already_registered | auto_enroll_changed | not_found | session_not_open | party_exceeds_capacity` (`:31-42`).
  - `ctx` is `{ trx: Transaction<DB>, now: Date, log }` (`:15-20`), and the adapter asserts `trx.isTransaction`.
- **Superseded signature.** This replaces the spec's `promoteWaitlist(trx, sessionId, now)` (Assumed output 4; already superseded in R5).
- **`decideAllocation` stays as planned.** R5's `createAllocator({ jobs, webBaseUrl })` signatures match the port structurally. The adapter is a thin wrapper.
- **Wiring.** Change only the body of `createSessionAllocator` (`apps/api/src/session-allocator.ts:26-29`). It returns `createRegistrationsSessionAllocator(createAllocator({ jobs, webBaseUrl }))`, with `name: 'registrations'` and `enrols: true`.
  - The deps are `{ db, jobs, clock, webBaseUrl }` (`:18-24`). `jobs` is the API producer in `main.ts:44` and the worker runner in `worker.ts:75`, so promotion and auto-enrol emails go on the caller's `trx` either way.
  - `AppDeps.sessionAllocator` (`apps/api/src/app.ts:71`) and `RegisterJobsOptions.sessionAllocator` (`apps/api/src/jobs/bootstrap.ts:45`) are already required. No environment variable selects the adapter.
  - The adapter may import only `allocator-port.ts` from `modules/sessions` (`boundaries.test.ts`).
- **`enrols` semantics.** `true` means the adapter really registers members.
  - SSE stamps the D-80 marker `game_sessions.auto_enrolled_at` only when `enrols` is true. It stamps in the same transaction as the placements (`apps/api/src/modules/sessions/auto-enrol.ts:149-155`).
  - Under the no-op it logs `session.auto_enrol.port_noop` and leaves the session pending (`auto-enrol.ts:95-105`).
- **Consequence of wiring the real adapter.** SSE's sweep (03:00 Pacific/Auckland and every worker boot) starts enrolling and stamping every pending PUBLISHED, not-started session.
  - SSE proves this only with a recording double (`apps/api/test/integration/sessions-contracts.int.test.ts:695-790`, "the marker proof").
  - This feature proves it with the real adapter in AC-INTEGRATION-6 (1).
- **Phasing.** The adapter is built and tested in Phase 2, with SSE's code paths using an injected adapter. The `createSessionAllocator` body swap waits for Phase 3, when both the promotion and the auto-enrol emails exist, so the branch never enrols anyone without emailing. `session-allocator.test.ts:24-33` currently expects `noopSessionAllocator` and is updated in that phase.

**R20 · Widen the D-85 predicate and its TypeScript twin together for the fee lock only, and split off a display count (ADR 0019 §8 and (b); ALG R-a; BIND T-17; O1 human ruling 2026-10-24).**
- **SQL.** The lifecycle migration replaces SSE's function (`db/migrations/20261020000100000_session_scheduling.sql:481-484`, today `status IN ('CONFIRMED','WAITLISTED')`) with `CREATE OR REPLACE FUNCTION game_session_has_active_registrations(p_session_id uuid)`. The new body also counts `status = 'WITHDRAWN' AND withdrawal_fee_due`, keeping `LANGUAGE sql STABLE`.
  - The down migration `CREATE OR REPLACE`s SSE's original body back. It must not `DROP` the function: SSE's trigger `game_sessions_fee_raise_locked` depends on it (`:505`), and SSE's own down migration drops it (`:519`).
  - The partial index `(session_id, withdrawn_at) WHERE withdrawal_fee_due` (R2) serves the new branch.
- **Two functions in `apps/api/src/modules/sessions/repo.ts`.** Both are reads, so `boundaries.test.ts` ("never writes registrations") still passes.
  - **Fee lock: `countActiveRegistrations(db, sessionIds)`** (`repo.ts:98-113`). It keeps its name and stays the TS twin of the SQL function, widened to the same rows: CONFIRMED, WAITLISTED, or WITHDRAWN with `withdrawal_fee_due`. The parity test keeps importing it. Its doc comment says it is the fee-lock count, not a "registered players" count.
  - **Display: new `countRegisteredPlayers(db, sessionIds)`.** It returns `Map<sessionId, number>`, counts only `status IN ('CONFIRMED','WAITLISTED')` (one per registration, as today), and has no SQL twin. It feeds the admin's "{n} players are registered" copy.
- **SSE call sites: one classification each, all changed in Phase 1**, in the same commit as the widening. At no commit does a fee-due withdrawal appear in the admin's "registered" count.

  | Call site | What it feeds | Count after the split |
  |---|---|---|
  | `service.ts:584` | the 409 `session_fee_locked` check under the session lock | fee lock |
  | `series-propagate.ts:81` | `existingInstanceOf(...)` → `reconcile.ts:146` `fee_locked` skip of a series fee raise | fee lock |
  | `view.ts:87` | `feesLocked` | fee lock: `toSessionResponse` gains a second option (for example `feeLockCount`); `activeRegistrationCount` keeps the display count |
  | `service.ts:290` (`viewOf`) | `activeRegistrationCount` and `feesLocked` | both: reads both counts |
  | `service.ts:369` (list) | `activeRegistrationCount` and `feesLocked` per row | both: reads both counts |
  | `series.ts:208` (series page) | per-row `activeRegistrationCount` (display) and the series-change preview (`series-view.ts:234-243`, `fee_locked` → `has_registrations`) | both: reads both counts |
  | `service.ts:796` | the cancel response's `activeRegistrationCount` (P-2: "let them know") | display |
  | `series-propagate.ts:236` | the end-series cancel count (P-2) | display |

  - The response field name `activeRegistrationCount` and the web copy in `apps/web/src/lib/teams/sessions-view.ts:414-424` are unchanged, since the field now carries the display count.
  - The OpenAPI descriptions that say the lock starts "once a PUBLISHED session has a registered player" (`routes.ts:110`, `:125`) gain "or a late withdrawal whose fee is still owed". `apps/api/openapi.yaml` is regenerated.
  - SSE's `view.test.ts` covers the new option.
  - **Known copy edge, not changed here:** a session whose only liable row is a fee-due withdrawal shows "No one has registered yet." beside `FEES_LOCKED_MESSAGE` ("Players have registered, so fees can only be lowered."). A copy change would be SSE's.
- **SSE tests: update them deliberately in Phase 1, not as collateral.**
  - `sessions-parity.int.test.ts:24-28`: the hand-written table splits WITHDRAWN into with and without `withdrawal_fee_due`; parity between `countActiveRegistrations` and the SQL function is kept. New case (AC-VERIFY-12): a session whose only row is a LATE withdrawal with `withdrawal_fee_due` is counted 1 by `countActiveRegistrations` and by the SQL predicate, and 0 by `countRegisteredPlayers`. When the fee is released (R2), all three are 0.
  - `sessions-schema.int.test.ts:980-991` and `:1033-1036`: the SQL predicate and the 23514 trigger now treat a fee-due withdrawal as active, and a released one as not.
  - `sessions-contracts.int.test.ts:638-655`: asserts the new function body text.
  - `sessions-contracts.int.test.ts:591` (C-SSE-4 cancel): its count stays a CONFIRMED + WAITLISTED count.
- **O1 RESOLVED (human ruling 2026-10-24): option (b), split.**
  - The widened predicate drives only the fee lock: the SQL function, `countActiveRegistrations`, and `feesLocked`.
  - `countRegisteredPlayers` drives every "{n} players are registered" display: the edit and fee-lock banners, cancel, end series, and the list and series rows.
  - Seat counting with guests, option (c), is not adopted.
  - ADR 0018 records the split and cites ADR 0019 §8.

**R21 · `already_registered` for an existing row in any status on the auto-enrol path (ADR 0019 §8; ALG R-b).** `autoEnrolInSession` returns `{ ok: false, reason: 'already_registered' }` for a member who already has a `registrations` row for the session, whatever its status: CONFIRMED, WAITLISTED, or WITHDRAWN of any kind, with or without `withdrawal_fee_due`.
- The row is never re-activated or relabelled. A retried durable job, or a sweep after a member withdrew, therefore never puts them back.
- This is checked under the session lock, after the member gates (R16), and before `decideAllocation`.
- It is a skip, and it does not apply to the member's own panel register. R3 still governs re-registration there.
- R3's `late_withdrawal_fee_due` never arises on this path, so it is not added to the port's reasons.
- Covered by AC-INTEGRATION-5's new bullet.

**R22 · Running inside SSE's transactions (ADR 0019 §2, §6, C-SSE-3, C-SSE-5, C-SAE-1/2 as amended).**
- **Lock order.** The canonical order is `LOCK_ORDER` (`apps/api/src/modules/sessions/locks.ts:25`): `teams → recurring_session_rules → team_members → game_sessions → registrations → registration_guests → payments`.
  - `registrations` comes after `game_sessions`. This feature never locks `recurring_session_rules`, and never takes a `teams` lock after a session lock (R18).
- **Port calls do not open a transaction.** They run in the caller's transaction:
  - SSE's `HTTP_POLICY`: 2 s `lock_timeout`, 3 attempts (`tx.ts:21`).
  - SSE's `JOB_POLICY`: 5 s, 3 attempts (`tx.ts:27`).
  - So they must not `SET LOCAL lock_timeout` or retry. They must be safe to re-run when SSE retries the whole transaction.
  - They use `ctx.now`, which SSE reads after its locks, and `ctx.log`. R5's own policy and single clock read apply only to this module's own transactions (register, withdraw, ban).
- **Auto-enrol.** It runs in SSE's follow-up transaction (`runSessionAutoEnrol`, `auto-enrol.ts:88-158`).
  - The first statement is SSE's advisory lock: `pg_advisory_xact_lock(SESSION_AUTO_ENROL_LOCK_NAMESPACE = 0x5345_4153, hashtext(sessionId))`, `locks.ts:39` and `:121`. Only SSE takes it, and this feature must never reuse the namespace.
  - Then come the member gates (`team_members FOR SHARE`, R16 re-check) and then the D-14 session lock.
  - SSE never calls the allocator with empty `entries`.
  - This supersedes the "inside the materialisation transaction" wording of C-SAE-1 in the architecture doc (line 590), which ADR 0018 records with a citation to ADR 0019 §6.
- **`promoteWaitlist`.** SSE calls it after `lockSession` and the capacity `UPDATE`, only when public capacity rose on a PUBLISHED, not-started session:
  - from the session `PUT` (`service.ts:608`);
  - per instance during series propagation (`series-propagate.ts:167`), in a transaction that already holds the rule lock and the instances' session locks in `(date, id)` order.
  - It re-takes the D-14 lock re-entrantly, may run several times in one transaction, and enqueues promotion emails on `ctx.trx`.
  - The R4 deferred capacity trigger (`FOR UPDATE NOWAIT`) finds those locks already held by the same transaction.
- AC-VERIFY-3 is amended accordingly.

**R23 · Page, route and component ownership (ADR 0019 §8 "Route namespace", "Slot contract acknowledgement").**
- **Pages.** SSE built admin pages only, under `/teams/[teamId]/manage/sessions`, and adds nothing to the player page.
  - The player page `/teams/[teamId]/sessions/[sessionId]` and the "Upcoming sessions" section stay this feature's (R8, journey slot contract).
  - SSE's check that no `apps/web/src/app/teams/[teamId]/sessions` directory exists (`sessions-contracts.int.test.ts:448-455`) fails by design when Phase 5 adds the page. Phase 5 rewrites it to assert the page is registration's and that the admin pages stay under `/manage/sessions`.
- **Routes.** Reserved for this feature: `GET /teams/:teamId/sessions/upcoming` and `/teams/:teamId/sessions/:sessionId/registration*` (`apps/api/src/modules/sessions/routes.ts:50`).
  - SSE's `GET /teams/:teamId/sessions/:sessionId` is `TEAM_ADMIN`. A test proves that a MEMBER's `GET .../sessions/upcoming` reaches registration's handler, since the static segment must win over SSE's parametric route (AC-VERIFY-1).
- **Components.** There is nothing to reuse as a component.
  - SSE's `SessionSummary` (`apps/web/src/components/teams/session-summary.tsx:47`) is an admin view over `SessionResponse` from a `TEAM_ADMIN` route. The player summary from the journey's slot contract fetches from `GET .../registration` and gets a distinct name (for example `components/registrations/player-session-summary.tsx`).
  - `sessionPath()` in `apps/web/src/lib/teams/sessions-paths.ts:12` is the admin path. The player path gets its own helper, for example `playerSessionPath` in `lib/registrations`.
  - SSE's pure formatters in `apps/web/src/lib/teams/sessions-view.ts` (`formatDay`, `formatClock`, `formatMoneyText`) may be reused for consistent dates and money.

**R24 · API conventions now on `main`: only those that apply to this feature's routes.**
- **O2 RESOLVED (human ruling 2026-10-24): another team's session id stays 404 on registration's routes.**
  - ADR 0019 (e) (human ruling 2026-10-24) answers 403 `forbidden` for an id that exists under another team, and 404 for an id that exists nowhere. The distinction comes from a lock-free `SELECT id` on the failure path only (`sessionExists`, `repo.ts:32`; `service.ts:312`), and the ruling covers SSE's admin routes.
  - This feature's AC-ENTRY-2 says 404 with an identical body for another team's id, a DRAFT id and an unknown id.
  - **Ruling:** option (a). AC-ENTRY-2 is unchanged: another team's id, a DRAFT id and an unknown id all answer 404 `not_found` with an identical body. Registration's service never calls `sessionExists` or any lookup by id alone.
  - **ADR 0018 records why this differs from ADR 0019 (e).** These routes are member-facing. A 403 would tell a member that a session id exists in a team they cannot see. The 404 rule was approved with this spec. SSE's 403 applies only to its `TEAM_ADMIN` routes.
  - A test in `registrations-api.int.test.ts` asserts the identical 404 body for all three cases.
- **Not adopted.** These are not adopted, because they don't fit this feature's routes:
  - `feesLocked: 'raise_only_blocked' | null`: an admin edit-form concern; registration only reads fees.
  - Explicit `changed` flags on write responses: register and withdraw are not idempotent saves; a repeat is a 409 `already_registered` or `not_registered`, AC-ERROR-3 and AC-ERROR-6.
  - The `expectedVersion` stale refusal: no registration route edits a versioned row. R9's `expectLate` is this feature's stale-terms guard.
- **O3 RESOLVED (human ruling 2026-10-24): accept and document; no `expectedSessionVersion` check.** Before the first registration, an admin may still raise fees or change times, so a player can register on terms that differ from the page they saw.
  - The register body stays as specified, with no session-version field and no 409 `session_changed`.
  - **ADR 0018 records the trade-off.** The window is only the first registrant(s) racing an admin edit, because once anyone is registered (or owes a late fee) D-85 stops fee raises (`game_sessions_fee_raise_locked`, 409 `session_fee_locked`). The fee line is an estimate. A deadline that moves while the withdraw confirmation is open is already covered by R9's `expectLate`.

**R25 · Numbering and migration order (re-check of R14).**
- **ADR.** On `main`, ADR 0018 is free, ADR 0019 is SSE's, and ADR 0017 is skill-levels'.
- **Ledger.** `db/schema-deviations.md` has D-01..D-61 and D-70..D-85, with D-84 reserved and not built. D-62..D-69 are free.
  - This feature's rows stay within D-62..D-69: R5's D-62..D-66 plus the R2 index, and R15/R17's columns and enums grouped into those rows.
  - If more rows are needed, continue at D-86, never in D-70..D-85.
  - The D-85 widening is recorded as a new D-6x row with the object key `function:game_session_has_active_registrations`. It cites ADR 0019 §8 and BIND T-17, and does not edit SSE's D-85 row.
- **Migration.** The newest migration on `main` is `20261020000100000_session_scheduling.sql`. The lifecycle migration's UTC timestamp is the build date, for example `20261024000100000_registration_lifecycle.sql`, and must sort after it.

**R26 · Fixtures and the SSE suites this feature's schema touches.**
- **`insertRegistration`** (`apps/api/test/helpers/factories.ts:460`) inserts CONFIRMED and WITHDRAWN rows with no `registrant_sex` / `registrant_skill_level` snapshot (R15 CHECK) and no withdrawal stamps (R12). SSE's suites insert such rows:
  - `sessions-schema`, `sessions-contracts` (C-SSE-4 with a WITHDRAWN row, `:591`), `sessions-parity`.
  - Phase 1 extends the factory to fill the snapshot for CONFIRMED, and the stamps and `withdrawal_kind` for WITHDRAWN, with defaults.
  - Phase 1 re-runs every `sessions-*` integration suite and `boundaries.test.ts`.
- **`insertPublishedSession`.** `insertSession` (`factories.ts:307`) now takes `{ status: 'PUBLISHED' }` and fills C-SSE-1-complete fees and a court. `insertPublishedSession` is built on it, with `now`-derived dates (R12, A14) and a payout-configured team (R18), rather than as a second raw insert.
- **The contract file.** `sessions-contracts.int.test.ts` is SSE's hand-off. Its header lists:
  - 1.1-1.5, the assumed outputs: Phases 1-2 (fees and instants), 2-3 (open rule, capacity raise, auto-enrol) and 5 (page);
  - C-SSE-1..5: Phase 2;
  - the port: Phase 2-3, R19;
  - D-85 a/b/c: Phase 1 R20, Phase 2 R21, Phase 3 R19;
  - the marker proof: Phase 3, AC-INTEGRATION-6.
  - It stays green except for the two checks R20 and R23 update deliberately.
  - The header test (`:659`) pins the header text, so the header is edited only to record what registration now provides.

**R27 · SSE rulings and lifecycle facts that change this feature's behaviour (ADR 0019 §1, §6; SSE archive "Requirements as built", P-1 to P-3).**
- **P-1: Auto Enroll applies to every session, one-off or series** (`auto_enrol_required` defaults to true, D-80).
  - Auto-enrol and its emails (AC-HAPPY-11) therefore fire for one-off sessions too.
  - On the first worker boot after the adapter ships, the boot sweep enrols every PUBLISHED, not-started session that was left pending since SSE merged. ADR 0019 §6 accepts this as the bounded exception to ADR 0017 point 7.
  - It sends one AC-HAPPY-11 email per placed member per session in that one run. Operators should expect that burst at deploy.
- **P-2: cancel and change send players no email.** SSE leaves every registration exactly as it was on cancel (C-SSE-4). A CANCELLED session can therefore hold CONFIRMED and WAITLISTED rows indefinitely.
  - The panel shows the journey A10 cancelled state ahead of "You're in." (AC-ERROR-2).
  - The ban handler and the sweep select PUBLISHED sessions only, so they never touch these rows.
  - `listBillableRegistrations` stays empty for a CANCELLED session (R7).
  - The "Upcoming sessions" list excludes it.
- **P-3: a series' pattern is fixed.** No effect on this feature.
- **Session lifecycle.**
  - `COMPLETED` is reachable only through billing (D-75).
  - Edits and cancels are refused after `starts_at` (409 `session_started`), which matches registration closing at `starts_at`.
  - A capacity cut never demotes anyone, so the over-capacity state handled by architecture A1/A5 is real on `main` (`CAPACITY_HINT`, `sessions-view.ts:427`).
- **Rollback order.** Once this feature ships, rolling SSE back requires rolling this feature back first. This feature widens D-85 and replaces the allocator body (SSE archive, Rollback). ADR 0018 states this.
- **O4 RESOLVED (human ruling 2026-10-24): `registration-ban-reconcile` moves to `45 5 * * *` Pacific/Auckland.** `skill-progression` already runs at `30 5 * * *`, commented as "the last daily slot" (`apps/api/src/jobs/schedules.ts:35-36`).
  - 05:45 is after the 02:00-02:59 DST window and after every other daily slot.
  - AC-ASYNC-3, R6 and creative question 4 are updated.
  - Phase 4 adds the slot to `schedules.ts` with a comment that it is now the last daily slot, and updates `skill-progression`'s comment.
  - `schedules.test.ts` gains `['registration-ban-reconcile', '45 5 * * *']` and the DST-hour check.

**New source files / extends from this amendment:**
- New: `apps/api/src/modules/registrations/session-allocator-adapter.ts` (+ `.test.ts`): `createRegistrationsSessionAllocator`.
- Extend:
  - `apps/api/src/session-allocator.ts` (body only) and `apps/api/src/session-allocator.test.ts`;
  - `apps/api/src/modules/sessions/repo.ts`: widen `countActiveRegistrations` (fee lock) and add `countRegisteredPlayers` (display), O1;
  - the SSE call sites in `service.ts`, `series.ts`, `series-propagate.ts` and `view.ts` (+ `view.test.ts`), per the R20 table;
  - the descriptions in `routes.ts:110` and `:125`, then regenerate `apps/api/openapi.yaml`;
  - `apps/api/test/integration/sessions-{parity,schema,contracts}.int.test.ts`: the D-85 cases, the fee-lock vs display case and the page check only;
  - `apps/api/test/helpers/factories.ts`: `insertRegistration` defaults;
  - `apps/api/src/jobs/schedules.ts` and `schedules.test.ts`: the 05:45 slot (O4).
- The web copy in `apps/web/src/lib/teams/sessions-view.ts` is unchanged.
- The lifecycle migration gains the `CREATE OR REPLACE` of `game_session_has_active_registrations` and its down-migration restore.

**Phase mapping:**
- Phase 1: R20 (SQL and TS widening, the display-count split with every SSE call site switched, the D-85 and fee-lock vs display test updates), R25, and R26's fixtures and suite re-run.
- Phase 4: the `registration-ban-reconcile` slot at `45 5 * * *` (O4).
- Phase 2: R19's adapter, R21, R22, and AC-INTEGRATION-6's domain half.
- Phase 3: R19's composition swap and test, R23's route precedence, the O2 404 test, and AC-INTEGRATION-6.
- Phase 5: R23's page, the tripwire rewrite, the component naming, and R27's cancelled copy.
- Phase 6: the e2e session via SSE's admin API.

---

## Execution State

**Build Status**: BUILD_COMPLETE (Phase 6 of 6)
**Auto-Build Mode**: YES
**Final Review Backend**: anthropic (codex unavailable: workspace out of credits). Verdict: ready to merge with fixes. 0 Critical, 1 Important (auto-enrol after the cancellation deadline creates a liability nobody chose and contradictory email copy; needs a human policy ruling), 8 Minor. C3 still awaits human acknowledgement.
**Current Phase**: all phases built; next /yay:reflect registration-and-waitlist
**Current Step**: Phase 6 built and committed (2026-10-25). Next: /yay:reflect registration-and-waitlist.
**Step Started**: 2026-10-16
**Can Resume**: YES
**Creative Critique**: CREATIVE CRITIQUE: codex — usable (needs-attention; 3 high + 1 medium, all resolved in the reconciliation)

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
- Step 4.5: Codex design critique - COMPLETE (needs-attention, 4 findings)
- Creative Reconciliation: COMPLETE (2026-10-16); user decided fee release on refill and confirmed-only re-registration
- Plan amendment: COMPLETE (2026-10-20). Rebased onto `main` (team-banking-and-gst merged). R14-R18 add numbering (ADR 0018, D-62+), the registrant sex/skill snapshot (C-PRICE-1), the auto-enrol opt-out re-check (C-SKL-1), the auto-enrol source/label/email, and the team-banking ADR 0016 rules. New ACs: AC-VERIFY-11, AC-INTEGRATION-5, AC-HAPPY-11. Taxonomy lint CLEAN (43 ACs). The user approved the amendment, keeping the existing spec and creative docs, with no stacked PR on #6.
- Plan amendment: APPROVED (2026-10-24). Rebased onto `main` after session-scheduling-engine merged (PR #7, cc324a3; ADR 0019).
  - R19-R27 cover the allocator port and composition, the D-85 SQL/TS widening, `already_registered` in any status, running inside SSE's transactions, page and route ownership, API conventions, numbering, fixtures and SSE suites, and SSE's rulings P-1 to P-3.
  - New ACs: AC-VERIFY-12 and AC-INTEGRATION-6.
  - O1-O4 RESOLVED (human ruling 2026-10-24):
    - O1: split into a fee-lock count `countActiveRegistrations` and a display count `countRegisteredPlayers`.
    - O2: registration keeps 404.
    - O3: accept and document, with no session-version check.
    - O4: the reconcile sweep moves to `45 5 * * *`.
- Phase 1 BUILD COMPLETE (2026-10-24): migration 20261024000100000_registration_lifecycle.sql (D-62..D-69), O1 count split (countActiveRegistrations fee-lock / countRegisteredPlayers display), shared contracts + 7 error codes, insertPublishedSession, fee-lock copy fix. Unit 2014, integration 674, build/lint/typecheck green. Review (codex + anthropic audit): 2 MAJOR + 5 MINOR fixed, re-verified.
- Phase 2 BUILD COMPLETE (2026-10-25): allocator core (allocation.ts, allocator.ts, repo.ts, tx.ts, deadline.ts, fees.ts, billing-handoff.ts, emails.ts), port adapter session-allocator-adapter.ts (not wired; Phase 3 swaps createSessionAllocator), ADR 0018, SSE copy carry-forward. Unit 2121, integration 782, coverage 96.4%/90.2%, build/lint/typecheck green. Review: Anthropic (1 BLOCKING, 2 MAJOR, 4 MINOR) + Codex adversarial (3 high): all fixed or documented, re-review APPROVED (iteration 2).
- Phase 3 BUILD COMPLETE (2026-10-25): registrations service/routes/read-model/access/errors, routes registered before SSE's (static `upcoming` wins), `createSessionAllocator` now returns the real adapter, OpenAPI regenerated with 401/403. AC-INTEGRATION-1 (a)-(d) repeated over HTTP; AC-INTEGRATION-6 proven through SSE's sweep, capacity PUT and series edit with the real adapter. Review: Anthropic APPROVED (5 MINOR) + Codex (1 P2: debtor on unknown/DRAFT/foreign session got 403 not 404, fixed test-first).
- Phase 4 BUILD COMPLETE (2026-10-25): real `MemberBannedHandler` (`modules/registrations/ban-handler.ts`, name 'registrations', one session per transaction under JOB_POLICY, continue on error, transient-first classification), sweep (`modules/registrations/reconcile.ts` + `jobs/ban-reconcile.ts`), queue and slot `registration-ban-reconcile` at `45 5 * * *` (O4), boot enqueue in `enqueueBootSweeps`, worker wiring and pool 2 to 5, repo reads `listBanTargets` / `listBannedWithActive`. `teams-ban-seam.int.test.ts` now runs the real handler (AC-INTEGRATION-2); AC-INTEGRATION-1 race (d) repeated over HTTP through the real handler path. ADR 0018 sections 10, 11 and Consequences updated (Phase 3 gate bucket 2 items i to iii, C3 sweep analysis).
- Phase 5 BUILD COMPLETE (2026-10-25): player session page + stacked RegistrationPanel, PlayerSessionSummary, Upcoming sessions section, Server Actions/api-client/proxy, ConfirmDisclosure extraction, restored ban confirmation copy, R17 label, SSE tripwire flipped; ban-handler fixed-clock carry-forward.
- Phase 6 BUILD COMPLETE (2026-10-25): `apps/web/e2e/registrations.spec.ts` (4 journeys x desktop and 360x740: register with a guest, waitlist a party of three, promotion on early withdrawal with Mailpit email, ban withdrawn within 30 s; late withdrawal wording; debt block; cancelled session), axe + no-horizontal-scroll + 44 px targets at every state; sessions created and published through SSE's admin API; docs (systemPatterns Test Scope Preferences, techContext, ADR 0018 status). 8/8 e2e passing.

### Guard & Recovery Log
- Post-build O5 (2026-10-25): final whole-branch review Important 1 fixed on a human ruling, test-first (RED seen: allocator integration, deadline_passed skip). Guard result recorded at commit.
- Phase 5 remediation 1 (2026-10-25): phase reviewer HALT (MISSING R15: fee estimate names the level only from the registration snapshot). Fixed test-first (RED seen: shared schema, integration read model, web component) with additive `me.feeLevel`. Guard result recorded at commit.
- Phase 5: guard PASS at 4267b7d (prod=29 test=14).
- Phase 3: guard PASS at 1516a22 (prod=7 test=13); later commits' results are in git log.
- Phase 1: commit guard result recorded at commit (see git log).
- Phase 2: guard result recorded at commit (see git log); no FAIL.
- Phase 2 remediation 1 (2026-10-25): phase reviewer HALT (Misunderstood, money-affecting): register branch spent one `seatsConfirmed` budget twice when a fee-due WITHDRAWN row re-registered (own fee cleared plus another owed fee released, under-billing). Fixed test-first (RED seen: unit, property seed 59): the release budget is now `seatsConfirmed - liablePriorPartySize` (floor 0) for a CONFIRMED newcomer. autoEnrol reuses the register path with no liable row (unaffected); rebalance has no newcomer; withdraw already netted. Added unit cases, property invariant I14, integration proof that the other fee stays billable.
- Phase 2 notes: allocator must null promoted_at when re-queuing WITHDRAWN to WAITLISTED; capacity trigger uses FOR UPDATE NOWAIT so tests must hold the session lock first; snapshot columns authoritative only for CONFIRMED and fee-due rows; source may change only on WITHDRAWN to active.

### Deviations
- Post-build | human-ruled O5 (2026-10-25) | allocator.ts autoEnrolInSession, allocator-port.ts, session-allocator-adapter.ts, shared AllocationRefusalReason, emails.ts | auto-enrol skips every member with `deadline_passed` once `now > cancellation_deadline` (locked row); auto-enrol email copy no longer carries the deadline-passed wording or a "Withdraw before" date; supersedes the R17 body text; ADR 0018 C3(b) sentence about an unlocked member gate removed and section 5 snapshot-lock claim corrected (final review).
- Phase 1 | reviewer-accepted | sessions-view.ts:425-427, lib/http/errors.ts:127-128 | FEES_LOCKED_MESSAGE / FEE_OVER_LIMIT_MESSAGE / session_fee_locked default reworded ('a player has registered or still owes a late-withdrawal fee') because the fee lock now also fires for a fee-due withdrawal (O1); requested by the build loop to resolve the 'No one has registered yet' contradiction.
- Phase 1 | reviewer-accepted | migration trigger | extra creative-doc rules (queue_position_stable, guest_count_frozen, promotion_stamp, fee_due_one_way, snapshot_immutable, source_immutable) and error codes late_withdrawal_fee_due, cancellation_terms_changed - plan-sanctioned.
- Phase 1 | builder choice | `source` changes only on WITHDRAWN->CONFIRMED|WAITLISTED; snapshot columns never cleared (authoritative for CONFIRMED and fee-due rows only); me.registration / fees shapes chosen by the TDD agent.
- Phase 2 | builder choice | allocator emits registration.* logs through ctx.log (Phase 3 service must not log them again); emails.ts (promotion + auto-enrol builders, keys per AC-ASYNC-1/AC-HAPPY-11) built this phase; withdrawFromSession accepts expectLate (R9) one phase early; estimateTotal/unitFee live in packages/shared/src/registrations/fees.ts (R11).
- Phase 2 | reviewer-required | listBillableRegistrations(trx, sessionId, now) requires a transaction, takes the session FOR SHARE and throws before_start when now < starts_at (codex high); Phase 4 billing must call it that way.
- Phase 2 | reviewer-required | banned WAITLISTED rows stay in the queue marked eligible:false (skipped by first-fit, withdrawable with cause 'ban'); newcomer queue position clears maxQueuePosition.
- Phase 2 | accepted residual | a ban committing concurrently with a promotion can still promote that member (lock order forbids locking team_members after the session); recorded in ADR 0018; consequence limited to a possible false promotion email, the Phase 4 ban handler withdraws with kind BANNED and no fee.
- Phase 2 | deferred | autoEnrolInSession reloads state per member (~6 queries each); recorded in ADR 0018. waitlistRank counts hidden banned rows (cosmetic).
- Phase 2 | carry-forward done | SSE UI copy deck (session-scheduling-engine-uiux.md) and sessions-view.ts series lines aligned to the fee-lock wording, test-first.
- Phase 2 | note | AC-INTEGRATION-1 races run through runAllocatorTransaction; Phase 3 must repeat them through buildAuthTestApp HTTP. ADR 0018 status is Proposed until merge.
- Phase 2 | reviewer buckets (remediation 1) | bucket 1 (fixed or documented above): listBillableRegistrations signature/FOR SHARE/before_start; banned waitlisted eligible:false; emails and expectLate built early; ADR 0018 Proposed; FEES_LOCKED carry-forward.
- Phase 2 | reviewer buckets (remediation 1) | bucket 2 (later phases): AC-INTEGRATION-1 must be repeated over HTTP in Phase 3; the systemPatterns Test Scope Preferences list is stale, fix it at reflect.
- Phase 2 | reviewer buckets (remediation 1) | bucket 3: the ban/promotion residual (ADR 0018 C3) is an accepted correctness gap that awaits human acknowledgement.
- Phase 3 notes: do not re-log registration.* events (the allocator already emits them); repeat the AC-INTEGRATION-1 races over HTTP.
- Phase 3 | builder choice | errors.ts overrides session_not_open / overdue_payments / party_exceeds_capacity messages to the AC wording with server-computed counts only (ERROR_DEFAULTS unchanged).
- Phase 3 | builder choice | read model runs in a REPEATABLE READ READ ONLY transaction; blockedReason precedence session_not_open, already_registered, overdue_payments, party_exceeds_capacity (public capacity < 1); a fee-due withdrawn caller keeps canRegister true and the allocator decides.
- Phase 3 | reviewer-required | register does a team-scoped lock-free readSessionHeader before the allocator, so a debtor gets the same 404 as everyone for unknown/DRAFT/foreign ids (Codex P2). For a visible closed session a debtor's POST is still 403 overdue_payments while the read model says session_not_open (documented in access.ts and ADR 0018 section 10).
- Phase 3 | accepted | withdraw feeEstimate is best-effort and may be "0.00" when the snapshot is unknown while withdrawalFeeDue is true (billing decides the charge); DB CHECKs prevent building the case on real rows, so pinned by a unit test.
- Phase 3 | test change | boundaries.test.ts money-table guard matches code references not prose, allows fastify imports, asserts only allocator.ts emits registration.created|withdrawn|promoted|refused; policy.test.ts team-route count 33 to 37. Race (d) uses withdrawFromSession(cause 'ban') through runAllocatorTransaction because the Phase 4 handler does not exist yet; repeat it with the real handler in Phase 4.
- Phase 3 | note | buildAuthTestApp/inertAppDeps still default to the no-op allocator, so sessions-* suites are unchanged; only registrations-sse-integration wires the real adapter. HTTP race tests use HTTP_POLICY (2 s lock_timeout) and would fail loudly (lock_retry) on a very slow machine.
- Phase 4 notes: call listBillableRegistrations(trx, sessionId, now) only at or after starts_at, inside a transaction.
- Phase 2 | reviewer-required | register branch released other owed fees with the seat a fee-due re-registrant took over (R2/R3 double waiver); budget now nets `liablePriorPartySize`.
- Phase 4 | builder choice | `createRegistrationsBanHandler` takes `{ db, jobs, clock, webBaseUrl }` (the AC text lists `{ db, jobs, clock }`; the allocator needs `webBaseUrl` for the promotion email link, as in creative Q4). Optional test seams `allocator`, `listTargets`, `runTransaction`.
- Phase 4 | builder choice | the sweep pages by keyset `(banned_at, id)` in pages of 500 inside one transaction instead of the creative's single `LIMIT 1000`, so a member whose job keeps failing permanently cannot starve the members behind it. Counts logged: scanned, enqueued, alreadyQueued, invalid. A BANNED row with no `banned_by` is counted `invalid` and skipped (cannot occur today: CHECK `team_members_ban_stamps`).
- Phase 4 | builder choice | the boot enqueue of the sweep lives in `enqueueBootSweeps` (bootstrap.ts, called by worker.ts after `registerJobs`) next to SSE's boot sweep, each in its own try/catch; creative Q4 said "in worker.ts after registerJobs", which this still is. `recurrence-rule.test.ts` boot-sweep tests updated (2 enqueues).
- Phase 4 | builder choice | the sweep integration tests live in their own file `registrations-ban-reconcile.int.test.ts` (own database, exact counts) instead of inside `registrations-ban.int.test.ts` (shared database, filtered by membership).
- Phase 4 | test change | `teams-ban-seam.int.test.ts` scenes now use PUBLISHED future sessions on a payout-configured team and a shared manual clock (the real handler selects PUBLISHED, future sessions); the transient case still injects its fault before the real handler runs and the permanent case still replaces it, because the fault is the contract's subject. `boundaries.test.ts`: PUBLIC import list gains `../teams/ban-hook.ts`; new guards for ban-handler.ts and reconcile.ts (no table writes, no ban_reason, no email, withdraw only through the allocator under JOB_POLICY, sweep reuses `enqueueMemberBanned`). `vitest.config.ts` coverage include gains `apps/api/src/jobs/ban-reconcile.ts`.
- Phase 4 | carry-forward done | listBillableRegistrations: no caller added this phase (the handler and sweep never call it), so the "at or after start, inside a transaction" rule is untouched; Phase 4 added no billing reader.
- Phase 4 | carry-forward done | AC-INTEGRATION-1 race (d) (player withdraw vs ban) now runs through the REAL ban handler over HTTP (`registrations-http-races.int.test.ts`).
- Phase 4 | carry-forward done | do-not-re-emit: the handler logs only `registration.ban.session_skipped` / `registration.ban.session_failed`; `boundaries.test.ts` (only allocator.ts emits registration.created|withdrawn|promoted|refused) and a handler unit test enforce it.
- Phase 4 | accepted residual (still pending human sign-off) | ADR 0018 C3, ban vs promotion. Did NOT reorder locks. Answer to "does the sweep narrow the window?": no, neither the handler nor the sweep narrows the window in which a banned member can be promoted (the one false promotion email is not preventable without the forbidden lock). They bound the consequence: the member-banned job runs right after the ban commits, selects by current state, takes the session lock and re-reads the row, so a promotion that commits after the ban still ends WITHDRAWN/BANNED (proved in `registrations-ban.int.test.ts` 'the ban/promotion residual'); if the job fails or never runs, the 05:45 and boot sweeps re-enqueue it, so a stuck CONFIRMED row lasts at most 24 h and billing only reads at or after starts_at.
- Phase 4 | doc fix (Phase 3 gate bucket 2) | ADR 0018: (i) the O2 404 visibility check precedes the member gate; (ii) a debtor POSTing to a visible closed session gets 403 overdue_payments while the read model says session_not_open; (iii) the HTTP race tests depend on the 2 s HTTP lock_timeout, a CI flake watch item.
- Phase 4 | reviewer-required | Anthropic review (APPROVED, 2 MAJOR doc + 6 MINOR): ADR 0018 C3 now states the limit that handler and sweep select only future sessions, so a banned member still CONFIRMED when a session starts (job failed permanently or exhausted retries before a successful sweep) is never healed and stays billable for that session; the same gap covers a register or auto-enrol whose unlocked member gate precedes the ban and commits after the handler's selection. This widens what the pending human sign-off of C3 must cover. `docs/getting-started.md` gained a "Ban reconciliation" runbook paragraph (05:45 slot, boot run, on-demand trigger, hook_failed, pool 5). The sweep "alreadyQueued" integration test now holds the singleton slot with a deferred job and asserts exact counts; `session_failed` logs the `registrationId` of a RegistrationInvariantError; repo comment about page stability corrected. Codex review of 28cc007..85f939c: no findings.
- Phase 4 | deferred | worker pool size 5 is hardcoded in worker.ts (it was hardcoded at 2); a `WORKER_DB_POOL_MAX` setting is the 12-factor follow-up. A mixed transient plus permanent run re-attempts the permanent session each retry (bounded by retryLimit, documented).
- Phase 5 | carry-forward done | ban-handler.ts passes `{ now: () => selectionNow }` into every per-session transaction (creative normative shape); unit test 'gives every per-session transaction the selection clock reading' seen RED first (clock advanced 60 s per session). Stamps are intentionally the selection instant.
- Phase 5 | reviewer-required | Anthropic B1 + Codex P2: pre-submit party Total line restored (`lib/registrations/total.ts partyTotal`, role="status", from me.unitFee, session.fees, pricingStructure); "Join waitlist" label predicted from guestCount + 1 > session.seatsLeft (server stays authoritative). Deviates from the orchestrator's "nothing client-side" rule on purpose: AC-HAPPY-2 and R11 require the total before submit. partyTotal uses the shared unitFee/sum/toMoneyString, not estimateTotal, because estimateTotal needs the registrant's own sex/level which the read model lacks.
- Phase 5 | reviewer-required (remediation 1, resolved) | R15 level naming: additive read-model field `me.feeLevel` (shared zod, OpenAPI, `read-model.ts`: snapshot for a CONFIRMED or fee-due row, otherwise the current level; null off BY_SKILL_LEVEL or when the caller is unknown). The web `feeLine` is fed from it, so a never-registered and a waitlisted caller see "Your fee (Intermediate): $X". Seen RED first (shared schema, integration read model, web component).
- Phase 5 | builder choice | RegistrationPanel takes pre-fetched `{teamId, data, now}` (one GET) instead of fetching itself (journey slot contract); cancelled state wins over an active registration (R27); closed state shows read-model session_not_open even for a debtor and a POST 403 overdue_payments maps to the API message plus "ask your team admin"; dates use formatDayShort + formatClock (creative copy) not formatNzDateTime; no ?notice= redirects (transient notes in a persistent role=status shell); segment not-found links only to My teams.
- Phase 5 | test note | player page.test.tsx proven RED by moving page.tsx aside (module not found). The ux-patterns.md file does not exist in the repo; creative UI/UX doc used.
- Phase 5 | accepted minor | test-only props initialParty/defaultOpen/initialGuests on production components; promotedLate and withdrawPrompt waitlistLength branch compare server fields (consider API field promotedAfterDeadline).
- Phase 5 | reviewer bucket 1 (accepted) | the pre-submit estimated Total line is shown because AC-HAPPY-2 requires it; `memory-bank/ux-patterns.md` is absent (creative UI/UX doc used); the four item-4 departures stay as recorded above; the ban-handler fixed clock (`{ now: () => selectionNow }`) is the creative normative shape.
- Phase 5 | reviewer bucket 2 (deferred) | Playwright E2E and axe checks belong to Phase 6; run `/yay:ux-ingest` after the feature to create `ux-patterns.md`. AC-VERIFY-5 wording reworded to name the NZ formatter (`formatDayShort` + `formatClock`, Pacific/Auckland) instead of `formatNzDateTime`.
- Phase 6 | guard | commit guard PASS at 4373d36 (prod=0 test=2); later commits' results are in git log.
- Phase 6 | RED seen | the first e2e run failed against a deliberately missing heading ("Registration panel"), then against real selector ambiguities (strict-mode on two matches) before passing; the 4 journeys x 2 projects pass against the Compose stack rebuilt from this branch.
- Phase 6 | builder choice | AC-INTEGRATION-4 uses capacity 3 (A + 1 guest, then B as a party of three waitlisted #1, promoted whole) instead of capacity 2 with B alone; it covers every listed step including the ban within 30 s. "B alone waitlisted" is exercised by unit/integration tests, not e2e. The only SQL write in e2e is three OVERDUE payments rows (no money row can be created through the app yet).
- Phase 6 | carry-forward done | Test Scope Preferences coverage list fixed; HTTP race tests' dependence on the 2 s lock_timeout recorded as a CI flake watch item (techContext, ADR 0018 Consequences); worker pool `max: 5` is a hardcoded literal in worker.ts, config key is a follow-up (techContext, ADR 0018 section 11); run `/yay:ux-ingest` after this feature (ux-patterns.md absent); ADR 0018 Status set to "Proposed until merge".
- Phase 6 | open for human | C3 (a ban can commit concurrently with a promotion, ADR 0018 Consequences) remains PENDING HUMAN ACKNOWLEDGEMENT before merge; not marked acknowledged.
- Phase 6 | reviewer | Anthropic APPROVED (non-blocking items fixed: strict-mode `.first()`, dialog collection asserted per person, techContext table layout and stale coverage bullet). Codex: no actionable findings.
