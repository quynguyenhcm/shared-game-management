# ADR 0020: Wallet, post-game billing and Akahu payments

- Status: **Decided items: final** (Phases 1-3, 4a, 5 and the Phase 6 documentation). **Akahu-gated items: open** (Phase 4b, listed in "Open pending Phase 4b (Akahu-gated)" below). This ADR is **not yet Accepted as a whole**: acceptance waits for Akahu's written answer to MVE-001 (Plan Amendment A1: third-party team payees under Tier 1, payee-verification liability, first-payment holds, distinct-payee caps). If that answer brings a payee-verification liability term, the human rules on verifying team bank details at save time before this ADR is accepted. A negative answer stops Phase 4b and triggers a re-plan.
- Task: wallet-and-akahu-billing (Level 4)
- Sources: task file `memory-bank/tasks/wallet-and-akahu-billing.md` (spec, rulings B1-B10, Creative Reconciliation CR-1 to CR-27, rulings H1-H3, Plan Amendments A1-A9, Deviations); creative docs `memory-bank/creative/wallet-and-akahu-billing-*` (architecture, algorithm, user journey, UI/UX); Akahu capability spike `akahu-payment-capability` (approved 2026-10-31, option A). Where the creative docs disagree, the task file's Creative Reconciliation wins.
- Numbering: the ADR is 0020; ledger deviations are D-87 to D-98, all in migration `20261102000100000_wallet_and_billing.sql`. No D-99 row exists.
- Related ADRs cited throughout: ADR 0004 (job runner), 0009 (money), 0012 (fee snapshot and guests), 0016 (team banking and publish gate), 0018 (registration allocation and billing hand-off), 0019 (session scheduling engine).

## Context

Registrations (ADR 0018) produce the people a session must charge; sessions (ADR 0019) produce the `ends_at` that says when. This feature turns the first into money: it completes ended sessions, prices each registration from its snapshot (ADR 0012), takes the fee from a player's per-team wallet when the wallet covers it, and otherwise leaves a pay-by-bank charge that the player settles through Akahu. Money is exact `Money` and `numeric(10,2)` throughout (ADR 0009). Work runs in the pg-boss worker (ADR 0004), and every email commits with the transaction that caused it.

Contracts this ADR honours: ADR 0016 (C-BIL-PAY: every payment-creation path takes `teams FOR KEY SHARE` and checks `is_payout_configured` before inserting anything; the GST snapshot; `payout_blocked_at`), ADR 0018 (C-BIL-1 to C-BIL-3: bill exactly `listBillableRegistrations`; C-ALL-1: never write `registrations`), ADR 0019 (`COMPLETED` is written by billing only; the D-75 lifecycle matrix is not widened; `LOCK_ORDER`).

## Decision

### 1. Lock order, with the wallet before payments (CR-4)

```
teams -> recurring_session_rules -> team_members -> game_sessions -> registrations -> registration_guests
      -> wallet_top_ups -> player_credits -> payments -> payment_attempts
```

This is `LOCK_ORDER` in `apps/api/src/modules/sessions/locks.ts`, asserted literally by `modules/sessions/lock-order.test.ts`. It replaces ADR 0019's seven-entry order. The wallet sits before `payments` because `payments.billing_type` is immutable (`payments_guard_immutable`) and is decided by the wallet balance (PREPAID_CREDIT when the wallet covers the fee, PER_GAME otherwise). The balance must be read under the wallet lock before the payment row is inserted. AC-VERIFY-3 is amended accordingly: "...then reads the hand-off, then locks the wallet rows (sorted by `user_id`), then inserts payments".

