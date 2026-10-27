# Reflection: registration-and-waitlist - Registration and waitlist

**Date**: 2026-10-27
**Task Complexity**: Level 4
**Total Phases**: 6 (plus 2 phase remediations and 3 post-build human rulings, O5 to O8)
**Duration**: 2026-10-14 (plan) to 2026-10-26 (last commit 9ecf2d0); build 2026-10-24 to 2026-10-25, post-build rulings 2026-10-25 to 2026-10-26

## Executive Summary

The feature delivers registration with up to two guests, a first-fit FIFO waitlist, the 3-OVERDUE debt gate, early/late withdrawal classification with a late-fee liability that is released when the place is refilled, the real ban handler and reconciliation sweep, the SSE allocator-port adapter, the billing hand-off (`listBillableRegistrations`), and the player session page with a stacked registration panel. The diff is 167 files, +27.6k / -0.4k lines. Final CI: `pnpm run ci` green, 3197 tests in 215 files, coverage 96.5% statements and 90.33% branches. Playwright `registrations.spec.ts` passes 8/8 (4 journeys on desktop and 360 px) with axe, no horizontal scroll and 44 px targets at every state.

The build used `/yay:build --auto`: a Sonnet orchestrator per phase, a spec-compliance phase reviewer, and an Opus-grade final reviewer. All 6 phases ended PROCEED. Two phases HALTed once and were remediated: Phase 2 (a money-affecting double waiver of late fees) and Phase 5 (R15: the fee line did not name the pricing level). The final whole-branch review found 0 Critical, 1 Important (auto-enrol adds people after the cancellation deadline, human ruling O5) and 8 Minor. Three further product-policy rulings (O6 ban gap and billing skip, O7 all-or-nothing waiver, O8 silent first-run backlog) arrived after BUILD_COMPLETE.

Overall: technically strong and unusually well-verified, but the cost of finding product-policy questions late was real. Four of the eight human rulings (O5 to O8) surfaced only after the build, each one a product rule that the spec and creative phases could have forced into the open. The orchestration loop itself performed well; the main ecosystem gaps are the unavailable Codex backend (out of credits, so the final review was single-model), verifier sub-agents running destructive git commands, and no task-indexed session logs.

---

## Dimension 1: Task Implementation Quality

### Requirements Achievement

**Status**: All Met (with 8 recorded human rulings and a documented accepted residual, C3)

- Capacity, guests, group atomicity: public capacity = `max_players - reserved_seats`; parties never split; first-fit (R1) replaced the spec's undecided "skip or block".
- Debt gate counts OVERDUE across all teams; refusal is 403 before any session lock, and a debtor sees 404 for unknown/DRAFT/foreign sessions (Codex P2 fixed test-first in Phase 3).
- Cancellation: early withdrawal free; late withdrawal is promoted-or-owed, with the fee released on refill (R2, user decision) and re-registration while owed constrained (R3). The overview/workflows window conflict was resolved in favour of workflows.
- Concurrency: D-14 session lock, canonical lock order, `FOR UPDATE NOWAIT` backstop trigger (R4), bounded retry on 40P01/55P03, and AC-INTEGRATION-1 races repeated over HTTP and through the real ban handler.
- ADR 0015 obligations: `assertApprovedMember` inside the transaction, real `MemberBannedHandler`, reconcile sweep (05:45 Pacific/Auckland, boot and on demand), restored ban copy.
- Cross-feature: R14 to R27 folded in SSE merge obligations (D-85 widening with its TS twin, port adapter, 403/404 choice, page ownership) and skill-levels obligations (C-PRICE-1 snapshot, C-SKL-1 opt-out re-check, labelled and emailed auto-enrol).
- Billing boundary is money-free (AC-VERIFY-10) and billing-ready: snapshot-based, final at `starts_at`, requires a transaction and the session lock.

