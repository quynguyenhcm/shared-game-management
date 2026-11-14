# UI/UX Decision: Tax Invoice PDF, Income Exports Page and Download Actions

**Created**: 2026-11-10
**Status**: DECIDED
**Decision Type**: UI/UX
**Task**: tax-invoices-and-exports (Level 3)
**Answers**: Creative design questions 3 (PDF layout and typography) and 4 (export UI), plus the download-action surfaces of Invocation Method (payment page, wallet list, admin Payments table), and the UI-side wording for rulings H1, H2 and the H6/H10/H11/H12 defaults.
**Defers to**: Architecture lane (schema, issuance, download transport, route names, contract fields), Algorithm lane (period math, row shape and order, `{maxRows}` and `{maxRangeYears}` values), User Journey lane (end-to-end journeys), and the accountant (AC-VERIFY-9: every tax wording below is provisional).

Sources read: the task file (whole), `techContext.md` and `systemPatterns.md` conventions as quoted in the task, `apps/web/src/components/billing/{payment-detail,payments-list,admin-payments-table}.tsx`, `apps/web/src/app/teams/[teamId]/manage/{payments,banking}/page.tsx`, `apps/web/src/lib/teams/manage-areas.ts`, `components/auth/{styles.ts,text-field.tsx}`, `components/teams/manage-section.tsx`, and the wallet-and-akahu-billing UI/UX creative doc. `memory-bank/ux-patterns.md` does not exist (same as the billing creative); `productBrief.md` was not re-read in full, personas come from the task Specification. No new colours or UI libraries: the Tailwind slate/blue scale and the classes in `components/auth/styles.ts` only.

## Assumptions about the other lanes (state, so they can contradict them)

| # | Assumption | Owner | If it changes |
|---|------------|-------|---------------|
| A1 | A document is always obtainable for a PAID payment above $0.00: if the issuance job has not run, the download request issues on demand and returns the PDF (AC-ASYNC-1). So the UI has **no "issuing in progress" disabled state**; the rare 5 s lock-timeout case surfaces as a retryable error. | Architecture | If on-demand can answer "not yet", add a `Preparing` state to the link (copy reserved below). |
| A2 | `PaymentResponse.payment` and `MyPaymentRow` gain `documentKind: 'TAX_INVOICE' \| 'RECEIPT'` (the snapshot kind) and `invoiceNumber: string \| null`. **`gstAmount > 0` cannot be used to pick the label**: a registered team's $0.01 payment has GST $0.00 (AC-HAPPY-10 vector). | Architecture | Without it the button label is wrong for tiny registered payments. |
| A3 | The Next route handlers are `GET` and return the PDF/CSV/XLSX with `Content-Disposition: attachment; filename=...` and `no-store`. On a non-2xx they return JSON `{ "code": string, "field"?: string, "message"?: string }` (never an HTML error page) **when the request sends `Accept: application/json, application/pdf, ...` from `fetch`**. | Architecture | The client download helper maps `code` to the copy below. |
| A4 | The export route returns the row count in a response header (proposed `X-Export-Row-Count`) so the page can say "No paid payments in this period". | Architecture/Algorithm | Without it the empty-range sentence is not possible; the page falls back to the generic success line. |
| A5 | The Income exports page load gets, from the API, `{ gstRegistered, earliestPaidOn: LocalDate \| null, financialYears: [{ startYear, label }], maxRows, maxRangeYears }`. GST period lists are built in the web with the shared period helpers from `earliestPaidOn` to today for the chosen alignment. | Algorithm | Names are abstract; copy uses `{maxRows}` and `{maxRangeYears}`. |
| A6 | Export column headers come from one shared constant (proposed `INCOME_EXPORT_COLUMNS` in `packages/shared`), so the "What's in the file" help text cannot drift from the file. | Algorithm | If headers are file-local, the help text duplicates them. |
| A7 | Document numbers are printed exactly as given by the document model (`INV-000001`; a receipt may carry another prefix, an Architecture ruling). | Architecture | The PDF has no hard-coded prefix. |
| A8 | The team-admin invoice route is the only one the admin table uses; the payer never sees the payer's email and neither does the PDF. | Architecture | n/a |

## User Context

### Target Users
- **Primary: the Player** (APPROVED member). Casual club player on a phone, who paid a few dollars and wants a PDF to keep or claim. Does not know tax vocabulary; wants "download, done". Often arrives from the payment page or the wallet list.
- **Secondary: the Team Admin** of a GST-registered (or not) team: a volunteer treasurer, often not an accountant, working at a desk or on a phone, exporting for a GST return, the financial year, or "last month". Afraid of picking the wrong period and filing the wrong numbers.
- **Tertiary: the accountant / team treasurer** who receives the PDFs and files. They read the PDF and the Excel file, so wording and totals must be unambiguous. They are a reviewer (AC-VERIFY-9), not a signed-in user.

### User Goals
1. Player: get a correct, printable tax invoice (or receipt) for a paid game in two taps, on a phone.
2. Admin: pick a period in a way that cannot be confused (dates vs GST period vs financial year) and get a file whose scope is stated before and after the download.
3. Admin: fetch one player's invoice from the Payments list without leaving the page or seeing an email.
4. Everyone: know what is wrong when a download fails, and what to do next.
5. Accountant: tell from the PDF alone who the supplier is, the GST number, the date, the amount and the GST, and that GST is included.

### Use Cases
| Use Case | User | Goal | Frequency |
|----------|------|------|-----------|
| Download invoice from payment page | Player | Keep a tax invoice for a game | After some payments |
| Download invoice from wallet list | Player | Get an older invoice | Occasional |
| Download invoice from admin table | Team Admin | Re-send / print a player's invoice | Rare |
| Export a GST return period | Team Admin | Reconcile income for IRD | Every 2 months (registered teams) |
| Export the financial year | Team Admin | Accounts and tax return | Yearly |
| Export a custom range | Team Admin | "What did we take last Saturday" | Occasional |
| Retry after a failed download | Anyone | Get the file | Rare |

### Constraints
- **Devices**: desktop and 360 x 740 phone (Playwright projects). No horizontal page scroll at 360 px; every control at least 44 px (`min-h-11`); 16 px input text.
- **Accessibility**: WCAG 2.2 AA; axe with no critical or serious violations (AC-VERIFY-8); visible labels on every field; errors announced and tied to the field; focus managed after a failed submit.
- **Languages**: English (en-NZ) only; NZ dates; NZD via `formatNZD`; macrons must render in the PDF (embedded TTF, ruled H7) and in the UI.
- **Existing patterns to reuse**: `components/auth/styles.ts` (`BUTTON_CLASS`, `SECONDARY_BUTTON_CLASS`, `LINK_CLASS`, `INPUT_CLASS`, `FOCUS_RING`), `TextField`/`FieldError`/`describedBy`, `ErrorSummary`, `FormBanner`, `ManageAreaNav`/`MANAGE_AREAS`, `NoAccess`, `guardResults`, `PaymentStatusTag`, the payments-list row and admin-table card patterns.
- **Rulings honoured**: H1 (team is supplier, platform issues as agent, no platform GST number), H2 (numbered "Receipt", no GST wording), H7 PDF (pdfkit, embedded TTF with macrons).
- **Defaults honoured, all accountant-checked**: H6 (name, GST number, number, date, buyer name, description, lines, subtotal, GST 15%, total incl. GST, paid date), H10 (late-withdrawal fee described as such), H11 (no payment route on the PDF; neutral "Wallet"/"Bank" in the export), H12 (date of issue plus paid on).

