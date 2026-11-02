# ADR 0020: Wallet, post-game billing and Akahu payments

- Status: **Proposed (Draft, Phases 1-2 recorded)**. It becomes Accepted only after Akahu's written answer to MVE-001 (Plan Amendment A1): third-party team payees under Tier 1, payee-verification liability, first-payment holds, distinct-payee caps. If that answer brings a payee-verification liability term, the human rules on verifying team bank details at save time before this ADR is accepted. A negative answer stops Phase 4 and triggers a re-plan.
- Task: wallet-and-akahu-billing
- Source: [Architecture design, "ADR 0020 outline"](../../memory-bank/creative/wallet-and-akahu-billing-billing-architecture.md) (ARCH); [Billing algorithm](../../memory-bank/creative/wallet-and-akahu-billing-billing-algorithm.md) (ALG); task file "Creative Reconciliation" CR-1 to CR-27 (binding where the design docs differ) and Plan Amendment A1-A8. Migration `20261102000100000_wallet_and_billing.sql` (ledger D-87 to D-98).
- Numbering: the next free ADR after 0019 and the next free deviation ids after D-86 on `main`. Phase 2 adds no migration and no schema deviation, so no D-99 row exists.
- Scope of this draft: the decisions Phases 1 and 2 build and test (lock order, single writers, the ledger, the billing engine and its rules B2/B5/B7/B8/B9, jobs, emails). The Akahu provider, intent, webhook and payout-block decisions (ARCH outline items 3, 7, 8, 9, 10) are carried forward as _Open until Phase 4_ at the end; they are not decided here.

## Context

Registrations (ADR 0018) produce the people a session must charge; sessions (ADR 0019) produce the `ends_at` that says when. This feature turns the first into money: it completes ended sessions, prices each registration from its snapshot (ADR 0012), takes the fee from a player's per-team wallet when the wallet covers it, and otherwise leaves a pay-by-bank charge. Money is exact `Money` and `numeric(10,2)` throughout (ADR 0009). Work runs in the pg-boss worker (ADR 0004), and every email commits with the transaction that caused it.

Contracts this ADR honours: ADR 0016 (C-BIL-PAY: every payment-creation path takes `teams FOR KEY SHARE` and checks `is_payout_configured` before inserting anything; the GST snapshot; `payout_blocked_at`), ADR 0018 (C-BIL-1 to C-BIL-3: bill exactly `listBillableRegistrations`; C-ALL-1: never write `registrations`), ADR 0019 (`COMPLETED` is written by billing only; the D-75 lifecycle matrix; `LOCK_ORDER`).

## Decision

### 1. Lock order, with the wallet before the payment (CR-4)

```
teams -> recurring_session_rules -> team_members -> game_sessions -> registrations -> registration_guests
      -> wallet_top_ups -> player_credits -> payments -> payment_attempts
```

This is `LOCK_ORDER` in `apps/api/src/modules/sessions/locks.ts`, asserted literally by `modules/sessions/lock-order.test.ts`. It replaces ADR 0019's seven-entry order and amends the spec's AC-VERIFY-3 sentence: the wallet sits **before** `payments` because `payments.billing_type` is immutable (`payments_guard_immutable`) and is decided by the wallet balance (PREPAID_CREDIT when the wallet covers the fee, PER_GAME otherwise). The balance must be read under the wallet lock before the payment is inserted; locking after the insert would decide on an unlocked balance or require changing an immutable column. AC-VERIFY-3 reads: "...then reads the hand-off, then locks the wallet rows (sorted by `user_id`), then inserts payments".

