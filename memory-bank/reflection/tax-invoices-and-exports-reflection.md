# Reflection: tax-invoices-and-exports - Tax invoices and income exports

**Date**: 2026-11-13
**Task Complexity**: Level 3
**Total Phases**: 5 (all built, plus one Phase 5 remediation)
**Duration**: 2026-11-10 (plan, creative) to 2026-11-13 (auto-build and final review). 19 commits on `feature/tax-invoices-and-exports`, 175 files changed, +20,514 / -602 lines.

## Executive Summary

The feature issues a numbered, immutable tax invoice (or numbered receipt for non-GST teams) for every PAID payment above $0.00. Issuance runs through a per-team `issue-invoices` pg-boss job, with an on-demand fallback at download time and an `invoice-reconcile` sweep that also backfills. The PDF is rendered on demand by pdfkit from an append-only `payment_documents` facts snapshot. Players and team admins download the PDF. Team admins also get CSV and XLSX income exports by custom range, GST period or NZ financial year, through an in-house `fflate` XLSX writer and bounded by row, byte and concurrency caps. All 34 ACs are built and covered, except that AC-VERIFY-9 (accountant sign-off) is recorded but human-pending. The suite ended at 4269+ tests, 96.3% statement and 89.6% branch coverage, and a Playwright journey passing on desktop and 360 px with axe.

The work ran as plan, then four parallel creative lanes with a Codex design critique, then `/yay:build --auto` (five fresh Sonnet orchestrators, each followed by a per-phase compliance reviewer, then an Opus/Codex whole-branch review). Design quality was high. The Codex critique caught three real design defects before any code existed: the migration stranding legacy numbered rows, an unsafe down-migration, and unbounded exports. The binding amendments CR-1..CR-3 were then implemented and tested. The build also surfaced and fixed a pool-deadlock in query cancellation (Phase 4 code review P1) and a 500 on `year=9999-00`.

The branch is not yet mergeable. The final review found two Important items that were not addressed autonomously: a Summary GST-number fallback that can print the wrong GST number on a historical export, and the lack of a recorded human ruling that production payment enablement is gated on AC-VERIFY-9. Issuance is a one-way door (CR-2), so the second item is a release-safety control, not paperwork.

---

## Dimension 1: Task Implementation Quality

### Requirements Achievement

**Status**: ⚠️ Partial (all buildable ACs met; one human gate and one correctness defect open)

- Per-payment documents, gapless per-kind per-team numbering (R1, `INV-`/`RCT-`), PAID > $0.00 only, automatic issuance plus on-demand fallback plus backfill: met (Phase 2, AC-ASYNC-1..3, AC-HAPPY-4/5, AC-ERROR-1/5).
- PDF documents, guests, late-withdrawal wording, payer and admin downloads, wallet "Show older paid games" pagination (R5): met (Phase 3).
- Three export period types, CSV/XLSX, neutralisation, row-cap refusal, 7-year range (R3), Reference column (R4), six-monthly GST (R2): met (Phase 4).
- AC-INTEGRATION-2 (MUST) was only partly asserted after Phase 5 and the phase reviewer HALTed correctly. The roadmap line had been looser than the AC. Remediation 1 completed it (two payers, consecutive numbers, PDF text, CSV/XLSX equal to the invoices) and re-review passed.
- AC-VERIFY-9: specimens (four PDF variants, month and FY exports) are in `docs/specimens/` and ADR 0021 stays Proposed. Sign-off is human and still pending.
- Spec variances worth tracking: title "Tax invoice" vs AC-HAPPY-1 "Tax Invoice" (deferred to the accountant); UI/UX status region and `fetch`+Blob enhancement not built (deliberate, per the cross-lane ruling); GST-period selector is one grouped select, not the dual field; the unregistered-team GST option is neither hidden nor annotated; the `EXPLAIN` plan test and the "both orders" snapshot-consistency test were not written.

### Code Quality Assessment

**Overall Rating**: Good (design is Excellent; two real defects and a few unpinned behaviours keep it from Excellent)

