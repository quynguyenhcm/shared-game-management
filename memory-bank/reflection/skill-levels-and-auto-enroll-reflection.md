# Reflection: skill-levels-and-auto-enroll - Skill Levels and Auto Enroll

**Date**: 2026-10-17
**Task Complexity**: Level 3
**Total Phases**: 5 (all complete, all PROCEED at first review, 0 remediation rounds)
**Duration**: 2026-10-17 10:45 to 16:38 (+13:00), plan, creative, auto-build and post-review fix in one day. 16 commits, 78 files, +12,422 / -160 lines vs origin/main.

## Executive Summary

skill-levels-and-auto-enroll adds admin skill-level override with provenance, a nightly auto-progression job (40 qualifying games in the trailing 365 days moves a member up one level), and the Auto Enroll flag with an optional end date. It also adds the read seams that later features consume: `countQualifyingGames` and `selectAutoEnrollees`, pinned by contract tests and ADR 0017. The database enforces the invariants (paired-override and baseline CHECKs, Auto Enroll cleared when off, approved-only). The job does a keyset pre-pass and then one lock-recount-decide-guarded-UPDATE transaction per candidate. The admin UI is a per-member "Skill and Auto Enroll" panel with two forms. The final combined suite is 1606 passed after the post-review fix, plus 26/26 re-run on the skill-levels suites after the one test-expectation miss.

The most valuable work happened before build. The four parallel creative agents contradicted each other on two points, and one of them found that the spec's "no repricing" claim was false against registration-and-waitlist. The Codex critique added three high and two medium findings. The human decided pricing is snapshotted at CONFIRMED, an expired Auto Enroll renewal goes to the back of the order, and overrides use optimistic concurrency. Everything went into one Binding Reconciliation block that the pre-flight scan then found clean. This is the second feature in a row (after team-management) where that pattern paid off.

The weak point was the same one the learned rules already name. All five phase reviewers passed, and only the final whole-branch review found that the Auto Enroll PUT was last-writer-wins while the skill-level PUT was guarded, and that `clock.now()` was read before the row lock in both saves. Both fixes landed in 1aa60e1. One Important item is still OPEN: the Compose e2e regression, because Phase 5 ran only on `next dev` and `teams.spec.ts:241` failed, so the promote/demote/ban steps never ran against the new Members row layout.

Overall: the task is a success with one open pre-merge gate. The ecosystem was moderately effective. The creative and binding-reconciliation machinery was highly effective. The per-phase review gate was not a reliable detector of sibling-guard symmetry, and the build harness lacked environment preconditions and a safe hand-back for nested agents.

---

## Dimension 1: Task Implementation Quality

### Requirements Achievement

**Status**: ⚠️ Partial (all 35 spec ACs plus AC-HAPPY-12/13, AC-ERROR-8/9/10 and AC-NAV-1 are implemented and evidenced, but the Compose e2e gate is still open)

- Phases 1-5 are all checked off. Each AC group has an owning phase, and each phase review returned PROCEED.
- Success criteria are met. Overrides record who and when. Progression counts confirmed sessions that have ended, excludes charged late withdrawals, and counts no-shows. An override resets the window baseline. Auto Enroll is cleared on ban and expired renewals go to the back of the order.
- Creative and critique decisions were applied through amended ACs: AC-HAPPY-13 (expired renewal), AC-ERROR-9 (stale override, 409 `skill_level_stale`), and later AC-ERROR-10 (stale Auto Enroll, 409 `auto_enroll_stale`).
- Not met or open:
  - The Compose e2e run (`pnpm run test:e2e`) has not been done. `teams.spec.ts` steps after line 241 did not run against the new `member-list.tsx` row layout. The failure itself (`cache-control` no-cache vs no-store under `next dev`) was judged an environment artefact, but that judgement is unverified.
  - C-PRICE-1 (pricing snapshot at CONFIRMED) and the allocator re-check (decision 5) are obligations on registration-and-waitlist and session-scheduling-engine. They are recorded in ADR 0017 and the contract test header, and this feature cannot prove them.

### Code Quality Assessment

**Overall Rating**: Good (Excellent on DB invariants, race design and the seam contracts; Fair on cross-endpoint guard consistency until the final review)