## User Flow

### Flow Diagram
```
PLAYER
 /payments/{id} (PAID, > $0) ──┐
 /teams/{t}/wallet Paid row ───┼─> press "Download tax invoice" (link, PDF)
                               │       │ fetch (JS) ────────────────────────────┐
                               │       v                                        │
                               │   "Preparing your tax invoice."  (polite)      │
                               │       │                                        │
                               │   200 PDF ──> browser saves file ──> "Downloaded INV-000001.pdf."
                               │   409 not paid ──> "An invoice is available once the payment is paid."
                               │   404 ──> "We couldn't find this payment."
                               │   5xx / network / lock timeout ──> "We couldn't download your tax invoice. Try again in a minute." (retry = press again)
                               └─ no JS: plain link; browser downloads or shows the route's error page

TEAM ADMIN
 Manage > "Income exports" ──> choose period type ──> fill matching fields ──> choose format ──> "Download"
        │                                             │ summary line updates ("You'll get ...")
        │                              422 ──> ErrorSummary (focus) + field errors, values kept
        │                              200 ──> file saved + status "Downloaded ... {n} payments."
        │                              200, 0 rows ──> status "No paid payments in this period. The file has headings only."
        │                              422 export_too_large ──> form error "... Choose a shorter period."
 Manage > Payments > filter "Paid" ──> row "Invoice" link ──> same download states, inline in the row cell
```

### Flow Description
1. **Entry (player)**: payment page (primary action once paid) or a PAID row in the wallet payment list.
2. **Act**: press the link. With JS the page fetches the file, keeps focus on the link, and announces progress and result in a persistent status region next to the link. Without JS the link is a plain download link.
3. **Decision (admin)**: pick one of three period types. The period types are mutually exclusive: choosing one reveals only its own fields directly under its radio.
4. **Confirm scope**: a "You'll get" line under the format choice restates the period in words, whether the end date is included and that only paid payments are counted.
5. **Exit**: the browser's own download UI shows the file, and the page's status line states the file name, the row count and the period. Nothing is persisted.

### Error States
| Error | Cause | User recovery / presentation |
|-------|-------|------------------------------|
| `invoice_not_available` (409) | Payment not PAID, held, processing, $0.00 | Inline text next to the link: "An invoice is available once the payment is paid." The link stays. |
| `not_found` (404) | Not the payer or not this team's payment, or removed | "We couldn't find this payment." |
| Issuance contention / 5xx / network | Lock timeout, API down | "We couldn't download your {tax invoice\|receipt}. Try again in a minute." Link re-enabled; pressing again retries (idempotent, never a second number). |
| 401 | Session expired | Redirect to sign in with `returnTo` (existing `sessionExpiredUrl`). |
| 403 on export | Role removed mid-session | Form error: "You no longer have access to this team's exports." |
| 422 field errors (export) | See copy table | `ErrorSummary` takes focus, field errors linked, typed values kept. |
| 422 `export_too_large` | More than `{maxRows}` rows | Form-level error in the summary, no file. |
| Page options failed to load | API down | Route error boundary (existing `throw new Error('unavailable')` pattern) with "We can't load the export options right now. Try again in a minute." |

## Options Explored

### Surface A: The PDF layout

#### Option A1: Classic single-column invoice (header band, two party blocks, one table, right-aligned totals)
- **Approach**: What accountants and the IRD examples look like: title and number block on one line, supplier and buyer side by side, the game, a description/amount table, a totals block aligned to the amount column. Plain black on white, hairline rules, no fills.
- **Wireframe**:
  ```
  ┌───────────────────────────────────────────────┐
  │ Tax invoice                     Invoice number │
  │                                 INV-000001     │
  │ Issued by Shared Game Management on behalf of  │
  │ Hōkio Badminton Club.           Date of issue  │
  │                                 3 June 2027    │
  │ ─────────────────────────────── Paid on        │
  │ Supplier            Billed to   3 June 2027    │
  │ Hōkio Badminton     Aroha Ngata                │
  │ Club                                           │
  │ GST number 49-091-850                          │
  │                                                │
  │ Game                                           │
  │ Hōkio Sports Hall                              │
  │ Tuesday 3 June 2027, 7:30 pm                   │
  │                                                │
  │ Description                  Amount (incl GST) │
  │ ─────────────────────────────────────────────  │
  │ Game fee, player                        $17.00 │
  │ Game fee, guest 1                       $20.00 │
  │ ─────────────────────────────────────────────  │
  │              Subtotal (excluding GST)   $32.17 │
  │              GST (15%)                   $4.83 │
  │              ═══════════════════════════════   │
  │              Total (including GST)      $37.00 │
  │              The total includes GST of $4.83.  │
  └───────────────────────────────────────────────┘
  ```
- **Pros**: Familiar to buyers and accountants; the GST breakdown is where IRD readers look; prints cleanly in B&W; easy to code with `doc.text` at fixed x and a running y; worst case still one page.
- **Cons**: Plain; no brand. Slightly tall header on long names (mitigated with a two-line cap).
- **Usability**: High. **Accessibility**: High (real selectable text, logical reading order). **Implementation Complexity**: Low.

#### Option A2: Banner header with large number and a boxed totals panel
- **Approach**: A heavy header rule or tinted band carrying the number, a boxed totals panel at the bottom right.
- **Pros**: More designed; the number is prominent.
- **Cons**: Tinted bands print grey and waste toner; boxes need more coordinates; the macron-heavy names get less room; no accounting convention gained.
- **Usability**: Medium-High. **Accessibility**: Medium (grey fills lower contrast when photocopied). **Implementation Complexity**: Medium.

#### Option A3: Receipt-slip layout (narrow centred column, like a till receipt)
- **Approach**: A 300 pt centred column, tight lines, totals at the bottom.
- **Pros**: Reads like a receipt for the non-GST variant; compact.
- **Cons**: Two different layouts to maintain (invoice vs receipt); a tax invoice in slip form looks informal to an accountant; wasted A4 area.
- **Usability**: Medium. **Accessibility**: Medium. **Implementation Complexity**: Medium (two layouts).

### Surface B: Income exports page and period form

#### Option B1: One form, period type as radios, each radio reveals its own fields beneath it (conditional reveal), then format, summary line, Download
- **Approach**: `fieldset` "Period" with three radios in the order Custom range, GST period, Financial year (GST period omitted for a team not currently GST-registered). The selected radio's inputs appear directly under it. Then `fieldset` "File format". Then a "You'll get" line, the Download button and a status region.
- **Wireframe (360 px)**:
  ```
  Income exports for Hōkio Badminton Club
  Download the payments your team has received ...
  [ What's in the file ▸ ]

  Period
  (•) GST period
      Your GST returns end in  [ March, May, ... ▾ ]
      Period                   [ 1 Apr 2027 to 31 May 2027 ▾ ]
  ( ) Financial year
  ( ) Custom range

  File format
  (•) Excel (.xlsx)  Payments sheet and a Summary sheet with totals
  ( ) CSV (.csv)     One row per payment; opens in any spreadsheet

  You'll get an Excel file of paid payments from
  1 April 2027 to 31 May 2027, both days included.

  [ Download ]
  status: Downloaded income-...xlsx. 14 payments.
  ```