- **Maintainability**: Strong. Accountant-sensitive wording is isolated in `packages/shared/src/invoice/document-copy.ts` and `export-columns.ts`, so AC-VERIFY-9 rulings are text edits that never touch stored records. The service/job split (`issueTeamBacklog` in the service, a thin job adapter) made the drain testable on real PostgreSQL. The writers are generic (cell types, not per-column specs).
- **Architecture**: SQL `issue_payment_document` is the sole issuer; `repo.ts` is the sole caller (enforced by a boundary test). Append-only snapshot rendered by `layout_version` makes layout changes safe. Per-team singleton job avoids a team-wide counter lock in the billing transaction. Shared helpers (`toInstantRange`, `gstOfInclusive` with parity proven on 30,603 values) are used by both API and web.
- **Error handling**: Thorough. Stable error codes (`invoice_not_available`, `invoice_pending`, `export_too_large`, `export_busy`, `validation_failed`); every refused download lands on a fixed page with a notice; cancellation propagates Next to API to the Postgres statement; `statement_timeout` and idle-in-transaction timeouts act as backstops. Gaps: a class-23 failure on the on-demand path answers 500 and then the sweep retries in a 15-minute failure loop (Minor, open); the empty-export GST-number fallback is wrong for history (Important, open).
- **Testing**: Strong and layered: per-rule boundary tests that are each proven to detect a violation, real-Postgres integration tests (including upgrade tests for CR-1: PAID, PENDING, $0.00 and interleaved numbered rows), a load test with measured (not asserted) numbers, specimen rendering test, and E2E with real PDF/XLSX parsing (`unpdf`, `read-excel-file`). Gaps: layout-1 render output is not pinned (layout drift is only caught by text assertions), no EXPLAIN test, and the phase-3 verifier did not capture lint/typecheck/build exit codes.

### Technical Decisions

**Key Decisions:**
1. Append-only facts snapshot + render-on-demand (rather than storing PDF bytes) - lets wording and layout change without rewriting tax records; the cost is that `layout_version` must be preserved forever and the render output must be pinned by tests (not yet done for layout 1).
2. Per-team job enqueued in the PAID transaction, with on-demand and reconcile fallbacks - keeps numbering locks out of billing; three redundant paths each tested; no migration-time backfill.
3. SQL as sole issuer with idempotent return of the winner's document - the race test now asserts the idempotent outcome instead of an error; simple and safe.
4. In-house XLSX on `fflate` (pinned 0.8.3) writing money cells from `MoneyString` - keeps P2 (no float money) without an exemption; `read-excel-file` pinned to the vetted 9.3.14 rather than a 2-day-old release.
5. Dedicated short-lived `pg.Client` for `pg_cancel_backend` guarded by `xact_start` - replaced the pool-based cancel after code review showed it could deadlock when `DATABASE_POOL_MAX` <= active exports.
6. Byte cap counts what the writer actually holds (zipped XLSX output), not uncompressed XML - the naive count refused the 50,000-row ceiling for a 2.4 MB file.

**Trade-offs:**
- Gapless per-kind series (R1) vs migration simplicity: legacy numbers convert by `gst_registered`, so a team with both kinds of legacy numbers may start a series with a hole. Accepted because no production payment exists before Akahu is live.
- No-JS plain anchors/GET forms vs the richer UI/UX status region: robust and accessible, but "Downloaded ..." feedback and the `x-export-row-count` header are unused by the web.
- In-process semaphore vs a distributed one: correct for one API instance; `INCOME_EXPORT_MAX_CONCURRENT` bounds each process only.

### What Went Well

