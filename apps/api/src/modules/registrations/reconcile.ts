/**
 * The ban reconciliation sweep (architecture Q4 sweep S-a; AC-ASYNC-3; ADR 0015 point 6). It closes the two gaps a live ban
 * leaves open: bans that ran the no-op handler before this feature deployed, and `member-banned` jobs that ended `failed`.
 *
 * It enumerates and never withdraws: for every BANNED membership that still holds an active registration in a future
 * PUBLISHED session of its team it enqueues the SAME `member-banned` job a live ban does (payload rebuilt from the
 * membership row, singleton key `member-banned:<membershipId>`), through the team module's helper so the payload shape and the
 * key stay in one place. The worker's handler does the withdrawing, so the sweep and a live ban share one idempotent path, and
 * a job already queued or active is not duplicated (the queue is `exclusive`; the enqueue answers `null`).
 *
 * One transaction per run reads the candidates and enqueues, so a job row never outlives a failed sweep. The scan pages by
 * keyset (`banned_at, id`), so a member whose job keeps failing cannot starve the ones behind it. A row that cannot make a
 * valid payload (no `banned_by`) is counted and skipped; it never aborts the run. Counts only, no ids, leave this function.
 */
import type { Clock } from '../../lib/clock.ts';
import type { Database } from '../../lib/db/kysely.ts';
import type { JobRunner } from '../../lib/jobs/jobs.ts';
import { enqueueMemberBanned, MemberBannedPayload } from '../teams/ban-hook.ts';
import { listBannedWithActive, type BannedCandidate } from './repo.ts';

export const RECONCILE_PAGE_SIZE = 500;

export interface ReconcileCounts {
  /** Candidate memberships examined. */
  readonly scanned: number;
  readonly enqueued: number;
  /** A job for the membership was already queued or active. */
  readonly alreadyQueued: number;
  /** Rows that could not make a valid payload. */
  readonly invalid: number;
}

export interface ReconcileDeps {
  readonly db: Database;
  readonly jobs: Pick<JobRunner, 'enqueue'>;
  readonly clock: Clock;
  /** Rows per page; tests lower it to exercise the keyset loop. */
  readonly pageSize?: number;
  /** Test seam: the candidate scan. */
  readonly listCandidates?: typeof listBannedWithActive;
}

function toPayload(candidate: BannedCandidate): MemberBannedPayload | undefined {
  const parsed = MemberBannedPayload.safeParse({
    teamId: candidate.teamId,
    userId: candidate.userId,
    membershipId: candidate.membershipId,
    bannedBy: candidate.bannedBy,
    bannedAt: candidate.bannedAt.toISOString(),
  });
  return parsed.success ? parsed.data : undefined;
}

export async function reconcileBannedMembers(deps: ReconcileDeps): Promise<ReconcileCounts> {
  const pageSize = deps.pageSize ?? RECONCILE_PAGE_SIZE;
  const listCandidates = deps.listCandidates ?? listBannedWithActive;
  const now = deps.clock.now();

  return deps.db.transaction().execute(async (trx) => {
    let scanned = 0;
    let enqueued = 0;
    let alreadyQueued = 0;
    let invalid = 0;
    let after: { bannedAt: Date; membershipId: string } | undefined;
    for (;;) {
      const page = await listCandidates(trx, { now, limit: pageSize, after });
      for (const candidate of page) {
        scanned += 1;
        const payload = toPayload(candidate);
        if (payload === undefined) {
          invalid += 1;
          continue;
        }
        const jobId = await enqueueMemberBanned(deps.jobs, payload, { trx });
        if (jobId === null) alreadyQueued += 1;
        else enqueued += 1;
      }
      const last = page.at(-1);
      if (page.length < pageSize || last === undefined) break;
      after = { bannedAt: last.bannedAt, membershipId: last.membershipId };
    }
    return { scanned, enqueued, alreadyQueued, invalid };
  });
}
