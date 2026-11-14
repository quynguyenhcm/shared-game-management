/**
 * `invoice-reconcile`: the safety net and backfill of invoice issuance (tax-invoices-and-exports Phase 2; AC-ASYNC-3; ADR 0021
 * section 2). Every 15 minutes (an `intervalSweep` slot, exempt from the DST guard), once at every worker boot, or
 * `pnpm run jobs:trigger invoice-reconcile`: it ENUMERATES the teams that still have a PAID payment above $0.00 without a document
 * (the predicate of `idx_payments_unissued`) and queues one `issue-invoices` job per team. It issues nothing itself and takes no lock.
 *
 * It covers a payment PAID before this feature existed (there is no migration-time backfill: the per-team job numbers them in
 * `paid_at` order), a job that was lost or dead-lettered, and a deploy window where a PAID writer ran without the enqueue. The
 * `issue-invoices` queue is `stately` with `singletonKey = issue-invoices:<teamId>`, so a team that already has a queued run is not
 * queued twice. Payments that are PENDING, OVERDUE, held, still processing or $0.00 are never selected. Logs carry counts only.
 */
import type { Database } from '../lib/db/kysely.ts';
import type { JobHandler, JobRunner } from '../lib/jobs/jobs.ts';
import type { Logger } from '../lib/logger/logger.ts';
import { listTeamsNeedingIssuance, sqlStateOf } from '../modules/invoices/issue.ts';
import { enqueueInvoiceIssuance } from './issue-invoices.ts';

/** Teams read per page of the sweep. */
export const RECONCILE_PAGE_SIZE = 500;

export interface InvoiceReconcileDeps {
  readonly db: Database;
  /** The worker's runner (queues the per-team jobs). */
  readonly jobs: Pick<JobRunner, 'enqueue'>;
  readonly log: Pick<Logger, 'info'>;
  /** Teams per page; tests lower it to exercise the keyset loop. */
  readonly pageSize?: number;
  /** Test seam. */
  readonly listTeams?: typeof listTeamsNeedingIssuance;
}

export interface InvoiceReconcileResult {
  /** Teams with leftovers seen. */
  readonly teams: number;
  /** Jobs actually queued (a team that already has one queued is not counted). */
  readonly enqueued: number;
}

export async function runInvoiceReconcile(
  deps: InvoiceReconcileDeps,
): Promise<InvoiceReconcileResult> {
  const limit = deps.pageSize ?? RECONCILE_PAGE_SIZE;
  const listTeams = deps.listTeams ?? listTeamsNeedingIssuance;
  let teams = 0;
  let enqueued = 0;
  let after: string | undefined;
  for (;;) {
    const page = await listTeams(deps.db, after === undefined ? { limit } : { after, limit });
    for (const teamId of page) {
      teams += 1;
      if ((await enqueueInvoiceIssuance(deps.jobs, { teamId })) !== null) enqueued += 1;
    }
    const last = page.at(-1);
    if (page.length < limit || last === undefined) break;
    after = last;
  }
  deps.log.info(
    { event: 'invoice.reconcile.enqueued', teams, enqueued },
    'invoice reconcile sweep',
  );
  return { teams, enqueued };
}

export type InvoiceReconcileHandlerDeps = Omit<InvoiceReconcileDeps, 'log'>;

export function createInvoiceReconcileHandler(deps: InvoiceReconcileHandlerDeps): JobHandler {
  return async (_payload, context) => {
    try {
      await runInvoiceReconcile({ ...deps, log: context.logger });
    } catch (error) {
      const state = sqlStateOf(error);
      const errorClass = error instanceof Error ? error.name : typeof error;
      context.logger.error(
        { event: 'invoice.reconcile.failed', errorClass, sqlState: state },
        'invoice-reconcile failed',
      );
      // A fresh error: the job runner logs what is thrown and a driver message can quote values.
      throw new Error(
        `invoice-reconcile failed (${errorClass}${state === undefined ? '' : `, SQLSTATE ${state}`})`,
      );
    }
  };
}
