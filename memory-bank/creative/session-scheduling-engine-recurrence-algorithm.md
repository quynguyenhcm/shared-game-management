# Algorithm Decision: Session Scheduling Engine (recurrence, horizon, propagation, DST input, fees and costing)

**Created**: 2026-10-20
**Status**: DECIDED
**Decision Type**: Algorithm
**Task**: session-scheduling-engine (Level 4). **Resolves**: A1-A5 and conflicts 2, 3, 5, 6, 10 from the task file's "Creative Exploration Needed". Numbering: ADR 0019, ledger D-70 onwards (allocated by the architecture doc, not here).

**Sources read**: task file `## Specification` and `## Architectural Plan`; PRODDUCT-OVERVIEW §2 and §4; workflows §4; `memory-bank/creative/platform-foundation-algorithm.md` (Q6 money, Q7 DST and its hand-off table, Q11 `fee_other`); ADR 0009, 0010, 0012, 0016 (gate contract, recurrence contract points 1-6), 0017 (C-SKL-1 points 1-7, C-GAME-1 point 3, C-PRICE-1); `packages/shared/src/time/time.ts`; `packages/shared/src/money/money.ts`; migrations `20260929000500000_recurring_session_rules.sql` and `20260929000600000_game_sessions_and_courts.sql` (incl. `nz_local_to_utc` and `game_sessions_derive_instants`); `apps/api/src/jobs/send-email.ts` (`enqueueEmail` dedupe); `apps/api/src/lib/config/config.ts` (`intInRange`); registration-and-waitlist branch tip: task file R14-R18, `registration-and-waitlist-allocator-architecture.md` (C-SSE-1..5, C-SAE-1..2, C-BIL-1..3), `registration-and-waitlist-allocation-algorithm.md` (billing computes fees at charge time); learned rules `db-derived-flags-and-gates`, `testing-injected-clock`, `job-queues-pgboss`.

**Facts that drove the decisions** (verified in code, not assumed):
- `recurring_session_rules` has `frequency`, `day_of_week 0..6`, one default start/end time, `recur_until`, `is_active`, and no anchor date, no per-court template, no version (gap 9).
- `session_courts.start_time`/`end_time` are local `time`. `game_sessions_derive_instants` always resolves with `compatible`: a gap shifts forward, an overlap takes the earlier instant. `nz_local_to_utc(..., 'later')` exists but no stored column can ask for it.
- `enqueueEmail` dedupes through `singletonKey` only while a job with that key is queued or active. After the email is sent, the same `idempotencyKey` sends again. A durable guard is therefore needed for "at most one email per rule per window".
- Registration snapshots the registrant's sex and skill level (R15) but **not the fee**. Billing computes the amount at charge time from the session's `fee_*` columns (allocation algorithm, hand-off point 7). So any fee change on a PUBLISHED session changes what already-registered players pay.
- `uq_game_sessions_rule_date (recurring_rule_id, date)` is the idempotency key. A CANCELLED row keeps its key.
- Config already has `intInRange(min, max, fallback)` for bounded integer env vars.

---

## Problem Statement

Turn a recurring series definition into concrete dated session instances, keep those instances consistent with later series edits without overwriting what an admin changed by hand, decide when instances open for registration (and so when Auto Enroll runs), accept admin-entered wall-clock times safely on the two NZ daylight-saving days, and price sessions exactly, without letting a fee change silently reprice players who already registered.

## Inputs & Outputs

### Inputs
| Name | Type | Size/Range | Source |
|------|------|------------|--------|
| Series rule | `frequency`, `day_of_week` (0 = Sunday), `starts_on: LocalDate` (new), `monthly_week: 1..4 \| -1` (new, MONTHLY only), `recur_until: LocalDate \| null`, `is_active` | Per team: 1-10 rules | `recurring_session_rules` |
| Court template | ordered `{ courtIdentifier, startTime, endTime }[]` | 1-20 courts | new rule-court template (architecture owns its shape) |
| Series defaults | location, address, max players, reserved seats, court cost, extras, custom rate, pricing structure, fees | Money as `numeric(10,2)` | `recurring_session_rules` |
| Run instant `now` | `Date` (UTC) | read once per run or per request | injected `Clock` |
| Horizon `H` | integer days | 7..91, default 28 | env `RECURRENCE_HORIZON_DAYS` (P7) |
| Existing instances | `{ id, date, status, is_instance_overridden, starts_at, cancellation_deadline, fees, max_players, reserved_seats, courts }` | at most about 13 future per rule | `game_sessions`, `session_courts` |
| Has active registrations | boolean per session | | `registrations` read under the session lock (SQL function, H6) |
| Admin-entered local date/time | `LocalDate`, `LocalTime` | | API body |

### Outputs
| Name | Type | Description |
|------|------|-------------|
| `recurrenceDates(rule, window)` | `LocalDate[]` ascending, no duplicates | Calendar dates of the series inside an inclusive window |
| Instance plan | `{ fields, courts (DST-normalised), startsAt, cancellationDeadline }` | What the materialiser inserts for one date |
| Reconciliation plan | per instance: `update`, `delete`, `keep_off_pattern`, `skip(reason)`, `unchanged` | What a series save does to existing instances, and the counts shown to the admin |
| Costing | `calculated_rate_per_player`, `fee_flat` | `ceil` to whole dollars; final FLAT rate |
| DST refusal | 422 with representable options | For admin-entered times on a gap or overlap |
| Fee-raise verdict | ok, or a list of raised fee fields | Decides `session_fee_locked` |

### Edge Cases
1. Window wholly before `starts_on` or wholly after `recur_until`: empty list.
2. `recur_until == starts_on`: exactly one date.
3. MONTHLY anchor on a 5th weekday: stored as "last" (`monthly_week = -1`), so every month has a date.
4. MONTHLY anchor that is both the 4th and the last weekday: the admin chooses 4th or last. They differ in months with five of that weekday (V12 and V13).
5. Year boundary and leap February: plain calendar arithmetic (V10, V16).
6. Series date that is a DST-change day: dates are unaffected (calendar only). The stored court time is normalised for a gap. An overlap resolves to the earlier instant.
7. Instance whose computed start has already passed (series created at 21:00 for a 19:00 session today): not created.
8. A series edit or pattern change that hits CANCELLED, COMPLETED, started, or admin-edited instances: never touched.
9. A pattern change back onto a date that has a CANCELLED instance: the date stays cancelled (`ON CONFLICT DO NOTHING`).
10. A fee raise on a PUBLISHED session with registrations: refused, or skipped for that instance in a series save.
11. Two materialiser runs at once (daily sweep and per-rule run): one row per `(rule, date)`, and the loser inserts nothing.
12. Empty template (no courts): the rule is invalid and save refuses it (422). The materialiser never sees it.

## Constraints

