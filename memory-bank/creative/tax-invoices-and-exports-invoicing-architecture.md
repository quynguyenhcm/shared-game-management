# Architecture Decision: Tax invoice issuance, snapshot, numbering, download path and module split

**Created**: 2026-11-10
**Status**: DECIDED
**Decision Type**: Architecture
**Task**: `tax-invoices-and-exports` (Level 3), design questions 1, 2 and 7, the H2 follow-up and the H7 remainder
**Read from**: `main` at `fbfc816` (migrations `20260929000900000_payments_and_invoicing.sql`, `20261102000100000_wallet_and_billing.sql`; ADR 0004, 0007, 0011, 0020; `modules/billing/{apply-akahu-result,bill-session,engine-repo,boundaries.test}.ts`; `jobs/{registry,bootstrap,schedules}.ts`; `apps/web/src/{proxy.ts,lib/api-client.ts}`; `apps/api/{Dockerfile,tsup.config.ts}`; learned rules `db-derived-flags-and-gates`, `job-queues-pgboss`, `logging-redaction-global`, `config-composition-root`, `api-write-idempotency`). Package facts were checked on the npm registry and the GitHub advisory database on 2026-11-10.

Binding rulings, not reopened here: **H1** the team is the supplier and the platform issues as its agent (no platform GST number); **H2** a non-GST-registered team's player gets a numbered "Receipt" with no GST wording; **H7** PDF = pdfkit with an embedded TTF that covers macrons. H3-H6 and H8-H12 are defaults awaiting the accountant (AC-VERIFY-9), so the design keeps document wording and layout out of stored records.

## Context

### System Requirements
- Every PAID payment above $0.00 gets exactly one numbered document: a tax invoice when the payment's charge-time snapshot says GST-registered, otherwise a receipt (H2). Unpaid, held, processing and $0.00 payments get no document and consume no number (AC-ERROR-1, AC-ERROR-5).
- Issuance happens automatically after the PAID commit, within 30 s, through a job enqueued in the PAID transaction (AC-ASYNC-1, P5). A download before the job has run issues on demand, never with a 5xx and never twice (AC-ASYNC-1). Payments paid before the feature, or whose job died, are still issued (AC-ASYNC-3).
- Numbers are gapless and per team, survive retries, crashes and concurrency, and are never reused (AC-HAPPY-4, AC-ASYNC-2, ADR 0011).
- An issued document never changes. Supplier name, GST number, buyer name, game description, lines, amounts and date stay as they were at issue, after renames or GST changes (AC-VERIFY-4). Printed amounts are the stored `payments` columns (AC-VERIFY-1).
- The same document comes out whichever way the money arrived: Akahu, wallet deduction or a resolved hold (AC-HAPPY-5).
- Payer-only and team-admin-only downloads with uniform 404/403 and `no-store` (AC-ERROR-2, AC-VERIFY-6). OpenAPI entries pass the drift check.
- Downloads go through the web tier, because the browser never talks to the API directly (systemPatterns, Web to API).

### Technical Constraints
- **The existing machinery has to be kept or deliberately amended.** That covers `payments.invoice_number`, `invoice_issued_at`, `is_tax_invoice_issued`, the CHECK `payments_invoice_issued_consistent`, `uq_payments_team_invoice_number`, `team_invoice_counters` and `assign_invoice_number(payment_id)` (D-22). `assign_invoice_number` locks the payment `FOR UPDATE`, refuses a numbered payment with 23000 `payments_invoice_number_set_once` and bumps the counter. Today it does **not** check that the payment is PAID or above $0.00.
- `payments_guard_immutable` (D-19, D-88) freezes the fee snapshot and the number once set. It does **not** freeze `paid_at`, which the export filter and the printed "Paid on" depend on.
- ADR 0020 C-INV-1: billing never sets `is_tax_invoice_issued`. ADR 0020 section 2 and `modules/billing/boundaries.test.ts` fix the writers of `payments`. PAID is written by `engine-repo.ts` (insert, wallet case) and `apply-akahu-result.ts` (update, both the provider path and `resolveHeldIntent`). `hold-resolution.ts` writes nothing. So exactly **two transaction sites** produce PAID: `billSession` (`modules/billing/bill-session.ts`) and the apply funnel.
- `bill-session` holds `teams FOR KEY SHARE`, `game_sessions FOR UPDATE` and every wallet lock of a session in one transaction, with up to ~30 payments. The apply funnel runs one payment at a time under `payments FOR NO KEY UPDATE`. Both use `SET LOCAL lock_timeout = 5000`.
- Lock order (ADR 0020 section 1): `teams -> ... -> player_credits -> payments -> payment_attempts`. ADR 0011 adds `payment -> team counter`, says to allocate last before COMMIT, and forbids allocating for two teams in one transaction.
- COMPLETED sessions are immutable (D-75). Billing completes the session before inserting payments, so `location` and `starts_at` are already frozen when a payment exists. `teams.name` (1-100) and `users.full_name` (varchar 255) are mutable. The "late withdrawal" reason is derived from `registrations.status` (`player-repo.ts`), which the D-64 matrix still lets change.
- pg-boss 12: at-least-once delivery; `singletonKey` works only on `exclusive` or `stately` queues; handlers must be idempotent through a durable guard (learned rule `job-queues-pgboss`).
- The api image is one long-lived container for HTTP and worker (ADR 0007). `tsup` bundles only `@sgm/shared`, so third-party dependencies stay external in `node_modules`. Runtime data files beside the bundle are copied by `tsup` `onSuccess`, as `common-passwords.txt` already is.
- `apiFetch` in the web uses a 5 s timeout and parses JSON. There is no binary path yet. `proxy.ts` already marks `/payments/*` and `/teams/<id>/manage/*` as protected and `no-store`.
- There is no metrics pipeline in the api (no meter provider; telemetry is traces and pino logs).

### Non-Functional Requirements
- **P1**: numbering, set-once, "only PAID above $0.00 is numbered", snapshot immutability and "numbered implies a document exists" are enforced in Postgres.
- **P2**: no `number`, `parseFloat`, `toFixed` or `Number()` in new money code (AC-HAPPY-10 source scan). This also applies to the XLSX writer.
- **P3**: the printed issue and paid dates and the period boundaries are converted to Pacific/Auckland only at the boundary.
- **P5**: issuance is a pg-boss job enqueued in the PAID transaction. No external call happens on any download.
- **P7**: no new required environment variable. A missing font file fails the API at boot.
- 7-year retention, no delete path, RESTRICT FKs.
- An invoice renders in one request. An export of up to the row cap returns in one request, completely or not at all (AC-ERROR-4: never truncated).

## Component Analysis

