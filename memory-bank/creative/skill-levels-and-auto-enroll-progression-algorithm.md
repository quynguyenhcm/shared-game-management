# Algorithm Decision: Skill Progression and Qualifying-Game Counting

**Created**: 2026-10-17
**Status**: DECIDED
**Decision Type**: Algorithm
**Task**: skill-levels-and-auto-enroll (Level 3)
**Creative questions owned**: Q1 (game-counting edges), Q2 (override vs auto-progression precedence), Q3 (surplus games and `skill_level_changed_at` semantics), Q6 (constants vs configuration), plus the `skill-progression` sweep, the count query and its index.
**Sources read**: task file `memory-bank/tasks/skill-levels-and-auto-enroll.md` (branch tip: Specification, Implementation Roadmap); `main:memory-bank/{productBrief,systemPatterns}.md`; `db/migrations/20260929000400000_team_members.sql`, `...000600000_game_sessions_and_courts.sql`, `...000700000_registrations_and_guests.sql`, `...001000000_indexes.sql`, `20261013000100000_team_membership_invariants.sql`; `apps/api/src/jobs/{registry,schedules}.ts`; `apps/api/src/modules/teams/repo.ts` (`lockTeam`, `listMembers`, no `team_members` delete path); `packages/shared/src/api/teams.ts` (`MEMBERS_PAGE_SIZE = 50`); `apps/api/src/lib/clock.ts`; `docs/adr/0010-time-dst.md`; `origin/feature/registration-and-waitlist:memory-bank/creative/registration-and-waitlist-allocation-algorithm.md` (withdrawal kinds, `withdrawal_fee_due`, closed-after-start rule).

Out of lane (other agents): selection ordering and the C-SKL-1 hand-off (architecture, Q4), the Members-row layout and copy (UI/UX, Q5), player visibility (Q7). Where this document constrains them it says so under "Hand-offs".

---

## Problem Statement

Each approved member of a team carries a `skill_level` (`BEGINNER`, `INTERMEDIATE`, `ADVANCED`) that prices `BY_SKILL_LEVEL` sessions. An admin can set it at any time. A daily job also moves a member up one level when they have played 40 games for that team in the trailing 365 days. The algorithm must:

1. define a "qualifying game" once, exactly and testably, on tables that are written by two other features (registration-and-waitlist, wallet-and-akahu-billing);
2. define a counting baseline (`skill_level_changed_at`) that makes "40 games per level" mean something after a promotion or an override;
3. decide promotions in a sweep that is idempotent under at-least-once delivery, safe against concurrent admin overrides and bans, isolates per-member failures, and stays cheap as teams grow;
4. give the Members page the same number the job will use, for up to 50 rows per page, without 50 round trips.

## Inputs & Outputs

### Inputs
| Name | Type | Size/Range | Source |
|------|------|------------|--------|
| `team_members` row | `skill_level`, `skill_level_changed_at` (new), `skill_level_override_at`, `status`, `team_id`, `user_id` | ~10^4 rows today-scale, ~10^5 at 10x | `team_members` |
| Confirmed registrations | `registrations (team_id, user_id, session_id, status)` | ~100/member/year (2 games a week), ≤ ~300 all-time per member per team | registration-and-waitlist |
| Session state and end instant | `game_sessions (id, team_id, status, ends_at)` | ~100 sessions/team/year | session-scheduling-engine (`ends_at` is trigger-derived), billing (`COMPLETED`) |
| `now` | `Date` from the injected `Clock` | one per member decision | `apps/api/src/lib/clock.ts` |
| Thresholds | `SKILL_PROGRESSION_GAMES = 40`, `SKILL_PROGRESSION_WINDOW_DAYS = 365` | constants | `packages/shared/src/skill/progression.ts` |

### Outputs
| Name | Type | Description |
|------|------|-------------|
| `games` | `number` (int ≥ 0) | Qualifying games for (team, member) at `now` since the baseline and inside the window |
| `ProgressionDecision` | `{ kind: 'stay' } \| { kind: 'promote', from, to }` | Pure decision from `{ level, games }` |
| Guarded `UPDATE` | 0 or 1 row | `skill_level = to`, `skill_level_changed_at = now`; override stamps untouched |
| Run summary | `{ scanned, candidates, promoted, skipped, failed }` | Logged as `skill.progression.completed`; `failed > 0` fails the job |
| `skillProgress` | `{ games, required, nextLevel } \| null` | Per Members row; `null` at `ADVANCED` |

