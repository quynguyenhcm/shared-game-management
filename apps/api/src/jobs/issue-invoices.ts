/**
 * `issue-invoices`: issues the tax invoices and receipts of ONE team (tax-invoices-and-exports Phase 2; ADR 0021 section 2).
 * Billing only ENQUEUES it, inside the transaction that moves a payment to PAID (`enqueueInvoiceIssuance`, P5), with
 * `singletonKey = issue-invoices:<teamId>` on a `stately` queue: one queued and one active run per team, so a PAID that commits
 * during a run queues exactly one trailing run. The `invoice-reconcile` sweep queues it for any team with leftovers, which is
 * also the backfill for payments PAID before this feature.
 *
 * Delivery is at-least-once and the work is idempotent through the SQL issuer (a payment that already has a document is returned,
 * not renumbered). The handler drains the team's unissued payments oldest-paid first, one payment per transaction, up to a per-run
 * limit, then queues a follow-up run (outside any transaction) if payments remain. A payment that fails an integrity check
 * (SQLSTATE class 23) is skipped and the others still commit; the run then ends `NonRetryableJobError`, so the failure stays visible
 * in the job table instead of being retried to no effect. A transient failure (lost connection, lock timeout, deadlock) is rethrown
 * as a fresh error, because the job runner logs what is thrown and a database message can quote values.
 */
import { z } from 'zod';
import type { Database } from '../lib/db/kysely.ts';
import {
  NonRetryableJobError,
  type JobHandler,
  type JobRunner,
  type TransactionLike,
} from '../lib/jobs/jobs.ts';
import {
  DEFAULT_RUN_LIMIT,
  issueTeamBacklog,
  sqlStateOf,
  type IssueFn,
} from '../modules/invoices/issue.ts';
import { QUEUE_NAMES } from './registry.ts';

/** Payments one run issues before it queues a follow-up run. */
export const ISSUE_RUN_LIMIT = DEFAULT_RUN_LIMIT;

export const IssueInvoicesPayload = z.strictObject({ teamId: z.uuid() });
export type IssueInvoicesPayload = z.infer<typeof IssueInvoicesPayload>;

/** The singleton key of one team's issuance job: a queued or active duplicate is dropped. */
export const issueInvoicesKey = (teamId: string): string => `issue-invoices:${teamId}`;

/**
 * Queues the team's issuance job. Pass the PAID transaction as `trx` so the job exists exactly when the payment commits as PAID
 * (a rolled-back transaction leaves no job). Resolves to the job id, or null when a queued job for the team already covers it.
 */
export function enqueueInvoiceIssuance(
  jobs: Pick<JobRunner, 'enqueue'>,
  input: { readonly teamId: string },
  options: { readonly trx?: TransactionLike } = {},
): Promise<string | null> {
  return jobs.enqueue(
    QUEUE_NAMES.issueInvoices,
    { teamId: input.teamId },
    {
      singletonKey: issueInvoicesKey(input.teamId),
      ...(options.trx === undefined ? {} : { trx: options.trx }),
    },
  );
}

export interface IssueInvoicesJobDeps {
  readonly db: Database;
  /** The worker's runner: the follow-up run is queued through it. */
  readonly jobs: Pick<JobRunner, 'enqueue'>;
  /** Per-run limit; tests lower it to exercise the follow-up run. Defaults to 500. */
  readonly runLimit?: number;
  /** Test seams. */
  readonly drain?: typeof issueTeamBacklog;
  readonly issue?: IssueFn;
}

export function createIssueInvoicesHandler(deps: IssueInvoicesJobDeps): JobHandler {
  const drain = deps.drain ?? issueTeamBacklog;
  return async (rawPayload, context) => {
    const parsed = IssueInvoicesPayload.safeParse(rawPayload);
    if (!parsed.success) {
      // Field paths only: the payload itself is never echoed.
      const fields = [
        ...new Set(parsed.error.issues.map((issue) => issue.path.join('.') || '(root)')),
      ];
      context.logger.error(
        { event: 'invoice.run.invalid_payload', fields },
        'issue-invoices payload is malformed',
      );
      throw new NonRetryableJobError(`malformed issue-invoices payload: ${fields.join(', ')}`);
    }
    const { teamId } = parsed.data;

    let result: Awaited<ReturnType<typeof issueTeamBacklog>>;
    try {
      result = await drain(
        {
          db: deps.db,
          log: context.logger,
          ...(deps.issue === undefined ? {} : { issue: deps.issue }),
        },
        { teamId, runLimit: deps.runLimit ?? ISSUE_RUN_LIMIT },
      );
    } catch (error) {
      const state = sqlStateOf(error);
      const errorClass = error instanceof Error ? error.name : typeof error;
      context.logger.error(
        { event: 'invoice.run.failed', teamId, errorClass, sqlState: state },
        'issue-invoices failed',
      );
      // A fresh, retryable error: the decision needs only that it is not NonRetryableJobError.
      throw new Error(
        `issue-invoices failed (${errorClass}${state === undefined ? '' : `, SQLSTATE ${state}`})`,
      );
    }

    context.logger.info(
      {
        event: 'invoice.run.completed',
        teamId,
        issued: result.issued,
        skipped: result.skipped,
        failed: result.failed.length,
      },
      'issue-invoices run completed',
    );
    if (result.limitReached) {
      // Outside any transaction: this run is active, and `stately` allows one queued job behind it.
      await enqueueInvoiceIssuance(deps.jobs, { teamId });
    }
    if (result.failed.length > 0) {
      throw new NonRetryableJobError(
        `issue-invoices: ${result.failed.length} payment(s) failed an integrity check; see invoice.issue.failed`,
      );
    }
  };
}
