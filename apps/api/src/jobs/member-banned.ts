/**
 * `member-banned` job: the durable half of a ban (Architecture 1B, ADR 0015). The ban already committed, so access
 * is revoked whatever this job does; the job only gives the injected `MemberBannedHandler` its turn. It never
 * writes `team_members`, and a failure here can neither undo nor delay the ban (AC-ERROR-12): a transient error is
 * retried by the queue's policy, a permanent one ends the job in `failed` with an error log for an operator, who can
 * re-run it with `cli jobs trigger member-banned '<json>'`.
 *
 * Delivery is at-least-once, so the handler re-reads the membership from the payload's id instead of trusting the
 * payload: a row that is gone (team deleted) completes as a no-op; ids that disagree with the payload, or a status
 * other than BANNED (terminal in v1), is an invariant breach and fails without retries.
 */
import type { Database } from '../lib/db/kysely.ts';
import { NonRetryableJobError, type JobHandler } from '../lib/jobs/jobs.ts';
import {
  MemberBannedPayload,
  toMemberBannedEvent,
  type MemberBannedHandler,
} from '../modules/teams/ban-hook.ts';
import * as repo from '../modules/teams/repo.ts';

export interface MemberBannedJobDeps {
  readonly db: Database;
  readonly hook: MemberBannedHandler;
}

export function createMemberBannedJobHandler(deps: MemberBannedJobDeps): JobHandler {
  const { db, hook } = deps;
  return async (rawPayload, context) => {
    const parsed = MemberBannedPayload.safeParse(rawPayload);
    if (!parsed.success) {
      // Field paths only: the payload itself is never echoed.
      const fields = [
        ...new Set(parsed.error.issues.map((issue) => issue.path.join('.') || '(root)')),
      ];
      context.logger.error(
        { event: 'team.member.banned.invalid_payload', fields },
        'member-banned payload is malformed',
      );
      throw new NonRetryableJobError(`malformed member-banned payload: ${fields.join(', ')}`);
    }
    const payload = parsed.data;
    const attempt = context.retryCount + 1;
    const ids = {
      teamId: payload.teamId,
      userId: payload.userId,
      membershipId: payload.membershipId,
    };

    const membership = await repo.findMembershipById(db, payload.membershipId);
    if (membership === undefined) {
      context.logger.info(
        { event: 'team.member.banned.stale', ...ids },
        'member-banned: membership no longer exists',
      );
      return;
    }
    if (
      membership.teamId !== payload.teamId ||
      membership.userId !== payload.userId ||
      membership.status !== 'BANNED'
    ) {
      context.logger.error(
        {
          event: 'team.member.banned.hook_failed',
          ...ids,
          hook: hook.name,
          attempt,
          willRetry: false,
          reason: 'membership_mismatch',
        },
        'member-banned: the membership does not match the job',
      );
      throw new NonRetryableJobError('member-banned payload does not match the membership row');
    }

    try {
      const outcome = await hook.handle(toMemberBannedEvent(payload), {
        logger: context.logger,
        signal: context.signal,
        jobId: context.jobId,
        attempt,
      });
      context.logger.info(
        {
          event: 'team.member.banned.handled',
          ...ids,
          hook: hook.name,
          affected: outcome.affected,
        },
        'member-banned handled',
      );
    } catch (error) {
      const final =
        error instanceof NonRetryableJobError || context.retryCount >= context.retryLimit;
      context.logger[final ? 'error' : 'warn'](
        {
          event: 'team.member.banned.hook_failed',
          ...ids,
          hook: hook.name,
          attempt,
          willRetry: !final,
          err: error,
        },
        'member-banned handler failed',
      );
      throw error;
    }
  };
}
