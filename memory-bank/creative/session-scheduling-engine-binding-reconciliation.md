# session-scheduling-engine: Binding Reconciliation (creative wave 1)

**Date**: 2026-10-20
**Inputs**: `session-scheduling-engine-recurrence-algorithm.md` (ALG), `session-scheduling-engine-architecture.md` (ARCH), `session-scheduling-engine-admin-user-journey.md` (UJ)
**Status**: BINDING. Where this doc and a wave 1 doc disagree, this doc wins. The UI/UX doc (wave 2), the task-file amendments, the build and ADR 0019 follow it.

The three wave 1 agents ran in parallel and recorded assumptions about each other (ALG hand-offs H1-H11, ARCH H1-H12, UJ H1-H13). This doc settles every point where they disagree. Rulings marked **(user)** were made by the user on 2026-10-20; the rest are orchestrator rulings with reasons.

## Product rulings (user)

### P-1 (user): Auto Enroll applies to every session, one-off or series
**Chosen**: every session gets its Auto Enroll members once, on its first DRAFT → PUBLISHED, whatever publishes it (materialiser, manual publish, draft retry). This follows PRODDUCT-OVERVIEW §2 ("all newly created game sessions") and extends ADR 0017 point 6, which left one-offs to this feature.
- ALG conflict-3 ruling stands. UJ's "one-off sessions never auto-enrol" is **overruled**: drop the one-off scope-line sentence about Auto Enroll. The publish confirm says "Members on Auto Enroll will be added to it." for every session, one-off or series. The shipped People-page hint in `skill-enroll-panel.tsx` stays as it is.
- ARCH H8: `auto_enrol_required` defaults to **true** for every session (one-off included). It is stamped `auto_enrolled_at` only when a real allocator (`enrols: true`) ran (SA-5).

### P-2 (user): telling registered players about a cancel or change is deferred
**Chosen**: out of scope for this feature. No notifier port. UJ's session-change notifier port (C3, H9) and its keys `session-cancelled:<id>` / `session-changed:<id>:<version>` are **dropped**, and nothing new is added to registration-and-waitlist's approved plan.
- The admin is told instead. The cancel confirm and banner and the published-session save banner carry `activeRegistrationCount`:
  - 0: "No one had registered."
  - n > 0: "{n} players were registered. Let them know it's cancelled." (or "…Let them know about the change." for a change)
- The count comes from `game_session_has_active_registrations` / a count variant (ALG conflict 10), read after the session lock (ARCH H6).
- Scope Boundaries keeps "Emailing registered players when a session is cancelled or changed" as out of scope, now as a decision rather than an open question.

### P-3 (user): a series' day, frequency, monthly week and first date are fixed after creation
**Chosen**: UJ H7. To change the pattern, the admin ends the series and creates a new one.
- ALG A4's "Starting from" re-pattern flow is **dropped**: no pattern-change endpoint and no deletion of mismatched dates on re-pattern. ALG's proposed AC-HAPPY-12 (pattern change) is not added.
- The API refuses a change to `frequency`, `day_of_week`, `monthly_week` or `starts_on` on an existing rule with 422 `validation_failed` (field code `series_pattern_fixed`). The form shows those fields read-only with "To change the day or how often it repeats, end this series and start a new one."
- Rule instances cannot change their `date` (UJ H6 = ARCH H4).

## Technical rulings (orchestrator)

### T-1: lock order
**Chosen**: ARCH SA-2. `teams → recurring_session_rules → team_members → game_sessions → registrations → registration_guests → payments`.
- ALG H4's implied order (rules → sessions → team_members) is superseded.
- The materialiser's auto-enrol never takes member locks inside the instance transaction, because T-2 moves it to a follow-up transaction. That removes the reason ALG needed sessions before members.

### T-2: auto-enrol runs in a follow-up transaction, always
**Chosen**: ARCH SA-3, which supersedes the spec's "same transaction when inserted" and ALG's same-transaction variant.
- In the materialiser, it runs inline right after the instance commits.
- For manual publish and draft retry, it runs through the `session-auto-enrol` job (singletonKey `session-auto-enrol:<sessionId>`), enqueued in the publish transaction (ALG H9).
- The sweep re-offers pending sessions (SA-5).
- Accepted cost: a window of milliseconds between publish and enrolment in which a player could register first.