### Edge Cases
1. **No-show** (confirmed, didn't turn up). No attendance data exists → counts. One place to change if attendance is added (C-GAME-1).
2. **Late withdrawal that is charged** (`WITHDRAWN`, `withdrawal_kind = 'LATE'`, `withdrawal_fee_due = true`) → does **not** count (see Q1).
3. **Waitlisted then promoted** → the row is `CONFIRMED` → counts once. Waitlisted never promoted → does not count.
4. **Guests** → never count, for anyone. Party size is irrelevant: one registration is one game.
5. **Two sessions of the same team on the same day** → two games.
6. **Session `COMPLETED` but `ends_at` after `now`** (data error or a seeded test row) → does not count yet (upper bound, see Q1).
7. **Game ended exactly at the baseline instant** → belongs to the old level; excluded after the change.
8. **Game ended exactly 365 × 24 h before `now`** → outside the window.
9. **Member with 85 games at `BEGINNER`** (backfill or a long outage of the job) → one level per run; the 45 surplus are discarded (Q3).
10. **Member at `ADVANCED`** → never examined by the job, `skillProgress = null`.
11. **Member banned between the pre-pass and the lock** → skipped (status re-read under the lock).
12. **Override committed between the pre-pass and the lock** → the recount uses the override's baseline, finds ~0 games, no write.
13. **Empty team / no sessions yet** (the production state until session-scheduling-engine and registration-and-waitlist ship) → every count is 0, the sweep scans and promotes nobody.
14. **`games` falls between runs** (an old game leaves the window) → the job decides on the count at its own `now`; the page may have shown 40 the evening before. Accepted.

## Constraints

### Performance Requirements
- **Maximum Latency**: Members page p95 is not given a number in productBrief; the existing list is one SQL query. Budget for the progress counts: ≤ 20 ms for a 50-row page (one extra query, not 50).
- **Job duration**: must finish well inside the queue's `expireInSeconds = 900` (registry default), with headroom at 10x.
- **Lag**: ≤ 1 day from `COMPLETED` to promotion is accepted (open question (c), user decision 2026-10-17).
- **Memory Budget**: the worker processes one batch of 500 rows at a time; O(batch) memory.

### Scale Requirements
- **Current Data Size**: zero games in production until the two upstream features ship. Planning scale: ~200 teams × ~60 approved members ≈ 12k members; ~100 confirmed registrations per member per year.
- **Expected Growth**: 10x (≈ 120k members, ≈ 12M registrations over a few years).
- **Peak Load**: one sweep at a time (queue `exclusive`), concurrent with admin saves, registrations and billing.

### Other Constraints
- **P1**: invariants are CHECKs; the count reads only committed rows.
- **P3**: all instants UTC; the window is an absolute duration, never a calendar or `'1 day'` interval (ADR 0010).
- **P5**: progression happens only in the job; no work in the HTTP request beyond reads.
- **P7**: config is for values that vary by deployment (Q6).
- **Lock order** (systemPatterns, ADR 0015): `teams` → `team_members` → `game_sessions` → `registrations`. The job must never take a `teams` lock.
- **Triggers on `team_members`**: `team_members_guard_update` fires on `UPDATE OF status, team_id, user_id`; `team_members_last_admin_on_update` fires on `UPDATE OF role, status` and locks the `teams` row. A progression `UPDATE` that lists `status` or `role` in its `SET` clause would fire them (PostgreSQL fires `UPDATE OF` triggers when the column is in the target list, even if the value is unchanged), and the last-admin trigger would take a `teams` lock after a `team_members` lock: a lock-order inversion. The progression `UPDATE` therefore sets only `skill_level` and `skill_level_changed_at`.
- **Upstream facts relied on** (registration-and-waitlist allocation doc): register and withdraw are refused at `now >= starts_at`, the ban handler skips started sessions, so a `COMPLETED` session's `CONFIRMED` set is frozen. Billing completes sessions through a 5-minute sweep (`post-game-billing`, `ends_at <= now()`), so completion lags `ends_at` by minutes, not days.

---

## Q1: What is a qualifying game?

### Option 1A: Confirmed registration in a completed session, clocked by `ends_at` (drafted, refined)
- **Approach**: count `registrations` with `status = 'CONFIRMED'` joined to the team's `game_sessions` with `status = 'COMPLETED'` and `ends_at` in `(since, now]`, where `since = greatest(now − 365 × 24 h, baseline)`.
- **Pros**: one status test per table; both statuses are terminal or frozen after start, so the count is stable once a game is in it; `ends_at` is `NOT NULL` for every non-`DRAFT`/`CANCELLED` session (`game_sessions_instants_when_live`) and is a real UTC instant comparable with the baseline.
- **Cons**: counts no-shows (no data exists to exclude them).

### Option 1B: Also count charged late withdrawals ("a paid seat is a game")
- **Pros**: mirrors billing (they pay for the session).
- **Cons**: the member did not play, and skill level is about playing; `withdrawal_fee_due` is mutable until `starts_at` (released when the seat is resold), so the predicate would need to reason about time; it couples skill to the fee mechanic (paying for empty seats would raise a level). Rejected.

### Option 1C: Clock by `date` (NZ local calendar date)
- **Pros**: the date admins see.
- **Cons**: a `date` cannot be compared with an instant baseline: an override at 15:00 on the day of an evening game cannot tell whether that game is before or after. A 365-day window on dates needs NZ calendar arithmetic (P3 boundary inside SQL). Rejected.

### Option 1D: Clock by completion time (when billing set `COMPLETED`)
- **Cons**: no `completed_at` column exists (a schema change in someone else's table); the count would depend on billing lag and retries rather than on when the game was played. Rejected.

### Q1 decision: Option 1A
| Question | Decision |
|----------|----------|
| Status pair | `registrations.status = 'CONFIRMED'` and `game_sessions.status = 'COMPLETED'`, same `team_id` (join on `(session_id, team_id)` matching the composite FK) |
| No-shows | **Count.** No attendance column exists, and a confirmed registrant of a completed session is billed as a player. If attendance is ever recorded, the predicate gains one clause in one place (`qualifyingGames` builder); C-GAME-1 records this. |
| Charged late withdrawal | **Does not count.** It is `WITHDRAWN`; the member did not play. Same for early, ban (`BANNED` kind) and leave-waitlist withdrawals. |
| Clock | `game_sessions.ends_at` (UTC instant) |
| Window | `ends_at > now − 365 × 24 h` (strict). "365 days" means exactly 31 536 000 000 ms, computed in TypeScript and bound as a parameter; never `interval '365 days'` or a calendar year. |
| Baseline | `ends_at > skill_level_changed_at` (strict); `NULL` baseline means no lower bound beyond the window. |
| Upper bound (new) | `ends_at <= now`. A completed session always has `ends_at <= now` in practice (billing only completes due sessions), but stating it makes the count a function of `now` alone and makes "after a promotion at `now`, the count is 0" provable (see Idempotency proof). It also keeps a mis-seeded or later-edited session from counting before it ends. |
| Guests, party size, payment status | Irrelevant: one `CONFIRMED` registration = one game for the registrant only. |
| Baseline floor for never-changed members | `-infinity` (as drafted). Checked: there is no `team_members` delete path in v1 (`modules/teams/repo.ts`), BANNED is terminal and REJECTED → PENDING members have no games, so games from an earlier membership cannot leak in. If a "leave team" feature ever deletes rows, switch the floor to `approved_at` (noted in the ADR). |

---

## Q2: Override versus auto-progression precedence

### Option 2A: Override resets the baseline (drafted)
- **Approach**: an override writes `skill_level`, both override stamps and `skill_level_changed_at = now`. Progression continues from the new level, counting only games after the override. The job never lowers.
- **Time/Space**: O(1) extra; no new column.
- **Pros**: one rule for every level change; no state the admin must remember to clear; the admin's choice wins immediately and permanently until either the admin or 40 new games change it; idempotent saves are possible.
- **Cons**: an admin who lowers a frequent player will see them move up again after 40 more games.

### Option 2B: Override pins the level permanently
- **Approach**: a `skill_level_pinned boolean` (or "override present") makes the job skip the member until an admin un-pins.
- **Pros**: a lowered level stays lowered.
- **Cons**: a new column, a new control ("resume automatic progression") and a new state that is easy to forget; raising a beginner by one level would freeze them there forever unless the admin returns. Contradicts the spec's "never blocks later progression".

### Option 2C: Override blocks progression for a period, baseline unchanged
- **Approach**: no progression for N days after `skill_level_override_at`.
- **Cons**: when the block expires, the games played *before* the override still count, so a member lowered from `ADVANCED` to `INTERMEDIATE` with 60 recent games is promoted again the day the block ends. That defeats the override. A new constant N with no product source. Rejected.

### Option 2D: Override as a ceiling/floor
- **Approach**: a lowered level becomes a cap that progression may not exceed.
- **Cons**: needs a cap column and a way to lift it; same forgetting problem as 2B with more states. Rejected.

### Q2 decision: Option 2A, with these exact rules
1. **Any different level is accepted**, up or down, including the admin's own row (open question (a): yes).
2. **Same level is a no-op**: no stamps, no baseline reset, no event (AC-HAPPY-3 as drafted). Rationale: a double submit or a confirm-what-I-see save must not silently throw away up to 39 games of progress. "Restart the count" is not a v1 action.
3. **Lowering** is allowed; the baseline resets; the job may raise the member again after 40 new games. Recommended copy for UI/UX (hand-off, not decided here): tell the admin when lowering that counting restarts and the member can move up again after 40 games.
4. **Progression never touches** `skill_level_override_by` / `skill_level_override_at`. It sets `skill_level_changed_at`, which is then later than `skill_level_override_at`.
5. **Provenance is derivable** with no extra column: `override_at IS NOT NULL AND changed_at = override_at` → "Set by {admin} · {override_at}"; `changed_at IS NOT NULL` otherwise → "Moved up automatically · {changed_at}"; `changed_at IS NULL` → "Self-assessed". The override `UPDATE` therefore writes the same bound `$now` to both `skill_level_override_at` and `skill_level_changed_at`.
6. **Override is absolute, last writer wins** (no `expectedSkillLevel` in the body). Considered and rejected for v1: optimistic concurrency on the form's displayed level. The only stale case is the job promoting between page load and save; the override then either becomes a no-op ("already {level}") when the admin chose the new level, or wins outright. Neither loses data the admin meant to keep.

### CHECK `skill_level_changed_at >= skill_level_override_at` cannot be broken by progression
Progression writes only when ≥ 40 games have `ends_at` in `(baseline, now]`, which needs `now > baseline ≥ override_at`. So `changed_at = now > override_at`, even under clock skew between the API host (which stamped the override) and the worker. An override writes both columns with one value. The CHECK is a backstop, not a path the job can reach.

---

## Q3: Surplus games after a promotion

### Option 3A: Baseline = time of the change; surplus discarded (drafted)
- **Approach**: `skill_level_changed_at = now` (the decision instant, read after the row lock). The next level needs 40 games that end after that instant.
- **Pseudocode**: `UPDATE ... SET skill_level = $to, skill_level_changed_at = $now`
- **Pros**: one instant, one meaning ("when the level last changed"), used for counting, provenance and display; after a promotion the count is exactly 0 at `now`, so a re-run is a no-op without extra guards; identical semantics for override and progression.
- **Cons**: surplus games are lost. In steady state with a daily job the surplus is the games completed since the previous run beyond the 40th: 0–1 for a 2-games-a-week player, at most a handful for someone playing daily. The large loss case (85 games at once) only happens on a backfill, and production has no games yet.

### Option 3B: Baseline = end of the 40th counted game; surplus carries over
- **Approach**: find the 40th qualifying game in `ends_at` order and set the baseline to its `ends_at`.
- **Time**: O(k log k) per member (ordered scan with `OFFSET 39`) instead of a count.
- **Cons**:
  - Ties: two sessions of the team can end at the same instant; a strict `>` on a single timestamp would drop one of them. A correct baseline needs `(ends_at, session_id)`, i.e. a second column and tuple comparisons everywhere.
  - `skill_level_changed_at` would no longer be when the level changed, so "Moved up automatically · {date}" needs another column (`skill_level_progressed_at`).
  - The spec's run semantics change: a member with 85 games goes `BEGINNER → INTERMEDIATE` on the first run and `→ ADVANCED` on the very next (45 games remain), contradicting AC-HAPPY-5 ("the second run changes nothing").
  - Overrides would still use "time of change", so the baseline would have two meanings.
- **Best For**: products that credit every game exactly (loyalty points). Not this one.

### Option 3C: Cumulative thresholds, no baseline (level = f(count in window): 40 → INT, 80 → ADV)
- **Pros**: no baseline column at all.
- **Cons**: overrides cannot be represented (an override down would be undone at the next run); counts fall as games leave the window, so the function would also demote, which the requirement never asks for; "40 games moves you up a level" becomes "80 for the second level". Rejected.

### Option 3D: Incremental counter column (`games_since_change`) bumped on completion
- **Cons**: needs a write hook in billing (another feature's transaction), drifts on any missed or replayed event, cannot apply the sliding 365-day window without re-deriving from rows anyway. Violates "derive from committed rows" (P1 spirit). Rejected.

### Q3 decision: Option 3A
**`skill_level_changed_at` is defined as**: the UTC instant, from the writer's injected clock, of the last committed write that changed `skill_level` to a *different* value, by admin override or by progression. `NULL` means the level has not changed since the member joined (self-assessed). It is never written by a same-level save, an Auto Enroll save, a ban, or approval. A game counts toward the current level only if it ended strictly after this instant. For progression the instant is read **after** the member row lock is acquired (so it is ≥ every `ends_at` it counted); for an override it is the request's single `now`, also written to `skill_level_override_at`.

---

## Q6: Thresholds as shared constants or configuration

| Option | Pros | Cons |
|--------|------|------|
| **6A Shared constants** in `packages/shared/src/skill/progression.ts` (drafted) | One value for job, API, web copy and tests; dev/prod parity by construction; no boot validation needed | A change needs a deploy |
| 6B Environment variables (P7) | Change without a code change | The value would differ between environments (dev "5 games" vs prod 40) while the UI copy ("of 40") and tests assume one value; P7 is for deployment-specific values (URLs, credentials, flags), and this is a product rule from PRODDUCT-OVERVIEW §2 |
| 6C Per-team columns (`teams.skill_progression_games`) | Clubs could tune it | Not a requirement; new admin UI, validation and migration; out of scope for v1 |
| 6D Settings table | Runtime-editable globally | Same objection as 6B plus a read per decision |

**Decision: 6A.** Export `SKILL_PROGRESSION_GAMES = 40`, `SKILL_PROGRESSION_WINDOW_DAYS = 365` and the derived `SKILL_PROGRESSION_WINDOW_MS = SKILL_PROGRESSION_WINDOW_DAYS * 24 * 60 * 60 * 1000` from the same file (so the grep guard in AC-VERIFY-4 still finds the literals only there). This is not a P7 deviation: P7 governs configuration, and these are domain constants with the same standing as the 15% GST rate. Per-team tuning stays a possible later feature (6C) with no schema conflict.

---

## The sweep: options

### Option S1: One transaction per eligible member (drafted in the NFR)
- **Approach**: keyset over approved non-`ADVANCED` members; for each: begin, lock row, count, decide, guarded update, commit.
- **Time**: O(M × (R + c)) where M = eligible members, R = the member's confirmed registrations in the team, c = transaction overhead (~2–3 ms with round trips).
- **Pros**: simplest; perfect isolation.
- **Cons**: M transactions and M row locks per day although promotions are rare (a member promotes at most every 40 games ≈ every 20 weeks at 2 a week): 12k members ≈ 30–40 s; 120k ≈ 5–6 min, approaching the 900 s queue expiry. Every member row is locked once a day, briefly blocking that member's registrations (`assertApprovedMember` takes `FOR SHARE`).

### Option S2: Read-only keyset pre-pass, then a locked recheck per candidate (chosen)
- **Approach**: each batch (500 members by `id`) runs one read-only query that returns the batch rows with their qualifying-game counts (same predicate builder). In TypeScript, `decideProgression` picks the candidates (count ≥ 40, level < `ADVANCED`). Only candidates get a transaction: lock, re-read, recount, decide again, guarded update.
- **Pseudocode**:
  ```
  function runSkillProgression({ db, clock, logger }):
      runNow = clock.now()
      stats = { scanned: 0, candidates: 0, promoted: 0, skipped: 0, failed: 0 }
      cursor = null
      loop:
          batch = prepassBatch(db, { after: cursor, limit: 500, now: runNow })   // no locks
          if batch is empty: break
          stats.scanned += batch.length
          for row in batch:
              if decideProgression({ level: row.skillLevel, games: row.games }).kind != 'promote': continue
              stats.candidates += 1
              try:
                  r = progressOneMember(db, clock, row.memberId)
                  if r.promoted: stats.promoted += 1; log 'team.member.skill_progressed'
                  else: stats.skipped += 1
              catch err:
                  stats.failed += 1; log 'skill.progression.member_failed' { teamId, userId, errorCode }
          cursor = batch.last.memberId
      log 'skill.progression.completed' stats
      if stats.failed > 0: throw SkillProgressionIncomplete(stats.failed)   // job ends failed, retries

  function progressOneMember(db, clock, memberId):
      transaction(trx):
          SET LOCAL lock_timeout = '5s'
          m = SELECT id, team_id, user_id, status, skill_level, skill_level_changed_at
                FROM team_members WHERE id = memberId FOR NO KEY UPDATE
          if m is null or m.status != 'APPROVED' or m.skill_level == 'ADVANCED':
              return { promoted: false }
          now = clock.now()                                  // after the lock
          games = countQualifyingGames(trx, { teamId: m.team_id, userId: m.user_id, now })
          d = decideProgression({ level: m.skill_level, games })
          if d.kind != 'promote': return { promoted: false }
          n = UPDATE team_members
                 SET skill_level = d.to, skill_level_changed_at = now        -- only these two columns
               WHERE id = m.id AND status = 'APPROVED' AND skill_level = d.from
                 AND skill_level_changed_at IS NOT DISTINCT FROM m.skill_level_changed_at
          if n != 1: throw ProgressionGuardMiss                              // unreachable under the lock
          return { promoted: true, from: d.from, to: d.to, games }
  ```
- **Time**: pre-pass O(M × R) index work in M / 500 statements; transactions O(P) where P = candidates (≈ promotions, a few per day).
- **Space**: O(500) rows in memory.
- **Pros**: transactions and locks only where a promotion is likely; the authoritative decision is still made under the lock with a fresh count, so the pre-pass can be stale without harm; per-candidate isolation as AC-ERROR-7 requires; the keyset cursor visits each member at most once per run (so at most one level per run, independent of the baseline argument).
- **Cons**: two code paths read the count (batch and single) → mitigated by one SQL predicate builder and a parity test. A member who crosses 40 between the pre-pass and the end of the run is promoted at the next run (inside the accepted one-day lag).

### Option S3: One set-based `UPDATE ... FROM (counts) WHERE games >= 40` per batch
- **Time**: fastest, O(M × R) in M / 500 statements, no per-member round trips.
- **Cons**: a single failing row rolls back the whole batch (fails AC-ERROR-7 isolation); the decision rule is duplicated in SQL instead of `decideProgression` (fails AC-VERIFY-4/AC-HAPPY-11 "one rule"); per-member events need `RETURNING` plus `from` reconstruction; row locks are taken in plan order across many members at once. Rejected.

### Option S4: Event-driven (billing enqueues per-member checks on `COMPLETED`)
- **Pros**: near-real-time; work proportional to games played.
- **Cons**: requires a hook in wallet-and-akahu-billing (not built, other owner); still needs a periodic sweep for window expiry, overrides and missed events; more jobs. Lag is already accepted. Deferred: a later optimisation could have billing enqueue `skill-progression` with a `teamId` payload after completing a session.

### Complexity Comparison (sweep)

| Metric | S1 per-member txn | **S2 pre-pass + candidate txn** | S3 set-based UPDATE | S4 event-driven |
|--------|-------------------|----------------------------------|---------------------|-----------------|
| Time (best) | O(M) txns, all counts 0 | O(M/500) reads, 0 txns | O(M/500) statements | O(games completed) |
| Time (avg) | O(M·R) + M·c | O(M·R) + P·c, P ≪ M | O(M·R) | O(games) + periodic sweep |
| Time (worst) | O(M·R) + M·c | O(M·R) + M·c (everyone a candidate: backfill) | O(M·R) | O(games) + sweep |
| Row locks per run | M | P | P (in one statement) | per event |
| Space | O(1) | O(500) | O(500) | O(1) |
| Failure isolation | per member | per candidate | per batch | per event |
| Implementation | Simple | Medium | Simple SQL, rule duplicated | Complex, cross-feature |

---

## Count query and index

### One predicate, three entry points
A single Kysely/`sql` builder `qualifyingGamesFor(tmAlias, now)` produces the join and `WHERE` below. It is used by:
- `countQualifyingGames(db | trx, { teamId, userId, now })` — scalar; the authoritative count inside the progression transaction (signature unchanged from the spec);
- `countQualifyingGamesForMembers(db, { teamId, userIds, now })` — one query for a Members page (≤ 50 users) returning `Map<userId, games>`;
- `prepassBatch(db, { after, limit, now })` — the sweep's batch read.

```sql
-- $now and $window_start = $now - SKILL_PROGRESSION_WINDOW_MS are bound parameters (P3: no now() in SQL)
SELECT count(*)
  FROM team_members tm
  JOIN registrations r
    ON r.team_id = tm.team_id AND r.user_id = tm.user_id AND r.status = 'CONFIRMED'
  JOIN game_sessions s
    ON s.id = r.session_id AND s.team_id = r.team_id AND s.status = 'COMPLETED'
 WHERE tm.team_id = $team_id AND tm.user_id = $user_id
   AND s.ends_at <= $now
   AND s.ends_at > greatest($window_start::timestamptz,
                            coalesce(tm.skill_level_changed_at, '-infinity'::timestamptz));
```

Pre-pass shape (per batch):
```sql
WITH batch AS (
  SELECT id, team_id, user_id, skill_level, skill_level_changed_at
    FROM team_members
   WHERE status = 'APPROVED' AND skill_level <> 'ADVANCED' AND id > $after   -- $after omitted on the first batch
   ORDER BY id
   LIMIT 500)
SELECT b.id, b.team_id, b.user_id, b.skill_level, q.games
  FROM batch b
  CROSS JOIN LATERAL (<qualifyingGamesFor(b, $now)> ) q
 ORDER BY b.id;
```
Inside the progression transaction the scalar count reads the same `team_members` row that is locked, so it sees the baseline the decision uses.

### Index
| Option | Definition | Assessment |
|--------|-----------|------------|
| Drafted | `registrations (team_id, user_id) WHERE status = 'CONFIRMED'` | Finds the member's confirmed rows, but every match needs a heap visit to read `session_id` before the join |
| **Chosen** | `registrations (team_id, user_id, session_id) WHERE status = 'CONFIRMED'` | Same selectivity plus `session_id` in the key, so the registrations side is an index-only scan (once vacuumed); then one `game_sessions` primary-key probe per row to test `status` and `ends_at`. Partial: `WAITLISTED`/`WITHDRAWN` rows never enter it |
| Session-driven | `game_sessions (team_id, ends_at) WHERE status = 'COMPLETED'` driving `idx_registrations_session_status` | Better when one member has thousands of all-time registrations but only ~100 in the window. Not needed at v1 scale; keep as the first optimisation if `EXPLAIN` shows registrations scans dominating at 10x |
| Existing `idx_registrations_user (user_id, registered_at DESC)` | — | All statuses and teams; the planner should prefer the partial index. The Phase 2 `EXPLAIN` check asserts that it does |

No new index on `team_members` for the sweep: the keyset walks the primary key and filters `status`/`skill_level` (most rows qualify). No `ends_at` bound can be pushed down to registrations (`registered_at` has no lower bound relative to `ends_at`), so the per-member cost is O(all-time confirmed registrations in the team), which is small (~100/year).

---

## Complexity Comparison (decisions)

| Question | Chosen | Time per member | Extra space | Implementation |
|----------|--------|-----------------|-------------|----------------|
| Q1 qualifying game | 1A + upper bound | O(R) index + R PK probes | none | Simple |
| Q2 precedence | 2A reset baseline | O(1) | none (provenance derived) | Simple |
| Q3 surplus | 3A discard | O(1) write; count stays O(R) | 1 column | Simple |
| Q3 alternative 3B | carry over | O(R log R) ordered scan | 2–3 columns | Medium, breaks AC-HAPPY-5 |
| Q6 constants | 6A shared constants | — | — | Simple |
| Sweep | S2 | O(R) read; txn only for candidates | O(500) | Medium |

## Performance Projection

Assumptions: R ≈ 100 confirmed registrations per member in the window, ≤ 300 all-time; a PK probe ≈ 1–3 µs warm; a short transaction with 4 round trips ≈ 2–4 ms locally.

| Path | Current planning scale (12k members) | 10x (120k members) |
|------|--------------------------------------|--------------------|
| Pre-pass, per 500-member batch | ~500 × 200 probes ≈ 0.1 M probes ≈ 50–150 ms | same per batch |
| Pre-pass, whole run (M/500 batches) | 24 batches ≈ 2–4 s | 240 batches ≈ 20–40 s |
| Candidate transactions | a few per day × 3 ms | tens per day × 3 ms |
| Backfill worst case (everyone a candidate) | 12k × 3 ms ≈ 40 s | 120k × 3 ms ≈ 6 min (inside 900 s; see bottlenecks) |
| Members page counts (≤ 50 rows) | 1 query, ~50 × 200 probes ≈ 5–15 ms | same (per-page bounded) |
| Option S1 for comparison (whole run) | ≈ 30–40 s, 12k locks | ≈ 5–6 min, 120k locks |

Memory: one batch of 500 small rows (< 100 KB).

---

## Decision

**Chosen**:
- **Q1**: Option 1A — a qualifying game is a `CONFIRMED` registration of the member in a `COMPLETED` session of the same team whose `ends_at` lies in `(greatest(now − 365×24 h, skill_level_changed_at), now]`. No-shows count (no data); charged late withdrawals do not.
- **Q2**: Option 2A — an override of a different level always applies, up or down, stamps who/when and resets the baseline; same-level saves are no-ops; progression never lowers and never touches override stamps.
- **Q3**: Option 3A — the baseline is the instant of the change; surplus games are discarded; `skill_level_changed_at` = time of the last actual level change (definition above).
- **Q6**: Option 6A — shared constants, with the window also exported in milliseconds.
- **Sweep**: Option S2 — keyset pre-pass (500 by `id`, read-only, same predicate) then, per candidate, `FOR NO KEY UPDATE` lock with `lock_timeout` → re-read status/level/baseline → `now` after the lock → recount → `decideProgression` → guarded two-column `UPDATE`; per-candidate failure isolation; job fails at the end when `failed > 0`.
- **Index**: partial `registrations (team_id, user_id, session_id) WHERE status = 'CONFIRMED'`.

### Rationale
- Every choice makes the count a pure function of committed rows and one `now`, so the job, the page and the tests agree by construction (AC-HAPPY-11) and nothing needs to be stored except one timestamp.
- Using the change instant as the baseline (3A) gives one meaning to `skill_level_changed_at` for both writers, lets the UI derive provenance without a new column, and makes re-runs no-ops by arithmetic rather than by extra state. Carry-over (3B) would cost two columns, tie handling and a change to AC-HAPPY-5 to save a handful of games per promotion.
- Override-resets-baseline (2A) is the only option where the admin's decision is never undone by games played before it, without introducing a state (pin, block) the admin must remember to clear.
- S2 keeps S1's per-member safety where it matters (candidates) and drops ~99% of the transactions and row locks, which keeps the run far inside the queue expiry at 10x and stops the job from briefly blocking every member's registrations daily.
- Counting `ends_at` with a strict lower bound and an inclusive upper bound at `now` is consistent with the baseline being set to `now`: each game belongs to exactly one level.

### Idempotency and race proofs (AC-ASYNC-2, AC-VERIFY-5)
- **Re-run / redelivery**: a promotion at decision instant `t` sets the baseline to `t`. Every game it counted had `ends_at <= t`. A later count at `t' ≥ t` needs `ends_at > t`, so only games ending after the promotion count; within the same day that is 0 or a few. No second promotion until 40 new games.
- **Concurrent runs**: the queue is `exclusive`; without it, the member lock serialises the two transactions and the second recounts against the first's baseline (previous point). The guard (`skill_level = $from AND skill_level_changed_at IS NOT DISTINCT FROM $baseline`) is a backstop if the lock is ever removed.
- **Override vs progression, job first**: the override's transaction waits on the member row (after taking the team lock), then reads the promoted level: a different level wins (last writer), the same level is a no-op. **Override first**: the job's lock waits, then re-reads the override baseline, counts ≈ 0, writes nothing. A promotion decided on a pre-override count never lands, because the count is redone under the lock.
- **Ban vs progression**: the ban takes the team lock, then the member row; the job holds only the member row and takes no other lock, so there is no cycle. Job first → the ban waits milliseconds. Ban first → the job reads `BANNED` and skips.
- **Lock order**: the job's only lock is one `team_members` row; its `UPDATE` sets neither `status` nor `role`, so neither membership trigger fires and no `teams` lock is taken (see Constraints).
- **CHECK safety**: shown under Q2; progression can never violate `changed_at >= override_at`.

### Trade-offs Accepted
- **No-shows count.** Acceptable without attendance data; one predicate change later.
- **Surplus games are discarded.** A few games per promotion in steady state; documented in the ADR and visible as "0 of 40" after a move.
- **A game in billing's pipeline at the moment of a level change is never counted** (it ended before the baseline but was not yet `COMPLETED`). Billing runs every 5 minutes, so this is at most the games that ended in the few minutes before a change. Accepted.
- **Lowering is not sticky.** An admin who wants to hold a level must re-override after a later promotion. A pin can be added later without changing these semantics.
- **Progress can go down** as old games leave the 365-day window, and the page can show 40 or more before the next run. The UI must handle `games >= required` (hand-off).
- **Clock skew** between API and worker hosts of a few seconds can let a game ending in that gap count on both sides of a change. Sessions end on court times, so this is theoretical.

## Implementation Details

### Data Structures
| Structure | Purpose | Operations Used |
|-----------|---------|-----------------|
| `team_members.skill_level_changed_at timestamptz NULL` | Counting baseline and provenance | O(1) read/write |
| Partial index `idx_registrations_confirmed_member (team_id, user_id, session_id) WHERE status = 'CONFIRMED'` | Count lookup | O(log N + R) range scan |
| `game_sessions` primary key | `status`/`ends_at` probe per registration | O(log N) per probe |
| `decideProgression({ level, games })` (pure, shared) | The rule | O(1) |
| Keyset cursor on `team_members.id` | Sweep batching, visit once per run | O(log N + 500) per batch |

`nextSkillLevel`: `BEGINNER → INTERMEDIATE → ADVANCED → null`. `decideProgression`: `promote` iff `next != null && games >= SKILL_PROGRESSION_GAMES`.

### Algorithm Steps
1. **Run start** — `runNow = clock.now()`; start one span `skill-progression.run`.
2. **Pre-pass batch** — read 500 approved non-`ADVANCED` members after the cursor with their counts at `runNow`; no locks.
3. **Select candidates** — `decideProgression` in TypeScript (the same function the transaction uses).
4. **Per candidate** — own transaction: `SET LOCAL lock_timeout = '5s'` (a code constant `PROGRESSION_LOCK_TIMEOUT`), lock the row `FOR NO KEY UPDATE`, skip unless `APPROVED` and below `ADVANCED`, `now = clock.now()`, `countQualifyingGames`, decide, guarded `UPDATE` of `skill_level` and `skill_level_changed_at` only, log `team.member.skill_progressed` with `teamId`, `userId`, `from`, `to`, `games` after commit.
5. **Isolate failures** — catch per candidate; log `skill.progression.member_failed` with `teamId`, `userId`, `errorCode` (SQLSTATE such as `55P03` for a lock timeout, or a domain code); child span only on failure.
6. **Advance the cursor** to the last `id` of the batch; repeat until a batch is empty.
7. **Summarise** — log `skill.progression.completed` with `scanned`, `candidates`, `promoted`, `skipped`, `failed`; if `failed > 0`, throw so pg-boss records the job as failed and retries (retry re-sweeps safely).

The Members page (`GET /teams/:id/members?status=APPROVED`) calls `countQualifyingGamesForMembers` once for the page's non-`ADVANCED` user ids with the request's `now`, and maps to `skillProgress = { games, required: SKILL_PROGRESSION_GAMES, nextLevel }`, or `null` at `ADVANCED`.

### Edge Case Handling
| Edge Case | Handling |
|-----------|----------|
| No-show | Counted (no data); one-clause change point in `qualifyingGamesFor` |
| Charged late withdrawal | Not counted (`status <> 'CONFIRMED'`) |
| `COMPLETED` session with `ends_at > now` | Not counted (upper bound) |
| `ends_at` = baseline | Old level only (strict `>` after, `<=` before) |
| `ends_at` = `now − 365×24 h` | Excluded |
| 85 games at `BEGINNER` | One level this run (cursor visits once; baseline resets); 45 discarded |
| Member at `ADVANCED` | Not scanned; `skillProgress = null` |
| Banned / no longer approved under the lock | `skipped`, no write |
| Override between pre-pass and lock | Recount ≈ 0 → `skipped` |
| Count dropped below 40 between pre-pass and lock | `skipped` |
| Same-level override | No-op, no baseline change |
| Lowering override | Applied, baseline reset, may rise again after 40 games |
| No games anywhere (production at launch) | All counts 0, nothing promoted, run summary still logged |

### Error Handling
| Error Condition | Response |
|-----------------|----------|
| Lock timeout on a member row (`55P03`) | `member_failed` (`errorCode: '55P03'`), continue; job ends failed and retries |
| CHECK or other constraint violation (`23514`, …) | `member_failed` with the SQLSTATE; continue; job ends failed (should be unreachable; surfaces a bug) |
| Guarded `UPDATE` affects 0 rows under the lock | `member_failed` (`errorCode: 'progression_guard_miss'`); unreachable while the lock is held |
| Pre-pass query fails (DB down) | The run throws immediately; pg-boss retries with backoff (retryLimit 3); idempotent |
| Worker crash mid-run | Redelivery re-sweeps; already-promoted members count ≈ 0 and are not candidates |
| Job exceeds expiry | Treated as a crash by pg-boss (redelivery); at the projected durations this needs > 20x scale |

## Performance Expectations

### At Current Scale
- Expected latency: whole run ≈ 2–4 s; Members page progress ≈ 5–15 ms extra (one query).
- Memory usage: < 1 MB in the worker.
- Throughput: ~5k members/s scanned in the pre-pass; promotions limited only by transaction latency (~300/s).

### At 10x Scale
- Expected latency: run ≈ 20–40 s; backfill worst case ≈ 6 min (inside the 900 s expiry).
- Memory usage: unchanged (batch-bounded).
- Bottlenecks: per-member all-time registration scans in the pre-pass (O(R_all-time)), and a mass backfill turning everyone into a candidate.

### Optimization Opportunities
- Session-driven count (`game_sessions (team_id, ends_at) WHERE status = 'COMPLETED'`) if long-tenured members make all-time scans dominate.
- Skip teams with no `COMPLETED` session since the previous successful run (needs a run-watermark; not worth it now).
- Billing enqueues a team-scoped `skill-progression` after completing a session (S4) if same-day promotion is ever wanted.
- Raise `expireInSeconds` for this queue if a backfill at large scale approaches it.

## Hand-offs (other lanes)
- **Architecture**: C-GAME-1 in ADR 0017 should state: (1) a game is a `CONFIRMED` registration in a `COMPLETED` session; (2) `COMPLETED` is terminal and only billing sets it; (3) a `COMPLETED` session's `CONFIRMED` rows are never withdrawn and its `ends_at` is never changed afterwards (session-scheduling-engine must refuse court edits on completed sessions; the `session_courts` trigger would otherwise move `ends_at`); (4) if attendance is added, it is applied inside `qualifyingGamesFor`; (5) the baseline floor switches to `approved_at` if `team_members` rows ever become deletable.
- **UI/UX**: `skillProgress.games` may be ≥ `required` before the next run and may go down as games leave the window; choose copy for "ready to move up at the next daily check" or clamp the display. Consider telling the admin, when lowering, that counting restarts and the member can move up again after 40 games. Consider disabling "Save skill level" when the selection equals the current level (the API still answers with the no-op message).

## Spec changes required (for the orchestrator)
1. **AC-VERIFY-3**: add the upper bound `ends_at <= now` and a table row "a `COMPLETED` session whose `ends_at` is after `now` is excluded" (and "one ending exactly at `now` is included"); state that the window start is `now − SKILL_PROGRESSION_WINDOW_MS` computed in TypeScript and bound as a parameter (no SQL `interval '365 days'`); state that the lower bound is `greatest(windowStart, skill_level_changed_at)`; add "a charged late withdrawal (`WITHDRAWN`, `withdrawal_fee_due = true`) is excluded" explicitly. Replace "one function is used by the job and by the row's progress line" with "one predicate builder (`qualifyingGamesFor`) backs `countQualifyingGames`, `countQualifyingGamesForMembers` and the sweep's pre-pass; a parity test asserts the batch and pre-pass forms equal the scalar for every table row".
2. **AC-HAPPY-11**: "the figure comes from the same counting predicate the job uses (batch form, one query per page)".
3. **AC-ASYNC-2**: the guard becomes `WHERE id = $id AND status = 'APPROVED' AND skill_level = $from AND skill_level_changed_at IS NOT DISTINCT FROM $baseline`, taken under a `FOR NO KEY UPDATE` row lock with the decision `now` read after the lock.
4. **AC-ERROR-7 / AC-VERIFY-6**: the run summary fields are `scanned`, `candidates`, `promoted`, `skipped`, `failed`.
5. **AC-VERIFY-5**: add "the progression `UPDATE` sets only `skill_level` and `skill_level_changed_at` (never `status` or `role`), so no `team_members` trigger takes a `teams` lock"; the job's member lock uses `lock_timeout` so a blocked member fails fast into `member_failed`.
6. **AC-VERIFY-4**: also export `SKILL_PROGRESSION_WINDOW_MS`, derived in the same file.
7. **NFR Performance** and the Phase 1 migration: the index is `registrations (team_id, user_id, session_id) WHERE status = 'CONFIRMED'`; the sweep is "a read-only keyset pre-pass (500 members per batch) computes counts without locks; one transaction per candidate (count ≥ 40) locks, recounts and decides" instead of "one transaction per member".
8. **Data persisted / AC-HAPPY-1**: add the definition of `skill_level_changed_at` from Q3 and the rule that the override writes the same `$now` to `skill_level_override_at` and `skill_level_changed_at` (provenance is derived from their equality).
No change to AC-HAPPY-3, -4, -5, -6 or AC-HAPPY-2: the drafted defaults for Q2 and Q3 stand.

## Validation Checklist

- [x] Meets latency requirements (one extra query per Members page; run in seconds at planning scale)
- [x] Meets memory requirements (batch-bounded)
- [x] Handles all edge cases (table above)
- [x] Scales to expected data size (10x inside the queue expiry, backfill included)
- [x] Implementation feasible (Kysely `sql` builder, existing job runner, existing lock helpers)
- [x] Respects Guiding Principles and data flow patterns in systemPatterns.md (P1 derived from committed rows + CHECKs; P3 bound UTC instants, absolute window; P5 progression only in the job; P7 not applicable to domain constants; lock order `teams` → `team_members` preserved, job never locks `teams`)

## Testing Strategy

### Unit Tests
- `decideProgression` for every level × {0, 39, 40, 41, 400}; `nextSkillLevel`; `SKILL_PROGRESSION_WINDOW_MS === 365 * 86_400_000`.
- Grep guard: literals 40 and 365 for this rule only in `progression.ts` and its test.
- Provenance derivation (web view model): `changed_at = override_at` → override; later `changed_at` → automatic; `NULL` → self-assessed.

### Integration Tests (real PostgreSQL)
- `countQualifyingGames` table: each inclusion/exclusion row from AC-VERIFY-3 plus the new upper-bound and charged-late-withdrawal rows; boundaries at exactly 365×24 h, exactly the baseline, exactly `now`, and one millisecond on either side.
- Parity: for each table row, scalar = batch (`countQualifyingGamesForMembers`) = pre-pass value.
- `EXPLAIN (FORMAT JSON)` of the scalar count uses `idx_registrations_confirmed_member`.
- Job: 40 vs 39; 85 → one level per run, then 0 on immediate re-run; override resets baseline (38 + override + 2 → stays; + 38 more → promotes); lowering then 40 games → promoted again; ADVANCED untouched; banned member skipped.
- Races (`lock-waiters.ts`, injected clock advanced between steps): override vs progression both orders; ban vs progression both orders; two concurrent runs → exactly one level; CHECKs hold after each.
- Failure isolation: force one candidate to fail (e.g. hold its row lock past `lock_timeout`) → others promoted, `member_failed` logged with `errorCode`, job ends failed; retry succeeds and promotes nobody twice.
- The progression `UPDATE` does not fire `team_members_guard_update` or `team_members_last_admin_on_update` (assert no `teams` lock is requested: a concurrent `teams FOR UPDATE` holder does not block the job).

### Performance Tests
- Seed 5k members × 100 confirmed registrations; assert a full run completes under a generous bound (e.g. 30 s in CI) and the Members page count query for 50 users under 50 ms. Documented, not a CI gate, if timing is flaky.
- 10x stress (manual): 50k members; record run time and `EXPLAIN ANALYZE` of one pre-pass batch.

## Next Steps

1. Phase 1: migration adds `skill_level_changed_at`, the four CHECKs and the `(team_id, user_id, session_id) WHERE status = 'CONFIRMED'` partial index; shared `progression.ts` with the three constants, `nextSkillLevel`, `decideProgression`.
2. Phase 2: `qualifyingGamesFor` builder, `countQualifyingGames`, `countQualifyingGamesForMembers`, parity and boundary tables, `EXPLAIN` check; C-GAME-1 text (with the hand-off clauses above) in ADR 0017.
3. Phase 3: override `UPDATE` writes one `$now` to both stamps and the baseline; same-level no-op; Members list uses the batch count.
4. Phase 4: `skill-progression` queue (`exclusive`), slot `30 5 * * *` Pacific/Auckland, handler per the S2 pseudocode, failure isolation, race tests, CLI trigger.
