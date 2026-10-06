import { describe, expect, it, vi } from 'vitest';
import type { JobContext, JobRunner } from '../lib/jobs/jobs.ts';
import { NonRetryableJobError } from '../lib/jobs/jobs.ts';
import { createInMemoryNotifier } from '../lib/notifications/adapters/in-memory.ts';
import { registerJobs } from './bootstrap.ts';
import { heartbeatHandler } from './heartbeat.ts';
import { QUEUES } from './registry.ts';
import { createSendEmailHandler, enqueueEmail } from './send-email.ts';

function context(): {
  ctx: JobContext;
  logs: { level: string; fields: Record<string, unknown> }[];
} {
  const logs: { level: string; fields: Record<string, unknown> }[] = [];
  const at = (level: string) => (fields: Record<string, unknown>) => {
    logs.push({ level, fields });
  };
  const ctx = {
    logger: { info: at('info'), error: at('error'), warn: at('warn') },
    jobId: 'job-1',
    queue: 'x',
    retryCount: 0,
    retryLimit: 3,
  } as unknown as JobContext;
  return { ctx, logs };
}

const message = {
  to: 'player@example.test',
  subject: 'Hello',
  text: 'Body',
  idempotencyKey: 'unit:1',
};

describe('heartbeat handler', () => {
  it('writes a structured log line carrying the payload and completes', async () => {
    const { ctx, logs } = context();
    await expect(heartbeatHandler({ probe: 'abc' }, ctx)).resolves.toBeUndefined();
    expect(logs[0]).toMatchObject({
      level: 'info',
      fields: { event: 'heartbeat', payload: { probe: 'abc' } },
    });
  });
});

describe('send-email handler', () => {
  it('delivers through the notifier', async () => {
    const notifier = createInMemoryNotifier();
    const { ctx } = context();
    await createSendEmailHandler(notifier)(message, ctx);
    expect(notifier.sent).toHaveLength(1);
  });

  it('rethrows transient errors so pg-boss retries', async () => {
    const notifier = createInMemoryNotifier();
    notifier.failWith('transient');
    const { ctx } = context();
    const error = await createSendEmailHandler(notifier)(message, ctx).catch((e: unknown) => e);
    expect(error).not.toBeInstanceOf(NonRetryableJobError);
    expect((error as Error).name).toBe('TransientDeliveryError');
  });

  it.each(['permanent', 'configuration'] as const)(
    'logs %s failures at error and fails the job without retries',
    async (kind) => {
      const notifier = createInMemoryNotifier();
      notifier.failWith(kind);
      const { ctx, logs } = context();
      const error = await createSendEmailHandler(notifier)(message, ctx).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(NonRetryableJobError);
      expect(logs.find((entry) => entry.level === 'error')?.fields).toMatchObject({
        event: 'notification.failed',
        adapter: 'memory',
        retryable: false,
      });
    },
  );

  it.each([
    ['a non-object payload', 'nope'],
    ['a missing recipient', { subject: 'Hi', text: 'Body', idempotencyKey: 'k' }],
    ['a non-string html body', { ...message, html: { path: '/etc/passwd' } }],
    ['an unknown field', { ...message, attachments: [{ path: '/etc/passwd' }] }],
  ])('fails %s at once without retry and never calls the notifier', async (_label, payload) => {
    const notifier = createInMemoryNotifier();
    const send = vi.spyOn(notifier, 'send');
    const { ctx, logs } = context();
    const error = await createSendEmailHandler(notifier)(payload as never, ctx).catch(
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(NonRetryableJobError);
    expect(send).not.toHaveBeenCalled();
    expect(logs.find((entry) => entry.level === 'error')?.fields).toMatchObject({
      event: 'notification.invalid_payload',
    });
  });

  it('enqueueEmail files the job under singletonKey notify:<idempotencyKey>', async () => {
    const enqueue = vi.fn().mockResolvedValue('id-1');
    await expect(enqueueEmail({ enqueue }, message)).resolves.toBe('id-1');
    expect(enqueue).toHaveBeenCalledWith('send-email', message, { singletonKey: 'notify:unit:1' });
  });
});

describe('registerJobs', () => {
  it('defines every registry queue, works each with a handler and registers the schedules', async () => {
    const defined: string[] = [];
    const worked: string[] = [];
    const scheduled: string[] = [];
    const runner = {
      defineQueue: (definition: { name: string }) => {
        defined.push(definition.name);
        return Promise.resolve();
      },
      work: (queue: string) => {
        worked.push(queue);
        return Promise.resolve();
      },
      schedule: (name: string) => {
        scheduled.push(name);
        return Promise.resolve();
      },
      previewSchedule: () => [],
    } as unknown as JobRunner;
    await registerJobs({
      runner,
      notifier: createInMemoryNotifier(),
      db: {} as never, // the auth-cleanup handler only touches it when a job runs
      expireSecondsOverride: 5,
    });
    expect(defined.sort()).toEqual(QUEUES.map((queue) => queue.name).sort());
    expect(worked.sort()).toEqual(QUEUES.map((queue) => queue.name).sort());
    expect(scheduled.sort()).toEqual(
      ['auth-cleanup', 'daily-overdue', 'post-game-billing', 'recurrence-materialisation'].sort(),
    );
  });
});