### T-3: materialiser queueing
**Chosen**: ARCH SA-1. The `exclusive` sweep fans out to the `recurrence-rule` queue (`stately`, singletonKey `recurrence-rule:<ruleId>`). Rule create, edit and end enqueue in-transaction.
- UJ's "Publish drafts now" (`POST …/session-series/:ruleId/publish-drafts`, SHOULD) is a thin route that enqueues that same rule job and returns 202.

### T-4: horizon, publishing and the banking-email window
- **Horizon**: `RECURRENCE_HORIZON_DAYS`, `intInRange(7, 91, 28)`. The window is `[today, today + H]` inclusive, with today read once per job (ALG A2, ARCH SA-1).
- **Publish timing**: instances publish on creation unless the gate refuses. There is no lead time; D-84 stays reserved for one.
- **`windowStart`**: **Chosen**: ALG's Monday of the NZ week, which gives at most one banking email per rule per week. ARCH H2's "window's first date" would allow one email per day, so it is superseded.
- **Storage**: ARCH D-81 `payout_notice_window (rule_id, window_start)` is the durable claim. It must never update the rule row (ALG H3).

### T-5: series-edit propagation
**Chosen**: ARCH SA-9's single synchronous transaction, bounded by the horizon (at most about 14 instances), with ALG A3's target rules and skip reasons.
- **Lock order**: rule lock, then each instance in `(date, id)` order, under the HTTP lock timeout of 2 s, with retry on deadlock or timeout (`tx.ts`).
- **Targets (ALG A3)**: future DRAFT and PUBLISHED instances that are not overridden.
  - A PUBLISHED instance changes only while both its current and its new cancellation deadline are in the future.
  - A capacity raise calls `promoteWaitlist`.
  - Each instance takes all of the change or none of it.
  - The comparison is against the current rule, so a retried save changes nothing more.
- **Skipped**:
  - edited, started, COMPLETED or CANCELLED instances, or a passed deadline: counted by reason;
  - `fee_locked` (T-7): counted by reason.
- **Banking**: a free-to-paid change that would reach a PUBLISHED instance and that the gate refuses refuses the **whole** edit with 409 `payout_not_configured` (ARCH SA-9).
  - ALG's per-instance "banking not set up" skip reason is dropped.
  - UJ H4 ("never refused because of banking") is overruled, because a half-applied pricing change across a series is worse than a refusal with the banking link.
  - Unpublished DRAFT targets are updated regardless; the gate is only consulted at publish.
- **Response and UI** (UJ C2): `{ updated, unchanged, skipped: { edited, started, closed, deadlinePassed, feeLocked } }`. The form shows a before-save effect line from `seriesChangeEffect`, and the banner after saving reads "Series saved. {u} upcoming sessions updated. {e} edited sessions kept their own details." Other skip reasons are listed under it.

### T-6: End series
**Chosen**: a merge of ALG A4 (shortening) and UJ H11.
- `recur_until` is set to the chosen last date, and `is_active` becomes false when that date is today or earlier.
- Instances after the last date are handled like this:
  - unedited DRAFTs are **deleted** (they can never have had registrations; ARCH D-75 allows DELETE only for DRAFT);
  - edited DRAFTs and PUBLISHED sessions are kept, unless the admin ticks "Also cancel the {p} published sessions after this date". When ticked, those sessions are cancelled one at a time under the cancel rules, and the banner includes the P-2 registered-player count.
- Shortening `recur_until` anywhere other than End series is refused ("To stop the series sooner, use End series.").

### T-7: fee edits after registration
**Chosen**: ALG conflict 10. Once a PUBLISHED session has an active registration, fees can only go down.
- Refused with 409 `session_fee_locked`, backed by trigger `game_sessions_fee_raise_locked`:
  - a pricing-model change;
  - any fee increase, including free to paid;
  - a costing change that raises a rate the session follows.
- UJ H12 ("fees locked once anyone registered") is relaxed to allow decreases. The editor shows `feesLocked: 'raise_only_blocked'` as "Players have registered, so fees can only be lowered."

### T-8: the cancellation-deadline default
**Chosen**: ARCH D-74, a `deadline_is_default` column plus a DB trigger that keeps a default deadline at `starts_at − 48h` when the start moves (P1).
- ALG's "derive default-ness by equality" is superseded. Equality is ambiguous when an admin explicitly enters exactly 48 h, and the column keeps the rule in the DB.
- The API still accepts `cancellationDeadline: null` to mean "use the default".

