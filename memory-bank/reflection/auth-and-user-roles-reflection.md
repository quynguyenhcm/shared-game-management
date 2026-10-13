# Reflection: auth-and-user-roles - Auth and User Roles

**Date**: 2026-10-07
**Task Complexity**: Level 3
**Total Phases**: 6 build phases (auto-build), 1 final cross-phase review, 1 post-review fix commit
**Duration**: 2026-10-06 (plan and creative, commit 6e0d753) to 2026-10-07 (final-review fixes, ff89da5). Per-phase timestamps were not recorded, so planned-vs-actual cannot be computed (same gap as platform-foundation).
**Branch**: `feature/auth-and-user-roles`, stacked on `feature/platform-foundation` (63dbc43). Task range is `6e0d753^..HEAD`: 17 commits, 204 files, +23,499 / -520 lines.
**Ratings**: **Task Quality: Good (high end)** | **Ecosystem Effectiveness: Moderately Effective**

## Executive Summary

The task delivered self-registration and sign-in by email/password, Google and Facebook; opaque DB-backed sessions with idle and absolute expiry; argon2id hashing; a Postgres sliding-log login throttle; password reset through the job queue; OAuth account linking with a "never auto-link" rule plus reset-evicts-OAuth (R1/D1); a declarative default-deny route policy with global and per-team role guards; a CLI to grant `GLOBAL_ADMIN`; and the full web UI (register, login, reset, `/register/complete`, `/account`, header, proxy). The 52-AC spec has all six roadmap phases checked. Final verification after the fix commit: `pnpm run test:coverage` 81 files / 627 tests passing, 96.06 / 89.96 / 98.12 / 97.59 % coverage, typecheck, ESLint and prettier clean. Playwright was last run in Phase 6 (35 passed, 3 desktop-skipped phone-layout tests) and was not re-run after 170bd5f, nor was `pnpm run build`.

The headline quality story is the same as platform-foundation: six per-phase reviews returned PROCEED, and the Codex whole-branch review then found one **Critical** and three security-relevant **Importants** that none of them saw. The Critical was real and would have shipped: the login throttle never refunded the address reservation in production, because `admit` and `settle` each called `clock.now()` and the refund matched an exact instant (`array_position`). The frozen-clock test harness made the two instants always equal, so every test passed. Three Importants were race and storage problems of one class (OAuth sign-in and link racing a password reset; the raw reset token sitting in `pgboss.job`). All four were fixed test-first in 170bd5f with regression tests.

Seven items stay open as pre-release follow-ups (Important 5-6, Minor 7-11). Two of them are release blockers in practice: the password blocklist is 368 hand-picked entries instead of the designed SecLists-derived 5-15k list, and no real Google/Facebook credentials have been exercised (AC-INTEGRATION-3). The branch is not ready to merge to a production release until those are closed, but it is ready to archive as a local-only feature branch once the open list is carried forward into the archive.

---

## Dimension 1: Task Implementation Quality

### Requirements Achievement

**Status**: ⚠️ Substantially met; pre-release gaps open

- All 52 ACs are assigned to a phase and all six phases are checked; the E2E phase re-ran every MUST AC. Optional AC-ERROR-19 (`POST /auth/password/reset/check`, COULD) was **not built** (Phase 3 and 4 ledger), so the AC is unmet by design.
- **AC-VERIFY-6** (every log line carries `traceId`) was narrowed in practice, not in the AC text: boot/shutdown lines and `OTEL_SDK_DISABLED` runs carry none. The AC wording should be amended (the same "ledger note instead of AC edit" drift flagged in the platform-foundation reflection).
- **AC-VERIFY-9** (coverage gate): unit-only coverage of the listed files was about 76%, so `ci` now runs `test:coverage` over both projects. Intent met, mechanism changed, recorded.
- **AC-INTEGRATION-3** (real provider credentials) and **AC-INTEGRATION-4** (trace continuity proven in CI) are **open**: no credentials exist, the trace-continuity Playwright test self-skips when Docker logs are unreadable, and there is no e2e job in `ci.yml`. A suite that skips itself can never fail CI.
- Success criteria observable at the stated surfaces (header text, `GET /auth/me`, Mailpit, DB rows) were exercised by the Phase 6 Playwright journeys on desktop and a 360x740 mobile project, with axe scans of every auth page and `/account`.