### Performance Requirements
- **Maximum Latency**: series save (rule write plus synchronous reconciliation of at most about 13 instances) p95 under 1 s. Instance edit p95 under 300 ms, holding the session row lock only for its own statements (C-SSE-5; registration's 2 s `lock_timeout`).
- **Throughput**: the daily run finishes far inside the 900 s job expiry. Target under 60 s at 10x scale.
- **Memory Budget**: per rule, O(dates in window), at most about 14 `LocalDate`s. No full-table loads.

### Scale Requirements
- **Current Data Size**: pre-launch, with no app-written `game_sessions` rows. Assume 100 teams with 1-3 rules each, 1-20 courts and about 12-40 players.
- **Expected Growth**: 10x (1,000 active rules) in two years.
- **Peak Load**: the daily sweep, plus a per-rule run on each series create or edit, plus admin edits on the same sessions.

### Other Constraints
- P1: every invariant also holds in the DB. P2: money only as `Money`/`MoneyString`. P3: dates are NZ calendar dates, instants UTC, and no host-TZ dependence. P5: emails and jobs are enqueued in the domain transaction. P7: the horizon is a zod-validated env var.
- ADR 0016: gate before any `game_sessions` lock; one instance per transaction; refused instance saved as DRAFT; at most one admin email per rule per run window; retry unedited materialiser drafts.
- ADR 0017 C-SKL-1: auto-enrol only after PUBLISHED; selection with `sessionDate = game_sessions.date`; same transaction only when the session row was inserted in it, otherwise a follow-up that has not locked the session.
- C-SSE-1..5 and C-SAE-1..2 as amended by R16.
- D-08 (trigger-derived instants, shared with billing's `ends_at` sweep) should not change unless it must.

---

## Options Explored

The work splits into nine decisions. Each has 2-4 options and one **Chosen** line. The complexity tables at the end cover the decisions where complexity differs between options (A1/date generation, A2/horizon, A3/propagation).

### Decision A1: what MONTHLY means, and the series anchor

The existing `day_of_week` column says which weekday but not which week. Fortnightly parity also needs a reference date, and the schema has none.

#### Option A1-1: Same day of month as the first date
- **Approach**: the 15th of every month. `day_of_week` is ignored.
- **Pseudocode**: `for m in months: d = date(y, m, min(anchor.day, daysIn(y, m)))`
- **Time Complexity**: Best/Avg/Worst O(months in window).
- **Space Complexity**: O(output).
- **Data Structures**: none beyond the anchor.
- **Pros**: simple; matches calendar apps' "monthly on day 15".
- **Cons**: the weekday drifts every month, but clubs book courts by weekday. It makes `day_of_week` meaningless (or contradictory) for MONTHLY. Days 29-31 need a clamp or skip rule.
- **Best For**: billing-style schedules. **Worst For**: weekly court bookings, which are this product.

#### Option A1-2: Nth weekday derived from the anchor; a 5th-weekday anchor skips months without a 5th (RFC 5545 `BYDAY=5WE`)
- **Approach**: ordinal `k = ceil(anchor.day / 7)`. Months with no k-th weekday produce nothing.
- **Time Complexity**: O(months in window).
- **Space Complexity**: O(output).
- **Pros**: no new column; faithful to iCalendar.
- **Cons**: a 5th-weekday series happens only about 4 times a year, which no admin expects. "Last Friday" cannot be expressed from a 4th-Friday anchor.
- **Best For**: calendar interop. **Worst For**: clubs that mean "last Friday".

#### Option A1-3: Nth weekday derived from the anchor; a 5th clamps to "last"
- **Approach**: `k = ceil(anchor.day / 7)`. When `k = 5`, use the last weekday of each month.
- **Time Complexity**: O(months in window).
- **Space Complexity**: O(output).
- **Pros**: no new column; every month has a date.
- **Cons**: an anchor that is both 4th and last is silently read as "4th". An admin who means "last Wednesday" and picks 28 Oct 2026 gets 23 Dec instead of 30 Dec (V12 against V13). The meaning is implicit in the data.
- **Best For**: a minimal schema. **Worst For**: the 4th-or-last ambiguity, which recurs every month.

#### Option A1-4: Explicit `monthly_week ∈ {1, 2, 3, 4, -1 (last)}` plus a mandatory `starts_on` anchor, both CHECKed for consistency
- **Approach**: `starts_on` is the series' first date. It must fall on `day_of_week`, and for MONTHLY it must be the `monthly_week`-th (or last) such weekday of its month. Weekly gives every 7th day from `starts_on`. Fortnightly gives every 14th day from `starts_on`, so parity comes from the anchor. Monthly gives the `monthly_week`-th (or last) `day_of_week` of each month from `starts_on`'s month. The UI derives the default ordinal from the anchor (`ceil(day/7)`, with 5 becoming -1) and offers "4th" or "last" when the anchor is both.
- **Pseudocode**: see "Algorithm Steps" below.
- **Time Complexity**: Best O(1) for an empty window. Average and worst O(d + m), where d is dates out and m is months scanned. With H ≤ 91, d ≤ 14 and m ≤ 4.
- **Space Complexity**: O(d).
- **Data Structures**: integer epoch-day arithmetic; no collections beyond the output array.
- **Pros**: total and unambiguous; every month has a date; the stored row says what the admin chose. It also gives Fortnightly its parity anchor and gives "first date" a home. DB CHECKs make an inconsistent rule impossible (P1).
- **Cons**: one more column and one more CHECK. The UI must offer the 4th-or-last choice.
- **Best For**: club schedules ("first Wednesday", "last Friday"). **Worst For**: nothing in scope.

**Chosen**: **A1-4.** Add `starts_on date NOT NULL` (anchor and first date) and `monthly_week smallint` (NOT NULL iff MONTHLY, values 1-4 or -1). `day_of_week` is kept and CHECKed equal to the weekday of `starts_on`, convention **0 = Sunday** (PostgreSQL `extract(dow)`, JS `getUTCDay()`). A 5th-weekday anchor is stored as -1. Recorded in ADR 0019.

### Decision A2 (with conflict 5): horizon, publish timing and the email window

#### Option A2-1: Materialise every date up to `recur_until` (the overview's wording)
- **Approach**: generate the whole series at create time.
- **Time Complexity**: O(total occurrences). Unbounded when `recur_until` is NULL, so some cap would still be needed.
- **Space Complexity**: O(total occurrences) rows.
- **Pros**: matches the overview's literal text.
- **Cons**: impossible for open-ended series. A two-year weekly series is 104 rows that every series edit must reconcile. Auto Enroll would register members two years ahead.
- **Best For**: short fixed series. **Worst For**: open-ended series, which are the normal case.

#### Option A2-2: Rolling horizon H, and an instance is published when it is created (gate permitting)
- **Approach**: each run creates every missing date in `[today, today + H]` whose start is still in the future, and publishes it straight away when the gate allows. Materialisation horizon and publish horizon are the same. Auto Enroll runs at that publish.
- **Time Complexity**: per rule per run O(d + e), where e is existing instances in the window. d ≤ 14.
- **Space Complexity**: O(rules × H/7) live future rows.
- **Pros**: one concept and one env var. It matches workflows §4 (generate then enrol) and ADR 0016 points 1-6 exactly: the only materialiser drafts are gate-refused ones, so "unedited draft means retry the publish" is unambiguous. Players see H days ahead.
- **Cons**: one global lead time for every team. Admins cannot see or pre-edit a date before it opens, so a holiday date appears already published (mitigated by the optional "skip a date" hand-off J7).
- **Best For**: v1 with one setting. **Worst For**: clubs that want registration to open exactly N days before, different from H.

#### Option A2-3: Materialise further ahead (H) and publish at a lead time L < H
- **Approach**: instances are DRAFT until `date - L`, then the materialiser publishes them, which reuses ADR 0016's retry path.
- **Time Complexity**: same as A2-2, plus one publish pass over drafts in `[today, today + L]`.
- **Space Complexity**: same order as A2-2.
- **Pros**: admins see and adjust drafts before players do; Auto Enroll happens closer to the date.
- **Cons**: it overloads `is_instance_overridden`. An admin who tweaks a future lead-time draft would silently stop it auto-publishing (ADR 0016 point 6 leaves edited drafts to the admin), which traps the admin. Fixing that needs a separate `auto_publish` flag, plus a third draft kind to explain in the UI.
- **Best For**: per-club registration windows. **Worst For**: v1 simplicity and the ADR 0016 semantics.

#### Option A2-4: A2-3 with a per-series `publish_lead_days` column
- **Approach**: as A2-3, with L per rule.
- **Time Complexity**: same as A2-3.
- **Space Complexity**: same as A2-3.
- **Pros**: the most flexible.
- **Cons**: everything in A2-3's Cons, plus a schema column, UI and validation (L ≤ H).

**Chosen**: **A2-2.**
- **Horizon**: `RECURRENCE_HORIZON_DAYS = intInRange(7, 91, 28)`. The run computes `today = instantToLocal(now).date` once, `windowEnd = addLocalDays(today, H)`, window inclusive at both ends.
- **Publishing**: an instance is published when it is created, unless the gate refuses.
- **Started instances**: a date whose derived `starts_at <= now` is not created.
- **Minimum and maximum**: 7 days guarantees the next weekly instance always exists. 91 days caps reconciliation at 14 instances per rule.
- **Door type**: two-way. A later lead time can be added as a new column defaulting to H without touching existing rows.

**Email window (`<windowStart>`)**: options were (i) the run's local date, which sends a daily email while banking is missing; (ii) the ISO week; (iii) once per "banking missing" episode, which needs a reset hook on banking save. **Chosen: (ii).** `windowStart = isoWeekStart(today)`, the Monday of the run's NZ local week as `YYYY-MM-DD`. Key `payout-missing:<ruleId>:<windowStart>`. The rule is at most one email per rule per NZ week while instances keep being refused, which doubles as a weekly reminder.
- Because `enqueueEmail` dedupes only queued or active jobs, the email is enqueued only when a **durable guard row** is newly claimed in the same transaction: `INSERT … (rule_id, window_start) ON CONFLICT DO NOTHING RETURNING`. See hand-off H3. A guard on the rule row itself would deadlock, as H3 explains.
- Example: run on 2026-10-20 (Tue) gives windowStart `2026-10-19`.

### Decision A3: what a series edit does to existing instances, and override granularity

#### Option A3-a: Only dates not yet created, plus unedited DRAFTs
- **Approach**: PUBLISHED instances never change.
- **Time Complexity**: O(drafts).
- **Space Complexity**: O(1) extra.
- **Pros**: no gate, capacity or fee interplay; trivially safe.
- **Cons**: under A2-2 almost every existing instance is PUBLISHED. "I moved the series to 7 pm" therefore changes nothing for the next H days, and the admin must edit each instance by hand, which marks each one "Edited". That defeats the series.
- **Best For**: lead-time models. **Worst For**: A2-2.

#### Option A3-b: Also PUBLISHED instances with no active registrations
- **Approach**: as A3-a, plus published ones nobody has registered for.
- **Time Complexity**: O(instances), with one registrations read each.
- **Space Complexity**: O(1) extra.
- **Pros**: protects registered players.
- **Cons**: whether an instance updates depends on hidden player activity, so the admin cannot predict it. A time change that harms nobody (location typo fix) is blocked by one registration. Under Auto Enroll nearly every instance has registrations, so this degrades to A3-a.

#### Option A3-c: Reconcile every future unedited, not-closed instance to the template, field-safe
- **Approach**: after the rule commits, each eligible instance is brought to `targetInstance(rule, date)`, each in its own short transaction.
- **Eligible**: same rule; `is_instance_overridden = false`; status DRAFT or PUBLISHED; not started. A PUBLISHED instance is eligible only while `now <` its current and its new cancellation deadline, because after the deadline players can no longer withdraw for free.
- **Field rules**:
  - A capacity raise calls `promoteWaitlist` (C-SSE-3).
  - Free to paid on a PUBLISHED instance calls the gate before the session lock.
  - A fee change on a PUBLISHED instance follows conflict 10.
- **Atomicity**: an instance either takes the whole template or nothing (`skip(reason)`). It never half-follows.
- **Idempotency**: the target is computed from the current template, not from "fields changed in this save". A retried or concurrent save therefore converges.
- **Time Complexity**: O(n) instances, n ≤ 14, with one transaction each.
- **Space Complexity**: O(n).
- **Pros**: the series means what it says; the outcome is predictable from rules the admin can be told; counts come back in the response; safe on retry and against a crash halfway through (re-saving converges).
- **Cons**: the most moving parts (gate, allocator call, fee rule per instance). Some instances can be left behind with a reason, which the UI must show.
- **Best For**: A2-2. **Worst For**: nothing in scope.

#### Option A3-d: A3-c plus an admin scope choice ("future sessions" or "only sessions not yet created")
- **Approach**: calendar-app style choice on every save.
- **Time Complexity**: same as A3-c.
- **Space Complexity**: same as A3-c.
- **Pros**: maximum control.
- **Cons**: one more decision on every save. The "not yet created" choice is A3-a's trap made optional.

**Override granularity**: (1) the whole-instance boolean (exists); (2) a per-field mask, where an instance follows the series for unedited fields. **Chosen: whole-instance.**
- Any admin instance save that changes at least one field sets `is_instance_overridden = true`. A no-op save does not.
- Publish and cancel are status changes, not edits, and leave the flag alone.
- A per-field mask makes "Edited" mean something different for each field. With at most about 14 future instances it buys nothing.

**Chosen**: **A3-c with whole-instance overrides.** The skip reasons, in check order, are:
- `edited`
- `closed` (CANCELLED or COMPLETED)
- `started`
- `deadline_passed` (PUBLISHED, and `now >= ` the current deadline or the new default deadline)
- `fee_locked` (conflict 10)
- `payout_not_configured` (free to paid refused by the gate)

`unchanged` (already equal to the template) is counted separately. The response carries `{ updated, unchanged, skipped: { reason: count }, removed, keptOffPattern: [{ sessionId, date, status }] }`.

### Decision A4: day, frequency or anchor changes, and shortening `recur_until`

#### Option A4-1: The pattern is immutable; to change it, end the series and create a new one
- **Approach**: refuse changes to `frequency`, `day_of_week`, `starts_on`, `monthly_week`.
- **Time Complexity**: O(1).
- **Space Complexity**: O(1).
- **Pros**: no off-pattern instances can exist.
- **Cons**: "we moved to Thursdays" means retyping the whole series. History splits across two series. `recur_until` shortening still needs a rule, so the hard case remains.

#### Option A4-2: The pattern is mutable from today; off-pattern instances are cancelled
- **Approach**: every future instance not in the new pattern becomes CANCELLED.
- **Time Complexity**: O(n).
- **Space Complexity**: O(n).
- **Pros**: the schedule is clean at once.
- **Cons**:
  - Registered players' sessions disappear with no email (player notification is deferred, open question C3).
  - A CANCELLED DRAFT keeps its `(rule, date)` key and blocks that date if the pattern later returns to it.
  - Cancelling is an admin act on players and should not be a side effect.

#### Option A4-3: The pattern is mutable with a "Starting from" date; drafts the series created are removed, edited or published instances are kept and listed
- **Approach**: a pattern change must carry a new `starts_on >= today` that matches the new pattern. Instances dated before the new `starts_on` are untouched. For instances on or after it whose date is no longer generated (not in the pattern, or after `recur_until`):
  - an unedited DRAFT is **deleted**: no player can ever have registered, because registrations need PUBLISHED and PUBLISHED never returns to DRAFT;
  - an edited DRAFT and any PUBLISHED instance are **kept** (`keep_off_pattern`) and returned in the response so the admin can cancel them;
  - CANCELLED, COMPLETED and started instances are untouched.

  Remaining eligible instances are reconciled as in A3-c. New dates come from the per-rule run. `recur_until` shortening (including "End series") uses the same date-set difference with the old pattern.
- **Time Complexity**: O(n + d).
- **Space Complexity**: O(n + d).
- **Pros**: one series survives a day change; the same code handles end and shorten; no surprise cancellations; deletion keeps the date free if the pattern returns.
- **Cons**: kept off-pattern instances need UI. DRAFT rows must be deletable (H8).

#### Option A4-4: As A4-3, plus a request flag `offPatternPublished: 'keep' | 'cancel'`
- **Approach**: bulk-cancel in the same save.
- **Time Complexity**: same as A4-3.
- **Space Complexity**: same as A4-3.
- **Pros**: one step for the admin.
- **Cons**: bulk-cancels registered sessions with no player notice. The kept list is at most about 14 rows, and each row already has "Cancel session".

**Chosen**: **A4-3.**
- Any change to `frequency`, `day_of_week`, `monthly_week` or `starts_on` is a **pattern change** and requires `starts_on >= today`. Otherwise 422 on `startsOn`: "Choose a start date from today for the new pattern".
- **Collision with a CANCELLED instance**: when a generated date already has a CANCELLED row for the same rule, the date stays cancelled. `ON CONFLICT DO NOTHING` keeps the row, which acts as an exception date. Transitions forbid CANCELLED to DRAFT, so an admin who wants that date back creates a one-off session.
- **"End series"** sets `recur_until`, and sets `is_active = false` when the date is today or earlier. Instances after the date follow the same remove-or-keep rule, and the confirmation shows both counts before the admin confirms.

### Decision A5: costing and rate details

| Sub-question | Options | **Chosen** |
|---|---|---|
| Divisor of the suggestion | (a) `max_players`; (b) public capacity `max_players - reserved_seats` | **(a) `max_players`**, as the spec says. `suggestedRate = divideByInteger(add(cost, extras), BigInt(maxPlayers), 'CEIL', 'DOLLAR')`. Product note for the ADR: reserved host seats are not registrations and are not billed, so the formula under-recovers by `reserved_seats × rate` if hosts do not pay. That is the spec owner's call, not changed here |
| What `custom_player_rate` NULL means | (a) NULL = "follow the suggestion", so the rate moves with costs; (b) always store the final rate | **(a).** "Use suggested rate" sends `customPlayerRate: null`. Any typed value is a pin, even one equal to the suggestion |
| When `fee_flat` is set | (a) copied only at publish (C-SSE-1 wording); (b) kept equal at **every** save | **(b).** For FLAT, `fee_flat = custom_player_rate ?? calculated_rate_per_player` after every write (DRAFT and PUBLISHED, instance and rule). For BY_SEX and BY_SKILL it is NULL. That is a superset of C-SSE-1 (equal at publish and after any later rate edit, AC-INTEGRATION-1), and a CHECK can hold it (H7). `calculated_rate_per_player` is always written (never NULL for new rows) |
| BY_SEX / BY_SKILL pre-fill | (a) blank inputs; (b) UI-only initial values from the final rate; (c) stored link that tracks the rate | **(b).** When the admin switches to BY_SEX or BY_SKILL and the inputs are empty, the form fills them with the current final rate. `fee_other` shows `min(fee_male, fee_female)` and tracks them until the admin edits it. Nothing tracks after save |
| `fee_other` on the server | (a) required in the body; (b) defaulted when omitted | **(b).** For BY_SEX, an omitted `feeOther` becomes `min(feeMale, feeFemale)` (`Money.min`) **only when the stored row was not already BY_SEX**. When it was, the stored value is kept, so a saved value is never overwritten (platform-foundation Q11) |
| Rule FLAT rate | | Rule `fee_flat = default_custom_player_rate ?? suggestedRate(rule defaults)`, kept at every rule save. Instances recompute `calculated` from their own fields |
| Moving-default deadline | (a) `deadline_is_default` column; (b) a DB trigger that maintains the default (changes D-08); (c) infer "default" as `cancellation_deadline == starts_at − 48 h` (exact instant equality) | **(c), no column.** API field `cancellationDeadline: null` (use the default) or an explicit local date and time. Reads report `deadlineIsDefault` by inference. Any path that moves `starts_at` (instance edit, series reconciliation) recomputes a default deadline and keeps an explicit one only if it still satisfies the CHECK (otherwise 422, AC-ERROR-2). The only loss: an explicit value exactly 48 h before start is treated as the default. That is harmless, because the default is that value |

### Conflict 2: `autoEnrolInSession` input shape

Options: (a) `userIds` (ADR 0017 C-SKL-1 point 3, C-SAE-1); (b) `entries: readonly { userId, assignedAt }[]` (R16, from the allocator's owner and later).

**Chosen**: **(b).** The call is `autoEnrolInSession(ctx, { teamId, sessionId, entries })`:
- `entries` is `selectAutoEnrollees(...)` mapped in its returned order (`auto_enroll_assigned_at ASC, id ASC`) to `{ userId, assignedAt }`, with `assignedAt` the selection's `Date` passed through unchanged, so the allocator can compare at millisecond precision;
- `membershipId` may be passed through;
- parties have no guests;
- `auto_enroll_changed`, `overdue_payments`, `forbidden` and `already_registered` are skips.

ADR 0019 records that this supersedes the `userIds` wording.

### Conflict 3: which sessions trigger auto-enrol

#### Option 3-1: Only instances the materialiser publishes (initial and retry)
- **Pros**: the narrowest reading of ADR 0017 point 6.
- **Cons**: inconsistent inside one journey. In AC-INTEGRATION-3 the admin fixes banking, then publishes one gate-refused draft by hand, and that instance gets no Auto Enroll members while its siblings (retried by the job) do.

#### Option 3-2: Every first publish of a series instance, whoever publishes it; one-offs never
- **Pros**: consistent for series.
- **Cons**: contradicts PRODDUCT-OVERVIEW §2 ("automatically registered for **all newly created game sessions** hosted by that team").

#### Option 3-3: Every session's first DRAFT to PUBLISHED transition, series instance or one-off
- **Pros**: one rule matches the product text; idempotent by construction (the guarded `UPDATE … WHERE status = 'DRAFT'` succeeds once, and PUBLISHED never returns to DRAFT).
- **Cons**: an ad-hoc special event also enrols regulars. Mitigated by the R17 auto-enrol email and a free withdrawal before the deadline, and the publish confirmation says it will happen (J1).

#### Option 3-4: 3-3 plus a per-session "Auto-enrol members" checkbox
- **Pros**: control for special events.
- **Cons**: a column and UI with no stated demand. It can be added later as a two-way door.

**Chosen**: **3-3.** Algorithmic rule: **auto-enrol runs exactly once per session, triggered by its DRAFT to PUBLISHED transition, for every session.**
- **Same transaction**: when the session row was inserted in that transaction (the materialiser's fresh instance), auto-enrol runs inside it (ADR 0017 C-SKL-1 points 3 and 5; C-SAE-1).
- **Durable follow-up**: when the row already existed (manual publish of a one-off or instance, or the materialiser's retry of a draft), auto-enrol runs after commit in a transaction that has not locked the session. It is made durable by an enqueue in the publish transaction (H9). The per-session order and entries follow conflict 2.
- **Excluded**: a CANCELLED or still-DRAFT session never auto-enrols.
- ADR 0019 records this extension of ADR 0017 point 6 (allowed by that point).

### Conflict 6: DST options in the 422 against what can be stored

`session_courts` stores a local `time` per court on the session's `date`, and the trigger resolves `compatible`. What each choice can store:

| Input (Pacific/Auckland) | Kind | Choice | Instant | Storable as a local time? |
|---|---|---|---|---|
| 2026-09-27 02:30 | nonexistent (gap 02:00→03:00) | `shiftedForward` (= `compatible` = `later`) | 2026-09-26T14:30Z = **03:30 NZDT** | Yes, store **03:30** (unique) |
| | | `shiftedBackward` (= `earlier`) | 2026-09-26T13:30Z = **01:30 NZST** | Yes, store **01:30** (unique) |
| 2027-04-04 02:30 | ambiguous (02:00-02:59 twice) | `earlier` (= `compatible`) | 2027-04-03T13:30Z = 02:30 NZDT | Yes, store 02:30 (the trigger resolves earlier) |
| | | `later` | 2027-04-03T14:30Z = 02:30 NZST | **No.** No local time maps to it under `compatible` |

#### Option 6-1: Offer only representable choices, and rewrite gap times to a real wall time
- **Approach**:
  - **Gap**: the 422 offers both shifted times. The client resubmits the chosen real time (03:30 or 01:30), which is then unique, so no new request field is needed.
  - **Overlap**: the 422 offers only "the first 2:30 am (NZDT)". The client resubmits with a transient per-court `startDisambiguation`/`endDisambiguation: 'earlier'`. It is a zod literal, never stored, and ignored when the time is not ambiguous.
  - **Never stored**: a time that never happens.
- **Pros**: no schema change; D-08 untouched; every stored court time is a real wall-clock time.
- **Cons**: "the second 2:30 am" cannot be chosen. That is a 02:30 badminton session on one night a year.

#### Option 6-2: Add a per-court disambiguation column (`start_fold`, `end_fold`) and change the D-08 trigger to use it
- **Pros**: every choice can be stored.
- **Cons**: **one-way door.**
  - It changes `game_sessions_derive_instants`, which billing's `ends_at` sweep and C-GAME-1 point 3 rely on, along with its TS/SQL parity tests.
  - It adds a column to every court row forever.
  - The recurrence engine and the court template would need it too.
  - All for an unrealistic time slot.

#### Option 6-3: Accept and store the typed time as-is with `compatible`
- **Pros**: no friction.
- **Cons**: violates `DST_POLICY.USER_INPUT = reject` (ADR 0010). A gap time is stored as "02:30" but happens at 03:30, which misleads players.

**Chosen**: **6-1.** The D-08 trigger and schema are not changed (the one-way door is flagged and declined). Details:
- **Applies to**: every admin-entered court start and end on a one-off or instance date, and the explicit cancellation deadline.
- **Deadline**: it is stored as an instant, so all four choices are storable. The 422 offers `shiftedForward`/`shiftedBackward` for a gap and `earlier`/`later` for an overlap. The client resubmits with `cancellationDeadline: { date, time, disambiguation? }`.
- **Materialiser and reconciliation** (derived, `compatible`): a template court time in a gap is **normalised** to the wall time of its resolved instant (02:30 becomes 03:30 on 2026-09-27). An overlap time is stored unchanged and resolves earlier, so the job never fails (AC-ASYNC-1).
- **Rule save refusal**: rule save refuses (422) a template court lying wholly inside 02:00-03:00, i.e. start ≥ 02:00 and end ≤ 03:00. On the NZ DST-start day such a court would have no real duration, and normalisation would break `session_courts_time_order`. NZ's gap is always 02:00→03:00 (Daylight Time Order 2007, the same assumption ADR 0010 records for tzdata stability).
- **422 body**: `{ code: 'validation_failed', fieldErrors: { 'courts.3.startTime': 'local_time_nonexistent' }, dstOptions: [{ field, date, time, kind, options: [{ choice, localTime, instant }] }] }`. No new top-level error code.

### Conflict 10: fee edits on PUBLISHED sessions with registrations

#### Option 10-1: Refuse any fee edit once the session has an active registration
- **Pros**: nobody is repriced.
- **Cons**: a typo ($170 for $17) can't be fixed even downwards. The admin must cancel and recreate, and players must register again.

#### Option 10-2: Allow with a warning
- **Pros**: no friction.
- **Cons**: billing charges the new fee at charge time, so players pay an amount they never saw. Player emails are out of scope (C3).

#### Option 10-3: Snapshot the fee per registration at confirmation
- **Pros**: raises would apply only to new registrations.
- **Cons**:
  - It needs a new `registrations` fee snapshot (registrant and guests) owned by registration-and-waitlist, plus billing reading it. That is a cross-feature contract change on an in-flight branch whose plan was just amended (R15 snapshots attributes, not fees).
  - Decreases would then not reach existing registrants unless they were re-snapshotted.

#### Option 10-4: Decrease-only while the session has active registrations
- **Approach**:
  - **With active registrations**: on a PUBLISHED session that has any, `pricing_structure` cannot change, and no applicable fee column may go up (NULL counts as 0, as in `isPaidSession`). Decreases are always allowed.
  - **Free to paid**: a raise, so it is refused while registrations exist. With none, it is allowed through the gate (ADR 0016 gate point 1).
  - **Costing edits**: an edit that raises a FLAT session's followed suggestion is a raise. The admin can pin the old rate (set a custom rate) to keep the fee.
  - **Without registrations**: anything goes, with the gate for free to paid.
- **Pros**: no player ever pays more than they saw; typos downwards are fixable; no cross-feature change; enforceable in SQL under the existing lock contract.
- **Cons**: an upward correction after the first registration needs cancel and recreate. That is accepted, and 10-3 is recorded as the evolution path.

**Chosen**: **10-4.**
- **Active registrations**: `game_session_has_active_registrations(session_id)` is one SQL function owned here, today `status IN ('CONFIRMED', 'WAITLISTED')`. registration-and-waitlist widens it to include `withdrawal_fee_due` rows when it adds that column, mirroring ADR 0016's `team_banking_in_use`.
- **Check**: it runs under the session `FOR UPDATE` lock, and a BEFORE UPDATE trigger backs it up (H6).
- **API refusal**: 409 `session_fee_locked`, naming the raised fields.
- **Series reconciliation**: the instance is skipped with reason `fee_locked`.
- Fee decreases stay allowed until COMPLETED. COMPLETED and CANCELLED are immutable (AC-ERROR-5).

---

## Complexity Comparison

Date generation (A1), per rule per window (d = dates out, m = months scanned, N = all occurrences):

| Metric | A1-1 Day of month | A1-2 Nth, skip 5th | A1-3 Nth, 5th = last | **A1-4 Explicit ordinal** |
|--------|----------|----------|----------|----------|
| Time (Best) | O(1) | O(1) | O(1) | O(1) empty window |
| Time (Avg) | O(m) | O(m) | O(m) | O(d + m) |
| Time (Worst) | O(m) | O(m) | O(m) | O(d + m), d ≤ 14, m ≤ 4 |
| Space | O(d) | O(d) | O(d) | O(d) |
| Implementation | Simple | Simple | Simple | Simple plus 2 CHECKs |

Horizon (A2) and propagation (A3), per series (n = future instances, R = active rules):

| Metric | A2-1 To `recur_until` | **A2-2 Rolling H** | A2-3/4 Lead time | A3-a Drafts only | A3-b No registrations | **A3-c Reconcile** |
|--------|---|---|---|---|---|---|
| Rows per rule | O(N), unbounded | O(H/7) ≤ 14 | O(H/7) | | | |
| Daily run | O(R·N) | O(R·(d + e)) | O(R·(d + e)) + publish pass | | | |
| Series save | | | | O(drafts) | O(n) plus n registration reads | O(n) plus n short transactions |
| Implementation | Simple, but unbounded | Simple | Medium (extra flag) | Simple | Medium | Medium |

## Performance Projection

At expected scale (100 teams, about 200 active rules, mostly weekly, H = 28, 12 courts, 30 Auto Enroll members):

| Option | Expected Latency | Memory Usage |
|--------|------------------|--------------|
| A2-2 daily run | about 30 new instances a day × (insert plus 12 courts plus gate plus publish plus 30-member auto-enrol ≈ 20-60 ms) ≈ 1-2 s | O(14) dates per rule |
| A2-2 series create (per-rule run) | ≤ 5 instances ≈ 0.3 s (the "about 5 s" in AC-HAPPY-5 is dominated by job polling) | negligible |
| A3-c series save | rule write, then ≤ 5 instance transactions × 5-15 ms (plus `promoteWaitlist` when capacity rises) ≈ 50-150 ms | O(5) |
| A1-4 `recurrenceDates` | microseconds | ≤ 14 strings |

---

## Decision

**Chosen**:

| Question | Decision |
|---|---|
| A1 | Explicit `monthly_week` (1-4 or last) and a mandatory `starts_on` anchor; `day_of_week` CHECKed equal to the anchor's weekday, 0 = Sunday |
| A2 | Rolling horizon `RECURRENCE_HORIZON_DAYS` (7..91, default 28); publish when created; ISO-week email window behind a durable guard |
| A3 | Reconcile future unedited instances to the template, field-safe, one instance at a time; whole-instance override flag |
| A4 | Pattern changes need a "Starting from" date ≥ today; unedited off-pattern drafts deleted; edited or published kept and listed; cancelled dates stay cancelled |
| A5 | Suggestion on `max_players`; NULL custom rate follows the suggestion; `fee_flat` kept equal at every save; UI-only pre-fills; inferred default deadline |
| Conflict 2 | R16 `entries` |
| Conflict 3 | Every first publish auto-enrols, one-offs included |
| Conflict 6 | Representable DST options only; gap times rewritten; D-08 unchanged |
| Conflict 10 | Decrease-only fees once registrations exist |

### Rationale
- **A1-4** is the only option that is total (every month has a date), says in the row what the admin meant, and supplies the Fortnightly parity anchor that the schema lacks. The extra column is small and CHECKable (P1).
- **A2-2** keeps one concept and one env var, and lines up exactly with ADR 0016's recurrence contract (gate-refused drafts are the only materialiser drafts) and ADR 0017 (auto-enrol at publish). A lead time stays available later without migrating data.
- **A3-c** is what an admin expects from "edit the series". Its safety comes from explicit, explainable skip rules: never edited, closed, started or past-deadline instances; never a fee raise on registered players; the gate for free to paid; `promoteWaitlist` on capacity raises. Reconcile-to-template is idempotent, so a retried save or a crash halfway through heals on the next save.
- **A4-3** reuses A3-c plus one date-set difference for both pattern changes and End series. It never cancels a registered session as a side effect, and it never leaves a CANCELLED key where a pattern may return.
- **10-4** is the only option that prevents silent repricing without changing two other features' contracts.
- **6-1** avoids a one-way change to D-08 for a slot nobody books.

### Trade-offs Accepted
- **One global horizon or lead time (A2-2)**: clubs wanting registration to open exactly N days ahead must live with H. Mitigation: H is env-configurable, and a per-series lead time is a two-way door.
- **Holiday dates appear already published (A2-2)**: mitigation is the optional "skip a future date" action (pre-materialise as DRAFT and cancel), J7.
- **Instances left behind (A3-c)**: some keep old values with a reason (fee locked, past deadline). The admin sees counts and reasons in the response.
- **No upward fee fix after the first registration (10-4)**: the admin must cancel and recreate. The evolution path is a per-registration fee snapshot (10-3), which needs registration-and-waitlist and wallet-and-akahu-billing to agree.
- **"Second 2:30 am" cannot be chosen on 4 April (6-1)**: a template court wholly within 02:00-03:00 is refused at rule save.
- **One-off special events auto-enrol regulars (3-3)**: mitigated by the publish confirmation (J1), the R17 email and a free withdrawal before the deadline.

---

## Implementation Details

### Data Structures
| Structure | Purpose | Operations Used |
|-----------|---------|-----------------|
| `LocalDate` epoch-day integer (`Date.UTC(y, m-1, d) / 86_400_000`) | TZ-free calendar arithmetic | O(1) add, diff, weekday `(epochDay + 4) mod 7` (1970-01-01 was a Thursday; 0 = Sunday) |
| `RecurrenceRule` `{ frequency, dayOfWeek, startsOn, monthlyWeek?, recurUntil }` | Input to the pure generator | validated once, O(1) |
| `Set<LocalDate>` of existing instance dates | Skip already-materialised dates in the run | O(1) membership |
| `InstancePlan` | Output of `buildInstance(rule, courts, date)` | built in O(courts) |
| `ReconcileAction` union | Output of `planSeriesReconciliation` | one per instance, O(n) |

### Algorithm Steps

**Pure module `packages/shared/src/sessions/recurrence.ts`** (no clock, no DB, no local-zone `Date` getters; only `getUTC*`):

```
const DAY = 86_400_000
epochDay(d: LocalDate): int        = Date.UTC(y, m-1, dd) / DAY
fromEpochDay(n): LocalDate          = format(new Date(n * DAY).getUTC*)
weekdayOf(d): 0..6                  = mod(epochDay(d) + 4, 7)              // 0 = Sunday
daysInMonth(y, m): int              = new Date(Date.UTC(y, m, 0)).getUTCDate()
nthWeekdayOfMonth(y, m, wd, k):     // k in 1..4 or -1
    if k > 0: return date(y, m, 1 + mod(wd - weekdayOf(date(y,m,1)), 7) + 7*(k-1))   // day ≤ 28, always exists
    last = daysInMonth(y, m); return date(y, m, last - mod(weekdayOf(date(y,m,last)) - wd, 7))
defaultMonthlyWeek(anchor): { week: 1..4 | -1, alsoLast: boolean }
    k = ceil(day(anchor) / 7); isLast = day(anchor) + 7 > daysInMonth(anchor)
    return k == 5 ? { week: -1, alsoLast: false } : { week: k, alsoLast: isLast }

assertRecurrenceRule(rule):        // throws RecurrenceRuleError; the DB CHECKs mirror it
    weekdayOf(rule.startsOn) == rule.dayOfWeek
    rule.frequency == 'MONTHLY'  ⇔ rule.monthlyWeek != null, monthlyWeek ∈ {1,2,3,4,-1}
    MONTHLY ⇒ nthWeekdayOfMonth(y(startsOn), m(startsOn), dayOfWeek, monthlyWeek) == startsOn
    recurUntil == null or recurUntil >= startsOn

recurrenceDates(rule, window: { from, to }): LocalDate[]
    assertRecurrenceRule(rule)
    s = max(window.from, rule.startsOn)
    e = rule.recurUntil == null ? window.to : min(window.to, rule.recurUntil)
    if s > e: return []
    if frequency in (WEEKLY, FORTNIGHTLY):
        step = WEEKLY ? 7 : 14
        a = epochDay(rule.startsOn)
        n = ceilDiv(epochDay(s) - a, step)              // ≥ 0 because s ≥ startsOn
        out = []; for (x = a + n*step; x <= epochDay(e); x += step) out.push(fromEpochDay(x))
        return out
    // MONTHLY
    out = []
    for (y, m) from (y(s), m(s)) to (y(e), m(e)):
        d = nthWeekdayOfMonth(y, m, rule.dayOfWeek, rule.monthlyWeek)
        if s <= d <= e: out.push(d)
    return out
```

**Instance building (`packages/shared/src/sessions/instance.ts`, pure, uses `time.ts` and `money.ts`)**:

```
buildInstance(rule, template: Court[], date): InstancePlan
    courts = template.map(c => ({ id: c.courtIdentifier,
                                  start: normaliseDerived(date, c.startTime),
                                  end:   c.endTime == '24:00' ? '24:00' : normaliseDerived(date, c.endTime) }))
    startsAt = localToInstant(date, min(courts.start), DST_POLICY.DERIVED)   // equals what the D-08 trigger will compute
    calculated = suggestedRate(rule.cost, rule.extras, rule.maxPlayers)
    custom = rule.defaultCustomRate
    fees = rule.fees with fee_flat = (FLAT ? custom ?? calculated : null)
    return { date, location, address, maxPlayers, reservedSeats, cost, extras, calculated, custom,
             pricing, fees, courts, startsAt, deadline: defaultCancellationDeadline(startsAt),
             isInstanceOverridden: false }

normaliseDerived(date, t): LocalTime
    r = resolveLocal(date, t)
    return r.kind == 'nonexistent' ? instantToLocal(r.shiftedForward).time : t   // gap → real time; overlap/unique unchanged
```

**Materialiser run** (`apps/api/src/modules/sessions/materialise.ts`; transactions and locks per the architecture doc):

```
run(now, scope = all | ruleId):
    today = instantToLocal(now).date; windowEnd = addLocalDays(today, H); windowStart = isoWeekStart(today)
    for rule in activeRules(scope)      // is_active AND (recur_until IS NULL OR recur_until >= today)
        dates = recurrenceDates(rule, { from: today, to: windowEnd })
        have  = dates of existing instances of rule in [today, windowEnd]       // any status
        for date in dates \ have:                                               // ascending
            TX(per instance):
                read rule + template under the rule lock (H4)                    // never a stale template
                plan = buildInstance(rule, template, date); if plan.startsAt <= now: skip
                gate = isPaidSession(plan) ? checkTeamCanPublishPaidSession(trx, …) : ok   // before any session lock
                id = INSERT game_sessions … status 'DRAFT' ON CONFLICT (rule, date) DO NOTHING RETURNING id
                if id == null: continue                                         // lost the race; nothing else
                INSERT session_courts (plan.courts)
                if gate.ok: UPDATE … SET status='PUBLISHED' WHERE id=$id AND status='DRAFT'
                            entries = selectAutoEnrollees(trx, { teamId, sessionDate: date })
                            port.autoEnrolInSession(ctx, { teamId, sessionId: id, entries })   // same tx (inserted here)
                else:       log publish_refused; if claimNotice(rule, windowStart): enqueueEmail(payout-missing:<rule>:<windowStart>)
        for draft in instances of rule WHERE status='DRAFT' AND NOT is_instance_overridden
                                       AND date <= windowEnd AND starts_at > now:       // ADR 0016 point 6
            TX: gate check → refused: log (+ notice claim) | ok: lock session FOR UPDATE;
                guarded UPDATE … WHERE status='DRAFT' AND NOT is_instance_overridden; enqueue durable auto-enrol (H9)
    log session.recurrence.run_completed { rulesScanned, created, published, savedAsDraft, failed }
```

**Series save reconciliation** (`planSeriesReconciliation` is pure; execution is per instance):

```
planSeriesReconciliation(oldRule, newRule, instances, today, now): Action[]
    patternChanged = any of frequency, dayOfWeek, monthlyWeek, startsOn differ
    gen = set(recurrenceDates(newRule, { from: today, to: max(instances.date) }))
    for i in instances where i.date >= today, ordered by date:
        if i.status in (COMPLETED, CANCELLED):           act(i, unchanged_closed)  // counted as skipped:closed
        elif i.startsAt <= now:                          skip(i, 'started')
        elif patternChanged and i.date < newRule.startsOn: untouched(i)          // before the change
        elif i.date not in gen:                          // off pattern or after recur_until
             i.status == DRAFT and not i.overridden ? delete(i) : keepOffPattern(i)
        elif i.overridden:                               skip(i, 'edited')
        else:
             target = buildInstance(newRule, template, i.date)
             if equalPersisted(i, target):               unchanged(i)
             elif i.status == PUBLISHED and (now >= i.deadline or target.deadline <= now): skip(i, 'deadline_passed')
             else:                                       update(i, target)        // final checks in the instance tx

execute update(i, target), one transaction per instance, in date order:
    if i.status == PUBLISHED and !isPaid(i) and isPaid(target): gate check before the lock → refused: skip 'payout_not_configured'
    SELECT … FOR UPDATE; re-read; re-run the eligibility checks above (another writer may have edited, cancelled or published it)
    if i.status == PUBLISHED and has_active_registrations(i) and (pricingChanged or feeRaised(i, target)): skip 'fee_locked'
    UPDATE fields (deadline = target default); replace courts
    if i.status == PUBLISHED and (target.maxPlayers > i.maxPlayers or target.reservedSeats < i.reservedSeats):
        port.promoteWaitlist(ctx, { teamId, sessionId: i.id })                   // C-SSE-3, same tx
```

`feeRaised(old, new)` (pure, in `costing.ts`): for the session's pricing structure, the list of applicable fee keys where `toCents(new ?? 0) > toCents(old ?? 0)`. Any `pricing_structure` change counts as a raise when registrations exist.

### Edge Case Handling
| Edge Case | Handling |
|-----------|----------|
| Window outside `[starts_on, recur_until]` | `[]` (V20, V21) |
| 5th-weekday anchor | stored as `monthly_week = -1` (V11) |
| Anchor both 4th and last | admin chooses; V12 against V13 |
| DST-change date in series | dates unchanged (V2-V5, V8, V9, V14, V15); gap court times normalised; overlap resolves earlier |
| Template court wholly inside 02:00-03:00 | rule save 422 |
| Instance start already passed at run time | not created; re-runs also skip it (still in the past) |
| Concurrent runs on the same `(rule, date)` | `ON CONFLICT DO NOTHING`; the loser creates nothing and makes no allocator call |
| Rule edited during a run | the instance transaction reads the template under the rule lock (H4); the save's reconciliation sees the committed instances |
| Pattern returns to a CANCELLED date | stays cancelled |
| Off-pattern PUBLISHED or edited DRAFT | kept and listed (`keptOffPattern`) |
| Fee raise with registrations | API 409 `session_fee_locked`; reconciliation `skip(fee_locked)` |
| Capacity cut on a published instance | saved; nobody demoted (C-SSE-3); if it raises a followed FLAT suggestion while registered, the instance is skipped with `fee_locked` |
| Explicit deadline no longer before start | 422 on `cancellationDeadline` (AC-ERROR-2) |
| BY_SEX switch with `feeOther` omitted | `min(feeMale, feeFemale)` |
| `recur_until < starts_on` | 422 plus CHECK |

### Error Handling
| Error Condition | Response |
|-----------------|----------|
| `RecurrenceRuleError` (anchor inconsistent) | API 422 `validation_failed` on `startsOn`/`monthlyWeek`; DB CHECK 23514 on raw SQL |
| Admin time nonexistent or ambiguous | 422 `validation_failed` with `fieldErrors[field] = local_time_nonexistent \| local_time_ambiguous` and `dstOptions` |
| Pattern change without `startsOn >= today` | 422 on `startsOn` |
| Fee raise or pricing change with active registrations | 409 `session_fee_locked` with `raisedFields`; the trigger backstop gives 23514 `game_sessions_fee_raise_locked` |
| Gate refusal in the materialiser | DRAFT plus log plus at most one email per rule per week; not a job failure (ADR 0016 points 2, 4) |
| Gate refusal during reconciliation | `skip(payout_not_configured)` for that instance; the rule save stands |
| 23514 from a trigger in the materialiser | roll back that instance only; `session.recurrence.instance_failed` at `error` (ADR 0016 point 3) |
| Lock timeout on an instance during reconciliation | that instance is reported `skipped: busy` and left unchanged; re-saving converges (idempotent) |

---

## Test Vectors

### `recurrenceDates` (AC-VERIFY-4)

Computed independently (Python `zoneinfo`/`calendar`) and to be copied into `recurrence.test.ts`. Weekdays: 0 = Sun … 6 = Sat. Windows inclusive. NZ DST 2026-27 starts **Sun 2026-09-27** and ends **Sun 2027-04-04**. Run every row under `TZ=UTC` and `TZ=Pacific/Kiritimati`, with identical results.

| # | Frequency | startsOn (dow) | monthlyWeek | recurUntil | Window | Expected |
|---|---|---|---|---|---|---|
| V1 | WEEKLY | 2026-09-23 (3) | - | - | 09-20..10-10 | 2026-09-23, 09-30, 10-07 |
| V2 | WEEKLY | 2026-09-20 (0) | - | - | 09-20..10-11 | 2026-09-20, **09-27**, 10-04, 10-11 |
| V3 | WEEKLY | 2027-03-21 (0) | - | - | 03-21..04-11 | 2027-03-21, 03-28, **04-04**, 04-11 |
| V4 | WEEKLY | 2026-09-02 (3) | - | - | 09-21..10-04 (DST-start week) | 2026-09-23, 09-30 |
| V5 | WEEKLY | 2027-03-03 (3) | - | - | 03-29..04-11 (DST-end week) | 2027-03-31, 04-07 |
| V6 | FORTNIGHTLY | 2026-09-16 (3) | - | - | 09-20..11-01 | 2026-09-30, 10-14, 10-28 (parity from anchor) |
| V7 | FORTNIGHTLY | 2026-10-14 (3) | - | - | 10-01..11-15 (starts before anchor) | 2026-10-14, 10-28, 11-11 |
| V8 | FORTNIGHTLY | 2026-09-13 (0) | - | - | 09-13..10-25 | 2026-09-13, **09-27**, 10-11, 10-25 |
| V9 | FORTNIGHTLY | 2027-03-21 (0) | - | - | 03-21..05-02 | 2027-03-21, **04-04**, 04-18, 05-02 |
| V10 | MONTHLY | 2026-10-07 (3) | 1 | - | 2026-10-01..2027-01-31 | 2026-10-07, 11-04, 12-02, **2027-01-06** |
| V11 | MONTHLY | 2026-10-30 (5) | -1 (5th anchor) | - | 2026-10-01..2027-01-31 | 2026-10-30, 11-27, 12-25, 2027-01-29 |
| V12 | MONTHLY | 2026-10-28 (3) | 4 | - | 2026-10-01..2027-01-31 | 2026-10-28, 11-25, **12-23**, 2027-01-27 |
| V13 | MONTHLY | 2026-10-28 (3) | -1 | - | 2026-10-01..2027-01-31 | 2026-10-28, 11-25, **12-30**, 2027-01-27 |
| V14 | MONTHLY | 2026-09-27 (0) | -1 | - | 2026-09-01..12-31 | **2026-09-27**, 10-25, 11-29, 12-27 |
| V15 | MONTHLY | 2027-03-07 (0) | 1 | - | 2027-03-01..05-31 | 2027-03-07, **04-04**, 05-02 |
| V16 | MONTHLY | 2028-01-31 (1) | -1 | - | 2028-01-01..03-31 (leap Feb) | 2028-01-31, 02-28, 03-27 |
| V17 | MONTHLY | 2026-11-10 (2) | 2 | - | 2026-11-01..2027-02-28 | 2026-11-10, 12-08, 2027-01-12, 02-09 |
| V18 | WEEKLY | 2026-10-07 (3) | - | 2026-10-21 | 10-01..10-31 | 2026-10-07, 10-14, **10-21** (inclusive) |
| V19 | WEEKLY | 2026-10-07 (3) | - | 2026-10-20 | 10-01..10-31 | 2026-10-07, 10-14 |
| V20 | WEEKLY | 2026-10-07 (3) | - | 2026-10-21 | 10-22..11-30 | `[]` |
| V21 | WEEKLY | 2026-12-02 (3) | - | - | 10-01..11-30 | `[]` |
| V22 | WEEKLY | 2026-10-07 (3) | - | - | 10-14..10-14 | 2026-10-14 |
| V23 | WEEKLY | 2026-10-07 (3) | - | - | 10-15..10-15 | `[]` |
| V24 | WEEKLY | 2026-10-07 (3) | - | 2026-10-07 | 10-01..12-31 | 2026-10-07 |
| V25 | MONTHLY | 2026-10-07 (3) | 1 | - | 2026-10-20..11-17 (H = 28 from today) | 2026-11-04 |
| V26 | MONTHLY | 2026-12-26 (6) | -1 | - | 2026-12-01..2027-02-28 | 2026-12-26, 2027-01-30, 02-27 |
| E1 | WEEKLY | 2026-10-08 (4) with dayOfWeek 3 | - | - | any | throws `RecurrenceRuleError` |
| E2 | MONTHLY | 2026-10-14 (3, 2nd Wed) with monthlyWeek 1 | 1 | - | any | throws |
| E3 | MONTHLY | monthlyWeek 5 or 0 | | | any | throws |
| E4 | any | | | | from > to | `[]` |
| E5 | WEEKLY | 2026-10-07 | - | 2026-10-06 | any | throws (`recurUntil < startsOn`) |

`defaultMonthlyWeek`: 2026-10-07 gives `{ 1, alsoLast: false }`; 2026-10-28 gives `{ 4, alsoLast: true }`; 2026-10-30 gives `{ -1 }`; 2026-12-26 gives `{ 4, alsoLast: true }`.

### Instance and DST vectors (`instance.test.ts`, `sessions-api.int.test.ts`)

| # | Input | Expected |
|---|---|---|
| T1 | Template court 02:30-04:00 on 2026-09-27 (materialiser) | stored 03:30-04:00; `starts_at` 2026-09-26T14:30Z; deadline 2026-09-24T14:30Z |
| T2 | Template court 02:30-04:00 on 2027-04-04 | stored 02:30-04:00; `starts_at` 2027-04-03T13:30Z (earlier, NZDT) |
| T3 | Template court 19:00-21:00 on 2026-09-27 | `starts_at` 2026-09-27T06:00Z (NZDT +13) |
| T4 | Template court 19:00-21:00 on 2026-09-28 | `starts_at` 2026-09-28T06:00Z; deadline 2026-09-26T06:00Z = 26/09/2026 6:00 pm NZST (absolute 48 h) |
| T5 | Template court 19:00 on 2027-04-05 | `starts_at` 2027-04-05T07:00Z; deadline 2027-04-03T07:00Z = 03/04/2027 8:00 pm NZDT (platform-foundation vector 16) |
| T6 | Admin court start 02:30 on 2026-09-27 | 422, `local_time_nonexistent`, options 03:30 (14:30Z) and 01:30 (13:30Z) |
| T7 | Admin court start 02:30 on 2027-04-04 | 422, `local_time_ambiguous`, one option `earlier` 02:30 (13:30Z); resubmit with `startDisambiguation: 'earlier'` gives 200 |
| T8 | Admin deadline 2027-04-04 02:30 | 422 with `earlier` 13:30Z and `later` 14:30Z; both resubmits are stored as given |
| T9 | Rule template court 02:15-02:45 | rule save 422 (wholly in the gap) |

### Costing and fee vectors (`costing.test.ts`)

| # | Input | Expected |
|---|---|---|
| C1-C4 | platform-foundation rate vectors | $11.00, $12.00, $9.00, $12.00 |
| C5 | Cost $0, extras $0, 20 players | $0.00 (free) |
| C6 | FLAT, custom NULL, calculated $11.00 | `fee_flat` $11.00 |
| C7 | FLAT, custom $10.00 | `fee_flat` $10.00 |
| C8 | BY_SEX male $17, female $16, `feeOther` omitted, switching from FLAT | `fee_other` $16.00 |
| C9 | BY_SEX stored `fee_other` $15, `feeOther` omitted on edit | $15.00 kept |
| C10 | `feeRaised` FLAT 17 → 16 | `[]` |
| C11 | `feeRaised` FLAT 0 → 5 (free to paid) | `['fee_flat']` |
| C12 | `feeRaised` BY_SKILL (10, 12, 14) → (10, 13, 12) | `['fee_intermediate']` |
| C13 | FLAT followed suggestion, `max_players` 12 → 10 at $132 cost | calculated $11 → $14, raise `['fee_flat']` |

### Reconciliation vectors (`reconcile.test.ts`, pure)

Today 2026-10-20 (Tue), now 2026-10-20T08:00Z. Weekly Wednesday series with instances on 10-21 (PUBLISHED, deadline passed), 10-28 (PUBLISHED, unedited), 11-04 (PUBLISHED, edited), 11-11 (DRAFT, gate-refused, unedited) and 10-14 (COMPLETED).

| Change | Expected actions |
|---|---|
| Start 18:00 → 19:00 | 10-21 skip `deadline_passed`; 10-28 update; 11-04 skip `edited`; 11-11 update; 10-14 untouched |
| Pattern to Thursday, `startsOn` 2026-10-29 | 10-21 untouched (before `startsOn`); 10-28 untouched (before `startsOn`); 11-04 keepOffPattern; 11-11 delete; new Thursdays from 10-29 come from the per-rule run |
| `recur_until` 2026-10-31 | 11-04 keepOffPattern; 11-11 delete; others unchanged |
| No change (retry) | every instance `unchanged` or skipped as before; zero writes |

---

## Performance Expectations

### At Current Scale
- Expected latency: series save ≤ 150 ms; daily run 1-2 s; `recurrenceDates` microseconds.
- Memory usage: negligible (≤ 14 dates and ≤ 14 instance rows per rule in memory).
- Throughput: dozens of new instances a day; each instance transaction holds a session lock for about 10-60 ms (dominated by auto-enrol).

### At 10x Scale
- Expected latency: daily run about 150-300 new instances × 20-60 ms ≈ 10-20 s, inside the 900 s expiry. Series save unchanged (bounded by H).
- Memory usage: still O(14) per rule; rules streamed in pages (architecture).
- Bottlenecks: auto-enrol for large member lists inside the instance transaction. A series create burst (≤ 14 instances) per rule. Neither threatens C-SSE-5, because each lock is per instance.

### Optimization Opportunities
- Batch-insert courts with one multi-row `INSERT`.
- Page rules by `team_id` for the sweep (architecture B1).
- A per-series lead time (A2-3/4) if clubs ask for it, as a new column defaulting to H.
- A per-registration fee snapshot (10-3) if upward fee corrections become a real need.

## Validation Checklist

- [x] Meets latency requirements (bounded by H; one short lock per instance)
- [x] Meets memory requirements (O(14) per rule)
- [x] Handles all edge cases (table above; V1-V26, E1-E5, T1-T9)
- [x] Scales to expected data size (10x within the job expiry)
- [x] Implementation feasible (pure functions plus existing primitives: `addLocalDays`, `resolveLocal`, `localToInstant`, `instantToLocal`, `defaultCancellationDeadline`, `divideByInteger`, `min`)
- [x] Respects Guiding Principles and data flow patterns in systemPatterns.md (P1: CHECKs and triggers in H1, H6, H7, H8; P2: `Money` only; P3: calendar dates only in the generator, instants via `time.ts`; P5: email, auto-enrol and job enqueues in the domain transaction; P7: `RECURRENCE_HORIZON_DAYS` through `intInRange`)

## Testing Strategy

### Unit Tests
- `recurrence.test.ts`: V1-V26, E1-E5, `defaultMonthlyWeek`, run under two `TZ` values, plus a property test that every output date is `≥ startsOn`, `≤ recurUntil`, ascending, has weekday `dayOfWeek` and, for FORTNIGHTLY, `(epochDay - anchor) % 14 == 0`.
- `instance.test.ts`: T1-T5 (DST normalisation, deadline), FLAT `fee_flat` derivation.
- `costing.test.ts`: C1-C13.
- `reconcile.test.ts`: the reconciliation vectors and every skip reason, plus delete against keep for each status and override combination.

### Integration Tests
- Materialiser: window bounds (today and today+H inclusive, start-passed date skipped); re-run creates nothing; concurrent per-rule and sweep runs on the same date; gate-refused DRAFT and one email per rule per ISO week (second run the same week: no email; run in the next week: one email); draft retry publishes and enqueues auto-enrol once.
- Series save: the reconciliation vectors against real rows; `promoteWaitlist` called once on a capacity raise via the recording double; `fee_locked` with a stand-in CONFIRMED registration; free to paid refused by the gate during reconciliation.
- Fee-raise trigger: raw `UPDATE` raising `fee_flat` on a PUBLISHED session with a CONFIRMED row gives 23514 `game_sessions_fee_raise_locked`; a decrease commits.
- DST: T6-T9 through the API.

### Performance Tests
- Seed 1,000 weekly rules × 12 courts × 30 Auto Enroll members (recording double) and time a cold sweep (target under 60 s) and a warm re-run (no inserts, target under 5 s).

---

## Hand-offs to architecture / journey / UI

These are requirements this algorithm places on the sibling docs. The siblings own the design of each.

**To architecture** (`session-scheduling-engine-architecture.md`):
- **H1 Rule anchor schema.**
  - Columns: `recurring_session_rules.starts_on date NOT NULL` and `monthly_week smallint`.
  - CHECKs:
    - `extract(dow from starts_on) = day_of_week`;
    - `(frequency = 'MONTHLY') = (monthly_week IS NOT NULL)`;
    - `monthly_week IN (1, 2, 3, 4, -1)`;
    - for MONTHLY, `starts_on` is the `monthly_week`-th (or last) weekday of its month (an IMMUTABLE SQL helper);
    - `recur_until IS NULL OR recur_until >= starts_on`.
  - Use the learned-rule `NOT VALID`/`VALIDATE` pattern plus an upgrade test if any rows can exist.
- **H2 Rule-court template.** The algorithm needs an ordered `{ court_identifier, start_time, end_time }[]` per rule, with a `UNIQUE(rule, identifier)` and the same time-order CHECK. Shape and the fate of `default_court_count`/`default_start_time`/`default_end_time` are architecture's call. Rule save also refuses a court with start ≥ 02:00 and end ≤ 03:00.
- **H3 Durable once-per-week email guard.**
  - Purpose: `enqueueEmail` dedupes only queued or active jobs, so the materialiser needs a durable claim.
  - Recommended: a small table keyed `(rule_id, window_start)` with `INSERT … ON CONFLICT DO NOTHING RETURNING`, done in the instance transaction before the enqueue.
  - Do **not** use an `UPDATE` on the rule row. An instance transaction holding the rule `FOR SHARE` that upgrades to an update deadlocks against a concurrent run doing the same.
  - Key format: `payout-missing:<ruleId>:<isoWeekStart(today)>`.
- **H4 Materialiser reads the template under a rule lock.**
  - Each instance transaction must read the rule and its template under a lock that conflicts with a rule edit (for example `FOR SHARE` against the edit's `FOR NO KEY UPDATE`). An instance is then never inserted from a template that an already-committed edit replaced, and the edit's reconciliation sees every instance inserted before it.
  - Implied order: `teams` (gate `KEY SHARE`) → `recurring_session_rules` → `game_sessions` → (`team_members` for same-transaction auto-enrol on the uncommitted row, allowed by ADR 0017 point 5) → registrations. Architecture fixes B2.
- **H5 Series-save reconciliation.**
  - Synchronous in the PUT, after the rule transaction commits, so the response can carry counts (AC-HAPPY-7).
  - One short transaction per instance, in date order: gate (free to paid only) → session `FOR UPDATE` → re-check eligibility → `UPDATE` plus court replace → `promoteWaitlist` on a capacity raise.
  - Bounded by H, at most 14.
  - Skip on lock timeout, reported as `busy`; the next save converges.
- **H6 Fee-raise lock.**
  - SQL function `game_session_has_active_registrations(session_id)`, today `status IN ('CONFIRMED', 'WAITLISTED')`.
  - BEFORE UPDATE trigger `game_sessions_fee_raise_locked` (23514): on a PUBLISHED row, a pricing change or any applicable fee raise with active registrations is refused.
  - Race-safe because the allocator writes registrations only under the session `FOR UPDATE` lock (D-14, C-ALL-1).
  - Error mapper: 409 `session_fee_locked`.
- **H7 FLAT fee invariant.**
  - `CHECK (pricing_structure <> 'FLAT' OR fee_flat IS NOT DISTINCT FROM COALESCE(custom_player_rate, calculated_rate_per_player))` on `game_sessions`.
  - On rules: FLAT ⇒ `fee_flat IS NOT NULL`.
  - BY_SKILL fees-present CHECK on rules (unconditional, like BY_SEX) so every instance is publishable.
  - Optional: a CHECK or generated column for the suggestion's SQL twin, with a parity test.
- **H8 DRAFT deletion.** Immutability triggers must allow `DELETE` of DRAFT rows (A4 removes unedited off-pattern drafts) and refuse deleting PUBLISHED, COMPLETED or CANCELLED rows.
- **H9 Durable auto-enrol for existing-session publishes.**
  - Applies to manual publish, the materialiser retry, and the manual publish of a series draft.
  - Enqueue in the publish transaction, recommended as a job keyed `session-auto-enrol:<sessionId>`. It runs `selectAutoEnrollees` plus `autoEnrolInSession` in a transaction that has not locked the session first (ADR 0017 point 5).
  - Fresh materialiser inserts stay same-transaction.
  - This also gives the conflict-1 rollout gap a natural backfill handle (re-enqueue for PUBLISHED future sessions). The gap decision stays with architecture.
- **H10 (optional P1 backstop).** A constraint trigger on `session_courts` refusing a time that is nonexistent on its session's date (23514). D-08 is unchanged.
- **H11 Config.** `RECURRENCE_HORIZON_DAYS: intInRange(7, 91, 28)` in `config.ts`, `.env.example`, `docs/getting-started.md`.

**To user journey** (`session-scheduling-engine-admin-user-journey.md`):
- **J1 Publish confirmation.** Every first publish (one-off included) auto-enrols Auto Enroll members. The confirmation names that, with a count from `selectAutoEnrollees` at render time.
- **J2 Series save outcome.** Updated, unchanged, and left-behind counts by reason (edited, closed, started, deadline passed, fee locked, banking, busy), plus "removed N drafts" and the kept off-pattern list with a "Cancel" link per row.
- **J3 Pattern change.** Requires a "Starting from" date; dates before it keep their current sessions.
- **J4 End series.** The confirmation shows how many drafts will be removed and which published sessions after the date will be kept.
- **J5 Telling players.** Fee decreases and time changes reach registered players without an email (C3 stays out of scope). Fee raises are impossible once anyone registered.

**To UI/UX** (`session-scheduling-engine-uiux.md`):
- **J6 Monthly picker.** "1st, 2nd, 3rd, 4th, last" plus weekday, derived from the first date; offer "4th" or "last" when the first date is both.
- **J7 Optional actions.**
  - "Skip a future date" for dates beyond the horizon: materialise as DRAFT and cancel, so the CANCELLED key blocks it.
  - "Revert to series" on an edited instance: clear the override and reconcile, subject to the same skip rules.
  - Both are SHOULD, not MUST.
- **J8 DST choices.** A gap shows two buttons with the real times (03:30 or 01:30). An overlap shows a confirm for "the first 2:30 am (NZDT)". A deadline overlap shows both.
- **J9 Rate and deadline controls.**
  - "Use suggested rate" means following the suggestion. Typing pins the rate.
  - Fee-locked message suggests pinning the rate.
  - Deadline shows "Default (48 hours before start)" or a custom date and time.
  - BY_SEX/BY_SKILL pre-fill from the final rate; `fee_other` tracks `min` until edited.

**To registration-and-waitlist** (record in ADR 0019 as offered or assumed):
- **R-a** Widen `game_session_has_active_registrations` to include `withdrawal_fee_due` rows in its own migration.
- **R-b** `autoEnrolInSession` should treat an existing row in any status (including WITHDRAWN) as `already_registered`, so a retried durable auto-enrol job never re-registers someone who withdrew.
- **R-c** Optional: `registerInSession` may accept the fee the player saw (`expectedFees`) to close the seconds-wide window between a fee decrease and a registration. With decrease-only fees this is only ever in the player's favour, so it is not required.

## Amendments to the task file

Do not apply here; for the orchestrator's reconciliation step.

1. **AC-HAPPY-5**: replace "a first date" and "Monthly follows the rule chosen in creative (open question A1)":
   - The first date is stored as `starts_on` and must fall on the chosen weekday.
   - Monthly is "the 1st/2nd/3rd/4th/last {weekday}" (`monthly_week`), defaulted from the first date, with a 5th weekday stored as "last".
   - Instances are created for dates in `[today, today + RECURRENCE_HORIZON_DAYS]` (default 28) that are ≥ `starts_on`, ≤ `recur_until` and whose start is still in the future.
   - Each instance is published as it is created unless the gate refuses.
2. **AC-HAPPY-7**: replace "follows the creative ruling (open question A3)":
   - Every future unedited DRAFT or PUBLISHED instance is reconciled to the series, one at a time. A PUBLISHED one changes only while its current and new cancellation deadlines are both in the future.
   - Never touched: edited, started, COMPLETED and CANCELLED instances.
   - Capacity raises call `promoteWaitlist`; free to paid goes through the gate; fee raises on instances with active registrations are skipped (`fee_locked`).
   - The page shows counts: updated, unchanged, and left behind by reason.
   - Re-saving the same series is a no-op.
3. **AC-HAPPY-10**: replace "handled per the creative ruling (open question A4)":
   - Unedited DRAFT instances after the end date are deleted.
   - Edited drafts and PUBLISHED instances after it are kept and listed for the admin to cancel.
   - The confirmation shows both counts.
4. **New AC-HAPPY-12 (MUST), changing a series' day or frequency**:
   - Changing frequency, weekday, monthly week or first date requires a "Starting from" date ≥ today (else 422).
   - Instances before it are untouched.
   - From it onwards, unedited drafts on dates no longer in the pattern are deleted, and edited or published ones are kept and listed.
   - A date that has a CANCELLED instance stays cancelled when the pattern returns to it.
5. **AC-HAPPY-2**:
   - `fee_flat = custom_player_rate ?? calculated_rate_per_player` after **every** save of a FLAT session or rule, not only at publish, backed by a CHECK.
   - `custom_player_rate` NULL means the rate follows the suggestion ("Use suggested rate").
6. **AC-HAPPY-3**:
   - An omitted `feeOther` defaults to `min(fee_male, fee_female)` only when switching into BY_SEX; a saved value is kept.
   - BY_SEX/BY_SKILL inputs are pre-filled in the form from the final rate (UI only).
7. **AC-HAPPY-11**:
   - "Still the default" is inferred as `cancellation_deadline = starts_at − 48 h`. No column is added.
   - The API accepts `cancellationDeadline: null` for the default.
8. **AC-ASYNC-1**:
   - Add the window definition (`today` read once from the injected clock; inclusive `[today, today + H]`; started dates skipped).
   - Add that a template court time in a DST gap is stored as the real wall time (02:30 becomes 03:30 on 2026-09-27), while an overlap time is stored unchanged and resolves earlier.
9. **AC-ASYNC-2** and **AC-INTEGRATION-2**:
   - Auto-enrol runs once on **every** session's first DRAFT to PUBLISHED transition, including one-off sessions and manual publishes of series drafts. It runs in the same transaction for a freshly inserted instance, and through a durable follow-up enqueued in the publish transaction otherwise.
   - Add a test: a manual publish of a gate-refused draft produces exactly one `autoEnrolInSession` call.
   - Record the extension of ADR 0017 point 6 in ADR 0019.
10. **AC-ASYNC-3**:
    - `windowStart` is the Monday of the run's NZ local week (`YYYY-MM-DD`).
    - The email is enqueued only when a durable `(rule, windowStart)` guard is newly claimed in the same transaction, giving at most one email per rule per NZ week.
11. **AC-ERROR-3**:
    - **Gap**: the 422 offers 03:30 (shifted forward) and 01:30 (shifted back), and the client resubmits the chosen real time.
    - **Overlap**: the 422 offers only "the first 2:30 am (NZDT)", accepted with a transient `startDisambiguation`/`endDisambiguation: 'earlier'`.
    - **Explicit deadline**: may take `earlier` or `later`.
    - **Body**: `validation_failed` with `fieldErrors` `local_time_nonexistent`/`local_time_ambiguous` and `dstOptions`.
    - **Schema**: no stored disambiguation column; D-08 unchanged.
12. **New AC-ERROR-10 (MUST), fees cannot rise for registered players**:
    - Scope: a PUBLISHED session with an active registration (`game_session_has_active_registrations`).
    - Refused with 409 `session_fee_locked`, naming the fields: a pricing-structure change, any applicable fee increase (including free to paid), or a costing change that raises a followed FLAT suggestion.
    - Decreases are accepted.
    - Raw SQL fails with 23514 `game_sessions_fee_raise_locked`.
13. **AC-VERIFY-1**: add the raw-SQL tests for:
    - the anchor and `monthly_week` CHECKs;
    - `recur_until >= starts_on`;
    - the FLAT `fee_flat` CHECK;
    - the BY_SKILL rule CHECK;
    - the fee-raise trigger;
    - DRAFT-only deletion.
14. **AC-VERIFY-4**:
    - The function takes `(frequency, dayOfWeek (0 = Sunday), startsOn, monthlyWeek, recurUntil)`.
    - Reference the V1-V26 and E1-E5 vector table in this doc, including months where the 4th and the last weekday differ (V12 and V13).
15. **Implementation Roadmap**:
    - Add `packages/shared/src/sessions/instance.ts` (`buildInstance`, DST normalisation) and `reconcile.ts` (`planSeriesReconciliation`) beside `recurrence.ts` and `costing.ts` (`feeRaised`).
    - `config.ts` gains `RECURRENCE_HORIZON_DAYS` (7..91, default 28).
    - The error codes gain `session_fee_locked`.
16. **Scope / Out of scope**: add "per-series publish lead time" and "per-registration fee snapshot" as recorded evolution paths (two-way doors), and "second-occurrence (NZST) court times on the DST-end night" as deliberately unsupported.
