# Architecture Decision: Team Membership State Machine and the Ban Side-Effect Seam

**Created**: 2026-10-13
**Status**: DECIDED
**Decision Type**: Architecture
**Task**: `team-management` (Level 3). Spec: `memory-bank/tasks/team-management.md` (approved 2026-10-13; the ACs are the contract, amended only where listed in [Spec amendments](#spec-amendments)).
**Resolves**: Creative Q1 (ban side-effect seam, ADR, backfill sweeper, cancellation status and fee semantics), Q3 (membership state machine policy and its DB invariants, lock ordering), Q4 (invite-code design), Q5 (search semantics).
**Not decided here**: Q2 (team-admin area layout, header nav) and Q6 (creator skill capture) belong to the UI/UX creative doc; this design keeps the spec defaults for them. End-to-end flows belong to the User Journey creative doc.
**Basis**: `main` at `73ae1c7` (platform-foundation + auth-and-user-roles merged) plus the task file on `feature/team-management`. Principles P1–P7 from `memory-bank/systemPatterns.md`. Prior decisions: `docs/adr/0001`–`0014`, ledger D-01..D-39 in `db/schema-deviations.md` (notably D-10..D-14 and the D-14 waitlist locking contract, and D-33 as the reference deferred-trigger pattern). Learned rules: `_learned/job-queues-pgboss.md`, `_learned/testing-integration-db-isolation.md`, `_learned/testing-injected-clock.md`.

---

## Context

### System Requirements
- A team's membership is a per-row state machine on `team_members` (`PENDING`, `APPROVED`, `REJECTED`, `BANNED`) crossed with a role (`MEMBER`, `TEAM_ADMIN`). Moderation (approve, reject, promote, demote, ban) is done by any approved `TEAM_ADMIN` of that team; all admins are equal (AC-HAPPY-6..11).
- A team never loses its last approved admin, including under concurrent self- and cross-demotion (AC-ERROR-7).
- An admin cannot be banned; ban is only from `APPROVED` `MEMBER`; `BANNED` is terminal in v1 (AC-ERROR-6, Scope Boundaries).
- Ban "immediately revokes team access, blocks future registrations, and cancels active session registrations (triggering waitlist promotion)" (PRODDUCT-OVERVIEW §2). Registration code does not exist yet; registration-and-waitlist owns cancellation, fees, FIFO and notifications.
- A failing ban side-effect must never undo or delay the ban (AC-ERROR-12); the side-effect must be durable and committed with the ban (AC-ASYNC-1, P5).
- One invite code per team, regenerable; the old code dies at once, pending requests survive (AC-HAPPY-12); the code survives the sign-in round trip (AC-ENTRY-4) and never leaks into logs (AC-VERIFY-3).
- Find a team: case-insensitive substring over `PUBLIC` teams, LIKE wildcards literal, keyset pagination of 20, Previous and Next links (AC-HAPPY-3, AC-VERIFY-4).

### Technical Constraints
- **Existing schema** (`20260929000300000_teams.sql`, `20260929000400000_team_members.sql`): `teams.invite_code varchar(100) UNIQUE NOT NULL`, `team_members UNIQUE(team_id, user_id)`, `role`/`status`/`skill_level` with defaults, stamp columns `approved_at/by`, `banned_at/by`, `ban_reason`, no CHECKs on any of them. `team_members.team_id → teams ON DELETE CASCADE`, `user_id → users ON DELETE CASCADE`.
- **Registration schema already exists** (D-10..D-14): `registrations.status registration_status ('CONFIRMED','WAITLISTED','WITHDRAWN')`, `queue_position` iff `WAITLISTED`, partial unique `(session_id, queue_position) WHERE status='WAITLISTED'`, and the **D-14 locking contract**: every enqueue, withdraw and promote first runs `SELECT … FROM game_sessions WHERE id = $1 FOR UPDATE`.
- **Job runner** (`apps/api/src/lib/jobs/jobs.ts`, ADR 0004): at-least-once; `singletonKey` dedupes only queued/active jobs on `exclusive` queues; `enqueue(..., { trx })` writes the job inside the caller's Kysely transaction; `_meta.traceparent` is injected and restored automatically; `NonRetryableJobError` ends a job without retries. Registry defaults: `retryLimit 3`, `retryDelay 5`, backoff, `expireInSeconds 900`, retention 7 days.
- **Auth platform** (ADR 0013): `requireTeamRole` reads `team_members` with `status='APPROVED'` **outside** any transaction on every request; `AppError` + closed `ErrorCode` list; `safeReturnTo` caps `returnTo` at 512 chars and it is stored in `oauth_states.return_to` / `oauth_pending_signups.return_to` during OAuth.
- **Postgres row-lock facts used below**: an FK insert takes `FOR KEY SHARE` on the parent row; `FOR NO KEY UPDATE` does not conflict with it, `FOR UPDATE` does. An `UPDATE` that changes a column covered by a full unique index (here `teams.invite_code`) takes `FOR UPDATE`, not `FOR NO KEY UPDATE`. Under `READ COMMITTED`, a `SELECT … FOR SHARE` that waits for a concurrent `UPDATE` returns the **updated** row version once that transaction commits; each statement in a plpgsql function takes a fresh snapshot.
- **No production data** (stage: Concept): the new CHECKs can be added without a backfill.

### Non-Functional Requirements
- **Integrity (P1)**: every membership rule above is a DB constraint or trigger, with the service mirroring it for good errors.
- **Async (P5)**: the ban side effect runs through pg-boss, enqueued in the ban's transaction.
- **Security**: guard-before-validation, IDOR-safe `(team_id, user_id)` lookups, no private-team existence leaks, invite code ≥ 256 bits and redacted from logs.
- **Privacy (NZ Privacy Act 2020)**: job payloads and logs carry ids only, never name, email, invite code or `ban_reason`.
- **Performance**: Find p95 < 300 ms at several hundred public teams; moderation is low-volume (per-team serialisation is acceptable).
- **Operability**: one developer, no new services, no new environment variables.

---

## Component Analysis

### Core Components

| Component | Purpose | Responsibilities |
|-----------|---------|------------------|
| Migration `db/migrations/20261013000100000_team_membership_invariants.sql` | DB-enforced membership rules (P1) | CHECKs on stamps and admin status, transition + key-immutability trigger, deferred last-admin constraint triggers, teams content CHECKs, Find and admin-list indexes (D-40..D-45). |
| `apps/api/src/modules/teams/transitions.ts` | Pure transition table | `decide(action, target, ctx) → { ok: true, next } \| { ok: false, error: ErrorCode }`; the single TS source for which `(status, role, action)` is allowed and which error code a refusal maps to. Unit-tested table-driven. |
| `apps/api/src/modules/teams/repo.ts` | Kysely queries | `lockTeam(trx, teamId, mode)`, `findActorRole(trx, …)`, `lockTarget(trx, teamId, userId)`, guarded `UPDATE … WHERE status = $expected RETURNING`, join upsert, Find and member-list keyset queries. |
| `apps/api/src/modules/teams/service.ts` | Use cases | Create, join, approve, reject, promote, demote, ban, regenerate; one transaction per mutation following the [moderation transaction shape](#moderation-transaction-shape); DB-error mapping; `team.*` logs after commit. |
| `apps/api/src/modules/teams/membership.ts` | Approved-member gate | Exported `assertApprovedMember(trx, teamId, userId)` (`FOR SHARE`), the contract registration-and-waitlist and auto-enrol call. |
| `apps/api/src/modules/teams/ban-hook.ts` | Ban seam (port side) | `MemberBannedPayload` zod schema, `MemberBannedEvent`, `MemberBannedHandler` port, `noopMemberBannedHandler`, `memberBannedSingletonKey`, `enqueueMemberBanned(jobs, payload, { trx })`. |
| `apps/api/src/jobs/member-banned.ts` | Ban seam (job side) | `createMemberBannedJobHandler({ db, hook })`: validates the payload, re-reads the membership, calls the port, classifies errors, logs `team.member.banned.*`. |
| `apps/api/src/jobs/{registry,bootstrap}.ts`, `apps/api/src/worker.ts` | Wiring | `member-banned` queue (`exclusive`); `RegisterJobsOptions.memberBannedHandler` (default `noopMemberBannedHandler`). |
| `apps/api/src/modules/teams/invite-code.ts` | Invite code | `generateInviteCode()` = `randomBytes(32).toString('base64url')` (43 chars); insert/rotate with a 23505 retry (max 3). |
| `apps/api/src/modules/teams/search.ts` | Find semantics | Query normalisation, LIKE escaping, opaque bidirectional cursor codec. |
| `docs/adr/0015-team-membership-and-ban-seam.md` | Recorded contract | Membership invariants, lock order, the gate contract and the `MemberBannedHandler` contract registration-and-waitlist must honour. |

### Component Interactions

```
Ban (HTTP, one transaction)                                     Worker (later, at least once)
---------------------------                                     -----------------------------
requireTeamRole('TEAM_ADMIN')  (preHandler, outside trx)
BEGIN
  teams        FOR NO KEY UPDATE      (per-team moderation mutex)
  team_members actor: still APPROVED TEAM_ADMIN?  else 403
  team_members target FOR UPDATE      (404 / 409 via transitions.ts)
  UPDATE team_members SET status='BANNED', banned_* ... WHERE status='APPROVED' AND role='MEMBER'
  INSERT pgboss.job (member-banned, singletonKey member-banned:<membershipId>)   <- same trx (P5)
COMMIT  (deferred triggers run here)  -> 200, log team.member.banned
                                                     \
                                                      +--> member-banned job --> createMemberBannedJobHandler
                                                                                  re-read membership (BANNED?)
                                                                                  hook.handle(event)  (port)
                                                                                    no-op today; registration-and-waitlist:
                                                                                    per session: game_sessions FOR UPDATE (D-14)
                                                                                      -> WITHDRAWN + promote

Registration (registration-and-waitlist, future, one transaction)
BEGIN
  assertApprovedMember(trx, teamId, userId)   team_members FOR SHARE   <- conflicts with the ban UPDATE
  game_sessions FOR UPDATE (D-14) -> capacity / FIFO -> INSERT registrations
COMMIT
```

**Canonical lock order** (recorded in ADR 0015; every feature must acquire in this order and skip levels it does not need):
`teams` → `team_members` → `game_sessions` → `registrations` → `registration_guests` / payments.
The ban path stops at `team_members`; the handler starts at `game_sessions`; registration takes `team_members` (shared) then `game_sessions`. No transaction ever waits on a `team_members` row while holding a `game_sessions` lock, so the three paths cannot deadlock.

---

## Options Explored

### Q1: Ban side-effect seam

#### Option 1A: Synchronous in-transaction hook
- **Description**: The ban transaction calls `onMemberBanned(trx, event)` which, once registration-and-waitlist exists, withdraws every active registration and promotes the waitlist before COMMIT.
- **Architecture Diagram**:
  ```
  BEGIN; lock team; lock target; UPDATE status=BANNED;
         for each future session: game_sessions FOR UPDATE -> withdraw -> promote -> enqueue emails
  COMMIT
  ```
- **Pros**:
  - Strongest reading of "immediately cancels": no window where a banned player still holds a seat.
  - One transaction, no job to monitor.
- **Cons**:
  - Lock order `team_members → game_sessions` inside the ban, held across N sessions: the ban waits on every busy session (e.g. a registration rush), and the moderation mutex (`teams` row) is held the whole time.
  - A bug or exception in registration code rolls back the ban, which breaks AC-ERROR-12 ("a failing side-effect never undoes the ban").
  - Couples the teams module to registration code that does not exist yet. Until it does, the hook would be a no-op anyway, so this option buys nothing now and makes the future change riskier.
  - Violates the spirit of P5 (an async side effect, including emails to promoted players, fanned out inside an HTTP request).
- **Technical Fit**: Low
- **Complexity**: Medium
- **Scalability**: Low (ban latency grows with the number of registrations and session contention)

#### Option 1B: Committed status + durable `member-banned` job + replaceable port + `FOR SHARE` gate (spec default)
- **Description**: The ban commits `status='BANNED'` and a `member-banned` pg-boss job in one transaction. Access revocation and the registration block are synchronous consequences of the committed row: guards read `status='APPROVED'`, and registration calls `assertApprovedMember` (row `FOR SHARE`) inside its own transaction. Cancellation and promotion run later in the worker through the `MemberBannedHandler` port (no-op default until registration-and-waitlist replaces it).
- **Pros**:
  - The ban never depends on registration code; a failing handler retries and then fails visibly (AC-ERROR-12).
  - Race-free hand-off: the gate's `FOR SHARE` conflicts with the ban's row `UPDATE`. A registration either commits before the ban (the job, which runs after the ban commits, sees it) or waits and then sees `BANNED` and is refused. Nothing slips between the two (AC-INTEGRATION-1).
  - Matches P5 exactly and reuses the existing job runner, trace propagation and retry policy.
  - The port is the natural place for registration-and-waitlist to plug in; the contract is testable today with a recording handler and a fixture `registrations` row.
- **Cons**:
  - Cancellation is eventual (about 2 s polling plus handler time; up to the expiry/retry window if the worker is down). During that window the banned player's seat is still held; they cannot use it to register anew (gate) and cannot reach team routes (guard).
  - A permanently failed job needs operator action (re-run) or a reconciliation sweep.
- **Technical Fit**: High
- **Complexity**: Low
- **Scalability**: High

#### Option 1C: Hybrid (synchronous withdraw, asynchronous promotion and notifications)
- **Description**: The ban transaction withdraws the banned member's registrations (cheap `UPDATE`s) and enqueues one `promote-waitlist` job per affected session.
- **Pros**:
  - The seat is released at ban time; promotion and emails stay async.
- **Cons**:
  - Withdraw is a D-14 operation, so it still needs `game_sessions FOR UPDATE` per session inside the ban, with the same latency and coupling as 1A.
  - Splits one business operation (withdraw + promote) across two transactions. A crash between them leaves a free seat and a waiting queue, which needs its own reconciliation.
  - Still requires registration code that does not exist; the seam today would still be a no-op port called in-transaction.
- **Technical Fit**: Medium
- **Complexity**: High
- **Scalability**: Medium

#### Option 1D: Database trigger cascade
- **Description**: An `AFTER UPDATE` trigger on `team_members` (status → `BANNED`) sets the user's active registrations in that team to `WITHDRAWN` in SQL.
- **Pros**:
  - Pure P1; impossible to forget.
- **Cons**:
  - FIFO promotion, capacity with guests, fee rules and notifications would have to be duplicated in plpgsql or left half-done.
  - The trigger takes session locks implicitly inside the ban, with the same lock-order and latency problems as 1A, and they are harder to see.
  - Business logic owned by registration-and-waitlist would live in a teams migration.
- **Technical Fit**: Low
- **Complexity**: High
- **Scalability**: Medium

**Sub-decision Q1-S (backfill / reconciliation sweeper)**
- *S1 ship a sweeper now*: a cron that re-enqueues `member-banned` for every `BANNED` row. With a no-op handler and no registration code it does nothing useful and adds a queue, a schedule and tests.
- *S2 no sweeper ever*: relies on every job eventually succeeding or an operator noticing. This leaves a gap in one realistic case: registration-and-waitlist deploys its API (registrations become possible) before its worker (real handler). A ban in that window is "handled" by the no-op and its registrations would never be cancelled.
- *S3 (chosen) the reconciliation sweep ships with registration-and-waitlist*. It is a query for `registrations` that are active in a future `PUBLISHED` session of a team where the member is `BANNED`, which enqueues `member-banned` per membership (deduped by `singletonKey`). It runs daily and on demand. It closes the deploy-window gap and the permanently-failed-job gap with the same idempotent handler. This feature only guarantees the handler contract that makes such a sweep safe.

**Sub-decision Q1-F (cancellation status and fee semantics, for registration-and-waitlist)**
- *F1 treat as a late withdrawal after the deadline* (charge the banned player if the waitlist is empty): the ban is an admin action, not the player's choice. Charging would be a penalty the product spec does not define, and it would create a payment record for a person who has just been removed.
- *F2 (chosen) treat as an early withdrawal regardless of the deadline*: `status = 'WITHDRAWN'`, no fee and no payment record for the banned player, and the normal FIFO promotion routine runs. A promoted registrant is billed post-game as usual.
- *F3 delete the registration rows*: loses history, and `ON DELETE RESTRICT` from payments forbids it once billed.

### Q3: Membership state machine policy and enforcement

#### Option 3A: CHECKs only, transitions in TS
- **Description**: Add the stamp and admin CHECKs; the service's transition table is the only guard on moves; last-admin checked in TS under the team lock.
- **Pros**: Least SQL; one place for the transition logic.
- **Cons**: A raw `UPDATE` (support fix, future feature) can resurrect a `BANNED` row or orphan a team. This violates P1, and AC-VERIFY-2 explicitly requires the trigger and the deferred constraint.
- **Technical Fit**: Low · **Complexity**: Low · **Scalability**: High

#### Option 3B: CHECKs + `BEFORE UPDATE` transition trigger + deferred last-admin constraint triggers + TS mirror under a team-row lock (spec default)
- **Description**: The DB enforces the state diagram (`PENDING → APPROVED|REJECTED`, `REJECTED → PENDING`, `APPROVED → BANNED`), stamp/role consistency, key immutability and "≥ 1 approved admin at COMMIT". The service serialises every moderation mutation per team with `teams … FOR NO KEY UPDATE`, re-checks the actor's admin role under that lock, uses guarded `UPDATE … WHERE status = $expected` and maps refusals to precise error codes. The DB triggers are the backstop (they produce 23514/23000, which are mapped to the same codes).
- **Pros**: P1-complete; good errors in the normal path; race-safe even for paths that skip the app lock (the trigger re-locks the team row and re-reads with a fresh statement snapshot, the same pattern as D-33).
- **Cons**: Two places encode the transition table (SQL and TS), kept aligned by one table-driven test that runs the same matrix against both.
- **Technical Fit**: High · **Complexity**: Medium · **Scalability**: High (moderation is per-team, low-volume)

#### Option 3C: Append-only membership event log with a derived current state
- **Description**: `team_membership_events` (requested, approved, rejected, promoted, demoted, banned) with the current row as a projection.
- **Pros**: Full audit history; unban and cooldowns become easy later.
- **Cons**: Audit history is explicitly out of scope; projection consistency needs its own triggers; it doubles the write path for a v1 that needs none of it.
- **Technical Fit**: Medium · **Complexity**: High · **Scalability**: High

**Policy sub-decisions (Q3-P)**
| Policy | Options weighed | Chosen |
|---|---|---|
| Re-request after rejection | none / cooldown (e.g. 7 days) / max N attempts | **Allowed at once, no cooldown.** The same row goes `REJECTED → PENDING` with a new skill level and `requested_at`. Spam costs an admin one click. A cooldown needs a `rejected_at` column and copy, so it can be added later without breaking anything. |
| `BANNED` terminal | terminal / admin unban → `REJECTED` | **Terminal in v1.** The transition trigger refuses every move out of `BANNED`. A future unban is one migration (allow `BANNED → REJECTED`, clear ban stamps) plus a route. |
| Ban source states | `APPROVED` only / also `PENDING` | **`APPROVED` `MEMBER` only.** For a `PENDING` requester the admin uses Reject. Banning a non-member (pre-emptive block) is out of scope. |
| Admin hierarchy | creator is owner / all admins equal | **All admins equal.** `teams.created_by` is informational only. |
| Last admin | app check / DB trigger / both | **Both**: team-row lock + deferred constraint trigger (Option 3B). |
| Team must have an admin at creation | deferred `AFTER INSERT ON teams` trigger / app-only | **App-only** (documented gap). A DB rule would break the existing `insertTeam` factory and every registration/session fixture that inserts a team without members. The create use case writes both rows in one transaction and is integration-tested. |

### Q4: Invite-code design

#### Option 4A: One code per team (public and private), rotate in place; code travels in `returnTo` (spec default)
- **Description**: `teams.invite_code` (43-char base64url, 256 bits) is the only invite. "Generate new link" replaces it in place: the old code stops matching at once, and rows already created (pending requests, members) are untouched because they never reference the code. An anonymous visitor goes to `/login?returnTo=%2Fteams%2Fjoin%3Fcode%3D…` and comes back to the same URL.
- **Pros**: Uses the existing column and `safeReturnTo` unchanged; no new cookie; works through password login, registration, OAuth and `/register/complete`, because `returnTo` already survives all of them (it is stored in `oauth_states.return_to`).
- **Cons**: The code also appears in the `/login` URL (browser history), in `oauth_states.return_to` until `auth-cleanup` removes it, and in any request-URL log line that is not masked.
- **Technical Fit**: High · **Complexity**: Low · **Scalability**: High

#### Option 4B: Short-lived cookie handoff
- **Description**: `/teams/join?code=X` (anonymous) sets `sgm_invite` (HttpOnly, SameSite=Lax, 15 min, path `/teams/join`) and redirects to `/login?returnTo=%2Fteams%2Fjoin`; after sign-in the page reads and clears the cookie.
- **Pros**: The code stays out of the login URL and out of `oauth_states`.
- **Cons**: The code is already in the shared link and in the visitor's history from the first hit, so the gain is marginal. It adds a new cookie (name, redaction pattern, `proxy.ts` handling, tests on two viewports). A stale cookie lands the next person who signs in on that browser on someone else's invite. It breaks when cookies are cleared mid-flow.
- **Technical Fit**: Medium · **Complexity**: Medium · **Scalability**: High

#### Option 4C: `team_invites` table (many codes, expiry, max uses, per-code revoke)
- **Pros**: Richer control (single-use links, audit of who invited whom).
- **Cons**: None of it is required; the spec has one link plus regenerate. Needs a new table, ledger entries and UI.
- **Technical Fit**: Medium · **Complexity**: High · **Scalability**: High

**Sub-decision Q4-H (hash the code at rest?)**: rejected. `GET /teams/:teamId/invite-code` must show the full link to every admin, so the value must be recoverable. Encrypting it (P4 style) protects a value whose only power is "may ask to join" (an admin still approves). It stays plaintext, with ≥ 256 bits of entropy, redacted from logs, `no-store`/`no-referrer` on the landing page, and rotatable.

### Q5: Search semantics

#### Option 5A: `ILIKE '%term%'` on name or description, ordered by `(lower(name), id)` over a partial btree (spec default)
- **Description**: `WHERE visibility = 'PUBLIC' AND (name ILIKE $p ESCAPE '\' OR description ILIKE $p ESCAPE '\') AND (lower(name), id) > ($n, $i) ORDER BY lower(name), id LIMIT 21`, using `idx_teams_public_name (lower(name), id) WHERE visibility = 'PUBLIC'`.
- **Pros**: True substring ("badm" finds "Badminton"); no extension; deterministic order and a stable keyset cursor; the index serves the ordering and the cursor seek, and the filter stops after 21 matches.
- **Cons**: The substring filter cannot use the btree. A rare term scans every public team. At several hundred to a few thousand teams that is well under 1 ms of CPU.
- **Technical Fit**: High · **Complexity**: Low · **Scalability**: Medium (fine to ~10⁴–10⁵ public teams)

#### Option 5B: `pg_trgm` GIN index on `name` and `description`
- **Pros**: Index-assisted substring search at large scale; similarity ranking possible.
- **Cons**: New extension (trusted since PG 13, but still a new dependency and a ledger entry); a trigram index cannot also deliver the `(lower(name), id)` order, so a large match set still sorts; terms under 3 characters fall back to a scan anyway.
- **Technical Fit**: Medium · **Complexity**: Medium · **Scalability**: High

#### Option 5C: Full-text search (`tsvector` + `websearch_to_tsquery`)
- **Pros**: Stemming, multi-word queries, ranking.
- **Cons**: No substring or prefix-of-word matching without `:*` tricks; English stemming mangles club names; rank ordering is incompatible with a stable name keyset; generated column + GIN index + ledger.
- **Technical Fit**: Low · **Complexity**: Medium · **Scalability**: High

**Ordering sub-decision**: by `(lower(name), id)`. Ordering by member count was rejected: counts change between page loads, so the keyset cursor is unstable (rows skipped or repeated), the popularity bias hides new clubs, and the order would need a maintained counter column to be indexable.

---

## Evaluation Matrix

Scores 1 (poor) to 5 (best).

**Q1 ban seam**

| Criteria | 1A sync hook | 1B job + port + gate | 1C hybrid | 1D DB cascade |
|----------|---|---|---|---|
| Scalability | 2 | 5 | 3 | 3 |
| Maintainability | 2 | 5 | 2 | 1 |
| Performance (ban latency) | 2 | 5 | 3 | 3 |
| Security (access revoked at commit) | 5 | 5 | 5 | 5 |
| Correctness under races | 4 | 5 | 3 | 4 |
| AC-ERROR-12 (failure never undoes ban) | 1 | 5 | 2 | 1 |
| Observability | 3 | 5 | 3 | 2 |
| Implementation cost now | 3 | 5 | 2 | 2 |
| **Total** | 22 | **40** | 23 | 21 |

**Q3 enforcement**

| Criteria | 3A CHECKs only | 3B CHECKs + triggers + lock | 3C event log |
|---|---|---|---|
| P1 compliance | 2 | 5 | 4 |
| Race safety | 3 | 5 | 4 |
| Maintainability | 4 | 4 | 2 |
| Implementation cost | 5 | 4 | 1 |
| **Total** | 14 | **18** | 11 |

**Q4 invite**

| Criteria | 4A returnTo | 4B cookie | 4C invites table |
|---|---|---|---|
| Security (leak surface) | 3 | 4 | 4 |
| Robustness of the round trip | 5 | 3 | 5 |
| Maintainability | 5 | 3 | 3 |
| Implementation cost | 5 | 3 | 1 |
| **Total** | **18** | 13 | 13 |

**Q5 search**

| Criteria | 5A ILIKE + btree | 5B pg_trgm | 5C FTS |
|---|---|---|---|
| Matches spec semantics (substring) | 5 | 5 | 2 |
| Stable keyset paging | 5 | 4 | 2 |
| Performance at target scale | 5 | 5 | 5 |
| Cost / dependencies | 5 | 3 | 3 |
| **Total** | **20** | 17 | 12 |

---

## Observability Architecture

### Logging
- **Library**: the existing pino logger (`apps/api/src/lib/logger/logger.ts`) with the OTel mixin (`traceId`, `spanId`), `service`, `version`; the job runner's child logger (`jobId`, `queue`) in the worker.
- **Format**: structured JSON; configuration unchanged (`LOG_LEVEL`, `LOG_FORMAT`, `LOG_OUTPUT`, `LOG_FILE_PATH`).
- **Events** (one per action, emitted **after** commit or after the refusal is decided; fields `teamId`, `actorId`, `userId` where relevant, plus `traceId` from the mixin; never name, email, invite code, `ban_reason`, session token):
  | Event | Level | Extra fields |
  |---|---|---|
  | `team.created` | info | `visibility` |
  | `team.join.requested` | info | `visibility`, `viaInvite` (bool), `rerequest` (bool) |
  | `team.member.approved` / `.rejected` / `.promoted` / `.demoted` / `.banned` | info | — |
  | `team.invite.regenerated` | info | — |
  | `team.action.refused` | info (warn for `forbidden`) | `action`, `reason` (= the `ErrorCode`) |
  | `team.member.banned.hook_noop` | info | `membershipId` (worker) |
  | `team.member.banned.handled` | info | `membershipId`, `hook`, `affected` (worker) |
  | `team.member.banned.hook_failed` | error (final attempt or non-retryable), warn (will retry) | `membershipId`, `hook`, `attempt`, `willRetry` (worker) |
  | `team.member.banned.invalid_payload` | error | `fields` (paths only) |
  | `team.member.banned.stale` | info | `membershipId` (row gone: team deleted) |
- **Redaction additions**: key pattern `/^invite_?code$/i` in `BASE_KEY_PATTERNS`; add `'returnto'` to `EXACT_QUERY_NAMES` (compared lower-cased) so a logged `/login?returnTo=%2Fteams%2Fjoin%3Fcode%3D…` URL is masked (see Spec amendment A7); `ban_reason`/`banReason` are never passed to the logger (enforced by the log-capture test rather than redaction, so that a regression shows up in the test).

### Distributed Tracing
- **SDK**: OpenTelemetry (existing `lib/telemetry`); **Propagation**: W3C Trace Context.
- **Service Boundaries**:
  | From | To | Protocol | Propagation Method |
  |------|-----|----------|-------------------|
  | Browser | web (Next.js) | HTTP | web starts the trace (existing `traceHeaders()`) |
  | web Server Action / page | api | HTTP | `traceparent` header (existing api-client) |
  | api | Postgres | SQL | active span (pg instrumentation when enabled) |
  | api (ban transaction) | `pgboss.job` | SQL insert in the same trx | `_meta.traceparent` in the payload (injected by `runner.enqueue`) |
  | worker | `member-banned` handler | pg-boss fetch | `"member-banned process"` CONSUMER span parented on `_meta.traceparent` (existing `wrap`) |
  | handler (future) | `send-email` jobs for promoted players | SQL insert | `_meta.traceparent` inherited from the consumer span |
- **Sampling**: unchanged (`OTEL_TRACES_SAMPLER_ARG`; 1.0 dev, production ratio set by ops).
- **Span attributes** (on the HTTP span, low cardinality only): `sgm.team.action` (`approve`, `ban`, …), `sgm.team.outcome` (`ok` or the error code). No team or user ids as attributes on metrics; ids are fine on spans and logs.

### Metrics
- No metrics exporter exists yet (ADR 0013 reserved names the same way). Reserved names, low-cardinality labels only (never team, user or code):
  - `sgm_team_moderation_actions_total{action, outcome}` — moderation volume and refusal rate.
  - `sgm_team_join_requests_total{visibility, outcome}` — join funnel.
  - `sgm_team_member_banned_hook_total{hook, outcome}` — `handled` / `noop` / `retry` / `failed`; alert on `failed > 0`.
  - `sgm_team_find_duration_seconds` (histogram) — Find p95 target 300 ms.
- **Standard**: `http_requests_total{method, route, status_code}`, `http_request_duration_seconds{method, route}` come from the existing HTTP instrumentation once an exporter exists.

### Configuration Variables
No new variables. Existing ones relied on:
| Variable | Purpose | Default |
|----------|---------|---------|
| LOG_LEVEL | Log verbosity | info |
| LOG_FORMAT | Output format | json |
| LOG_OUTPUT / LOG_FILE_PATH | Destination | stdout |
| OTEL_EXPORTER_OTLP_ENDPOINT | Collector endpoint | — (off) |
| OTEL_SERVICE_NAME | Service identifier | sgm-api / sgm-worker |
| OTEL_TRACES_SAMPLER_ARG | Sampling ratio | 1.0 (dev) |
| WEB_BASE_URL | Invite URL base (`{WEB_BASE_URL}/teams/join?code=…`) | — (required) |

The `member-banned` handler implementation is chosen by code wiring in `bootstrap.ts`, not by an environment variable: a deployment cannot accidentally run the no-op once the real handler ships.

---

## Decision

### Q1: Ban seam

**Chosen**: Option 1B. Committed `BANNED` status, a durable `member-banned` job enqueued in the same transaction, a replaceable `MemberBannedHandler` port with a no-op default, and the exported `assertApprovedMember` `FOR SHARE` gate. Sweeper: S3 (ships with registration-and-waitlist). Cancellation semantics: F2 (early-withdrawal semantics, no fee).

**Rationale**: It is the only option that satisfies AC-ERROR-12 and P5 together. The two parts of "immediately" that matter for safety (no team access, no new registrations) are delivered synchronously by the committed row, so only seat release and promotion are eventual. The `FOR SHARE` / row-`UPDATE` conflict gives a provable "before or after the ban" ordering for every registration, which AC-INTEGRATION-1 tests with a real race. Nothing in the ban transaction touches `game_sessions`, so the ban cannot deadlock with or wait on registration traffic.

**ADR**: `docs/adr/0015-team-membership-and-ban-seam.md` (next free number; 0014 is account linking). It records: the membership invariants (D-40..D-45), the canonical lock order, the gate contract, the handler contract below, F2 semantics and the S3 sweep requirement. registration-and-waitlist's plan must cite it.

#### `MemberBannedHandler` contract (normative, copied into ADR 0015)
A handler registered through the port MUST:
1. **Select by current state, not by payload history**: act on every registration with `team_id = event.teamId AND user_id = event.userId AND status IN ('CONFIRMED','WAITLISTED')` whose session has `status = 'PUBLISHED' AND starts_at > now` (handler clock). Sessions that have started or finished are left alone; post-game billing treats them normally.
2. **Process one session per transaction**, in `(starts_at, id)` order. Each transaction first takes `SELECT … FROM game_sessions WHERE id = $1 FOR UPDATE` (D-14), then performs a guarded `UPDATE registrations SET status='WITHDRAWN', queue_position=NULL, updated_at=$now WHERE id=$r AND status IN ('CONFIRMED','WAITLISTED') RETURNING`. Guests withdraw with the registration (the `registration_guests` rows stay as history). Queue positions of others are not renumbered.
3. **Apply early-withdrawal semantics regardless of the deadline** (F2): no fee and no `payments` row for the banned player. If a `CONFIRMED` seat was freed, run the standard FIFO promotion routine in the same transaction (enqueue promotion emails in that transaction, P5).
4. **Never** write `team_members`, never read `ban_reason`, and never notify the banned player (privacy; no notification copy is specified).
5. **Be safe to re-run** at any time, including as a backfill or reconciliation over every `BANNED` membership: a second run finds nothing active and returns `{ affected: 0 }`.
6. **Signal permanence** by throwing `NonRetryableJobError` (e.g. an invariant breach); any other error is treated as transient and retried (`retryLimit 3`, backoff).
7. Pass `apps/api/test/integration/teams-ban-seam.int.test.ts`, which is the contract test (its header says so).

#### Gate contract (normative)
- `assertApprovedMember(trx, teamId, userId)` MUST be called inside the caller's registration or auto-enrol transaction, **before** that transaction takes any `game_sessions` lock. It holds the `team_members` row `FOR SHARE` until COMMIT, so a concurrent ban waits for it and vice versa.
- It assumes `READ COMMITTED` (the project default). Under `REPEATABLE READ`/`SERIALIZABLE`, a concurrent ban surfaces as SQLSTATE 40001, and the caller must retry.

### Q3: State machine

**Chosen**: Option 3B, with the policy table above (re-request immediately, `BANNED` terminal, ban only from `APPROVED` `MEMBER`, all admins equal, last-admin by team-row lock + deferred trigger, no DB rule at team INSERT).

**Rationale**: P1 demands that the DB forbid illegal states and moves; the team-row mutex gives deterministic, readable 409s and makes the deferred trigger a backstop that normally never fires. The D-33 pattern (lock the parent row inside the deferred trigger, skip if the parent is gone) is already proven in this codebase.

### Q4: Invite code

**Chosen**: Option 4A. One 256-bit base64url code per team for both visibilities, rotated in place under a team lock, carried in `returnTo` during sign-in (accepted trade-off), with `returnTo` masked in logged URLs.

**Rationale**: The code is a low-power capability (request only), already present in the shared link and the visitor's history, and rotatable. The cookie handoff adds state and failure modes to remove a copy that is not the main exposure. The added `returnTo` masking addresses the one leak that matters (server logs).

**Rules**:
- `POST /teams/invite/lookup { code }`: exact match on `teams.invite_code`; no row → 404 `invite_invalid`. The response never echoes the code.
- `POST /teams/:teamId/join-requests { skillLevel, inviteCode? }`:
  - `PRIVATE` team: `inviteCode` must be present **and** equal the team's current code, else 404 `not_found` (same body as an unknown team; no existence probe).
  - `PUBLIC` team: `inviteCode` optional; if present and not the current code → 404 `invite_invalid` (stale link, tell the user); if absent → allowed.
  - A join racing a regenerate may succeed with the old code if it read the team before the rotation committed. This is accepted: pending requests are kept on rotation anyway.
- Regenerate: `teams … FOR UPDATE` (not `NO KEY`: the `invite_code` UPDATE needs the key lock, so take it up front instead of upgrading), re-check the actor, `UPDATE teams SET invite_code = $new`, retry on 23505 up to 3 times with a new code, then 500.
- Create: `invite_code` generated server-side, with the same 23505 retry. Request bodies containing `inviteCode` on create are 422 (strict schema).

### Q5: Search

**Chosen**: Option 5A. `ILIKE` substring on `name` or `description`, `PUBLIC` only, ordered by `(lower(name), id)`, keyset in both directions, 20 per page. pg_trgm is the documented upgrade path if public teams exceed ~10⁴ or Find p95 passes 300 ms.

**Rules**:
- Normalise `q`: NFC, trim, collapse internal whitespace to one space, max 100 characters (longer → 422 `validation_failed`); escape `\` → `\\`, then `%` → `\%`, `_` → `\_`; pattern `%<escaped>%`; empty `q` → no text predicate.
- The partial-index predicate must be a **literal** in SQL (`visibility = 'PUBLIC'` via `sql.lit`), never a bind parameter, or generic plans cannot match the partial index. The order expression must be exactly `lower(name)`.
- Cursor: opaque `base64url(JSON {"v":1,"n":<lower(name) as returned by Postgres>,"i":<uuid>,"d":"f"|"b"})`, at most 400 characters, decoded by a strict zod schema. A malformed cursor → 422 `validation_failed`. `n` always comes from the DB (`SELECT lower(name) AS sort_name`), never from JS `toLowerCase`, so the comparison uses the DB collation.
- Forward page: `(lower(name), id) > (n, i) ORDER BY lower(name), id LIMIT 21`. Backward page: `(lower(name), id) < (n, i) ORDER BY lower(name) DESC, id DESC LIMIT 21`, then reverse in TS. The 21st row only signals "more".
- Response `{ teams, nextCursor, prevCursor }`. `prevCursor` is null on the first page (no cursor given, or a backward page that returned ≤ 20 rows).
- `memberCount`: one `LEFT JOIN LATERAL (SELECT count(*) FROM team_members WHERE team_id = t.id AND status = 'APPROVED')` in the same statement (served by `idx_team_members_team_status_role`). `myStatus` for a signed-in caller: one `LEFT JOIN team_members m ON m.team_id = t.id AND m.user_id = $caller`, mapped to `PENDING`/`APPROVED`/`REJECTED`/null, with `BANNED` shown as null on Find. The team page shows the banned state.

### Trade-offs Accepted
- **Eventual seat release after a ban** (seconds normally; up to the retry window when the worker is down). It is acceptable because access and new registrations are blocked synchronously, and the S3 sweep plus the `hook_failed` error log bound the worst case.
- **Two encodings of the transition table** (SQL trigger, TS `transitions.ts`). Mitigated by one shared matrix fixture exercised by the unit test and by the schema integration test.
- **Per-team serialisation of moderation**: two admins acting at once on one team wait milliseconds for each other. Moderation is low-volume.
- **Regenerate briefly blocks FK inserts referencing that team** (join requests, session inserts) because the `invite_code` update takes the key lock. This lasts milliseconds and is rare.
- **No DB guarantee that a freshly inserted team has an admin** (app-enforced at create). Recorded in the ledger. A future account-deletion feature must also handle "deleting the last admin's user fails at COMMIT with `team_members_last_admin`".
- **Invite code in `returnTo`, `oauth_states.return_to` and browser history**. The code is low-power and rotatable, and it is masked in logs.

---

## Implementation Guidelines

### 1. Migration `db/migrations/20261013000100000_team_membership_invariants.sql`

```sql
-- Up Migration
-- team-management: membership invariants (D-40..D-45). Decision record:
-- memory-bank/creative/team-management-membership-architecture.md, docs/adr/0015.

-- D-40: an admin is always an approved member (AC-ERROR-6: banning an admin fails with 23514).
ALTER TABLE team_members
  ADD CONSTRAINT team_members_admin_approved CHECK (role <> 'TEAM_ADMIN' OR status = 'APPROVED');

-- D-41: stamp columns match the status. A BANNED row was APPROVED first, so it keeps approved_*.
ALTER TABLE team_members
  ADD CONSTRAINT team_members_approval_stamps CHECK (
        (status IN ('APPROVED', 'BANNED')) = (approved_at IS NOT NULL)
    AND (status IN ('APPROVED', 'BANNED')) = (approved_by IS NOT NULL)),
  ADD CONSTRAINT team_members_ban_stamps CHECK (
        (status = 'BANNED') = (banned_at IS NOT NULL)
    AND (status = 'BANNED') = (banned_by IS NOT NULL)
    AND (status = 'BANNED' OR ban_reason IS NULL)),
  ADD CONSTRAINT team_members_ban_reason_length CHECK (
    ban_reason IS NULL OR (char_length(ban_reason) BETWEEN 1 AND 500 AND ban_reason = btrim(ban_reason)));

-- D-42: allowed status moves (BANNED is terminal in v1) and immutable ownership keys.
CREATE FUNCTION team_members_guard_update() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.team_id IS DISTINCT FROM OLD.team_id OR NEW.user_id IS DISTINCT FROM OLD.user_id THEN
    RAISE EXCEPTION 'team_members.team_id and user_id are immutable'
      USING ERRCODE = '23000', CONSTRAINT = 'team_members_keys_immutable';
  END IF;
  IF NEW.status IS DISTINCT FROM OLD.status AND NOT (
         (OLD.status = 'PENDING'  AND NEW.status IN ('APPROVED', 'REJECTED'))
      OR (OLD.status = 'REJECTED' AND NEW.status = 'PENDING')
      OR (OLD.status = 'APPROVED' AND NEW.status = 'BANNED')) THEN
    RAISE EXCEPTION 'team_members: % -> % is not an allowed transition', OLD.status, NEW.status
      USING ERRCODE = '23000', CONSTRAINT = 'team_members_status_transition';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER team_members_guard_update
  BEFORE UPDATE OF status, team_id, user_id ON team_members
  FOR EACH ROW EXECUTE FUNCTION team_members_guard_update();

-- D-43: a team keeps at least one approved admin, checked at COMMIT. Locks the team row
-- FOR NO KEY UPDATE (serialises concurrent demotes without blocking FK inserts) and is skipped
-- when the team row is gone (ON DELETE CASCADE). Same pattern as auth_identities_last_method (D-33).
CREATE FUNCTION team_members_enforce_last_admin() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM 1 FROM teams WHERE id = OLD.team_id FOR NO KEY UPDATE;
  IF NOT FOUND THEN
    RETURN NULL;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM team_members
                 WHERE team_id = OLD.team_id AND role = 'TEAM_ADMIN' AND status = 'APPROVED') THEN
    RAISE EXCEPTION 'team % must keep at least one approved admin', OLD.team_id
      USING ERRCODE = '23514', CONSTRAINT = 'team_members_last_admin';
  END IF;
  RETURN NULL;
END $$;
-- Two triggers: a DELETE trigger's WHEN may not reference NEW.
CREATE CONSTRAINT TRIGGER team_members_last_admin_on_update
  AFTER UPDATE OF role, status ON team_members
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
  WHEN (OLD.role = 'TEAM_ADMIN' AND OLD.status = 'APPROVED'
        AND NOT (NEW.role = 'TEAM_ADMIN' AND NEW.status = 'APPROVED'))
  EXECUTE FUNCTION team_members_enforce_last_admin();
CREATE CONSTRAINT TRIGGER team_members_last_admin_on_delete
  AFTER DELETE ON team_members
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
  WHEN (OLD.role = 'TEAM_ADMIN' AND OLD.status = 'APPROVED')
  EXECUTE FUNCTION team_members_enforce_last_admin();

-- D-44: team content and invite-code format (43-char base64url codes; factory codes also match).
ALTER TABLE teams
  ADD CONSTRAINT teams_name_trimmed_length CHECK (char_length(name) BETWEEN 1 AND 100 AND name = btrim(name)),
  ADD CONSTRAINT teams_description_length CHECK (description IS NULL OR char_length(description) BETWEEN 1 AND 1000),
  ADD CONSTRAINT teams_invite_code_format CHECK (invite_code ~ '^[A-Za-z0-9_-]{32,100}$');

-- D-45: Find a team (ordering + keyset) and the admin member lists.
CREATE INDEX idx_teams_public_name ON teams (lower(name), id) WHERE visibility = 'PUBLIC';
CREATE INDEX idx_team_members_team_status_role ON team_members (team_id, status, role);

-- Down Migration
DROP INDEX idx_team_members_team_status_role;
DROP INDEX idx_teams_public_name;
ALTER TABLE teams
  DROP CONSTRAINT teams_invite_code_format,
  DROP CONSTRAINT teams_description_length,
  DROP CONSTRAINT teams_name_trimmed_length;
DROP TRIGGER team_members_last_admin_on_delete ON team_members;
DROP TRIGGER team_members_last_admin_on_update ON team_members;
DROP FUNCTION team_members_enforce_last_admin();
DROP TRIGGER team_members_guard_update ON team_members;
DROP FUNCTION team_members_guard_update();
ALTER TABLE team_members
  DROP CONSTRAINT team_members_ban_reason_length,
  DROP CONSTRAINT team_members_ban_stamps,
  DROP CONSTRAINT team_members_approval_stamps,
  DROP CONSTRAINT team_members_admin_approved;
```

No backfill: no production rows exist and no team code existed before this feature. A dev database with hand-inserted inconsistent rows fails the migration loudly; `pnpm db:reset` fixes it. `types.generated.ts` does not change (no column changes). `idx_teams_visibility` (draft index) is kept.

### 2. Ledger rows for `db/schema-deviations.md`

| ID | Objects | Change | Source |
|---|---|---|---|
| D-40 | `constraint:team_members_admin_approved` | `CHECK (role <> 'TEAM_ADMIN' OR status = 'APPROVED')`: an admin is never `PENDING`, `REJECTED` or `BANNED`, so banning an admin fails with 23514 until they are demoted. | team-management AC-ERROR-6, AC-VERIFY-2; Arch Q3 |
| D-41 | `constraint:team_members_approval_stamps` `constraint:team_members_ban_stamps` `constraint:team_members_ban_reason_length` | `approved_at`/`approved_by` set iff status is `APPROVED` or `BANNED`; `banned_at`/`banned_by` set iff `BANNED`; `ban_reason` only on `BANNED`, trimmed, 1–500 characters. Stamps are written by the service with the injected clock, not by a trigger. | AC-VERIFY-2, AC-HAPPY-8, AC-HAPPY-11; Arch Q3 |
| D-42 | `function:team_members_guard_update` `trigger:team_members_guard_update` | `BEFORE UPDATE OF status, team_id, user_id`: only `PENDING → APPROVED/REJECTED`, `REJECTED → PENDING`, `APPROVED → BANNED` (`BANNED` terminal in v1); `team_id`/`user_id` immutable. Raises 23000 (`team_members_status_transition` / `team_members_keys_immutable`). INSERT status is unconstrained beyond D-40/D-41. | AC-VERIFY-2; Arch Q3; P1 |
| D-43 | `function:team_members_enforce_last_admin` `trigger:team_members_last_admin_on_update` `trigger:team_members_last_admin_on_delete` | Deferred constraint triggers: a COMMIT that leaves a team with no approved admin after an approved admin was demoted, changed status or deleted fails with 23514 `team_members_last_admin`. Locks the team row `FOR NO KEY UPDATE`; skipped when the team row is deleted. Not enforced at team INSERT (the create use case writes team + admin in one transaction). Deleting the last admin's user account also fails at COMMIT (relevant to a future account-deletion feature). | AC-ERROR-7, AC-VERIFY-2; Arch Q3; pattern D-33 |
| D-44 | `constraint:teams_name_trimmed_length` `constraint:teams_description_length` `constraint:teams_invite_code_format` | `name` trimmed, 1–100 characters; `description` NULL or 1–1000 characters; `invite_code ~ '^[A-Za-z0-9_-]{32,100}$'` (URL-safe, ≥ 32 chars). | AC-ERROR-1, AC-VERIFY-2, AC-VERIFY-3; Arch Q4 |
| D-45 | `index:idx_teams_public_name` `index:idx_team_members_team_status_role` | Partial `(lower(name), id) WHERE visibility = 'PUBLIC'` for the Find ordering and keyset; `(team_id, status, role)` for admin lists, member counts and the last-admin check. | AC-VERIFY-2, AC-VERIFY-4; Arch Q5 |

### 3. Moderation transaction shape

Every mutating admin route (approve, reject, promote, demote, ban, regenerate) uses one helper in `service.ts`:

```ts
async function moderate<T>(
  input: { teamId: string; actorId: string; action: ModerationAction },
  work: (trx: Transaction<DB>) => Promise<T>,
): Promise<T> {
  try {
    return await db.transaction().execute(async (trx) => {
      // 1. Per-team mutex. Regenerate takes FOR UPDATE (it will update a key column); others FOR NO KEY UPDATE.
      const team = await repo.lockTeam(trx, input.teamId, input.action === 'regenerate' ? 'update' : 'noKeyUpdate');
      if (team === undefined) throw new AppError('forbidden');            // guard passed but the team vanished
      // 2. Authority re-check under the lock (the guard ran outside the transaction).
      const actor = await repo.findApprovedRole(trx, input.teamId, input.actorId);
      if (actor !== 'TEAM_ADMIN') throw new AppError('forbidden');
      return await work(trx);                                             // 3. target lock + guarded UPDATE (+ enqueue)
    });                                                                    // 4. deferred triggers run at COMMIT
  } catch (error) {
    throw mapMembershipDbError(error);                                    // 5. 23514/23000/23505 -> AppError
  }
}
```

Inside `work` for a target member:
1. `repo.lockTarget(trx, teamId, userId)` = `SELECT id, role, status FROM team_members WHERE team_id = $1 AND user_id = $2 FOR UPDATE`. No row → 404 `not_found`.
2. `transitions.decide(action, target, { actorId })` → error code, or the next `(status, role)` plus the stamps to write.
3. Guarded write, e.g. ban: `UPDATE team_members SET status='BANNED', banned_at=$now, banned_by=$actor, ban_reason=$reason WHERE id=$id AND status='APPROVED' AND role='MEMBER' RETURNING …`. Zero rows → 409 `membership_state_conflict` (defensive; the row lock makes this unreachable in practice).
4. Ban only: `await enqueueMemberBanned(jobs, payload, { trx })`.
5. Demote of the last admin: `transitions.decide` refuses with `last_team_admin` after `repo.countApprovedAdmins(trx, teamId)` (exact under the team lock); the deferred trigger is the backstop.

Join (not a moderation action, no team lock):
`INSERT INTO team_members (team_id, user_id, role, status, skill_level, requested_at) VALUES ($t,$u,'MEMBER','PENDING',$skill,$now) ON CONFLICT ON CONSTRAINT uq_team_members_team_user DO UPDATE SET status='PENDING', skill_level=EXCLUDED.skill_level, requested_at=EXCLUDED.requested_at WHERE team_members.status='REJECTED' RETURNING id, status`. If no row comes back, read the existing status and map it: `PENDING` → 409 `already_requested`, `APPROVED` → 409 `already_member`, `BANNED` → 403 `banned_from_team`. Check visibility and invite code first (reading `teams` without a lock).

Create: one transaction: `INSERT teams` (generated code, 23505 retry) + `INSERT team_members (role 'TEAM_ADMIN', status 'APPROVED', skill_level $chosen, approved_at $now, approved_by $creator)`.

### 4. Error-code mapping

| Situation | Detected by | HTTP | ErrorCode |
|---|---|---|---|
| Caller not approved admin (guard or in-trx re-check) | guard / `moderate` | 403 | `forbidden` |
| Target `(team_id, user_id)` row absent | `lockTarget` | 404 | `not_found` |
| Ban target is an approved `TEAM_ADMIN` | `transitions` / DB 23514 `team_members_admin_approved` | 409 | `team_admin_cannot_be_banned` |
| Demote would leave no approved admin | `transitions` / DB 23514 `team_members_last_admin` at COMMIT | 409 | `last_team_admin` |
| Action does not match the current state (approve a non-`PENDING`, promote an admin, demote a member, ban a `PENDING`, …) | `transitions` / guarded UPDATE 0 rows / DB 23000 `team_members_status_transition` | 409 | `membership_state_conflict` |
| Join: row `PENDING` / `APPROVED` / `BANNED` | upsert returned nothing | 409 / 409 / 403 | `already_requested` / `already_member` / `banned_from_team` |
| Join private team without the valid code; private team detail for a non-member or banned caller | service | 404 | `not_found` |
| Lookup unknown code; join a public team with a stale code | service | 404 | `invite_invalid` |
| Invite code 23505 three times | create/regenerate | 500 | `internal` (existing) |
| Malformed cursor or `q` > 100 chars | zod | 422 | `validation_failed` |

`mapMembershipDbError` switches on the `pg` error's `code` + `constraint`. Any other DB error is rethrown unchanged (500).

### 5. Ban seam code

```ts
// apps/api/src/modules/teams/ban-hook.ts
export const MemberBannedPayload = z.strictObject({
  teamId: z.uuid(), userId: z.uuid(), membershipId: z.uuid(), bannedBy: z.uuid(),
  bannedAt: z.iso.datetime(),            // UTC ISO-8601 with 'Z' (P3); no name, email or ban_reason
});
export type MemberBannedPayload = z.infer<typeof MemberBannedPayload>;

export interface MemberBannedEvent {
  readonly teamId: string; readonly userId: string; readonly membershipId: string;
  readonly bannedBy: string; readonly bannedAt: Date;
}
export interface MemberBannedHookContext {
  readonly logger: Logger; readonly signal: AbortSignal; readonly jobId: string; readonly attempt: number;
}
export interface MemberBannedOutcome { readonly affected: number }
export interface MemberBannedHandler {
  /** Logged as `hook`; e.g. 'noop', 'registrations'. */
  readonly name: string;
  handle(event: MemberBannedEvent, context: MemberBannedHookContext): Promise<MemberBannedOutcome>;
}
export const noopMemberBannedHandler: MemberBannedHandler;            // logs team.member.banned.hook_noop, returns { affected: 0 }
export const memberBannedSingletonKey = (membershipId: string) => `member-banned:${membershipId}`;
/** `trx` is required: the job must commit with the ban (P5). */
export function enqueueMemberBanned(
  jobs: Pick<JobRunner, 'enqueue'>, payload: MemberBannedPayload, options: { trx: TransactionLike },
): Promise<string | null>;
```

- Registry: `QUEUE_NAMES.memberBanned = 'member-banned'`, `{ ...DEFAULTS, name, policy: 'exclusive' }`.
- `apps/api/src/jobs/member-banned.ts`: `createMemberBannedJobHandler({ db, hook }): JobHandler`:
  1. `MemberBannedPayload.safeParse` fails → log `team.member.banned.invalid_payload` (field paths) and throw `NonRetryableJobError`.
  2. `SELECT team_id, user_id, status FROM team_members WHERE id = $membershipId`. No row (team deleted) → log `team.member.banned.stale`, return. Ids differ from the payload, or status ≠ `BANNED` → `NonRetryableJobError` (invariant breach; `BANNED` is terminal).
  3. `const outcome = await hook.handle(event, ctx)` → log `team.member.banned.handled { hook, affected }`.
  4. On error: `final = error instanceof NonRetryableJobError || ctx.retryCount >= ctx.retryLimit`; log `team.member.banned.hook_failed` at `error` if final, else `warn`, with `willRetry: !final`; rethrow (the runner applies retry or terminal state).
- `bootstrap.ts`: `RegisterJobsOptions.memberBannedHandler?: MemberBannedHandler` (default `noopMemberBannedHandler`); `worker.ts` passes nothing today. registration-and-waitlist will pass its implementation there. `app.ts` needs no change for the port (the HTTP process only enqueues through the existing `deps.jobs`).
- Operator re-run (AC-ERROR-12): add `member-banned` to the CLI `jobs trigger` allow-list, validating the JSON with `MemberBannedPayload` before enqueueing with the same `singletonKey`. The handler's re-read makes a hand-typed payload safe.

### 6. Gate code

```ts
// apps/api/src/modules/teams/membership.ts
export interface ApprovedMembership {
  readonly membershipId: string; readonly role: TeamRole; readonly skillLevel: SkillTier;
}
/**
 * Contract for registration-and-waitlist and auto-enrol (ADR 0015): call inside your transaction, before any
 * game_sessions lock. Holds the team_members row FOR SHARE until COMMIT, so it serialises with a ban.
 */
export async function assertApprovedMember(
  trx: Transaction<DB>, teamId: string, userId: string,
): Promise<ApprovedMembership> {
  if (!trx.isTransaction) throw new Error('assertApprovedMember must run inside a transaction');
  const row = await trx.selectFrom('team_members')
    .select(['id', 'role', 'status', 'skill_level'])
    .where('team_id', '=', teamId).where('user_id', '=', userId)
    .forShare().executeTakeFirst();
  if (row === undefined || row.status !== 'APPROVED') throw new AppError('forbidden');
  return { membershipId: row.id, role: row.role, skillLevel: row.skill_level };
}
```
No status predicate in the WHERE: the row is locked whatever its state, and the status is read from the version returned after any wait. It returns `skillLevel` because `BY_SKILL_LEVEL` pricing will need it in the same transaction.

### 7. Admin member list (`GET /teams/:teamId/members?status=&after=`)
- Page size 50; keyset cursor in the same opaque, versioned format as Find.
- Order: `PENDING` oldest first `(requested_at, user_id)`; `APPROVED` admins first, then by name `(role_rank, lower(u.full_name), user_id)`; `BANNED` newest first `(banned_at DESC, user_id)`. Presentation may differ (UI/UX doc); these are the API orders.
- Columns: `userId, fullName, role, status, skillLevel, requestedAt, approvedAt, bannedAt, banReason` (no email). `banReason` only in the `BANNED` list.

### 8. Tests that prove the decisions (in addition to the spec's list)
- One shared transition matrix fixture (`apps/api/test/fixtures/membership-transitions.ts`), exported as data, consumed by `transitions.test.ts` (TS) and `teams-schema.int.test.ts` (raw SQL), so SQL and TS cannot drift.
- Last-admin race: a dedicated clone with a pool of at least 21 connections (`_learned/testing-integration-db-isolation`). Two admins demote each other, synchronised with a barrier after both transactions hold their target row lock (not a sleep); exactly one commits. A 20-way variant has 20 admins each demoting themselves: exactly 19 commit. A raw-SQL variant skips the app lock and proves the deferred trigger alone refuses (`SET CONSTRAINTS ALL IMMEDIATE` for the in-transaction assertion).
- Gate race (AC-INTEGRATION-1): connection A runs `assertApprovedMember` (holds `FOR SHARE`) and inserts a fixture registration. Connection B starts the ban and blocks (assert via `pg_locks` / `pg_stat_activity.wait_event_type = 'Lock'`, not a timer). A commits, then B commits, and the handler sees A's registration. In the reverse order, B's ban commits first, and A's gate throws `forbidden`.
- Find index test: seed about 500 public and private teams, `ANALYZE teams`, `SET LOCAL enable_seqscan = off`, and assert that `EXPLAIN` of the exact repo SQL names `idx_teams_public_name`. This proves the index matches the query; at small sizes the planner may legitimately prefer a seq scan without the setting.
- Handler tests use the real runner and worker with a recording `MemberBannedHandler` passed through `registerJobs({ memberBannedHandler })`. A throws-once handler proves the retry. A `NonRetryableJobError` handler proves the terminal state plus the `hook_failed` error log. Replaying a completed job proves the redelivery is harmless.

---

## Validation Checklist

- [x] Meets all system requirements: access revoked and registrations blocked at commit; cancellation via the durable job; last-admin, admin-not-banned and terminal-ban rules enforced by the DB; invite rotation; search semantics.
- [x] Respects technical constraints: reuses the existing tables, job runner, guards, `safeReturnTo` and logger; no new service or env var.
- [x] Addresses non-functional requirements: security (guard + in-trx re-check, IDOR-safe lookups, no leaks), privacy (ids-only payloads and logs), performance (indexes, single-statement Find).
- [x] Technically feasible: every SQL construct is in use already (deferred constraint triggers with WHEN, `FOR NO KEY UPDATE`, partial indexes, `RAISE … USING CONSTRAINT`).
- [x] Risks identified and acceptable (below).
- [x] Complies with Guiding Principles: P1 (D-40..D-45), P3 (UTC stamps from the injected clock; `bannedAt` is ISO UTC), P5 (job enqueued in the ban's transaction), P7 (no new config). No deviation from P2/P4/P6. No principle is overridden.
- [x] Respects established patterns: `modules/<feature>/{routes,service,repo}`, adapter-behind-interface (the `MemberBannedHandler` port follows the `Notifier` style), D-33 deferred-trigger pattern, ledgered SQL, exclusive queue + `singletonKey` + durable idempotency guard.
- [x] Observability architecture defined (events, redaction, spans, reserved metrics).
- [x] Trace context propagation across all boundaries (HTTP `traceparent`, job `_meta.traceparent`, consumer span).
- [x] Logging strategy consistent with observability-requirements.md (structured JSON, trace ids, no PII, configurable levels).
- [x] Metrics strategy follows naming conventions (`sgm_` prefix, `_total` / `_seconds`, low-cardinality labels; reserved until an exporter exists).

## Risk Assessment

| Risk | Likelihood | Impact | Mitigation |
|------|------------|--------|------------|
| registration-and-waitlist ignores the gate or calls it after the session lock | M | H | ADR 0015 contract; the gate returns `skillLevel` they need anyway; the AC-INTEGRATION-1 contract test file is named as the test their handler and registration path must pass; their plan must cite ADR 0015. |
| Deploy window: registration API live before the real handler, so a ban during it is handled by the no-op | L | M | S3 reconciliation sweep ships with registration-and-waitlist (required by ADR 0015). |
| `member-banned` job permanently fails, so the banned player keeps a seat | L | M | `team.member.banned.hook_failed` error log (alertable); CLI `jobs trigger member-banned`; S3 sweep. |
| Deadlock between demotes, or between the deferred trigger and the app lock | L | M | App always locks `teams` first; the trigger re-locks the same row (no-op when held); 20-way race test. |
| SQL trigger and TS transition table drift | M | M | Shared matrix fixture run against both. |
| Partial index unused because the predicate is parameterised | M | L | Literal predicate rule plus the `EXPLAIN` test. |
| Invite code captured from `oauth_states.return_to` or browser history | L | L | The code only allows asking to join; admin approval required; rotation; `auth-cleanup` purges expired state; log masking of `returnTo`. |
| Existing tests break on the new CHECKs (`insertTeamMember` defaults to `APPROVED` with no stamps) | H | L | Phase 1 updates the factory to stamp `approved_*` (and `banned_*` for `BANNED`), defaulting `approved_by`/`banned_by` to an explicit `actorId` input or the member's own id. |

## Spec amendments

These change or clarify the approved spec. The task file is not edited here; `/yay:creative` applies them.

- **A1 File names (AC-ASYNC-2/3 vs New Source Files)**: use the AC names. `apps/api/src/modules/teams/ban-hook.ts` (port, payload, no-op, enqueue helper) and `apps/api/src/modules/teams/membership.ts` (gate); the job handler is `apps/api/src/jobs/member-banned.ts`. Replace `member-banned.ts` and `approved-member.ts` under `modules/teams` in New Source Files, and rename `member-banned.test.ts` to `ban-hook.test.ts` (plus `apps/api/src/jobs/member-banned.test.ts` for the job handler).
- **A2 Handler wiring**: the port is injected only in `apps/api/src/jobs/bootstrap.ts` (`RegisterJobsOptions.memberBannedHandler`, default no-op) and `worker.ts`; `apps/api/src/app.ts` only registers the teams module. Drop "inject the handler port" from the `app.ts` line.
- **A3 AC-VERIFY-2 invariant list**: (a) `approved_at`/`approved_by` are required for `APPROVED` **and `BANNED`** and must be NULL for `PENDING`/`REJECTED`; (b) `ban_reason` is NULL unless `BANNED`, trimmed, 1–500 chars; (c) the transition trigger also makes `team_id`/`user_id` immutable (23000); (d) the last-admin rule is two deferred constraint triggers (UPDATE and DELETE); (e) `teams.name` is trimmed and 1–100 chars, `description` NULL or 1–1000; (f) the ledger rows are D-40..D-45 as listed above; (g) there is no DB rule that a new team has an admin (documented in D-43).
- **A4 AC-ASYNC-2 contract wording**: replace "cancel without a late-withdrawal fee" with the normative handler contract above. It covers registrations `CONFIRMED`/`WAITLISTED` in the team's `PUBLISHED` sessions with `starts_at` after the handler's now, one session per transaction under the D-14 lock, `WITHDRAWN` with early-withdrawal semantics regardless of deadline (no fee, no payment row), normal FIFO promotion, no notification to the banned player, and `NonRetryableJobError` for permanent failures. Add: "registration-and-waitlist ships a reconciliation sweep that re-enqueues `member-banned` for `BANNED` memberships with active registrations" (ADR 0015).
- **A5 AC-ASYNC-1 payload**: `bannedAt` is an ISO-8601 UTC string; the handler re-reads the membership by `membershipId`, completes as a no-op when the row is gone, and fails non-retryably on a mismatch.
- **A6 AC-ASYNC-3 gate**: signature `assertApprovedMember(trx: Transaction<DB>, teamId, userId): Promise<{ membershipId, role, skillLevel }>`; throws a programming `Error` outside a transaction; must be called before any `game_sessions` lock; assumes READ COMMITTED.
- **A7 AC-VERIFY-3 redaction**: in addition to the `inviteCode`/`invite_code` key pattern (`/^invite_?code$/i`), add `returnTo` to the exact query-name mask list so a logged `/login?returnTo=…code…` URL never shows the code. The log-capture test covers the sign-in redirect URL.
- **A8 Find API (Invocation Method, AC-HAPPY-3, AC-VERIFY-4)**: the response is `{ teams, nextCursor, prevCursor }` (the spec's UI already has "Previous"); the cursor is opaque and bidirectional, and a malformed cursor or `q` over 100 characters → 422 `validation_failed`. AC-VERIFY-4's plan assertion runs with `enable_seqscan = off` after `ANALYZE`, and the partial-index predicate is a SQL literal.
- **A9 Join with an invite code (AC-HAPPY-5, AC-ERROR-3)**: on a `PUBLIC` team, a present-but-stale `inviteCode` → 404 `invite_invalid`; an absent one is fine. On a `PRIVATE` team, a missing or wrong code → 404 `not_found` (unchanged). A join that races a regenerate may succeed with the old code (accepted).
- **A10 Authority re-check (AC-ERROR-8/9)**: every moderation mutation and regenerate re-checks the actor's approved `TEAM_ADMIN` row under the team-row lock. An admin demoted between the guard and the transaction gets 403 `forbidden` and nothing changes. Add one Phase 3 test.
- **A11 Event names (Observability Requirements section vs AC-VERIFY-5)**: use the AC-VERIFY-5 dotted names throughout (`team.join.requested`, `team.member.approved|rejected|promoted|demoted|banned`, `team.invite.regenerated`, `team.action.refused`), plus the worker events `team.member.banned.hook_noop`, `.handled`, `.hook_failed`, `.invalid_payload`, `.stale`. Delete the underscore variants (`team.join_requested`, `team.member_banned_handled`, …).
- **A12 Operator re-run (AC-ERROR-12)**: `cli jobs trigger member-banned '<json>'` is the supported re-run path (payload validated by `MemberBannedPayload`). Extend `apps/api/src/cli.ts` (+ its test) in Phase 3.
- **A13 Member list order and page size (Invocation Method)**: page size 50; orders as in Implementation Guideline 7.

## Next Steps

1. `/yay:creative` applies Spec amendments A1–A13 to `memory-bank/tasks/team-management.md` and marks the Architecture creative phase complete.
2. **Phase 1**: migration (section 1), ledger D-40..D-45 (section 2), shared transition-matrix fixture, factory stamping, 7 error codes, `inviteCode` + `returnTo` redaction, zod contracts including the Find cursor and `prevCursor`.
3. **Phase 2**: invite-code generator with 23505 retry, create, Find (section Q5 rules), mine, detail, lookup, join upsert, regenerate under `FOR UPDATE`.
4. **Phase 3**: `moderate()` helper and `mapMembershipDbError`, transitions, member lists, ban + `enqueueMemberBanned`, `member-banned` queue and job handler, `bootstrap` port option, gate, CLI trigger, race tests, and `docs/adr/0015-team-membership-and-ban-seam.md` (contract text copied from the Decision section).
5. Hand-off: registration-and-waitlist's `/yay:plan` must read ADR 0015 and include the reconciliation sweep, the gate call before the D-14 lock, and its own handler passing `teams-ban-seam.int.test.ts`.
