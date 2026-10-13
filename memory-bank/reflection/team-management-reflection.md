# Reflection: team-management - Team Management

**Date**: 2026-10-13
**Task Complexity**: Level 3
**Total Phases**: 5 (all complete)
**Duration**: 2026-10-13 (plan, creative and build in one day), 13 commits, 116 files, +20,276 / -95 lines vs origin/main

## Executive Summary

team-management delivers team creation, discovery (public Find, private invite link), join requests with a self-assessed skill level, admin approve/reject/promote/demote/ban, and the ban seam that later features consume. The membership state machine is enforced by the database (CHECKs, a transition trigger, deferred last-admin triggers, D-40 to D-46), with a web discovery area and a team-admin "People" area on top. Plan produced 43 ACs (44 with AC-ERROR-15). Every phase passed the verifier, code review (0 blocking) and the phase-reviewer. The suite grew to 763 unit + 275 integration tests, and Playwright e2e passes 8/8 on desktop and 360px. Coverage on `modules/teams/**` and `lib/teams` is 97.65% lines.

The most valuable work happened before build. The Codex adversarial critique found three real defects in the creative output: ban copy that over-promised cancellation while the handler is a no-op, an accepted invite-rotation TOCTOU race, and a non-idempotent create. All three were resolved as binding rulings before any code was written. The final review found one genuine regression, which is the clearest lesson of the build. A global logger redaction on the exact key `code`, added in Phase 2, silently hid the error code on `auth.oauth.link_conflict` logs in the already-shipped auth feature. No test caught it because the existing test only asserted that the event existed. It was fixed in ad7256e with a test that fails without the fix.

Overall: the task is a success. The ecosystem was moderately effective. The binding-reconciliation pattern worked but should be a first-class workflow step. The Codex critique default scope, load-sensitive verifier tests, and the missing cross-feature blast-radius check for global changes are concrete gaps.

---

## Dimension 1: Task Implementation Quality

### Requirements Achievement

**Status**: All Met (with Minor 2-5 open)

