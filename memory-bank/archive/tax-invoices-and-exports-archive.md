# Archive: Tax invoices, receipts and income exports

## Metadata
- Task: tax-invoices-and-exports
- Complexity: Level 3
- Started: 2026-11-10
- Completed: 2026-11-13
- Roadmap Link: tax-invoices-and-exports (v1.0.0)
- Branch: feature/tax-invoices-and-exports
- **Release gate (human ruling, 2026-11-13):** production payments (live Akahu, wallet-and-akahu-billing Phase 4b) stay off until the accountant signs off AC-VERIFY-9. See ADR 0021, "Accountant review record".

## Summary
Every PAID payment above $0.00 now gets a numbered, immutable document: a tax invoice (`INV-000001`) for a GST-registered team, or a receipt (`RCT-000001`) otherwise. The team is the supplier and the platform issues on its behalf. Players and team admins download the PDF, and team admins export income as CSV or Excel by custom range, GST period (two-monthly in either calendar, or six-monthly) or NZ financial year. It builds on the stored GST split (D-19, D-88) and replaces the dormant numbering of ADR 0011.

## Requirements
### Original Requirements
- GST split stored per payment (`GST = total × 3/23`), shown on the invoice.
- PDF tax invoices and receipts with the team's GST number, sequential numbers and the GST breakdown (IRD taxable supply information rules).
- CSV and Excel income exports by custom range, GST period and NZ financial year (1 April to 31 March).

### Success Criteria
- [✓] 34 acceptance criteria (ENTRY 3, HAPPY 10, ERROR 6, ASYNC 3, VERIFY 9, INTEGRATION 3), each checked by a phase compliance review.
- [✓] Issuance is idempotent and concurrency-safe on real PostgreSQL, and independent of how the payment was settled.
- [✓] Downloads and exports work without JavaScript; axe, 360 px and 44 px target checks pass.
- [ ] AC-VERIFY-9 accountant sign-off: pending (human). Specimens are in `docs/specimens/`; ADR 0021 stays Proposed.

## Implementation
### Approach
Five phases, built autonomously with `/yay:build --auto` (a fresh build orchestrator per phase, a compliance review gate after each, then a Codex whole-branch review).

### Key Components
1. **Schema and single issuer (Phase 1)**
   - The SQL function `issue_payment_document` is the only way to number a payment. `payment_documents` is an append-only facts snapshot with a `layout_version`. There is one gapless counter per team and document kind. `is_tax_invoice_issued` is a generated column, `paid_at` is frozen once set, and a CHECK allows numbers only on PAID > $0.00.
   - The migration converts legacy numbered rows or aborts with their ids (CR-1), and the down migration refuses once any document exists (CR-2).
   - Files: `db/migrations/20261110000100000_tax_invoices.sql`, `packages/shared/src/{nz/gst.ts,tax/periods.ts,api/invoices.ts}`.
2. **Issuance (Phase 2)**
   - A per-team singleton `issue-invoices` job is enqueued in the PAID transaction by `bill-session` and by the apply funnel's APPLY branch. An `invoice-reconcile` sweep runs at boot and every 15 minutes and is also the backfill. A download issues on demand if the job has not run.
   - Files: `apps/api/src/modules/invoices/{repo,issue}.ts`, `apps/api/src/jobs/{issue-invoices,invoice-reconcile}.ts`.
3. **Documents and downloads (Phase 3)**
   - pdfkit 0.20.2 renders on demand from the snapshot, in Noto Sans (OFL, hashes pinned).
   - Payer and team-admin routes answer a uniform 404 and set no-store. Next route handlers stream the bytes; errors redirect back with `?download_error=`.
   - The billing DTOs carry `document: {kind, available, number}`, and the wallet gains "Show older paid games" (R5).
   - Files: `apps/api/src/modules/invoices/{document,render-pdf}.ts`, `packages/shared/src/invoice/document-copy.ts`, `apps/web/src/lib/invoices/*`.