- Several wallets in one transaction are locked by one statement ordered by `user_id` (`wallet/ledger.ts: lockWallets`). All of a session's wallets belong to one team, so two billing transactions that share players can never take them in opposite orders.
- `bill-session` takes exactly: `teams FOR KEY SHARE` (with the `is_payout_configured` read) -> `game_sessions FOR UPDATE` -> the hand-off reads (`registrations` and guests, unlocked) -> `player_credits FOR NO KEY UPDATE` (every needed wallet, one statement) -> `payments` (insert only) -> `credit_transactions` (insert; the trigger re-locks the wallet already held). `billing-races.int.test.ts` records the statements PostgreSQL received and asserts this order against `LOCK_ORDER`.
- No path locks an existing `payments` row and then a wallet. Later phases' paths (top-up apply, attempt start and apply, reminder, `daily-overdue`) are in order as listed in ARCH Q4b and are tested when they land.
- **Order-inverting key share (recorded deliberately).** Inserting `payments` and `credit_transactions` takes `KEY SHARE` on the referenced `registrations` row after the wallet lock. `KEY SHARE` conflicts only with `FOR UPDATE` and key changes, and no registration path takes either (registrations are never deleted; updates are `NO KEY`), so the inversion cannot wait. It is the same kind of exception as ADR 0018's unlocked O6 read.
- **Payout block does not wait on billing.** The payout block takes `teams FOR NO KEY UPDATE`, which does not conflict with billing's `KEY SHARE`, so billing never waits on a block and cannot deadlock against it (ADR 0016, deliberate). A block committed while a billing transaction is already running does not undo that transaction: it keeps its committed read, completes whole, and the next session is held (B8). Both orders are raced in `billing-races.int.test.ts`.
- **Banking removal does wait.** A removal takes `teams FOR UPDATE`, which conflicts with billing's `KEY SHARE`: either the removal waits for billing and is then refused `banking_in_use` (the new payment is PENDING), or it runs first, is refused because a PUBLISHED paid session exists, and billing then completes with the destination intact. Both orders are raced against the real `bill-session` in `team-banking-gate.int.test.ts` (the Phase 2 replacement of the test-only payment stand-in, which is deleted).

### 2. Single writers of money state (CR-5, CR-9)

| State                                                      | Written only by                                                                            |
| ---------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| `payments`, `payment_line_items`, `billing_session_blocks` | `modules/billing/engine-repo.ts` (Phase 2)                                                 |
| `player_credits`, `credit_transactions`                    | `modules/wallet/ledger.ts`                                                                 |
| `game_sessions.status = 'COMPLETED'`                       | `modules/billing/engine-repo.ts`, called by `bill-session`                                 |
| `payments.status = 'OVERDUE'`                              | the `daily-overdue` job (Phase 3: `jobs/daily-overdue.ts` or `modules/billing/overdue.ts`) |
| `registrations`, `registration_guests`                     | `modules/registrations/repo.ts` only; billing and the wallet write none (C-ALL-1)          |

The ARCH outline named a `payments-repo.ts`; the file that exists is `engine-repo.ts`, and Phases 3-4 add their payment writers (overdue, apply-Akahu-result, reminders) as further allowed files in the structural test when they land. `modules/billing/boundaries.test.ts` scans every non-test source under `apps/api/src` for writes to each table (query-builder calls and SQL text) and fails on any writer outside the list; `registrations/boundaries.test.ts` additionally proves billing and the wallet write no `registrations` row and reach registrations only through `billing-handoff.ts` and the email helpers. Each rule is also proved to detect a violation.

Because `modules/sessions` keeps its own `lockSession` private to it (its boundary test), billing takes the same `game_sessions FOR UPDATE` through its own `lockSessionForBilling`, scoped to the team, in the same position of the order. **D-75 is not widened**: billing writes a session row once, in the PUBLISHED -> COMPLETED update the matrix already allows; the B8 hold writes a claim row in a billing-owned table, not the session.

### 3. The wallet ledger: trigger-maintained balance, one TypeScript writer (CR-5)

- `player_credits.balance` is changed only from inside the BEFORE INSERT trigger `credit_transactions_ledger_chain`, which refuses a ledger row whose `resulting_balance` is not the locked balance plus `amount`, or that leaves 0.00-100.00. A direct balance write is refused by a guard (so test fixtures fund a wallet through a synthetic applied top-up plus one TOPUP row). The ledger is append-only.
- `wallet/ledger.ts` makes no decisions: `ensureWallet`, `lockWallets` and `applyMovement`. A movement is never clamped; a movement that would leave the range throws `WalletLedgerError('out_of_range')` and the caller's transaction rolls back (a top-up that does not fit is the caller's B3 case, decided before it gets here). The shape of each type is checked in TypeScript as well as in the table (AUTO_DEDUCTION: negative, with a registration; TOPUP: positive, with an applied intent and an Akahu payment id).
- A wallet row is created at 0.00 by `ensureWallet` only; a read never creates one. "No wallet" is a balance of 0.00 with nothing to lock.
- Invariant, proven under concurrency: balance = ledger sum, within 0.00-100.00, never negative, for a deduction racing a TOPUP credit and for two sessions ending together for one player (`billing-races.int.test.ts`). Because `created_at` is a transaction start rather than a lock order, "latest row" is not defined by timestamp; the proof is the sum and the chain.