1. The Codex design critique plus human rulings (R1-R6, CR-1..CR-4) turned architecture risk into binding, testable build requirements; Phase 1 implemented CR-1/CR-2 exactly and with upgrade tests.
2. The per-phase compliance reviewer did its job: it HALTed Phase 5 on a real MUST-level gap, and the remediation was bounded (one attempt) and re-verified.
3. Test-first fixes on review findings (Phase 4: three Codex findings plus one on re-review) and boundary tests that police single-writer, money and observability rules.
4. The deviation ledger is exhaustive and honest, including deferrals, which makes this reflection and the final review fast to audit.
5. Isolated E2E on a second Compose project (`sgm-e2e`) so the user's dev stack is never touched.

### Challenges Encountered

1. Phase 4 orchestrator interruption (ESCALATION) after Step 8 with 44 uncommitted files and a still-running backgrounded verifier - resumed by a second orchestrator; the concurrent-verifier hazard was handled by messaging, not by a mechanism.
2. E2E leaked one read-only GET to the user's dev web on localhost:3000 before `WEB_BASE_URL` was set - fixed by hard-setting 3100 in the overlay (build arg and runtime).
3. Load flakes: `registrations-sse` "session PUT promotes first-fit" (row-lock timeout, recurred twice, file untouched by this feature) and the `invoices-schema` round trip ("Not run migration ... preceding already run"). Both pass alone; same family as the PR #9 `billing-schema` flake.
4. The yay verifier reverted `apps/api/openapi.yaml` with `git checkout` (already in project memory), and in Phase 3 returned an interim verdict without lint/typecheck/build exit codes.
5. Environment: GitHub push needs the gh credential-helper workaround, macOS has no `timeout` so the Codex wrapper fails (Phase 2 skipped Codex), the Codex sandbox cannot run DB tests, and the pg-boss preview budget constrains the DST schedule guard.

### Technical Debt & Future Work

See "Open Follow-ups" below for the prioritised list.

---

## Dimension 2: Claude Code Ecosystem Effectiveness

### Build Session Analysis

**Session logs**: No `.agent-logs/claude/by-task/tax-invoices-and-exports/` directory exists, so tool-call counts, per-tool success rates and error-recovery counts are not available and are not fabricated. The assessment below rests on the task file, the deviation ledger and `git log` (19 commits; 5 phase commits, 5 review-ledger commits, 1 remediation commit, 4 plan/creative commits, 1 start, 1 final).

**Build Sessions**: 5 phase orchestrators (Sonnet) + 1 resumed Phase 4 orchestrator + 1 Phase 5 remediation + 1 final review
**Guard FAILs / re-invocations**: see below (task file has no `### Guard & Recovery Log` section)
**Errors recovered**: at least 6 documented (Phase 4 interruption, Phase 4 pool-deadlock P1, `year=9999-00` 500, Phase 5 AC-INTEGRATION-2 HALT, e2e localhost:3000 leak, e2e docs referencing a missing override)

#### Tool Utilization

Not measurable (no session logs). Qualitative: Bash was the dominant tool for compose/E2E/test runs; Codex (companion) was used for design critique, Phase 3-4 code review and the final review.

#### Sub-Agent Performance

| Agent Type | Invocations | Model | Effectiveness |
|------------|-------------|-------|---------------|
| Build orchestrator | 6 (5 phases + Phase 4 resume) | Sonnet | Effective; recovered from interruption via resume, but depended on a second orchestrator reconciling 44 uncommitted files |
| Phase compliance reviewer | 5 + 1 re-review | Sonnet/Anthropic | High value: caught the AC-INTEGRATION-2 gap; Phase 2 used Anthropic because Codex wrapper failed |
| Codex code review (per phase) | 2 confirmed (Phase 3 clean, Phase 4 3+1 findings) | Codex | High value on Phase 4 (P1 deadlock, P2 500, P2 GST fallback); Sandbox cannot run DB tests |
| Verifier | 5 | Sonnet | Mixed: reverted openapi.yaml, backgrounded a run, skipped lint/typecheck/build exit codes in Phase 3 |
| Final reviewer | 1 | Opus/Codex | Found the two Important items; correct that neither was auto-fixed |
| Creative lanes | 4 + Codex critique | Opus/Codex | Excellent; critique found 3 real design defects |

### Command Workflow Evaluation

