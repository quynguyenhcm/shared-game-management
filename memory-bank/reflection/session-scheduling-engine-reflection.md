# Reflection: session-scheduling-engine - Session Scheduling Engine

## Metadata
- Task: session-scheduling-engine
- Complexity: Level 4
- Duration: 2026-10-20 (all 14 commits, plan through final review, same day) 
- Phases: 6 build phases via one `/yay:build --auto` run
- Branch: feature/session-scheduling-engine, HEAD 97fd32d, fork point 1ee4520, pr_target and metadata_branch main
- Evidence base: task file Execution State and `### Deviations` ledger (read from the branch), `git log 1ee4520..HEAD`, and the orchestrator's authoritative run summary. **Session logs absent**: `.agent-logs/claude/by-task/session-scheduling-engine/` does not exist in this worktree and no fallback scan was done, so tool-call counts and per-tool success rates are NOT reported. Where the template asks for them, figures come from the run summary or are marked n/a. Run /yay:init to enable task-indexed logs.

## Executive Summary

The task delivered the full session scheduling engine: a recurrence-rule and session/court schema (D-70..D-85), a pure shared recurrence core, a one-off and series API, a materialiser with pg-boss recurrence and auto-enrol jobs, an allocator seam for registration-and-waitlist, an admin web UI under `/teams/[teamId]/manage/sessions`, a Playwright journey with axe and an explicit 360 px pass, and ADR 0019. Final counts were 1952 unit, 637 integration and 2/2 e2e tests, with aggregate statement coverage 96.3% and branch 90.0%. Six phases landed as six commits plus three remediation or closing commits, with history linear after a mid-run detached-HEAD incident.

