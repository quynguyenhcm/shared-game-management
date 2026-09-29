# Reflection: platform-foundation - Platform Foundation

## Metadata
- Task: platform-foundation
- Complexity: Level 4 (NFR / infrastructure)
- Total phases: 6 build phases, plus a final whole-branch review and one owner-approved remediation
- Duration: 2026-09-29, first commit 18:13 to last commit 22:41 (about 4.5 h wall-clock, all one day)
- Branch: `feature/platform-foundation` (22 commits ahead of local `main`, 152 files, +22,536 / -96 lines)
- Ratings: **Task Quality: Good (high end)** | **Ecosystem Effectiveness: Moderately Effective**

## Executive Summary

The task built the monorepo, the local Docker stack, CI, the full PostgreSQL 17 domain schema (26 documented deviations from the draft design), the money, time and crypto libraries, the pg-boss job runner and notification abstraction, plus 12 ADRs, a getting-started guide and refreshed `techContext.md` / `systemPatterns.md`. It has no domain logic. Ten later v1.0.0 features build on it. Final state: unit 150/150, integration 63/63, coverage about 97-99% lines, lint/typecheck/build clean, and a fresh-clone `setup -> compose up -> ci` run green in 67.6 s.

AC outcome: 25 of 32 met, 6 met-with-deviation, and AC-VERIFY-4 (a real GitHub Actions run) open because the push is blocked. None of the deviations weakens the intent of an AC. They are mostly "verified by a weaker but honest method" (closed-port pool for AC-ERROR-2, catalog snapshot in place of pg_dump when compose Postgres is absent). The upfront investment paid off. The spec passed its taxonomy check first time, and the Codex adversarial critique caught a critical cross-tenant payment-ownership hole and three high-severity race conditions before any code existed.

The main quality failure is a **planned-vs-delivered gap that slipped through all six phase reviews**. The plan called for OpenTelemetry tracing, and `techContext.md` claimed it, but Phase 5 recorded "no OTel API dependency yet" and nobody reconciled that. The final whole-branch review found it (Important I2). The same review found that `dev` never started the worker (I1). Both were fixed under an owner-approved remediation (20 new tests, RED to GREEN). The build was otherwise clean: 0 remediation loops in phase review and PROCEED on every phase. That last point shows the phase reviewer is a spec-compliance gate on the phase diff. It does not catch cross-phase claims or omissions.

The ecosystem ran well for planning and creative work. Friction was concentrated in the environment (no GitHub push, no `gh`, no Docker/Postgres/pnpm at start) and in build-agent discipline (skipped TDD in Phase 2, detached HEAD from Phase 4, a Haiku doc agent that wrote wrong content).

---

## Goals vs Outcomes

| Goal | Target | Actual | Status |
|------|--------|--------|--------|
| Acceptance criteria | 32 ACs (29 MUST / 3 SHOULD) | 25 met, 6 met-with-deviation, 1 open (AC-VERIFY-4) per the task-file AC walk | ⚠️ |
| Schema grounded in `database-design.md` | Every deviation traced | D-01..D-26 in `db/schema-deviations.md` | ✅ |
| Money never through binary float | Exact money module + lint guard | Money module, brand types, lint selector (Identifier-only gap noted) | ✅ (⚠️ hardening) |
| DST-correct time helpers | TS + SQL mirror, parity-tested | `@sgm/shared/time` + `nz_local_to_utc`, parity test | ✅ |
| Job runner | Dedup, retry, survive worker kill | Recovery after SIGKILL 9-13 s (limit 30 s) | ✅ |
| Same gates local and CI | One `ci` target | Local `ci` green; CI file lints clean under actionlint; no real Actions run | ⚠️ |
| Memory bank reflects foundation | ADRs, techContext, systemPatterns | 12 ADRs, guide, docs (with known overstatements) | ✅ (⚠️ accuracy) |
| Observability | OTel tracing, logs, metrics | Tracing added in remediation; only METRICS_* config, no exporter | ⚠️ |
| Test count | ~86 planned | 213 (150 unit + 63 integration) | ✅ |

Note on the AC count row: the task-file AC walk labels are the source of truth (AC-VERIFY-4 open; AC-VERIFY-2, -5, AC-INTEGRATION-4, AC-ASYNC-2, AC-ERROR-2, AC-ERROR-6 met-with-deviation; the remaining 25 met).

## Phase Analysis

No per-phase time estimates were written in the plan, so planned-vs-actual duration is not measurable. Commit timestamps show the whole build in about 4.5 h. That is a finding in itself (see Process Assessment).

