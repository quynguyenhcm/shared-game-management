# ADR 0021: Tax invoices, receipts and income exports

- Status: **Proposed. Provisional until AC-VERIFY-9 records the accountant's review** (date, reviewer, outcome, required changes; see "Accountant review record"). The schema in "Decision" sections 1 to 4 ships in Phase 1 (migration `20261110000100000_tax_invoices.sql`); sections 5 to 9 are the design the later phases build and are updated as each lands.
- Task: tax-invoices-and-exports (Level 3)
- Sources: task file `memory-bank/tasks/tax-invoices-and-exports.md` (spec, human rulings H1 to H12 and R1 to R6, creative amendments CR-1 to CR-4); creative docs `memory-bank/creative/tax-invoices-and-exports-invoicing-{architecture,algorithm,user-journey,uiux}.md`.
- Numbering: the ADR is 0021; ledger deviations are D-99 to D-105 in `db/schema-deviations.md`, all in migration `20261110000100000_tax_invoices.sql`.
- Related ADRs: 0009 (money), 0010 (time), 0011 (invoice numbering; amended in part below), 0020 (wallet and Akahu billing, C-INV-1).

## Context

The product overview (section 8) requires GST compliance outputs for NZ teams: a GST split stored per payment, PDF tax invoices and receipts with sequential numbers, and CSV and Excel income exports for a custom range, a GST period and the financial year. The GST split already exists (D-19, D-88: `payments.gst_amount` and `subtotal_amount` are generated from the charge-time rate, and `gst_number` is a charge-time copy). The numbering machinery from ADR 0011 exists but nothing called it, and billing deliberately never sets `is_tax_invoice_issued` (ADR 0020 C-INV-1). No PDF, Excel or CSV code existed.

Rulings this ADR records, not reopened: **H1** the team is the supplier and the platform issues the document as the team's agent, with no platform GST number; **H2** a non-GST-registered team's player gets a numbered Receipt with no GST wording; **H7 (PDF)** pdfkit with an embedded TTF that covers macrons; **R1** a separate gapless series per document kind per team; **R2** GST periods of two months (both alignments) and six months (March and September); **R3** a custom range of at most 2,557 days; **R4** exports carry the payment reference; **R5** the wallet page can reach older paid games. H3 to H6 and H8 to H12 are defaults that wait for the accountant.

## Decision

### 1. Documents and kinds (H2, H3)

Every PAID payment above $0.00 gets exactly one numbered document: a **tax invoice** when the payment's charge-time snapshot says `gst_registered`, otherwise a **receipt**. The kind follows the immutable `payments.gst_registered`, so it can never disagree with the GST lines (SQL `payment_document_kind_of`, TypeScript `documentKindOf`). Unpaid, held, processing and $0.00 payments get no document and consume no number. A team that registers for GST after a charge was created issues a receipt for that charge; whether that is the right tax point is H12, for the accountant.

### 2. Series, numbers and the flag (supersedes ADR 0011 in part, D-100, D-101)

- One gapless series per team per kind: counter key `(team_id, document_kind)`, printed `INV-000123` (tax invoices) and `RCT-000123` (receipts), `format_document_number` in SQL and `formatDocumentNumber` in `packages/shared/src/invoice/document.ts`. Uniqueness is `(team_id, gst_registered, invoice_number)` (`uq_payments_team_series_number`), replacing `(team_id, invoice_number)`. A number is never reused; a credit-note series is reserved (`ALTER TYPE payment_document_kind ADD VALUE 'CREDIT_NOTE'`, H5) and not built.
- `payments.is_tax_invoice_issued` is now a **generated** column `(invoice_number IS NOT NULL AND gst_registered)`: it keeps the meaning in its name, a receipt number does not set it, and it cannot drift. `payments_invoice_stamp_pair` keeps the number and issue time together.
- A number exists only on a PAID payment above $0.00 (`payments_invoice_requires_paid`; PAID is terminal, D-87, so the CHECK cannot become false later).
- ADR 0011 stays accurate for what it still says (gapless per team, allocate last, `SET LOCAL lock_timeout`, never two teams in one transaction, never reuse a number) and carries a note that this ADR supersedes its counter key and unique constraint.

### 3. The snapshot table (D-99, D-104)

