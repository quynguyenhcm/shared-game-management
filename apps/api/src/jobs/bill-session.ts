/**
 * `bill-session` job: bills one ended session (wallet-and-akahu-billing Phase 2). The sweep enqueues it per due session
 * (`singletonKey = bill-session:<sessionId>`); an operator can re-run one with `pnpm run jobs:trigger bill-session '<json>'`.
 *
 * Delivery is at-least-once, so the handler is idempotent through the billing transaction's own guards (a replay finds the
 * session COMPLETED). A malformed payload fails at once. A transient failure (lost connection, lock timeout, deadlock) is rethrown
 * so pg-boss retries with backoff; an integrity failure (SQLSTATE class 23: the deferred line-sum check, a unique key) cannot be
 * cured by a retry, so it ends the job failed at once. Either way `billing.session.failed` carries the session id, the error class
 * and the SQLSTATE only, never the message (it can quote values), and the next 5-minute sweep re-enqueues the session.
 */
import { z } from 'zod';
import type { Clock } from '../lib/clock.ts';
import type { FieldCrypto } from '../lib/crypto/crypto.ts';
import type { Database } from '../lib/db/kysely.ts';
import { NonRetryableJobError, type JobHandler, type JobRunner } from '../lib/jobs/jobs.ts';
import { billSession } from '../modules/billing/bill-session.ts';
import { billSessionKey } from '../modules/billing/sweep.ts';

export { billSessionKey };

export const BillSessionPayload = z.strictObject({
  sessionId: z.uuid(),
  trigger: z.enum(['sweep', 'manual']),
});
export type BillSessionPayload = z.infer<typeof BillSessionPayload>;

export interface BillSessionJobDeps {
  readonly db: Database;
  readonly jobs: Pick<JobRunner, 'enqueue'>;
  readonly clock: Clock;
  readonly crypto: FieldCrypto;
  readonly webBaseUrl: string;
  /** Test seam. */
  readonly run?: typeof billSession;
}

function sqlState(error: unknown): string | undefined {
  const code = error instanceof Error ? (error as Error & { code?: unknown }).code : undefined;
  return typeof code === 'string' ? code : undefined;
}

export function createBillSessionHandler(deps: BillSessionJobDeps): JobHandler {
  const run = deps.run ?? billSession;
  return async (rawPayload, context) => {
    const parsed = BillSessionPayload.safeParse(rawPayload);
    if (!parsed.success) {
      // Field paths only: the payload itself is never echoed.
      const fields = [
        ...new Set(parsed.error.issues.map((issue) => issue.path.join('.') || '(root)')),
      ];
      context.logger.error(
        { event: 'billing.session.invalid_payload', fields },
        'bill-session payload is malformed',
      );
      throw new NonRetryableJobError(`malformed bill-session payload: ${fields.join(', ')}`);
    }
    const { sessionId } = parsed.data;
    try {
      await run(
        {
          db: deps.db,
          jobs: deps.jobs,
          clock: deps.clock,
          crypto: deps.crypto,
          webBaseUrl: deps.webBaseUrl,
          log: context.logger,
        },
        { sessionId },
      );
    } catch (error) {
      const state = sqlState(error);
      context.logger.error(
        {
          event: 'billing.session.failed',
          sessionId,
          errorClass: error instanceof Error ? error.name : typeof error,
          sqlState: state,
        },
        'bill-session failed',
      );
      if (state?.startsWith('23') === true) {
        throw new NonRetryableJobError(
          `bill-session hit an integrity violation (SQLSTATE ${state})`,
        );
      }
      // Rethrow a fresh error, not the driver's: the job runner logs the thrown error (message, stack, cause chain) and a
      // database message can quote values. The retry decision needs only that it is not NonRetryableJobError.
      throw new Error(
        `bill-session failed (${error instanceof Error ? error.name : typeof error}${state === undefined ? '' : `, SQLSTATE ${state}`})`,
      );
    }
  };
}
