import { systemClock, type Clock } from '../lib/clock.ts';
import type { FieldCrypto } from '../lib/crypto/crypto.ts';
import type { PaymentsConfig } from '../lib/akahu/config.ts';
import type { PaymentsGateway } from '../lib/akahu/gateway.ts';
import type { Database } from '../lib/db/kysely.ts';
import type { JobHandler, JobRunner, QueueDefinition } from '../lib/jobs/jobs.ts';
import type { Notifier } from '../lib/notifications/notifier.ts';
import type { Logger } from '../lib/logger/logger.ts';
import type { SessionAllocatorPort } from '../modules/sessions/allocator-port.ts';
import { DEFAULT_RECURRENCE_HORIZON_DAYS } from '../modules/sessions/materialise.ts';
import { noopMemberBannedHandler, type MemberBannedHandler } from '../modules/teams/ban-hook.ts';
import {
  createAkahuCancelHandler,
  createAkahuReconcileHandler,
  createAkahuSyncHandler,
} from './akahu-jobs.ts';
import { createAuthCleanupHandler } from './auth-cleanup.ts';
import { createBanReconcileHandler } from './ban-reconcile.ts';
import { createBillSessionHandler } from './bill-session.ts';
import { createDailyOverdueHandler } from './daily-overdue.ts';
import { heartbeatHandler } from './heartbeat.ts';
import { createInvoiceReconcileHandler } from './invoice-reconcile.ts';
import { createIssueInvoicesHandler } from './issue-invoices.ts';
import { createMemberBannedJobHandler } from './member-banned.ts';
import { createPostGameBillingHandler } from './post-game-billing.ts';
import { createRecurrenceMaterialisationHandler } from './recurrence-materialisation.ts';
import { createRecurrenceRuleHandler } from './recurrence-rule.ts';
import { QUEUES, QUEUE_NAMES, withExpireOverride } from './registry.ts';
import { SCHEDULES, placeholderHandler, registerSchedules } from './schedules.ts';
import { createSendEmailHandler } from './send-email.ts';
import { createSessionAutoEnrolHandler } from './session-auto-enrol.ts';
import { createSkillProgressionHandler } from './skill-progression.ts';

export interface ExtraQueue {
  readonly definition: QueueDefinition;
  readonly handler: JobHandler;
}

export interface RegisterJobsOptions {
  /** A started worker-role runner. */
  readonly runner: JobRunner;
  readonly notifier: Notifier;
  /** Opens the sealed `send-email` payloads (reset links); the API seals them with the same keyring. */
  readonly crypto: FieldCrypto;
  /** Kysely handle over the worker's pool (the `auth-cleanup` handler deletes through it). */
  readonly db: Database;
  /** Time source for handlers that judge staleness; defaults to the system clock. */
  readonly clock?: Clock;
  /**
   * What a ban triggers (ADR 0015). `worker.ts` passes `createRegistrationsBanHandler`; the no-op default exists for tests
   * and for an entrypoint that forgets it (`worker.test.ts` proves the worker does not). This option is the only place the
   * port is injected.
   */
  readonly memberBannedHandler?: MemberBannedHandler;
  /**
   * Seat allocator seam for the sessions jobs (architecture SA-4). REQUIRED: `worker.ts` builds it with
   * `createSessionAllocator`, so an entrypoint that forgets it does not compile.
   */
  readonly sessionAllocator: SessionAllocatorPort;
  /** `RECURRENCE_HORIZON_DAYS` (7-91): how far ahead the series materialiser creates sessions. Defaults to 28. */
  readonly recurrenceHorizonDays?: number;
  /**
   * The payments gateway `daily-overdue` re-reads open attempts through (ruling H1). REQUIRED: `worker.ts` builds it with
   * `createPaymentsGateway`, so an entrypoint that forgets it does not compile.
   */
  readonly paymentsGateway: PaymentsGateway;
  /**
   * `config.payments`: the reconcile ages and the finality horizon `akahu-reconcile` uses (CR-12, CR-25). REQUIRED: `worker.ts`
   * passes `config.payments`, so an entrypoint that forgets it does not compile (no silent default).
   */
  readonly payments: PaymentsConfig;
  /** `config.auth.webBaseUrl`: origin for the links in the series banking notice. REQUIRED (12-factor: no localhost fallback). */
  readonly webBaseUrl: string;
  /** Defaults to the registry; tests pass tuned copies. */
  readonly queues?: readonly QueueDefinition[];
  /** Test-only expiry override applied to every queue (JOBS_EXPIRE_SECONDS_OVERRIDE). */
  readonly expireSecondsOverride?: number | undefined;
  /** Additional queues (test entrypoints); the expiry override applies to them too. */
  readonly extraQueues?: readonly ExtraQueue[];
}

