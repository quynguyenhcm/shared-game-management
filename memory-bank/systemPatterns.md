# System Architecture Patterns

This file documents the architectural patterns, design patterns, and system structure used in this project. It helps developers understand the system's organization and maintain consistency when extending functionality.

## Guiding Principles

These principles govern ALL architectural and implementation decisions. Agents MUST validate their work against these principles. Deviations require explicit justification in a creative/architecture decision document with a trade-off analysis referencing the specific principle being overridden.

| Principle | Description |
|-----------|-------------|
| **P1: System of Record** | Postgres is the system of record, with all invariants enforced by DB constraints (CHECK, UNIQUE, FOREIGN KEY, triggers). App code reads from the DB and trusts its guarantees. |
| **P2: Money is Exact** | Money never touches binary floating point. All amounts are `bigint` (cents NZD) or `Money` (branded type), never `number` or `parseFloat()`. Rounding is via integer arithmetic (multiplyByRatio, divideByInteger), never Math.round/ceil/floor. |
| **P3: Temporal Boundaries** | All internal timestamps are UTC `timestamptz`, enforced by DB `SET TimeZone=UTC`. Pacific/Auckland timezone conversion happens ONLY at application boundaries (API response, job scheduling, UI display). No host-TZ-dependent code in the runtime. |
| **P4: Encryption with Key ID** | Banking and credential columns are encrypted at rest with AES-256-GCM, keyed from the environment. Each ciphertext is prefixed with a key ID, enabling rotation without breaking old data. Plaintext is never logged, even on error. |
| **P5: Async via Job Queue** | Every async side effect (email, billing, recurrence) goes through the job runner (pg-boss). Domain writes and job enqueues share one transaction (pg-boss `db` adapter), so a job row exists only if its trigger committed. No background tasks outside the queue. |
| **P6: One Root Command Set** | All development, CI, and operations use the same named root scripts: `setup`, `dev`, `lint`, `typecheck`, `test`, `test:integration`, `db:migrate`, `db:rollback`, `db:reset`, `build`, `ci`. These run on every developer machine and in CI with the same gates, versions, and behavior. |
| **P7: 12-Factor Config, Fail-Fast** | All configuration comes from environment variables, validated by zod at application boot. Invalid or missing required values cause immediate process exit with a clear error message. No defaults that mask misconfig; no lazy validation. |

## System Architecture

### High-Level Architecture
```
Browser -> apps/web (Next.js) -> apps/api (Fastify HTTP) -> PostgreSQL 17
                                  apps/api/src/worker.ts (pg-boss worker) -> PostgreSQL 17 (pgboss schema)
                                                                          -> Notifier (smtp/Mailpit, memory)
packages/shared (@sgm/shared): enums, zod DTOs, money, time, invoice - used by web and api
```