- **Pros**: One mental model ("what period?"), only the fields that matter are on screen, native controls, one submit, the pattern is well-tested for screen readers when the revealed panel follows its radio in DOM order; scope is restated in words.
- **Cons**: Needs a small client component (reveal, dependent period list, fetch download). Hiding GST period for unregistered teams adds one condition.
- **Usability**: High. **Accessibility**: High. **Implementation Complexity**: Medium.

#### Option B2: Three separate mini-forms (one card per period type, each with its own Download)
- **Approach**: Three stacked cards: "Custom range", "GST period", "Financial year"; each has its own inputs, format select and Download button.
- **Pros**: No hiding; each is simple; works without JS as three GET forms.
- **Cons**: Three buttons called Download; a screen reader user hears the same controls three times; format repeated three times; a long page at 360 px; error handling and status regions triplicated. Strong invitation to press the wrong "Download".
- **Usability**: Medium. **Accessibility**: Medium. **Implementation Complexity**: Medium.

#### Option B3: Quick presets as buttons ("This month", "Last GST period", "This financial year") plus an "Other range" disclosure
- **Approach**: One-tap preset downloads for the common cases; a disclosure with the custom form for the rest.
- **Pros**: Fastest for the common case.
- **Cons**: "Last GST period" is ambiguous without the alignment; one-tap downloads with no stated scope are exactly the filing-the-wrong-period risk; the presets hide the bi-monthly alignment choice; more buttons than the spec's one "Download".
- **Usability**: Medium (fast but error-prone). **Accessibility**: Medium. **Implementation Complexity**: Medium.

### Surface C: Download actions on the payment page, wallet list and admin table

#### Option C1: Progressive link, enhanced to fetch and save, with a persistent status region per action
- **Approach**: The action is a real `<a href>` to the Next route (works without JS and middle-click). A client enhancement intercepts the click, fetches, saves the blob and writes the outcome into an adjacent `role="status"` text. Primary button style on the payment page; compact link style in list rows and the admin table.
- **Pros**: Failures render in the page instead of a raw JSON body or a dead tab; the file type is stated in the name; keyboard and screen-reader friendly; one shared component for three surfaces and for the player-dashboard later.
- **Cons**: Client component; blob download needs `fetch` (fine for a one-page PDF); two code paths (JS and plain link).
- **Usability**: High. **Accessibility**: High. **Implementation Complexity**: Medium.

#### Option C2: Plain link only (no JS), errors on a route-rendered error page
- **Approach**: `<a href download>`; the route handler renders an error page on failure.
- **Pros**: Simplest; nothing to hydrate.
- **Cons**: With the `download` attribute a failed request can save a JSON/HTML error as the file; without it the player navigates away from their payment page to an error page; no progress or confirmation; no per-row error text.
- **Usability**: Medium-Low. **Accessibility**: Medium. **Implementation Complexity**: Low.

#### Option C3: Server action returning the file as base64 or a signed URL, then `window.location`
- **Approach**: A server action produces the document and the client triggers a download.
- **Pros**: Error handling similar to C1.
- **Cons**: Large base64 payloads through the RSC protocol; signed URLs are an Architecture lane decision the plan has not made; poor fit for the repo's proxy approach (no precedent).
- **Usability**: High. **Accessibility**: High. **Implementation Complexity**: High.

## Evaluation Matrix

| Criteria | A1 Classic | A2 Banner | A3 Slip | B1 Reveal form | B2 Three forms | B3 Presets | C1 Progressive link | C2 Plain link | C3 Server action |
|----------|-----------|-----------|---------|----------------|----------------|------------|---------------------|---------------|------------------|
| Usability | High | Med-High | Medium | High | Medium | Medium | High | Med-Low | High |
| Accessibility | High | Medium | Medium | High | Medium | Medium | High | Medium | High |
| Consistency with repo | High | Medium | Low | High (ManageSection, TextField, ErrorSummary) | Medium | Low | High (Pay now link rows) | High | Low |
| Responsiveness (360 px) | n/a (A4) | n/a | n/a | High (single column) | Low (long) | Medium | High | High | High |
| Performance | High | High | High | High | High | High | High | High | Low |
| Implementation effort | Low | Medium | Medium (2 layouts) | Medium | Medium | Medium | Medium | Low | High |

## Decision

**Chosen**: A1 (classic single-column invoice, one shared layout for both document kinds), B1 (one export form, radio-revealed fields, scope line, status region), C1 (progressive link enhanced to fetch and save, with a persistent status region).

### Rationale
- **A1**: the audience that matters for the PDF is the buyer and the accountant, and the content is a legal-ish document; convention beats design. One layout with two variants (a flag removes the GST number, GST rows and the word "tax") keeps the receipt and invoice from drifting and keeps all wording in one module.
- **B1**: the confusion the task asks us to avoid (date fields that mean different things) is solved by showing only the fields that belong to the chosen period type, directly under its radio, and by restating the result in words ("both days included, paid payments only") before the button. B2 multiplies controls; B3 hides the alignment choice, which is the main way to file the wrong period.
- **C1**: a download gives no page feedback, and the repo has no download precedent. The enhanced link gives progress, success and failure feedback in the page, keeps a plain-link fallback, and one component serves three surfaces plus the player-dashboard.

### Trade-offs Accepted
- A client component for the form and the link (hydration cost is small; both are already behind a sign-in).
- No file size is announced: the file is generated on demand, so the size is unknown until it arrives. The type ("PDF", "Excel", "CSV") is announced instead.
- Excel is the default export format (it carries the Summary sheet that reconciles). CSV users must change one radio.
- Printing is not tested for exact page fit across printers; one-page A4 at 100% scale with 17 mm margins is the contract.
- The "issued on behalf of" wording and every tax term are provisional until AC-VERIFY-9; they live in one shared module so a change is one edit and no stored record changes (the snapshot stores values, the renderer owns words).

## Design Specifications

### 1. PDF layout (pdfkit, A4)

**Document**: `size: 'A4'` (595.28 x 841.89 pt), `margins: { top: 48, left: 48, right: 48, bottom: 48 }` (about 17 mm), content width 499.28 pt, x from 48 to 547.28. `autoFirstPage: true`. Info: `Title: "{Tax invoice|Receipt} {number}"`, `Author: PLATFORM_NAME`, `Subject: "{supplier name}"`, `CreationDate: invoice_issued_at` (see determinism below), `lang: 'en-NZ'`, and `tagged: true` / `displayTitle: true` if the installed pdfkit version supports them (SHOULD).