### Phase 1: Workspace scaffold and quality gates
- Outcome: 36 unit tests RED to GREEN. Strict lint, format and typecheck gates with violation checks. Logger with deep key redaction.
- Review: PROCEED. Left stubs (`db migrate` exits 1, `--passWithNoTests`, coverage globs naming not-yet-existing modules) that were later closed.

### Phase 2: Local dev stack and CI
- Outcome: compose stack healthy in 17 s (cached), `/health` 200/503/200, Playwright smoke, actionlint clean.
- Process miss: builder skipped the TDD sub-agent (no RED evidence). The reviewer initially returned CHANGES_REQUIRED (ReDoS in a URL-userinfo regex, `err` serializer unredacted, compose ports on 0.0.0.0), fixed in-phase. This is the only phase with a real blocking finding.

### Phase 3: Domain schema and migrations
- Outcome: TDD RED 38 failing to GREEN 38/38; integration 42/42. 26 documented schema deviations. Per-test-file template-cloned databases.
- Review: APPROVED with 8 advisories, including hand-offs to three downstream features.

### Phase 4: Money, time and crypto libraries
- Outcome: RED (5 unit + 2 integration files failing on missing modules) to unit 80/80, integration 50/50; coverage 94-100%. AAD-bound encryption with key-ID prefix.
- Process miss: committed on a detached HEAD from here on.

### Phase 5: Job runner and notifications
- Outcome: 130 unit / 63 integration. pg-boss facts discovered empirically (singletonKey only on exclusive queues; both supervise and monitor intervals needed for crash recovery). Real SIGKILL recovery test.
- Missed: planned OTel not delivered, and the ledger note "no OTel API dependency yet" was accepted without escalation.

### Phase 6: Docs, ADRs, memory bank
- Outcome: getting-started, ADR 0001-0012, techContext, systemPatterns, fresh-clone verification.
- Process miss: Haiku documentation agent produced inaccuracies and overwrote systemPatterns.md after the commit. Hand-corrected. Some techContext testing statements still overstate reality.

### Final review and remediation
- Codex whole-branch review: Ready with fixes, 0 Critical / 4 Important / 5 Minor. Important items I1-I4 fixed by TDD (20 new tests), remediation review PROCEED, independent `ci` green (unit 150/150, integration 63/63), `pnpm audit --prod` clean.

## Architecture Assessment

### What Worked
- **Postgres as system of record** (CHECK, UNIQUE, FK RESTRICT, triggers): concurrency-sensitive invariants (invoice numbering, FIFO waitlist, wallet bounds, no cascade delete of financial records) are enforced where races cannot bypass them, and tested with real concurrent transactions.
- **Lean all-TypeScript stack** (Fastify + node-pg-migrate plain SQL with real downs + Kysely + pg-boss): a single language across web, api and worker removed shared-type friction. Plain-SQL migrations made triggers and sequence functions straightforward.
- **Template database cloned per test file**: stronger isolation than per-worker, cheap, and made 63 integration tests reliable.
- **Key-ID-prefixed, AAD-bound encryption**: rotatable, and the copy-to-another-row/column test proves ciphertext is not portable.
- **One DST algorithm in two places with a parity test**: avoids TS/SQL drift.
- **Documenting every schema deviation (D-01..D-26)**: made AC-INTEGRATION-1 auditable.

### What Could Improve
- **Lint guards written as Identifier-only selectors** (money, time) are evadable (`Math.round(row.amount)`). Type brands are the real defence. The guard should not be described as complete.
- **`intervalSweep` flag** in schedules can exempt any cron from the 02:00-02:59 rule. It should be narrowed to the one job, or the cron split (`*/5 0-1,3-23 * * *`).
- **`credit_transactions` is not append-only** at the DB level although it is a financial ledger. Deferred minor, but a real gap given the 7-year retention AC.
- **Permanent notifier errors fail with 0 retries**, a literal-reading departure from AC-ERROR-6. Defensible, but the AC wording should have been amended in the spec, not just noted in a ledger.

## Technical Successes

### Adversarial critique before code
- Evidence: Codex critique found 1 critical (cross-tenant payment ownership), 3 high (FIFO waitlist race, invoice same-payment race, OTHER-sex unbillable) and 1 medium (AC-ASYNC-3 overstated). All applied, spec grew from 31 to 32 ACs and gained a `fee_other` rate.
- Impact: three concurrency/ownership defects never reached implementation. This is the highest-value single step in the run.

