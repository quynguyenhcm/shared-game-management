/**
 * `session-auto-enrol` job: the durable half of "every session gets its Auto Enroll members on first publish"
 * (binding P-1, T-2, T-19). A publish enqueues one job per session in its own transaction
 * (`singletonKey = session-auto-enrol:<sessionId>`), and the sweep re-offers sessions that are still pending.
 *
 * Delivery is at-least-once, so the handler is idempotent through the D-80 marker, which `runSessionAutoEnrol` re-reads and
 * stamps under the per-session advisory lock. A thrown error rolls that transaction back, is logged by the run, and ends the
 * job failed so the queue retries it; a malformed payload fails at once without retries.
 */
import type { Clock } from '../lib/clock.ts';
import type { Database } from '../lib/db/kysely.ts';
import { NonRetryableJobError, type JobHandler } from '../lib/jobs/jobs.ts';
import type { SessionAllocatorPort } from '../modules/sessions/allocator-port.ts';
import { SessionAutoEnrolPayload, runSessionAutoEnrol } from '../modules/sessions/auto-enrol.ts';

export interface SessionAutoEnrolJobDeps {
  readonly db: Database;
  readonly clock: Clock;
  readonly allocator: SessionAllocatorPort;
}

export function createSessionAutoEnrolHandler(deps: SessionAutoEnrolJobDeps): JobHandler {
  return async (rawPayload, context) => {
    const parsed = SessionAutoEnrolPayload.safeParse(rawPayload);
    if (!parsed.success) {
      // Field paths only: the payload itself is never echoed.
      const fields = [
        ...new Set(parsed.error.issues.map((issue) => issue.path.join('.') || '(root)')),
      ];
      context.logger.error(
        { event: 'session.auto_enrol.invalid_payload', fields },
        'session-auto-enrol payload is malformed',
      );
      throw new NonRetryableJobError(`malformed session-auto-enrol payload: ${fields.join(', ')}`);
    }
    await runSessionAutoEnrol(
      { db: deps.db, clock: deps.clock, allocator: deps.allocator, log: context.logger },
      { teamId: parsed.data.teamId, sessionId: parsed.data.sessionId },
    );
  };
}
