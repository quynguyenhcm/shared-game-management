# Reflection: player-dashboard - Player Dashboard

**Date**: 2026-11-17
**Task Complexity**: Level 2
**Total Phases**: 3 (API read models, Web dashboard, E2E/a11y/docs) plus one post-review fix
**Duration**: 2026-11-14 (spec review, plan) to 2026-11-17 (post-review fix)

## Executive Summary

The task delivered the player-facing `/dashboard` with three URL-driven, no-JS tabs (Currently Opening, My Registration, Payments & Wallet), a header link, proxy protection, two new read-only aggregate endpoints (`GET /me/sessions/open`, `GET /me/registrations`) and an additive `status=PAID` extension of `GET /payments/me`. No migration was needed (`idx_registrations_user` already existed; confirmed with EXPLAIN ANALYZE on 60k rows). It was built with `/yay:build --auto`: a fresh orchestrator per phase, a per-phase compliance reviewer (all PROCEED), and a Codex whole-branch final review.

Final state: 4364/4364 tests, 96.42% statement coverage, typecheck, lint, build and openapi drift pass, and Playwright 10/10 (desktop and 360 px) at Phase 3. All 19 ACs are met or covered with recorded deviations. The one significant miss was Important #1 from the final review: the Overdue/Pending/Paid accordion counts were derived from the loaded page's rows. The Phase 2 reviewer had explicitly accepted this as "polish", although an existing learned rule (`review-process-plan-claims.md`) says reviewers must reject counts derived from loaded rows. The human ruled for server totals; the fix (79fd2dd) adds `counts {overdue,pending,paid}` to `GET /payments/me`.

Overall the work is high quality. The process lesson is that a learned rule existed, was relevant, and still did not reach the per-phase reviewer, so the whole-branch review had to catch the same class of defect for the second time (session-scheduling-engine was the first).

---

## Dimension 1: Task Implementation Quality

### Requirements Achievement

**Status**: ✅ All Met (with recorded, accepted deviations)

- ENTRY-1/2/3 (header link, URL-driven tabs, signed-out redirect with `returnTo` and `no-store`): met. A Codex P2 on the redirect's `cache-control: no-store` was fixed in Phase 2 for every protected path.
- HAPPY-1..5: met in the API integration tests and web view-model tests. HAPPY-2 is end to end only for Register, View registration and the debt banner; `Join waitlist` and blocked `View session` are unit-tested only (one overdue payment does not reach DEBT_LIMIT 3).
- HAPPY-6 (paging): `status=PAID` pages of 50 with independent cursors (`paidCursor`, `unpaidCursor`). The remaining behaviour is that a later unpaid page shows only that page's rows (no accumulation). This is consistent with the existing `/payments` pager but is a known UX limit.
- HAPPY-7 (scoping, read-only guard): met, with a structural boundaries test and two-player isolation.
- HAPPY-8 (a11y/responsive): met in Playwright (axe, no horizontal scroll, 44 px) on both projects.
- ERROR-1..6, ASYNC-1/2: met. ERROR-3 is proven end to end only for `invoice_not_available`; `invoice_pending` and `service_unavailable` are unit-tested because the e2e stack cannot provoke them reliably.
- The post-review fix means the accordion counts now match AC-HAPPY-5's intent. Before it, `Overdue (n)` was wrong on any later unpaid page.

No scope creep. The four open spec choices were ruled up front (2026-11-14), which kept Level 2 free of a creative phase.

### Code Quality Assessment

**Overall Rating**: Good

- **Maintainability**: Pure view models in `lib/dashboard/{paths,labels,view}.ts` with a single copy deck; reuse of `PaymentRow`, `walletState`, `paymentTag` etc. rather than copies. Weak spots are the deferred duplication items below.
- **Architecture**: Read-only `player-dashboard` module that reuses the registrations fee and access helpers; no new write paths; tabs and accordions as native links and `<details>`. Sound and consistent with the project's patterns.
- **Error handling**: Per-section degradation, `sessionExpiredUrl` on 401, cursor 422 falls back to page 1, structured `web.dashboard.api_failure` with no sensitive data.
- **Testing**: 4364 tests overall; the new tests map to ACs; integration tests on real PostgreSQL assert totals across 120 PAID and 60 PENDING payments. Gaps are listed under Challenges and Technical Debt.