### 4. The billing engine (Q4c, CR-9)

- **One transaction per session.** `bill-session` completes the session, inserts every payment and line item, takes every deduction and enqueues every email in one transaction (`SET LOCAL lock_timeout = 5s`). A replay finds the session COMPLETED and does nothing; `UNIQUE(registration_id)` on `payments` and one AUTO_DEDUCTION per registration are second guards. A failure rolls everything back: nothing is half-billed (AC-ERROR-9). The deferred `payment_lines_match_header` check runs at COMMIT.
- **The clock is read once, after the locks** (P3), so waiting on a lock cannot make a session look due earlier than it was. A session is billed only when `now >= ends_at`.
- **Exactly the hand-off.** Billing charges exactly `listBillableRegistrations` and prices each party from the snapshot (registrant sex and skill at confirmation, each guest's own) with the shared `unitFee`, never `users.sex` or `team_members.skill_level`.
- **All or nothing per registration.** `decideSettlement` deducts when `gte(balance, total)` and only then; any shortfall, or no wallet, leaves a PER_GAME payment PENDING with a due date. A partial wallet payment is never taken.
- **GST snapshot (ADR 0016).** `insertCharge` copies `gst_registered`, the rate and `gst_number` out of `teams` in the statement that inserts the payment, so one payment never carries a number that does not belong to its `gst_registered`. `gst_amount` and `subtotal_amount` are generated columns (3/23 of the inclusive total, HALF_UP); `billing-money.int.test.ts` checks every cent amount from 0.00 to 300.00 and large amounts against `packages/shared` arithmetic (AC-VERIFY-4; no `number`, `parseFloat` or `toFixed` exists in billing or wallet code, also enforced by a source scan).
- **Rulings applied.** B2: due date is the billing instant plus 72 hours, exactly. B5: a low-credit email after every deduction that leaves the balance below $20.00. B7: a party whose total is $0.00 is a PAID $0.00 PER_GAME row, with no link, no email and no wallet movement. B8: see 5. B9: the sweep selects due sessions oldest first and the `bill-session` queue has local concurrency 1, so a backlog is billed in the order the games ended, with emails.

### 5. B8: a paid session of a team that cannot take payments is held

When `paid && !is_payout_configured` (read under the team `KEY SHARE`, C-BIL-PAY), billing writes nothing but a `billing_session_blocks` claim row (D-97) and enqueues one "Billing is paused" email per approved admin, once per session (the claim's `notified_at` is the once-only gate). The session stays PUBLISHED. The sweep skips a session that has a marker while its team is still blocked, so a held session does not re-run every five minutes; the first sweep after banking is saved again bills it normally. A **free** session writes no payment, so it completes whatever the team's state (the predicate is `isPaidSession`, the TypeScript twin of `game_session_is_paid`). Because the payout block does not wait on billing (1), a block can land while a billing transaction is already running; that transaction completes whole and the next session is held. Phase 4's payment-attempt start applies C-BIL-PAY again at pay time, so a PENDING charge on a blocked team cannot be paid until banking is saved.

### 6. Jobs (CR-13)

- `post-game-billing` is an every-five-minute sweep (also run once at worker boot and by `pnpm run jobs:trigger post-game-billing`). It enumerates due sessions through `idx_game_sessions_billing_due` (keyset on `(ends_at, id)`, oldest first), enqueues one `bill-session` job each with `singletonKey = bill-session:<sessionId>` on an exclusive queue (a queued or active job for the session suppresses a duplicate), bills nothing itself and takes no lock. It logs counts only (`billing.sweep.enqueued`).
- `bill-session` (`jobs/bill-session.ts`) validates a strict payload (`sessionId`, `trigger`), runs the transaction and logs after COMMIT (`billing.session.completed`, `billing.session.blocked`). A transient failure (lost connection, lock timeout `55P03`, deadlock) is rethrown for pg-boss to retry with backoff; an integrity failure (SQLSTATE class 23) cannot be cured by a retry and ends the job failed at once as `NonRetryableJobError`. Either way `billing.session.failed` carries the session id, the error class and the SQLSTATE only, never the message (it can quote values). The next sweep re-enqueues the session. Duplicate concurrent runs are safe: one COMPLETED, one payment per registration (`billing-races.int.test.ts`).
- `daily-overdue` and `akahu-reconcile` queues and their schedules arrive in Phases 3 and 4.

### 7. Emails are sealed, and commit with the work (P5, CR-20)

Payment-due, low-credit and billing-paused emails are enqueued **inside** the billing transaction (`enqueueEmail(jobs, message, { trx, crypto })`), so they exist exactly when the billing commits (AC-ASYNC-4). Any payload carrying a link is sealed with FieldCrypto (`pgboss.job`, `data.send-email`, keyed by the idempotency key), so a payment link never sits in `pgboss.job` in clear. Idempotency keys are derived from the cause (payment id, ledger row id, session and admin), so a replay cannot send twice. A $0.00 party gets no email (B7). The payment link in the email is `/payments/<id>` on the web origin and needs a sign-in; it is not a bearer capability.

### 8. Observability and no leaks (AC-VERIFY-7, Phase 2 portion)

Log fields are ids and counts. `billing-logs.int.test.ts` triggers each event for real and asserts its fields and that no line carries a bank name or number, an email, a name, a link, a token or a payment reference. The new field names (`sessionId`, `payments`, `deducted`, `linked`, `zero`, `scanned`, `enqueued`, `errorClass`, `sqlState`) match no global redaction key, so none is masked by accident; the `akahu_*`, `payee*` and `authorizationUrl` keys are already masked.

## Contracts this ADR exports

- **C-WAL-1**: only `wallet/ledger.ts` writes `player_credits` and `credit_transactions`; the balance is maintained by the trigger; a caller decides, the ledger moves.
- **C-BIL-4**: only `bill-session` completes sessions; only `daily-overdue` writes OVERDUE; `payments` rows are written only from the files the structural test lists.
- **C-BIL-5, C-INV-1** (read models for player-dashboard and admin-reporting-dashboard; the snapshot, including `gst_number`, for tax-invoices-and-exports; this feature never sets `is_tax_invoice_issued`): Phase 3-4.

## Consequences and one-way doors

- The migration (D-87 to D-98) encodes the Akahu one-off payment lifecycle in `payment_attempts` and `wallet_top_ups`. If MVE-001 is negative they need a follow-up migration (accepted in A1); the ledger, engine, jobs, reference and lock order are provider-neutral.
- Production cannot boot until Phase 4: `PAYMENTS_ADAPTER=fake` is refused in production and `akahu` refuses boot ("is not available in this build") until the live adapter exists.
- One transaction per session holds that session's wallets for its duration: at 30 registrations under 2 s, a top-up credit for the same wallet waits at most that long. One bad registration fails the session visibly and retries it.
- Rejected: wallet after payments (unsound, see 1); per-registration billing transactions (half-billed sessions); an application-only guarded balance write (fails AC-VERIFY-2: the database must refuse); completing a held session while deducting from wallets (the B8 alternative, not ruled); sessions-module exports of its lock helper (breaks its boundary test).

## Open until Phase 4 (not decided here)

Provider and port (Akahu One-Off Payments, platform app credential, payee per call, thin client, the fake adapter); intents and the shared `applyAkahuResult` (tx1 / create / tx2, HELD, sync job, reconcile and finality polling CR-25, hold-resolution guards CR-26); webhook ingress and verification (A4); the manual GLOBAL_ADMIN payout block and `payout_block_events` (A3, CR-14); `payment_reference` as the payment identity and the authenticated payer-only page; Akahu contract citations and fixture provenance (A7).

## Related

ADR 0004 (job runner), ADR 0009 (money), ADR 0012 (fee snapshot and guests), ADR 0016 (team banking and publish gate), ADR 0018 (registration allocation and billing hand-off), ADR 0019 (session scheduling engine).
