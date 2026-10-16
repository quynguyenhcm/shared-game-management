# Reflection: team-banking-and-gst - Team Banking and GST

**Date**: 2026-10-17
**Task Complexity**: Level 3
**Total Phases**: 5 (all complete) plus a final whole-branch review and a post-review fix commit
**Duration**: 2026-10-16 (plan, creative, critique, reconciliation, five build phases) to 2026-10-17 (final review fixes). 16 commits, 99 files, +15,091 / -261 lines vs origin/main.

## Executive Summary

team-banking-and-gst gives a team admin an area at `/teams/<id>/manage/banking` to store an encrypted bank account (name and number, last 4 shown), a single GST number with a registered toggle, and a change email to every approved admin. It also ships the publish gate that session-scheduling-engine will call: `assertTeamCanPublishPaidSession`, a `game_session_is_paid` SQL twin, a `game_sessions` publish trigger, and a removal guard (`banking_in_use`). The database carries the invariants (CHECKs, a generated `is_payout_configured`, `payout_blocked_at`, two triggers, a 32-key `banking_change_keys` replay array). The spec's 43 ACs were materially reshaped by the creative reconciliation (R1-R12), so the shipped feature differs from the spec in scope: no Akahu credentials, no IRD field, AC-ASYNC-1 promoted to MUST, AC-ERROR-15 added.

Final state: unit 1030, integration 357 (35 files, three consecutive full runs of 354 with no flakiness before the last fixes), coverage gate PASS (`team-banking/**` 99.37% lines, `nz/**` 100%), Playwright 14/14 (7 journeys x 2 viewports, axe critical and serious both fail). One Important defect escaped to the final review: a no-op save did not claim its `changeKey`, so the D-54 replay protection still had a gap. That is the same class of bug the Phase 2 Codex P1 fix was meant to close. It was fixed at the user's request with a regression test.

Overall: success. The pre-build pipeline (spec, four creative docs, Codex critique, binding reconciliation, four user decisions) was the strongest part and removed two product-level ambiguities and one race before any code existed. The weak spots are the same ones team-management exposed: per-phase reviewers verify the phase, and the final review still finds what the phases miss. The learned rules were followed this time (scoped critique, binding reconciliation, redaction collision grep), and they prevented a repeat of the team-management regression.

---

## Dimension 1: Task Implementation Quality

### Requirements Achievement

**Status**: Met as amended (⚠️ with one open reproduction gap noted below)

- All five phases checked off; each phase review returned PROCEED. The 43 spec ACs were applied through R1-R12, which override the spec where they conflict.
- Scope changes that were decisions, not drift (user-approved 2026-10-16): R1 bank account only (drops `akahu_merchant_id` and `akahu_app_token` from this feature; AC-ERROR-4, AC-HAPPY-1/2/3, AC-VERIFY-2/3/13, AC-INTEGRATION-1 token cases removed); R2 single GST number (IRD field, `irdNumberLast3`, IRD decrypt paths removed); R3 `payout_blocked_at` with new AC-ERROR-15; R6 summary-then-Change editing with `?edit=` and `?notice=`; R8 AC-ASYNC-1 from COULD to MUST with audit columns.
- The task file's spec text was not rewritten to match R1-R12, so a reader of the 43 ACs alone sees obsolete token and IRD criteria. The binding section is correct, but the ACs and the Verifiable-at copy table (which still lists Akahu strings) are stale. Phase 4's copy deviation entry (line 773) records this friction.
- Reproduction gap: Playwright was not re-run after the 2026-10-17 fixes (GST form checkbox, removal banner, `changeKey` on PUT /gst). Component and action unit tests cover those changes, but the browser journeys for the changed UI are unproven on the final head.
- AC-VERIFY-13 token-input check became "no password input on the page" (Phase 5 deviation). AC-ERROR-13 (5xx path) stays unit-tested only.

### Code Quality Assessment

**Overall Rating**: Good (Excellent on DB and lock design; Fair on one replay-claim gap that survived five reviews)