**Fonts**: register two embedded TTFs once per process: `body = NotoSans-Regular.ttf`, `bold = NotoSans-Bold.ttf` (Noto Sans, SIL OFL 1.1; Latin Extended-A includes all macron vowels Ā ā Ē ē Ī ī Ō ō Ū ū; record the licence next to the files). **No fallback to built-in Helvetica**: if a font file cannot be read, fail the render (a WinAnsi font cannot draw macrons and would corrupt names silently, AC-INTEGRATION-1). Put a test that renders "Ā ā Ē ē Ī ī Ō ō Ū ū Whangārei Tāne Wīremu" and extracts the same text.

**Colour and print**: all text `#000000`; rules `#000000` at 0.75 pt (table header and totals rule 1 pt), no fills, no images, no grey below `#333333` (use size and weight, not grey, for hierarchy), so the document survives a mono laser or a photocopy.

**Type scale (pt)**

| Role | Font | Size | Leading (`lineGap`) |
|------|------|------|---------------------|
| Document title ("Tax invoice") | bold | 22 | 0 |
| Party/section label ("Supplier", "Billed to", "Game") | bold | 9 | 2 |
| Names (supplier, buyer) | bold | 12 | 2 |
| Body (GST number, game, lines) | regular | 10 | 3 |
| Meta label (right header) | regular | 9 | 0 |
| Meta value | bold | 10 | 0 |
| Agent statement and GST sentence | regular | 9 | 2 |
| Totals: Total row | bold | 12 | 0 |

Minimum text size is 9 pt. Never set text below `doc.page.height - margins.bottom`; if a future footer is added set `doc.page.margins.bottom = 0` while drawing it, otherwise pdfkit adds a blank page.

**Vertical layout (y measured from the top of the page, in pt)**

| Zone | y start | Content |
|------|---------|---------|
| Header | 48 | Left (x 48, w 290): title, 22 pt bold. Right meta block (x 347, w 200, label left at x 347 w 95; value right-aligned to x 547): three rows at 48, 64, 80 (row pitch 16): `{Invoice number|Receipt number}` / number; `Date of issue` / date; `Paid on` / date. |
| Agent line | 82 | x 48, w 290, 9 pt: `Issued by {PLATFORM_NAME} on behalf of {supplierName}.` Max 2 lines. |
| Header rule | 112 | 0.75 pt, x 48 to 547.28. |
| Parties | 124 | Two columns: Supplier x 48 w 235; Billed to x 312 w 235. Each: 9 pt bold label, then the name 12 pt bold, max 2 lines with ellipsis (`ellipsis: true`, `height: 30`). Supplier block (tax invoice only) adds a 10 pt line `GST number 49-091-850` 4 pt below the name. |
| Game | next y + 20 | Label `Game` (9 pt bold); location 10 pt, max 2 lines; date and time line `Tuesday 3 June 2027, 7:30 pm` 10 pt. |
| Table header | next y + 22 | Columns: Description x 48 w 399; Amount right-aligned to x 547.28 in a 100 pt column (x 447 to 547). Header labels 9 pt bold: `Description`, `Amount (including GST)` for a tax invoice, `Amount` for a receipt. 1 pt rule under. Rows: 10 pt, 6 pt padding above and below each, 0.25 pt rule between rows; description wraps within 399 pt. |
| Totals | table bottom + 16 | Block x 327 w 220.28: label left (x 327, w 130) and value right-aligned to x 547.28, row pitch 16. Tax invoice: `Subtotal (excluding GST)`, `GST (15%)`, a 1 pt rule across the block, `Total (including GST)` 12 pt bold. Under it, right-aligned 9 pt: `The total includes GST of $4.83.` Receipt: one row `Total paid` 12 pt bold. |
| Footer | none | One-page documents have no footer. |

Worst case height (2-line names, 2-line location, 3 lines of two-line descriptions, totals) is under 520 pt of the 745 pt usable; the design cannot spill, but the renderer must still assert it: after rendering, `doc.bufferedPageRange().count === 1` (test), and descriptions are capped by data shape (a payment has at most 3 lines).

**Content spec, tax invoice (GST-registered snapshot)**

| Element | Text |
|---------|------|
| Title | `Tax invoice` |
| Number label / value | `Invoice number` / `INV-000001` |
| Dates | `Date of issue` / `3 June 2027`; `Paid on` / `3 June 2027` (the NZ-local `paid_at` date) |
| Agent line (H1) | `Issued by Shared Game Management on behalf of Hōkio Badminton Club.` |
| Supplier | label `Supplier`; name; `GST number 49-091-850` |
| Buyer | label `Billed to`; buyer name only (no email, no address) |
| Game | label `Game`; location; `Tuesday 3 June 2027, 7:30 pm` (NZ local) |
| Registrant line | `Game fee, player` / `$17.00` |
| Guest lines | `Game fee, guest 1` / `$20.00`; `Game fee, guest 2` |
| Late-withdrawal line (H10) | `Late withdrawal fee, Hōkio Sports Hall, 3 June 2027` (and `Late withdrawal fee, guest 1, Hōkio Sports Hall, 3 June 2027`) |
| Totals | `Subtotal (excluding GST)` / `$32.17`; `GST (15%)` / `$4.83`; `Total (including GST)` / `$37.00`; `The total includes GST of $4.83.` |

**Content spec, receipt (non-registered snapshot, H2)**: title `Receipt`; `Receipt number`; same dates, agent line, supplier name (no GST number line), buyer, game, lines; column header `Amount`; totals `Total paid` only. No GST number, no GST row, no "including GST", no "tax" anywhere. (Open question OQ2: whether to add "This is not a tax invoice." The default here is no, because H2 says no GST wording and the accountant has not asked for it.)

**Rules**
- Money from the stored `subtotal_amount`, `gst_amount` and `amount` only (AC-VERIFY-1), formatted by `formatNZD` (thousands separators for amounts over $999.99). GST rate label from `gst_rate_bps` (`1500` -> `15%`; a non-integer percent prints with one decimal).
- GST number printed in IRD grouping: 8 digits as `NN-NNN-NNN`, 9 digits as `NNN-NNN-NNN` (reuse an existing formatter in `packages/shared/src/nz/` if one exists; otherwise add `formatIrdNumber`). The stored value stays unformatted.
- Dates in the long form `3 June 2027`; time as `7:30 pm`. AC-HAPPY-1 allows "dd/mm/yyyy or the NZ format used by `formatNzDate`"; the long form is chosen because a bare `03/06/2027` is ambiguous to an overseas accountant. **Pitfall**: ICU 72 and later put a narrow no-break space (U+202F) before "pm"; normalise any U+202F and U+00A0 to a plain space in the shared formatter, or text extraction and tests will not match.
- Names are drawn with `lineBreak` on and the two-line cap above; long unbroken names break at the column edge (`width` set), never overflow.
- **Determinism (AC-HAPPY-4: same snapshot, same bytes)**: fix `info.CreationDate = invoice_issued_at` and `ModDate` likewise; do not call `Date.now()` in the renderer. Verify in the first render test whether pdfkit's trailer `/ID` is derived from content; if it is random, assert equal extracted text plus equal page count instead of equal bytes and tell Architecture.
- The renderer takes the snapshot-derived document model only (supplier name, GST number, buyer name, game description, lines, amounts, dates, kind, number). It does no database or network access.
- Extension points for a later accountant ruling (H6): supplier address lines go under the supplier name; a buyer address under the buyer name; a "Description of services" sentence under the game block. The vertical budget has room; no change to the zone anchors.

