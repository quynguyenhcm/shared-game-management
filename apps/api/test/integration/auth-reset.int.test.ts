/**
 * Password reset over the real app, real Postgres and a real pg-boss worker (AC-HAPPY-6, AC-ERROR-5,
 * AC-ERROR-6, AC-ERROR-16, AC-ASYNC-1, AC-ASYNC-2, AC-INTEGRATION-1). The worker runs the production job
 * wiring with a swappable notifier: in-memory by default, scripted failures for AC-ASYNC-2, and the real
 * SMTP adapter against Mailpit for AC-INTEGRATION-1.
 */
import { createHash, randomUUID } from 'node:crypto';
import { ErrorResponse, ForgotPasswordResponse, ResetPasswordResponse } from '@sgm/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { registerJobs } from '../../src/jobs/bootstrap.ts';
import { QUEUES } from '../../src/jobs/registry.ts';
import { loadConfig } from '../../src/lib/config/config.ts';
import { createKysely } from '../../src/lib/db/kysely.ts';
import { createJobRunner, type JobRunner } from '../../src/lib/jobs/jobs.ts';
import { createInMemoryNotifier } from '../../src/lib/notifications/adapters/in-memory.ts';
import { TransientDeliveryError } from '../../src/lib/notifications/errors.ts';
import {
  createNotifier,
  type EmailMessage,
  type Notifier,
} from '../../src/lib/notifications/notifier.ts';
import { TEST_WEB_BASE_URL, testCrypto } from '../helpers/app-deps.ts';
import {
  bearer,
  buildAuthTestApp,
  createPasswordUser,
  internalHeaders,
  login,
  sessionFor,
  TEST_INTERNAL_SECRET,
  type AuthTestApp,
} from '../helpers/auth-app.ts';
import {
  insertAuthSession,
  insertOAuthIdentity,
  insertResetToken,
  insertUser,
} from '../helpers/factories.ts';
import { captureLogs } from '../helpers/log-capture.ts';
import { createTestDatabase, type TestDatabase } from '../helpers/test-db.ts';
import { waitFor } from '../helpers/wait-for.ts';
import { noopSessionAllocator } from '../../src/modules/sessions/allocator-port.ts';

const config = loadConfig();
const NEW_PASSWORD = 'tui-and-kereru-914';
const MINUTE = 60_000;

async function probeMailpit(): Promise<boolean> {
  try {
    const response = await fetch(new URL('/api/v1/info', config.mailpitApiUrl), {
      signal: AbortSignal.timeout(2_000),
    });
    return response.ok;
  } catch {
    return false;
  }
}
const mailpitAvailable = await probeMailpit();

let database: TestDatabase;
let h: AuthTestApp;
let producer: JobRunner;
let worker: JobRunner;
const workerLogs = captureLogs();
const memory = createInMemoryNotifier();
let activeNotifier: Notifier = memory;
// Every delivery attempt as the worker made it (after it opened the sealed payload), even a failing one.
const attempted: EmailMessage[] = [];
const delegating: Notifier = {
  send: (message) => {
    attempted.push(message);
    return activeNotifier.send(message);
  },
};

beforeAll(async () => {
  database = await createTestDatabase({ poolMax: 30 });
  producer = createJobRunner({
    databaseUrl: database.url,
    logger: captureLogs().logger,
    role: 'producer',
  });
  worker = createJobRunner({
    databaseUrl: database.url,
    logger: workerLogs.logger,
    role: 'worker',
    pollingIntervalSeconds: 0.5,
    superviseIntervalSeconds: 2,
  });
  await producer.start();
  await worker.start();
  await registerJobs({
    sessionAllocator: noopSessionAllocator,
    runner: worker,
    notifier: delegating,
    crypto: testCrypto(),
    db: createKysely(database.pool),
    // Short retry policy so the transient-retry test runs in seconds.
    queues: QUEUES.map((queue) =>
      queue.name === 'send-email'
        ? { ...queue, retryLimit: 2, retryDelay: 1, retryBackoff: false }
        : queue,
    ),
  });
  h = await buildAuthTestApp(database.pool, {
    jobs: producer,
    env: { API_INTERNAL_SHARED_SECRET: TEST_INTERNAL_SECRET, AUTH_FORGOT_MAX_PER_ADDRESS: '3' },
  });
});
afterAll(async () => {
  await h.close();
  await producer.stop();
  await worker.stop();
  await database.close();
});

