# Archive: Auth and User Roles

## Metadata
- Task: auth-and-user-roles
- Complexity: Level 3
- Status: COMPLETE (archived 2026-10-07). **Not pushed, no PR yet.** GitHub push returns 403 (wrong git account). The branch is stacked on `feature/platform-foundation` (`63dbc43`) and must be rebased onto `main` after platform-foundation merges. Not release-ready: see [Open items / release blockers](#open-items--release-blockers).
- Started: 2026-10-06 (plan and creative consolidation, commit `6e0d753`)
- Completed: 2026-10-07 (final-review fixes `170bd5f` / `ff89da5`, reflection `3d8b2c4`)
- Duration: about 2 calendar days. Per-phase timestamps were not recorded, so planned-vs-actual cannot be computed (same gap as platform-foundation).
- Roadmap Link: [auth-and-user-roles] (v1.0.0)
- Branch: `feature/auth-and-user-roles`. Task range `6e0d753^..HEAD`: 18 commits, 205 files changed, +23,776 / -519 (includes spec, creative and memory-bank files). Platform-foundation commits are not part of this task.
- Build mode: `/yay:auto-build`, 6 phases, local-only (commit per phase, never pushed)

## Summary

Self-registration and sign-in for players by email/password, Google OAuth and Facebook OAuth, with a required sex choice (`MALE`, `FEMALE`, `OTHER`) once per user, including first-time OAuth users. The feature also delivers the authorization layer every later feature builds on: global roles `GLOBAL_ADMIN` and `PLAYER`, a per-team role derived from approved `team_members` rows, and a default-deny route policy with guards for both. It is the reference `modules/<feature>` implementation for the API and the first user of the shared `{ error: { code, message, fieldErrors? } }` error shape.

## Requirements

### Original Requirements
- Email/password, Google and Facebook sign-up and sign-in (PRODDUCT-OVERVIEW section 1).
- Required sex selection at registration, including first-time OAuth.
- Global roles `GLOBAL_ADMIN` and `PLAYER`; `TEAM_ADMIN` scoped per team.
- Session management, password reset, route and API authorization guards (global plus per-team).

### Success Criteria
The spec carries 52 ACs, all assigned to one of six phases and all six phases checked. Source: Specification in `memory-bank/tasks/auth-and-user-roles.md`.
- [x] Entry points (ENTRY-1 to 8), happy paths (HAPPY-1 to 13), errors (ERROR-1 to 18, 20), async (ASYNC-1 to 5), verify (VERIFY-1 to 15), integration (INTEGRATION-1, 2, 5): built and re-run in Phase 6 (every MUST AC).
- [ ] AC-ERROR-19 (`POST /auth/password/reset/check`, COULD): **not built** by design (Phase 3 and 4 ledger). Unmet.
- [ ] AC-INTEGRATION-3 (real Google and Facebook credentials): adapters pass against recorded fixtures only; the manual smoke test has not been run. **Open.**
- [ ] AC-INTEGRATION-4 (trace continuity proven end to end): passes locally under Playwright, but the test self-skips when Docker logs are unreadable and `ci.yml` has no e2e job, so it is not proven in CI. **Open.**
- Met with deviation: AC-VERIFY-6 (every log line carries `traceId`: true for request- and job-scoped lines, not boot, shutdown or `OTEL_SDK_DISABLED` runs; AC text not yet amended), AC-VERIFY-9 (unit-only coverage was about 76%, so `ci` now runs `test:coverage` over both projects).

## Implementation

### Approach
Schema, contracts and wiring first (Phase 1); password auth, sessions, throttle and guards, the critical path (Phase 2); password reset and cleanup (Phase 3); web password flows, giving a usable product before OAuth (Phase 4); OAuth and identity linking, the riskiest part (Phase 5); end-to-end journeys, contract and docs (Phase 6). Postgres is the system of record (P1): uniqueness, single use, the last-method rule and role validity are enforced by constraints and triggers, not application checks.

### Key Components
1. **Schema** (`db/migrations/20261006*`, 6 files; ledger `db/schema-deviations.md` D-27 to D-39)
   - Purpose: case-insensitive email CHECK, `users.role` CHECK that rejects `TEAM_ADMIN`, `UNIQUE(user_id, provider)`, PASSWORD-subject composite FK, deferred last-sign-in-method trigger; tables `auth_sessions`, `password_reset_tokens`, `oauth_states`, `oauth_pending_signups`, `auth_throttle` with `admit`/`settle` functions; a `register_address` throttle scope added in Phase 3.
2. **Auth module** (`apps/api/src/modules/auth/`)
   - Purpose: routes, `service.ts`, `reset-service.ts`, `oauth-service.ts` (about 600 lines, not split), the pure `oauth-decision.ts` table, `node:crypto` argon2id hasher with boot self-test, password policy, tokens, sessions, providers (Google, Facebook, fake) built on `jose`.
3. **Auth platform and HTTP layer** (`apps/api/src/lib/auth/`, `apps/api/src/lib/http/`)
   - Purpose: `onRoute` policy registry (`public | optionalSession | authenticated | globalRole | teamRole`), `requireGlobalRole`, `requireTeamRole` (with opt-in `allowGlobalAdmin`), error mapper, Origin check, constant-time internal-hop secret check.
4. **Shared contracts** (`packages/shared/src/{api/auth,api/errors,auth/*}.ts`)
   - Purpose: strict zod request schemas, the authoritative `ErrorCode` list, `normaliseEmail`, `safeReturnTo`, the `sgm_oauth` binding-cookie codec.
5. **Jobs** (`apps/api/src/jobs/auth-cleanup.ts`, `send-email.ts`, registry and schedules)
   - Purpose: daily `auth-cleanup` (`0 5 * * *` Pacific/Auckland, outside the 02:00-02:59 window); sealed reset-email payloads.
6. **Web** (`apps/web/src/{app,components,lib/auth,proxy.ts}`)
   - Purpose: `/register`, `/register/complete`, `/login`, `/forgot-password`, `/reset-password`, `/account`, `/auth/callback/[provider]`, `/auth/session-expired`, `SiteHeader`, `FlashNotice`, Server Actions with progressive enhancement, `proxy.ts` (Next 16), web config, client-address derivation, in-app-browser hint.
7. **Operator CLI** (`apps/api/src/cli.ts`): `users set-role <email> <GLOBAL_ADMIN|PLAYER>`.
8. **Docs**: `docs/adr/0013-authentication-sessions-and-route-authorization.md`, `docs/adr/0014-account-linking-and-login-throttling.md`, `docs/getting-started.md` (OAuth setup, first admin, production trust settings, manual smoke steps), `systemPatterns.md` auth pattern.

### Design Decisions
Full option scoring is in the three creative documents. A Codex adversarial critique (2026-10-06, "needs-attention", 4 findings) was applied before any code was written.

- **Q1 Library and hasher**: own Fastify `modules/auth`, `node:crypto` argon2id (Node `>=24.7 <25`, no native dependency), thin Google and Facebook adapters plus `jose`. No arctic, Better Auth, Auth.js or passport. Cost: about 600 lines of OAuth service and a real-credentials smoke test the project cannot yet run.
- **Q2 Sessions and relay**: opaque Postgres sessions (SHA-256 of a 256-bit token stored), 7-day idle and 30-day absolute expiry, hourly touch. The web owns the `sgm_session` cookie and calls the API with `Authorization: Bearer`; the API sets no cookies, so CSRF stays at `SameSite=Lax` plus Origin checks. Role is read from the database on every request, never carried in the session.
- **Q3 Linking and email conflicts**: never auto-link, never sign in on an email match, link only while signed in. Every completed reset deletes all Google and Facebook identities (R1, unconditional per user decision D1, forced by the critique's recycled-inbox finding).
- **Q4 Facebook without email**: block sign-up with guidance and a "Try Facebook again" `rerequest`; a known Facebook identity still signs in.
- **Q5 RBAC guards**: declarative default-deny registry; `GLOBAL_ADMIN` passes team guards only with `allowGlobalAdmin: true`; team routes answer 403.
- **Q6 OAuth topology**: web-owned callback, single-use Postgres `oauth_states` and `oauth_pending_signups`, one `sgm_oauth` binding-cookie schema (`<state>.<ctx>`, at most 1024 bytes).
- **Q7 Throttling**: Postgres sliding-log table with atomic reserve-then-verify and refund on success; 5 failures per email and 20 per client address per 15 minutes; forgot-password 10 per address per 60 minutes; keys are HMAC pseudonyms only, no IP or email in clear.
- **Q8 Fake provider**: env-selected `AUTH_FAKE_OAUTH` adapter, refused in production, sharing fixtures with the unit tests.
- **Critique outcomes**: D1 (reset evicts all OAuth identities); client address read only from `X-Forwarded-For` counted from the right by `WEB_TRUSTED_PROXY_HOPS` over a secret-authenticated web-to-API hop (new AC-VERIFY-14); one `sgm_oauth` schema (AC-VERIFY-15); one `ErrorCode` list and a bearer `sessionToken` OpenAPI scheme.

Reference: `memory-bank/creative/auth-and-user-roles-architecture.md` (Q1, Q2, Q5, Q6, Q8), `memory-bank/creative/auth-and-user-roles-algorithm.md` (Q3, Q4, Q7, email, password policy, token and session rules), `memory-bank/creative/auth-and-user-roles-user-journey.md` (10 flows, copy deck, contradictions X1-X14 resolved).

### Phases and Timeline
Commit SHAs are from `git log --oneline 6e0d753^..HEAD`.

| Phase | Code commit | Review commit | Outcome |
|-------|-------------|---------------|---------|
| Plan and creative | `6e0d753` | | Spec (52 ACs), three creative docs, critique findings applied |
| Auto-build start | `2cb9ed0` | | |
| 1 Schema, contracts, wiring | `b22b25e` | `fc924b6` | 5 migrations, D-27 to D-39, shared contracts, DI in `buildApp`; PROCEED after one CHANGES_REQUIRED (open redirect in `safeReturnTo`, throttle lock order, 23514 mapping, placeholder secret) |
| 2 Password auth, sessions, throttle, guards | `63ed1c5` | `2ee428d` | 69 new tests; PROCEED |
| 3 Password reset and cleanup | `476a561` | `5dedb6a` | D1 implemented; login-vs-reset race noted and assigned to Phase 4 start |
| 4 Web password flows | `f1c1cb2` | `ba577c2` | Race fixed first (user-row lock plus identity re-read); 107 web unit tests |
| 5 OAuth and identity linking | `cc1a383` | `2195241` | About 127 new tests; PROCEED after one CHANGES_REQUIRED (`x-pending-signup` unredacted in request logs) |
| 6 End-to-end, contract, docs | `977cd2a` | `5c62539` | Playwright 35 passed / 3 skipped; ADRs 0013 and 0014; PROCEED after two vacuous e2e assertions were fixed |
| Final review (Codex) | `729efa9` | | 1 Critical, 5 Important, 5 Minor; not addressed autonomously |
| Final-review fixes | `170bd5f`, `ff89da5` | | Critical 1 and Important 2-4 fixed test-first |
| Reflection | `3d8b2c4` | | |

## Testing

### Strategy
Balanced, leaning integration. Security properties (uniqueness, single use, CHECKs, triggers, throttle atomicity, guards, reset eviction) are proven against real PostgreSQL 17 with per-file cloned databases; pure logic (hasher, policy, `returnTo`, decision table, cookie codec, address derivation, provider parsing) is unit-tested. Concurrency tests use real parallel transactions (20-way registration, 20-way wrong-password, 20-way reset). Playwright covers the journeys on desktop and a 360 x 740 mobile project with axe scans.

### Results
Final verification after fix commit `170bd5f`:

| Check | Result |
|-------|--------|
| `pnpm run test:coverage` | 81 files, **627 tests passing** (unit and integration, both projects) |
| Coverage (statements / branches / functions / lines) | 96.06 / 89.96 / 98.12 / 97.59 % |
| Typecheck, ESLint, prettier | Clean |
| Playwright | Last run in Phase 6: 35 passed, 3 skipped (phone-layout tests skip on the desktop project). **Not re-run after `170bd5f`.** |
| `pnpm run build` | **Not re-run after `170bd5f`.** |

The plan targeted about 145 tests; 627 were delivered. Phase counts from the ledger: 204 unit + 87 integration after Phase 1, 235 + 125 after Phase 2, 244 + 153 after Phase 3, 341 + 154 after Phase 4, 604 combined after Phase 5, 619 after Phase 6, 627 after the fixes. RED evidence was recorded in most phases; Phase 5 shared codec, decision and provider tests were written alongside code.

## Final Review (Codex, range `63dbc43..5c62539`)
Verdict: Ready to merge with fixes. Six per-phase reviews all returned PROCEED and then found none of the following.

| # | Severity | Finding | Status |
|---|----------|---------|--------|
| 1 | Critical | Login throttle never refunded the address reservation in production: `admit` and `settle` each read `clock.now()` and the refund matched an exact instant. The frozen-clock test harness made them always equal. | **Fixed `170bd5f`**: one `attemptedAt` per login passed to both. Test: 25 successful sign-ins from one address with an advancing clock (RED was 429 on the 21st). |
| 2 | Important | OAuth sign-in (S1) and sign-up completion (C3) could race a password reset and issue a session for a removed identity. | **Fixed `170bd5f`**: `lockUserRow` and identity re-check inside the issuing transaction. |
| 3 | Important | `finishLink` could attach an identity after the reset revoked the linking session. | **Fixed `170bd5f`**: `isSessionLive` re-check after the lock. |
| 4 | Important | Raw reset token stored in `pgboss.job.data`. | **Fixed `170bd5f`**: payload sealed with `FieldCrypto` bound to the idempotency key; job row holds only `{idempotencyKey, sealed}`. |
| 5-6, 7-11 | Important / Minor | See next section. | **Open** |

## Open items / release blockers

Items 5-11 stay open as tracked pre-release follow-ups. **Do not release until 5, 6a, 7 and 8 are closed**, and re-run Playwright and `pnpm run build` once after `170bd5f`.

| # | Item | Release risk | Recommended action |
|---|------|--------------|--------------------|
| 5 | Password blocklist is 368 hand-picked entries, not the designed SecLists-derived 5-15k list (the SecLists fetch was denied by a network permission in the build environment) | **High** for public sign-up | Swap in a vetted list (10+ chars, lower-cased, de-duplicated, MIT header) behind `PasswordBlocklist` (one-file change); add a test that a known-top-1000 password is rejected |
| 6a | AC-INTEGRATION-3: real Google and Facebook credential smoke test not run; the Facebook Authorization-header Graph call (pinned v26.0) is unverified | **High**: OAuth has only run against fixtures and the fake provider | Run the `docs/getting-started.md` smoke steps with real apps |
| 6b | AC-INTEGRATION-4: e2e trace test self-skips when Docker logs are unreadable; no e2e job in `ci.yml`, so it cannot fail CI | Medium | Fail when `CI=true`; add an e2e CI job |
| 6c | `pnpm audit --prod`: `source-map-js` < 1.2.2 (GHSA-68fv-2mgg-jv7q) via `next > postcss`, build-time only | Low-Medium | Re-run before release; bump `next` when patched |
| 7 | Migration 0001 CHECKs validate immediately with no backfill | Low now (empty DB), **High** on any populated environment | Add `NOT VALID` plus `VALIDATE` or a backfill before applying to non-empty data |
| 8 | The Compose default internal secret passes production validation | Medium | Reject the known default in `loadConfig` in production; add a guard test |
| 9 | Web logger ignores `LOG_LEVEL` and has no `traceId` | Low-Medium | Route it through the shared logger config |
| 10 | Key rotation resets throttle counters (HKDF keyed on the key) | Low | Document in the runbook or key HKDF on a stable label |
| 11 | Hygiene: `errorMessage` typed as string, stale comment `cookies.ts:7`, `oauth-service.ts` about 600 lines, `redactDeep` skips `Error` instances under non-`err` keys | Low | Split link and complete out of `oauth-service.ts`; fix `redactDeep` |

Also noted: AC-ERROR-19 not built; `hash-queue` 503 does not refund the email throttle reservation; `auth-cleanup` has no max-batch guard; the PASSWORD identity cannot be disconnected through the API (consistent with AC-HAPPY-12); unknown-email forgot is faster than known-email (accepted, bounded by the address limit); AC-VERIFY-6 and AC-VERIFY-2 wording should be amended (reflection corrections).

## Files Changed
Counts are from `git diff --shortstat 6e0d753^..HEAD` (205 files). Grouped by area; the full list is `git diff --stat 6e0d753^..HEAD`.
- `db/migrations/20261006*.sql` (6 files) and `db/schema-deviations.md`: schema, D-27 to D-39.
- `apps/api/src/modules/auth/**`: routes, services, hasher, policy, tokens, sessions, throttle, providers, `oauth-decision.ts`, `common-passwords.txt`.
- `apps/api/src/lib/{auth,http,config,logger}/**`: policy registry and guards, error mapper, Origin and internal-auth hooks, new config variables, log redaction hardening.
- `apps/api/src/{app,main,cli,openapi}.ts`, `apps/api/openapi.yaml`, `apps/api/src/jobs/**`: dependency injection, `users set-role`, bearer scheme, `auth-cleanup`, sealed `send-email`.
- `packages/shared/src/{api,auth,types}/**`: contracts, `ErrorCode`, email and `returnTo` helpers, binding codec, enum mirror.
- `apps/web/src/**`, `apps/web/e2e/auth.spec.ts`, `apps/web/{next.config.ts,Dockerfile,playwright.config.ts}`: pages, header, actions, proxy, config, Playwright journeys, baked `WEB_BASE_URL` build arg.
- `apps/api/test/**`, `**/*.test.ts(x)`: 627 tests across 81 files.
- `docker-compose.yml`, `.env.example`, `vitest.config.ts`, root `package.json`, `pnpm-lock.yaml`: compose-local secret default, new variables, `test:coverage`, engines `>=24.7 <25`, dependencies `jose` (api) and `@axe-core/playwright` (web, dev).
- `docs/getting-started.md`, `docs/adr/0013-*.md`, `docs/adr/0014-*.md`, `memory-bank/**`: docs and task artefacts.

## Lessons Learned
Reference: `memory-bank/reflection/auth-and-user-roles-reflection.md`. Ratings: Task Quality **Good** (high end); Ecosystem Effectiveness **Moderately Effective**.

**What worked**
- The Codex design critique before code removed a recycled-inbox account takeover, a spoofable throttle address and two contract conflicts.
- Codex whole-branch review again caught what six same-family phase reviews missed (second consecutive build).
- Fixes were test-first with named regression tests tied to ACs.
- Running the full stack in Phase 6 found two product bugs unit tests missed (duplicate welcome banner, stale signed-out header after a cross-tab sign-up) and a Compose boot failure.
- DB-enforced invariants and a truthful deviation ledger (D-27 to D-39).

**What went wrong**
- A frozen injected clock hid a timestamp-equality bug in the throttle refund. No convention said to advance the clock between the calls of one operation.
- The login-vs-reset race was fixed for login only and recorded as a finding about one path rather than a rule about every session-issuing path; OAuth sign-in, sign-up completion and link repeated the omission.
- A secret (reset token) was written into a queue payload because "hashed at rest" was read as covering one table.
- A security-relevant fallback (the blocklist) was downgraded silently when a fetch was denied, with only a ledger line instead of a human gate.
- Phase reviewers compare one diff against the phase ACs and cannot see cross-phase interaction (recommended after platform-foundation, not adopted).

**Learned rules consolidated at archive** into `memory-bank/agent-rules/_learned/`: `review-process-plan-claims.md` reinforced; `job-queues-pgboss.md` extended with sealed secret payloads; new `testing-injected-clock.md` and `auth-session-issuance.md`.

## References
- Task file (spec, 52 ACs, plan, Design Critique, Deviations ledger): `memory-bank/tasks/auth-and-user-roles.md`
- Reflection: `memory-bank/reflection/auth-and-user-roles-reflection.md`
- Creative: `memory-bank/creative/auth-and-user-roles-architecture.md`, `-algorithm.md`, `-user-journey.md`
- ADRs: `docs/adr/0013-authentication-sessions-and-route-authorization.md`, `docs/adr/0014-account-linking-and-login-throttling.md`
- Schema deviations D-27 to D-39: `db/schema-deviations.md`; setup and smoke steps: `docs/getting-started.md`
- Prior archive: `memory-bank/archive/platform-foundation-archive.md`
- Implementation timeline: `git log --oneline 6e0d753^..HEAD` (18 commits, `6e0d753` to `3d8b2c4`)

## Follow-up
- **Publish**: restore push access (correct git account), push `feature/platform-foundation` first, rebase this branch onto `main` once it merges, then open the PR to `main`.
- **Pre-release**: close open items 5, 6a, 7 and 8 above; then 6b, 6c and 9-11. Re-run `pnpm run build` and Playwright after `170bd5f`.
- **Spec hygiene**: amend AC-VERIFY-6 (request- and job-scoped lines) and AC-VERIFY-2 (token absent from queue payloads and logs); decide whether to build AC-ERROR-19.
- **Downstream consumers**: team-management and later features use `request.auth.userId`, `requireGlobalRole` and `requireTeamRole`; every new route must declare a policy (the app refuses to boot otherwise); every new session-issuing path must lock the user row and re-check the credential inside its transaction.
- **Ecosystem recommendations (none implemented)**: cross-phase invariant checklist in the phase reviewer and a "Cross-Phase Invariants" task-template section; run the Codex review after the password and reset phases for security features; make the by-task log index work for v2 slugs; make `/yay:task` redirect to `/yay:go continue` for in-flight Level 2-4 work; network-permission and package-manager preflights; first-class local-only flag; per-phase timestamps; a "needs real credentials" release gate for third-party integrations.