### Behavioural verification, not just green tests
- Evidence: real `docker compose stop postgres` recovery (503 in 267 ms, 200 again with no api restart), real SIGKILL worker recovery (9-13 s), ReDoS timing test, fresh-clone run at a pinned commit.
- Impact: ACs about failure behaviour were checked against reality, and the shortfalls were recorded as deviations instead of hidden.

### Test discipline from Phase 3 on
- Evidence: RED evidence recorded in Phases 3, 4, 5 and in the remediation (20 tests RED to GREEN). Coverage 94-100% on money/time/crypto.
- Impact: after the Phase 2 miss was logged, forcing TDD by prompt worked every time.

## Technical Challenges

### Planned observability not delivered (I2), missed by six phase reviews
- Description: the plan's Observability Requirements and `techContext.md` stated OpenTelemetry tracing. Phase 5 implemented a hand-rolled `_meta.traceparent` carried via AsyncLocalStorage and recorded "no OTel API dependency yet". Each phase reviewer checked the phase diff against the phase's ACs. No AC required tracing spans, so nothing failed, and no reviewer diffed plan text against delivered code.
- Resolution: the final whole-branch reviewer compared the plan and docs against the tree and flagged it. Remediation wired `NodeTracerProvider` + `@fastify/otel`, trace/span ids in logs, and corrected the docs.
- Prevention: see Memory-Bank Corrections and Ecosystem Recommendations (plan-claims checklist per phase, and treating a ledger "not yet" against a plan item as an escalation).

### `dev` did not start the worker (I1)
- Description: `pnpm dev` ran only the api. Jobs would enqueue and never execute in local development.
- Resolution: `dev` now runs `dev:api` and `dev:worker` in parallel with a test in `scripts/root-targets.test.ts`.
- Prevention: AC-VERIFY-1 verified root command names exist but not that they start every unit. Add "each `dev`/`up` target starts all runtime units" as a check.

### Environment absent at build start
- Description: no Docker, Postgres, or pnpm. `gh` missing. GitHub push returned 403 (wrong git account), so origin/main never received the memory bank.
- Resolution: Colima + docker + compose via brew mid-run, pnpm through Corepack (pinned to 10 via `packageManager` after Corepack fetched pnpm 12), and every yay step told to "use local main".
- Prevention: a preflight in `/yay:build` (toolchain, remote reachability, `gh`) before Phase 1.

### Detached HEAD in the worktree
- Description: Phases 4-6 were committed on a detached HEAD. The branch ref stayed at 169e868 until Phase 6.
- Resolution: fast-forwarded with `git checkout -B` and verified linear.
- Prevention: assert `git symbolic-ref -q HEAD` and branch-ref equality at the start and end of every phase (the guard script checks the diff but not the ref).

### Haiku documentation agent wrote wrong content
- Description: it invented facts (static export, per-test transactions, a telemetry directory, custom metrics) and later overwrote `systemPatterns.md` after the commit.
- Resolution: hand-corrected, second version discarded. Residual overstatements remain in techContext "Unit Testing Specifics".
- Prevention: do not use a mechanical-templating model for architecture docs. Require every claim to cite a file path, and have the verifier diff docs against the tree.

### Stale/duplicate agent notifications and dispatch semantics
- Description: `run_in_background:false` dispatches ran in the background and reported by notification. A stale Phase 2 code-reviewer handback arrived late as a duplicate. An orchestrator `--help` probe of the Codex companion accidentally ran a full working-tree review.
- Resolution: handled manually.
- Prevention: see recommendations.

## Guardrail Misses & Root-Cause Analysis

The task file has **no `### Guard & Recovery Log` section** (only the Deviations ledger), and no commit-guard output was available to this reflection, so guard FAILs cannot be counted from the log. The event trail that exists:

| Event | What went wrong first time | Systemic cause | Correction |
|-------|----------------------------|----------------|------------|
| Phase 2 CHANGES_REQUIRED (ReDoS regex, `err` serializer, 0.0.0.0 ports) | Builder implemented directly and never ran RED first; security hardening was not test-driven | The orchestrator "saved context" by absorbing the TDD agent. Nothing enforced the dispatch. | Make TDD dispatch (or a RED-evidence check) a hard gate in the build orchestrator, not a soft instruction |
| Phase 2 TDD skipped | Same | Same, and the ledger accepted it rather than blocking | Reviewer must reject a phase with no RED evidence unless the phase is declared non-code |
| Phase 4-6 detached HEAD | Commits landed off-branch | No ref assertion; the worktree was likely left detached by an earlier git step (`git checkout <sha>`) | Add a ref check to the phase-start and phase-end steps |
| Phase 6 Haiku doc agent overwrote systemPatterns.md | Wrong facts, post-commit overwrite | Weak model with a templating prompt and write access to guidance files | Restrict write scope and require source citations |
| OTel planned, not built (I2) | Plan item silently dropped | Phase reviewers were scoped to the phase's ACs, and the ledger note was informational | Plan-vs-delivered reconciliation step (see below) |