const forgot = (email: string, headers: Record<string, string> = {}) =>
  h.app.inject({ method: 'POST', url: '/auth/password/forgot', headers, payload: { email } });

const reset = (token: string, password: string) =>
  h.app.inject({ method: 'POST', url: '/auth/password/reset', payload: { token, password } });

interface Row {
  [column: string]: unknown;
}
async function query<T extends Row = Row>(text: string, values: unknown[] = []): Promise<T[]> {
  return (await database.pool.query<T>(text, values)).rows;
}

const tokensOf = (userId: string) =>
  query<{
    id: string;
    token_hash: Buffer;
    created_at: Date;
    expires_at: Date;
    used_at: Date | null;
  }>(
    `SELECT id, token_hash, created_at, expires_at, used_at FROM password_reset_tokens
      WHERE user_id = $1 ORDER BY created_at, id`,
    [userId],
  );

const jobsForToken = (tokenId: string) =>
  query<{
    id: string;
    state: string;
    retry_count: number;
    data: { idempotencyKey: string; sealed: string };
  }>(
    `SELECT id, state, retry_count, data FROM pgboss.job
      WHERE name = 'send-email' AND singleton_key = $1`,
    [`notify:password-reset:${tokenId}`],
  );

/** The raw token the way a user gets it: out of the link in the email the worker delivers. */
async function emailedToken(tokenId: string): Promise<string> {
  const mail = await waitFor(
    () => attempted.find((message) => message.idempotencyKey === `password-reset:${tokenId}`),
    { timeoutMs: 15_000, label: 'reset email delivery attempt' },
  );
  const match = /\/reset-password\?token=(\S+)/.exec(mail.text);
  if (match?.[1] === undefined) throw new Error('no reset link in the delivered email');
  return decodeURIComponent(match[1]);
}

const sendEmailJobCount = async (): Promise<number> =>
  Number(
    (
      await query<{ n: string }>(
        `SELECT count(*)::text AS n FROM pgboss.job WHERE name = 'send-email'`,
      )
    )[0]?.n,
  );

async function requestReset(email: string): Promise<{ tokenId: string; token: string }> {
  const response = await forgot(email);
  expect(response.statusCode).toBe(202);
  const user = (await query<{ id: string }>(`SELECT id FROM users WHERE email = $1`, [email]))[0];
  const tokens = await tokensOf(user?.id ?? '');
  const latest = tokens.at(-1);
  if (latest === undefined) throw new Error('forgot created no token');
  return { tokenId: latest.id, token: await emailedToken(latest.id) };
}

const identitiesOf = (userId: string) =>
  query<{ provider: string; provider_subject: string }>(
    `SELECT provider, provider_subject FROM auth_identities WHERE user_id = $1 ORDER BY provider`,
    [userId],
  );