**Commands Used**: plan, creative, build --auto, reflect (archive pending)

**Workflow Efficiency**: Good

**Assessment**:
- Classification as Level 3 was right: LOW-confidence tax fields made creative mandatory, and the critique paid for itself.
- The "roadmap line looser than the AC" failure in Phase 5 shows the phase brief is a lossy copy of the ACs. The reviewer is the only backstop.
- The final-review "Ready to merge WITH FIXES" ends in a silent state: the auto-build recorded the verdict and stopped, leaving the Important items to the human. That is correct behaviour for the human-ruling item but not for the Summary GST-number defect, which has an unambiguous fix and a test-first path.
- Missing: a way to carry a "release gate" (like AC-VERIFY-9) into the archive/PR step so that merge-ready and ship-ready are distinct.

### Context File Effectiveness

**Files Loaded**: task file, creative docs, ADR 0021, `_learned/` rules (config composition root, job-queues-pgboss, testing-integration-db-isolation, logging-redaction-global, db-derived-flags-and-gates), `systemPatterns.md`.

**Assessment**:
- **Helpful**: the cross-lane reconciliation block and the binding CR-1..CR-4 block in the task file; they resolved parallel-lane conflicts and were followed.
- **Gaps**: `systemPatterns.md` overstates the snapshot columns (Minor, open). No rule yet about orchestrator interruption recovery or about verifier hazards.
- **Redundancy**: the "New Source Files" list (plan) conflicts with the creative docs in many paths and is explicitly superseded by CR-4. Having two authoritative lists in one file is a trap for any agent that reads only the plan section.

### Memory Bank Organization

**Assessment**:
- **Structure**: task file at about 584 lines with a ~60-line deviation ledger is dense but navigable; the ledger format (`Phase | file | rationale`) is the most useful part.
- **Navigation**: creative docs prefixed with the slug are easy to find.
- **Completeness**: no place records "release gates" (human sign-offs that block production enablement) separate from AC status.

### Guardrail Misses & Root-Cause Analysis

No `### Guard & Recovery Log` exists in the task file, and `git log` shows no amended or retry commits, so there were no commit-guard FAILs. Re-invocation events existed but were not guard flags:
- **Phase 5 HALT -> remediation 1.** First attempt asserted AC-INTEGRATION-2 partially. Root cause: the Implementation Roadmap line for Phase 5 paraphrased the AC more loosely than the AC itself (a lossy phase brief), and the orchestrator built to the roadmap line. This is a plan-authoring cause, not stale memory-bank guidance.
- **Phase 4 interruption.** Not a guard miss; an environmental/orchestrator limit. 44 uncommitted files and a live backgrounded verifier were reconciled by a second orchestrator.
- **Verifier overreach (openapi revert, no exit codes).** Recurrent across phases (and already in project memory), which by the "same mistake, many agents" heuristic points at the verifier instructions, not at the agent.

### Memory-Bank Corrections (from Guardrail Misses) - ACT ON THESE

| File · section | Current (stale/wrong) | Correction | Evidence |
|---|---|---|---|
| `memory-bank/systemPatterns.md` · invoices / snapshot section | Overstates the snapshot columns relative to the shipped `payment_documents` schema | Rewrite from the migration `20261110000100000_tax_invoices.sql` as the source of truth; list actual columns, `layout_version`, `is_tax_invoice_issued` generated column and `paid_at` freeze | Final review Minor finding |
| `memory-bank/tasks/tax-invoices-and-exports.md` · Implementation Roadmap, Phase 5 | Roadmap line weaker than AC-INTEGRATION-2 | Replace paraphrased AC text in phase lines with "ACs verbatim by id; build to the AC, not this line" (plan template change, see Improvements) | Phase 5 HALT and remediation 1 |
| `memory-bank/techContext.md` · test/dev commands | No note on the E2E overlay or that the worktree has no `.env` | Document `docker-compose.e2e.yml` (`-p sgm-e2e`, ports 3100/4100/5532/1125/8125), `-c apps/web/playwright.config.ts`, and that `scripts/setup.ts` generates the worktree `.env` | Phase 5 deviations (env friction, localhost:3000 leak) |
| `memory-bank/systemPatterns.md` · Testing / flaky tests | No flaky-test register | Add: `registrations-sse` "session PUT promotes first-fit" (row-lock timeout, 2+ recurrences) and `invoices-schema`/`billing-schema` migration round-trip under load | Phase 2, 4, 5 deviations |

