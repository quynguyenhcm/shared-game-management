/**
 * The three Akahu job handlers (wallet-and-akahu-billing Phase 4a; CR-3, CR-12, CR-13, CR-25). Thin adapters to
 * `modules/billing`: the work and its idempotency (row locks, guarded intent transitions, cause-keyed emails) live there.
 *
 *   akahu-sync ....... `{ akahuPaymentId, source }`: re-read Akahu outside any transaction, then apply through the single funnel
 *   akahu-cancel ..... `{ akahuPaymentId, source }`: best-effort cancel in READY, then re-read; an orphan is cancelled outright
 *   akahu-reconcile .. the 15-minute sweep (also at boot): close stale CREATING, re-read OPEN / HELD / CLOSED-with-id intents
 *
 * Payloads are validated at runtime (a malformed one fails at once, without retries). A transient provider failure is rethrown so
 * pg-boss retries with backoff; any other failure is logged with its class and SQLSTATE only and rethrown as a fresh error, because
 * the job runner logs what is thrown and a driver message can quote values.
 */
import { z } from 'zod';
import type { PaymentsConfig } from '../lib/akahu/config.ts';
import { GatewayUnavailableError, type PaymentsGateway } from '../lib/akahu/gateway.ts';
import type { Clock } from '../lib/clock.ts';
import type { FieldCrypto } from '../lib/crypto/crypto.ts';
import type { Database } from '../lib/db/kysely.ts';
import {
  NonRetryableJobError,
  type JobContext,
  type JobHandler,
  type JobRunner,
} from '../lib/jobs/jobs.ts';
import {
  CANCEL_SOURCES,
  PROVIDER_PAYMENT_ID_PATTERN,
  SYNC_SOURCES,
  syncAkahuPayment,
} from '../modules/billing/apply-akahu-result.ts';
import { cancelAkahuPayment } from '../modules/billing/cancel.ts';
import { runAkahuReconcile } from '../modules/billing/reconcile.ts';

export interface AkahuJobOptions {
  readonly db: Database;
  readonly gateway: PaymentsGateway;
  readonly jobs: Pick<JobRunner, 'enqueue'>;
  readonly clock: Clock;
  readonly crypto: FieldCrypto;
  readonly webBaseUrl: string;
  /** `config.payments`: the reconcile ages and the finality horizon. */
  readonly payments: PaymentsConfig;
}

const SyncPayload = z.strictObject({
  akahuPaymentId: z.string().regex(PROVIDER_PAYMENT_ID_PATTERN),
  source: z.enum(SYNC_SOURCES),
});
const CancelPayload = z.strictObject({
  akahuPaymentId: z.string().regex(PROVIDER_PAYMENT_ID_PATTERN),
  source: z.enum(CANCEL_SOURCES),
});

function sqlState(error: unknown): string | undefined {
  const code = error instanceof Error ? (error as Error & { code?: unknown }).code : undefined;
  return typeof code === 'string' ? code : undefined;
}

/** Rethrows a transient provider failure as is (pg-boss retries); anything else as a sanitised error. */
function failSafely(queue: string, event: string, error: unknown, context: JobContext): never {
  if (error instanceof GatewayUnavailableError || error instanceof NonRetryableJobError)
    throw error;
  const state = sqlState(error);
  const errorClass = error instanceof Error ? error.name : typeof error;
  context.logger.error({ event, errorClass, sqlState: state }, `${queue} failed`);
  throw new Error(
    `${queue} failed (${errorClass}${state === undefined ? '' : `, SQLSTATE ${state}`})`,
  );
}

function parse<T>(schema: z.ZodType<T>, payload: unknown, queue: string, context: JobContext): T {
  const parsed = schema.safeParse(payload);
  if (!parsed.success) {
    const fields = [
      ...new Set(parsed.error.issues.map((issue) => issue.path.join('.') || '(root)')),
    ];
    context.logger.error(
      { event: 'akahu.job.invalid_payload', queue, fields },
      `${queue} payload is malformed`,
    );
    throw new NonRetryableJobError(`malformed ${queue} payload: ${fields.join(', ')}`);
  }
  return parsed.data;
}

const depsOf = (options: AkahuJobOptions, context: JobContext) => ({
  db: options.db,
  gateway: options.gateway,
  jobs: options.jobs,
  clock: options.clock,
  crypto: options.crypto,
  webBaseUrl: options.webBaseUrl,
  log: context.logger,
});

export function createAkahuSyncHandler(options: AkahuJobOptions): JobHandler {
  return async (payload, context) => {
    const input = parse(SyncPayload, payload, 'akahu-sync', context);
    try {
      await syncAkahuPayment(depsOf(options, context), input);
    } catch (error) {
      failSafely('akahu-sync', 'akahu.sync.failed', error, context);
    }
  };
}

export function createAkahuCancelHandler(options: AkahuJobOptions): JobHandler {
  return async (payload, context) => {
    const input = parse(CancelPayload, payload, 'akahu-cancel', context);
    try {
      await cancelAkahuPayment(depsOf(options, context), input);
    } catch (error) {
      failSafely('akahu-cancel', 'akahu.cancel.failed', error, context);
    }
  };
}

export function createAkahuReconcileHandler(options: AkahuJobOptions): JobHandler {
  return async (_payload, context) => {
    try {
      await runAkahuReconcile({ ...depsOf(options, context), settings: options.payments });
    } catch (error) {
      failSafely('akahu-reconcile', 'akahu.reconcile.failed', error, context);
    }
  };
}