describe('POST /auth/password/forgot (AC-ERROR-6, AC-ASYNC-1)', () => {
  it('answers the identical 202 for a known and an unknown email, creating token and job only for the known one', async () => {
    const user = await createPasswordUser(h, { email: 'forgot.known@example.com' });
    const jobsBefore = await sendEmailJobCount();
    const known = await forgot('Forgot.Known@Example.com');
    const unknown = await forgot('forgot.nobody@example.com');
    expect(known.statusCode).toBe(202);
    expect(unknown.statusCode).toBe(202);
    expect(known.json()).toEqual(unknown.json());
    expect(ForgotPasswordResponse.parse(known.json())).toBeDefined();

    const [token, ...extra] = await tokensOf(user.id);
    expect(extra).toHaveLength(0);
    expect(token?.token_hash).toHaveLength(32);
    expect(token?.used_at).toBeNull();
    expect((token?.expires_at.getTime() ?? 0) - (token?.created_at.getTime() ?? 0)).toBe(
      60 * MINUTE,
    );

    const jobs = await jobsForToken(token?.id ?? '');
    expect(jobs).toHaveLength(1);
    // The queued job is sealed (AC-VERIFY-2): only the idempotency key is readable.
    expect(jobs[0]?.data).toMatchObject({ idempotencyKey: `password-reset:${token?.id}` });
    expect(jobs[0]?.data).toHaveProperty('sealed');
    expect(jobs[0]?.data).not.toHaveProperty('text');
    expect(jobs[0]?.data).not.toHaveProperty('to');
    const raw = await emailedToken(token?.id ?? '');
    expect(
      createHash('sha256')
        .update(raw)
        .digest()
        .equals(token?.token_hash ?? Buffer.alloc(0)),
    ).toBe(true);
    // Unknown address: no token anywhere for it, and no job for it (only the known request queued one).
    expect(await sendEmailJobCount()).toBe(jobsBefore + 1);
  });

  it('never stores the raw token in pgboss.job and still delivers a working link (AC-VERIFY-2)', async () => {
    const user = await createPasswordUser(h, { email: 'forgot.sealed@example.com' });
    const { tokenId, token } = await requestReset(user.email);

    const jobs = await query<{ data: string }>(
      `SELECT data::text AS data FROM pgboss.job WHERE name = 'send-email' AND singleton_key = $1`,
      [`notify:password-reset:${tokenId}`],
    );
    expect(jobs).toHaveLength(1);
    const stored = jobs[0]?.data ?? '';
    expect(stored).not.toContain(token);
    expect(stored).not.toContain(encodeURIComponent(token));
    expect(stored).not.toContain('reset-password');
    expect(stored).not.toContain(user.email);

    // The link the worker delivered is the one the service issued.
    expect((await reset(token, NEW_PASSWORD)).statusCode).toBe(200);
    expect((await login(h, user.email, NEW_PASSWORD)).statusCode).toBe(200);
  });

  it('answers a malformed email with the same 202 and does nothing', async () => {
    const before = await query<{ n: string }>(
      `SELECT count(*)::text AS n FROM password_reset_tokens`,
    );
    const response = await forgot('not-an-email');
    expect(response.statusCode).toBe(202);
    const after = await query<{ n: string }>(
      `SELECT count(*)::text AS n FROM password_reset_tokens`,
    );
    expect(after[0]?.n).toBe(before[0]?.n);
  });

  it('issues at most one new token per user per 60 seconds, also under concurrent requests', async () => {
    const user = await createPasswordUser(h, { email: 'forgot.flood@example.com' });
    const responses = await Promise.all(
      Array.from({ length: 5 }, () => forgot('forgot.flood@example.com')),
    );
    expect(responses.map((response) => response.statusCode)).toEqual([202, 202, 202, 202, 202]);
    expect(await tokensOf(user.id)).toHaveLength(1);

    h.clock.advance(59_000);
    await forgot('forgot.flood@example.com');
    expect(await tokensOf(user.id)).toHaveLength(1);
    h.clock.advance(1_000);
    await forgot('forgot.flood@example.com');
    expect(await tokensOf(user.id)).toHaveLength(2);
  });

  it('limits one client address to 3 requests (the configured value) in the window, whether or not the account exists (AC-ERROR-6)', async () => {
    await createPasswordUser(h, { email: 'forgot.limited@example.com' });
    const address = internalHeaders('203.0.113.50');
    const emails = [
      'forgot.limited@example.com',
      'forgot.ghost-1@example.com',
      'forgot.ghost-2@example.com',
    ];
    for (const email of emails) expect((await forgot(email, address)).statusCode).toBe(202);

    for (const email of ['forgot.limited@example.com', 'forgot.ghost-3@example.com']) {
      const blocked = await forgot(email, address);
      expect(blocked.statusCode).toBe(429);
      expect(ErrorResponse.parse(blocked.json()).error.code).toBe('too_many_requests');
      expect(Number(blocked.headers['retry-after'])).toBeGreaterThan(0);
    }
    // Another address is unaffected.
    expect(
      (await forgot('forgot.ghost-4@example.com', internalHeaders('203.0.113.51'))).statusCode,
    ).toBe(202);
    // A client-supplied address without the internal secret cannot move the request to another key.
    expect(
      (await forgot('forgot.ghost-5@example.com', { 'x-sgm-client-ip': '203.0.113.52' }))
        .statusCode,
    ).toBe(202);
  });

  it('commits the token and the email job together: a failing enqueue leaves neither (P5)', async () => {
    const user = await createPasswordUser(h, { email: 'forgot.atomic@example.com' });
    const jobsBefore = await sendEmailJobCount();
    const failing = await buildAuthTestApp(database.pool, {
      jobs: {
        enqueue: async (queue, data, options) => {
          await producer.enqueue(queue, data, options); // joins the request transaction
          throw new Error('queue unavailable after insert');
        },
      },
    });
    try {
      const response = await failing.app.inject({
        method: 'POST',
        url: '/auth/password/forgot',
        payload: { email: 'forgot.atomic@example.com' },
      });
      expect(response.statusCode).toBe(500);
    } finally {
      await failing.close();
    }
    expect(await tokensOf(user.id)).toHaveLength(0);
    expect(await sendEmailJobCount()).toBe(jobsBefore);
  });
});

