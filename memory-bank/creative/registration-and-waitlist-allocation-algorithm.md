# Algorithm Decision: Registration Seat Allocation, Waitlist Promotion and Late-Withdrawal Liability

**Created**: 2026-10-16
**Status**: DECIDED
**Decision Type**: Algorithm
**Task**: registration-and-waitlist (Level 4)
**Creative questions owned**: Q1 (a waitlisted group that doesn't fit), Q3 (fee-transfer semantics at and after the deadline)
**Sources read**: task file on `feature/registration-and-waitlist` (spec, 40 ACs, billing boundary); `db/migrations/20260929000600000_game_sessions_and_courts.sql`, `...000700000_registrations_and_guests.sql`, `...000900000_payments_and_invoicing.sql`; `docs/adr/0012`, `docs/adr/0015`; `packages/shared/src/money/money.ts`; `apps/api/src/lib/clock.ts`; `workflows_state_machine_architecture.md` §1, §2, §3 (authoritative); `PRODDUCT-OVERVIEW.md` §5, §6; `main:memory-bank/productBrief.md`, `main:memory-bank/systemPatterns.md`.

## Problem Statement

A session has `publicCapacity = max_players - reserved_seats` places. Members register as parties of 1 to 3 people (registrant plus 0 to 2 guests). A party is confirmed or waitlisted whole. When places free up (withdrawal, ban, capacity raise), waitlisted parties are promoted in FIFO order. The allocator must decide three things, deterministically and under the D-14 session row lock:

1. **Seats (Q1).** Who gets freed seats when the head of the waitlist is larger than the free seats, and when a newcomer may take a free seat ahead of the waitlist.
2. **Liability (Q3).** After `cancellation_deadline`, a withdrawer is free if someone takes their place and owes the fee otherwise (workflows §2). This feature cannot write `payments` (an Akahu `payment_link_token NOT NULL`, line items with a registrant line at position 0 summing to `amount`, `UNIQUE(registration_id)`; ADR 0012). It must therefore record the liability in a form billing can read at session end.
3. **Time.** Each operation must be classified EARLY or LATE exactly, from a single `now`.

The decision must be a pure function (`decideAllocation`) that every seat-changing path calls: register, withdraw, ban withdrawal, `promoteWaitlist` (capacity edits) and auto-enrol. The function is checked by a table-driven matrix and a property test (AC-VERIFY-4).

## Inputs & Outputs

### Inputs
| Name | Type | Size/Range | Source |
|------|------|------------|--------|
| `publicCapacity` | integer | 0..`max_players` (typ. 8–40) | `game_sessions.max_players - reserved_seats`, read under the D-14 lock |
| `confirmedParties` | `{ registrationId, partySize }[]` | 0..capacity rows; `partySize` 1..3 | `registrations WHERE status = 'CONFIRMED'` (`partySize = 1 + guest_count`) |
| `waitlist` | `{ registrationId, partySize, queuePosition }[]` | 0..~100 rows; positions unique, ≥ 1 | `registrations WHERE status = 'WAITLISTED' ORDER BY queue_position` |
| `openLiabilities` | `{ registrationId, partySize }[]`, oldest first | 0..a few rows | `registrations WHERE status = 'WITHDRAWN' AND withdrawal_fee_due ORDER BY withdrawn_at, id` |
| `request` | `register` / `withdraw` / `rebalance` (see Implementation Details) | one per call | service, ban handler, `promoteWaitlist`, auto-enrol |
| `now` | `Date` (ms precision, UTC instant) | one per operation | `clock.now()`, read once and passed down (not an input of the pure function; used by `classifyWithdrawal` and `isRegistrationOpen`) |
| `cancellation_deadline`, `starts_at`, `status` | `timestamptz`, `session_status` | `deadline <= starts_at` (D-09) | `game_sessions` row locked `FOR UPDATE` |

### Outputs
| Name | Type | Description |
|------|------|-------------|
| `outcome` | `'applied' \| 'refused'` | A refusal changes nothing (no promotions, no releases) |
| `refusal` | `'already_registered' \| 'not_registered' \| 'party_exceeds_capacity' \| 'late_withdrawal_fee_due'` | Why a request was refused. The service maps it to the HTTP error |
| `newcomer` | `{ status: 'CONFIRMED' } \| { status: 'WAITLISTED', queuePosition }` | Register only. `queuePosition = max(input waitlist positions, 0) + 1` (D-14) |
| `withdrawn` | `{ fromStatus, kind, feeDue }` | Withdraw only. `kind` ∈ EARLY, LATE, BANNED |
| `promotions` | `{ registrationId, partySize, fromQueuePosition }[]` | In ascending queue order. Each becomes CONFIRMED with `promoted_at = now` and gets one promotion email |
| `releasedLiabilities` | `registrationId[]` | Earlier fee-due withdrawals whose places were resold in this step; set `withdrawal_fee_due = false` |
| `seatsTaken`, `seatsLeft` | integers | After the step; `seatsLeft = max(0, publicCapacity - seatsTaken)` for display and logs |

### Edge Cases
1. **Head of the waitlist larger than the free seats.** Skipped; the first party behind it that fits is promoted. The head keeps its position and stays first for the next scan (Q1).
2. **Newcomer while seats are free and the waitlist is non-empty.** By the invariant, no waitlisted party fits, so a newcomer that fits is CONFIRMED (it is scanned after every waitlisted party).
3. **Party that can never fit** (`partySize > publicCapacity`, including capacity 0). Register is refused with `party_exceeds_capacity`.
4. **Waitlisted party that stops fitting after an admin capacity cut.** It stays WAITLISTED, is skipped by every scan, and is never billed. It may leave for free.
5. **Over capacity after an admin cut** (`seatsTaken > publicCapacity`). Free seats are ≤ 0, so nobody is promoted or confirmed. Nobody is demoted. A late withdrawal in this state frees no resellable seat and is liable (see Q3 trade-offs).
6. **Late withdrawal, nobody fits.** The withdrawer is liable now and is released if a later confirmation resells places before `starts_at` (Q3b).
7. **Late withdrawal of a party of 3 refilled by a party of 1.** Not liable: any promotion in the step releases the withdrawer (Q3a).
8. **Leaving the waitlist**, early or late. Never liable; frees no seat; promotes nobody when the invariant held before.
9. **`now == cancellation_deadline`.** EARLY (free). `now == starts_at` or later: closed (refused before classification). `deadline == starts_at`: there is no late window.
10. **Re-registration of a fee-due withdrawal.** Allowed only into a CONFIRMED place for a party at least as large as before, otherwise refused with `late_withdrawal_fee_due` (closes a fee-escape path; see Q3).
11. **Empty inputs.** Empty waitlist: nothing is promoted. No confirmed parties: `seatsTaken = 0`. Capacity 0: every register is refused.
12. **Malformed inputs** (duplicate ids, `partySize` outside 1..3, duplicate positions). A programming error: `decideAllocation` throws, the transaction rolls back, and the DB would have refused the state anyway (P1).

## Constraints

### Performance Requirements
- **Maximum Latency**: register and withdraw p95 < 300 ms at 100 registrations per session (spec NFR). The decision itself must be negligible next to the 5–8 SQL statements of the transaction.
- **Throughput**: per session, serialised by the D-14 lock. Target: absorb a publish-time rush of 40+ simultaneous registrations within about 1 s.
- **Memory Budget**: O(registrations in one session), at most a few KB per call.

### Scale Requirements
- **Current Data Size**: 0 (no registration code yet). Typical session: 8–40 public places, 0–20 waitlisted parties.
- **Expected Growth**: the spec ceiling is 100 registrations per session. Sessions are independent, so growth in teams or sessions does not affect the per-call cost.
- **Peak Load**: tens of concurrent operations on one session at publish time (AC-INTEGRATION-1a: 20-way race).

### Other Constraints
- **D-14 (binding)**: every enqueue, withdraw and promote runs under `SELECT ... FROM game_sessions WHERE id = $1 FOR UPDATE`. Enqueue uses `coalesce(max(queue_position), 0) + 1`, positions are never renumbered, and the scan is in ascending `queue_position`.
- **Never split a party** (product rule; `registration_guests` belong to one registration with one status).
- **Workflows §2 is authoritative**: `now <= cancellation_deadline` is free. Late: if someone takes the place, the fee moves to them; otherwise the withdrawer pays.
- **No money rows** (AC-VERIFY-10). Billing (wallet-and-akahu-billing) creates the only `payments` row per registration (`UNIQUE(registration_id)`), at most one line per party member (`party_position` 0..2), and the registrant line at position 0 is mandatory. So a liability must be a **whole party** on **one registration**.
- **P1**: the DB backstops every invariant the decision should never break. **P2**: fee estimates are `Money` only. **P3**: UTC instants and one injected `now` per operation.
- **ADR 0015**: ban withdrawals use early semantics (never liable), then the standard promotion.
- **Explainability**: a player must be able to understand the outcome from one sentence on the panel.

## Options Explored

### Part A: Q1, a waitlisted group that doesn't fit

#### Option 1A: First-fit in queue order (spec default)
- **Approach**: After any change, scan WAITLISTED parties in ascending `queue_position` with budget `free = publicCapacity - seatsTaken`. Promote each party with `partySize <= free` and subtract it from the budget. Stop when `free < 1`. A newcomer is placed at the tail of the same scan: it is CONFIRMED only if it still fits after every waitlisted party that fits has been promoted, and is otherwise WAITLISTED at `max + 1`. A skipped party keeps its position and is offered seats first on every later scan.
- **Pseudocode**:
  ```
  function firstFit(queue /* ascending position */, free):
      promoted = []
      for p in queue:
          if free < 1: break
          if p.partySize <= free:
              promoted.push(p); free -= p.partySize
      return promoted
  ```
- **Time Complexity**:
  - Best: O(1): no free seats (`free < 1`) or the first party fills the free seats exactly.
  - Average: O(k), where k is the number of parties scanned before the budget reaches 0. With parties of 1–3 and 1–3 freed seats, k is usually 1–3.
  - Worst: O(W), when every waitlisted party is too large (e.g. one free seat, W parties of 2 or 3).
- **Space Complexity**: O(W) for the ordered queue (already materialised by the query); O(1) extra.
- **Data Structures**: an array ordered by `queue_position` (the partial unique index `uq_registrations_waitlist_position` gives an index-ordered read).
- **Pros**:
  - Seats never sit empty while a waitlisted party could use them, so utilisation and team revenue are highest.
  - One rule covers promotion and newcomers ("the newcomer is the tail of the queue"), so there is no special newcomer branch.
  - It yields a simple, checkable invariant: no WAITLISTED party fits the free seats.
  - It matches workflows §2 best: "if the waitlist is non-empty, promote and the fee moves to the new player".
- **Cons**:
  - A party of 3 can be passed over repeatedly by smaller parties behind it (starvation risk). It gets in only when 3 seats free up at once or capacity is raised.
  - The rule must be explained to the passed-over party.
- **Best For**: sessions dominated by solo players with occasional groups (the expected mix).
- **Worst For**: sessions where large groups are common and small parties constantly backfill.

#### Option 1B: Strict head-of-line (block)
- **Approach**: Promote the head while it fits; stop at the first party that doesn't fit. A newcomer is waitlisted whenever the waitlist is non-empty.
- **Pseudocode**:
  ```
  function block(queue, free):
      promoted = []
      for p in queue:
          if p.partySize > free: break
          promoted.push(p); free -= p.partySize
      return promoted
  ```
- **Time Complexity**: Best O(1) (head doesn't fit); Average O(k); Worst O(W) (every party fits). Space O(1) extra.
- **Data Structures**: the same ordered array.
- **Pros**:
  - Pure FIFO: nobody is ever passed over, so it is trivially fair to groups.
  - Very simple to explain.
- **Cons**:
  - Seats sit empty while willing players wait, sometimes until start.
  - Late withdrawers are charged even though a waitlisted player could have taken the place, which contradicts the spirit of workflows §2.
  - A newcomer is refused a free seat because of a group that can't use it.
- **Best For**: products where group integrity matters more than utilisation (e.g. fixed-team bookings).
- **Worst For**: social sessions with mostly solo players, close to start.

#### Option 1C: Bounded skip (first-fit with an anti-starvation cap)
- **Approach**: First-fit, but each WAITLISTED row counts how often it has been passed over (new column `times_skipped`). Once the head reaches N skips (or once `now > starts_at - X h`), the scan blocks behind it.
- **Pseudocode**:
  ```
  function boundedSkip(queue, free, N):
      promoted = []
      for p in queue:
          if free < 1: break
          if p.partySize <= free: promoted.push(p); free -= p.partySize
          else if p.timesSkipped >= N: break
          else: mark p skipped (persisted)
      return promoted
  ```
- **Time Complexity**: Best O(1); Average O(k); Worst O(W), plus O(W) skip-counter writes. Space O(1) extra, plus one persisted counter per row.
- **Data Structures**: the ordered array plus a persisted per-registration counter (new column, CHECK, migration, and an invariant for the property test).
- **Pros**:
  - It bounds how often one party is passed over.
- **Cons**:
  - More state that must stay consistent across re-registration and promotion.
  - It is hard to explain: "you were skipped twice, now everyone waits for you".
  - It inherits block's empty seats and unfair late-withdrawal charges.
  - The time-based variant switches to block exactly when late withdrawals cluster (the last 48 h).
  - N and X are arbitrary tuning knobs, and the spec forbids new environment variables.
- **Best For**: queues with long waits and many large groups.
- **Worst For**: small sessions close to start.

#### Option 1D: Best-fit packing (maximise seats used)
- **Approach**: Choose the subset of waitlisted parties that fills the free seats best (a subset sum with item sizes 1–3), tie-broken by queue position.
- **Time Complexity**: O(W · free) with dynamic programming. Tiny in absolute terms, but the order is no longer FIFO.
- **Space Complexity**: O(W · free) for the DP table.
- **Pros**: the most seats filled per step.
- **Cons**: it violates FIFO even among parties that fit (a party of 2 at position 5 can beat a party of 1 at position 2), it is opaque to players, and the extra utilisation over 1A is marginal because first-fit with sizes 1–3 already leaves at most 2 seats idle per step.
- **Best For**: revenue maximisation with no fairness requirement.
- **Worst For**: this product, whose rule is a FIFO waitlist.

#### Evidence: Monte Carlo comparison (scratch simulation, not project code)
The model: 20,000 sessions per row. Parties are 75% size 1, 17% size 2 and 8% size 3. Arrivals are uniform over 7 days, and the deadline is 48 h before start. Each party withdraws with probability 25% at a random later time. Demand is 1.4× public capacity. The numbers are per 100 sessions.

| Capacity / rule | Empty seats at start while parties wait | Late withdrawals charged despite a waitlist | Utilisation | Size-3 parties confirmed | Solo players confirmed | Size-3 still waiting at start while a later registrant got in |
|---|---|---|---|---|---|---|
| 10 / first-fit (1A) | **7.1** | **18.4** | **98.3%** | 54.8% | **78.5%** | 17.6 |
| 10 / block (1B) | 28.9 | 18.6 | 96.2% | **60.2%** | 73.0% | **0** |
| 10 / bounded skip N=2 (1C) | 13.2 | 21.7 | 97.7% | 55.7% | 77.4% | 15.9 |
| 20 / first-fit (1A) | **3.6** | **20.6** | **99.6%** | 58.2% | **78.2%** | 32.2 |
| 20 / block (1B) | 30.2 | 41.1 | 98.3% | **65.5%** | 72.7% | **0** |
| 20 / bounded skip N=2 (1C) | 18.0 | 39.5 | 98.9% | 61.1% | 76.0% | 23.5 |

Reading the table: block confirms about 6–7 percentage points more size-3 parties. The cost is 4× to 8× more empty seats while people wait, about 5 points fewer solo players confirmed, and, at capacity 20, twice as many late withdrawers charged although someone was waiting. Bounded skip gets most of block's costs and little of its benefit.

### Part B: Q3, fee-transfer semantics at and after the deadline

All options share three things. Liability exists only for a **LATE** withdrawal of a **CONFIRMED** party (never for EARLY, BANNED, or leaving the waitlist). A promoted party "takes the fee" by being CONFIRMED and billed at session end. Nothing is written to money tables. They differ in **when** liability is settled and **how much** it covers.

#### Option 3A: Decided once at withdrawal, whole party (spec default)
- **Approach**: In the withdrawal step, `feeDue = (kind == LATE) && fromStatus == CONFIRMED && promotions.length == 0`. The flag never changes afterwards.
- **Pseudocode**:
  ```
  feeDue = kind == 'LATE' and from == 'CONFIRMED' and promotions.length == 0
  ```
- **Time Complexity**: O(1) on top of the first-fit scan (Best/Avg/Worst O(1)).
- **Space Complexity**: O(1): one boolean column.
- **Data Structures**: `registrations.withdrawal_fee_due boolean`.
- **Pros**:
  - The simplest rule. The outcome told to the player at withdrawal is final.
  - Literal reading of workflows §2, where the payment record is generated at withdrawal.
- **Cons**:
  - **It charges the same seat twice.** A liable withdrawer's freed seat is usually taken later by a newcomer (registration stays open until start), who is also billed. Simulation: **69%** (capacity 10) and **86%** (capacity 20) of liable seats were resold before start. That is 35–42 double-charged seats per 100 sessions.
  - It contradicts the plan's own business context ("never charge twice", "no surprise fees").
- **Best For**: sessions where nobody registers after the deadline.
- **Worst For**: under-subscribed sessions with last-minute sign-ups, the exact case where liability arises.

#### Option 3B: Provisional at withdrawal, released when the place is resold (chosen)
- **Approach**: Same as 3A at the withdrawal step, but a fee-due withdrawal is an **open liability** until `starts_at`. Every later allocation step that confirms parties (a newcomer confirmed, a promotion by any cause) **releases open liabilities oldest-first** with a seat budget equal to the seats newly confirmed in that step. A liability is released whole while the remaining budget is > 0, so rounding always favours the player. In a withdrawal step, the current withdrawer is first in line for its own step's budget. That reproduces 3A's "someone took your place" exactly, and leftover budget releases older liabilities. Liabilities only ever go from due to released, never back. At `starts_at` they freeze, because no allocation step runs after start. Billing reads the same column at session end.
- **Pseudocode**:
  ```
  function release(liabilities /* oldest first */, budget):
      released = []
      for l in liabilities:
          if budget <= 0: break
          released.push(l.id); budget -= l.partySize
      return released
  // withdrawal step (LATE, from CONFIRMED):
  //   S = Σ size(promotions)
  //   if S == 0: withdrawer becomes an open liability (feeDue = true)
  //   else: withdrawer released (feeDue = false); release(open, S - withdrawer.partySize)
  // any other step: release(open, Σ size(promotions) + (newcomer confirmed ? newcomer.partySize : 0))
  //   a fee-due re-registrant that confirms nets off its prior party size first (floor 0)
  ```
- **Time Complexity**: Best O(1) (no confirmations or no open liabilities); Average O(1)–O(2); Worst O(L), where L is the number of open liabilities in the session (single digits).
- **Space Complexity**: O(L) for the ordered liability list read under the lock; one boolean column.
- **Data Structures**: `withdrawal_fee_due boolean` (now meaning "currently due"), `withdrawn_at` for the ordering, an ordered list of open liabilities.
- **Pros**:
  - **No seat is charged twice.** With fixed or raised capacity, the invariant `Σ open liable seats ≤ free seats` holds after every step (proof below). Simulation: charged seats fall from 51.2 to 13.0 per 100 sessions (capacity 10) and from 49.1 to 6.1 (capacity 20), always ≤ the empty seats at start.
  - It is workflows §2's rule ("the fee moves to whoever takes the place") applied to anyone who takes the place before the game, not only a waitlisted player at that instant.
  - The billing hand-off contract (`listBillableRegistrations`) is unchanged.
  - It is a whole-party liability, so it is representable as one payment with a position-0 line.
- **Cons**:
  - The withdrawer's outcome is conditional until start, so the copy must say "unless someone takes your place before the game".
  - The allocator reads one more small list and may write one more guarded UPDATE.
  - Rounding in the player's favour under-collects a little when a small party refills a larger liability: about 2–3 seats per 100 sessions in the simulation.
- **Best For**: this product: registration stays open until start, and parties are small.
- **Worst For**: nothing material. An admin capacity cut can leave a liability standing although the seat no longer exists (an edge case, accepted).

**Proof sketch (no capacity cut).** Let E be the free seats and L the open liable seats, with L ≤ E before a step.
- A liability is created only when nothing is promoted: L and E both grow by the party size.
- A step confirming S seats lowers E by S. Its release removes at least min(L, S) liable seats, because it releases while the budget is > 0 and each release consumes at most its own size. So L' ≤ max(0, L - S) ≤ E - S = E'.
- In a withdrawal step, the withdrawer first consumes s of the budget; the bound still holds because E grows by s.
- Early withdrawals, ban withdrawals and capacity raises only grow E. ∎

#### Option 3C: Settled at session end (billing derives from final occupancy)
- **Approach**: Record only the provisional fact (a LATE withdrawal with nobody promoted). At session end, billing computes the empty seats E and charges provisional withdrawers covering at most E seats, choosing which ones by rule (oldest first, or newest first).
- **Time Complexity**: O(R log R) at billing time over the session's withdrawn rows; O(1) at withdrawal.
- **Space Complexity**: O(1) at withdrawal time; O(R) at billing time.
- **Pros**: exact against the final state; nothing to update during the session.
- **Cons**:
  - It moves registration semantics into billing (two features must implement and test the same rule).
  - Capacity edits, bans and re-registrations between withdrawal and start make "final occupancy" ambiguous.
  - The player has no answer until after the game.
  - Partial coverage (E < party size) needs a partial payment that the line-item model cannot express without arbitrary member selection.
- **Best For**: systems with a single post-hoc settlement engine.
- **Worst For**: this split of features (billing is not built; this feature owns the allocation semantics).

#### Option 3D: Proportional liability (charge only the unfilled seats)
- **Approach**: Record `withdrawal_fee_seats` (1..3), the seats not refilled, and have billing charge the registrant line plus the first k-1 guest lines.
- **Time Complexity**: O(1) per step, plus per-seat attribution bookkeeping (O(L) per step).
- **Space Complexity**: one extra smallint per registration.
- **Pros**: the most exact money.
- **Cons**:
  - Which guests count as the unfilled seats is arbitrary, and it matters under BY_SEX or BY_SKILL_LEVEL pricing (guest fees differ).
  - It needs seat-level attribution of every refill (which freed seat did a newcomer take?).
  - It forces billing to build partial payments.
  - The gain over 3B is about 2–3 seats per 100 sessions.
- **Best For**: high-value bookings where every seat matters.
- **Worst For**: this product (fees of about $17, parties of 1–3).

#### Sub-decision (f): the liability marker
| Option | Shape | Verdict |
|---|---|---|
| f1: column on `registrations` | `withdrawal_fee_due boolean NOT NULL DEFAULT false` + `withdrawal_kind` + `withdrawn_at` | **Chosen.** One registration ↔ at most one payment (`UNIQUE(registration_id)`), so the billing key and the liability key are the same row. CHECK-able (P1), indexable, and read in the same query as CONFIRMED rows |
| f2: liability table | `registration_liabilities(registration_id UNIQUE, ...)` | A 1:1 extension with the same key, one more join and one more invariant (the row must be WITHDRAWN and LATE), and no new capability. Rejected |
| f3: billing derives from history | promotions joined to withdrawals by timestamps | No event log exists, `promoted_at`/`registered_at` are overwritten on re-registration, and same-millisecond ties are ambiguous. Fragile, and it puts registration semantics in billing. Rejected |

## Complexity Comparison

**Q1, promotion rule** (W = waitlisted parties, k = parties scanned until the budget is spent):

| Metric | 1A First-fit | 1B Block | 1C Bounded skip | 1D Best-fit |
|--------|----------|----------|----------|----------|
| Time (Best) | O(1) | O(1) | O(1) | O(W·free) |
| Time (Avg) | O(k), k ≈ 1–3 | O(k) | O(k) + skip writes | O(W·free) |
| Time (Worst) | O(W) | O(W) | O(W) + O(W) writes | O(W·free) |
| Space | O(1) extra | O(1) extra | O(1) + 1 column/row | O(W·free) |
| Persisted state | none | none | `times_skipped` | none |
| Implementation | Simple | Simple | Medium | Medium |

**Q3, liability semantics** (L = open liabilities in the session, R = withdrawn rows):

| Metric | 3A Decide once | 3B Release on resale | 3C Settle at end | 3D Proportional |
|--------|----------|----------|----------|----------|
| Time per step (Best/Avg/Worst) | O(1)/O(1)/O(1) | O(1)/O(1)/O(L) | O(1) during; O(R log R) at billing | O(1)/O(L)/O(L) |
| Space | 1 boolean | 1 boolean (+ ordered read) | 1 boolean | boolean + smallint |
| Double-charged seats / 100 sessions (sim, cap 10/20) | 35.4 / 42.2 | **0 / 0** | 0 / 0 | 0 / 0 |
| Charged seats / 100 sessions (sim, cap 10/20) | 51.2 / 49.1 | 13.0 / 6.1 | ≈ empty seats | ≈ empty seats |
| Billing changes needed | none | none | rule duplicated in billing | partial payments |
| Implementation | Simple | Simple+ | Medium (cross-feature) | Complex |

## Performance Projection

At the expected scale (100 registrations per session, at most about 20 waitlisted and a few open liabilities):

| Option | Expected Latency (decision only) | Memory Usage |
|--------|------------------|--------------|
| 1A + 3B (chosen) | < 0.05 ms (one pass over ≤ 100 small objects) | < 20 KB transient |
| 1B + 3A | < 0.05 ms | < 20 KB |
| 1C + 3A | < 0.05 ms + up to W extra UPDATEs (~0.3 ms each) | < 20 KB |
| 1D + 3D | < 0.5 ms | < 100 KB |

The transaction is dominated by SQL round trips, not the decision. The chosen path runs: gate read, debt count, `FOR UPDATE`, one read of the session's registrations (all non-withdrawn rows plus fee-due rows; one indexed query), then 1 to 4 guarded writes, plus an email enqueue per promotion. That is about 6–9 statements at about 0.5–1.5 ms each locally, so roughly 5–15 ms p50. The p95 budget of 300 ms leaves room for lock waits. The lock is held for the read, decide and write portion only (≈ 3–8 ms), which gives about 125–300 serialised operations per second per session. A 40-person publish rush therefore drains in well under 1 s.

## Decision

### Q1

**Chosen**: Option 1A, first-fit in queue order. The newcomer is the tail of the same scan, and a party is never split.

#### Rationale
- It is the only option that keeps seats from sitting empty while someone who fits is waiting. That is what makes workflows §2's fee transfer work: a late withdrawer is charged only when nobody on the waitlist could use the place. Under block, at capacity 20, twice as many late withdrawers were charged although someone was waiting (41.1 vs 20.6 per 100 sessions).
- It produces one invariant that is easy to test and to explain: **after every committed step, no WAITLISTED party fits the free seats.**
- It needs no new state (no skip counters) and no tuning knobs (the spec allows no new environment variables).
- Parties are only 1–3 people, so the size of a skip is bounded. A passed-over party of 3 is still first in line whenever 3 places free up together, or capacity is raised, and it can always withdraw and re-register smaller.

#### Rules (normative)
1. **Promotion.** After every withdrawal, ban withdrawal, capacity change (`promoteWaitlist`) and registration, run `firstFit` over WAITLISTED parties in ascending `queue_position` with `free = publicCapacity - seatsTaken`. Promote every party that fits, in order. Positions of the parties that stay are unchanged (D-14).
2. **Newcomer.** The newcomer is scanned after every waitlisted party. It is CONFIRMED iff it fits the seats left after those promotions, and is otherwise WAITLISTED at `max(queue_position) + 1`. While the invariant holds, this reduces to "CONFIRMED iff `partySize <= free`": by the invariant, no waitlisted party fits, so a newcomer that fits takes the seat, even ahead of a larger head. The register path still runs the full scan, so a state left inconsistent by a path outside this module (e.g. a capacity edit that forgot `promoteWaitlist`) heals itself before the newcomer is placed.
3. **Never split.** A party moves between statuses only as a whole registration. No partial confirmation exists.
4. **No demotion.** Lowering capacity never moves CONFIRMED to WAITLISTED (also a DB trigger rule, AC-VERIFY-2).
5. **After start.** No promotion happens at or after `starts_at`. `promoteWaitlist(trx, sessionId, now)` returns `{ promoted: [] }` when `status != 'PUBLISHED'` or `now >= starts_at`.
6. **D-14 refinement.** The migration comment says "promote = lowest queue_position". With first-fit this becomes "promote, in ascending queue_position, every party that fits". ADR 0016 records the refinement. The ledger entry D-14 is not changed; its locking and enqueue rules hold as written.

#### What the passed-over party sees (facts for the UI/UX and journey agents; they own the final copy)
- Their rank (`waitlistRank`, from position order) is unchanged by being passed over. It only improves as parties ahead leave or are promoted.
- Data the panel already has: `partySize` (`1 + guestCount`), `seatsLeft`, `waitlistRank`. When `seatsLeft > 0` while the caller is WAITLISTED, they were passed over for size, because the invariant guarantees `seatsLeft < partySize`.
- Facts to state: "Your group of {partySize} needs {partySize} places together. {seatsLeft} place(s) are free now. When places free up, they go to the first group in the queue that fits, so smaller groups behind you can get in first. You keep your place in the queue (#{rank}). Groups are never split. If you register with fewer guests, you'll lose your place in the queue." Never name or count the parties that got in (privacy NFR).
- No new API field is required. A derived boolean `me.waitlistedTooLargeForFreeSeats = status == 'WAITLISTED' && seatsLeft > 0` may be added by the UI agent for convenience.

#### Trade-offs Accepted
- **Starvation risk for parties of 3.** In the simulation, 17.6 (capacity 10) and 32.2 (capacity 20) per 100 sessions end with a size-3 party still waiting while a later registrant got in. That is acceptable: block's cost (4–8× more empty seats, more players charged although someone was waiting) falls on more people. Mitigations: the copy above; the party can split itself by re-registering; admins can raise capacity. Revisit if the reporting dashboard shows size-3 waitlist outcomes as a complaint driver (possible future: an opt-in "hold places for the head" per session).
- **Fairness is FIFO among parties that fit**, not FIFO absolute. The ADR and the copy say so.

### Q3

**Chosen**: Option 3B, provisional liability at withdrawal, released when the place is resold before start. Marker f1 (column on `registrations`). Billing hand-off unchanged.

#### Rationale
- It honours workflows §2 ("the fee is assigned to the new player") for every way a place gets retaken, not just a promotion in the same second. That removes 35–42 double-charged seats per 100 sessions (simulation) at the cost of one ordered read and one guarded update.
- It keeps the hand-off contract that billing already depends on in the spec: at session end, bill CONFIRMED rows plus WITHDRAWN rows with `withdrawal_fee_due = true`, one payment per registration for the whole party, with the registrant line at position 0.
- Whole-party liability is the only shape the `payments` and `payment_line_items` model can bill without arbitrary member selection.
- The invariant "open liable seats ≤ free seats" is provable and property-testable, so "never charge twice" becomes a tested property rather than a hope.

#### Sub-decisions
| # | Question | Decision |
|---|---|---|
| (a) | Partial refill: a late party of 3 frees 3 seats, only a party of 1 is promoted | **Not liable.** Any promotion in the withdrawal's own step releases the withdrawer (rounding in the player's favour). Under-collection is bounded: at most 2 seats per such event, about 2–3 seats per 100 sessions in the simulation. Billing never sees a partial liability |
| (b) | Later refill: a newcomer or a later promotion fills a liable withdrawer's seat before start | **Released** (Option 3B). Every step that confirms parties spends a seat budget equal to the seats confirmed, releasing open liabilities oldest-first (`withdrawn_at`, then `id`), each released whole while the budget is > 0. Releases are one-way (due → released) and stop at `starts_at` |
| (c) | Promotion after the deadline | **Promote anyway**, up to `starts_at` (workflows §2). The promoted party becomes CONFIRMED and is billed at session end; if it can't play, it withdraws LATE under the same rule (free if someone takes its place before start). No "stop N hours before start" (it would leave seats empty and charge withdrawers while people wait). Acceptance offers are out of scope (spec). Required facts: the promotion email and the waitlist-join confirmation must say that promotion is automatic and that the fee applies after the deadline unless someone takes the place (AC-ASYNC-1 already covers the email; the join copy goes to UI) |
| (d) | Registration after the deadline | **Allowed** until `starts_at`. A registration after the deadline that later withdraws is LATE by the clock. The panel warns before submit (AC-ERROR-2 copy) |
| (e) | After start | **Closed.** At `now >= starts_at`, register and withdraw are refused with `session_not_open`. The ban handler skips started sessions (ADR 0015). `promoteWaitlist` promotes nobody. Liabilities freeze. The open check runs **before** classification |
| (f) | Marker | **Column** `withdrawal_fee_due boolean NOT NULL DEFAULT false` on `registrations` (meaning "currently due"), with `withdrawal_kind` and `withdrawn_at`. Its DB rules are below |
| (g) | Re-registration of a fee-due withdrawal (new, found during this analysis) | **Allowed only into a CONFIRMED place for a party at least as large as the liable party.** Otherwise it is refused with 409 `late_withdrawal_fee_due`. Without this rule, a liable player can escape the fee in three clicks: re-register with a party too large to fit (waitlisted, flag reset), then leave the waitlist for free. A smaller re-registration would also drop guests' fees after the deadline. A re-registration that is CONFIRMED clears the flag (the row is CONFIRMED and billed), and that confirmation spends its seat budget on other open liabilities only after netting off the re-registrant's own prior party size (its own fee is cleared by taking that seat back; extra seats and simultaneous promotions still count) |
| (h) | Ban withdrawal, early withdrawal, leaving the waitlist | Never liable (`feeDue = false`). A ban step's promotions do release other open liabilities |
| (i) | Session CANCELLED | Out of scope (session-scheduling-engine). Recommended for the hand-off: `listBillableRegistrations` returns `[]` for a session whose status is not `PUBLISHED` or `COMPLETED`, so a cancelled game is never billed by mistake |

#### Trade-offs Accepted
- **The withdrawer's outcome is conditional until start.** The withdraw response and the panel state the condition ("…unless someone takes your place before the game"), and the panel always shows the current flag (`withdrawalFeeDue`). Nobody is emailed when a liability is released. The page shows it, consistent with "nobody is emailed about their own withdraw".
- **Rounding favours the player** (a), (b): a little revenue lost on mismatched party sizes (≈ 2–3 seats per 100 sessions) in exchange for a rule that never double-charges and never needs partial payments.
- **An admin capacity cut can leave a liability standing** for a seat that no longer exists. The admin chose fewer places, and the player did withdraw late. Uniform rule; ADR 0016 notes it for review with billing and admin features.
- **Order of release is oldest-first.** The first person to withdraw is the first released. An alternative (newest-first) has no principled basis. Oldest-first mirrors the queue.

## Implementation Details

### Data Structures
| Structure | Purpose | Operations Used |
|-----------|---------|-----------------|
| `queue: WaitlistEntry[]` sorted by `queuePosition` | First-fit scan; newcomer position | O(W) scan; O(1) last element for `max` |
| `confirmed: Map<id, partySize>` | Withdraw lookup; `seatsTaken = Σ` | O(1) lookup; O(C) sum once |
| `openLiabilities: Liability[]` ordered by `(withdrawn_at, id)` | Release on resale | O(L) prefix walk |
| `withdrawal_fee_due` column | The billing marker ("currently due") | Set true only on entry to WITHDRAWN; may only change true → false afterwards |

### `decideAllocation`: contract

```ts
// apps/api/src/modules/registrations/allocator.ts (pure; no I/O, no clock)
export type PartySize = 1 | 2 | 3;
export interface PartyRef { registrationId: string; partySize: PartySize }
export interface WaitlistEntry extends PartyRef { queuePosition: number }   // ≥ 1, unique
export type WithdrawalKind = 'EARLY' | 'LATE' | 'BANNED';

export type AllocationRequest =
  | { kind: 'register'; registrationId: string; partySize: PartySize;
      /** set iff the row being re-registered is WITHDRAWN with withdrawal_fee_due = true */
      liablePriorPartySize: PartySize | null }
  | { kind: 'withdraw'; registrationId: string; withdrawalKind: WithdrawalKind }
  | { kind: 'rebalance' };                    // promoteWaitlist after a capacity change

export interface AllocationInput {
  publicCapacity: number;                     // integer ≥ 0
  confirmedParties: readonly PartyRef[];
  waitlist: readonly WaitlistEntry[];         // any order; sorted inside
  openLiabilities: readonly PartyRef[];       // ORDER BY withdrawn_at, id (caller's order is kept)
  request: AllocationRequest;
}

export type AllocationDecision =
  | { outcome: 'refused';
      reason: 'already_registered' | 'not_registered' | 'party_exceeds_capacity' | 'late_withdrawal_fee_due' }
  | { outcome: 'applied';
      newcomer: null | { registrationId: string; status: 'CONFIRMED' }
                     | { registrationId: string; status: 'WAITLISTED'; queuePosition: number };
      withdrawn: null | { registrationId: string; fromStatus: 'CONFIRMED' | 'WAITLISTED';
                          kind: WithdrawalKind; feeDue: boolean };
      promotions: readonly (PartyRef & { fromQueuePosition: number })[];   // ascending position
      releasedLiabilities: readonly string[];                               // oldest first
      seatsTaken: number;
      seatsLeft: number;                                                    // max(0, cap - taken)
    };
```

The spec's signature `decideAllocation({ publicCapacity, confirmedParties, waitlist, request })` gains one field, `openLiabilities` (Spec Amendment A7).

**Pseudocode**
```
function decideAllocation({ publicCapacity, confirmedParties, waitlist, openLiabilities, request }):
    validate(...)                       // sizes 1..3, unique ids across lists, unique positions ≥ 1, cap ≥ 0 → else throw
    queue  = sortBy(waitlist, queuePosition)
    taken  = Σ p.partySize for p in confirmedParties
    maxPos = queue.isEmpty ? 0 : last(queue).queuePosition

    switch request.kind:
    case 'register':
        if request.registrationId ∈ confirmed ∪ queue: return refused('already_registered')
        if request.partySize > publicCapacity:        return refused('party_exceeds_capacity')
        tail     = { ...request, queuePosition: +∞ }
        promoted = firstFit(queue ++ [tail], publicCapacity - taken)
        newcomerConfirmed = tail ∈ promoted
        if request.liablePriorPartySize != null
           and (not newcomerConfirmed or request.partySize < request.liablePriorPartySize):
            return refused('late_withdrawal_fee_due')
        promotions = promoted − {tail}
        budget     = Σ size(promoted)                 // includes the newcomer when confirmed
        if newcomerConfirmed: budget = max(0, budget - (request.liablePriorPartySize ?? 0))  // own fee cleared by retaking its seat
        released   = release(openLiabilities, budget) // the re-registering row is not in openLiabilities (caller excludes it)
        newcomer   = newcomerConfirmed ? CONFIRMED : WAITLISTED at maxPos + 1
        taken     += budget

    case 'withdraw':
        if id ∈ confirmed:   from = CONFIRMED; taken -= size(id)
        elif id ∈ queue:     from = WAITLISTED; queue = queue − {id}
        else:                return refused('not_registered')
        promotions = firstFit(queue, publicCapacity - taken)
        S          = Σ size(promotions)
        liableKind = request.withdrawalKind == 'LATE' and from == CONFIRMED
        if liableKind and S == 0:  feeDue = true;  released = []
        elif liableKind:           feeDue = false; released = release(openLiabilities, S - size(id))
        else:                      feeDue = false; released = release(openLiabilities, S)
        taken += S

    case 'rebalance':
        promotions = firstFit(queue, publicCapacity - taken)
        S          = Σ size(promotions)
        released   = release(openLiabilities, S)
        taken     += S

    return applied({ newcomer, withdrawn: {id, from, kind, feeDue}, promotions, releasedLiabilities: released,
                     seatsTaken: taken, seatsLeft: max(0, publicCapacity - taken) })

function release(liabilities, budget):
    out = []
    for l in liabilities:                 // oldest first
        if budget <= 0: break
        out.push(l.registrationId); budget -= l.partySize
    return out
```

**Cases, by caller**
| Caller | Request | Notes |
|---|---|---|
| `POST .../registrations` | `register` | `liablePriorPartySize = row?.status == 'WITHDRAWN' && row.withdrawal_fee_due ? 1 + row.guest_count : null`. The caller excludes that row from `openLiabilities` |
| auto-enrol (skill-levels-and-auto-enroll) via `registerInSession` | `register` | Same function. Debt policy for auto-enrol is the architecture/Q6 owner's call |
| `POST .../registrations/me/withdraw` | `withdraw` with `classifyWithdrawal(now, session)` | EARLY or LATE |
| ban handler (ADR 0015) | `withdraw` with `withdrawalKind: 'BANNED'` | Always `feeDue = false`. Promotions still release older liabilities |
| `promoteWaitlist(trx, sessionId, now)` (capacity edits) | `rebalance` | Returns no promotions if the session is not open (Rule 5) |

### Time: early/late classification from a single `now`

```ts
// apps/api/src/modules/registrations/deadline.ts (pure)
export function isRegistrationOpen(now: Date, s: { status: SessionStatus; startsAt: Date | null }): boolean {
  return s.status === 'PUBLISHED' && s.startsAt !== null && now.getTime() < s.startsAt.getTime();
}
export function classifyWithdrawal(now: Date, s: { cancellationDeadline: Date }): 'EARLY' | 'LATE' {
  return now.getTime() <= s.cancellationDeadline.getTime() ? 'EARLY' : 'LATE';   // workflows §2: NOW <= deadline is free
}
```
- **One `now` per operation.** It is read once with `clock.now()` at the start of the operation (before the gate) and used for the open check, the classification, `withdrawn_at`, `promoted_at`, `registered_at`, `updated_at` and the email idempotency key. SQL never calls `now()` for these values; they are bound parameters (AC-VERIFY-3). Assumption for the architecture agent: reading before the lock means a request that waited on the lock across the deadline is judged by its arrival time. That is user-favourable by at most the lock wait.
- **Order.** `isRegistrationOpen` first (refusal `session_not_open`), then `classifyWithdrawal`. With `deadline == starts_at`, every allowed withdrawal is EARLY.
- **Precision is exact.** `now` is an integer number of milliseconds. `pg` parses `timestamptz` to a `Date` by truncating sub-millisecond digits, giving `floor_ms(deadline)`. For an integer `n`: `n <= floor_ms(d) ⇔ n <= d`. So the comparison is exact even if a deadline has microseconds. Boundary tests use `deadline - 1 ms`, `deadline`, `deadline + 1 ms` (AC-VERIFY-5).
- **Zones.** Comparisons are on UTC instants only. Pacific/Auckland appears only when formatting (`formatNzDateTime`). DST sessions need no special case, because the deadline is an instant.

### Algorithm Steps (one operation, inside the transaction the architecture agent defines)
1. `now = clock.now()` once. Gate (`assertApprovedMember`) and the debt read for register: architecture's ordering, AC-VERIFY-3.
2. Lock the session (`FOR UPDATE`) and check `isRegistrationOpen(now, session)`. If it fails, refuse `session_not_open`; the ban handler skips the session instead.
3. Read the session's registrations in one query: CONFIRMED and WAITLISTED rows (`id, user_id, status, guest_count, queue_position`) and fee-due WITHDRAWN rows ordered by `(withdrawn_at, id)`. Read the caller's own row, if any, from the same result.
4. Build the request. Withdrawals are classified with `classifyWithdrawal`.
5. Call `decideAllocation`. On `refused`, map it to the error and log `registration.refused`.
6. Apply the writes in this order. Each write is guarded by the expected current state, and a row count other than expected throws, which rolls back (P1):
   1. the withdrawn row: `status = 'WITHDRAWN', queue_position = NULL, withdrawn_at = now, withdrawal_kind, withdrawal_fee_due = feeDue … WHERE id = $1 AND status = $from`;
   2. the promotions: `status = 'CONFIRMED', queue_position = NULL, promoted_at = now WHERE id = ANY($ids) AND status = 'WAITLISTED'` (expect n rows);
   3. the newcomer: INSERT, or the re-registration UPDATE with guest replacement (architecture owns the details); `queue_position` comes from the decision;
   4. the released liabilities: `withdrawal_fee_due = false WHERE id = ANY($ids) AND status = 'WITHDRAWN' AND withdrawal_fee_due` (expect n rows).
7. Enqueue one promotion email per promoted registrant in the same transaction (AC-ASYNC-1). Emit the log events with counts (`promotedCount`, `liabilitiesReleased`).

### Edge Case Handling
| Edge Case | Handling |
|-----------|----------|
| Head larger than free seats | Skipped by `firstFit`; keeps its position; first in line on the next scan |
| Newcomer fits while the waitlist is non-empty | CONFIRMED (no waitlisted party fits, by the invariant) |
| `partySize > publicCapacity` | `refused('party_exceeds_capacity')` → 422 |
| Waitlisted party larger than a newly cut capacity | Stays WAITLISTED, skipped, not billed; may leave |
| Over capacity after a cut | `free ≤ 0`: no promotion or confirmation; a late withdrawal is liable and released only if a later step confirms seats |
| Leaving the waitlist | `feeDue = false`; promotions normally empty |
| Late withdrawal, party of 3, a single promoted | `feeDue = false` (a) |
| Two late single withdrawals, a party of 2 waiting (AC-INTEGRATION-1c) | First: liable (nothing fits). Second: the party of 2 is promoted (S = 2), the withdrawer is released, and budget 1 releases the first. End state: neither liable, the party of 2 confirmed once |
| Re-registration of a fee-due row into the waitlist or with a smaller party | `refused('late_withdrawal_fee_due')` → 409 |
| `promoteWaitlist` after start or on a non-PUBLISHED session | No-op `{ promoted: [] }` |
| Duplicate ids or positions in the input | Throw (programming error); the DB would also refuse |

### Error Handling
| Error Condition | Response |
|-----------------|----------|
| `refused.already_registered` | 409 `already_registered` |
| `refused.not_registered` | 409 `not_registered` |
| `refused.party_exceeds_capacity` | 422 `party_exceeds_capacity` |
| `refused.late_withdrawal_fee_due` (new) | 409 `late_withdrawal_fee_due`. Safe message (UI owns copy): "You withdrew after the free cancellation deadline and the fee applies, so you can only rejoin if a place is free for a group at least as large as before." |
| Invalid input to `decideAllocation` | Throw `Error`. Transaction rollback; 500 on HTTP; transient-classified in the ban handler unless the architecture agent classifies it as permanent |
| Guarded write row count mismatch | Throw. Rollback (another path broke the lock contract; the DB backstops catch the rest) |

## Performance Expectations

### At Current Scale
- Expected latency: decision < 0.05 ms; whole transaction about 5–15 ms p50 locally, well under 300 ms p95.
- Memory usage: < 20 KB per call.
- Throughput: about 125–300 operations per second per session (lock-bound), unbounded across sessions.

### At 10x Scale
- 1,000 registrations in one session (beyond any court booking): decision < 0.5 ms; the single read returns about 1,000 rows (~100 KB), about 10–20 ms. Still within p95.
- Memory usage: < 200 KB per call.
- Bottlenecks: the per-session lock serialises the rush. That is the D-14 design, not the algorithm. If ever needed, read only `SUM(1 + guest_count)` for CONFIRMED plus the WAITLISTED prefix up to the first ~10 rows, instead of all rows.

### Optimization Opportunities
- A partial index `registrations (session_id, withdrawn_at, id) WHERE withdrawal_fee_due` for the liability read (the architecture agent decides indexes; the table is small per session).
- Early exit in `firstFit` once `free == 0` (already in the pseudocode).

## Validation Checklist

- [x] Meets latency requirements (the decision costs microseconds; the transaction is SQL-bound and far under 300 ms p95)
- [x] Meets memory requirements (O(registrations per session), KB)
- [x] Handles all edge cases (table above, including capacity cuts, the deadline boundary, re-registration escape)
- [x] Scales to expected data size (100 per session; 10x is fine)
- [x] Implementation feasible (pure TS function + guarded UPDATEs; no new dependency; no new environment variable)
- [x] Respects the Guiding Principles and data flow patterns in systemPatterns.md (P1 DB backstops for transitions, capacity and liability flips; P2 no money persisted, estimates as `Money`; P3 one UTC `now`; P5 emails enqueued in the promoting transaction; lock order per ADR 0015)

## Testing Strategy

### Unit Tests (`allocator.test.ts`, `deadline.test.ts`; table-driven)
- **The matrix.** Party size 1–3 × free seats 0–3 × waitlist shapes (empty; head fits; head too big with a fitting party behind; all too big) × request (register / withdraw CONFIRMED / withdraw WAITLISTED / rebalance) × kind (EARLY / LATE / BANNED) × open liabilities (none; one of each size; several). These rows are re-run as integration fixtures (plan's anti-drift rule).
- **Fixed cases.** AC-HAPPY-3/4/5/6/7/9; AC-INTEGRATION-1c's two-step case; a party of 3 refilled by a single; a newcomer of 3 releasing three single liabilities; a newcomer of 1 releasing a liability of 3 (rounding); refusals for the re-registration rule; healing on register (an inconsistent input with a fitting waitlisted party).
- **Deadline.** `deadline - 1 ms` → EARLY; `deadline` → EARLY; `deadline + 1 ms` → LATE; `deadline == starts_at`; DST sessions (2026-09-27, 2027-04-04); open check at `starts_at - 1 ms` and `starts_at`.

### Property test (AC-VERIFY-4), `allocator.property.test.ts`
No new dependency: a seeded PRNG (mulberry32), 2,000 sequences × up to 60 steps. The seed is printed on failure and can be re-run via `ALLOCATOR_PROPERTY_SEED` read in the test only (not application config). The generator draws:
- capacity 0–12;
- registers (size 1–3, re-registrations of withdrawn rows included);
- withdrawals of random active rows with a random kind;
- capacity raises and cuts followed by `rebalance`.

The model state is advanced only through `decideAllocation`. After every applied step, assert:
- **I1 Capacity.** If `seatsTaken ≤ cap` before the step, then `seatsTaken ≤ cap` after it. No step ever increases `seatsTaken` above `max(cap, seatsTaken_before)`.
- **I2 Seat accounting.** `seatsTaken = Σ partySize` over CONFIRMED, recomputed from the model state.
- **I3 Never split.** Every party appears in exactly one of CONFIRMED, WAITLISTED or WITHDRAWN. `promotions` and `newcomer` move whole parties only.
- **I4 Queue.** WAITLISTED positions are unique and ≥ 1. The positions of WAITLISTED parties that remain are unchanged. A newcomer's position is greater than every existing position, so position order equals enqueue order among current WAITLISTED rows.
- **I5 First-fit maximality.** After every applied step, no WAITLISTED party has `partySize ≤ cap - seatsTaken`.
- **I6 FIFO among fits.** Promotions are in ascending `fromQueuePosition`. For every party that stayed waitlisted and was ahead of a promoted party, its size exceeded the remaining budget at its turn (checked against a reference implementation).
- **I7 No demotion.** No CONFIRMED party becomes WAITLISTED. CONFIRMED leaves only through `withdraw`.
- **I8 Newcomer rule.** The newcomer is CONFIRMED iff it fits after all waitlisted fits.
- **I9 Liability creation.** `feeDue ⇔ kind == LATE ∧ from == CONFIRMED ∧ promotions = ∅`. EARLY, BANNED and WAITLISTED withdrawals are never fee-due.
- **I10 Liability monotonicity.** A fee-due row is only ever released (true → false). Nothing becomes fee-due except the withdrawn row of the current step.
- **I11 Never charge twice.** In sequences with no capacity cut since the oldest open liability: `Σ partySize(open liabilities) ≤ cap - seatsTaken`.
- **I12 Refusal is inert.** A `refused` decision leaves the model state unchanged.
- **I13 Determinism.** The same input gives the same output, and `rebalance` on a state satisfying I5 is a no-op.

### Integration Tests
- `registrations-allocator.int.test.ts`: the matrix rows against real rows. After each step, SQL recomputes `seatsTaken`, positions, I5 and I11 directly from `registrations` (AC-VERIFY-4's "match a direct SQL count").
- `registrations-billing-handoff.int.test.ts`: AC-INTEGRATION-3 plus a released liability (excluded) and a still-due liability (included).

### Performance Tests
- Benchmark `decideAllocation` at 100 and 1,000 registrations (unit, assertion-free timing log only; wall-clock budgets stay load-tolerant).
- AC-INTEGRATION-1a (20-way) and 1b (10 withdrawals racing 5 registrations) with `waitForLockWaiters`; assert the invariants afterwards, not timings.

## ADR 0016 Draft Content (for build Phase 2 to write as `docs/adr/0016-registration-allocation-and-billing-handoff.md`)

> **ADR 0016: Registration allocation, waitlist promotion and the billing hand-off**
>
> - Status: Proposed (accepted when Phase 2 merges)
> - Task: registration-and-waitlist
> - Source: [Algorithm Q1, Q3](../../memory-bank/creative/registration-and-waitlist-allocation-algorithm.md); architecture creative doc for locking (Q2) and the ban handler (Q4)
>
> **Context.** Parties of 1–3 share a session's public capacity (`max_players - reserved_seats`) and are confirmed or waitlisted whole. Workflows §2 makes a late withdrawer free when someone takes their place and liable otherwise. Payments can be created only by wallet-and-akahu-billing at session end (Akahu link, GST snapshot, line items with a registrant line; ADR 0012), so registration must record liability without writing money rows.
>
> **Decision.**
> 1. *One pure decision.* Every seat change (register, withdraw, ban withdrawal, capacity change, auto-enrol) calls `decideAllocation` under the D-14 session lock and applies its result with guarded writes.
> 2. *First-fit promotion.* When seats are free, WAITLISTED parties are scanned in ascending `queue_position` and every party that fits is promoted, in order. A party that doesn't fit keeps its position and is offered seats first next time. A newcomer is scanned after the whole waitlist. Parties are never split, and nobody is demoted. Invariant: after every step, no WAITLISTED party fits the free seats. This refines D-14's "promote the lowest position" to "promote, lowest position first, every party that fits".
> 3. *Time.* One `now` per operation. Open while `status = 'PUBLISHED' AND now < starts_at`. A withdrawal is EARLY iff `now <= cancellation_deadline` (inclusive), LATE otherwise. Bans are BANNED. Nothing is promoted at or after `starts_at`.
> 4. *Liability.* A LATE withdrawal of a CONFIRMED party is fee-due iff its own step promoted nobody. A fee-due withdrawal is released, whole and oldest-first, when a later step before `starts_at` confirms seats: the budget is the seats confirmed, each release is whole while the budget is > 0, and the current withdrawer is first in its own step. Releases are one-way. EARLY, BANNED and waitlist withdrawals are never fee-due. A promoted party takes the fee by being CONFIRMED.
> 5. *Marker.* `registrations.withdrawal_fee_due boolean NOT NULL DEFAULT false`, with `withdrawal_kind` (EARLY, LATE, BANNED) and `withdrawn_at`. The DB allows it to become true only in the UPDATE that enters WITHDRAWN with kind LATE, and afterwards only true → false.
> 6. *Re-registration.* A fee-due withdrawal may re-register only into a CONFIRMED place with a party at least as large; otherwise 409 `late_withdrawal_fee_due`.
> 7. *Hand-off contract (binding for wallet-and-akahu-billing).* At session end, billing bills exactly `listBillableRegistrations(db, sessionId)`: every CONFIRMED registration (`reason: CONFIRMED`) and every WITHDRAWN registration with `withdrawal_fee_due = true` (`reason: LATE_WITHDRAWAL`), each as one payment for the whole party (registrant line at position 0 plus a line per guest row). Fees are computed at charge time from the session's fee columns, `users.sex`, `team_members.skill_level` and `registration_guests`. The flag is final once `starts_at` has passed. The list is empty for a session that is not PUBLISHED or COMPLETED. Registration never deletes registrations or guest rows. Billing alone writes `payments` and the `OVERDUE` status.
>
> **Alternatives considered.** Block (strict head-of-line): 4–8× more empty seats while parties wait in simulation, and late withdrawers charged although someone was waiting. Bounded skip: block's costs, persisted counters and arbitrary knobs. Best-fit packing: breaks FIFO among parties that fit. Liability decided once at withdrawal: in simulation, 69–86% of liable seats were resold before start and so charged twice. Settlement at session end inside billing: duplicates the rule across features and can't express partial coverage. Proportional (per-seat) liability: arbitrary guest selection and partial payments for about 2–3 seats per 100 sessions. Liability table or derivation from history: no gain over a column (one payment per registration), or fragile.
>
> **Consequences.**
> - A party of 3 can be passed over by smaller parties (by design; explained on the panel).
> - A late withdrawer's outcome is provisional until start; the panel shows the current state.
> - Rounding favours players on mismatched party sizes.
> - An admin capacity cut can leave a liability for a seat that no longer exists; revisit with admin reporting.
> - Billing must not bill a session before `starts_at` and must treat `withdrawal_fee_due` as read-only.

## Assumptions Deferred to Other Agents
- **Architecture (Q2, Q4)**: transaction shape, lock order, the capacity backstop, the lock timeout and retry policy, the debt-read placement, the ban handler's per-session loop, and the guest replacement on re-registration. This doc assumes `now` is read once at operation start and that all guarded writes run after the decision inside the locked transaction.
- **UI/UX and journey (Q5)**: all copy. This doc lists the facts each message must state: the passed-over party, a provisional liability, promotion binding after the deadline, and the `late_withdrawal_fee_due` refusal.
- **Q6**: auto-enrol's debt policy, and confirmation that `fee_flat` is the final FLAT rate (affects only fee estimates, not the allocation).

## Next Steps
1. The reconciliation step (orchestrator) adopts the Spec Amendments below and resolves overlaps with the architecture doc (indexes, backstop, transition trigger).
2. Phase 1: migration columns plus the liability flip rule in the transition trigger (A5); `withdrawal_kind` enum; error code `late_withdrawal_fee_due` (A8).
3. Phase 2: `allocator.ts` (`decideAllocation`, `firstFit`, `release`), `deadline.ts`, `promoteWaitlist`, `registerInSession`, `listBillableRegistrations`; the unit matrix and property test; write ADR 0016 from the draft above.
4. Phase 3: map refusals to HTTP; log `liabilitiesReleased`; provisional-liability copy in the withdraw response.

## Spec Amendments

| # | AC / section | Change |
|---|---|---|
| A1 | **AC-HAPPY-9** | Creative chose **first-fit**: delete the closing "If creative chooses the block rule…" sentence. Add: "A newcomer is considered after every waitlisted party: with 1 seat free and only a party of 3 waiting, a newcomer of 1 is CONFIRMED and the party of 3 stays #1." Add: "A WAITLISTED party larger than the public capacity after a capacity cut stays queued and is skipped." |
| A2 | **AC-HAPPY-3** | Given: the two existing WAITLISTED parties are of size 2 or more (with 1 seat free, a waitlisted party of 1 would violate the AC-VERIFY-4 invariant). |
| A3 | **AC-HAPPY-6** | Given: "only waitlisted parties larger than the free seats after P withdraws". Then: P's `withdrawal_fee_due true` is **provisional until `starts_at`**. The message must state that P won't be charged if someone takes the place before the game (UI owns the wording; e.g. "No one could take your place yet. If someone does before the game you won't be charged; otherwise the $51.00 fee will be charged after the game."). |
| A4 | **New AC-HAPPY-6b (MUST)**: a fee-due withdrawal is released when its place is resold | Given a fee-due LATE withdrawal P (party 1) before `starts_at`. When a newcomer is CONFIRMED, or a party is promoted by any cause, in the same session. Then P's `withdrawal_fee_due` becomes false in that transaction and `listBillableRegistrations` excludes P. With several fee-due withdrawals, the oldest (`withdrawn_at`, `id`) is released first. A step confirming n seats releases whole liabilities while its remaining seat budget is > 0. Nothing is released at or after `starts_at`, and a released row never becomes fee-due again. The panel then shows "you won't be charged". No email. |
| A5 | **AC-VERIFY-2** | Add DB rules (transition trigger): `withdrawal_fee_due` may be true only on a WITHDRAWN row with `withdrawal_kind = 'LATE'` (as written). It can become true only in the UPDATE that moves the row into WITHDRAWN. On a row that stays WITHDRAWN it may change only true → false (23000 otherwise). |
| A6 | **AC-HAPPY-8** | A row with `withdrawal_fee_due = true` may re-register only if the new party is at least as large and is CONFIRMED immediately; otherwise 409 `late_withdrawal_fee_due`, nothing changes, and the fee stays due. EARLY rows and LATE rows that are not fee-due (replaced or released) re-register as written. Banned members are refused earlier by the gate. |
| A7 | **AC-VERIFY-4** | Signature becomes `decideAllocation({ publicCapacity, confirmedParties, waitlist, openLiabilities, request })` with `request` ∈ `register` / `withdraw` (with `withdrawalKind`) / `rebalance`. Replace the invariant bullets with I1–I13 of this doc. Key points: no WAITLISTED party fits; positions of remaining WAITLISTED rows are never changed and a newcomer's position exceeds all existing ones; no demotion; `feeDue` rule; liabilities only release; open liable seats ≤ free seats when no capacity cut occurred. Property test: a seeded PRNG, no new dependency. |
| A8 | **AC-VERIFY-7, AC-VERIFY-6** | Add error code `late_withdrawal_fee_due` (409) to `errors.ts`/`ERROR_DEFAULTS`, and to the `registration.refused` reasons. Add a `liabilitiesReleased` count to `registration.created`, `registration.withdrawn` and `registration.promoted`. |
| A9 | **AC-VERIFY-5** and Phase 2 test guidance | Boundary granularity is 1 ms (the `Clock` is ms; the floor-to-ms comparison is exact): replace "one microsecond after" with "1 ms after". Add: the open check (`now < starts_at`) runs before classification; with `cancellation_deadline == starts_at` every allowed withdrawal is EARLY. |
| A10 | **AC-INTEGRATION-1(c)** | Add the expected liability outcome for a run after the deadline: the first withdrawer is fee-due at its commit, and is released by the second withdrawal's step (the party of 2 promoted, budget 2 - 1 = 1). At the end neither withdrawer is fee-due. |
| A11 | **AC-INTEGRATION-3** | Add rows: a LATE withdrawal whose liability was released by a later newcomer (excluded), and a still-due one (included). Add: for a session that is not PUBLISHED or COMPLETED (e.g. CANCELLED), the list is empty. |
| A12 | **AC-HAPPY-9 / AC-VERIFY-3** (`promoteWaitlist`) | `promoteWaitlist(trx, sessionId, now)` promotes nobody when the session is not PUBLISHED or `now >= starts_at`. Its promotions release open liabilities like any other step. |
| A13 | **Billing boundary paragraph** | Rewrite (b) as: "every WITHDRAWN registration with `withdrawal_fee_due = true` at session end (the flag can only be released before `starts_at`, and is final after it)". Add: "`listBillableRegistrations` returns `[]` for a session that is not PUBLISHED or COMPLETED." |
| A14 | **Copy facts** (AC-HAPPY-5 prompt, AC-ERROR-2 after-deadline line, AC-HAPPY-3 waitlist message; UI agent owns wording) | The late-withdraw prompt says "if someone takes your place before the game" (not only "a waitlisted player"). After the deadline, the waitlist-join and register messages say promotion is automatic and the fee applies once promoted. A WAITLISTED caller with `seatsLeft > 0` sees the passed-over facts (Decision Q1). |
| A15 | **Creative Exploration Q3 / Specification "Data persisted"** | `withdrawal_fee_due` means "currently due" (true only for LATE with nobody promoted at withdrawal, or later released to false). The Q3 assumption "(b) later refill: the withdrawer is still charged" is reversed. |
