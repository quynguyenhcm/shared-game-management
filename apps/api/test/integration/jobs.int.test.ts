/**
 * Job runner against real PostgreSQL 17 + pg-boss (AC-ASYNC-1/2/3, AC-ERROR-3, AC-ERROR-6).
 * Every file gets its own cloned database, so queues, singleton keys and worker processes here
 * never touch another suite. Child workers run the real production wiring under `node --import tsx`.
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { registerJobs } from '../../src/jobs/bootstrap.ts';
import { QUEUES } from '../../src/jobs/registry.ts';
import { enqueueEmail } from '../../src/jobs/send-email.ts';
import { loadConfig } from '../../src/lib/config/config.ts';
import { createKysely } from '../../src/lib/db/kysely.ts';
import { createJobRunner, type JobRunner, type QueueDefinition } from '../../src/lib/jobs/jobs.ts';
import { createInMemoryNotifier } from '../../src/lib/notifications/adapters/in-memory.ts';
import { createNotifier } from '../../src/lib/notifications/notifier.ts';
import { TransientDeliveryError } from '../../src/lib/notifications/errors.ts';
import { captureLogs } from '../helpers/log-capture.ts';
import { freePort, spawnNode } from '../helpers/spawn-node.ts';
import { createTestDatabase, type TestDatabase } from '../helpers/test-db.ts';
import { sleep, waitFor } from '../helpers/wait-for.ts';

const config = loadConfig();

const testQueue = (name: string, overrides: Partial<QueueDefinition> = {}): QueueDefinition => ({
  name,
  policy: 'standard',
  retryLimit: 0,
  retryDelay: 1,
  retryBackoff: false,
  expireInSeconds: 60,
  retentionDays: 7,
  ...overrides,
});

let db: TestDatabase;
let worker: JobRunner;
let producer: JobRunner;
const workerLogs = captureLogs();
const notifier = createInMemoryNotifier();

beforeAll(async () => {
  db = await createTestDatabase();
  await db.pool.query(
    `CREATE TABLE job_effects (
       id bigserial PRIMARY KEY, job_id text, kind text, attempt int, idempotency_key text UNIQUE)`,
  );
  worker = createJobRunner({
    databaseUrl: db.url,
    logger: workerLogs.logger,
    role: 'worker',
    pollingIntervalSeconds: 0.5,
    superviseIntervalSeconds: 2,
  });
  producer = createJobRunner({
    databaseUrl: db.url,
    logger: captureLogs().logger,
    role: 'producer',
  });
  await worker.start();
  await producer.start();
  // The production wiring, with a short retry policy on send-email so AC-ERROR-6 runs in seconds.
  await registerJobs({
    runner: worker,
    notifier,
    queues: QUEUES.map((queue) =>
      queue.name === 'send-email'
        ? { ...queue, retryLimit: 2, retryDelay: 1, retryBackoff: false }
        : queue,
    ),
  });
});

afterAll(async () => {
  await producer.stop();
  await worker.stop();
  await db.close();
});

async function jobRow(queue: string, id: string, pool: TestDatabase['pool'] = db.pool) {
  const { rows } = await pool.query<{
    state: string;
    retry_count: number;
    retry_limit: number;
    output: { message?: string; attempt?: number } | null;
  }>('SELECT state, retry_count, retry_limit, output FROM pgboss.job WHERE name = $1 AND id = $2', [
    queue,
    id,
  ]);
  return rows[0];
}

async function waitForState(
  queue: string,
  id: string,
  state: string,
  timeoutMs = 10_000,
  pool: TestDatabase['pool'] = db.pool,
) {
  return waitFor(
    async () => {
      const row = await jobRow(queue, id, pool);
      return row?.state === state ? row : undefined;
    },
    { timeoutMs, label: `${queue}/${id} to be ${state}` },
  );
}

const effectCount = async (where: string, value: string): Promise<number> => {
  const { rows } = await db.pool.query<{ count: string }>(
    `SELECT count(*) FROM job_effects WHERE ${where} = $1`,
    [value],
  );
  return Number(rows[0]?.count);
};

describe('lifecycle (AC-ASYNC-1)', () => {
  it('moves created -> active -> completed within 10 s, with a side effect and a readable final state', async () => {
    const queue = 'it-lifecycle';
    await worker.defineQueue(testQueue(queue));
    await worker.work<{ probe: string }>(queue, async (data, ctx) => {
      await sleep(700);
      await db.pool.query('INSERT INTO job_effects (job_id, kind) VALUES ($1, $2)', [
        ctx.jobId,
        data.probe,
      ]);
    });
    const probe = `probe-${randomUUID()}`;
    const enqueuedAt = performance.now();
    const id = await producer.enqueue(
      queue,
      { probe },
      // Seconds on the database clock: the host clock may differ from the DB container's.
      { startAfter: 2 },
    );
    expect(id).toEqual(expect.any(String));

    const states: string[] = [];
    await waitFor(
      async () => {
        const row = await jobRow(queue, id as string);
        if (row && states.at(-1) !== row.state) states.push(row.state);
        return row?.state === 'completed' ? true : undefined;
      },
      { timeoutMs: 10_000, intervalMs: 25, label: 'lifecycle to complete' },
    );
    expect(performance.now() - enqueuedAt).toBeLessThan(10_000);
    expect(states).toEqual(['created', 'active', 'completed']);
    expect(await effectCount('kind', probe)).toBe(1);
    await expect(worker.getJob(queue, id as string)).resolves.toMatchObject({
      state: 'completed',
      queue,
    });
    const lifecycle = workerLogs
      .lines()
      .filter((line) => line.jobId === id && String(line.event).startsWith('job.'))
      .map((line) => line.event);
    expect(lifecycle).toEqual(['job.started', 'job.completed']);
  });

  it('runs the foundation heartbeat job to completion and logs its payload', async () => {
    const payload = { probe: `hb-${randomUUID()}` };
    const id = await producer.enqueue('heartbeat', payload);
    // Generous: only the lifecycle test above asserts the 10 s AC; a step in the DB container's
    // clock can delay any job by several seconds here.
    await waitForState('heartbeat', id as string, 'completed', 20_000);
    const line = workerLogs
      .lines()
      .find((entry) => entry.event === 'heartbeat' && entry.jobId === id);
    expect(line).toMatchObject({ payload });
  });

  it('enqueues inside a Kysely transaction: rollback leaves nothing, commit persists the job', async () => {
    const queue = 'it-transactional';
    await worker.defineQueue(testQueue(queue));
    const kysely = createKysely(db.pool);
    await expect(
      kysely.transaction().execute(async (trx) => {
        await producer.enqueue(queue, { n: 1 }, { trx });
        throw new Error('force rollback');
      }),
    ).rejects.toThrow('force rollback');
    const count = async () =>
      Number(
        (
          await db.pool.query<{ count: string }>(
            'SELECT count(*) FROM pgboss.job WHERE name = $1',
            [queue],
          )
        ).rows[0]?.count,
      );
    expect(await count()).toBe(0);
    const id = await kysely
      .transaction()
      .execute((trx) => producer.enqueue(queue, { n: 2 }, { trx }));
    expect(id).toEqual(expect.any(String));
    expect(await count()).toBe(1);
  });
});

describe('duplicate suppression and at-least-once delivery (AC-ASYNC-3 i, ii)', () => {
  it('suppresses queued and active duplicates, runs the handler once, and neutralises a post-completion replay', async () => {
    const queue = 'it-singleton';
    await worker.defineQueue(testQueue(queue, { policy: 'exclusive' }));
    let invocations = 0;
    let release!: () => void;
    let gate = new Promise<void>((resolve) => (release = resolve));
    let started = false;
    await worker.work<{ domainKey: string }>(queue, async (data) => {
      invocations += 1;
      started = true;
      await gate;
      // Handler-level idempotency: a durable unique row, not just singletonKey.
      await db.pool.query(
        'INSERT INTO job_effects (kind, idempotency_key) VALUES ($1, $2) ON CONFLICT DO NOTHING',
        ['domain', data.domainKey],
      );
    });

    const key = `bill-session:${randomUUID()}`;
    const first = await producer.enqueue(
      queue,
      { domainKey: key },
      { singletonKey: key, startAfter: 2 },
    );
    expect(first).toEqual(expect.any(String));
    // (i) duplicate while the first is queued.
    await expect(
      producer.enqueue(queue, { domainKey: key }, { singletonKey: key }),
    ).resolves.toBeNull();
    await waitFor(() => (started ? true : undefined), { label: 'first job to start' });
    // (i) duplicate while the first is active.
    await expect(
      producer.enqueue(queue, { domainKey: key }, { singletonKey: key }),
    ).resolves.toBeNull();
    release();
    await waitForState(queue, first as string, 'completed');
    expect(invocations).toBe(1);

    // (ii) the same key after completion reaches the handler again ...
    gate = Promise.resolve();
    const replay = await producer.enqueue(queue, { domainKey: key }, { singletonKey: key });
    expect(replay).toEqual(expect.any(String));
    expect(replay).not.toBe(first);
    await waitForState(queue, replay as string, 'completed');
    expect(invocations).toBe(2);
    // ... and the unique row makes the side effect happen exactly once.
    expect(await effectCount('idempotency_key', key)).toBe(1);
  });
});

describe('failure handling (AC-ERROR-3, AC-ERROR-6)', () => {
  it('retries with increasing backoff, ends failed with message and attempt count, and logs at error', async () => {
    const queue = 'it-retry';
    await worker.defineQueue(
      testQueue(queue, { retryLimit: 3, retryDelay: 1, retryBackoff: true }),
    );
    let attempts = 0;
    await worker.work(queue, () => {
      attempts += 1;
      return Promise.reject(new Error('always fails'));
    });

    // Sample the job while it waits between attempts. Each sample reads the remaining wait as
    // `start_after - now()` inside one statement, so the figure is on a single (database) clock:
    // absolute timestamps compared across statements are not reliable when the DB container's
    // clock steps.
    const remainingWaits: number[] = [];
    let seenStartAfter = '';
    let sampling = true;
    const sampler = (async () => {
      while (sampling) {
        const { rows } = await db.pool.query<{ start_after: string; remaining: number }>(
          `SELECT start_after::text AS start_after,
                  EXTRACT(EPOCH FROM (start_after - now()))::float AS remaining
             FROM pgboss.job WHERE name = $1 AND state = 'retry'`,
          [queue],
        );
        const row = rows[0];
        if (row && row.start_after !== seenStartAfter) {
          seenStartAfter = row.start_after;
          remainingWaits.push(row.remaining);
        }
        await sleep(20);
      }
    })();

    const id = await producer.enqueue(queue, { doomed: true });
    const row = await waitForState(queue, id as string, 'failed', 40_000);
    sampling = false;
    await sampler;

    expect(attempts).toBe(4); // initial run + retryLimit retries
    expect(row.retry_count).toBe(3);
    expect(row.output).toMatchObject({ message: 'always fails', attempt: 4 });
    // retryDelay 1 s with exponential backoff waits ~[1,2) s, ~[2,4) s, ~[4,8) s: strictly growing.
    expect(remainingWaits).toHaveLength(3);
    expect(remainingWaits[0]).toBeGreaterThan(0.5);
    expect(remainingWaits[1]).toBeGreaterThan(remainingWaits[0] as number);
    expect(remainingWaits[2]).toBeGreaterThan(remainingWaits[1] as number);

    const failures = workerLogs
      .lines()
      .filter((line) => line.event === 'job.failed' && line.jobId === id);
    expect(failures.map((line) => line.level)).toEqual(['warn', 'warn', 'warn', 'error']);
    expect(failures.at(-1)).toMatchObject({ attempt: 4, willRetry: false, queue });
    await expect(worker.getJob(queue, id as string)).resolves.toMatchObject({
      state: 'failed',
      retryCount: 3,
    });
  }, 60_000);

  it('retries a transient notifier failure inside a job and ends failed (memory adapter)', async () => {
    notifier.reset();
    notifier.failWith('transient');
    const id = await enqueueEmail(producer, {
      to: 'player@example.test',
      subject: 'never delivered',
      text: 'body',
      idempotencyKey: `it-transient:${randomUUID()}`,
    });
    const row = await waitForState('send-email', id as string, 'failed', 30_000);
    expect(row.retry_count).toBe(2);
    expect(row.output?.message).toMatch(/memory/i);
    expect(notifier.sent).toHaveLength(0);
    expect(
      workerLogs
        .lines()
        .some((line) => line.event === 'job.failed' && line.jobId === id && line.level === 'error'),
    ).toBe(true);
  });

  it('fails a permanent notifier failure at once, without burning retries, and logs at error', async () => {
    notifier.reset();
    notifier.failWith('permanent');
    const id = await enqueueEmail(producer, {
      to: 'gone@example.test',
      subject: 'rejected',
      text: 'body',
      idempotencyKey: `it-permanent:${randomUUID()}`,
    });
    const row = await waitForState('send-email', id as string, 'failed', 15_000);
    expect(row.retry_count).toBe(0);
    expect(row.retry_limit).toBe(2);
    const lines = workerLogs.lines().filter((line) => line.jobId === id);
    expect(lines.find((line) => line.event === 'notification.failed')).toMatchObject({
      level: 'error',
      retryable: false,
    });
    notifier.failWith(undefined);
  });

  it('surfaces a typed error, never success, from the smtp adapter pointed at an unreachable host', async () => {
    const smtp = createNotifier({
      notifierAdapter: 'smtp',
      smtpUrl: 'smtp://127.0.0.1:1',
      emailFrom: config.emailFrom,
    });
    await expect(
      smtp.send({
        to: 'player@example.test',
        subject: 's',
        text: 't',
        idempotencyKey: 'it-unreachable',
      }),
    ).rejects.toBeInstanceOf(TransientDeliveryError);
  });
});

describe('schedules (AC-ASYNC-2)', () => {
  it('fires daily 04:00 Pacific/Auckland at the right UTC instant across both DST changes', () => {
    const next = (from: string): string | undefined =>
      worker
        .previewSchedule('0 4 * * *', { tz: 'Pacific/Auckland', from: new Date(from), count: 1 })[0]
        ?.toISOString();
    expect(next('2026-09-25T16:00:01Z')).toBe('2026-09-26T15:00:00.000Z');
    expect(next('2027-04-02T15:00:01Z')).toBe('2027-04-03T16:00:00.000Z');
  });

  it('lists all three slots, and every placeholder plus heartbeat can be triggered manually and observed', async () => {
    const schedules = await worker.listSchedules();
    expect(
      schedules
        .map(({ name, cron, tz }) => ({ name, cron, tz }))
        .sort((a, b) => a.name.localeCompare(b.name)),
    ).toEqual([
      { name: 'daily-overdue', cron: '0 4 * * *', tz: 'Pacific/Auckland' },
      { name: 'post-game-billing', cron: '*/5 * * * *', tz: 'Pacific/Auckland' },
      { name: 'recurrence-materialisation', cron: '0 3 * * *', tz: 'Pacific/Auckland' },
    ]);
    for (const slot of ['recurrence-materialisation', 'post-game-billing', 'daily-overdue']) {
      const id = await worker.trigger(slot, { source: 'integration-test' });
      expect(id, slot).toEqual(expect.any(String));
      await waitForState(slot, id as string, 'completed');
      expect(
        workerLogs.lines().find((line) => line.event === 'schedule.invoked' && line.jobId === id),
        slot,
      ).toMatchObject({ slot });
    }
    const heartbeat = await worker.trigger('heartbeat', { source: 'integration-test' });
    await waitForState('heartbeat', heartbeat as string, 'completed');
  });
});