describe('POST /auth/password/reset (AC-HAPPY-6, AC-ERROR-5)', () => {
  it('sets the new password, consumes the token, revokes every session and clears the email throttle in one go', async () => {
    const user = await createPasswordUser(h, { email: 'reset.happy@example.com' });
    const tokenA = await sessionFor(h, user);
    const tokenB = await sessionFor(h, user);
    await login(h, user.email, 'a-wrong-password-1');
    await login(h, user.email, 'a-wrong-password-2');
    const throttleBefore = await query<{ n: string }>(
      `SELECT count(*)::text AS n FROM auth_throttle WHERE scope = 'login_email'`,
    );
    const { tokenId, token } = await requestReset(user.email);
    h.clock.advance(MINUTE);

    const response = await reset(token, NEW_PASSWORD);
    expect(response.statusCode).toBe(200);
    expect(ResetPasswordResponse.parse(response.json())).toEqual({ removedProviders: [] });

    const [row] = await tokensOf(user.id);
    expect(row?.id).toBe(tokenId);
    expect(row?.used_at).not.toBeNull();
    const sessions = await query<{ revoked_reason: string | null }>(
      `SELECT revoked_reason FROM auth_sessions WHERE user_id = $1`,
      [user.id],
    );
    expect(sessions.length).toBeGreaterThanOrEqual(2);
    expect(sessions.every((session) => session.revoked_reason === 'password_reset')).toBe(true);
    for (const old of [tokenA, tokenB]) {
      const me = await h.app.inject({ method: 'GET', url: '/auth/me', headers: bearer(old) });
      expect(me.statusCode).toBe(401);
      expect(me.json()).toMatchObject({ error: { code: 'session_expired' } });
    }
    const [verified] = await query<{ email_verified_at: Date | null }>(
      `SELECT email_verified_at FROM users WHERE id = $1`,
      [user.id],
    );
    expect(verified?.email_verified_at).not.toBeNull();
    const throttleAfter = await query<{ n: string }>(
      `SELECT count(*)::text AS n FROM auth_throttle WHERE scope = 'login_email'`,
    );
    expect(Number(throttleAfter[0]?.n)).toBe(Number(throttleBefore[0]?.n) - 1);

    expect((await login(h, user.email, user.password)).statusCode).toBe(401); // old password
    expect((await login(h, user.email, NEW_PASSWORD)).statusCode).toBe(200);
  });

  it('is single use: a replayed token fails with 400 invalid_or_expired_token and hashes nothing', async () => {
    const user = await createPasswordUser(h, { email: 'reset.replay@example.com' });
    const { token } = await insertResetToken(database.pool, user.id, { createdAt: h.clock.now() });
    expect((await reset(token, NEW_PASSWORD)).statusCode).toBe(200);

    h.hasher.resetCalls();
    const replay = await reset(token, 'another-new-pass-77');
    expect(replay.statusCode).toBe(400);
    expect(replay.json()).toMatchObject({ error: { code: 'invalid_or_expired_token' } });
    expect(h.hasher.hashCount()).toBe(0);
    expect((await login(h, user.email, NEW_PASSWORD)).statusCode).toBe(200); // first reset stands
  });

  it('rejects expired, malformed and unknown tokens with 400, without hashing and without changing anything', async () => {
    const user = await createPasswordUser(h, { email: 'reset.dead@example.com' });
    const session = await sessionFor(h, user);
    const expired = await insertResetToken(database.pool, user.id, { createdAt: h.clock.now() });
    h.clock.advance(60 * MINUTE); // exactly the expiry instant: no longer valid
    h.hasher.resetCalls();
    for (const token of [expired.token, 'garbage', 'x'.repeat(43), randomUUID()]) {
      const response = await reset(token, NEW_PASSWORD);
      expect(response.statusCode, token).toBe(400);
      expect(response.json()).toMatchObject({ error: { code: 'invalid_or_expired_token' } });
    }
    expect(h.hasher.hashCount()).toBe(0);
    expect((await login(h, user.email, user.password)).statusCode).toBe(200); // password unchanged
    expect(
      (await h.app.inject({ method: 'GET', url: '/auth/me', headers: bearer(session) })).statusCode,
    ).toBe(200); // session unchanged
  });

  it('returns 422 for a weak password without consuming the token, and the token still works afterwards', async () => {
    const user = await createPasswordUser(h, { email: 'reset.weak@example.com' });
    const { token } = await insertResetToken(database.pool, user.id, { createdAt: h.clock.now() });
    for (const weak of ['short', 'password123', 'reset.weak@example.com', 'reset.weak']) {
      const response = await reset(token, weak);
      expect(response.statusCode, weak).toBe(422);
      const error = ErrorResponse.parse(response.json()).error;
      expect(error.code).toBe('validation_failed');
      expect(error.fieldErrors?.password).toBeDefined();
    }
    const [row] = await tokensOf(user.id);
    expect(row?.used_at).toBeNull();
    expect((await reset(token, NEW_PASSWORD)).statusCode).toBe(200);
  });

  it('invalidates the other unused tokens of the user', async () => {
    const user = await createPasswordUser(h, { email: 'reset.others@example.com' });
    const first = await insertResetToken(database.pool, user.id, { createdAt: h.clock.now() });
    const second = await insertResetToken(database.pool, user.id, { createdAt: h.clock.now() });
    expect((await reset(first.token, NEW_PASSWORD)).statusCode).toBe(200);
    const tokens = await tokensOf(user.id);
    expect(tokens.every((row) => row.used_at !== null)).toBe(true);
    const replay = await reset(second.token, 'yet-another-pass-55');
    expect(replay.statusCode).toBe(400);
  });
});

