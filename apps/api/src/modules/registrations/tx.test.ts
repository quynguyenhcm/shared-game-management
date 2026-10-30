import { DummyDriver, PostgresAdapter, PostgresIntrospector, PostgresQueryCompiler } from 'kysely';
import { describe, expect, it, vi } from 'vitest';
import { createManualClock } from '../../lib/clock.ts';
import {
  createQueryRecorder,
  createRecordingDatabase,
} from '../../../test/helpers/query-recorder.ts';
import { HTTP_POLICY, JOB_POLICY, isLockConflict, runAllocatorTransaction } from './tx.ts';

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
  const log = { warn: vi.fn() };
  const sleep = vi.fn((_ms: number) => Promise.resolve());
  const clock = createManualClock(new Date('2026-10-05T06:00:00.000Z'));
  return { recorder, db, log, sleep, clock };
}

const sqlError = (code: string): Error => Object.assign(new Error(`pg ${code}`), { code });

describe('allocator lock policies (architecture Q2, L1)', () => {
  it('are code constants: 2 s HTTP and 5 s job lock timeouts, three attempts', () => {
    expect(HTTP_POLICY).toEqual({ lockTimeoutMs: 2000, attempts: 3, backoffMs: [25, 75] });
    expect(JOB_POLICY).toEqual({ lockTimeoutMs: 5000, attempts: 3, backoffMs: [100, 400] });
  });

  it('retries only a deadlock or a lock timeout', () => {
    expect(isLockConflict(sqlError('40P01'))).toBe(true);
    expect(isLockConflict(sqlError('55P03'))).toBe(true);
    expect(isLockConflict(sqlError('23514'))).toBe(false);
    expect(isLockConflict(new Error('plain'))).toBe(false);
  });
});

describe('runAllocatorTransaction', () => {
  it('sets the lock timeout as the first statement and returns the work result with one clock reading', async () => {
    const { db, recorder, sleep, clock } = setup();
    const now = clock.now();
    const result = await runAllocatorTransaction(
      db,
      HTTP_POLICY,
      { clock, sleep, teamId: 't1', path: 'register' },
      ({ now: seen }) => Promise.resolve(seen),
    );
    expect(result).toEqual(now);
    expect(recorder.statements[0]).toMatch(/set local lock_timeout = 2000/i);
    expect(sleep).not.toHaveBeenCalled();
  });

  it.each(['55P03', '40P01'])(
    'retries the whole transaction on %s and hands every attempt the SAME instant read before the first',
    async (code) => {
      const { db, recorder, log, sleep, clock } = setup();
      const first = clock.now();
      const seen: Date[] = [];
      const result = await runAllocatorTransaction(
        db,
        JOB_POLICY,
        { clock, sleep, log, teamId: 't1', path: 'ban' },
        ({ now }) => {
          seen.push(now);
          // Time passes while the lock is waited for; a retry must not re-read it (the deadline is the request instant).
          clock.advance(3_000);
          if (seen.length < 3) throw sqlError(code);
          return Promise.resolve(seen.length);
        },
      );
      expect(result).toBe(3);
      expect(seen.map((d) => d.getTime())).toEqual([
        first.getTime(),
        first.getTime(),
        first.getTime(),
      ]);
      expect(sleep.mock.calls.map(([ms]) => ms)).toEqual([100, 400]);
      expect(recorder.statements.filter((s) => /set local lock_timeout/i.test(s))).toHaveLength(3);
      expect(log.warn).toHaveBeenCalledTimes(2);
      expect(log.warn).toHaveBeenCalledWith(
        expect.objectContaining({
          event: 'registration.lock_retry',
          path: 'ban',
          attempt: 1,
          sqlState: code,
          teamId: 't1',
        }),
        expect.any(String),
      );
    },
  );

  it('gives up after the attempts, rethrows the last error and logs the exhaustion', async () => {
    const { db, log, sleep, clock } = setup();
    let calls = 0;
    await expect(
      runAllocatorTransaction(
        db,
        HTTP_POLICY,
        { clock, sleep, log, teamId: 't1', path: 'register' },
        () => {
          calls += 1;
          return Promise.reject(sqlError('55P03'));
        },
      ),
    ).rejects.toMatchObject({ code: '55P03' });
    expect(calls).toBe(3);
    expect(log.warn).toHaveBeenLastCalledWith(
      expect.objectContaining({
        event: 'registration.lock_retry_exhausted',
        attempts: 3,
        sqlState: '55P03',
      }),
      expect.any(String),
    );
  });

  it('does not retry any other failure', async () => {
    const { db, sleep, clock } = setup();
    let calls = 0;
    await expect(
      runAllocatorTransaction(
        db,
        HTTP_POLICY,
        { clock, sleep, teamId: 't1', path: 'register' },
        () => {
          calls += 1;
          return Promise.reject(sqlError('23514'));
        },
      ),
    ).rejects.toMatchObject({ code: '23514' });
    expect(calls).toBe(1);
    expect(sleep).not.toHaveBeenCalled();
  });
});