describe('worker process (AC-ASYNC-3 iii and boot)', () => {
  const childEnv = async (database: TestDatabase, extra: Record<string, string> = {}) => ({
    DATABASE_URL: database.url,
    NOTIFIER_ADAPTER: 'memory',
    LOG_FORMAT: 'json',
    LOG_LEVEL: 'info',
    WORKER_HEALTH_PORT: String(await freePort()),
    JOBS_POLL_INTERVAL_SECONDS: '0.5',
    ...extra,
  });

  it('recovers a job whose worker is SIGKILLed mid-execution, completing within 30 s of the kill', async () => {
    const own = await createTestDatabase();
    const children: ReturnType<typeof spawnNode>[] = [];
    try {
      await own.pool.query(
        'CREATE TABLE job_effects (id bigserial PRIMARY KEY, job_id text, kind text, attempt int)',
      );
      const env = await childEnv(own, {
        JOBS_EXPIRE_SECONDS_OVERRIDE: '5',
        JOBS_SUPERVISE_INTERVAL_SECONDS: '2',
      });
      const first = spawnNode('test/helpers/worker-fixture.ts', [], env);
      children.push(first);
      const ready = await waitFor(
        () => (first.output().includes('fixture.ready') ? true : undefined),
        {
          timeoutMs: 30_000,
          label: `fixture worker to boot\n${first.output()}`,
        },
      );
      expect(ready).toBe(true);

      const ownProducer = createJobRunner({
        databaseUrl: own.url,
        logger: captureLogs().logger,
        role: 'producer',
      });
      await ownProducer.start();
      const id = (await ownProducer.enqueue('it-crash', { run: randomUUID() })) as string;
      await waitFor(
        async () => {
          const { rows } = await own.pool.query(
            "SELECT 1 FROM job_effects WHERE job_id = $1 AND kind = 'started'",
            [id],
          );
          return rows.length > 0 ? true : undefined;
        },
        { timeoutMs: 15_000, label: 'job to be running' },
      );

      first.child.kill('SIGKILL');
      const killedAt = performance.now();
      await first.exited;

      const second = spawnNode(
        'test/helpers/worker-fixture.ts',
        [],
        await childEnv(own, {
          JOBS_EXPIRE_SECONDS_OVERRIDE: '5',
          JOBS_SUPERVISE_INTERVAL_SECONDS: '2',
        }),
      );
      children.push(second);
      await waitFor(
        async () => {
          const { rows } = await own.pool.query<{ state: string }>(
            'SELECT state FROM pgboss.job WHERE name = $1 AND id = $2',
            ['it-crash', id],
          );
          return rows[0]?.state === 'completed' ? true : undefined;
        },
        {
          timeoutMs: 30_000,
          intervalMs: 100,
          label: `crashed job to be recovered\n${second.output()}`,
        },
      );
      expect(performance.now() - killedAt).toBeLessThan(30_000);
      const { rows } = await own.pool.query<{ kind: string; attempt: number }>(
        'SELECT kind, attempt FROM job_effects WHERE job_id = $1 ORDER BY id',
        [id],
      );
      expect(rows.map((row) => `${row.kind}:${row.attempt}`)).toEqual([
        'started:0',
        'started:1',
        'completed:1',
      ]);
      await ownProducer.stop();
    } finally {
      for (const spawned of children) spawned.child.kill('SIGKILL');
      await own.close();
    }
  }, 90_000);

  it('boots the real worker.ts, processes jobs (incl. via the CLI), lists schedules and stops cleanly on SIGTERM', async () => {
    const own = await createTestDatabase();
    const spawned = spawnNode('src/worker.ts', [], await childEnv(own));
    try {
      await waitFor(() => (spawned.output().includes('worker started') ? true : undefined), {
        timeoutMs: 30_000,
        label: `worker to start\n${spawned.output()}`,
      });
      const ownProducer = createJobRunner({
        databaseUrl: own.url,
        logger: captureLogs().logger,
        role: 'producer',
      });
      await ownProducer.start();
      const id = (await ownProducer.enqueue('heartbeat', { probe: 'boot' })) as string;
      await waitFor(
        async () =>
          (await ownProducer.getJob('heartbeat', id))?.state === 'completed' ? true : undefined,
        {
          timeoutMs: 10_000,
          label: 'heartbeat handled by worker.ts',
        },
      );
      await ownProducer.stop();

      const cli = async (...args: string[]) => {
        const run = spawnNode('src/cli.ts', ['jobs', ...args], await childEnv(own));
        const { code } = await run.exited;
        return { code, output: run.output() };
      };
      const schedules = await cli('schedules');
      expect(schedules.code).toBe(0);
      for (const slot of ['recurrence-materialisation', 'post-game-billing', 'daily-overdue']) {
        expect(schedules.output).toContain(slot);
      }
      expect(schedules.output).toContain('Pacific/Auckland');
      const triggered = await cli('trigger', 'heartbeat', '{"via":"cli"}');
      expect(triggered.code).toBe(0);
      const cliJobId = /job ([0-9a-f-]{36})/.exec(triggered.output)?.[1];
      expect(cliJobId).toBeDefined();
      await waitForState('heartbeat', cliJobId as string, 'completed', 10_000, own.pool);
      const rejected = await cli('trigger', 'not-a-slot');
      expect(rejected.code).not.toBe(0);

      spawned.child.kill('SIGTERM');
      const exit = await Promise.race([spawned.exited, sleep(15_000).then(() => undefined)]);
      expect(exit).toMatchObject({ code: 0 });
    } finally {
      spawned.child.kill('SIGKILL');
      await own.close();
    }
  }, 90_000);
});