describe('every completed reset evicts Google and Facebook (AC-ERROR-16, user decision D1)', () => {
  it('deletes GOOGLE and FACEBOOK even when email_verified_at was already set, and reports them in removedProviders', async () => {
    const user = await createPasswordUser(h, { email: 'evict.both@example.com' });
    await insertOAuthIdentity(database.pool, user.id, 'GOOGLE');
    await insertOAuthIdentity(database.pool, user.id, 'FACEBOOK');
    // A Google sign-up or link already set the (informational) inbox proof: it must exempt nothing.
    await database.pool.query(`UPDATE users SET email_verified_at = $2 WHERE id = $1`, [
      user.id,
      h.clock.now(),
    ]);
    const { token } = await insertResetToken(database.pool, user.id, { createdAt: h.clock.now() });
    h.clock.advance(MINUTE);

    const response = await reset(token, NEW_PASSWORD);
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ removedProviders: ['FACEBOOK', 'GOOGLE'] });
    expect((await identitiesOf(user.id)).map((identity) => identity.provider)).toEqual([
      'PASSWORD',
    ]);
    expect((await login(h, user.email, NEW_PASSWORD)).statusCode).toBe(200);
  });

  it('gives an OAuth-only account a PASSWORD identity (subject = its email) and removes the OAuth one', async () => {
    const userId = await insertUser(database.pool, 'FEMALE', {
      email: 'evict.oauth-only@example.com',
    });
    await insertOAuthIdentity(database.pool, userId, 'FACEBOOK');
    const { token } = await insertResetToken(database.pool, userId, { createdAt: h.clock.now() });

    const response = await reset(token, NEW_PASSWORD);
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ removedProviders: ['FACEBOOK'] });
    expect(await identitiesOf(userId)).toEqual([
      { provider: 'PASSWORD', provider_subject: 'evict.oauth-only@example.com' },
    ]);
    expect((await login(h, 'evict.oauth-only@example.com', NEW_PASSWORD)).statusCode).toBe(200);
  });

  it('recycled email: the previous owner’s Google identity can no longer sign in after the new owner’s reset', async () => {
    // The address belonged to a Google-first user (verified by Google); a new owner of the inbox now resets.
    const userId = await insertUser(database.pool, 'MALE', { email: 'recycled@example.com' });
    await insertOAuthIdentity(database.pool, userId, 'GOOGLE');
    const [google] = await identitiesOf(userId);
    await database.pool.query(`UPDATE users SET email_verified_at = $2 WHERE id = $1`, [
      userId,
      h.clock.now(),
    ]);
    const previousOwnerSession = await insertAuthSession(database.pool, userId, {
      createdAt: h.clock.now(),
    });
    const { token } = await insertResetToken(database.pool, userId, { createdAt: h.clock.now() });

    expect((await reset(token, NEW_PASSWORD)).statusCode).toBe(200);

    // The sign-in lookup of the OAuth callback (provider + subject) finds nothing any more...
    expect(
      await query(
        `SELECT 1 FROM auth_identities WHERE provider = 'GOOGLE' AND provider_subject = $1`,
        [google?.provider_subject],
      ),
    ).toHaveLength(0);
    // ...and the email now has a PASSWORD identity, so a Google callback for it ends in the
    // 409 oauth_account_exists row of the decision table (Phase 5), never in a session.
    expect(
      await query(
        `SELECT 1 FROM auth_identities WHERE provider = 'PASSWORD' AND provider_subject = $1`,
        ['recycled@example.com'],
      ),
    ).toHaveLength(1);
    // The previous owner's live session died with the reset.
    const me = await h.app.inject({
      method: 'GET',
      url: '/auth/me',
      headers: bearer(previousOwnerSession.token),
    });
    expect(me.statusCode).toBe(401);
  });
});

