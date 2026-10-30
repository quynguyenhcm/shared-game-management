/**
 * `registration-ban-reconcile` job wrapper (architecture Q4 sweep S-a, AC-ASYNC-3): it runs the module's reconciliation and
 * logs the counts, nothing else. The sweep's SQL and its idempotence are proven against a real database in
 * `registrations-ban.int.test.ts`.
 */
import { describe, expect, it } from 'vitest';
import { createManualClock } from '../lib/clock.ts';
import type { Database } from '../lib/db/kysely.ts';
import type { JobContext } from '../lib/jobs/jobs.ts';
import { createBanReconcileHandler } from './ban-reconcile.ts';

function context(signal = new AbortController().signal) {
  const infos: Record<string, unknown>[] = [];
  const ctx = {
    logger: {
      info: (bindings: Record<string, unknown>) => infos.push(bindings),
      warn: () => undefined,
      error: () => undefined,
    },
    jobId: 'job-1',
    queue: 'registration-ban-reconcile',
    retryCount: 0,
    retryLimit: 3,
    signal,
  } as unknown as JobContext;
  return { ctx, infos };
}

describe('createBanReconcileHandler', () => {
  it('runs the reconciliation with the injected clock and logs registration.ban_reconcile.completed with counts only', async () => {
    const clock = createManualClock(new Date('2026-10-25T17:45:00Z'));
    const seen: Date[] = [];
    const handler = createBanReconcileHandler({
      db: {} as Database,
      jobs: { enqueue: () => Promise.resolve(null) },
      clock,
      reconcile: (deps) => {
        seen.push(deps.clock.now());
        return Promise.resolve({ scanned: 3, enqueued: 2, alreadyQueued: 1, invalid: 0 });
      },
    });
    const { ctx, infos } = context();
    await handler({ source: 'schedule' }, ctx);
    expect(seen).toEqual([new Date('2026-10-25T17:45:00Z')]);
    const completed = infos.find((line) => line.event === 'registration.ban_reconcile.completed');
    expect(completed).toMatchObject({ scanned: 3, enqueued: 2, alreadyQueued: 1, invalid: 0 });
    expect(Object.keys(completed ?? {}).sort()).toEqual(
      ['alreadyQueued', 'durationMs', 'enqueued', 'event', 'invalid', 'scanned'].sort(),
    );
  });

  it('lets a failure propagate so the job ends failed and visible', async () => {
    const handler = createBanReconcileHandler({
      db: {} as Database,
      jobs: { enqueue: () => Promise.resolve(null) },
      clock: createManualClock(),
      reconcile: () => Promise.reject(new Error('db down')),
    });
    await expect(handler({}, context().ctx)).rejects.toThrow('db down');
  });
});
