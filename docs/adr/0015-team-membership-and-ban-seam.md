# ADR 0015: Team membership state machine and the ban seam

- Status: Accepted (2026-10-13)
- Task: team-management
- Source: [Architecture Q1, Q3, Q4, Q5 and Spec amendments A1 to A13](../../memory-bank/creative/team-management-membership-architecture.md); task file "Creative Reconciliation (binding for build)"

## Context

A ban must revoke team access at once, block future registrations, and cancel the member's active registrations (promoting the waitlist). The registration tables exist, but no registration code does: cancellation, fees, FIFO promotion and notifications belong to registration-and-waitlist. team-management therefore delivers a seam, not the cancellation. The seam has to be race-free against a concurrent registration, must never let a failing side effect undo or delay the ban, and must stay correct when delivered more than once.

## Decision

- **A ban is a committed status plus a durable job in one transaction (option 1B, P5).** The ban transaction sets `status = 'BANNED'` and enqueues a `member-banned` pg-boss job through the caller's transaction. A ban that rolls back leaves no job; a job never exists without its BANNED row. Queue `member-banned`, policy `exclusive`, `singletonKey = member-banned:<membershipId>`, defaults `retryLimit 3`, backoff, 7-day retention.
- **Strict id-only payload.** `{ teamId, userId, membershipId, bannedBy, bannedAt }` (`bannedAt` is ISO-8601 UTC) validated by `MemberBannedPayload` (`modules/teams/ban-hook.ts`). No name, email, invite code or ban reason ever reaches `pgboss.job`, nor any log line.
- **A replaceable port with a safe default.** `MemberBannedHandler` (`modules/teams/ban-hook.ts`) is injected only through `RegisterJobsOptions.memberBannedHandler` in `jobs/bootstrap.ts` (and `worker.ts`), never through an environment variable, so a deployment cannot keep running the no-op after the real handler ships. The default logs `team.member.banned.hook_noop` and succeeds. The job handler (`jobs/member-banned.ts`) validates the payload, re-reads the membership by id (gone: complete as a no-op, `team.member.banned.stale`; ids or status disagree with the payload: fail without retries), calls the port, and logs `team.member.banned.handled` or `team.member.banned.hook_failed`.
- **Failure never undoes or delays the ban.** Access is revoked by the committed row, before any job runs. A transient handler failure is retried with the queue backoff; a permanent one (`NonRetryableJobError`, or retries exhausted) ends the job in `failed` with an error log `team.member.banned.hook_failed` (`teamId`, `userId`, `membershipId`, `hook`, `attempt`, `willRetry`; no PII), which is what an operator alerts on. The supported re-run is `cli jobs trigger member-banned '<json>'`, validated with the same strict schema.
- **The approved-member gate.** `assertApprovedMember(trx, teamId, userId)` (`modules/teams/membership.ts`) reads the `team_members` row `FOR SHARE` and throws `forbidden` unless it is APPROVED.
- **Canonical lock order, for every feature:** `teams` then `team_members` then `game_sessions` then `registrations` then `registration_guests` and payments. Skip the levels you do not need; never acquire out of order. The ban stops at `team_members`, the handler starts at `game_sessions`, registration takes `team_members` (shared) then `game_sessions`, so the three paths cannot deadlock.
- **Moderation transaction shape.** Every mutating admin action (approve, reject, promote, demote, ban, regenerate) locks the team row (`FOR NO KEY UPDATE`; regenerate `FOR UPDATE` because it changes a key column), re-checks that the actor is still an approved `TEAM_ADMIN` under that lock (the route guard ran outside the transaction; an admin demoted in between gets 403), then locks the target row by `(team_id, user_id)` and writes with a guarded `UPDATE ... WHERE status = $expected`. The database is the backstop (D-40 to D-45: CHECKs, the status-transition trigger, the deferred last-admin triggers); the service maps them by `err.constraint`.
- **Membership policy.** Re-request after rejection is immediate (the same row returns to PENDING). BANNED is terminal in v1 (no unban). Ban only from APPROVED `MEMBER`; an approved admin cannot be banned until demoted. All admins are equal. A team never loses its last admin.

## The `MemberBannedHandler` contract (normative)

A handler registered through the port MUST:

1. **Select by current state, not by payload history.** Act on every registration with `team_id = event.teamId AND user_id = event.userId AND status IN ('CONFIRMED', 'WAITLISTED')` whose session has `status = 'PUBLISHED' AND starts_at > now` (the handler's clock). Sessions that have started or finished are left alone; post-game billing treats them normally.
2. **Process one session per transaction**, in `(starts_at, id)` order. Each transaction first takes `SELECT ... FROM game_sessions WHERE id = $1 FOR UPDATE` (ledger D-14), then runs a guarded `UPDATE registrations SET status = 'WITHDRAWN', queue_position = NULL, updated_at = $now WHERE id = $r AND status IN ('CONFIRMED', 'WAITLISTED') RETURNING ...`. Guests withdraw with the registration (the `registration_guests` rows stay as history). Other registrants' queue positions are not renumbered.
3. **Apply early-withdrawal semantics regardless of the deadline.** No fee and no `payments` row for the banned player. If a CONFIRMED seat was freed, run the standard FIFO promotion in the same transaction and enqueue the promotion emails in that transaction (P5).
4. **Never** write `team_members`, never read `ban_reason`, and never notify the banned player.
5. **Be safe to re-run** at any time, including as a backfill or reconciliation over every BANNED membership: a second run finds nothing active and returns `{ affected: 0 }`.
6. **Signal permanence** by throwing `NonRetryableJobError`; any other error is transient and retried.
7. **Pass `apps/api/test/integration/teams-ban-seam.int.test.ts`**, which is the contract test (its header says so).

## The gate contract (normative)

- Call `assertApprovedMember(trx, teamId, userId)` INSIDE the registration or auto-enrol transaction, BEFORE that transaction takes any `game_sessions` lock. It holds the row `FOR SHARE` until COMMIT, so a concurrent ban waits for it and vice versa: a registration either commits before the ban, where the ban's job (which runs after the ban commits) sees it, or waits, reads BANNED and is refused. Nothing slips between the two.
- It assumes READ COMMITTED (the project default). Under REPEATABLE READ or SERIALIZABLE a concurrent ban surfaces as SQLSTATE 40001 and the caller must retry.
- It returns `{ membershipId, role, skillLevel }` (`BY_SKILL_LEVEL` pricing needs the level in the same transaction) and throws a programming `Error` outside a transaction.

## Requirements on registration-and-waitlist (it must carry these into its plan)

- **Ship the reconciliation sweep.** Registration-and-waitlist MUST ship a reconciliation sweep that re-enqueues `member-banned` (the same payload and `singletonKey`) for every BANNED membership that still has an active registration in a future PUBLISHED session of that team. It runs daily and on demand. It closes two gaps with the same idempotent handler: the deploy window in which registrations are possible while the worker still runs the no-op handler (a ban handled by the no-op would otherwise never cancel its registrations), and a permanently failed job. This feature ships no sweeper because, with a no-op handler and no registration code, it would do nothing.
- **Ban copy must not promise cancellation until that feature ships.** (User decision, 2026-10-13.) The confirmation reads "Ban {Full name}? They lose access to this team and can't register for its sessions." Registration-and-waitlist adds wording about cancelled registrations only when it ships the real handler and the sweep.
- Call the gate before the D-14 session lock, apply the handler contract above, and make its handler pass `teams-ban-seam.int.test.ts`.
- A future account-deletion feature must handle that deleting the last admin's user fails at COMMIT with `team_members_last_admin`.

## Alternatives considered

- **1A, a synchronous in-transaction hook.** The ban would wait on every busy session and hold the moderation mutex meanwhile; a registration-code failure would roll the ban back (violating "a failing side effect never undoes the ban"), and today it would be a no-op anyway.
- **1C, withdraw synchronously and promote asynchronously.** Withdraw is already a D-14 operation, so it has 1A's coupling, and it splits one business operation across two transactions.
- **1D, a database trigger cascade.** FIFO promotion, capacity, fees and notifications would have to be duplicated in plpgsql, with implicit session locks inside the ban.
- **A sweeper shipped now (S1).** No behaviour to reconcile until the real handler exists. **No sweeper ever (S2).** Leaves the deploy-window gap open.
- **Cancellation as a late withdrawal (F1) or by deleting rows (F3).** F1 would charge a player for an admin's action; F3 loses history and is forbidden once billed (`ON DELETE RESTRICT` from payments).

## Consequences

- Seat release after a ban is eventual (seconds normally; up to the retry window when the worker is down). The two safety-relevant parts of "immediately" (no team access, no new registrations) are synchronous.
- Moderation is serialised per team; two admins acting at once on one team wait milliseconds for each other.
- Two encodings of the transition table (the SQL trigger and `modules/teams/transitions.ts`) are kept aligned by one shared matrix fixture run against both.
- A joint demotion race resolves by amendment A10: the loser is no longer an admin when its turn comes and is refused with 403 `forbidden`; sole-admin and 20-way self-demotion answer 409 `last_team_admin`.