- **Maintainability**: Clear slice `modules/team-banking/{routes,service,repo,emails,errors,publish-gate}.ts`; shared pure validators in `packages/shared/src/nz/`; `admin-lock.ts` and `lib/auth/team-refusals.ts` extracted so teams and banking share one lock/refusal path. Ledger D-47 onward and ADR 0016 record the contracts. Minor duplication (`field`/`requireSession` in `banking-actions.ts`) is forced by `'use server'` export rules.
- **Architecture**: Lock protocol (R4: gate and trigger `FOR KEY SHARE`, PUTs `FOR NO KEY UPDATE`, DELETE `FOR UPDATE` first) is sound, and C-BIL-PAY extends it to payment creation, which closed the critique's high race. The generated `is_payout_configured` removes drift by construction.
- **Error Handling**: Errors mapped by `err.constraint`; a decrypt failure answers safely and a full save recovers (R7); replay returns 200 with current state and sends nothing. The residual gap was the no-op path (fixed `claimChangeKey`).
- **Testing**: Strong. Vectors for the validators trace to the IRD 2026-27 spec; the TS and SQL paid rule share one fixture matrix; race tests use lock waiters (both orderings, including a COMPLETED session); an upgrade test seeds every partial shape; log assertions check fields, not event presence. Gaps: no jsdom, so interactive behaviour relies on reducer/static-markup tests plus Playwright; banking and GST components sit outside the coverage include.

### Technical Decisions

**Key Decisions:**
1. **Bank account only, no team Akahu credentials (R1, 3C)** - the architecture agent found Akahu has no "merchant ID"; the critique found 3C contradicted the task text. The user chose 3C explicitly. Outcome: smaller secret surface, simpler page, but wallet-and-akahu-billing now owns platform credentials and must be told. Verdict: good, with the spec text left stale.
2. **`payout_blocked_at` plus generated `is_payout_configured` (R3)** - answers the critique's "nothing revokes publish eligibility when payouts fail". Outcome: gate, trigger and UI all key off one column; adds a contract that billing must honour (ADR 0016).
3. **Removal under `teams FOR UPDATE` with `team_banking_in_use` (R4)** - found because the architecture agent saw that the spec's lock design let a raw publish race a removal. Outcome: both orderings tested deterministically.
4. **32-key `banking_change_keys uuid[]` (D-54)** - the coordinator suggested a single last-key column; the build agent correctly rejected it because a single key cannot recognise a replay after a different admin saved in between. Outcome: correct, but the claim was not applied on the no-op path until the final review.
5. **IRD algorithm from the 2026-27 spec, not the 2014 one (R9)** - the spec's 2014 source was offline; the algorithm agent used the current IRD spec, pinned the 150000026 erratum, and set the range 10,000,000 to 200,000,000.
6. **Change email goes to every approved admin, actor included (R8, later aligned in docs a8166aa)**.

**Trade-offs:**
- Permissive IRD range vs risk of blocking a real team: chose permissive, with the check digit as the real guard.
- Summary-then-Change vs always-visible form: more states and Playwright cost, but removes the write-only-field ambiguity and matches the journey doc.
- GET still decrypts the full account number to detect damage (AES-GCM proves integrity only by decrypting): accepted, plaintext never leaves `present()`.

### What Went Well

1. **Plan-time code check** caught a real break (`insertSession` defaults to a paid session; `session-instants.int.test.ts:67`) and an ADR/ledger numbering collision with registration-and-waitlist (both planned ADR 0016 and D-47+). Both were fixed in the plan, not discovered in build.
2. **Creative agents found things the spec author could not:** the offline IRD source, the missing Akahu merchant ID, and the removal-vs-publish race. The Codex critique, scoped correctly this time (`--base origin/main --scope branch`), found 4 high and 3 medium issues, including a payment-creation vs removal race and incompatible UI and journey edit models.
3. **Binding reconciliation worked** (learned rule applied): build agents read one ruling per conflict, and the user made four decisions at one checkpoint instead of many.
4. **Deterministic races, no flakiness:** integration ran 354/354 three times in a row.
5. **Redaction blast radius handled up front:** the collision grep ran before the patterns landed, anchored regexes were used, and log events use `changedFields` instead of `replaced*` (which `/token$/` would have redacted). No repeat of the team-management regression.
6. **Build agent overruled a wrong coordinator suggestion** on the replay fix with a correct 32-key design.

### Challenges Encountered

