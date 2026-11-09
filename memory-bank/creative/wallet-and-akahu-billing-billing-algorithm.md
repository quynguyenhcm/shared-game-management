# Algorithm Decision: Wallet Top-Up Intents, Akahu Result Application and Post-Game Billing

**Created**: 2026-10-31
**Status**: DECIDED
**Decision Type**: Algorithm
**Task**: wallet-and-akahu-billing (Level 4)
**Creative questions owned**: Q3 (top-up intent, the $100.00 cap, duplicates per B3), Q6 (post-game edge cases per B8/B9, departed members, long worker outage), plus the A2 hold state (Plan Amendment 2026-10-31), the A8 `team_banking_in_use` question, `daily-overdue`, the B6 reminder cooldown and `akahu-reconcile`.
**Binding inputs**: rulings B1-B10 at their defaults (approved 2026-10-30); Plan Amendment A1-A8 (2026-10-31); spike `akahu-payment-capability` DR-001 to DR-005 with OV-1 to OV-3.
**Sources read**: task file (spec, 46 ACs, Architectural Plan, Plan Amendment); spike artifact and handoff; `db/migrations/20260929000800000_wallet.sql`, `...000900000_payments_and_invoicing.sql`, `20261016000100000_team_banking_and_gst_invariants.sql` (`team_banking_in_use`, `game_session_is_paid`, `is_payout_configured`), `20261020000100000_session_scheduling.sql` (D-75); `apps/api/src/modules/registrations/billing-handoff.ts`, `registrations/repo.ts` (`countOverdueByUser`); `packages/shared/src/registrations/fees.ts`, `packages/shared/src/money/money.ts`; `apps/api/src/modules/sessions/locks.ts`; `apps/api/src/jobs/{registry,schedules,bootstrap,recurrence-materialisation,send-email}.ts`, `lib/jobs/jobs.ts` (`EnqueueOptions`); ADR 0016 (C-BIL-PAY, R3), ADR 0018 (C-BIL-1..3, C-ALL-1), ADR 0019 (D-75); `memory-bank/productBrief.md`, `memory-bank/systemPatterns.md` (P1-P7).

## Problem Statement

The feature moves real money in three directions, and each needs a deterministic, idempotent algorithm that the database can backstop (P1):

1. **Top-ups (Q3).** A player pays Akahu to put credit in a per-(player, team) wallet whose balance is capped at $100.00 (B1). The payment is asynchronous: Akahu creates a one-off payment, the player authorises it on a hosted page, and the outcome arrives later as an unordered, id-less webhook or through polling (DR-003). The algorithm must keep the cap under concurrent starts, abandoned intents, late or duplicate successes, and a terminal status where money may or may not have moved (`FAILED/BANK_ERROR_INDETERMINATE`, A2).
2. **Pay-by-link attempts.** A PENDING or OVERDUE payment is paid through the same Akahu flow. At most one payment is ever PAID once, a second success is recorded for refund (B3), and an indeterminate result holds the payment (A2).
3. **Post-game billing (Q6).** At `ends_at`, each ended PUBLISHED session is completed and every registration returned by `listBillableRegistrations` is charged once: deducted in full from the wallet when it covers the fee, otherwise left PENDING with a due date (B2). The algorithm must handle a team that cannot take payments (B8), a deploy-time backlog (B9), $0.00 parties (B7), departed members, a multi-day worker outage and at-least-once job delivery. A daily job then marks unpaid charges OVERDUE, and admins can send rate-limited reminders (B6).

All three paths share one rule: **never call Akahu while holding a database lock** (Architectural Principle 3, P5). Every Akahu interaction is therefore split into a short "intent" transaction, an external call, and a second short "apply" transaction.

## Inputs & Outputs

