import { Writable } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';
import { createLogger } from '../logger/logger.ts';
import {
  createJobRunner,
  currentTrace,
  extractTraceMeta,
  injectTraceMeta,
  MIN_RETENTION_DAYS,
  newTraceContext,
  NonRetryableJobError,
  parseTraceparent,
  runWithTrace,
  toBossOptions,
  toQueueOptions,
  toSendOptions,
  type BossLike,
  type JobHandler,
  type QueueDefinition,
} from './jobs.ts';

const definition: QueueDefinition = {
  name: 'unit-queue',
  policy: 'exclusive',
  retryLimit: 3,
  retryDelay: 5,
  retryBackoff: true,
  expireInSeconds: 900,
  retentionDays: 7,
};

function capture(): { stream: Writable; lines: () => Record<string, unknown>[] } {
  const chunks: string[] = [];
  const stream = new Writable({
    write(chunk: Buffer, _encoding, callback) {
      chunks.push(chunk.toString());
      callback();
    },
  });
  return {
    stream,
    lines: () =>
      chunks
        .join('')
        .split('\n')
        .filter((line) => line.length > 0)
        .map((line) => JSON.parse(line) as Record<string, unknown>),
  };
}

function makeLogger() {
  const sink = capture();
  const logger = createLogger(
    {
      service: 'worker',
      version: 'test',
      environment: 'test',
      level: 'debug',
      format: 'json',
      output: 'stdout',
      redactPatterns: [],
    },
    sink.stream,
  );
  return { logger, lines: sink.lines };
}

type Fake = { [K in keyof BossLike]: ReturnType<typeof vi.fn> };

function fakeBoss(overrides: Partial<Fake> = {}): { boss: BossLike; fake: Fake } {
  const fake = {
    on: vi.fn(),
    start: vi.fn().mockResolvedValue(undefined),
    stop: vi.fn().mockResolvedValue(undefined),
    createQueue: vi.fn().mockResolvedValue(undefined),
    updateQueue: vi.fn().mockResolvedValue(undefined),
    send: vi.fn().mockResolvedValue('job-1'),
    work: vi.fn().mockResolvedValue('worker-1'),
    schedule: vi.fn().mockResolvedValue(undefined),
    getSchedules: vi.fn().mockResolvedValue([]),
    getJobById: vi.fn().mockResolvedValue(null),
    previewSchedule: vi.fn().mockReturnValue([]),
    ...overrides,
  };
  return { boss: fake as unknown as BossLike, fake };
}

const databaseUrl = 'postgres://sgm:sgm@localhost:5432/sgm';

describe('option mapping', () => {
  it('maps a queue definition to pg-boss queue options with at least 7 days of retention', () => {
    expect(toQueueOptions(definition)).toEqual({
      policy: 'exclusive',
      retryLimit: 3,
      retryDelay: 5,
      retryBackoff: true,
      expireInSeconds: 900,
      deleteAfterSeconds: 7 * 24 * 3600,
    });
    expect(MIN_RETENTION_DAYS).toBe(7);
    expect(() => toQueueOptions({ ...definition, retentionDays: 6 })).toThrow(/retention/i);
  });

  it('never lets an application process run DDL, and only the worker supervises and schedules', () => {
    const producer = toBossOptions({ databaseUrl, role: 'producer' });
    expect(producer).toMatchObject({
      connectionString: databaseUrl,
      migrate: false,
      createSchema: false,
      supervise: false,
      schedule: false,
    });
    const worker = toBossOptions({ databaseUrl, role: 'worker', superviseIntervalSeconds: 3 });
    expect(worker).toMatchObject({
      migrate: false,
      createSchema: false,
      supervise: true,
      schedule: true,
      superviseIntervalSeconds: 3,
      monitorIntervalSeconds: 3,
    });
    expect(worker.options).toContain('TimeZone=UTC');
  });

  it('maps enqueue options: singletonKey, startAfter and the transaction adapter', async () => {
    expect(toSendOptions({})).toEqual({});
    const executeQuery = vi.fn().mockResolvedValue({ rows: [{ id: 'x' }] });
    const sendOptions = toSendOptions({
      singletonKey: 'bill-session:1',
      startAfter: new Date('2026-01-01T00:00:00Z'),
      trx: { executeQuery },
    });
    expect(sendOptions).toMatchObject({
      singletonKey: 'bill-session:1',
      startAfter: new Date('2026-01-01T00:00:00Z'),
    });
    const result = await sendOptions.db?.executeSql('INSERT INTO t VALUES ($1)', ['a']);
    expect(result).toEqual({ rows: [{ id: 'x' }] });
    const compiled = executeQuery.mock.calls[0]?.[0] as { sql: string; parameters: unknown[] };
    expect(compiled.sql).toBe('INSERT INTO t VALUES ($1)');
    expect(compiled.parameters).toEqual(['a']);
  });
});