/** Creates the queues (idempotent), attaches every handler and registers the cron schedules. */
export async function registerJobs(options: RegisterJobsOptions): Promise<void> {
  const { runner } = options;
  // Fail fast, before any queue is defined: the banking-notice links need the real origin.
  if (typeof options.webBaseUrl !== 'string' || options.webBaseUrl.length === 0) {
    throw new Error('registerJobs: webBaseUrl is required (set WEB_BASE_URL)');
  }
  const akahu = {
    db: options.db,
    gateway: options.paymentsGateway,
    jobs: runner,
    clock: options.clock ?? systemClock,
    crypto: options.crypto,
    webBaseUrl: options.webBaseUrl,
    payments: options.payments,
  };
  const handlers: Record<string, JobHandler> = {
    // Placeholders first: a slot that has a real handler below overrides its placeholder.
    ...Object.fromEntries(SCHEDULES.map((slot) => [slot.name, placeholderHandler(slot.name)])),
    [QUEUE_NAMES.heartbeat]: heartbeatHandler,
    [QUEUE_NAMES.sendEmail]: createSendEmailHandler(
      options.notifier,
      options.crypto,
    ) as unknown as JobHandler,
    [QUEUE_NAMES.authCleanup]: createAuthCleanupHandler({
      db: options.db,
      clock: options.clock ?? systemClock,
    }),
    [QUEUE_NAMES.memberBanned]: createMemberBannedJobHandler({
      db: options.db,
      hook: options.memberBannedHandler ?? noopMemberBannedHandler,
    }),
    // The real sweep replaces the schedule placeholder (registration-and-waitlist AC-ASYNC-3).
    [QUEUE_NAMES.registrationBanReconcile]: createBanReconcileHandler({
      db: options.db,
      jobs: runner,
      clock: options.clock ?? systemClock,
    }),
    // The real billing engine replaces the schedule placeholder (wallet-and-akahu-billing CR-13): the sweep enqueues one
    // `bill-session` job per ended session, and that handler bills it.
    [QUEUE_NAMES.postGameBilling]: createPostGameBillingHandler({
      db: options.db,
      jobs: runner,
      clock: options.clock ?? systemClock,
    }),
    // The real overdue job replaces the 04:00 placeholder (CR-13, CR-27): it re-reads Akahu for open attempts before it flips.
    [QUEUE_NAMES.dailyOverdue]: createDailyOverdueHandler({
      db: options.db,
      gateway: options.paymentsGateway,
      jobs: runner,
      clock: options.clock ?? systemClock,
      crypto: options.crypto,
      webBaseUrl: options.webBaseUrl,
    }),
    // The single Akahu apply funnel and its safety nets (CR-3, CR-12, CR-25): the reconcile sweep replaces its slot placeholder.
    [QUEUE_NAMES.akahuSync]: createAkahuSyncHandler(akahu),
    [QUEUE_NAMES.akahuCancel]: createAkahuCancelHandler(akahu),
    [QUEUE_NAMES.akahuReconcile]: createAkahuReconcileHandler(akahu),
    // Invoice issuance (tax-invoices-and-exports Phase 2): the per-team job and the sweep that replaces its schedule placeholder.
    [QUEUE_NAMES.issueInvoices]: createIssueInvoicesHandler({ db: options.db, jobs: runner }),
    [QUEUE_NAMES.invoiceReconcile]: createInvoiceReconcileHandler({ db: options.db, jobs: runner }),
    [QUEUE_NAMES.billSession]: createBillSessionHandler({
      db: options.db,
      jobs: runner,
      clock: options.clock ?? systemClock,
      crypto: options.crypto,
      webBaseUrl: options.webBaseUrl,
    }),
    [QUEUE_NAMES.skillProgression]: createSkillProgressionHandler({
      db: options.db,
      clock: options.clock ?? systemClock,
    }),
    [QUEUE_NAMES.sessionAutoEnrol]: createSessionAutoEnrolHandler({
      db: options.db,
      clock: options.clock ?? systemClock,
      allocator: options.sessionAllocator,
    }),
    // The real sweep replaces the schedule placeholder; it fans out to the per-rule and per-session queues.
    [QUEUE_NAMES.recurrenceMaterialisation]: createRecurrenceMaterialisationHandler({
      db: options.db,
      clock: options.clock ?? systemClock,
      jobs: runner,
    }),
    [QUEUE_NAMES.recurrenceRule]: createRecurrenceRuleHandler({
      db: options.db,
      clock: options.clock ?? systemClock,
      allocator: options.sessionAllocator,
      jobs: runner,
      horizonDays: options.recurrenceHorizonDays ?? DEFAULT_RECURRENCE_HORIZON_DAYS,
      webBaseUrl: options.webBaseUrl,
    }),
  };

  const registered = [
    ...(options.queues ?? QUEUES).map((definition) => ({
      definition,
      handler: handlers[definition.name],
    })),
    ...(options.extraQueues ?? []),
  ];
  const definitions = withExpireOverride(
    registered.map((entry) => entry.definition),
    options.expireSecondsOverride,
  );

  for (const [index, definition] of definitions.entries()) {
    const handler = registered[index]?.handler;
    if (!handler) throw new Error(`queue "${definition.name}" has no handler`);
    await runner.defineQueue(definition);
    await runner.work(definition.name, handler);
  }
  await registerSchedules(runner);
}