- **Maintainability**: A clean `skill-levels` module split (`routes, service, repo, games, auto-enrol, progression, decisions, errors`) with a `boundaries.test.ts`. One predicate builder backs the single-member count, the per-page batch count and the sweep pre-pass, with a parity test. Web logic is pulled into `skill-levels-view.ts` (+33 tests).
- **Architecture**: Lock order is explicit (team row first, then the member row `FOR NO KEY UPDATE`, with `lock_timeout` 2s on PUTs and 5s in the job). The window is computed in TS and bound as a parameter. Baseline timestamps are read as text under the lock to keep microsecond precision. Seams take no locks and have a non-blocking proof test.
- **Error Handling**: Typed stale errors map to 409 with the current member so the panel can refresh. The job isolates per-member failures and fails the run if `failed > 0`. Gaps: lock timeout maps to an undocumented 503 (not in route response schemas or OpenAPI), and span events are a no-op (see debt).
- **Testing**: Strong. RED was confirmed each phase. The races are deterministic (a throwaway BEFORE UPDATE trigger waiting on a test-held advisory lock, no production hooks). The seam read paths have real-DB table-driven tests. Weak spots: the Phase 5 e2e is incomplete (above), and the partial-index test is an EXPLAIN with seq scans discouraged, so it proves usability and not planner choice at scale.

### Technical Decisions

**Key Decisions:**
1. **Pricing snapshotted at CONFIRMED (C-PRICE-1)** - This closed the self-override-to-cheaper-tier hole and made the "existing fees don't change" copy true. The cost is an obligation on another branch.
2. **Expired Auto Enroll counts as off; renewal is a new assignment** - The panel, ordering and the journey copy now agree. AC-HAPPY-13 and a contract test pin it.
3. **Optimistic concurrency on both admin writes** - The override got it by design (decision 4). Auto Enroll got it only after the final review, using `expectedEnabled/expectedUntil/expectedAssignedAt` and `MemberStaleError` (replacing `SkillLevelStaleError`).
4. **Window and baseline in the count predicate** - `ends_at in (greatest(now - window, skill_level_changed_at), now]` makes override-resets and surplus-game discard fall out of one predicate. Same-level saves are no-ops, even with stale expectations, so retries are safe.
5. **Allocator re-check (decision 5)** - Auto Enroll opt-out is authoritative at registration time. This is a binding obligation on the later allocator.

**Trade-offs:**
- Admin-only visibility and no player notification in v1: simpler, but a player can be auto-enrolled or levelled without being told. ADR 0017 records the later obligation.
- Forms use `onSubmit` + `startTransition` (not form `action`) because React 19 reset the typed values after a failed action: robust input retention, but both forms need JS.
- Fixed 500-row keyset pre-pass and one transaction per candidate: failure isolation and short locks, at the price of more round-trips than a single set-based update.

### What Went Well

1. Spec to creative to build ran with a clean taxonomy lint, a clean pre-flight plan scan, and 0 remediation rounds across five phases.
2. The creative stage found a cross-feature contradiction (false "no repricing" claim) and the Codex critique found five real issues. All were resolved before any code was written.
3. The Binding Reconciliation block gave build agents one ruling per conflict, so there were no spec-vs-design disputes during build.
4. Real-DB, real-race tests pinned the invariants that matter (lock order, guarded UPDATE, ban-clears-Auto-Enroll).
5. The final whole-branch review found real defects and the user-requested fix landed with ADR, openapi and web copy updated together.

### Challenges Encountered

1. **Nested TDD sub-agent hand-back stalled Phase 3.** The build-orchestrator returned ESCALATION because its TDD sub-agent returned an interim "waiting on background work" result while it was still running. The main loop waited for the final report, committed the task-file edits, and re-dispatched the orchestrator at Step 6. No work was lost, but it needed a manual rescue that auto mode should not need.
2. **Recurring environment flakes.** pg-boss `previewSchedule` timeouts under full-suite load (Phases 2 and 4; the DST-hour guard test needed a 30s timeout) and one node-pg-migrate `checkOrder` error in a combined coverage run. All were pre-existing and unrelated to this branch, but they cost reruns and noise in every verifier verdict.
3. **Verifier FAIL for a missing precondition.** `test:coverage` runs the integration project and needs `DATABASE_URL`. The verifier reported FAIL when it was unset. The orchestrator knew; the verifier did not.
4. **No `.env` for Phase 5 e2e.** Compose api/web could not start, so e2e ran on `next dev`. A cache-control difference then failed a pre-existing spec and hid the rest of it.
5. **One test-expectation miss after the post-review fix.** The logs test did not expect the second `auto_enroll` refusal event. This was fixed and re-run 26/26.

### Technical Debt & Future Work