### Suggested Improvements to Claude Code System

**High Priority**:
1. Auto-build should auto-fix Important findings that have an unambiguous, test-first fix (e.g. the Summary GST-number fallback), and only escalate findings that need a human ruling. Today both Important items are "not addressed autonomously".
2. Verifier agent: forbid `git checkout`/`git restore` on tracked generated files (`openapi.yaml`), require foreground execution (never return an interim verdict) and require lint, typecheck and build exit codes in every verdict. All three recurred this build and the openapi revert is already in project memory.
3. Resumable orchestrator contract: an orchestrator that is interrupted should leave a checkpoint commit (or `WIP` stash) before long verifier runs, so a successor does not inherit 44 uncommitted files and a live backgrounded process.

**Medium Priority**:
1. Per-phase reviewer should receive the phase's ACs verbatim by id and be required to map each MUST to an assertion (this is what caught Phase 5); the plan step should do the same and not paraphrase ACs in roadmap lines.
2. Provide a portable `timeout` shim (or detect `gtimeout`/`perl`) for the Codex wrapper so the per-phase Codex review does not silently degrade to Anthropic on macOS.
3. Add a "release gates" field to the task file (e.g. AC-VERIFY-9) that `/yay:archive` surfaces in the PR body as a blocking checklist item.
4. Flaky-test register: when a test fails once and passes on re-run, auto-append a structured entry so recurrences are counted rather than rediscovered per phase.

**Low Priority / Nice to Have**:
1. Allow the Codex companion to run DB tests via an allowed temp dir, or document that DB-test verification always falls to the verifier.
2. Create the `.agent-logs/claude/by-task/<slug>/` index during auto-build so reflection can report tool metrics.

---

## Open Follow-ups

**Important (must resolve before merge)**
1. **Summary GST-number fallback (`apps/api/src/modules/income-exports/service.ts:213-216`).** The fallback to the team's current `gst_number` is applied to non-empty exports, so a team that registered later shows its current GST number on a historical (unregistered-period) export. Restrict the fallback to `rows = 0` (as the Phase 4 fix intended), and add a test-first integration test: registered now, unregistered export for a past period with rows, and the empty case.
2. **Production gate on AC-VERIFY-9.** Issuance is a one-way door (CR-2). Record a human ruling (ADR 0021 and the task file) that enabling production payments (Akahu live) is gated on accountant sign-off of the specimens and the wording/numbering rulings (H4, H5, H6, H10, H12, R1 format, "Tax invoice" capitalisation). Surface it as a release gate in the PR.

**Minor / Deferred**
3. Pin layout-1 render output (e.g. glyph/box snapshot or a golden text-layout assertion) so a pdfkit or font change cannot silently alter issued layouts.
4. On-demand class-23 failure should return a stable code (not 500) and break the 15-minute failure loop (cooldown or dead-letter with a logged reason).
5. Correct `systemPatterns.md` snapshot wording; add the flaky-test and E2E overlay notes (see Corrections).
6. Add the algorithm doc's `EXPLAIN` index-plan test and the both-order snapshot-consistency variant.
7. Deferred UX polish: post-download status line and `x-export-row-count` use; dual-field GST period; hide or annotate the GST option for unregistered teams; default GST radio for registered teams.
8. Payment page shows the invoice number only after the next view following an on-demand download (the journey reloads); consider showing it in the redirect landing.
9. Migration comment wording, `NOT VALID/VALIDATE` simplification, revoke `EXECUTE` on `assign_invoice_number` from the app role, and ADR 0021 statement that production never called `assign_invoice_number` before.
10. Pre-existing vulnerable dependencies (`next`, `zod`) - track separately; not introduced here.
11. Triage the recurring `registrations-sse` first-fit lock-timeout flake and the migration round-trip flake under load.