### Code Quality Assessment

**Overall Rating**: Good

- **Maintainability**: A clear module shape (`modules/auth`, `lib/auth`, `lib/http`), a pure decision-table module (`oauth-decision.ts`) separate from I/O, injectable `Clock`, hasher, throttle and providers. Weak spot: `oauth-service.ts` is about 600 lines and was explicitly not split.
- **Architecture**: Security properties sit in the right layer: last-sign-in-method protection as a deferred DB constraint trigger, case-insensitive email as a CHECK plus a composite FK, role read from the DB on every request (no role claim in the session), default-deny route policy via `onRoute`. The web-owns-cookie / bearer-to-API split kept the API free of cookie and CSRF surface.
- **Error handling**: A single shared `{ error: { code, message, fieldErrors? } }` shape with an authoritative `ErrorCode` list; fail-closed throttle (503); generic 401 for all credential failures; `signup_expired` and replay paths resolve to the signed-in state.
- **Testing**: 627 tests, concurrency tests with real parallel transactions (20-way registration, 20-way wrong-password, 20-way reset), recorded provider fixtures, and TDD RED evidence in most phases. The gap is not volume but **what the tests could not see**: a frozen clock and single-actor tests hid the Critical, and each race test covered one pair of actors (login vs reset, then later OAuth vs reset) instead of the whole class.

### Technical Decisions