Gaps and residuals, all documented: ban concurrent with promotion (C3a) and ban-after-last-sweep (C3b) accepted by O6, mitigated by the billing skip; `ux-patterns.md` is absent so the UI/UX conformance pass and `/yay:uat` were not run (the Playwright axe suite partly substitutes); the per-person-only fee in emails; the worker pool of 5 is hardcoded.

### Code Quality Assessment

**Overall Rating**: Excellent

- **Maintainability**: Pure `decideAllocation` rules in `allocation.ts`, a single repo writer for `registrations` enforced by a grep-style boundary test, and an adapter that is a thin wrapper over the allocator. Single emitter for `registration.*` logs, enforced by `boundaries.test.ts`.
- **Architecture**: Port/adapter against SSE with one composition point; lock order encoded and tested; DB-level guard rails (transition triggers, CHECKs on snapshot and fee flag, one-way fee flag) mean application bugs fail loudly rather than corrupting billing data. Property tests with an invariant list (I14 added after the Phase 2 HALT).
- **Error handling**: Refusals are returned values, transient versus permanent job failures are classified, handler continues past a failed session, sweep pages by keyset so one poisoned member cannot starve others.
- **Testing**: Strong. Unit, deterministic race tests that hold locks, integration through HTTP, real-adapter marker proof through SSE's sweep, e2e with axe on both viewports. Weak spots: HTTP race tests depend on the 2 s lock_timeout (recorded CI flake watch item); the TDD RED observation was recorded explicitly in the ledger for every remediation and O5/O6/O8, which is a clear improvement over the prior feature.

### Technical Decisions

**Key Decisions:**
1. **First-fit promotion (R1)** - scan waitlist in order, promote each party that fits, keep unfit parties in place. Prevents a large group blocking the queue; a trade-off against strict FIFO fairness, accepted by the user.
2. **Late fee as a releasable liability, not a payment row (R2/R3)** - `withdrawal_fee_due` flag set once, one-way true to false, released oldest-first when seats refill. Keeps this feature money-free and gives billing a deterministic hand-off. It also produced the most subtle defects (Phase 2 double waiver; O7 policy).
3. **Port adapter swapped at one composition point (R19)** - the real adapter was built in Phase 2 but wired in Phase 3 only when both emails existed, so the branch never enrolled anyone without emailing. A sound sequencing decision.
4. **Registrant pricing snapshot written in the CONFIRMED transition (R15)** - removes dependence on mutable `users.sex` / `team_members.skill_level` at charge time; DB CHECK plus trigger make it authoritative.
5. **Accepting C3 rather than inverting lock order (O6)** - protects the canonical `teams -> team_members -> game_sessions -> registrations` order and adds a billing-side skip instead.

**Trade-offs:**
- First-fit vs strict FIFO: queue throughput and fewer empty seats at the cost of strict arrival fairness for large groups.
- Unlocked `team_members` read in billing (O6): avoids lock inversion at the cost of a documented race that is benign because `banned_at` has a single guarded writer.
- Silent backlog (O8): no email burst at first deploy, at the cost of a new column and re-creating an SSE-owned trigger.

### What Went Well

1. The phase reviewer caught a real money bug (Phase 2: one refilled seat could waive two late fees) and a spec gap (Phase 5: R15) that code review and tests had passed.
2. The Creative Reconciliation section with a binding "this section wins" rule, plus the codex critique before build, caught three high design issues (fee release not wired, re-registration erasing a fee, reversed lock order) before any code existed.
3. Two dated plan amendments (R14 to R18, R19 to R27) at the build gate absorbed three merged neighbour features cleanly; the build gate checklist (re-run SSE contract tests, re-confirm free ADR/D numbers) worked as designed.
4. Test-first evidence was recorded in the ledger for every remediation and post-build ruling.
5. Final CI was green with coverage held above the gate, and e2e created sessions through SSE's admin API rather than seed scripts, which validated the cross-feature seam.

### Challenges Encountered