### 2. Income exports page

**Route and nav**: `/teams/[teamId]/manage/exports`. Append `{ id: 'exports', label: 'Income exports', segment: 'exports' }` to `MANAGE_AREAS` (after Payments). `globalAdminOnly` already filters to the `payments` area, so a global admin who is not a team admin never sees it (H9); the page itself relies on the API (403 -> `NoAccess`). The nav becomes five links: confirm at 360 px that `ManageAreaNav` wraps rather than overflows (existing `flex-wrap` expected; add a test line in `manage-areas.test.ts`/component test).

**Page structure** (single column, `max-w-xl`):
1. `ManageAreaNav current="exports"`.
2. `<header>`: `h1` `Income exports for {team name}`; intro paragraph; (unregistered team) a second paragraph; (no paid payments) a third.
3. `<details>` "What's in the file": 44 px summary; body lists each column with a one-line meaning (from `INCOME_EXPORT_COLUMNS`, A6) and the scope sentences.
4. `<form>` (client component `IncomeExportForm`): `fieldset` "Period" with radios; `fieldset` "File format"; scope line; Download button; persistent status region; `ErrorSummary` above the form when errors exist.

**Period radios (order and defaults)**

| Team | Radios shown (in order) | Default selected |
|------|------------------------|------------------|
| GST-registered | GST period, Financial year, Custom range | GST period |
| Not registered | Financial year, Custom range | Financial year |

Each radio is a `label` row (min 44 px) with the revealed panel as the next sibling inside the same `fieldset`, shown only when that radio is checked (`hidden` attribute otherwise, which also removes its inputs from tab order and the accessibility tree; hidden inputs are `disabled` so they are not submitted). The radio references its panel with `aria-controls`. Focus is never moved when a radio is chosen.

