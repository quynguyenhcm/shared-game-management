import { describe, expect, it, vi } from 'vitest';
import { createManualClock } from '../lib/clock.ts';
import { NonRetryableJobError, type JobContext } from '../lib/jobs/jobs.ts';
import { noopSessionAllocator } from '../modules/sessions/allocator-port.ts';
import { SessionAutoEnrolPayload } from '../modules/sessions/auto-enrol.ts';
import { createSessionAutoEnrolHandler } from './session-auto-enrol.ts';

const UUID = '0b6f0a5e-5d0b-4a52-9d52-0d9a0f0b1c11';
const OTHER = '3b241101-e2bb-4255-8caf-4136c566a962';

function context() {
  const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
  const ctx = {
    logger,
    jobId: 'job-1',
    queue: 'session-auto-enrol',
    retryCount: 0,
    retryLimit: 3,
    signal: new AbortController().signal,
  } as unknown as JobContext;
  return { logger, ctx };
}

describe('SessionAutoEnrolPayload', () => {
  it('is strict: ids and a trigger only', () => {
    expect(
      SessionAutoEnrolPayload.safeParse({ sessionId: UUID, teamId: OTHER, trigger: 'publish' })
        .success,
    ).toBe(true);
    for (const trigger of ['sweep', 'manual']) {
      expect(
        SessionAutoEnrolPayload.safeParse({ sessionId: UUID, teamId: OTHER, trigger }).success,
      ).toBe(true);
    }
    expect(SessionAutoEnrolPayload.safeParse({ sessionId: UUID, teamId: OTHER }).success).toBe(
      false,
    );
    expect(
      SessionAutoEnrolPayload.safeParse({ sessionId: UUID, teamId: OTHER, trigger: 'x' }).success,
    ).toBe(false);
    expect(
      SessionAutoEnrolPayload.safeParse({ sessionId: 'nope', teamId: OTHER, trigger: 'publish' })
        .success,
    ).toBe(false);
    expect(
      SessionAutoEnrolPayload.safeParse({
        sessionId: UUID,
        teamId: OTHER,
        trigger: 'publish',
        extra: 1,
      }).success,
    ).toBe(false);
  });
});

describe('session-auto-enrol handler', () => {
  it('fails a malformed payload at once, without retries, logging field paths only', async () => {
    const handler = createSessionAutoEnrolHandler({
      // Never reached: a malformed payload fails before any query.
      db: {} as never,
      clock: createManualClock(new Date('2026-10-20T00:00:00Z')),
      allocator: noopSessionAllocator,
    });
    const { ctx, logger } = context();
    await expect(handler({ sessionId: 'nope', secret: 'x' }, ctx)).rejects.toBeInstanceOf(
      NonRetryableJobError,
    );
    expect(logger.error).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(logger.error.mock.calls)).not.toContain('secret');
  });
});