1. **Phase 2 orchestrator handed back ESCALATION before its code reviewer reported** - process slip, not a failed gate; re-dispatched to resume at Step 8. Cost one extra orchestrator invocation.
2. **Phase 3 had no Codex review** (Codex returned no verdict). Anthropic-side review only; the final review was meant to cover it and did not flag anything in that phase.
3. **Phase 3 post-review edits skipped the integration re-run** (only unit, lint, typecheck). Closed in Phase 4/5 by full runs, but for one phase the head was unverified.
4. **Stray `.vitest/` report broke `prettier --check`.** A delete was denied by the user's permissions, so it was added to `.gitignore` and `.prettierignore` instead (Phase 5). Resolved without deleting.
5. **Process slips against repo rules:** one `cd` compound command and Python file edits through Bash.
6. **`schema-deviations.md` formatter churn** widens the whole markdown table and makes the diff noisy; reverting fails `prettier --check`. Not changed.

### Technical Debt & Future Work

- Update the task file's spec ACs and copy table to match R1-R12 (or note at archive that R1-R12 supersede), so downstream readers (wallet-and-akahu-billing, tax-invoices-and-exports) do not read obsolete token and IRD criteria.
- Re-run `apps/web/e2e/team-banking.spec.ts` on the final head before merge.
- wallet-and-akahu-billing must implement: set `payout_blocked_at` under the team-row lock, `FOR KEY SHARE` plus `is_payout_configured` before any payment insert (C-BIL-PAY), snapshot `payments.gst_number` at charge time, own platform Akahu credentials. All recorded in ADR 0016.
- session-scheduling-engine: call the gate before any `game_sessions` lock; recurrence materialiser creates a refused instance as DRAFT and sends at most one admin email per rule per run window.
- Annual April review of `nz/*` tables (ADR 0016).
- Pre-existing platform item: pg error `detail` is logged unredacted.
- Banking and GST components are outside the coverage include; consider adding a jsdom harness (also noted in team-management).

---

## Dimension 2: Claude Code Ecosystem Effectiveness

### Build Session Analysis

**Build Sessions**: 1 `/yay:build --auto` run (5 phases) plus one re-dispatched Phase 2 orchestrator and a post-review fix pass.
**Sub-Agents Spawned**: about 35 estimated (spec writer 1; creative 4; Codex critique 1; per phase: orchestrator, TDD, verifier, code reviewer, phase reviewer; documentation in Phase 5; final reviewer 1). Estimates only; they come from the task file.
**Tool Calls**: not measurable. `.agent-logs/claude/by-task/team-banking-and-gst/` does not exist (only `FEAT-001`, `TASK-001`, `TASK-007` legacy directories). The same limitation was recorded in the team-management reflection and remains unfixed.
**Errors Recovered**: 1 orchestrator hand-back slip, 1 missing Codex verdict (Phase 3), 1 Phase 2 Codex P1 (replay), 1 Phase 4 Codex P2 (banner wording), 1 Phase 5 Codex P3 (stale doc), 1 final-review Important plus 7 minors.

#### Tool Utilization

Not extractable without task-indexed logs. From the task file: verifier runs lint, typecheck, unit, integration, coverage and build each phase; Phase 5 ran the E2E natively against a temporary database `sgm_e2e_banking`. Process slips (one `cd`, Python edits via Bash) went against the repo's tool rules.

#### Sub-Agent Performance

| Agent Type | Invocations | Model | Effectiveness |
|------------|-------------|-------|---------------|
| Spec Writer | 1 | Sonnet | High: 43 ACs, taxonomy lint clean first try; but its 2014 IRD source and Akahu model were wrong, caught by creative |
| Creative (algorithm, architecture, journey, UI/UX) | 4 parallel | Opus/Sonnet | Very high on discovery (offline source, Akahu model, lock race); the same overlap and conflicts as team-management, resolved by the binding section |
| Codex design critique | 1 | Codex | Very high: 7 findings, 4 high; correct scope this time |
| Build orchestrator | 5 plus 1 re-dispatch | Sonnet | Good; Phase 2 handed back before its reviewer reported |
| TDD agent | 5 | Sonnet | Effective; correctly overruled a wrong coordinator replay design (D-54) |
| Verifier | 5 plus final | Sonnet | Reliable; no load-induced false failure this time |
| Code reviewer (Codex) | 4 of 5 phases | Codex | Found 3 real defects (P1 replay, P2 banner, P3 doc); Phase 3 returned no verdict; Phase 5 ran on working-tree scope |
| Phase reviewer | 4-5 | Sonnet | Fast gate; accepted ledger deviations; did not generalise the Phase 2 replay fix to the no-op path |
| Documentation agent | 1 (Phase 5) | Haiku | Verified claims against code; recorded spec-vs-code differences |
| Final whole-branch reviewer | 1 | Codex | Found the one Important and 7 minors; again the only gate that caught a cross-phase gap |
| Batch Test Agent | 0 | n/a | Not used in auto-build |

