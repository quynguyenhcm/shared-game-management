/**
 * The scheduled `auth-cleanup` job (AC-ASYNC-3): deletes only stale auth rows, in batches, idempotently,
 * and leaves live sessions, valid tokens and live throttle counters alone. Real Postgres, real queue.
 */
import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createAuthCleanupHandler } from '../../src/jobs/auth-cleanup.ts';
import { registerJobs } from '../../src/jobs/bootstrap.ts';
import { createManualClock } from '../../src/lib/clock.ts';
import { createKysely } from '../../src/lib/db/kysely.ts';
import { createJobRunner, type JobContext, type JobRunner } from '../../src/lib/jobs/jobs.ts';
import { createInMemoryNotifier } from '../../src/lib/notifications/adapters/in-memory.ts';
import { insertAuthSession, insertResetToken, insertUser } from '../helpers/factories.ts';
import { captureLogs } from '../helpers/log-capture.ts';
import { createTestDatabase, type TestDatabase } from '../helpers/test-db.ts';
import { waitFor } from '../helpers/wait-for.ts';

const NOW = new Date('2026-10-06T12:00:00Z');
const MINUTE = 60_000;
const DAY = 86_400_000;
const ago = (milliseconds: number, from: Date = NOW): Date =>
  new Date(from.getTime() - milliseconds);

let database: TestDatabase;
beforeAll(async () => {
  database = await createTestDatabase();
});
afterAll(async () => {
  await database.close();
});

async function insertOAuthState(
  createdAt: Date,
  expiresAt: Date,
  usedAt: Date | null,
): Promise<string> {
  const { rows } = await database.pool.query<{ id: string }>(
    `INSERT INTO oauth_states (state_hash, provider, intent, created_at, expires_at, used_at)
     VALUES ($1, 'GOOGLE', 'signin', $2, $3, $4) RETURNING id`,
    [randomBytes(32), createdAt, expiresAt, usedAt],
  );
  return rows[0]?.id ?? '';
}

async function insertPendingSignup(
  createdAt: Date,
  expiresAt: Date,
  usedAt: Date | null,
): Promise<string> {
  const { rows } = await database.pool.query<{ id: string }>(
    `INSERT INTO oauth_pending_signups
       (token_hash, provider, provider_subject, email, email_verified, created_at, expires_at, used_at)
     VALUES ($1, 'GOOGLE', $2, $3, true, $4, $5, $6) RETURNING id`,
    [
      randomBytes(32),
      `sub-${randomBytes(6).toString('hex')}`,
      `pending-${randomBytes(4).toString('hex')}@example.com`,
      createdAt,
      expiresAt,
      usedAt,
    ],
  );
  return rows[0]?.id ?? '';
}

async function insertThrottleRow(updatedAt: Date): Promise<Buffer> {
  const key = randomBytes(32);
  await database.pool.query(
    `INSERT INTO auth_throttle (scope, key_hash, attempts, updated_at)
     VALUES ('login_email', $1, ARRAY[$2]::timestamptz[], $2)`,
    [key, updatedAt],
  );
  return key;
}

async function exists(table: string, column: string, value: unknown): Promise<boolean> {
  const { rows } = await database.pool.query(`SELECT 1 FROM ${table} WHERE ${column} = $1`, [
    value,
  ]);
  return rows.length > 0;
}

function contextWith(logs = captureLogs()): {
  ctx: JobContext;
  logs: ReturnType<typeof captureLogs>;
} {
  const ctx = {
    logger: logs.logger,
    jobId: 'job-1',
    queue: 'auth-cleanup',
    retryCount: 0,
    retryLimit: 3,
  } as unknown as JobContext;
  return { ctx, logs };
}

