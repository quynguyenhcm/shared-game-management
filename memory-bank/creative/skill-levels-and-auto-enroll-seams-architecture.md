# Architecture Decision: Skill Levels Module, Cross-Feature Seams and the Progression Job

**Created**: 2026-10-17
**Status**: DECIDED
**Decision Type**: Architecture
**Task**: `skill-levels-and-auto-enroll` (Level 3). Spec: `memory-bank/tasks/skill-levels-and-auto-enroll.md` on `feature/skill-levels-and-auto-enroll` (approved 2026-10-17, creative flagged).
**Resolves**: Creative Q4 (cross-feature contracts C-GAME-1 and C-SKL-1, the selection seam, ADR 0017 content) and Q7 (player visibility), plus the module boundary, the `TeamMemberRow` seam, the ban path and the `skill-progression` job.
**Not decided here**: Q1 to Q3 and Q6 (counting edges, override precedence, surplus games, constants) belong to the algorithm doc being written in parallel; Q5 (row layout) belongs to the UI/UX doc. Where this design depends on an algorithm choice, the dependency is stated in [Algorithm Dependencies](#algorithm-dependencies).
**Basis**: `main` at `9321205` (platform-foundation, auth-and-user-roles, team-management, team-banking-and-gst merged). Principles P1 to P7 (`memory-bank/systemPatterns.md`). Binding prior decisions: ADR 0004 (pg-boss), ADR 0012 (fee snapshot), ADR 0015 (ban seam, gate, canonical lock order, moderation transaction shape), ADR 0016 (team-row lock modes, `teams FOR UPDATE` leaf rule). In flight: `origin/feature/registration-and-waitlist` creative `registration-and-waitlist-allocator-architecture.md` (Q6: `createAllocator`, `autoEnrolInSession`, C-SAE-1/2, C-BIL-1..3, C-ALL-1) and `registration-and-waitlist-allocation-algorithm.md` (hand-off rule 7). Code read: `modules/teams/{admin-lock,membership,repo,service}.ts`, `jobs/{registry,schedules,bootstrap,auth-cleanup}.ts`, `lib/jobs/jobs.ts`, `app.ts`, `cli.ts`, `test/helpers/lock-waiters.ts`, migrations `20260929000400000`, `20260929000600000`, `20260929000700000`, `20261013000100000`, `packages/shared/src/api/teams.ts`.

---

## Context

### System Requirements
- Admin override of a member's skill level (records who and when) and Auto Enroll on/off with an optional end date, via two `PUT` routes guarded by `requireTeamRole('TEAM_ADMIN')`, using the moderation transaction shape (AC-HAPPY-1..3, 7..10, AC-ERROR-1..5).
- A daily `skill-progression` job that promotes a member one level once they have 40 qualifying games in the trailing 365 days since their last level change. It is idempotent under redelivery and concurrent runs, and it isolates per-member failures (AC-HAPPY-4..6, AC-ASYNC-1/2, AC-ERROR-7).
- Two read seams that later features consume: `countQualifyingGames` (also feeds the members-list progress line) and `selectAutoEnrollees` (session-scheduling-engine's materialiser) (AC-VERIFY-3, AC-INTEGRATION-1, AC-ASYNC-3).
- `TeamMemberRow` gains additive fields (`skillOverride`, `skillChangedAt`, `autoEnroll`, `skillProgress`) without changing any existing field (AC-VERIFY-7).
- A ban clears Auto Enroll in the same `UPDATE` (AC-ERROR-5).
- An ADR (0017) records C-GAME-1, C-SKL-1 and the pricing-timing rule, and a contract test pins the seam (AC-INTEGRATION-3).

### Technical Constraints
- The columns already exist on `team_members` (`skill_level`, `skill_level_override_by/at`, `is_auto_enroll`, `auto_enroll_until date`, `auto_enroll_assigned_at`). Only `skill_level_changed_at` is new.
- `registrations` and `game_sessions` exist but no application code writes them on `main`. The allocator (`registration-and-waitlist`) and the materialiser (`session-scheduling-engine`) are not merged. This feature cannot call either, and must prove its seams against factory-seeded rows.
- Canonical lock order (ADR 0015): `teams`, `team_members`, `game_sessions`, `registrations`, `registration_guests`, payments. Moderation shape: team row `FOR NO KEY UPDATE`, then the actor re-check, then the target row lock.
- `teams` module public surface: `admin-lock.ts` (`lockTeamRow`, `assertTeamAdminUnderLock`, `findApprovedRole`) and `membership.ts` (`assertApprovedMember`). Other modules never import `teams/repo.ts`.
- Jobs: queue in `jobs/registry.ts`, cron slot in `schedules.ts` (DST guard: nothing between 02:00 and 02:59 Pacific/Auckland), handler wired in `bootstrap.ts`. `cli jobs trigger <slot>` already accepts every `SCHEDULES` name.
- Metrics: config variables exist (`METRICS_ENABLED` etc.) but no exporter is implemented (techContext). Tracing: each job already runs inside a `"{queue} process"` consumer span with `traceId`/`spanId` on every log line.

### Non-Functional Requirements
- P1: every invariant is a CHECK. The TypeScript decision tables only shape errors.
- P3: instants are UTC `timestamptz`. `auto_enroll_until` and `sessionDate` are Pacific/Auckland calendar dates. "Today" comes from the injected clock, converted at the boundary.
- P5: progression runs only through the job queue, never in an HTTP request.
- P7: no new environment variables. The 40/365 thresholds are product rules, not deployment config (algorithm Q6).
- Performance: the members list computes at most 50 counts per page. The sweep visits approved, non-`ADVANCED` members in keyset batches of 500.
- Privacy (NZ Privacy Act 2020): the override actor's name is shown to team admins only. Logs and job payloads carry ids, levels, counts and booleans only.

---

## Component Analysis

### Core Components

| Component | Purpose | Responsibilities |
|-----------|---------|------------------|
| `modules/skill-levels/games.ts` (**leaf**) | The single definition of a qualifying game | `qualifyingGamesCount(...)` SQL fragment (correlated count); `countQualifyingGames(db, { teamId, userId, now })`. Lock-free reads only |
| `modules/skill-levels/auto-enrol.ts` (**leaf**, new file) | C-SKL-1 selection seam | `selectAutoEnrollees(db, { teamId, sessionDate })`. A plain `SELECT` in contract order, no locks |
| `modules/skill-levels/decisions.ts` (new file, pure) | Shape outcomes before writing | `decideOverride(current, requested)` (no-op on the same level), `decideAutoEnrolChange(current, input, todayNz)` (off→on, on→on, on→off, off→off) |
| `modules/skill-levels/repo.ts` | Writes | `lockMemberRow(trx, teamId, userId)` and `lockMemberById(trx, id)` (`FOR NO KEY UPDATE`); guarded override, Auto Enroll and progression `UPDATE`s; keyset candidate query |
| `modules/skill-levels/service.ts` | HTTP use cases | Override and Auto Enroll transactions in the moderation shape; refusal logging through `lib/auth/team-refusals.ts` |
| `modules/skill-levels/progression.ts` (new file) | Job-side domain | `sweepCandidates` (keyset + pre-count) and `progressMember` (lock → re-read → recount → decide → guarded `UPDATE`) |
| `modules/skill-levels/routes.ts`, `errors.ts` | HTTP surface | Two `PUT` routes, strict zod bodies, error mapping |
| `jobs/skill-progression.ts` | Job handler | Runs the sweep, isolates per-member failures, logs the summary, fails the run when `failed > 0` |
| `modules/teams/member-read.ts` (new **public** teams file) | One `TeamMemberRow` mapper for every endpoint | Moves `getMemberRow`/`toMemberRow` out of `repo.ts`. Selects the new columns, `LEFT JOIN users` for the override actor's name, embeds `qualifyingGamesCount` for APPROVED rows below `ADVANCED` |
| `modules/teams/repo.ts` (changed) | Ban path | `applyMembershipChange('ban')` also sets `is_auto_enroll = false, auto_enroll_until = NULL, auto_enroll_assigned_at = NULL`. `listMembers` uses `member-read.ts`'s column list and mapper |
| `packages/shared/src/skill/` | Rules shared by web and API | `SKILL_PROGRESSION_GAMES`, `SKILL_PROGRESSION_WINDOW_DAYS`, `decideProgression`, `nextSkillLevel`, `toSkillProgress(level, games)`, `deriveSkillProvenance(row)` |
| `docs/adr/0017-skill-levels-and-auto-enroll.md` | Contract record | C-GAME-1, C-SKL-1, the progression contract, the pricing-timing rule (content below) |

### Component Interactions

```
                      apps/web Server Action (bearer)
                                 |
                                 v
  PUT /teams/:teamId/members/:userId/{skill-level|auto-enroll}   requireTeamRole('TEAM_ADMIN')
                                 |
                    skill-levels/service.ts  -- one transaction --------------------------+
                      1. teams/admin-lock.assertTeamAdminUnderLock(trx, team, actor,       |
                         'noKeyUpdate')            teams FOR NO KEY UPDATE + re-check      |
                      2. skill-levels/repo.lockMemberRow   team_members FOR NO KEY UPDATE  |
                      3. decisions.decide*  ->  guarded UPDATE                             |
                      4. teams/member-read.getMemberRow(trx)  (count via games fragment)   |
                                 +---------------------------------------------------------+
                                 v
                              { member }  + log team.member.skill_overridden / auto_enroll_changed

  GET /teams/:teamId/members (teams module, unchanged route)
      teams/service -> teams/repo.listMembers -> teams/member-read (columns + mapper)
                                                    \-> skill-levels/games.qualifyingGamesCount (leaf)

  worker: cron 30 5 * * * Pacific/Auckland | cli jobs trigger skill-progression
      jobs/skill-progression.ts
         -> skill-levels/progression.sweepCandidates (keyset 500, pre-count, no locks)
         -> per candidate with games >= 40, own transaction:
              progressMember: team_members FOR NO KEY UPDATE (by id)  [never teams]
                              re-read level, baseline, status -> recount -> decideProgression
                              -> guarded UPDATE -> log team.member.skill_progressed
         -> log skill.progression.completed { scanned, promoted, failed, durationMs }

  Future consumers (not built here):
      registration-and-waitlist allocator --> teams/membership.assertApprovedMember (FOR SHARE, returns skillLevel)
      session-scheduling-engine materialiser --> skill-levels/auto-enrol.selectAutoEnrollees (no locks)
                                             --> allocator.autoEnrolInSession(ctx, { teamId, sessionId, userIds })
      wallet-and-akahu-billing --> (reads team_members.skill_level via listBillableRegistrations)
```

**Import graph (files, not modules; must stay acyclic):**
- `skill-levels/games.ts` and `skill-levels/auto-enrol.ts` import only `lib/db/*`, `kysely` and `@sgm/shared`. They are leaves.
- `teams/member-read.ts` imports `skill-levels/games.ts` (leaf) and `@sgm/shared`.
- `skill-levels/{service,progression,repo}.ts` import `teams/admin-lock.ts`, `teams/member-read.ts`, `lib/auth/team-refusals.ts`, and their own leaves.
- Nothing outside `teams/` imports `teams/repo.ts`, and nothing outside `skill-levels/` imports `skill-levels/repo.ts`, `service.ts` or `progression.ts` (except `jobs/skill-progression.ts` → `progression.ts`).
- A structural unit test (`apps/api/src/modules/skill-levels/boundaries.test.ts`) reads the import lines of the two leaves and of `teams/member-read.ts` and fails on any import from `modules/**` other than the allowed edges.

---

## Options Explored

The decision has five parts that interact: where the code lives, how `TeamMemberRow` gets its fields, the shape of the C-SKL-1 seam, the progression job, and Q7. Three coherent end-to-end architectures are compared first. The sub-decisions that follow resolve the choices within the chosen one.

### Option 1: New `skill-levels` module, leaf read seams, daily lock-and-recount sweep (spec default, refined)
- **Description**: A fourth `modules/<feature>` slice, registered in `buildApp` under the `/teams` prefix (the `team-banking` precedent). The two read seams are leaf files with no module imports, so `teams` can embed the counting fragment in its member read model without a cycle. `teams` keeps ownership of `team_members` writes on its own paths (the ban) and of the `TeamMemberRow` shape. `skill-levels` owns the override, Auto Enroll and progression writes. Progression is a daily sweep: an unlocked pre-count picks candidates, then each candidate gets its own transaction that locks only its member row, re-reads, recounts, decides and does a guarded `UPDATE`.
- **Architecture Diagram**: see [Component Interactions](#component-interactions).
- **Pros**:
  - Matches `systemPatterns.md` § Module Structure and the team-banking precedent. Coverage gate entry `apps/api/src/modules/skill-levels/**` is clean.
  - The seams the materialiser and the members list need are small, lock-free and testable on real rows today.
  - The job never touches `teams`, so it cannot deadlock with moderation (which goes `teams` → `team_members`).
  - One SQL definition of "qualifying game" serves the job and the list (AC-VERIFY-3, AC-HAPPY-11).
- **Cons**:
  - A module-level two-way dependency (`teams/member-read.ts` → `skill-levels/games.ts`, `skill-levels/*` → `teams/admin-lock.ts`). A structural test is needed to keep it file-acyclic.
  - Promotion lags game completion by up to a day (accepted in open question (c)).
- **Technical Fit**: High
- **Complexity**: Medium
- **Scalability**: High (bounded by the candidate count. Per-member transactions run only for members at or above 40 pre-counted games)

### Option 2: Extend the `teams` module
- **Description**: The two routes go into `teams/routes.ts`. Override, Auto Enroll and progression go into `teams/service.ts` and `teams/repo.ts`. Counting and selection go into a new `teams/games.ts`. The job imports `teams`.
- **Pros**:
  - No cross-module imports. `TeamMemberRow` and its mapper sit next to the queries.
  - Reuses `repo.lockTarget` and `runModeration` directly.
- **Cons**:
  - `teams/service.ts` (456 lines) and `repo.ts` (621 lines) grow by roughly 40%. They would mix the membership state machine with the progression domain and the scheduler's selection seam.
  - The materialiser and billing would import `teams` for game and auto-enrol concepts. That blurs which feature owns C-GAME-1 and C-SKL-1.
  - Diverges from the explicit "new module + public helpers" direction ADR 0016 set with `admin-lock.ts`.
- **Technical Fit**: Medium
- **Complexity**: Low
- **Scalability**: High (same SQL)

### Option 3: Event-driven progression and a skill-levels-owned auto-enrol orchestrator
- **Description**: `skill-levels` exports `onSessionCompleted(trx, sessionId)`. Billing would call it in the transaction that moves a session to `COMPLETED`, and it enqueues one `skill-progression-member` job per confirmed registrant (P5). `skill-levels` also exports `autoEnrolSession(ctx, allocator, { teamId, sessionId, sessionDate })`, which selects and calls `allocator.autoEnrolInSession`, so ordering and refusal logging live in one place. A daily sweep remains as reconciliation.
- **Pros**:
  - Promotion within seconds of billing. The materialiser cannot pass the wrong order.
  - Completeness argument: a member's count can only rise when a session they confirmed becomes `COMPLETED`. Window expiry and baseline resets only lower it. So a hook on `COMPLETED` catches every promotion opportunity.
- **Cons**:
  - Both entry points have no caller until wallet-and-akahu-billing and session-scheduling-engine ship. Today they would be dead code plus a third contract (a new C-BIL hook) on an unplanned feature.
  - Calls the allocator, which the approved scope excludes ("This feature does not call the allocator"). It would also need the allocator's `AllocatorContext` type from an unmerged branch.
  - The sweep is still needed for missed hooks, so this is strictly more code than Option 1.
- **Technical Fit**: Low (couples to two unbuilt features)
- **Complexity**: High
- **Scalability**: High

---

## Sub-decisions within Option 1

### D1: Where the `TeamMemberRow` skill fields are computed

| Option | Description | Verdict |
|---|---|---|
| **D1a: teams owns the mapper, embeds the leaf count fragment** | Move `getMemberRow`/`toMemberRow` and the member column list to public `teams/member-read.ts`. Select the four raw columns plus `LEFT JOIN users o ON o.id = m.skill_level_override_by` for `byName`. For APPROVED rows below `ADVANCED`, add a correlated subquery from `skill-levels/games.qualifyingGamesCount`. Every endpoint returning `TeamMemberRow` (list, moderation, the two new PUTs) uses the one mapper | **Chosen.** One mapper, one SQL query per page, no N+1. The response schema can require the fields on every row |
| D1b: injected enricher port (like `MemberBannedHandler`) | `createTeamsService({ ..., memberEnricher })` and `skill-levels` supplies it in `buildApp` | Rejected. The fields are required by the response schema, so a composition without the port (tests, a future entrypoint) would emit invalid rows or need defaults that lie. A port is right for a side effect (ban) and wrong for part of a read model |
| D1c: separate `GET /teams/:id/members/skill` merged by the web | skill-levels owns its own list | Rejected. Contradicts the approved additive-fields API. It doubles the round trips and needs two cursors to agree |

**Field semantics (normative; amends the spec's field list):**
- `skillOverride: { byName: string; at: string } | null`: from `skill_level_override_by/at`. Null when never overridden. The CHECK pairs the two columns.
- `skillChangedAt: string | null`: `skill_level_changed_at`. Null means the level is still the self-assessed one.
- `autoEnroll: { enabled: boolean; until: LocalDate | null; assignedAt: string | null }`: present on every row. Always `{ false, null, null }` for non-APPROVED rows (enforced by CHECK).
- `skillProgress: { games: number; required: number; nextLevel: SkillTier } | null`: computed for APPROVED rows below `ADVANCED`. **Null for `ADVANCED` ("Highest level") and for every non-APPROVED row.** `toSkillProgress(level, games)` in `packages/shared` builds it, so web and API agree.
- Provenance ("Self-assessed" / "Set by X" / "Moved up automatically") is **derived, not stored**: `deriveSkillProvenance({ skillOverride, skillChangedAt })` in `packages/shared/src/skill/`. `SELF` when `skillChangedAt` is null, `ADMIN` when `skillChangedAt == skillOverride.at`, `AUTO` otherwise. This is exact because an override writes both columns from the same `now`, and the CHECK `skill_level_changed_at >= skill_level_override_at` rules out the other order.

### D2: Module registration and the member-row lock

- `buildApp` registers `skillLevelsRoutes` with `prefix: '/teams'` and `service: createSkillLevelsService({ db, clock })`. No `jobs` dependency is needed in v1 (no enqueue). Paths: `/:teamId/members/:userId/skill-level` and `/:teamId/members/:userId/auto-enroll`.
- **Transaction shape for both PUTs** (AC-ERROR-4, AC-VERIFY-5):
  1. `SET LOCAL lock_timeout = '2s'` (the HTTP value used by registration-and-waitlist).
  2. `assertTeamAdminUnderLock(trx, teamId, actorId, 'noKeyUpdate')`: team row `FOR NO KEY UPDATE`, then the actor re-check (403 on failure).
  3. `lockMemberRow(trx, teamId, userId)`: `SELECT id, status, skill_level, skill_level_changed_at, is_auto_enroll, auto_enroll_until, auto_enroll_assigned_at FROM team_members WHERE team_id = $1 AND user_id = $2 FOR NO KEY UPDATE`. A missing row gives 404 `not_found`. A non-APPROVED row gives 409 `membership_state_conflict`.
  4. Pure decision. A no-op returns the current row with no write and no event.
  5. Guarded `UPDATE ... WHERE id = $id AND status = 'APPROVED'`. Zero rows (unreachable under the lock) gives 409.
  6. `getMemberRow(trx, teamId, userId)` from `teams/member-read.ts`.
- **Why `FOR NO KEY UPDATE` and not moderation's `FOR UPDATE`**: these writes never change a key column, and `NO KEY UPDATE` is the weakest mode that still conflicts with the ban's row lock, a second override, the job and `assertApprovedMember`'s `FOR SHARE`. It does not block foreign-key `KEY SHARE` lockers, of which there are none on `team_members` today. Moderation keeps `repo.lockTarget` (`FOR UPDATE`) unchanged.
- **Ban vs Auto Enroll toggle (AC-ERROR-5)** is serialised by the **team row**, because both take `teams FOR NO KEY UPDATE` first. If the ban commits first, the toggle reads `BANNED` under its own locks and answers 409. If the toggle commits first, the ban's single `UPDATE` clears the flag. The CHECK `team_members_auto_enroll_approved_only` makes a ban that forgets to clear the flag fail with 23514, so the ban path cannot regress silently (P1).
- **Ban path implementation choice**: set the three columns explicitly in `applyMembershipChange('ban')`, not in a `BEFORE UPDATE` trigger. Explicit code is visible in review and keeps the existing trigger focused on transitions. The CHECK is the backstop. `teams-ban-seam.int.test.ts` gains one assertion (the flag is cleared in the ban's statement).

### D3: The C-SKL-1 selection seam

| Option | Description | Verdict |
|---|---|---|
| **D3a: lock-free typed function in a leaf file** | `selectAutoEnrollees(db, { teamId, sessionDate })` returns rows in contract order. The allocator's gate stays authoritative | **Chosen** |
| D3b: SQL view `auto_enroll_candidates` | The DB owns the predicate, and the materialiser selects from it | Rejected. A view cannot guarantee order, so the TS wrapper is still needed. It adds a schema object and a ledger entry for no extra guarantee |
| D3c: selection with `FOR SHARE` on member rows | Closes the race in which Auto Enroll is turned off between selection and allocation | Rejected. The materialiser may already hold the session row (see the lock note below). A `FOR SHARE` here would duplicate the allocator's gate, and the race is benign (below) |
| D3d: skill-levels owns `autoEnrolSession(ctx, allocator, ...)` | Wraps select + allocate | Rejected for v1 (Option 3's cons: out of scope, needs unmerged types). It can be added later without changing D3a |

**Normative signature (pinned by the contract test):**

```ts
// apps/api/src/modules/skill-levels/auto-enrol.ts  (leaf: imports lib/db, kysely, @sgm/shared only)
import type { Kysely } from 'kysely';
import type { LocalDate } from '@sgm/shared';
import type { DB } from '../../lib/db/types.generated.ts';

export interface AutoEnrollee {
  readonly userId: string;        // what allocator.autoEnrolInSession takes, in this order
  readonly membershipId: string;  // for the caller's logs; never needed for the allocator call
  readonly assignedAt: Date;      // auto_enroll_assigned_at (UTC); the order key
}

/**
 * C-SKL-1 (ADR 0017). A plain SELECT that takes NO row locks, so the caller keeps the canonical order
 * teams -> team_members -> game_sessions. `db` may be the pool handle or the caller's transaction (Kysely
 * Transaction extends Kysely). `sessionDate` is the session's Pacific/Auckland calendar date
 * (`game_sessions.date`), never derived from `starts_at`.
 */
export function selectAutoEnrollees(
  db: Kysely<DB>,
  input: { readonly teamId: string; readonly sessionDate: LocalDate },
): Promise<readonly AutoEnrollee[]>;
```

```sql
SELECT m.user_id, m.id, m.auto_enroll_assigned_at
  FROM team_members m
 WHERE m.team_id = $teamId
   AND m.status = 'APPROVED'               -- redundant with the CHECK; kept as defence in depth
   AND m.is_auto_enroll
   AND (m.auto_enroll_until IS NULL OR m.auto_enroll_until >= $sessionDate::date)
 ORDER BY m.auto_enroll_assigned_at ASC, m.id ASC
```

- **Until-date semantics**: inclusive. A member with `until = 2026-11-30` is selected for a session whose `date` is 30 Nov and not for 1 Dec (AC-ASYNC-3). The flag stays `true` after the date passes, and the predicate does the work. No cleanup job exists.
- **Order key**: `auto_enroll_assigned_at` changes only on an **off → on transition of the stored flag**. Changing `until`, including on a flag whose `until` has already passed, keeps the place. `id` (membership uuid) breaks ties deterministically. It is arbitrary but stable, and the spec accepts that.
- **Not retroactive**: Auto Enroll applies to sessions materialised after the change commits. Turning it on never registers the member into sessions that already exist, and turning it off never withdraws them (AC-HAPPY-10). This must appear in the UI copy (hand-off to the UI/UX doc).
- **Benign race**: the read takes no locks, so an "Auto Enroll off" that commits between the materialiser's selection and the allocator's gate can still let that one member be auto-enrolled into that one session. The gate re-checks APPROVED (`FOR SHARE`) but not the flag. This is accepted and documented. Materialisation runs days before a session, so the member can withdraw early for free. Serialising it would need locks the seam deliberately avoids. A ban cannot slip through, because the gate refuses non-APPROVED members.
- **Index**: `idx_team_members_auto_enroll ON team_members (team_id, auto_enroll_assigned_at, id) WHERE is_auto_enroll` (one D-number). It is a small partial index that serves the predicate and the order without a sort.

### D4: The `skill-progression` job

| Option | Description | Verdict |
|---|---|---|
| **D4a: one sweep job, unlocked pre-count, per-member lock-recount transaction** | Keyset over candidates in batches of 500 with a correlated pre-count. Only rows with `games >= 40` get a transaction | **Chosen** |
| D4b: sweep that locks every candidate | One transaction per approved non-`ADVANCED` member | Rejected. N transactions and N row locks per day to promote a handful. Every lock briefly blocks registrations (`FOR SHARE`) for no reason |
| D4c: fan-out, one job per member | Sweep enqueues `skill-progression:<membershipId>` jobs | Rejected. pg-boss rows grow with team size. Per-member retries are not needed (the run is idempotent and cheap to repeat) |
| D4d: event-driven (Option 3) | Billing hook | Deferred. It is recorded in ADR 0017 as a compatible future addition. Its idempotency key is reserved: `skill-progression-member:<membershipId>` |

**Queue and schedule:**
- `QUEUE_NAMES.skillProgression = 'skill-progression'` with registry defaults and `policy: 'exclusive'`, so at most one job is queued or active. A cron tick or CLI trigger during a run is dropped.
- `SCHEDULES`: `{ name: 'skill-progression', cron: '30 5 * * *', tz: 'Pacific/Auckland' }`. This is after the 02:00 to 02:59 DST window and after the 03:00 (recurrence), 04:00 (overdue) and 05:00 (auth-cleanup) slots. `assertNoDstHourFirings` covers it automatically.
- `bootstrap.ts`: `[QUEUE_NAMES.skillProgression]: createSkillProgressionHandler({ db, clock })`, which overrides the placeholder.
- **CLI**: `cli.ts` needs **no code change**, because `TRIGGERABLE` already spreads `SCHEDULES`. Update only the `usage()` text and `docs/getting-started.md`. The CLI sends `{ source: 'cli' }`. The handler **ignores its payload** (any object, `_meta` included) and never validates it strictly, because cron sends `{}`.

**Handler algorithm (normative shape; thresholds and counting come from the algorithm doc):**
```
run(context):
  startedAt = clock.now(); scanned = promoted = failed = 0; after = null
  loop:
    if context.signal.aborted: throw (pg-boss retries; idempotent)
    batch = sweepCandidates(db, { after, limit: 500, now: clock.now() })
            -- SELECT m.id, m.team_id, m.user_id, <qualifyingGamesCount(m, now)> AS games
            --   FROM team_members m
            --  WHERE m.status = 'APPROVED' AND m.skill_level <> 'ADVANCED' AND (after IS NULL OR m.id > after)
            --  ORDER BY m.id LIMIT 500          (no locks; pre-count is a FILTER, never a decision)
    if batch empty: break
    scanned += batch.length; after = last(batch).id
    for c in batch where c.games >= SKILL_PROGRESSION_GAMES:
      try:
        outcome = progressMember(db, { membershipId: c.id, clock, log })
        if outcome.promoted: promoted += 1
      catch err:
        failed += 1
        log.error({ event: 'skill.progression.member_failed', teamId, userId, errorCode: sqlstate ?? 'unknown' })
        span.addEvent('skill.progression.member_failed', { ... }); span.recordException(err)
  log.info({ event: 'skill.progression.completed', scanned, promoted, failed, durationMs })
  if failed > 0: throw new Error('skill-progression: n member(s) failed')   -- transient: retried, then visible as failed

progressMember(db, { membershipId, clock }):  -- ONE transaction per member
  SET LOCAL lock_timeout = '5s'                                 -- the jobs value used by registration-and-waitlist
  row = SELECT team_id, user_id, status, skill_level, skill_level_changed_at
          FROM team_members WHERE id = $membershipId FOR NO KEY UPDATE   -- lock + read in ONE statement
  if row missing or row.status <> 'APPROVED': return { promoted: false }  -- banned meanwhile: skip
  now   = clock.now()                                           -- read AFTER the lock is held
  games = countQualifyingGames(trx, { teamId, userId, now })    -- new statement: sees any committed override
  d     = decideProgression({ level: row.skill_level, games })
  if not d.promote: return { promoted: false }                  -- an override reset the baseline: no-op
  UPDATE team_members SET skill_level = d.to, skill_level_changed_at = $now
   WHERE id = $membershipId AND status = 'APPROVED'
     AND skill_level = $row.skill_level
     AND skill_level_changed_at IS NOT DISTINCT FROM $row.skill_level_changed_at
  log.info({ event: 'team.member.skill_progressed', teamId, userId, from, to, games })
```

- **Why this is race-safe (AC-VERIFY-5, AC-ASYNC-2)**: the decisive guard is "lock, then recount in a fresh statement". Under READ COMMITTED, `SELECT ... FOR NO KEY UPDATE` returns the newest committed row version after any wait, and the following count statement takes a new snapshot. If an override commits first, the job waits, re-reads the new baseline, counts 0 and does nothing. If the job commits first, the override (team lock, then member lock) waits and then applies the admin's choice, which always succeeds. A redelivery or a second concurrent run finds the baseline already moved and promotes nothing. The guarded `UPDATE` (level **and** baseline **and** status) is defence in depth, unreachable while the lock is held, like moderation's guards. `exclusive` reduces duplicate runs but is not relied on for correctness.
- **Lock order**: the job locks **only** the member row and never `teams`. It runs no other locking statements while holding it. The count reads `registrations` and `game_sessions` without locks, and the `UPDATE` changes no foreign-key column, so no FK lock is taken. It therefore cannot form a cycle with moderation/override (`teams` → `team_members`), the ban (`teams` → `team_members`), registration (`team_members FOR SHARE` → `game_sessions`) or billing (`game_sessions` → unlocked read of `team_members`).
- **Clock**: `now` is read per member **after** the lock, and the same value is used as the count's upper bound and the new baseline (see [Algorithm Dependencies](#algorithm-dependencies) A1). If the HTTP and worker processes' clocks disagree so badly that `now < skill_level_override_at`, the CHECK `skill_level_changed_at >= skill_level_override_at` fails with 23514. That becomes a visible `member_failed`, never a silent corrupt row.
- **Failure semantics (AC-ERROR-7)**: per-member `try/catch`. Every other candidate is still processed. The run throws a retryable error when `failed > 0`, so it retries with backoff (retryLimit 3) and then stays `failed` in `pgboss.job`. Retrying is safe because promoted members are no-ops on the next pass.
- **Cost**: one keyset query per 500 members with correlated counts, served by the partial index `idx_registrations_confirmed_team_user ON registrations (team_id, user_id) WHERE status = 'CONFIRMED'` and the `game_sessions` primary key. Per-member transactions run only for the few at or above the threshold. The run is well within the 900 s expiry for the product's scale (clubs of tens to hundreds of members).

### D5: Q7, player visibility of progression in v1

| Option | Description | Verdict |
|---|---|---|
| **Q7a: admin-only, no notification (spec draft)** | Players see nothing new. Admins see level, provenance and progress on Members | **Chosen for v1**, with the caveat below |
| Q7b: read-only `myMembership.skillLevel` (+ progress) on team detail | Additive field on `GET /teams/:id` for the caller | Deferred to player-dashboard. It is cheap, but adds a player-facing surface, copy and a11y work outside this spec |
| Q7c: email on automatic promotion | Enqueue `send-email` in the promotion transaction (P5) | Deferred. Its idempotency key is reserved now: `skill-progressed:<membershipId>:<skill_level_changed_at ISO>`. Adding it later is a one-line enqueue inside `progressMember`'s transaction |

**Caveat (why this is not purely internal):** registration-and-waitlist's register panel already shows "Your fee: {amount}" for `BY_SKILL_LEVEL` sessions, computed from `team_members.skill_level`. Billing charges the registrant's level **at charge time** (see C-PRICE-1 below). So a promotion can change a player's next charge without telling them. That is acceptable for v1 only if the human accepts it explicitly, and it strengthens the case for C-PRICE-1's recommended snapshot. Admin-only stays the recommendation because it is in the approved scope, every promotion is logged, and the admin sees it on the next page load.

---

## Evaluation Matrix

Scores 1 (poor) to 5 (best).

| Criteria | Option 1: new module + leaf seams + sweep | Option 2: extend teams | Option 3: event-driven + orchestrator |
|----------|------|------|------|
| Scalability | 5 | 5 | 5 |
| Maintainability | 4 (two-way module edge guarded by a test) | 2 (teams becomes a grab-bag) | 2 (dead entry points until two features ship) |
| Performance | 4 (≤ 1 day lag; pre-count avoids needless locks) | 4 | 5 |
| Security | 5 (same guards and moderation shape) | 5 | 4 (more surface: billing hook) |
| Observability | 5 (one run span, summary event, per-member failure events) | 5 | 3 (work split across many jobs) |
| Implementation Cost | 4 | 5 | 1 |
| Fit with approved scope and ADRs 0015/0016 | 5 | 3 | 1 |
| **Total** | **32** | **29** | **21** |

---

## Observability Architecture

### Logging
- **Library**: the existing pino logger (`lib/logger`). The request path uses `request.log` (carries `traceId`/`spanId`); the job path uses `context.logger` (bound to `jobId`, `queue`, trace).
- **Format**: structured JSON (`timestamp`, `level`, `message`, `service`, `traceId`, `spanId`, plus `jobId`/`queue` on jobs).
- **Configuration**: `LOG_LEVEL`, `LOG_FORMAT`, `LOG_OUTPUT`, `LOG_FILE_PATH` (unchanged).
- **Events (exact field sets, AC-VERIFY-6)**:

| Event | Level | Path | Fields |
|---|---|---|---|
| `team.member.skill_overridden` | info | HTTP | `teamId`, `actorId`, `userId`, `from`, `to` |
| `team.member.auto_enroll_changed` | info | HTTP | `teamId`, `actorId`, `userId`, `enabled`, `hasUntil` |
| `team.action.refused` | info | HTTP | existing helper: `action` (`skill_override` / `auto_enroll`), `actorId`, `teamId`, `reason` |
| `team.member.skill_progressed` | info | job | `teamId`, `userId`, `from`, `to`, `games` |
| `skill.progression.member_failed` | error | job | `teamId`, `userId`, `errorCode` (SQLSTATE or `unknown`) |
| `skill.progression.completed` | info | job | `scanned`, `promoted`, `failed`, `durationMs` |

  No full name, email, override-actor name or `until` date is logged. No field is named exactly `code` (globally redacted). No-op saves log nothing.

### Distributed Tracing
- **SDK**: OpenTelemetry (existing `instrumentation.ts`).
- **Propagation**: W3C Trace Context.
- **Service Boundaries**:

  | From | To | Protocol | Propagation Method |
  |------|-----|----------|-------------------|
  | apps/web Server Action | apps/api `PUT` routes | HTTP | `traceparent` header (existing `api-client.ts`) |
  | apps/api | PostgreSQL | pg | in-process (pg instrumentation not wired; unchanged) |
  | pg-boss cron / CLI | worker `skill-progression` | pg-boss | `payload._meta.traceparent` when present; otherwise the worker's `"skill-progression process"` consumer span is the root |
  | future materialiser | `selectAutoEnrollees` | in-process | caller's active span |

- **Spans**: no new spans on the HTTP path (Fastify request/handler spans suffice). On the job path, the existing consumer span gets attributes `skill.progression.scanned`, `.promoted`, `.failed` at the end. Each member failure becomes a **span event** plus `recordException` on that span, instead of a per-member child span (cheaper, and no conditional span creation). Span status is `ERROR` when `failed > 0`.
- **Sampling**: `OTEL_TRACES_SAMPLER_ARG` (0.1 in production per deployment; 1.0 dev).

### Metrics
- **Standard Metrics**: none added. The metrics exporter is not implemented in the foundation (`METRICS_ENABLED` default off), and the spec states none new.
- **Reserved names** (for when the exporter lands; no user/request ids as labels):
  - `skill_progression_runs_total{outcome="succeeded|failed"}`: run outcomes.
  - `skill_progression_promotions_total{from, to}`: promotions per transition (3 label combinations).
  - `skill_progression_member_failures_total{error_code}`: SQLSTATE-bounded cardinality.
  - `skill_progression_run_duration_seconds` (histogram).
  - `team_member_skill_overrides_total`, `team_member_auto_enroll_changes_total{enabled}`.
  Until then the run-summary log is the metric source (an operator can alert on `skill.progression.member_failed` and on `pgboss.job` rows in `failed` for queue `skill-progression`).

### Configuration Variables

| Variable | Purpose | Default |
|----------|---------|---------|
| LOG_LEVEL | Log verbosity | info |
| LOG_FORMAT | Output format | json |
| OTEL_EXPORTER_OTLP_ENDPOINT | Collector endpoint | - (no export) |
| OTEL_SERVICE_NAME | Service identifier | `sgm-api` / `sgm-worker` |
| OTEL_TRACES_SAMPLER_ARG | Sampling ratio | 1.0 (dev) |

No new variables. Batch size (500), lock timeouts (2 s HTTP, 5 s job) and the cron slot are code constants, consistent with every existing job and with registration-and-waitlist. The progression thresholds are shared product constants (algorithm Q6).

---

## Decision

**Chosen**: Option 1 - New `skill-levels` module with leaf read seams, teams-owned `TeamMemberRow` mapper, and a daily lock-and-recount progression sweep. Sub-decisions D1a, D2 (moderation shape, member row `FOR NO KEY UPDATE`, explicit ban clear), D3a (lock-free typed selection), D4a (pre-count sweep, per-member transaction locking only the member row), Q7a (admin-only v1, with the pricing caveat surfaced to the human).

### Rationale
- It is the only option that delivers every MUST AC **now**, against real rows, without depending on unmerged or unplanned code. It also respects the approved scope boundary (no allocator call, no billing hook).
- The module boundary follows the precedent ADR 0016 set: a feature module that uses the `teams` public lock helpers and never reaches into `teams/repo.ts`. The single unavoidable reverse edge (the member read model needs the count) goes to a leaf file and is enforced by a structural test.
- Correctness under concurrency comes from the canonical lock order plus a lock-then-recount discipline, not from queue policy. That is the same reasoning ADR 0015 and the registration allocator use, so reviewers have one mental model.
- Both seams are tiny, typed and lock-free. Their contracts (C-GAME-1, C-SKL-1) can be pinned by tests today and re-checked at the consumers' build gates.

### Trade-offs Accepted
- **Up to one day between a game's completion and a promotion.** Accepted in open question (c). The CLI trigger gives operators an immediate path, and Option 3's hook is reserved as a compatible future addition.
- **A benign race on "Auto Enroll off" during a materialisation.** It is documented and does no harm (free early withdrawal). Closing it would need locks that break the seam's lock-free contract.
- **A module-level two-way dependency between `teams` and `skill-levels`.** It is kept file-acyclic by the leaf rule and a test, and is cheaper than a port that would let required response fields go missing.
- **`skill_level_changed_at` is a counting baseline as well as a display stamp.** That couples UI provenance to algorithm semantics (see A2). The pure `deriveSkillProvenance` isolates the web from it.

---

## Cross-Feature Contracts (content for ADR 0017)

ADR file: `docs/adr/0017-skill-levels-and-auto-enroll.md`. Status Accepted at build, Task `skill-levels-and-auto-enroll`, Source: this doc plus the algorithm doc. **Numbering**: ADR 0016 (team-banking) instructed registration-and-waitlist to renumber to 0017 at its build gate, so both branches now target 0017. Per the user decision of 2026-10-17, whichever merges second renumbers its ADR and its D-numbers.

### C-GAME-1: what a game is (owners: registration-and-waitlist, wallet-and-akahu-billing)
1. **Definition** (this feature owns it; one SQL definition in `skill-levels/games.ts`): a qualifying game for member M of team T at time `now` is a `registrations` row with `user_id = M`, `team_id = T`, `status = 'CONFIRMED'`, joined to its `game_sessions` row with `status = 'COMPLETED'` and `ends_at` inside the counting window (algorithm doc; architecture requires the window's upper bound to be `now`, see A1). One registration counts as one game, whatever the party size or payment state.
2. **Registration obligation**: once a session is `COMPLETED`, none of its `registrations` rows changes `status`. The allocator already refuses with `session_not_open` and the ban handler only touches future `PUBLISHED` sessions. Recommended backstop for that feature: a trigger refusing `registrations.status` changes when the session is `COMPLETED`.
3. **Billing obligation**: sessions become `COMPLETED` only through billing's `PUBLISHED → COMPLETED` transition (C-BIL-1). `COMPLETED` is terminal, and `ends_at` (that is, `session_courts`) is not edited after completion. If a completed session were ever reverted, counts would drop and nobody would be demoted. That is safe, but it must be a deliberate decision recorded in that feature's ADR.
4. **Denormalisation relied on**: `registrations.team_id` equals its session's `team_id` (composite FK, D-10). The count filters `registrations.team_id` directly.
5. **Reads only**: counting takes no locks and reads only committed rows. Callers may pass a transaction.

### C-SKL-1: auto-enrol selection (owner of the consumer: session-scheduling-engine)
1. **Seam**: `selectAutoEnrollees(db, { teamId, sessionDate })` exactly as in D3a (signature, predicate, order `auto_enroll_assigned_at ASC, id ASC`, inclusive `until`, no locks). `sessionDate` is the session's `game_sessions.date`.
2. **Call sequence** (per registration-and-waitlist C-SAE-1 and C-SAE-2): after the session is `PUBLISHED` (in this or an earlier transaction), call `selectAutoEnrollees`, then **once per session** `allocator.autoEnrolInSession(ctx, { teamId, sessionId, userIds })` with the `userId`s **in the returned order**. Parties have 0 guests. Never write `registrations` directly. Per-member refusals (`overdue_payments`, `forbidden`, `already_registered`) are skips, not failures.
3. **Lock-order note for session-scheduling-engine** (advisory; re-check at its plan): the allocator gates members (`team_members FOR SHARE`) before it takes the session lock. When auto-enrol runs in the **same** transaction that inserted the session row, the uncommitted row is invisible to other transactions, so taking `team_members` after it cannot deadlock. When a materialiser publishes a session that **already existed** (for example ADR 0016's retry of a DRAFT instance), it should run auto-enrol in a **follow-up transaction** that has not locked that session. Otherwise it acquires `game_sessions` before `team_members`, against C-ALL-1.
4. **Which sessions**: only recurrence materialisation (workflows §4). Whether a manually created one-off session triggers auto-enrol is an open question owned by session-scheduling-engine. The seam works either way.
5. **Not retroactive**: Auto Enroll changes apply to materialisations that start after the change commits (D3a).
6. **Contract test**: `apps/api/test/integration/skill-levels-games.int.test.ts` carries a header naming C-SKL-1 and ADR 0017 (like `teams-ban-seam.int.test.ts`). It contains:
   - `expectTypeOf(selectAutoEnrollees).parameters` and `.returns` pins (Vitest), plus `Object.keys(row).sort()` equal to `['assignedAt', 'membershipId', 'userId']`.
   - The AC-INTEGRATION-1 predicate/order table.
   - A **non-blocking proof**: another connection holds `FOR UPDATE` on every selected member row while `selectAutoEnrollees` and `countQualifyingGames` complete. Either function blocking fails the test (bounded by `waitFor`'s timeout).
   - A `TeamMemberRow` additive-fields pin (strict parse of a real list response).

### C-PRICE-1: level changes and pricing (replaces the spec's "no-retroactive-repricing rule" wording)
- **What is guaranteed by this feature**: an override or a promotion never writes `registrations`, `registration_guests`, `payments` or `payment_line_items`. It never alters an issued payment or line item, because those snapshot the applied fee basis (ADR 0012).
- **What the in-flight design actually does**: registration-and-waitlist's hand-off (allocation-algorithm rule 7; allocator `BillableRegistration.registrantSkillLevel` "current") computes the registrant's `BY_SKILL_LEVEL` fee **at charge time** from the then-current `team_members.skill_level`. Guests' levels **are** snapshotted on `registration_guests`. So a level change between registering and billing changes that registrant's charge, and the fee estimate shown at registration can then be wrong. The spec's parenthetical "fees are read when registering and billing snapshots them" is therefore inaccurate.
- **Recommendation to registration-and-waitlist / wallet-and-akahu-billing** (their decision; recorded here so it is not lost): snapshot the registrant's level on the registration when it becomes `CONFIRMED` (for example `registrations.registrant_skill_level skill_tier NOT NULL`, mirroring `registration_guests.skill_level`), and have `listBillableRegistrations` return the snapshot. That makes the price a player sees at registration the price they pay, makes registrant and guests consistent, and makes "no retroactive repricing" literally true.
- **Interaction with timing (holds under either choice)**: billing bills a session as it moves to `COMPLETED`, which is the same moment that session's games become countable. Progression runs at 05:30 the next day. So the game that triggers a promotion is always billed at the old level.

### Progression contract (internal, recorded for operators and future features)
- Queue `skill-progression` (`exclusive`), cron `30 5 * * *` Pacific/Auckland, `cli jobs trigger skill-progression`. The payload is ignored.
- Lock: the member row only (`FOR NO KEY UPDATE`), never `teams`. Lock and read in one statement, then recount, decide and guard.
- Reserved for later: the event-driven hook key `skill-progression-member:<membershipId>` (D4d) and the email key `skill-progressed:<membershipId>:<changedAt>` (Q7c).

---

## Algorithm Dependencies

The architecture holds for every option the algorithm doc is weighing, with these explicit couplings:

- **A1 (required of every counting option)**: the counting window must be **half-open with `now` as its upper bound**: `baseline < ends_at <= now`, with `now` the same value the job writes to `skill_level_changed_at`. Without `ends_at <= now`, a session completed between a run's pre-count and its per-member transaction could be counted towards a promotion and counted **again** after the new baseline. AC-VERIFY-3's rule currently has no upper bound and needs it.
- **A2 (surplus games, Q3)**: with the drafted default (discard surplus), `skill_level_changed_at = now` and the job is "one level per run" (AC-HAPPY-5's second run changes nothing). If the algorithm chooses **carry-over** (baseline = `ends_at` of the 40th counted game), the job writes that `ends_at` instead of `now`. The guarded `UPDATE`, the lock discipline and idempotency are unchanged. Two things do change: (i) AC-HAPPY-5's second run would promote again (85 games → INTERMEDIATE, then 45 remaining → ADVANCED), and (ii) "Moved up automatically · {date}" would show the game's date, so `deriveSkillProvenance`'s `AUTO` case would need its own timestamp rather than `skillChangedAt`. The CHECK `skill_level_changed_at >= skill_level_override_at` still holds, because the 40th game is after the baseline.
- **A3 (override precedence, Q2)**: with the drafted default (override resets the baseline and never freezes progression), no job filter on override columns is needed. If the algorithm chooses "override pins the level", `sweepCandidates` and `progressMember` add `skill_level_override_at IS NULL` (or a pin window). That is one predicate, with no structural change.
- **A4 (clock for the window, Q1)**: if the algorithm counts by `date` instead of `ends_at`, only the fragment in `games.ts` and the partial-index choice change.
- **A5 (same-level saves)**: `decideOverride` returns a no-op when the level is unchanged (AC-HAPPY-3, drafted). If the algorithm makes a same-level save reset the baseline, only that pure function changes.

---

## Implementation Guidelines

1. **Phase 1 (schema)**: migration adds `skill_level_changed_at timestamptz` and four named CHECKs: `team_members_override_stamps_paired`, `team_members_changed_after_override`, `team_members_auto_enroll_cleared_when_off`, `team_members_auto_enroll_approved_only`. It adds partial indexes `idx_registrations_confirmed_team_user` and `idx_team_members_auto_enroll`, one D-number each from D-55. **Pre-flight**: the approved-only CHECK fails if any non-APPROVED row has `is_auto_enroll = true`. Nothing writes it today, but the Up migration should still assert `NOT EXISTS` first and raise a clear error rather than a bare 23514. The ban `UPDATE` change lands in the **same phase** as the CHECK, otherwise every ban of an auto-enrolled member would fail.
2. Move `getMemberRow`/`toMemberRow` and the member column list into public `teams/member-read.ts`. `teams/repo.ts` re-exports them so teams code is unchanged (the precedent of `findApprovedRole` moving to `admin-lock.ts`). Add the boundaries test.
3. `games.ts` exports the fragment builder (`qualifyingGamesCount(eb | sql refs, { now })`) and `countQualifyingGames`. `member-read.ts` embeds the fragment for APPROVED, non-`ADVANCED` rows only. Confirm with `EXPLAIN (ANALYZE)` in Phase 2 that the correlated count uses `idx_registrations_confirmed_team_user`.
4. `auto-enrol.ts` takes `sessionDate: LocalDate` and binds it as `::date`. It never parses dates in host time (P3).
5. Both PUTs: `SET LOCAL lock_timeout = '2s'` → `assertTeamAdminUnderLock(..., 'noKeyUpdate')` → `lockMemberRow` (`FOR NO KEY UPDATE`, by `(team_id, user_id)`) → pure decision → guarded `UPDATE ... AND status = 'APPROVED'` → `getMemberRow(trx)`. Log after commit. Wrap in `refusing(...)` for `team.action.refused`.
6. `decideAutoEnrolChange`: off→on sets `assigned_at = now`. on→on keeps `assigned_at` and updates `until`, even when the old `until` has passed. on→off clears all three columns. off→off, and on→on with the same `until`, are no-ops (no write, no event). `until` must be on or after today in Pacific/Auckland (from the injected clock). `enabled: false` with a non-null `until` gives 422.
7. Progression: `sweepCandidates` uses no locks. `progressMember` sets `SET LOCAL lock_timeout = '5s'`, locks and reads in one statement, reads `now` after the lock, recounts, and does a guarded `UPDATE` on level, baseline and status. The handler checks `context.signal` between members and throws when `failed > 0`.
8. Tests that interleave (AC-VERIFY-5) use `waitForLockWaiters`:
   - Hold the member row `FOR NO KEY UPDATE` in a test connection, start `progressMember`, wait for 1 waiter, commit an override in the held transaction, release, and assert no promotion.
   - Reverse: hold the member row, start an override request, wait, let a promotion commit in the held transaction, release, and assert that the override applied and the CHECKs hold.
   - The ban vs toggle race uses the existing `raceUnderTeamLock` (both block on the team row).
   - For two concurrent runs, call the handler twice directly (pg-boss `exclusive` is not under test).
   - Advance the injected clock between sequential steps.
9. Wire `QUEUE_NAMES.skillProgression`, the registry entry, the `SCHEDULES` slot and the `bootstrap.ts` handler. Extend `registry.test.ts`, `schedules.test.ts` and `handlers.test.ts`. Update `cli.ts` `usage()` text and `docs/getting-started.md` only.
10. Shared: `packages/shared/src/skill/{progression,provenance}.ts` (`decideProgression`, `nextSkillLevel`, `toSkillProgress`, `deriveSkillProvenance`). Extend the `TeamMemberRow` zod schema with the four fields, required on every row (D1a semantics). Strict request schemas in `packages/shared/src/api/skill-levels.ts`.

---

## Validation Checklist

- [x] Meets all system requirements (every MUST AC maps to a component above. The seams are provable on factory rows today)
- [x] Respects technical constraints (no allocator call, no session or registration writes, no new env vars)
- [x] Addresses non-functional requirements (P1 CHECKs, P3 date/instant boundaries, P5 queue only, 50-row list cost bounded by a partial index)
- [x] Technically feasible (uses only existing helpers: `admin-lock.ts`, `team-refusals.ts`, `registerJobs`, `waitForLockWaiters`, factories)
- [x] Risks identified and acceptable (below)
- [x] Complies with Guiding Principles in systemPatterns.md. P1: the new invariants are CHECKs, and the ban regression is caught by a CHECK. P2: no money touched. P3: `until`/`sessionDate` are `date`, instants are UTC, and "today" is converted at the boundary. P4: n/a. P5: progression only via pg-boss, and future notifications are reserved for the same transaction. P6: no new root scripts. P7: no new configuration; thresholds and timeouts are domain or code constants like every existing job's. No deviation.
- [x] Respects established patterns (moderation transaction shape, canonical lock order, module public-surface files, guarded `UPDATE`s, contract-test header convention, exact-field log tests)
- [x] Observability architecture defined
- [x] Trace context propagation across all service boundaries (web→API header; cron/CLI→worker via `_meta` or root consumer span; in-process for the future materialiser)
- [x] Logging strategy consistent with observability-requirements.md (structured JSON, trace ids, no PII, no `code` field)
- [x] Metrics strategy follows naming conventions (reserved `snake_case` names with `_total`/`_seconds` suffixes and bounded labels; not implemented until the exporter exists)

---

## Risk Assessment

| Risk | Likelihood | Impact | Mitigation |
|------|------------|--------|------------|
| Charge-time skill pricing (registration-and-waitlist C-BIL) means a promotion silently changes a player's next `BY_SKILL_LEVEL` charge | M | M | C-PRICE-1 records the facts and recommends a registrant-level snapshot to the owning features. Flag to the human now. Q7 caveat |
| Counting without an upper bound double-counts a game across a baseline | M (if missed) | H | A1 is mandatory. Add a table row to AC-VERIFY-3: a session completed with `ends_at > now` is excluded |
| Ban path not updated in the same phase as the approved-only CHECK, so every ban of an auto-enrolled member fails | L | H | Same phase (guideline 1). `teams-ban-seam.int.test.ts` assertion |
| ADR and D-number collision with registration-and-waitlist (both target 0017 and D-55+) | H | L | User decision: the second to merge renumbers. ADR text and test headers reference contract IDs (C-SKL-1), not the ADR number alone |
| Module cycle creeps in (`games.ts` imports from `teams`) | L | M | Leaf rule + `boundaries.test.ts` |
| Materialiser runs auto-enrol in the same transaction after locking an already-committed session (lock inversion) | M | M | C-SKL-1 point 3 advisory. Re-checked at session-scheduling-engine's plan and build gate |
| Auto Enroll turned off during a materialisation still enrols that member once | L | L | Documented as benign. Early withdrawal is free days before the session |
| Clock skew between api and worker processes trips `changed_after_override` | L | L | 23514 surfaces as `skill.progression.member_failed`. The run fails visibly and retries |
| Members-list latency from 50 correlated counts | L | M | Partial index. `EXPLAIN` check in Phase 2. Counts are skipped for non-APPROVED and `ADVANCED` rows |
| Zero games in production until the allocator and billing ship, so admins wonder why progress stays at 0 | H | L | Expected and documented in the ADR. "0 of 40" copy is still accurate |

---

## Required Spec and Plan Changes

These are for the orchestrator to reconcile with the algorithm and UI/UX docs. This agent did not edit the task file.

1. **Scope Boundaries, "Repricing existing registrations..."** and **AC-INTEGRATION-3**: replace "the no-retroactive-repricing rule" and the parenthetical "(fees are read when registering and billing snapshots them, ADR 0012)" with C-PRICE-1. Level changes never write registrations or payments, and issued payments are immutable. The registrant's unbilled `BY_SKILL_LEVEL` charge uses the level at charge time per registration-and-waitlist's hand-off, and a snapshot is recommended to that feature. **Needs a human decision**: accept charge-time pricing for v1, or ask registration-and-waitlist to add the snapshot.
2. **AC-VERIFY-3**: add the upper bound `ends_at <= now` (A1), plus a table row excluding a `COMPLETED` session whose `ends_at` is after `now`. Reword "one function (`countQualifyingGames`) is used by the job and by the row's progress line" to "one SQL definition (`qualifyingGamesCount` in `skill-levels/games.ts`), wrapped by `countQualifyingGames` for the job and embedded by `teams/member-read.ts` in the members list".
3. **AC-INTEGRATION-1**: the return shape is `readonly { userId, membershipId, assignedAt }[]`. `sessionDate` is a `LocalDate` equal to `game_sessions.date`. Add the non-blocking proof (a held `FOR UPDATE` on member rows does not block selection).
4. **AC-ASYNC-2**: replace "the guarded `UPDATE ... WHERE id = $id AND skill_level = $expected` and the queue's `exclusive` policy are the only guards needed" with "the member-row lock followed by a recount in a new statement is the guard. The `UPDATE` is additionally guarded on `skill_level`, `skill_level_changed_at` and `status = 'APPROVED'`. `exclusive` only reduces duplicate runs".
5. **AC-VERIFY-5**: the target and job row lock is `team_members ... FOR NO KEY UPDATE` (moderation's `lockTarget` stays `FOR UPDATE`). The job sets `lock_timeout = 5s`, the PUTs set `2s`. The job reads `now` after taking the lock.
6. **AC-HAPPY-9 / AC-HAPPY-10**: add "an on→on save keeps `auto_enroll_assigned_at` even when the previous `until` has passed. Off→off and an unchanged on→on are no-ops with no event". Add "Auto Enroll applies to sessions created after the save. It never registers into, or withdraws from, existing sessions" (UI copy hand-off).
7. **Invocation Method / API, `TeamMemberRow` fields**: fields are present on every row of every endpoint. `skillProgress` is null for `ADVANCED` and for non-APPROVED rows. Provenance is derived by shared `deriveSkillProvenance`, not a new field.
8. **AC-ERROR-7 / AC-VERIFY-6**: `skill.progression.completed` fields are `scanned`, `promoted`, `failed`, `durationMs`. Per-member failures are span events on the run span (not child spans). Update the Observability Requirements "Tracing" bullet to match.
9. **New Source Files**: add `apps/api/src/modules/skill-levels/auto-enrol.ts` (selection moves out of `games.ts`), `progression.ts` (sweep + per-member), `decisions.ts` (pure), `boundaries.test.ts`, `apps/api/src/modules/teams/member-read.ts` (public mapper), and `packages/shared/src/skill/provenance.ts`. Change the `apps/api/src/cli.ts` entry to "usage text only (trigger list derives from `SCHEDULES`)". Add the second partial index `idx_team_members_auto_enroll` to the migration bullet. Add `apps/api/src/modules/teams/repo.ts` re-exports.
10. **Phase 1**: the ban `UPDATE` change is mandatory in the same phase as the approved-only CHECK (already listed. Make the dependency explicit), plus the migration's `NOT EXISTS` pre-flight.
11. **Phase 2**: the contract test header names C-GAME-1, C-SKL-1 and ADR 0017, and includes the type pins. ADR 0017 includes C-PRICE-1, the C-SKL-1 lock-order advisory, and the reserved idempotency keys.
12. **ADR numbering note**: ADR 0016 already told registration-and-waitlist to take 0017. Add to Dependencies & Risks that both branches now target 0017, so whichever merges second renumbers.

---

## Next Steps

1. Orchestrator: reconcile with the algorithm doc (A1 to A5) and the UI/UX doc (Auto Enroll non-retroactive copy, "ended" state keeping its place). Put the C-PRICE-1 decision to the human.
2. Phase 1: migration (column, four CHECKs, two partial indexes, pre-flight), ban `UPDATE`, shared constants and pure functions, strict schemas.
3. Phase 2: `games.ts`, `auto-enrol.ts`, `teams/member-read.ts`, boundaries test, contract test, `EXPLAIN` check, ADR 0017.
4. Phase 3: `skill-levels` routes, service and decisions. `buildApp` registration, OpenAPI, coverage gate entry.
5. Phase 4: `progression.ts`, `jobs/skill-progression.ts`, registry, schedule and bootstrap wiring, race tests.
6. Phase 5: web panel and view model (per the UI/UX doc).
7. At session-scheduling-engine's plan: re-check C-SKL-1 (call sequence, lock-order advisory, one-off sessions). At registration-and-waitlist's build gate: re-check C-GAME-1 point 2 and the C-PRICE-1 recommendation.