### Core Components
| Component | Purpose | Responsibilities |
|-----------|---------|------------------|
| `issue_payment_document(payment_id)` (SQL, new) | The single issuer | Lock the payment; refuse unless PAID and above $0.00; return the existing document if one is already issued; read the issue-time facts; allocate the number in the payment's series (calls the amended `assign_invoice_number`); insert the immutable `payment_documents` row |
| `payment_documents` (table, new) | Issue-time snapshot | Frozen facts that are mutable elsewhere (supplier name, buyer name, game location and start, charge reason), the document kind, the printed number, issue time and `layout_version`. Append-only |
| `modules/invoices/` (API, new) | Issuance service, document model, PDF, routes | `repo.ts` (the only TS caller of the SQL issuer, plus snapshot reads), `issue.ts` (issue one, issue a team's backlog), `document.ts` (pure view model), `render-pdf.ts` (pdfkit, layout registry, fonts), `routes.ts`, `errors.ts` |
| `jobs/issue-invoices.ts` (new) | Async issuance | `enqueueInvoiceIssuance(jobs, { teamId }, { trx })`, the public helper billing calls, and the per-team handler |
| `jobs/invoice-reconcile.ts` (new) | Backfill and safety net | At boot and every 15 min, enqueues `issue-invoices` for each team that has PAID, above-$0.00, unnumbered payments |
| `modules/income-exports/` (API, new) | Income exports | Read-only repo, row shaping (algorithm lane), export and period-list routes |
| `lib/tabular/{csv,xlsx}.ts` (API platform, new) | Generic file writers | RFC 4180 CSV with formula neutralisation and a BOM; a minimal OOXML writer on `fflate` that writes decimal strings without any JS number |
| `lib/http/content-disposition.ts` (API platform, new) | Download headers | ASCII-safe `attachment; filename="..."` |
| `packages/shared/src/invoice/document.ts` (new; `invoice.ts` extended) | Isomorphic rules | `DocumentKind`, `documentKindOf(gstRegistered)`, `formatDocumentNumber(kind, n)`, `isDocumentAvailable(status, amount)`, the `PaymentDocumentRef` DTO |
| `packages/shared/src/tax/` (new; algorithm lane) | Period helpers | Financial year, GST two-month periods, custom range to `[from, to)` |
| `packages/shared/src/api/invoices.ts` (new) | Contracts | Export query (discriminated by period type), period-list response, error extras |
| `apps/web/src/lib/invoices/download.ts` (new) | Binary proxy | Bearer forwarding, header allowlist, streaming, error-to-redirect mapping |
| Web route handlers (new) | Download endpoints | `payments/[paymentId]/invoice/route.ts`, `teams/[teamId]/manage/payments/[paymentId]/invoice/route.ts`, `teams/[teamId]/manage/exports/income/route.ts` |
| `components/invoices/download-invoice-link.tsx` (new) | Reusable action | One link component used by the payment page, the wallet list, the admin table and later the player-dashboard |

### Component Interactions
```
PAID writers (billing)                          worker                              API (HTTP)                    web (Next)
bill-session txn ──┐  enqueue issue-invoices    issue-invoices:<teamId> (stately)   GET /payments/:id/invoice  <- route handler <- <a href>
apply funnel txn ──┘  {teamId} in the same txn  └─ per payment, own txn:            GET /teams/:t/payments/:id/invoice
                                                   SELECT issue_payment_document()    ├─ resolve payment by caller
invoice-reconcile (boot + */15) ── enqueue ───────▶                                   ├─ issue on demand (same SQL fn)
                                                                                      ├─ document.ts -> render-pdf.ts
                                                                                      └─ 200 application/pdf, no-store
```
- Billing depends on `jobs/issue-invoices.ts` (enqueue only), never on `modules/invoices`. `modules/invoices` reads billing tables and writes them only through the SQL function. `income-exports` reads `payments`, `payment_documents`, `payment_line_items` and the joined names, and writes nothing.
- The job and the on-demand path call the same SQL function. The payment row lock serialises them, and the second caller gets the already-issued document back.

## Options Explored

### Decision A: What is stored for an issued document

#### Option A1: Snapshot row of facts, PDF rendered on demand (`payment_documents`)
- **Description**: One immutable row per issued payment holds the facts that can change elsewhere: supplier name, buyer name, game location and start, charge reason. It also holds the document kind, the printed number string, `issued_at` and `layout_version`. Amounts, rate, GST number and lines are read from `payments` and `payment_line_items`, which are already immutable (D-19, D-20, D-88). The PDF is rendered from these on each download.
- **Pros**:
  - Wording and layout changes (H3-H6, H10-H12 are still open with the accountant) never rewrite a stored record: a new `layout_version` is added instead.
  - Rows are small (about 200 bytes), so the 7-year retention costs nothing.
  - Exports use the same snapshot, so the number and names agree with the PDF.
  - Printed money comes straight from the authoritative columns (AC-VERIFY-1); nothing is duplicated.
- **Cons**:
  - A reprint is a faithful copy only while the layout code for that `layout_version` is kept. Old layouts must stay in the code base.
  - Byte-identical re-downloads depend on pdfkit rendering deterministically (see Risk Assessment).
- **Technical Fit**: High. It follows the existing append-only snapshot pattern (`payment_line_items`, `reject_modification`).
- **Complexity**: Medium
- **Scalability**: High

#### Option A2: Store the rendered PDF bytes (`bytea`)
- **Description**: Render once at issue time and store the bytes; downloads return them.
- **Pros**:
  - Reprints are byte-identical forever, with no dependence on the renderer.
  - Downloads do no rendering work.
- **Cons**:
  - Any accountant-driven wording change means re-rendering, which rewrites stored records. That breaks the "content changes do not require rewriting stored records" requirement and fights the immutability trigger.
  - 30-60 KB per document with a font subset adds hundreds of MB over 7 years in Postgres backups.
  - The worker becomes the renderer and the on-demand path renders in the HTTP process, so the font has to work in both.
  - Exports still need the facts in queryable form, so a facts snapshot is needed anyway.
- **Technical Fit**: Low
- **Complexity**: Medium
- **Scalability**: Medium

#### Option A3: Snapshot columns on `payments`
- **Description**: Add `supplier_name_at_issue`, `buyer_name_at_issue` and the other facts to `payments`, and widen `payments_guard_immutable`.
- **Pros**:
  - No new table and no join.
- **Cons**:
  - Widens the most-written money table and its guard with nullable columns that only make sense after issue.
  - The invoices module becomes another `UPDATE payments` writer, which blurs the billing single-writer list.
  - There is no natural home for a later credit note (H5), which needs its own document row.
- **Technical Fit**: Medium
- **Complexity**: Low
- **Scalability**: High

**Chosen: A1.**

### Decision B: When and where the number is allocated

#### Option B1: Allocate inside the PAID transaction
- **Description**: `bill-session` and the apply funnel call the issuer as the last step before COMMIT.
- **Pros**:
  - A number exists exactly when PAID commits, with no window to cover.
  - No job, no on-demand path, no sweep.
- **Cons**:
  - Couples billing to invoicing. A bug or constraint failure in issuance rolls back the PAID transition or a whole session's billing, so an invoice defect would stop settlement.
  - `bill-session` would hold the team counter row for the rest of a ~30-payment transaction, and the apply funnel for the same team would wait on it within its 5 s `lock_timeout`.
  - ADR 0011's "allocate last" conflicts with `bill-session`, which enqueues emails after the inserts and would need reordering.
  - Breaks ADR 0020 C-INV-1 and widens billing's boundary tests.
- **Technical Fit**: Low
- **Complexity**: Medium
- **Scalability**: Medium

#### Option B2: Per-payment `issue-invoice` job enqueued in the PAID transaction, plus on-demand
- **Description**: One job per payment (`singletonKey = issue-invoice:<paymentId>`), plus issue-on-demand at download time.
- **Pros**:
  - Fully decoupled from billing.
  - Simple payload.
- **Cons**:
  - A 30-payment session enqueues 30 jobs that all contend for one team counter row.
  - Numbers follow job pick-up order rather than paid order.
  - Thirty enqueues inside the billing transaction.
- **Technical Fit**: High
- **Complexity**: Medium
- **Scalability**: Medium

#### Option B3: Per-team `issue-invoices` job (stately) enqueued in the PAID transaction, plus on-demand, plus a reconcile sweep
- **Description**: The PAID transaction enqueues `{ teamId }` once, with `singletonKey = issue-invoices:<teamId>` on a `stately` queue (one queued and one active per team). The handler drains that team's unissued PAID payments above $0.00 in `(paid_at, id)` order, one payment per transaction. Downloads issue on demand through the same SQL function. `invoice-reconcile` (boot and every 15 min) re-enqueues teams with leftovers (pre-feature payments, failed jobs).
- **Pros**:
  - One enqueue per billing transaction.
  - Numbers follow paid order, which is easiest for an accountant to read.
  - No contention within a team. Different teams run in parallel and never share a transaction.
  - `stately` means a PAID committed during a run queues exactly one trailing run, so nothing is missed.
  - Billing changes by one line per site.
- **Cons**:
  - Three issuance entry points (job, on-demand, sweep). They are made safe by funnelling all three through one SQL function under the payment lock.
- **Technical Fit**: High (same shape as `recurrence-rule` and `akahu-sync`)
- **Complexity**: Medium
- **Scalability**: High

#### Option B4: Sweep only, no enqueue in billing
- **Description**: A periodic sweep finds unnumbered PAID payments; billing is untouched.
- **Pros**:
  - Zero billing change.
- **Cons**:
  - The pg-boss cron granularity is one minute, so the 30 s target is missed.
  - Contradicts AC-ASYNC-1 ("enqueued in the same transaction").
- **Technical Fit**: Medium
- **Complexity**: Low
- **Scalability**: High

A database trigger that inserts into `pgboss.job` on the PAID update was also considered and rejected. It couples the schema to pg-boss internals and bypasses the runner's trace propagation.

**Chosen: B3.**

### Decision C: Receipt numbering, the `is_tax_invoice_issued` flag, and changing GST registration (H2 follow-up)

#### Option C1: One shared per-team counter for both kinds, with a prefix by kind
- **Description**: INV-000001, RCT-000002, INV-000003 and so on, drawn from one sequence.
- **Pros**:
  - No counter schema change.
- **Cons**:
  - A team that registers for GST mid-life (its older PENDING charges become receipts, newer ones tax invoices) gets a tax-invoice series with holes filled by receipts. That is hard to explain to an accountant and weakens the "gapless" claim of ADR 0011.
- **Technical Fit**: Medium
- **Complexity**: Low
- **Scalability**: High

#### Option C2: A separate gapless series per document kind per team
- **Description**: Counter key `(team_id, document_kind)`; uniqueness `(team_id, gst_registered, invoice_number)`. Tax invoices print `INV-000001`, receipts `RCT-000001`. The kind is derived from the payment's immutable charge-time `gst_registered`, so it can never disagree with the GST lines.
- **Pros**:
  - Each series is gapless on its own.
  - A team's registration changes never interleave the series.
  - A future credit-note series (H5) is one enum value away (`ALTER TYPE ... ADD VALUE`).
- **Cons**:
  - Amends ADR 0011 (counter key and unique constraint) and the existing numbering test.
- **Technical Fit**: High
- **Complexity**: Low
- **Scalability**: High

#### Option C3: Number tax invoices only; receipts carry the payment reference
- **Description**: Receipts are identified by the existing payment reference.
- **Pros**:
  - No new series.
- **Cons**:
  - Contradicts H2, which rules a *numbered* receipt.
  - `payment_reference` is random, not sequential.
- **Technical Fit**: Low
- **Complexity**: Low
- **Scalability**: High

For the flag, three treatments were weighed. Keeping `is_tax_invoice_issued` and setting it true for receipts mislabels them. Renaming it to `is_document_issued` churns generated types and names for no gain. Making it a **generated column** `(invoice_number IS NOT NULL AND gst_registered)` keeps its honest meaning and cannot drift (learned rule `db-derived-flags-and-gates`). The generated column is chosen.

**Chosen: C2**, with `is_tax_invoice_issued` as a generated column.

### Decision D: Download transport through Next

#### Option D1: Next route handler that proxies the API bytes, errors answered as a 303 back to the page
- **Description**: A GET route handler reads the `sgm_session` cookie and calls the API server-side with the bearer and the trace and internal headers (the same allowlist as `apiFetch`). On 200 it streams `upstream.body` back with an allowlisted header set and adds `cache-control: no-store` and `x-content-type-options: nosniff`. On any error it answers `303 See Other` to a validated `returnTo` page (default: the page the link lives on) with `?download_error=<code>`, and the export form also gets its own query values and `&field=<name>` back. A 401 redirects through the existing `/auth/session-expired` route. The link is a plain `<a href>` with **no** `download` attribute, so a navigation to an `attachment` response saves the file and leaves the page in place, while an error navigates back to a page that renders the sentence. The export form is a plain GET `<form>`.
- **Pros**:
  - Works without JavaScript.
  - No raw JSON body ever reaches the user.
  - Same cookie and bearer model as every other page.
  - The URL is not a capability: the session is required every time.
  - Streams, so a large file is never buffered in the web process.
- **Cons**:
  - A successful download gives the page no feedback. That is the UI lane's problem: copy such as "Your download should start", or a progressive-enhancement fetch.
  - A field error costs a full round trip of the page.
- **Technical Fit**: High (`auth/session-expired/route.ts` is the precedent)
- **Complexity**: Low
- **Scalability**: High

#### Option D2: Client `fetch()` to the route handler, Blob plus object URL
- **Description**: A client island fetches the file and triggers the save in the browser.
- **Pros**:
  - Inline states (spinner, field errors without reload).
- **Cons**:
  - Requires JavaScript.
  - The whole file is held in browser memory.
  - Blob downloads are unreliable on iOS Safari.
  - The route handler needs two error modes.
- **Technical Fit**: Medium
- **Complexity**: Medium
- **Scalability**: Medium

#### Option D3: Server Action returning bytes
- **Description**: A Server Action returns the file contents to the page.
- **Pros**:
  - None of note.
- **Cons**:
  - Server Action results are serialised through the RSC protocol, so binary must be base64-encoded and buffered, with no streaming and no `Content-Disposition`.
- **Technical Fit**: Low
- **Complexity**: Medium
- **Scalability**: Low

#### Option D4: Signed short-lived URL to the API
- **Description**: The API issues a signed URL that the browser fetches directly.
- **Pros**:
  - The web process carries no bytes.
- **Cons**:
  - The API is internal-only (`API_INTERNAL_URL`), so it would have to be exposed publicly.
  - A bearer capability in a URL leaks through history and logs.
  - A new signing secret is needed.
- **Technical Fit**: Low
- **Complexity**: High
- **Scalability**: High

**Chosen: D1.** The UI lane may layer D2 on the export form as an enhancement, provided the D1 behaviour still works without it.

### Decision E: XLSX writer (H7 remainder)

Facts checked 2026-11-10 (npm registry and GitHub advisory database):

| Candidate | Licence | Latest | Maintenance | Advisories | Money cells |
|---|---|---|---|---|---|
| `exceljs` | MIT | 4.4.0 (2023-10-19); only a 4.4.1 prerelease since (2024-12) | 667 open issues; no stable release in 3 years | Own: XSS < 1.6.0 (old). Dependency `tmp` ^0.2.0 had high advisories up to 0.2.7 (2026; resolvable within range); also depends on `archiver` 5, `unzipper` 0.10, `uuid` 8 | JS `number` |
| `write-excel-file` | MIT | 4.1.1 (2026-06-08) | Active | None | JS `number` (P2 deviation needed) |
| `xlsx` (SheetJS) on npm | Apache-2.0 | 0.18.5 | Not maintained on npm; fixes ship only from cdn.sheetjs.com | High: prototype pollution < 0.19.3, ReDoS < 0.20.2; no fixed npm version | JS `number` |
| In-house writer on `fflate` | MIT (`fflate`) | `fflate` 0.8.3 (already a dependency of pdfkit 0.20.2) | Active | `fflate` < 0.8.3: ZIP64 *unzip* loop (we only zip); fixed in 0.8.3 | Decimal string from `MoneyString`, no JS number |

#### Option E1: `exceljs`
- **Description**: The most widely used Node XLSX library, including a streaming writer.
- **Pros**:
  - Streaming writer for large sheets.
  - Rich formatting.
- **Cons**:
  - Stagnant, with a heavy dependency tree.
  - Money cells need a JS number (P2 and AC-HAPPY-10 source-scan conflict).
- **Technical Fit**: Low
- **Complexity**: Low
- **Scalability**: High

#### Option E2: `write-excel-file`
- **Description**: A small, actively maintained writer with one dependency.
- **Pros**:
  - Small, active, one dependency (`fflate`), `toBuffer()` and `toStream()`, formulas written only when typed `Formula`.
- **Cons**:
  - Numeric cells must be JS numbers, so a documented P2 deviation and an exemption from the source scan are needed.
  - It holds the whole sheet as an array in memory.
- **Technical Fit**: Medium
- **Complexity**: Low
- **Scalability**: Medium

#### Option E3: SheetJS
- **Description**: The npm `xlsx` package.
- **Pros**:
  - Feature-complete.
- **Cons**:
  - The npm package carries unfixed high advisories.
  - The supported build lives outside the registry, which needs a tarball pin.
- **Technical Fit**: Low
- **Complexity**: Low
- **Scalability**: High

#### Option E4: A minimal in-house OOXML writer on `fflate` (`lib/tabular/xlsx.ts`)
- **Description**: Write exactly the parts needed: `[Content_Types].xml`, `_rels/.rels`, `xl/workbook.xml`, `xl/_rels/workbook.xml.rels`, `xl/styles.xml` (built-in numFmt 2 `0.00` and a bold header), and `xl/worksheets/sheet1.xml` and `sheet2.xml` with inline strings (`t="inlineStr"`, so no shared-strings table). Money cells are `<c s="1"><v>20.00</v></c>`, written directly from the `MoneyString`.
- **Pros**:
  - P2 holds with no deviation.
  - No formula can ever be written (AC-INTEGRATION-3 by construction).
  - Deterministic bytes (fixed zip `mtime`), so read-back tests are stable.
  - Rows can be written incrementally into `fflate`'s streaming `Zip`.
  - Zero new transitive dependencies.
  - Reusable by admin-reporting-dashboard.
- **Cons**:
  - We own about 250 lines of OOXML. A malformed part makes Excel show a "repair" prompt. Mitigations: an independent reader in tests (`read-excel-file`, MIT, 9.3.14, no advisories) and opening the Phase 5 specimen in Excel and LibreOffice before AC-VERIFY-9.
- **Technical Fit**: High
- **Complexity**: Medium
- **Scalability**: High

**Chosen: E4.**

**CSV**: UTF-8 **with** a byte-order mark, CRLF line endings, RFC 4180 quoting, and the formula-injection neutralisation from AC-VERIFY-5 (algorithm lane owns the exact rule). Rationale: the CSV's audience is a team admin opening it in Excel or Google Sheets. Excel for Windows garbles macrons without the BOM, Sheets ignores it, and accounting-software import formats are out of scope. The XLSX remains the recommended Excel path.

**PDF font**: **Noto Sans** Regular and Bold, static TTF, SIL Open Font License 1.1 (embedding and subsetting permitted; the licence text ships beside the files). It covers Latin Extended-A (ā ē ī ō ū and capitals), and AC-INTEGRATION-1 proves that in extracted text. Files: `apps/api/src/modules/invoices/fonts/NotoSans-Regular.ttf`, `NotoSans-Bold.ttf`, `OFL.txt`, with the source URL and SHA-256 of each recorded in ADR 0021. `tsup.config.ts` `onSuccess` copies them to `dist/fonts/`, following the `common-passwords.txt` precedent, so the **Dockerfile is unchanged** (it already copies `dist`). The renderer resolves them with `new URL('./fonts/…', import.meta.url)`, which works both under `tsx` (source) and from the bundle. `buildApp` loads both fonts once at boot and throws if either is missing (P7 fail-fast). The worker does not render. pdfkit 0.20.2: MIT, released 2026-08-30, no advisories, and neither has its `fontkit` dependency.

**Test-only dependencies**: `unpdf` (MIT, 2.1.0) for PDF text extraction and `read-excel-file` (MIT) as the independent XLSX reader. Both are devDependencies.

### Decision F: Module split and API surface

#### Option F1: One `modules/invoices` holding issuance, PDF and exports
- **Description**: A single module for everything in this feature.
- **Pros**:
  - Fewer folders.
- **Cons**:
  - Mixes a writer (issuance) with a pure reader (exports).
  - The read-only guarantee of exports becomes a per-file rule instead of a per-module rule.
- **Technical Fit**: Medium
- **Complexity**: Low
- **Scalability**: Medium

#### Option F2: `modules/invoices` (writes via SQL) + `modules/income-exports` (read-only) + generic writers in `lib/tabular/` + shared rules in `packages/shared/src/{invoice,tax}/`
- **Description**: Split by writer versus reader, with generic file writers as platform code.
- **Pros**:
  - Clean boundary tests: one module writes nothing at all.
  - The generic writers serve admin-reporting-dashboard.
  - Period helpers are isomorphic.
- **Cons**:
  - More paths for the coverage include list.
- **Technical Fit**: High (matches `billing` / `wallet` and `lib/akahu`)
- **Complexity**: Low
- **Scalability**: High

**Chosen: F2.**

## Evaluation Matrix

Scores: 5 = best.

| Criteria | A1 snapshot + render | A2 stored bytes | A3 columns on payments |
|---|---|---|---|
| Scalability | 5 | 3 | 5 |
| Maintainability (wording changes) | 5 | 1 | 3 |
| Performance | 4 (render ~tens of ms) | 5 | 4 |
| Security / integrity | 5 | 4 | 4 |
| Observability | 4 | 4 | 4 |
| Implementation cost | 4 | 3 | 4 |

| Criteria | B1 in-txn | B2 per-payment job | B3 per-team job + on-demand + sweep | B4 sweep only |
|---|---|---|---|---|
| Scalability | 2 | 3 | 5 | 4 |
| Maintainability (billing coupling) | 1 | 4 | 5 | 5 |
| Performance (30 s target) | 5 | 4 | 5 | 2 |
| Security / integrity | 3 | 4 | 5 | 4 |
| Observability | 3 | 4 | 4 | 3 |
| Implementation cost | 3 | 4 | 3 | 5 |

| Criteria | D1 route handler + 303 | D2 fetch/Blob | D3 Server Action | D4 signed URL |
|---|---|---|---|---|
| Works without JS / a11y | 5 | 2 | 3 | 5 |
| Security | 5 | 5 | 4 | 2 |
| Performance (large export) | 5 | 3 | 1 | 5 |
| Implementation cost | 4 | 3 | 2 | 1 |

| Criteria | E1 exceljs | E2 write-excel-file | E3 SheetJS | E4 in-house on fflate |
|---|---|---|---|---|
| Supply-chain risk | 2 | 4 | 1 | 5 |
| P2 compliance | 1 | 1 | 1 | 5 |
| Maintainability | 3 | 4 | 2 | 3 |
| Implementation cost | 5 | 5 | 4 | 3 |

## Observability Architecture

### Logging
- **Library**: the existing pino logger (`lib/logger`), injected. No `console`; the boundary scan is extended to `modules/invoices`, `modules/income-exports`, `lib/tabular` and the two new jobs.
- **Format**: structured JSON with `traceId`, `spanId`, `service`, `version`.
- **Events** (ids, kinds and counts only; no names, amounts, GST numbers, emails or file names. Field names checked against the global redaction keys first: avoid `code` (use `errorCode`) and any `*token` or `*number` pattern collisions; log `documentKind`, never `invoiceNumber`):
  - `invoice.issued` `{ paymentId, teamId, documentKind, trigger: 'job' | 'on_demand' }` (logged after COMMIT).
  - `invoice.issue.skipped` `{ paymentId, reason: 'not_paid' | 'zero_amount' | 'already_issued' }`.
  - `invoice.issue.failed` `{ paymentId, teamId, errorClass, sqlstate }`.
  - `invoice.run.completed` `{ teamId, issued, skipped, failed }`.
  - `invoice.reconcile.enqueued` `{ teams }`.
  - `invoice.downloaded` `{ paymentId, actorRole: 'payer' | 'team_admin', documentKind, issuedOnDemand }`.
  - `income_export.generated` `{ teamId, periodType, format, rows }`.
  - `income_export.refused` `{ teamId, reason }`.
- **Configuration**: `LOG_LEVEL`, `LOG_FORMAT`, `LOG_OUTPUT`, `LOG_FILE_PATH` as today.

### Distributed Tracing
- **SDK**: OpenTelemetry (existing).
- **Propagation**: W3C Trace Context.
- **Service Boundaries**:

| From | To | Protocol | Propagation Method |
|------|-----|----------|-------------------|
| Browser | web route handler | HTTP | incoming `traceparent` if any, else new root (`traceHeaders`) |
| web route handler | API invoice/export route | HTTP | `traceparent` header (same builder as `apiFetch`) |
| billing PAID transaction | `issue-invoices` job | pg-boss | trace meta injected by `runner.enqueue` (`injectTraceMeta`) |
| `invoice-reconcile` | `issue-invoices` job | pg-boss | same |
| worker handler | Postgres | SQL | consumer span `"issue-invoices process"` around the handler |

- **Custom spans**: `invoice.issue` (one per payment transaction), `invoice.render_pdf`, `income_export.generate` (attributes: format, row count).
- **Sampling**: `OTEL_TRACES_SAMPLER_ARG` (unchanged).

### Metrics
- **Standard metrics**: none are added. The api has no meter provider today, so adding one is out of scope. Operators read the job state in `pgboss.job` (failed `issue-invoices` jobs stay visible after retries) and the events above. If a metrics pipeline is added later, the natural counters are `invoices_issued_total{document_kind, trigger}` and `income_exports_total{format, outcome}`, both with low-cardinality labels and no team or user ids.

### Configuration Variables
| Variable | Purpose | Default |
|----------|---------|---------|
| LOG_LEVEL | Log verbosity | info |
| LOG_FORMAT | Output format | json |
| OTEL_EXPORTER_OTLP_ENDPOINT | Collector endpoint | - |
| OTEL_SERVICE_NAME | Service identifier | - |
| OTEL_TRACES_SAMPLER_ARG | Sampling ratio | 1.0 (dev) |
| `INCOME_EXPORT_MAX_ROWS` | Row cap (algorithm lane sets the value and validation) | algorithm lane |

No new variable comes from this lane. Font paths are code-relative constants, and the download timeout is a named constant beside `AUTH_TIMEOUT_MS`.

## Decision

**Chosen**: A1 + B3 + C2 + D1 + E4 + F2. In one sentence: one SQL function `issue_payment_document` issues a numbered, immutable `payment_documents` snapshot in a per-kind gapless series. It is driven by a per-team `issue-invoices` job enqueued in the PAID transaction, by issue-on-demand at download and by a reconcile sweep. PDFs are rendered on demand with pdfkit and Noto Sans from the snapshot plus the immutable payment columns, and are served through Next route handlers that stream the bytes and turn errors into a redirect back to the page.

### 1. Schema (migration `db/migrations/20261110000100000_tax_invoices.sql`)
1. `CREATE TYPE payment_document_kind AS ENUM ('TAX_INVOICE', 'RECEIPT')`. A future `CREDIT_NOTE` is an `ADD VALUE` (H5 extension point; not built).
2. **`team_invoice_counters`**: add `document_kind payment_document_kind NOT NULL DEFAULT 'TAX_INVOICE'` (existing rows are tax-invoice series), then make the primary key `(team_id, document_kind)`.
3. **`payments`**:
   - Drop `is_tax_invoice_issued` (which drops `payments_invoice_issued_consistent`) and re-add it as `boolean NOT NULL GENERATED ALWAYS AS (invoice_number IS NOT NULL AND gst_registered) STORED`.
   - Add the CHECK `payments_invoice_stamp_pair`: `(invoice_number IS NULL) = (invoice_issued_at IS NULL)`.
   - Add the CHECK `payments_invoice_requires_paid`: `invoice_number IS NULL OR (status = 'PAID' AND amount > 0.00)`. PAID is terminal (D-87), so this cannot become false later.
   - Replace `uq_payments_team_invoice_number` with `uq_payments_team_series_number UNIQUE (team_id, gst_registered, invoice_number)`. The series discriminator is the immutable `gst_registered`; `payment_document_kind_of(gst_registered)` names the mapping.
4. **`payments_guard_immutable`** additionally freezes `paid_at` once it is set (`OLD.paid_at IS NOT NULL AND NEW.paid_at IS DISTINCT FROM OLD.paid_at`). The printed "Paid on" and the export period both depend on it, and a moved `paid_at` would shift income between already-filed GST periods. No current code rewrites it: the apply funnel sets it once under `status IN ('PENDING', 'OVERDUE')`.
5. **`payment_documents`**:

   | column | type | note |
   |---|---|---|
   | `payment_id` | uuid PRIMARY KEY REFERENCES payments ON DELETE RESTRICT | one document per payment |
   | `document_kind` | payment_document_kind NOT NULL | equals `payment_document_kind_of(payments.gst_registered)` (insert guard) |
   | `number_display` | varchar(20) NOT NULL | the printed number frozen at issue (`INV-000001` / `RCT-000001`); CHECK `^(INV\|RCT)-[0-9]{6,}$` and prefix matches kind |
   | `issued_at` | timestamptz NOT NULL | equals `payments.invoice_issued_at` |
   | `supplier_name` | varchar(100) NOT NULL | `teams.name` at issue (H1: the team is the supplier) |
   | `buyer_name` | varchar(255) NOT NULL | `users.full_name` of the payer at issue |
   | `session_location` | varchar(255) NOT NULL | copied although D-75 freezes it: defence against a later relaxation of D-75 |
   | `session_starts_at` | timestamptz NOT NULL | same |
   | `charge_reason` | varchar(16) NOT NULL CHECK IN ('GAME_FEE', 'LATE_WITHDRAWAL') | derived at issue from the registration (WITHDRAWN means a late fee), which the D-64 matrix can still change |
   | `layout_version` | smallint NOT NULL DEFAULT 1 CHECK (>= 1) | the renderer layout this document is printed with |
   | `created_at` | timestamptz NOT NULL DEFAULT now() | |

   - Not copied, because each is immutable already: amount, subtotal, GST, rate, `gst_number`, `billing_type` and `paid_at` (all on `payments`), and the lines (`payment_line_items`, append-only).
   - Guest display names are never printed. They are mutable, and the UI lane labels guest lines "Guest 1" and "Guest 2".
   - Triggers: `payment_documents_append_only BEFORE UPDATE OR DELETE` reuses `reject_modification()`. `payment_documents_guard_insert BEFORE INSERT` checks that the payment carries a number, that the kind matches `gst_registered`, that `number_display = formatDocumentNumber(kind, invoice_number)` (SQL twin `format_document_number`) and that `issued_at = invoice_issued_at` (23514 `payment_documents_matches_payment`).
6. **Deferred consistency**: `CONSTRAINT TRIGGER payment_documents_required AFTER UPDATE OF invoice_number ON payments DEFERRABLE INITIALLY DEFERRED` raises 23514 `payment_documents_required` at COMMIT when a numbered payment has no document. Allocating without issuing therefore cannot commit.
7. **`assign_invoice_number(payment_id)`** (amended in place; CREATE OR REPLACE, signature unchanged):
   - Locks the payment `FOR NO KEY UPDATE` (no key changes; lighter than `FOR UPDATE`).
   - Refuses unless PAID and above $0.00 (23514 `payments_invoice_requires_paid`, so the CHECK and the function report the same name).
   - Keeps the set-once refusal.
   - Upserts the counter on `(team_id, payment_document_kind_of(gst_registered))`.
   - No longer writes `is_tax_invoice_issued`, which is now generated.
8. **`issue_payment_document(p_payment_id uuid)`** RETURNS `(number_display text, issued boolean)`; plpgsql, the only issuer:
   1. `SELECT ... FROM payments WHERE id = $1 FOR NO KEY UPDATE`. Not found raises P0002.
   2. If a document already exists, return it with `issued = false` (idempotent; this is where the losing racer lands).
   3. If not PAID or the amount is 0.00, raise 23514 `payments_invoice_requires_paid`. The TS service checks first and maps this to 409; the SQL is the backstop.
   4. Read the facts with plain reads, no locks: `teams.name`, `users.full_name`, the session's location and start, and the registration status (for the charge reason).
   5. `v_n := assign_invoice_number(p_payment_id)`, which locks the counter row. This is the allocation, and from here on only two cheap statements run before the caller commits.
   6. `INSERT INTO payment_documents ...` and return it with `issued = true`.

   Lock order: payment row, then counter row, then the FK `KEY SHARE` on `teams` and `payments` from the inserts. The `teams` key share inverts the canonical order in the same benign way ADR 0020 section 1 records for billing. `KEY SHARE` conflicts only with `teams FOR UPDATE` (banking removal), and removal never locks a payment, so no cycle can form.
9. Index `idx_payments_unissued ON payments (team_id, paid_at, id) WHERE status = 'PAID' AND invoice_number IS NULL AND amount > 0.00` serves the job's drain query and the sweep. Exports keep using `idx_payments_team_paid_status`.
10. The down migration reverses everything: it restores the plain column and the D-22 CHECK and unique constraint (the column is recomputed as `invoice_number IS NOT NULL`, the old meaning), the old function bodies and the old guard. If receipt numbers exist, the restored `(team_id, invoice_number)` uniqueness can fail; the migration says so in a comment, as D-53 does for its own irreversibility. No production row can exist before Akahu goes live (see Risk Assessment).

### 2. Issuance flow
- **Enqueue site 1, `bill-session`**: after the per-registration loop, if any payment inserted in this transaction is PAID with an amount above 0.00 (the `PREPAID_CREDIT` branch), call `enqueueInvoiceIssuance(deps.jobs, { teamId }, { trx })` once.
- **Enqueue site 2, the apply funnel**: in `applyToAttempt`, inside the `APPLY` branch that moves the payment to PAID (covering both the provider trigger and `resolveHeldIntent`), call `enqueueInvoiceIssuance(..., { trx })`. The team id comes from the payment row it already locks (add `team_id` to that select).
- The `$0.00` B7 rows are PAID but never enqueue; the job and the sweep filter `amount > 0` as well.
- **Queue `issue-invoices`**: policy `stately`, `singletonKey = issue-invoices:<teamId>`, payload `{ teamId }` validated with zod, defaults retry 3 with backoff. Handler:
  1. Repeat until done or the per-run limit (500 payments, after which the handler re-enqueues itself without `trx`): select the next unissued PAID payment above 0.00 of the team in `(paid_at, id)` order, skipping ids that failed in this run, then issue it in its own transaction (`SET LOCAL lock_timeout = '5s'`; `SELECT * FROM issue_payment_document($1)`; COMMIT).
  2. SQLSTATE class 23 for one payment: log `invoice.issue.failed`, add it to the skip set, continue with the rest.
  3. Transient error (connection loss, `55P03` lock timeout): rethrow, so pg-boss retries the run.
  4. At the end, if any payment failed, throw `NonRetryableJobError` so the run stays visible as `failed` (AC-ASYNC-3). The others are already committed.
- **Queue `invoice-reconcile`**: policy `exclusive`, interval slot `*/15 * * * *` (`intervalSweep: true`, which the DST guard exempts), also queued at worker boot (`enqueueBootSweeps`). It selects the distinct `team_id` values from `idx_payments_unissued` and enqueues `issue-invoices` per team. It takes no lock and is the backfill for payments paid before this feature (AC-ASYNC-3). No migration-time backfill is done.
- **On demand** (both download routes): resolve the payment for the caller. If it is not available, answer 409 `invoice_not_available`. If it is unissued, issue in the request with the same SQL function; on `55P03` retry once, then answer 409 `invoice_pending` ("Your invoice is being prepared. Try again in a moment."). Then render. Issuance is idempotent and is exactly what the job would do, so a GET that issues is safe to replay. A cross-site `<img>` on the URL can only issue the victim's own document early.
- **Numbers follow issue order**: normally paid order, with on-demand calls able to jump the queue. `invoice_issued_at` is the issue time (`now()` of the issuing transaction); the paid date is printed separately (H12 default).
- **GST registration over time**: the document kind and the printed GST number come only from the payment's charge-time snapshot (`gst_registered`, `gst_number`, D-88). The supplier *name* is taken at issue. A team that changed registration between charge and issue still gets the document that matches the charge. Whether that is the right tax point is H12, for the accountant.

### 3. Rendering and wording isolation
- `document.ts` (pure) builds the view model from the snapshot, the payment's immutable columns and the lines. It does no I/O and has no clock; it prints the dates in Pacific/Auckland (P3) through shared `formatNzDate`.
- `render-pdf.ts` holds `LAYOUTS: Record<number, (doc, model) => void>`, with only layout 1 at launch. It sets pdfkit `info` (`CreationDate` and `ModDate` = `issued_at`, fixed Title, Producer, Author) so the output depends only on the model.
- **Layout versioning rule (ADR 0021)**: until the first production document exists, layout 1 is edited in place (the accountant's AC-VERIFY-9 changes land here). After that, any change to printed output adds layout N+1, and new documents take the latest version (`issue_payment_document` writes the current constant passed from TS, or the column default bumped by migration). Old documents keep rendering with their own layout, so a reprint is a true copy. All wording (title, "includes GST", "issued on behalf of" if the accountant wants it, H1) lives in the layout, never in a stored row.
- PDF layout and typography belong to the UI lane. Assumption for that lane: the model gives it the kind, number, dates, supplier name and GST number (registered only), buyer name, game location and date, charge reason, lines (position, basis, unit fee), subtotal, GST, total and billing type. It never gets an email address, bank detail, Akahu id or payment reference.

### 4. API surface (OpenAPI, `apps/api/openapi.yaml`)
| Method and path | Policy | operationId | Success | Errors |
|---|---|---|---|---|
| `GET /payments/:paymentId/invoice` | `authenticated()`; payment resolved by `(id, user_id)` | `downloadMyPaymentDocument` | 200 `application/pdf` | 404 `not_found` (uniform), 409 `invoice_not_available`, 409 `invoice_pending`, 401 |
| `GET /teams/:teamId/payments/:paymentId/invoice` | `requireTeamRole('TEAM_ADMIN')`, `allowGlobalAdmin` **off** (see open question 2); payment resolved by `(id, team_id)` | `downloadTeamPaymentDocument` | 200 `application/pdf` | 403, 404 `not_found`, 409 as above |
| `GET /teams/:teamId/exports/income` | `requireTeamRole('TEAM_ADMIN')`, `allowGlobalAdmin` off (H9) | `exportTeamIncome` | 200 `text/csv; charset=utf-8` or `application/vnd.openxmlformats-officedocument.spreadsheetml.sheet` | 403, 422 `validation_failed` with `fieldErrors`, 422 `export_too_large` |
| `GET /teams/:teamId/exports/income/periods` | same | `listIncomeExportPeriods` | 200 JSON: financial years with PAID payments plus the current year, and the earliest paid date | 403 |

- Every answer, errors included, carries `cache-control: no-store`. Binary answers also carry `x-content-type-options: nosniff`, an exact `content-length` and a `content-disposition` built by `lib/http/content-disposition.ts`: `attachment; filename="<ascii>"` with ASCII-only names.
  - Invoices: `tax-invoice-INV-000001.pdf` and `receipt-RCT-000001.pdf`.
  - Exports: `income-<team-slug>-<from>-to-<to>.<csv|xlsx>`. The slug is NFKD with diacritics stripped (Hōkio becomes `hokio`), `[a-z0-9-]`, at most 40 characters.
- The export query is a strict zod discriminated union on `period` (`CUSTOM` with `from`/`to`; `GST_PERIOD` and `FINANCIAL_YEAR` with the parameters the algorithm lane defines). The **server** resolves presets with the shared `tax/` helpers, so it owns one range semantics, the period label for the Summary sheet and file name, and the "unknown financial year" refusal.
- Exports are **atomic**: validation and the row-count check (`export_too_large`) run before any byte is sent. The file is built from a paged read into a writer buffer (rows are never held as objects all at once) and sent with `content-length`. No partial file is ever served. Streaming the response is deferred: it would need a mid-stream failure mode.
- Binary responses use a 200 response schema declared for OpenAPI only (`type: string, format: binary`) and `reply.type(...).send(buffer)`. They bypass the zod serializer, while the error responses keep their shared schema. The build must make sure `fastify-type-provider-zod` does not try to serialize the buffer.
- New `ErrorCode` entries: `invoice_not_available`, `invoice_pending`, `export_too_large`.
- **Shared contract with player-dashboard** (design question 7): `PaymentResponse.payment`, `MyPaymentRow` and the admin `AdminPaymentsResponse` row each gain
  ```ts
  document: { kind: 'TAX_INVOICE' | 'RECEIPT'; available: boolean; number: string | null }
  ```
  (`PaymentDocumentRef` in `packages/shared/src/api/invoices.ts`). The spec's names map as `invoiceAvailable` = `document.available` (PAID and above $0.00, whether issued or not, because on-demand covers the gap) and `invoiceNumber` = `document.number` (the frozen `number_display` once issued, else null). `kind` drives the "Download tax invoice" or "Download receipt" label. The billing read repos left-join `payment_documents` (a read; billing still writes nothing new) and compute `available` with the shared `isDocumentAvailable(status, amount)`, which the API's 409 path uses too. No polling is required: the button works whenever `available` is true, and the number is shown once present.

### 5. Web (Next)
- `apps/web/src/lib/invoices/download.ts`: `proxyDownload({ apiPath, request, returnTo, errorTarget })`.
  - Builds headers with the same allowlist and trace logic as `apiFetch` (refactor the header builder out of `apiFetch` rather than copying it).
  - Uses the bearer from `sgm_session` and a 30 s `AbortSignal.timeout` (named constant).
  - On 200, forwards only `content-type` (one of the three allowed), `content-disposition` (must start with `attachment;`), `content-length`, and sets `cache-control: no-store` and `x-content-type-options: nosniff`.
  - On a 4xx or 5xx JSON error, redirects 303 to `errorTarget` with `download_error=<code>`, plus the field name for 422. A 401 or `session_expired` goes to `/auth/session-expired?returnTo=...`. A network failure or timeout goes to `download_error=service_unavailable`.
  - `returnTo` is checked with the shared `safeReturnTo`. It never echoes a payer name, amount or file name into a URL.
- Route handlers (each `export const dynamic = 'force-dynamic'`):
  - `app/payments/[paymentId]/invoice/route.ts`: default target `/payments/<id>`; the wallet list passes `returnTo=/teams/<id>/wallet`.
  - `app/teams/[teamId]/manage/payments/[paymentId]/invoice/route.ts`: default target `/teams/<id>/manage/payments`.
  - `app/teams/[teamId]/manage/exports/income/route.ts`: target `/teams/<id>/manage/exports` with the submitted query preserved, so the form re-renders with the entered values and the field error (AC-ERROR-3).
- `proxy.ts` needs no change: both prefixes are already protected and `no-store`.
- `components/invoices/download-invoice-link.tsx` takes `{ href, document }`, and `lib/invoices/paths.ts` provides `myDocumentPath(paymentId, returnTo?)` and `teamDocumentPath(teamId, paymentId)`. The player-dashboard "Payments & Wallet" tab reuses exactly these two plus `MyPaymentRow.document`, with no new route.
- Assumptions for the UI and journey lanes: links are plain anchors without the `download` attribute, the export form is a GET form, error sentences come from the `download_error` code, and any JavaScript enhancement must leave this behaviour intact.

### 6. Boundaries (structural tests)
- **`modules/invoices/boundaries.test.ts`** (new):
  - No TypeScript source writes `payment_documents` or `team_invoice_counters`. Only `modules/invoices/repo.ts` contains `issue_payment_document(`, and no source contains `assign_invoice_number(`.
  - `modules/income-exports/**` and `lib/tabular/**` write no table.
  - `modules/invoices` and `modules/income-exports` reach other modules only through their public files.
  - Each rule is proven to detect a violation.
- **`modules/billing/boundaries.test.ts`**: add `'../../jobs/issue-invoices.ts'` to `PUBLIC`. The `payments` writers list is **unchanged** (the invoices module never writes `payments` from TS), and so is "PAID only by the apply funnel".
- **`modules/registrations/boundaries.test.ts`**: add `payment_documents` to its money-table pattern.
- The money source scan (no `parseFloat`, `toFixed`, `Number(`, `Math.`; no money field typed `number`; no `console`) is extended to the new modules, `lib/tabular` and the two jobs.
- The coverage include list gains `packages/shared/src/tax/**`, `modules/invoices`, `modules/income-exports`, `lib/tabular`, and the jobs `issue-invoices` and `invoice-reconcile`. `packages/shared/src/invoice/**` is already in it.

### Rationale
- **A1** is the only option that satisfies both "an issued document never changes" (frozen facts, append-only, a per-document layout version) and "wording changes do not rewrite stored records". It also gives exports the same frozen names and numbers as the PDF.
- **B3** keeps an invoice defect from ever blocking settlement (ADR 0020 C-INV-1 stays true: billing still never sets the flag and only enqueues). It meets the 30 s target, numbers payments in paid order and keeps each team's allocations serial, with the transaction scope ADR 0011 asks for. The single SQL issuer makes the job, on-demand and sweep paths equivalent, and the database proves it.
- **C2** keeps every printed series gapless however a team's GST status moves, and leaves a clean slot for credit notes. The generated flag keeps `is_tax_invoice_issued` meaning what its name says.
- **D1** is the only option that works without JavaScript, never shows raw JSON and streams.
- **E4** is the only XLSX option that needs neither a P2 deviation nor a stagnant or advisory-laden dependency.

### Trade-offs Accepted
- **Layout code is kept forever** after go-live (one function per layout version). That is acceptable: layouts are small, and the alternative is re-rendering stored records.
- **A GET can write.** Issuance on demand is idempotent and equal to the job's work; it is recorded in ADR 0021.
- **We own an OOXML writer.** It is bounded to the features we use and verified by an independent reader plus a manual open of the specimen.
- **Numbers are in issue order, not strictly paid order**, when an on-demand download jumps the job. ADR 0011 promises gapless and unique, not paid-order, numbers.
- **ADR 0011 is amended**: series per kind, the generated flag, and the PAID-and-above-$0.00 requirement in SQL. ADR 0021 states this, and ADR 0011 gets a "superseded in part by ADR 0021" note.

### Guiding Principles check
- **P1**: PAID and above $0.00, set-once, per-series uniqueness, snapshot immutability, kind-to-snapshot agreement, "numbered implies a document" and the frozen `paid_at` are all in Postgres. TypeScript only shapes the 409s.
- **P2**: printed amounts come from `numeric` columns as `MoneyString`, and XLSX cells are written from decimal strings. No float anywhere in our code. Excel's own parsing of `<v>20.00</v>` is outside the system boundary.
- **P3**: `issued_at` and `paid_at` are stored UTC and formatted for Pacific/Auckland at render and export time.
- **P4**: no banking or credential column is read.
- **P5**: issuance is enqueued in the PAID transaction. The sweep is a job, and nothing runs outside the queue.
- **P6**: no new root scripts.
- **P7**: no new environment variable; missing font files fail the API at boot.

No principle is overridden.

## Implementation Guidelines

1. Write the migration first, with an upgrade test seeded with the old shapes:
   - A numbered PENDING payment (made possible by the old `assign_invoice_number`) is cleaned by the migration: its number is cleared, a NOTICE reports the count, and no production row exists.
   - The constraints are then added `NOT VALID` and validated (learned rule `db-derived-flags-and-gates`).
2. Update `apps/api/test/integration/invoice-number.int.test.ts` and the factory used there (`insertBilledRegistration`). The numbered payments must be PAID and above $0.00 (add a factory option rather than weakening the test), and the test must cover both series.
3. Keep `invoice-number.int.test.ts` as the function-level proof and add `invoice-issuance.int.test.ts` for the races. Order the races with `waitForLockWaiters`:
   - the job and on-demand on one payment;
   - two payments of one team;
   - two teams in parallel;
   - a crash between allocation and COMMIT (`pg_terminate_backend` on the issuing backend) leaving the counter unchanged.
4. The billing enqueue is one call per site, each with an integration test that a committed PAID enqueues exactly one `issue-invoices:<teamId>` job and that a rolled-back one enqueues none.
5. `render-pdf.test.ts`: two renders of one model are byte-identical (determinism) and parse with `unpdf` to the expected text, macrons included. The layout registry rejects an unknown version.
6. Never log a name, amount, GST number, document number or file name (redaction-collision check first).
7. ADR 0021 ships in Phase 1 with Status "Proposed (provisional until AC-VERIFY-9)" and is updated per phase.

### Plan changes (how this reshapes the Implementation Roadmap)
**Phase 1 (shared, contracts, schema).** Changed scope:
- the migration exactly as in Decision 1;
- `packages/shared/src/invoice/document.ts` (kind, `formatDocumentNumber`, `isDocumentAvailable`; `formatInvoiceNumber` kept as a wrapper);
- `PaymentDocumentRef` and the export query schemas in `packages/shared/src/api/invoices.ts`, and the new `ErrorCode` entries;
- `gstOfInclusive` and the period helpers (algorithm lane);
- the invoices boundary test (schema-level rules) and the registrations and billing boundary edits;
- the numbering test and factory update;
- ledger rows D-99 to D-105 and the ADR 0021 draft.

The `document` field is **not** added to the billing DTOs yet (Phase 3).

**Phase 2 (issuance).**
- `modules/invoices/{repo,issue}.ts`;
- `jobs/issue-invoices.ts` and `jobs/invoice-reconcile.ts`, plus the `registry.ts`, `bootstrap.ts` (`registerJobs`, `enqueueBootSweeps`) and `schedules.ts` entries;
- the two billing enqueue sites;
- `invoice-issuance.int.test.ts` and the extended `registry` and `handlers` tests.

On-demand issuance is implemented here as a service function (`issueOnDemand`) and tested at service level; the routes come in Phase 3.

**Phase 3 (documents and downloads).**
- `modules/invoices/{document,render-pdf,routes,errors}.ts`;
- the fonts with `tsup` copy and boot check;
- `lib/http/content-disposition.ts`;
- the `document` field on `PaymentResponse`, `MyPaymentRow` and the admin row (billing read repos left-join `payment_documents`);
- the web `lib/invoices/{download,paths}.ts`, two route handlers, `download-invoice-link.tsx` and the page wiring;
- OpenAPI for both invoice routes.

**Phase 4 (exports).**
- `lib/tabular/{csv,xlsx}.ts` (generic writers) and `modules/income-exports/{repo,rows,service,routes}.ts`;
- the periods route;
- the web export route handler, page and form;
- OpenAPI.

**Phase 5**: unchanged.

**File list changes against the plan:**
- **Moved**: `apps/api/assets/fonts/<font>.ttf` becomes `apps/api/src/modules/invoices/fonts/{NotoSans-Regular.ttf,NotoSans-Bold.ttf,OFL.txt}`, with `apps/api/tsup.config.ts` extended. The Dockerfile is unchanged.
- **Moved**: `apps/api/src/modules/income-exports/{csv,xlsx}.ts` become `apps/api/src/lib/tabular/{csv,xlsx}.ts` (generic). The module keeps `rows.ts` (algorithm lane), `repo.ts`, `service.ts` and `routes.ts`.
- **Added**:
  - `packages/shared/src/invoice/document.ts`
  - `apps/api/src/jobs/invoice-reconcile.ts`
  - `apps/api/src/lib/http/content-disposition.ts`
  - `apps/api/src/modules/invoices/boundaries.test.ts`
  - `apps/web/src/lib/invoices/paths.ts`
  - `apps/api/test/integration/invoice-number.int.test.ts` changes (both series)
- **Renamed**: `apps/api/src/jobs/issue-invoice.ts` becomes `apps/api/src/jobs/issue-invoices.ts` (per-team queue name `issue-invoices`).
- **Dependencies**:
  - `apps/api`: `pdfkit@^0.20.2`, `fflate@^0.8.3`; dev `@types/pdfkit`, `unpdf`, `read-excel-file`. **No `exceljs`, `xlsx` or `write-excel-file`.**
  - `apps/web`: none.

## Validation Checklist

- [x] Meets all system requirements: issuance (AC-ASYNC-1..3), numbering (AC-HAPPY-4), kinds (AC-HAPPY-3), route independence (AC-HAPPY-5: issuance reads no attempt, ledger or Akahu row), immutability (AC-VERIFY-4), stored amounts (AC-VERIFY-1), auth (AC-ERROR-2, AC-VERIFY-6), single writer (AC-VERIFY-7), real PDF with macrons (AC-INTEGRATION-1)
- [x] Respects technical constraints: billing's writer lists unchanged; lock order payment, then counter; one team per transaction
- [x] Addresses non-functional requirements: P1-P7, retention, atomic exports
- [x] Technically feasible: every library checked on 2026-11-10; the font is OFL
- [x] Risks identified and acceptable
- [x] Complies with Guiding Principles in systemPatterns.md (no deviation)
- [x] Respects established patterns: snapshot plus append-only, SQL-backed gates, transactional enqueue, stately per-key queues, boot and interval sweeps, route-handler precedent, `tsup` asset copy
- [x] Observability architecture defined
- [x] Trace context propagation across all service boundaries
- [x] Logging strategy consistent with observability-requirements.md
- [x] Metrics strategy follows naming conventions (none added; future names given)

## Risk Assessment

| Risk | Likelihood | Impact | Mitigation |
|------|------------|--------|------------|
| pdfkit output is not byte-deterministic (subset tags, `/ID`), which breaks AC-HAPPY-4 "byte-identical" | M | L | Fix `info` dates from `issued_at`. A Phase 3 test renders twice and compares bytes. If pdfkit still varies, compare extracted text plus a hash of the view model, and amend AC-HAPPY-4 wording through the human (the stored snapshot, not the bytes, is the record) |
| The in-house XLSX writer produces a file Excel "repairs" | M | M | Read-back with `read-excel-file`; open the Phase 5 specimen in Excel and LibreOffice before AC-VERIFY-9; minimal part set; XML escaping and control-character stripping unit-tested |
| The migration's CHECK `payments_invoice_requires_paid` fails on dev or test rows numbered while PENDING by the old function | H (dev only) | L | The migration clears such numbers first, with a NOTICE count, plus an upgrade test. No production payment exists before Akahu goes live (Phase 4b gated), so no real number is ever cleared |
| A permanently failing payment (e.g. a CHECK on a snapshot field) is retried by every 15-minute sweep | L | L | The job skips it within the run and ends `failed` (visible); the event carries the SQLSTATE; the sweep only enqueues. Snapshot column widths equal their source columns, so a length failure cannot happen |
| On-demand issuance waits on a team's job transaction | L | L | The issuer's critical section is two statements; one retry, then 409 `invoice_pending`, never a 5xx |
| Accountant changes the number format or the series after go-live | L | M | `number_display` is frozen per document, so old documents keep their numbers. A format change applies to new documents only (ADR 0011: never renumber). Before go-live, layout 1 and the format are edited in place |
| Accountant rules the kind should follow issue-time rather than charge-time registration (H12) | L | M | Kind is a single SQL function `payment_document_kind_of`; changing its input is a forward migration affecting only unissued payments |
| A web download of a large export exceeds the 30 s proxy timeout | L | M | The algorithm lane sets the row cap so generation stays well inside it; atomic API generation means a timeout shows `service_unavailable`, never a truncated file |
| Noto Sans files add about 1 MB to the repository and image | H | L | Accepted. pdfkit embeds only the used-glyph subset, so documents stay small |

## Open questions for the human
1. **Receipt prefix and series (H2 follow-up).** Is `RCT-000001` in its own gapless series per team acceptable, against one shared series? Recommended: separate series. Accountant to confirm with AC-VERIFY-9.
2. **Global admin on the per-row "Invoice" action.** The Payments area lets a GLOBAL_ADMIN read for support, but this design turns `allowGlobalAdmin` **off** for the team invoice route and hides the row action from a viewer who is not a team admin, following the literal AC-ERROR-2 list. Should a global admin be able to fetch a team's invoice for support?
3. **Kind and GST number follow the charge-time snapshot** (a team registered after a charge was created issues a receipt for that charge). Accountant to confirm under H12.
4. **Byte-identical re-downloads** (AC-HAPPY-4): if pdfkit cannot be made deterministic, accept "same text and same snapshot" as the stability criterion?

## ADR 0021 outline (`docs/adr/0021-tax-invoices-and-exports.md`)
- **Status**: Proposed. Provisional until AC-VERIFY-9 records the accountant's review (date, reviewer, outcome).
- **Context**: H1-H12 rulings; D-19, D-22, D-88; ADR 0011 pending confirmation; ADR 0020 C-INV-1.
- **Decision**:
  1. Supplier and agent (H1).
  2. Documents and kinds (H2, H3). The kind follows the charge-time `gst_registered`.
  3. Series per kind, gapless per team. The generated `is_tax_invoice_issued`. Numbers are never reused. A credit-note series is reserved (H5). Supersedes ADR 0011 in part.
  4. The snapshot table and what it does and does not copy. Immutability and "numbered implies a document". The `paid_at` freeze.
  5. Issuance: the per-team stately job enqueued in the PAID transaction, on-demand, the reconcile sweep, lock order and transaction scope.
  6. Rendering: pdfkit, Noto Sans (OFL, file hashes), layout versioning rule, determinism.
  7. Downloads: API routes, headers, file names, the Next route-handler proxy and 303 error mapping.
  8. Exports: atomicity, row cap, the CSV BOM decision, the in-house XLSX writer and why (P2 and advisories, with the 2026-11-10 package table).
  9. Single writers and boundary tests.
  10. Observability events.
  11. Shared contract `PaymentDocumentRef` for player-dashboard.
- **Consequences**: layout code is retained; a GET may issue; ADR 0011 note; follow-ups (credit notes, emailing the PDF, a metrics pipeline).
- **Accountant review record** (AC-VERIFY-9): specimens list, date, reviewer, outcome, required changes.

## Decision-ledger rows (`db/schema-deviations.md`, from D-99)
| ID | Objects | Change |
|---|---|---|
| D-99 | `enum:payment_document_kind` `table:payment_documents` `trigger:payment_documents_append_only` `trigger:payment_documents_guard_insert` `constraint:payment_documents_matches_payment` | Immutable issue-time document snapshot (kind, frozen number, issue time, supplier and buyer names, game location and start, charge reason, layout version); append-only through `reject_modification`; the insert guard ties kind, number and issue time to the payment |
| D-100 | `column:team_invoice_counters.document_kind` `constraint:team_invoice_counters_pkey` `constraint:uq_payments_team_series_number` `function:payment_document_kind_of` `function:format_document_number` | One gapless series per team per document kind; uniqueness `(team_id, gst_registered, invoice_number)` replaces `uq_payments_team_invoice_number` (amends D-22 and ADR 0011) |
| D-101 | `column-def:payments.is_tax_invoice_issued` `constraint:payments_invoice_stamp_pair` | `is_tax_invoice_issued` becomes a generated column `(invoice_number IS NOT NULL AND gst_registered)`; `payments_invoice_issued_consistent` is replaced by the number and issue-time pair CHECK |
| D-102 | `constraint:payments_invoice_requires_paid` `cleanup:payments.invoice_number` | A number only on a PAID payment above $0.00; dev and test rows numbered while unpaid are cleared first (NOTICE count; not reversible) |
| D-103 | `function:assign_invoice_number` `function:issue_payment_document` `trigger:payment_documents_required` | `assign_invoice_number` becomes series-aware, uses `FOR NO KEY UPDATE`, refuses unpaid or zero and no longer writes the flag; `issue_payment_document` is the single issuer (idempotent); a deferred trigger refuses a numbered payment without a document at COMMIT |
| D-104 | `trigger:payments_guard_immutable` | `paid_at` is frozen once set (invoice "Paid on" and export periods) |
| D-105 | `index:idx_payments_unissued` | Partial index `(team_id, paid_at, id) WHERE status = 'PAID' AND invoice_number IS NULL AND amount > 0.00` for the issuance drain and the reconcile sweep |

## Assumptions about the parallel lanes
- **Algorithm lane**: owns `packages/shared/src/tax/` (period helpers and DST), the export query's preset parameters, the row filter and ordering, the row cap and range limits (`INCOME_EXPORT_MAX_ROWS`), the column set and row shaping (`income-exports/rows.ts`), and the neutralisation rule. This lane assumes it:
  - takes the payer name and the number from `payment_documents` when a row is issued, and live from `users` / `game_sessions` for unissued ($0.00) rows;
  - writes dates as text cells;
  - hands `lib/tabular` decimal strings for money.
- **UI/UX lane**: owns PDF layout 1 (inside `render-pdf.ts`'s layout function, fed by `document.ts`), the export page and form, and the post-download copy. It works within D1 (plain anchors without `download`, a GET form, `download_error` codes, optional progressive enhancement).
- **User Journey lane**: failure and recovery states map to `invoice_not_available`, `invoice_pending`, `export_too_large`, `validation_failed`, `service_unavailable` (timeout or API down) and session expiry (redirect through `/auth/session-expired`).

## Next Steps
1. Orchestrator: reconcile with the algorithm, UI/UX and journey docs (query shape, layout inputs, error codes), take open questions 1-4 to the human, and fold the plan changes above into the task file.
2. Phase 1: migration D-99 to D-105 with the upgrade test, shared document rules and contracts, boundary tests, ADR 0021 draft.
3. Phase 2: issuance job, sweep and billing enqueues with the race suite.
4. Phase 3: renderer, fonts, routes, web proxy and contract fields.
5. Phase 4: tabular writers and exports.