### Command Workflow Evaluation

**Commands Used**: `/yay:plan`, `/yay:creative` (with critique and reconciliation), `/yay:build --auto`, final review, fixes at user request, `/yay:reflect`.
**Workflow Efficiency**: Good

- Complexity Level 3 was accurate (43 ACs, 5 phases, 4 creative docs, 34 ledger entries).
- The pre-build front end earned its cost. The only thing that hurt later was that the reconciliation overrides the ACs instead of rewriting them.
- Auto-build replaced per-phase human review with reviewer agents; the single human gate was the pre-build decision checkpoint, which was the right place.
- No `/yay:uat` run; Playwright specs were written directly in Phase 5.

### Context File Effectiveness

**Files Loaded**: task file, four creative docs, ADR 0015/0016, level-3 rules, systemPatterns, techContext, learned rules (`review-process-plan-claims`, `logging-redaction-global`, `testing-injected-clock`, `testing-integration-db-isolation`, `job-queues-pgboss`).

- **Helpful**: Creative Reconciliation as binding input; per-phase "Handoff" notes in Completed Steps (named helpers and constraint names such as `teams_banking_in_use`); learned rules for redaction and critique scope; the Deviations ledger for traceability.
- **Gaps**: No convention for merging reconciliation back into the spec ACs; the copy table in the task file went stale (Akahu strings). The task file is about 92 KB, which makes the binding section hard to find without knowing it exists.
- **Redundancy**: Four creative amendment tables overlap; R12 re-lists them by reference.

### Memory Bank Organization

- **Structure**: Adequate. The collapse (`pr_target == metadata_branch`) kept everything on one branch.
- **Navigation**: Weak at 92 KB per task file. Reflection had to grep headings to locate sections.
- **Completeness**: The Execution State "Final Review Fixes" entry is good; the "Guard & Recovery Log" section was not present in the task file as read, so guard verdicts cannot be audited from it (see below).

### Guardrail Misses & Root-Cause Analysis

No commit-guard FAIL is recorded in the task file (the task file as read contains no `Guard & Recovery Log` section, so absence of a FAIL is inferred from the Completed Steps and the deviation ledger, not from a guard log). Re-invocations and misses:

1. **Phase 2 orchestrator hand-back before the code reviewer reported.** What went wrong: the orchestrator escalated while a reviewer was still running. Why: not stale guidance; a hand-back condition in the orchestrator prompt that treats "reviewer pending" like a blocker. The fix that worked was re-dispatch at Step 8. Prevention: the orchestrator must wait for all dispatched reviewers before returning ESCALATION.
2. **Phase 3 Codex review returned no verdict.** Accepted as Anthropic-only with a ledger entry. Root cause: Codex flakiness. The final review covered it. This is a degraded gate, not a failure.
3. **Phase 3 post-review edits skipped the integration run.** Root cause: the build step list re-runs only unit, lint and typecheck after review fixes, unless the orchestrator chooses otherwise. It was closed by Phase 4/5 full runs.
4. **Final-review Important (no-op save does not claim `changeKey`).** What went wrong the first time: the Phase 2 fix for the Codex P1 closed replay for saves that change something and did not apply the claim to the no-change branch (`service.ts:225-227`). Why: the Phase 2 review prompt asked "is the P1 fixed?", not "does every code path that returns 200 claim the key?"; the ledger entry for Phase 2 (line 758) explicitly describes an identical re-save as a no-op without noting the claim. The coordinator's own suggested fix (a single last-key column) was also wrong, so two agents misjudged the same area. This is the same pattern as team-management's redaction regression and the learned rule `review-process-plan-claims` (per-phase reviews check the phase, not the invariant across paths). Prevention: when a review finding names an invariant ("every request with key K is idempotent"), the fix review must enumerate all return paths of the handler and assert the invariant on each (success, no-op, refusal, replay).
5. **GST had no replay protection at all** (PUT /gst had no `changeKey`) and **no way to clear a GST number**: both missed by spec, creative and all phase reviews; found only by the final reviewer. Root cause: the replay and clear semantics were designed for banking in the architecture doc and never stated for GST. The spec treated GST as a simple toggle.

