# User Journey Design: Tax Invoices and Exports

**Created**: 2026-11-10
**Status**: DECIDED
**Decision Type**: User Journey
**Task**: `tax-invoices-and-exports` (Level 3). Spec and plan: `memory-bank/tasks/tax-invoices-and-exports.md` on `feature/tax-invoices-and-exports` (spec approved 2026-11-10). Binding rulings: **H1** the team is the supplier and the platform issues the document as its agent, with no platform GST number; **H2** a non-GST-registered team's player gets a numbered "Receipt" with no GST wording; **H7** PDF by pdfkit with an embedded TTF font. H3-H6 and H8-H12 stand at their defaults until the accountant reviews the specimens (AC-VERIFY-9).
**Answers**: the User Journey creative: the player download journey (all three settlement routes, the issuance window, unpaid states, registration changes, pre-feature payments), the team-admin export and per-row invoice journeys, the ops journeys (failed issuance, a player reporting wrong details), and the reuse contract for player-dashboard.
**Parallel lanes (not decided here)**: Architecture (snapshot shape, issuance mechanism, numbering and prefix, download transport, contracts), Algorithm (period helpers, export rows, limits), UI/UX (PDF layout, the export form, final copy). Every UI string here is **proposed**. Where this journey needs something from a lane, it is stated as a requirement in "Requirements on the other lanes".
**Web conventions reused** (from the billing, banking and registration journeys on `main`): one task per URL; `requireUser(returnTo)` and the sign-in redirect; codes-only `?notice=` with text from a labels module, stripped after render; the reload-or-keep rule (state known to have changed: reload; outcome unknown: change nothing, keep the input); `ManageAreaNav` rendered only after the area guard passes; the payer-only payment page with one uniform not-found; names only in admin views (never an email or a bank detail); no native dialogs.

**Hard constraints carried into every journey**
- **A document follows the payment's charge-time snapshot, not the team's current settings.** `payments.gst_registered` at charge time decides "Tax invoice" or "Receipt". A team that changes its GST registration later changes only later charges.
- **An issued document never changes.** Re-downloading returns the same number, date and content. Nobody in the app can edit, void or re-issue it (H5).
- **No document for a payment that is not PAID or is $0.00**, and no number is consumed for one.
- **A download never shows a raw error body.** A refused or failed download always lands on a page with one sentence that says what happened and what to do.
- **No email address, bank detail, Akahu id or payment token** on any document, in any export, or in any log line.

---

## Journey Overview