### T-9: `fee_flat`
**Chosen**: ALG A5 and ARCH D-77 agree. `fee_flat = custom_player_rate ?? calculated_rate_per_player` on every save of a FLAT session, enforced by CHECK while PUBLISHED or COMPLETED. `custom_player_rate` NULL means the rate follows the suggestion. The suggestion divides by `max_players`, and ADR 0019 notes that unbilled host seats mean it doesn't quite break even.

### T-10: DST
**Chosen**: ALG conflict 6 as written. D-08 is unchanged.
- A gap time gets a 422 offering 03:30 or 01:30.
- An overlap time gets only the first 2:30 am (`'earlier'`).
- The materialiser rewrites a gap time to the real time.
- A rule save refuses any court time between 02:00 and 03:00.
- Field codes are `local_time_nonexistent` and `local_time_ambiguous`, with a `dstOptions` list.
- ALG H10 (a trigger refusing nonexistent times) is **not** adopted; TS validation plus the rewrite is enough.

### T-11: edits after start, closed sessions, labels
**Chosen**: UJ and ARCH SA-7 agree.
- Every edit and every cancel is refused after `starts_at` with 409 `session_started`. That rule lives in TS, because `now()` stays out of SQL rules.
- COMPLETED and CANCELLED are immutable (trigger).
- The API computes `phase` (`upcoming | started | ended`) from its clock, which gives the labels Started and Ended (UJ). PUBLISHED → COMPLETED belongs to billing.

### T-12: stale saves and replay
**Chosen**: ARCH SA-6. Writes carry `expectedVersion`, a no-op save returns 200, and creates carry `createKey`.
- A 409 `session_stale` / `series_stale` carries the current row.
- Copy follows UJ: "This session changed since you opened it. Review the latest version and save again." The spec's "Someone else changed…" is wrong when the job made the change.

### T-13: allocator port
**Chosen**: ARCH SA-4 with R16 `entries`. One composition function, `createSessionAllocator()` in `apps/api/src/session-allocator.ts`. `autoEnrolInSession` is never called with an empty `entries` list.
- Hand-offs to registration-and-waitlist go into ADR 0019's "offered" section and its build gate:
  - ALG R-a: widen the active-registrations function to fee-due withdrawals.
  - ALG R-b: treat an existing row in any status as `already_registered`.
  - ARCH H10: the composition function and the superseded `promoteWaitlist(trx, sessionId, now)` signature.

### T-14: AC prefixes
The project declares no taxonomy extensions, so UJ's proposed AC-NAV-1/AC-NAV-2 become AC-HAPPY or AC-INTEGRATION entries. AC-NAV is not allowed.

### T-15: numbering and migration
ADR 0019. One migration `20261020000100000_session_scheduling.sql`, ledger D-70..D-83, with D-84 reserved (ARCH SA-8, using the T-8 column). The build gate re-checks that these numbers are still free against registration's reservation (ADR 0018, D-62..D-66 plus its R2 index).

### T-16: existing tests broken by Phase 1
These come from ARCH. They are fixed in the Phase 1 commit, never weakened:
- `paid-session-matrix.ts` gains a `publishable` flag.
- The new factory helper `advanceSessionTo` walks the legal lifecycle path instead of raw `DRAFT → COMPLETED` updates.