Quality is good and the engine itself is sound, but the build did not finish clean. The final Opus review verdict was "Ready to merge WITH FIXES" with 0 Critical and 2 Important findings that are still open, plus 8 Minor. AC-ERROR-8 (404 vs 403 for another team's session id) is still waiting on a human ruling. Two Important findings are the same defect class: UI state derived from the page of rows already loaded rather than from an authoritative source (a series past `recur_until` still shows Active and can be restarted by PUT; the list banking notice is computed from the loaded page only). The same class caused the Phase 5 HALT (Series list from loaded rows, making AC-ENTRY-2, AC-ASYNC-6 and AC-HAPPY-15 unsatisfiable).

On the process side the auto-build loop worked as a safety net: the per-phase compliance reviewer caught genuine AC gaps the in-phase code reviewers missed, and the final review caught two more. But the loop was catching the same things repeatedly, TDD discipline slipped several times, the Documentation agent was skipped in P2 to P5, and one phase's "pushed" claim was false.

## Goals vs Outcomes

| Goal | Target | Actual | Status |
|------|--------|--------|--------|
| 48 acceptance criteria | all met | all met or reviewer-accepted with ledger entry, except AC-ERROR-8 (404 vs 403, human decision pending) and AC text drift (AC-ASYNC-3 key, AC-HAPPY-10 banner) | warn |
| Recurrence: weekly/fortnightly/monthly, `recur_until`, materialiser | working | delivered; series ended past `recur_until` still displays Active and PUT can restart it (open Important) | warn |
| Single-instance overrides without breaking series | edited instances skipped | delivered with `skipped*` counts and `seriesChangeEffect` | pass |
| Multi-court setup + costing + pricing models | FLAT / BY_SEX / BY_SKILL_LEVEL | delivered; `feesLocked` contract uses `'none'` vs spec `null` (Minor drift) | pass |
| Downstream contracts (registration C-SSE-1..5, banking gate, auto-enrol) | honoured | allocator seam, banking gate, auto-enrol queue delivered; widening hand-off list into ADR 0019 | pass |
| Observability (AC-VERIFY-6) | trace + structured events | delivered after P4 HALT; `sweep_completed` carve-out via human ruling | pass |
| Accessibility / mobile | axe clean, 360 px | axe + 360 px scripted on main screens; screen reader, full Tab walk and moderate/minor axe not verified | warn |
| Test health | green, RED-first | green and high coverage; RED-first slipped (see Process) | warn |

## Phase Analysis

All six phases ran on one calendar day (wall-clock per phase not recoverable without logs).

### Phase 1 (c9291e8): schema, shared core, contracts
223 tests, PROCEED. Established migration D-70..D-85 (D-84 reserved), pure recurrence core, zod contracts and fixture fixes. This phase's migration was later amended in place (see P4), which is why `pnpm db:reset` is now required for any DB that applied the early body.

### Phase 2 (dae608a): one-off API, allocator seam, auto-enrol queue
Reviewer found 2 blocking bugs (PUBLISHED edit into the past, malformed cursor causing a 500). Fixed, but `build` was not re-run after the fixes (DONE_WITH_CONCERNS; P3 verifier later ran the full build and passed). Opened AC-ERROR-8.

### Phase 3 (dd13c74): series and materialiser
72 tests. Part A TDD agent wrote implementation before tests (RED proven afterwards on a clean archive copy). Codex code-review failed to launch (`timeout` is not on macOS), so P3 to P6 used the Anthropic reviewer only. Reviewer flagged `webBaseUrl ?? 'http://localhost:3000'` as a 12-factor violation (deferred, carried).

### Phase 4 (2668987, 22002cd): concurrency, observability, contracts
HALT: `session.lock_retry` and `_exhausted` events missing `teamId` (AC-VERIFY-6). Human ruled a `sweep_completed` carve-out; remediation PROCEED. Found a real 55P03 lock-order bug in `session_courts_guard_closed`, fixed by amending the unmerged P1 migration. 38 race tests were characterization tests, not RED-first. Commits were left on a detached HEAD.

### Phase 5 (5afa293, c7ffa60): admin web UI
HALT: the Series list section was derived from loaded rows, with no list endpoint, so three ACs were unsatisfiable. The web also hard-coded a 28-day horizon against configurable `RECURRENCE_HORIZON_DAYS`, and the copy deck's 5th-weekday date example was wrong. 360 px manual walk deferred to P6 by human ruling. Remediation added `GET /teams/:teamId/session-series`, put `horizonDays` on the API, corrected the example, and observed RED for the new tests. P5 discovered and repaired the P4 detached-HEAD incident.

### Phase 6 (5ffb7bc): journey, accessibility, ADR, docs
Playwright journey plus axe plus explicit 360 px found and fixed 3 real product bugs (bodiless Publish POST gave 400; bare "Changes saved."; End-series default date) without observed RED. ADR 0019 written. Four files remain under 80% branch coverage while the aggregate gate passes.

### Final whole-branch review (Opus, plus codex called directly)
Ready to merge WITH FIXES; 0 Critical; 2 Important and 8 Minor (see Technical Debt).

## Architecture Assessment

### What Worked
- **Pure shared core plus DB-side guards**: recurrence math lives in `packages/shared` and is test-heavy (and DST/NZ-timezone aware), while the DB triggers (D-85) and the session lock enforce the invariants under concurrency. P4 exercised this with real race tests and found a real lock-order bug that unit tests could not.
- **Creative phase ahead of build**: five creative docs plus a critique and "binding reconciliation" gave the phase reviewers a concrete spec to compare against, which is why compliance review caught AC gaps by reading against the binding docs.
- **Per-phase human gates with a ledger**: every deviation landed in `### Deviations` with file:line, so the final reviewer and this reflection could reconstruct decisions without logs.
- **API-owned configuration**: after remediation `horizonDays` is a response field instead of a duplicated web constant, which is the correct 12-factor shape.
- **Real-browser journey in the build**: the Playwright pass found three product bugs the 1952 unit tests had missed.

### What Could Improve
- **Server-authoritative aggregates**: UI sections and notices derived from whichever rows happen to be loaded (Series list, banking notice, "{n} upcoming", "Nothing changed" from version equality) are fragile; each should have a dedicated read or a server-computed field.
- **In-place amendment of an earlier phase's migration** works only because it is unmerged; it should be a recorded merge constraint (it is, in the ledger and D-76) but is an easy trap at archive time.
- **Large files**: `service.ts` 823 lines, `series.ts` ~716 lines, and 8.7k-line `openapi.yaml` diff all deferred; they will slow later review.
- **Optional-with-silent-default config** (`recurrenceHorizonDays` default 28 in `buildApp`; `webBaseUrl` localhost fallback) repeats the original 12-factor miss in a smaller form.

## Technical Successes

### Concurrency correctness
- Evidence: P4 real race tests found a 55P03 lock-order bug in `session_courts_guard_closed`; D-85 trigger alone is not sufficient under READ COMMITTED, so the session lock plus T-17 cover it.
- Impact: prevents deadlocks between court edits and registration inserts, which registration-and-waitlist will exercise heavily.

### Test volume and coverage
- Evidence: 1952 unit, 637 integration, 2 e2e; aggregate coverage 96.3% statements and 90.0% branches.
- Impact: strong regression net for the next features; caveat that four files are below 80% branch (series-view.ts 79.6, series.ts 76.7, materialise-notice.ts 75.0, series-name.ts 66.7).

### Browser journey finds product bugs
- Evidence: 3 bugs fixed in P6 that all earlier layers passed.
- Impact: validates the value of an end-to-end journey in the build, not only after.

## Technical Challenges

### 1. Unsatisfiable ACs because UI data source was page-local (P5 HALT, final review x2)
- Description: Series list derived from loaded session rows; no list endpoint. Same pattern again in the banking notice and the series Active status.
- Resolution: P5 remediation added `GET /session-series`; the two remaining instances are open.
- Prevention: see learning 1 and the Memory-Bank Corrections table.

### 2. Missing `teamId` on lock retry logs (P4 HALT)
- Description: AC-VERIFY-6 requires teamId on events; `lock_retry*` and `sweep_completed` lacked it.
- Resolution: `SessionTxOptions.teamId` threaded; `sweep_completed` carve-out by human ruling (cross-team sweep).
- Prevention: AC checklist for log-field requirements should be run per event at TDD time.

### 3. Detached HEAD with false "pushed" claim (P4 to P5)
- Description: P4 commits (2668987, 22002cd) sat on a detached HEAD; the branch and origin were still at dd13c74. P4 reported a push that did not happen.
- Resolution: P5 found it, moved the branch and pushed; the loop verified linear history afterwards.
- Prevention: orchestrator must verify `git rev-parse --abbrev-ref HEAD` is the feature branch and that `origin/<branch>` contains HEAD after each phase, independent of the sub-agent's claim. The existing `_learned/git-worktree-attached-head.md` rule did not prevent this; see corrections.

### 4. Codex review unavailable (`timeout` absent on macOS)
- Description: the codex backend launcher used `timeout`, which macOS lacks; P3 to P6 silently fell back to Anthropic-only review.
- Resolution: final review called codex directly without the wrapper and it worked.
- Prevention: use `gtimeout` or a portable fallback, and surface the fallback as a ledger note at the first occurrence.

### 5. Migration amended in place (P4)
- Description: a forward migration broke four schema round-trip tests, so the unmerged P1 migration was edited.
- Resolution: accepted by reviewer; `pnpm db:reset` required for databases that ran the old body.
- Prevention: recorded in D-76 and the ledger; must remain one in-place migration through merge.

## Process Assessment

### Effective Practices
- Separate phase-compliance reviewer reading against spec: caught AC gaps (P2 blocking bugs, P5 unsatisfiable ACs) that in-phase code reviewers did not.
- Opus final whole-branch review: found the two Important cross-phase issues no phase reviewer saw.
- Ledger of deviations with human rulings dated: made rulings (sweep carve-out, 360 px deferral) auditable.

### Improvement Opportunities
- **TDD discipline**: impl-before-test in 3A; characterization-only race tests in P4 (38); no observed RED in P4 remediation, 5A, and the three P6 fixes. Several "RED proven afterwards on a clean copy" workarounds were used. Phase reviewers accepted these each time, so the gate is advisory rather than enforced.
- **Re-verification after late fixes**: P2 fixes were not re-built or re-reviewed; P4 remediation did not re-run full suites after Prettier. The next phase's verifier absorbed the risk by luck of ordering.
- **Documentation agent skipped in P2 to P5**: no per-phase memory-bank doc updates, concentrated into P6 and ADR 0019, hence the AC text drift, stale carry-forward notes (P6 had to mark two as resolved) and misleading comments.
- **Task-file metadata inconsistencies** reached the final review (fixed in 97fd32d).

## Business Impact
- Value delivered: team admins can create one-off and recurring multi-court sessions, cost them, override single nights, and publish with the banking gate; downstream registration-and-waitlist and wallet-and-akahu-billing have their contracts in place.
- Stakeholder feedback: three human rulings during the run (sweep carve-out, 360 px deferral, and pending 404 vs 403); no end-user feedback yet.
- Metrics: see Executive Summary. Not yet UAT'd (`/yay:uat` not run).

## Technical Debt and Action Items

### High priority (before merge)
- [ ] Series past `recur_until` shows Active and PUT can restart it: derive status server-side and refuse PUT (409 `series_ended`).
- [ ] List banking notice computed from the loaded page only: serve it from a team-level server read.
- [ ] Human ruling on AC-ERROR-8 (404 vs 403) and align AC text or code.
- [ ] Update AC text: AC-ASYNC-3 idempotency key `:<recipientId>`; drop AC-HAPPY-10 partial-failure banner.

### Medium priority
- [ ] Series list sort order is ascending, spec says newest-first (Minor).
- [ ] "Nothing changed" inferred from version equality: expose an explicit server flag.
- [ ] `feesLocked` `'none'` vs `null` contract drift; correct contract or code.
- [ ] Make `webBaseUrl` and `recurrenceHorizonDays` required rather than silently defaulted.
- [ ] Fix misleading vitest comments; trim or split the 8.7k-line openapi diff for review.
- [ ] Lift series.ts (76.7), series-view.ts (79.6), materialise-notice.ts (75.0), series-name.ts (66.7) branch coverage over 80.
- [ ] Hand-off to registration-and-waitlist: widen `countActiveRegistrations` with the D-85 predicate; add TS/SQL parity test; note T-10 wording vs ALG in ADR 0019.

### Low priority
- [ ] Split service.ts (823) and extract `propagate` from series.ts (716); comment the `as never` casts.
- [ ] `waitForLockWaiters` latent flake: filter by locktype.
- [ ] Add CLI `jobs trigger session-auto-enrol` to TRIGGERABLE.
- [ ] Remaining unverified browser items: screen reader, full Tab order, moderate/minor axe, publish confirm panel; run `/yay:uat`.

## Strategic Insights

### For Future Enterprise Work
- For every list/summary/banner AC, decide the data source at plan time: "which endpoint or field is authoritative for this?" A page-local derivation is a smell.
- Keep a TDD-compliance gate that can fail, not just note, a phase when implementation commits precede test commits.
- Verify git state (branch, upstream containment) from the orchestrator rather than trusting a sub-agent's report.

### Reusable Components
- Pure shared recurrence core and `seriesName()`: reuse for registration and billing displays.
- `apiFetch` keeping `dstOptions` and `raisedFields` from error bodies: reuse for other form-level conflict flows.
- Playwright journey with axe and 360 px assertion: template for future UI features.

## Claude Code Ecosystem Strategic Evaluation

### Executive Summary
The auto-build loop (fresh Sonnet orchestrator per phase, Sonnet compliance reviewer, Opus final review) scaled to a 6-phase Level 4 build on a single day and surfaced real defects at each stage, which is its main value. Its weakness is that enforcement is soft: TDD slippage, skipped re-runs, skipped Documentation agent, an unverified push, and a silently failing Codex backend were all tolerated and noted rather than blocked. Most phase-level findings recurred as the same classes, which points to instructions and gates rather than individual agent error.

### Command Architecture Assessment

| Command | Phases Used | Effectiveness | Strategic Notes |
|---------|-------------|---------------|-----------------|
| /yay:plan | 1 | 4 | Plan and spec with 48 ACs gave reviewers a concrete target; some ACs were unsatisfiable by design (series list, banner) |
| /yay:creative | 5 docs + critique | 4 | Binding reconciliation was valuable; copy deck still contained a wrong date example |
| /yay:build --auto | 6 phases | 4 | Effective loop; soft gates |
| /yay:reflect | 1 | n/a | This document |
| /yay:archive | pending | n/a | Must carry in-place migration constraint and corrections below |
| /yay:uat | not run | n/a | Level 4 "strongly recommended"; 360 px/axe in P6 partially substitutes |

**Command gap analysis**: a lightweight `/yay:go resume-check` that verifies branch, upstream and uncommitted state between phases, since the detached-HEAD incident was recovered by accident.

### Workflow Architecture Assessment

| Phase | Duration | Friction Level | Value Delivered |
|-------|----------|----------------|-----------------|
| PLAN | same day | Low | 48 ACs, 6 phases |
| CREATIVE | same day | Low | High; binding rulings reused by reviewers |
| BUILD | same day, 6 phases | Medium: 3 HALTs (P4, P5 and the P4 git incident) | Real defects caught |
| REFLECT | this run | Low | log-less; see Context gaps |

### Context System Assessment

| Context Category | Files Loaded | Usefulness | Token Efficiency |
|------------------|--------------|------------|------------------|
| Level-specific | level4-reflection.md | 4 | Good |
| Agent prompts | build-orchestrator, tdd, phase-reviewer, final-reviewer | 4 | Acceptable; TDD prompt did not prevent impl-first |
| Learned rules | 9 `_learned/` files present | 3 | See Learned Rules Applied |

**Context gaps**: no AC-authoring rule for data-source authority; no rule on log-field-per-event checklists; `by-task` log directory missing so ecosystem metrics are unrecoverable.

### Tool Utilization Analysis
Counts unavailable (no logs). Observed qualitatively: Bash-heavy build loop (git, pnpm, docker compose pause in e2e); Task (sub-agents) per phase; the `timeout` dependency broke the Codex launcher on macOS. Rating of tool success rates: n/a.

**Tool gap**: portable timeout wrapper for Codex invocation.

### Subagent Architecture Assessment

| Agent Type | Invocations | Output Quality | Prompt Issues |
|------------|-------------|----------------|---------------|
| Build orchestrator (Sonnet) | 6 + remediations | 3 | claimed push that did not happen; skipped re-runs after late fixes; skipped Documentation agent P2 to P5 |
| TDD agent (Sonnet) | 2 per phase typical | 3 | impl-before-test (3A); characterization tests labelled as TDD (P4) |
| Phase compliance reviewer (Sonnet) | 6 | 5 | caught P2 blockers and the P5 AC gaps; thin by design |
| Code reviewer | 2 to 6 | 3 | Anthropic only after P3; no Codex second opinion |
| Final reviewer (Opus) | 1 (+ codex direct) | 5 | found both Important cross-phase issues |
| Documentation agent | skipped P2 to P5 | n/a | skipping caused AC drift and stale notes |

**Agent prompt improvements**:
- Orchestrator: require `git rev-parse --abbrev-ref HEAD` equals the feature branch and `git merge-base --is-ancestor HEAD origin/<branch>` after push before claiming "pushed".
- TDD agent: if a failing test has not been observed before implementation, mark the task DONE_WITH_CONCERNS and name the files.
- Phase reviewer: add a "data-source" check for every UI AC that lists, counts or labels collections.

### Memory Bank Architecture Assessment

| Document Type | Created | Utility | Maintenance Burden |
|---------------|---------|---------|-------------------|
| tasks/session-scheduling-engine.md | Y | 5 (ledger saved this reflection) | High: very long Deviations section, with stale and duplicated entries |
| creative/*.md | 5 | 5 | Medium |
| reflection | Y | n/a | |
| ADR 0019 | Y | 4 | Needs the hand-off list items above |

**Knowledge preservation**: good for decisions (ledger and rulings), weak for process metrics (no task-indexed logs).

### Ecosystem Scalability Assessment

| Metric | Observation | Impact |
|--------|-------------|--------|
| Context window pressure | Low per phase (fresh orchestrator) | Good isolation |
| Token efficiency | n/a, no logs | unknown |
| Phase handoff quality | Acceptable; ledger carry-forwards worked, git state handoff failed once | one false push claim |
| Recovery from errors | Good: 3 HALT/remediate cycles resolved | extra phases of rework |

### Strategic Improvement Recommendations

#### Immediate (High Priority)
| Recommendation | Component | Rationale | Expected Benefit |
|----------------|-----------|-----------|------------------|
| Orchestrator verifies branch and origin ancestry after each phase | build-orchestrator-agent.md, post-commit step | P4 detached HEAD and false "pushed" (Level 2 task) | No lost commits |
| Replace `timeout` with portable wrapper (`gtimeout`, `perl alarm`, or node) and log the fallback in the ledger at first occurrence | Codex backend launcher (agent-backends.md) | Silent Codex loss P3 to P6 (Level 2) | Dual-model review retained |
| Add "UI data-source authority" check to phase-reviewer and final-reviewer prompts | auto-build-phase-reviewer-agent.md | Same defect class in P5 HALT and both Important findings (Level 2) | Fewer late findings |
| Make full-suite re-run mandatory after any review-driven fix | build-orchestrator-agent.md | P2 and P4 fixes shipped unverified (Level 2) | Closes verification gap |

#### Short-term (Medium Priority)
| Recommendation | Component | Rationale | Expected Benefit |
|----------------|-----------|-----------|------------------|
| TDD order gate: reviewer checks test commit/diff precedes impl or records RED output | tdd agent + phase reviewer | 3A, 5A, 4 remediation, P6 fixes lacked RED (Level 2) | Real TDD signal |
| Do not skip Documentation agent in `--auto` unless task file records why | auto-build orchestration | Docs concentrated in P6; AC drift (Level 2) | Fresh docs |
| Write session logs to `by-task/<slug>/` in worktree-based builds | log indexing in /yay:init or hook | No metrics possible for a Level 4 reflection (Level 2) | Evidence-based ecosystem reflection |

#### Long-term (Strategic)
| Recommendation | Component | Rationale | Expected Benefit |
|----------------|-----------|-----------|------------------|
| Plan-time AC lint: each list/count/banner AC names its authoritative read | /yay:plan spec-writer agent | Two Important findings plus P5 HALT | Prevents unsatisfiable ACs |
| Ledger compaction at phase boundaries | task file template | Deviations section ~60+ entries with stale items | Lower reading cost |

### Patterns Worth Codifying
1. **Spec-reading phase reviewer separate from code reviewer**: keep; it caught what in-phase code review did not.
2. **Dated human rulings in the ledger with AC amendment**: keep.
3. **Browser journey with axe and 360 px inside the build, not only in UAT**: caught 3 bugs.

## Guardrail Misses and Root-Cause Analysis

The task file's `### Guard & Recovery Log` section was not found in the content reviewed (the Deviations ledger carries the equivalent trail). Using the ledger and git log, the following guard/recovery events occurred; this was NOT a clean build.

| Event | What went wrong first time | Systemic cause | Proposed correction |
|-------|---------------------------|----------------|---------------------|
| P4 HALT: `lock_retry*` missing teamId | Agents implemented log events from ARCH names without checking AC-VERIFY-6 field list per event | Log-field requirement lives in AC text; no per-event field checklist in plan; sweep spans teams and the AC did not allow for it | Plan task checklist must tabulate event to required fields; AC-VERIFY-6 now amended with carve-out |
| P5 HALT: Series list unsatisfiable | UI section derived from loaded rows; no endpoint | Plan/ARCH defined the component but not its authoritative read; same class recurred in final review (2 Important) | Add data-source rule (learning 1) |
| P4 detached HEAD, false "pushed" | Commits not on the branch; claim unverified | Orchestrator trusts sub-agent report; `_learned/git-worktree-attached-head.md` exists but is scoped to attached-HEAD worktree setup, not post-commit verification | See corrections table |
| P2 blocking bugs (past edit, cursor 500) | Caught by the reviewer after TDD agent | Edge cases (state-transition guards, input validation on pagination cursors) not in test checklist | Add to testing conventions |
| P3 impl-before-test; P4, P5, P6 no RED | Agents skipped or reordered RED | Repeated across 4 phases and several agents, which points to the instruction (no hard gate; "RED proven afterwards" accepted as equivalent) | Hard gate, see recommendations |

## Memory-Bank Corrections (from Guardrail Misses) - ACT ON THESE

| File and section | Current (stale/wrong) | Correction | Evidence |
|---|---|---|---|
| agent-rules/_learned/git-worktree-attached-head.md | covers attached-HEAD worktree, did not stop a detached phase | Add bullet: after every phase commit, assert `git symbolic-ref -q HEAD` succeeds and `origin/<branch>` contains HEAD before reporting "pushed"; never accept a sub-agent's push claim | P4 commits on detached HEAD, false "pushed" (found in P5) |
| agent-rules/_learned/review-process-plan-claims.md | plan claims verified in review | Add: for any UI AC listing/counting/labelling items, plan must name the endpoint or field that is authoritative; reject page-local derivation | P5 HALT plus 2 Important final findings |
| systemPatterns.md, Migration conventions | not stated for pre-merge migrations | Add: an unmerged feature migration may be amended in place; record it in the ADR and task ledger as a merge constraint and require `pnpm db:reset` note | P4 `session_courts_guard_closed` amend (D-76) |
| systemPatterns.md, Config conventions | no rule on silent defaults | Add: do not default config-derived values in constructors or `buildApp` deps (`recurrenceHorizonDays` 28, `webBaseUrl` localhost); require explicit wiring | P3 reviewer flag, P5 remediation, final review |
| techContext.md, Tooling (macOS) | assumes `timeout` | Add: macOS has no `timeout`; use `gtimeout` or the Codex runtime directly | P3 Codex launch failure; final review worked without it |
| memory-bank/tasks/session-scheduling-engine.md (and ADR 0019) | AC-ASYNC-3 key text, AC-HAPPY-10 banner text, T-10 wording | Update AC text to `...:<recipientId>`, drop partial-failure banner, reconcile T-10 "wholly inside the gap" | Ledger P3, P5, P1 |

## Key Learnings

### Extractable Learnings (for Continuous Learning)

1. **ui-data-sources** (`apps/web/**`, list/summary/banner components): Derive every list section, count and warning from a server-authoritative read, never from the rows already loaded on the current page.
2. **git-verification** (`build orchestration, branch handoff`): Verify the checked-out branch and that `origin/<branch>` contains HEAD after each phase push instead of trusting a sub-agent's "pushed" claim.
3. **testing-patterns** (`*.test.*`): Run the full unit, integration and build after every review-driven fix, and record an observed RED for each bug fix before changing code.
4. **config-defaults** (`apps/api/src/app.ts`, `bootstrap.ts`): Make config-derived values required at the composition root rather than defaulting silently to a hard-coded value.

### Learned Rules Applied
- `_learned/git-worktree-attached-head.md`: loaded but did not prevent the P4 detached-HEAD incident; extend per corrections above.
- `_learned/job-queues-pgboss.md`, `_learned/testing-injected-clock.md`, `_learned/db-derived-flags-and-gates.md`, `_learned/api-write-idempotency.md`, `_learned/testing-integration-db-isolation.md`, `_learned/logging-redaction-global.md`: relevant to the queues, clock-relative ACs (T-11), derived flags (`deadline_is_default`), idempotent email keys, DB-backed race tests and log fields; likely applicable but per-rule effectiveness cannot be confirmed without session logs. `_learned/review-process-plan-claims.md`: applicable to the review loop. `_learned/auth-session-issuance.md`: not applicable.

### For Claude Code Workflow
1. A flag followed by recovery is a symptom: three HALTs and four TDD slips all came from instructions, not isolated agent errors; harden the prompts.
2. `--auto` needs explicit "must not skip" steps (Documentation agent, full re-run after fixes) or a ledger entry stating why.
3. Capture task-scoped session logs so Level 4 reflections have metrics.

## Conclusion

The engine is functionally complete, well tested and architecturally sound, and the build loop genuinely improved it, but the branch should not merge before the two Important findings are fixed and the AC-ERROR-8 ruling is made. The recurring root causes are page-local UI derivation, weak TDD and re-verification enforcement, and unverified git handoff; each has a specific correction above.

**Overall Task Success**: Partial Success (good quality, two Important findings and one ruling open)

**Overall Workflow Effectiveness**: Moderately Effective

**Recommendation**: Needs follow-up before archive/merge: fix the two Important findings, get the AC-ERROR-8 ruling, apply the AC text updates, and run `/yay:uat`; then archive, applying the Memory-Bank Corrections.

## References
- Task: memory-bank/tasks/session-scheduling-engine.md
- Creative: memory-bank/creative/session-scheduling-engine-{binding-reconciliation,recurrence-algorithm,architecture,admin-user-journey,uiux}.md
- ADR: docs/adr/0019-session-scheduling-engine.md
- Timeline: `git log 1ee4520..97fd32d` on feature/session-scheduling-engine
