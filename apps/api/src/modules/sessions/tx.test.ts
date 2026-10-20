import { DummyDriver, PostgresAdapter, PostgresIntrospector, PostgresQueryCompiler } from 'kysely';
import { describe, expect, it, vi } from 'vitest';
import {
  createQueryRecorder,
  createRecordingDatabase,
} from '../../../test/helpers/query-recorder.ts';
import { HTTP_POLICY, JOB_POLICY, isLockConflict, runSessionTransaction } from './tx.ts';

function setup() {
  const recorder = createQueryRecorder();
  const db = createRecordingDatabase(
    {
      createAdapter: () => new PostgresAdapter(),
      createDriver: () => new DummyDriver(),
      createIntrospector: (kysely) => new PostgresIntrospector(kysely),
      createQueryCompiler: () => new PostgresQueryCompiler(),
    },
    recorder,
  );
  const log = { warn: vi.fn(), info: vi.fn(), error: vi.fn() };
  const sleep = vi.fn((_ms: number) => Promise.resolve());
  return { recorder, db, log, sleep };
}

const sqlError = (code: string): Error => Object.assign(new Error(`pg ${code}`), { code });

describe('lock policies (architecture SA-2)', () => {
  it('are code constants: 2 s HTTP and 5 s job lock timeouts, three attempts', () => {
    expect(HTTP_POLICY).toEqual({ lockTimeoutMs: 2000, attempts: 3, backoffMs: [25, 75] });
    expect(JOB_POLICY).toEqual({ lockTimeoutMs: 5000, attempts: 3, backoffMs: [100, 400] });
  });

  it('classifies only deadlock and lock-timeout SQLSTATEs as retryable', () => {
    expect(isLockConflict(sqlError('40P01'))).toBe(true);
    expect(isLockConflict(sqlError('55P03'))).toBe(true);
    expect(isLockConflict(sqlError('23505'))).toBe(false);
    expect(isLockConflict(new Error('plain'))).toBe(false);
    expect(isLockConflict('40P01')).toBe(false);
  });
});

describe('runSessionTransaction', () => {
  it('sets the policy lock timeout as the first statement and returns the callback result', async () => {
    const { db, recorder, sleep } = setup();
    const result = await runSessionTransaction(
      db,
      HTTP_POLICY,
      async (trx) => {
        await trx.selectFrom('teams').select('id').execute();
        return 'done';
      },
      { sleep },
    );
    expect(result).toBe('done');
    expect(recorder.statements[0]).toMatch(/set local lock_timeout/i);
    expect(recorder.statements[0]).toContain('2000');
    expect(sleep).not.toHaveBeenCalled();
  });

  it.each(['55P03', '40P01'])(
    'retries the WHOLE transaction on %s with the policy backoff, then succeeds',
    async (code) => {
      const { db, recorder, log, sleep } = setup();
      let attempt = 0;
      const result = await runSessionTransaction(
        db,
        JOB_POLICY,
        () => {
          attempt += 1;
          if (attempt < 3) throw sqlError(code);
          return Promise.resolve(attempt);
        },
        { sleep, log, path: 'publish' },
      );
      expect(result).toBe(3);
      expect(sleep.mock.calls.map(([ms]) => ms)).toEqual([100, 400]);
      // Each attempt is a fresh transaction, so the timeout is set again every time.
      expect(recorder.statements.filter((s) => /set local lock_timeout/i.test(s))).toHaveLength(3);
      expect(log.warn).toHaveBeenCalledTimes(2);
      expect(log.warn).toHaveBeenCalledWith(
        expect.objectContaining({
          event: 'session.lock_retry',
          path: 'publish',
          attempt: 1,
          sqlState: code,
        }),
        expect.any(String),
      );
    },
  );

  it('rethrows the last error after the attempts are exhausted and logs it', async () => {
    const { db, log, sleep } = setup();
    let calls = 0;
    await expect(
      runSessionTransaction(
        db,
        HTTP_POLICY,
        () => {
          calls += 1;
          return Promise.reject(sqlError('55P03'));
        },
        { sleep, log, path: 'edit' },
      ),
    ).rejects.toMatchObject({ code: '55P03' });
    expect(calls).toBe(HTTP_POLICY.attempts);
    expect(log.warn).toHaveBeenCalledWith(
      expect.objectContaining({ event: 'session.lock_retry_exhausted', path: 'edit' }),
      expect.any(String),
    );
  });

  it('does not retry any other error', async () => {
    const { db, sleep } = setup();
    let calls = 0;
    await expect(
      runSessionTransaction(
        db,
        HTTP_POLICY,
        () => {
          calls += 1;
          return Promise.reject(sqlError('23505'));
        },
        { sleep },
      ),
    ).rejects.toMatchObject({ code: '23505' });
    expect(calls).toBe(1);
    expect(sleep).not.toHaveBeenCalled();
  });
});