Clean parts: no redaction collision; no `replaced*` field redacted; the learned rules were read and applied.

### Memory-Bank Corrections (from Guardrail Misses) — ACT ON THESE

| File · section | Current (stale/wrong) | Correction | Evidence |
|---|---|---|---|
| `agent-rules/_learned/review-process-plan-claims.md` | Covers cross-phase invariants and global changes; no rule for idempotency or replay claims across all return paths | Add a bullet: after a review fix for replay/idempotency, enumerate every return path of the handler (changed, no-op, refused, replay) and test the claim on each; bump `evidence_count` to 4 and add `team-banking-and-gst` to `derived_from` | Final-review Important 1; Phase 2 ledger line 758 described the no-op without claiming the key |
| `memory-bank/tasks/team-banking-and-gst.md` · Specification (do not edit during reflect; handle at archive) | 43 ACs and the copy table still describe Akahu token, IRD field and the optional email | Archive note: R1-R12 supersede the spec ACs; list AC groups removed or promoted so downstream readers do not rely on them | R1, R2, R8 vs the AC text; Phase 4 copy deviation (line 773) |
| `systemPatterns.md` / `techContext.md` · Test and verification notes | Not verified whether it states that Playwright needs a manual native stack and is not re-run by `ci` | Document the native E2E recipe (temp DB, `AUTH_FAKE_OAUTH`, `ENCRYPTION_KEYS`, `API_INTERNAL_SHARED_SECRET`, `WEB_BASE_URL`, `E2E_DATABASE_URL`) from Execution State line 744 so fixes after Phase 5 can re-run it | Playwright not re-run after the 2026-10-17 fixes |
| `techContext.md` · Akahu row | Described "credentials stored, no client yet" in the plan (AC-VERIFY-14) | Per R1, state that teams store no Akahu credentials; the platform's app credentials are server config owned by wallet-and-akahu-billing; the `akahu_*` team columns are reserved and unused | R1 |

### Suggested Improvements to Claude Code System

**High Priority**:
1. **Final-review "all return paths" checklist in the phase reviewer prompt:** when a ledger entry or a review finding mentions replay, idempotency, lock or claim semantics, require the reviewer to list each handler return path and cite a test per path. Prevents the D-54 gap recurring.
2. **Orchestrator must not hand back ESCALATION with reviewers pending.** Add an explicit "all dispatched sub-agents have reported" precondition to the build-orchestrator hand-back rules.
3. **Reconciliation should feed back into the spec:** after `/yay:creative` writes the binding section, offer to rewrite the affected ACs and copy tables (or mark them superseded) so the task file has one truth. Today build agents must hold both.

**Medium Priority**:
1. **Re-run the integration suite after any post-review edit that touches non-test code**, not just unit/lint/typecheck; record the reason if skipped (Phase 3 skipped it).
2. **Codex review with no verdict should retry once with an explicit commit range**, as Phase 4 did, instead of falling back to Anthropic-only; and Phase 5's working-tree scope review should have used a range. Log the scope used.
3. **Task-scoped session logs for v2 slugs** (`.agent-logs/claude/by-task/<slug>/`) so reflection can extract tool metrics. Missing for the second feature in a row.
4. **Split the 92 KB task file:** keep the plan, creative reconciliation and ledger in the task file; move per-phase build logs to a sibling file, so a reader can open the binding section directly.

**Low Priority / Nice to Have**:
1. Put `.vitest/` (and other test report dirs) into the `.gitignore` template during `/yay:init` so no phase needs a housekeeping deviation.
2. Add a build-agent lint for the tool rules (no `cd &&`, no file edits via Bash/Python) since both slips recurred.
3. Make the Documentation agent's spec-vs-code difference note a standing section of the reflection input.

**Note**: Suggestions only; nothing was implemented.

---

## Key Learnings

### Extractable Learnings (for Continuous Learning)

Level 3: max 4. Each states whether it confirms an existing rule or is new.