1. **Double fee waiver (Phase 2 HALT)** - release budget reused one seat twice when a fee-due row re-registered; fixed by netting `liablePriorPartySize`, with property invariant I14.
2. **R15 missing (Phase 5 HALT)** - fee line named the level only from the registration snapshot; fixed with additive `me.feeLevel`.
3. **Late product-policy surprises (O5 to O8)** - see the guardrail section below.
4. **Cross-feature coupling** - D-85 widening needed a TS twin and a display/fee-lock split touching every SSE call site; O8 required re-creating an SSE-owned trigger.
5. **Reviewer availability** - Codex out of credits mid-build; Phase 2/3/4 had a Codex second opinion, later reviews were Anthropic only.

### Technical Debt & Future Work

- Ban-handler and billing mitigations for C3 rely on `banned_at` having a single writer; a future ban-date correction feature must respect billing finality (documented in ADR 0018).
- Final-review Minors left open: ban handler fixed clock can promote or release after start; logs emitted before commit; emails show only the per-person fee; withdraw has no member re-check; worker pool max 5 hardcoded (`WORKER_DB_POOL_MAX` follow-up); e2e SQL writes lack a non-localhost DB guard.
- `autoEnrolInSession` reloads state per member (about 6 queries each); acceptable now, measure when auto-enrol batches grow.
- Run `/yay:ux-ingest` to create `ux-patterns.md`, then `/yay:uat` for the registration journeys.
- ADR 0018 is Proposed until merge; SSE ADR 0019 left unchanged but rollback order is now coupled (this feature first).

---

## Dimension 2: Claude Code Ecosystem Effectiveness

### Build Session Analysis

**Build Sessions**: One `/yay:build --auto` loop in the main session, 6 phase orchestrations plus 2 remediation passes and 3 post-build fix cycles
**Sub-Agents Spawned**: Not countable from logs (see gap below). Qualitatively: one Sonnet orchestrator per phase, TDD, reviewer, verifier sub-agents per phase, a final reviewer, and creative agents (4) plus a codex critique earlier.
**Tool Calls**: unavailable
**Errors Recovered**: 2 phase HALTs, 1 destroyed generated file (verifier `git checkout`), 1 wrong-checkout verifier run

**Log gap**: no `.agent-logs/claude/by-task/registration-and-waitlist/` directory exists and `.agent-logs/claude` is absent in the worktree, so no tool counts, durations or token metrics can be extracted. This is the second consecutive Level 4 feature without task-indexed logs. Session logs not task-indexed. Run /yay:init to upgrade.

#### Tool Utilization

| Tool | Count | Success Rate | Notes |
|------|-------|--------------|-------|
| Read / Edit / Write / Bash / Task / Grep / Glob | n/a | n/a | No logs. Qualitative: Bash-heavy (pnpm ci, git, Compose for e2e), sub-agent Task per phase |

#### Sub-Agent Performance

| Agent Type | Invocations | Model | Effectiveness |
|------------|-------------|-------|---------------|
| Build orchestrator | 6 + 2 remediation | Sonnet | Good; one fresh context per phase kept pressure low; ledger carry-forwards worked ("do not re-log", "call hand-off only at/after start") |
| TDD agent | per phase | Sonnet | Good; RED seen recorded in ledger for remediations; fewer impl-first slips than the prior feature |
| Phase reviewer (spec compliance) | 6 + re-reviews | Sonnet | Excellent; caught both HALTs |
| Code reviewer (Anthropic) | per phase | Sonnet | Good; found doc and test gaps (e.g. C3 widening, B1 total line) |
| Codex adversarial review | Phases 1 to 4 (+ P5/P6 partially) | Codex | High value where available (3 high in Phase 2; P2 in Phase 3); lost to credits afterwards |
| Final whole-branch reviewer | 1 (Anthropic only) | Opus | Very good; found the only Important issue (O5) and the Minors; but single-model |
| Verifier | per phase | Sonnet | Mechanical but twice unsafe (see below) |
| Documentation agent | not evidenced | n/a | Docs updated by builders and carried to P6 |

