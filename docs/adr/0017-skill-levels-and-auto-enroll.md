# ADR 0017: Skill levels, Auto Enroll and the cross-feature contracts

- Status: Accepted (2026-10-17)
- Task: skill-levels-and-auto-enroll
- Source: [Seams architecture, "Cross-Feature Contracts (content for ADR 0017)"](../../memory-bank/creative/skill-levels-and-auto-enroll-seams-architecture.md); [Progression algorithm Q1 to Q3, Q6 and "Hand-offs"](../../memory-bank/creative/skill-levels-and-auto-enroll-progression-algorithm.md); task file "Binding Reconciliation" decisions 1 to 5 and the design amendments. Migration `20261017000100000_skill_levels_and_auto_enroll.sql` (ledger D-55 to D-61).
- Numbering: ADR 0016 told registration-and-waitlist to renumber to 0017, and that branch is still unmerged, so both branches now target 0017 and D-55 onwards. Whichever of the two merges second renumbers its ADR and its D-numbers. Contract names (C-GAME-1, C-SKL-1, C-PRICE-1) are stable across a renumber, so tests and code comments cite them, not only this file's number.

## Context

Two later features consume what this one produces, and a third defines what it counts:

- session-scheduling-engine's materialiser must pre-fill new sessions for members who turned on Auto Enroll, in a fair, repeatable order.
- registration-and-waitlist owns registrations and the allocator, and wallet-and-akahu-billing completes sessions. Together they decide what a "game" is, which drives automatic skill progression.
- registration-and-waitlist prices `BY_SKILL_LEVEL` sessions from a member's level, which this feature changes.

None of those features is on `main`. This feature therefore delivers two lock-free read seams, proves them against real rows seeded through the factories, and writes down the obligations the other features must meet. Until session-scheduling-engine and registration-and-waitlist ship, no application code writes `registrations` or `game_sessions`, so every game count is zero in production and the progression job promotes nobody.

## Decision

### C-GAME-1: what a game is (owners: registration-and-waitlist, wallet-and-akahu-billing)

1. **Definition** (owned here, one SQL definition in `apps/api/src/modules/skill-levels/games.ts`): a qualifying game for member M of team T at time `now` is a `registrations` row with `user_id = M`, `team_id = T` and `status = 'CONFIRMED'`, joined to its `game_sessions` row with `status = 'COMPLETED'` and `ends_at` in `(greatest(now - SKILL_PROGRESSION_WINDOW_MS, skill_level_changed_at), now]`.
   - The window start is computed in TypeScript from the shared constant and bound as a parameter. The SQL never uses `interval '365 days'` or `now()`. A NULL baseline means no lower bound beyond the window.
   - One registration is one game, whatever the party size, guest count or payment state.
   - No-shows count, because no attendance data exists. If attendance is ever recorded, the predicate gains one clause in `qualifyingGamesQuery`.
   - A charged late withdrawal does not count: that registration is `WITHDRAWN`.
   - A completed session whose `ends_at` is after `now` does not count yet (the upper bound).
2. **Registration obligation**: once a session is `COMPLETED`, none of its `registrations` rows changes `status`. The allocator already refuses with `session_not_open`, and the ban handler touches only future `PUBLISHED` sessions. Recommended backstop for registration-and-waitlist: a trigger that refuses a `registrations.status` change when the session is `COMPLETED`.
3. **Billing obligation**: sessions become `COMPLETED` only through billing's `PUBLISHED` to `COMPLETED` transition (C-BIL-1), `COMPLETED` is terminal, and a completed session's `ends_at` is never edited afterwards. session-scheduling-engine must refuse court edits on completed sessions, because the `session_courts` trigger would otherwise move `ends_at`. If a completed session were ever reverted, counts would drop and nobody would be demoted. That is safe, but billing's ADR must record it as a deliberate decision.
4. **Denormalisation relied on**: `registrations.team_id` equals its session's `team_id` (composite foreign key, D-10). The count filters `registrations.team_id` directly and joins the session on `(id, team_id)`.
5. **Reads only**: counting takes no locks and reads only committed rows. Callers may pass a transaction.
6. **The `approved_at` floor note**: the counting baseline for a member whose level never changed is `-infinity` (`skill_level_changed_at IS NULL`). That is correct today because no `team_members` delete path exists in v1, `BANNED` is terminal, and a `REJECTED` to `PENDING` member has no games, so games from an earlier membership cannot leak in. If a "leave team" feature ever makes `team_members` rows deletable (so a re-join creates a new row for the same person), the floor must switch to `approved_at`.
7. **One predicate, three entry points**: `qualifyingGamesQuery` backs `countQualifyingGames` (the authoritative single-member count the progression job recounts under its lock), `countQualifyingGamesBatch` (one query for a page of up to 50 members) and, in Phase 4, the sweep's read-only pre-pass. A parity test asserts the single and batch forms agree.
8. **Index**: `idx_registrations_confirmed_member (team_id, user_id, session_id) WHERE status = 'CONFIRMED'` (D-60). `skill-levels-games.int.test.ts` asserts through `EXPLAIN` that the count plan uses it.