describe('reset logs', () => {
  it('log auth.password_reset events with the user id and never the token, the password or the email', async () => {
    const user = await createPasswordUser(h, { email: 'reset.logs@example.com' });
    const { token } = await requestReset(user.email);
    expect((await reset(token, NEW_PASSWORD)).statusCode).toBe(200);
    const lines = h.logs.lines();
    const events = lines.map((line) => line.event);
    expect(events).toContain('auth.password_reset.requested');
    expect(events).toContain('auth.password_reset.completed');
    expect(
      lines.find(
        (line) => line.event === 'auth.password_reset.completed' && line.userId === user.id,
      ),
    ).toMatchObject({ removedProviders: [] });
    const everything = JSON.stringify(lines);
    expect(everything).not.toContain(token);
    expect(everything).not.toContain(NEW_PASSWORD);
    expect(everything).not.toContain('reset.logs@example.com');
  });
});

describe('delivery through the queue (AC-ASYNC-1, AC-ASYNC-2)', () => {
  it('delivers the reset email through the worker, not inline: the request returns before the notifier runs', async () => {
    memory.reset();
    activeNotifier = memory;
    const user = await createPasswordUser(h, { email: 'async.inline@example.com' });
    const { tokenId } = await requestReset(user.email);
    await waitFor(
      async () => ((await jobsForToken(tokenId))[0]?.state === 'completed' ? true : undefined),
      { timeoutMs: 15_000, label: 'send-email job to complete' },
    );
    expect(memory.sent.filter((mail) => mail.to === user.email)).toHaveLength(1);
  });

  it('retries a transient failure and still delivers exactly one email', async () => {
    memory.reset();
    let attempts = 0;
    activeNotifier = {
      send: (message) => {
        attempts += 1;
        if (attempts === 1) {
          return Promise.reject(
            new TransientDeliveryError('simulated outage', {
              adapter: 'memory',
              providerCode: 'simulated-transient',
            }),
          );
        }
        return memory.send(message);
      },
    };
    try {
      const user = await createPasswordUser(h, { email: 'async.transient@example.com' });
      const { tokenId } = await requestReset(user.email);
      const job = await waitFor(
        async () => {
          const [row] = await jobsForToken(tokenId);
          return row?.state === 'completed' ? row : undefined;
        },
        { timeoutMs: 20_000, label: 'send-email job to complete after a retry' },
      );
      expect(job.retry_count).toBe(1);
      expect(memory.sent.filter((mail) => mail.to === user.email)).toHaveLength(1);
    } finally {
      activeNotifier = memory;
    }
  });

  it('fails a permanent error without retries, logs notification.failed, and lets the user request a new link', async () => {
    memory.reset();
    memory.failWith('permanent');
    try {
      const user = await createPasswordUser(h, { email: 'async.permanent@example.com' });
      const { tokenId } = await requestReset(user.email);
      const job = await waitFor(
        async () => {
          const [row] = await jobsForToken(tokenId);
          return row?.state === 'failed' ? row : undefined;
        },
        { timeoutMs: 15_000, label: 'send-email job to fail' },
      );
      expect(job.retry_count).toBe(0);
      expect(
        workerLogs
          .lines()
          .find(
            (line) =>
              line.event === 'notification.failed' &&
              line.idempotencyKey === `password-reset:${tokenId}`,
          ),
      ).toMatchObject({ retryable: false });

      memory.failWith(undefined);
      h.clock.advance(61_000);
      const second = await requestReset(user.email);
      expect(second.tokenId).not.toBe(tokenId);
      await waitFor(
        async () =>
          (await jobsForToken(second.tokenId))[0]?.state === 'completed' ? true : undefined,
        { timeoutMs: 15_000, label: 'second send-email job to complete' },
      );
      expect(memory.sent.filter((mail) => mail.to === user.email)).toHaveLength(1);
    } finally {
      memory.failWith(undefined);
    }
  });
});