- Several wallets in one transaction are locked by one statement ordered by `user_id` (`wallet/ledger.ts: lockWallets`). All of a session's wallets belong to one team, so two billing transactions that share players cannot take them in opposite orders.
- `bill-session` takes exactly: `teams FOR KEY SHARE` (with the `is_payout_configured` read) -> `game_sessions FOR UPDATE` -> the hand-off reads (`registrations` and guests, unlocked) -> `player_credits FOR NO KEY UPDATE` (every needed wallet, one statement) -> `payments` (insert only) -> `credit_transactions` (insert; the trigger re-locks the wallet already held). `billing-races.int.test.ts` records the statements PostgreSQL received and asserts this order.
- No path locks an existing `payments` row and then a wallet. Later paths (top-up start and apply, attempt start and apply, reminders, `daily-overdue`, hold resolution) follow the same order and are tested where they land.
- **Order-inverting key share (recorded deliberately).** Inserting `payments` and `credit_transactions` takes `KEY SHARE` on the referenced `registrations` row after the wallet lock. `KEY SHARE` conflicts only with `FOR UPDATE` and key changes, and no registration path takes either (registrations are never deleted; updates are `NO KEY`), so the inversion cannot wait. It is the same kind of exception as ADR 0018's unlocked O6 read.
- **Payout block does not wait on billing.** The payout block takes `teams FOR NO KEY UPDATE`, which does not conflict with billing's `KEY SHARE`, so billing never waits on a block (ADR 0016, deliberate). A block committed while a billing transaction is already running does not undo that transaction: it completes whole, and the next session is held (B8). Both orders are raced in `billing-races.int.test.ts`.
- **Banking removal does wait.** A removal takes `teams FOR UPDATE`, which conflicts with billing's `KEY SHARE`. Either the removal waits and is then refused `banking_in_use`, or it runs first and billing inserts nothing. Both orders are raced against the real `bill-session` in `team-banking-gate.int.test.ts`, which replaced the test-only payment stand-in in Phase 2 (the stand-in is deleted).
- **Intent and attempt locks.** `wallet_top_ups` and `payment_attempts` rows are locked in the same order. An intent's `CREATING` row is inserted before the balance is read (CR-24), so a start never validates a stale headroom.

### 2. Single writers of money state (CR-5, CR-9, CR-8, CR-14, A4)

| State                                                                                                                            | Written only by                                                                                    |
| -------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| `payments` (insert with billing_type, status PENDING or PAID for PREPAID_CREDIT), `payment_line_items`, `billing_session_blocks` | `modules/billing/engine-repo.ts`                                                                   |
| `payments.status = 'OVERDUE'`                                                                                                    | `modules/billing/overdue.ts` (the `daily-overdue` job)                                             |
| `payments` transition to PAID for an existing payment, and the 24 h grace write on `due_date`                                    | `modules/billing/apply-akahu-result.ts`                                                            |
| `payments` hold and payout-block side effects                                                                                    | `modules/billing/hold-resolution.ts`, `modules/billing/payout-block.ts`                            |
| `payment_attempts`, `wallet_top_ups` (intent state)                                                                              | `apply-akahu-result.ts`, `reconcile.ts`, `billing/attempts-repo.ts`, `wallet/top-up-repo.ts`       |
| `payment_reminders` (append-only)                                                                                                | `modules/billing/reminders.ts`                                                                     |
| `payout_block_events`, `teams.payout_blocked_at`                                                                                 | `modules/billing/payout-block.ts` (under `teams FOR NO KEY UPDATE`; banking columns never touched) |
| `player_credits`, `credit_transactions`                                                                                          | `modules/wallet/ledger.ts` only                                                                    |
| `game_sessions.status = 'COMPLETED'`                                                                                             | `bill-session`, through `engine-repo.ts`                                                           |
| `registrations`, `registration_guests`                                                                                           | `modules/registrations/repo.ts` only (billing and the wallet write none, C-ALL-1)                  |

Gateway (Akahu) calls are made only from `lib/akahu/start.ts`, the apply path, the cancel job, `overdue.ts` and `hold-resolution.ts`. `modules/billing/boundaries.test.ts` scans every non-test source under `apps/api/src` for writes to each table and for gateway calls, and fails on a writer outside its list. It also proves each rule detects a violation. `registrations/boundaries.test.ts` proves billing and the wallet write no `registrations` row.

Because `modules/sessions` keeps its own `lockSession` private (its boundary test), billing takes `game_sessions FOR UPDATE` through `lockSessionForBilling`, scoped to the team, in the same position of the order. **D-75 is not widened**: billing writes a session row once, in the PUBLISHED -> COMPLETED update the matrix already allows. The B8 hold writes a claim row in a billing-owned table, not the session.

### 3. The wallet ledger: trigger-maintained balance, one TypeScript writer (CR-5)

- `player_credits.balance` is changed only from inside the BEFORE INSERT trigger `credit_transactions_ledger_chain`, which refuses a ledger row whose `resulting_balance` is not the locked balance plus `amount`, or that leaves 0.00-100.00. A direct balance write is refused by a guard. The ledger is append-only.
- Type shapes are enforced in the table and in TypeScript: `TOPUP` is positive, with an applied top-up and an Akahu payment id, and no registration; `AUTO_DEDUCTION` is negative, with a registration and no top-up; `REFUND` is refused in v1 (B3). One `TOPUP` per Akahu payment and per top-up (partial uniques). One `AUTO_DEDUCTION` per registration.
- `wallet/ledger.ts` makes no decisions: `ensureWallet`, `lockWallets` and `applyMovement`. A movement is never clamped. A movement that would leave the range throws `WalletLedgerError('out_of_range')` and the caller's transaction rolls back. A top-up that does not fit is the caller's B3 case, decided before it reaches the ledger.
- A wallet row is created at 0.00 by `ensureWallet` only. A read never creates one; "no wallet" reads as 0.00 with nothing to lock.
- Invariant, proven under concurrency: balance equals the ledger sum, stays within 0.00-100.00, is never negative. `credit_transactions.created_at` is a transaction start time, so "latest row" is never found by timestamp; the proof is the sum and the chain.

