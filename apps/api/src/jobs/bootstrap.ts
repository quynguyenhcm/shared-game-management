import { systemClock, type Clock } from '../lib/clock.ts';
import type { FieldCrypto } from '../lib/crypto/crypto.ts';
import type { Database } from '../lib/db/kysely.ts';
import type { JobHandler, JobRunner, QueueDefinition } from '../lib/jobs/jobs.ts';
import type { Notifier } from '../lib/notifications/notifier.ts';
import type { Logger } from '../lib/logger/logger.ts';
import type { SessionAllocatorPort } from '../modules/sessions/allocator-port.ts';
import { DEFAULT_RECURRENCE_HORIZON_DAYS } from '../modules/sessions/materialise.ts';
import { noopMemberBannedHandler, type MemberBannedHandler } from '../modules/teams/ban-hook.ts';
import { createAuthCleanupHandler } from './auth-cleanup.ts';
import { createBanReconcileHandler } from './ban-reconcile.ts';
import { heartbeatHandler } from './heartbeat.ts';
import { createMemberBannedJobHandler } from './member-banned.ts';
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
 * Both queues are `exclusive`, so each is a no-op when a run is already queued or active. A failure to enqueue is logged and
 * never stops the worker (the cron slots are still registered), and one failing sweep never prevents the other.
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
}
