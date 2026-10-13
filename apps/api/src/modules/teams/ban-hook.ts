/**
 * The ban seam, port side (Architecture 1B, ADR 0015). A ban commits `status = 'BANNED'` and a `member-banned`
 * job in the SAME transaction (P5); the worker later calls the injected `MemberBannedHandler`. Cancelling the
 * member's registrations and promoting the waitlist belong to registration-and-waitlist, which replaces the no-op
 * default through `registerJobs({ memberBannedHandler })` (the only injection point; an environment variable could
 * leave the no-op running after the real handler ships). The handler contract is normative and lives in ADR 0015.
 *
 * The payload is ids and one timestamp, nothing else: no name, email, invite code or ban reason ever reaches
 * `pgboss.job`, which keeps completed jobs for days.
 */
import { z } from 'zod';
import { QUEUE_NAMES } from '../../jobs/registry.ts';
import type { JobContext, JobRunner, TransactionLike } from '../../lib/jobs/jobs.ts';

/** Strict runtime shape of a `member-banned` job payload (the job row is untyped JSON). */
export const MemberBannedPayload = z.strictObject({
  teamId: z.uuid(),
  userId: z.uuid(),
  membershipId: z.uuid(),
  bannedBy: z.uuid(),
  /** UTC ISO-8601 with a `Z` suffix (P3). */
  bannedAt: z.iso.datetime(),
});
export type MemberBannedPayload = z.infer<typeof MemberBannedPayload>;

export interface MemberBannedEvent {
  readonly teamId: string;
  readonly userId: string;
  readonly membershipId: string;
  readonly bannedBy: string;
  readonly bannedAt: Date;
}

export function toMemberBannedEvent(payload: MemberBannedPayload): MemberBannedEvent {
  return { ...payload, bannedAt: new Date(payload.bannedAt) };
}

export interface MemberBannedHookContext {
  /** Child logger bound to the job and its trace. */
  readonly logger: JobContext['logger'];
  readonly signal: AbortSignal;
  readonly jobId: string;
  /** 1 on the first attempt. */
  readonly attempt: number;
}

export interface MemberBannedOutcome {
  /** Registrations the handler changed; 0 for a replay or a no-op. */
  readonly affected: number;
}

export interface MemberBannedHandler {
  /** Logged as `hook`, for example `noop` or `registrations`. */
  readonly name: string;
  /**
   * Must be idempotent and safe to re-run as a backfill over every BANNED membership (ADR 0015). Throw
   * `NonRetryableJobError` for a permanent failure; any other error is retried with the queue's backoff.
   */
  readonly handle: (
    event: MemberBannedEvent,
    context: MemberBannedHookContext,
  ) => Promise<MemberBannedOutcome>;
}

/** Safe default until registration-and-waitlist ships: record that the ban was seen and succeed. */
export const noopMemberBannedHandler: MemberBannedHandler = {
  name: 'noop',
  handle(event, context) {
    context.logger.info(
      {
        event: 'team.member.banned.hook_noop',
        teamId: event.teamId,
        userId: event.userId,
        membershipId: event.membershipId,
      },
      'member banned: no registration handler installed',
    );
    return Promise.resolve({ affected: 0 });
  },
};

/** One queued or active job per membership (the `member-banned` queue is `exclusive`). */
export const memberBannedSingletonKey = (membershipId: string): string =>
  `member-banned:${membershipId}`;

/**
 * Enqueues the ban job inside the ban's transaction. `trx` is required: a job enqueued outside it could outlive a
 * rolled-back ban, or be missing for a committed one.
 */
export async function enqueueMemberBanned(
  jobs: Pick<JobRunner, 'enqueue'>,
  payload: MemberBannedPayload,
  options: { readonly trx: TransactionLike },
): Promise<string | null> {
  const data = MemberBannedPayload.parse(payload);
  return await jobs.enqueue(QUEUE_NAMES.memberBanned, data, {
    singletonKey: memberBannedSingletonKey(data.membershipId),
    trx: options.trx,
  });
}