### Command Workflow Evaluation

**Commands Used**: roadmap feature create, plan, creative (4 agents + codex critique), reconciliation, two plan amendments, build --auto (6 phases), reflect.

**Workflow Efficiency**: Good

**Assessment**:
- The plan-creative-reconcile-build sequence was effective for a Level 4 feature, and the build gate (hold build until SSE merged) avoided building against a moving target.
- The late amendments show the plan needs a step "rebase and re-read neighbour ADRs" as a first-class gate, which the project already did manually.
- `/yay:uat` was not run (no `ux-patterns.md`, no `uat-config` evidence); Playwright with axe substituted. For a Level 4 user-facing feature this is a process gap.
- Complexity classification (Level 4) was accurate; 27k added lines and 6 phases justify it.

### Context File Effectiveness

**Files Loaded**: tasks file, 4 creative docs, ADR 0015/0016/0017/0018/0019, systemPatterns, techContext, `_learned/*` (10 files).

**Assessment**:
- **Helpful**: the Reconciliation section with explicit precedence; per-phase "Phase mapping" lists; carry-forward notes in the ledger.
- **Gaps**: the task file is about 1,140 lines with a long Deviations ledger; reading it costs a lot per phase. `systemPatterns.md` Test Scope Preferences was stale (flagged in Phase 2 bucket 2, fixed in Phase 6, but it took four phases). No guidance for "ship the adapter in one phase, wire it in another".
- **Redundancy**: R-sections, creative docs and the amendments overlap; precedence rules mitigate but force agents to reconcile 3 layers.

### Memory Bank Organization

- **Structure**: Adequate. Task, creative, ADR and reflection separation is clear.
- **Navigation**: Good via the plan amendments, but the ledger needs compaction at phase boundaries (repeated from the prior reflection).
- **Completeness**: Missing `ux-patterns.md` (blocked UX conformance and UAT). No place to record "product policy questions to decide before build" as a gate artifact.

### Guardrail Misses & Root-Cause Analysis

Guard result: the commit guard recorded PASS for Phase 3 and Phase 5 and "no FAIL" for Phase 2 and Phase 6; Phase 1 and the remediation commits show the result in git log only. There were no commit-guard FAILs recorded. There were, however, 2 reviewer-gate HALTs and 4 post-build rulings, which are the real guardrail misses here.

| Event | What went wrong first time | Systemic cause | Proposed correction |
|---|---|---|---|
| Phase 2 HALT, double fee waiver | The register branch spent one seat budget on both the re-registrant's own fee and another owed fee | The algorithm doc's release rule (R2) was written for withdraw/promote steps; the interaction with R3 (fee-due re-registration) was not given a netting rule or invariant, so the TDD agent implemented each rule correctly in isolation | Algorithm creative docs should include an invariant list covering rule interactions (budget conservation) and property tests should be specified at design time; I14 added only after the HALT |
| Phase 5 HALT, R15 fee line | Fee level named only from the registration snapshot | R15 was a late amendment (2026-10-20) that landed in "Phase mapping: Phase 5" as one clause, while Phase 5's AC set and UI creative doc predated it | Amendments that change UI copy must also rewrite the AC (or a UI/UX note), not only append to the phase mapping |
| O5 auto-enrol after the cancellation deadline | Auto-enrol could place members after `cancellation_deadline`, creating instantly-late registrations | Spec treated auto-enrol as just another caller of the allocator; no question "what does automation do at/after the deadline" was asked | Spec-writer checklist item: for every automated actor, state behaviour at each time boundary |
| O8 first-deploy email burst | Wiring the real adapter makes SSE's sweep enrol and email every pending published session at first worker boot | R27/P-1 recorded the burst as an accepted consequence without a decision owner; surfaced as a product decision only at final review | Deploy-transition effects (backlog processing, one-off bursts) must be a named line in the plan's rollout or risk section requiring a human ruling |
| O6 ban at start and billing | Billing would charge a member banned before start | ADR 0015 only defined ban effect on registrations, not the interaction with billing; Phase 2 reviewer bucket 3 flagged the C3 residual "awaiting human acknowledgement" in Phase 2 and it stayed pending through Phase 6 | Residuals flagged "needs human sign-off" should block at the next phase gate or be forced at plan time rather than aging across four phases |
| O7 multi-seat late-fee waiver | All-or-nothing release was a design rounding choice ("rounding favours the player") that is a product rule | The algorithm doc made a money policy choice inside a technical document; confirmed only after build | Algorithm/creative docs must list money-affecting choices in a "Product rulings required" block that the human signs before build |

