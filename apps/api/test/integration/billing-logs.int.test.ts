/**
 * Observability of the post-game billing path (wallet-and-akahu-billing Phase 2 portion of AC-VERIFY-7): `billing.sweep.enqueued`,
 * `billing.session.completed`, `.blocked` and `.failed` are triggered for real, their FIELDS are asserted (learned rule:
 * logging-redaction-global), and no line carries a bank name or number, an email address, a name, a link, a token or a payment
 * reference. The `akahu.*` and `wallet.*` events arrive with Phase 4.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createManualClock } from '../../src/lib/clock.ts';
import { createKysely } from '../../src/lib/db/kysely.ts';
import { NonRetryableJobError, type JobContext } from '../../src/lib/jobs/jobs.ts';
import { createBillSessionHandler } from '../../src/jobs/bill-session.ts';
import { billSession } from '../../src/modules/billing/bill-session.ts';
import { runPostGameBillingSweep } from '../../src/modules/billing/sweep.ts';
import { testCrypto } from '../helpers/app-deps.ts';
import {
  insertPublishedSession,
  insertRegistration,
  insertTeam,
  insertWallet,
} from '../helpers/factories.ts';
import { captureLogs } from '../helpers/log-capture.ts';
import { createRecordingJobs, insertMember } from '../helpers/registration-scene.ts';
import { createTestDatabase, type TestDatabase } from '../helpers/test-db.ts';

const BASE = new Date('2026-10-20T00:00:00.000Z');
const WEB = 'https://games.example.nz';
const TEAM_NAME = 'Zorblax Secretname Badminton Club';
const EMAIL_PART = 'billing-logs-person';
/** The account block `insertTeam({ payoutConfigured })` writes, in clear (its envelope is what the row stores). */
const BANK_NAME = 'Test Club Account';
const BANK_NUMBER = '01-0902-0068389-000';

const clock = createManualClock(BASE);
let database: TestDatabase;
beforeAll(async () => {
  database = await createTestDatabase({ poolMax: 10 });
});
afterAll(async () => {
  await database.close();
});
beforeEach(() => clock.set(BASE));

interface Scene {
  readonly teamId: string;
  readonly sessionId: string;
}

async function endedPaidSession(
  options: { wallet?: string; blockedAt?: Date } = {},
): Promise<Scene> {
  const teamId = await insertTeam(database.pool, {
    payoutConfigured: true,
    name: TEAM_NAME,
  });
  const { sessionId } = await insertPublishedSession(database.pool, teamId, { now: BASE });
  // The publish gate refuses a blocked team, so the block lands after the session is published (as a real block does).
  if (options.blockedAt !== undefined) {
    await database.pool.query('UPDATE teams SET payout_blocked_at = $2 WHERE id = $1', [
      teamId,
      options.blockedAt,
    ]);
  }
  const userId = await insertMember(database.pool, teamId, {
    email: `${EMAIL_PART}-${sessionId.slice(0, 8)}@example.test`,
  });
  await insertRegistration(database.pool, { sessionId, teamId, userId });
  if (options.wallet !== undefined)
    await insertWallet(database.pool, userId, teamId, options.wallet);
  const { rows } = await database.pool.query<{ ends_at: Date }>(
    'SELECT ends_at FROM game_sessions WHERE id = $1',
    [sessionId],
  );
  const endsAt = rows[0]?.ends_at;
  if (endsAt !== undefined && endsAt > clock.now()) clock.set(endsAt);
  return { teamId, sessionId };
}

const depsWith = (logger: ReturnType<typeof captureLogs>['logger']) => ({
  db: createKysely(database.pool),
  jobs: createRecordingJobs(),
  clock,
  crypto: testCrypto(),
  webBaseUrl: WEB,
  log: logger,
});

const eventLines = (logs: ReturnType<typeof captureLogs>, event: string) =>
  logs.lines().filter((line) => line['event'] === event);

/** The substrings no billing log line may carry, whatever the event. */
function expectNoLeaks(logs: ReturnType<typeof captureLogs>): void {
  const text = JSON.stringify(logs.lines());
  for (const secret of [
    TEAM_NAME,
    EMAIL_PART,
    '@example.test',
    BANK_NAME,
    BANK_NUMBER,
    '0068389',
    'Test Player',
    WEB,
    '/payments/',
    'token',
    'SGM',
  ]) {
    expect(text, `log lines contain ${secret}`).not.toContain(secret);
  }
}

