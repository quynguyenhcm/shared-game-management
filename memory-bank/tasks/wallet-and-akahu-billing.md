---
slug: wallet-and-akahu-billing
feature: wallet-and-akahu-billing
status: PLANNING_COMPLETE
---

# wallet-and-akahu-billing: Wallet and Akahu Billing

**Complexity**: Level 4 (inherited from wallet-and-akahu-billing)
**Status**: PLANNING_COMPLETE
**Roadmap**: wallet-and-akahu-billing
**Branch**: feature/wallet-and-akahu-billing
**Worktree**: ~/yay-wt/shared-game-management/feature-wallet-and-akahu-billing

## Task Description

Prepaid wallet, post-game billing and payment collection via Akahu (PRODDUCT-OVERVIEW §7; workflows §3).

- Wallet per (player, team); top-up via Akahu direct payment; balance capped at $100.00 NZD
- Akahu routes every payment to the team's configured bank account; webhook handling (idempotent, signature-verified)
- Post-game engine at MAX(court end_time): session → COMPLETED; for each confirmed registration compute the fee (pricing model + guests), deduct from the wallet if the balance covers it (`PAID`, `PREPAID_CREDIT`), otherwise create an Akahu payment link due in 3 days
- Low-credit reminder when the balance drops below $20.00 after a deduction
- Daily cron: unpaid → `OVERDUE` after 3 days, plus reminder notifications
- Manual "send reminder" action for team/global admins
- Wallet ledger (`credit_transactions`) with resulting balances; reconciliation