Heuristic applied: four independent agents (spec, algorithm, builders, reviewers) all missed the same class, product policy hidden in technical decisions. That points to the planning instructions, not agent error.

### Memory-Bank Corrections (from Guardrail Misses) - ACT ON THESE

| File and section | Current (stale or missing) | Correction | Evidence |
|---|---|---|---|
| systemPatterns.md, Test Scope Preferences | Was stale for four phases (flagged Phase 2, fixed Phase 6) | Verify the Phase 6 edit landed on `main` at archive; add a rule: any phase that adds a test layer updates this list in the same commit | Phase 2 reviewer bucket 2; Phase 6 carry-forward |
| systemPatterns.md, Concurrency / lock order | Canonical order is in ADR 0016/0018 only | Add the canonical order `teams -> team_members -> game_sessions -> registrations -> registration_guests/payments`, the NOWAIT backstop rule, and "reads that would invert order are unlocked and justified in an ADR" | R4, R18, O6 decision to use an unlocked read |
| systemPatterns.md, Money-affecting state | No convention for a releasable liability flag | Add: liability flags are one-way (true to false) with a DB trigger; billing reads a finalised hand-off at or after `starts_at` inside a transaction | R2, I14, `listBillableRegistrations` |
| techContext.md, Tooling (macOS) | Still assumes `timeout` for the Codex launcher (prior reflection) | Add: macOS has no `timeout`; call the companion directly or use `gtimeout`; verify Codex credits before a long auto-build | Prior feature timeout failure; this build lost Codex to credits |
| memory-bank/agent-rules/_learned/review-process-plan-claims.md | Covers verifying plan claims | Add: "residual risks marked pending human acknowledgement must be resolved or re-flagged at every phase gate" | C3 carried from Phase 2 to post-build |
| yay plan/spec-writer guidance (plugin, not memory bank) | No time-boundary or deploy-transition checklist | Add checklist: automated actors at each deadline; first-run backlog effects; billing-ban interactions; money-rounding rules | O5, O6, O7, O8 |

### Suggested Improvements to Claude Code System

**High Priority**:
1. **Product-policy pre-build gate** - add to `/yay:creative` reconcile or `/yay:plan` a required "Product rulings needed" table (money rounding, automation at time boundaries, deploy-time effects, residual risks). Blocks build until each is signed. Four rulings O5 to O8 would have been caught earlier.
2. **Verifier agents must never run `git checkout`, `restore`, `stash` or `reset`** - one verifier wiped a regenerated `openapi.yaml`. Encode this in the verifier agent prompt, not only in the orchestrator's per-run instruction; also require the verifier to assert `pwd` is the worktree (one verifier ran in the primary checkout).
3. **Reviewer backend health preflight and status line** - check Codex credits and the macOS `timeout` dependency before `--auto` starts, and record in the ledger the first phase at which a backend fell back, so reviewers know the second model is gone. Consider reserving one Codex call for the final review.

