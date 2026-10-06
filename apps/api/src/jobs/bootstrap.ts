import { systemClock, type Clock } from '../lib/clock.ts';
import type { Database } from '../lib/db/kysely.ts';
import type { JobHandler, JobRunner, QueueDefinition } from '../lib/jobs/jobs.ts';
import type { Notifier } from '../lib/notifications/notifier.ts';
import { createAuthCleanupHandler } from './auth-cleanup.ts';
import { heartbeatHandler } from './heartbeat.ts';
import { QUEUES, QUEUE_NAMES, withExpireOverride } from './registry.ts';
import { SCHEDULES, placeholderHandler, registerSchedules } from './schedules.ts';
import { createSendEmailHandler } from './send-email.ts';

export interface ExtraQueue {
  readonly definition: QueueDefinition;
  readonly handler: JobHandler;
}

export interface RegisterJobsOptions {
  /** A started worker-role runner. */
  readonly runner: JobRunner;
  readonly notifier: Notifier;
  /** Kysely handle over the worker's pool (the `auth-cleanup` handler deletes through it). */
  readonly db: Database;
  /** Time source for handlers that judge staleness; defaults to the system clock. */
  readonly clock?: Clock;
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
  const handlers: Record<string, JobHandler> = {
    // Placeholders first: a slot that has a real handler below overrides its placeholder.
    ...Object.fromEntries(SCHEDULES.map((slot) => [slot.name, placeholderHandler(slot.name)])),
    [QUEUE_NAMES.heartbeat]: heartbeatHandler,
    [QUEUE_NAMES.sendEmail]: createSendEmailHandler(options.notifier) as unknown as JobHandler,
    [QUEUE_NAMES.authCleanup]: createAuthCleanupHandler({
      db: options.db,
      clock: options.clock ?? systemClock,
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