**Depends on**: registration-and-waitlist (merged 2026-10-30, PR #8)

## Specification

**Feature Type**: End-User Feature
**Primary Persona**: Player (`PLAYER`, an APPROVED member of a team) who tops up a prepaid wallet for that team, is charged automatically after each game, and pays any remaining charge through an Akahu pay-by-bank link. Secondary: Team Admin (`TEAM_ADMIN`), who sees the team's payments, sends reminders and is told when Akahu refuses the team's payout account; Global Admin (`GLOBAL_ADMIN`), who can send reminders for any team. Downstream consumers: tax-invoices-and-exports (payment rows, GST snapshot, `gst_number`), player-dashboard (wallet and payments read models), admin-reporting-dashboard (payments list and the reminder action).
**Creative Exploration Needed**: Yes. Architecture, user-journey and UI/UX creative are required for Level 4 anyway. LOW confidence: what Akahu can actually do for a one-off payment to a third-party account (hosted payment request vs. OAuth-connected payment initiation), its webhook signature scheme and event shape, the wallet top-up intent model under the $100 cap, and the player-facing surface (overlap with player-dashboard). MEDIUM: the post-game engine, the ledger and lock order, the overdue job, because ADR 0004, 0012, 0016, 0018 and 0019 already fix most of the contract. Several product-policy choices are listed as named human rulings (B1-B10 below) and must be ruled before build.

*Note: like registration-and-waitlist, this End-User spec also delivers cross-cutting infrastructure (the post-game billing engine, an Akahu gateway, the webhook receiver, the wallet ledger, the overdue job). Following the project precedent set by registration-and-waitlist and team-banking-and-gst, the structural checks are written as `AC-VERIFY`, `AC-ASYNC` and `AC-INTEGRATION` criteria.*

*Basis for this draft* (read from `main` at `0e291fc`, which contains every feature up to registration-and-waitlist):
- **Schema already present, no billing code.** `player_credits` (`db/migrations/20260929000800000_wallet.sql`): one row per `(user_id, team_id)` (`uq_player_credits_user_team`), `balance numeric(10,2)` with CHECK `BETWEEN 0.00 AND 100.00`. `credit_transactions`: `amount <> 0`, `transaction_type credit_transaction_type` (`TOPUP`, `AUTO_DEDUCTION`, `REFUND`), `akahu_payment_id`, `registration_id` (composite FK to `registrations (id, user_id, team_id)`), `resulting_balance` with the same 0-100 CHECK, FK to the wallet row (so the wallet row must exist before the first movement), and partial unique `uq_credit_tx_auto_deduction_per_registration` (one AUTO_DEDUCTION per registration). `payments` (`...000900000_payments_and_invoicing.sql`): `team_id`, `registration_id` (`uq_payments_registration`, the idempotent billing key), `billing_type` (`PER_GAME` default, `PREPAID_CREDIT`), GST snapshot (`pricing_structure`, `gst_registered`, `gst_rate_bps`, generated `gst_amount`/`subtotal_amount`), `amount >= 0`, `status payment_status` (`PENDING`, `PAID`, `FAILED`, `OVERDUE`), `payment_link_token varchar(255) UNIQUE NOT NULL`, `akahu_payment_id`, `due_date NOT NULL`, `paid_at` (CHECK `paid_at IS NOT NULL` iff PAID), invoice columns (tax-invoices-and-exports). `payment_line_items`: one append-only row per party (position 0 registrant, 1-2 guests), `applied_basis fee_basis`, `party_sex`, `party_skill_level`, `unit_fee`; the deferred trigger `payment_lines_match_header` requires a registrant line and `sum(unit_fee) = amount` at COMMIT. `payments_guard_immutable` freezes the snapshot columns but **allows `status`, `paid_at`, `akahu_payment_id` and `due_date` to change**. There is **no status-transition guard** on `payments` and **no `gst_number` column** yet.
- **Contracts this feature must honour** (each consumer's plan must cite them; the build gate re-checks them):
  - **ADR 0018 C-BIL-1** (`docs/adr/0018-registration-allocation-and-billing-handoff.md` section 8): at session end lock the session `FOR UPDATE`, move it to COMPLETED, bill exactly `listBillableRegistrations(trx, sessionId, now)` (`apps/api/src/modules/registrations/billing-handoff.ts`), one payment per returned registration, `guests[].guestId` for `payment_line_items.registration_guest_id`, priced from the snapshot (`registrantSex`, `registrantSkillLevel`, each guest's `sex`/`skillLevel`), never from `users.sex` or `team_members.skill_level`. The list already leaves out registrants BANNED at or before `starts_at` (O6), is empty for any status other than PUBLISHED/COMPLETED, requires a transaction and throws `before_start` when `now < starts_at`.
  - **C-BIL-2**: the debt gate counts OVERDUE across all of the user's teams (`countOverdueByUser`, `modules/registrations/repo.ts:159`); **only billing's `daily-overdue` job writes OVERDUE**.
  - **C-BIL-3**: `withdrawal_fee_due` is read-only for billing and final at `starts_at`; never bill before `starts_at`.
  - **C-ALL-1**: never write `registrations` (the structural test `modules/registrations/boundaries.test.ts` fails otherwise); lock order `teams -> recurring_session_rules -> team_members -> game_sessions -> registrations -> registration_guests -> payments` (`LOCK_ORDER`, `apps/api/src/modules/sessions/locks.ts`).
  - **ADR 0016 C-BIL-PAY** (`docs/adr/0016-team-banking-and-publish-gate.md`): every payment-creation path takes `teams FOR KEY SHARE` and checks `is_payout_configured` before inserting any payment row; on failure it inserts nothing and fails cleanly with `payout_not_configured`. `apps/api/test/helpers/payment-stand-in.ts` is the test model that billing's real path replaces, raced against a banking removal in both orders (`apps/api/test/integration/team-banking-gate.int.test.ts`).
  - **ADR 0016 `payout_blocked_at` obligation (R3)**: when Akahu declines a payout because of the destination account, set `teams.payout_blocked_at = now()` under `teams FOR NO KEY UPDATE`, notify the admins, and never touch the banking columns. `is_payout_configured` is generated and cannot be written.
  - **ADR 0016 GST snapshot obligation**: add `payments.gst_number` and copy `teams.gst_number` at charge time, in the same statement that reads `gst_registered` and the rate (`GST_RATE_BPS`, `packages/shared/src/nz/gst.ts`). `team_banking_in_use(team)` (PENDING or OVERDUE payments block banking removal) may be widened by replacing that one function (for example to `FAILED`).
  - **ADR 0019** (`docs/adr/0019-session-scheduling-engine.md`): COMPLETED is reachable only through billing; the lifecycle trigger (D-75) allows PUBLISHED -> COMPLETED and makes COMPLETED rows immutable. A column billing must write on a COMPLETED row needs the D-75 allowlist widened in billing's migration and recorded in billing's ADR.
  - **ADR 0004**: post-game billing is a 5-minute sweep that enqueues one `bill-session` job per due session with a `singletonKey`; every handler is idempotent (at-least-once delivery). **ADR 0009**: `numeric(10,2)` in the DB, `MoneyString` on the wire, `Money` (bigint cents) in TypeScript, HALF_UP. **ADR 0012**: line items and idempotency keys as above. **ADR 0007**: long-lived worker container, secrets from the platform store.
- **Existing infrastructure to reuse:** queue names `post-game-billing` and `daily-overdue` with `exclusive` policy (`apps/api/src/jobs/registry.ts`) and their cron slots `*/5 * * * *` (interval sweep) and `0 4 * * *` Pacific/Auckland (`apps/api/src/jobs/schedules.ts`), both still `placeholderHandler` in `apps/api/src/jobs/bootstrap.ts`; `enqueueEmail(runner, message, { trx, crypto })` (`apps/api/src/jobs/send-email.ts`) with FieldCrypto sealing for secret-bearing emails; `Notifier` (`apps/api/src/lib/notifications/notifier.ts`, `smtp`/`memory` adapters); `NonRetryableJobError`; `Clock`/`createManualClock` (`apps/api/src/lib/clock.ts`); `FieldCrypto` (`apps/api/src/lib/crypto/crypto.ts`) to decrypt the team's payee name and number at payment time; `lockTeamRow`/`findApprovedRole` (`apps/api/src/modules/teams/admin-lock.ts`); `requireTeamRole(role, { allowGlobalAdmin })` (`apps/api/src/lib/auth/policy.ts`); `unitFee`/`estimateTotal`/`SessionFeeColumns` (`packages/shared/src/registrations/fees.ts`); `Money`, `parseMoney`, `toMoneyString`, `formatNZD`, `sum`, `lt`, `subtract` (`packages/shared/src/money/money.ts`); `MANAGE_AREAS` (`apps/web/src/lib/teams/manage-areas.ts`: People, Banking and GST, Sessions); `ConfirmDisclosure` (`apps/web/src/components/teams/confirm-disclosure.tsx`); `RefreshWhilePending` (`apps/web/src/components/teams/refresh-while-pending.tsx`); `apiClient` (`apps/web/src/lib/api-client.ts`); `proxy.ts` `PROTECTED` list; the Origin check (`apps/api/src/lib/http/origin.ts`) lets a request with no `Origin` through, so a server-to-server webhook is not refused by it. Test helpers: `insertTeam({ payoutConfigured })`, `payoutBlockFor`, `insertPublishedSession`, `advanceSessionTo`, `insertRegistration`, `insertGuest`, `insertPaymentRows`/`insertPayment`, `insertBilledRegistration`, `insertWallet` (`apps/api/test/helpers/factories.ts`), `waitForLockWaiters`, `captureLogs`, `createTestDatabase`, `worker-fixture.ts`.
- **Nothing Akahu exists yet.** No Akahu client, config key or route exists in `apps/` or `packages/`. `teams.akahu_merchant_id` and `teams.akahu_app_token` are reserved columns; ADR 0016 rejected per-team Akahu credentials ("the payee in Akahu's model is an account number and name"), so this draft assumes **platform-level Akahu app credentials in the environment** and the team's bank account as the payee of every payment.
- **No player wallet or payments page exists.** player-dashboard (L2, depends on this feature) owns the cross-team three-tab dashboard. admin-reporting-dashboard (L2) owns the cross-team master report and reuses this feature's reminder action. This feature therefore ships the APIs plus the smallest pages that make each journey usable and testable end to end (see creative question 5).
- **Highest ids in use:** ADR 0019, ledger D-86. This feature takes **ADR 0020** (`docs/adr/0020-wallet-and-akahu-billing.md`) and **ledger D-87 onwards** in `db/schema-deviations.md`.

### Invocation Method
- **Location**: Web app (Next.js App Router), API (Fastify), worker (pg-boss) and an inbound Akahu webhook.
  - **Player wallet page** `/teams/[teamId]/wallet` (new, protected; `proxy.ts` `PROTECTED` gains `/teams/*/wallet`). Heading "Wallet and payments", then a "Wallet" section (balance, top-up form) and a "Payments" section (this team's payments for the caller, grouped Overdue, Pending, Paid). Reached from a new line on the team page `/teams/[teamId]` (`apps/web/src/app/teams/[teamId]/page.tsx`), rendered only for APPROVED members next to `UpcomingSessions`: "Wallet: {formatNZD(balance)} · Top up or pay". **LOW confidence** on placement (creative question 5).
  - **Payment page** `/payments/[paymentId]` (new, protected): the target of every payment email ("Pay now"). It shows the session (team, location, date), the amount, the line items, the due date and the status, with a "Pay {amount} with Akahu" button while the payment is PENDING or OVERDUE. Only the payer can open it; anyone else gets the not-found page. **MEDIUM confidence** (the authenticated id-based link is this draft's default; a bearer `payment_link_token` link usable without sign-in is the alternative, creative question 2).
  - **Akahu return pages**: Akahu redirects the browser back to `/payments/[paymentId]?return=1` or `/teams/[teamId]/wallet?topUp=<topUpId>`, which show the processing state (AC-ASYNC-2).
  - **Team admin "Payments" area** `/teams/[teamId]/manage/payments` (new; `MANAGE_AREAS` gains `{ id: 'payments', label: 'Payments', segment: 'payments' }`). A table of the team's payments (player name, session date, amount, status, due date, last reminder) filtered by status (default "Unpaid": PENDING and OVERDUE), each unpaid row with a "Send reminder" button. A GLOBAL_ADMIN may open it for any team (the page guard and route use `allowGlobalAdmin: true`, unlike banking).
  - **API** (new modules, final split decided in architecture creative; proposed `apps/api/src/modules/wallet/`, `apps/api/src/modules/billing/`, and `apps/api/src/lib/akahu/` for the gateway adapter; every route declares a policy, money is `MoneyString`, instants ISO-8601 UTC, `cache-control: no-store`):
    - `GET /teams/:teamId/wallet` (`requireTeamRole('MEMBER')`) returns `{ wallet: { balance, cap: '100.00', headroom, lowCreditThreshold: '20.00', pendingTopUp: null | { id, amount, status, createdAt } }, transactions: [{ id, type, amount, resultingBalance, createdAt, sessionId? }], nextCursor }`. A member with no wallet row gets balance `0.00` (no row is created by a read).
    - `POST /teams/:teamId/wallet/top-ups` (`requireTeamRole('MEMBER')`), strict body `{ amount: MoneyString, idempotencyKey: uuid }`, returns 201 `{ topUp: { id, amount, status: 'AWAITING_PAYER' }, redirectUrl }` (the Akahu URL the browser follows). A repeat with the same key returns the same top-up.
    - `GET /teams/:teamId/payments/me` (`requireTeamRole('MEMBER')`) returns the caller's payments in that team `{ payments: [{ id, sessionId, sessionStartsAt, location, amount, status, billingType, dueDate, paidAt, reason: 'CONFIRMED' | 'LATE_WITHDRAWAL' }] }`.
    - `GET /payments/:paymentId` (`authenticated()`, payer only; any other caller, and an unknown id, gets the same 404 `not_found`) returns `{ payment: { id, teamName, session: { location, startsAt }, amount, gstAmount, lines: [{ position, basis, unitFee }], status, billingType, dueDate, paidAt, attempt: null | { status, startedAt } } }`.
    - `POST /payments/:paymentId/attempts` (`authenticated()`, payer only), strict body `{ idempotencyKey: uuid }`, returns 201 `{ redirectUrl }`; 409 `payment_settled` when PAID; 409 `payment_in_progress` with the existing attempt when one is still open.
    - `GET /teams/:teamId/payments?status=UNPAID|PENDING|OVERDUE|PAID|FAILED&cursor=` (`requireTeamRole('TEAM_ADMIN', { allowGlobalAdmin: true })`) returns `{ payments: [{ id, player: { userId, fullName }, sessionStartsAt, amount, status, dueDate, paidAt, lastReminderAt }], nextCursor }`. No email address and no bank detail in the response.
    - `POST /teams/:teamId/payments/:paymentId/reminders` (`requireTeamRole('TEAM_ADMIN', { allowGlobalAdmin: true })`), strict body `{ changeKey: uuid }`, returns 202 `{ sent: true, lastReminderAt }`; 409 `payment_settled`, 409 `reminder_too_soon` (B6), 404 for a payment of another team.
    - `POST /webhooks/akahu` (`publicRoute()`): raw body kept for signature verification; 401 on a bad or missing signature; 200 for a verified event whether or not it changed anything. The handler treats the event only as a signal and re-reads the payment from Akahu before changing state (MEDIUM, creative question 1).
  - **Jobs** (`apps/api/src/jobs/`): the real `post-game-billing` sweep (replaces the placeholder) selects PUBLISHED sessions with `ends_at <= now` and enqueues one `bill-session` job each (new queue, `exclusive`, `singletonKey = bill-session:<sessionId>`); the `bill-session` handler; the real `daily-overdue` handler (replaces the placeholder, 04:00 Pacific/Auckland); a new `akahu-reconcile` interval sweep (proposed every 15 minutes) that re-reads open top-ups and payment attempts older than a threshold from Akahu (AC-ASYNC-3). All emails go through `send-email`. Manual runs: `pnpm run jobs:trigger post-game-billing`, `... bill-session '<json>'`, `... daily-overdue`, `... akahu-reconcile`.
- **Element**: copy and controls (final copy from UI/UX creative):
  - Wallet section: "Balance: {formatNZD(balance)}" and "You can top up to {formatNZD(headroom)} more (wallet limit $100.00)." Form: label "Top-up amount (NZD)", text input `inputmode="decimal"`, button "Top up with Akahu". At headroom 0.00 the form is replaced by "Your wallet is full."
  - Payment rows: "{Location}, {Wed 7 Oct}" · amount · status tag ("Paid from wallet", "Paid", "Due {Sat 10 Oct}", "Overdue since {Sat 10 Oct}") · "Pay now" link to `/payments/[id]` for PENDING and OVERDUE.
  - Payment page button: "Pay {amount} with Akahu"; settled: "Paid on {date}."
  - Admin row button: "Send reminder", which opens a `ConfirmDisclosure` ("Email {player first name} a reminder for {amount}?" with "Send reminder" and "Cancel"); after success the row reads "Reminder sent {time}".
- **Visibility**: The team-page wallet line, the wallet page and `GET .../wallet`/`.../payments/me` are for APPROVED members (TEAM_ADMIN included) only. "Pay now" appears only on PENDING and OVERDUE payments; a PAID or FAILED payment shows no pay action (FAILED semantics are ruling B4). The top-up form appears only when headroom > 0 and no top-up is open. The "Payments" manage area is visible to the team's admins and to a GLOBAL_ADMIN; "Send reminder" only on PENDING and OVERDUE rows. The API is the real check in every case.
- **Navigation**:
  - Top up: header "My teams" -> `/teams` -> team -> "Wallet: $x.xx · Top up or pay" -> `/teams/[teamId]/wallet` -> amount -> "Top up with Akahu" -> Akahu -> back to `/teams/[teamId]/wallet?topUp=<id>`.
  - Pay: payment email "Pay now" -> `/payments/[paymentId]` (anonymous: `/login?returnTo=%2Fpayments%2F<id>` and back) -> "Pay {amount} with Akahu" -> Akahu -> back to `/payments/[paymentId]?return=1`. The same page is reachable from the wallet page's "Pay now".
  - Admin: header "My teams" -> team -> "Manage" -> area nav "Payments" -> `/teams/[teamId]/manage/payments` -> "Send reminder". A GLOBAL_ADMIN types or follows the team URL (no cross-team admin UI until admin-reporting-dashboard).
  - Registration debt block ("You have {n} overdue payments...", registration panel): gains a link to the caller's payments (SHOULD; target depends on creative question 5, because overdue payments can be in other teams).
- **Confidence**: post-game engine, ledger, overdue job and reminder routes: MEDIUM to HIGH (contracts fixed by ADR 0004/0012/0016/0018/0019 and the existing schema). Akahu flow, redirect URLs, webhook handling, top-up intent model: LOW (creative questions 1-3). Page placement and the split with player-dashboard: LOW (creative question 5). Copy: MEDIUM.

### Success Criteria
- **User sees**:
  - After a confirmed top-up of $30.00 on a $0.00 wallet: "Balance: $30.00" and a ledger line "Top-up +$30.00 · balance $30.00". While Akahu has not confirmed: "Processing your top-up. This usually takes under a minute." with a Refresh link.
  - After a game, with enough credit: the payment shows "Paid from wallet" and the balance falls by the fee. If the new balance is under $20.00, an email "Your {Team} wallet is running low ({balance})" with a link to the wallet page.
  - After a game, without enough credit: an email "Payment due: {Team}, {Wed 7 Oct}, {amount}, due {Sat 10 Oct}" with "Pay now"; the wallet page lists the payment as "Due {Sat 10 Oct}"; the wallet balance is unchanged.
  - After paying through Akahu: "Paid on {date}." on the payment page, the row moves to Paid, and the overdue count shown by the registration panel drops.
  - After the due date passes unpaid: the row reads "Overdue since {date}" and an email "Overdue: {Team}, {amount}" arrives. Three or more OVERDUE payments block new registrations (existing gate).
  - A team admin who clicks "Send reminder" sees "Reminder sent {time}"; the player receives "Reminder: {amount} for {Team}, {Wed 7 Oct}".
  - When Akahu rejects the team's payout account: every approved admin gets "Payments to {Team}'s bank account are failing" (no account name or digits); the Banking and GST page shows the existing blocked notice; new paid sessions cannot be published until the account is re-saved.
- **Verifiable at**: the wallet page, payment page and Payments manage area; the API routes above; the rows below; `pgboss.job` for `post-game-billing`, `bill-session`, `daily-overdue`, `akahu-reconcile`, `send-email`; Mailpit in dev and CI; structured `billing.*`, `wallet.*` and `akahu.*` log events (AC-VERIFY-7); the fake Akahu adapter's recorded calls in tests.
- **Data persisted**:
  - `game_sessions.status = 'COMPLETED'` (written only by `bill-session`).
  - `payments` + `payment_line_items`: one per billable registration (`UNIQUE(registration_id)`), with `billing_type` `PREPAID_CREDIT` (paid from wallet, `status = PAID`, `paid_at` = billing instant) or `PER_GAME` (`status = PENDING`, `due_date` per ruling B2), the GST snapshot, the new `gst_number` column, `payment_link_token` (256-bit random, ruling on its role in creative question 2), `akahu_payment_id` once Akahu has one, and new reminder bookkeeping (proposed `last_reminder_at`, `reminder_count`).
  - `player_credits` (created lazily at the first movement, balance 0.00) and `credit_transactions`: `TOPUP` (with `akahu_payment_id`, unique per Akahu payment) and `AUTO_DEDUCTION` (with `registration_id`, unique per registration), each with `resulting_balance` equal to the wallet's new balance.
  - New tables proposed for creative (names indicative): `wallet_top_ups` (top-up intents: `id`, `user_id`, `team_id`, `amount`, `status`, `idempotency_key`, `akahu_payment_id`, timestamps) and `payment_attempts` (pay-link attempts against a payment). If Akahu's flow needs a per-player connection or token, it is stored encrypted with a key id (P4) in its own table.
  - `teams.payout_blocked_at` (set by billing only, under the team lock).
  - `send-email` jobs: payment due, low credit, overdue, manual reminder, payment received (SHOULD), payout blocked (admins), billing blocked (admins). Any email carrying a payment link is sealed with FieldCrypto.
  - One reversible migration (ledger D-87 onwards): payment status-transition guard, `payments.gst_number`, reminder columns, the new tables, ledger-consistency enforcement, any `team_banking_in_use` widening, and any D-75 allowlist widening.
- **Observable within**: a session is COMPLETED and billed within 10 minutes of `ends_at` while the worker runs (5-minute sweep plus job latency). Webhook-driven changes (top-up credited, payment PAID) are visible on the next page load after Akahu's callback; missed webhooks are reconciled within one `akahu-reconcile` interval plus its age threshold. OVERDUE flips at the first 04:00 run after `due_date`. Emails are enqueued in the triggering transaction and delivered within 30 s.

### Acceptance Criteria

**Entry points**

#### AC-ENTRY-1: An approved member finds their wallet for a team
**Priority**: MUST
**Given** an APPROVED member of team T with a wallet balance of $12.50 (fixture `insertWallet`)
**When** they open `/teams/[T]` and follow "Wallet: $12.50 · Top up or pay"
**Then** `/teams/[T]/wallet` shows "Balance: $12.50", "You can top up to $87.50 more (wallet limit $100.00).", the top-up form and the Payments section, all keyboard-reachable. The values come from `GET /teams/[T]/wallet` (balance, headroom) and `GET /teams/[T]/payments/me` (rows), never computed from other page data. An anonymous visitor is redirected to `/login?returnTo=%2Fteams%2F<T>%2Fwallet`; a non-member, PENDING, REJECTED or BANNED caller gets 403 `forbidden` from both routes and the page shows "You need to be a member of this team to use its wallet." A member without a wallet row sees $0.00 and no row is created

#### AC-ENTRY-2: A payment email leads the payer, and only the payer, to the payment page
**Priority**: MUST
**Given** a PENDING payment P for player A
**When** A follows "Pay now" from the email (signed out first, then signed in through `/login?returnTo=...`)
**Then** `/payments/[P]` shows the team, session, amount, line items, due date and "Pay {amount} with Akahu". Player B, a team admin of the same team and an unknown id all get the same not-found page, and `GET /payments/:id` answers the same 404 `not_found` body for all three

#### AC-ENTRY-3: A team admin finds the team's payments and the reminder action
**Priority**: MUST
**Given** team T with PENDING, OVERDUE and PAID payments
**When** a TEAM_ADMIN of T opens Manage and chooses "Payments" in the area nav (and separately a GLOBAL_ADMIN opens `/teams/[T]/manage/payments`)
**Then** the page lists the unpaid payments by default (filter "Unpaid", "Paid", "All"), from `GET /teams/[T]/payments`, with "Send reminder" on PENDING and OVERDUE rows only. A MEMBER gets the existing `NoAccess` page and 403 from the route. `MANAGE_AREAS` and `manage-areas.test.ts` include the new area

#### AC-ENTRY-4: The registration debt block points to where the debt can be paid
**Priority**: SHOULD
**Given** a member with 3 OVERDUE payments
**When** they open a session page and see "You have 3 overdue payments. Pay them before registering for more sessions."
**Then** the message links to a page that lists those overdue payments with "Pay now" (target decided in creative question 5, because the payments may be in other teams)

**Happy paths**

#### AC-HAPPY-1: A player tops up their wallet and the money goes to the team's account
**Priority**: MUST
**Given** member A of team T (payout configured) with a $0.00 wallet, and the fake Akahu adapter
**When** A enters "30.00" and clicks "Top up with Akahu", completes the Akahu step and returns
**Then** `POST .../wallet/top-ups` created one top-up intent and asked Akahu for a payment of $30.00 whose payee is T's bank account name and number (decrypted only for that call, never logged); after the verified completion event the wallet balance is $30.00, one `credit_transactions` row `TOPUP +30.00` with `resulting_balance 30.00` and the Akahu payment id exists, and the page shows "Balance: $30.00". A repeated completion event changes nothing

#### AC-HAPPY-2: After a game, the fee is taken from a wallet that covers it
**Priority**: MUST
**Given** a PUBLISHED FLAT session S of T at $17.00, `ends_at` passed, and A CONFIRMED with a $30.00 wallet
**When** the `post-game-billing` sweep runs and `bill-session` processes S
**Then** in one transaction S becomes COMPLETED and A has one payment: `billing_type PREPAID_CREDIT`, `status PAID`, `paid_at` = the job's `now`, `amount 17.00`, one line item (position 0, `FLAT`), the GST snapshot of T; one `AUTO_DEDUCTION -17.00` row with `resulting_balance 13.00` linked to the registration; the wallet reads $13.00. No Akahu call is made and no payment-due email is sent

#### AC-HAPPY-3: Without enough credit, a pay-by-bank charge is created, due per ruling B2
**Priority**: MUST
**Given** S as above and B CONFIRMED with a $10.00 wallet (and C with no wallet row)
**When** S is billed
**Then** B and C each get one payment `billing_type PER_GAME`, `status PENDING`, `due_date` = billing instant + 3 days (B2 default), and a sealed "Payment due" email with the `/payments/[id]` link; B's wallet stays $10.00 (no partial deduction) and no `credit_transactions` row is written for B or C

#### AC-HAPPY-4: A player pays a pending charge through Akahu
**Priority**: MUST
**Given** B's PENDING payment of $17.00
**When** B clicks "Pay $17.00 with Akahu", completes the Akahu step and returns
**Then** one payment attempt exists, the Akahu payment's payee is T's account; after the verified completion the payment is `PAID` with `paid_at` set and `akahu_payment_id` stored, the page shows "Paid on {date}.", and B's wallet balance is unchanged

#### AC-HAPPY-5: The fee is computed from the session's pricing model and every guest, from the snapshot
**Priority**: MUST
**Given** table-driven sessions: FLAT $17.00 with a party of 3; BY_SEX (male $15.00, female $12.00, other $13.00) with a male registrant, a female guest and an OTHER guest; BY_SKILL_LEVEL (beginner $10.00, intermediate $14.00, advanced $18.00) with a registrant snapshotted as INTERMEDIATE whose `team_members.skill_level` has since changed to ADVANCED
**When** each session is billed
**Then** amounts are $51.00, $40.00 and $14.00 respectively; each payment has one line item per party with the applied basis (`SEX_FEMALE`, `SKILL_INTERMEDIATE`, ...) and the snapshotted sex and skill; `sum(unit_fee) = amount` (the deferred trigger passes); the registrant line uses the registration snapshot, never `users.sex` or the current skill level (C-BIL-1); fees are read from the session's `fee_*` columns (C-SSE-1) through the shared `unitFee`

#### AC-HAPPY-6: Billing charges exactly the hand-off: promoted players and late withdrawers yes, others no
**Priority**: MUST
**Given** session S with: a CONFIRMED registrant; a party promoted from the waitlist after the deadline; a LATE withdrawal with `withdrawal_fee_due = true` (party of 2); a LATE withdrawal replaced by the waitlist (`withdrawal_fee_due = false`); an EARLY withdrawal; a WAITLISTED party; a CONFIRMED member banned before `starts_at`
**When** S is billed
**Then** exactly three payments exist: the confirmed registrant, the promoted party, and the late withdrawer (for the whole party of 2, reason `LATE_WITHDRAWAL`, wording "Late withdrawal fee" in the email); nobody else is charged. A CANCELLED session with CONFIRMED rows is never selected, never completed and never billed

#### AC-HAPPY-7: A deduction that leaves the wallet under $20.00 sends one low-credit reminder
**Priority**: MUST
**Given** wallets of $35.00, $36.00 and $15.00 (the last covering a $10.00 fee) and a $17.00 FLAT fee where covered
**When** the sessions are billed
**Then** the $35.00 wallet ends at $18.00 and its owner gets exactly one "Your {Team} wallet is running low ($18.00)" email (idempotency key from the deduction id); the $36.00 wallet ends at $19.00 and also gets one (it crossed below $20.00); a wallet ending at exactly $20.00 gets none; the $15.00 wallet paying $10.00 ends at $5.00 and gets one per ruling B5 (default: every deduction that leaves the balance below $20.00). A redelivered `bill-session` job sends nothing more

#### AC-HAPPY-8: The daily job marks unpaid charges overdue and reminds the player
**Priority**: MUST
**Given** PENDING payments with `due_date` before and after the run's `now`, a PAID payment past due, and an OVERDUE payment
**When** `daily-overdue` runs at 04:00 Pacific/Auckland (or via `jobs:trigger daily-overdue` with an injected clock)
**Then** only the PENDING payments with `due_date <= now` become `OVERDUE`, each with one "Overdue" email enqueued in the same transaction; the others are untouched; a second run the same day changes nothing and sends nothing. The registration debt gate (`countOverdueByUser`) now counts them

#### AC-HAPPY-9: Paying an overdue charge clears it and can lift the registration block
**Priority**: MUST
**Given** a member with exactly 3 OVERDUE payments (registration blocked)
**When** they pay one of them through `/payments/[id]` and the completion is verified
**Then** that payment is `PAID` (OVERDUE -> PAID is allowed), the overdue count is 2, and the registration panel shows the register form again on the next load

#### AC-HAPPY-10: An admin sends a payment reminder
**Priority**: MUST
**Given** an OVERDUE payment of player A in team T
**When** a TEAM_ADMIN of T (and separately a GLOBAL_ADMIN) clicks "Send reminder" and confirms
**Then** `POST .../reminders` answers 202 `{ sent: true, lastReminderAt }`, one sealed "Reminder" email to A is enqueued in the same transaction that stamps `last_reminder_at`, and the row reads "Reminder sent {time}". A replay with the same `changeKey` sends nothing and returns the same answer

#### AC-HAPPY-11: A session with nothing to charge still completes
**Priority**: MUST
**Given** a PUBLISHED free session (no fee, `isPaidSession` false) and a paid session with no billable registrations
**When** each is billed
**Then** both become COMPLETED with no payment rows and no emails; behaviour for a party whose computed total is $0.00 on a paid session follows ruling B7

#### AC-HAPPY-12: A player sees what happened to their money
**Priority**: SHOULD
**Given** a member with top-ups, deductions and paid, pending and overdue payments in T
**When** they open `/teams/[T]/wallet`
**Then** the ledger lists each movement with its signed amount and resulting balance (newest first, paginated by `nextCursor`), each deduction names its session, and the Payments section groups rows Overdue, Pending, Paid with "Pay now" on unpaid rows. A "Payment received" email is sent when a PER_GAME payment becomes PAID

**Errors and recovery**

#### AC-ERROR-1: A top-up that would exceed $100.00, or is not a valid amount, is refused with the limit stated
**Priority**: MUST
**Given** a wallet of $85.00
**When** the member submits "20.00", "0", "-5", "12.345", "abc" or a body with extra fields
**Then** "20.00" gets 422 with a field error "You can top up at most $15.00." and the form keeps the typed value; invalid amounts get 422 naming the field; extra fields get 422 (strict schema); no top-up intent is created and Akahu is not called

#### AC-ERROR-2: The $100.00 cap holds under concurrent top-ups and late confirmations
**Priority**: MUST
**Given** a wallet of $60.00
**When** two top-ups of $30.00 are started at the same time from two tabs, and separately a top-up confirmation arrives after a deduction and another top-up have changed the balance
**Then** at most one top-up is open per wallet at a time (the second gets 409 `top_up_in_progress` with the open one), the balance never exceeds $100.00 (DB CHECK as backstop), and a confirmation that could not be credited without breaking the cap is recorded and surfaced to the player and the team admins per ruling B3, never silently clamped or dropped

#### AC-ERROR-3: A declined, cancelled or abandoned Akahu payment leaves the charge payable
**Priority**: MUST
**Given** a PENDING payment (and separately an open top-up)
**When** Akahu reports the payment as declined, cancelled or errored, or the player abandons the Akahu step
**Then** the payment stays PENDING (or OVERDUE) and payable, the page shows "Your payment didn't go through. You haven't been charged." with "Try again"; the top-up is closed with no `credit_transactions` row and the form is available again; nothing is marked PAID and no wallet movement is written

#### AC-ERROR-4: Akahu rejecting the team's payout account blocks new paid publishes and tells the admins
**Priority**: MUST
**Given** team T with payout configured and a payment attempt whose Akahu result is a decline attributable to the destination account
**When** the result is processed (webhook or reconcile)
**Then** in one transaction billing takes `teams FOR NO KEY UPDATE`, sets `payout_blocked_at = now` (if not already set), and enqueues one email per approved admin naming no account details; `is_payout_configured` becomes false; publishing a paid session answers 409 `payout_not_configured`; the banking columns are untouched; re-saving banking clears the block (existing behaviour). The player sees "This team can't receive payments right now. We've told the team admins."
*Amended 2026-10-31 (A3, binding; see Plan Amendment below): Akahu documents no "destination account rejected" signal, so the trigger is a manual action by a GLOBAL_ADMIN (ops), not an Akahu result. `FAILED/REJECTED` never sets `payout_blocked_at`. A create-time `invalid_payee` is added as an automatic trigger only if MVE-003 shows it means a bad account. The Then clause (lock, `payout_blocked_at`, admin emails, publish gate, banking untouched, player copy) is unchanged; fixtures are synthetic.*

#### AC-ERROR-5: A session whose team cannot take payments at billing time is not half-billed
**Priority**: MUST
**Given** a PUBLISHED paid session S that has ended, and team T with `payout_blocked_at` set
**When** `bill-session` runs for S
**Then** per C-BIL-PAY no payment row is inserted; the outcome follows ruling B8 (default: S stays PUBLISHED, nothing is written, the job completes with `billing.session.blocked` logged and one "Billing is paused" email per admin with a per-session idempotency key, and the next sweep after the account is fixed bills S normally). No player is emailed and no wallet is touched while blocked

#### AC-ERROR-6: Forged or replayed webhooks change nothing
**Priority**: MUST
**Given** the webhook route
**When** it receives a request with no signature, a wrong signature, a signature from an unknown key, a valid signature over a modified body, or the same valid event twice
**Then** the first four get 401 with no state change and a `akahu.webhook.rejected` log carrying the reason and no body; the duplicate gets 200 and changes nothing (no second `TOPUP`, no second PAID transition, no second email)

#### AC-ERROR-7: Akahu being unavailable never leaves a charge or a top-up in a false state
**Priority**: MUST
**Given** the fake adapter set to fail (timeout, 5xx, network error)
**When** a member starts a top-up or a payment
**Then** the API answers 503 `payment_provider_unavailable`, the page shows "We couldn't reach Akahu. Nothing has been charged. Try again in a few minutes.", any intent row written is closed (or never committed), and a retry with a new key works. The Akahu call is never made while a database lock is held

#### AC-ERROR-8: Reminders are refused when they make no sense
**Priority**: MUST
**Given** a PAID payment, an OVERDUE payment reminded a few minutes ago, a payment of another team, and a MEMBER caller
**When** reminders are requested
**Then** they answer 409 `payment_settled`, 409 `reminder_too_soon` (ruling B6, default one manual reminder per payment per 24 hours), 404 `not_found`, and 403 `forbidden` (before body validation) respectively; no email is enqueued in any of these cases

#### AC-ERROR-9: A failing billing job is visible and never half-applies
**Priority**: MUST
**Given** `bill-session` for S fails mid-way (injected error after some payments are inserted)
**When** the transaction rolls back
**Then** S is still PUBLISHED with no payments, line items, deductions or emails; transient errors retry with backoff; a permanent failure ends `failed` with `billing.session.failed` (ids, error class, SQLSTATE only) and the next 5-minute sweep re-enqueues S

#### AC-ERROR-10: Paying twice is impossible
**Priority**: MUST
**Given** a PENDING payment
**When** the payer double-clicks "Pay", opens a second tab, or starts a new attempt while one is open, or a completion arrives for a payment that is already PAID
**Then** at most one Akahu payment is open per payment (409 `payment_in_progress` returns the open attempt's redirect), a PAID payment answers 409 `payment_settled`, and if Akahu nonetheless reports a second successful payment it is recorded and surfaced for refund handling per ruling B3; the payment is never PAID twice and no wallet credit is invented

**Async lifecycle**

#### AC-ASYNC-1: Ended sessions are billed by the sweep, exactly once
**Priority**: MUST
**Given** three PUBLISHED sessions: ended 1 minute ago, ending in 1 hour, and CANCELLED after its end
**When** `post-game-billing` runs (twice in a row, and with two workers running)
**Then** only the ended PUBLISHED session gets a `bill-session` job (`singletonKey = bill-session:<id>`), it is COMPLETED and billed once, and a replayed job finds it COMPLETED and does nothing (guarded transition plus `UNIQUE(registration_id)`). With the worker running, billing completes within 10 minutes of `ends_at`

#### AC-ASYNC-2: The player sees a processing state that resolves on its own
**Priority**: MUST
**Given** a player returning from Akahu before the completion event arrives
**When** the wallet page (`?topUp=<id>`) or the payment page (`?return=1`) loads
**Then** it shows "Processing your payment. This usually takes under a minute." with a Refresh link, refreshes itself a few times (`RefreshWhilePending` pattern, no focus move), and shows the credited balance or "Paid on {date}." once the event is processed; if still open afterwards it says "Your bank hasn't confirmed yet. We'll email you when it does."

#### AC-ASYNC-3: A missed webhook is reconciled
**Priority**: MUST
**Given** a top-up and a payment attempt completed at Akahu whose webhooks never arrived
**When** `akahu-reconcile` runs after the age threshold
**Then** it re-reads both from Akahu and applies exactly the transitions the webhook would have (credit once, PAID once); attempts Akahu reports as failed are closed; an attempt still open after a maximum age is logged `akahu.reconcile.stuck` at warn level

#### AC-ASYNC-4: Every notification is committed with its cause
**Priority**: MUST
**Given** each trigger: a payment due, a low-credit deduction, an overdue transition, a manual reminder, a payment received, a payout block, a blocked billing
**When** the triggering transaction commits (or rolls back)
**Then** its `send-email` job exists exactly when the trigger committed (P5), with an idempotency key derived from the cause (payment id, deduction id, transition), and any email containing a payment link is sealed with FieldCrypto so `pgboss.job.data` holds no link or token

**Structural checks**

#### AC-VERIFY-1: Every new route has an explicit, expected policy
**Priority**: MUST
**Given** `buildApp`
**When** routes are registered
**Then** each new route declares the policy listed in the Invocation Method (`MEMBER`, `TEAM_ADMIN` with `allowGlobalAdmin: true`, `authenticated()` payer-scoped, `publicRoute()` for the webhook only); the team guard runs before body validation; bodies are strict (a client cannot send `status`, `userId`, `teamId`, `balance` or `amount` for a payment); the webhook route alone gets a raw-body parser; OpenAPI is regenerated (`pnpm run openapi`) and drift-checked

#### AC-VERIFY-2: Money invariants are enforced by the database, reversibly and ledgered
**Priority**: MUST
**Given** the new migration (ledger D-87 onwards)
**When** raw SQL tries an invalid change
**Then** the DB refuses: a payment status change outside the allowed matrix (default PENDING -> PAID, PENDING -> OVERDUE, OVERDUE -> PAID, plus FAILED per ruling B4; PAID is terminal), with a TypeScript twin replayed from a shared matrix fixture; a `credit_transactions` row whose `resulting_balance` does not equal the previous balance plus `amount`, or a `player_credits.balance` that differs from the latest `resulting_balance`; a second `TOPUP` for the same Akahu payment; a second open top-up per wallet. `pnpm run db:rollback` then `db:migrate` gives an identical schema (`schema.int.test.ts`), and every deviation is a ledger row

#### AC-VERIFY-3: Billing follows the lock order and C-BIL-PAY, proven by races in both orders
**Priority**: MUST
**Given** the real billing path replacing `payment-stand-in.ts`
**When** `team-banking-gate.int.test.ts` races a banking removal against `bill-session` in both orders, and new tests race a deduction against a top-up credit, two sessions ending together for the same player, and a payout block against billing
**Then** billing takes `teams FOR KEY SHARE` and checks `is_payout_configured` first, then `game_sessions FOR UPDATE`, then reads the hand-off, then writes `payments`, then locks the wallet row (the wallet's position in the lock order is recorded in ADR 0020); a removal either waits and answers 409 `banking_in_use` or commits first and billing inserts nothing; no race ends in `40P01`; ordering uses `waitForLockWaiters`, never sleeps

#### AC-VERIFY-4: Money is exact end to end
**Priority**: MUST
**Given** the billing, wallet and display code
**When** amounts are computed, stored, compared and shown
**Then** only `Money`/`MoneyString` are used (no `number`, `parseFloat`, `toFixed`; the existing ESLint bans pass); the deduction decision is `gte(balance, total)`; `payments.amount` equals the sum of line items; generated `gst_amount`/`subtotal_amount` equal `packages/shared` HALF_UP 3/23 for every amount in a property test; display uses `formatNZD`

#### AC-VERIFY-5: The GST snapshot is taken at charge time and never changes
**Priority**: MUST
**Given** a GST-registered team T (GST number 123456789) and a non-registered team U
**When** sessions of both are billed, and T then turns GST off and changes its number
**Then** T's payments carry `gst_registered true`, `gst_rate_bps 1500` and `gst_number '123456789'`, U's carry `false`, `0` and NULL, all read in the same statement; the later change alters no existing payment (immutability trigger extended to `gst_number`)

#### AC-VERIFY-6: Time boundaries are exact and zone-safe
**Priority**: MUST
**Given** an injected clock
**When** billing runs at `ends_at - 1 ms`, at `ends_at`, and around a DST change; and the overdue job runs at `due_date - 1 ms` and `due_date`
**Then** the session is billed only from `ends_at` on (and never before `starts_at`, C-BIL-3); `due_date` follows ruling B2 exactly; OVERDUE is set only when `due_date <= now`; all stored instants are UTC and Pacific/Auckland appears only in display and the cron slots; no new calendar slot fires between 02:00 and 02:59 (`assertNoDstHourFirings`)

#### AC-VERIFY-7: Billing is observable and leaks no secrets or personal data
**Priority**: MUST
**Given** every billing, wallet, webhook and Akahu-client path
**When** it runs (success, refusal, failure)
**Then** it logs `billing.*`, `wallet.*` and `akahu.*` events with ids, amounts as `MoneyString`, status and `traceId`, and never a bank account name or number, an Akahu credential or user token, a payment link or token, an email address or a raw webhook body; new log field names are grepped against the global redaction keys first (learned rule); the Akahu HTTP client propagates `traceparent`; Akahu credentials come only from the environment, and any stored Akahu token is an encrypted envelope with a key id (P4)

#### AC-VERIFY-8: Akahu configuration fails fast and the fake adapter is test-only
**Priority**: MUST
**Given** the config schema (`apps/api/src/lib/config/config.ts`)
**When** the API or worker boots with missing or malformed Akahu settings, or with the fake adapter in production
**Then** boot fails with a named error (P7); the adapter is chosen only by an environment variable (pattern of `NOTIFIER_ADAPTER` and `AUTH_FAKE_OAUTH`), the fake is refused when `NODE_ENV=production`, and `.env.example` and `docs/getting-started.md` list every new variable

#### AC-VERIFY-9: The new pages are accessible and work on a phone
**Priority**: MUST
**Given** the wallet page, payment page and Payments manage area in each state (empty, pending, processing, paid, overdue, error, full wallet)
**When** scanned in Playwright on desktop and 360 x 740
**Then** axe reports no critical or serious violation, there is no horizontal scroll, every target is at least 44 px, the top-up field has a visible label and its error is announced and linked with `aria-describedby`, status tags are text (not colour only), and confirmations use `ConfirmDisclosure`, never a native dialog

#### AC-VERIFY-10: The feature is inside the quality gates and documented
**Priority**: MUST
**Given** the finished branch
**When** `pnpm run ci` runs
**Then** lint, typecheck, unit and integration tests and build pass; `vitest.config.ts` `coverage.include` gains the new module, shared and job paths and the aggregate stays at or above 80%; ADR 0020 records the decisions and cites ADR 0004, 0009, 0012, 0016, 0018 and 0019; `systemPatterns.md`, `techContext.md`, `productBrief.md` (Akahu now live) and the ledger are updated

#### AC-VERIFY-11: Upstream contracts still hold after billing lands
**Priority**: MUST
**Given** the merged contract tests
**When** the suite runs on this branch
**Then** `boundaries.test.ts` still passes (billing writes no `registrations` row), `registrations-billing-handoff.int.test.ts` and `sessions-contracts.int.test.ts` pass unchanged, COMPLETED is written only by `bill-session`, OVERDUE only by `daily-overdue` (a grep test), and if `team_banking_in_use` is widened the service, trigger and parity tests change together

#### AC-VERIFY-12: Ledger and payments reconcile
**Priority**: SHOULD
**Given** any database state produced by the test suites
**When** the reconciliation query (shipped as a CLI check, e.g. `cli billing reconcile`) runs
**Then** for every wallet, balance = sum of its `credit_transactions.amount` = latest `resulting_balance`; every `AUTO_DEDUCTION` has a PAID `PREPAID_CREDIT` payment for the same registration and amount; every PAID `PER_GAME` payment and every `TOPUP` has an Akahu payment id; the check reports zero discrepancies, and a seeded discrepancy is reported by id

**Grounded integration**

#### AC-INTEGRATION-1: The Akahu adapter is built against Akahu's real contract, not an invented one
**Priority**: MUST
**Given** the Akahu gateway interface and its live adapter
**When** its tests run
**Then** request and response shapes, payment statuses, error codes and the webhook signature check are taken from Akahu's current documentation (cited in ADR 0020 with the retrieval date) and exercised against recorded fixtures, including a webhook signed with a real Akahu-format key pair; a manual sandbox smoke test (top-up, pay, decline) is a documented pre-release item, like the OAuth providers'

#### AC-INTEGRATION-2: Billing is proven on real registrations, not on inserted payments
**Priority**: MUST
**Given** a session whose registrations, guests, promotions and late withdrawals are produced through the real allocator (`createAllocator`) on a real database
**When** the clock passes `ends_at` and the worker runs the sweep and `bill-session`
**Then** the payments, line items and deductions match AC-HAPPY-5 and AC-HAPPY-6 exactly, with no billing test seeding `payments` directly for the path under test

#### AC-INTEGRATION-3: Concurrency is proven with real connections
**Priority**: MUST
**Given** separate connections and a pool larger than the parallelism
**When** the same `bill-session` job runs twice concurrently, a webhook and the reconcile sweep process the same Akahu payment concurrently, 10 top-ups start at once on one wallet, and a deduction races a top-up credit
**Then** exactly one COMPLETED transition, one payment per registration, one PAID transition, one TOPUP per Akahu payment and one open top-up exist; the balance stays within 0-100 and equals the ledger; no deadlock

#### AC-INTEGRATION-4: The money journeys work in a real browser on both viewports
**Priority**: MUST
**Given** the Compose stack with the fake Akahu adapter and the worker running
**When** Playwright runs `apps/web/e2e/billing.spec.ts` on desktop and 360 x 740: top up; a session ends and the fee is deducted; a second player is billed, receives the email in Mailpit and pays via the link; a payment goes overdue (clock or `jobs:trigger daily-overdue` with a fixture date); a team admin sends a reminder
**Then** each journey reaches its success state with the axe, no-horizontal-scroll and 44 px checks at each scanned state, and sessions and registrations are created through the APIs (no seed script for anything the app can create)

### Scope Boundaries
- **In scope**:
  - Wallet per (player, team): lazy creation, balance cap $100.00, top-up through Akahu with the team's account as payee, the `credit_transactions` ledger with resulting balances, and a reconciliation check.
  - The post-game engine: `post-game-billing` sweep, `bill-session` job, PUBLISHED -> COMPLETED, billing exactly `listBillableRegistrations`, fee computation from the session fee columns and snapshots, line items, GST snapshot including the new `payments.gst_number`, full wallet deduction when covered, otherwise a PER_GAME payment with a due date and a payment email.
  - Paying a payment through Akahu (`/payments/[id]`), the webhook receiver (signature-verified, idempotent), the `akahu-reconcile` sweep, and the processing states.
  - The low-credit reminder, the `daily-overdue` job with reminders, the manual reminder action (team and global admins) with its API, and the payment-received email.
  - `payout_blocked_at` handling and admin notification (ADR 0016 R3), and C-BIL-PAY on every payment-creation path, replacing `payment-stand-in.ts` in the race test.
  - The minimal pages: team-page wallet line, `/teams/[teamId]/wallet`, `/payments/[paymentId]`, and the "Payments" manage area.
  - The Akahu gateway behind an interface with a live and a fake adapter, config keys, ADR 0020, ledger rows, OpenAPI, coverage, docs, and the E2E journeys.
  - Updating the registrations E2E debt journey to create OVERDUE payments through billing if it becomes possible (COULD).
- **Out of scope**:
  - PDF tax invoices, invoice numbering (`assign_invoice_number`), IRD/GST exports and the invoice columns (tax-invoices-and-exports). This feature only stores what invoicing needs (the GST snapshot and `gst_number`) and must not set `is_tax_invoice_issued`.
  - The cross-team three-tab player dashboard (player-dashboard) and the cross-team admin master report with filters, search and pagination across teams (admin-reporting-dashboard). Both consume this feature's read models and reminder route.
  - Refunds paid back to a player's bank, withdrawing wallet credit, transferring credit between teams, and admin manual credits or adjustments (the `REFUND` enum value stays unused except as ruling B3 decides for overflow or duplicate payments).
  - Partial wallet deductions (workflows section 3 is all-or-nothing), split payments, payment plans, late fees or interest on overdue payments.
  - Subscription billing (`MONTHLY_SUBSCRIPTION`, `QUARTERLY_SUBSCRIPTION`).
  - Per-team Akahu credentials or merchant onboarding (`teams.akahu_merchant_id`/`akahu_app_token` stay unused, ADR 0016), and live Akahu verification of the bank account at save time.
  - SMS or push notifications; any notification preference settings.
  - Changing registration, ban, debt-gate or session rules (the debt threshold stays 3, counted across teams).
- **Dependencies**:
  - registration-and-waitlist (merged 2026-10-30, PR #8): `listBillableRegistrations`, `withdrawal_fee_due`, the snapshot columns, the debt gate, ADR 0018 C-BIL-1 to C-BIL-3 and C-ALL-1.
  - team-banking-and-gst (merged): `is_payout_configured`, `payout_blocked_at`, `team_banking_in_use`, encrypted payee columns, `gst_registered`/`gst_number`, ADR 0016 C-BIL-PAY.
  - session-scheduling-engine (merged): sessions, `ends_at`, the lifecycle trigger (D-75), `LOCK_ORDER`, ADR 0019.
  - platform-foundation (merged): wallet and payment schema, pg-boss slots, `send-email`, FieldCrypto, money and time primitives, test harness.
  - External: an Akahu developer account with an app that can make payments to third-party accounts, webhook configuration, and sandbox access (a prerequisite to confirm in creative question 1).
- **NFR implications**:
  - **Integrity (P1):** status transitions, the cap, the ledger and idempotency keys are database-enforced; TypeScript only shapes errors.
  - **Money (P2):** `Money` only; HALF_UP; all-or-nothing deduction.
  - **Time (P3):** UTC instants, injected clock read once per operation after locks; due dates and overdue in exact instants.
  - **Encryption (P4):** payee details decrypted only in memory for the Akahu call; any stored Akahu token encrypted with a key id.
  - **Async (P5):** billing, overdue, reconcile and every email through pg-boss in the triggering transaction; external calls never inside a transaction holding locks.
  - **Config (P7):** Akahu settings validated at boot; adapter selected only by environment.
  - **Security:** webhook signature verification over the raw body, payer-scoped payment reads (no IDOR), team-scoped admin reads, strict bodies, payment links sealed in job payloads.
  - **Privacy and retention:** financial rows kept 7 years (RESTRICT FKs already); no emails or bank details in logs; admin views show names, not emails.
  - **Accessibility:** AC-VERIFY-9.
  - **Performance:** `bill-session` for a 30-registration session completes in under 2 s; wallet and payment reads p95 under 300 ms.

### Creative Exploration Needed
Yes. Questions for `/yay:creative`, in order of risk. A `/yay:spike` on question 1 before or during architecture creative is recommended, because every Akahu-facing AC depends on it.

1. **Akahu capability and integration shape (LOW, architecture; spike recommended).** Confirm from Akahu's current documentation and a sandbox:
   - Can a platform app take a one-off payment from a player's bank account to a third-party account (the team's) through a hosted flow with no enduring player connection, or must each player connect their bank to the app through Akahu OAuth (an enduring consent, a stored user token, an account picker) before Akahu's payment API can debit them? This decides whether a "payment link" is an Akahu-hosted request or our own `/payments/[id]` page that starts an Akahu flow, and whether a new encrypted per-player token table is needed.
   - Payment statuses and which ones mean success, failure, cancellation or "destination account rejected" (the trigger for `payout_blocked_at`).
   - The webhook contract: event types, payload, signature header and algorithm, key retrieval and rotation, retry behaviour, and whether events carry a unique id. Default in this draft: verify the signature over the raw body, then re-read the payment from Akahu and act on that.
   - Limits, fees, sandbox behaviour, and app approval lead time (a schedule risk).
2. **Payment link identity (MEDIUM, architecture and security).** Default: an authenticated `/payments/[paymentId]` page for the payer only, with `payment_link_token` used as the Akahu reference or idempotency key. Alternative: a bearer-token link that works without sign-in (simpler to pay, but a capability in email and URL that must be treated like the invite code). Decide, and decide what `payment_link_token` holds.
3. **Wallet top-up intent, the cap and duplicates (LOW, algorithm and architecture).** Default: one open top-up per wallet; the requested amount must be at most `100.00 - balance` when started; deductions only lower the balance, so the headroom can only grow while it is open. Decide the intent table and states, expiry of an abandoned intent, what happens when a completion arrives for an expired intent, and how an over-cap credit or a duplicate successful payment is recorded (ruling B3).
4. **Ledger, lock order and transaction boundaries (MEDIUM, architecture).** Where `player_credits` sits in `LOCK_ORDER` (default: after `payments`); whether the ledger invariant (balance = latest `resulting_balance` = running sum) is a trigger or a guarded write; one transaction per session for `bill-session` (default) vs. per registration; the module split (`wallet`, `billing`, `lib/akahu`) and the single writer of each money table (a structural test like registrations' `boundaries.test.ts`); how the webhook, the reconcile sweep and the pay route share one "apply Akahu result" function.
5. **Player and admin surfaces vs. player-dashboard and admin-reporting-dashboard (LOW, UI/UX and user journey).** Confirm the per-team wallet page, the team-page entry line, the payment page and the Payments manage area as this feature's minimum, and that player-dashboard later aggregates across teams instead of replacing them. Decide where the registration debt block links when the overdue payments are in another team, and the copy of all seven emails.
6. **Post-game edge cases (MEDIUM, algorithm).** A paid session whose team is blocked at billing time (ruling B8); a first-deploy backlog of sessions that ended long ago (ruling B9); a member who left the team or whose wallet is in a team they no longer belong to; a session that ended while the worker was down for days.

**Human rulings needed before build** (product policy hidden in technical decisions; each default is what the ACs assume):
- **B1** Wallet cap: $100.00 is a cap on the balance, not on each top-up (productBrief assumption, DB CHECK already enforces it). Minimum top-up amount: default $1.00.
- **B2** Due date: default `billing instant + 72 hours` (exact), so with the 04:00 job a charge becomes OVERDUE between 3 and 4 days after the game. Alternative: end of the third Pacific/Auckland calendar day.
- **B3** Over-cap credit or a duplicate successful payment: default record it, credit nothing beyond the cap, notify the player and the team admins, and leave the refund to the team outside the app (the `REFUND` type is not used in v1). Alternative: allow a balance above $100.00 in that case only.
- **B4** Meaning of `FAILED`: default never set on a payment (a failed attempt is recorded on the attempt, and the charge stays payable); alternative: a terminal state set by an admin "write off". If used, `team_banking_in_use` must include it.
- **B5** Low-credit reminder: default every deduction that leaves the balance below $20.00; alternative: only the deduction that first crosses below $20.00 until the next top-up.
- **B6** Reminder cadence: default the overdue email once at the transition, no automatic repeats, and manual reminders limited to one per payment per 24 hours. Alternative: a weekly automatic reminder while OVERDUE.
- **B7** A paid session where a party's computed total is $0.00: default write a PAID $0.00 `PER_GAME` row with no link and no email (so reports and invoices see it); alternative: no row.
- **B8** Team payout blocked at billing time: default hold the whole session (stay PUBLISHED, notify admins once, retry each sweep); alternative: complete it and still deduct from wallets (the money is already in the team's account) while holding only link payments.
- **B9** Deploy-time backlog: default bill every PUBLISHED session that has ended, oldest first, with emails; alternative: complete sessions that ended more than N days before deploy without billing.
- **B10** Payee at payment time: default the team's bank account as it is when the player pays (a later banking change redirects unpaid charges); alternative: snapshot the payee at billing time.

### Implementation Guide Required
Yes, for operations only. Every acceptance criterion except the Akahu sandbox smoke test (AC-INTEGRATION-1) is auto-verifiable with the fake adapter, an injected clock and real PostgreSQL. A short guide in `docs/getting-started.md` must cover: creating the Akahu app and webhook, the environment variables, running the sandbox smoke test, re-running a failed `bill-session` or `daily-overdue` job, reading `cli billing reconcile` output, and what an admin does after a payout block.

**Spec review (human, 2026-10-30)**: approved as drafted. Rulings B1-B10 are accepted at their stated defaults; creative may raise a ruling again only with a concrete reason (for example, an Akahu capability that makes a default impossible), and any change is recorded as a plan amendment.

## Test Strategy

### Approach
- **Emphasis**: integration-heavy, as in registration-and-waitlist. Money state (status transitions, the ledger invariant, the cap, one payment per registration, one TOPUP per Akahu payment) is proven against real PostgreSQL 17 and a real pg-boss queue, with multi-connection race tests ordered by `waitForLockWaiters` (P1, P5; `testing-integration-db-isolation`). Pure decisions (fee computation per party, deduct-or-link, due date, low-credit, transition matrix, top-up headroom, reminder cooldown) are table-driven unit tests with an injected clock (`testing-injected-clock`). Akahu is reached only through a gateway port: unit and integration tests use the fake adapter; the live adapter is tested against recorded fixtures (AC-INTEGRATION-1). Playwright covers top-up, auto-deduction, link payment, overdue and reminder on desktop and 360 px with axe.
- **Target test count**: about 135 across 6 phases. That is well above the 20-test guideline because the spec has 46 ACs across four money paths (billing, top-up, link payment, overdue) plus a webhook trust boundary, and the fee matrix (3 pricing models × party sizes 1-3 × snapshot drift) is one table-driven file whose rows are replayed as integration fixtures so the SQL and the TS cannot drift.
- **Load-sensitive tests**: race tests use `waitForLockWaiters`, never sleeps; wall-clock budgets stay load-tolerant (`techContext.md` Integration Testing Specifics). The 10-minute billing SLA is proven with the injected clock, not wall time.

### File Organization
- **New test files**:
  - `packages/shared/src/api/billing.test.ts`: strict bodies (no `status`, `userId`, `teamId`, `balance`, payment `amount`), `MoneyString` top-up amounts, idempotency keys, response shapes.
  - `packages/shared/src/billing/{payment-status,due-date}.test.ts`: the shared transition matrix fixture and the B2 due-date rule.
  - `apps/api/src/modules/billing/charge.test.ts`: per-party fee matrix from snapshots, all-or-nothing deduction, low-credit decision (B5), $0.00 party (B7).
  - `apps/api/src/modules/wallet/top-up.test.ts`: headroom, minimum (B1), one open top-up, over-cap and duplicate handling (B3).
  - `apps/api/src/modules/billing/reminders.test.ts`: cooldown (B6), settled refusal.
  - `apps/api/src/lib/akahu/{webhook-signature,live-adapter}.test.ts`: signature check over the raw body against recorded fixtures; request and status mapping.
  - `apps/api/test/integration/billing-schema.int.test.ts`: the D-87+ migration: transition guard, ledger invariant, `gst_number` immutability, new tables and uniques, migrate/rollback round trip (AC-VERIFY-2, 5).
  - `apps/api/test/integration/billing-engine.int.test.ts`: sweep and `bill-session` on allocator-produced registrations (AC-HAPPY-2, 3, 5, 6, 7, 11, AC-ASYNC-1, AC-ERROR-5, 9, AC-INTEGRATION-2).
  - `apps/api/test/integration/billing-races.int.test.ts`: duplicate `bill-session`, deduction vs top-up credit, two sessions for one player, payout block vs billing, webhook vs reconcile, 10 concurrent top-ups (AC-VERIFY-3, AC-INTEGRATION-3, AC-ERROR-2, 10).
  - `apps/api/test/integration/billing-overdue.int.test.ts`: `daily-overdue`, debt-gate interplay, reminders API (AC-HAPPY-8, 9, 10, AC-ERROR-8).
  - `apps/api/test/integration/wallet-api.int.test.ts`: wallet, top-up, payments/me, payment and attempts routes; payer-only 404 (AC-ENTRY-1, 2, AC-HAPPY-1, 4, 12, AC-ERROR-1, 3, 7).
  - `apps/api/test/integration/akahu-webhook.int.test.ts`: forged, replayed and valid events; payout-block handling; reconcile sweep (AC-ERROR-4, 6, AC-ASYNC-3).
  - `apps/api/test/integration/billing-logs.int.test.ts`: `billing.*`, `wallet.*`, `akahu.*` fields asserted, no secrets (AC-VERIFY-7).
  - `apps/api/test/integration/billing-reconcile-cli.int.test.ts`: `cli billing reconcile` zero and seeded discrepancies (AC-VERIFY-12).
  - `apps/web/src/lib/billing/{actions,labels,wallet-view}.test.ts`: Server Action error mapping, status copy, typed value kept.
  - `apps/web/e2e/billing.spec.ts`: AC-INTEGRATION-4.
- **Extend existing**:
  - `apps/api/test/integration/team-banking-gate.int.test.ts`: race the real `bill-session` instead of `payment-stand-in.ts` (AC-VERIFY-3).
  - `apps/api/test/integration/{schema,enum-parity,payments-snapshot}.int.test.ts`: new columns, enums, `gst_number` snapshot.
  - `apps/api/src/modules/registrations/boundaries.test.ts`: billing writes no `registrations` row; add the single-writer rules for `payments`, `player_credits`, `credit_transactions` (AC-VERIFY-11).
  - `apps/api/src/jobs/{registry,schedules,handlers}.test.ts`: `bill-session`, `akahu-reconcile`, real handlers in place of placeholders.
  - `apps/api/src/lib/auth/policy.test.ts`, `apps/api/src/lib/http/errors.test.ts`, `apps/api/src/lib/config/*.test.ts`: route policies, new error codes, Akahu config fail-fast (AC-VERIFY-1, 8).
  - `apps/api/src/openapi.test.ts`, `apps/api/src/coverage-gate.test.ts` (AC-VERIFY-10).
  - `apps/api/test/helpers/factories.ts`: wallet and top-up factories; keep `payment-stand-in.ts` only if another suite still needs it.
  - `apps/web/src/lib/teams/manage-areas.test.ts`, `apps/web/src/proxy.test.ts`, `apps/web/src/lib/api-client.test.ts`, `apps/web/src/app/teams/[teamId]/page.test.tsx`.

### What NOT to Test
- Who is billable (CONFIRMED, promoted, late-withdrawal fee, ban exclusion): owned and tested by registration-and-waitlist (`registrations-billing-handoff.int.test.ts`). Here we test that billing charges exactly what the hand-off returns.
- Session lifecycle rules other than PUBLISHED -> COMPLETED via billing: session-scheduling-engine.
- `is_payout_configured` derivation and banking removal: team-banking-and-gst. Here we test C-BIL-PAY at each payment-creation path and `payout_blocked_at` writes.
- Email delivery mechanics and FieldCrypto internals: platform-foundation. Here we test enqueue-in-transaction, idempotency keys and that link-bearing payloads are sealed.
- Akahu's own behaviour: only our mapping of its documented contract (recorded fixtures) and the manual sandbox smoke test.
- Invoice numbering and PDFs: tax-invoices-and-exports.
- Visual styling: UAT covers it.

### Per-Phase Test Guidance
- **Phase 1** (about 22 tests): migration (transition guard matrix incl. PAID terminal, ledger invariant refusals, `gst_number` column + immutability, `wallet_top_ups`/`payment_attempts` uniques incl. one open per wallet/payment, reminder columns, D-75 allowlist if widened), migrate/rollback round trip, enum parity, shared zod contracts and matrix fixture, new error codes, Akahu config fail-fast and fake-in-production refusal, gateway port contract run against the fake.
- **Phase 2** (about 35 tests): fee matrix per pricing model and party with snapshot drift; deduct-or-link; B2 due date; B5 low-credit; B7 $0.00 party; B8 blocked team holds the session; sweep selection (ended PUBLISHED only, never before `starts_at`); singleton job; replay is a no-op; rollback leaves nothing; C-BIL-PAY races in both orders (replacing the stand-in); lock-order races; GST snapshot incl. `gst_number`; billing on allocator-produced registrations; emails enqueued with cause-derived keys and sealed.
- **Phase 3** (about 18 tests): `daily-overdue` boundary at `due_date - 1 ms` and `due_date`, idempotent same-day re-run, one email per transition; debt gate counts the new OVERDUE rows; admin payments list (filters, team scope, global admin, no emails or bank details); reminders 202/409/404/403 incl. cooldown and `changeKey` replay; OVERDUE written only by this job (grep test).
- **Phase 4** (about 30 tests): top-up start (headroom, minimum, one open, idempotency key), Akahu unavailable -> 503 with nothing open, Akahu call never under a DB lock; payment attempts (one open, settled refusal); webhook signature (missing, wrong, unknown key, tampered, replay); the shared "apply Akahu result" function (credit once, PAID once, OVERDUE -> PAID, decline leaves payable, destination-account decline sets `payout_blocked_at` and notifies admins); B3 over-cap and duplicate recording; reconcile sweep incl. stuck warning; webhook vs reconcile race; live adapter mapping against recorded fixtures.
- **Phase 5** (about 18 tests): Server Actions error mapping; wallet page states (empty, pending top-up, processing, full, error); payment page states (pending, overdue, processing, paid, declined, payout blocked); payer-only not-found; team-page wallet line for APPROVED only; Payments manage area and reminder confirm; proxy protection and `returnTo`; debt-block link.
- **Phase 6** (about 12 tests): Playwright journeys (top up; session ends and fee deducted; second player pays via Mailpit link; overdue; admin reminder) on desktop and 360 px with axe, no horizontal scroll, 44 px targets; `cli billing reconcile` zero and seeded discrepancy; coverage gate.

## Implementation Roadmap

### Architectural Plan

#### Executive Summary
Add billing as two `modules/<feature>` slices plus one adapter: `modules/billing` (post-game engine, payments, overdue, reminders, the shared "apply Akahu result" function), `modules/wallet` (wallet reads, top-up intents, the ledger writer) and `lib/akahu` (a gateway port with live and fake adapters, webhook signature verification). The post-game sweep enqueues one `bill-session` job per ended PUBLISHED session; that job, in one transaction under the canonical lock order, checks C-BIL-PAY, completes the session, reads `listBillableRegistrations`, and for each registration either deducts the whole fee from the wallet (PAID, `PREPAID_CREDIT`, ledgered) or creates a PENDING `PER_GAME` payment due per B2, enqueuing emails in the same transaction. Every Akahu interaction happens outside database locks; its result is applied by one idempotent function shared by the webhook, the reconcile sweep and the return pages. The database backstops every money invariant (P1).

#### Business Context
This is the feature that makes the product pay: until it ships, sessions never reach COMPLETED, nobody is charged, OVERDUE is never written (so the registration debt gate is inert), and team admins chase money by hand. Correctness beats speed: a double charge, a lost top-up or a charge sent to the wrong account destroys trust in a small community product. Stakeholders: players (predictable, low-friction payment, never charged twice), team admins (money lands in their account, visibility of who owes, a reminder button), global admins (cross-team reminders), and tax-invoices-and-exports (a complete GST snapshot per payment).

#### Vision and Goals
- **Vision**: every game is paid for exactly once, into the right team's account, without an admin chasing anyone.
- **Goals**:
  - Every ended session COMPLETED and billed within 10 minutes of `ends_at` while the worker runs; zero half-billed sessions (single transaction per session).
  - Zero double charges and zero double credits under concurrent jobs, webhooks and reconcile (proven by real-connection races).
  - Wallet balance always equals the ledger (reconciliation check reports zero discrepancies on every suite's final state).
  - A missed webhook reconciled within one `akahu-reconcile` interval plus its age threshold.
  - `bill-session` for 30 registrations under 2 s; wallet and payment reads p95 under 300 ms.

#### Requirements
- **Functional**: the spec's 46 ACs, with rulings B1-B10 at their defaults (approved 2026-10-30).
- **Non-functional**: P1 integrity (DB-enforced transitions, ledger, cap, uniques), P2 money (`Money` only, HALF_UP, all-or-nothing), P3 time (UTC instants, injected clock read once after locks), P4 encryption (payee decrypted in memory for the Akahu call only; any stored Akahu token is an envelope with a key id), P5 async (every side effect through pg-boss in the triggering transaction; no external call under a lock), P7 config (fail-fast Akahu settings, adapter by env), security (raw-body webhook signature, payer-scoped reads, strict bodies, sealed links), privacy (no emails or bank details in logs or admin views), 7-year retention (RESTRICT FKs), accessibility (AC-VERIFY-9).

#### Architectural Principles
1. **Billing is the only writer of money state**: `payments` status, `player_credits`, `credit_transactions`, `game_sessions` COMPLETED and `teams.payout_blocked_at` are written only by `modules/billing` and `modules/wallet`, enforced by a structural test.
2. **One lock order, extended not reinvented**: `teams -> recurring_session_rules -> team_members -> game_sessions -> registrations -> registration_guests -> payments -> player_credits` (wallet position confirmed in architecture creative and recorded in ADR 0020).
3. **Never call Akahu while holding a lock**: intents are committed first, the Akahu call happens outside the transaction, and the result is applied in a new transaction.
4. **Signals are not truth**: a webhook is verified, then the payment is re-read from Akahu before state changes; the webhook, reconcile and return pages share one idempotent apply function.
5. **Decide in TS, enforce in SQL**: pure decision functions are table-tested; the database refuses any state they should never produce.
6. **Honour the upstream contracts**: ADR 0018 C-BIL-1..3 and C-ALL-1, ADR 0016 C-BIL-PAY and R3, ADR 0019 D-75, ADR 0004, 0009, 0012.

#### Architecture Alternatives (to settle in /yay:creative)
- **Akahu integration shape** (Q1): hosted one-off payment to a third-party account (default assumption) vs per-player OAuth connection with a stored encrypted token vs Akahu not viable for this flow (fallback: re-scope with the human). A `/yay:spike` on Q1 is recommended before architecture creative.
- **Payment link identity** (Q2): authenticated payer-only `/payments/[id]` (default) vs bearer `payment_link_token` link.
- **Ledger invariant enforcement** (Q4): trigger on `credit_transactions` (default) vs guarded write with a check constraint pair.
- **Billing transaction granularity** (Q4): one transaction per session (default) vs per registration.
- **Top-up intent model** (Q3): one open intent per wallet with headroom checked at start (default) vs a reservation that holds headroom.

#### Selected Architecture
Provisional (pending creative): the defaults above. The creative architecture, algorithm and journey docs, the Q1 spike result and ADR 0020 become binding for Phases 2-5. If Q1 shows Akahu cannot take a hosted one-off payment to the team's account, Phases 1 and 4 are re-planned before build (plan amendment), and the human decides whether to proceed with per-player connections.

#### Architecture Documentation
- **Components**:
  - `modules/billing/{sweep,bill-session,charge,engine-repo,overdue,reminders,apply-akahu-result,payout-block,emails,routes,service,repo,errors}.ts`
  - `modules/wallet/{routes,service,repo,top-up,ledger,errors}.ts`
  - `lib/akahu/{gateway,live-adapter,fake-adapter,webhook-signature,config}.ts`
  - `jobs/{post-game-billing,bill-session,daily-overdue,akahu-reconcile}.ts`
  - the web wallet page, payment page, team-page line and Payments manage area
- **Data flow, billing**: pg-boss cron -> `post-game-billing` sweep selects PUBLISHED sessions with `ends_at <= now` -> enqueue `bill-session` (`singletonKey`) -> handler opens a transaction -> `teams FOR KEY SHARE` + `is_payout_configured` (B8 hold if false) -> `game_sessions FOR UPDATE` -> guarded PUBLISHED -> COMPLETED -> `listBillableRegistrations` -> per registration: compute fee from snapshots -> insert payment + line items (GST snapshot incl. `gst_number`) -> lock wallet -> deduct whole fee (ledger row) or leave PENDING with due date -> enqueue emails -> commit.
- **Data flow, Akahu**: route commits an intent (top-up or attempt) -> calls Akahu outside the transaction -> returns the redirect URL -> Akahu redirects the browser back -> webhook (verified) or reconcile sweep or return page -> re-read from Akahu -> `applyAkahuResult` in a new transaction (credit once, PAID once, decline leaves payable, destination decline -> `payout_blocked_at` under `teams FOR NO KEY UPDATE` + admin emails).
- **Integration points**: registration-and-waitlist (`listBillableRegistrations`, `countOverdueByUser`, debt block link), team-banking-and-gst (C-BIL-PAY, `payout_blocked_at`, encrypted payee, GST settings, `team_banking_in_use`), session-scheduling-engine (`ends_at`, D-75 lifecycle trigger, `LOCK_ORDER`), platform-foundation (pg-boss, `send-email`, FieldCrypto, Money, Clock), Akahu (external).

#### Observability Requirements
- **Applies**: Yes. Reference `context/observability-requirements.md` during build.
- **Logging**: `billing.sweep.enqueued` (count), `billing.session.completed` (sessionId, payments, deducted, linked), `billing.session.blocked`, `billing.session.failed` (error class, SQLSTATE), `billing.overdue.marked` (count), `billing.reminder.sent`, `wallet.topup.started`/`credited`/`closed`/`overflow`, `akahu.request` (operation, status, duration), `akahu.webhook.accepted`/`rejected` (reason), `akahu.reconcile.applied`/`stuck`, `billing.payout.blocked`. Fields: ids, `MoneyString` amounts, status, `traceId`. Never bank account name or number, Akahu credentials or tokens, payment links or tokens, emails or raw webhook bodies. New field names are grepped against the global redaction keys first (learned rule `logging-redaction-global`).
- **Tracing**: existing HTTP and pg-boss spans; the Akahu HTTP client propagates `traceparent`; `bill-session` jobs carry the sweep's trace context.
- **Metrics**: no exporter yet (as ADR 0013/0015/0018); reserve names `billing_sessions_billed_total`, `billing_payments_total{billing_type}`, `akahu_requests_total{operation,outcome}`, `akahu_webhooks_total{outcome}`.
- **Configuration**: new env vars (final names in architecture creative): `AKAHU_ADAPTER` (`live` | `fake`, fake refused in production), `AKAHU_APP_ID`, `AKAHU_APP_SECRET`, `AKAHU_API_BASE_URL`, `AKAHU_WEBHOOK_*` (signature key settings), `AKAHU_RECONCILE_AGE_SECONDS`; all validated at boot and listed in `.env.example` and `docs/getting-started.md`.

#### API Requirements - REST
- **Involves REST API**: Yes.
- **OpenAPI Spec Location**: `apps/api/openapi.yaml` (generated, drift-tested), with 401/403 on every guarded route.
- **Endpoints**: `GET /teams/:teamId/wallet`, `POST /teams/:teamId/wallet/top-ups`, `GET /teams/:teamId/payments/me`, `GET /payments/:paymentId`, `POST /payments/:paymentId/attempts`, `GET /teams/:teamId/payments`, `POST /teams/:teamId/payments/:paymentId/reminders`, `POST /webhooks/akahu`.
- **Auth**: `requireTeamRole('MEMBER')`; `requireTeamRole('TEAM_ADMIN', { allowGlobalAdmin: true })`; `authenticated()` with payer scoping (uniform 404); `publicRoute()` + signature for the webhook only.
- **Build Phase**: load `context/api-rest-requirements.md`.
- **GraphQL**: No.

#### Risk Assessment
- **Risk**: Akahu cannot do a hosted one-off payment to a third-party account, or app approval takes weeks. **Mitigation**: spike Q1 first; the gateway port and fake adapter let Phases 1-3 proceed independently; Phase 4 gated on the spike; fallback re-scope with the human.
- **Risk**: double charge or double credit from at-least-once jobs, duplicate webhooks and reconcile racing. **Mitigation**: DB uniques (`UNIQUE(registration_id)`, one TOPUP per Akahu payment, one open intent), guarded transitions, one shared apply function, real-connection race tests.
- **Risk**: deadlocks between billing, top-up credit and banking removal. **Mitigation**: one extended lock order, no Akahu call under a lock, `waitForLockWaiters`-ordered races in both orders.
- **Risk**: a first-deploy backlog bills old sessions and floods emails. **Mitigation**: B9 accepted (bill all, oldest first); the operations guide warns, and the sweep is paced by the singleton queue.
- **Risk**: breaking upstream contracts (registration boundaries, D-75, banking gate). **Mitigation**: AC-VERIFY-11; upstream contract suites run unchanged in every phase review.
- **Risk**: secrets leaking via logs or job payloads. **Mitigation**: sealed link-bearing emails, redaction grep, log-field assertions.

### New Source Files (pin path + extension)
- [ ] `db/migrations/<utc>_wallet_and_billing.sql`: payment transition guard, `payments.gst_number` (+ immutability), `last_reminder_at`, `reminder_count`, `wallet_top_ups`, `payment_attempts`, ledger-invariant enforcement, any D-75 allowlist or `team_banking_in_use` widening (D-87 onwards)
- [ ] `packages/shared/src/api/billing.ts` (+ `.test.ts`): zod contracts for wallet, top-ups, payments, attempts, reminders
- [ ] `packages/shared/src/billing/payment-status.ts` (+ `.test.ts`): transition matrix shared by TS and the SQL fixture
- [ ] `packages/shared/src/billing/due-date.ts` (+ `.test.ts`): B2 rule
- [ ] `packages/shared/src/billing/index.ts`
- [ ] `apps/api/src/lib/akahu/gateway.ts`: port interface and result types
- [ ] `apps/api/src/lib/akahu/live-adapter.ts` (+ `.test.ts`)
- [ ] `apps/api/src/lib/akahu/fake-adapter.ts`
- [ ] `apps/api/src/lib/akahu/webhook-signature.ts` (+ `.test.ts`)
- [ ] `apps/api/src/lib/akahu/config.ts`
- [ ] `apps/api/src/modules/billing/sweep.ts`
- [ ] `apps/api/src/modules/billing/bill-session.ts`
- [ ] `apps/api/src/modules/billing/charge.ts` (+ `.test.ts`): fee per party, deduct-or-link, low-credit decision
- [ ] `apps/api/src/modules/billing/engine-repo.ts`
- [ ] `apps/api/src/modules/billing/overdue.ts`
- [ ] `apps/api/src/modules/billing/reminders.ts` (+ `.test.ts`)
- [ ] `apps/api/src/modules/billing/apply-akahu-result.ts`
- [ ] `apps/api/src/modules/billing/payout-block.ts`
- [ ] `apps/api/src/modules/billing/emails.ts`
- [ ] `apps/api/src/modules/billing/routes.ts`, `service.ts`, `repo.ts`, `errors.ts`
- [ ] `apps/api/src/modules/billing/reconcile-cli.ts`: `cli billing reconcile`
- [ ] `apps/api/src/modules/wallet/routes.ts`, `service.ts`, `repo.ts`, `errors.ts`
- [ ] `apps/api/src/modules/wallet/top-up.ts` (+ `.test.ts`)
- [ ] `apps/api/src/modules/wallet/ledger.ts`: the only writer of `player_credits` and `credit_transactions`
- [ ] `apps/api/src/jobs/post-game-billing.ts`, `bill-session.ts`, `daily-overdue.ts`, `akahu-reconcile.ts` (+ `.test.ts` where logic lives)
- [ ] `apps/api/test/integration/billing-{schema,engine,races,overdue,logs,reconcile-cli}.int.test.ts`
- [ ] `apps/api/test/integration/wallet-api.int.test.ts`, `akahu-webhook.int.test.ts`
- [ ] `apps/api/test/fixtures/akahu/`: recorded Akahu responses and signed webhook fixtures (`.json`)
- [ ] `docs/adr/0020-wallet-and-akahu-billing.md`
- [ ] `apps/web/src/lib/billing/actions.ts`, `labels.ts`, `wallet-view.ts` (+ `.test.ts`): no JSX, `.ts`
- [ ] `apps/web/src/components/billing/wallet-summary.tsx`, `top-up-form.tsx`, `payments-list.tsx`, `payment-status-tag.tsx`, `pay-button.tsx`, `reminder-confirm.tsx`
- [ ] `apps/web/src/app/teams/[teamId]/wallet/page.tsx` (+ `page.test.tsx`)
- [ ] `apps/web/src/app/payments/[paymentId]/page.tsx` (+ `page.test.tsx`)
- [ ] `apps/web/src/app/teams/[teamId]/manage/payments/page.tsx` (+ `page.test.tsx`)
- [ ] `apps/web/e2e/billing.spec.ts`
- [ ] extend: `packages/shared/src/api/errors.ts`, `packages/shared/src/index.ts`, `apps/api/src/app.ts`, `apps/api/src/worker.ts`, `apps/api/src/jobs/{registry,bootstrap,schedules}.ts`, `apps/api/src/lib/config/config.ts`, `apps/api/src/lib/db/types.generated.ts`, `apps/api/src/modules/sessions/locks.ts`, `apps/api/src/modules/registrations/boundaries.test.ts`, `apps/api/openapi.yaml`, `apps/api/test/helpers/factories.ts`, `apps/api/test/integration/team-banking-gate.int.test.ts`, `db/schema-deviations.md`, `vitest.config.ts`, `.env.example`, `docs/getting-started.md`, `apps/web/src/proxy.ts`, `apps/web/src/lib/api-client.ts`, `apps/web/src/lib/teams/manage-areas.ts`, `apps/web/src/app/teams/[teamId]/page.tsx`, `apps/web/src/components/registrations/registration-panel.tsx` (debt-block link)

### Phases
**Build gate**: do not start Phase 1 until the creative docs (architecture, algorithm, user journey, UI/UX) and a binding Creative Reconciliation section exist here. Do not start Phase 4 until creative Q1 (Akahu capability) is resolved with cited Akahu documentation; if it changes the integration shape, amend this plan first. Before Phase 1, re-confirm that ADR 0020 and D-87 are still free on `main` and that no migration newer than `20261026000100000` has landed.

- [ ] **Phase 1: Schema, shared contracts and the Akahu port**: the D-87+ migration, regenerated types, zod contracts, transition matrix fixture, due-date rule, error codes, Akahu config (fail-fast, fake refused in production), gateway port with the fake adapter, `LOCK_ORDER` gains the wallet, factories. ACs: AC-VERIFY-2, AC-VERIFY-5 (schema half), AC-VERIFY-8.
- [ ] **Phase 2: Post-game billing engine and wallet ledger**: `post-game-billing` sweep, `bill-session` queue and handler, fee computation from snapshots, payments + line items + GST snapshot, all-or-nothing deduction through `wallet/ledger.ts`, B2/B5/B7/B8/B9, payment-due and low-credit emails, C-BIL-PAY at every creation path (replacing `payment-stand-in.ts` in the gate race), single-writer structural test, ADR 0020 draft. ACs: AC-HAPPY-2, 3, 5, 6, 7, 11, AC-ASYNC-1, AC-ASYNC-4 (billing emails), AC-ERROR-5, 9, AC-VERIFY-3, 4, 5, 6, 11, AC-INTEGRATION-2, AC-INTEGRATION-3 (billing races).
- [ ] **Phase 3: Overdue job, admin payments list and reminders**: real `daily-overdue` handler, overdue emails, `GET /teams/:teamId/payments`, `POST .../reminders` with B6 cooldown and `changeKey`, route policies, OpenAPI. ACs: AC-HAPPY-8, 10, AC-ERROR-8, AC-VERIFY-1 (these routes), AC-VERIFY-6 (overdue boundary).
- [ ] **Phase 4: Akahu flows: top-ups, payment attempts, webhook and reconcile** (follows the Q1 spike and architecture creative): live adapter against recorded fixtures, top-up and attempt routes, `GET /payments/:id`, `GET .../wallet`, `GET .../payments/me`, `POST /webhooks/akahu` with raw-body signature verification, `applyAkahuResult`, payout block (R3), B3 overflow and duplicates, B10 payee at payment time, `akahu-reconcile` queue and slot, payment-received email. ACs: AC-HAPPY-1, 4, 9, 12 (API side), AC-ERROR-1, 2, 3, 4, 6, 7, 10, AC-ASYNC-3, AC-VERIFY-7, AC-INTEGRATION-1, AC-INTEGRATION-3 (Akahu races).
- [ ] **Phase 5: Web wallet, payment page and Payments manage area** (follows the UI/UX and journey creative docs): team-page wallet line, `/teams/[teamId]/wallet`, `/payments/[paymentId]` with processing states (`RefreshWhilePending`), `/teams/[teamId]/manage/payments` with `ConfirmDisclosure` reminder, `MANAGE_AREAS`, proxy, api-client, Server Actions, debt-block link. ACs: AC-ENTRY-1 to 4, AC-ASYNC-2, web side of AC-HAPPY-1, 4, 9, 10, 12 and AC-ERROR-1, 3, 4, 7.
- [ ] **Phase 6: E2E, reconciliation CLI, accessibility and docs**: `apps/web/e2e/billing.spec.ts` on both viewports with axe, `cli billing reconcile`, coverage gate, ADR 0020 final, operations guide in `docs/getting-started.md`, `systemPatterns.md`/`techContext.md`/`productBrief.md` updates, sandbox smoke test checklist. This phase delivers the complete entry-to-success flow. ACs: AC-VERIFY-9, 10, 12, AC-INTEGRATION-4.

## Creative Phases

Level 4: creative is required.
- [ ] **Architecture Design** (required): Q1 (Akahu integration shape: technical shape settled by spike, Plan Amendment A1; still design the gateway port, top-up/attempt flows and the manual R3 action per A3), Q2 (payment link identity), Q4 (ledger enforcement, lock order, transaction boundaries, module split, shared apply function). Status: pending.
- [ ] **Algorithm Design** (required): Q3 (top-up intent, cap, duplicates per B3) and Q6 (post-game edge cases per B8/B9, departed members, long worker outage). Status: pending.
- [ ] **User Journey Design** (required for Level 4): Q5 journey (top-up, pay-by-link, overdue, reminder; debt-block link target across teams; the seven emails' copy). Status: pending.
- [ ] **UI/UX Design** (required): Q5 UI (wallet page, payment page, Payments manage area, processing and error states). Status: pending.
- **Reconciliation step**: after the parallel creative docs return, write one binding Creative Reconciliation section here before build (lesson from team-management and registration-and-waitlist).

### Plan Amendment 2026-10-31 (binding; spike `akahu-payment-capability`, Gate #2)

Source: `memory-bank/research/wallet-and-akahu-billing-akahu-payment-capability-spike.md` (approved; ADOPT 5 · BORROW 2 · TRAP 10 · DEFER 7) and its handoff. Overrides OV-1, OV-2, OV-3 accepted by Quy Nguyen. These supersede the spec and plan where they conflict; creative treats DR-001 to DR-005 as provisional inputs.

- **A1 (DR-001, OV-2) Integration shape: Akahu One-Off Payments, conditional.** `POST api.payments.akahu.io/v1/one-off-payments` with platform app token + secret; payee = team account name + number decrypted per call (B10 at payment time); player redirected to `authorisation_url` from our `/payments/[id]` or top-up start. No per-player or per-team Akahu credentials; no per-player token table. Creative Q1 is answered for the technical shape. **Go/no-go**: Akahu's written answer to MVE-001 (third-party team payees under Tier 1, payee-verification liability, first-payment holds, distinct-payee caps) is required before signing the Akahu contract, accepting ADR 0020, or building the Phase 4 live adapter. If Akahu imposes a payee-verification liability term, the human rules on verifying team bank details at save time before ADR 0020 is accepted. A negative answer stops Phase 4 and triggers a re-plan (U10 platform-first settlement / U11 other vendors). Phases 1-3 proceed behind the gateway port and fake adapter, accepting that Phase 1's `payment_attempts`/`wallet_top_ups` tables encode the one-off lifecycle and may need a follow-up migration.
- **A2 (DR-004, OV-1) Status mapping.** SENT → payment PAID / top-up credited once (re-read amount checked against stored amount); READY/AUTHORISED/SUBMITTED → attempt open, payment PENDING/OVERDUE; CANCELLED/* and FAILED/{REJECTED, BANK_ERROR, INTERNAL_ERROR} → attempt closed, payment payable (B4); **FAILED/BANK_ERROR_INDETERMINATE → hold**: payment not payable, no new attempt, flagged for ops, no "You haven't been charged" copy, until U4/MVE-004 resolves; unknown status → attempt left open and logged. AC-ERROR-3 and AC-ERROR-10 are read with this hold branch; algorithm creative designs the hold state and its admin/ops surface.
- **A3 (OV-3) AC-ERROR-4 trigger is manual.** See the note under AC-ERROR-4. Architecture creative designs the GLOBAL_ADMIN "mark payout blocked" action (route, policy, audit log) that reuses the R3 transaction.
- **A4 (DR-003) Webhook conditions.** `X-Akahu-Payments-Signature`/`-Signing-Key`, RSA-SHA256 over raw bytes, key from `GET /v1/webhooks/keys/{keyId}`; validate and URL-encode the key id, single-flight fetches, negative-cache unknown ids, cap fetches per window; answer 5xx (not 401) when the key fetch itself fails; correlate only by the stored `_payment` id, never URL params; ignore unknown `_payment`; the webhook is a signal, truth is `GET /v1/one-off-payments/{id}` plus `akahu-reconcile`; return 2xx within 10 s. Do not reuse the enduring-webhook dialect or the `akahu` SDK's `validateWebhook` unchanged. Add the signature headers to log redaction.
- **A5 (DR-002, DR-005) Client and idempotency.** Thin hand-written client in `apps/api/src/lib/akahu/` over `FetchLike`/`providerFetch` with manual `traceparent` and 429 backoff; no `akahu` npm dependency. Create is an inline call between tx1 (intent row) and tx2 (record `_id`/`authorisation_url`), outside any lock, never blindly retried; the queued job is the reconcile/orphan-cleanup safety net (`PUT .../cancel` in READY). Never pre-create a payment at billing time or email an Akahu link. Read bank limits at runtime (`limits.oneoff[]`), never hard-code them.
- **A6 Adapter config.** Rename the planned `AKAHU_ADAPTER` to follow the BORROW: `PAYMENTS_ADAPTER=akahu|fake`, fake refused in production; architecture creative fixes final env names.
- **A7 New gates.** Phase 4 also requires: MVE-001 answer (go), sandbox credentials (MVE-002), and MVE-005 (a verified signed sandbox webhook stored as a fixture). Each AC-INTEGRATION-1 fixture carries provenance (sandbox-real, vendor-doc-derived, synthetic). Byte-level details (auth header, padding) are re-read from the live Akahu pages at the Phase 4 gate, because the spike read them through digests.
- **A8 Open items for creative/ops** (no change to scope): the Akahu fee model (U8, outside B1-B10; human ruling after the quote); an open top-up holds no `payments` row, so it does not hold the `team_banking_in_use` guard (algorithm Q3 and the D-87+ migration decide); SENT received for a locally closed attempt or top-up routes to B3.

**Action for the human (outside the code):** send the MVE-001/MVE-002 email to hello@akahu.nz (the handoff has the question list).

---

## Execution State

**Build Status**: IDLE
**Current Phase**: CREATIVE
**Current Step**: Spike complete, Plan Amendment 2026-10-31 recorded; next /yay:creative
**Can Resume**: NO
**Spike Phase**: 4 — complete (artifact `akahu-payment-capability` approved 2026-10-31, option A; OV-1..OV-3 accepted; run_id 20261030-ac067d8f6863)

### Active Sub-Agents
(none)

### Completed Steps
- Step 0.1 - Task auto-provisioned from roadmap feature (2026-10-30)
- Step 3 - Spec Writer Agent (Opus) - COMPLETE; taxonomy lint CLEAN; human approved with B1-B10 defaults (2026-10-30)
- Steps 4-6 - Codebase analysis, Level 4 architectural plan, test strategy, 6 phases - COMPLETE (2026-10-30)
- Spike akahu-payment-capability (deep; 4 lanes + DRP-001/002; synthesis Opus; 3 adversarial challenges, first-principles) - COMPLETE; Gate #2 option A, OV-1..OV-3 accepted; Plan Amendment A1-A8 (2026-10-31)