**Medium Priority**:
1. **Gate unresolved "needs human sign-off" residuals** at phase boundaries in auto-build, with a ledger field `pending_human` that the orchestrator must list in each phase result.
2. **Amendment application check** - when a plan amendment is approved, auto-generate a "touched ACs and phases" diff so late changes like R15 are not carried only in a phase-mapping clause.
3. **Ledger compaction** at phase boundaries (second consecutive feature with an over-long Deviations section).
4. **Task-indexed session logs** for worktree-based builds so Level 4 reflections have metrics.

**Low Priority / Nice to Have**:
1. `/yay:go resume-check` for branch and upstream state between phases (carried from the prior reflection).
2. Make property-test invariant lists a standard output of the algorithm creative agent for money or allocation logic.

---

## Key Learnings

### Extractable Learnings (for Continuous Learning)

1. **money-liability-flags** (`apps/api/src/modules/registrations/`, `db/migrations/`): Model owed amounts as one-way DB-guarded flags with a netting rule when two release paths can fire in one step, and test it with a conservation property.
2. **review-process-residuals** (`memory-bank/tasks/*.md`, phase gates): Re-flag every residual marked pending human sign-off at each phase gate until a ruling is recorded.
3. **planning-product-policy** (`memory-bank/creative/*.md`, spec): List money-rounding, automated-actor time-boundary and deploy-transition behaviours as named human rulings before build.
4. **verifier-safety** (`build verifier sub-agents`): Forbid git checkout, restore, stash and reset in verifier prompts and assert the worktree path before running.

### Learned Rules Applied

- `_learned/db-derived-flags-and-gates.md`: relevant to the derived `withdrawal_fee_due` and the snapshot CHECKs; applied by design.
- `_learned/testing-injected-clock.md`: relevant to deadline boundary tests and the ban handler fixed clock; applied (manual clock shared in the ban-seam tests).
- `_learned/job-queues-pgboss.md`, `_learned/api-write-idempotency.md`: relevant to promotion and auto-enrol email keys and the sweep singleton; applied.
- `_learned/testing-integration-db-isolation.md`: applied (the sweep tests got their own database for exact counts).
- `_learned/config-composition-root.md`: partially followed (adapter wired at one composition point); the hardcoded worker pool of 5 shows a remaining violation.
- `_learned/git-worktree-attached-head.md`: loaded; no detached-HEAD incident recurred this build. One verifier ran in the primary checkout, which is a different failure it does not cover.
- `_learned/review-process-plan-claims.md`: applicable; the C3 residual aging suggests extending it.
- `_learned/logging-redaction-global.md`: applicable to `registration.*` events; no violations reported.
- `_learned/auth-session-issuance.md`: not applicable.

Per-rule effectiveness cannot be confirmed from logs.

### For Claude Code Workflow

1. A reviewer gate that checks the spec rather than the diff pays for itself: it caught the only money-affecting bug and the only missed amendment.
2. Late-surfacing product decisions are a planning problem; add a gate rather than rely on the final reviewer.
3. A single-model final review is a quality risk on money code; preserve second-model capacity for the end of the run.
4. Make sub-agent safety rules part of the agent definition, not per-run instructions.

---

## Conclusion

The feature is functionally complete, thoroughly tested, and well documented, with a money-free billing hand-off that wallet-and-akahu-billing can consume. The build loop delivered most of its value through the spec-compliance reviewer and the pre-build critique and reconciliation. Its main weakness was timing: policy questions (O5 to O8) and a long-lived human-sign-off residual (C3) were discovered or resolved after BUILD_COMPLETE. The next Level 4 features that touch money or automation should surface such rulings during creative reconciliation, and verifier agents should be hardened.

**Overall Task Success**: Success

**Overall Workflow Effectiveness**: Moderately Effective (strong orchestration and review gates; late policy discovery, reviewer backend loss, verifier safety and missing logs)

**Recommendation**: Ready to archive. At archive, apply the Memory-Bank Corrections, confirm C3 acknowledgement is recorded in ADR 0018, and queue `/yay:ux-ingest` and `/yay:uat` as follow-ups.