describe('trace context in _meta', () => {
  it('injects a W3C traceparent under _meta and extracts it, stripping _meta from handler data', () => {
    const trace = newTraceContext();
    expect(trace.traceparent).toMatch(/^00-[0-9a-f]{32}-[0-9a-f]{16}-01$/);
    const data = injectTraceMeta({ a: 1 }, trace);
    expect(data).toEqual({ a: 1, _meta: { traceparent: trace.traceparent } });
    const extracted = extractTraceMeta(data);
    expect(extracted.data).toEqual({ a: 1 });
    expect(extracted.trace).toMatchObject({ traceId: trace.traceId, spanId: trace.spanId });
  });

  it('uses the ambient trace when present, creates a fresh one otherwise, and tolerates junk', () => {
    const ambient = newTraceContext();
    runWithTrace(ambient, () => {
      expect(currentTrace()).toEqual(ambient);
      expect(extractTraceMeta(injectTraceMeta({})).trace?.traceId).toBe(ambient.traceId);
    });
    expect(currentTrace()).toBeUndefined();
    expect(extractTraceMeta(injectTraceMeta({})).trace?.traceId).toMatch(/^[0-9a-f]{32}$/);
    expect(parseTraceparent('garbage')).toBeUndefined();
    expect(parseTraceparent(`00-${'0'.repeat(32)}-${'1'.repeat(16)}-01`)).toBeUndefined();
    expect(extractTraceMeta({ x: 1, _meta: 'nope' }).trace).toBeUndefined();
    expect(extractTraceMeta({ x: 1 }).data).toEqual({ x: 1 });
  });
});