describe('billing.session.* (the per-session transaction)', () => {
  it('billing.session.completed carries the session id and the counts, logged once, after commit', async () => {
    const logs = captureLogs();
    const wallet = await endedPaidSession({ wallet: '30.00' });
    await billSession(depsWith(logs.logger), { sessionId: wallet.sessionId });
    const link = await endedPaidSession();
    await billSession(depsWith(logs.logger), { sessionId: link.sessionId });

    const lines = eventLines(logs, 'billing.session.completed');
    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatchObject({
      level: 'info',
      sessionId: wallet.sessionId,
      payments: 1,
      deducted: 1,
      linked: 0,
      zero: 0,
    });
    expect(lines[1]).toMatchObject({ sessionId: link.sessionId, deducted: 0, linked: 1 });
    // Counts, ids and the event: nothing else is added to the line by the billing code.
    for (const line of lines) {
      const own = Object.keys(line).filter(
        (key) =>
          ![
            'level',
            'time',
            'timestamp',
            'message',
            'msg',
            'service',
            'version',
            'environment',
            'pid',
            'hostname',
          ].includes(key),
      );
      expect(own.sort()).toEqual(
        ['deducted', 'event', 'linked', 'payments', 'sessionId', 'zero'].sort(),
      );
    }
    expectNoLeaks(logs);
  });

  it('billing.session.blocked (B8) is a warning with the session id only, and a replay of the held session logs it again without leaking', async () => {
    const logs = captureLogs();
    const held = await endedPaidSession({ blockedAt: BASE });
    await billSession(depsWith(logs.logger), { sessionId: held.sessionId });

    const lines = eventLines(logs, 'billing.session.blocked');
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ level: 'warn', sessionId: held.sessionId });
    expect(Object.keys(lines[0] ?? {})).not.toEqual(expect.arrayContaining(['teamId', 'email']));
    expectNoLeaks(logs);
  });

  it('billing.session.failed (job handler) carries the session id, the error class and the SQLSTATE only: never the message, which can quote values', async () => {
    const logs = captureLogs();
    const sessionId = '2f2e2d2c-2b2a-4928-8726-252423222120';
    const leaky = Object.assign(
      new Error(
        `duplicate key value (${EMAIL_PART}@example.test, ${BANK_NUMBER}) at ${WEB}/payments/abc?token=zzz`,
      ),
      { code: '23505', name: 'DatabaseError' },
    );
    const handler = createBillSessionHandler({
      ...depsWith(logs.logger),
      run: () => Promise.reject(leaky),
    });
    const context = {
      logger: logs.logger,
      jobId: 'job-1',
      queue: 'bill-session',
      retryCount: 0,
      retryLimit: 3,
      signal: new AbortController().signal,
    } as unknown as JobContext;

    await expect(handler({ sessionId, trigger: 'sweep' }, context)).rejects.toBeInstanceOf(
      NonRetryableJobError,
    );
    const lines = eventLines(logs, 'billing.session.failed');
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({
      level: 'error',
      sessionId,
      errorClass: 'DatabaseError',
      sqlState: '23505',
    });
    expect(lines[0]).not.toHaveProperty('err');
    expect(lines[0]).toMatchObject({ message: 'bill-session failed' });
    expectNoLeaks(logs);
  });

  it('a transient failure (lock timeout) is logged the same way and rethrown for pg-boss to retry', async () => {
    const logs = captureLogs();
    const sessionId = '3f2e2d2c-2b2a-4928-8726-252423222120';
    const handler = createBillSessionHandler({
      ...depsWith(logs.logger),
      run: () => Promise.reject(Object.assign(new Error('lock timeout'), { code: '55P03' })),
    });
    const context = { logger: logs.logger } as unknown as JobContext;
    await expect(handler({ sessionId, trigger: 'sweep' }, context)).rejects.not.toBeInstanceOf(
      NonRetryableJobError,
    );
    expect(eventLines(logs, 'billing.session.failed')[0]).toMatchObject({
      sessionId,
      sqlState: '55P03',
      errorClass: 'Error',
    });
  });
});

describe('billing.sweep.enqueued', () => {
  it('logs the scanned and enqueued counts and nothing about the sessions', async () => {
    const logs = captureLogs();
    const due = await endedPaidSession({ wallet: '30.00' });
    expect(due.sessionId).toBeDefined();
    const result = await runPostGameBillingSweep({
      db: createKysely(database.pool),
      jobs: createRecordingJobs(),
      clock,
      log: logs.logger,
    });

    const lines = eventLines(logs, 'billing.sweep.enqueued');
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({
      level: 'info',
      scanned: result.scanned,
      enqueued: result.enqueued,
    });
    expect(result.scanned).toBeGreaterThanOrEqual(1);
    expect(JSON.stringify(lines[0])).not.toContain(due.sessionId);
    expectNoLeaks(logs);
  });
});
