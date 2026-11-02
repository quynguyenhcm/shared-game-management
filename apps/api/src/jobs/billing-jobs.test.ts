/**
 * The `bill-session` job's payload contract and failure handling (AC-ERROR-9), and the CLI trigger guard, against a fake run.
 * The billing transaction itself is covered on real PostgreSQL in `billing-engine.int.test.ts`.
 */
import { describe, expect, it, vi } from 'vitest';
import { parseBillSessionTrigger } from '../cli-guards.ts';
import { createManualClock } from '../lib/clock.ts';
import { NonRetryableJobError, type JobContext } from '../lib/jobs/jobs.ts';
import { BillSessionPayload, billSessionKey, createBillSessionHandler } from './bill-session.ts';

const SESSION = '2f2e2d2c-2b2a-4928-8726-252423222120';

function context() {
  const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
  const ctx = {
    logger,
    jobId: 'job-1',
    queue: 'bill-session',
    retryCount: 0,
    retryLimit: 3,
    signal: new AbortController().signal,
  } as unknown as JobContext;
  return { logger, ctx };
}

function handlerFor(run: ReturnType<typeof vi.fn>) {
  return createBillSessionHandler({
    db: {} as never,
    jobs: { enqueue: vi.fn() },
    clock: createManualClock(),
    crypto: {} as never,
    webBaseUrl: 'https://app.example.test',
    run: run as never,
  });
}

describe('bill-session handler', () => {
  it('runs the billing transaction for a valid payload', async () => {
    const run = vi.fn().mockResolvedValue({ kind: 'completed' });
    const { ctx } = context();
    await handlerFor(run)({ sessionId: SESSION, trigger: 'sweep' }, ctx);
    expect(run).toHaveBeenCalledOnce();
    expect(run.mock.calls[0]?.[1]).toEqual({ sessionId: SESSION });
  });

  it('fails a malformed payload at once, naming only field paths', async () => {
    const run = vi.fn();
    const { ctx, logger } = context();
    await expect(
      handlerFor(run)({ sessionId: 'nope', secret: 'hush' }, ctx),
    ).rejects.toBeInstanceOf(NonRetryableJobError);
    expect(run).not.toHaveBeenCalled();
    expect(JSON.stringify(logger.error.mock.calls)).not.toContain('hush');
  });

  it('logs billing.session.failed with ids, error class and SQLSTATE only, and lets a transient error retry', async () => {
    const run = vi
      .fn()
      .mockRejectedValue(
        Object.assign(new Error('connection to host 10.0.0.5 lost: secret'), { code: '57P01' }),
      );
    const { ctx, logger } = context();
    const thrown = await handlerFor(run)({ sessionId: SESSION, trigger: 'sweep' }, ctx).then(
      () => undefined,
      (error: unknown) => error as Error & { cause?: unknown },
    );
    expect(thrown).toBeInstanceOf(Error);
    expect(thrown).not.toBeInstanceOf(NonRetryableJobError);
    // The generic job runner logs the thrown error (message, stack, cause chain): it must carry no driver text.
    expect(thrown?.message).toContain('57P01');
    expect(thrown?.message).not.toContain('secret');
    expect(thrown?.cause).toBeUndefined();
    expect(thrown?.stack ?? '').not.toContain('secret');
    expect(logger.error).toHaveBeenCalledWith(
      {
        event: 'billing.session.failed',
        sessionId: SESSION,
        errorClass: 'Error',
        sqlState: '57P01',
      },
      expect.any(String),
    );
    expect(JSON.stringify(logger.error.mock.calls)).not.toContain('secret');
  });

  it('ends a constraint failure (SQLSTATE class 23) as a permanent failure, without retries', async () => {
    const run = vi
      .fn()
      .mockRejectedValue(Object.assign(new Error('payment lines'), { code: '23514' }));
    const { ctx, logger } = context();
    const thrown = await handlerFor(run)({ sessionId: SESSION, trigger: 'sweep' }, ctx).then(
      () => undefined,
      (error: unknown) => error as Error & { cause?: unknown },
    );
    expect(thrown).toBeInstanceOf(NonRetryableJobError);
    expect(thrown?.cause).toBeUndefined();
    expect(thrown?.message).not.toContain('payment lines');
    expect(logger.error).toHaveBeenCalledWith(
      expect.objectContaining({ event: 'billing.session.failed', sqlState: '23514' }),
      expect.any(String),
    );
  });
});

describe('bill-session trigger', () => {
  it('keys the job like the sweep does, so a hand-typed trigger and a queued job collapse into one', () => {
    expect(billSessionKey(SESSION)).toBe(`bill-session:${SESSION}`);
    expect(
      parseBillSessionTrigger(JSON.stringify({ sessionId: SESSION, trigger: 'manual' })),
    ).toEqual({
      payload: { sessionId: SESSION, trigger: 'manual' },
      singletonKey: `bill-session:${SESSION}`,
    });
  });

  it('rejects missing, malformed and extra-field payloads without echoing them', () => {
    expect(parseBillSessionTrigger(undefined)).toHaveProperty('error');
    expect(parseBillSessionTrigger('{nope')).toHaveProperty('error');
    const extra = parseBillSessionTrigger(
      JSON.stringify({ sessionId: SESSION, trigger: 'manual', userId: 'secret-value' }),
    );
    expect(extra).toHaveProperty('error');
    expect(JSON.stringify(extra)).not.toContain('secret-value');
    expect(BillSessionPayload.safeParse({ sessionId: SESSION, trigger: 'nope' }).success).toBe(
      false,
    );
  });
});