### C-SKL-1: auto-enrol selection (consumer: session-scheduling-engine)

1. **Seam**: `selectAutoEnrollees(db | trx, { teamId, sessionDate: LocalDate })` in `apps/api/src/modules/skill-levels/auto-enrol.ts` returns `readonly { userId, membershipId, assignedAt }[]`. It is a plain `SELECT` over `team_id = T AND status = 'APPROVED' AND is_auto_enroll AND (auto_enroll_until IS NULL OR auto_enroll_until >= sessionDate)`, ordered `auto_enroll_assigned_at ASC, id ASC`. It takes no row locks, and a test proves it completes while another transaction holds `FOR UPDATE` on every member row. `sessionDate` is the session's `game_sessions.date`, never derived from `starts_at`.
2. **Until-date semantics**: inclusive. A member with `until = 30 Nov` is selected for a 30 Nov session and not for 1 Dec. The flag stays true after the date passes and the predicate does the work, so no cleanup job exists. **An expired Auto Enroll counts as off** (reconciliation decision 3): the panel shows it unticked with an "ended" note, and an enabled save on such a row is a new assignment (`auto_enroll_assigned_at = now`, back of the order). Changing only `until` on a row that has not expired keeps its place.
3. **Call sequence** (registration-and-waitlist C-SAE-1 and C-SAE-2): after the session is `PUBLISHED` (in this or an earlier transaction), call `selectAutoEnrollees`, then call `allocator.autoEnrolInSession(ctx, { teamId, sessionId, userIds })` **once per session** with the `userId`s **in the returned order**. Parties have no guests. The materialiser never writes `registrations` directly. Per-member refusals (`overdue_payments`, `forbidden`, `already_registered`) are skips, not failures.
4. **The allocator re-checks the opt-out (reconciliation decision 5, an obligation on registration-and-waitlist)**: inside `autoEnrolInSession`, under its `team_members` row lock and before it creates a registration, the allocator re-checks `is_auto_enroll`, `auto_enroll_until >= session date` and `auto_enroll_assigned_at` equal to the value `selectAutoEnrollees` returned for that member. Turning Auto Enroll off is therefore authoritative at registration time even though the selection took no locks. A member who was turned off and on again between selection and allocation has a new `assigned_at`, so the stale selection is refused too. The contract test header in `skill-levels-games.int.test.ts` carries this obligation, and a deterministic race test lands with whichever feature ships the allocator. Without the re-check, an opt-out that commits between selection and allocation could still register and charge that member.
5. **Lock-order advisory for session-scheduling-engine** (re-check at its plan). The canonical order is `teams`, then `team_members`, then `game_sessions` (ADR 0015, ADR 0016). The selection takes no locks. The allocator gates members (`team_members FOR SHARE`) before it takes the session lock, and the progression job locks only a member row and never `teams`. When auto-enrol runs in the **same** transaction that inserted the session row, the uncommitted row is invisible to other transactions, so taking `team_members` afterwards cannot deadlock. When a materialiser publishes a session that **already existed** (for example ADR 0016's retry of a DRAFT instance), it must run auto-enrol in a **follow-up transaction** that has not locked that session. Otherwise it takes `game_sessions` before `team_members`, against C-ALL-1.
6. **Which sessions**: only recurrence materialisation (workflows section 4). Whether a manually created one-off session triggers auto-enrol is an open question owned by session-scheduling-engine. The seam works either way.
7. **Not retroactive**: an Auto Enroll change applies to sessions materialised after it commits. Turning it on never registers the member into sessions that already exist, and turning it off never withdraws them.
8. **Benign race**: the selection takes no locks, so an opt-out that commits between selection and allocation can only be caught by the allocator's re-check in point 4. A ban cannot slip through in any case, because `assertApprovedMember` refuses non-`APPROVED` members.

### C-PRICE-1: level changes and pricing (decision 1; an obligation on registration-and-waitlist, flagged to that branch)

A registrant's `BY_SKILL_LEVEL` tier is **snapshotted when the registration becomes `CONFIRMED`**, and billing charges from that snapshot.

- registration-and-waitlist must add the snapshot, for example `registrations.registrant_skill_level skill_tier NOT NULL`, mirroring `registration_guests.skill_level`, and `listBillableRegistrations` must return it instead of reading `team_members.skill_level` at charge time. As designed today (allocation-algorithm hand-off rule 7, `BillableRegistration.registrantSkillLevel`) it reads the level at charge time, so a change between registering and billing would change a charge and make the fee shown at registration wrong.
- A level change, by override or by promotion, **never reprices an existing registration**. This feature writes none of `registrations`, `registration_guests`, `payments` or `payment_line_items`, and issued payments already snapshot the applied fee basis (ADR 0012).
- Timing holds under either design: billing completes a session at the same moment its games become countable, and progression runs the next morning, so the game that triggers a promotion is always billed at the old level.
- Self-override stays allowed (decision 2). It is safe because of this snapshot: an admin cannot lower their own billable tier for a registration that is already `CONFIRMED`.
- Later obligations that follow from it, owned by the features named: priced fees name the level used (registration-and-waitlist, wallet-and-akahu-billing), and auto-enrolled registrations are labelled as such and emailed to the player (registration-and-waitlist).

### Progression and visibility (recorded for operators and later features)

- **Automatic progression**: queue `skill-progression` (`exclusive`), cron `30 5 * * *` Pacific/Auckland, operator command `pnpm run jobs:trigger skill-progression`. The payload is ignored. A member at `BEGINNER` or `INTERMEDIATE` moves up exactly one level at 40 qualifying games (`SKILL_PROGRESSION_GAMES`) and never down. The change instant becomes the new counting baseline (`skill_level_changed_at`), so surplus games are discarded and the next level needs 40 new games. An admin override of a different level also resets the baseline and never freezes progression.
- **Locks**: the job locks the member row only (`FOR NO KEY UPDATE`), never `teams`, and its `UPDATE` sets only `skill_level` and `skill_level_changed_at`. It never sets `status` or `role`, so neither membership trigger fires and no `teams` lock is taken.
- **Reserved keys and names** (none is used yet, so a later feature must not repurpose them):
  - `skill-progression-member:<membershipId>`: idempotency key for an event-driven per-member progression check, if billing ever enqueues one on `COMPLETED` (compatible with the daily sweep, which stays as reconciliation).
  - `skill-progressed:<membershipId>:<skill_level_changed_at ISO>`: idempotency key for a "you moved up" email, if one is added inside the promotion transaction.
  - Metric names for when the exporter exists: `skill_progression_runs_total{outcome}`, `skill_progression_promotions_total{from,to}`, `skill_progression_member_failures_total{error_code}`, `skill_progression_run_duration_seconds`, `team_member_skill_overrides_total`, `team_member_auto_enroll_changes_total{enabled}`.
- **Player visibility is admin-only in v1**: only team admins see a member's level, provenance, progress and Auto Enroll state, and no email or push is sent on a promotion. A player-facing level or notification is a later feature.

## Alternatives considered

- **Extend the `teams` module (no new module).** Grows `teams/service.ts` and `repo.ts` by about 40% and blurs which feature owns C-GAME-1 and C-SKL-1.
- **A skill-levels-owned `autoEnrolSession` that selects and calls the allocator.** Out of scope (this feature does not call the allocator) and needs the allocator's unmerged types. It can be added later without changing the seam.
- **Selection with `FOR SHARE` on member rows.** The materialiser may already hold the session row, so this would add a lock-order edge and duplicate the allocator's gate. The allocator's re-check (C-SKL-1 point 4) closes the race without it.
- **A SQL view for the selection.** A view cannot guarantee order, so a TypeScript wrapper is still needed, plus a schema object and ledger entry.
- **Count by `date` or by completion time.** A `date` cannot be compared with an instant baseline, and no `completed_at` column exists.
- **Carry surplus games over after a promotion.** Needs a tie-safe second baseline column and breaks the one-level-per-run rule.
- **Snapshot nothing and price at charge time (C-PRICE-1 rejected).** A promotion would silently change a player's next charge and make the registration-time fee wrong.

## Consequences

- registration-and-waitlist's plan and build gate must cite this ADR: the C-GAME-1 freeze (point 2), the allocator re-check (C-SKL-1 point 4) and the C-PRICE-1 snapshot column. session-scheduling-engine's plan must cite C-SKL-1 (call sequence, lock-order advisory, one-off sessions). wallet-and-akahu-billing's plan must cite C-GAME-1 point 3.
- The `teams` and `skill-levels` modules depend on each other only through leaf files (`skill-levels/games.ts` and `auto-enrol.ts` import nothing from `modules/**`, checked by `boundaries.test.ts`).
- Until the allocator and billing ship, every count is zero and the Members progress line reads "0 of 40", which is accurate.
- Up to a day passes between a session completing and a promotion. The CLI trigger gives an operator an immediate path.