interface MailpitSummary {
  ID: string;
}
interface MailpitMessage {
  Subject: string;
  Text: string;
  To: { Address: string }[];
}
async function mailpit<T>(path: string): Promise<T> {
  const response = await fetch(new URL(path, config.mailpitApiUrl));
  expect(response.ok, `${path} -> ${response.status}`).toBe(true);
  return (await response.json()) as T;
}

describe('Mailpit delivery (AC-INTEGRATION-1)', () => {
  it.skipIf(!mailpitAvailable)(
    'delivers one message over SMTP with the subject, expiry text and a link that works exactly once',
    async () => {
      activeNotifier = createNotifier({
        notifierAdapter: 'smtp',
        smtpUrl: config.smtpUrl,
        emailFrom: config.emailFrom,
      });
      try {
        const address = `reset-${randomUUID()}@example.com`;
        const user = await createPasswordUser(h, { email: address });
        const response = await forgot(address);
        expect(response.statusCode).toBe(202);

        const summary = await waitFor(
          async () => {
            const found = await mailpit<{ messages: MailpitSummary[] }>(
              `/api/v1/search?query=${encodeURIComponent(`to:${address}`)}`,
            );
            return found.messages.length > 0 ? found.messages : undefined;
          },
          { timeoutMs: 30_000, intervalMs: 250, label: `Mailpit message to ${address}` },
        );
        expect(summary).toHaveLength(1);
        const message = await mailpit<MailpitMessage>(`/api/v1/message/${summary[0]?.ID}`);
        expect(message.To.map((to) => to.Address)).toEqual([address]);
        expect(message.Subject).toBe('Reset your Shared Game Management password');
        expect(message.Text).toContain('60 minutes');
        expect(message.Text).toContain("If you didn't request this, ignore this email.");
        const link = /(https?:\/\/\S+\/reset-password\?token=\S+)/.exec(message.Text)?.[1];
        expect(link?.startsWith(`${TEST_WEB_BASE_URL}/reset-password?token=`)).toBe(true);
        const token = decodeURIComponent(new URL(link ?? '').searchParams.get('token') ?? '');

        expect((await reset(token, NEW_PASSWORD)).statusCode).toBe(200);
        expect((await reset(token, 'a-second-try-pass-1')).statusCode).toBe(400);
        expect((await login(h, user.email, NEW_PASSWORD)).statusCode).toBe(200);
      } finally {
        activeNotifier = memory;
      }
    },
    60_000,
  );
});