---

## Key Learnings

### Extractable Learnings (for Continuous Learning)

1. **testing-patterns** (`*.int.test.ts`, `apps/api/test/`): Add a boundary test per single-writer rule and prove each rule detects a deliberate violation, not just passes on clean code.
2. **db-migrations** (`db/migrations/`): Preflight legacy rows and raise with the offending ids instead of clearing or rewinding counters, and make the down migration refuse once immutable records exist.
3. **resource-bounds** (`apps/api/src/lib/db/`, export routes): Never draw cancellation or cleanup work from the same pool the cancelled work holds; use a dedicated short-lived connection fired without awaiting.
4. **review-process** (`memory-bank/tasks/*.md`): Put each MUST AC into the phase brief verbatim by id; paraphrased roadmap lines let a phase pass its own checks yet fail the AC.
5. **fallback-semantics** (`apps/api/src/modules/income-exports/`): Apply "current-state" fallbacks only for empty results, never to historical rows that carry their own snapshot values.

Limits for Level 3: the list is capped at 2-4 entries. The five above should be consolidated to the top four at archive (drop or merge 5 into 4 as appropriate).

### Learned Rules Applied

- `config-composition-root.md`: applied. New env vars (`INCOME_EXPORT_*`) and the required `AppDeps.incomeExports`/`cancelBackend` follow the composition-root rule.
- `job-queues-pgboss.md`: applied. The `issue-invoices` per-team singleton, `NonRetryableJobError`, and the interval-sweep DST guard behaviour.
- `testing-integration-db-isolation.md`: applied; the integration flakes show its limits under parallel load.
- `db-derived-flags-and-gates.md`: applied. `is_tax_invoice_issued` is a generated column overridden to `never` in Kysely.
- `logging-redaction-global.md`: applied (ids, counts and kinds only; `sqlState` field).
- `api-write-idempotency.md`, `testing-injected-clock.md`, `review-process-plan-claims.md`: loaded; `review-process-plan-claims.md` is directly relevant to the Phase 5 roadmap-line gap.
- `git-worktree-attached-head.md`, `auth-session-issuance.md`: loaded but not applicable.

### For Claude Code Workflow

1. A design critique by a second model before build earns its cost on irreversible schemas; require it for any migration that touches existing rows or numbering.
2. Reviewer gates must test against the AC text, not the plan summary; the one HALT in this build came from exactly that mismatch.
3. Long mechanical verification (full suite, build, lint) must be foreground and exit-code-reporting; interim verdicts and revert-on-verify behaviour broke trust in the verifier three times.
4. Distinguish "ready to merge" from "ready to ship": human-gated release controls need a first-class home in the task file and the PR.

---

## Conclusion

The task delivered a well-designed, thoroughly tested, one-way-door-aware feature. The design process (four creative lanes, a model-independent critique and explicit rulings) and the per-phase reviewer gate were the highlights, and both prevented real defects (the legacy numbered-row migration trap, the pool-deadlock cancel, the AC-INTEGRATION-2 gap). The weaknesses are small but real: a historical-export GST-number defect, a not-yet-recorded release gate on accountant sign-off, and verifier behaviours that recurred across phases. The branch should not be merged until the two Important follow-ups are closed, and production payment enablement must remain blocked on AC-VERIFY-9.

**Overall Task Success**: ⚠️ Partial Success (build complete and high quality; two Important items open)

**Overall Workflow Effectiveness**: ✅ Highly Effective (with verifier and orchestrator-recovery fixes recommended)

**Recommendation**: Needs follow-up. Fix the Summary GST-number fallback test-first, record the AC-VERIFY-9 production gate ruling, then archive. Keep ADR 0021 Proposed until accountant sign-off.