### Inputs
| Name | Type | Size/Range | Source |
|------|------|------------|--------|
| Wallet balance | `Money` | 0.00-100.00 (DB CHECK) | `player_credits.balance` (absent row = 0.00) |
| Top-up amount | `MoneyString` -> `Money` | 1.00 (B1 minimum) to headroom | `POST /teams/:teamId/wallet/top-ups` |
| Idempotency key | uuid | one per click | top-up and attempt request bodies |
| Akahu snapshot | `{ id, status, statusReason?, amount, terminalAt? }` | statuses READY, AUTHORISED, SUBMITTED (PENDING, SETTLEMENT_IN_PROGRESS), SENT, CANCELLED/*, FAILED/* | `GET /v1/one-off-payments/{id}` (truth); webhook is only a signal (DR-003) |
| Billable registrations | `BillableRegistration[]` | 0..~40 per session (party 1-3) | `listBillableRegistrations(trx, sessionId, now)` |
| Session fee columns | `SessionFeeColumns` | per pricing structure | `game_sessions.fee_*`, `pricing_structure` |
| Team payout and GST state | `is_payout_configured`, `gst_registered`, `gst_number`, encrypted payee | one row | `teams` (read under `FOR KEY SHARE`) |
| `now` | `Date` (UTC, ms) | read once per transaction, after its locks (P3) | injected `Clock` |
| Payment rows | `payments` | PENDING / OVERDUE / PAID | billing tables |
| Config | durations, batch sizes | see "Configuration" | environment (P7) |

### Outputs
| Name | Type | Description |
|------|------|-------------|
| Top-up intent | `wallet_top_ups` row | one per start; at most one non-terminal per wallet |
| Payment attempt | `payment_attempts` row | one per pay click; at most one non-terminal per payment |
| Ledger movement | `credit_transactions` (`TOPUP`, `AUTO_DEDUCTION`) | signed amount and `resulting_balance` equal to the wallet's new balance |
| Payment | `payments` + `payment_line_items` | one per billable registration, `PREPAID_CREDIT/PAID` or `PER_GAME/PENDING` (or `PER_GAME/PAID` at $0.00) |
| Session completion | `game_sessions.status = COMPLETED` | written only by `bill-session` |
| Status changes | `payments.status` PENDING -> OVERDUE (daily job) / -> PAID (apply) | guarded transitions |
| Emails | `send-email` jobs | enqueued in the triggering transaction with a cause-derived key |
| Ops signals | `HELD` / `UNAPPLIED` intents, `akahu.*` warn logs, CLI listing | see "Ops surface" |

### Edge Cases
1. **Two top-ups started at once (two tabs)** - one wins the one-open slot; the other gets 409 `top_up_in_progress` with the open one (AC-ERROR-2).
2. **Top-up over headroom, below $1.00, malformed** - 422 before anything is committed; Akahu is never called (AC-ERROR-1).
3. **Abandoned top-up** - Akahu times the link out (`expires_at`); reconcile or the next start reads CANCELLED/TIMED_OUT and closes it; the form returns (AC-ERROR-3).
4. **Completion for a locally closed intent** - routed through the B3 absorb rule (A8): credited or paid if it still fits, otherwise recorded `UNAPPLIED` and notified.
5. **Over-cap credit** - impossible under the invariants below unless Akahu contradicts itself; recorded `UNAPPLIED (OVER_CAP)`, nothing credited, player and admins notified (B3).
6. **Second success for a PAID payment** - recorded `UNAPPLIED (DUPLICATE)`, payment stays PAID once, no wallet credit (AC-ERROR-10, B3).
7. **`FAILED/BANK_ERROR_INDETERMINATE`** - intent `HELD`: payment not payable, no new attempt, top-up slot stays occupied, ops flag (A2).
8. **SENT with a different amount** - intent `HELD (AMOUNT_MISMATCH)`; nothing is credited or marked PAID until ops resolves (A2 amount re-check).
9. **Unknown Akahu status** - intent left OPEN, `akahu.status.unknown` logged (A2).
10. **Ambiguous create (timeout, 5xx, network)** - intent closed, 503 to the player; the player never received a URL, so any orphan Akahu payment cannot be authorised and times out (DR-005, first-principles note).
11. **Team payout blocked at billing time (B8)** - paid session held PUBLISHED, nothing written except a once-per-session notice marker and admin emails; billed on the first sweep after the account is fixed.
12. **Deploy-time backlog (B9)** - every ended PUBLISHED session is billed, oldest `ends_at` first, with emails.
13. **$0.00 party on a paid session (B7)** - PAID $0.00 `PER_GAME` row, no link, no email, wallet untouched.
14. **Member who left, or whose wallet is in a team they no longer belong to** - billed exactly as the hand-off says; their wallet in that team is still used; they pay links through the payer-only `/payments/:id`, which never checks membership.
15. **Worker down for days** - sessions billed at the actual billing instant (due date = that instant + 72 h, B2); boot sweeps enqueue billing, overdue and reconcile immediately.
16. **Replayed or concurrent `bill-session`** - second run finds COMPLETED (or waits on the session lock, then finds COMPLETED) and does nothing.
17. **Empty inputs** - a session with no billable registrations, or a free session, is completed with no payments and no emails (AC-HAPPY-11); a sweep with nothing due enqueues nothing; reconcile with nothing open does nothing.

## Constraints

### Performance Requirements
- **`bill-session`**: under 2 s for 30 registrations (spec NFR); target under 300 ms.
- **Billing latency**: COMPLETED and billed within 10 minutes of `ends_at` while the worker runs (5-minute sweep + job latency).
- **Missed webhook**: reconciled within one `akahu-reconcile` interval plus its age threshold (15 + 5 = 20 minutes by default).
- **Wallet and payment reads**: p95 under 300 ms (index-backed single-row reads; not algorithmic).
- **Memory budget**: trivial (per-session working set is O(registrations)).

### Scale Requirements
- **Current data size**: small community product (productBrief gives no volumes). Working assumption: tens of teams, up to ~40 billable parties per session, a few hundred sessions a week, a few dozen open Akahu intents at any time.
- **Expected growth**: 10x (hundreds of teams) without algorithm changes; every per-run cost is bounded by a batch size.
- **Peak load**: a session boundary where several sessions of one team end at the same minute (shared players), a deploy-time backlog of up to ~1,000 sessions, 10 concurrent top-up starts on one wallet (AC-INTEGRATION-3).

### Other Constraints
- **P1**: transitions, the cap, the ledger and once-only keys are DB-enforced; TypeScript decides, SQL refuses.
- **P2**: `Money` only; the deduction decision is `gte(balance, total)`; no partial deductions.
- **P3**: one `now` per transaction, read after its locks; due dates and cooldowns are exact UTC instants.
- **P5**: every email and follow-up job enqueued inside the transaction that caused it; no Akahu call under a lock.
- **C-BIL-1..3, C-ALL-1** (ADR 0018), **C-BIL-PAY and R3** (ADR 0016), **D-75** (ADR 0019).
- **At-least-once delivery** (ADR 0004): `singletonKey` only suppresses concurrent duplicates, and `send-email`'s `notify:<key>` suppression ends when the job completes, so every "exactly one email" needs a durable once-only cause.

## Options Explored

The work splits into four decisions. Each has its own options; the chosen ones are combined in "Implementation Details".

---

### Decision D1: Top-up intent model and the cap (Q3)

#### Option D1-A: One non-terminal intent per wallet, headroom checked at start (spec default)
- **Approach**: `wallet_top_ups` holds one row per start. A partial unique index admits at most one row per `(user_id, team_id)` in a non-terminal state (`CREATING`, `OPEN`, `HELD`). The start transaction claims that slot first, then reads the balance (`FOR SHARE`, fresh snapshot) and requires `amount <= 100.00 - balance`. Deductions only lower the balance, so the headroom can only grow while the intent is open, and the credit always fits.
- **Pseudocode**:
  ```
  function startTopUp(user, team, amount, key):
      validate amount >= 1.00                         # B1, before any transaction
      tx:
          lock teams FOR KEY SHARE; require is_payout_configured     # C-BIL-PAY
          INSERT wallet_top_ups(status CREATING) -- unique: one non-terminal per wallet
          balance = SELECT balance FROM player_credits FOR SHARE (or 0.00)
          if amount > 100.00 - balance: ROLLBACK; 422
      create at Akahu (outside tx); record OPEN (tx2)
  ```
- **Time Complexity**: Best O(1) / Average O(1) / Worst O(1) statements; index lookups O(log W) for W wallets.
- **Space Complexity**: O(1) per start; table grows O(top-ups ever made).
- **Data Structures**: partial unique B-tree on `(user_id, team_id) WHERE status IN (CREATING, OPEN, HELD)`; unique `(user_id, team_id, idempotency_key)`; unique `akahu_payment_id`.
- **Pros**:
  - The cap is provable without reservations: with one slot, the only balance increase between start and credit is this intent's own credit.
  - The DB index is the concurrency control: 10 simultaneous starts give exactly one row (AC-INTEGRATION-3), with no application locking.
  - Over-cap becomes an anomaly path, not a normal outcome.
- **Cons**:
  - A slow bank (SUBMITTED for hours) or a held intent blocks further top-ups for that wallet until it resolves.
  - An abandoned intent blocks the form until its link expires (mitigated by a short Akahu `expires_at` and lazy resolution on the next start).
- **Best For**: low-frequency top-ups by one person per wallet, which is the product's case.
- **Worst For**: a wallet needing several concurrent top-ups (not a requirement).

#### Option D1-B: Reservation (headroom held by open intents)
- **Approach**: allow several open intents per wallet; each start checks `amount <= 100.00 - balance - sum(open intent amounts)` under a wallet `FOR UPDATE` lock. Credits release the reservation.
- **Time Complexity**: O(k) per start for k open intents (sum), O(1) per credit.
- **Space Complexity**: O(k) open rows per wallet.
- **Data Structures**: wallet row lock plus an aggregate over open intents (or a `reserved` column kept in sync).
- **Pros**:
  - Several in-flight top-ups possible.
- **Cons**:
  - Needs a wallet `FOR UPDATE` in every start and a derived "reserved" value that must stay consistent with intent states (a second invariant to enforce in SQL).
  - Abandoned intents hold headroom just as in D1-A, so the user-visible benefit is small.
  - More states for AC-INTEGRATION-3 races and the reconciliation CLI.
- **Best For**: high-frequency wallet funding.
- **Worst For**: this product: more machinery for a case nobody asked for.

#### Option D1-C: No start-time limit; cap checked only at credit
- **Approach**: any number of intents, each up to $100.00; at SENT, credit if it fits, otherwise B3.
- **Time Complexity**: O(1).
- **Space Complexity**: O(1).
- **Pros**:
  - Simplest start path.
- **Cons**:
  - Over-cap becomes a routine outcome, so B3's "refund outside the app" becomes a regular admin chore. This contradicts AC-ERROR-1, which refuses an over-headroom start with "You can top up at most $X".
- **Best For**: nothing here.
- **Worst For**: any product with a hard cap and manual refunds.

#### Sub-decision D1-S: what an unabsorbable success does (B3)
| Variant | Behaviour | Verdict |
|---------|-----------|---------|
| S1 Whole unapplied | Credit nothing; record the intent `UNAPPLIED (OVER_CAP)` with the full amount; notify player and admins; team refunds outside the app | **Chosen** |
| S2 Partial credit | Credit up to the cap; record the remainder as unapplied | Rejected: one Akahu payment would map to a ledger row of a different amount, the refund is an odd remainder the team must compute, and it needs a split record type (the `REFUND` type is unused in v1) |
| S3 Allow > $100.00 | Credit in full above the cap (B3 alternative) | Rejected: B3 default chosen by the human; needs the balance CHECK widened |

S1 fits B3's "credit nothing beyond the cap" (it credits nothing at all), mirrors the all-or-nothing deduction rule, and keeps the reconciliation invariant "every `TOPUP` equals its intent's amount and its Akahu payment's amount". Under D1-A it can only be reached through a vendor anomaly or an ops error (see the proof under "Invariants").

---

### Decision D2: Applying Akahu results (webhook, reconcile, return page)

#### Option D2-A: One state-based apply function over a re-read snapshot (DR-003/DR-004 shape)
- **Approach**: every path (webhook job, reconcile sweep, return page, start-path lazy resolution) calls `refreshFromAkahu(target)`: `GET` the payment outside any transaction, then `applyAkahuResult(target, snapshot)` in one short transaction that locks the target row, maps the status (A2), and runs a pure decision table keyed on (local state, mapped outcome, absorb check). Every write is a guarded UPDATE on the expected local state, so duplicates and races are no-ops.
- **Time Complexity**: O(1) DB statements per apply; one HTTP GET (~100-500 ms) outside the transaction.
- **Space Complexity**: O(1).
- **Data Structures**: `payment_intent_status` enum (new, shared by both tables), row locks, unique keys.
- **Pros**:
  - Order-independent: the webhook body never drives state, so unordered or replayed events cannot regress anything.
  - One table to test exhaustively (the matrix below) covers webhook, reconcile and return-page behaviour.
- **Cons**:
  - Every signal costs one Akahu GET (cheap at this scale; watch the rate limit in reconcile).
- **Best For**: providers without event ids and with unordered delivery.

#### Option D2-B: Apply the webhook payload directly, poll only as fallback
- **Approach**: trust the verified body's `status`; dedupe by `(_payment, status)`.
- **Pros**: one fewer HTTP call.
- **Cons**: the body has no amount (no A2 amount re-check), delivery is unordered, and a forged-but-replayed valid body would be applied as-is. Contradicts DR-003 ("signal only"). Rejected.

#### Option D2-C: Event-sourced intent log (append every observed status, derive state)
- **Approach**: append each snapshot to `akahu_events`; derive the intent state by fold.
- **Pros**: full audit trail.
- **Cons**: no event id to dedupe on (TRAP in the spike), derivation in two languages, and the derived state still needs a guarded materialised row for the unique "one open" constraint. Over-engineered. Rejected (structured logs give the audit trail).

---

### Decision D3: `bill-session` transaction shape and wallet locking (Q6)

#### Option D3-A: One transaction per session; wallets locked once, sorted, before the payment inserts
- **Approach**: lock `teams FOR KEY SHARE`, `game_sessions FOR UPDATE`, read the hand-off, compute every charge (pure), lock all needed wallet rows in one `SELECT ... ORDER BY user_id FOR UPDATE`, decide each charge against the locked balances, then write the session completion, payments, line items, ledger rows and emails with a few multi-row statements. Commit or roll back as a unit.
- **Time Complexity**:
  - Best: O(1) statements (free session or empty hand-off).
  - Average/Worst: O(R + G) rows in O(1) multi-row statements plus O(R) email enqueues, for R registrations and G guests (G <= 2R).
- **Space Complexity**: O(R + G) in memory.
- **Data Structures**: `Map<userId, LockedWallet>`; arrays of payment and line-item rows for bulk insert.
- **Pros**:
  - Never half-billed (AC-ERROR-9): a failure rolls back the COMPLETED move, payments, deductions and emails together.
  - Sorted wallet locking makes two sessions with shared players deadlock-free (AC-VERIFY-3).
  - Replay is trivially a no-op: COMPLETED is the guard.
  - `billing_type` is immutable (`payments_guard_immutable`), so the deduction must be decided before the payment insert; D3-A does that naturally.
- **Cons**:
  - Holds the session row and the session's wallet rows for the whole transaction (well under a second).
  - The wallet lock comes before the (new-row) payment inserts in program order; see the lock-order note under D3 decision.
- **Best For**: sessions of tens of parties.

#### Option D3-B: One transaction per registration
- **Approach**: the sweep completes the session in one transaction, then each registration is billed in its own transaction.
- **Pros**: smaller lock windows.
- **Cons**: a session can be COMPLETED with only some players billed, which needs a second "billed" marker per registration and a re-drive loop. Violates the spec's default and AC-ERROR-9 ("never half-applies"). Rejected.

#### Option D3-C: One transaction per session, wallets locked one at a time in hand-off order
- **Pros**: simplest code.
- **Cons**: hand-off order is `registered_at`; two sessions of the same team sharing players A and B can lock A then B and B then A, which can end in `40P01`. Rejected.

---

### Decision D4: Reconcile cadence

#### Option D4-A: Interval sweep over open intents past an age threshold, least-recently-checked first, bounded batch
- **Approach**: every 15 minutes, close stale `CREATING` rows (no Akahu id, never handed out), then re-read up to `BATCH` open intents with `created_at <= now - AGE`, ordered `last_checked_at NULLS FIRST, created_at, id`, with small parallelism, stopping on a 429. Intents open longer than `MAX_AGE` are flagged stuck once (warn) and then re-read hourly.
- **Time Complexity**: O(B) GETs and O(B) short transactions per run (B = batch); selection O(B log N) on a partial index over open rows.
- **Space Complexity**: O(B).
- **Pros**: bounded work and rate use per run; fair rotation via `last_checked_at`; simple to reason about.
- **Cons**: a fixed cadence re-reads long-SUBMITTED intents every run until stuck (a few dozen GETs, harmless).

#### Option D4-B: Per-row exponential backoff (`next_check_at`)
- **Pros**: fewer GETs for long-lived intents.
- **Cons**: another column and a backoff policy to test, for a saving that does not matter at this scale. Kept as an optimisation if Akahu rate limits bite.

#### Option D4-C: Webhook only, no poll
- **Cons**: Akahu recommends polling as the fallback and practitioner evidence makes it mandatory (spike T4). Rejected.

---

## Complexity Comparison

### D1 (top-up intent)
| Metric | D1-A one open | D1-B reservation | D1-C credit-time cap |
|--------|---------------|------------------|----------------------|
| Time (Best) | O(1) | O(1) | O(1) |
| Time (Avg) | O(1) | O(k) | O(1) |
| Time (Worst) | O(1) (+ one wait on a committing credit) | O(k) under wallet lock | O(1) |
| Space | O(1) open/wallet | O(k) open/wallet | unbounded open |
| Over-cap outcomes | anomaly only | anomaly only | routine |
| Implementation | Simple | Medium | Simple |

### D3 (bill-session)
| Metric | D3-A per session, sorted locks | D3-B per registration | D3-C per session, unsorted |
|--------|-------------------------------|-----------------------|----------------------------|
| Time (Best) | O(1) stmts | O(1) | O(1) |
| Time (Avg) | O(1) stmts + O(R) enqueues | O(R) transactions | O(R) stmts |
| Time (Worst) | same | same + re-drive | deadlock retry |
| Space | O(R + G) | O(1) per tx | O(R + G) |
| Half-billed possible | No | Yes | No |
| Deadlock possible | No | No | Yes |
| Implementation | Medium | Complex | Simple |

### D2 and D4
D2-A and D4-A are O(1) per intent and O(B) per run respectively; the alternatives are rejected on correctness (D2-B, D4-C) or cost-benefit (D2-C, D4-B), not on complexity.

## Performance Projection

At the working scale (30-40 registrations per session, a few dozen open intents):

| Algorithm | Expected Latency | Memory Usage |
|-----------|------------------|--------------|
| `bill-session` (D3-A), 30 parties, 20 guests | ~15 statements + ~30 email enqueues ≈ 50-100 ms; deferred `payment_lines_match_header` at COMMIT ≈ 80 trigger runs x 3 small queries ≈ 50-150 ms; total ≈ 100-300 ms (budget 2 s) | < 1 MB |
| `post-game-billing` sweep | one index range scan (`idx_game_sessions_billing_due`) + one enqueue per due session ≈ 5-20 ms typical; backlog of 1,000 ≈ 1-2 s per page loop | O(page) |
| `startTopUp` / `startAttempt` | tx1 ≈ 3-5 ms; Akahu create 300-1,500 ms (outside tx); tx2 ≈ 2 ms | O(1) |
| `applyAkahuResult` | ≈ 5-10 statements ≈ 5-15 ms (+ GET outside) | O(1) |
| `daily-overdue` | batches of 200: ≈ 10-30 ms per batch + enqueues | O(batch) |
| `akahu-reconcile`, batch 100, parallelism 4 | ≈ 100 x 300 ms / 4 ≈ 8-15 s (job expiry 900 s) | O(batch) |

## Decision

**Chosen**: D1-A with S1 (one non-terminal top-up per wallet, headroom at start, whole-amount B3 record), D2-A (single state-based apply over a re-read, with an explicit HELD state), D3-A (one transaction per session, wallets locked once in `user_id` order before the payment inserts), and D4-A (interval reconcile, age threshold, bounded batch, stuck flag).

### Rationale
- **The cap is a theorem, not a hope (D1-A).** With one slot per wallet and the balance read after the slot is claimed, no credit other than the intent's own can land between start and completion (proof below). The DB CHECK (`balance <= 100.00`) stays a backstop that should never fire, and the B3 path is reserved for vendor contradictions and ops mistakes. That keeps refunds-outside-the-app rare, which matters because B3 puts that work on volunteer team admins.
- **One apply function (D2-A)** is the only design that tolerates no event id, unordered delivery, 20 retries, a racing reconcile and a return page, all at once, because it reads truth and applies guarded transitions. The decision is a pure table, so AC-ERROR-3, AC-ERROR-6, AC-ERROR-10, AC-ASYNC-3 and A2 are all rows of one test matrix.
- **HELD is a first-class state, not a flag.** It occupies the same "one open per payment / per wallet" slot as an in-flight intent, so "no new attempt" and "payment not payable" (A2) fall out of the existing unique index with no extra check. Resolution is an explicit ops action.
- **One transaction per session (D3-A)** gives "never half-billed" and replay-safety from one guard (the PUBLISHED -> COMPLETED transition), meets 2 s by an order of magnitude, and sorted wallet locking removes the only realistic deadlock (two sessions of one team sharing players).
- **Bounded, fair reconcile (D4-A)** meets "missed webhook within interval + threshold" with predictable Akahu usage.

### Trade-offs Accepted
- **One top-up at a time per wallet.** A slow bank or a held intent blocks new top-ups for that wallet. Acceptable: the player can still pay any charge by link, and the wallet page explains the state. Abandonment is bounded by the Akahu link TTL (default 30 minutes) and resolved lazily on the next start.
- **Unabsorbable success is recorded, not credited (S1).** The team refunds outside the app. Accepted under B3; mitigated by making the case nearly unreachable and by notifying both sides with the amount and a statement reference.
- **Wallet rows are locked before the new payment rows are inserted** in `bill-session`. The deduction must be known before the insert (`billing_type` is immutable), and inserting new rows takes no lock on any existing `payments` row, so this does not invert the canonical order in any lock that another transaction can hold (see "Lock order" below). Flagged for the architecture reconciliation (RF-1).
- **Held payments do not go OVERDUE** (and neither do payments whose attempt the player has authorised). The debt gate does not punish a player whose money may already have moved. A held payment therefore never becomes overdue until ops resolves it; the stuck and held listings keep it visible.
- **Per-run reconcile cost is fixed**, not adaptive (D4-B deferred).

## Implementation Details

### Assumptions about the architecture (to reconcile; owned by the parallel architecture agent)
| ID | Assumption made here | Why it matters to the algorithm |
|----|---------------------|----------------------------------|
| RF-1 | `LOCK_ORDER` extended to `teams -> recurring_session_rules -> team_members -> game_sessions -> registrations -> registration_guests -> payments -> payment_attempts -> wallet_top_ups -> player_credits` (`credit_transactions` rows are inserted after their wallet is locked). `bill-session` locks wallet rows after the hand-off and before inserting its new payment rows; AC-VERIFY-3's wording "then writes payments, then locks the wallet row" should read "then locks the wallet rows (sorted by `user_id`), then inserts payments" | Deadlock freedom (proof below) |
| RF-2 | Ledger enforcement sits behind one writer, `wallet/ledger.applyMovement(trx, lockedWallet, amount, type, refs) -> newBalance`, whether the architecture picks a trigger or a guarded write. The algorithm only needs: the wallet row is locked `FOR UPDATE` by the caller, and `resulting_balance = old + amount` | Deduction and credit pseudocode |
| RF-3 | Module split `modules/billing` (bill-session, overdue, reminders, apply for attempts), `modules/wallet` (top-ups, ledger, apply for top-ups), `lib/akahu` (gateway). The pure decision functions live in `packages/shared/src/billing/` so the API and tests share them | File placement only |
| RF-4 | New schema (column names indicative): enum `payment_intent_status` (`CREATING`, `OPEN`, `HELD`, `APPLIED`, `UNAPPLIED`, `CLOSED`) used by both `wallet_top_ups` and `payment_attempts`; columns `amount`, `idempotency_key`, `akahu_payment_id` (unique), `akahu_status`, `akahu_status_reason`, `link_expires_at`, `authorisation_url_sealed` (or none, see RF-6), `reference`, `close_reason`, `hold_reason`, `unapplied_reason`, `last_checked_at`, `stuck_at`, `resolved_by`, `resolved_at`, timestamps; partial unique "one non-terminal" index per wallet and per payment; DB transition guard per the matrix below; `credit_transactions.top_up_id` unique FK (or unique `akahu_payment_id` WHERE `TOPUP`); `billing_session_blocks(session_id PK, team_id, blocked_at, notified_at)`; `payment_reminders(id, payment_id, change_key UNIQUE, actor_id, sent_at)` plus `payments.last_reminder_at`; partial index `payments (due_date) WHERE status = 'PENDING'` | The once-only guards the algorithms rely on |
| RF-5 | `team_banking_in_use` widened (A8, decided here): also true while the team has a `wallet_top_ups` or `payment_attempts` row in `CREATING`, `OPEN` or `HELD`. Service, trigger and parity tests change together (AC-VERIFY-11) | A8 |
| RF-6 | Resume of an open intent returns its `authorisation_url`. Default here: store it sealed (FieldCrypto, P4) and return it on 409 while the link has at least `RESUME_MIN_REMAINING` left; otherwise cancel-and-replace. If architecture prefers not to store the URL, use cancel-and-replace always (both are covered by the algorithm) | AC-ERROR-10 "returns the open attempt's redirect" |
| RF-7 | A GLOBAL_ADMIN "resolve held intent" action (route, policy, audit log), analogous to the A3 manual payout-block action, calls `resolveHeld` below; `cli billing reconcile` (AC-VERIFY-12) also lists HELD, UNAPPLIED and stuck intents | A2 ops surface |
| RF-8 | The webhook route persists and enqueues an `akahu-apply` job keyed by `_payment` (`singletonKey = akahu-apply:<akahuPaymentId>`), whose handler is `refreshFromAkahu`. The return pages call `refreshFromAkahu` inline at most once per `RETURN_REFRESH_MIN_INTERVAL` per intent | Entry points to D2-A |
| RF-9 | New emails beyond the spec's seven: a B3 "money received but not applied" notice (player + admins) and, to honour AC-ASYNC-2's "We'll email you when it does", a "Top-up received" email. The journey agent owns their copy or may fold them into existing templates | B3, AC-ASYNC-2 |
| RF-10 | `daily-overdue` skips payments whose attempt is `OPEN` with Akahu status `AUTHORISED`/`SUBMITTED`, or `HELD`. This refines AC-HAPPY-8's "only PENDING with `due_date <= now`"; the AC's fixtures (no attempts) are unaffected | Fairness of the debt gate |
| RF-11 | Boot sweeps (`enqueueBootSweeps`) also enqueue `post-game-billing`, `daily-overdue` and `akahu-reconcile` (all exclusive, idempotent) so a worker that was down catches up at once | Multi-day outage |
| RF-12 | `bill-session` queue is `exclusive` with `singletonKey = bill-session:<sessionId>` and is worked with local concurrency 1, so B9's oldest-first order holds on the single worker container (ADR 0007). Correctness does not depend on the order | B9 |

### Data Structures
| Structure | Purpose | Operations Used |
|-----------|---------|-----------------|
| Partial unique index "one non-terminal top-up per wallet" | Concurrency control for D1-A | insert O(log n); conflict waits for an in-flight update of the slot holder, then re-checks |
| Partial unique index "one non-terminal attempt per payment" | One open attempt (AC-ERROR-10); HELD blocks new attempts | insert O(log n) |
| Unique `akahu_payment_id` on each intent table | Correlate a snapshot to exactly one intent (`_payment` only, never URL params) | lookup O(log n) |
| `uq_payments_registration` | One payment per registration (existing) | insert O(log n) |
| `uq_credit_tx_auto_deduction_per_registration` + unique TOPUP key | Once-only ledger rows (existing + RF-4) | insert O(log n) |
| `idx_game_sessions_billing_due` (existing, partial on PUBLISHED) | Sweep selection by `ends_at` | range scan O(log n + k) |
| `payments (due_date) WHERE status = 'PENDING'` (RF-4) | Overdue selection | range scan O(log n + k) |
| Partial index on intents `(last_checked_at, created_at) WHERE status = 'OPEN'` | Reconcile ordering | range scan O(log n + B) |
| `billing_session_blocks` PK | Once-per-session B8 notice | insert ... ON CONFLICT DO NOTHING O(log n) |
| `payment_reminders.change_key` unique | Reminder replay | lookup/insert O(log n) |
| `Map<userId, LockedWallet>` (memory) | Per-session running balances | O(1) |

### Configuration (P7; names final in architecture)
| Setting | Default | Range / rule |
|---------|---------|--------------|
| `WALLET_CAP` | 100.00 | constant (DB CHECK), not env |
| `TOPUP_MIN` | 1.00 | constant (B1) |
| `LOW_CREDIT_THRESHOLD` | 20.00 | constant (B5) |
| `PAYMENT_DUE_AFTER` | 72 h | constant (B2) |
| `REMINDER_COOLDOWN` | 24 h | constant (B6) |
| `AKAHU_LINK_TTL_SECONDS` | 1800 | 900..86400 (Akahu `expires_at` minimum 15 min) |
| `RESUME_MIN_REMAINING_SECONDS` | 120 | 0..600 |
| `CREATING_STALE_SECONDS` | 120 | > Akahu create timeout x 2 |
| `AKAHU_RECONCILE_AGE_SECONDS` | 300 | 60..3600 |
| `AKAHU_RECONCILE_MAX_AGE_SECONDS` | 86400 | > age |
| `AKAHU_RECONCILE_BATCH` | 100 | 1..500 |
| `AKAHU_RECONCILE_PARALLELISM` | 4 | 1..8 |
| `akahu-reconcile` cron | `*/15 * * * *`, `intervalSweep: true` | exempt from the DST rule |
| `BILLING_SWEEP_PAGE` | 100 | page size of the sweep loop |
| `OVERDUE_BATCH` | 200 | rows per overdue transaction |

### State machines

#### Intent state (shared by `wallet_top_ups` and `payment_attempts`)
```
             create ok (tx2)
  CREATING ----------------> OPEN ----(SENT, absorbable, amount ok)----> APPLIED
     |                        |  \---(SENT, not absorbable)-----------> UNAPPLIED   (B3)
     | create failed,         |  \---(SENT, amount mismatch)----------> HELD (AMOUNT_MISMATCH)
     | ambiguous, or stale    |  \---(FAILED/BANK_ERROR_INDETERMINATE)-> HELD (INDETERMINATE)
     v                        |  \---(CANCELLED/*, FAILED/other)-------> CLOSED
   CLOSED <-------------------+       (READY/AUTHORISED/SUBMITTED or unknown: stays OPEN, mirror updated)
     |
     +--(late SENT; only rows that have an akahu_payment_id)--> APPLIED | UNAPPLIED   (A8 -> B3 absorb rule)

  HELD --(ops RECEIVED, or a SENT re-read)--> APPLIED | UNAPPLIED
  HELD --(ops NOT_RECEIVED)-----------------> CLOSED
  APPLIED, UNAPPLIED: terminal
```
- **Non-terminal (occupies the one-open slot, counts for `team_banking_in_use`)**: `CREATING`, `OPEN`, `HELD`.
- **DB transition guard** (twin of the shared matrix fixture): exactly the arrows above; `CLOSED -> APPLIED|UNAPPLIED` only when `akahu_payment_id IS NOT NULL`; `amount`, `idempotency_key`, owner and target columns immutable; `akahu_payment_id` set once.
- **OPEN mirror**: `akahu_status` only moves forward by rank READY(0) < AUTHORISED(1) < SUBMITTED(2), so a stale re-read cannot regress it.

#### Payment status (DB guard, AC-VERIFY-2, B4)
| From \ To | PENDING | OVERDUE | PAID | FAILED |
|-----------|---------|---------|------|--------|
| (insert) | allowed | no | allowed (PREPAID_CREDIT, or $0.00 PER_GAME) | no |
| PENDING | - | `daily-overdue` only | apply / ops | no (B4) |
| OVERDUE | no | - | apply / ops | no (B4) |
| PAID | no | no | - | no |
| FAILED | unreachable | | | |

#### Akahu status mapping (A2; pure `mapAkahuStatus`)
| Akahu `status` / `status_reason` | Mapped outcome |
|----------------------------------|----------------|
| READY | `STILL_OPEN(READY)` |
| AUTHORISED | `STILL_OPEN(AUTHORISED)` |
| SUBMITTED / PENDING, SETTLEMENT_IN_PROGRESS, none | `STILL_OPEN(SUBMITTED)` |
| SENT | `SUCCEEDED` (then the amount check) |
| CANCELLED / TIMED_OUT, USER_CANCELLED, APP_CANCELLED, other | `FAILED_PAYABLE(reason)` |
| FAILED / REJECTED, BANK_ERROR, INTERNAL_ERROR | `FAILED_PAYABLE(reason)`; never sets `payout_blocked_at` (OV-3) |
| FAILED / BANK_ERROR_INDETERMINATE | `INDETERMINATE` |
| FAILED / any other reason | `FAILED_PAYABLE(reason)` (FAILED is terminal and documented as not moving money, except INDETERMINATE) |
| anything else | `UNKNOWN` (left open, warn) |

### Invariants and proofs

**I1 (cap).** For a top-up T started on wallet W with amount `a`, the balance at T's credit is at most the balance `b0` read in T's start transaction, so `b0 + a <= 100.00` implies the credit fits.
*Proof sketch.* Balance increases come only from `applyMovement(TOPUP)`, which runs only in an apply or `resolveHeld` for an intent of W in state OPEN, HELD or CLOSED-with-Akahu-id. (a) While T holds W's slot, no other intent of W is OPEN or HELD (unique index). (b) Any intent that held the slot before T reached a terminal state before T's insert could succeed; T's insert waits on that holder's in-flight update, and the balance is read afterwards `FOR SHARE` with a fresh statement snapshot, so a credit committed by the previous holder is already in `b0`. (c) A CLOSED intent can only be credited on a late SENT, which the mapping assigns only to an Akahu payment that Akahu previously reported CANCELLED or FAILED (both terminal), or to a create that never handed a URL to anyone (cannot be authorised). Both require Akahu to contradict its documented lifecycle. Hence, absent a vendor contradiction or an ops RECEIVED on the wrong intent, only deductions change W between T's start and credit, and they only lower it. The S1 B3 branch handles the excluded cases without breaking the CHECK.

**I2 (payment paid once).** `payments.status = PAID` is reached by exactly one guarded UPDATE (`WHERE status IN ('PENDING','OVERDUE')`) under the payment row lock; any later success for the same payment finds PAID and becomes `UNAPPLIED (DUPLICATE)`.

**I3 (ledger once).** Each `TOPUP` is tied to one intent by a unique key and written only in the transaction that moves that intent to APPLIED; each `AUTO_DEDUCTION` is unique per registration and written only in the transaction that moves the session PUBLISHED -> COMPLETED.

**I4 (no deadlock).** Every transaction acquires row locks in `LOCK_ORDER` (RF-1), multi-row locks of one table are taken in one statement ordered by key (`player_credits` by `user_id`; `payments` by `id` in `daily-overdue`), and no transaction waits on a lock of an earlier table while holding a later one. `bill-session` holds `player_credits` while inserting new `payments` rows and their FK checks take `KEY SHARE` on `registrations`/`teams`/`users`. No transaction holds a conflicting lock (`FOR UPDATE`, key update, delete) on those referenced rows while waiting for a wallet: the allocator cannot be inside this session (it needs the session lock that billing holds), and the banking removal (`teams FOR UPDATE`) never locks a wallet.

**I5 (no Akahu call under a lock).** Every gateway call happens between committed transactions (`startTopUp`, `startAttempt`, `refreshFromAkahu`, `reconcile`).

### Algorithm Steps and Pseudocode

#### A. Pure functions (`packages/shared/src/billing/`)
```
CAP = 100.00; TOPUP_MIN = 1.00; LOW = 20.00; DUE_AFTER_MS = 72*3600*1000; COOLDOWN_MS = 24*3600*1000

function topUpHeadroom(balance): return CAP - balance                      # never negative (CHECK)

function validateTopUp(amount, balance):
    if amount < TOPUP_MIN:              return refuse('below_minimum')       # B1
    h = topUpHeadroom(balance)
    if h == 0:                          return refuse('wallet_full')
    if amount > h:                      return refuse('exceeds_headroom', max = h)
    return ok

function dueDate(billedAt): return billedAt + DUE_AFTER_MS                   # B2, exact instant

function computeCharge(fees, reg):                                           # C-BIL-1: snapshot only
    lines = [ line(0, fees, { sex: reg.registrantSex, skillLevel: reg.registrantSkillLevel }) ]
    for g in reg.guests (by position): lines.append(line(g.position, fees, { sex: g.sex, skillLevel: g.skillLevel }, g.guestId))
    total = sum(l.unitFee for l in lines)
    return { lines, total }
  where line(pos, fees, person, guestId?) =
    fee = unitFee(fees, person); if fee == null: throw InvariantError        # CHECK makes this unreachable
    basis = FLAT | SEX_<person.sex> | SKILL_<person.skillLevel> per fees.pricing
    return { pos, guestId, basis, sex: person.sex, skill: person.skillLevel, unitFee: fee }

function decideSettlement(balanceOrNull, total):                             # P2, all-or-nothing
    if total == 0:                                   return { kind: ZERO }   # B7
    if balanceOrNull != null and gte(balanceOrNull, total):
        nb = balanceOrNull - total
        return { kind: WALLET, newBalance: nb, lowCredit: lt(nb, LOW) }      # B5: every such deduction
    return { kind: LINK }

function decideApply(local, outcome, ctx):        # ctx: { amountMatches, absorbable }
    match (local.status, outcome):
      (APPLIED | UNAPPLIED, _)              -> NOOP
      (CREATING, _)                         -> NOOP            # cannot have an Akahu id yet
      (OPEN, STILL_OPEN(s))                 -> MIRROR(s)       # forward-only rank
      (OPEN, UNKNOWN)                       -> MIRROR_UNKNOWN  # stays OPEN, warn
      (OPEN | HELD | CLOSED, SUCCEEDED):
            if not ctx.amountMatches        -> (local.status == OPEN ? HOLD(AMOUNT_MISMATCH) : NOOP_WARN)
            if ctx.absorbable               -> APPLY
            else                            -> UNAPPLY(kind == TOPUP ? OVER_CAP : DUPLICATE)
      (OPEN, FAILED_PAYABLE(r))             -> CLOSE(r)
      (OPEN, INDETERMINATE)                 -> HOLD(INDETERMINATE)
      (HELD | CLOSED, _)                    -> NOOP            # terminal at Akahu; only SENT reopens
    # absorbable: TOPUP   -> balance(locked) + amount <= CAP
    #             ATTEMPT -> payment.status in (PENDING, OVERDUE)

function overdueCandidate(p, openAttempt, now):
    return p.status == PENDING and p.due_date <= now
       and not (openAttempt and (openAttempt.status == HELD
                or openAttempt.akahu_status in (AUTHORISED, SUBMITTED)))    # RF-10

function reminderAllowed(p, now):
    if p.status == PAID: return refuse('payment_settled')
    if p.last_reminder_at != null and now < p.last_reminder_at + COOLDOWN_MS: return refuse('reminder_too_soon')
    return ok
```

#### B. Starting a top-up (Q3)
```
function startTopUp(actor, teamId, amount, idempotencyKey):
    validate amount (zod MoneyString, strict body) and amount >= TOPUP_MIN       # 422, nothing written
    for retry in [first, afterLazyResolve]:
        tx1:
            team = SELECT is_payout_configured, bank ciphertexts FROM teams WHERE id = teamId FOR KEY SHARE
            if !team.is_payout_configured: raise 409 payout_not_configured        # C-BIL-PAY
            prior = SELECT * FROM wallet_top_ups WHERE (user, team, idempotency_key) = (...)
            if prior: return replay(prior)                                      # same key -> same answer
            try INSERT wallet_top_ups(user, team, amount, idempotency_key, status CREATING,
                                      reference = shortRef(id), created_at = now) RETURNING id
            on unique(one non-terminal per wallet):
                open = load the non-terminal row
                if retry == first and open.status == OPEN and linkExpired(open, now):
                    ROLLBACK; refreshFromAkahu(TOPUP, open, cancelIfReady = true); continue   # lazy expiry
                raise 409 top_up_in_progress { topUp: open, redirectUrl: resumeUrl(open, now) }
            on unique(idempotency key): return replay(load by key)              # concurrent same-key click
            balance = SELECT balance FROM player_credits WHERE (user, team) FOR SHARE ?? 0.00
            v = validateTopUp(amount, balance)
            if refused(v): ROLLBACK; raise 422 v                                # "You can top up at most $X"
        COMMIT
        return createAtAkahu(TOPUP, topUpId, amount, payee = decrypt(team), redirect = /teams/:t/wallet?topUp=<id>)

function resumeUrl(open, now):            # RF-6
    if open.status == OPEN and open.akahu_status == READY
       and open.link_expires_at - now >= RESUME_MIN_REMAINING: return unseal(open.authorisation_url_sealed)
    return null                           # client shows "processing" (AUTHORISED/SUBMITTED/HELD) or retries
```

#### C. Starting a payment attempt
```
function startAttempt(actor, paymentId, idempotencyKey):
    for retry in [first, afterLazyResolve]:
        tx1:
            p0 = SELECT team_id, user_id FROM payments WHERE id = paymentId          # plain read to find the team
            if !p0 or p0.user_id != actor: raise 404 not_found                       # payer only, uniform 404
            team = SELECT ... FROM teams WHERE id = p0.team_id FOR KEY SHARE          # lock order: teams first
            p = SELECT * FROM payments WHERE id = paymentId FOR UPDATE
            if p.status == PAID: raise 409 payment_settled
            if !team.is_payout_configured: raise 409 payout_not_configured            # "can't receive payments"
            prior = attempt with (payment_id, idempotency_key); if prior: return replay(prior)
            try INSERT payment_attempts(payment_id, amount = p.amount, key, status CREATING, reference)
            on unique(one non-terminal per payment):
                open = load
                if open.status == HELD: raise 409 payment_on_hold                   # A2: no new attempt (new code, RF-7)
                if retry == first and open.status == OPEN and linkExpired(open, now):
                    ROLLBACK; refreshFromAkahu(ATTEMPT, open, cancelIfReady = true); continue
                raise 409 payment_in_progress { redirectUrl: resumeUrl(open, now) }  # AC-ERROR-10
        COMMIT
        return createAtAkahu(ATTEMPT, attemptId, p.amount, payee = decrypt(team), redirect = /payments/:id?return=1)
```
Membership is never checked here: a member who left or was banned after `starts_at` still pays their own charge (Edge 14).

#### D. Create at Akahu (shared; DR-005, A5)
```
function createAtAkahu(kind, intentId, amount, payee, redirectUri):
    now = clock.now()
    res = gateway.create({ amount, payee, redirect_uri: redirectUri, webhook_uri: WEBHOOK_URL,
                           expires_at: now + LINK_TTL, particulars/code/reference: shortRef(intentId) })
          # called once; never blindly retried; payee decrypted in memory only (P4); not logged
    if res is DEFINITIVE_REJECTION(code):      # 4xx: invalid_payee, single_limit_exceeded, bank_limit_exceeded, ...
        tx: UPDATE intent SET status CLOSED, close_reason 'create_rejected:'+code WHERE id AND status = CREATING
        raise mapCreateError(code)              # invalid_payee -> 409 payout_not_configured copy; limits -> 422
    if res is AMBIGUOUS:                        # timeout, 5xx, network
        tx: UPDATE intent SET status CLOSED, close_reason 'create_ambiguous' WHERE id AND status = CREATING
        raise 503 payment_provider_unavailable  # AC-ERROR-7; a retry needs a new key
    tx2:
        n = UPDATE intent SET status OPEN, akahu_payment_id = res.id, akahu_status = READY,
                   link_expires_at = now + LINK_TTL, authorisation_url_sealed = seal(res.url)
            WHERE id = intentId AND status = CREATING
    if n == 0:                                  # reconcile closed it as stale meanwhile (should not happen)
        gateway.cancel(res.id) best effort; raise 503
    return { intent, redirectUrl: res.url }     # URL handed out only after tx2 committed
```
A crash between the create and tx2 leaves `CREATING`; nobody received the URL, so reconcile closes it after `CREATING_STALE` (step H).

#### E. Applying a result (D2-A)
```
function refreshFromAkahu(kind, intent, cancelIfReady = false):
    snap = gateway.get(intent.akahu_payment_id)                        # outside any tx
    if cancelIfReady and snap.status == READY and now >= intent.link_expires_at:
        gateway.cancel(snap.id)                                        # 204, or 400 bad_payment_state
        snap = gateway.get(snap.id)
    return applyAkahuResult(kind, intent.id, snap)

function applyAkahuResult(kind, intentId, snap):
    outcome = mapAkahuStatus(snap.status, snap.status_reason)
    tx:
        if kind == ATTEMPT:
            pid = SELECT payment_id FROM payment_attempts WHERE id = intentId          # plain read
            p   = SELECT * FROM payments WHERE id = pid FOR UPDATE                     # payments before attempts
            i   = SELECT * FROM payment_attempts WHERE id = intentId FOR UPDATE
        else:
            i   = SELECT * FROM wallet_top_ups WHERE id = intentId FOR UPDATE
            if outcome == SUCCEEDED and i.status in (OPEN, HELD, CLOSED):
                INSERT player_credits(user, team, 0.00) ON CONFLICT DO NOTHING          # lazy wallet (wallet.sql note)
                w = SELECT * FROM player_credits WHERE (user, team) FOR UPDATE
        now = clock.now()                                                               # after locks (P3)
        assert i.akahu_payment_id == snap.id                                            # correlate by _payment only
        ctx = { amountMatches: eq(parseMoney(snap.amount), i.amount),
                absorbable: kind == TOPUP ? lte(w.balance + i.amount, CAP)
                                          : p.status in (PENDING, OVERDUE) }
        d = decideApply(i, outcome, ctx)
        switch d:
          NOOP:            touch last_checked_at
          MIRROR(s):       UPDATE i SET akahu_status = s (if rank higher), last_checked_at = now WHERE status = OPEN
          MIRROR_UNKNOWN:  touch; log warn akahu.status.unknown { intentId, status }
          CLOSE(r):        UPDATE i SET status CLOSED, close_reason = 'akahu:'+r WHERE status = OPEN
                           # payment untouched: stays PENDING/OVERDUE and payable (B4); top-up slot freed
          HOLD(reason):    UPDATE i SET status HELD, hold_reason = reason WHERE status = OPEN
                           log warn akahu.intent.held { kind, intentId, reason }        # ops flag (A2)
          APPLY:
            if kind == TOPUP:
                nb = ledger.applyMovement(trx, w, +i.amount, TOPUP, { topUpId: i.id, akahuPaymentId: snap.id })
                UPDATE i SET status APPLIED WHERE status = i.status
                enqueueEmail(topUpReceived, key 'topup-received:'+i.id)                  # RF-9
            else:
                UPDATE payments SET status PAID, paid_at = now, akahu_payment_id = snap.id
                    WHERE id = p.id AND status IN (PENDING, OVERDUE)                     # I2
                UPDATE i SET status APPLIED WHERE status = i.status
                enqueueEmail(paymentReceived, key 'payment-received:'+p.id)              # AC-HAPPY-12
                other = SELECT open attempt of p (id != i.id, status OPEN)               # only after a late SENT
                if other: mark for post-commit cancel
            log info (kind == TOPUP ? wallet.topup.credited : billing.payment.paid)
          UNAPPLY(reason):
            UPDATE i SET status UNAPPLIED, unapplied_reason = reason WHERE status = i.status
            enqueue B3 notice to the player and each APPROVED TEAM_ADMIN,
                key 'b3:'+i.id+':'+recipientId                                           # RF-9
            log warn (wallet.topup.overflow | billing.payment.duplicate)
    after commit: for each marked other attempt: refreshFromAkahu(ATTEMPT, other, cancelIfReady = true)
```
Webhook, reconcile and return page race freely: each locks the same rows and re-checks the local state, so exactly one of them performs APPLY (AC-INTEGRATION-3). A webhook that arrives before tx2 has recorded the Akahu id finds no intent and is ignored (A4); the only status possible at that moment is READY, which carries no effect.

#### F. Resolving a held intent (A2 ops path, RF-7)
```
function resolveHeld(kind, intentId, verdict, actor, note):        # GLOBAL_ADMIN only
    tx (same locks as applyAkahuResult):
        if i.status != HELD: return 409 not_held
        if verdict == NOT_RECEIVED:
            UPDATE i SET status CLOSED, close_reason 'ops_not_received', resolved_by = actor, resolved_at = now
            # payment payable again / top-up slot freed
        else:  # RECEIVED (team confirmed the reference on its statement, or Akahu support confirmed)
            ctx = { amountMatches: true (ops attests the stored amount), absorbable: as in E }
            run the APPLY or UNAPPLY branch of E, then set resolved_by, resolved_at
        log info billing.hold.resolved { kind, intentId, verdict, actorId }    # note kept in the row, never PII in logs
```

#### G. Post-game billing (Q6)
```
function postGameBillingSweep():                               # every 5 min; also at boot (RF-11)
    now = clock.now(); after = null
    loop:
        page = SELECT s.id, s.team_id, s.ends_at FROM game_sessions s
               WHERE s.status = 'PUBLISHED' AND s.ends_at <= now
                 AND (after IS NULL OR (s.ends_at, s.id) > after)
                 AND NOT EXISTS (SELECT 1 FROM billing_session_blocks b JOIN teams t ON t.id = b.team_id
                                 WHERE b.session_id = s.id AND NOT t.is_payout_configured)   # B8: skip while still blocked
               ORDER BY s.ends_at, s.id LIMIT PAGE                 # B9: oldest first
        for s in page: jobs.enqueue('bill-session', { sessionId: s.id, teamId: s.team_id },
                                    { singletonKey: 'bill-session:' + s.id })
        if len(page) < PAGE: break; after = (last.ends_at, last.id)
    log billing.sweep.enqueued { scanned, enqueued }

function billSession({ sessionId, teamId }):                   # one transaction (D3-A)
    tx:
      1  team = SELECT is_payout_configured, gst_registered, gst_number FROM teams
                WHERE id = teamId FOR KEY SHARE                     # C-BIL-PAY; GST snapshot read here (ADR 0016)
      2  s = lockSession(trx, { sessionId, teamId })                 # FOR UPDATE (D-14)
         if !s: log warn billing.session.missing; return
         if s.status != PUBLISHED: return NOOP                       # replay, concurrent duplicate, or CANCELLED
      3  now = clock.now()                                           # after locks (P3)
         if now < s.ends_at: return NOOP (not_due)                   # AC-VERIFY-6; implies never before starts_at
      4  paid = isPaidSession(s.fees)                                # TS twin of game_session_is_paid
         if paid and !team.is_payout_configured:                     # B8 hold
             if INSERT billing_session_blocks(session_id, team_id, blocked_at = now)
                ON CONFLICT DO NOTHING inserted a row:
                 for admin in approved TEAM_ADMINs of teamId (plain read):
                     enqueueEmail(billingBlocked, key 'billing-blocked:'+sessionId+':'+admin.id)
             log warn billing.session.blocked { sessionId, teamId }
             COMMIT; return BLOCKED                                  # session stays PUBLISHED, no payment, no wallet
      5  regs = listBillableRegistrations(trx, sessionId, now)       # C-BIL-1; exact list, snapshot attributes
      6  UPDATE game_sessions SET status = 'COMPLETED' WHERE id = sessionId AND status = 'PUBLISHED'
         assert rowcount == 1                                        # D-75 allows PUBLISHED -> COMPLETED
      7  if !paid or regs empty: log billing.session.completed { payments: 0 }; COMMIT; return
      8  charges = [ (r, computeCharge(s.fees, r)) for r in regs ]    # pure; hand-off order (registered_at, id)
      9  users = sorted(distinct r.userId for charges with total > 0)
         wallets = SELECT * FROM player_credits WHERE team_id = teamId AND user_id = ANY(users)
                   ORDER BY user_id FOR UPDATE                       # one statement, sorted (I4)
         bal = Map(user_id -> balance)                               # missing row = no wallet (not created)
     10  gst = team.gst_registered ? (GST_RATE_BPS, team.gst_number) : (0, null)
         for (r, c) in charges:
             d = decideSettlement(bal.get(r.userId), c.total)
             switch d.kind:
               ZERO:   row = payment(PER_GAME, PAID, paid_at = now, due_date = dueDate(now))      # B7: no email
               WALLET: row = payment(PREPAID_CREDIT, PAID, paid_at = now, due_date = dueDate(now))
                       bal.set(r.userId, d.newBalance)
               LINK:   row = payment(PER_GAME, PENDING, paid_at = null, due_date = dueDate(now)) # B2
             rows.append(row with amount = c.total, pricing_structure, gst, reason = r.reason,
                         payment_link_token = random256())           # role of the token: architecture (Q2)
     11  INSERT payments (all rows) RETURNING id, registration_id     # uq_payments_registration: a conflict is an
                                                                     # invariant breach -> throw -> rollback
         INSERT payment_line_items (all lines, guest lines carry registration_guest_id = guestId)
     12  for each WALLET row (in sorted user order):
             nb = ledger.applyMovement(trx, wallets[user], -total, AUTO_DEDUCTION, { registrationId })
             if d.lowCredit: enqueueEmail(lowCredit, key 'low-credit:'+creditTxId)               # B5
     13  for each LINK row: enqueueEmail(paymentDue (sealed link), key 'payment-due:'+paymentId,
                                         wording by reason: CONFIRMED | LATE_WITHDRAWAL)
     14  if a billing_session_blocks row exists for sessionId: UPDATE ... SET resolved_at = now   # history only
         log billing.session.completed { sessionId, payments, deducted, linked, zero }
    COMMIT                                                           # deferred payment_lines_match_header runs here
    on error: ROLLBACK; transient -> pg-boss retry with backoff; permanent -> job failed,
              log billing.session.failed { sessionId, errorClass, sqlstate }; the next sweep re-enqueues (AC-ERROR-9)
```
Notes on the edge cases owned here:
- **Departed members.** The hand-off already decides who is billed (bans at or before `starts_at` excluded, O6). Billing never consults current membership: a member who left, or was banned after the start, is charged; their wallet in that team is deducted when it covers the fee (the money is already in the team's account), otherwise they get a link and pay through `/payments/:id`. A wallet balance left in a team the player no longer belongs to stays there (withdrawals are out of scope); the journey agent should say so.
- **Multi-day outage.** Nothing is dated from `ends_at` except selection: `paid_at`, `due_date` and the emails use the billing instant, so a player billed late still gets the full 72 hours. Deductions use the balance at billing time, including any top-ups made in the meantime.
- **Backlog (B9).** The sweep enqueues oldest-first; the single worker with local concurrency 1 processes in that order (RF-12). A same-player conflict across sessions is settled by the wallet lock; whichever session bills first deducts first.
- **No D-75 widening is needed.** Billing writes `game_sessions` once (the status change itself, allowed from PUBLISHED); the B8 marker lives in a billing-owned table.
- **Free sessions on a blocked team** are completed normally: B8 applies only when `paid` is true, because C-BIL-PAY guards payment rows and a free session writes none.

#### H. Reconcile (D4-A)
```
function akahuReconcile():                                     # */15, also at boot
    now = clock.now()
    # 1. stale CREATING: never handed out, safe to close (DR-005)
    for kind in (TOPUP, ATTEMPT):
        UPDATE <table> SET status CLOSED, close_reason 'create_abandoned'
         WHERE status = 'CREATING' AND created_at <= now - CREATING_STALE
    # 2. open intents past the age threshold, least recently checked first
    cands = union over both tables of OPEN rows
            WHERE created_at <= now - AGE
              AND (last_checked_at IS NULL OR last_checked_at <= now - AGE)
              AND (stuck_at IS NULL OR last_checked_at <= now - 1 hour)
            ORDER BY last_checked_at NULLS FIRST, created_at, id LIMIT BATCH
    run with parallelism P:
        for c in cands:
            try: d = refreshFromAkahu(c.kind, c, cancelIfReady = true)
            on 429: stop scheduling further rows; log warn akahu.reconcile.rate_limited
            on other error: touch last_checked_at; log warn akahu.reconcile.read_failed { kind, id, errorClass }
            if still OPEN and c.created_at <= now - MAX_AGE and c.stuck_at IS NULL:
                UPDATE SET stuck_at = now; log warn akahu.reconcile.stuck { kind, id, ageSeconds, akahuStatus }
    # HELD rows are not re-read (A4: reconcile does not resolve INDETERMINATE)
    log akahu.reconcile.applied { checked, closed, applied, held, unapplied, stuck }
```
Missed-webhook bound: an intent completed at Akahu at time t is re-read by the first run after `max(created_at + AGE, t)`, so within `AGE + interval` (20 minutes by default) of completion, provided the batch is not saturated. Saturation (more than 100 intents due in one run) only delays the tail by whole intervals and is logged by the counts.

#### I. Daily overdue (B2, B6, C-BIL-2)
```
function dailyOverdue():                                       # 04:00 Pacific/Auckland; also at boot (RF-11)
    now = clock.now()
    loop:
        tx:
            ids = SELECT p.id FROM payments p
                  WHERE p.status = 'PENDING' AND p.due_date <= now
                    AND NOT EXISTS (SELECT 1 FROM payment_attempts a WHERE a.payment_id = p.id
                                    AND (a.status = 'HELD'
                                         OR (a.status = 'OPEN' AND a.akahu_status IN ('AUTHORISED','SUBMITTED'))))
                  ORDER BY p.id LIMIT OVERDUE_BATCH FOR UPDATE OF p          # waits for an in-flight apply
            rows = UPDATE payments SET status = 'OVERDUE' WHERE id = ANY(ids) AND status = 'PENDING'
                   RETURNING id, user_id, team_id, amount, registration_id
            for r in rows: enqueueEmail(overdue (sealed link), key 'payment-overdue:'+r.id)
        COMMIT
        if len(ids) < OVERDUE_BATCH: break
    log billing.overdue.marked { count }
```
- The same-day re-run finds nothing new: each payment leaves PENDING once and never returns, so `payment-overdue:<id>` is a durable once-only cause.
- A payment whose attempt fails after the 04:00 run stays PENDING past due until the next run (at most 24 hours), which is acceptable under B6 (no automatic repeats).
- Only this function writes OVERDUE (C-BIL-2; grep test).

#### J. Manual reminder (B6)
```
function sendReminder(actor, teamId, paymentId, changeKey):
    tx:
        if not actor.isGlobalAdmin: assert team_members(actor, teamId) FOR SHARE is APPROVED TEAM_ADMIN   # 403
        prior = SELECT * FROM payment_reminders WHERE change_key = changeKey
        if prior: return 202 { sent: true, lastReminderAt: prior.sent_at }              # replay, nothing sent
        p = SELECT * FROM payments WHERE id = paymentId AND team_id = teamId FOR UPDATE
        if !p: raise 404 not_found                                                       # other team or unknown
        now = clock.now()
        v = reminderAllowed(p, now); if refused(v): raise 409 v                          # payment_settled | reminder_too_soon
        r = INSERT payment_reminders(payment_id, change_key, actor_id, sent_at = now) RETURNING id
        UPDATE payments SET last_reminder_at = now WHERE id = paymentId                   # mutable (not in the immutability list)
        enqueueEmail(reminder (sealed link), key 'payment-reminder:'+r.id)
    return 202 { sent: true, lastReminderAt: now }
```
- The cooldown is exact (`now >= last + 24 h` allows). The automatic overdue email does not count as a reminder: `last_reminder_at` records manual reminders only, which is what the admin table shows as "Reminder sent".
- A replay is checked before the cooldown, so the same `changeKey` always returns the original answer even within 24 hours.

### Edge Case Handling
| Edge Case | Handling |
|-----------|----------|
| Two simultaneous top-ups | One INSERT wins the partial unique index; the other gets 409 `top_up_in_progress` (and the open intent's resume URL if READY) |
| Same idempotency key twice | Unique `(user, team, key)` -> replay of the first answer |
| Top-up over headroom / below $1.00 / wallet full | 422 `exceeds_headroom` (with `max`), `below_minimum`, `wallet_full`; transaction rolled back; no Akahu call |
| Payout not configured at top-up or pay time | 409 `payout_not_configured` under `teams FOR KEY SHARE` (C-BIL-PAY) |
| Abandoned top-up / attempt | Akahu times out at `expires_at`; reconcile or the next start's lazy resolve reads CANCELLED/TIMED_OUT and closes; the form returns |
| Player retries while READY with < 2 min left | Lazy resolve cancels the READY payment (204), closes it, then the start proceeds |
| Cancel races an authorisation | `PUT .../cancel` answers `bad_payment_state`; the re-read shows AUTHORISED/SUBMITTED; intent stays OPEN; 409 in progress |
| SENT for a CLOSED intent (A8) | B3 absorb rule: credited / PAID if it still fits; otherwise UNAPPLIED + notices |
| SENT over the cap | UNAPPLIED (OVER_CAP), nothing credited (S1), notices to player and admins |
| Second SENT for a PAID payment | UNAPPLIED (DUPLICATE), payment untouched, no wallet credit |
| SENT, amount differs | HELD (AMOUNT_MISMATCH); ops resolves |
| BANK_ERROR_INDETERMINATE | HELD (INDETERMINATE): no new attempt (index), payment not overdue (RF-10), held copy (no "you haven't been charged"), ops resolves |
| Unknown Akahu status | OPEN, warn; re-read next run |
| Webhook before tx2 | Unknown `_payment` -> ignored (only READY possible) |
| Banking removal during an open top-up | Refused: `team_banking_in_use` includes non-terminal intents (RF-5) |
| Banking change during an open intent | Money goes to the account fixed at create (B10 at payment time); later attempts use the new account |
| Team payout blocked while a payment is PENDING | New attempts refused; an already-open attempt completes normally (money to the old account) |
| B8 blocked session | PUBLISHED kept; one notice per admin per session (durable marker); billed on the first sweep after the block clears |
| B7 $0.00 party | PAID PER_GAME $0.00 with lines, no email, no wallet change |
| Free session / no billable rows | COMPLETED, no payments, no emails |
| Party total above $100.00 | Wallet can never cover it (cap) -> link |
| Balance exactly equal to total | Deducted to $0.00 (`gte`), low-credit email (0.00 < 20.00) |
| Balance ends at exactly $20.00 | No low-credit email (`lt`) |
| Member left / banned after start | Billed per hand-off; wallet used; link payable via payer-only page |
| Two sessions, same players, end together | Wallet rows locked in `user_id` order in one statement; serialised, no deadlock |
| Worker down for days | Boot sweeps; oldest-first billing at the actual instant; overdue and reconcile catch up |
| `bill-session` replay / duplicate | COMPLETED guard (after waiting on the session lock) -> no-op |
| Job enqueued before `ends_at` (manual trigger) | `now < ends_at` -> no-op |
| Reminder replay / too soon / settled / other team | Replay answer; 409 `reminder_too_soon`; 409 `payment_settled`; 404 |

### Error Handling
| Error Condition | Response |
|-----------------|----------|
| Akahu create 4xx | Intent CLOSED (`create_rejected:<code>`); map to 409/422 with player copy; never retried |
| Akahu create timeout / 5xx / network | Intent CLOSED (`create_ambiguous`); 503 `payment_provider_unavailable`; retry needs a new key |
| tx2 finds the intent no longer CREATING | Best-effort `PUT .../cancel`; 503 |
| Akahu GET fails in reconcile | Row skipped, `last_checked_at` touched, warn; next run retries |
| Akahu 429 | Reconcile stops scheduling, finishes the job successfully; client backs off (DR-002) |
| `listBillableRegistrations` throws `before_start` | Impossible after the `ends_at` check; treated as an invariant error |
| Null `unitFee` / missing snapshot | `InvariantError` -> rollback; job fails; `billing.session.failed` |
| `uq_payments_registration` conflict in `bill-session` | Invariant breach (a payment exists for a PUBLISHED session) -> rollback, fail visibly |
| Deferred `payment_lines_match_header` failure at COMMIT | Rollback; job fails with SQLSTATE 23514 in the log |
| Balance CHECK violation | Should be unreachable (I1, `gte`); if raised, rollback and fail visibly rather than clamp |
| Serialization or deadlock (`40001`, `40P01`) | Retried by pg-boss; the race tests prove `40P01` does not occur |

## Performance Expectations

### At Current Scale
- `bill-session`: about 100-300 ms for 30 parties (2 s budget); one transaction, about 15 statements plus one enqueue per email.
- Sweep: one indexed range scan; tens of enqueues per day.
- Top-up and attempt start: two short transactions (single-digit ms each) around one Akahu call.
- Reconcile: a handful of GETs per run; seconds.
- Daily overdue: one or two batches.

### At 10x Scale
- `bill-session` cost is per session and does not grow with the number of teams; the sweep scans only due sessions.
- Reconcile at hundreds of open intents: the batch cap (100 per 15 minutes, parallelism 4) becomes the bottleneck before the database does. Raise the batch, or adopt D4-B backoff, if `akahu.reconcile.applied.checked` regularly hits the cap.
- Overdue: thousands of rows run in 200-row batches, seconds in total.
- Bottlenecks: Akahu rate limits (reconcile, key fetches), the single worker draining a large B9 backlog (about 1,000 sessions x 0.3 s ≈ 5 minutes), and email throughput after a backlog.

### Optimization Opportunities
- D4-B per-row `next_check_at` backoff if Akahu rate limits bite.
- Batch `enqueueEmail` through one multi-row pg-boss insert in `bill-session` if email enqueues dominate.
- Poison-session parking (a `billing_session_blocks` reason for invariant failures) if a broken session's 5-minute re-enqueue becomes noisy.
- Optional "pay this charge from my wallet" action for a PENDING charge after a top-up (out of scope; billing deducts only at session end).

## Validation Checklist

- [x] Meets latency requirements (`bill-session` ≈ 0.1-0.3 s vs 2 s; billing within 10 minutes; missed webhook within 20 minutes)
- [x] Meets memory requirements (O(R) per session, O(batch) per sweep)
- [x] Handles all edge cases (table above; B1-B10 and A2/A8 covered)
- [x] Scales to expected data size (bounded batches; indexed selections)
- [x] Implementation feasible (existing helpers: `lockSession`, `listBillableRegistrations`, `unitFee`, `enqueueEmail`, pg-boss `singletonKey`, `Clock`)
- [x] Respects Guiding Principles and data flow patterns in systemPatterns.md (P1 DB guards and uniques; P2 `Money`, `gte`, no partials; P3 one `now` after locks; P4 payee and URL sealed or in-memory only; P5 enqueue in the causing transaction, no call under a lock; P7 config validated at boot)

## Testing Strategy

### Unit Tests (table-driven, `packages/shared/src/billing/*.test.ts` and module `*.test.ts`)

**T1 `validateTopUp`** (balance, amount -> outcome):
| balance | amount | expected |
|---------|--------|----------|
| 0.00 | 30.00 | ok |
| 85.00 | 15.00 | ok (exactly the headroom) |
| 85.00 | 15.01 | `exceeds_headroom`, max 15.00 |
| 85.00 | 20.00 | `exceeds_headroom`, max 15.00 (AC-ERROR-1) |
| 100.00 | 1.00 | `wallet_full` |
| 50.00 | 0.99 | `below_minimum` |
| 50.00 | 1.00 | ok |
| 99.50 | 1.00 | `exceeds_headroom`, max 0.50 (headroom below the minimum: UI shows the limit) |

**T2 `mapAkahuStatus`**: one row per status and reason in the A2 table, plus an unknown status, plus `FAILED/REJECTED` asserting no payout-block effect.

**T3 `decideApply`** (local x outcome x ctx -> decision), the full cross product of {CREATING, OPEN, HELD, CLOSED, APPLIED, UNAPPLIED} x {STILL_OPEN(READY/AUTHORISED/SUBMITTED), SUCCEEDED, FAILED_PAYABLE, INDETERMINATE, UNKNOWN} x {amountMatches, absorbable} for both kinds. Key rows:
| local | outcome | amount | absorbable | kind | decision |
|-------|---------|--------|------------|------|----------|
| OPEN | SUCCEEDED | match | yes | TOPUP | APPLY |
| OPEN | SUCCEEDED | match | no | TOPUP | UNAPPLY(OVER_CAP) |
| OPEN | SUCCEEDED | match | no (PAID) | ATTEMPT | UNAPPLY(DUPLICATE) |
| OPEN | SUCCEEDED | mismatch | any | any | HOLD(AMOUNT_MISMATCH) |
| OPEN | INDETERMINATE | - | - | any | HOLD(INDETERMINATE) |
| OPEN | FAILED_PAYABLE(REJECTED) | - | - | ATTEMPT | CLOSE |
| OPEN | STILL_OPEN(SUBMITTED) | - | - | any | MIRROR |
| OPEN(SUBMITTED) | STILL_OPEN(READY) | - | - | any | NOOP (no rank regression) |
| OPEN | UNKNOWN | - | - | any | MIRROR_UNKNOWN |
| CLOSED | SUCCEEDED | match | yes | ATTEMPT | APPLY (late SENT, A8) |
| CLOSED | FAILED_PAYABLE | - | - | any | NOOP |
| HELD | SUCCEEDED | match | yes | TOPUP | APPLY |
| HELD | FAILED_PAYABLE | - | - | any | NOOP |
| APPLIED | SUCCEEDED | match | - | any | NOOP (replay) |

**T4 `computeCharge`** (the AC-HAPPY-5 matrix plus extras): FLAT $17.00 x party 1/2/3 = 17/34/51; BY_SEX M15/F12/O13 with M + F guest + O guest = 40.00 and bases SEX_MALE/SEX_FEMALE/SEX_OTHER; BY_SKILL B10/I14/A18 with registrant snapshotted INTERMEDIATE (current ADVANCED ignored) = 14.00; BY_SEX with `fee_female = 0.00` and a lone female = 0.00 (B7); a null column -> InvariantError. Rows replayed as integration fixtures so SQL and TS cannot drift.

**T5 `decideSettlement`** (balance, total -> kind, newBalance, lowCredit):
| balance | total | expected |
|---------|-------|----------|
| 30.00 | 17.00 | WALLET, 13.00, low |
| 35.00 | 17.00 | WALLET, 18.00, low |
| 36.00 | 17.00 | WALLET, 19.00, low |
| 37.00 | 17.00 | WALLET, 20.00, not low |
| 15.00 | 10.00 | WALLET, 5.00, low (B5 default) |
| 17.00 | 17.00 | WALLET, 0.00, low |
| 16.99 | 17.00 | LINK |
| 10.00 | 17.00 | LINK (no partial) |
| null | 17.00 | LINK (no wallet row created) |
| 50.00 | 0.00 | ZERO (B7) |
| 100.00 | 120.00 | LINK |

**T6 `dueDate` and `overdueCandidate`**: due = billed + 72 h across the DST start and end; at `due - 1 ms` not a candidate, at `due` a candidate; PAID/OVERDUE never; PENDING with OPEN READY attempt is a candidate; with OPEN AUTHORISED, OPEN SUBMITTED or HELD it is not.

**T7 `reminderAllowed`**: PAID -> settled; never reminded -> ok; reminded at `now - 24 h + 1 ms` -> too soon; at exactly `now - 24 h` -> ok; OVERDUE and PENDING both ok.

**T8 transition matrices**: the payment matrix and the intent matrix as shared fixtures; every pair asserted in TS and replayed as raw SQL in `billing-schema.int.test.ts` (allowed pairs succeed, others raise the named constraint).

**T9 property test (fast-check)**: random interleavings of `startTopUp` (amounts 0.01-120.00), credits, failures and deductions on one wallet, run against the pure model: the balance stays in [0, 100], equals the sum of applied movements, no APPLY is ever refused for over-cap unless the sequence includes an injected vendor contradiction (late SENT on a CLOSED intent), and every refusal at start matches T1.

### Integration Tests (real PostgreSQL, real pg-boss, `waitForLockWaiters`, no sleeps)
- **Top-up races**: 10 concurrent starts on one wallet -> exactly one CREATING/OPEN, nine 409 (AC-INTEGRATION-3); start while the previous holder's credit is mid-transaction -> the new start waits, then sees the credited balance (I1 part b).
- **Apply races**: webhook job vs reconcile vs return page applying the same SENT -> one TOPUP / one PAID; deduction vs top-up credit on one wallet in both orders -> balance and ledger agree, no `40P01`.
- **Hold**: INDETERMINATE fixture -> HELD; a new attempt gets 409 `payment_on_hold`; `daily-overdue` skips the payment; `resolveHeld` RECEIVED -> PAID once; NOT_RECEIVED -> payable again.
- **B3**: late SENT on a CLOSED top-up that fits -> credited; one that does not fit -> UNAPPLIED, notices enqueued once, no ledger row; second SENT on a PAID payment -> UNAPPLIED, no wallet change.
- **bill-session**: AC-HAPPY-2/3/5/6/7/11 on allocator-produced registrations; replay no-op; two concurrent runs -> one COMPLETED; injected failure after the inserts -> nothing persisted; two sessions of one team ending together with shared players -> no deadlock, correct deductions; B8 blocked -> PUBLISHED, one notice per admin across three sweeps, then billed after the block clears; C-BIL-PAY race vs banking removal in both orders (replacing `payment-stand-in.ts`).
- **Sweep**: ended vs not-ended vs CANCELLED; backlog of 5 sessions enqueued in `ends_at` order; boot enqueue.
- **Overdue**: boundary at `due - 1 ms` / `due`; same-day re-run sends nothing; in-flight and held attempts skipped.
- **Reminders**: 202, replay, 409 too soon at 23:59:59.999, 202 at 24:00:00.000, 404 other team, 403 member.
- **Reconcile**: stale CREATING closed; OPEN past age re-read and applied; READY past expiry cancelled then closed; 429 stops the batch; stuck flagged once at MAX_AGE; HELD not re-read.
- **`team_banking_in_use`**: removal refused while a top-up is CREATING/OPEN/HELD; allowed once it is APPLIED/CLOSED; service, trigger and parity tests agree.

### Performance Tests
- `bill-session` with 40 parties (80 guests) completes in under 2 s on the CI database (load-tolerant bound; expected under 0.5 s), asserted via the job's logged duration.
- Sweep over a seeded backlog of 1,000 ended sessions enqueues all of them within one run's expiry.
- Reconcile with 100 open intents and the fake adapter's latency set to 300 ms completes within 60 s at parallelism 4.

## Next Steps

1. Architecture reconciliation: confirm or amend RF-1 to RF-12 (lock order and AC-VERIFY-3 wording, ledger writer, schema names, the `team_banking_in_use` widening, URL storage, the held-intent ops action, the extra emails) in the task file's Creative Reconciliation section.
2. Phase 1: migration with `payment_intent_status`, both intent tables and their partial uniques and transition guards, `billing_session_blocks`, `payment_reminders`, `payments.last_reminder_at`, the pending-due index, the widened `team_banking_in_use`; shared pure functions T1-T8 with fixtures.
3. Phase 2: sweep and `bill-session` (G) with the ledger writer; race tests; replace the payment stand-in.
4. Phase 3: `dailyOverdue` (I) and `sendReminder` (J).
5. Phase 4 (after the MVE-001 go and MVE-005): `startTopUp` (B), `startAttempt` (C), `createAtAkahu` (D), `applyAkahuResult`/`refreshFromAkahu` (E), `resolveHeld` (F), `akahuReconcile` (H) against recorded fixtures with provenance labels.
6. Re-check U4 (MVE-004) and U13 (SENT irrevocability) answers: if INDETERMINATE is shown never to move money, the HOLD branch can map to CLOSE; if SENT can reverse, the ledger needs a reversal movement (out of v1 scope; raise a plan amendment).

NEW_TERMS_INTRODUCED:
- **Intent** (top-up intent or payment attempt): a local row representing one Akahu one-off payment we asked for, with state `payment_intent_status`.
- **`payment_intent_status`**: `CREATING`, `OPEN`, `HELD`, `APPLIED`, `UNAPPLIED`, `CLOSED`, shared by `wallet_top_ups` and `payment_attempts`.
- **Non-terminal intent**: `CREATING`, `OPEN` or `HELD`; occupies the one-open slot and counts for `team_banking_in_use`.
- **HELD**: intent state for `FAILED/BANK_ERROR_INDETERMINATE` or a SENT amount mismatch; blocks new intents for the same wallet or payment until ops resolves it.
- **UNAPPLIED**: terminal intent state for money Akahu reports as SENT that billing does not credit or apply (B3: `OVER_CAP`, `DUPLICATE`); the team refunds it outside the app.
- **Absorb rule**: a SENT is applied if its target can still take it (top-up fits under the cap; payment still PENDING/OVERDUE), otherwise recorded UNAPPLIED.
- **Lazy resolution**: re-reading (and cancelling if READY and expired) the blocking intent inside a new start before refusing with 409.
- **`billing_session_blocks`**: billing-owned marker that makes the B8 "Billing is paused" notice once per session.
- **`payment_reminders`**: append-only record of manual reminders keyed by `change_key` (B6 replay and audit).
- **Stuck intent**: an OPEN intent older than `AKAHU_RECONCILE_MAX_AGE_SECONDS`, flagged once with `stuck_at` and `akahu.reconcile.stuck`.
- **`shortRef`**: a 10-12 character reference derived from the intent id, sent to Akahu so a team can match a bank statement line (hold resolution, B3 refunds).