### 4. The billing engine (Q4c, CR-9)

- **One transaction per session.** `bill-session` completes the session, inserts every payment and line item, takes every deduction and enqueues every email in one transaction (`SET LOCAL lock_timeout`). A replay finds the session COMPLETED and does nothing. `UNIQUE(registration_id)` on `payments` and one AUTO_DEDUCTION per registration are second guards. A failure rolls everything back, so nothing is half-billed (AC-ERROR-9). The deferred `payment_lines_match_header` check runs at COMMIT.
- **The clock is read once, after the locks** (P3). A session is billed only when `now >= ends_at`, and never before `starts_at` (C-BIL-3).
- **Exactly the hand-off.** Billing charges exactly `listBillableRegistrations` and prices each party from the snapshot (registrant sex and skill at confirmation, each guest's own) with the shared `unitFee` from the session's `fee_*` columns (C-SSE-1). It never reads `users.sex` or `team_members.skill_level` (C-BIL-1).
- **All or nothing per registration.** `decideSettlement` deducts when `gte(balance, total)`, and only then. Any shortfall, or no wallet, leaves a PER_GAME payment PENDING with a due date. A partial wallet payment is never taken.
- **GST snapshot (ADR 0016).** `insertCharge` copies `gst_registered`, the rate and `gst_number` (D-88) from `teams` in the statement that inserts the payment. `gst_amount` and `subtotal_amount` are generated columns (3/23 of the inclusive total, HALF_UP). Billing and wallet code use no `number`, `parseFloat` or `toFixed` (also a source scan).
- **Rulings applied.** B2: due date is the billing instant plus 72 hours, exactly. B5: a low-credit email after every deduction that leaves the balance below $20.00. B7: a party whose total is $0.00 is a PAID $0.00 PER_GAME row with no link, no email and no wallet movement. B8: see 5. B9: due sessions are selected oldest first, and the `bill-session` queue has local concurrency 1.

### 5. B8: a paid session of a team that cannot take payments is held

When `paid && !is_payout_configured` (read under the team `KEY SHARE`, C-BIL-PAY), billing writes nothing except a `billing_session_blocks` claim row (D-97) and enqueues one "Billing is paused" email per approved admin, once per session (the claim's `notified_at` is the once-only gate). The session stays PUBLISHED. The sweep skips a session that has a marker while its team is still blocked, so a held session does not re-run every five minutes. The first sweep after banking is saved again bills it normally. A free session writes no payment and completes whatever the team's state (the predicate is `isPaidSession`, the TypeScript twin of `game_session_is_paid`). Because the payout block does not wait on billing (1), a block can land while a billing transaction is running; that transaction completes whole, and the next session is held. Payment-attempt start applies C-BIL-PAY again at pay time (5a below), so a PENDING charge on a blocked team cannot be paid until banking is saved.

### 6. Jobs (CR-3, CR-12, CR-13, CR-25, CR-27)

| Queue               | Policy                                                                | Trigger and key                                                                   | Purpose                                                                                                                                                                                           |
| ------------------- | --------------------------------------------------------------------- | --------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `post-game-billing` | slot `*/5 * * * *` (interval sweep), also at worker boot              | none                                                                              | Enumerates due PUBLISHED sessions (`idx_game_sessions_billing_due`, oldest first). Enqueues one `bill-session` per session. Bills nothing, takes no lock. Logs counts (`billing.sweep.enqueued`). |
| `bill-session`      | `exclusive`, local concurrency 1                                      | `singletonKey = bill-session:<sessionId>`; payload `{ sessionId, trigger: 'sweep' | 'manual' }`                                                                                                                                                                                       | One transaction per session (section 4). A transient failure is rethrown for retry with backoff. An integrity failure (SQLSTATE class 23) ends the job failed at once as `NonRetryableJobError`. Logs `billing.session.failed` with ids, error class and SQLSTATE only. |
| `daily-overdue`     | slot `0 4 * * *` Pacific/Auckland, also at worker boot                | none                                                                              | Marks due PENDING payments OVERDUE after re-reading open attempts (section 12).                                                                                                                   |
| `akahu-sync`        | `stately`                                                             | `singletonKey = akahu-sync:<akahuPaymentId>` (one queued, one active)             | The single apply funnel for provider results (section 11).                                                                                                                                        |
| `akahu-cancel`      | `exclusive`                                                           | `singletonKey = akahu-cancel:<akahuPaymentId>`                                    | Best-effort cancel of a provider payment still READY: a superseded attempt, a payout block, or an orphan whose local intent is already closed.                                                    |
| `akahu-reconcile`   | `exclusive`; slot `*/15 * * * *`, interval sweep, also at worker boot | none                                                                              | Re-reads open intents that a webhook may have missed, and polls HELD and recently closed intents for finality (CR-25). At most 100 per run, 4 in parallel, stops on 429.                          |

Failed jobs retry 3 times with exponential backoff, then stay visible in `pgboss.job` with state `failed`. Every handler is idempotent: delivery is at-least-once, and each handler is backed by a unique constraint or a guarded transition.

### 7. Emails are sealed, and commit with the work (P5, CR-20)

Eleven templates, enqueued through `enqueueEmail(jobs, message, { trx, crypto })` inside the transaction that causes them, so each exists exactly when its cause commits (AC-ASYNC-4):

1. payment due (PER_GAME, sealed, links to `/payments/<id>`)
2. low credit (balance below $20.00)
3. overdue
4. manual reminder (admin action)
5. payment received (PER_GAME becomes PAID)
6. top-up received
7. payment not completed (only after the payer approved at the bank and the payment then failed)
8. held notice (player)
9. money received but not applied (B3; player and team admins)
10. payout blocked (approved admins, no account details)
11. billing paused (B8, admins)

Idempotency keys come from the cause (payment id, ledger row id, transition, session and admin), so a replay cannot send twice. Any payload carrying a link is sealed with FieldCrypto, so `pgboss.job.data` never holds a payment link in clear. Payment links point to the authenticated `/payments/<id>` page on the web origin and are not bearer capabilities (CR-7). Emails never carry an Akahu URL (A5). A $0.00 party gets no email (B7).

### 8. Observability and no leaks (AC-VERIFY-7)

Log events: `billing.sweep.enqueued`, `billing.session.completed`, `billing.session.blocked`, `billing.session.failed`, `billing.overdue.marked`, `billing.overdue.deferred`, `billing.reminder.sent`, `billing.payout.blocked`, `wallet.topup.started` / `credited` / `closed` / `overflow`, `akahu.request`, `akahu.webhook.accepted` / `rejected` (reason only), `akahu.reconcile.applied` / `stuck`. Fields are ids, counts, `MoneyString` amounts, status and `traceId`. They never carry a bank account name or number, an Akahu credential or token, a payment link or token, an email address, a name, a payment reference or a raw webhook body. New field names were checked against the global redaction keys first (learned rule `logging-redaction-global`). `billing-logs.int.test.ts` asserts the fields and the absence of secrets. The Akahu HTTP client propagates `traceparent`.

### 9. Payment identity, surfaces and reminders (CR-7, CR-8, CR-16, CR-17)

- **Payment identity.** Authenticated, payer-only `/payments/[paymentId]`, with a uniform 404 for the payer's team admins, other players and unknown ids. No bearer link works without sign-in (Q2).
- **Payment reference.** `payments.payment_reference` (D-89; `SGM` plus 8 Crockford base32 characters, UNIQUE, immutable, not secret) replaces `payment_link_token`. It is sent as the Akahu statement reference, so a team admin can match a bank line to a payment. Top-ups get the same kind of reference.
- **Reminders.** The append-only `payment_reminders` table (D-95, `change_key` unique) is the only record. `lastReminderAt` is derived from it, so `payments` gets no reminder columns and its immutability guard is not widened. The B6 cooldown is 24 h from the last manual reminder. A replay by `changeKey` is checked first. Reminders are refused 409 `payment_on_hold` while an attempt is HELD, and never for a settled payment (409 `payment_settled`).
- **Where a debt is paid (CR-16).** `/payments` ("Unpaid payments") lists the caller's PENDING, OVERDUE and held payments across teams, backed by `GET /payments/me?status=UNPAID`. `/payments/[id]` is the only place an attempt starts, and the team wallet page is the only place a top-up starts.
- **Read models (CR-17).** Latest attempt or top-up carries `outcome: 'processing' | 'cancelled' | 'failed' | 'held' | 'none'`. Payment reads and the admin list carry `onHold` and `payoutBlocked`. Ledger items carry the session location and start time. The wallet read carries the last closed top-up for the B3 notice. Team payment lists are cursor-paginated (`nextCursor`).
- **Admin list.** `GET /teams/:teamId/payments` (team admins and GLOBAL_ADMIN) returns names, never email addresses or bank details. Unpaid rows are ordered oldest-due first; PAID and ALL rows newest first; page size 50.
- **Admin surfaces.** The Payments manage area in each team, with a GLOBAL_ADMIN who is not a team admin seeing only that area under a "Viewing as a global admin" line (CR-21). `RefreshWhilePending` takes its copy as props (CR-22).

### 10. Top-up and payment intents (B1, B3, CR-1, CR-2, CR-6, CR-24)

- **One state enum.** `payment_intent_status` (D-90): CREATING, OPEN, HELD, APPLIED, UNAPPLIED, CLOSED, shared by `payment_attempts` and `wallet_top_ups`. CREATING, OPEN and HELD block a new intent: one blocking intent per wallet (D-92) and per payment (D-91). The transition matrix is `payment_intent_transition_allowed`, with a shared TypeScript fixture.
- **Provider status is kept separately.** The provider's own status stays in `akahu_status`. "Awaiting payer" is the provider's READY status, not a row state.
- **Gateway outcomes.** The gateway reports `OPEN | SUCCEEDED | NOT_CHARGED | INDETERMINATE | UNRECOGNISED`, mapped only in `lib/akahu/status.ts`. An indeterminate result, or a SENT amount that differs from the stored amount, sets HELD. A SENT that cannot be absorbed (over cap, duplicate, or late for a closed intent that no longer fits) sets UNAPPLIED with `unapplied_reason` (OVER_CAP, DUPLICATE, LATE, AMOUNT_MISMATCH). Nothing is credited beyond the cap, and there is no partial credit (B3).
- **Start order (CR-24).** tx1 inserts the CREATING row first, which claims the one blocking slot (a unique violation returns 409 `top_up_in_progress`). The transaction then reads the balance under `player_credits FOR SHARE` and checks B1 (minimum $1.00, headroom to $100.00). On failure the transaction rolls back with 422. The Akahu call happens outside any transaction and lock (A5, below). A failed tx2 is applied only by the funnel.
- **Creation (A5).** Create is an inline call between tx1 and tx2, outside any lock, and is never blindly retried. tx2 records the provider id and `authorisation_url` (stored sealed with FieldCrypto, AAD per row, CR-6). Reconcile or the orphan job is the safety net. A 409 `payment_in_progress` or `top_up_in_progress` returns the stored resume URL while it has time left, otherwise the old link is cancelled and replaced. Expiry defaults to 30 minutes (`AKAHU_PAYMENT_EXPIRY_MINUTES`).
- **Per-call payee (B10, A1).** The team's account name and number are decrypted only in memory, for the one call that creates the payment. They are never logged or stored in clear. The payee is the team's account as it is when the player pays.
- **Provider limits (A5).** Bank limits are read at runtime and never hard-coded. A provider refusal answers 422 `payment_provider_refused` with a reason (`payee_unusable`, `amount_over_bank_limit`, `payer_bank_unavailable`). The payout check runs before idempotency-key replay.

### 11. One apply funnel (CR-3, CR-26, H2)

- Every provider result is applied only by the `akahu-sync` job, through `apply-akahu-result.ts`. The job re-reads the provider outside any transaction, then runs the pure decision table under the locks. The webhook, reconcile, start-path failures and the return-page GETs only enqueue (GETs at most once per 5 s per open intent). No request handler applies a result inline.
- Reconcile currently calls the same guarded funnel function directly, bounded to 4 in parallel (recorded deviation, see Deviations). A concurrency test asserts one PAID and one email under three concurrent syncs.
- **Webhook as signal.** The webhook is verified, and then the truth is the provider's payment read plus `akahu-reconcile`. Correlation uses only the stored payment id, never URL parameters. Unknown payment ids are ignored. The webhook answers 2xx promptly, without doing the apply work inline (A4; the exact time budget is part of the Phase 4b re-read).
- **Holds (A2, CR-26).** A hold is an intent in HELD with `hold_reason` (INDETERMINATE or AMOUNT_MISMATCH). The payment is not payable while held: no new attempt, no pay button, no "You haven't been charged" wording, and the copy reads "Under review" (CR-18).
- **Hold resolution (H2, CR-15, CR-26).** Team admins of the payee team, or a GLOBAL_ADMIN, may resolve a hold with `RECEIVED` or `NOT_RECEIVED`, through `POST /payments/:paymentId/hold-resolution` or `POST /teams/:teamId/wallet/top-ups/:topUpId/hold-resolution` (strict body `{ outcome, changeKey, observedAmount? }`). Every resolution first re-reads the provider inline. A definite provider status wins, and the manual outcome is refused (409 `hold_resolved_by_provider`). `NOT_RECEIVED` is allowed only when the fresh read is still indeterminate or not SENT. An AMOUNT_MISMATCH hold can be resolved RECEIVED only when `observedAmount` equals the intent amount; otherwise the intent becomes UNAPPLIED (AMOUNT_MISMATCH), notified and refunded by the team outside the app. `resolved_by`, `resolved_at`, `resolution_reason` and `observed_amount` are audited. There is no free text. There is no web UI for top-up holds in v1 (the route and `cli billing reconcile` listing are the surface).
- **Finality (CR-25).** Reconcile also re-reads HELD intents and CLOSED intents that have a provider id, with backoff (hourly, then daily), until `AKAHU_FINALITY_HORIZON_HOURS` (default 168) has passed since close or hold. A late SENT then follows the absorb rule above. A second successful payment is recorded as UNAPPLIED (DUPLICATE) and surfaced, never silently credited.
- **Credit once, PAID once.** A top-up credit runs through `ledger.ts` once per Akahu payment. A payment becomes PAID once, guarded by its status. Replays and webhook-versus-reconcile races are tested with real connections.

### 12. Overdue decision (H1, CR-27)

`daily-overdue` decides on fresh state, not on the stored mirror:

1. Select candidates: PENDING with `due_date <= now`, in batches of 200.
2. For candidates with an OPEN attempt, re-read the provider outside any transaction (bounded parallelism, same 429 stop as reconcile). Apply each result through the funnel's decision table before deciding. A failed re-read leaves that payment untouched for this run and logs `billing.overdue.deferred`. A payment is never flipped on stale data.
3. Skip a payment whose attempt is then HELD, or OPEN with the provider reporting it as authorised or submitted (submitted includes the pending and settlement-in-progress reasons). A READY-only open attempt does not protect the payment, so a link opened at 03:59 cannot defer the debt.
4. Flip the rest with a guarded update, one email per transition.

**Grace.** When an attempt closes after the payer authorised, or a hold is resolved NOT_RECEIVED, the same transaction sets `payments.due_date = greatest(due_date, now + 24 h)` for a PENDING payment. An OVERDUE payment is not moved back to PENDING. The "payment not completed" email states the new due date. Grace never shortens a due date.

**Payout-blocked teams** are not skipped: their due dates are unchanged. OVERDUE is written only by this job (a grep test enforces it), and the registration debt gate counts OVERDUE rows across all of the user's teams (C-BIL-2).

### 13. Payout block (ADR 0016 R3, A3, CR-14)

- **Trigger.** Akahu does not document a "destination account rejected" signal (A3), so the block is a manual action by a GLOBAL_ADMIN: `POST /teams/:teamId/payout-block`, strict body `{ reason, akahuPaymentId?, changeKey }`, with an enum reason (AKAHU_REPORTED_ACCOUNT_PROBLEM, FUNDS_RETURNED, TEAM_REQUESTED, OTHER) and no free text. The response is `{ payoutBlockedAt, alreadyBlocked }`. A `FAILED/REJECTED` provider result never sets `payout_blocked_at`. An automatic trigger for `invalid_payee` is added only if MVE-003 shows it means a bad account (Open section).
- **Effect.** In one transaction the route takes `teams FOR NO KEY UPDATE`, sets `payout_blocked_at = now()` (if not already set), appends a `payout_block_events` row, enqueues one email per approved admin, and best-effort cancels the team's OPEN or READY intents through `akahu-cancel`. `is_payout_configured` becomes false. Banking columns are never touched. A second block appends an audit event, keeps the first instant and sends no email.
- **While blocked.** Top-up and attempt starts answer 409 `payout_not_configured` (C-BIL-PAY, both routes), and the admin "Send reminder" action is hidden. Publishing a paid session answers 409 `payout_not_configured` (ADR 0016).
- **Clearing.** There is no unblock action. Re-saving the banking details clears `payout_blocked_at` (team-banking behaviour). Held sessions bill on the next sweep after that.
- **Player copy.** "This team can't receive payments right now. We've told the team admins."
- **CLI.** `cli billing block-payout <teamId> <REASON> [akahuPaymentId] --as <email>` was built in Phase 6 beside the GLOBAL_ADMIN route. `--as` is required and must name a GLOBAL_ADMIN, who is recorded as `actor_user_id` like the route's caller; otherwise it exits 1 and writes nothing.

### 14. Configuration and adapter selection (P7, A6, CR-12)

- The adapter is chosen only by `PAYMENTS_ADAPTER=akahu|fake`, default `fake`. The fake is refused when `NODE_ENV=production`. `akahu` refuses to boot ("is not available in this build") until the live adapter ships (Phase 4b). A production boot is therefore refused until then.
- Akahu settings are validated at boot with a named error that never prints a value: `AKAHU_APP_TOKEN`, `AKAHU_APP_SECRET`, `AKAHU_PAYMENTS_API_URL` (https and a `.akahu.io` host in production), `AKAHU_WEBHOOK_URL` (http(s), no query string, https in production), `AKAHU_PAYMENT_EXPIRY_MINUTES` (15-120, default 30), `AKAHU_RECONCILE_ORPHAN_AGE_SECONDS` (30-3600, default 120), `AKAHU_RECONCILE_MIN_AGE_SECONDS` (60-3600, default 300), `AKAHU_RECONCILE_STUCK_AFTER_SECONDS` (3600-604800, default 21600), `AKAHU_FINALITY_HORIZON_HOURS` (1-720, default 168). They are listed in `.env.example` and in `docs/getting-started.md`.
- Business constants are code, not environment: wallet cap $100.00 (`WALLET_CAP`), top-up minimum $1.00 (`TOP_UP_MINIMUM`), low-credit threshold $20.00 (`LOW_CREDIT_THRESHOLD`), due window 72 h (B2), reminder cooldown 24 h (B6), debt threshold 3 (unchanged from ADR 0018). `packages/shared/src/billing/wallet-limits.ts` is the source; the web copy of the reminder cooldown and debt limit is a recorded duplication.

### 15. Retention and privacy

Financial rows (payments, line items, ledger, intents, reminders, payout events) are kept 7 years; their foreign keys are RESTRICT. No bank detail, email address, token or payment link appears in logs, job payloads in clear, or admin views. Names are shown, not emails.

### 16. Upstream contracts honoured

ADR 0018 C-BIL-1 to C-BIL-3 and C-ALL-1; ADR 0016 C-BIL-PAY, R3 and the GST snapshot (including `gst_number`, D-88); ADR 0019 D-75 (not widened) and `LOCK_ORDER`; ADR 0004 (sweep plus singleton jobs), ADR 0009 (exact money), ADR 0012 (line items and idempotency keys). The upstream suites (`boundaries.test.ts`, `registrations-billing-handoff.int.test.ts`, `sessions-contracts.int.test.ts`) pass unchanged.

## Contracts this ADR exports

- **C-WAL-1**: only `wallet/ledger.ts` writes `player_credits` and `credit_transactions`. The trigger maintains the balance; a caller decides, the ledger moves.
- **C-BIL-4**: only `bill-session` completes sessions; only `daily-overdue` writes OVERDUE; a PAID transition of an existing payment only in the apply funnel; `payments` rows are written only from the files the structural test lists.
- **C-BIL-5 (read models)**: built in Phases 3-5 (`modules/wallet/read.ts`, `modules/billing/player*.ts`). player-dashboard and admin-reporting-dashboard consume them.
- **C-INV-1 (invoice snapshot)**: this feature stores the GST snapshot, including `gst_number`, for tax-invoices-and-exports. It never sets `is_tax_invoice_issued`. Invoice numbering and PDFs are out of scope.

## Deviations and deferrals recorded during the build

Recorded in the task file's Deviations ledger. Each is a deferral or a known gap; none changes a decided ruling.

- Phase 2: AC-VERIFY-3's literal ordering ("removal commits first, billing inserts nothing") is unreachable while a paid PUBLISHED session exists. It is proven through a committed payout block (B8 hold) instead. Accepted by the phase reviewer.
- Phase 3: a Codex P1 is deferred. The actor's team role is checked by the route policy, not re-checked inside the reminder transaction, matching other team routes. The window is one request; revisit with the other team routes if a demotion race matters.
- Phase 4a: reconcile calls the guarded funnel directly (bounded parallel, stops on GatewayUnavailable), rather than enqueueing `akahu-sync` as CR-3 wording says. Still a single funnel. A follow-up test (Phase 6) adds a literal webhook-enqueued `akahu-sync` race against reconcile for the same provider id.
- Phase 4a: there is no `stuck_at` column, so `akahu.reconcile.stuck` is logged on each hourly re-read. A provider `not_found` read does not advance `last_synced_at`, so such an intent is re-read every 15 minutes until the finality horizon. Deferred to Phase 4b, because the fix needs a write from the funnel.
- Phase 4a: a replayed payout-block `changeKey` derives its response from the current `payout_blocked_at`, so it can differ after banking is re-saved and the team is blocked again. Persist the first answer if this matters.
- Phase 4a: the hold-resolution route has no change-key column; replay is keyed on the stored resolution reason. A resolution on a non-held intent answers 409 conflict.
- Phase 4a: `cli billing block-payout` was not built in 4a; it landed in Phase 6 with `cli billing reconcile`.
- Phase 4a: an expired open link enqueues `akahu-cancel` and answers 409 with `redirectUrl: null` (no inline refresh). The player clicks again after the cancel job.
- Phase 5: `GET /teams/:teamId/wallet` has no `payoutBlocked` field, so the top-up form is not hidden in advance; a start answers `payout_not_configured` after the fact. Follow-up in Phase 4b or 6.
- Phase 5: the read model does not expose `hold_reason`, so the hold panel always shows the `observedAmount` field, and the API enforces CR-26 with a 422 field error.
- Phase 5: the top-up field messages follow the API strings rather than the UI/UX copy table. Align them in a later phase.
- Phase 5: the web copy of the reminder cooldown and debt limit is a duplicate of the API constants (move to `packages/shared`).
- Phase 5: a wallet or payment 403 renders the uniform not-found, not the UI/UX "You need to be a member" copy, except the wallet page's member-only sentence in the team shell (fixed in remediation).
- Phase 6 (documentation pass): the Phase 6 CLI, E2E and coverage items are described in this ADR and the operations guide as they are specified. They are verified only when they land. See `docs/getting-started.md` for the operator procedures.

## Open pending Phase 4b (Akahu-gated)

Phase 4b (live Akahu adapter and sandbox fixtures) is **not built**. It is gated on three things: Akahu's written answer to MVE-001 (go or no-go), sandbox credentials (MVE-002), and a verified signed sandbox webhook stored as a fixture (MVE-005). Until those arrive, the items below are open. This ADR asserts no outcome for any of them. No Akahu documentation was re-read for this revision, so no retrieval date is recorded.

1. **Live adapter.** `apps/api/src/lib/akahu/live-adapter.ts` (thin REST client over the existing `FetchLike`/`providerFetch` pattern, manual `traceparent`, 429 backoff, no `akahu` npm dependency). `PAYMENTS_ADAPTER=akahu` stays refused at boot until it exists.
2. **Byte-level re-read.** The auth header, the webhook signature headers, the padding scheme and the signing-key retrieval and rotation are re-read from Akahu's live pages at the Phase 4b gate (A4, A7). The spike read them through digests, so they are not yet verified.
3. **Status mapping.** The AUTHORISED and SUBMITTED mapping, the READY mapping, and the whole provider status set are re-checked against live documentation (Phase 1 note, A2). The FAILED reason set is re-verified, with particular attention to `INTERNAL_ERROR` before approval (Phase 4a phase review). `decideHoldGate` treats NOT_CHARGED and SUCCEEDED as definite and is re-checked against the real semantics.
4. **Payee charset and `invalid_payee`.** The permitted payee characters and the meaning of `invalid_payee` (MVE-003). The automatic payout-block trigger is added only if MVE-003 shows it means a bad account, which needs a migration because `payout_block_reason` has no `AKAHU_INVALID_PAYEE` value.
5. **Bank error indeterminate.** The handling of `BANK_ERROR_INDETERMINATE` (MVE-004). The hold design in section 14 applies to it. The exact resolution path is not yet decided.
6. **Cancel and timeout fixtures.** Recorded fixtures for cancel and timeout behaviour (MVE-006).
7. **Fixture provenance.** Synthetic and vendor-doc-derived fixtures are replaced by sandbox-real fixtures where they exist (A7). Each fixture carries its provenance. The Phase 4a suites are re-run against the recorded sandbox fixtures.
8. **Production boot.** `PAYMENTS_ADAPTER=akahu` must become bootable, which clears the Phase 1 production-boot note. Until then a production image cannot start.
9. **Payee-verification liability.** If the MVE-001 answer brings a payee-verification liability term, the human rules on verifying team bank details at save time before this ADR is accepted.
10. **Fee model (A8, U8).** The Akahu fee model is outside rulings B1-B10 and needs a human ruling after the quote.
11. **Re-plan trigger.** A negative MVE-001 answer stops Phase 4b and re-plans it (U10 platform-first settlement or U11 other vendors). It may also rework the Akahu-specific status mapping in 4a, which is an accepted risk (A9).

Phases 1-3 and 5 use only the provider-neutral port and the fake adapter, and do not depend on any item above.