Heuristic check: TDD skipping happened once (Phase 2) and was corrected by prompt, so it looks like an agent decision, not stale instructions. The OTel gap is different. `techContext.md` (written at init/plan time) asserted tracing as a fact before it existed, so the guidance itself was ahead of the code. Any agent reading it would have believed tracing was done.

## Process Assessment

### Effective Practices
- **Codex adversarial critique between plan and build**: cheapest defect removal in the whole run.
- **Whole-branch final review by a different backend (Codex)**: found the two issues six Sonnet phase reviews missed. Independent-model review earns its cost at the end.
- **Phase reviewer as a thin compliance gate with an accept/advisory ledger**: kept the build moving and preserved all trade-offs in writing. The deviations ledger is genuinely useful institutional memory (about 60 entries).
- **Spec owner decisions captured immediately** (PG15 to PG17, `fee_other`, remediation approval): no rework from ambiguity.
- **Fresh-clone verification at the last phase**: proved the getting-started guide and exposed the stale-image compose failure (fixed in docs).
- **Sequential architecture then algorithm creative**: the algorithm agent could build on the architecture choices.

### Improvement Opportunities
- **No per-phase estimates or timings recorded**: Level 4 reflection cannot compute planned-vs-actual.
- **Advisories accumulate without an owner**: about 40 advisory items were "accepted" across phases. A few were later real (A1 nodemailer file access, db rollback production guard both became I3/I4). Advisories about security hardening deserve a re-check at final review, which happened here only because the final reviewer found them independently.
- **AC wording drift**: ACs that could not be met literally (AC-ERROR-6 retry, AC-VERIFY-2 timing, AC-ASYNC-2) were handled by ledger notes and not by editing the AC. The spec still says something untrue.
- **Docs claims not verified against code**: techContext testing paragraph still overstates ("fresh Node process per test", "exit on first failure").

## Business Impact
- Value delivered: a foundation with database-enforced financial and concurrency invariants, a reproducible one-command local environment (setup 4.5 s, cached compose up 17 s, ci 67.6 s), and 12 recorded architectural decisions. Ten downstream features are unblocked.
- Risk removed: cross-tenant payment ownership, FIFO waitlist race, duplicate invoice numbers, and unencrypted bank/Akahu credentials were all designed out before feature work.
- Stakeholder feedback: spec owner approved the spec (keeping 3 extra schema fixes), decided PG17, accepted all critique findings, and approved remediation. No negative feedback recorded.
- Open business items: IRD invoice numbering needs accountant confirmation.

## Strategic Insights

### For Future Enterprise Work
- Put adversarial critique after design and before build, and keep it. It found more than all six phase reviews combined.
- A whole-branch review should explicitly diff **plan and documentation claims against the tree**, not only re-read code.
- A phase reviewer that judges only the phase diff will PROCEED on an omission if no AC names it. Cross-phase omissions need a separate gate.
- For a foundation feature, prefer behavioural verification (kill the worker, stop the DB, fresh clone) over green unit tests for failure-mode ACs.

### Reusable Components
- Template-DB-per-test-file harness (`apps/api/test`): reuse for every feature with integration tests.
- `@sgm/shared/money` + brand types, and `@sgm/shared/time` with `dst-vectors` fixtures.
- Key-ID-prefixed AAD-bound crypto helper for any new encrypted column.
- pg-boss runner wrapper with `NonRetryableJobError` and `previewSchedule`.
- Hand-offs list (below) as the entry brief for downstream features.

## Action Items

### High Priority
- [ ] Re-enable push access (correct git account / install `gh`) and run the real GitHub Actions pipeline to close AC-VERIFY-4.
- [ ] Correct `memory-bank/techContext.md` "Unit Testing Specifics" (see Memory-Bank Corrections).
- [ ] tax-invoices-and-exports: require PAID in `assign_invoice_number` and block direct `invoice_number` writes (hand-off).
- [ ] session-scheduling-engine: insert sessions as DRAFT and publish after courts exist; `fee_other` default `LEAST(male, female)` (hand-off).
- [ ] wallet-and-akahu-billing: create the wallet row before the first credit transaction (hand-off).
- [ ] Get accountant confirmation of IRD invoice numbering.