- **Compose e2e (Important #1, OPEN)**: run `pnpm run test:e2e` on the Compose stack before merge. Pay attention to `teams.spec.ts` promote/demote/ban against the new row layout.
- **Span events are no-ops**: `trace.getActiveSpan()?.addEvent` does nothing because `lib/jobs/jobs.ts` does not make the run span active. Either activate the span in the job runner or drop the claim. The `member_failed` log and the failed job state carry visibility meanwhile.
- **503 undocumented**: add `service_unavailable` to the route response schemas and OpenAPI.
- **systemPatterns.md / techContext.md not updated**: add the skill-levels module, the seam contracts, the `skill-progression` queue and the new constants.
- **Deploy order**: the migration is a precondition for the new API and job. Note it in the runbook.
- **User-deletion FK**: confirm the `skill_level_override_by` FK behaviour on user deletion.
- **Phase 5 UI nits**: off-hint missing from the checkbox `aria-describedby`; the success line persists after re-edit; 502/504 say "Nothing was changed" (not provable); `todayNz` goes stale across NZ midnight.
- **Cross-branch obligations**: C-PRICE-1 snapshot, allocator re-check, and the ADR 0017 / D-55+ renumbering if registration-and-waitlist merges first.

---

## Dimension 2: Claude Code Ecosystem Effectiveness

### Build Session Analysis

**Session logs**: `.agent-logs/claude/by-task/skill-levels-and-auto-enroll/` does not exist. The fallback scan of `.agent-logs/claude/2026-10-17/` found one 4 MB session log (`1043__eacc3c49...md`), but its header carries `Git Branch: feature/team-banking-and-gst` and Task IDs `TASK-007/TASK-001/FEAT-001`, so it belongs to another task. The log index is still on legacy IDs (`by-task` holds only `FEAT-001`, `TASK-001`, `TASK-007`). Session logs are not task-indexed for v2 slugs, and tool counts for this task cannot be extracted. The figures below come from the orchestrator timeline and the task file.

**Build Sessions**: 1 auto-build run (5 phases) plus a main-session post-review fix
**Sub-Agents Spawned**: not countable from logs. Per phase: orchestrator, TDD, verifier and phase reviewer. Plus 4 creative agents, 1 spec writer, 1 final reviewer, and 2 Codex passes (creative critique, final review)
**Tool Calls**: not available
**Errors Recovered**: 1 harness escalation (Phase 3), recurring flakes (pg-boss `previewSchedule`, one `checkOrder`), 1 test-expectation miss after the post-review fix

#### Tool Utilization

Not available (no task-scoped logs). Qualitative: Bash-driven real-DB test runs, `git show`, and Codex via the companion runtime carried the work. Playwright e2e was the only browser-level evidence.

#### Sub-Agent Performance

| Agent Type | Invocations | Model | Effectiveness |
|------------|-------------|-------|---------------|
| Spec Writer | 1 | Sonnet | High. 35 ACs, taxonomy lint clean on the first pass, approved as drafted. |
| Creative (algorithm, architecture, UI/UX, journey) | 4, parallel | Opus/Sonnet | High on content (found the false no-repricing claim); contradicted each other twice, needed reconciliation. |
| Creative critique | 1 | Codex | High. 3 high and 2 medium findings, all real. |
| Build orchestrator | 5 + 1 resume | Sonnet | Good. One ESCALATION from the nested hand-back. |
| TDD agent | 5 | Sonnet | Good. RED confirmed each phase. Interim hand-back in Phase 3. |
| Verifier | 5 | n/a | Mixed. Env-blind (DATABASE_URL), flake-sensitive. |
| Phase reviewer | 5 | n/a | Low recall for cross-endpoint symmetry (0 findings across 5 phases of an Important defect). |
| Final reviewer | 1 | Codex | High. Caught all three Important findings. |

### Command Workflow Evaluation

**Commands Used**: plan, creative, auto-build (with phase gates and a final review), reflect. A user-requested post-review fix was done in the main session.

**Workflow Efficiency**: Good

**Assessment**:
- The plan to creative to critique to reconciliation to auto-build sequence worked and the Level 3 classification was accurate.
- `--auto` removed per-phase pauses and the five phases went through with no remediation rounds. The one stall came from the nested-agent hand-back.
- The post-review fix happened outside the pipeline. That is fine here, but the fix needed its own review (it produced a test miss) and nothing in the flow offered one.
- Missing: a pre-merge "environment gate" step. The Compose e2e gap was recorded in the ledger at Phase 5 and again at the final review, but nothing blocks archive on it.

### Context File Effectiveness

**Files Loaded**: task file (spec, Binding Reconciliation), four creative docs, ADR 0017, systemPatterns, techContext, learned rules (`api-write-idempotency`, `review-process-plan-claims`, `job-queues-pgboss`, `testing-injected-clock`, `testing-integration-db-isolation` and others)

**Assessment**:
- **Helpful**: The Binding Reconciliation block and the learned rules for pg-boss, injected clock and DB isolation. Tests were deterministic from Phase 1 largely because of them.
- **Gaps**: The `api-write-idempotency` rule says sibling writes on one page share the same guard, yet it did not reach the phase reviewers' checklist as a concrete check. The clock-after-lock rule was stated in the job's own design, but there is no learned rule that says "all lock-then-read-now paths, not only the job".
- **Redundancy**: The spec's Test Strategy and the per-phase guidance overlap. This is minor.

### Memory Bank Organization

**Assessment**:
- **Structure**: Four creative docs plus a Binding Reconciliation block in the task file is easy to navigate. The Deviations ledger is rich but long (about 30 entries); the open pre-merge items are buried among notes.
- **Navigation**: `git show` reads from the feature branch work as designed.
- **Completeness**: Missing a place for **pre-merge blockers**, separate from Deviations. An "OPEN gates" list in Execution State would have kept the Compose e2e item visible.

### Memory-Bank Corrections (from Guardrail Misses) - ACT ON THESE

The task's `Guard & Recovery Log` is empty (the commit guard passed first try), so there were no guard FAILs or sub-agent re-invocations in the commit-guard sense. Three agent-level misses did occur and are traced here. The decisive heuristic applies to the first: all five phase reviewers independently missed the same defect, which points to the review instructions and learned rules, not the agents.

| File · section | Current (stale/wrong) | Correction | Evidence |
|---|---|---|---|
| `agent-rules/_learned/api-write-idempotency.md` (and the phase-reviewer checklist) | States that sibling writes on one page share the same guard, but only as prose. Reviewers did not enumerate siblings. | Add an explicit review step: "when a phase adds a write endpoint, list every other write on the same page/resource and confirm each has the same stale/concurrency guard, or record why not." Bump `evidence_count` and `last_validated`. | Auto Enroll PUT was last-writer-wins beside a guarded override PUT. 5 phase reviews and the Codex critique missed it. Final review caught it. |
| `agent-rules/_learned/testing-injected-clock.md` | Covers injecting a clock for determinism. Does not say where in a locking transaction `now` is read. | Add: "read `clock.now()` after acquiring the row lock, never before, in every handler that locks then compares." Add a test that fails if the read precedes the lock. | Both admin saves read the clock before `lockMemberRow` while the job's own rule says after. Fixed in 1aa60e1. |
| `agent-rules/_learned/review-process-plan-claims.md` | Covers plan-vs-tree reconciliation. Does not cover verifier environment preconditions. | Add: "record verifier preconditions (DATABASE_URL for `test:coverage`, `.env` for Compose e2e) in `techContext.md` Development Commands and pass them in the verifier dispatch." | Verifier FAIL on `test:coverage` without DATABASE_URL (Phase 3). Phase 5 e2e could not use Compose (no `.env`). |
| `techContext.md` · Development Commands | `test:coverage` documented without the integration-project / DATABASE_URL requirement. | Document: `test:coverage` runs unit and integration; requires `DATABASE_URL`; `test:e2e` requires the Compose stack and `.env`. | Phase 3 deviation note. |
| `systemPatterns.md` / `techContext.md` | No skill-levels module, seam contract, queue or constants. | Add them (the Documentation step did not run for these). | Final review Minor finding. |

### Suggested Improvements to Claude Code System

**High Priority**:
1. **Nested-agent interim hand-back guard** - In the build-orchestrator, treat a nested sub-agent result containing "waiting", "background" or "will report" as non-final. Poll or wait for the final report instead of returning ESCALATION. Tell the TDD agent explicitly that it must not return while background work is running. Without it, `--auto` needs a human rescue.
2. **Verifier preconditions** - Give the verifier a preflight (`DATABASE_URL`, `.env`, services up) and return `BLOCKED: <missing precondition>` instead of FAIL. The orchestrator should pass known env requirements from `techContext.md` in the dispatch.
3. **Sibling-symmetry checklist in the phase reviewer** - Add a mandatory step: enumerate other writes on the same resource or page and compare guards (stale checks, lock order, clock position). Today this is only caught by the final whole-branch review.
4. **Pre-merge gate list** - Add `### Open Gates` to Execution State (e.g. "Compose e2e green") that `/yay:archive` checks, separate from the Deviations ledger.

**Medium Priority**:
1. **Creative contradiction pass** - Add a lightweight reconciliation step to `/yay:creative`. After the parallel agents finish, a cheap agent diffs their decisions (success-message placement, expired-renewal semantics) and drafts the Binding Reconciliation block for the human. Today the orchestrator does it by hand.
2. **Critique before the user journey is final** - The critique was good, but its findings forced three late AC additions (AC-HAPPY-13, AC-ERROR-9, AC-ERROR-10). Running it on the architecture doc before the journey doc is finalised would cut rework.
3. **Review the post-review fix** - A fix applied after the final review should trigger a short targeted re-review (the logs-test miss shows that it matters).
4. **Task-indexed session logs for v2 slugs** - `by-task/` is still on legacy IDs and the only 2026-10-17 log is for another branch. Reflection cannot compute tool metrics.

**Low Priority / Nice to Have**:
1. **Flake registry** - Record known flaky tests (pg-boss `previewSchedule`, `checkOrder`) so verifiers can classify them as "known flake" without a rerun, and fix the root cause (a larger timeout, or isolate the schedule preview).
2. **Dev-server cache-control parity** - Make the dev-server `cache-control` match production in e2e, or tag the assertion, so a pre-existing spec does not fail for environment reasons.

**Note**: These are suggestions only and are not implemented.

---

## Key Learnings

### Extractable Learnings (for Continuous Learning)

**Learnings for this task:**

1. **concurrency-guards** (`apps/api/src/modules/**/service.ts`, `apps/web/src/**/actions.ts`): When adding a write beside an existing guarded write on the same resource, give it the same stale-check (expected-value compare under the row lock, 409 with current row), and test the stale path.
2. **testing-clock-ordering** (`apps/api/src/modules/**/service.ts`, `apps/api/src/jobs/`): Read `clock.now()` after acquiring the row lock in every lock-then-compare path, and pin the order with a test.
3. **review-process-plan-claims** (`memory-bank/tasks/*.md`): At each phase review, enumerate sibling endpoints and handlers on the touched resource and compare their guards, lock order and clock position, not only the phase's ACs.
4. **verification-env** (`package.json`, `memory-bank/techContext.md`): Record each verification command's environment preconditions (`DATABASE_URL`, `.env`, Compose) and fail fast with a named missing precondition before running.

### Learned Rules Applied

- `job-queues-pgboss.md`: Applied. The exclusive `skill-progression` queue, runtime payload validation and idempotent guarded UPDATE followed it. The `previewSchedule` timeout flake is in the same family.
- `testing-injected-clock.md`: Applied for determinism (the injected clock and the race harness). Not applied for ordering relative to the lock, which is the gap behind final-review Important #3.
- `testing-integration-db-isolation.md`: Applied. Real-DB integration tests and the advisory-lock race trigger were isolated.
- `review-process-plan-claims.md`: Partly applied. The creative stage followed its "binding reconciliation" and cross-feature rules and found the repricing contradiction. Phase reviews did not apply the "invariants earlier phases established" rule to the sibling PUT, and the final review caught it again.
- `api-write-idempotency.md`: The final review cited it. It applied to the Auto Enroll PUT and was met only after the fix.
- `auth-session-issuance.md`, `logging-redaction-global.md`, `git-worktree-attached-head.md`: Loaded, not applicable.

### For Claude Code Workflow

1. A learned rule is not a check. Rules that say "do X consistently across siblings" need to be turned into a reviewer step with an enumerated list, or only the final review will find the gaps.
2. Auto mode needs a non-final-result handshake between nested agents. The Phase 3 stall was a protocol gap, not a work failure.
3. Environment preconditions belong in the dispatch contract. The verifier and the Phase 5 e2e both lost time to missing environment facts the orchestrator or `techContext.md` could have supplied.
4. The final whole-branch review and the creative critique repeatedly found what per-phase gates missed. Keep both. Do not thin them out.

---

## Conclusion

The skill-levels-and-auto-enroll design is sound. The database invariants, the lock-ordered job, the real-race tests and the seam contracts are strong, and the pre-build reconciliation settled a real cross-feature pricing hole. The defects that remained were in consistency across sibling code paths (guard parity and the clock position), and the final review found them. They are fixed and the post-fix suite is green. What remains is environmental: run the Compose e2e before merge, and carry the cross-branch obligations (C-PRICE-1, the allocator re-check) into registration-and-waitlist.

**Overall Task Success**: ⚠️ Partial Success (functionally complete and green; the Compose e2e gate is open)

**Overall Workflow Effectiveness**: ⚠️ Moderately Effective

**Recommendation**: Needs follow-up before archive: run `pnpm run test:e2e` on the Compose stack and record the result. After that, archive. Apply the Memory-Bank Corrections at archive.
