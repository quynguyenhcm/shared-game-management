/**
 * `recurrence-rule` job: one materialisation run of one series (architecture SA-1, binding T-3). Queued by the nightly sweep,
 * the boot sweep, series create, edit and end, "Publish drafts now" and `jobs trigger recurrence-rule '<json>'`.
 *
 * The run isolates every instance (AC-ERROR-9). After the loop this handler decides how the job ends: a plain `Error` when any
 * failure was transient (pg-boss retries with backoff, and the run is idempotent), `NonRetryableJobError` when every failure was
 * permanent (a constraint or data error repeats on every retry), and a clean return otherwise. A malformed payload fails at once.
 */
import type { Clock } from '../lib/clock.ts';
import type { Database } from '../lib/db/kysely.ts';
import { NonRetryableJobError, type JobHandler, type JobRunner } from '../lib/jobs/jobs.ts';
import type { SessionAllocatorPort } from '../modules/sessions/allocator-port.ts';
import {
  failureVerdict,
  materialiseRule,
  type MaterialiseDeps,
  type MaterialiseResult,
} from '../modules/sessions/materialise.ts';
import { RecurrenceRulePayload, recurrenceRuleKey } from '../modules/sessions/rule-jobs.ts';
import { enqueueEmail } from './send-email.ts';

// The job's public contract, for the CLI trigger (which may not import the sessions module directly).
export { RecurrenceRulePayload, recurrenceRuleKey };

export interface RecurrenceRuleJobDeps {
  readonly db: Database;
  readonly clock: Clock;
  readonly allocator: SessionAllocatorPort;
  /** The worker's runner: queues the `send-email` and `session-auto-enrol` jobs on the run's transactions. */
  readonly jobs: Pick<JobRunner, 'enqueue'>;
  readonly horizonDays: number;
  /** `config.auth.webBaseUrl`, for the links in the banking notice. */
  readonly webBaseUrl: string;
  /** Test seam: replaces the run itself. */
  readonly run?: (
    deps: MaterialiseDeps,
    payload: RecurrenceRulePayload,
  ) => Promise<MaterialiseResult>;
}

export function createRecurrenceRuleHandler(deps: RecurrenceRuleJobDeps): JobHandler {
  const run = deps.run ?? materialiseRule;
  return async (rawPayload, context) => {
    const parsed = RecurrenceRulePayload.safeParse(rawPayload);
    if (!parsed.success) {
      // Field paths only: the payload itself is never echoed.
      const fields = [
        ...new Set(parsed.error.issues.map((issue) => issue.path.join('.') || '(root)')),
      ];
      context.logger.error(
        { event: 'session.recurrence.invalid_payload', fields },
        'recurrence-rule payload is malformed',
      );
      throw new NonRetryableJobError(`malformed recurrence-rule payload: ${fields.join(', ')}`);
    }

    const result = await run(
      {
        db: deps.db,
        clock: deps.clock,
        allocator: deps.allocator,
        jobs: deps.jobs,
        log: context.logger,
        horizonDays: deps.horizonDays,
        notice: {
          webBaseUrl: deps.webBaseUrl,
          sendEmail: (message, trx) => enqueueEmail(deps.jobs, message, { trx }),
        },
      },
      parsed.data,
    );

    const verdict = failureVerdict(result.failures);
    if (verdict === 'none') return;
    const summary = `${result.failed} series instance(s) failed for rule ${parsed.data.ruleId}; see instance_failed logs`;
    // Transient: a plain Error, so pg-boss retries (idempotently). Permanent: a retry would repeat it, so fail at once.
    if (verdict === 'retry') throw new Error(summary);
    throw new NonRetryableJobError(summary);
  };
}