- All five phases are checked off. The ACs by group (ENTRY, HAPPY, ERROR, ASYNC, VERIFY, INTEGRATION) map to the phase assignment in the roadmap, and each phase review returned PROCEED.
- AC-INTEGRATION-1 and 2 (ban seam against real rows, real queue, real race) and AC-INTEGRATION-3 (full journey in a real browser on both viewports) are evidenced by integration and e2e runs.
- Success criteria are met. A ban commits the BANNED row and the `member-banned` job together, access is revoked via `assertApprovedMember` (FOR SHARE) the moment the ban commits, and the handler port is a replaceable no-op.
- Accepted gaps, recorded in the Deviations ledger: the ban does not cancel registrations yet (honest copy; registration-and-waitlist owns the real handler and sweeper), two admins demoting each other simultaneously return 403 instead of 409, and e2e does not cover the 5xx keep-panel path or self-demote success (unit-tested only).
- Open Minors: 2 (double `team.action.refused` log in a race), 3 (create replay with a different body returns the original; `callManageApi` duplication), 4 (cursor length edge case with control-character names), 5 (admin routes' OpenAPI lacks 401/403).

### Code Quality Assessment

**Overall Rating**: Good (Excellent on the DB and concurrency design, Fair on one global side-effect)

- **Maintainability**: Clear module split (`modules/teams/{service,membership,membership-errors,ban-hook}.ts`, `jobs/member-banned.ts`, `manage-areas.ts` registry). ADR 0015 documents the seam. Minor duplication remains in `actions.ts`.
- **Architecture**: Enforcing the state machine in the database with a lock-order rule (team row first) is robust, and two deterministic race tests prove it (join vs regenerate, create replay). The seam is replaceable and idempotent.
- **Error Handling**: Mapper keys on `err.constraint`. A failing ban side-effect never undoes the ban (AC-ERROR-12). The exception is the global logger redaction, which was too broad (see below).
- **Testing**: Strong and well-targeted: RED confirmed each phase, real multi-connection race tests, real queue. Weak spot: no jsdom, so interactive component behaviour is covered by reducer and static-markup tests plus e2e. Server components under `app/teams` had no unit tests until Phase 5.

### Technical Decisions

**Key Decisions:**
1. Ban row and job commit together, handler port is a no-op, no sweeper here - keeps this feature honest and decouples from registration-and-waitlist. Outcome: sound, but required rewording the UI copy.
2. DB-enforced state machine (CHECKs, transition trigger, deferred last-admin triggers) - correctness holds regardless of code path. Outcome: good; one unreachable `keys_immutable` mapped defensively.
3. One rotating 256-bit invite code plus FOR SHARE vs FOR UPDATE on the team row - closes the TOCTOU the critique found. Outcome: deterministic race test proves it.
4. ILIKE over a partial `(lower(name), id)` index with a two-way cursor - bounded, index-friendly search; cursor max length 700.
5. Create idempotency via `(created_by, create_idempotency_key)` unique index (D-46) - retry-safe create.
6. Logger redaction of exact key `code` in Phase 1/2 - intended to protect invite codes, but with global scope. Outcome: caused the one regression.

**Trade-offs:**
- Honest ban copy vs a more reassuring "registrations are cancelled" message: chose truth; later feature must add cancellation wording.
- Native e2e run vs Compose: faster and runnable here, but not part of `ci`.
- Hardening beyond spec (regenerate re-check) vs scope: accepted and ledgered.

### What Went Well

1. Design critique converted three latent defects into binding rulings before build, at the cheapest possible point.
2. Every phase returned verifier PASS, review APPROVED and phase-reviewer PROCEED, with carry-overs between phases explicitly noted in Build Logs.
3. Race conditions were tested deterministically, not by sleeping.
4. The final whole-branch review caught a cross-feature regression the per-phase reviews missed.
5. The orchestrator verified a phase-reviewer's "on trust" claim (MEMBERS_PAGE_SIZE = 50) against the tree.

### Challenges Encountered

1. Parallel creative agents produced ~40 overlapping amendments with conflicts (page size 25 vs 50, self-demote redirect, Find "Previous" vs "Back to first page") - reconciled in a binding section rather than folded into the ACs.
2. The Codex critique first reviewed an empty working-tree diff - re-run with `--base origin/main --scope branch`.
3. Phase 3's first verifier run failed from CPU load (DST/pg-boss `previewSchedule` tests timed out) - passed on a quiet sequential re-run.
4. No `.env` in repo; integration tests need inline env vars.
5. Logger redaction side-effect on auth logs (see Guardrail section).

### Technical Debt & Future Work

- registration-and-waitlist must ship the real `MemberBannedHandler`, the reconciliation sweep for bans the no-op handled, and cancellation wording. This is recorded in the task file and must be in that feature's plan.
- Fix Minors 2-5; extract `callManageApi` and the `listMembers` SQL builder; give the self-demote InlineConfirm a per-user id.
- Add 401/403 to admin-route OpenAPI.
- Consider a jsdom or Testing Library harness for interactive components.
- Make load-sensitive tests (DST, `previewSchedule`) deterministic or isolated.

---

## Dimension 2: Claude Code Ecosystem Effectiveness

### Build Session Analysis

**Build Sessions**: 1 single-phase `/yay:build` (Phase 1) + 1 `/yay:build --auto` run (Phases 2-5) + final review
**Sub-Agents Spawned**: ~40 estimated (spec writer, 3 creative, codex critique, per phase: TDD, verifier, code reviewer, phase reviewer; plus final reviewer). Counts are estimates from task-file logs.
**Tool Calls**: not measured. `.agent-logs/claude/by-task/team-management` does not exist (only FEAT-001, TASK-001, TASK-007 legacy entries), so session logs are not task-indexed. Metrics below come from the task file and orchestrator facts.
**Errors Recovered**: 1 verifier re-run (CPU load), 1 critique re-run (wrong scope), 1 post-build fix (ad7256e).

#### Tool Utilization

Not extractable (no task-indexed logs). Observations from the task file: verifier runs full unit + integration + coverage + lint/typecheck/build/openapi drift each phase; the TDD agent executed Playwright natively.

#### Sub-Agent Performance

| Agent Type | Invocations | Model | Effectiveness |
|------------|-------------|-------|---------------|
| Spec Writer | 1 | Sonnet | High: 43 ACs, taxonomy lint clean first try |
| Creative (Journey, Architecture, UI/UX) | 3 parallel | Opus, Opus, Sonnet | High depth, but overlapping amendments and conflicts; needed manual reconciliation |
| Codex design critique | 2 (1 empty-scope) | Codex | Very high value (3 real findings) once scoped correctly |
| TDD Agent | 5 | Sonnet | Effective; RED confirmed each phase |
| Verifier | 5+1 | Sonnet | Reliable except one load-induced false failure |
| Code Reviewer | 5 | Sonnet | Useful non-blocking recs; approved all |
| Phase Reviewer | 4-5 | Sonnet | Fast gate; once accepted a claim on trust |
| Final Reviewer (Codex + Anthropic) | 1 | mixed | Caught the one real regression |
| Documentation | 1 (Phase 5 only) | Haiku | Orchestrators skipped it until Phase 5 |
| Batch Test Agent | 0 | n/a | Skipped by auto-build orchestrators |

### Command Workflow Evaluation

**Commands Used**: `/yay:plan`, `/yay:creative` (+ critique), `/yay:build` (Phase 1), `/yay:build --auto` (Phases 2-5), `/yay:reflect`
**Workflow Efficiency**: Good

- Complexity classification (Level 3) was accurate; one day end to end.
- Auto-build removed per-phase pauses, but per-phase human review was replaced by reviewer agents, which share blind spots (see learned rule review-process-plan-claims).
- Building in the main clone (no worktree) worked but diverged from prior tasks; the plan said "Worktree: N/A".
- No `/yay:uat` run; e2e specs were written directly in Phase 5.

### Context File Effectiveness

**Files Loaded**: task file, three creative docs, ADR 0015, level-3 rules, systemPatterns, techContext, learned rules.

- **Helpful**: The Creative Reconciliation section was effective as binding build input; the "Notes for later phases" carry-overs in Build Logs.
- **Gaps**: No convention for reconciling parallel creative output; no guidance about environment variables for integration tests (no `.env`); no rule requiring a blast-radius check for global changes.
- **Redundancy**: Amendment tables in three docs duplicated and conflicted instead of feeding one spec.

### Memory Bank Organization

- **Structure**: Adequate. Core State / Work-Specific split worked in the single-branch collapse.
- **Navigation**: Task file is large (75 KB); finding the binding section required knowing it existed.
- **Completeness**: The Guard & Recovery Log says only "see commit guard result" in Phases 2-5, which makes guard outcomes hard to audit afterwards.

### Guardrail Misses & Root-Cause Analysis

- No commit-guard FAIL is recorded (Phase 1 log: guard PASS first try; Phases 2-5: no FAIL recorded).
- Re-invocations: (a) Phase 3 verifier re-run: load-sensitive DST/pg-boss timing tests under parallel agent load. Cause is environmental plus tests without load tolerance, not stale guidance. (b) Codex critique re-run: the default scope reviews the working-tree diff, which is empty on a committed feature branch. (c) The post-build fix ad7256e is a guardrail miss that passed every per-phase gate. Root cause: the Phase 1 code review deferred "logger exact `code` body-key redaction" to Phase 2, and Phase 2 implemented it in a global logger. No phase reviewer was given the instruction to grep other features' log fields for the same key. The shipped auth feature's `auth.oauth.link_conflict` logs used `code`. The test asserted only that the event existed, not its fields. Same pattern as the learned rule review-process-plan-claims (reviews check the phase's ACs, not paths owned by earlier work).

### Memory-Bank Corrections (from Guardrail Misses) - ACT ON THESE

| File · section | Current (stale/wrong) | Correction | Evidence |
|---|---|---|---|
| techContext.md or systemPatterns.md · Logging / redaction | Redaction rules are described per feature; no statement that the redaction list is global | Add: "Redaction keys apply to every log in every feature. Before adding a key, grep all `logger.*` calls and log assertions for that field name, and assert logged fields (not only event presence) in tests." | ad7256e: exact-`code` redaction hid `auth.oauth.link_conflict` code |
| agent-rules/_learned/review-process-plan-claims.md | Covers plan and doc claims and invariants of earlier phases | Add a bullet on cross-feature blast radius of global changes (logger, middleware, error mapper) with evidence_count bump (team-management) | Final review Minor 1 |
| techContext.md · Integration test commands | No mention of required env vars | Document the inline env vars needed because no `.env` exists | Build setup friction every phase |
| techContext.md · Tests | Timing-sensitive DST/pg-boss `previewSchedule` tests not flagged | Note that these tests flake under parallel CPU load; verifier should run them sequentially | Phase 3 verifier first run failed |

### Suggested Improvements to Claude Code System

**High Priority**:
1. `/yay:creative` should fold or reconcile amendments automatically: after parallel agents finish, a reconciliation step (or a fourth agent) should produce one conflict-resolved amendment list and propose AC edits, not leave ~40 overlapping amendments plus a hand-written binding section.
2. The creative critique should default to `--base <pr_target> --scope branch` when the working tree is clean, and warn on an empty diff instead of reviewing it.
3. Code review and phase-review prompts should include a mandatory check: "for any global/shared change (logger, middleware, error mapper, schema), search all callers and prior-feature tests for impact."

**Medium Priority**:
1. Verifier should detect timeout-class failures and automatically re-run the failing files sequentially before reporting FAIL.
2. Auto-build should not silently skip the docs agent and batched test steps; log skipped steps in the Execution State with a reason, and add an explicit "docs deferred to final phase" policy if intended.
3. Guard & Recovery Log should always record the guard verdict, not "see commit guard result".
4. Phase reviewer should verify numeric contract claims (page size, limits) against the tree rather than the plan text.

**Low Priority / Nice to Have**:
1. Provide a task-scoped log index (`.agent-logs/claude/by-task/<slug>`) for v2 slugs so reflection can extract tool metrics; currently only legacy TASK/FEAT directories exist.
2. Split very large task files (75 KB) into a summary plus per-phase logs.

---

## Key Learnings

### Extractable Learnings (for Continuous Learning)

1. **logging-redaction** (`apps/api/src/**/logger*.ts`, `*.int.test.ts`): Before adding a global redaction key, grep every log call and log assertion across all features for that field name, and rename colliding fields.
2. **testing-patterns** (`*.test.ts`, `*.int.test.ts`): Assert the logged fields (not only that the event fired) when a test covers a log whose payload is operationally important.
3. **review-process** (`memory-bank/creative/`, `memory-bank/tasks/*.md`): Run an adversarial critique with an explicit `--base <pr_target> --scope branch` and write conflicts between parallel creative docs into one binding reconciliation section before planning the build.
4. **testing-patterns** (`apps/api/test/`): Make timing-sensitive tests (DST, pg-boss schedule preview) load-tolerant or run them sequentially, since parallel agents cause CPU-load false failures.

### Learned Rules Applied

- `review-process-plan-claims.md`: Relevant and reinforced. Per-phase reviews again passed while a cross-phase/cross-feature effect (logger redaction on auth logs) slipped to the final review. Candidate for evidence_count bump.
- `testing-integration-db-isolation.md`: Applied (per-file template DBs, real multi-connection race tests for join vs regenerate, create replay).
- `job-queues-pgboss.md`: Applicable to the `member-banned` queue and job; consistent with the idempotent handler port.
- `testing-injected-clock.md`: Loaded; the load-sensitive DST test failure suggests it is worth reinforcing for timing tests.
- `auth-session-issuance.md`, `git-worktree-attached-head.md`: loaded but not applicable (no worktree was used).

### For Claude Code Workflow

1. Parallel creative agents need an integration step; without it the orchestrator carries the merge burden and the ACs drift from the binding rulings.
2. Early adversarial review is the cheapest defect filter in the pipeline; make it standard for Level 3-4 with correct scope defaults.
3. Auto-build's reviewers are strong on in-phase spec compliance and weak on cross-feature blast radius; the final whole-branch review remains essential and should not be skippable.
4. Environment-dependent flakiness (load, missing `.env`) should be documented in techContext so agents do not rediscover it each phase.

---

## Conclusion

team-management is a high-quality delivery: DB-enforced membership invariants, deterministic race tests, honest ban copy, a clean replaceable seam, and a full browser-tested journey. The one escaped defect was a global-scope change with a cross-feature side effect; it was caught at the final review and fixed with a proper regression test. The workflow worked well overall, with improvement opportunities in creative reconciliation, critique scoping, verifier flake handling and a blast-radius check for global changes.

**Overall Task Success**: Success

**Overall Workflow Effectiveness**: Moderately Effective

**Recommendation**: Ready to archive. Apply the Memory-Bank Corrections at archive, and carry the ban-handler, sweeper and cancellation-wording follow-up into the registration-and-waitlist plan.