`payment_documents` holds one immutable row per issued payment: `document_kind`, `number_display` (the printed number, frozen), `issued_at`, `supplier_name` (the team's name at issue, H1), `buyer_name`, `session_location`, `session_starts_at`, `charge_reason` (`GAME_FEE` or `LATE_WITHDRAWAL`) and `layout_version`. It copies only what is mutable elsewhere. Amounts, rate, GST number, billing type, `paid_at` and the lines stay on `payments` and `payment_line_items`, which are immutable, so printed money is the stored columns and is never recomputed. Guest display names are never copied (they are mutable; the document labels guest lines "Guest 1" and "Guest 2").

- Append-only: `payment_documents_append_only` reuses `reject_modification()`; the FK to `payments` is `RESTRICT`; there is no delete path (7-year retention).
- `payment_documents_guard_insert` ties the snapshot to its payment: it carries a number, the kind matches `gst_registered`, `number_display` equals the formatted counter value and `issued_at` equals `invoice_issued_at` (23514 `payment_documents_matches_payment`).
- `payment_documents_required` is a deferred constraint trigger: a numbered payment with no document cannot commit, so allocating without issuing is impossible.
- `paid_at` is frozen once set (D-104). The printed "Paid on" and the export period filter depend on it; a moved `paid_at` would shift income between already-filed GST periods. The apply funnel sets it once, from PENDING or OVERDUE.
- Wording and layout never live in a stored row. They live in a versioned layout (`layout_version`). Until the first production document exists, layout 1 is edited in place (the accountant's changes land there); afterwards any change to printed output adds layout N+1 and old documents keep rendering with their own layout, so a reprint is a true copy.

### 4. The single issuer (D-103, D-105)

`issue_payment_document(payment_id)` is the only issuer. It locks the payment `FOR NO KEY UPDATE`, returns the existing document if one is already issued (`issued = false`; this is where the losing racer lands), refuses unless PAID above $0.00, reads the facts with plain reads, calls `assign_invoice_number` (the allocation, which locks the series counter row) and inserts the snapshot. `assign_invoice_number` is amended in place: series-aware, `FOR NO KEY UPDATE`, refuses unpaid or zero, no longer writes the flag. Lock order: payment row, then the counter row, then the foreign-key `KEY SHARE` on `teams` and `payments`. That `teams` key share inverts the canonical order of ADR 0020 section 1 in the same benign way that section already records: `KEY SHARE` conflicts only with `teams FOR UPDATE` (banking removal), and removal never locks a payment, so no cycle can form. `idx_payments_unissued` serves the issuance drain and the reconcile sweep. No TypeScript source writes `payment_documents` or `team_invoice_counters`, only `modules/invoices/repo.ts` may call `issue_payment_document`, and no source calls `assign_invoice_number` (boundary tests, section 9).

### 5. Issuance flow (Phase 2)

A per-team `issue-invoices` job (policy `stately`, `singletonKey = issue-invoices:<teamId>`) is enqueued inside the PAID transaction in `bill-session` and the apply funnel's APPLY branch. It drains the team's unissued PAID payments above $0.00 in `(paid_at, id)` order, one payment per transaction, so an invoice defect can never block settlement (ADR 0020 C-INV-1 stays true: billing only enqueues). Downloads issue on demand through the same SQL function (a GET that issues is idempotent and equal to the job's work). `invoice-reconcile` runs at boot and every 15 minutes and is also the backfill for payments paid before this feature. Numbers follow issue order, normally paid order.

### 6. Rendering (Phase 3)

pdfkit 0.20.2 (MIT, exact version) renders each PDF on demand from the snapshot, the payment's immutable columns and its lines, by `layout_version` (`LAYOUTS` in `modules/invoices/render-pdf.ts`; only layout 1 exists). Layout 1 is a single-column A4 page with 48 pt margins, black on white, nothing below 9 pt, a tax-invoice and a receipt variant inside one model, and all wording in `packages/shared/src/invoice/document-copy.ts` (no stored row holds a word of it, so an accountant's wording change is one edit and no migration). Printed subtotal, GST and total are the stored `payments` columns formatted, never recomputed. The PDF info dates are the document's own issue time and the renderer reads no clock, so the same snapshot renders to the same bytes (tested). A layout that would spill to a second page throws. There is no default font: the constructor is given `font: ''` and every text call selects an embedded face first, so no built-in WinAnsi font can ever draw (and corrupt) a macron.

**Font: Noto Sans Regular and Bold, SIL Open Font License 1.1.** Taken from the npm package `@expo-google-fonts/noto-sans` **0.4.2** (package licence `MIT AND OFL-1.1`; the font files carry "Copyright 2022 The Noto Project Authors (https://github.com/notofonts/latin-greek-cyrillic)"), tarball `https://registry.npmjs.org/@expo-google-fonts/noto-sans/-/noto-sans-0.4.2.tgz`, fetched with `npm pack` on 2026-11-13 and copied (not a runtime dependency) into `apps/api/src/modules/invoices/fonts/` together with the licence text:

| File in `modules/invoices/fonts/` | Source file in the package           | SHA-256                                                            |
| --------------------------------- | ------------------------------------ | ------------------------------------------------------------------ |
| `NotoSans-Regular.ttf`            | `400Regular/NotoSans_400Regular.ttf` | `fe8c022f48d8dd29f17b744d16f9346f4357e16f7d4f7be58b000ae7c291b614` |
| `NotoSans-Bold.ttf`               | `700Bold/NotoSans_700Bold.ttf`       | `13a813c49624ae3ba3c5c6e72c5ebffc4b9e1e6ea32f421c04069b037c6ad431` |
| `OFL.txt`                         | `LICENSE_FONT`                       | `cee9892f9f0cc8fe882c9e9537ee6a89621d86ee7ceaf70b02e2b2b1c25c061a` |

The OFL permits embedding, subsetting and redistribution with the licence text, which ships beside the files and into `dist/fonts/`; the fonts are not sold by themselves. `tsup.config.ts` `onSuccess` copies the directory to `dist/fonts/` (the `common-passwords.txt` precedent), so the Dockerfile is unchanged (it already copies `dist`). The renderer resolves the files from `import.meta.url` (source under `tsx`, the bundle in production), and `buildApp` reads both once at boot and throws if either is missing (P7). A test proves macron coverage (ā ē ī ō ū and capitals) in both weights and that macron names survive text extraction. `pdfkit` and `fflate` are the new runtime dependencies; `@types/pdfkit` and `unpdf` (PDF text extraction in tests) are dev dependencies, `read-excel-file` is test-only.

### 7. Downloads (Phase 3 and 4)

Phase 3 routes: `GET /payments/:paymentId/invoice` (payer only, `authenticated()`, the payment resolved by `(id, user_id)`) and `GET /teams/:teamId/payments/:paymentId/invoice` (`TEAM_ADMIN` of that team only, `allowGlobalAdmin` off, H9; resolved by `(id, team_id)`), file names `tax-invoice-INV-000001.pdf` / `receipt-RCT-000001.pdf` (`lib/http/content-disposition.ts`, ASCII-safe with the RFC 5987 form). Every answer, errors included, is `no-store`; the invoice is issued on demand by `issueOnDemand` when the job has not run, and a 409 `invoice_not_available` consumes no number. API routes return `application/pdf`, `text/csv` or the OOXML sheet type with `cache-control: no-store`, `x-content-type-options: nosniff`, an exact `content-length` and an ASCII `content-disposition`. The web streams the bytes through Next route handlers that forward the session bearer and turn any error into a 303 back to the page with `?download_error=<code>`. New error codes `invoice_not_available`, `invoice_pending` and `export_too_large` exist from Phase 1 in `packages/shared/src/api/errors.ts`.

### 8. Exports (Phase 4)

Atomic (never truncated), built from a REPEATABLE READ cursor, row cap 50,000 and a 2,557-day range limit (CR-3 adds a hard production ceiling, an encoded-byte cap, request cancellation and a bounded semaphore). CSV is UTF-8 with a BOM and CRLF with RFC 4180 quoting and spreadsheet-formula neutralisation. XLSX is written by an in-house minimal OOXML writer on `fflate` that writes money cells from decimal strings. The decision table (checked 2026-11-10):

| Candidate                     | Licence    | Why not                                                                                                                            |
| ----------------------------- | ---------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| `exceljs`                     | MIT        | No stable release since 2023-10, heavy dependency tree, money cells are JS numbers                                                 |
| `write-excel-file`            | MIT        | Money cells are JS numbers (a P2 exemption), whole sheet held in memory                                                            |
| `xlsx` (SheetJS) on npm       | Apache-2.0 | Unfixed high advisories on npm; supported build lives outside the registry                                                         |
| in-house on `fflate` (chosen) | MIT        | No float, no formula can be written, deterministic bytes, no new transitive dependency; verified by an independent reader in tests |

The period helpers (`packages/shared/src/tax/periods.ts`, Phase 1) give every export one range semantics: a Pacific/Auckland `LocalDateRange` becomes the half-open instant pair `[start 00:00 NZ, end + 1 day 00:00 NZ)` in exactly one function, `toInstantRange`.

Phase 4 as built: `GET /teams/:teamId/exports/income` (`TEAM_ADMIN` of that team only, `allowGlobalAdmin` off, H9; query `format`, `period` and its dates or `fy` year, years 2000 to 2099 else 422) and `GET /teams/:teamId/exports/income/periods` (today in NZ, first paid date, financial years with payments, the limits). Every answer is `no-store`. Rows are `PAID` payments with `paid_at` in the half-open range, ordered by `paid_at`, invoice number (nulls last), then id, in one REPEATABLE READ read-only transaction that also reads the preflight aggregate, so the preflight and the rows are one snapshot and are reconciled before the file is returned (a mismatch discards the file). The preflight enforces the row cap and the byte cap with a generic 422 `export_too_large` message that reveals no internal limit. A bounded per-team and global semaphore answers 429 `export_busy` with a retry hint. On client disconnect the Postgres statement is cancelled through a dedicated cancel connection (`apps/api/src/lib/db/cancel.ts`, never the app pool, so cancellation cannot wait on an exhausted pool). The Summary sheet prints the GST numbers found on the exported rows; when the period has no payment it falls back to the team's current GST number, and says `Not registered` only for a team that is not GST-registered. The web app downloads through the Next route handler `teams/[teamId]/manage/exports/income`, which forwards the bearer and turns any error into a 303 with `?download_error=<code>`.

### 9. Single writers and the shared contract

Boundary tests (`modules/invoices/boundaries.test.ts`, and `payment_documents` added to the registrations money-table rule) enforce the single-writer rules of section 4 and prove each rule detects a violation. `PaymentDocumentRef` (`{ kind, available, number }`, `packages/shared/src/api/invoices.ts`) is the contract the billing DTOs gain in Phase 3 and the player-dashboard reuses.

## The one-way door (CR-2) and the legacy conversion (CR-1)

**Forward-only once used.** The down migration raises once any `payment_documents` row (or series counter) exists and never drops the snapshot table or the per-kind numbering: a document is a 7-year tax record. With nothing issued it restores the D-22 shape, which keeps the migrate / rollback / migrate round trip testable. After first use, recovery is a forward remediation migration or an application rollback that is compatible with this schema. **This was accepted with ruling R1** (separate series per kind), and it is recorded here so nobody expects `db:rollback` to undo issued documents.

**The migration converts and never clears (CR-1).** A database can hold numbered rows made by the old `assign_invoice_number`, which never checked payment state. The migration converts every numbered PAID payment above $0.00 into a snapshot with its number, kind and issue time kept, and rebuilds each team's counters per series from the numbers already issued. If any numbered row is not PAID above $0.00, or has no game to snapshot, the migration raises and aborts the deploy naming the offending ids; it never clears a number and never rewinds a counter. A team that numbered both registered and unregistered payments keeps each number inside its own series, so one series can start with a hole that the other filled. That is acceptable because no document had ever been printed (billing never issued one) and no production payment can exist before Akahu goes live, and the prefixes differ so no printed identifier is reused.

## Consequences

- Layout code is retained forever after go-live, one function per `layout_version`.
- A GET may issue a document. It is idempotent and equal to the job's work.
- We own about 250 lines of OOXML (Phase 4), checked by an independent reader and a manual open of the specimen in Excel and LibreOffice.
- Numbers follow issue order, not strictly paid order, when an on-demand download jumps the job. ADR 0011 promises gapless and unique, not paid-order.
- Follow-ups, not built: credit notes and refunds (H5), emailing the PDF, a metrics pipeline (`invoices_issued_total`, `income_exports_total`).

## Accountant review record (AC-VERIFY-9)

Status: **pending** as of 2026-11-13. Not yet reviewed: the numbering scheme and printed format (`INV-` and `RCT-`, six digits), the document content against IRD's taxable supply information rules (H6, H10), the kind following the charge-time registration (H12), the treatment of prepaid wallet credit and the export basis (H4), and the receipt for a non-registered team (H2). Until the outcome (approved, or the required changes), with the date and reviewer, is written here, the format is provisional in this ADR, in ADR 0011 and in product copy. Specimens were produced in Phase 5 and committed in `docs/specimens/` (2026-11-13): `tax-invoice-one-player.pdf`, `tax-invoice-with-guests.pdf`, `receipt-non-gst-team.pdf`, `tax-invoice-late-withdrawal-fee.pdf` (rendered by the real renderer from the document model, `apps/api/src/modules/invoices/specimens.test.ts`), and `e2e-*.pdf`, `e2e-*.csv`, `e2e-*.xlsx` (downloaded by the invoices E2E run against the fake Akahu adapter). Awaiting the accountant: this record stays **pending** and the ADR stays **Proposed** until a human writes the reviewer, date and outcome here.

| Date    | Reviewer | Outcome (approved / changes required) | Required changes |
| ------- | -------- | ------------------------------------- | ---------------- |
| pending | pending  | pending                               | pending          |