1. **review-process** (`memory-bank/tasks/*.md`, `apps/api/src/modules/**`): After a review finding about replay, idempotency or claim semantics, enumerate every return path of the handler (changed, no-op, refused, replay) and require a test that asserts the claim on each. *Extends existing rule `review-process-plan-claims` (the per-phase-misses-cross-path-invariant theme); evidence from this task: a no-op save skipped the `changeKey` claim after the Phase 2 fix.*
2. **api-design** (`apps/api/src/modules/**/service.ts`, `packages/shared/src/api/`): When a write endpoint takes a per-render idempotency key, give every sibling write endpoint of the same page (not only the headline one) the same key and the same claim-under-lock rule, and define a way to clear optional fields (`null`) in the contract. *New.*
3. **data-integrity** (`db/migrations/`, `apps/api/src/modules/**`): Derive "is configured" style flags as generated columns and add a separate nullable timestamp (`payout_blocked_at`) for externally detected failure, so the gate, trigger and UI read one source; backstop any service-level gate with a SQL trigger and a shared SQL predicate used by both. *New.*
4. **creative-process** (`memory-bank/creative/`, `memory-bank/tasks/*.md`): Run the scoped Codex critique and write one binding reconciliation, then record user decisions at a single checkpoint before the first build phase; also rewrite or mark superseded the spec ACs and copy tables the reconciliation overrides. *Confirms existing rule `review-process-plan-claims` (scoped critique and binding reconciliation bullets); the "rewrite the ACs" part is new.*

Also confirmed without a new learning: `logging-redaction-global` (collision grep before adding patterns; anchored regexes; `changedFields` instead of colliding `replaced*` names) was applied and prevented a repeat; `testing-integration-db-isolation` (real multi-connection races, lock waiters, per-file clones) was applied across the gate and removal races.

### Learned Rules Applied

- `review-process-plan-claims.md`: Applied and effective for critique scope (`--base origin/main --scope branch`) and the binding reconciliation. The "global change" bullet was applied for logger redaction. Not sufficient for the replay-claim gap, which is a cross-path invariant inside one handler; candidate `evidence_count` bump to 4.
- `logging-redaction-global.md`: Applied (AC-VERIFY-4, R10): collision grep on main was clean; field-by-field log assertions in `team-banking-logs.int.test.ts`. Confirms the rule; candidate `evidence_count` bump to 2.
- `testing-injected-clock.md`: Loaded; the plan told verifiers to re-run timing-only failures sequentially. No load-induced failure this time, so no new evidence.
- `testing-integration-db-isolation.md`: Applied (per-file template DBs, real multi-connection races with `waitForLockWaiters`); candidate `evidence_count` bump.
- `job-queues-pgboss.md`: Applicable to the `send-email` job per admin enqueued in the same transaction with a per-recipient idempotency key; consistent with the rule.
- `auth-session-issuance.md`, `git-worktree-attached-head.md`: loaded but not applicable (no worktree; no session issuance).

### For Claude Code Workflow

1. The pre-build pipeline is the highest-leverage part of the system. Four parallel creative agents plus a scoped adversarial critique found product, data-model and concurrency issues that would have been far more expensive after build.
2. Auto-build reviewers are good at "is this phase's finding fixed" and weak at "is the invariant true on all paths". The final whole-branch review remains the real safety net and should never be skippable.
3. A degraded gate (no Codex verdict, skipped integration re-run) is acceptable only when it is ledgered and closed later; this build did that, which is why it cost little.
4. When the user's decisions rewrite scope (R1, R2), the spec text must follow, or the downstream reader inherits obsolete criteria.

---

## Conclusion

team-banking-and-gst delivers a well-constrained feature: encrypted write-only bank details, one GST number, a publish gate enforced in TS and SQL, and a lock protocol proven by deterministic races in both orderings. The creative stage did unusually valuable work and the learned rules from team-management measurably helped (no redaction regression, correct critique scope, binding reconciliation). The one escaped defect was a replay claim missing on the no-op path, a repeat of the pattern where phase reviews verify the phase and not the invariant. It was found by the final review and fixed with a regression test. Remaining follow-ups are the stale spec text, a Playwright re-run on the final head, and the cross-feature contracts in ADR 0016.

**Overall Task Success**: ✅ Success

**Overall Workflow Effectiveness**: ⚠️ Moderately Effective (Highly Effective before build; Moderate during build)

**Recommendation**: Ready to archive after re-running `team-banking.spec.ts` on the final head. Apply the Memory-Bank Corrections at archive, and carry the ADR 0016 contracts into the wallet-and-akahu-billing and session-scheduling-engine plans.
