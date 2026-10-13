import { systemClock, type Clock } from '../lib/clock.ts';
import type { FieldCrypto } from '../lib/crypto/crypto.ts';
import type { Database } from '../lib/db/kysely.ts';
import type { JobHandler, JobRunner, QueueDefinition } from '../lib/jobs/jobs.ts';
import type { Notifier } from '../lib/notifications/notifier.ts';
import { noopMemberBannedHandler, type MemberBannedHandler } from '../modules/teams/ban-hook.ts';
import { createAuthCleanupHandler } from './auth-cleanup.ts';
import { heartbeatHandler } from './heartbeat.ts';
import { createMemberBannedJobHandler } from './member-banned.ts';
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
  /** Opens the sealed `send-email` payloads (reset links); the API seals them with the same keyring. */
  readonly crypto: FieldCrypto;
  /** Kysely handle over the worker's pool (the `auth-cleanup` handler deletes through it). */
  readonly db: Database;
  /** Time source for handlers that judge staleness; defaults to the system clock. */
  readonly clock?: Clock;
  /**
   * What a ban triggers (ADR 0015). Defaults to the no-op until registration-and-waitlist supplies its handler;
   * this option is the only place the port is injected.
   */
  readonly memberBannedHandler?: MemberBannedHandler;
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
