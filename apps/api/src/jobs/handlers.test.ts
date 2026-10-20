import { describe, expect, it, vi } from 'vitest';
import type { JobContext, JobRunner } from '../lib/jobs/jobs.ts';
import { NonRetryableJobError } from '../lib/jobs/jobs.ts';
import { createInMemoryNotifier } from '../lib/notifications/adapters/in-memory.ts';
import type { EmailMessage } from '../lib/notifications/notifier.ts';
import { testCrypto } from '../../test/helpers/app-deps.ts';
import { noopSessionAllocator } from '../modules/sessions/allocator-port.ts';
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
    await createSendEmailHandler(notifier, testCrypto())(message, ctx);
    expect(notifier.sent).toHaveLength(1);
  });

  it('rethrows transient errors so pg-boss retries', async () => {
    const notifier = createInMemoryNotifier();
    notifier.failWith('transient');
    const { ctx } = context();
    const error = await createSendEmailHandler(notifier, testCrypto())(message, ctx).catch(
      (e: unknown) => e,
    );
    expect(error).not.toBeInstanceOf(NonRetryableJobError);
    expect((error as Error).name).toBe('TransientDeliveryError');
  });

  it.each(['permanent', 'configuration'] as const)(
    'logs %s failures at error and fails the job without retries',
    async (kind) => {
      const notifier = createInMemoryNotifier();
      notifier.failWith(kind);
      const { ctx, logs } = context();
      const error = await createSendEmailHandler(notifier, testCrypto())(message, ctx).catch(
        (e: unknown) => e,
      );
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
    const error = await createSendEmailHandler(notifier, testCrypto())(payload as never, ctx).catch(
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

  it('enqueueEmail with crypto files only a sealed payload: the message never appears in the job data', async () => {
    const enqueue = vi.fn().mockResolvedValue('id-2');
    const secret = { ...message, text: 'Link: https://x.test/reset?token=raw-secret-token' };
    await enqueueEmail({ enqueue }, secret, { crypto: testCrypto() });
    const [queue, data, options] = enqueue.mock.calls[0] as [
      string,
      Record<string, unknown>,
      object,
    ];
    expect(queue).toBe('send-email');
    expect(options).toEqual({ singletonKey: 'notify:unit:1' });
    expect(Object.keys(data).sort()).toEqual(['idempotencyKey', 'sealed']);
    expect(data.idempotencyKey).toBe('unit:1');
    expect(JSON.stringify(data)).not.toContain('raw-secret-token');
    expect(JSON.stringify(data)).not.toContain(message.to);
  });

  it('opens a sealed payload and delivers the original message', async () => {
    const enqueue = vi.fn().mockResolvedValue('id-3');
    const crypto = testCrypto();
    await enqueueEmail({ enqueue }, message, { crypto });
    const notifier = createInMemoryNotifier();
    const { ctx } = context();
    await createSendEmailHandler(notifier, crypto)(enqueue.mock.calls[0]?.[1] as EmailMessage, ctx);
    expect(notifier.sent).toHaveLength(1);
    expect(notifier.sent[0]).toMatchObject(message);
  });

  it('fails a sealed payload moved to another idempotency key at once, without calling the notifier', async () => {
    const enqueue = vi.fn().mockResolvedValue('id-4');
    const crypto = testCrypto();
    await enqueueEmail({ enqueue }, message, { crypto });
    const sealed = enqueue.mock.calls[0]?.[1] as { sealed: string };
    const notifier = createInMemoryNotifier();
    const send = vi.spyOn(notifier, 'send');
    const { ctx, logs } = context();
    const error = await createSendEmailHandler(notifier, crypto)(
      { ...sealed, idempotencyKey: 'unit:other' } as never,
      ctx,
    ).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(NonRetryableJobError);
    expect(send).not.toHaveBeenCalled();
    expect(logs.find((entry) => entry.level === 'error')?.fields).toMatchObject({
      event: 'notification.invalid_payload',
    });
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
      crypto: testCrypto(),
      db: {} as never, // the auth-cleanup handler only touches it when a job runs
      sessionAllocator: noopSessionAllocator,
      expireSecondsOverride: 5,
    });
    expect(defined.sort()).toEqual(QUEUES.map((queue) => queue.name).sort());
    expect(worked.sort()).toEqual(QUEUES.map((queue) => queue.name).sort());
    expect(scheduled.sort()).toEqual(
      [
        'auth-cleanup',
        'daily-overdue',
        'post-game-billing',
        'recurrence-materialisation',
        'skill-progression',
      ].sort(),
    );
  });

  it('wires the injected MemberBannedHandler into the member-banned queue, and the no-op by default', async () => {
    const handlers = new Map<string, unknown>();
    const runner = {
      defineQueue: () => Promise.resolve(),
      work: (queue: string, handler: unknown) => {
        handlers.set(queue, handler);
        return Promise.resolve();
      },
      schedule: () => Promise.resolve(),
      previewSchedule: () => [],
    } as unknown as JobRunner;
    const base = {
      runner,
      notifier: createInMemoryNotifier(),
      crypto: testCrypto(),
      db: {} as never,
      sessionAllocator: noopSessionAllocator,
    };
    await registerJobs(base);
    const defaultHandler = handlers.get('member-banned');
    expect(defaultHandler).toBeTypeOf('function');
    await registerJobs({
      ...base,
      memberBannedHandler: { name: 'custom', handle: () => Promise.resolve({ affected: 0 }) },
    });
    expect(handlers.get('member-banned')).toBeTypeOf('function');
    expect(handlers.get('member-banned')).not.toBe(defaultHandler);
  });
});