describe('createJobRunner', () => {
  it('starts as a producer without creating queues or scheduling, and registers definitions only', async () => {
    const { boss, fake } = fakeBoss();
    const { logger } = makeLogger();
    const runner = createJobRunner({ databaseUrl, logger, role: 'producer', boss });
    await runner.start();
    await runner.defineQueue(definition);
    expect(fake.start).toHaveBeenCalledOnce();
    expect(fake.createQueue).not.toHaveBeenCalled();
    await expect(
      runner.schedule('unit-queue', '0 4 * * *', {}, { tz: 'Pacific/Auckland' }),
    ).rejects.toThrow(/worker/);
    await expect(runner.work('unit-queue', vi.fn())).rejects.toThrow(/worker/);
    await runner.stop();
    expect(fake.stop).toHaveBeenCalledOnce();
  });

  it('worker defineQueue creates the queue idempotently and converges its options', async () => {
    const { boss, fake } = fakeBoss();
    const runner = createJobRunner({
      databaseUrl,
      logger: makeLogger().logger,
      role: 'worker',
      boss,
    });
    await runner.defineQueue(definition);
    expect(fake.createQueue).toHaveBeenCalledWith('unit-queue', toQueueOptions(definition));
    expect(fake.updateQueue).toHaveBeenCalledWith('unit-queue', {
      retryLimit: 3,
      retryDelay: 5,
      retryBackoff: true,
      expireInSeconds: 900,
      deleteAfterSeconds: 7 * 24 * 3600,
    });
  });

  it('enqueue injects _meta.traceparent, passes job options and logs job.enqueued', async () => {
    const { boss, fake } = fakeBoss();
    const { logger, lines } = makeLogger();
    const runner = createJobRunner({ databaseUrl, logger, role: 'producer', boss });
    const id = await runner.enqueue('unit-queue', { n: 1 }, { singletonKey: 'k1' });
    expect(id).toBe('job-1');
    const [queue, data, options] = fake.send.mock.calls[0] as [
      string,
      Record<string, unknown>,
      Record<string, unknown>,
    ];
    expect(queue).toBe('unit-queue');
    expect(data.n).toBe(1);
    expect((data._meta as { traceparent: string }).traceparent).toMatch(/^00-/);
    expect(options).toMatchObject({ singletonKey: 'k1' });
    expect(lines().find((line) => line.event === 'job.enqueued')).toMatchObject({
      event: 'job.enqueued',
      jobId: 'job-1',
      queue: 'unit-queue',
      singletonKey: 'k1',
      deduplicated: false,
    });
  });

  it('reports a suppressed duplicate as null and flags it in the log', async () => {
    const { boss } = fakeBoss({ send: vi.fn().mockResolvedValue(null) });
    const { logger, lines } = makeLogger();
    const runner = createJobRunner({ databaseUrl, logger, role: 'producer', boss });
    await expect(runner.enqueue('unit-queue', {}, { singletonKey: 'dup' })).resolves.toBeNull();
    expect(lines().find((line) => line.event === 'job.enqueued')).toMatchObject({
      jobId: null,
      deduplicated: true,
    });
  });

  it('trigger enqueues for manual invocation; getJob and listSchedules delegate to pg-boss', async () => {
    const schedule = {
      name: 'daily-overdue',
      key: '',
      cron: '0 4 * * *',
      timezone: 'Pacific/Auckland',
      lastJobId: null,
      data: null,
    };
    const job = {
      id: 'j1',
      name: 'unit-queue',
      state: 'failed',
      retryCount: 3,
      retryLimit: 3,
      output: { message: 'boom' },
      data: { a: 1 },
      singletonKey: null,
      createdOn: new Date(),
      startedOn: new Date(),
      completedOn: new Date(),
    };
    const { boss, fake } = fakeBoss({
      getSchedules: vi.fn().mockResolvedValue([schedule]),
      getJobById: vi.fn().mockResolvedValue(job),
      previewSchedule: vi.fn().mockReturnValue([new Date('2026-09-26T15:00:00Z')]),
    });
    const runner = createJobRunner({
      databaseUrl,
      logger: makeLogger().logger,
      role: 'worker',
      boss,
    });
    await expect(runner.trigger('heartbeat', { manual: true })).resolves.toBe('job-1');
    expect((fake.send.mock.calls[0] as unknown[])[0]).toBe('heartbeat');
    await expect(runner.listSchedules()).resolves.toEqual([
      {
        name: 'daily-overdue',
        key: '',
        cron: '0 4 * * *',
        tz: 'Pacific/Auckland',
        lastJobId: null,
      },
    ]);
    await expect(runner.getJob('unit-queue', 'j1')).resolves.toMatchObject({
      id: 'j1',
      queue: 'unit-queue',
      state: 'failed',
      retryCount: 3,
      retryLimit: 3,
      output: { message: 'boom' },
    });
    fake.getJobById.mockResolvedValueOnce(null);
    await expect(runner.getJob('unit-queue', 'missing')).resolves.toBeNull();
    expect(
      runner.previewSchedule('0 4 * * *', { tz: 'Pacific/Auckland', from: new Date(0), count: 1 }),
    ).toHaveLength(1);
  });

  it('schedule forwards cron, data and tz to pg-boss (worker role)', async () => {
    const { boss, fake } = fakeBoss();
    const runner = createJobRunner({
      databaseUrl,
      logger: makeLogger().logger,
      role: 'worker',
      boss,
    });
    await runner.schedule('daily-overdue', '0 4 * * *', {}, { tz: 'Pacific/Auckland' });
    expect(fake.schedule).toHaveBeenCalledWith(
      'daily-overdue',
      '0 4 * * *',
      {},
      { tz: 'Pacific/Auckland' },
    );
  });

  it('logs pg-boss error events instead of crashing the process', () => {
    const { boss, fake } = fakeBoss();
    const { logger, lines } = makeLogger();
    createJobRunner({ databaseUrl, logger, role: 'worker', boss });
    const [event, listener] = fake.on.mock.calls[0] as [string, (error: Error) => void];
    expect(event).toBe('error');
    listener(new Error('pool exploded'));
    expect(lines().find((line) => line.level === 'error')).toMatchObject({
      event: 'jobs.runner.error',
    });
  });
});