### Medium Priority
- [ ] Make `credit_transactions` append-only at the DB level.
- [ ] Narrow `intervalSweep` to `post-game-billing`, or split the cron; align AC-ASYNC-2 wording.
- [ ] Amend AC-ERROR-6 (permanent errors do not retry) and AC-VERIFY-2 (cached-image budget) so the spec matches reality.
- [ ] Extend redaction beyond snake_case keys; redact SMTP error text in job output; flush OTLP on SIGTERM; add pg/http spans; raise `telemetry.ts` coverage from about 71%.
- [ ] AAD delimiter hardening (length-prefix or validate identifiers); non-canonical base64url; `moneyFromCents` runtime bigint guard; `addHours` overflow.
- [ ] Pin CI actions by SHA and pin the actionlint image.

### Low Priority
- [ ] Remove the `dst-vectors` test fixture from the shared exports map if a cleaner sharing route exists.
- [ ] Template DB sweeper for leaked `sgm_tpl_*` databases on failed global setup.

## Claude Code Ecosystem Strategic Evaluation

### Executive Summary

Moderately effective. Plan and creative were strong, and Codex critique plus Codex final review were the best-performing seams. The phase pipeline produced good code and a good ledger, but process enforcement was soft: TDD skipped once, a detached HEAD went undetected for three phases, and the docs agent was unreliable. Environment preflight was absent, so a blocked remote and missing toolchain surfaced mid-run.

**Build Session Analysis note**: no session logs exist. `.agent-logs/claude/by-task/` and `.agent-logs/claude/` were absent in both the primary checkout and the worktree (the SessionEnd hook had not fired). Tool-call counts, per-tool success rates and per-agent token use therefore **could not be measured**, and the tables below use "n/a" where the data is missing. Metrics are derived from git history and the task file: 22 commits (5 plan/creative/docs, 1 build start, 6 phase code commits, 6 phase-review commits, final review, remediation, ledger tidy), 6 phase reviews (1 CHANGES_REQUIRED then fixed, 5 APPROVED first pass), 0 phase remediation loops beyond the Phase 2 in-phase fix, 1 final review, 1 remediation review.

### Command Architecture Assessment

| Command | Phases Used | Effectiveness | Strategic Notes |
|---------|-------------|---------------|-----------------|
| /yay:init | once | 4 | Worked, but memory bank existed only on local main; origin lacked it, forcing "use local main" in every later step |
| /yay:plan | once | 5 | Opus spec writer: 31 ACs, taxonomy clean first pass, test strategy and 6-phase roadmap |
| /yay:creative | architecture, then algorithm | 5 | Sequential Opus agents; spec owner changed PG15 to PG17 mid-run and it was absorbed cleanly. Codex critique 5 findings, all applied |
| /yay:build --auto | 6 phases + final review + remediation | 3 | Good output; soft enforcement (TDD, HEAD, docs agent), 6 PROCEEDs but missed the tracing gap |
| /yay:reflect | this run | 4 | Handicapped by absent logs and no Guard & Recovery Log section |
| /yay:archive | pending | n/a | Must handle a local-only, unpushed branch |
| /yay:verify | not used as a command | n/a | Verification ran inside the build |

**Command Gap Analysis:**
- Preflight/doctor-for-build: toolchain, remote reachability, `gh` and git identity check before Phase 1 (`/yay:doctor` exists but is not invoked by build). Level 2 task.
- Local-only mode: a first-class flag that suppresses push attempts and records "no remote" once, instead of a per-phase "push skipped" ledger line.

### Workflow Architecture Assessment

| Phase | Duration | Friction Level | Value Delivered |
|-------|----------|----------------|-----------------|
| INIT | not recorded | Med | Roadmap of 11 features; remote/branch gaps |
| PLAN | not recorded | Low | Very high; approved spec with 3 schema fixes kept |
| CREATIVE | not recorded | Low-Med | Very high; PG17 change and critique fixes |
| BUILD | about 4.5 h total incl. remediation | High (environment), Med (process) | Full foundation delivered |
| REFLECT | this run | Med | Limited by missing logs |
| ARCHIVE | pending | unknown | Local-only merge path |

**Workflow Recommendations:**
- Record phase start/end timestamps in the Execution State so Level 4 reflection can compute planned-vs-actual.
- Keep the critique step mandatory for Level 4.
- Keep the final whole-branch review on a different backend from the phase reviewers.

### Context System Assessment

| Context Category | Files Loaded | Usefulness | Token Efficiency |
|------------------|--------------|------------|------------------|
| Level-specific | level4 plan/creative/build/reflection rules | 4 | Acceptable |
| Agent prompts | spec-writer, creative agents, build-orchestrator, phase reviewer, final reviewer, Haiku docs agent | 4 (docs agent 1) | Good except docs agent |
| Phase guidance | task file (about 723 lines, roughly 38k tokens) | 5 for content, 2 for size | Poor: the task file exceeds a single Read limit and had to be read in slices |