**Panels**
- **GST period**: select 1 `Your GST returns end in`, options `March, May, July, September, November and January` and `April, June, August, October, December and February`; select 2 `Period`, options are the two-month windows of that alignment from the period containing `earliestPaidOn` (or the current period if none) up to the current period, newest first, labelled `1 Apr 2027 to 31 May 2027`, with the open period suffixed ` (not finished)`. Changing select 1 rebuilds select 2 and re-selects the most recent finished period. Default alignment: remembered per team in `localStorage` (try/catch, a per-viewer convenience only), otherwise the first option. A hint under select 1: `Pick the pattern your team uses to file with Inland Revenue. If you are not sure, ask your accountant.`
- **Financial year**: select `Financial year`, options from the API list (years with at least one paid payment plus the current one), newest first, labelled `2026-27 (1 April 2026 to 31 March 2027)`; the current year is suffixed ` (not finished)`. Default: the current year.
- **Custom range**: two native `<input type="date">`: `Start date` and `End date`, hint on the pair `Both days are included.` Empty by default and `required` (pre-filling dates risks an unreviewed wrong range). No `max`/`min` (the server owns limits; browsers' own validation bubbles are suppressed with `noValidate` so our messages are the only ones).

**File format**: radios `Excel (.xlsx)` (default) and `CSV (.csv)`, each with a hint line (see copy). `name="format"` values `xlsx` and `csv`.

**Scope line** (`<p id="export-scope">`, not live): rebuilt from the current selection, e.g. `You'll get an Excel file of paid payments from 1 April 2027 to 31 May 2027, both days included.` For incomplete custom input: `Choose a start and end date to see what you'll get.` The Download button is `aria-describedby="export-scope"`.

**Download button**: `BUTTON_CLASS`, visible text `Download` (idle), `Preparing your file...` while busy (`aria-disabled="true"`, not `disabled`, so focus is kept; a second press is ignored). Desktop: `sm:w-auto sm:self-start`.

**Post-download state**: a persistent `<p role="status" id="export-status">` directly under the button, empty until used:
- busy: `Preparing your file.`
- success (rows known): `Downloaded {file name}. {n} paid payments from {from} to {to}.` (`1 paid payment`, singular handled)
- success, 0 rows: `No paid payments in this period. The file has headings only.` (Excel: `...The file has headings and zero totals.`)
- success, rows header missing (A4 fallback): `Downloaded {file name}.`
The text stays until the next submit or a field change (a field change clears it so stale scope never sits beside new choices). Focus stays on the Download button. There is no toast and no auto-dismiss.

**Validation** runs on the server (422 with `field`) and, for instantly knowable cases (empty dates, end before start), on the client before the request. Errors use `ErrorSummary` (takes focus on submit failure, each entry links to its field) plus `FieldError` under the label, `aria-invalid`, `aria-describedby` (the `TextField` pattern). Entered values are kept. A form-level error (too large, no access, failure) is a summary item with no field link.

**Empty state**: a range with no paid payments is not an error. A team with no paid payments at all gets a standing note under the intro and still can download (headings only).

**States**: loading (route `loading.tsx` of the manage layout already covers page load); busy (button text change); success; error; for a team without the GST option the GST radio is simply absent.

### 3. Download actions

**Shared component**: `DownloadInvoiceLink` (client). Props: `href`, `kind` (`TAX_INVOICE | RECEIPT | INVOICE` where `INVOICE` is the neutral admin label), `context` (`{ location, day, amount }` or `{ player, day, amount }`), `variant` (`primary | link`), `invoiceNumber?`. Renders `<a href download>` plus a sibling `<span role="status" class="text-sm">` that is always in the DOM (empty until used).

| Surface | Condition | Rendering |
|---------|-----------|-----------|
| `/payments/[paymentId]` | `status === PAID` and amount > $0.00 | Inside the existing "Payment status" section after the state message: primary link-button `Download tax invoice` or `Download receipt` + ` (PDF)` as a visually secondary suffix. Under the `dl`, a row `Invoice number` appears only when `invoiceNumber` is known; no placeholder is shown while it is null (A1: the link works regardless). |
| Same | PENDING, OVERDUE, processing, held, $0.00 | No link, no extra sentence (existing state message stays the single message). A direct request gets `invoice_not_available`. |
| Wallet payment list `PaymentRow` | PAID, amount > $0.00 | `LINK_CLASS` link `Download tax invoice` / `Download receipt` + ` (PDF)` in the status-tag line, `sm:ml-auto`; status text under it. |
| Wallet list | everything else | none (existing hold/payout notes unchanged). |
| `AdminPaymentsTable` | PAID and amount > $0.00 | In the Action cell: `LINK_CLASS` link `Invoice`, accessible name `Invoice for {player}, {day}, {amount} (PDF)`. Mobile card: the cell keeps `max-sm:before:content-none` and the link sits on its own 44 px row; status text below it. |
| `AdminPaymentsTable` | not PAID, held, or $0.00 | none |

**Accessible names** (visible label is always the start of the name, WCAG 2.5.3):
- Payment page: `Download tax invoice for {location}, {day}, {amount} (PDF)` (or `Download receipt ...`).
- Wallet row: same string (the existing `Pay now, {label}, {amount}` pattern).
- Admin: `Invoice for {player}, {day}, {amount} (PDF)`.
Format of `{day}` and `{amount}` reuses `formatDay` and `money` from `lib/billing/labels.ts`.

**Behaviour**: click -> `preventDefault`; set `aria-disabled="true"`; status `Preparing your {document}.`; `fetch(href, { headers: { Accept: 'application/pdf, application/json' } })`; on 2xx create a Blob, a temporary object URL and a programmatic `<a download>` click using the `Content-Disposition` filename; revoke the URL; status `Downloaded {file name}.`; on error map the JSON `code` to the copy table and `role="status"` text (a failure uses the same region; it is announced politely because the user just acted and is waiting; add `role="alert"` only on the failure text node so it is announced assertively). Focus stays on the link. 401 redirects to sign-in. Without JS the plain link downloads or shows whatever the route returns (accepted degradation).

**Plan change from AC-ASYNC-1**: the player page does not need `RefreshWhilePending` for the invoice; the button works at once (A1) and the invoice-number row simply appears on the next load. Do not add a refresh timer for this.

### Layout
- **Desktop**: export form `max-w-xl`, left aligned under the nav; radio rows and panels stack; Download button auto width. Payment page and lists unchanged, with the download link at the end of the status line / section.
- **Tablet (640-1024 px)**: same as desktop; admin table remains a table from 640 px.
- **Mobile (< 640 px)**: everything single column; admin table rows are cards (existing); download links full-row 44 px; Download button full width.

### Key Components
| Component | Purpose | Behavior |
|-----------|---------|----------|
| `DownloadInvoiceLink` | The one download action for three surfaces (and the player-dashboard) | Progressive `<a>`, fetch and save, status region, error mapping |
| `IncomeExportForm` | Period type, fields, format, scope line, status | Conditional reveal, dependent selects, client precheck, fetch and save, status messages |
| `ExportStatus` (inside the form) | Persistent `role="status"` | Cleared on field change |
| `ManageAreaNav` (existing) | Area nav | Gets the "Income exports" entry |
| `ErrorSummary`, `FieldError`, `TextField` (existing) | Errors | Focus on failed submit, linked entries |
| `document-copy` (shared module) | All words that can change by accountant ruling | Imported by the PDF renderer and by web labels |
| `renderInvoicePdf` | pdfkit renderer | Pure function: document model in, `Buffer` out |

### Interactions
| Trigger | Action | Feedback |
|---------|--------|----------|
| Choose a period radio | Reveal its panel, hide others, rebuild scope line, clear old status | Panel appears directly under the radio; focus stays on the radio |
| Change GST alignment | Rebuild the Period select, pick the latest finished period | Scope line updates |
| Press Download | Client precheck, then fetch | Button text `Preparing your file...`, status `Preparing your file.` |
| 200 | Save file | Browser download UI; status text; focus unchanged |
| 422 | Show errors | `ErrorSummary` takes focus; fields marked invalid; values kept |
| Press an invoice link | Fetch and save | Status next to the link; link re-enabled after |
| Edit a field after an error | Clear that field's error on input | The summary clears when its last error clears |

### Responsive Behavior
| Breakpoint | Changes |
|------------|---------|
| < 640px | Single column; full-width Download button; admin payments as cards; download links 44 px rows; no horizontal scroll at 360 px (long file names and team names `break-words`) |
| 640-1024px | Table layout for admin payments; button auto width |
| > 1024px | Same, with form capped at `max-w-xl` for readable line length |

### Accessibility Requirements
- [ ] Keyboard: every control reachable in DOM order (nav, h1, details, Period radios and their panel fields, File format, Download, status); radios operate with arrows; Enter/Space on the link and button; no keyboard trap; the details summary toggles with Enter/Space.
- [ ] Focus order after failure: `ErrorSummary` receives focus (existing `useAuthForm` behaviour), its links move focus to the field, then the field's own error is read via `aria-describedby`.
- [ ] Screen reader: `fieldset`/`legend` for Period and File format; `aria-controls` on radios; revealed panels follow their radio in DOM order and use `hidden` (not CSS-only); status regions are persistent and present at first render; download links announce the file type in their name (`(PDF)`); the admin link includes player, day and amount.
- [ ] Contrast: only the existing slate-900/700 text on white, blue-800 links, blue-700 focus ring (all AA); no meaning by colour alone (error text says "error" via `ErrorSummary` heading and `aria-invalid`).
- [ ] Targets: every link, radio row, select, date input and button at least 44 px (`min-h-11`); radio inputs `size-5` inside a 44 px row.
- [ ] Reflow: 360 px, no horizontal page scroll; zoom to 200% keeps the form usable; text uses rem/Tailwind sizes.
- [ ] Errors: field errors linked with `aria-describedby`, `aria-invalid`, entered values kept; the status region never carries the only copy of an error that also needs a field link.
- [ ] No native `alert`/`confirm` dialogs.
- [ ] Motion: none, so `prefers-reduced-motion` needs no handling.
- [ ] axe: no critical or serious violations on the page idle, with errors, with each panel selected (E2E scans these states at desktop and 360 x 740).
- [ ] PDF: real selectable text in reading order (title, meta, parties, game, table, totals), document title and language set, tagged if supported, black on white at 9 pt or larger.

## Copy Table (exact strings; `{...}` are runtime values)

Web strings live in `apps/web/src/lib/invoices/labels.ts`; PDF strings and kind names in the shared `document-copy.ts` (see Implementation).

### Download actions
| Key | Text |
|-----|------|
| `DOWNLOAD_TAX_INVOICE` | `Download tax invoice` |
| `DOWNLOAD_RECEIPT` | `Download receipt` |
| `INVOICE_ACTION_ADMIN` | `Invoice` |
| `FILE_TYPE_SUFFIX` | ` (PDF)` (visible, secondary) |
| `downloadName(kind, ctx)` | `Download {tax invoice\|receipt} for {location}, {day}, {amount} (PDF)` |
| `adminInvoiceName(ctx)` | `Invoice for {player}, {day}, {amount} (PDF)` |
| `INVOICE_NUMBER_LABEL` | `Invoice number` (receipt: `Receipt number`) |
| `INVOICE_PREPARING` | `Preparing your {tax invoice\|receipt}.` |
| `INVOICE_DONE` | `Downloaded {file name}.` |
| `INVOICE_NOT_AVAILABLE` | `An invoice is available once the payment is paid.` |
| `INVOICE_NOT_FOUND` | `We couldn't find this payment.` |
| `INVOICE_FAILED` | `We couldn't download your {tax invoice\|receipt}. Try again in a minute.` |
| `INVOICE_FAILED_ADMIN` | `We couldn't download this invoice. Try again in a minute.` |
| `INVOICE_BUSY_RESERVED` | `Your {tax invoice\|receipt} is being prepared. Try again in a moment.` (reserved for A1 changing; used if the API answers an `invoice_issuing` retry code) |

### Income exports page
| Element | Text |
|---------|------|
| Nav label | `Income exports` |
| `<title>` | `Income exports – {team} – Shared Game Management` |
| h1 | `Income exports for {team}` |
| Intro | `Download the payments your team has received, for a GST return or your accounts. Only paid payments are included, counted by the date they were paid (New Zealand time).` |
| Top-ups note | `Wallet top-ups aren't included. A top-up is counted when it is used to pay for a game.` |
| Unregistered note | `Your team isn't registered for GST, so the GST columns show $0.00.` |
| No payments note | `Your team has no paid payments yet. A file will only have headings.` |
| Details summary | `What's in the file` |
| Details intro | `One row for each paid payment, oldest first. Amounts are in New Zealand dollars and the totals add up exactly to the rows.` |
| Column help (from `INCOME_EXPORT_COLUMNS`, wording proposed) | `Invoice number`: the number on the tax invoice or receipt, blank when no document was issued (a $0.00 game). `Paid date`: the day the payment was paid (New Zealand time). `Game date`: the day of the game. `Player`: the player's name. `Description`: what was paid for. `Subtotal`: the amount before GST. `GST`: the GST in the payment. `Total`: the amount paid, including GST. `GST registered`: Yes or No at the time of payment. `Paid by`: Wallet or Bank. |
| Excel summary note | `Excel files also have a Summary sheet with the team, period, number of payments and totals.` |
| Period legend | `Period` |
| Radio: GST period | `GST period` |
| Radio: Financial year | `Financial year` |
| Radio: Custom range | `Custom range` |
| GST select 1 label | `Your GST returns end in` |
| GST select 1 option A | `March, May, July, September, November and January` |
| GST select 1 option B | `April, June, August, October, December and February` |
| GST select 1 hint | `Pick the pattern your team uses to file with Inland Revenue. If you're not sure, ask your accountant.` |
| GST select 2 label | `Period` |
| GST period option | `{1 Apr 2027} to {31 May 2027}` (open period: `... (not finished)`) |
| FY select label | `Financial year` |
| FY option | `{2026-27} ({1 April 2026} to {31 March 2027})` (open year: `... (not finished)`) |
| FY hint | `New Zealand financial years run from 1 April to 31 March.` |
| Custom: start label | `Start date` |
| Custom: end label | `End date` |
| Custom: hint | `Both days are included.` |
| Format legend | `File format` |
| Radio Excel | `Excel (.xlsx)` + hint `A Payments sheet and a Summary sheet with totals.` |
| Radio CSV | `CSV (.csv)` + hint `One row for each payment. Opens in any spreadsheet.` |
| Scope line (period set) | `You'll get {an Excel\|a CSV} file of paid payments from {1 April 2027} to {31 March 2027}, both days included.` |
| Scope line (custom incomplete) | `Choose a start and end date to see what you'll get.` |
| Button idle | `Download` |
| Button busy | `Preparing your file...` |
| Status busy | `Preparing your file.` |
| Status success | `Downloaded {file name}. {n} paid {payment\|payments} from {from} to {to}.` |
| Status success, no rows (CSV) | `No paid payments in this period. The file has headings only.` |
| Status success, no rows (Excel) | `No paid payments in this period. The file has headings and zero totals.` |
| Status success, count unknown | `Downloaded {file name}.` |
| Error summary heading | `Fix these before you download` |

### Validation and refusals
| Field / case | Message |
|--------------|---------|
| Start date empty | `Enter a start date.` |
| End date empty | `Enter an end date.` |
| Date not real (2027-02-30, malformed) | `Enter a real {start\|end} date.` |
| End before start | `The end date can't be before the start date.` |
| Range too long | `Choose a period of {maxRangeYears} years or less.` |
| Start in the future | `The start date can't be in the future.` |
| GST period unknown | `Choose a GST period from the list.` |
| Financial year unknown | `Choose a financial year from the list.` |
| Format unknown | `Choose Excel or CSV.` |
| `export_too_large` | `This period has more than {maxRows} paid payments, so we can't put it in one file. Choose a shorter period.` |
| 403 | `You no longer have access to this team's exports.` |
| 5xx / network | `We couldn't make your file. Try again in a minute.` |
| Options failed to load | `We can't load the export options right now. Try again in a minute.` |

### PDF strings (in the shared copy module)
`Tax invoice`, `Receipt`, `Invoice number`, `Receipt number`, `Date of issue`, `Paid on`, `Issued by {platform} on behalf of {supplier}.`, `Supplier`, `GST number {n}`, `Billed to`, `Game`, `Description`, `Amount (including GST)`, `Amount`, `Game fee, player`, `Game fee, guest {n}`, `Late withdrawal fee, {location}, {date}`, `Late withdrawal fee, guest {n}, {location}, {date}`, `Subtotal (excluding GST)`, `GST ({rate}%)`, `Total (including GST)`, `The total includes GST of {amount}.`, `Total paid`. `PLATFORM_NAME = 'Shared Game Management'`.

## Implementation Guidelines

### For Developers
1. **Wording in one place.** Create `packages/shared/src/invoice/document-copy.ts` exporting `PLATFORM_NAME`, `DOCUMENT_TITLES`, the agent-line builder, the line-description builders, the totals labels and `documentLabel(kind)` for the web link text. The PDF renderer and the web labels both import it, so an accountant change (H1, H2, H6, H10, H12) is one file and one snapshot test, with no migration (stored values never include these words).
2. **No float, no recompute.** The renderer and the form never compute GST. Print the stored values; the row-count and totals in the page come from the API.
3. **pdfkit rules.** Register fonts once; use `doc.font('bold')` / `doc.font('body')`; lay out by the zone anchors above using `doc.text(text, x, y, { width, align, lineBreak, ellipsis, height })`; draw rules with `doc.moveTo().lineTo().lineWidth().strokeColor('#000').stroke()`; never write below the bottom margin; assert one page. Fonts live in `apps/api/assets/fonts/`; the API Dockerfile and tsup output must copy `assets/` (coordinate with Architecture); resolve the path from the module location, not `process.cwd()`.
4. **Shared date helpers.** Add `formatNzDateLong(Date | LocalDate)` ("3 June 2027"), `formatNzWeekdayDate` ("Tuesday 3 June 2027") and `formatNzTime12` ("7:30 pm") to `packages/shared/src/time/` with the U+202F normalisation and DST test vectors; reuse in the web.
5. **Download helper** (`apps/web/src/lib/invoices/download.ts`): one function `downloadFile(url)` that does the fetch, reads `Content-Disposition`, saves the blob, returns `{ ok: true, filename, rowCount? } | { ok: false, code, field?, status }`; used by both the link and the form so error mapping exists once. Use `URL.createObjectURL` and revoke after the click; guard `window` access for SSR.
6. **Form.** `IncomeExportForm` is a client component; initial state from server props (A5); reveal logic keeps all three panels in the DOM (so the server render and no-JS view show everything and the server ignores fields of the unselected type); controlled `period` state only for the reveal and scope line; field values stay uncontrolled where possible (`defaultValue`) so values persist through errors. Submit button `type="submit"` with `aria-disabled` while busy; the `onSubmit` handler no-ops if busy.
7. **Contracts.** Request from Architecture: `documentKind` and `invoiceNumber` on `PaymentResponse` and `MyPaymentRow`; error JSON shape A3; export header A4; options payload A5. UI helpers (`canDownloadInvoice(row)`) live in `apps/web/src/lib/billing/wallet-view.ts` as pure functions and are unit tested with the status matrix (PAID, $0.00, held, processing, OVERDUE, PENDING).
8. **Tests to add** (within the plan's Phase 3 and Phase 4 counts): `labels` strings snapshot; `canDownloadInvoice` matrix; `DownloadInvoiceLink` component test for busy/success/each error; `IncomeExportForm` component test for reveal, dependent selects, client validation, status messages; `render-pdf` test for macrons, one page, kind variants, no "tax" or GST text in the receipt; E2E scans (axe) idle, with errors and per panel at both widths. Specimen PDFs for AC-VERIFY-9: tax invoice with and without a guest, a receipt, a late-withdrawal invoice, and a long-name stress case.
9. **Security and logging.** The page and links never render an email, bank detail or token; client code logs nothing; file names come from the server header and are shown as text only.

### Component Structure
```
apps/web/src/components/invoices/
├── download-invoice-link.tsx
├── download-invoice-link.test.tsx
├── income-export-form.tsx
├── income-export-form.test.tsx
└── export-panels.tsx                 ← the three period panels (GST, Financial year, Custom)
apps/web/src/lib/invoices/
├── download.ts                       ← shared fetch-and-save helper + error mapping
├── download.test.ts
├── labels.ts                         ← web copy (imports shared document-copy)
├── labels.test.ts
└── export-view.ts                    ← scope line, period option labels, client precheck (pure)
apps/web/src/app/teams/[teamId]/manage/exports/
├── page.tsx
└── page.test.tsx
apps/web/src/lib/teams/manage-areas.ts          ← extend (id 'exports')
apps/web/src/lib/billing/wallet-view.ts         ← extend: canDownloadInvoice
apps/web/src/components/billing/{payment-detail,payments-list,admin-payments-table}.tsx  ← extend
packages/shared/src/invoice/document-copy.ts    ← shared PDF and link wording
packages/shared/src/invoice/document-copy.test.ts
packages/shared/src/time/format-long.ts         ← long NZ date and 12-hour time formatters (+ test)
apps/api/src/modules/invoices/render-pdf.ts     ← pdfkit renderer (layout constants at top)
apps/api/src/modules/invoices/render-pdf.test.ts
apps/api/assets/fonts/NotoSans-Regular.ttf
apps/api/assets/fonts/NotoSans-Bold.ttf
apps/api/assets/fonts/OFL.txt
```
(Extensions resolved from the plan's Source files and the repo convention: `.tsx` for components and pages under `app/**` and `components/**`, `.ts` for `lib/**`, shared and API modules, test files `.test.ts(x)`.)

### Recommended Libraries/Patterns
- pdfkit with embedded Noto Sans (ruled). pdf text extraction in tests with the library the Architecture lane picks (`pdfjs-dist`/`pdf-parse`-class); not decided here.
- Native `<input type="date">`, `<select>`, radios, `<details>`: no date-picker library (accessible, 44 px, mobile-native).
- Conditional-reveal radio pattern (as in GOV.UK) for the period types.
- Fetch + Blob + temporary anchor for the download, with a plain-link fallback.
- No new web dependency.

## Validation Checklist

- [x] Meets all user goals (player two taps; admin scoped, confirmed export; accountant-readable PDF)
- [x] Accessible per requirements (WCAG 2.2 AA items above)
- [x] Consistent with existing patterns (ManageAreaNav, TextField, ErrorSummary, LINK/BUTTON classes, row patterns)
- [x] Respects Guiding Principles: API is the authority (UI never recomputes GST, never decides eligibility beyond hiding links the API would refuse), no secrets rendered, money as stored strings
- [x] Responsive across devices (360 px reflow, 44 px targets)
- [x] Performance acceptable (one-page PDF in a request; export as a single fetch, blob up to the row cap)
- [x] Implementation feasible (no new web libraries; pdfkit already ruled)

## Plan Changes and Open Questions (for the parent agent)

### Suggested plan changes
1. **Contract fields**: add `documentKind` (and `invoiceNumber`) to `PaymentResponse`/`MyPaymentRow`; `gstAmount > 0` is not a safe label test ($0.01 case). Also the existing `gstShown` check in `payment-detail.tsx` hides "Includes GST of $0.00" for such a payment; harmless, but not a source for the document kind.
2. **AC-ASYNC-1 wording**: drop the "page refreshes while a number is pending" clause for the invoice; the link works at once (A1).
3. **AC-HAPPY-1 text assertions**: totals read `Subtotal (excluding GST)` / `GST (15%)` / `Total (including GST)` plus the sentence `The total includes GST of $3.00.`; the AC's `Total "$23.00 including GST"` string should be asserted as label and value separately. Dates print in the long form (`3 June 2027`), which the AC allows as "the NZ format used by `formatNzDate`" only if the shared formatter is the one used; the test must call the same formatter.
4. **New files**: `packages/shared/src/invoice/document-copy.ts`, `packages/shared/src/time/format-long.ts`, `apps/web/src/components/invoices/export-panels.tsx`, `apps/web/src/lib/invoices/{labels,export-view}.ts`, font files and licence; add `export-panels.tsx` and the two libs to the Phase 3/4 file lists and `packages/shared/src/time` additions to Phase 1/3.
5. **Route handler contract (A3/A4/A5)** to the Architecture lane: JSON error bodies for `fetch`, row-count header, export-options payload.
6. **Docker/tsup**: `apps/api/assets/` must be shipped in the API image.
7. **`ManageAreaNav` at five links**: verify wrap at 360 px and add it to the manage-areas test.
8. **E2E scope**: axe scans on the export form idle, with errors, and with each panel selected; admin Invoice link in the table; `(PDF)` in accessible names.

### Open questions (human or accountant)
- **OQ1** Date style on the PDF: long (`3 June 2027`, chosen) or numeric `03/06/2027`.
- **OQ2** Receipt wording: add "This is not a tax invoice."? Default no (H2: no GST wording).
- **OQ3** The agent line `Issued by Shared Game Management on behalf of {team}.`: is this the form the accountant wants (H1), and should it also appear in a footer?
- **OQ4** GST period option visible only while the team is currently registered (default). A team that deregistered still has historic registered payments reachable via Custom range or Financial year.
- **OQ5** Default export format Excel (chosen) vs CSV; CSV BOM is an Algorithm/Architecture decision (H7).
- **OQ6** Is a no-JS plain link acceptable as the only fallback (raw route error)? Chosen: yes.

## Next Steps

1. Architecture lane: confirm A1-A8 (contract fields, JSON errors, row-count header, options payload, assets in the image).
2. Algorithm lane: supply the period-list helper signatures and the shared `INCOME_EXPORT_COLUMNS`; fix `{maxRows}` and `{maxRangeYears}`.
3. Phase 3: build `document-copy.ts`, the date formatters, `render-pdf.ts` with the layout constants, `DownloadInvoiceLink`, and the three surface changes; generate specimen PDFs for the accountant.
4. Phase 4: build `IncomeExportForm`, the manage area entry and the page; wire the status copy to the route's headers.
5. Phase 5: E2E and axe at 360 x 740 for each state above; record the accountant's outcome (AC-VERIFY-9) and update any wording in `document-copy.ts` only.