describe('work wrapper', () => {
  interface Registered {
    options: Record<string, unknown>;
    run: (
      jobs: Record<string, unknown>[],
    ) => Promise<{ id: string; status: string; output?: Record<string, unknown> }[]>;
  }

  async function register(handler: JobHandler<{ n: number }>, logger = makeLogger()) {
    const { boss, fake } = fakeBoss();
    const runner = createJobRunner({ databaseUrl, logger: logger.logger, role: 'worker', boss });
    await runner.work('unit-queue', handler);
    const [name, options, run] = fake.work.mock.calls[0] as [
      string,
      Record<string, unknown>,
      Registered['run'],
    ];
    expect(name).toBe('unit-queue');
    return { registered: { options, run } satisfies Registered, lines: logger.lines };
  }

  const job = (overrides: Record<string, unknown> = {}) => ({
    id: 'job-9',
    name: 'unit-queue',
    retryCount: 0,
    retryLimit: 3,
    signal: new AbortController().signal,
    data: { n: 7, _meta: { traceparent: newTraceContext().traceparent } },
    ...overrides,
  });

  it('runs the handler with clean data and trace, completes the job and logs started and completed', async () => {
    const seen: { data: unknown; traceId: string | undefined; ambient: string | undefined }[] = [];
    const trace = newTraceContext();
    const { registered, lines } = await register((data, ctx) => {
      seen.push({ data, traceId: ctx.trace.traceId, ambient: currentTrace()?.traceId });
      return Promise.resolve();
    });
    expect(registered.options).toMatchObject({ includeMetadata: true, perJobResults: true });
    const results = await registered.run([
      job({ data: { n: 7, _meta: { traceparent: trace.traceparent } } }),
    ]);
    expect(results).toEqual([{ id: 'job-9', status: 'completed' }]);
    expect(seen).toEqual([{ data: { n: 7 }, traceId: trace.traceId, ambient: trace.traceId }]);
    const events = lines().filter(
      (line) => typeof line.event === 'string' && String(line.event).startsWith('job.'),
    );
    expect(events.map((line) => line.event)).toEqual(['job.started', 'job.completed']);
    expect(events[0]).toMatchObject({
      jobId: 'job-9',
      queue: 'unit-queue',
      attempt: 1,
      traceId: trace.traceId,
    });
    expect(events[1]).toMatchObject({ jobId: 'job-9', queue: 'unit-queue' });
    expect(typeof events[1]?.durationMs).toBe('number');
  });

  it('fails a throwing job for retry with the error message and attempt, logging at warn until the last attempt', async () => {
    const { registered, lines } = await register(() => Promise.reject(new Error('boom')));
    const first = await registered.run([job()]);
    expect(first).toEqual([
      {
        id: 'job-9',
        status: 'failed',
        output: expect.objectContaining({ message: 'boom', attempt: 1 }) as unknown,
      },
    ]);
    const failed = lines().filter((line) => line.event === 'job.failed');
    expect(failed[0]).toMatchObject({
      level: 'warn',
      attempt: 1,
      retryLimit: 3,
      willRetry: true,
      queue: 'unit-queue',
    });
    const final = await registered.run([job({ retryCount: 3 })]);
    expect(final[0]).toMatchObject({ status: 'failed', output: { message: 'boom', attempt: 4 } });
    expect(lines().filter((line) => line.event === 'job.failed')[1]).toMatchObject({
      level: 'error',
      attempt: 4,
      willRetry: false,
      jobId: 'job-9',
    });
  });

  it('routes NonRetryableJobError to a terminal failure without burning retries, logged at error', async () => {
    const { registered, lines } = await register(() =>
      Promise.reject(new NonRetryableJobError('recipient rejected')),
    );
    const results = await registered.run([job({ retryCount: 0 })]);
    expect(results).toEqual([
      {
        id: 'job-9',
        status: 'deadletter',
        output: expect.objectContaining({ message: 'recipient rejected', attempt: 1 }) as unknown,
      },
    ]);
    expect(lines().find((line) => line.event === 'job.failed')).toMatchObject({
      level: 'error',
      willRetry: false,
    });
  });

  it('processes each job of a batch independently and tolerates jobs without _meta', async () => {
    const { registered } = await register((data) =>
      data.n === 2 ? Promise.reject(new Error('second fails')) : Promise.resolve(),
    );
    const results = await registered.run([
      job({ id: 'a', data: { n: 1 } }),
      job({ id: 'b', data: { n: 2 } }),
    ]);
    expect(results.map((result) => [result.id, result.status])).toEqual([
      ['a', 'completed'],
      ['b', 'failed'],
    ]);
  });
});