**Context Gaps:**
- `techContext.md` was written with claims (OTel tracing, testing details) ahead of, or unsupported by, the code. It should distinguish "planned" from "built".
- No documented convention for "local-only" runs.
- The task template had no Guard & Recovery Log section, so this reflection could not evaluate guard behaviour.

**Context Redundancy:**
- The Deviations ledger duplicates some review advisories, and the same items appear in the phase entry, the review record and later "accepted" lines. Consolidate to one entry per item with a status field.

### Tool Utilization Analysis

| Tool | Operations | Success Rate | Limitations Encountered |
|------|------------|--------------|-------------------------|
| Grep / Glob / Read / Edit / Write / Task / Bash | n/a (no session logs) | n/a | Task file too large for one Read call; sandbox denied `rm -rf`, `docker compose down`, and `curl` in verifier shells |

**Tool Gap Analysis:**
- Session-log capture that survives until reflection (SessionEnd hook timing).

**Workarounds Required:**
- Colima/brew install of Docker and compose mid-run; Corepack pnpm pin.
- `git checkout -B` to repair the detached HEAD.
- Hand-correction and discard of the Haiku docs output.
- Manual verification of `/health` recovery where the sandbox blocked `curl`.

### Subagent Architecture Assessment

| Agent Type | Invocations | Output Quality | Prompt Issues |
|------------|-------------|----------------|---------------|
| Spec writer (Opus) | 1 | 5 | None; taxonomy clean first pass |
| Creative architecture (Opus) | 1 | 5 | None |
| Creative algorithm (Opus) | 1 | 5 | None |
| Codex critique | 1 | 5 | 5 findings, all valid |
| Build orchestrator (Sonnet) | 6 | 4 | Skipped TDD in Phase 2; left detached HEAD in Phases 4-6 |
| TDD agent | 4 confirmed (Phases 3-5, remediation); 0 in Phase 2 | 4 | Only dispatched when forced by prompt |
| Phase reviewer (Sonnet) | 6 | 3 | Catches phase-scope defects (ReDoS, ports); blind to plan-vs-delivered gaps |
| Code reviewer | 1+ per phase | 4 | One stale duplicate handback |
| Verifier | per phase | 4 | Blocked by sandbox for curl |
| Documentation (Haiku) | 1 (Phase 6; others not dispatched) | 1 | Fabricated facts, overwrote a guidance file post-commit |
| Final reviewer (Codex) | 1 + remediation review | 5 | Found I1-I4 and 5 minors |
| General-purpose (applied creative AC edits) | 1 | 3 | Worked, but an unusual route for spec edits |

**Agent Prompt Improvements:**
- build-orchestrator: hard requirement for RED evidence and for a branch-ref check at phase start and end.
- phase reviewer: add a "plan and doc claims vs delivered" checklist item, and treat a ledger "not yet" against a plan item as an escalation.
- documentation agent: require a file path citation for every claim, forbid writing to `systemPatterns.md`/`techContext.md` after the commit, and prefer Sonnet or human review for architecture docs.

**New Agent Types Needed:**
- Preflight/environment agent (toolchain, remote, git identity), Haiku-grade is fine here.
- Plan-reconciliation agent that diffs plan and docs claims against the tree after each phase (cheap, mechanical, would have caught I2 at Phase 5).

### Memory Bank Architecture Assessment

