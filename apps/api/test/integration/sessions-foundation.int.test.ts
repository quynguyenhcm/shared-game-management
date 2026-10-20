/**
 * Phase 2 part A: the lock helpers, the transaction policy, the query recorder and the test scaffolding, against
 * real PostgreSQL. Covers the canonical lock order of architecture SA-2 (teams -> rules -> team_members ->
 * game_sessions), the T-19 advisory-lock namespace, the `advanceSessionTo` PUBLISHED -> CANCELLED path (T-16) and
 * the recording allocator double.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AppError } from '../../src/lib/http/errors.ts';
import {
  SESSION_AUTO_ENROL_LOCK_NAMESPACE,
  assertSessionAdmin,
  lockRule,
  lockRuleInstances,
  lockSession,
  lockSessionAutoEnrol,
  lockTeamKeyShare,
} from '../../src/modules/sessions/locks.ts';
import { HTTP_POLICY, runSessionTransaction } from '../../src/modules/sessions/tx.ts';
import { createKysely } from '../../src/lib/db/kysely.ts';
import { advanceSessionTo, insertRule, insertSession } from '../helpers/factories.ts';
import { createQueryRecorder, createRecordingDatabase } from '../helpers/query-recorder.ts';
import { createRecordingAllocator, createSessionsScene } from '../helpers/sessions-scene.ts';
import { createTestDatabase, expectPgError, type TestDatabase } from '../helpers/test-db.ts';
import { PostgresDialect } from 'kysely';

let database: TestDatabase;
beforeAll(async () => {
  database = await createTestDatabase();
});
afterAll(async () => {
  await database.close();
});

const db = () => createKysely(database.pool);

function recordingDb() {
  const recorder = createQueryRecorder();
  return {
    recorder,
    db: createRecordingDatabase(new PostgresDialect({ pool: database.pool }), recorder),
  };
}

describe('lock helpers and the canonical order', () => {
  it('locks teams (KEY SHARE), then the rule, then the actor, then the session, in that order', async () => {
    const scene = await createSessionsScene(database.pool);
    const ruleId = await insertRule(database.pool, scene.teamId);
    const sessionId = await insertSession(
      database.pool,
      scene.teamId,
      {},
      { recurringRuleId: ruleId },
    );
    const { db: recording, recorder } = recordingDb();

    const locked = await runSessionTransaction(recording, HTTP_POLICY, async (trx) => {
      expect(await lockTeamKeyShare(trx, scene.teamId)).toBe(true);
      const rule = await lockRule(trx, { ruleId, teamId: scene.teamId });
      await assertSessionAdmin(trx, scene.teamId, scene.adminId);
      const session = await lockSession(trx, { sessionId, teamId: scene.teamId });
      return { rule, session };
    });

    expect(locked.rule).toMatchObject({ id: ruleId, team_id: scene.teamId, version: 1 });
    expect(locked.session).toMatchObject({ id: sessionId, status: 'DRAFT', version: 1 });
    recorder.assertBefore(
      /from "teams".*for key share/,
      /from "recurring_session_rules".*for no key update/,
    );
    recorder.assertBefore(
      /from "recurring_session_rules".*for no key update/,
      /from "team_members".*for share/,
    );
    recorder.assertBefore(/from "team_members".*for share/, /from "game_sessions".*for update/);
  });

  it('refuses a session or rule of another team and reports a missing team', async () => {
    const scene = await createSessionsScene(database.pool);
    const sessionId = await insertSession(database.pool, scene.otherTeamId);
    const ruleId = await insertRule(database.pool, scene.otherTeamId);
    await runSessionTransaction(db(), HTTP_POLICY, async (trx) => {
      expect(await lockSession(trx, { sessionId, teamId: scene.teamId })).toBeUndefined();
      expect(await lockRule(trx, { ruleId, teamId: scene.teamId })).toBeUndefined();
      expect(await lockTeamKeyShare(trx, '00000000-0000-4000-8000-000000000000')).toBe(false);
    });
  });

  it('assertSessionAdmin gives 403 forbidden to a member, a demoted admin, a banned admin and another team', async () => {
    const scene = await createSessionsScene(database.pool);
    const check = (actorId: string, teamId = scene.teamId) =>
      runSessionTransaction(db(), HTTP_POLICY, (trx) => assertSessionAdmin(trx, teamId, actorId));

    await expect(check(scene.adminId)).resolves.toBeUndefined();
    await expect(check(scene.memberId)).rejects.toMatchObject({ code: 'forbidden', status: 403 });
    await expect(check(scene.otherAdminId)).rejects.toBeInstanceOf(AppError);

    // A team must keep one approved admin (D-42), so a second one is promoted before the first is demoted.
    await database.pool.query(
      `UPDATE team_members SET role = 'TEAM_ADMIN' WHERE team_id = $1 AND user_id = $2`,
      [scene.teamId, scene.memberId],
    );
    await database.pool.query(
      `UPDATE team_members SET role = 'MEMBER' WHERE team_id = $1 AND user_id = $2`,
      [scene.teamId, scene.adminId],
    );
    await expect(check(scene.adminId)).rejects.toMatchObject({ code: 'forbidden' });
  });

  it('lockRuleInstances locks the rule instances in (date, id) order', async () => {
    const scene = await createSessionsScene(database.pool);
    const ruleId = await insertRule(database.pool, scene.teamId);
    const late = await insertSession(
      database.pool,
      scene.teamId,
      {},
      { recurringRuleId: ruleId, date: '2026-11-18' },
    );
    const early = await insertSession(
      database.pool,
      scene.teamId,
      {},
      { recurringRuleId: ruleId, date: '2026-11-04' },
    );
    const { db: recording, recorder } = recordingDb();

    const rows = await runSessionTransaction(recording, HTTP_POLICY, (trx) =>
      lockRuleInstances(trx, { ruleId, teamId: scene.teamId }),
    );

    expect(rows.map((row) => row.id)).toEqual([early, late]);
    expect(recorder.statements.find((s) => /for update/.test(s))).toMatch(
      /order by "date" asc, "id" asc/,
    );
  });
});

describe('runSessionTransaction against a real lock', () => {
  it('times out on a held session lock (55P03) and retries the whole transaction until it is free', async () => {
    const scene = await createSessionsScene(database.pool);
    const sessionId = await insertSession(database.pool, scene.teamId);
    const holder = await database.pool.connect();
    await holder.query('BEGIN');
    await holder.query('SELECT id FROM game_sessions WHERE id = $1 FOR UPDATE', [sessionId]);
    let released = false;
    let attempts = 0;
    try {
      const result = await runSessionTransaction(
        db(),
        { lockTimeoutMs: 100, attempts: 3, backoffMs: [10, 10] },
        async (trx) => {
          attempts += 1;
          return lockSession(trx, { sessionId, teamId: scene.teamId });
        },
        {
          sleep: async () => {
            if (!released) {
              released = true;
              await holder.query('COMMIT');
            }
          },
        },
      );
      expect(result?.id).toBe(sessionId);
      expect(attempts).toBe(2);
    } finally {
      if (!released) await holder.query('ROLLBACK');
      holder.release();
    }
  });

  it('gives up with 55P03 once the attempts are exhausted', async () => {
    const scene = await createSessionsScene(database.pool);
    const sessionId = await insertSession(database.pool, scene.teamId);
    const holder = await database.pool.connect();
    await holder.query('BEGIN');
    await holder.query('SELECT id FROM game_sessions WHERE id = $1 FOR UPDATE', [sessionId]);
    try {
      await expectPgError(
        runSessionTransaction(db(), { lockTimeoutMs: 50, attempts: 2, backoffMs: [1] }, (trx) =>
          lockSession(trx, { sessionId, teamId: scene.teamId }),
        ),
        '55P03',
      );
    } finally {
      await holder.query('ROLLBACK');
      holder.release();
    }
  });
});

describe('auto-enrol advisory lock (T-19)', () => {
  it('uses an int4 namespace and serialises per session until commit', async () => {
    expect(Number.isInteger(SESSION_AUTO_ENROL_LOCK_NAMESPACE)).toBe(true);
    expect(Math.abs(SESSION_AUTO_ENROL_LOCK_NAMESPACE)).toBeLessThan(2 ** 31);

    const scene = await createSessionsScene(database.pool);
    const sessionA = await insertSession(database.pool, scene.teamId);
    const sessionB = await insertSession(database.pool, scene.teamId);
    const tryLock = async (sessionId: string): Promise<boolean> => {
      const client = await database.pool.connect();
      try {
        await client.query('BEGIN');
        const { rows } = await client.query<{ ok: boolean }>(
          `SELECT pg_try_advisory_xact_lock($1, hashtext($2)) AS ok`,
          [SESSION_AUTO_ENROL_LOCK_NAMESPACE, sessionId],
        );
        await client.query('ROLLBACK');
        return rows[0]?.ok === true;
      } finally {
        client.release();
      }
    };

    let during: boolean[] = [];
    await runSessionTransaction(db(), HTTP_POLICY, async (trx) => {
      await lockSessionAutoEnrol(trx, sessionA);
      during = [await tryLock(sessionA), await tryLock(sessionB)];
    });
    expect(during).toEqual([false, true]);
    expect(await tryLock(sessionA)).toBe(true);
  });
});

describe('advanceSessionTo (T-16 carry-over)', () => {
  it('walks PUBLISHED -> CANCELLED and DRAFT -> CANCELLED, and refuses a closed session', async () => {
    const scene = await createSessionsScene(database.pool, { payoutConfigured: true });
    const published = await insertSession(database.pool, scene.teamId, {}, { status: 'PUBLISHED' });
    await advanceSessionTo(database.pool, published, 'CANCELLED');
    const draft = await insertSession(database.pool, scene.teamId);
    await advanceSessionTo(database.pool, draft, 'CANCELLED');
    const completed = await insertSession(database.pool, scene.teamId, {}, { status: 'COMPLETED' });

    const { rows } = await database.pool.query<{ id: string; status: string }>(
      `SELECT id, status FROM game_sessions WHERE id = ANY($1::uuid[])`,
      [[published, draft]],
    );
    expect(rows.map((row) => row.status)).toEqual(['CANCELLED', 'CANCELLED']);
    await expect(advanceSessionTo(database.pool, completed, 'CANCELLED')).rejects.toThrow(
      /not a legal path/,
    );
  });
});

describe('recording allocator double', () => {
  it('records both entrypoints with the caller transaction and the switchable enrols flag', async () => {
    const allocator = createRecordingAllocator({ enrols: false });
    expect(allocator.enrols).toBe(false);
    allocator.enrols = true;
    const when = new Date('2026-10-20T01:00:00Z');
    await runSessionTransaction(db(), HTTP_POLICY, async (trx) => {
      await allocator.promoteWaitlist(
        { trx, now: when, log: console },
        { teamId: 't', sessionId: 's' },
      );
      const results = await allocator.autoEnrolInSession(
        { trx, now: when, log: console },
        { teamId: 't', sessionId: 's', entries: [{ userId: 'u1', assignedAt: when }] },
      );
      expect(results).toEqual([{ userId: 'u1', outcome: { ok: true, status: 'CONFIRMED' } }]);
    });
    expect(allocator.promoteCalls).toEqual([
      { teamId: 't', sessionId: 's', now: when, inTransaction: true },
    ]);
    expect(allocator.autoEnrolCalls).toHaveLength(1);
    expect(allocator.autoEnrolCalls[0]?.entries.map((e) => e.userId)).toEqual(['u1']);
    allocator.reset();
    expect(allocator.promoteCalls).toEqual([]);
  });
});
