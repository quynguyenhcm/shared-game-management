---
slug: tax-invoices-and-exports
feature: tax-invoices-and-exports
status: BUILD_COMPLETE
---

# tax-invoices-and-exports: Tax Invoices and Exports

**Complexity**: Level 3
**Status**: BUILD_COMPLETE
**Roadmap**: tax-invoices-and-exports
**Branch**: feature/tax-invoices-and-exports
**Worktree**: /Users/admin/yay-wt/shared-game-management/feature-tax-invoices-and-exports

## Task Description

NZ GST compliance outputs (PRODUCT-OVERVIEW §8), from roadmap feature `tax-invoices-and-exports` (v1.0.0, Level 3):

- GST split for GST-registered teams: `GST = Total * 3 / 23`, stored per payment (subtotal + GST)
- PDF tax invoices/receipts with team IRD/GST numbers, sequential invoice numbers and the GST breakdown (per IRD taxable supply information rules)
- CSV/Excel income exports: custom date range, GST bi-monthly periods, and the NZ financial year (Apr 1 – Mar 31)

**Depends on**: wallet-and-akahu-billing (Phases 1-6 merged to main in PR #9, 2026-11-09; Akahu live adapter, Phase 4b, still gated, so payments run on the fake adapter in dev and E2E).

**Complexity rationale**: PDF generation + export formats + tax rule correctness across billing and admin UI → Level 3.

## Specification

**Feature Type**: End-User Feature
**Primary Persona**: Player (`PLAYER`, an APPROVED member of a team) who has paid a game fee and needs a downloadable PDF tax invoice or receipt for it (PRODDUCT-OVERVIEW section 2 Tab 3 and section 8). Secondary: Team Admin (`TEAM_ADMIN`, per team) of a GST-registered team, who exports income reports for a date range, a GST return period or the NZ financial year, and can fetch any player's invoice from the Payments area. Downstream consumers: player-dashboard (its "Payments & Wallet" tab links to the invoice download this feature ships) and admin-reporting-dashboard (may reuse the period helpers). Not a persona here: `GLOBAL_ADMIN` (see Scope Boundaries and H9).
**Creative Exploration Needed**: Yes. LOW confidence on tax-rule questions (who the supplier is, what an invoice must show, how prepaid wallet credit and refunds are treated), which are accountant or human decisions, not design decisions. MEDIUM on the invoice-snapshot and issuance architecture, the PDF and Excel library choice, and the export surface. The Invocation Method is MEDIUM. Details in "Creative Exploration Needed" and the human rulings H1-H12.

*Note: like registration-and-waitlist and wallet-and-akahu-billing, this End-User spec also delivers cross-cutting correctness and infrastructure (gapless issuance under concurrency, immutable 7-year records, DST-safe period boundaries). Following that project precedent, the structural checks are written as `AC-VERIFY`, `AC-ASYNC` and `AC-INTEGRATION` criteria. Section 8 of the overview says tax receipts are generated "for players" and exports are for Team Admins; this draft follows that split.*

*Basis for this draft* (read from `main` at `fbfc816`, which contains wallet-and-akahu-billing Phases 1-6; nothing below is assumed):
- **The GST split is already stored per payment, so roadmap bullet 1 is mostly delivered.** `payments` (`db/migrations/20260929000900000_payments_and_invoicing.sql`, D-19) has `gst_registered`, `gst_rate_bps` (1500 or 0, CHECK `gst_registered = (gst_rate_bps > 0)`), and the `STORED` generated columns `gst_amount = round(amount * bps / (10000 + bps), 2)` and `subtotal_amount = amount - gst_amount` (HALF_UP, 3/23 at 1500 bps). Wallet-and-akahu-billing added `payments.gst_number` (D-88, a charge-time copy of `teams.gst_number`, CHECK `(gst_number IS NOT NULL) = gst_registered`), frozen by `payments_guard_immutable`. `insertCharge` (`apps/api/src/modules/billing/engine-repo.ts`) writes the snapshot in the statement that inserts the payment. The payment page already shows "Includes GST of ..." (`apps/web/src/components/billing/payment-detail.tsx`). What is left for bullet 1: expose the stored values on invoices and exports, and prove they agree with a TypeScript twin (`packages/shared/src/nz/gst.ts` has only `GST_RATE_BPS` and `gstFraction`; there is no function that computes the GST of an inclusive `Money`).
- **The invoice number machinery exists but nothing calls it.** `payments.invoice_number`, `invoice_issued_at`, `is_tax_invoice_issued` (CHECK `payments_invoice_issued_consistent`, `UNIQUE (team_id, invoice_number)`, set-once guard in `payments_guard_immutable`), the per-team counter table `team_invoice_counters`, and `assign_invoice_number(payment_id)` (locks the payment row, refuses a numbered payment with 23000 `payments_invoice_number_set_once`, bumps the counter, last statement before COMMIT) are in the first migration (D-22). `formatInvoiceNumber` (`packages/shared/src/invoice/invoice.ts`) renders `INV-000123`. `apps/api/test/integration/invoice-number.int.test.ts` proves gaplessness. ADR 0011 fixes the scheme but says "**Pending confirmation:** the numbering scheme and display format have not yet been confirmed by an accountant against IRD tax-invoice requirements", and that "voiding and credit notes (tax-invoices-and-exports) must not reuse numbers". Billing deliberately never sets `is_tax_invoice_issued` (ADR 0020 C-INV-1; wallet task Scope: "must not set `is_tax_invoice_issued`").
- **No PDF, Excel or CSV code or dependency exists.** No `pdf`, `csv` or `xlsx` package in any `package.json`, and no file-download route in `apps/web` (the only `route.ts` files are the auth callback and flash helpers). The web calls the API only server-side with the session bearer (`systemPatterns.md` Web to API), so a download must go through a Next route handler or server action that proxies the bytes.
- **Where money comes from, and what a PAID payment is.** `payments.status = PAID` is written only by `apps/api/src/modules/billing/apply-akahu-result.ts` (Akahu one-off payment, fake adapter in dev and E2E) and by `bill-session.ts` when a wallet covers the fee (`billing_type = PREPAID_CREDIT`, `paid_at = now`), plus hold resolution (`hold-resolution.ts`, a team admin or global admin records RECEIVED). `boundaries.test.ts` lists the allowed writers of `payments`; a new writer of the invoice columns must be added there. A wallet **top-up is not a payment row**: it lives in `wallet_top_ups` and `credit_transactions` (type `TOPUP`) and is a deposit, so it has no invoice and is not income in the payments table (see H4). A $0.00 charge is recorded PAID with no link (ruling B7). A late-withdrawal fee is also a `payments` row (`reason: LATE_WITHDRAWAL`).
- **What is not stored at charge time and an invoice needs.** `teams.name` is the only supplier-name source (no legal or trading name, no address column), and a team rename or a player name change would silently change a reprinted invoice, so an invoice needs an issue-time snapshot of the supplier name and the buyer name (`users.full_name`). No team rename route exists in v1 (`modules/teams/routes.ts` operationIds), but this must not be relied on. `payments` has the game (`registration_id` to `registrations` to `game_sessions`: location, `starts_at`) and `payment_line_items` (position 0 registrant, 1-2 guests, GST-inclusive `unit_fee`).
- **UI and API entry points.** The player payment page `apps/web/src/app/payments/[paymentId]/page.tsx` (payer-only, uniform 404 for anyone else; `GET /payments/:paymentId`, `modules/billing/player-routes.ts`); the per-team payment list `components/billing/payments-list.tsx` on `apps/web/src/app/teams/[teamId]/wallet/page.tsx` (`GET /teams/:teamId/payments/me`); the team admin Payments area `apps/web/src/app/teams/[teamId]/manage/payments/page.tsx` with `AdminPaymentsTable` (`GET /teams/:teamId/payments`, `requireTeamRole('TEAM_ADMIN', { allowGlobalAdmin: true })`, 50 per page, status filter including PAID). `MANAGE_AREAS` (`apps/web/src/lib/teams/manage-areas.ts`) currently has People, Banking and GST, Sessions, Payments; `GLOBAL_ADMIN_AREA_ID = 'payments'` is the only area a global admin who is not a team admin may open. Neither `PaymentResponse` nor `MyPaymentRow` carries an invoice number yet.
- **Time and money primitives to reuse.** `Money`/`MoneyString`, `multiplyByRatio`, `sum`, `toMoneyString`, `formatNZD` (`packages/shared/src/money/money.ts`, ADR 0009, HALF_UP); `localToInstant`, `instantToLocal`, `parseLocalDate`, `addLocalDays`, `formatNzDate`, `APP_TIME_ZONE = 'Pacific/Auckland'` (`packages/shared/src/time/time.ts`, ADR 0010, P3). There is no financial-year or GST-period helper yet. Coverage gate includes `packages/shared/src/{money,time,invoice,...,nz}/**` and the listed API modules; a new module adds its paths to `vitest.config.ts` in the same phase (`systemPatterns.md` Coverage gate).
- **Settlement-route independence (required by the task).** `payments.status`, `paid_at`, `amount` and the GST snapshot are the same whichever way the money arrived. The invoice and export read only those columns, never `payment_attempts`, `akahu_payment_id` or `credit_transactions`, so Akahu (live or fake), wallet debit and manual hold resolution produce identical invoices. The Akahu live adapter (Phase 4b) being gated therefore does not block this feature. The only route-specific field shown is a neutral "Paid by" label derived from `billing_type` (wallet credit vs bank payment); it is not required on the invoice (H11).
- **Highest ids in use:** ADR 0020 (next free **0021**, `docs/adr/0021-tax-invoices-and-exports.md`), ledger **D-98** (next **D-99**, in `db/schema-deviations.md`), newest migration `20261102000100000_wallet_and_billing.sql`.

### Invocation Method
- **Location**:
  - *Players:* the payment page `/payments/[paymentId]` and each PAID row in the per-team payment list on `/teams/[teamId]/wallet` (`PaymentRow` in `components/billing/payments-list.tsx`).
  - *Team admins:* a new team-admin area "Income exports" at `/teams/[teamId]/manage/exports` (a new entry in `MANAGE_AREAS`), and a per-row "Invoice" action on PAID rows of `AdminPaymentsTable` in the existing Payments area.
- **Element**:
  - Player: a link-styled button "Download tax invoice" (GST-registered snapshot) or "Download receipt" (non-registered snapshot) on a PAID payment with a payable amount. Not rendered for PENDING, OVERDUE, held or $0.00 payments.
  - Admin export: a form with a period type (Custom range, GST period, Financial year), the matching date inputs or selectors, a format choice (CSV or Excel) and a "Download" button.
  - API (proposed names, creative to confirm): `GET /payments/:paymentId/invoice` (payer only, `application/pdf`); `GET /teams/:teamId/payments/:paymentId/invoice` (team admin, same bytes); `GET /teams/:teamId/exports/income?format=csv|xlsx&from=YYYY-MM-DD&to=YYYY-MM-DD` (presets are resolved to `from`/`to` by shared helpers so the server has one range semantics). The web serves each through a Next route handler that forwards the session bearer and streams the bytes with `Content-Disposition: attachment` and `cache-control: no-store`.
- **Visibility**: the player button appears only while the payment is PAID (and amount > 0); the admin area appears in the manage nav for `TEAM_ADMIN` of that team. `GLOBAL_ADMIN` who is not a team admin does not see it (H9).
- **Navigation**: Player: sign in, open the team, "Wallet" (`/teams/[teamId]/wallet`) or follow a payment link to `/payments/[paymentId]`, press "Download tax invoice". Team admin: sign in, team, "Manage", nav item "Income exports". Invoice per payment: Manage, "Payments", filter "Paid", row action.
- **Confidence**: MEDIUM. The surfaces and the proven patterns (manage-area registry, payer-only payment page, admin payments table) are HIGH, but the exact route names, the "Income exports" placement (a tab inside Payments is the alternative) and the download mechanism through the Next layer have no precedent in the repo (no download route exists), so they are inferred.

### Success Criteria
- **User sees**:
  - A player who has paid sees a "Download tax invoice" (or "Download receipt") button, and the downloaded PDF names the team as supplier with its GST number, a sequential invoice number `INV-NNNNNN`, the issue date, the buyer, the game and its lines, and a subtotal, a GST amount (3/23 of the total) and the GST-inclusive total that equal the stored `payments` values.
  - A team admin sees an export that downloads as a CSV or an `.xlsx` file whose rows are the team's PAID payments in the chosen range and whose totals reconcile exactly to the sum of the rows.
  - A payment that is not paid shows no download action, and a download attempt gets a clear "available once the payment is paid" answer.
- **Verifiable at**: the downloaded file (PDF text extraction and PDF structure; CSV/XLSX cell values) in integration and Playwright tests; the payment page, wallet page, admin Payments table and the "Income exports" page.
- **Data persisted**: `payments.invoice_number`, `invoice_issued_at`, `is_tax_invoice_issued` (existing, set once, via `assign_invoice_number`); a new issue-time snapshot of what the document shows (supplier name, GST number, buyer name, game description, lines, subtotal, GST, total, document type) stored immutably so a reprint never changes (table or stored PDF bytes; creative decides; a migration and ledger rows D-99+ are expected); no change to the existing snapshot columns. Exports persist nothing (computed on request).
- **Observable within**: a payment that becomes PAID has its invoice downloadable within 30 seconds (job-driven issuance), and at once on first request if issuance has not yet run (issue-on-demand). A CSV or XLSX export for up to the row cap returns in one request (proposed row cap 50,000; creative question 5 confirms the number).

### Acceptance Criteria

#### AC-ENTRY-1: Player finds the invoice download on a paid payment
**Priority**: MUST
**Given** a signed-in APPROVED member who has a PAID payment of more than $0.00 in a team (paid by Akahu, by wallet debit, or by a manually resolved hold)
**When** they open `/payments/[paymentId]`, and separately the team's wallet page `/teams/[teamId]/wallet`
**Then** the payment page shows a "Download tax invoice" button (a GST-registered snapshot) or "Download receipt" (a non-registered snapshot) with an accessible name that includes the game and the amount, and the matching PAID row in the wallet page's payment list shows the same action; both are keyboard-reachable with a 44 px target at 360 px width

#### AC-ENTRY-2: Team admin finds Income exports and per-payment invoices
**Priority**: MUST
**Given** a `TEAM_ADMIN` of a team (GST-registered or not)
**When** they open the team's manage area
**Then** the nav shows "Income exports" (registered in `MANAGE_AREAS`, with `aria-current="page"` on it when open) and the page `/teams/[teamId]/manage/exports` shows the period selector, the format choice and "Download"; a plain MEMBER sees the no-access page with none of the area's content; a `GLOBAL_ADMIN` who is not an approved team admin does not see the link (H9)

#### AC-ENTRY-3: Team admin can fetch any paid payment's invoice from the Payments area
**Priority**: SHOULD
**Given** a team admin viewing `/teams/[teamId]/manage/payments` with the "Paid" filter
**When** the list renders
**Then** each PAID row with an amount above $0.00 carries an "Invoice" action for that payment (the admin never sees or needs the payer's email), and PENDING, OVERDUE and held rows carry none

#### AC-HAPPY-1: Player downloads a correct tax invoice for a GST-registered team
**Priority**: MUST
**Given** a GST-registered team (GST number `49091850`, name "Hōkio Badminton Club") and a player "Aroha Ngata" whose $23.00 game fee is PAID (one registrant line $23.00, no guests)
**When** the player presses "Download tax invoice"
**Then**
  1. the response is `200`, `content-type: application/pdf`, `content-disposition: attachment` with a file name containing the invoice number, and `cache-control: no-store`
  2. the PDF's extracted text contains "Tax Invoice", `INV-000001` (the first number for this team), the issue date in `dd/mm/yyyy` or the NZ format used by `formatNzDate`, the supplier name "Hōkio Badminton Club" with its macron intact, the GST number as printed `49-091-850` (format per H6), the buyer name "Aroha Ngata", the game location and start date, one line "$23.00", Subtotal "$20.00", GST (15%) "$3.00", Total "$23.00 including GST"
  3. the subtotal, GST and total printed equal the row's `subtotal_amount`, `gst_amount` and `amount` columns (not recomputed), and the player's invoice never contains an email address, a bank account digit or an Akahu reference

#### AC-HAPPY-2: Player with a guest sees a header-level GST breakdown that adds up
**Priority**: MUST
**Given** a GST-registered team and a payment of $37.00 made of a registrant line $17.00 and a guest line $20.00
**When** the player downloads the invoice
**Then** the PDF lists both lines with their GST-inclusive fees, prints GST once for the whole payment (`gst_amount` $4.83, subtotal $32.17, total $37.00) and does not print a per-line GST figure, so the printed figures always add up to the stored totals even when summing per-line GST would differ by a cent (H6 asks the accountant to confirm this layout)

#### AC-HAPPY-3: A non-GST-registered team's player gets a receipt, not a tax invoice
**Priority**: MUST
**Given** a team that was not GST-registered when the charge was created (`payments.gst_registered = false`, `gst_rate_bps = 0`, `gst_number` null), and one of its payments is PAID
**When** the player downloads the document
**Then** the PDF is titled "Receipt" (never "Tax Invoice"), prints the supplier name, receipt number, date, buyer, game, lines and the total, and prints no GST number, no GST line and no "includes GST" wording; the same download action reads "Download receipt" (H2 records the default and the alternative of issuing no document at all)

#### AC-HAPPY-4: Invoice numbers are sequential per team, stable and gapless
**Priority**: MUST
**Given** team A with three payments that become PAID in order, and team B with one
**When** all four invoices are issued and each is downloaded twice
**Then** team A's invoices are `INV-000001`, `INV-000002`, `INV-000003` (in issue order, no number skipped), team B's is `INV-000001`, each repeat download returns the same number, the same date and byte-identical content for the same stored snapshot, and `payments.invoice_number`, `invoice_issued_at` and `is_tax_invoice_issued` are set together

#### AC-HAPPY-5: The invoice is available whichever way the money arrived
**Priority**: MUST
**Given** three PAID payments of the same GST-registered team: one settled by the Akahu path (fake adapter, `billing_type = PER_GAME`), one settled by a wallet deduction (`PREPAID_CREDIT`), one settled by a held payment resolved as RECEIVED by a team admin
**When** the payer of each downloads their invoice
**Then** all three are real tax invoices with correct numbers and GST, the content differs only by the payment's own data, and none depends on a row in `payment_attempts`, `credit_transactions` or an Akahu response (so the gated live adapter changes nothing here)

#### AC-HAPPY-6: Team admin exports income for a custom date range as CSV
**Priority**: MUST
**Given** a GST-registered team with PAID payments on 3 June, 10 June and 25 June 2027 (NZ dates), plus one PENDING and one OVERDUE payment, and a wallet top-up in the same month
**When** the admin chooses Custom range 2027-06-01 to 2027-06-15 and format CSV and presses "Download"
**Then** the CSV has a header row and exactly two data rows (3 and 10 June), columns for invoice number, paid date (NZ local), game date, payer name, description, subtotal, GST, total, GST-registered flag, and payment method (wallet or bank), amounts as plain 2-decimal strings, the PENDING and OVERDUE payments are absent, the top-up is absent, and the file name states the team, the range and the format

#### AC-HAPPY-7: Team admin exports a GST bi-monthly period
**Priority**: MUST
**Given** the admin chooses "GST period" and one of the two bi-monthly alignments (periods ending Jan/Mar/May/Jul/Sep/Nov, or Feb/Apr/Jun/Aug/Oct/Dec; H8) and the period "1 Apr 2027 to 31 May 2027"
**When** they download
**Then** the rows are exactly the PAID payments whose NZ-local paid date falls on or between 1 April 2027 and 31 May 2027 inclusive, the period label and boundaries appear in the file name and (for Excel) the Summary sheet, and the same payments chosen through "Custom range" with those two dates produce an identical row set

#### AC-HAPPY-8: Team admin exports the NZ financial year (1 April to 31 March)
**Priority**: MUST
**Given** the admin chooses "Financial year" and "2026-27"
**When** they download
**Then** the range is 1 April 2026 to 31 March 2027 inclusive in Pacific/Auckland time; a payment paid at 31 March 2027 23:59 NZDT is in, one paid at 1 April 2027 00:00 NZDT (`2027-03-31T11:00:00Z`; NZ daylight saving ends on the first Sunday in April, so 1 April midnight is always NZDT) is out (it belongs to 2027-28), and the year selector lists the years that contain at least one PAID payment plus the current one

#### AC-HAPPY-9: Team admin exports Excel with a summary that reconciles
**Priority**: MUST
**Given** the same data as AC-HAPPY-6
**When** the admin chooses Excel and downloads
**Then** the `.xlsx` opens with a "Payments" sheet whose rows equal the CSV rows (money cells are numeric, formatted with 2 decimals, never text) and a "Summary" sheet with the team name, GST number (if registered), period label, row count, total subtotal, total GST and grand total, each equal to the sum of the rows and to a direct `SUM` over `payments` for the same filter

#### AC-HAPPY-10: GST arithmetic is 3/23 of the inclusive total, in one place
**Priority**: MUST
**Given** inclusive totals of $0.01, $0.50, $1.00, $5.00, $10.00, $12.00, $23.00 and $37.00 for a registered team
**When** the GST is computed by the shared TypeScript helper and read from `payments.gst_amount`
**Then** both agree to the cent for every vector (GST $0.00, $0.07, $0.13, $0.65, $1.30, $1.57, $3.00, $4.83 respectively), subtotal plus GST always equals the total, a non-registered team has GST $0.00 and subtotal equal to the total, and no `number`, `parseFloat` or `toFixed` is used in the new code (source scan, as in billing)

#### AC-ERROR-1: A payment that is not paid has no invoice and consumes no number
**Priority**: MUST
**Given** payments in each non-paid state: PENDING, OVERDUE, held (an attempt `HELD`), and one with an open Akahu attempt (processing)
**When** the payer requests the invoice URL directly
**Then** the API answers `409 invoice_not_available` ("An invoice is available once the payment is paid"), the page renders that sentence in place of the button, no invoice number is allocated (the team's `last_number` is unchanged), and when the held payment is later resolved as RECEIVED it becomes PAID and only then gets its number

#### AC-ERROR-2: Nobody can fetch an invoice or export that is not theirs
**Priority**: MUST
**Given** player X's PAID payment in team A
**When** another player, a member of team A who is not the payer, a `TEAM_ADMIN` of a different team B, and an unauthenticated caller each request that invoice, and a plain MEMBER and a team-B admin each request team A's export
**Then** the invoice answers the same `404 not_found` (payer-only uniform not-found, the existing payment-page rule) for everyone except the payer and a `TEAM_ADMIN` of team A, an unauthenticated caller gets 401, an export by a MEMBER gets 403 and by a team-B admin gets 403 with no data in the body, and every response carries `cache-control: no-store`

#### AC-ERROR-3: Invalid export input is refused with a message and no file
**Priority**: MUST
**Given** the Income exports form
**When** the admin submits an end date before the start date, a malformed or non-existent date (2027-02-30), a range longer than the allowed maximum (proposed: 5 years), a future-only range, an unknown format, or an unknown financial year
**Then** the API answers `422` with a field-level message (for example "The end date can't be before the start date"), the form shows it next to the field with the entered values kept, no file is returned, and nothing is written; a valid range with no PAID payments is not an error and downloads a file with only a header row (or zero totals in the Summary sheet)

#### AC-ERROR-4: An export too large to serve is refused, not truncated
**Priority**: SHOULD
**Given** a range that would return more than the row cap (proposed 50,000 rows)
**When** the admin downloads it
**Then** the API answers `422 export_too_large` ("Choose a shorter range"), the page shows that sentence, and no partial file is ever returned

#### AC-ERROR-5: A $0.00 payment gets no document and does not appear as a gap
**Priority**: MUST
**Given** a PAID `PER_GAME` payment of $0.00 (ruling B7) for a registered team
**When** the player opens the payment page, requests its invoice, or the admin exports the period
**Then** no download action is shown, the invoice request answers `409 invoice_not_available`, no number is consumed (so the sequence has no hole), and the export lists it (so counts reconcile to `payments`) with total, subtotal and GST of 0.00 and an empty invoice-number cell (H3 records the alternative of excluding it)

#### AC-ERROR-6: A late-withdrawal fee is invoiced as what it is
**Priority**: SHOULD
**Given** a PAID payment with `reason: LATE_WITHDRAWAL` for a registered team
**When** the payer downloads the invoice and the admin exports the period
**Then** the invoice description reads "Late withdrawal fee, <location>, <date>" and the export row's description says the same, with the same stored GST as any other payment (H10 flags that IRD treatment of cancellation fees needs accountant confirmation)

#### AC-ASYNC-1: The invoice is issued automatically once a payment becomes PAID
**Priority**: MUST
**Given** a payment that moves to PAID by any route (the Akahu sync funnel, a wallet deduction in `bill-session`, a hold resolved as RECEIVED)
**When** the PAID transition commits
**Then** an issuance job is enqueued in the same transaction (P5), the worker assigns the number and writes the snapshot within 30 seconds, the player's button works without a page reload problem (the page refreshes while a number is pending, using the existing `RefreshWhilePending` pattern), and if the player presses the button before the job has run the request issues the invoice synchronously and returns the PDF (issue-on-demand), never a 5xx and never a number allocated twice

#### AC-ASYNC-2: Issuance is idempotent and leaves no gaps under retry, crash and concurrency
**Priority**: MUST
**Given** the issuance job delivered twice (at-least-once), a worker crash after the number is allocated but before commit, and ten payments of one team becoming PAID together
**When** the jobs run, including the crash and the concurrent attempts, and jobs for two different teams run at once
**Then** each payment ends with exactly one number, a crashed attempt rolls the counter back so the sequence is gapless, ten concurrent issues give ten distinct consecutive numbers, the allocation happens last before COMMIT with `SET LOCAL lock_timeout = '5s'` and the lock order payment row then team counter row (ADR 0011), and no transaction allocates for two teams

#### AC-ASYNC-3: A payment paid before this feature deployed is still invoiced
**Priority**: SHOULD
**Given** a PAID payment with no invoice number (paid before issuance existed, or whose job failed and was dead-lettered)
**When** the payer or the team admin first requests its invoice
**Then** the invoice is issued on demand with the next number and `invoice_issued_at = now` (the date of issue), the document also shows the original paid date, and a failed job is visible in the existing job-failure tracking rather than lost

#### AC-VERIFY-1: Printed GST and totals are the stored values, never recomputed
**Priority**: MUST
**Given** every PAID payment in a mixed fixture (registered and not, with and without guests, wallet and bank)
**When** the invoice view model and the export rows are built
**Then** subtotal, GST and total come from `subtotal_amount`, `gst_amount` and `amount`; a test that mutates the fixture's rate or recomputes with a different rule fails; the parity matrix compares the shared TypeScript helper with the database for a generated range of totals (every cent from $0.00 to $100.00 and a sample up to the field maximum)

#### AC-VERIFY-2: Export totals reconcile and the row filter is exactly "PAID in range by paid_at"
**Priority**: MUST
**Given** a fixture with PAID, PENDING, OVERDUE and FAILED payments, payments in other teams, and payments just inside and outside the range
**When** an export is produced
**Then** the rows are exactly the team's `status = 'PAID'` payments whose `paid_at` falls in the NZ-local inclusive range; the Summary totals equal the row sums and a direct SQL `SUM` (so totals are the sum of per-payment rounded values, not a re-rounded figure); other teams' payments never appear (H4 records that the filter basis is `paid_at`, a payments basis, not invoice date)

#### AC-VERIFY-3: Period boundaries are right in Pacific/Auckland, including daylight-saving changes
**Priority**: MUST
**Given** payments paid at instants around: 31 March 2027 23:59:59 NZDT and 1 April 2027 00:00:00 NZDT; the clock changes on the first Sunday in April and the last Sunday in September (NZ); 31 May and 1 June, and 30 November and 1 December in both bi-monthly alignments; 29 February in a leap year
**When** the range helpers convert local dates to instants (`[start 00:00 NZ, end + 1 day 00:00 NZ)`) and the filter runs
**Then** each instant lands in exactly one financial year and exactly one bi-monthly period of each alignment, with no payment counted twice or dropped, using the shared `localToInstant` (no host-timezone dependence, P3), and the financial-year and GST-period helpers live in `packages/shared` with their own test vectors

#### AC-VERIFY-4: Issued documents are immutable, snapshotted and kept for 7 years
**Priority**: MUST
**Given** an issued invoice, after the team's name or GST registration, or the payer's name, later changes (or a future rename route is added)
**When** the invoice is downloaded again
**Then** the supplier name, GST number, buyer name, game description, lines, amounts and date are exactly those at issue; there is no application path that updates or deletes an issued number or its snapshot (a raw `UPDATE` or `DELETE` is rejected by a trigger like `reject_modification`, and the FKs are `RESTRICT`), and a number is never reused (ADR 0011)

#### AC-VERIFY-5: Exports are safe to open in a spreadsheet and carry no sensitive data
**Priority**: MUST
**Given** a payer named `=HYPERLINK("http://x","click")` or `+1 Smith` or `@cmd` and a team name with a comma, a quote, a newline and a macron ("Hōhepa's, "Club"")
**When** the CSV and the XLSX are generated
**Then** a cell that begins with `=`, `+`, `-`, `@`, tab or carriage return is neutralised so no spreadsheet evaluates it (the stored name is unchanged), CSV quoting follows RFC 4180, the file is UTF-8 (a byte-order mark is used if the human wants Excel to read macrons directly; H7) and macrons survive a round-trip, and no email address, bank account digit, payment token or Akahu id appears in any column or sheet

#### AC-VERIFY-6: Authorization is enforced in the API, not only the UI
**Priority**: MUST
**Given** the role matrix: payer, other player, team MEMBER, TEAM_ADMIN of this team, TEAM_ADMIN of another team, GLOBAL_ADMIN, unauthenticated
**When** each calls every new route (player invoice, team invoice, export) with correct and with a guessed id
**Then** results follow AC-ERROR-2 exactly, the team guard runs before any query by id, a payment is always resolved together with its team and caller, and an OpenAPI entry exists for each route and passes the drift check

#### AC-VERIFY-7: Single writer, boundaries and decision records
**Priority**: MUST
**Given** the finished change
**When** the structural tests and the doc checks run
**Then** the only code that sets the invoice columns is the issuance module (added to the allow list in `modules/billing/boundaries.test.ts`, which proves its rule detects a violation), billing and wallet code still never set `is_tax_invoice_issued` except through that module, ADR 0021 and ledger rows from D-99 describe the schema and the decisions, ADR 0011's "pending confirmation" note is updated to the accountant's actual outcome (or restated as still pending with the date), the new module paths are in the `vitest.config.ts` coverage include list, and the coverage gate (80% aggregate, with new code read per file) passes

#### AC-VERIFY-8: New pages are accessible at phone width
**Priority**: MUST
**Given** the player payment page, wallet page rows, admin Payments table and the Income exports page at 360 x 740 and at desktop
**When** the E2E accessibility scan (axe, as in `team-banking.spec.ts` and `billing.spec.ts`) runs, including the form with a validation error shown
**Then** there are no critical or serious violations, no horizontal scroll, targets are at least 44 px, date inputs and selectors have visible labels, errors are announced and tied to their field, and focus is managed after a failed submit

#### AC-VERIFY-9: The accountant has confirmed the document content
**Priority**: SHOULD
**Given** the specimen PDFs (tax invoice with and without guests, a receipt for a non-registered team, an invoice for a late-withdrawal fee) and a specimen CSV and XLSX produced by the E2E run
**When** an accountant or the owner reviews them against IRD's current taxable supply information rules and the numbering scheme in ADR 0011
**Then** the outcome (approved, or the required changes) is recorded in ADR 0021 with the date and reviewer; until then the ADR and the product copy say the format is provisional (this is a manual criterion by nature: IRD requirements are not decided in code)

#### AC-INTEGRATION-1: The PDF is real, specific to the payment and renders New Zealand names
**Priority**: MUST
**Given** two different PAID payments (different teams, players, games, amounts) including a team named "Whangārei Shuttlers" and a player named "Tāne Wīremu"
**When** the generated PDFs are parsed with a PDF reader in the test (not just checked for a `%PDF-` header)
**Then** each file is a valid PDF with a non-trivial size and its own extracted text; the two documents differ in invoice number, supplier, buyer, game, amounts and GST; the macron characters appear correctly in the extracted text (so an embedded Unicode font is used, not a built-in WinAnsi font that cannot draw them); no text contains "TODO", "placeholder", "undefined", "NaN" or "[object"; and re-downloading the same invoice returns the same content

#### AC-INTEGRATION-2: Pay, download and export work end to end in a real browser
**Priority**: MUST
**Given** the Compose stack with the worker and the fake Akahu adapter (`PAYMENTS_ADAPTER=fake`), as in `apps/web/e2e/billing.spec.ts`, with a GST-registered team, a published paid session that has ended, and a player who owes the fee
**When** the player pays through the fake adapter, the worker applies the result, the player downloads the invoice from the payment page, a second player is billed from a wallet and downloads theirs, and the team admin downloads the CSV and the Excel export for the current month and the financial year
**Then** Playwright captures each download event, the PDF text shows the right team, number, GST and total, the two invoice numbers are consecutive, the CSV and XLSX each contain both payments with totals that equal the invoices' totals, and the same specs pass at 360 x 740 (the E2E needs no seeded rows except the two time fixtures the billing spec already documents, `endSession` and `makeDue`)

#### AC-INTEGRATION-3: The Excel file opens and equals the CSV
**Priority**: SHOULD
**Given** an exported `.xlsx`
**When** it is read back by an independent reader in the test
**Then** the "Payments" sheet equals the CSV row for row and column for column (money cells numeric), the "Summary" sheet reconciles to it, and the workbook contains no external link, macro or formula that the spreadsheet would evaluate

### Scope Boundaries
- **In scope**:
  - Per-payment documents: a PDF tax invoice for a GST-registered team and a PDF receipt for a non-registered team (default, H2), for every PAID payment above $0.00, available to the payer, and to the team's admins from the Payments area.
  - Sequential per-team numbering through the existing `assign_invoice_number`, issued automatically when a payment becomes PAID with an issue-on-demand fallback; the issue-time snapshot; ADR 0021 and its ledger rows; a migration for the snapshot (and any changes to `payments_guard_immutable`, the numbering function, or a guard for issued records that creative decides).
  - The shared TypeScript GST helper and its parity matrix against the generated columns; financial-year and GST bi-monthly period helpers; the shared export-row builder.
  - CSV and Excel (`.xlsx`) income exports for a custom range, a GST bi-monthly period (two alignments) and an NZ financial year, for one team, from a new "Income exports" team-admin area.
  - The Next download routes, OpenAPI entries, coverage config, the E2E journey, docs in `docs/getting-started.md` (how to export, what each column means), and the memory-bank updates.
  - Settlement-route independence: the same documents for Akahu, wallet and manual settlement; clear behaviour for payments that are PENDING, OVERDUE, held or processing (no document, no number).
- **Out of scope**:
  - Credit notes, debit notes, refunds and voiding or correcting an issued invoice. The app has no refund path in v1 (`REFUND` movements are refused by a CHECK; ruling B3 leaves over-cap and duplicate-payment refunds to the team outside the app), so there is nothing to credit. Numbers are still never reused so a later credit-note feature can be added without renumbering (ADR 0011). A team that must correct an invoice does it outside the app in v1 (H5).
  - GST return preparation or filing, any IRD or accounting-package integration (Xero, MYOB), and exports in any accounting-software import format.
  - Wallet top-up receipts or invoices (a deposit, not a supply; H4), invoices to guests or invoices addressed to a business buyer.
  - Emailing the PDF or attaching it to the payment-received email (COULD for later), zip or bulk invoice download, custom branding or logos, multi-language documents.
  - A cross-team or platform-wide export, a `GLOBAL_ADMIN` export, and the cross-team admin report (admin-reporting-dashboard). The player-dashboard "Payments & Wallet" tab will link to this feature's download; building that tab is not here.
  - Changing the charge-time snapshot, the billing engine or the Akahu adapter; new team profile fields (legal name, address) unless H6 rules them in.
  - Subscription billing (`MONTHLY_SUBSCRIPTION`, `QUARTERLY_SUBSCRIPTION`), and a GST rate other than 15% (the rate stays the snapshot per payment).
- **Dependencies**:
  - wallet-and-akahu-billing (Phases 1-6 on `main`): PAID payments, the GST snapshot incl. `gst_number`, the payment pages and the admin Payments area. Phase 4b (live Akahu) is not required.
  - team-banking-and-gst (merged): the team's GST registration and number, and the Banking and GST page where the number is maintained.
  - platform-foundation (merged): `assign_invoice_number`, ADR 0011/0009/0010, the job runner (ADR 0004), `Money` and `time` primitives, the test harness.
  - New third-party packages: a PDF generator and an Excel writer (H7). Neither exists today.
- **NFR implications**:
  - **Integrity (P1):** invoice numbers, the set-once rule and snapshot immutability are enforced in Postgres; TypeScript shapes the errors.
  - **Money (P2):** `Money` only; the stored GST is authoritative; no float conversion in new code.
  - **Time (P3):** all period boundaries are Pacific/Auckland local dates converted with the shared helpers; instants stay UTC.
  - **Async (P5):** issuance is a pg-boss job enqueued in the PAID transaction; downloads never call an external service.
  - **Security:** payer-only and team-admin-only reads with uniform 404/403 and `no-store`; no bank detail, email or payment token in any document; CSV formula-injection neutralised; request logs carry no payer name or amount (global redaction rules apply).
  - **Privacy and retention:** issued documents and the numbering are kept 7 years (productBrief); no delete path.
  - **Accessibility:** WCAG 2.2 AA on the new pages, 360 px reflow, 44 px targets (AC-VERIFY-8).
  - **Performance (no AC-PERF prefix is declared for this project):** an invoice renders in a single request, and an export of the row cap returns in one request without loading the rows into memory at once (stream or paged read); the creative phase sets and tests the numbers.

### Creative Exploration Needed
Yes. Questions for `/yay:creative`, in order of risk. The first group are **tax-rule and policy questions that need a human or an accountant, not a design**; do not invent answers in code. Each default is what the ACs above assume.

**Human rulings at spec review (Quy Nguyen, 2026-11-10):** spec approved with the defaults for H3-H6 and H8-H12, which stay accountant-checked before ADR 0021 is accepted (AC-VERIFY-9). **H1 RULED:** the team is the supplier; the platform issues the document as the team's agent; no platform GST number. **H2 RULED:** a non-GST-registered team's player gets a numbered "Receipt" with no GST wording (counter sharing, prefix and the `is_tax_invoice_issued` naming are left to the architecture creative). **H7 RULED (PDF):** pdfkit with an embedded TTF font that covers macrons; the Excel writer and the CSV BOM are still for the creative phase.

**Human rulings needed before build** (LOW confidence; none is decided by code or by the repo):
- **H1 Who is the supplier (LOW).** Default: the **team** is the supplier (the fee is paid into the team's own bank account and the GST number is the team's), and the platform issues the document on the team's behalf, as the supplier's agent, with the team's name and GST number as supplier and no platform GST number. Open: whether IRD treats the platform as an agent or as a separate supplier for any part, whether the document may say "issued on behalf of" with the platform's name, and whether a buyer-created invoice (RCTI) or a supplier-issued invoice applies (this draft assumes supplier-issued; no RCTI agreement exists). Needs the accountant.
- **H2 Documents for non-GST-registered teams (MEDIUM).** Default: a numbered "Receipt" with no GST wording. Only a GST-registered supplier may issue a tax invoice, so calling it a tax invoice would be wrong. Alternatives: issue nothing, or one document type with GST lines hidden. Also decide: one per-team counter shared by both kinds (the counter is gapless per team, ADR 0011, and a team can change registration status over time), a "R-" prefix, or numbers only for tax invoices. `payments.is_tax_invoice_issued` is named for tax invoices, so a receipt number may need a different flag or a rename.
- **H3 Which payments get a document (MEDIUM).** Default: every PAID payment above $0.00. The roadmap says "receipts" as well as invoices; the $0.00 case (B7) is listed in the export but not numbered. Confirm.
- **H4 Prepaid wallet credit and the export basis (LOW).** A top-up is a deposit, and the game fee is taken from it later. Default: the supply and the income date are the wallet deduction (`paid_at` on the `PREPAID_CREDIT` payment), top-ups are excluded from income exports, and the export filter is `paid_at` (a payments basis). Open: a team on the **payments** accounting basis may owe GST when the top-up is **received**, not when it is applied; a team on the **invoice** basis follows the invoice date; a team on a hybrid basis differs again. The `teams` table stores no accounting basis. Options: keep the default and print the basis in the export header, add an optional informational "wallet top-ups received" sheet, or add a team accounting-basis setting (a new field on Banking and GST). Needs the accountant.
- **H5 Credit notes and corrections (LOW).** Default: out of scope in v1, because the app issues no refunds. Open: how a team records a refund or a mistake made outside the app (for example a duplicate or over-cap Akahu payment returned by the team, B3), whether the 7-year record must show it, and whether a credit note needs to exist before the first real payment. ADR 0011 already forbids reusing a number; creative should leave a clean extension point (a separate credit-note table and number series) without building it.
- **H6 What an invoice must show (LOW).** IRD's taxable supply information rules vary by invoice size (a lower tier needs supplier name, GST number, date, a description and the total with a statement that GST is included; a higher tier also needs the buyer's identification and quantities), and the tiers and the exact wording are for the accountant to confirm, not for this draft to assert. Default content in the ACs: supplier name (team name snapshot), GST number, invoice number and date, buyer name, game description, lines, subtotal, GST at 15%, GST-inclusive total, and the paid date. Decide: the printed GST number format (as stored `49091850` or the IRD display form), whether the supplier needs a postal or trading address and legal name (the `teams` table has only `name`; adding fields means touching Banking and GST), and whether the buyer's name alone is enough. Game fees are small (the wallet cap is $100), so the lower tier is expected to apply, but no DB constraint limits a fee, so confirm the highest fee a team can set.
- **H7 Library choices (MEDIUM, human decision).** PDF: a pure-JavaScript generator that can embed a TTF font (needed for macrons, AC-INTEGRATION-1) such as pdfkit or pdf-lib, versus a React-to-PDF renderer, versus headless Chromium (heavy for the long-lived api container, ADR 0007, and not recommended). Excel: a maintained writer library versus a minimal hand-written OOXML writer; check licence, maintenance and known vulnerabilities at the time of choosing (do not assume). Also CSV encoding: UTF-8 with or without a BOM (Excel for Windows needs the BOM to show macrons correctly; the BOM breaks some importers). Font licence for the embedded font. Record the choice in ADR 0021.
- **H8 GST period alignment (MEDIUM).** NZ two-monthly returns come in two alignments (periods ending Jan/Mar/May/Jul/Sep/Nov, or Feb/Apr/Jun/Aug/Oct/Dec; confirm against IRD) and some businesses file monthly or six-monthly. The task says "bi-monthly", so the default is an export-time selector offering both two-month alignments and no schema change; the alternative is a stored per-team setting on Banking and GST (default for exports, one fewer choice). Decide whether monthly and six-monthly are needed.
- **H9 Who may export (MEDIUM).** Default: `TEAM_ADMIN` of the team only, `allowGlobalAdmin` off (like Banking and GST, because an export bulk-reads who paid what). The existing Payments area lets a global admin read for support; the invoice-per-row action there may follow that policy (a design question), but the export should not.
- **H10 Cancellation fees (LOW).** Whether a late-withdrawal fee is a taxable supply and how it is described. Default: invoice it like any other payment with a clear description; accountant to confirm.
- **H11 What a player sees about how they paid (MEDIUM).** Default: no payment-route detail on the invoice; the export has a neutral "wallet" or "bank" column from `billing_type`. Confirm the player-facing wording.
- **H12 Document date and tax point (MEDIUM).** Default: "Date of issue" is `invoice_issued_at` (NZ date) and the PDF also prints "Paid on" `paid_at`; exports are by `paid_at`. Confirm which date an accountant wants as the invoice date.

**Design questions for creative** (after the rulings):
1. **Invoice snapshot and issuance architecture (MEDIUM, architecture).** Store a frozen snapshot row (a new `payment_invoices` table keyed by payment, immutable, with the printed values) and render the PDF from it on demand, or store the rendered PDF bytes, or add columns to `payments`. Trigger: PAID writers call `assign_invoice_number` inside the PAID transaction (couples the counter lock to billing and the Akahu apply funnel, and adds a team-wide lock to a 30-registration `bill-session`) versus an `issue-invoice` job enqueued in the PAID transaction (default here, plus issue-on-demand on first request). Decide the guard (`payments_guard_immutable` already blocks changing a set number; the snapshot needs its own), the `team_banking_in_use`-style single-writer rule, and the module split (`modules/invoices`, `modules/income-exports`, `packages/shared/src/tax/`).
2. **Download mechanism through Next (MEDIUM, architecture).** A route handler that proxies the API response with the bearer, a signed short-lived URL, or a server action; how the filename, `Content-Disposition` and `no-store` are preserved; how a failed download renders an error in the page instead of a raw JSON body.
3. **PDF layout and typography (LOW, UI/UX).** A one-page A4 layout, fonts that cover macrons, how guest lines and the late-withdrawal wording read, the receipt variant, the wording of "includes GST", and a print-friendly black-and-white design. No design system exists for PDFs.
4. **Export UI (MEDIUM, UI/UX).** A new "Income exports" area versus a panel inside Payments; how the three period types share one form without confusing the date fields; where the financial-year list comes from; what the post-download state looks like (a download gives no page feedback unless the form says so).
5. **Export format and size (MEDIUM, algorithm).** CSV as detail rows only versus rows plus summary lines; the XLSX sheet layout; streaming or paged read for large ranges; the row cap and range limit values; deterministic ordering (paid date, then invoice number).
6. **Period helpers (MEDIUM, algorithm).** The shared API for financial year and GST period (inputs as `LocalDate`, outputs a `[from, to)` instant pair), leap years, the DST vectors in `time/dst-vectors.ts`, and how a selected "GST period" maps to the two alignments.
7. **Where the player-dashboard will plug in (LOW, architecture).** Which components and route the dashboard's "Payments & Wallet" tab reuses so it does not duplicate the download action; whether `MyPaymentRow` and `PaymentResponse` gain `invoiceNumber` and `invoiceAvailable` (a contract change both features share).

### Implementation Guide Required
Yes, for operations and for the accountant's sign-off, not for the code. Every acceptance criterion except AC-VERIFY-9 (the accountant's confirmation of IRD content and the numbering format) is auto-verifiable with the fake adapter, an injected clock and real PostgreSQL. A short guide in `docs/getting-started.md` must cover: how a team admin exports for a GST return period and for the financial year, what each CSV and Excel column means and how the totals reconcile to the invoices, how to re-run a failed `issue-invoice` job, what to do when a player says an invoice has the wrong detail (the stored snapshot is final; corrections are made outside the app in v1, H5), and the recorded outcome of the accountant's review of the specimens.

## Test Strategy

### Approach
- **Emphasis**: integration-heavy, as in wallet-and-akahu-billing. Gapless numbering, set-once issuance, snapshot immutability and the "PAID in range by `paid_at`" filter are proven against real PostgreSQL 17 and a real pg-boss queue; races (two issuers for one payment, two payments of one team issuing at once, issuance vs on-demand download) are ordered with `waitForLockWaiters`, never sleeps (P1, P5; `testing-integration-db-isolation`). Pure decisions (GST of an inclusive `Money`, financial-year and GST-period ranges, document kind, export row shaping, CSV cell neutralisation) are table-driven unit tests with an injected clock (`testing-injected-clock`). The PDF is parsed back to text in tests (no image snapshots); the XLSX is read back and compared with the CSV. Playwright covers pay → download → export on desktop and 360 px with axe.
- **Target test count**: about 90 across 5 phases. Above the 20-test guideline because the spec has 34 ACs over three settlement routes, two document kinds, three period types and two export formats; the GST parity matrix and the DST period vectors are single table-driven files.
- **Load-sensitive tests**: no wall-clock budget under 5 s for CPU-heavy tests (PDF render, period sweeps); give exhaustive sweeps an explicit timeout as in `packages/shared/src/time/time.test.ts` (PR #9 lesson). The 30-second availability target (Success Criteria) is proven with the injected clock and the job queue, not wall time.

### File Organization
- **New test files**:
  - `packages/shared/src/tax/periods.test.ts`: financial year, both GST two-month alignments, custom range, leap years, DST vectors (AC-VERIFY-3, AC-HAPPY-7, 8).
  - `packages/shared/src/api/invoices.test.ts`: strict query/response schemas for invoice and export endpoints (AC-ERROR-3).
  - `apps/api/src/modules/invoices/document.test.ts`: document kind (tax invoice vs receipt), line descriptions incl. late-withdrawal and guests (AC-HAPPY-2, 3, AC-ERROR-6).
  - `apps/api/src/modules/invoices/render-pdf.test.ts`: pdfkit output parsed to text: number, supplier, GST number, totals, macrons (AC-INTEGRATION-1, AC-VERIFY-1).
  - `apps/api/src/modules/income-exports/csv.test.ts`: column order, formula-injection neutralisation, no sensitive columns (AC-VERIFY-5).
  - `apps/api/test/integration/invoices-schema.int.test.ts`: snapshot migration, immutability guard, set-once, migrate/rollback round trip (AC-VERIFY-4).
  - `apps/api/test/integration/invoice-issuance.int.test.ts`: job enqueued in the PAID transaction for each writer, on-demand fallback, idempotency and concurrency, backfill of pre-feature PAID payments, no number for unpaid or $0.00 (AC-ASYNC-1, 2, 3, AC-HAPPY-4, 5, AC-ERROR-1, 5).
  - `apps/api/test/integration/invoices-api.int.test.ts`: payer and team-admin downloads, uniform 404/403, `no-store` (AC-ENTRY-1, 3, AC-HAPPY-1, AC-ERROR-2, AC-VERIFY-6).
  - `apps/api/test/integration/income-exports.int.test.ts`: range filter, reconciliation, row cap refusal, XLSX equals CSV (AC-HAPPY-6..9, AC-ERROR-3, 4, AC-VERIFY-2, AC-INTEGRATION-3).
  - `apps/web/src/lib/invoices/download.test.ts`: Next route-handler proxy (headers, filename, error mapping).
  - `apps/web/e2e/invoices.spec.ts`: AC-INTEGRATION-2, AC-VERIFY-8.
- **Extend existing**:
  - `packages/shared/src/nz/gst.test.ts`: `gstOfInclusive` parity matrix against the generated-column formula (AC-HAPPY-10).
  - `apps/api/test/integration/invoice-number.int.test.ts`: numbering under the new issuer and both document kinds.
  - `apps/api/src/modules/registrations/boundaries.test.ts`: single-writer rule for the invoice columns and the snapshot table (AC-VERIFY-7).
  - `apps/api/src/jobs/{registry,handlers}.test.ts`: the `issue-invoice` queue and handler.
  - `apps/web/src/lib/teams/manage-areas.test.ts`: the "Income exports" area and its TEAM_ADMIN-only visibility (AC-ENTRY-2).
  - `apps/api/test/integration/{schema,enum-parity}.int.test.ts`: new table/columns/enums.

### What NOT to Test
- pdfkit's own layout engine and fonts beyond what is printed — third-party; we assert extracted text, not pixels.
- The Akahu adapter and billing transitions — covered by wallet-and-akahu-billing; here only "a PAID transition enqueues issuance" per writer.
- IRD content rules — not machine-checkable; AC-VERIFY-9 is the accountant's sign-off on specimens.
- Excel's rendering of the file — we read the XLSX back with the same library and compare cell values.

### Per-Phase Test Guidance
- Phase 1: ~22 tests — GST parity matrix, period helpers and DST vectors, API schemas, snapshot schema and immutability guard.
- Phase 2: ~18 tests — issuance per PAID writer, on-demand fallback, idempotency/concurrency races, backfill, unpaid/$0.00 refusal, numbering.
- Phase 3: ~20 tests — document kind and lines, PDF text extraction (incl. macrons), payer/admin download routes and authorization, Next proxy, UI buttons per status.
- Phase 4: ~22 tests — export row filter and ordering, three period types, CSV safety, XLSX read-back equals CSV, row cap, manage area.
- Phase 5: ~8 tests — Playwright journey desktop + 360 px with axe, docs/OpenAPI checks, coverage gate.

## Implementation Roadmap

### Overview
Issue a numbered, immutable tax invoice (or receipt, H2) for every PAID payment above $0.00, render it to PDF with pdfkit on demand from a frozen snapshot, let players and team admins download it, and give team admins CSV/XLSX income exports by custom range, GST two-month period or NZ financial year. Builds on the stored GST split (D-19, D-88) and the dormant numbering machinery (D-22, ADR 0011); billing and Akahu code are not changed beyond enqueuing issuance on PAID. The phase split below is provisional: the Architecture and Algorithm creative phases may reshape Phases 1-2 (snapshot table vs stored bytes, job vs in-transaction issuance) and Phase 4 (streaming, row cap).

### Requirements
- **Functional**: per-payment PDF documents (tax invoice / receipt), sequential per-team numbering, automatic issuance with on-demand fallback and backfill, payer and team-admin downloads, three export period types in CSV and XLSX, an "Income exports" manage area.
- **Non-functional**: integrity in Postgres (P1), `Money` only (P2), Pacific/Auckland period boundaries (P3), issuance via pg-boss (P5), payer-only/team-admin-only reads with `no-store`, CSV formula-injection safety, 7-year retention with no delete path, WCAG 2.2 AA at 360 px.

### Component Analysis
- **New**: `packages/shared/src/tax/` (period helpers), `packages/shared/src/api/invoices.ts` (contracts), `apps/api/src/modules/invoices/` (issuance, snapshot repo, document model, pdfkit renderer, routes), `apps/api/src/modules/income-exports/` (row query, CSV/XLSX writers, route), `apps/api/src/jobs/issue-invoice.ts`, a migration for the snapshot, Next download route handlers, the "Income exports" page, ADR 0021.
- **Affected**: PAID writers (`modules/billing/apply-akahu-result.ts`, `jobs/bill-session.ts`, `modules/billing/hold-resolution.ts`) enqueue `issue-invoice` in the PAID transaction; `packages/shared/src/nz/gst.ts` gains `gstOfInclusive`; `MyPaymentRow`/`PaymentResponse` gain `invoiceNumber`/`invoiceAvailable` (shared contract with player-dashboard); `payment-detail.tsx`, `payments-list.tsx`, `AdminPaymentsTable`, `MANAGE_AREAS`; `apps/api/openapi.yaml`; `docs/getting-started.md`.

### Dependencies & Risks
- Risk: accountant rulings (H4, H5, H6, H10, H12) change document content after build → Mitigation: content lives in one document model and the PDF is rendered on demand from the snapshot, so wording changes do not touch stored records; ADR 0021 stays not Accepted until AC-VERIFY-9.
- Risk: a team-wide counter lock inside billing transactions → Mitigation: default to a job enqueued in the PAID transaction (architecture creative confirms).
- Risk: large exports exhaust memory → Mitigation: paged/streamed read and a row cap with a refusal, never truncation (AC-ERROR-4).
- Risk: new third-party packages (pdfkit, an XLSX writer) → Mitigation: check licence, maintenance and advisories at selection; record in ADR 0021; font licence for the embedded TTF.
- Risk: load-sensitive tests on CI (PR #9 lesson) → Mitigation: explicit timeouts for CPU-heavy tests, no tight wall-clock assertions.

### Observability Requirements
- **Applies**: Yes → load `${CLAUDE_PLUGIN_ROOT}/context/observability-requirements.md` during build.
- **Logging**: `invoice.issued` (payment id, team id, invoice number, kind), `invoice.issue.skipped` (reason: not_paid, zero_amount, already_issued), `invoice.downloaded` (payment id, actor role), `income_export.generated` (team id, period type, format, row count). Ids, counts and kinds only — no names, amounts, GST numbers or emails (global redaction keys checked first).
- **Tracing**: the `issue-invoice` job carries trace meta from the enqueuing transaction (existing `extractTraceMeta`); custom spans for PDF render and export generation.
- **Metrics**: none new beyond standard HTTP and job metrics.
- **Configuration**: none expected; the export row cap and range limit are env-configurable with defaults set in creative (e.g. `INCOME_EXPORT_MAX_ROWS`).

### API Requirements - REST
- **Involves REST API**: Yes
- **OpenAPI Spec Location**: `apps/api/openapi.yaml`
- **Endpoints Affected** (names provisional, architecture creative confirms): `GET /payments/:paymentId/invoice` (payer, `application/pdf`); `GET /teams/:teamId/payments/:paymentId/invoice` (team admin); `GET /teams/:teamId/exports/income?format=csv|xlsx&from=&to=` (team admin only); `PaymentResponse` and `MyPaymentRow` gain invoice fields.
- **Build Phase**: load `${CLAUDE_PLUGIN_ROOT}/context/api-rest-requirements.md`.

### New Source Files (pin path + extension)
Extensions follow the repo convention (`.ts` for logic and route handlers, `.tsx` for React components/pages, `.sql` migrations under `db/migrations/` with the `YYYYMMDDHHMMSSmmm_name.sql` stamp).
- [ ] `db/migrations/20261110000100000_tax_invoices.sql` — snapshot table/columns, immutability guard, document kind, numbering changes (exact shape from architecture creative)
- [ ] `packages/shared/src/nz/gst.ts` — extend: `gstOfInclusive(Money, bps)`
- [ ] `packages/shared/src/tax/periods.ts` — financial year, GST two-month periods (both alignments), custom range → `[from, to)` instants
- [ ] `packages/shared/src/tax/index.ts` — barrel, like `packages/shared/src/nz/index.ts`
- [ ] `packages/shared/src/api/invoices.ts` — invoice/export request and response schemas
- [ ] `packages/shared/src/api/billing.ts` — extend: `invoiceNumber`, `invoiceAvailable` on `PaymentResponse`/`MyPaymentRow`
- [ ] `apps/api/src/modules/invoices/repo.ts` — issue (calls `assign_invoice_number`), snapshot read
- [ ] `apps/api/src/modules/invoices/issue.ts` — issuance service (idempotent, on-demand fallback)
- [ ] `apps/api/src/modules/invoices/document.ts` — document model (kind, supplier, buyer, lines, totals) from the snapshot
- [ ] `apps/api/src/modules/invoices/render-pdf.ts` — pdfkit renderer with embedded font
- [ ] `apps/api/src/modules/invoices/routes.ts` — payer and team-admin invoice routes
- [ ] `apps/api/src/modules/invoices/errors.ts` — `invoice_not_available` etc.
- [ ] `apps/api/assets/fonts/<font>.ttf` — embedded font with macrons (licence recorded in ADR 0021; path confirmed in creative)
- [ ] `apps/api/src/jobs/issue-invoice.ts` — job handler; plus `registry.ts`/`bootstrap.ts` extend
- [ ] `apps/api/src/modules/income-exports/repo.ts` — "PAID in range by `paid_at`" paged query
- [ ] `apps/api/src/modules/income-exports/csv.ts` — CSV writer with cell neutralisation
- [ ] `apps/api/src/modules/income-exports/xlsx.ts` — XLSX writer (library from creative)
- [ ] `apps/api/src/modules/income-exports/routes.ts` — export route (TEAM_ADMIN only)
- [ ] `apps/web/src/app/payments/[paymentId]/invoice/route.ts` — Next download proxy (payer)
- [ ] `apps/web/src/app/teams/[teamId]/manage/payments/[paymentId]/invoice/route.ts` — Next download proxy (team admin)
- [ ] `apps/web/src/app/teams/[teamId]/manage/exports/page.tsx` — Income exports page
- [ ] `apps/web/src/app/teams/[teamId]/manage/exports/income/route.ts` — Next export download proxy
- [ ] `apps/web/src/components/invoices/download-invoice-link.tsx` — shared download action (reused by player-dashboard)
- [ ] `apps/web/src/components/invoices/income-export-form.tsx` — period-type form
- [ ] `apps/web/src/lib/invoices/download.ts` — shared proxy helper (bearer, headers, error mapping)
- [ ] `apps/web/src/lib/teams/manage-areas.ts` — extend: "Income exports"
- [ ] `apps/web/src/components/billing/{payment-detail,payments-list,admin-payments-table}.tsx` — extend: download actions
- [ ] `docs/adr/0021-tax-invoices-and-exports.md` — ADR (not Accepted until AC-VERIFY-9)

### Phases
- [x] **Phase 1: Shared tax helpers, contracts and the invoice snapshot schema.** `gstOfInclusive` with the parity matrix; financial-year and GST-period helpers with DST vectors; invoice/export API schemas and the payment invoice fields; the migration (snapshot, document kind, immutability guard, set-once) per the architecture creative; single-writer boundary rules; ADR 0021 draft and ledger rows (D-99+). ACs: AC-HAPPY-10, AC-VERIFY-3, AC-VERIFY-4, AC-VERIFY-7 (partial).
- [x] **Phase 2: Issuance.** `issue-invoice` queue and handler; each PAID writer enqueues it in the PAID transaction; idempotent issuance through `assign_invoice_number` with the snapshot; on-demand fallback; boot-time backfill of pre-feature PAID payments; no number for unpaid, held or $0.00. ACs: AC-ASYNC-1, 2, 3, AC-HAPPY-4, 5, AC-ERROR-1, 5.
- [x] **Phase 3: Documents and downloads.** Document model (tax invoice vs receipt, guests, late-withdrawal wording); pdfkit renderer with embedded font; payer and team-admin invoice routes; Next download proxies; "Download tax invoice"/"Download receipt" on the payment page and wallet list, "Invoice" row action in the admin Payments table; OpenAPI. ACs: AC-ENTRY-1, 3, AC-HAPPY-1, 2, 3, AC-ERROR-2, 6, AC-VERIFY-1, 6, AC-INTEGRATION-1.
- [x] **Phase 4: Income exports.** Paged "PAID in range by `paid_at`" query; CSV writer with neutralisation; XLSX writer with summary sheet; export route (TEAM_ADMIN only) with row cap refusal; "Income exports" manage area and form; OpenAPI. ACs: AC-ENTRY-2, AC-HAPPY-6, 7, 8, 9, AC-ERROR-3, 4, AC-VERIFY-2, 5, AC-INTEGRATION-3.
- [x] **Phase 5: End-to-end journey, accessibility, docs and accountant specimens.** `apps/web/e2e/invoices.spec.ts` (pay on the fake adapter → download invoice → export) on desktop and 360 px with axe; coverage gate; `docs/getting-started.md` export guide and re-run instructions; specimen PDFs/exports for the accountant and the AC-VERIFY-9 record; memory-bank updates. ACs: AC-INTEGRATION-2, AC-VERIFY-8, AC-VERIFY-9 (recorded; sign-off is human), AC-VERIFY-7 (complete). The final phase delivers the full entry-to-success flow: Player at `/payments/[paymentId]` → "Download tax invoice" → PDF; Team admin at `/teams/[teamId]/manage/exports` → "Download" → CSV/XLSX.

## Creative Phases

Level 3 with LOW-confidence fields → creative REQUIRED. Rulings already made: H1 (team is supplier, platform as agent), H2 (numbered Receipt for non-GST teams), H7 PDF (pdfkit). The remaining tax-rule defaults (H3-H6, H8-H12) are assumed by the ACs and go to the accountant (AC-VERIFY-9), not to creative.

- [x] User Journey Design → complete — `creative/tax-invoices-and-exports-invoicing-user-journey.md`: issue-at-PAID job + on-demand on download + sweep (option 3 of 4); every refused/failed download lands on a fixed page with a notice; gap G1 (wallet shows only the latest 10 paid games).
- [x] Architecture Design → complete — `creative/tax-invoices-and-exports-invoicing-architecture.md`: SQL `issue_payment_document` as sole issuer; append-only `payment_documents` facts snapshot, PDF rendered on demand by `layout_version`; per-team `issue-invoices` job (enqueued in `bill-session` and the apply funnel APPLY branch) + on-demand + `invoice-reconcile` sweep (boot + 15 min, also the pre-feature backfill); separate gapless series per kind (`INV-`, `RCT-`), `is_tax_invoice_issued` generated; number only on PAID > $0.00; `paid_at` frozen once set; Next GET route handlers streaming bytes, errors → 303 with `download_error`; in-house XLSX on `fflate`, CSV UTF-8 BOM + CRLF; Noto Sans (OFL) in `modules/invoices/fonts/`; ledger D-99..D-105, ADR 0021 outline.
- [x] Algorithm Design → complete — `creative/tax-invoices-and-exports-invoicing-algorithm.md`: N-month cadence + financial-year helpers, one `toInstantRange`; `gstOfInclusive` via `multiplyByRatio` HALF_UP (parity proven on 30,603 values); export = count/sum preflight then SQL cursor in one REPEATABLE READ READ ONLY transaction, buffered with Content-Length; row cap 50,000, range limit 2,557 days (7 years); 11-column shared row builder, formula neutralisation in both formats.
- [x] UI/UX Design → complete — `creative/tax-invoices-and-exports-invoicing-uiux.md`: single-column A4 (Noto Sans, 48 pt margins), tax invoice and receipt variants, "Issued by Shared Game Management on behalf of {team}."; all accountant-sensitive wording in `packages/shared/src/invoice/document-copy.ts`; Income exports radio-revealed form, Excel default; progressive download links with a status region.

### Cross-lane reconciliation (orchestrator, 2026-11-10)
Where the parallel docs disagree, the lane that owns the concern wins:
- **Download transport and errors** (owner: Architecture): plain anchors and a GET form; the Next route handler streams the file or answers 303 to a validated `returnTo` with `?download_error=<code>`. UI/UX's status region renders that code's message on the landing page; a client-side fetch is an optional enhancement only, never required (supersedes UI/UX assumption of JSON errors to `fetch` and Journey's `?notice=` name).
- **Payment contract field** (owner: Architecture): `document: { kind, available, number }` on `PaymentResponse`, `MyPaymentRow` and the admin payments row (supersedes UI/UX `documentKind`/`invoiceNumber` and Journey `invoice: {...} | null`). The button label comes from `document.kind`, never from `gstAmount` (UI/UX finding).
- **XLSX money cells** (owner: Architecture, library choice): the in-house writer writes cells from `MoneyString`, so no P2 exemption is needed (supersedes the Algorithm doc's declared exemption).
- **Export query** (Algorithm + Architecture agree): a discriminated `period=custom|gst|fy` query resolved on the server by the shared helpers; plus `GET /teams/:t/exports/income/periods` for the form's options (covers UI/UX and Journey R-A7).
- **Backfill** (owner: Architecture): the `invoice-reconcile` sweep at boot covers Journey OQ-2's deploy-time backfill, in `paid_at` order; no migration-time backfill.
- **AC-ASYNC-1 "refresh while pending"**: dropped (UI/UX and Journey agree; the link works before issuance). The rare lock-timeout case answers `invoice_pending` with a retry message.
- **Spec fix applied**: AC-HAPPY-8 and AC-VERIFY-3 now say 1 April 00:00 is NZDT (`2027-03-31T11:00:00Z`).
- **Creative rulings (human, Quy Nguyen, 2026-11-12)**:
  - **R1 Receipt numbering:** a separate gapless series per document kind per team, `INV-000001` and `RCT-000001` (accountant confirms the format, AC-VERIFY-9).
  - **R2 Six-monthly GST:** the GST-period selector offers two-monthly (odd and even month-ends) and six-monthly ending March/September. Monthly is not offered (Custom range covers it).
  - **R3 Range limit:** Custom range up to 2,557 days inclusive (7 years, matching retention); AC-ERROR-3's 5-year wording becomes 7 years at build.
  - **R4 Reference column:** exports include `payments.payment_reference` (not secret, D-89).
  - **R5 Gap G1:** "Show older paid games" pagination on the wallet page's paid list ships in this feature (Phase 3), so every invoice is reachable.
  - **R6 Codex critique:** all three findings are folded into the design as binding build requirements (CR-1..CR-3 below).
  - Kept as spec defaults (not reopened): no GLOBAL_ADMIN invoice or export access (H9); the per-row "Invoice" action is hidden from anyone who is not a team admin.

### Plan amendments from creative (binding for build)
- **CR-1 Migration converts, never clears (critique high #1).** Before adding the PAID-and-above-$0.00 CHECK, the migration preflights every payment that already has an `invoice_number`: each PAID > $0.00 row gets a `payment_documents` snapshot built in the migration with its existing number, kind and counter kept; if any numbered row is not PAID > $0.00, the migration raises and aborts the deploy with the offending ids (no silent clearing, no counter rewind). The deferred "numbered payment must have a document" trigger is validated against existing rows at migration time. Upgrade tests cover PAID, PENDING, $0.00 and interleaved numbered rows.
- **CR-2 Forward-only document schema (critique high #2).** The down migration refuses (raises) once any `payment_documents` row exists; it never drops the snapshot table or the per-kind numbering. Recovery after first use is a forward remediation migration or an application rollback that is compatible with the new schema; ADR 0021 records this one-way door and that it was accepted with R1.
- **CR-3 Bounded exports (critique medium).** A hard production ceiling on `INCOME_EXPORT_MAX_ROWS` (config cannot exceed the measured safe value; default 50,000), an encoded-byte cap checked while building (refuse with `export_too_large`, never truncate), request cancellation propagated from Next to the API and to the Postgres statement, and a bounded export semaphore in v1 (per team 1, global small N, configurable) answering 429 `export_busy` with a retry message. A load test drives concurrent worst-case-width CSV and XLSX exports through API and Next.
- **CR-4 Phase changes (from the architecture doc).** Phase 1 adds the migration with D-99..D-105, CR-1 and CR-2, the per-kind counter key, the generated `is_tax_invoice_issued`, the `paid_at` freeze, `FOR NO KEY UPDATE` in `assign_invoice_number`, `idx_payments_unissued`, the boundary-test updates and the `invoice-number.int.test.ts` factory update. Phase 2 adds `jobs/issue-invoices.ts` (per team, singleton) and `jobs/invoice-reconcile.ts` (boot + 15 min, the backfill), with enqueue sites in `bill-session` and the apply funnel's APPLY branch only. Phase 3 adds `document: { kind, available, number }` on the billing DTOs, `packages/shared/src/invoice/document-copy.ts`, Noto Sans in `apps/api/src/modules/invoices/fonts/` copied by `tsup`, `lib/http/content-disposition.ts`, the web `lib/invoices/{download,paths}.ts`, and the R5 pagination. Phase 4 puts the CSV/XLSX writers in `apps/api/src/lib/tabular/` (in-house XLSX on `fflate`), adds the periods route and CR-3. New dependencies: `pdfkit`, `fflate`; dev `@types/pdfkit`, `unpdf`, `read-excel-file`. The New Source Files list above is superseded where it conflicts; the creative docs give the exact files.

## Design Critique (advisory)
**Backend**: codex (adversarial-review, 2026-11-10). **Verdict**: needs-attention. **Summary**: the migration strands legacy numbered rows, rollback can fail or destroy immutable tax records once documents exist, and export limits do not bound memory or concurrency.
- [high] Migration leaves existing numbered payments permanently unissuable (architecture doc lines 483-511): no snapshot for rows numbered by the old `assign_invoice_number`, the sweep skips them, and clearing PENDING/zero-value numbers leaves gaps or reuses numbers.
- [high] The down migration is unsafe immediately after first use (architecture doc line 500): restoring the old `(team_id, invoice_number)` uniqueness fails once both series share a number, and reverting drops 7-year records.
- [medium] Export limits do not bound memory or concurrency (algorithm doc lines 651-655): full buffering in API and Next, a 200,000 configurable ceiling, no byte cap, no v1 semaphore.


---

## Execution State

**Build Status**: COMPLETE
**Current Phase**: 5 of 5 complete
**Auto-Build Mode**: YES
**Current Step**: Phase 5 (End-to-end journey, accessibility, docs and accountant specimens) built 2026-11-13: lint, typecheck, build, unit+integration+coverage (96.3% statements, 89.6% branches) and Playwright (invoices and income-exports, desktop and 360 px, 4/4) all exit 0
**Creative Critique**: CREATIVE CRITIQUE: codex — usable (verdict needs-attention, 3 findings)
**Step Started**: 2026-11-10
**Last Completed**: CREATIVE (2026-11-12)
**Can Resume**: NO
**Resume From**: /yay:reflect

### Active Sub-Agents
- User Journey Design: COMPLETE
- Architecture Design: COMPLETE
- Algorithm Design: COMPLETE
- UI/UX Design: COMPLETE

### Completed Steps
- Step 0.1: task provisioned from roadmap feature (2026-11-10)
- Step 3.1: Spec Writer (sonnet) draft written, 34 ACs; Step 3.2a taxonomy lint CLEAN (2026-11-10)
- Step 3.2: human review: approved; H1 team-as-supplier, H2 numbered Receipt, H7 pdfkit ruled (2026-11-10)
- Steps 4-6: codebase analysis, Test Strategy (~90 tests), 5-phase roadmap, creative flagged: Architecture, Algorithm, UI/UX (2026-11-10)
- Creative (2026-11-10): User Journey, Architecture, Algorithm, UI/UX complete; outputs memory-bank/creative/tax-invoices-and-exports-invoicing-{user-journey,architecture,algorithm,uiux}.md; cross-lane reconciliation recorded; NZDT spec fix
- Creative rulings R1-R6 and plan amendments CR-1..CR-4 recorded; status CREATIVE_COMPLETE (2026-11-12)
- Phase 4 build complete (2026-11-13): backend exports, web manage area, ADR 0021 section 8 and OpenAPI updated
- Phase 5 build complete (2026-11-13): invoices.spec.ts, income-exports.spec.ts executed and passing, getting-started guide, specimens in docs/specimens, memory-bank updates; AC-VERIFY-9 sign-off pending (human)

### Halt State
<!-- populated only on a halt trigger -->

### Deviations
<!-- Phase <N> | <file:line/artifact> | <rationale> -->
- Phase 1 | db/migrations/20261110000100000_tax_invoices.sql | CR-1 preflight also aborts (naming ids) on a numbered payment with no registration or no session start, because `payment_documents.session_*` are NOT NULL and cannot be snapshotted; the spec only named "not PAID above $0.00". Legacy numbered rows convert by `gst_registered`, so a team with both registered and unregistered legacy numbers keeps every number but each series may start with a hole (recorded in ADR 0021; no document was ever printed and no production payment exists before Akahu is live).
- Phase 1 | db/schema-deviations.md | D-99..D-105 are in a second table ("Three-digit ids") because `D-100` widens the ID column and prettier would otherwise re-pad all 98 existing rows; the schema test reads rows by `^| D-\d+`, so both tables count.
- Phase 1 | packages/shared/src/api/errors.ts, apps/api/src/lib/http/errors.ts | The three new error codes (`invoice_not_available`, `invoice_pending`, `export_too_large`) land in Phase 1 with their status and message (the `ERROR_DEFAULTS` record is exhaustive, so the shared list cannot grow alone). `export_busy` (CR-3) is left to Phase 4. `PaymentDocumentRef` is defined in `api/invoices.ts` but NOT yet on the billing DTOs (CR-4: Phase 3).
- Phase 1 | apps/api/src/modules/invoices/boundaries.test.ts | The single-writer rules are a new `modules/invoices/boundaries.test.ts` (architecture section 6) plus `payment_documents` added to the registrations money-table rule, rather than only the registrations file named in the phase brief; the invoices file scans all of `apps/api/src`, so it guards billing and wallet too.
- Phase 1 | apps/api/test/integration/{registrations,sessions,teams,skill-levels,team-banking-upgrade,billing}-schema.int.test.ts | The new migration sits on top, so every "roll back the newest N migrations" count moved up by one and `tax_invoices` heads each ordered list; `billing-schema` now rolls back twice to reach the wallet migration.
- Phase 1 | apps/api/test/integration/invoice-number.int.test.ts | Numbers are now allocated only through `issue_payment_document`, so the race test asserts the idempotent outcome (the loser gets the winner's document back with `issued = false`) instead of the old 23000 set-once error, which now only a direct `assign_invoice_number` call raises. The sleep-based ordering became `waitForLockWaiters`.
- Phase 1 | apps/api/.kysely-codegenrc.json | `payments.is_tax_invoice_issued` is overridden to `ColumnType<boolean, never, never>` (generated column, like `gst_amount`), so no TypeScript can write it.
- Phase 1 | db/migrations/20261110000100000_tax_invoices.sql:147-150,207-208 | Deferred Minor (code review): comment wording on D-104 trigger order and the FK description; NOT VALID/VALIDATE could be a plain ADD CONSTRAINT; consider revoking EXECUTE on assign_invoice_number from the app role; ADR 0021 should say production never called assign_invoice_number before. Phase review: PROCEED (all 7 deviations above accepted).
- Phase 2 | apps/api/src/modules/invoices/issue.ts, apps/api/src/jobs/issue-invoices.ts | The `invoice.issue.failed` / `invoice.run.failed` logs name the SQLSTATE field `sqlState` (as `billing.session.failed` and the Akahu jobs do) instead of the architecture doc's `sqlstate`, so one log query covers every job. Ids, error class and SQLSTATE only, never the message.
- Phase 2 | apps/api/src/modules/invoices/issue.ts | The drain loop, per-run limit and class-23 skip set live in the service (`issueTeamBacklog`), and the job handler is a thin adapter (payload check, follow-up enqueue, NonRetryableJobError, sanitised rethrow), so the drain is testable on real PostgreSQL with injected failures. The sweep reaches the repo through `listTeamsNeedingIssuance` in `issue.ts`, so the jobs import one public file (`modules/invoices/issue.ts`) and `repo.ts` stays internal; no separate barrel was needed.
- Phase 2 | apps/api/src/jobs/schedules.ts, apps/api/src/jobs/bootstrap.ts | `invoice-reconcile` is slot 4 (right after `akahu-reconcile`, an `intervalSweep`), and its boot enqueue logs `invoice.reconcile.boot` / `invoice.reconcile.boot_failed`. Because it is an interval sweep the DST guard skips it, so `schedules.ts` needed no extra paging; the guard test stays well inside pg-boss's 1000 ms preview budget.
- Phase 2 | apps/api/src/modules/billing/apply-akahu-result.ts | The enqueue sits inside the APPLY branch and is gated on the guarded PAID `UPDATE ... RETURNING id` actually moving a row (and on the amount being above $0.00), so a replay or an already-PAID payment never enqueues. The select of the locked payment row gained `team_id`.
- Phase 2 | apps/api/src/modules/invoices/boundaries.test.ts | Extended with the issuance code's money/observability scan (the module plus `jobs/issue-invoices.ts` and `jobs/invoice-reconcile.ts`), an import rule (no billing, wallet or registrations import; the module reaches no job except the registry) and an exact match that `repo.ts` is the sole caller of the SQL issuer.
- Phase 2 | apps/api/test/integration/jobs.int.test.ts | The scheduled-slot list now has eight entries and `invoice-reconcile` is triggered like the other real sweeps.
- Phase 2 | test run | `registrations-sse-integration.int.test.ts` "(2) the session PUT promotes first-fit" failed once in a full parallel integration run with `could not obtain lock on row in relation "game_sessions"` raised by a test factory insert, and passed on re-run alone (4.6 s); not touched by this phase.
- Phase 2 | apps/api/test/integration/registrations-sse-integration.int.test.ts | Deferred: one-off row-lock-timeout flake in "session PUT promotes first-fit" during a full parallel run (passed on every re-run; file untouched by this feature). Per-phase Codex review not run in Phase 2 (Anthropic reviewer used). Phase review: PROCEED (all Phase 2 deviations accepted).
- Phase 3 | apps/api/src/modules/invoices/fonts/ (NotoSans-Regular.ttf, NotoSans-Bold.ttf, OFL.txt) | The font source is the npm package `@expo-google-fonts/noto-sans` 0.4.2 (package licence `MIT AND OFL-1.1`; the font files carry "Copyright 2022 The Noto Project Authors"), fetched with `npm pack` and copied (not a runtime dependency). These are the full-coverage static TTFs (about 630 KB each, pdfkit embeds only the used glyphs), so macrons need no second subset font. SHA-256 and the source are recorded in ADR 0021 section 6 and pinned by a test; no ledger row (no schema change in Phase 3).
- Phase 3 | apps/api/src/modules/invoices/render-pdf.ts | Layout 1 departs from the UI/UX coordinates in three small ways: the amount column is 140 pt wide (not 100 pt) so "Amount (including GST)" does not wrap, the agent-line box is 30 pt high (two lines) so a long team name is not cut by the ellipsis, and the GST-number line follows the supplier name's real height instead of a fixed offset. The PDF is created with `font: ''` so no built-in Helvetica can ever be used. The title reads "Tax invoice" (UI/UX copy) where AC-HAPPY-1 wrote "Tax Invoice"; the tests assert the UI/UX wording.
- Phase 3 | apps/web/src/components/invoices/download-invoice-link.tsx | Per the cross-lane reconciliation the action is a plain anchor with no `download` attribute and no client-side fetch: the UI/UX "Preparing..." / "Downloaded ..." status region and the `fetch`+Blob enhancement are NOT built (optional there, never required). A refused download shows its sentence on the landing page from `?download_error=` through `DownloadErrorNotice` (`role="alert"`). The landing codes are `invoice_not_available`, `invoice_pending`, `not_found`, `forbidden` and `service_unavailable` (`forbidden` is an addition for an admin who lost access).
- Phase 3 | apps/web/src/lib/api-client.ts | The header allowlist of `apiFetch` is extracted into an exported `buildApiHeaders` (architecture section 5: refactor, not copy), and `apiFetch` now calls it; behaviour is unchanged (the existing client tests pass untouched).
- Phase 3 | packages/shared/src/api/invoices.ts | `PaymentDocumentRef` becomes `z.strictObject` (it was `z.object`, which silently strips an unknown key), so a stray key on the billing DTOs is refused like every other strict response shape.
- Phase 3 | apps/api/src/modules/invoices/document.ts | The model field for the GST rate is `rateBps`, not `gstRateBps`: the Phase 2 money scan in `modules/invoices/boundaries.test.ts` flags any `gst*: number` field as a money field typed `number`. `InvoiceServiceDeps` has an optional `lockTimeoutMs` seam (tests shorten the 5 s lock wait to prove 409 `invoice_pending`); `buildApp` does not pass it.
- Phase 3 | apps/api/src/app.ts | `buildApp` reads the two font files once at boot (`loadInvoiceFonts`) and throws if either is missing, so every test that builds the app reads 1.2 MB once; the worker does not render. `tsup.config.ts` `onSuccess` also copies `src/modules/invoices/fonts` to `dist/fonts` (checked: build output has the three files); the Dockerfile is unchanged.
- Phase 3 | apps/web/src/lib/billing/wallet-view.ts, apps/web/src/app/teams/[teamId]/wallet/page.tsx | R5 is `?payments=all` (every paid row of the loaded page) and `?pcursor=<opaque API cursor>` (older pages), with a "Show older paid games" link from `olderPaidHref`; the query names are this phase's choice. The "Showing your latest 10 paid games." note stays beside the link. The admin Invoice action is shown only when the page passes `invoiceReturnTo`, which it does only for an approved TEAM_ADMIN (a GLOBAL_ADMIN who is not one gets none, H9).
- Phase 3 | existing tests | `apps/api/src/lib/auth/policy.test.ts` (team route count 44 to 45, and the new route in the TEAM_ADMIN-no-bypass list), `apps/api/test/integration/payment-attempts.int.test.ts` (the payment read now carries `document`), `packages/shared/src/api/billing.test.ts`, `apps/web/src/lib/billing/fixtures.ts` and the local fixtures of `billing-components.test.tsx` gained the `document` field. `vitest.config.ts` needs no new coverage path (everything Phase 3 adds sits under paths already listed); only its comment changed.
- Phase 3 | apps/api/openapi.yaml | Regenerated with `pnpm run openapi` after the last route and DTO change (the earlier verifier has reverted this file with `git checkout`; re-check it before commit). The invoice 200 answers are declared `application/pdf` with a `string`/`binary` schema for OpenAPI only; the bytes are sent as a Buffer, which bypasses the zod serializer.
- Phase 3 | review | Per-phase Codex review (code-review seam) ran directly via codex-companion (review --wait --scope working-tree): no findings; the Codex sandbox could not run vitest (read-only temp config), so tests were verified by the verifier agent (4183/4183). openapi.yaml checked byte-identical before commit.
- Phase 3 | apps/api/src/modules/invoices/render-pdf.ts | Deferred to accountant (AC-VERIFY-9): title capitalisation "Tax invoice" (UI/UX copy) vs AC-HAPPY-1 "Tax Invoice". Verifier did not capture lint/typecheck/build exit codes this phase (later phases must). Phase review: PROCEED (all Phase 3 deviations accepted).
- Phase 4 | apps/api/package.json | `fflate` pinned at exactly 0.8.3 (as required) and dev `read-excel-file` pinned at exactly 9.3.14, the version vetted in the architecture doc, not the newest 9.3.15 (published 2026-11-11, two days before this build: too new to adopt). Tests read numbers back with `parseNumber: (s) => s`, so no test turns money into a JS number either.
- Phase 4 | apps/api/src/lib/tabular/{cells,csv,xlsx}.ts | The writers are generic: a cell is a string (text, always neutralised in both formats, header included) or `{ number, format: 'money' | 'integer' }` copied as exact decimal text (validated by pattern), so neutralisation is by cell type rather than per column spec. Counts in the Summary sheet are integer cells (`0` format), money cells use built-in format 2 (`0.00`). XLSX text is `inlineStr` (no shared strings); entries are streamed into fflate's `Zip`/`ZipDeflate` with a fixed entry time, and `[Content_Types].xml`/workbook parts are added after the sheets (zip order is irrelevant to OOXML; Excel and `read-excel-file` read it).
- Phase 4 | apps/api/src/lib/tabular/xlsx.ts | CR-3's encoded-byte cap counts the bytes the writer actually holds and will send: the CSV bytes, and for XLSX the zipped output as fflate emits it (checked after every write), not the uncompressed XML. The uncompressed-XML count refused the 50,000-row ceiling (about 36 MB of sheet XML that zips to about 2.4 MB) although the uncompressed XML is never held. A chunk can overshoot the cap by one deflate block before the refusal (bounded, tens of KB).
- Phase 4 | apps/api/src/lib/config/config.ts | Three env vars: `INCOME_EXPORT_MAX_ROWS` (1 to 50,000, default 50,000), `INCOME_EXPORT_MAX_BYTES` (1,024 to 67,108,864, default 33,554,432 = 32 MiB) and `INCOME_EXPORT_MAX_CONCURRENT` (1 to 8, default 2); the ceilings are exported constants and zod refuses a higher value at boot ("must be at most N (the measured safe ceiling)"). The per-team bound is fixed at 1 (not configurable). The range limit stays the shared constant `MAX_RANGE_DAYS` (2,557, Phase 1) rather than the algorithm doc's `INCOME_EXPORT_MAX_RANGE_DAYS` env var. `AppDeps.incomeExports` is REQUIRED (config-composition-root rule); main, openapi, `inertAppDeps` and `buildAuthTestApp` pass it.
- Phase 4 | apps/api/test/integration/income-exports-load.int.test.ts | Measured on this machine (printed with `--silent=false`, never asserted): four concurrent worst-case-width exports (8,000 rows each, 255-character payer names of 2-byte letters, quotes and commas, two CSV and two XLSX) in about 0.8 s with about 77 MiB heap growth, CSV 3.07 MB, XLSX 0.43 MB; 50,000 typical rows in about 0.6 s (CSV, 3.6 MB) and 1.2 s (XLSX, 2.4 MB); 50,001 rows refused. The worst-case rows have no registration (bulk-inserted with `generate_series`; 50,000 registrations would need 50,000 users), so their description is "Payment": the widest description (255-character location) is covered by the byte cap, not by this run. At 50,000 rows a worst-case-width CSV would reach about 19 MB (names only) and up to about 40 MB with maximal locations, which the 32 MiB byte cap refuses with `export_too_large`.
- Phase 4 | apps/api/src/modules/income-exports/semaphore.ts | The semaphore is in-process (one instance per `buildApp`), so `INCOME_EXPORT_MAX_CONCURRENT` bounds each API process; v1 runs one. A refused request is answered at once (never queued) with 429 `export_busy`, `retry-after: 10`, message "Another export is being prepared. Try again in a moment.", and logged `income_export.refused` with `reason: 'busy'`. The slot is taken after validation (422s never take one) and released in `finally`.
- Phase 4 | apps/api/src/modules/income-exports/{repo,routes}.ts | Cancellation: the route aborts an `AbortController` when the response socket closes before the reply is written; the repo then sends `pg_cancel_backend(<this transaction's pid>)` from another pooled connection (only while it still holds its connection, and awaited before release, so it can never hit another request), the statement ends with 57014 and the transaction rolls back; the route answers 499 (nobody listens) and the service logs `income_export.cancelled`. `statement_timeout` and `idle_in_transaction_session_timeout` are 25 s (`set_config(..., true)`, local to the transaction) as a backstop below the web proxy's 30 s. The Next-to-API hop of cancellation is the web half's. (Superseded in part: the canceller runs on a dedicated connection, see the cancel.ts line below.)
- Phase 4 | packages/shared/src/api/invoices.ts | Contract additions: `IncomeExportPeriodsResponse` gains `maxRows` and `maxRangeDays` (the web reads the env-configured cap from the API, never a copied constant); `futurePeriodIssue` refuses a financial year or GST period that has not started on `year` / `end` (algorithm validation step 4) with two new messages; `INCOME_EXPORT_ROW_COUNT_HEADER = 'x-export-row-count'` (UI/UX A4) is sent on every 200; `IncomeExportQueryString` (a flat strict object piped into the Phase 1 union) is the route's querystring, because `@fastify/swagger` flattened the bare union wrongly (every parameter required, `period` enum only `fy`). Validation and the resolved output are the union's. `financialYearsWithPayments` is ascending.
- Phase 4 | packages/shared/src/invoice/export-columns.ts | UI/UX A6: `INCOME_EXPORT_COLUMNS` (key, header, help) is shared so the web's "What's in the file" cannot drift. Headers follow the UI/UX help text: `Player` (the algorithm doc's "Payer") and `Paid by` with `Wallet` / `Bank` (the algorithm doc's lowercase `wallet` / `bank` under "Payment method"), plus `Reference` (R4). Description: `Game fee, {location}, {date}` / `Late withdrawal fee, {location}, {date}` (the invoice's AC-ERROR-6 wording) plus `, with N guest(s)`; `Payment` for a row with no game. The Summary sheet labels live here too. All provisional until AC-VERIFY-9.
- Phase 4 | apps/api/src/modules/income-exports/rows.ts | File name is the algorithm's `income_<team-slug>_<fileStem>.<ext>` (`income_hokio-badminton-club_2027-06-01_to_2027-06-15.csv`, `..._gst_2027-04_to_2027-05.csv`, `..._fy_2026-27.xlsx`) using Phase 1's `describePeriod().fileStem`, not the architecture's `income-<slug>-<from>-to-<to>`. The slug falls back to `team` when nothing ASCII is left.
- Phase 4 | apps/api/src/modules/income-exports/repo.ts | Snapshot precedence is applied in SQL with `coalesce(d.<snapshot>, <live>)` (number, buyer name, game start, location, charge reason); a not-yet-issued row derives LATE_WITHDRAWAL from `registrations.status = 'WITHDRAWN'`, the issuer's own rule. Ordering uses `payments.invoice_number` (nulls last) then id. The algorithm doc's `EXPLAIN` plan test and the snapshot-consistency "both orders" variant were not added: one order is proven through the service's `afterPreflight` test seam (a payment committed between the preflight and the cursor is in neither; the next export sees it). `afterPreflight` is never passed by `buildApp`.
- Phase 4 | apps/api/src/lib/auth/policy.test.ts | Team route count 45 to 47; both export routes are in the TEAM_ADMIN-without-global-bypass list. An unknown team id answers the same 403 as another team (no existence oracle). `vitest.config.ts` coverage now includes `apps/api/src/modules/income-exports/**` and `apps/api/src/lib/tabular/**`. A new `modules/income-exports/boundaries.test.ts` scans both directories (no table write, no sensitive column or table named, no float money, no console, imports only through public files), each rule proven to detect a violation; the existing boundary tests were not directory-listed for these paths, so none needed extending.
- Phase 4 | apps/web/src/components/invoices/income-export-form.tsx | Per the cross-lane reconciliation (Phase 3 precedent) the form is a plain GET form with no client JavaScript: no `fetch`+Blob download, no busy button text, no post-download status region (`Downloaded {file}. {n} paid payments...`, so `x-export-row-count` is not read by the web yet), no live scope line and no client precheck. A static hint under the button says the file downloads and the page stays. The period panels are revealed by CSS (`group-has-[[name=period]:not(:checked)]:hidden`, checked to compile with Tailwind 4.3.3) instead of the `hidden` attribute plus `disabled` inputs: hidden panels still submit and the route consumes only the selected type's fields; a browser without `:has()` shows all three panels.
- Phase 4 | apps/web/src/components/invoices/income-export-form.tsx, apps/web/src/lib/invoices/export-view.ts | The GST period is ONE select (`name="gst"`, value `<cadence>/<YYYY-MM>`, e.g. `2m-odd/2027-05`) with three optgroups (two-monthly odd, two-monthly even, six-monthly Mar/Sep, R2) instead of the UI/UX dependent pair "Your GST returns end in" + "Period", which cannot work without JavaScript; the route splits it into the API's `cadence` and `end`. The radios are in the order Custom range, GST period, Financial year and shown to every team (the page does not load the GST status), default Financial year (current year); the UI/UX default of GST period for a registered team, the GST radio hidden for an unregistered team, the "unregistered" note and the `localStorage` cadence memory are not built. Labels: GST select `GST return period`.
- Phase 4 | apps/web/src/lib/invoices/{export-view.ts,download.ts}, apps/web/src/app/teams/[teamId]/manage/exports/{page.tsx,income/route.ts} | A 422 lands back as `?period=..&<selected fields>&format=..&download_error=validation_failed&field=<form field>` (API `cadence`/`end` map to `gst`; unknown names dropped). No message text is put in the URL: the page re-derives each message with the same shared rules the API runs (`IncomeExportQueryString`, `validateExportRange`, `futurePeriodIssue`, with the periods answer's `today`); a flagged field the rules now accept gets "Check this answer and try again.". So the field messages are the shared API wording (`The end date can't be before the start date`, `Enter a valid start date as YYYY-MM-DD.`), not the UI/UX copy table's (`Enter a real start date.`). The export landing is always the team's exports page built from the validated id (`proxyDownload` gained `ignoreReturnTo` and a `landing` builder; a `returnTo` in the query is ignored). An unknown period type is refused with `field=period` without an API call.
- Phase 4 | apps/web/src/lib/invoices/{paths,labels}.ts | `DOWNLOAD_ERROR_CODES` gains `export_too_large`, `export_busy` and `validation_failed`; `downloadErrorMessage(code, { export: { maxRows } })` words them (too large names the API's `maxRows`, `50,000`), and `forbidden`/`service_unavailable` get the export wording. The invoice routes keep mapping a 422 to `not_found`. Form-level refusals render as a focused `FormBanner` error above the form and field errors in the focused `ErrorSummary` (rather than a summary item with no field link).
- Phase 4 | apps/web/e2e/income-exports.spec.ts | Added (desktop and 360 x 740 projects: nav, CSS reveal, FY CSV download, 422 landing with focused summary and kept values, axe and 44 px targets) but NOT executed: no stack was started in this build. A fresh team has no payments, so the file is headings only. Request cancellation Next to API is proven by unit tests (`download.test.ts`, the exports `route.test.ts`): aborting the incoming request aborts the upstream fetch signal (`proxyDownload` already combined `request.signal` with the 30 s timeout in Phase 3).
- Phase 4 | apps/api/src/lib/db/cancel.ts, apps/api/src/modules/income-exports/{repo,service}.ts, apps/api/src/{app,main,openapi}.ts | Code-review P1 (supersedes the cancellation line above): the cancel no longer draws a connection from the app pool, which deadlocked when `DATABASE_POOL_MAX` <= active exports (every connection held by an export awaiting its own cancel). `createBackendCanceller({ connectionString })` opens a short-lived dedicated `pg.Client` per cancel (2 s connect and query timeout, never rejects) and runs `pg_cancel_backend(pid)` only `WHERE pid = $1 AND xact_start = $2` (the transaction's `now()::text`), so the cancel is fired and NOT awaited and the export's connection is released at once; a late cancel matches nothing once that transaction has ended. New required `AppDeps.cancelBackend` / `IncomeExportServiceDeps.cancelBackend`. Proven by an integration test with an app pool of 2 and 2 exports blocked at the concurrency limit: both are cancelled and the pool recovers.
- Phase 4 | packages/shared/src/tax/periods.ts, packages/shared/src/api/invoices.ts | Code-review P2: `period=fy&year=9999-00` passed `parseFinancialYear` but `financialYear(9999)` throws on a five-digit date (500). New `EXPORT_YEARS = { first: 2000, last: 2099 }`: `parseFinancialYear` refuses a start outside it and the GST `end` year is refused outside it, both as 422 `validation_failed` on their field. A custom range ending 9999-12-31 was already a 422 (`to`, over 7 years) because validation runs before any range conversion; it is now covered by the API test.
- Phase 4 | apps/web/src/lib/invoices/labels.ts, apps/web/src/app/teams/[teamId]/manage/exports/page.tsx | Code-review P2: the `export_too_large` sentence named `maxRows`, but the API also refuses for the byte cap. It is now the generic `EXPORT_TOO_LARGE` "That export is too large to prepare. Choose a shorter range." and `downloadErrorMessage`'s option is `export: true` (the `{ maxRows }` object is removed; the page no longer passes the cap). The API's default message ("Choose a shorter range.") was already generic and is unchanged; openapi.yaml regenerates byte-identical.
- Phase 4 | apps/api/src/modules/income-exports/{service,repo}.ts | Code-review P2 (Codex re-review): an empty export of a GST-registered team printed `Not registered` because the Summary GST number came only from matching rows. It now falls back to the team's current `gst_number` when `gst_registered` and no row names one (`readTeamGstNumber`); `Not registered` stays for non-registered teams. Test-first in `income-exports.int.test.ts`.
- Phase 4 | apps/web/src/components/invoices/income-export-form.tsx, apps/web/src/lib/invoices/export-view.ts | Deferred UX polish (phase review accepted): no post-download status line / x-export-row-count use; GST period is one grouped select (no-JS) not the two-field pair; GST option not hidden/annotated for unregistered teams.
- Phase 4 | apps/api/src/modules/income-exports/repo.ts | Deferred verification depth: algorithm doc's EXPLAIN index-plan test and both-order snapshot-consistency test not written (single-snapshot behaviour is tested; CR-3 caps bound cost).
- Phase 4 | apps/web/e2e/income-exports.spec.ts | Written but not run; Phase 5 must execute it and fix failures. Registrations-sse "session PUT promotes first-fit" lock-timeout flake recurred (2nd time) — track as a flaky test. Phase review: PROCEED.
- Phase 5 | docker-compose.e2e.yml | New overlay so the E2E runs on a second Compose project (`-p sgm-e2e`: ports 3100/4100/5532/1125/8125, retagged images, `WEB_BASE_URL` on api, worker and web build) and never touches the developer's `sgm` stack. The first run showed the fake Akahu return and emails use the api's `WEB_BASE_URL`, so the overlay sets it; Codex review caught that the docs referenced a missing override and omitted `-c apps/web/playwright.config.ts` (both fixed).
- Phase 5 | apps/web/e2e/invoices.spec.ts | One journey per project (pay on the fake adapter, player download of a real PDF, reload shows `INV-` number, wallet and payments list scans, admin `?status=paid` Invoice action, CSV with BOM and `INV-` row, XLSX `PK`). The GST-registered team is set up through `PUT /teams/:id/gst` so the document is a tax invoice. The invoice number only shows on the payment page after the next view (on-demand issuance happens in the download route), so the spec reloads before asserting it. `income-exports.spec.ts` was executed unchanged and passes on both projects.
- Phase 5 | apps/api/src/modules/invoices/specimens.test.ts, docs/specimens/ | The accountant's four PDF variants (one player, with guests, receipt for a non-registered team, late-withdrawal fee) are rendered from the real renderer by a test that also asserts one real page each; `E2E_SPECIMEN_DIR` keeps the PDF, CSV and XLSX the E2E run downloads. A late-withdrawal specimen could not come from the E2E (no way to create a cancellation fee in the browser journey).
- Phase 5 | docs/adr/0021-tax-invoices-and-exports.md | AC-VERIFY-9: specimens listed and a review table left `pending` (sign-off is human). ADR 0021 stays Proposed; ADR 0011's pending note was already restated on 2026-11-13. AC-VERIFY-7 needed no new code: the issuance module is on the billing allow list (`issue-invoices.ts`), `invoices/**` and the jobs are in the coverage include list.
- Phase 5 | test environment | Integration tests ran against the e2e Postgres (`DATABASE_URL=...:5532`) with a generated `ENCRYPTION_KEYS`, because the worktree has no `.env`. First full run: `invoices-schema.int.test.ts` round trip failed with node-pg-migrate "Not run migration ... preceding already run" (passes alone, passed in the clean re-run: load flake, same family as the billing-schema round trip). The registrations-sse "session PUT promotes first-fit" flake did not recur in the clean run.