| Document Type | Created | Utility | Maintenance Burden |
|---------------|---------|---------|-------------------|
| tasks/platform-foundation.md | Y | 4 | High (723 lines, ledger sprawl) |
| creative/*.md | 2 (807 and 1099 lines) | 5 | Low, static |
| reflection/*.md | Y (this) | 3 | Low |
| archive/*.md | pending | n/a | n/a |
| docs/adr/0001-0012 | Y | 4 | Low; five ADRs omit alternatives and rely on links |
| db/schema-deviations.md | Y | 5 | Low |

**Knowledge Preservation Quality:** strong for decisions (ADRs, creative docs, deviations). Weak for verified operational facts (techContext testing paragraph).

**Cross-Reference Effectiveness:** good. ACs link to creative sections, and deviations link to files and lines. Untracked spec docs (`database-design.md`) were missing from worktrees until committed, an avoidable break in discoverability.

### Ecosystem Scalability Assessment

| Metric | Observation | Impact |
|--------|-------------|--------|
| Context window pressure | High for the orchestrator (task file about 38k tokens; Phase 2 skipped TDD "to save context") | Directly caused a process miss |
| Token efficiency | Acceptable, not measurable (no logs) | Unknown |
| Phase handoff quality | Acceptable | Ledger good; git ref state and plan-claim carry-over rough |
| Recovery from errors | Good | Detached HEAD, stale image, Haiku overwrite all recovered without data loss |

### Strategic Improvement Recommendations

> Recommendations only. None implemented here. Scope estimates are the level of a task to implement.

#### Immediate (High Priority)
| Recommendation | Component | Rationale | Expected Benefit |
|----------------|-----------|-----------|------------------|
| Add a plan-vs-delivered reconciliation step to each phase review (Observability Requirements, Architectural Principles, doc claims vs tree) | phase-reviewer prompt; build command Step for review (Level 2) | OTel omitted through 6 PROCEEDs and only caught at final review | Cross-phase omissions caught within the phase that introduced them |
| Assert `git symbolic-ref HEAD` equals the feature branch and ref equals commit at phase start and end | build-orchestrator, `scripts/commit-guard.sh` (Level 2) | Phases 4-6 committed on a detached HEAD unnoticed | Prevent orphaned commits |
| Require RED evidence or an explicit "non-code phase" declaration; reviewer rejects otherwise | build-orchestrator and phase reviewer prompts (Level 2) | Phase 2 skipped TDD and produced the only blocking review finding | TDD applied consistently without per-prompt repetition |
| Restrict the documentation agent: no Haiku for architecture docs, citations required, no writes to guidance files after commit | build-documentation-agent (Level 2) | Fabricated facts and post-commit overwrite | Trustworthy techContext/systemPatterns |
| Add a `### Guard & Recovery Log` section to the level 4 task template | task template (Level 1-2) | Reflection could not audit guard misses | Auditable guardrail history |

#### Short-term (Medium Priority)
| Recommendation | Component | Rationale | Expected Benefit |
|----------------|-----------|-----------|------------------|
| Build preflight (docker, postgres, package manager, remote reachability, `gh`, git identity) | `/yay:build` Step 0 or `/yay:doctor` hook (Level 2) | Toolchain and push failures discovered mid-run | Fail fast, one clear message |
| First-class local-only flag | build/archive commands (Level 2-3) | Every phase logged "push skipped"; origin lacked the memory bank | Consistent handling, correct archive path |
| Advisory re-check at final review: list all "accepted" security advisories and require a disposition | final-reviewer prompt (Level 2) | A1/I3 and Phase 3 A1/I4 were accepted early and became Important at the end | Fewer late surprises |
| Timestamp each phase and record estimates in the roadmap | task template, build (Level 1-2) | Planned-vs-actual not computable | Real process metrics |
| Keep AC text truthful: when an AC is met-with-deviation, propose the AC edit to the owner | build/verify (Level 2) | AC-ERROR-6, AC-VERIFY-2, AC-ASYNC-2 still read as literal-but-false | Spec matches system |
| Fix dispatch semantics: `run_in_background:false` should block, and stale handbacks should be deduplicated | build orchestration (Level 3) | Duplicate notifications and unexpected background runs | Cleaner orchestration |

#### Long-term (Strategic)
| Recommendation | Component | Rationale | Expected Benefit |
|----------------|-----------|-----------|------------------|
| Split large task files: keep the ledger in a companion file | memory-bank layout (Level 3) | 723-line, 38k-token task file forces sliced reads and context pressure | Lower orchestrator context load |
| Persist session logs at write time rather than at SessionEnd | hooks (Level 2-3) | Reflection had no tool/agent metrics | Data-driven ecosystem evaluation |
| Mark techContext statements as "built" vs "planned" with an automated check against the tree | memory-bank tooling (Level 3) | techContext claimed OTel before it existed | No aspirational facts in guidance |

### Patterns Worth Codifying
1. **Critique-then-build for Level 4**: adversarial review of spec plus design before any code, with all findings dispositioned in the task file.
2. **Two-backend review**: cheap phase gates, then a different model family for the whole-branch review.
3. **Behavioural AC verification**: kill/stop/clone the real system for failure-mode ACs and record any weaker fallback as a named deviation.
4. **Template-DB-per-test-file integration harness.**
5. **Deviation ledger with `Phase | artifact | rationale` entries** plus a separate schema-deviations file with stable IDs (D-01..D-26).

## Memory-Bank Corrections (from Guardrail Misses) - ACT ON THESE

| File · section | Current (stale/wrong) | Correction | Evidence |
|---|---|---|---|
| `memory-bank/techContext.md` · Unit Testing Specifics | Says "fresh Node process per test" and "exit on first failure"; says `test:e2e` runs against `dev` | Remove the two claims (not configured); state that `test:e2e` needs the compose stack | Phase 6 ledger entry, accepted as minor; Haiku doc-agent inaccuracies |
| `memory-bank/techContext.md` · Observability | Before remediation claimed OTel tracing while the code had none; now tracing exists but metrics do not | Confirm the section lists: tracing built (opt-in via `OTEL_EXPORTER_OTLP_ENDPOINT`/console), no metrics exporter, only `METRICS_*` config, no pg/http spans, no OTLP flush on SIGTERM | I2 final-review finding; Phase 6 "only METRICS_* config" |
| `memory-bank/systemPatterns.md` · full file | Second Haiku version was discarded; committed version verified | Diff once against the tree at archive to confirm no residue of the discarded content (static export, per-test transactions, telemetry dir) | Phase 6 doc agent overwrite |
| Spec · AC-ERROR-6 | "Failing notification is retried" | Amend: transient errors retry with backoff; permanent/configuration errors fail with 0 retries via `NonRetryableJobError` | Phase 5 deviation |
| Spec · AC-ASYNC-2 | 02:00-02:59 no-fire rule | Amend for `post-game-billing` fixed-interval exemption, or split the cron | Phase 5 deviation |
| Spec · AC-VERIFY-2 | `docker compose up -d --wait` in 120 s | State the budget applies to cached images, first build is longer (106.7 s with `--build` partly cached) | Phase 6 deviation |
| Task template · Execution State | No Guard & Recovery Log section | Add it | Reflection could not audit guardrail behaviour |

## Key Learnings

### Extractable Learnings (for Continuous Learning)

1. - **review-process** (`memory-bank/tasks/*.md`, Observability/Architectural Plan sections): Diff plan and documentation claims against the built tree at each phase review, not only the phase's ACs.
2. - **testing-patterns** (`apps/api/test/`, `*.int.test.ts`): Give each integration test file its own database cloned from a migrated template, and give concurrency tests a separate clone.
3. - **git-workflow** (`worktree builds`): Assert HEAD is attached to the feature branch and the ref matches the last commit at the start and end of every build phase.
4. - **job-queues** (`apps/api/src/lib/jobs`, pg-boss): Set both supervise and monitor intervals for crash recovery, use exclusive-policy queues for singletonKey dedup, and fail permanent errors through a non-retryable error type.

### Learned Rules Applied
No learned rules available (`memory-bank/agent-rules/_learned/` on main contains only `.gitkeep`).

### For Claude Code Workflow

1. Independent-model review at the end (Codex) catches what same-family phase reviewers miss; keep it and consider running it at the design and build midpoint for Level 4.
2. Soft process instructions decay under context pressure ("save context" skipped TDD). Encode them as gates the orchestrator cannot skip.
3. A mechanical-model doc agent with write access to guidance files is a net negative. Guidance files are the highest-leverage context in the system, so protect them.
4. Preflight environment and remote checks belong at the start of build, not discovered per phase.
5. Ledger entries marked "accepted" for security items should be re-opened at final review.

## Conclusion

The foundation is sound: database-enforced invariants, exact money, DST-safe time, encrypted secrets, a job runner that survives a worker kill, and a reproducible environment verified from a fresh clone. The unresolved risks are known and written down: AC-VERIFY-4 (no real CI run), three downstream hand-offs, IRD numbering confirmation, and a short list of minors. The build's gaps came from process enforcement (a plan item dropped without a gate, a detached HEAD, a skipped TDD dispatch, an unreliable docs agent), not from design quality. The design work, Codex critique and final review were the most reliable parts. Fixing the phase-review scope and adding a few hard gates would remove most of this run's friction.

**Overall Task Success**: ✅ Success (with AC-VERIFY-4 open, 6 accepted deviations)

**Overall Workflow Effectiveness**: ⚠️ Moderately Effective

**Recommendation**: Ready to archive after the local-only path is decided (push access or local merge). Apply the Memory-Bank Corrections at archive, and open follow-up Level 2 tasks for the Immediate ecosystem recommendations.

## References
- Task: `memory-bank/tasks/platform-foundation.md`
- Creative: `memory-bank/creative/platform-foundation-architecture.md`, `memory-bank/creative/platform-foundation-algorithm.md`
- ADRs: `docs/adr/0001` to `0012`; schema deviations: `db/schema-deviations.md`; guide: `docs/getting-started.md`
- Timeline: `git log --oneline main..feature/platform-foundation`