/**
 * Queues the sweeps that reconcile state at every worker boot (SA-1, SA-5; registration-and-waitlist Q4):
 *  - the series materialiser (also re-offers every pending auto-enrol) runs once right after the queues are up, so a deploy
 *    that wires a real allocator enrols the sessions that were waiting, and a worker that was down at 03:00 catches up;
 *  - the ban reconciliation re-enqueues `member-banned` for banned members who still hold active registrations, so the deploy
 *    window of the old no-op handler closes at the first boot instead of at 05:45.
 *  - the post-game billing sweep (wallet-and-akahu-billing CR-13) bills every ended PUBLISHED session at the first boot, oldest
 *    first (B9), instead of waiting for the next 5-minute tick.
 *  - `daily-overdue` (CR-13, RF-11) marks the payments that fell due while the worker was down, instead of waiting for 04:00.
 *  - `akahu-reconcile` (CR-13, RF-11) applies the Akahu results whose webhooks were missed while the worker was down.
 *  - `invoice-reconcile` (tax-invoices-and-exports) queues invoice issuance for every team with a PAID payment still unnumbered:
 *    the backfill of payments PAID before the feature and of any lost issuance job, at the first boot.
 * All six queues are `exclusive`, so each is a no-op when a run is already queued or active. A failure to enqueue is logged and
 * never stops the worker (the cron slots are still registered), and one failing sweep never prevents the others.
 */
export async function enqueueBootSweeps(
  runner: Pick<JobRunner, 'enqueue'>,
  logger: Pick<Logger, 'info' | 'warn'>,
): Promise<void> {
  try {
    const jobId = await runner.enqueue(QUEUE_NAMES.recurrenceMaterialisation, { source: 'boot' });
    logger.info(
      { event: 'session.recurrence.boot_sweep', enqueued: jobId !== null },
      jobId === null ? 'boot sweep already queued' : 'boot sweep queued',
    );
  } catch (error) {
    logger.warn(
      { event: 'session.recurrence.boot_sweep_failed', err: error },
      'boot sweep could not be queued',
    );
  }
  try {
    const jobId = await runner.enqueue(QUEUE_NAMES.registrationBanReconcile, { source: 'boot' });
    logger.info(
      { event: 'registration.ban_reconcile.boot_sweep', enqueued: jobId !== null },
      jobId === null ? 'ban reconciliation already queued' : 'ban reconciliation queued',
    );
  } catch (error) {
    logger.warn(
      { event: 'registration.ban_reconcile.boot_sweep_failed', err: error },
      'ban reconciliation could not be queued',
    );
  }
  try {
    const jobId = await runner.enqueue(QUEUE_NAMES.postGameBilling, { source: 'boot' });
    logger.info(
      { event: 'billing.sweep.boot', enqueued: jobId !== null },
      jobId === null ? 'post-game billing sweep already queued' : 'post-game billing sweep queued',
    );
  } catch (error) {
    logger.warn(
      { event: 'billing.sweep.boot_failed', err: error },
      'post-game billing sweep could not be queued',
    );
  }
  try {
    const jobId = await runner.enqueue(QUEUE_NAMES.dailyOverdue, { source: 'boot' });
    logger.info(
      { event: 'billing.overdue.boot', enqueued: jobId !== null },
      jobId === null ? 'daily-overdue already queued' : 'daily-overdue queued',
    );
  } catch (error) {
    logger.warn(
      { event: 'billing.overdue.boot_failed', err: error },
      'daily-overdue could not be queued',
    );
  }
  try {
    const jobId = await runner.enqueue(QUEUE_NAMES.akahuReconcile, { source: 'boot' });
    logger.info(
      { event: 'akahu.reconcile.boot', enqueued: jobId !== null },
      jobId === null ? 'akahu-reconcile already queued' : 'akahu-reconcile queued',
    );
  } catch (error) {
    logger.warn(
      { event: 'akahu.reconcile.boot_failed', err: error },
      'akahu-reconcile could not be queued',
    );
  }
  try {
    const jobId = await runner.enqueue(QUEUE_NAMES.invoiceReconcile, { source: 'boot' });
    logger.info(
      { event: 'invoice.reconcile.boot', enqueued: jobId !== null },
      jobId === null ? 'invoice-reconcile already queued' : 'invoice-reconcile queued',
    );
  } catch (error) {
    logger.warn(
      { event: 'invoice.reconcile.boot_failed', err: error },
      'invoice-reconcile could not be queued',
    );
  }
}