## Superseded points (summary)
| Doc | Point | Superseded by |
|---|---|---|
| UJ | One-off sessions never auto-enrol | P-1 |
| UJ | Session-change notifier port (C3, H9) | P-2 |
| ALG | A4 "Starting from" re-pattern; AC-HAPPY-12 (pattern change) | P-3 |
| ALG | H4 lock order rules → sessions → members | T-1 |
| ALG / spec | Same-transaction auto-enrol for inserted sessions | T-2 |
| ARCH | H2 `windowStart` = window's first date | T-4 (Monday of the NZ week) |
| ALG | Per-instance "banking not set up" skip in series edit | T-5 (whole-edit refusal) |
| UJ | H4 series save never refused for banking | T-5 |
| UJ | H12 fees fully locked | T-7 (decreases allowed) |
| ALG | No `deadline_is_default` column | T-8 |
| ALG | H10 nonexistent-time trigger | T-10 (not adopted) |
| UJ | AC-NAV-1/2 | T-14 |
| ARCH | D-81 `payout_notice_window` column + UPDATE of the locked rule row | T-18 (`payout_notice_claims` table) |
| ARCH | `runSessionAutoEnrol` unlocked marker read before the allocator call | T-19 (advisory xact lock, re-read, stamp in same tx) |
| ALG / ARCH | Fee-lock predicate assumed to exist (registration's `withdrawal_kind`) | T-17 (this feature ships the predicate as D-85; registration widens it) |

## Wave 2 (UI/UX) acceptance

**Chosen**: `session-scheduling-engine-uiux.md` is accepted with its six assumptions confirmed:
1. A blank "Court hire" means $0.00, which makes a free session. AC-HAPPY-2 is amended to say so.
2. The list GET returns `isPayoutConfigured`.
3. Series instance rows carry `activeRegistrationCount`.
4. The list GET supports keyset paging.
5. `seriesChangeEffect` gives a per-instance value: `will_update`, `edited`, `closed` or `has_registrations`. There is no `needs_banking` value, because T-5 refuses the whole edit instead.
6. `bankingReturnTo` already accepts sessions paths.

The rate input moves from Costing into Pricing, and Places comes before Costing. Both supersede the spec's Element text.

## Critique rulings (Codex adversarial review, 2026-10-20)

### T-17: the active-registrations predicate ships with this feature, and registration widens it later
**Chosen**: this feature's migration creates `game_session_has_active_registrations(p_session_id uuid) RETURNS boolean`, which is true when a `registrations` row has `status IN ('CONFIRMED','WAITLISTED')`. It also creates the fee-raise backstop trigger `game_sessions_fee_raise_locked` that uses it.
- Ledger: **D-85** for the function and trigger together. D-84 stays reserved.
- registration-and-waitlist's lifecycle migration `CREATE OR REPLACE`s the function to also count `WITHDRAWN` rows with `withdrawal_fee_due` (ALG R-a). This goes in ADR 0019's "offered" section and is re-checked at registration's build gate.
- The function is safe whichever feature merges first: it reads only columns that exist on `main` today.
- Tests:
  - raw SQL: a fee raise with an active registration fails 23514; a decrease succeeds;
  - a race test: a registration insert against a fee edit, both under the session lock.

### T-18: the banking-email claim is its own table
**Chosen**: a dedicated table `payout_notice_claims (rule_id uuid REFERENCES recurring_session_rules ON DELETE CASCADE, window_start date, claimed_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY (rule_id, window_start))`, claimed with `INSERT … ON CONFLICT DO NOTHING RETURNING` in the instance transaction. The email is enqueued only when a row comes back.
- This **supersedes ARCH D-81** as written (a column on `recurring_session_rules` plus an UPDATE of the locked rule row), which T-4 already forbade.
- The D-81 ledger row and the migration's down section are rewritten to match.
- Test: two concurrent instance transactions for the same rule and window enqueue exactly one email.

### T-19: auto-enrol runs serialised per session
**Chosen**: the follow-up auto-enrol transaction (`runSessionAutoEnrol`) runs in this order:
1. Its **first statement** takes `pg_advisory_xact_lock(<sessions-auto-enrol namespace>, hashtext(session_id))`, before any row lock. Taking it first keeps the canonical row-lock order intact, and only this one code path ever uses the lock.
2. It re-reads `auto_enrol_required`, `auto_enrolled_at` and `status` after the lock. It returns if the session is already enrolled, not PUBLISHED, or not required.
3. It calls `selectAutoEnrollees`, then `allocator.autoEnrolInSession`, and stamps `auto_enrolled_at` **in the same transaction**, and only when `allocator.enrols === true`.

Effect:
- An inline materialiser follow-up and a sweep or replayed `session-auto-enrol` job serialise.
- The second one sees the marker and does nothing, which keeps the once-per-session promise even though pg-boss delivers at least once.
- Allocator effects and the marker commit or roll back together.
- The advisory-lock namespace constant goes in `locks.ts` and is recorded in ADR 0019.
- Race test: inline follow-up against the sweep job against a replayed job gives exactly one `autoEnrolInSession` call (recording double) and one stamp.

### T-20: the task file is brought in line before build
**Chosen**: the Specification ACs, Success Criteria copy, Scope Boundaries, Implementation Roadmap (new files, queues and handlers) and Test Strategy are rewritten to match this doc and the four design docs' amendment lists, then re-linted. This is done before CREATIVE_COMPLETE.