**Key Decisions:**
1. **Opaque DB sessions, web-owned cookie, bearer token to the API** (architecture Q1/Q2). Held up: the guards, idle/absolute expiry and immediate role changes all fell out of it, and the AC-ERROR-15 CSRF story stayed simple.
2. **Never auto-link OAuth by email; a completed reset deletes all Google and Facebook identities (3A' with R1, unconditional per D1).** The Codex creative critique forced D1 (recycled-inbox bypass). It is the right call, and it is also the source of the final-review races: R1 makes "identity exists" a fact that can change between a sign-in's read and its session insert.
3. **Postgres sliding-log throttle with reserve-then-verify and refund on success** (Q7). Atomic and replica-safe, but the refund keyed on an exact timestamp was fragile by construction (the Critical). It was fixed by passing one `attemptedAt` to both calls; the stronger design would key the refund on a reservation id so no clock coupling remains.
4. **Own provider adapters + `jose`, no `arctic`/`passport`.** Small dependency footprint and full control of PKCE, `appsecret_proof` and `rerequest`; costs ~600 lines of OAuth service and a manual real-credentials smoke test the project cannot yet run.
5. **`node:crypto` argon2id** (no native dependency) with a boot-time self-test. Good for portability; the policy blocklist is the weak part (see debt).

**Trade-offs:**
- Server Actions with progressive enhancement: JS-off works, but the Next 16 origin check forced a build-time baked `WEB_BASE_URL` (`serverActions.allowedOrigins`), in tension with build-once/config-in-environment. Mitigated by a boot check that the baked host equals the runtime host.
- Throttle fails closed (503) when its store is down: safe, but a throttle outage takes sign-in down with it.
- Unknown-email forgot is faster than known-email (timing not padded): accepted, bounded by the address limit and not required by any AC.

### What Went Well

1. **Creative critique paid off again.** Codex adversarial critique on the design produced four findings, all applied before code: the recycled-inbox bypass (D1), the spoofable client-address chain (`WEB_TRUSTED_PROXY_HOPS` + authenticated internal hop), the conflicting `sgm_oauth` cookie contracts, and the conflicting error-code/OpenAPI contracts. The spoofable-address fix alone prevented a throttle bypass and a venue-wide lockout.
2. **Findings were fixed test-first with named regression tests**, each tied to an AC (e.g. the 25-sign-in clock-advance test, RED at 429 on the 21st).
3. **Behavioural proof in Phase 6**: the full stack under Colima with fake OAuth exposed two product bugs unit tests missed (duplicate welcome banner; stale signed-out header in the second tab after a cross-tab sign-up) and a Compose boot failure (placeholder secret refused by the production build).
4. **Live-race hardening was proactive in places**: the login-vs-reset race found in the Phase 3 review was assigned to the start of Phase 4 and fixed with a regression test before moving on.
5. **Deviation ledger stayed truthful** (D-27..D-39 in `db/schema-deviations.md`, plus per-phase ledger lines with file:line references).

### Challenges Encountered

1. **Throttle refund never matched in production (Critical).** Admit and settle read the clock independently. Resolution: one `attemptedAt` per login. The test helper that froze the clock is the real defect (see Misses).
2. **Race class found piecemeal.** Login-vs-reset (Phase 3 review) was fixed for login only; OAuth S1 sign-in, C3 sign-up completion and link (`finishLink`) had the same shape and were found by the final review. Resolution: `lockUserRow` + identity/session re-check inside the session-issuing transaction in all three.
3. **Raw reset token stored in `pgboss.job.data`.** The token is a credential; job rows are readable, retained and logged by queue tooling. Resolution: sealed with `FieldCrypto` (bound to the idempotency key); `registerJobs` and the worker take `crypto`.
4. **SecLists fetch denied** by a network permission, so a 368-entry list replaced the designed one. Resolution: kept behind the `PasswordBlocklist` interface (one-file swap); tracked pre-release.
5. **Package-manager shim mismatch** (corepack shim v12 vs repo pin 10.34.6) forced `--lockfile-only` installs in Phases 1 and 5; closed in Phase 6 with a real install.
6. **Vacuous E2E assertions** in Phase 6 (Connected row, returnTo fallback) were caught by code review, fixed, and Playwright re-run.

### Technical Debt & Future Work

Open final-review items, ordered by release risk:

| # | Item | Release risk | Recommended action |
|---|------|--------------|--------------------|
| 5 | 368-entry password blocklist vs designed SecLists-derived 5-15k list | **High** for a public sign-up (weak-password acceptance) | Swap in a vetted list (10+ chars, lower-cased, de-duplicated, MIT attribution header) behind the existing interface; add a test that a known-top-1000 password is rejected |
| 6a | AC-INTEGRATION-3 real Google/Facebook smoke test not run; Facebook Authorization-header Graph call unverified | **High**: OAuth paths have only run against fixtures and the fake provider | Run the getting-started smoke steps with real apps before any release |
| 6b | AC-INTEGRATION-4 not proven in CI; trace test self-skips; no e2e CI job | Medium | Fail the test when `CI=true`; add an e2e job to `ci.yml` |
| 6c | `pnpm audit --prod`: `source-map-js` via `next > postcss` (build-time) | Low-Medium | Re-run audit before release; bump `next` when patched |
| 7 | Migration 0001 CHECKs validate immediately with no backfill | Low now (empty DB), **High** on any non-empty environment | Add a backfill/`NOT VALID` + `VALIDATE` path before applying to a populated database |
| 8 | Compose default internal secret passes production validation | Medium: a production deploy using the Compose default would run with a public secret | Reject the known default in `loadConfig` in production; add an automated guard test |
| 9 | Web logger ignores `LOG_LEVEL` and has no `traceId` | Low-Medium (observability standard) | Route the web logger through the shared logger config |
| 10 | Key rotation resets throttle counters | Low | Document in the runbook, or key the HKDF on a stable label |
| 11 | Hygiene: `errorMessage` typed as string, stale comment `cookies.ts:7`, `oauth-service.ts` ~600 lines, `redactDeep` skips `Error` instances under non-`err` keys | Low | Split link/complete out of `oauth-service.ts`; fix `redactDeep` |

Also: AC-ERROR-19 reset/check COULD not built; no automated guard for the compose placeholder-secret fix; `hash-queue 503` does not refund the email throttle reservation; `auth-cleanup` has no max-batch guard; PASSWORD identity cannot be disconnected via the API (consistent with AC-HAPPY-12).

---

## Dimension 2: Claude Code Ecosystem Effectiveness

### Build Session Analysis

**Log source**: the by-task log index is not available for this slug (`.agent-logs/claude/by-task/` has only legacy `FEAT-001`, `TASK-001`, `TASK-007` folders). Fallback: grepped `.agent-logs/claude/` date directories; two session logs mention the slug: `2026-10-07/1043__f75a9972...md` (1.5 MB, 306 turns, header **Task IDs: `TASK-007`**, branch `main`) and `2026-10-02/2350__22d0eff1...md` (1.99 MB, a different earlier session that mentions the slug). The header shows the log index is stamping a legacy task ID and the wrong branch for a v2 feature. The metrics below come from the 2026-10-07 session, which is the orchestrating conversation only; sub-agent internal tool calls are not in it, so per-agent tool counts are not measurable.

**Build Sessions**: 1 orchestrator session covering plan, creative, 6 auto-build phases, final review and reflection; plus the post-review fix session (commit 170bd5f).
**Sub-Agents Spawned**: 18 (from the session log)
**Orchestrator Tool Calls**: 153
**Errors Recovered**: 3 code-review CHANGES_REQUIRED recoveries (Phases 1, 5, 6), 1 inline fix per recovery; 0 halts; 1 Critical + 3 Important after the fact.

#### Tool Utilization (orchestrator session only)

| Tool | Count | Success Rate | Notes |
|------|-------|--------------|-------|
| Bash | 80 | not measurable per call | mostly `git -C` state probes; consistent with the one-command-per-call rule |
| Edit | 31 | not measurable | targeted ledger and task-file edits |
| Agent (Task) | 18 | all returned | see sub-agent table |
| Read | 16 | n/a | the task file now exceeds a single Read (835 lines, about 49k tokens) and had to be read in slices |
| Write | 4 | n/a | |
| AskUserQuestion | 2 | n/a | decisions D1 and spec approval |
| ToolSearch / TaskStop | 1 / 1 | n/a | |

Not used by the orchestrator: Grep, Glob. Anything the sub-agents did with them is outside the log.

#### Sub-Agent Performance

| Agent Type | Invocations | Model | Effectiveness |
|------------|-------------|-------|---------------|
| spec-writer | 1 | Sonnet | Good: 52 ACs, taxonomy lint clean, approved as drafted; AC count (52 vs 32 for platform-foundation) made the task file heavy |
| creative architecture / algorithm / user-journey | 3 | Opus-class | Strong; user-journey added for Level 3 and consumed the other two docs; contradictions X1-X14 resolved in consolidation |
| Codex creative critique | 1 | Codex | Very high value: 4 findings, all applied, 2 were high severity |
| build-orchestrator | 6 | Sonnet | Good output; every phase returned a result and the task ledger stayed current. No sign of the detached-HEAD or skipped-TDD misses from platform-foundation |
| auto-build phase reviewer | 6 | Sonnet | Thin compliance gate; all 6 PROCEED; reliable for in-phase defects (open redirect, lock order, x-pending-signup log leak in the code-review step), blind to cross-phase interaction |
| auto-build final reviewer | 1 | Codex | Highest value in the build: 1 Critical + 4 Important + 5 Minor |
| general-purpose | 1 | n/a | Used for ad-hoc work; one sub-agent edited files with Python scripts instead of the Edit tool (5 `python`/`.py` mentions in the log), against the project Tool Usage Rules |

### Command Workflow Evaluation

**Commands Used**: `/yay:task` (once, by the user, "resume the last task"), `/yay:roadmap`, `/yay:plan`, `/yay:creative`, `/yay:auto-build`, `/yay:reflect`. `/yay:archive` pending.

**Workflow Efficiency**: Good

**Assessment**:
- The Level 3 flow (plan, three creative docs, critique, 6-phase auto-build, final review, reflect) was appropriate; complexity was classified correctly (a Level 4 foundation preceded it, and this feature stayed Level 3).
- `/yay:auto-build` ran 6 phases end to end without a human gate. That is productive but means **no human saw any phase diff before the final review**. For a security feature, an optional pause after the throttle and reset phases would have been cheap.
- **`/yay:task` has no resume path for a feature branch.** The user invoked `/yay:task "resume the last task, where did we end up with?"` on a Level 3 feature; the Level 1 Fast Path is the wrong entry. `/yay:go continue` is the right command, but the user did not know it. The session log shows the orchestrator had to discover state itself (branches, worktrees, git log).
- Phase transitions were smooth. The Guard & Recovery Log section the platform-foundation reflection asked for exists now and was used (3 entries).
- Local-only mode is still implicit: every phase writes "Push skipped (local-only run)". The platform-foundation recommendation for a first-class flag was not adopted.

### Context File Effectiveness

**Files Loaded**: level3 plan/creative/build/reflection rules, observability-requirements, api-rest-requirements, the three creative docs, `techContext.md`, `systemPatterns.md`, `productBrief.md`, the platform-foundation reflection.

**Assessment**:
- **Helpful**: creative documents with explicit decision tables and AC impact sections; the deviations ledger with file:line references; `db/schema-deviations.md`.
- **Gaps**: no convention for *injectable-clock tests* (when a test freezes the clock, sequential calls inside one operation share an instant). No convention for *session-issuing transaction rules* (lock the user row, re-validate the credential). No guidance that secrets must not be written into queue payloads.
- **Redundancy / size**: the task file is 835 lines. The per-phase "review PROCEED" ledger lines duplicate the builder's deviation lines for the same items (e.g. the 368-entry blocklist appears in four places). Reflection and orchestration both pay for it.

### Memory Bank Organization

- **Structure**: adequate; the `memory-bank/tasks`, `creative`, `reflection` layout is intuitive.
- **Navigation**: good for in-flight work from branch tips, but the log index (`by-task`) is wrong or absent for v2 slugs, which broke the primary analysis route.
- **Completeness**: missing a place for **cross-phase invariants** ("every path that issues a session must..."). Such invariants currently live only in individual phase ledger lines.

### Guardrail Misses & Root-Cause Analysis

Recorded recoveries: Phase 1 code review CHANGES_REQUIRED (open redirect in `safeReturnTo`, throttle insert lock order, 23514 mapping, placeholder secret); Phase 5 (unredacted `x-pending-signup` header in request logs); Phase 6 (two vacuous E2E assertions). The deterministic commit guard produced no FAIL entry in the log; the recoveries came from the code-review step. The first three phases of the build showed the pattern *"catch in review, fix, move on"*, which is the process working. The costly misses are the ones the process did **not** catch:

| Miss | What the agent got wrong first time | Why (systemic cause) |
|------|-------------------------------------|----------------------|
| **Throttle refund (Critical)** | Wrote `admit` and `settle` to read the clock separately, tested only with a frozen clock | The shared test harness injects a frozen `Clock`; no instruction says to advance the clock between the calls of one operation. Every agent that used the harness would pass. This is the instructions/test convention, not one agent's mistake |
| **OAuth sign-in/link vs reset races (Important 2-3)** | Fixed login-vs-reset only, did not generalise | The Phase 3 and 4 fix was recorded as a *finding about login*, not as a *rule about session issuance*. Nothing told the Phase 5 agents "all session-issuing paths lock the user row and re-check the identity (D1 invariant)". The same class was rediscovered by a different model family at the end. Multiple independent code paths (S1, C3, link) made the same omission, which points to missing guidance |
| **Raw reset token in `pgboss.job` (Important 4)** | Passed the plaintext link through `enqueueEmail` | The platform-foundation notifier contract carries the whole message in the job payload; the AC for "token stored hashed" (AC-VERIFY-2) was read as covering `password_reset_tokens` only. The spec said "hashed at rest" but not "secret-bearing payloads"; nobody checked every place a secret lands |
| **Phase reviewers all PROCEED** | Reviewed the phase diff against the phase's ACs | Same finding as platform-foundation: phase reviews judge one diff against the phase ACs and cannot see cross-phase interaction. The platform-foundation reflection recommended a plan-vs-delivered and cross-phase checklist; there is no evidence it landed in the phase-reviewer prompt |

**Heuristic check**: the throttle test pattern, the race pattern and the secret-at-rest pattern each recurred across several code paths or agents, so the cause is guidance, not carelessness. A clean build from the commit-guard point of view still produced a Critical; the guard checks that tests exist and run, not that they exercise real conditions.

### Memory-Bank Corrections (from Guardrail Misses) - ACT ON THESE

| File · section | Current (stale/wrong) | Correction | Evidence |
|---|---|---|---|
| `memory-bank/systemPatterns.md` · Testing Patterns (add a bullet) | No convention for injected clocks | State: "Tests that inject a `Clock` must advance it between the sequential calls of one operation (admit then settle, issue then verify); a frozen clock hides timestamp-matching bugs. Prefer reservation ids over timestamp equality for refunds." | Critical 1 (170bd5f), RED was 429 on the 21st sign-in |
| `memory-bank/systemPatterns.md` · Auth pattern (added in Phase 6) | Describes the guards and sessions, not the session-issuance invariant | Add: "Every path that issues a session (password login, OAuth sign-in S1, sign-up completion C3, link) must lock the user row and re-check the credential/identity and the linking session inside the issuing transaction (D1)." | Important 2-3 (170bd5f); Phase 3 and 4 login-vs-reset fix |
| `memory-bank/systemPatterns.md` · Jobs / Notifications | `enqueueEmail` described as the way to send mail | Add: "Any message carrying a secret (reset link, token) is enqueued with `crypto` so `pgboss.job.data` holds only `{idempotencyKey, sealed}`." | Important 4 (170bd5f) |
| `memory-bank/techContext.md` · Auth / Secrets | Lists the compose default internal secret as acceptable local config | Note it is local-only and that production must refuse it (minor 8 still open) | Minor 8 |
| Spec · AC-VERIFY-6 | "every line carries traceId" | Amend to request- and job-scoped lines | Phase 6 deviation (carried over from Phase 2 and 6) |
| Spec · AC-VERIFY-2 | "reset token stored hashed" | Extend to "and not present in any queue payload or log" | Important 4 |
| `memory-bank/tasks/*` task template | No place for cross-phase invariants | Add a "Cross-Phase Invariants" section the phase reviewer must check each phase | Recurrence of the platform-foundation I2 finding |

### Suggested Improvements to Claude Code System

**High Priority**:
1. **Cross-phase invariant checklist in the phase reviewer.** Both Level 3 and Level 4 builds got six PROCEEDs then a final-review Critical or Important set. Add to the auto-build phase-reviewer prompt a step: "list invariants established by earlier phases (e.g. D1) and grep the new diff for each code path that touches them." Cheap, mechanical, and the platform-foundation recommendation for a plan-vs-delivered check has no visible effect.
2. **Dispatch the Codex final review per risk cluster for security features**, or run a mid-build Codex review after the password-auth and reset phases (Phases 2-3). The independent review found everything important in both builds; running it earlier shrinks rework and keeps the remaining phases from re-implementing the same hole.
3. **Make the by-task log index work for v2 slugs.** The session log header says `Task IDs: TASK-007` and `Git Branch: main` for a session that built `auth-and-user-roles`; `by-task/auth-and-user-roles/` is never created. This repeats the platform-foundation gap and blocks the reflection's primary data source.
4. **`/yay:task` should redirect, not execute, when asked to "resume".** Detect a Level 2-4 feature branch in flight and point to `/yay:go continue` (or resume it). The user's request was a natural one and the Level 1 Fast Path is the wrong path.

**Medium Priority**:
1. **Reject Python/sed file edits in sub-agent prompts and add a PostToolUse hook** that flags Bash commands writing files. The project's Tool Usage Rules say to use Edit/Write; one sub-agent used Python scripts regardless.
2. **A network-permission preflight** in `/yay:build` (and a "fetch needed assets" step in plan): the SecLists fetch was denied mid-build and a security-relevant artifact was silently downgraded (368 vs 5-15k entries). Fetch required data during planning with the user present, or record a "needs human" gate for any security-relevant fallback.
3. **Package-manager preflight**: the corepack shim v12 vs pinned 10.34.6 mismatch has now hit two builds. Add `packageManager` assertion to the preflight and document `npx -y pnpm@<pinned>`.
4. **Deviation ledger structure**: one entry per item with a status field (open, tracked pre-release, closed) rather than repeated prose. The pre-release items (blocklist, smoke test, e2e in CI, audit) were restated in 3-4 places each.
5. **First-class local-only flag**, as recommended in platform-foundation. Still absent.

**Low Priority / Nice to Have**:
1. Split the ledger from the task file when it passes about 400 lines (the file is 835 lines, 49k tokens).
2. Auto-build could write phase start/end timestamps to the Execution State so planned-vs-actual is computable.
3. Recommend a "needs real credentials" release gate in the task template for features with third-party integrations.

**Note**: suggestions only; none implemented here.

---

## Creative Decision Assessment

| Decision | Outcome | Verdict |
|---|---|---|
| Never auto-link by email; R1 (reset evicts all OAuth identities, unconditional per D1) | Held; produced zero account-takeover ACs failing, and drove the race class found at the end | Good (needs the session-issuance invariant written down) |
| Postgres sliding-log throttle, reserve-then-verify, refund on success | Correct design, fragile refund (timestamp match) | Could improve: key refund on reservation id |
| Web-owned cookie, bearer to API, authenticated internal hop with trusted proxy hops | Critique fixed the spoofing hole before code; Playwright confirmed trace and cookie flows | Good |
| Opaque DB sessions, role read per request | AC-HAPPY-8 and ERROR-12 satisfied with no cache invalidation | Good |
| Own provider adapters + `jose` | Fixture and fake-provider tested; real providers untested | Good design, unverified in the wild |
| Server Actions with `allowedOrigins` baked at build | Worked after adding a boot check; conflicts with build-once | Could improve |
| User-journey doc (copy deck, codes-only URLs, landing table) | Made web phases mechanical; Playwright caught two real UX bugs it did not predict | Good |

## Plan vs Reality

- Original estimate: not recorded in the roadmap; Actual: about 2 days wall-clock including planning, creative, and one post-review fix cycle.
- Deviations: six phases followed the plan; deviations are recorded in the ledger (mainly: `health.ts` policy moved to Phase 2, composite-FK `ON DELETE CASCADE`, a `register_address` throttle scope added in Phase 3, `POST /auth/password/reset/check` not built, coverage gate mechanism changed, SecLists swap not done).
- Final-review misses (Critical 1, Important 2-4) were all in-scope for the original plan and all repaired.

## Platform-Foundation Learnings: Applied or Repeated?

| Platform-foundation learning | Status here |
|---|---|
| Template DB per test file | Applied (all integration tests) |
| Add Guard & Recovery Log section | Applied (3 entries) |
| Behavioural verification over green unit tests | Applied in Phase 6 (stack run found 3 real defects) |
| Independent-model final review finds what phase reviews miss | **Repeated, not fixed**: again 6 PROCEED then Critical + Importants |
| Plan-vs-delivered / cross-phase check in the phase reviewer | **Not adopted** (see High Priority 1) |
| Advisories accepted early become real late | **Repeated**: login-vs-reset advisory (Phase 3) widened to OAuth races at the end; secret-in-payload was a Phase 3 design assumption |
| Local-only flag, build preflight, timestamps, task-file size | **Not adopted**; same friction |
| Detached HEAD, skipped TDD, Haiku doc agent | Not seen this time (no recurrence found in the ledger) |

## Key Learnings

### Extractable Learnings (for Continuous Learning)

1. - **testing-patterns** (`*.test.*`, `apps/api/test/`): Advance an injected clock between sequential calls of one operation; a frozen clock hides timestamp-equality bugs.
2. - **auth-concurrency** (`apps/api/src/modules/auth/`): Every session-issuing path locks the user row and re-checks the credential or identity inside the issuing transaction.
3. - **secrets-handling** (`apps/api/src/jobs/`, queue payloads): Seal secret-bearing job payloads with FieldCrypto bound to the idempotency key so job tables never hold raw tokens.
4. - **review-process** (`memory-bank/tasks/*.md`): At each phase review, re-check invariants from earlier phases across every new code path, not only the phase's ACs.

### Learned Rules Applied

No learned rules available (`memory-bank/agent-rules/_learned/` carries only `.gitkeep` on the metadata branch; the platform-foundation learnings have not yet been consolidated because that branch is not archived).

### For Claude Code Workflow

1. A guard that checks "tests exist and pass" does not check "tests exercise real conditions"; add review prompts for frozen-clock and single-actor test shapes on concurrency and timing code.
2. Independent-model review has now caught every Critical in two consecutive builds; schedule it earlier for security-sensitive features.
3. A fix recorded as a finding about one code path should be rewritten as an invariant about the class before the next phase starts.
4. Fallbacks for security-relevant assets (blocklist, credentials) need a human gate, not a ledger line.
5. User-facing resume entry points should detect in-flight Level 2-4 work.

---

## Conclusion

The feature is complete as specified and the design held up. The throttle bug, the race class and the token-at-rest finding all came from the same underlying gap: nobody wrote the cross-cutting invariants down, so each phase re-derived them. The workflow's weakest link remains the per-phase review scope, which platform-foundation already identified. The strongest links were again the Codex critique before code and the Codex review after. Before release, close the blocklist, the real-credentials smoke test, the e2e-in-CI gap, the migration backfill and the compose-secret production guard.

**Overall Task Success**: ⚠️ Success with pre-release items open (Good, high end)

**Overall Workflow Effectiveness**: ⚠️ Moderately Effective

**Recommendation**: Ready to archive as a local-only feature branch, carrying items 5-11 forward as tracked pre-release follow-ups. Apply the Memory-Bank Corrections at archive. Do not release until items 5, 6a and 7-8 are closed. Re-run Playwright and `pnpm run build` once after 170bd5f.

## References
- Task: `memory-bank/tasks/auth-and-user-roles.md` (feature branch tip)
- Creative: `memory-bank/creative/auth-and-user-roles-architecture.md`, `-algorithm.md`, `-user-journey.md`
- Prior reflection: `memory-bank/reflection/platform-foundation-reflection.md`
- Timeline: `git log --oneline 6e0d753^..HEAD` (17 commits; fixes in 170bd5f and ff89da5)
- Session log: `.agent-logs/claude/2026-10-07/1043__f75a9972-2df1-4ddf-a4f2-04eedd1c40c4.md` (by-task index unavailable for this slug)