### Technical Decisions

**Key Decisions:**
1. New cross-team aggregate endpoints instead of N+1 fan-out for Tabs 1 and 2 - one call per tab, scoped by the authenticated user, `no-store`.
2. `Top up credit` and `Pay now` are link-throughs to existing pages; the dashboard never calls the payments gateway - this made the dashboard independent of Akahu Phase 4b (not live) and satisfied AC-ERROR-2 by construction.
3. Wallet fan-out through existing `GET /teams/:teamId/wallet` per approved team rather than a new `GET /me/wallets` - avoided new surface; acceptable while teams per player are small (open question 6 never got a membership cap answer).
4. Server-provided accordion totals (`counts`) rather than counts from loaded rows - fixes the Important finding and is the correct authoritative-read design.
5. Cursor formats are shared between PAID and UNPAID, so the web keeps them in separate query params.

**Trade-offs:**
- Open sessions capped at 50 with `hasMore` and no Show more: simpler, but a player beyond 50 silently loses sessions (Minor #3).
- Not re-running Playwright after the totals fix: saved a long e2e run; the seeded data fits one page so titles are unchanged, but the new `counts` path is covered only by integration and unit tests.

### What Went Well

1. Spec drafting and human review up front (19 ACs, 10 ruled questions) removed the need for a creative phase and kept the build free of design halts.
2. Phase reviews and the Codex per-phase review produced real fixes (no-store on redirect, e2e stack guard, frozen test date).
3. The final whole-branch review found the one real defect, and the human ruling was recorded in the task file with a clean fix and test evidence.
4. The Guard & Recovery Log is empty: no commit-guard failures and no sub-agent re-invocations.
5. E2E ran on a separate `sgm-e2e` compose project, leaving the dev stack untouched.

### Challenges Encountered

1. Accordion counts from loaded rows passed Phase 2 review as "accepted polish" and were caught only at the final review - fixed with server totals (see Memory-Bank Corrections and Improvements).
2. A fresh worktree had no `node_modules` or `.env` - resolved with `pnpm install` and `scripts/setup.ts`.
3. Known flaky tests appeared once (registrations-sse first-fit, invoices-schema migration round trip; 4359/4360 at Phase 3, 5/5 in isolation).
4. Codex per-phase review needed a direct companion call because macOS has no `timeout` (already in auto-memory).

### Technical Debt & Future Work

Deferred Minor findings from the final review:
- `seatsLineOf` in `lib/dashboard/view.ts` duplicates `seatsLine` in `lib/registrations/labels.ts`; import the existing one.
- The "snapshot prices a CONFIRMED row or an owed late fee" rule exists in three places (`player-dashboard/service.ts` `pricingPerson` and inline `openSessions`, `registrations/read-model.ts` `snapshotApplies`); extract one shared predicate with a test, since drift here is a money-display bug.
- Currently Opening ignores `hasMore` silently beyond 50.
- Upcoming in `GET /me/registrations` has no row cap.
- `operationId listMyUnpaidPayments` now also serves PAID; rename (breaking for generated clients, so consider an alias) or document.
- AC-ERROR-3 end to end only for `invoice_not_available`.
- Later unpaid pages do not accumulate rows.
- Open question 5 (post-login landing on `/dashboard`) remains a follow-up task.

---

## Dimension 2: Claude Code Ecosystem Effectiveness

### Build Session Analysis

No `.agent-logs/claude/by-task/player-dashboard/` directory exists, so session-log metrics (tool counts, session durations, error counts) could not be extracted. Figures below come from the task file and the caller's summary only.

**Build Sessions**: one `/yay:build --auto` run (3 phase orchestrators plus a post-review fix session)
**Sub-Agents Spawned**: not countable from logs; per the task file: 3 build orchestrators, 3 phase reviewers, 1 Codex final review, plus per-phase Codex reviews
**Tool Calls**: not available
**Errors Recovered**: guard FAILs 0; sub-agent re-invocations 0

#### Tool Utilization

Not available (no task-indexed logs). Qualitative notes: Codex per-phase review required a manual direct companion call on macOS; dispatches sometimes returned "async launched" and required waiting for notifications.

#### Sub-Agent Performance

| Agent Type | Invocations | Model | Effectiveness |
|------------|-------------|-------|---------------|
| Build orchestrator | 3 | Sonnet | Effective; no re-invocations |
| Phase reviewer (auto-build) | 3 | n/a | Mixed: all PROCEED and several real ledger items, but accepted a rule-violating count derivation |
| Codex per-phase review | 3 | Codex | Effective: 1 P2 (Phase 2), 1 P1 and 1 P2 (Phase 3); needed manual invocation |
| Final reviewer (Codex) | 1 | Codex | High value: the only reviewer to catch Important #1 |
| Verifier | 3 | n/a | Did not revert `openapi.yaml` this time (watched for) |

### Command Workflow Evaluation

**Commands Used**: brainstorm/roadmap/plan (spec, human review), build --auto (3 phases + final review), reflect.

**Workflow Efficiency**: Good

- Spec-first with human rulings on every open question worked well for a Level 2 with LOW-confidence items; no creative phase was needed and the complexity classification was accurate.
- The auto-build loop kept human review to the spec gate and the final-review ruling, which was the right place for the one product decision (counts).
- The loop failed to apply an existing learned rule at the per-phase gate (below).

### Context File Effectiveness

**Files Loaded**: task file, `systemPatterns.md`, `techContext.md`, `productBrief.md`, learned rules.

- **Helpful**: the task file's explicit "reused vs new" table, Test Strategy and per-phase test guidance gave agents concrete targets.
- **Gaps**: the learned rule on authoritative server reads was not enumerated by the phase reviewer. The spec's AC-HAPPY-5 said `Overdue (1)` with a count in the summary but did not name the authoritative server read for that count; the learned rule asks for exactly that.
- **Redundancy**: none noted.

### Memory Bank Organization

- **Structure**: intuitive; deviations ledger plus phase results made the final review and this reflection straightforward.
- **Navigation**: fine. The missing task-indexed session log directory limited the metrics analysis.
- **Completeness**: no missing document types.

### Memory-Bank Corrections (from Guardrail Misses) — ACT ON THESE

There were no commit-guard FAILs or re-invocations. There was, however, a review-gate miss with the same systemic character: a defect caused by a rule not reaching the reviewer. Corrections:

| File · section | Current (stale/wrong) | Correction | Evidence |
|---|---|---|---|
| `agent-rules/_learned/review-process-plan-claims.md` (frontmatter + UI-AC bullet) | `derived_from` lists 7 tasks; the bullet on "reject a section, count or banner derived from loaded rows" has `evidence_count: 7`, `last_validated: 2026-10-30` | At archive: add `player-dashboard` to `derived_from`, bump `evidence_count`, refresh `last_validated`, and add that a *phase reviewer accepting this as polish* is itself the failure mode; cite `view.ts` `paymentAccordions` | Phase 2 reviewer accepted `unpaidMore`/count behaviour (Deviations, Phase 2); final review Important #1; fixed in 79fd2dd |
| plan/spec template (Spec Writer agent output for ACs) | AC text such as `Overdue (1)` names a count without its authoritative read | Spec Writer must add, for each AC that lists, counts or warns, the endpoint/field that supplies it (and flag when no such field exists, so Phase 1 adds it) | AC-HAPPY-5 had no server count; Phase 1 API shipped without `counts`; the fix needed an API change after Phase 3 |
| `memory-bank/techContext.md` / `systemPatterns.md` | Not verified here | Document the `counts` field on `GET /payments/me`, the shared PAID/UNPAID cursor format, and that `listMyUnpaidPayments` now serves PAID | Post-review fix; Phase 3 doc update predates it |

### Suggested Improvements to Claude Code System

**High Priority**:
1. Give the per-phase compliance reviewer the matching learned rules. Inject `agent-rules/_learned/review-*.md` (or all rules whose globs match the phase diff) into the `yay:auto-build-phase-reviewer-agent` dispatch, with a required line in its output: "learned rules checked: <list> / violations: <list>". Here the rule existed, matched, and was not applied by the Phase 2 reviewer; as the rule itself says, a learned rule is not a check until a reviewer enumerates it.
2. Make "accepted as polish" a guarded verdict. If a reviewer accepts a deviation that a learned or agent rule forbids, the review must either reject it or escalate it as a named human ruling; the ledger should flag "contradicts rule X" so the final reviewer sees it first.
3. Spec Writer: for each AC that lists, counts, labels or warns, require a named authoritative server read, and have the Phase 1 (API) reviewer check that the field exists.

**Medium Priority**:
1. Fix Codex per-phase review invocation on macOS (missing `timeout`): use a portable timeout wrapper or `gtimeout` fallback in the yay plugin instead of requiring a manual direct companion call every time.
2. Worktree bootstrap: have `build-git-setup-agent` run `pnpm install` and `scripts/setup.ts` (or a project-configured bootstrap command from `projectConfig.md`) when creating a worktree.
3. "async launched" returns from agent dispatch should be handled by the orchestrator (wait for the notification) rather than needing manual prompting.
4. Create `.agent-logs/claude/by-task/<slug>/` for auto-build runs, or have reflect state how to compute metrics when it is absent.

**Low Priority / Nice to Have**:
1. Quarantine or fix the known flaky tests (registrations-sse first-fit, invoices-schema migration round trip) so a single failure does not require re-running in isolation to clear the gate.
2. Offer an "e2e re-run" check after API contract changes in a post-review fix, even when seeded data is expected to be unchanged, or at least a cheap targeted spec run.

**Note**: Suggestions only; nothing was implemented.

---

## Key Learnings

### Extractable Learnings (for Continuous Learning)

1. **review-process** (`memory-bank/tasks/*.md`, phase review hand-offs): Give the phase reviewer the matching learned review rules and require it to list which ones it checked and any it found violated.
2. **ui-read-models** (`apps/web/src/lib/**/view.ts`, `apps/api/src/modules/**`): Return section totals (counts, headroom, badges) from the API; never derive them from the rows on the loaded page, and add the field in the API phase.
3. **review-process** (`memory-bank/tasks/*.md`): Treat "accepted as polish" on a deviation that contradicts a learned rule as a rejection or a named human ruling.
4. **duplication-of-policy** (`apps/api/src/modules/**/read-model*.ts`, `service.ts`): Extract a business predicate that appears in two or more modules (here "snapshot prices a CONFIRMED row or owed late fee") into one tested function before adding a third copy.

(Level 2 normally allows 1-2 learnings; items 1 and 2 are the strongest, items 3 and 4 may be merged into existing topic files at archive.)

### Learned Rules Applied

- `review-process-plan-claims.md`: relevant and decisive. The final reviewer applied its "reject counts derived from loaded rows" bullet and found Important #1; the Phase 2 reviewer did not apply it and accepted the same pattern. This is the second feature (after session-scheduling-engine) where a whole-branch review had to catch what the rule already described, which supports raising its priority from `low`/`medium` or moving the UI-AC bullet into the phase-reviewer's mandatory checklist. Other learned rules: loaded but not separately assessed here.

### For Claude Code Workflow

1. A learned rule that is only loaded as context is weaker than one enumerated in a checklist; wire rules into reviewer output, not only reviewer input.
2. The final whole-branch review remains the highest-yield gate; keep it mandatory in `--auto`.
3. Resolve spec ambiguity about data sources at spec time: an AC that shows a number should say where the number comes from.

---

## Conclusion

The player dashboard shipped complete, tested (4364 tests, 96.42% coverage, Playwright 10/10) and without a migration, with a small and well-recorded set of deferred Minor items. The one real defect, accordion counts derived from loaded rows, was fixed with a server-side contract change after a human ruling. It escaped the per-phase review although a learned rule already forbade it, so the main improvement is to make learned rules visible to and enumerated by the phase reviewer. The deferred duplication of the snapshot-pricing rule is the item most worth a near-term follow-up, since it is money display logic.

**Overall Task Success**: ✅ Success

**Overall Workflow Effectiveness**: ⚠️ Moderately Effective (the spec, build and final-review loop worked; the per-phase reviewer missed a rule it should have applied; Codex-on-macOS and worktree bootstrap needed manual work)

**Recommendation**: Ready to archive. At archive, apply the Memory-Bank Corrections (update `review-process-plan-claims.md` frontmatter and bullets, and document the `counts` field and the shared cursor format), and file follow-up tasks for the snapshot-rule duplication, the 50-session cap, and the post-login landing.
