/**
 * The `recurrence-rule` handler's job outcome (AC-ERROR-9) and the boot sweep enqueue, against a fake run. The run itself is
 * covered on real PostgreSQL in `sessions-job.int.test.ts`.
 */
import { describe, expect, it, vi } from 'vitest';
import { createManualClock } from '../lib/clock.ts';
import { NonRetryableJobError, type JobContext } from '../lib/jobs/jobs.ts';
import { noopSessionAllocator } from '../modules/sessions/allocator-port.ts';
import { classifySessionError } from '../modules/sessions/errors.ts';
import type { MaterialiseResult } from '../modules/sessions/materialise.ts';
import { enqueueBootSweeps } from './bootstrap.ts';
import { createRecurrenceRuleHandler } from './recurrence-rule.ts';

const RULE = '0b6f0a5e-5d0b-4a52-9d52-0d9a0f0b1c11';
const TEAM = '3b241101-e2bb-4255-8caf-4136c566a962';
const PAYLOAD = { ruleId: RULE, teamId: TEAM, trigger: 'manual' };

function context() {
  const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
  const ctx = {
    logger,
    jobId: 'job-1',
    queue: 'recurrence-rule',
    retryCount: 0,
    retryLimit: 3,
    signal: new AbortController().signal,
  } as unknown as JobContext;
  return { logger, ctx };
}

const result = (failures: MaterialiseResult['failures']): MaterialiseResult => ({
  created: 0,
  published: 0,
  savedAsDraft: 0,
  draftsRetried: 0,
  autoEnrolled: 0,
  failed: failures.length,
  skipped: undefined,
  windowStart: '2026-10-20' as MaterialiseResult['windowStart'],
  failures,
});

function handlerFor(failures: MaterialiseResult['failures']) {
  const run = vi.fn().mockResolvedValue(result(failures));
  const handler = createRecurrenceRuleHandler({
    db: {} as never,
    clock: createManualClock(),
    allocator: noopSessionAllocator,
    jobs: { enqueue: vi.fn() },
    horizonDays: 28,
    webBaseUrl: 'https://app.example.test',
    run,
  });
  return { handler, run };
}

const failure = (code: string) => classifySessionError(Object.assign(new Error('boom'), { code }));

describe('recurrence-rule handler (AC-ERROR-9)', () => {
  it('completes when the run had no failures, passing the horizon and the parsed payload', async () => {
    const { handler, run } = handlerFor([]);
    await expect(handler(PAYLOAD, context().ctx)).resolves.toBeUndefined();
    expect(run).toHaveBeenCalledWith(expect.objectContaining({ horizonDays: 28 }), PAYLOAD);
  });

  it('throws a plain Error, so pg-boss retries, when any failure was transient', async () => {
    const { handler } = handlerFor([failure('23514'), failure('55P03')]);
    const error = await handler(PAYLOAD, context().ctx).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(Error);
    expect(error).not.toBeInstanceOf(NonRetryableJobError);
  });

  it('throws NonRetryableJobError when every failure was permanent', async () => {
    const { handler } = handlerFor([failure('23514'), failure('22007')]);
    await expect(handler(PAYLOAD, context().ctx)).rejects.toBeInstanceOf(NonRetryableJobError);
  });

  it('fails a malformed payload at once, without running and without echoing it', async () => {
    const { handler, run } = handlerFor([]);
    const { ctx, logger } = context();
    await expect(handler({ ruleId: 'x', secret: 'hush' }, ctx)).rejects.toBeInstanceOf(
      NonRetryableJobError,
    );
    expect(run).not.toHaveBeenCalled();
    expect(JSON.stringify(logger.error.mock.calls)).not.toContain('hush');
  });
});

describe('boot sweep (AC-ASYNC-5)', () => {
  const logger = { info: vi.fn(), warn: vi.fn() };

  it('queues the recurrence-materialisation sweep once', async () => {
    const enqueue = vi.fn().mockResolvedValue('job-1');
    await enqueueBootSweeps({ enqueue }, logger);
    expect(enqueue).toHaveBeenCalledTimes(1);
    expect(enqueue).toHaveBeenCalledWith('recurrence-materialisation', expect.any(Object));
  });

  it('never stops the worker when the enqueue fails', async () => {
    const enqueue = vi.fn().mockRejectedValue(new Error('db down'));
    await expect(enqueueBootSweeps({ enqueue }, logger)).resolves.toBeUndefined();
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ event: 'session.recurrence.boot_sweep_failed' }),
      expect.any(String),
    );
  });
});