describe('skill-progression wiring', () => {
  it('works the skill-progression queue with the real handler, not the placeholder', async () => {
    const handlers = new Map<string, (data: object, ctx: JobContext) => Promise<void>>();
    const runner = {
      defineQueue: () => Promise.resolve(),
      work: (queue: string, handler: (data: object, ctx: JobContext) => Promise<void>) => {
        handlers.set(queue, handler);
        return Promise.resolve();
      },
      schedule: () => Promise.resolve(),
      previewSchedule: () => [],
    } as unknown as JobRunner;
    // A database that is down: the placeholder would complete, the real sweep must fail.
    const db = {
      selectFrom: () => {
        throw new Error('db down');
      },
    } as never;
    await registerJobs({
      runner,
      notifier: createInMemoryNotifier(),
      crypto: testCrypto(),
      db,
      sessionAllocator: noopSessionAllocator,
    });
    const handler = handlers.get('skill-progression');
    expect(handler).toBeTypeOf('function');
    const { ctx } = context();
    await expect(handler?.({}, { ...ctx, signal: new AbortController().signal })).rejects.toThrow(
      /db down/,
    );
  });
});

describe('recurrence wiring (session-scheduling-engine)', () => {
  function wired() {
    const handlers = new Map<string, (data: object, ctx: JobContext) => Promise<void>>();
    const runner = {
      defineQueue: () => Promise.resolve(),
      work: (queue: string, handler: (data: object, ctx: JobContext) => Promise<void>) => {
        handlers.set(queue, handler);
        return Promise.resolve();
      },
      schedule: () => Promise.resolve(),
      previewSchedule: () => [],
    } as unknown as JobRunner;
    return { handlers, runner };
  }

  it('works the recurrence-materialisation slot with the real sweep, not the placeholder', async () => {
    const { handlers, runner } = wired();
    // A database that is down: the placeholder would complete, the real sweep must fail.
    const db = {
      selectFrom: () => {
        throw new Error('db down');
      },
    } as never;
    await registerJobs({
      runner,
      notifier: createInMemoryNotifier(),
      crypto: testCrypto(),
      db,
      sessionAllocator: noopSessionAllocator,
    });
    const { ctx } = context();
    await expect(
      handlers.get('recurrence-materialisation')?.(
        {},
        { ...ctx, signal: new AbortController().signal },
      ),
    ).rejects.toThrow(/db down/);
  });

  it('works the recurrence-rule queue with a handler that rejects a malformed payload without retries', async () => {
    const { handlers, runner } = wired();
    await registerJobs({
      runner,
      notifier: createInMemoryNotifier(),
      crypto: testCrypto(),
      db: {} as never,
      sessionAllocator: noopSessionAllocator,
    });
    const { ctx } = context();
    await expect(handlers.get('recurrence-rule')?.({ nope: true }, ctx)).rejects.toBeInstanceOf(
      NonRetryableJobError,
    );
  });
});