describe('auth-cleanup handler', () => {
  it('deletes exactly the stale rows of every table and leaves fresh rows alone, then a second run deletes nothing', async () => {
    const clock = createManualClock(NOW);
    const userId = await insertUser(database.pool);

    const sessions = {
      live: await insertAuthSession(database.pool, userId, { createdAt: ago(MINUTE) }),
      idleExpired: await insertAuthSession(database.pool, userId, { createdAt: ago(8 * DAY) }),
      absoluteExpired: await insertAuthSession(database.pool, userId, {
        createdAt: ago(31 * DAY),
        idleDays: 30,
        absoluteDays: 30,
      }),
      revoked: await insertAuthSession(database.pool, userId, { createdAt: ago(2 * MINUTE) }),
    };
    await database.pool.query(
      `UPDATE auth_sessions SET revoked_at = $2, revoked_reason = 'logout' WHERE id = $1`,
      [sessions.revoked.id, ago(MINUTE)],
    );

    const tokens = {
      valid: await insertResetToken(database.pool, userId, { createdAt: ago(10 * MINUTE) }),
      expired: await insertResetToken(database.pool, userId, { createdAt: ago(2 * 60 * MINUTE) }),
      used: await insertResetToken(database.pool, userId, {
        createdAt: ago(10 * MINUTE),
        usedAt: ago(5 * MINUTE),
      }),
    };

    const states = {
      live: await insertOAuthState(ago(MINUTE), new Date(NOW.getTime() + 9 * MINUTE), null),
      expired: await insertOAuthState(ago(20 * MINUTE), ago(10 * MINUTE), null),
      used: await insertOAuthState(
        ago(2 * MINUTE),
        new Date(NOW.getTime() + 8 * MINUTE),
        ago(MINUTE),
      ),
    };
    const pending = {
      live: await insertPendingSignup(ago(MINUTE), new Date(NOW.getTime() + 14 * MINUTE), null),
      expired: await insertPendingSignup(ago(30 * MINUTE), ago(15 * MINUTE), null),
      used: await insertPendingSignup(
        ago(2 * MINUTE),
        new Date(NOW.getTime() + 13 * MINUTE),
        ago(MINUTE),
      ),
    };
    const throttle = {
      live: await insertThrottleRow(ago(59 * MINUTE)),
      boundary: await insertThrottleRow(ago(60 * MINUTE)), // newest attempt left the longest window
      stale: await insertThrottleRow(ago(61 * MINUTE)),
    };

    const { ctx, logs } = contextWith();
    const handler = createAuthCleanupHandler({ db: createKysely(database.pool), clock });
    await handler({}, ctx);

    // Fresh rows survive.
    expect(await exists('auth_sessions', 'id', sessions.live.id)).toBe(true);
    expect(await exists('password_reset_tokens', 'id', tokens.valid.id)).toBe(true);
    expect(await exists('oauth_states', 'id', states.live)).toBe(true);
    expect(await exists('oauth_pending_signups', 'id', pending.live)).toBe(true);
    expect(await exists('auth_throttle', 'key_hash', throttle.live)).toBe(true);
    // Stale rows are gone.
    for (const id of [sessions.idleExpired.id, sessions.absoluteExpired.id, sessions.revoked.id]) {
      expect(await exists('auth_sessions', 'id', id), `session ${id}`).toBe(false);
    }
    for (const id of [tokens.expired.id, tokens.used.id]) {
      expect(await exists('password_reset_tokens', 'id', id), `token ${id}`).toBe(false);
    }
    for (const id of [states.expired, states.used]) {
      expect(await exists('oauth_states', 'id', id), `state ${id}`).toBe(false);
    }
    for (const id of [pending.expired, pending.used]) {
      expect(await exists('oauth_pending_signups', 'id', id), `pending ${id}`).toBe(false);
    }
    for (const key of [throttle.boundary, throttle.stale]) {
      expect(await exists('auth_throttle', 'key_hash', key)).toBe(false);
    }

    const completed = logs.lines().find((line) => line.event === 'auth.cleanup.completed');
    expect(completed).toMatchObject({
      deleted: { sessions: 3, resetTokens: 2, oauthStates: 2, pendingSignups: 2, throttleRows: 2 },
    });

    // Idempotent: nothing left to delete, and it still succeeds.
    const second = contextWith();
    await handler({}, second.ctx);
    expect(
      second.logs.lines().find((line) => line.event === 'auth.cleanup.completed'),
    ).toMatchObject({
      deleted: { sessions: 0, resetTokens: 0, oauthStates: 0, pendingSignups: 0, throttleRows: 0 },
    });
    expect(await exists('auth_sessions', 'id', sessions.live.id)).toBe(true);
  });

  it('works through the rows in batches until none are left', async () => {
    const clock = createManualClock(NOW);
    const userId = await insertUser(database.pool);
    const created: string[] = [];
    for (let i = 0; i < 5; i += 1) {
      created.push(
        (await insertAuthSession(database.pool, userId, { createdAt: ago(9 * DAY) })).id,
      );
    }
    const { ctx, logs } = contextWith();
    await createAuthCleanupHandler({ db: createKysely(database.pool), clock, batchSize: 2 })(
      {},
      ctx,
    );
    const { rows } = await database.pool.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM auth_sessions WHERE id = ANY($1)`,
      [created],
    );
    expect(rows[0]?.n).toBe('0');
    expect(logs.lines().find((line) => line.event === 'auth.cleanup.completed')).toMatchObject({
      deleted: { sessions: 5 },
    });
  });
});

describe('auth-cleanup queue (production wiring)', () => {
  let worker: JobRunner;
  let producer: JobRunner;
  beforeAll(async () => {
    worker = createJobRunner({
      databaseUrl: database.url,
      logger: captureLogs().logger,
      role: 'worker',
      pollingIntervalSeconds: 0.5,
      superviseIntervalSeconds: 2,
    });
    producer = createJobRunner({
      databaseUrl: database.url,
      logger: captureLogs().logger,
      role: 'producer',
    });
    await worker.start();
    await producer.start();
    await registerJobs({
      runner: worker,
      notifier: createInMemoryNotifier(),
      db: createKysely(database.pool),
    });
  });
  afterAll(async () => {
    await producer.stop();
    await worker.stop();
  });

  it('runs the registered handler for a job on the auth-cleanup queue and registers its daily schedule', async () => {
    const userId = await insertUser(database.pool);
    const real = new Date();
    const stale = await insertResetToken(database.pool, userId, {
      createdAt: ago(2 * DAY, real),
      usedAt: ago(DAY, real),
    });
    const fresh = await insertResetToken(database.pool, userId, { createdAt: real });

    const id = await producer.enqueue('auth-cleanup', {});
    expect(id).toEqual(expect.any(String));
    await waitFor(
      async () => ((await exists('password_reset_tokens', 'id', stale.id)) ? undefined : true),
      { timeoutMs: 15_000, label: 'stale reset token to be cleaned up' },
    );
    expect(await exists('password_reset_tokens', 'id', fresh.id)).toBe(true);

    const schedules = await worker.listSchedules();
    expect(schedules.find((schedule) => schedule.name === 'auth-cleanup')).toMatchObject({
      cron: '0 5 * * *',
      tz: 'Pacific/Auckland',
    });
  });
});
