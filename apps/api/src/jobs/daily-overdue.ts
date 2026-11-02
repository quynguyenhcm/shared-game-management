/**
 * `daily-overdue` job (04:00 Pacific/Auckland, once at every worker boot, or `pnpm run jobs:trigger daily-overdue`): marks unpaid
 * charges OVERDUE and emails the payer (wallet-and-akahu-billing Phase 3, AC-HAPPY-8). The work is in
 * `modules/billing/overdue.ts`, the only writer of OVERDUE; this is the thin handler that replaces the schedule placeholder.
 *
 * Every step is idempotent (a payment leaves PENDING once; the overdue email key comes from the payment), so at-least-once
 * delivery and the boot sweep are safe. A failure is logged with the error class and SQLSTATE only and rethrown as a fresh error:
 * the job runner logs what is thrown, and a driver message can quote values.
 */
import type { PaymentsGateway } from '../lib/akahu/gateway.ts';
import type { Clock } from '../lib/clock.ts';
import type { FieldCrypto } from '../lib/crypto/crypto.ts';
import type { Database } from '../lib/db/kysely.ts';
import type { JobHandler, JobRunner } from '../lib/jobs/jobs.ts';
import { runDailyOverdue } from '../modules/billing/overdue.ts';

export interface DailyOverdueOptions {
  readonly db: Database;
  /** Akahu, re-read for payments with an open attempt (never inside a transaction). */
  readonly gateway: PaymentsGateway;
  readonly jobs: Pick<JobRunner, 'enqueue'>;
  readonly clock: Clock;
  readonly crypto: FieldCrypto;
  readonly webBaseUrl: string;
}

function sqlState(error: unknown): string | undefined {
  const code = error instanceof Error ? (error as Error & { code?: unknown }).code : undefined;
  return typeof code === 'string' ? code : undefined;
}

export function createDailyOverdueHandler(options: DailyOverdueOptions): JobHandler {
  return async (_payload, context) => {
    try {
      await runDailyOverdue({
        db: options.db,
        gateway: options.gateway,
        jobs: options.jobs,
        clock: options.clock,
        crypto: options.crypto,
        webBaseUrl: options.webBaseUrl,
        log: context.logger,
      });
    } catch (error) {
      const state = sqlState(error);
      const errorClass = error instanceof Error ? error.name : typeof error;
      context.logger.error(
        { event: 'billing.overdue.failed', errorClass, sqlState: state },
        'daily-overdue failed',
      );
      throw new Error(
        `daily-overdue failed (${errorClass}${state === undefined ? '' : `, SQLSTATE ${state}`})`,
      );
    }
  };
}