4. **Income exports (Phase 4)**
   - A preflight count and sums, then a cursor, in one REPEATABLE READ READ ONLY transaction. The CSV is UTF-8 with a BOM and CRLF; the XLSX is written in house on fflate 0.8.3. Cells are neutralised against formulas.
   - Limits (CR-3): a row cap (default 50k), a byte cap, cancellation on a dedicated connection, and a semaphore that answers 429 `export_busy`.
   - Files: `apps/api/src/lib/tabular/*`, `apps/api/src/modules/income-exports/*`, `apps/api/src/lib/db/cancel.ts`, `apps/web/src/app/teams/[teamId]/manage/exports/*`.
5. **E2E, accessibility, docs and specimens (Phase 5)**
   - `apps/web/e2e/{invoices,income-exports}.spec.ts` run on desktop and 360 px with axe, on a separate `sgm-e2e` stack (`docker-compose.e2e.yml`).
   - Also: the `docs/getting-started.md` guide and the `docs/specimens/` files.

### Design Decisions
- Separate `INV-` and `RCT-` series (R1).
- A six-monthly GST cadence is offered (R2).
- The export range is limited to 7 years / 2,557 days (R3).
- A Reference column is added (R4).
- "Show older paid games" pagination (R5).
- The critique's fixes were folded in as CR-1 to CR-4 (R6).

References: `memory-bank/creative/tax-invoices-and-exports-invoicing-{user-journey,architecture,algorithm,uiux}.md`, `docs/adr/0021-tax-invoices-and-exports.md`, ledger rows D-99 to D-105.

## Testing
- Full suite: about 4,274 tests in 295 files (up from 4,013 before the feature). Coverage is about 96.3% statements and 89.6% branches.
- Integration tests run on real PostgreSQL. They cover double delivery, the job against on-demand race, 10-way concurrency, a crash between allocation and COMMIT, the backfill, the period and DST vectors, CSV/XLSX read-back, the caps and cancellation.
- Playwright: 4/4 (two specs at two widths), including consecutive numbers, PDF text, and export totals equal to the invoices.

## Files Changed
176 files, about 20.7k lines added. The main areas are listed under Key Components above; the full list is `git diff --stat origin/main...feature/tax-invoices-and-exports`.

## Lessons Learned
- The Codex design critique plus human rulings caught the legacy-number, down-migration and unbounded-export traps before any code existed.
- Copy MUST acceptance criteria into phase briefs verbatim. A paraphrased Phase 5 line let a one-payer E2E pass until the phase review HALTed it.
- Apply current-state fallbacks only to empty results. The export Summary printed a team's current GST number on pre-registration receipts; this was fixed at archive.
- Ecosystem: the verifier repeatedly misbehaved (reverting generated files, backgrounding runs, omitting exit codes), and an interrupted orchestrator needs a checkpoint.

Reference: `memory-bank/reflection/tax-invoices-and-exports-reflection.md`. Learnings are consolidated into `agent-rules/_learned/{review-process-plan-claims,db-derived-flags-and-gates,testing-integration-db-isolation}.md`.

## References
- Reflection: `memory-bank/reflection/tax-invoices-and-exports-reflection.md`
- Creative: `memory-bank/creative/tax-invoices-and-exports-invoicing-*.md`
- ADR: `docs/adr/0021-tax-invoices-and-exports.md`
- Task (spec, rulings, deviation ledger): `memory-bank/tasks/tax-invoices-and-exports.md`

## Follow-up
1. **Before go-live:**
   - AC-VERIFY-9 accountant sign-off. This includes the "Tax invoice" capitalisation, the `INV-`/`RCT-` format, and H4/H6/H10/H12.
   - Pin layout 1's rendered output, so a later copy change cannot alter re-printed invoices.
2. On-demand class-23 issuance failure: return a stable code rather than a 500, and break the 15-minute failure loop.
3. Fix the `systemPatterns.md` snapshot-column wording, and add a flaky-test register.
4. Export page polish:
   - a post-download status line;
   - the two-field GST period;
   - hide the GST option for unregistered teams.
5. Add the algorithm doc's EXPLAIN index-plan test and the both-order snapshot-consistency test.
6. Show the invoice number right after an on-demand download.
7. Flaky tests: `registrations-sse` first-fit (lock timeout), and the migration round trips under load.
8. Pre-existing vulnerable dependencies (`next`, `zod`): open a separate upgrade task.