### Component Responsibilities
- **apps/web**: Next.js App Router UI; talks to the API only through `src/lib/api-client.ts` and `API_INTERNAL_URL`.
- **apps/api (HTTP)**: Fastify, built by `buildApp(deps)`; routes in `src/routes` and `src/modules/<feature>/{routes,service,repo}.ts`.
- **apps/api (worker)**: `src/worker.ts`; the only process that supervises, schedules and works pg-boss queues. The HTTP process is a producer only.
- **packages/shared**: isomorphic primitives (`money`, `time`, `invoice`, `types/enums`, `api/*` zod schemas); consumed as source (JIT package).
- **db/**: hand-written reversible SQL migrations plus `schema-deviations.md`, the ledger of every difference from `database-design.md`.

### Data Flow Patterns

#### Async side effect (email, billing, recurrence)
```
Domain write + enqueue (one transaction) -> pgboss.job -> worker handler -> Notifier / DB
```
- **Trigger**: a domain change or a cron slot in `apps/api/src/jobs/schedules.ts` (Pacific/Auckland).
- **Guarantee**: at-least-once; handlers are idempotent through a unique constraint or guarded status transition.
- **Output**: job state visible in `pgboss.job` (failed jobs stay visible after 3 retries with backoff).
- **Secrets in payloads**: job data is kept for days, so any message carrying a secret (reset link, token) is enqueued with `enqueueEmail(..., { crypto })`; `pgboss.job.data` then holds only `{ idempotencyKey, sealed }` (FieldCrypto envelope bound to the idempotency key) and the handler opens it.

## Design Patterns Used

### Database-enforced invariants (P1)
- **Implementation**: CHECK, UNIQUE, composite FKs, deferred constraint triggers, generated GST columns, `assign_invoice_number()`, session-instant triggers in `db/migrations/`.
- **Trade-offs**: SQL is hand-written and every deviation is ledgered; constraint errors surface as SQLSTATE codes (23505, 23514, 23503).

### Branded primitives (P2, P3)
- **Implementation**: `Money` (bigint cents) and `MoneyString` in `packages/shared/src/money/money.ts`; `LocalDate`/`LocalTime` and explicit DST disambiguation in `packages/shared/src/time/time.ts`; `Ciphertext` brand for encrypted columns.

### Adapter behind an interface
- **Implementation**: `Notifier` (`apps/api/src/lib/notifications/notifier.ts`) with `smtp` and `memory` adapters chosen only by `NOTIFIER_ADAPTER`; `KeyProvider` for encryption keys.

### Keyed envelope encryption (P4)
- **Implementation**: `apps/api/src/lib/crypto/crypto.ts`, AES-256-GCM, AAD = `sgm:v1:<table>.<column>:<rowId>`, envelope CHECK on each encrypted column.

### Authentication and authorization (auth pattern)
- **Implementation**: `apps/api/src/modules/auth/` (own Fastify module: `service`, `reset-service`, `oauth-service`, pure `oauth-decision`, `repo`, `sessions`, `throttle`, `providers/`), platform pieces in `apps/api/src/lib/auth/` (`policy.ts`, `guards.ts`, `request-auth.ts`) and `apps/api/src/lib/http/` (`errors.ts`, `origin.ts`, `internal-auth.ts`). Web side: `apps/web/src/lib/auth/`, `proxy.ts`, `SiteHeader`. Shared contracts: `packages/shared/src/{api,auth}/`. Decisions: `docs/adr/0013` and `0014`.
- **Sessions**: opaque 256-bit tokens, only the SHA-256 stored in `auth_sessions`; 7-day idle and 30-day absolute expiry; the role is read from `users` on every request (no role claim). The **web owns the cookie** (`sgm_session`, HttpOnly, SameSite=Lax, `__Host-` and Secure when `WEB_BASE_URL` is https) and calls the API with `Authorization: Bearer`; the API never sets a cookie.
- **Default-deny route policy**: every route declares `config: { policy }` with `publicRoute()`, `optionalSession()`, `authenticated()`, `requireGlobalRole(...)` or `requireTeamRole(role, { teamIdParam?, allowGlobalAdmin? })` (`lib/auth/policy.ts`). A route without one makes `buildApp` fail. Handlers read `requireAuth(request)`; team roles come from `team_members` with `status = 'APPROVED'`, read fresh each request. New features must follow this for every route.
- **Errors and contracts**: the shared `{ error: { code, message, fieldErrors? } }` shape and one `ErrorCode` list in `packages/shared/src/api/errors.ts`; zod request schemas are strict (an unknown field such as `role` is a 422); the web `api-client` and the Fastify routes import the same schemas.
- **Trust boundary for the client address**: the web derives it from `WEB_TRUSTED_PROXY_HOPS` counted from the right of `X-Forwarded-For` and sends `x-sgm-client-ip` only with `x-sgm-internal-auth` (`API_INTERNAL_SHARED_SECRET`, constant-time compare); production refuses to boot without both.
- **Account linking and throttling**: never auto-link and never sign in on an email match; a completed password reset evicts every Google and Facebook identity (rule R1); sign-in, forgot-password and registration are throttled by the Postgres sliding-log functions `auth_throttle_admit` / `auth_throttle_settle` with HMAC-keyed counters (no email or address in clear). One login uses one timestamp for both admit and settle (the refund matches it exactly).
- **Session-issuance invariant (D1)**: every path that issues a session or attaches a credential (password login, OAuth sign-in, sign-up completion, identity link) locks the user row (`lockUserRow`) and re-checks the credential or identity, and for links the linking session, inside the issuing transaction, so a concurrent password reset always wins.
- **Logging**: `auth.*` events with `userId`/`provider`/`reason` and no email; every request line (including Fastify's "incoming request") carries `traceId`; redaction covers `*token` keys, `sgm_*` cookie names, client secrets, `code`/`state` query values and secret query parameters inside error messages; provider transport errors are never kept as `cause`.
- **Testing**: DB-backed behaviour via `app.inject` over a cloned Postgres (`buildAuthTestApp`), pure rules as table-driven unit tests, browser journeys and axe scans in Playwright on desktop and a 360 px project with `AUTH_FAKE_OAUTH=true` (the fake provider answers `oauth.fake.invalid`).
- **Trade-offs**: we own security-sensitive code (small surfaces, recorded fixtures, tampered-token tests); no MFA, passkeys or session list in v1; the web image bakes `WEB_BASE_URL` (Server Action `allowedOrigins`), so there is one image per environment.

### Team membership state machine and DB invariants (team-management)
- **Implementation**: migration `db/migrations/20261013000100000_team_membership_invariants.sql` (ledger D-40..D-46): admin implies APPROVED; stamp CHECKs for approval and ban; `ban_reason` 1-500 trimmed; a `BEFORE UPDATE` trigger allowing only PENDING to APPROVED or REJECTED, REJECTED to PENDING, and APPROVED to BANNED (BANNED is terminal in v1) and making `team_id`/`user_id` immutable; deferred constraint triggers that require one approved admin at COMMIT (`team_members_last_admin`); team name, description and invite-code format CHECKs; a unique `(created_by, create_idempotency_key)` for create replays. The pure table `modules/teams/transitions.ts` (`decide`) gives the precise 409 on the normal path and is kept aligned with the trigger by a shared matrix fixture.
- **Lock order**: the team row first, then `team_members` rows. Every moderation takes the team row `FOR NO KEY UPDATE` (the per-team mutex), re-checks under that lock that the actor is still an approved admin (the route guard ran outside the transaction), then locks the target by `(team_id, user_id)` and writes with a guarded `UPDATE ... WHERE status = $expected`. The service maps DB violations by `err.constraint` (last admin: 409 `last_team_admin`).
- **Policy**: all admins are equal; ban only an APPROVED `MEMBER` (an admin is refused with `team_admin_cannot_be_banned` until demoted); re-request after rejection returns the same row to PENDING. Decision record: `docs/adr/0015-team-membership-and-ban-seam.md`.
- **Trade-offs**: the rules live in two encodings (SQL and TypeScript) that must be kept in step; the database is the backstop, the TypeScript table only shapes the error.

### Ban seam (member-banned)
- **Implementation**: a ban commits `status = 'BANNED'` and enqueues a `member-banned` job in the same transaction (P5), so a rolled-back ban leaves no job. Queue policy `exclusive`, `singletonKey = member-banned:<membershipId>`, `retryLimit 3`, 7-day retention. The payload is ids plus one UTC timestamp (`MemberBannedPayload` in `modules/teams/ban-hook.ts`); no name, email, invite code or ban reason reaches `pgboss.job` or a log line.
- **Port**: `MemberBannedHandler` with a no-op default (logs `team.member.banned.hook_noop`). The real handler is injected only through `registerJobs({ memberBannedHandler })` in `jobs/bootstrap.ts` and `worker.ts`, never through an environment variable. The job (`jobs/member-banned.ts`) re-reads the membership by id: gone is a no-op (`team.member.banned.stale`), and mismatched ids or status fail without retries.
- **Failure rules**: access is revoked by the committed row, so a failing handler never undoes or delays the ban. Transient errors retry with backoff; permanent ones (`NonRetryableJobError`, or retries exhausted) end in `failed` with `team.member.banned.hook_failed`. The re-run is `cli jobs trigger member-banned '<json>'`.
- **Approved-member gate**: `assertApprovedMember(trx, teamId, userId)` (`modules/teams/membership.ts`) reads the `team_members` row `FOR SHARE` and throws `forbidden` unless APPROVED. Registration calls it inside its transaction before any `game_sessions` lock. Canonical lock order for all features: `teams`, `team_members`, `game_sessions`, `registrations`, `registration_guests`, payments.
- **Status**: the handler is a no-op until registration-and-waitlist ships. The ban confirmation copy promises no cancellation until then. ADR 0015 holds the handler contract (idempotent, state-based selection, one session per transaction) and the reconciliation sweep that registration-and-waitlist must ship.

### Invite codes (team-management)
- **Implementation**: `modules/teams/invite-code.ts`. 256 random bits from `crypto.randomBytes`, base64url (43 characters, inside the `teams_invite_code_format` CHECK). A unique-constraint collision is retried with a new code up to 3 attempts (`withInviteCodeRetry`), each attempt in its own transaction.
- **Capability handling**: the code is a bearer capability to ask to join. It is compared in constant time (`timingSafeEqual`), is never logged, and is sent by `POST` so it never appears in a URL. Only `getInviteCode`, `lockTeam` and the lookup-by-code query select it (`repo.ts`), so list and detail responses cannot leak it. It is returned only by the admin invite-code endpoints and regenerate.
- **Rotation race**: a join holds the team row `FOR SHARE` and a regenerate holds it `FOR UPDATE`, so a join either sees the rotated code or waits; a join with the old code after a committed rotation fails.

### Manage area registry and inline confirm (web)
- **Area registry**: `apps/web/src/lib/teams/manage-areas.ts` (`MANAGE_AREAS`). Today there is one area ("People"), so `manageAreaLinks` returns no nav. A later feature appends one entry and the area nav appears when there are two or more.
- **InlineConfirm**: `apps/web/src/components/teams/inline-confirm.tsx` is the one confirmation pattern. It is a disclosure (`aria-expanded`, `aria-controls`) with a non-modal `role="group"` under the row. Focus moves to the prompt, Cancel and Escape return it to the trigger, and only one confirm is open per section (`manage-state.ts` reducer). No native `confirm()` or `<dialog>`, because a native browser dialog blocks the flow in UAT. It needs JavaScript; the safe failure is that the destructive action cannot be taken.
- **Moderation Server Actions**: `apps/web/src/lib/teams/actions.ts` (`'use server'`) calls the API with the bearer token. `moderation.ts` maps each API answer to its copy and `refresh` flag. Actions are never optimistic: the manage page is revalidated only after a successful change, and a 5xx keeps the panel open with no change.

## Integration Patterns

### Email
- **Type**: outbound, via the `send-email` job. **Protocol**: SMTP (Mailpit in dev and CI; provider TBD, likely Postmark). **Contract**: `EmailMessage` with a required `idempotencyKey`.

### Web to API
- **Type**: HTTP/JSON, zod contracts in `packages/shared/src/api/`; OpenAPI at `apps/api/openapi.yaml` (drift-checked, documents the `sessionToken` bearer scheme). The web calls the API only server-side (`API_INTERNAL_URL`) with the session token as a bearer, a `traceparent`, and the internal hop headers described above.

### Google and Facebook OAuth
- **Type**: outbound, authorization-code flow through the web-owned callback `/auth/callback/<provider>`; thin adapters (`providers/google.ts` with PKCE and `jose` ID-token verification, `providers/facebook.ts` with `appsecret_proof` and a pinned Graph version). Single-use state and pending sign-ups live in Postgres. No provider token is stored. `AUTH_FAKE_OAUTH=true` swaps in fakes (refused in production).

## Code Organization Patterns

### Source Language & Default Extensions
- **Primary language**: TypeScript only. `.ts` for logic, `.tsx` only for React components in `apps/web/src/app/**` and `apps/web/src/components/**`.
- **`.js`/`.jsx` permitted?**: No. `.mjs` only for tool configs that require it (`eslint.config.mjs`, `postcss.config.mjs`).
- **Type-checking enforced**: `pnpm run typecheck` (`strict: true` in every package), part of `ci`.

### File Extension by Directory / Role

| Directory / Role | Extension | Notes |
|------------------|-----------|-------|
| `apps/api/src/**`, `packages/shared/src/**`, `scripts/` | `.ts` | Server and shared logic |
| `apps/web/src/app/**`, `apps/web/src/components/**` | `.tsx` | Any file rendering JSX |
| `apps/web/src/lib/**` | `.ts` | No JSX |
| `db/migrations/` | `.sql` | `<utc-timestamp>_<name>.sql`, `-- Up Migration` / `-- Down Migration` |
| Unit tests | `.test.ts` | Co-located with source |
| Integration tests | `.int.test.ts` | `apps/api/test/integration/` |
| E2E tests | `.spec.ts` | `apps/web/e2e/` (Playwright) |
| Docs | `.md` | `docs/getting-started.md`, `docs/adr/NNNN-*.md` |

### Module Structure
- **New feature module shape**: `apps/api/src/modules/<feature>/{routes.ts,service.ts,repo.ts}`, registered explicitly in `buildApp(deps)`.
- **Where shared code lives**: cross-app types, DTO schemas and primitives in `packages/shared/src/`; server platform code in `apps/api/src/lib/<area>/`.
- **Jobs**: queue in `apps/api/src/jobs/registry.ts`, handler in `apps/api/src/jobs/`, wiring in `bootstrap.ts`, cron in `schedules.ts`.

## Testing Patterns

### Test Organization
- **Test location**: unit tests co-located (`*.test.ts` next to source); integration tests in `apps/api/test/integration/*.int.test.ts`; helpers in `apps/api/test/helpers/`.
- **File mapping**: one test file per module.
- **Naming convention**: `*.test.ts`, `*.int.test.ts`, `*.spec.ts` (Playwright only).

### Test Grouping
- **Within-file structure**: group by behavior; shallow `describe` nesting.
- **Setup sharing**: factory functions (`test/helpers/factories.ts`); each integration file clones a migrated template database (`createTestDatabase()`), so tests may COMMIT freely. Deferred-constraint tests use `SET CONSTRAINTS ALL IMMEDIATE`.

### Test Framework & Style
- **Framework**: Vitest 5 (projects `unit` and `integration`, forks pool for integration), Playwright for the web journeys (desktop and a 360 x 740 project, axe-core scans, run against the Compose stack with `AUTH_FAKE_OAUTH=true`; not part of `ci`).
- **Assertion style**: `expect(...)`.
- **Mocking approach**: dependency injection and test doubles (the `memory` notifier); no DB mocking, integration tests use real PostgreSQL 17.
- **Injected clocks**: tests that inject a `Clock` advance it between the sequential calls of one operation (admit then settle, issue then verify); a frozen clock hides timestamp-matching bugs.

### Test Scope Preferences
- **Emphasis**: balanced; DB constraints are proven against a real database.
- **Coverage gate**: 80% lines/functions/branches/statements, measured over unit **and** integration tests (`pnpm run test:coverage`, used by `ci`), on `packages/shared/src/{money,time,invoice,auth}`, `apps/api/src/lib/{crypto,config,notifications,jobs,logger,telemetry,http,auth}`, `apps/api/src/modules/auth/**` and `apps/web/src/lib/**`. New feature modules should be added to the list.
- **Not tested**: generated types (`types.generated.ts`, checked by tsc and drift tests), framework boilerplate, real external providers (Postmark, Akahu) until their features land.

<!-- AUTO-MANAGED: c4-architecture-start -->
## C4 Architecture

<!--
  This section is auto-managed by /yay:c4. Run /yay:c4 to populate or refresh.
  Until /yay:c4 has been run for the first time, this section is a placeholder.
  Do not hand-edit between the AUTO-MANAGED markers — edits will be overwritten.
-->

C4 architecture documentation has not been generated for this project yet.

To populate this section, run `/yay:c4`. The command builds a complete bottom-up architecture model (Code → Component → Container → Context) and stores it under `memory-bank/c4/`. After it runs, this section will contain pointers to the generated docs and guidance on how agents should use them.

`/yay:c4` is idempotent — re-running only re-walks source directories whose content has changed. It is recommended for **large brownfield codebases** (≥3 components or ≥50 source files) and is auto-prompted at the end of `/yay:init` for projects that meet the threshold.

<!-- AUTO-MANAGED: c4-architecture-end -->

## Recent Architecture Changes

### 2026-10-13 - Team management (team-management)
- **What Changed**: `modules/teams` (routes, service, repo, transitions, invite code, membership gate, ban hook) with a DB-enforced membership state machine (migration `20261013000100000`); the `member-banned` job and its no-op handler port; invite-code rotation; the team-admin manage area with Server Actions for moderation, the area registry and the InlineConfirm disclosure.
- **Reason**: Team admins need to approve, moderate and ban members, and registration-and-waitlist needs a race-free ban signal without the ban depending on that feature (see `docs/adr/0015`).
- **Trade-offs**: a ban revokes team access synchronously but releases seats only eventually (via the job); the handler is a no-op until registration-and-waitlist ships; moderation is serialised per team by the team row lock.
- **Affected Components**: `apps/api` (`modules/teams`, `jobs/member-banned.ts`, `jobs/bootstrap.ts`, `worker.ts`, `cli.ts`), `apps/web` (`app/teams`, `components/teams`, `lib/teams`, `e2e/teams.spec.ts`), `packages/shared` (team DTOs), `db/migrations`.

### 2026-10-06 - Authentication and user roles (auth-and-user-roles)
- **What Changed**: Email/password, Google and Facebook sign-in; opaque Postgres sessions relayed by the web as a bearer token; default-deny route policies with global and per-team role guards; Postgres sliding-log throttling; password reset that evicts OAuth identities; the shared HTTP error shape; web `SiteHeader`, auth pages, `proxy.ts`; Playwright journeys on two viewports.
- **Reason**: Players need to get in quickly and every later feature needs a trustworthy `request.auth` and guards (see `docs/adr/0013` and `0014`).
- **Trade-offs**: own security-sensitive code instead of a framework; per-environment web image because `WEB_BASE_URL` is baked into Server Action origins; coverage is now measured over unit and integration tests together.
- **Affected Components**: `apps/api` (`modules/auth`, `lib/auth`, `lib/http`, jobs `auth-cleanup`), `apps/web` (pages, `lib/auth`, `proxy.ts`), `packages/shared`, `db/migrations` (D-27 onwards), `docker-compose.yml`, `vitest.config.ts`.

### 2026-09-29 - Platform foundation established
- **What Changed**: Greenfield monorepo built: pnpm workspaces (`apps/web`, `apps/api` with worker entrypoint, `packages/shared`), Fastify + Kysely + node-pg-migrate + pg-boss on PostgreSQL 17, AES-256-GCM field encryption, exact money and DST-safe time primitives, notifier abstraction, Docker Compose stack and CI gates.
- **Reason**: One lean, all-Postgres TypeScript stack that a single developer can run and that enforces invariants in the database (see `docs/adr/0001` to `0012`).
- **Trade-offs**: hand-written SQL and no framework-imposed structure, in exchange for exact constraints, real down migrations and one fewer service (no Redis).
- **Affected Components**: all; every downstream v1.0.0 feature builds on it.

---

## Notes

- Keep this file updated during the BUILD phase when architectural changes occur
- Document patterns and trade-offs to help future developers understand design decisions
- Keep Guiding Principles current; flag any pattern that appears to contradict one