**Feature**: Every paid game fee above $0.00 gets a numbered, permanent PDF document from the team (a tax invoice if the team was GST-registered when the fee was charged, otherwise a receipt). The payer downloads it from the payment page or the team's wallet page. A team admin downloads any player's document from the Payments area and exports the team's paid income as CSV or Excel for a custom range, a GST two-month period or the NZ financial year.
**Primary Persona**: Player (`PLAYER`, an APPROVED member, or a former member who paid), on a phone or at a desk at tax time, collecting proof of what they paid.
**Journey Type**: **Hybrid.** Issuance is asynchronous (a job enqueued when the payment becomes PAID, with a sweep as a safety net). The download is synchronous and issues on the spot if the job has not run yet, so the player never sees the async boundary. The export is fully synchronous (one request, one file).
**Orchestration Pattern**: **Status-driven action on an existing page** (the download button appears on the PAID payment, in the payment page and in the wallet list; no new player page), **Dashboard + Detail row action** in the admin Payments table, and a **single-screen form with progressive disclosure** for the export (choose a period type, then only that type's inputs show).

### Success Statements
> **Player**: Aroha opens "Payment for Hōkio Courts, Wed 7 Oct", sees "Paid", taps "Download tax invoice", and her phone saves `INV-000012-hokio-badminton-club.pdf`, which says "Tax Invoice", "Hōkio Badminton Club, GST 49-091-850", "Aroha Ngata", Subtotal $20.00, GST $3.00, Total $23.00 including GST.
>
> **Team admin**: Mere opens Manage → "Income exports", picks "GST period", "1 Apr 2027 to 31 May 2027", "Excel", taps "Download", and opens a workbook whose Summary sheet shows the period, 42 payments, GST $126.52 and total $970.00, matching the invoices.

---

## Persona Context

### Primary User
- **Who**: Player (`PLAYER`, productBrief Key Personas; pain point "manual bank transfers").
- **Goal**: Get a proper document for a game fee, for an employer's wellness or sports allowance, a reimbursement, or their own records. Often wants several at once (end of month or the financial year).
- **Context**: Two moments. Right after paying (on a phone, from the payment page or the "Payment received" email) and weeks later at a desk, looking for an older game. The second moment matters more for this feature, and it is the one where the current pages are weakest (see "Gaps found").
- **Proficiency**: Casual. Knows what a receipt is. Does not know the difference between a tax invoice and a receipt and should not need to: the button name tells them which they will get.

### Secondary Users
- **Team Admin** (`TEAM_ADMIN` of the team; GST-registered or not): needs the team's income for a GST return (a two-month period) and the year end (1 April to 31 March), in a form their accountant or spreadsheet accepts, and must be able to show that the export agrees with the invoices. Also answers a player who lost an invoice: the admin fetches it from the Payments table. Usually at a desk; exports are rare (every two months), so the form must be self-explanatory each time.
- **Global Admin** (`GLOBAL_ADMIN`, platform support): **not** a persona for documents or exports (H9 and AC-ERROR-2). Can still open the Payments area for support, sees no "Invoice" action there and no "Income exports" link.
- **Ops / support** (an engineer with database and worker access): re-runs a failed issuance and answers a "my invoice is wrong" report. Works from logs, `pgboss.job`, `pnpm run jobs:trigger` and `docs/getting-started.md`.
- **Accountant** (the team's or the owner's): never signs in. Reads the specimen PDFs and exports (AC-VERIFY-9) and the files team admins send them.
- **Later features**: player-dashboard ("Payments & Wallet" tab reuses the download action), admin-reporting-dashboard (may reuse the period helpers).

---

## Journey Map

### Entry Points

| Entry | Context | User intent |
|---|---|---|
| "Download tax invoice" / "Download receipt" on `/payments/[paymentId]` | Payer, payment PAID and above $0.00 | "Give me the invoice for this game" |
| The same action on a PAID row of the wallet page's Payments list `/teams/[T]/wallet` | APPROVED member | "Get invoices for my recent games" |
| "Payment received" email → "View the payment" `{WEB}/payments/{id}` (existing email, not changed) | Payer, after a bank payment or a resolved hold. **Not sent for a wallet deduction** (billing journey email 5) | "Where's my receipt?" |
| Manage nav "Income exports" `/teams/[T]/manage/exports` | TEAM_ADMIN only | "Export income for my GST return / year end" |
| Manage → "Payments" → filter "Paid" → row "Invoice" | TEAM_ADMIN only | "A player lost their invoice", "check what we issued" |
| player-dashboard "Payments & Wallet" tab (later) | Payer, across teams | "All my invoices in one place" |
| Typed or bookmarked download URL, signed out | Any | Sign in, land back on the page the document belongs to |

### Page and route inventory

| URL | Who | Purpose | New? |
|---|---|---|---|
| `/payments/[id]` | Payer only (member or not) | Gains the download action and, once issued, the document number | Existing page, new action |
| `/teams/[T]/wallet` | APPROVED members | PAID rows gain the download action | Existing page, new action |
| `/teams/[T]/manage/payments` | TEAM_ADMIN of T; GLOBAL_ADMIN (no invoice action) | PAID rows gain "Invoice" for team admins | Existing page, new action |
| `/teams/[T]/manage/exports` | TEAM_ADMIN of T only | The export form | **New area** in `MANAGE_AREAS` |
| `/payments/[id]/invoice` (Next route handler) | Payer | Streams the PDF; on refusal redirects to `/payments/[id]?notice=…` | New |
| `/teams/[T]/manage/payments/[id]/invoice` (Next route handler) | TEAM_ADMIN of T | Streams the PDF; on refusal redirects to the Payments area with a notice | New |
| `/teams/[T]/manage/exports/income` (Next route handler) | TEAM_ADMIN of T | Streams the CSV/XLSX; on refusal redirects to the form with the values and the error | New |

Proposed `?notice=` codes (closed list; text in a labels module; stripped after render): payment page `invoice_not_available`, `invoice_failed`; Payments area `invoice_not_available`, `invoice_failed`; exports page carries a field error instead (see J5).

---

### Document-visible states of one payment

```
   payment state (owned by billing)                document state (this feature)
   ───────────────────────────────                 ─────────────────────────────
   PENDING / OVERDUE / processing / HELD  ──────▶  [NONE]  no action shown; direct request → "available once paid"
   PAID, amount $0.00 (B7)                ──────▶  [NONE]  "There's no charge for this game." no action, never numbered
   PAID, amount > $0.00
        │  (PAID transaction enqueues issue-invoice)
        ▼
   [AVAILABLE, NOT YET ISSUED]  button shown, no number shown
        │        │                     │
        │  job runs (target < 30 s)    │ payer or admin presses the button first
        │        ▼                     ▼
        │   [ISSUED]  ◀──── issue on demand (same number whoever wins; no 5xx, no double allocation)
        │        │
        │   sweep catches a failed or missing job
        ▼        ▼
   [ISSUED: number INV-000012 (or the receipt prefix), date of issue, frozen snapshot]
        │
        └── every later download: same bytes. No edit, void or re-issue in v1 (H5).
```

The player never sees "not yet issued" as a separate state. The button is the same before and after issuance and works in both. The only visible difference is that the page shows the document number once it exists.

### Step-by-step journeys

#### J1: Player downloads the document for a paid game (AC-ENTRY-1, AC-HAPPY-1, 2, 3, 5, AC-ASYNC-1)

| # | System | User sees | User does | Transition |
|---|---|---|---|---|
| 1 | Billing (any route) | Their payment becomes "Paid" ("Paid from wallet", "Paid on Wed 7 Oct", or after a resolved hold) | Nothing | The PAID transaction enqueues `issue-invoice` (P5). Settlement route makes no difference after this point (AC-HAPPY-5) |
| 2 | Worker | Nothing | Nothing | The job assigns the number and writes the snapshot, normally within 30 s |
| 3 | Web page `/payments/[id]` (server component, API `GET /payments/:id`) | Status "Paid", and in a "Your tax invoice" (or "Your receipt") block: "Download tax invoice" (or "Download receipt"), with "Tax invoice INV-000012" under it once issued. Accessible name includes the game and the amount (AC-ENTRY-1) | Taps "Download tax invoice" | Browser requests `/payments/[id]/invoice` |
| 4 | Next route handler → API `GET /payments/:id/invoice` | Nothing yet (the page stays put) | Waits under a second | API: payer check, PAID and > $0.00 check, issue now if the job hasn't (idempotent, AC-ASYNC-1), render the PDF from the snapshot |
| 5 | Browser | The file `INV-000012-<team>.pdf` saves or opens (phone: the share or open sheet; desktop: the downloads bar). The page is unchanged | Opens the PDF | **Success**: a document titled "Tax Invoice" (GST snapshot) or "Receipt" (non-GST snapshot) with the team as supplier (H1), the number, date of issue, paid date, buyer, game, lines and the stored totals |

From the wallet page: step 3 happens on a PAID row of the Payments list. The row shows the same action, with the same accessible name pattern ("Download tax invoice, Hōkio Courts, Wed 7 Oct, $23.00"). Rows for PENDING, OVERDUE, held and $0.00 payments show none.

**Success indicator (exact)**: the browser receives `200 application/pdf` with `content-disposition: attachment; filename="INV-000012-…pdf"`; the payment page, if reloaded, shows "Tax invoice INV-000012" and the same button; a second download is byte-identical.

**Variants**
- **J1a, the window before the job runs.** The payer opens the page seconds after paying (the Akahu return page, or straight after a wallet deduction notice). The button is already there. Pressing it issues the document on the spot (step 4). There is no "Preparing your invoice" state and no auto-refresh loop. *Spec conflict SC-1*: AC-ASYNC-1 asks for `RefreshWhilePending` while the number is pending. This journey drops that: the only thing the refresh would change is the printed number, and an auto-refresh loop announces changes to screen readers for no user benefit. The page shows the number on its next ordinary render.
- **J1b, the payer is not signed in** (bookmarked download URL, or the session expired). The route handler gets 401 and redirects to sign-in with `returnTo` set to the **payment page**, not the download URL. Signing in lands on the payment page, where one more tap downloads. (Returning to a download URL would leave the user on the sign-in page while the file downloads, which looks like a failed sign-in.)
- **J1c, a former or banned member.** They can no longer open the team's wallet page, but `/payments/[id]` is payer-scoped, so they download from there (reached from the "Payment received" email, or a link their team admin sends).
- **J1d, a payment that is not paid** (PENDING, OVERDUE, processing, held). The page shows no download block at all; the existing status block explains the payment. A direct request to the download URL redirects to `/payments/[id]?notice=invoice_not_available`: "An invoice is available once the payment is paid." (AC-ERROR-1). No number is used.
- **J1e, a $0.00 payment** (B7). The page shows the existing "There's no charge for this game." and no download block. A direct request gets the same `invoice_not_available` notice (AC-ERROR-5).
- **J1f, a held payment later resolved as received.** While held: no document. When a team admin (or global admin) records RECEIVED, the payment becomes PAID, the resolution enqueues issuance, the "Payment received" email ("…your payment went through.") links to the page, and the button is there.
- **J1g, the team changed its GST registration between charges.** Each payment keeps the kind decided at charge time: a fee charged while registered downloads as "Tax invoice INV-…", one charged after de-registration downloads as "Receipt …", and the wallet list labels each row's action accordingly. The player sees no explanation and needs none; the button name is the explanation. (The accountant question about a team that de-registers between charge and issue is listed in Open questions, OQ-4.)
- **J1h, a payment paid before this feature shipped.** At deploy, a one-off backfill issues documents for existing PAID payments in `paid_at` order per team, so older games get the lower numbers. The document shows "Date of issue" (the backfill date) and "Paid on" (the original date) (AC-ASYNC-3, H12). If the player presses the button before the backfill reaches their payment, J1a's on-demand issue covers it.
- **J1i, a late-withdrawal fee.** Same journey; the document describes it as "Late withdrawal fee, <location>, <date>" (AC-ERROR-6, H10).
- **J1j, issuance fails at the click** (a data error, a lock timeout, the API down). The route handler redirects to `/payments/[id]?notice=invoice_failed`: "We couldn't prepare your invoice just now. Try again in a few minutes. If it still doesn't work, ask your team admin." The payment is untouched and no number is used (the issue transaction rolled back). The failure is logged for ops (J6).

#### J2: Player collects older invoices (the end-of-year moment)

| # | System | User sees | User does | Transition |
|---|---|---|---|---|
| 1 | Web `/teams/[T]/wallet` | The Paid group, latest 10 games, and "Showing your latest 10 paid games." | Looks for a game from three months ago | — |
| 2 | (gap today) | The game isn't listed | — | **Dead end** unless they kept the email (and wallet-paid games never send one) |

This is the main way the feature can fail its primary persona. See **Gap G1** and Open question OQ-1. The recommended fix: a "Show older paid games" link under the Paid group that pages back through the player's paid payments in this team (the API list is already keyset-paged), each row with its download action. The alternative is to wait for player-dashboard and tell players to ask their team admin meanwhile.

#### J3: Team admin fetches a player's document (AC-ENTRY-3, AC-ERROR-2)

| # | System | User sees | User does | Transition |
|---|---|---|---|---|
| 1 | Web `/teams/[T]/manage/payments` | Filters "All", "Unpaid", "Paid", … | Taps "Paid" | `?status=PAID` |
| 2 | Same page, `AdminPaymentsTable` | PAID rows above $0.00 carry "Invoice" (accessible name: "Download tax invoice INV-000012, Aroha Ngata, Wed 7 Oct, $23.00", or "Download receipt …"). PENDING, OVERDUE, held and $0.00 rows carry none | Taps "Invoice" | Browser requests `/teams/[T]/manage/payments/[id]/invoice` |
| 3 | Route handler → API `GET /teams/:T/payments/:id/invoice` | The same PDF the payer gets (same bytes) | Opens it, forwards it to the player | **Success**: the admin has the exact document the player would have |

- **J3a, not yet issued**: issues on demand, as J1a. Whoever presses first, payer or admin, both get the same number.
- **J3b, refused or failed**: redirect to the Payments area with `?notice=invoice_not_available` or `invoice_failed`, the filter kept.
- **J3c, a global admin who is not a team admin** opens the Payments area for support: rows show no "Invoice" action (the API would answer 404). They see the same names, dates and amounts as today.

#### J4: Team admin finds Income exports (AC-ENTRY-2)

| Who | What they see |
|---|---|
| TEAM_ADMIN of T | Manage nav: People, Banking and GST, Sessions, Payments, **Income exports** (`aria-current="page"` when open) |
| MEMBER of T (typed URL) | The existing no-access page, none of the area's content, no nav |
| GLOBAL_ADMIN who is not a team admin | Nav shows Payments only (CR-21, unchanged). A typed URL gives the no-access page (H9) |
| TEAM_ADMIN of another team | The no-access page |

#### J5: Team admin exports income (AC-HAPPY-6, 7, 8, 9, AC-ERROR-3, 4)

| # | System | User sees | User does | Transition |
|---|---|---|---|---|
| 1 | Web `/teams/[T]/manage/exports` (server component; one guard read that also returns the options: the financial years that contain a PAID payment plus the current one, and the team's current GST status) | Heading "Income exports", one sentence on what is included ("Paid game fees, by the date they were paid. Wallet top-ups are not included."), a period type choice: **Custom range**, **GST period**, **Financial year**; a format choice **CSV** / **Excel**; "Download" | Picks "GST period" | Only the GST period inputs show (progressive disclosure): the two-month alignment (periods ending Jan/Mar/… or Feb/Apr/…, H8) and the period |
| 2 | Same page | The period list, newest first, labelled "1 Apr 2027 to 31 May 2027" | Picks a period, "Excel", taps "Download" | A plain form GET to `/teams/[T]/manage/exports/income?…` (works without client JavaScript) |
| 3 | Route handler → API `GET /teams/:T/exports/income` | The page stays put | Waits a moment | API: TEAM_ADMIN check, validate, resolve the preset to `from`/`to` with the shared helpers, count against the cap, then stream rows |
| 4 | Browser | File `<team>-income-2027-04-01-to-2027-05-31.xlsx` saves | Opens it | **Success**: a Payments sheet (one row per PAID payment, numeric money cells) and a Summary sheet (team, GST number if registered, period, row count, subtotal, GST, total) that reconciles to the rows and to the invoices |

- **Custom range**: two labelled date inputs, From and To (NZ dates, inclusive). **Financial year**: one select of "2026-27 (1 Apr 2026 to 31 Mar 2027)" style labels. The chosen preset always shows its exact dates before download, so the admin knows what the file will cover.
- **J5a, an empty period** (no PAID payments). Not an error: the file downloads with only the header row (CSV) or zero totals (Excel). The page cannot tell the admin before download that it is empty, so the form's helper line says "A period with no paid games downloads an empty file." (A count preview is a possible later improvement, not v1.)
- **J5b, invalid input** (end before start, 2027-02-30, longer than the maximum range, a future-only range, an unknown year or format). The route handler gets 422 and redirects back to the form with the entered values and the error code in the query; the page renders the form with the values kept, the message next to the field ("The end date can't be before the start date."), an error summary at the top, and focus moved to it. No file. Date inputs also carry `min`/`max` so most mistakes are caught before submit, but the API is the authority.
- **J5c, too large** (more rows than the cap). Refused before any byte is streamed: redirect back with "This period has too many payments for one file. Choose a shorter range." and values kept. Never a partial file (AC-ERROR-4).
- **J5d, a team that is not GST-registered, or changed registration in the period.** Exports work the same. Each row carries the payment's own GST-registered flag and document type; GST is 0.00 on non-registered rows. The Summary says which applies ("GST-registered for all of this period", "Not GST-registered", or "GST-registered for part of this period"), so the admin is not misled by a total GST that covers only some rows.
- **J5e, the session expired.** 401 → sign-in with `returnTo` = the exports page with the chosen values; after sign-in the admin taps Download again.
- **J5f, the admin lost the role between page load and submit.** 403 → the no-access page.
- **After download**: the page does not claim success (it cannot know the file saved). It stays as it was, values kept, so a second format can be downloaded at once.

#### J6: Ops re-runs a failed issuance (AC-ASYNC-2, 3; Implementation Guide)

Most failures need no human: the payer's click issues on demand (J1a) and the sweep re-issues any PAID payment above $0.00 that still has no number after a set age. Ops acts when the sweep's own count of unissued payments stays above zero, or a player or admin reports J1j repeatedly.

1. **Find it.** The worker logs `invoice.issue.failed` (payment id, team id, error class, SQLSTATE, attempt; never the message). Failed jobs stay in `pgboss.job` with state `failed` and name `issue-invoice`. A reconcile check (proposed: a line in `cli billing reconcile`, or `cli invoices unissued`) lists PAID payments above $0.00 with no number older than the sweep age.
2. **Fix the cause** if it is a data error (SQLSTATE class 23) or a lock timeout (55P03, normally transient). Never hand-edit `payments`, the counter or the snapshot: the triggers refuse it, and a number must never be reused.
3. **Re-run.** `pnpm run jobs:trigger issue-invoice '{"paymentId":"<uuid>","trigger":"manual"}'`. Safe to repeat: an issued payment logs `invoice.issue.skipped` with `already_issued` and changes nothing. The sweep can also be triggered by name.
4. **Confirm.** `invoice.issued` with `source: manual`; the payer's next download works.

#### J7: A player reports wrong details on an issued document (H5)

The issued document is final. v1 has no edit, void, re-issue or credit note.

| Reported problem | What support and the team admin do | What the player gets |
|---|---|---|
| Buyer name wrong or outdated (profile typo, name changed later) | Explain the document shows the name on the profile at issue time. The team admin, who is the supplier, issues a corrected document outside the app if the player needs one | The in-app document stays as issued; a corrected one from the team |
| Team name wrong | Same; the admin corrects the team details for future documents (there is no rename route in v1, so this goes through support) | As above |
| GST number wrong (the team saved a wrong number) | Serious: every document since the charge carries it. The admin fixes the number on Banking and GST (affects only new charges), tells their accountant, and corrects affected documents outside the app. Ops can list the affected payments by team and charge date | Corrected documents from the team |
| "This should be a tax invoice, not a receipt" | Explain: the team was not GST-registered when the fee was charged. If the team says it was registered then, that is an accountant question (OQ-4); no in-app change | — |
| Amount or GST wrong | Should not happen: the document prints the stored values that billing charged. Treat as an incident: compare the PDF with `payments.amount`, `gst_amount`, `subtotal_amount` | — |

Support's view of what was issued: the player's own PDF, or the team admin's download (J3). Ops can read the snapshot row read-only. A global admin has no in-app download (H9, AC-ERROR-2; see OQ-3).

Prevention (proposed, UI/UX lane): the Banking and GST page says, next to the GST number, "This number is printed on your players' tax invoices." so a wrong number is caught before the first charge.

#### J8: player-dashboard reuses the download (design question 7)

The "Payments & Wallet" tab (a later feature) shows paid payments across teams. It must not rebuild the download. Contract:
1. **One component.** `DownloadInvoiceLink` (`apps/web/src/components/invoices/download-invoice-link.tsx`) takes the payment id, the document kind, the document number (or null), and the game label and amount for the accessible name. It renders nothing when the payment has no document. The wallet list, the payment page and the dashboard all use it.
2. **One route.** It links to `/payments/[id]/invoice`. The dashboard never calls the API's invoice route itself.
3. **One error landing.** A refused or failed player download always lands on `/payments/[id]?notice=…`, whichever page started it. The dashboard needs no error handling of its own, and a crafted return parameter can't send the user anywhere else.
4. **Contract fields.** `MyPaymentRow` and `PaymentResponse` (and the admin row) carry the document fields the button needs (see Requirements on Architecture, R-A4). The dashboard reads the same fields.

Record this in ADR 0021 next to ADR 0020's slot contract.

---

## Gaps found in the existing surfaces

- **G1. Older paid games are unreachable for wallet payers.** The wallet page shows the latest 10 paid games (`PAID_SHOWN`, `PAID_CAPPED_NOTE`), and no "Payment received" email is sent for a wallet deduction. A regular player has 10 games in a few weeks, so by the end of the financial year most of their invoices have no in-app path. Recommended: "Show older paid games" on the wallet page (OQ-1).
- **G2. Wallet-paid players get no email link.** Acceptable for v1 (no email changes are in scope; emailing the PDF is a COULD). G1 is the fix that matters.
- **G3. Former members** keep access only through `/payments/[id]` (J1c), which they reach only from an email or their team admin. player-dashboard closes this.

---

## Async Handling

### Operation lifecycle

| Phase | Duration | User experience |
|---|---|---|
| Payment becomes PAID | Immediate (billing) | Status "Paid"; the download action appears at once |
| Issuance job | Target under 30 s; p95 tracked | Invisible. The action works before and after |
| Issue on demand (button pressed first) | One request, under a second | The file downloads; the user never knows a job was pending |
| Sweep (safety net) | Every few minutes (architecture sets it) | Invisible; catches dead-lettered and missing jobs |
| Backfill at deploy | Once; minutes for the whole history | Invisible; older games get numbers in `paid_at` order |
| Export | One request; seconds at the row cap | The browser's download indicator; no page change |

### Progress communication
- **Method**: none needed for issuance (the boundary is hidden by issue-on-demand). The browser's own download indicator for files.
- **Persistence**: the issued snapshot is the persistent record; the page shows the number once issued. Exports persist nothing (computed per request).

---

## Distributed System Flow

### System boundaries

```
 Browser ──GET page──▶ Next server component ──bearer──▶ API GET /payments/:id ──▶ Postgres (payments + snapshot)
    │
    └──GET /payments/[id]/invoice──▶ Next route handler ──bearer──▶ API GET /payments/:id/invoice
                                         │  200: stream bytes,              │ authz (payer) → PAID>0?
                                         │  attachment, no-store            │ → issued? else issue now (txn:
                                         │  401: redirect sign-in           │   assign_invoice_number + snapshot)
                                         │  409/404/5xx: redirect page      │ → render pdfkit from snapshot
                                         ▼  ?notice=                        ▼
 Billing PAID writers (apply-akahu-result, bill-session, hold-resolution)
    └── same transaction: enqueue issue-invoice ──pg-boss──▶ Worker issue-invoice ──▶ Postgres (number + snapshot)
 Sweep (schedule) ──▶ finds PAID>0 with no number past age ──▶ enqueue issue-invoice

 Browser ──form GET──▶ Next route handler /teams/[T]/manage/exports/income ──bearer──▶ API GET /teams/:T/exports/income
                          200: stream CSV/XLSX                                  authz TEAM_ADMIN → validate → resolve preset
                          422: redirect form with values + error                → count vs cap → paged read → write file
```

### Responsibility matrix

| Step | Owner | State storage | Failure handling |
|---|---|---|---|
| PAID transition | Billing (unchanged except the enqueue) | `payments` | Billing's own; the enqueue commits or rolls back with PAID |
| Issue (job, sweep, on demand) | Invoices module (single writer of the invoice columns and snapshot) | `payments.invoice_*` + snapshot (architecture) | Rollback leaves no number used; job retries (3, backoff), then the sweep |
| Render PDF | Invoices module | None (rendered from the snapshot each time) | 5xx → route handler redirects with `invoice_failed` |
| Download transport | Next route handler | None | Every non-200 becomes a redirect to a page with a notice; never a raw body |
| Export | Income-exports module | None | 422 before streaming; a failure mid-stream aborts the response (the browser shows a failed download) and is logged |
| Export form state | URL query | The query string | Values kept on every redirect back |

---

## Error Handling

### Error states

| Error | When | User sees | Recovery |
|---|---|---|---|
| Not paid / $0.00 | Direct request | "An invoice is available once the payment is paid." on the payment page (or Payments area) | Pay, or wait for a hold to resolve |
| Not yours | Another user, or a guessed id | The uniform not-found page | None (by design) |
| Signed out | Any download or export | Sign-in, then back to the page (not the file URL) | Tap again |
| Issue or render failed | Data error, lock timeout, API down | "We couldn't prepare your invoice just now. Try again in a few minutes. If it still doesn't work, ask your team admin." | Retry; the sweep and ops (J6) |
| Invalid export input | 422 | Field message, values kept, error summary focused | Fix and download |
| Export too large | 422 `export_too_large` | "This period has too many payments for one file. Choose a shorter range." | A shorter range |
| Not a team admin | 403 | No-access page | — |
| Export fails mid-stream | Rare | The browser reports a failed download; the page is unchanged | Download again |

### Partial failure
- **Issuance**: number allocation and the snapshot commit together or not at all, so there is never a number without a document or a gap in the sequence.
- **Export**: the cap is checked before the first byte, so a refusal never yields a partial file. A crash mid-stream is the only partial case; the browser marks the download failed and nothing is persisted, so retrying is safe.

### Edge cases
- Two downloads at once before issuance (payer and admin, or a double tap): one number, both get the same bytes (AC-ASYNC-2).
- Link scanners or prefetch hitting a download URL: they are not signed in (401, no issuance). A signed-in prefetch would only issue a document the payment is owed anyway.
- A team admin who is also the payer: both routes work and return the same file.
- A payment whose team was deleted or whose payer account was deleted: out of the app's reach today (no delete paths); records are kept 7 years.

---

## Options Explored

### Option 1: Issue inside the PAID transaction (eager, synchronous)
- **Orchestration**: each PAID writer calls the issuer in its own transaction.
- **Flow**: the payment is PAID and numbered at the same instant; the button always has a number.
- **Pros**: no window; no job, sweep or on-demand path; simplest to explain.
- **Cons**: a failure to issue (a lock timeout on the team counter, a snapshot error) rolls back the **payment** itself, so a player's money can't be recorded because an invoice couldn't be written. `bill-session` billing 30 registrants takes the team counter lock for the whole batch. The Akahu apply funnel gains a team-wide lock. Couples billing to invoicing in exactly the code that wallet-and-akahu-billing kept separate (ADR 0020 C-INV-1).

### Option 2: Issue lazily on first download only
- **Orchestration**: no job; the first download allocates the number.
- **Wireframe**: same buttons as the chosen option.
- **Pros**: no job or sweep; numbers only for documents someone wanted.
- **Cons**: numbers follow download order, not supply order, so INV-000003 can be for a game months before INV-000002. Most payments never get a number, so the export's invoice-number column is mostly empty and does not tie to a register of issued invoices. An admin export would either show blanks or have to issue in bulk, which turns a read into thousands of writes. Accountants expect each supply to have its invoice.

### Option 3: Job at PAID, plus issue on demand, plus a sweep (hybrid) (CHOSEN)
- **Orchestration**: the PAID transaction enqueues `issue-invoice`; the worker issues within ~30 s; a download before that issues on the spot; a sweep re-issues anything still missing; a backfill numbers pre-feature payments in `paid_at` order.
- **Wireframe** (payment page, 360 px):
  ```
  ┌──────────────────────────────────┐
  │ Payment for Hōkio Courts, Wed 7 Oct│
  │ Team    Hōkio Badminton Club     │
  │ Amount  $23.00                   │
  │ GST     Includes GST of $3.00    │
  │ Status  [Paid]                   │
  │──────────────────────────────────│
  │ Your tax invoice                 │
  │ ┌──────────────────────────────┐ │
  │ │   Download tax invoice (PDF) │ │
  │ └──────────────────────────────┘ │
  │ Tax invoice INV-000012           │
  └──────────────────────────────────┘
  ```
- **Pros**: the player never meets the async boundary; numbers follow supply order in practice; billing only enqueues; failures self-heal (retry, sweep, on demand) and are visible to ops; every PAID payment above $0.00 ends up numbered, so exports and the register agree.
- **Cons**: three issuance entry points (job, sweep, on demand) must share one idempotent issuer. A GET can write (issue on demand). An on-demand issue can occasionally take a number a few seconds "ahead" of a payment paid slightly earlier whose job hasn't run; numbers are still gapless and unique, and the order differs only within that window.

### Option 4: Job only; show the button after issuance
- **Orchestration**: the page shows "Preparing your invoice…" with `RefreshWhilePending` until the number exists; the download is a pure read.
- **Pros**: the download never writes; strict issue order.
- **Cons**: a new visible state the player must wait through right after paying (the moment they most want the receipt); a dead-lettered job leaves the player stuck with "Preparing…" until ops acts; an auto-refresh loop on the page. Borrowed from it: the sweep, so stuck jobs are caught without a player.

---

## Evaluation Matrix

| Criterion | 1 Eager in PAID txn | 2 Lazy on download | 3 Job + on demand + sweep | 4 Job only |
|---|---|---|---|---|
| Discoverability | H | H | H | M (button missing at first) |
| Learnability | H | H | H | M (extra state) |
| Efficiency | H | H | H | M (waits) |
| Error prevention | L (invoice failure blocks payment) | M | H | M |
| Error recovery | L | H | H | L (stuck until ops) |
| Feedback | H | H | H | M |
| Consistency (with billing's separation, P5) | L | M | H | H |
| Accessibility | H | H | H | M (refresh loop) |
| Accounting fit (every supply numbered, in order) | H | L | H (near-order) | H |

## Decision

**Chosen**: Option 3 - Job at PAID, plus issue on demand, plus a sweep (hybrid), with the download action shown for every PAID payment above $0.00 from the moment it is paid, one shared download component, and every refused or failed download landing on a page with a notice.

### Rationale
The player's need is "a document for this payment, now or months later". Option 3 is the only one in which the button always works, every paid supply gets its number in close to supply order, and billing is not made to wait on or fail because of invoicing. The issuance job matches the existing pg-boss pattern (P5) and the spec's default; issue on demand removes the visible window; the sweep removes the dependence on ops for transient failures. The export is a single synchronous request because exports are rare, bounded by a cap, and an admin waits for the file anyway.

### Trade-offs accepted
- **A GET can issue.** Acceptable: issuance is idempotent, payer- or admin-only, and would happen anyway. It is never reachable signed out.
- **Near-order, not strict order, of numbers** in the seconds between PAID and the job. Numbers stay unique, gapless and permanent (ADR 0011). The accountant reviews this in AC-VERIFY-9 (OQ-5).
- **No "preparing" state and no refresh loop** (SC-1 against AC-ASYNC-1). The page shows the number on its next render.
- **Wrong details are corrected outside the app** (H5). Mitigated by the Banking and GST helper line and by J7's support runbook.
- **Older invoices are hard to reach for wallet payers** until G1 is fixed. Recommended fix in OQ-1.

---

## Requirements on the other lanes

### Architecture
- **R-A1** Billing's PAID writers only **enqueue** issuance in the PAID transaction. No issuance failure may roll back or delay a PAID transition.
- **R-A2** One idempotent issuer used by the job, the sweep, the backfill and the download routes. Concurrent callers for one payment get one number and the same snapshot; the losing caller reads the winner's result (no 5xx, no second allocation).
- **R-A3** A safety net: a scheduled sweep issues any PAID payment above $0.00 with no number older than a set age, and a deploy-time backfill issues pre-feature PAID payments per team in `paid_at, id` order. Sweep and backfill log counts.
- **R-A4** Contract fields on `PaymentResponse`, `MyPaymentRow` and the admin payments row, available **before** issuance: whether a document exists for this payment (PAID and above $0.00), its kind (tax invoice or receipt, from the charge-time `gst_registered`), and its number or null. Proposed shape `invoice: { kind: 'TAX_INVOICE' | 'RECEIPT', number: string | null } | null`. player-dashboard reads the same fields.
- **R-A5** The printed number's prefix must match the document title (a receipt must not print "INV-"), whatever the counter decision (shared or separate, H2 follow-up).
- **R-A6** Download transport through Next route handlers that stream the bytes with `attachment`, the file name and `no-store`, and turn every non-200 into a redirect: 401 → sign-in with `returnTo` = the **source page**; 409/404/5xx on the player route → `/payments/[id]?notice=…`; on the admin route → the Payments area with a notice and the filter kept; 422 on the export → the form with values and error code. The return target is fixed per route, never taken from a request parameter.
- **R-A7** A guard read for the exports page that also returns the options (financial years with at least one PAID payment, plus the current one; the team's current GST status). TEAM_ADMIN only, `allowGlobalAdmin` off (H9).
- **R-A8** The export endpoint accepts a plain form GET (no JavaScript required), checks the row cap **before** streaming, and never returns a partial file on refusal.
- **R-A9** No GLOBAL_ADMIN access to either invoice route (AC-ERROR-2). The Payments table hides "Invoice" for a global-admin-only viewer.
- **R-A10** An ops check for unissued PAID payments (a line in `cli billing reconcile` or a new command) and `issue-invoice` triggerable with `jobs:trigger`, safe to repeat.
- **R-A11** Decide and record in ADR 0021 which snapshot fields are frozen at charge time (GST registration, rate and number, already frozen by D-88) and which at issue time (supplier name, buyer name, game description). A backfilled document's issue-time names are the names at backfill.

### Algorithm
- **R-L1** Every preset (GST period in either alignment, financial year) resolves to the same `from`/`to` local dates a Custom range would use, so the page can show the exact dates before download and AC-HAPPY-7's identity holds.
- **R-L2** A valid range with no rows yields a header-only CSV and an Excel Summary with zero totals, not an error.
- **R-L3** Each row carries the payment's own GST-registered flag and a document-type value (tax invoice, receipt, or none for $0.00), so a mixed-registration period reads correctly; the Summary states whether the team was registered for all, none or part of the period.
- **R-L4** The cap is a count check before streaming; the range limit and cap values come with user-facing messages (J5b, J5c).
- **R-L5** The list of GST periods and financial years offered on the form is bounded (from the first PAID payment's period to the current one) and ordered newest first.

### UI/UX
- **R-U1** The download block on the payment page and the action on wallet and admin rows, with accessible names that include the document type, game and amount (and the number when known), 44 px targets, and "(PDF)" in the visible label or name.
- **R-U2** The notice copy for `invoice_not_available` and `invoice_failed` (proposed above) on the payment page and the Payments area.
- **R-U3** The exports form: three period types with progressive disclosure, the resolved dates shown for every preset, the scope sentence ("Paid game fees, by the date they were paid. Wallet top-ups are not included."), the empty-period helper line, field errors with an error summary and focus management, values kept after an error, and no false "downloaded" confirmation.
- **R-U4** "Show older paid games" on the wallet page if OQ-1 is accepted.
- **R-U5** The Banking and GST helper line "This number is printed on your players' tax invoices."
- **R-U6** File names: `INV-000012-<team-slug>.pdf` (or the receipt prefix) and `<team-slug>-income-<from>-to-<to>.<csv|xlsx>`, ASCII-only slugs (macrons folded) so every OS saves them.

---

## Implementation Guidelines

### Frontend Requirements
1. `DownloadInvoiceLink` component, used by `payment-detail.tsx`, `payments-list.tsx` and `admin-payments-table.tsx` (admin variant label "Invoice").
2. Three Next route handlers sharing `lib/invoices/download.ts` (bearer forwarding, header pass-through, error-to-redirect mapping).
3. `/teams/[T]/manage/exports/page.tsx` with `IncomeExportForm`; a new `MANAGE_AREAS` entry `{ id: 'exports', label: 'Income exports', segment: 'exports' }`; not added to `GLOBAL_ADMIN_AREA_ID`.
4. Notice codes in the billing or invoices labels module.

### Backend Requirements
1. Invoice routes (payer, team admin) and the export route, OpenAPI entries.
2. `issue-invoice` queue and handler, the sweep schedule, the backfill, the enqueue in each PAID writer.
3. The contract fields of R-A4 on the three payment read models.

### Integration Points

| System | Interface | Data exchanged |
|---|---|---|
| Billing PAID writers | pg-boss enqueue in the PAID transaction | `{ paymentId, trigger }` |
| Worker | `issue-invoice` job, sweep schedule | Payment id; result logged |
| Web ↔ API | Bearer-authenticated GETs via Next route handlers | PDF bytes, CSV/XLSX bytes, or a status + code |
| player-dashboard (later) | `DownloadInvoiceLink` + contract fields | Payment id, kind, number |

---

## Acceptance Criteria (MANDATORY)

These journey criteria add to the spec's AC list; they do not replace it. They become test cases.

### JAC-ENTRY-1: The download action is on every paid payment above $0.00, and only there
**Priority**: MUST
**Given** a payer with payments in each state: PAID (bank), PAID (wallet), PAID after a resolved hold, PAID $0.00, PENDING, OVERDUE, held, processing
**When** they open `/payments/[id]` for each, and the team's wallet page
**Then** only the three PAID payments above $0.00 show "Download tax invoice" (GST snapshot) or "Download receipt" (non-GST snapshot), in both places, with an accessible name containing the game and the amount; the others show no download action
**Verification**:
- [ ] E2E: action present and labelled per kind; absent for the five other states
- [ ] Component: `DownloadInvoiceLink` renders nothing for a payment without a document

### JAC-HAPPY-1: The player downloads before the job has run
**Priority**: MUST
**Given** a payment that became PAID with the issuance job not yet run (worker paused in the test)
**When** the payer presses "Download tax invoice"
**Then** the browser receives the PDF with a number; when the worker then runs the job it logs `invoice.issue.skipped` (`already_issued`); a reload of the page shows "Tax invoice INV-…" with the same number; no refresh loop ran on the page
**Verification**:
- [ ] Integration: on-demand issue then job is a no-op
- [ ] E2E: download event captured; page shows the number after reload

### JAC-HAPPY-2: The admin exports a GST period whose Summary matches the invoices
**Priority**: MUST
**Given** a GST-registered team with two players' payments paid in April and May 2027 (one by bank, one by wallet), both invoiced
**When** the admin opens Manage → "Income exports", chooses "GST period", the alignment ending in odd months, "1 Apr 2027 to 31 May 2027", "Excel", "Download"
**Then** the form shows the resolved dates before download; the file name contains both dates; the Summary's row count is 2 and its GST and total equal the sums printed on the two PDFs
**Verification**:
- [ ] E2E: export download read back and compared to the two PDFs' extracted totals

### JAC-ERROR-1: Every refused or failed download lands on a page with one sentence
**Priority**: MUST
**Given** the player route answers 409, and separately the API answers 500, and separately the admin route answers 409
**When** the download is requested
**Then** the player is redirected to `/payments/[id]` showing "An invoice is available once the payment is paid." or "We couldn't prepare your invoice just now. …"; the admin is redirected to the Payments area with the filter kept and the same kind of sentence; no response body is ever shown raw; no number was consumed
**Verification**:
- [ ] Unit: route-handler status → redirect mapping (fixed targets, no request-supplied target)
- [ ] E2E: mocked failure shows the notice

### JAC-ERROR-2: An invalid export keeps the admin's input and focuses the error
**Priority**: MUST
**Given** the exports form with Custom range From 2027-06-15, To 2027-06-01, format CSV
**When** the admin presses "Download"
**Then** the page shows "The end date can't be before the start date." next to To and in an error summary that receives focus, both dates and the format are still filled in, and no file downloads; a too-large range shows "This period has too many payments for one file. Choose a shorter range." the same way
**Verification**:
- [ ] E2E: values kept, focus on summary, axe clean with the error shown

### JAC-ASYNC-1: A failed issuance heals without the player
**Priority**: MUST
**Given** a PAID payment whose `issue-invoice` job failed all retries
**When** the sweep runs after its set age
**Then** the payment is issued with the next number, `invoice.issued` is logged with `source: sweep`, and the ops check reports zero unissued payments
**Verification**:
- [ ] Integration: dead-lettered job, sweep issues, reconcile count goes to 0

### JAC-NAV-1: A signed-out download returns to the page, not the file
**Priority**: SHOULD
**Given** a signed-out browser with a download URL for the user's own payment
**When** it opens the URL and signs in
**Then** it lands on `/payments/[id]` (not a blank or sign-in page), and one tap downloads the document
**Verification**:
- [ ] E2E: redirect chain ends on the payment page

### JAC-ADMIN-1: Export and invoice actions follow H9
**Priority**: MUST
**Given** a GLOBAL_ADMIN who is not a team admin, a MEMBER, and a TEAM_ADMIN of another team
**When** each opens `/teams/[T]/manage/payments?status=PAID` (where allowed) and `/teams/[T]/manage/exports`
**Then** the global admin sees the Paid rows with no "Invoice" action and no "Income exports" nav link, and gets the no-access page on the exports URL; the member and the other team's admin get the no-access page on both
**Verification**:
- [ ] E2E: role matrix on both pages

### JAC-OPS-1: Re-running issuance is safe
**Priority**: MUST
**Given** an issued payment
**When** ops runs `pnpm run jobs:trigger issue-invoice '{"paymentId":"<id>","trigger":"manual"}'` twice
**Then** the number, issue date and snapshot are unchanged, the counter is unchanged, and the log shows `invoice.issue.skipped` with `already_issued`
**Verification**:
- [ ] Integration: repeated manual trigger is a no-op

### JAC-INTEGRATION-1: Documents differ by input across the three settlement routes
**Priority**: MUST
**Given** a bank-paid, a wallet-paid and a hold-resolved payment for different players and games
**When** each payer downloads their document
**Then** each PDF's extracted text names its own buyer, game, amount and number; the numbers are consecutive in issue order; none contains "TODO", "sample", "undefined" or an Akahu reference
**Verification**:
- [ ] Integration: three PDFs parsed and compared

---

## Test Scenarios (Derived from Acceptance Criteria)

### Happy Path Tests
1. JAC-ENTRY-1: action per state and kind
2. JAC-HAPPY-1: download before the job; job then no-op
3. JAC-HAPPY-2: GST-period Excel export reconciles to the PDFs
4. JAC-INTEGRATION-1: three settlement routes

### Error Scenario Tests
1. JAC-ERROR-1: refusal and failure land on pages with notices
2. JAC-ERROR-2: invalid and too-large exports keep input
3. JAC-ADMIN-1: role matrix

### Edge Case Tests
1. JAC-ASYNC-1: sweep heals a dead-lettered job
2. JAC-NAV-1: signed-out download
3. JAC-OPS-1: manual re-run is a no-op
4. J1g: one team, two payments either side of a GST registration change, two document kinds

---

## Accessibility Checklist

- [ ] The download action is a link or button reachable by keyboard, 44 px, with a name stating the document type, game, amount and "PDF"
- [ ] A download does not move focus or change the page; nothing claims success that the page can't know
- [ ] Notices after a redirect are in a `role="status"` region and focus goes to the page heading (existing pattern)
- [ ] The exports form: visible labels on every input and select; only the chosen period type's inputs are rendered (not just hidden visually); error summary focused after a failed submit; each error tied to its field with `aria-describedby`
- [ ] No time limits; no auto-refresh loop on the payment page
- [ ] 360 px reflow with no horizontal scroll on all four pages (AC-VERIFY-8)
- [ ] The PDF itself: real text (not images), a logical reading order and a document title (UI/UX lane decides how far tagging goes with pdfkit)

---

## Analytics & Observability

### Key Metrics

| Metric | Purpose | Target |
|---|---|---|
| Issuance lag (`issued_at - paid_at`), p95, by `source` | The 30 s target | p95 < 30 s for `job` |
| Share of issues with `source: on_demand` | Job too slow if high | < 5% |
| PAID payments above $0.00 with no number older than the sweep age | Safety net works | 0 |
| Download refusals by reason; download failures | Broken states or bugs | failures ~0 |
| Export refusals by reason (`invalid_range`, `too_large`) | Form clarity, cap fit | Low; `too_large` rare |

### Instrumentation Points (ids, kinds and counts only; never a name, amount, GST number or email)
- `invoice.issued`: payment id, team id, invoice number, kind, `source` (`job`, `on_demand`, `sweep`, `backfill`, `manual`), lag seconds.
- `invoice.issue.skipped`: payment id, reason (`not_paid`, `zero_amount`, `already_issued`).
- `invoice.issue.failed`: payment id, team id, error class, SQLSTATE, attempt.
- `invoice.downloaded`: payment id, actor role (`payer`, `team_admin`).
- `invoice.download.refused`: payment id (only when the caller is authorised for it), reason.
- `income_export.generated`: team id, period type, format, row count, duration.
- `income_export.refused`: team id, reason.
- `invoice.sweep.completed` / `invoice.backfill.completed`: counts issued and failed.
- Web: `web.invoices.download_failed` (route, status, code), following `web.billing.api_failure`.
- Traces: the `issue-invoice` job carries the enqueuing trace (`extractTraceMeta`); spans around PDF render and export generation.

---

## Validation Checklist

- [x] Journey delivers stated value (document for every paid fee; reconciled exports)
- [x] All personas can complete the journey (player, team admin; global admin excluded by H9; ops runbook)
- [x] Errors are recoverable (notices, kept input, sweep, manual re-run)
- [x] Async states are clear (hidden by issue on demand)
- [x] Consistent with existing patterns (payer-only page, manage-area registry, notices, reload-or-keep)
- [x] Accessible per requirements (checklist above)
- [x] Testable with defined scenarios
- [ ] G1 (older paid games) resolved by OQ-1

---

## Spec conflicts and additions (for the Creative Reconciliation)

- **SC-1** AC-ASYNC-1's "the page refreshes while a number is pending, using `RefreshWhilePending`" is dropped: the button works before issuance, so there is nothing to wait for. Proposed AC text: "…the player's button works whether or not the job has run; the page shows the number on its next render".
- **SC-2** Sign-in `returnTo` for a download is the source page, not the download URL (J1b). Add to AC-ERROR-2 or AC-VERIFY-6.
- **SC-3** Refused downloads redirect to a fixed page with a notice rather than rendering a body (AC-ERROR-1 says "the page renders that sentence in place of the button"; on the page itself no button is shown for non-paid payments, so the sentence appears only after a direct request).
- **SC-4** Additions: a sweep and its ops check (R-A3, R-A10); a document-type column in exports (R-L3); the Banking and GST helper line (R-U5); the receipt prefix rule (R-A5).

## Open questions for the human

- **OQ-1 (G1)** Add "Show older paid games" to the wallet page in this feature, so wallet payers can reach invoices for more than their latest 10 games? Recommended **yes**: end-of-year collection is the main reason to want invoices, and wallet payers get no email link. The alternative is to wait for player-dashboard.
- **OQ-2** Does the backfill of pre-feature PAID payments run once at deploy (recommended) or only on first download? On-demand-only would number old payments in download order.
- **OQ-3** Should a GLOBAL_ADMIN be able to download an issued document for support (read only)? The spec says no (AC-ERROR-2); this journey keeps that and relies on the player's copy or the team admin. Revisit if support needs it.
- **OQ-4 (accountant)** A team that was GST-registered when a fee was charged but de-registered before the document is issued: is a tax invoice still right? And the reverse (registered after the charge): is a receipt right? The journey follows the charge-time snapshot until told otherwise.
- **OQ-5 (accountant)** Is "near-order" numbering acceptable (an on-demand issue can take a number a few seconds before a slightly earlier payment's job)? Numbers stay unique, gapless and permanent.
- **OQ-6 (accountant)** For backfilled documents, "Date of issue" is the backfill date and "Paid on" is the original date (H12). Confirm.

## Next Steps

1. Architecture lane confirms R-A1 to R-A11 (issuer, sweep, backfill, contract fields, transport, prefix).
2. Algorithm lane confirms R-L1 to R-L5; UI/UX lane writes the copy and layout for R-U1 to R-U6.
3. The human rules on OQ-1 to OQ-3 at the creative reconciliation; OQ-4 to OQ-6 go with the accountant specimens (AC-VERIFY-9).
