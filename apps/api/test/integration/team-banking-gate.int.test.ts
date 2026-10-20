/**
 * team-banking-and-gst, Phase 3: the publish gate and the removal guard over a real cloned Postgres.
 * Decisions: the task file's Creative Reconciliation R3 (`payout_blocked_at`), R4 (lock protocol: the gate and
 * the publish trigger take `teams FOR KEY SHARE`, a removal takes `FOR UPDATE` first, C-BIL-PAY) and the
 * banking architecture doc Q4. ACs: AC-HAPPY-7, AC-ERROR-8, 9, 10, 15, AC-VERIFY-8, 9, AC-INTEGRATION-2.
 *
 * Every race holds a real lock (or an open transaction) and waits until Postgres reports the blocked backend
 * through `pg_stat_activity`; nothing sleeps. No race may end in a deadlock (40P01).
 *
 * Raw `INSERT ... status = 'PUBLISHED'` can never commit today: `game_sessions_derive_instants` overwrites the
 * instants from the (not yet inserted) courts with NULL, so `game_sessions_instants_when_live` always fails. The
 * payout trigger fires BEFORE that CHECK, which is what the INSERT cases below prove.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type pg from 'pg';
import { AppError } from '../../src/lib/http/errors.ts';
import {
  assertTeamCanPublishPaidSession,
  checkTeamCanPublishPaidSession,
  isPaidSession,
  mapBankingDbError,
  mapPublishGateDbError,
  type PublishGateFees,
} from '../../src/modules/team-banking/publish-gate.ts';
import { PAID_SESSION_MATRIX, type PaidSessionCase } from '../fixtures/paid-session-matrix.ts';
import { buildAuthTestApp, type AuthTestApp } from '../helpers/auth-app.ts';
import {
  ACCOUNT_A,
  ACCOUNT_B,
  createBankingScene,
  type BankingBody,
  type ErrorBody,
} from '../helpers/banking-scene.ts';
import {
  insertPayment,
  insertRegistration,
  insertSession,
  insertTeam,
  insertUser,
} from '../helpers/factories.ts';
import { holdTeamLock, raceUnderTeamLock, waitForLockWaiters } from '../helpers/lock-waiters.ts';
import { captureLogs } from '../helpers/log-capture.ts';
import { attemptStandInPayment, createStandInPayment } from '../helpers/payment-stand-in.ts';
import {
  createTestDatabase,
  expectPgError,
  pgError,
  type TestDatabase,
} from '../helpers/test-db.ts';

let database: TestDatabase;
let h: AuthTestApp;
let scene: ReturnType<typeof createBankingScene>;

beforeAll(async () => {
  // Each race holds a lock holder plus one connection per blocked request.
  database = await createTestDatabase({ poolMax: 16 });
  h = await buildAuthTestApp(database.pool);
  scene = createBankingScene(h, database);
});
afterAll(async () => {
  await h.close();
  await database.close();
});

const json = <T>(response: { json: () => unknown }): T => response.json() as T;

const NO_FEES: PublishGateFees = {
  feeFlat: null,
  feeMale: null,
  feeFemale: null,
  feeOther: null,
  feeBeginner: null,
  feeIntermediate: null,
  feeAdvanced: null,
};
const PAID: PublishGateFees = { ...NO_FEES, feeFlat: '17.00' };
const FREE: PublishGateFees = { ...NO_FEES, feeFlat: '0.00' };

const ZERO_BLOCK =
  'bank_account_name = NULL, bank_account_number = NULL, bank_account_last4 = NULL';
const CLEAR_BANKING = `UPDATE teams SET ${ZERO_BLOCK} WHERE id = $1`;

const gateInput = (teamId: string, fees: PublishGateFees = PAID, extra: object = {}) =>
  ({ teamId, pricingStructure: 'FLAT', fees, ...extra }) as const;

/** The gate as a caller runs it: its own transaction, outcome returned so a race can await it safely. */
async function gateAttempt(
  teamId: string,
  fees: PublishGateFees = PAID,
): Promise<{ ok: true } | { refused: unknown }> {
  try {
    await h.db
      .transaction()
      .execute((trx) => assertTeamCanPublishPaidSession(trx, gateInput(teamId, fees)));
    return { ok: true };
  } catch (error) {
    return { refused: error };
  }
}

const paidDraft = (teamId: string): Promise<string> =>
  insertSession(database.pool, teamId, { flat: '17.00' });

async function statusOf(sessionId: string): Promise<string | undefined> {
  const { rows } = await database.pool.query<{ status: string }>(
    'SELECT status FROM game_sessions WHERE id = $1',
    [sessionId],
  );
  return rows[0]?.status;
}

async function setStatus(sessionId: string, status: string): Promise<void> {
  await database.pool.query(`UPDATE game_sessions SET status = $2 WHERE id = $1`, [
    sessionId,
    status,
  ]);
}

const publishRaw = (sessionId: string): Promise<unknown> =>
  database.pool.query(`UPDATE game_sessions SET status = 'PUBLISHED' WHERE id = $1`, [sessionId]);

const INSERT_PUBLISHED = `INSERT INTO game_sessions (team_id, location, address, date, cancellation_deadline,
    max_players, pricing_structure, fee_flat, status)
  VALUES ($1, 'Hall', '1 Street', '2026-10-07', '2026-10-05T06:00:00Z', 12, 'FLAT', $2, 'PUBLISHED')`;
const insertPublishedRaw = (
  db: Pick<pg.ClientBase, 'query'>,
  teamId: string,
  flat: string,
): Promise<unknown> => db.query(INSERT_PUBLISHED, [teamId, flat]);

async function configured(teamId: string): Promise<boolean> {
  return (await scene.row(teamId)).is_payout_configured;
}

async function countSessions(teamId: string): Promise<number> {
  const { rows } = await database.pool.query<{ n: number }>(
    'SELECT count(*)::int AS n FROM game_sessions WHERE team_id = $1',
    [teamId],
  );
  return rows[0]?.n ?? 0;
}

/** The published-and-paid invariant: no team has such a session without a configured destination. */
async function strandedPaidSessions(teamId: string): Promise<number> {
  const { rows } = await database.pool.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM game_sessions s JOIN teams t ON t.id = s.team_id
      WHERE s.team_id = $1 AND s.status = 'PUBLISHED' AND NOT t.is_payout_configured
        AND game_session_is_paid(s.pricing_structure, s.fee_flat, s.fee_male, s.fee_female, s.fee_other,
                                 s.fee_beginner, s.fee_intermediate, s.fee_advanced)`,
    [teamId],
  );
  return rows[0]?.n ?? 0;
}

function expectRefusal(error: unknown): void {
  expect(error).toBeInstanceOf(AppError);
  expect((error as AppError).code).toBe('payout_not_configured');
  expect((error as AppError).status).toBe(409);
}

/** Refusal log lines of `team.banking.publish_gate_refused`. */
const refusalLines = (logs: ReturnType<typeof captureLogs>) =>
  logs.lines().filter((line) => line['event'] === 'team.banking.publish_gate_refused');

describe('AC-HAPPY-7: a configured team publishes, free sessions never need banking', () => {
  it('passes the gate for a configured team and then publishes the real session in the same transaction', async () => {
    const teamId = await insertTeam(database.pool, { payoutConfigured: true });
    const sessionId = await paidDraft(teamId);
    await h.db.transaction().execute(async (trx) => {
      expect(await checkTeamCanPublishPaidSession(trx, gateInput(teamId))).toEqual({ ok: true });
      await assertTeamCanPublishPaidSession(trx, gateInput(teamId));
      await trx
        .updateTable('game_sessions')
        .set({ status: 'PUBLISHED' })
        .where('id', '=', sessionId)
        .execute();
    });
    expect(await statusOf(sessionId)).toBe('PUBLISHED');
  });

  it('lets free sessions through for an unconfigured team, at the gate and at the trigger, without logging a refusal', async () => {
    const logs = captureLogs();
    const teamId = await insertTeam(database.pool);
    await h.db.transaction().execute(async (trx) => {
      expect(
        await checkTeamCanPublishPaidSession(trx, gateInput(teamId, FREE, { log: logs.logger })),
      ).toEqual({ ok: true });
      expect(
        await checkTeamCanPublishPaidSession(trx, gateInput(teamId, NO_FEES, { log: logs.logger })),
      ).toEqual({ ok: true });
    });
    const free = await insertSession(database.pool, teamId, { flat: '0.00' });
    await publishRaw(free);
    expect(await statusOf(free)).toBe('PUBLISHED');
    expect(refusalLines(logs)).toEqual([]);
  });

  it('passes the payout rule for a raw INSERT as PUBLISHED: only the unrelated instants CHECK stops it', async () => {
    const teamId = await insertTeam(database.pool, { payoutConfigured: true });
    await expectPgError(
      insertPublishedRaw(database.pool, teamId, '17.00'),
      '23514',
      'game_sessions_instants_when_live',
    );
    expect(await countSessions(teamId)).toBe(0);
  });
});

describe('AC-ERROR-8: a paid session cannot be published without banking', () => {
  it('refuses at the gate with payout_not_configured, logs the team and the reason only, and leaves the DRAFT alone', async () => {
    const logs = captureLogs();
    const teamId = await insertTeam(database.pool);
    const sessionId = await paidDraft(teamId);

    const outcome = await h.db.transaction().execute(async (trx) => {
      const checked = await checkTeamCanPublishPaidSession(
        trx,
        gateInput(teamId, PAID, { log: logs.logger }),
      );
      let thrown: unknown;
      try {
        await assertTeamCanPublishPaidSession(trx, gateInput(teamId, PAID, { log: logs.logger }));
      } catch (error) {
        thrown = error;
      }
      return { checked, thrown };
    });
    expect(outcome.checked).toEqual({ ok: false, reason: 'not_configured' });
    expectRefusal(outcome.thrown);
    expect(await statusOf(sessionId)).toBe('DRAFT');

    const lines = refusalLines(logs);
    expect(lines).toHaveLength(2);
    for (const line of lines) {
      expect(line).toMatchObject({
        teamId,
        reason: 'not_configured',
        errorCode: 'payout_not_configured',
      });
      // Ids and the reason only: no actor was supplied, nothing about the bank, no `code` field.
      expect(line).not.toHaveProperty('code');
      expect(line).not.toHaveProperty('actorId');
      expect(
        Object.keys(line).filter((key) => /^(bank|account|envelope|number)/i.test(key)),
      ).toEqual([]);
    }
  });

  it('adds the actor id to the log line only when the caller supplies one', async () => {
    const logs = captureLogs();
    const teamId = await insertTeam(database.pool);
    const actorId = await insertUser(database.pool);
    await h.db.transaction().execute(async (trx) => {
      await checkTeamCanPublishPaidSession(
        trx,
        gateInput(teamId, PAID, { log: logs.logger, actorId }),
      );
    });
    expect(refusalLines(logs)[0]).toMatchObject({ teamId, actorId });
  });

  it('treats a missing team as not configured (refuses, never throws a database error)', async () => {
    const logs = captureLogs();
    const missing = '00000000-0000-4000-8000-0000000000aa';
    const result = await h.db
      .transaction()
      .execute((trx) =>
        checkTeamCanPublishPaidSession(trx, gateInput(missing, PAID, { log: logs.logger })),
      );
    expect(result).toEqual({ ok: false, reason: 'team_not_found' });
    expect(refusalLines(logs)[0]).toMatchObject({ teamId: missing, reason: 'team_not_found' });
    await expect(
      h.db.transaction().execute((trx) => assertTeamCanPublishPaidSession(trx, gateInput(missing))),
    ).rejects.toMatchObject({ code: 'payout_not_configured' });
  });

  it('refuses a raw UPDATE to PUBLISHED and a raw INSERT as PUBLISHED, and mapPublishGateDbError turns both into the same 409', async () => {
    const teamId = await insertTeam(database.pool);
    const sessionId = await paidDraft(teamId);
    const rawErrors: unknown[] = [];
    for (const attempt of [
      () => publishRaw(sessionId),
      () => insertPublishedRaw(database.pool, teamId, '17.00'),
    ]) {
      try {
        await attempt();
      } catch (error) {
        rawErrors.push(error);
      }
    }
    expect(rawErrors).toHaveLength(2);
    for (const error of rawErrors) {
      expect(error).toMatchObject({
        code: '23514',
        constraint: 'game_sessions_paid_requires_payout',
      });
      const mapped = mapPublishGateDbError(error);
      expectRefusal(mapped);
      expect((mapped as AppError).cause).toBe(error);
    }
    expect(await statusOf(sessionId)).toBe('DRAFT');
    expect(await countSessions(teamId)).toBe(1);
  });
});

describe('AC-ERROR-9: the rule is re-checked at every publish', () => {
  it('blocks later paid publishes and free-to-paid edits after removal, and leaves PUBLISHED, COMPLETED and CANCELLED sessions untouched', async () => {
    const admin = await scene.person();
    const teamId = await scene.team([admin]);
    expect(
      (await scene.putBanking(teamId, admin, scene.body('Club Account', ACCOUNT_A))).statusCode,
    ).toBe(200);

    const freePublished = await insertSession(database.pool, teamId, { flat: '0.00' });
    await publishRaw(freePublished);
    const paidCompleted = await paidDraft(teamId);
    await publishRaw(paidCompleted);
    await setStatus(paidCompleted, 'COMPLETED');
    const paidCancelled = await paidDraft(teamId);
    await publishRaw(paidCancelled);
    await setStatus(paidCancelled, 'CANCELLED');

    // Nothing depends on the destination any more, so the removal is allowed.
    const removed = await scene.deleteBanking(teamId, admin);
    expect(removed.statusCode).toBe(200);
    expect(await configured(teamId)).toBe(false);
    expect(await statusOf(freePublished)).toBe('PUBLISHED');
    expect(await statusOf(paidCompleted)).toBe('COMPLETED');
    expect(await statusOf(paidCancelled)).toBe('CANCELLED');

    // A different paid DRAFT can no longer be published: gate and trigger agree.
    const later = await paidDraft(teamId);
    expectRefusal(((await gateAttempt(teamId)) as { refused: unknown }).refused);
    await expectPgError(publishRaw(later), '23514', 'game_sessions_paid_requires_payout');
    expect(await statusOf(later)).toBe('DRAFT');

    // Raising a free published session's fee above zero is a transition into published-and-paid.
    let raiseError: unknown;
    try {
      await database.pool.query(`UPDATE game_sessions SET fee_flat = '5.00' WHERE id = $1`, [
        freePublished,
      ]);
    } catch (error) {
      raiseError = error;
    }
    expect(raiseError).toMatchObject({
      code: '23514',
      constraint: 'game_sessions_paid_requires_payout',
    });
    expectRefusal(mapPublishGateDbError(raiseError));
    expect(await statusOf(freePublished)).toBe('PUBLISHED');
  });
});

describe('AC-ERROR-10: banking cannot be removed while it is in use', () => {
  it('answers 409 banking_in_use for a PUBLISHED paid session, keeps the row, and still allows replacing the details', async () => {
    const admin = await scene.person();
    const teamId = await scene.team([admin]);
    await scene.putBanking(teamId, admin, scene.body('Club Account', ACCOUNT_A));
    const sessionId = await paidDraft(teamId);
    await publishRaw(sessionId);
    const before = await scene.row(teamId);

    const refused = await scene.deleteBanking(teamId, admin);
    expect(refused.statusCode).toBe(409);
    expect(json<ErrorBody>(refused).error.code).toBe('banking_in_use');
    const after = await scene.row(teamId);
    expect(after.bank_account_number).toBe(before.bank_account_number);
    expect(after.bank_account_name).toBe(before.bank_account_name);
    expect(after.is_payout_configured).toBe(true);

    // Replacing stays allowed (AC-HAPPY-2 and 3): a different account while the session is published.
    const replaced = await scene.putBanking(teamId, admin, scene.body('New Name', ACCOUNT_B));
    expect(replaced.statusCode).toBe(200);
    expect(json<BankingBody>(replaced).banking.isPayoutConfigured).toBe(true);
    expect(await scene.opened(teamId)).toEqual({ name: 'New Name', number: ACCOUNT_B.canonical });
    expect(await statusOf(sessionId)).toBe('PUBLISHED');
  });

  it('backstops a raw-SQL removal with 23514 teams_banking_in_use and maps it to banking_in_use', async () => {
    const teamId = await insertTeam(database.pool, { payoutConfigured: true });
    await publishRaw(await paidDraft(teamId));
    let raw: unknown;
    try {
      await database.pool.query(CLEAR_BANKING, [teamId]);
    } catch (error) {
      raw = error;
    }
    expect(raw).toMatchObject({ code: '23514', constraint: 'teams_banking_in_use' });
    const mapped = mapBankingDbError(raw);
    expect(mapped).toBeInstanceOf(AppError);
    expect((mapped as AppError).code).toBe('banking_in_use');
    expect(await configured(teamId)).toBe(true);
  });

  it('allows removal when the only sessions are free, DRAFT, CANCELLED or COMPLETED', async () => {
    const admin = await scene.person();
    const teamId = await scene.team([admin], { payoutConfigured: true });
    const free = await insertSession(database.pool, teamId, { flat: '0.00' });
    await publishRaw(free);
    await paidDraft(teamId);
    const cancelled = await paidDraft(teamId);
    await publishRaw(cancelled);
    await setStatus(cancelled, 'CANCELLED');
    const completed = await paidDraft(teamId);
    await publishRaw(completed);
    await setStatus(completed, 'COMPLETED');

    const response = await scene.deleteBanking(teamId, admin);
    expect(response.statusCode).toBe(200);
    expect(json<BankingBody>(response).banking.isPayoutConfigured).toBe(false);
    expect((await scene.row(teamId)).bank_account_number).toBeNull();
  });

  it('refuses removal while a payment is PENDING or OVERDUE and allows it once the payments are settled', async () => {
    const admin = await scene.person();
    const teamId = await scene.team([admin], { payoutConfigured: true });
    const payerId = await insertUser(database.pool);
    const paymentId = await insertPayment(database.pool, {
      userId: payerId,
      teamId,
      registrationId: null,
      amount: '17.00',
    });
    for (const status of ['PENDING', 'OVERDUE'] as const) {
      await database.pool.query(`UPDATE payments SET status = $2::payment_status WHERE id = $1`, [
        paymentId,
        status,
      ]);
      const refused = await scene.deleteBanking(teamId, admin);
      expect(refused.statusCode, status).toBe(409);
      expect(json<ErrorBody>(refused).error.code).toBe('banking_in_use');
    }
    await database.pool.query(
      `UPDATE payments SET status = 'PAID', paid_at = now() WHERE id = $1`,
      [paymentId],
    );
    expect((await scene.deleteBanking(teamId, admin)).statusCode).toBe(200);
  });
});

describe('AC-ERROR-15: a blocked payout destination refuses paid publishes until a save', () => {
  it('refuses at the gate (payout_blocked) and the trigger, then a PUT banking save clears the block and publish passes', async () => {
    const logs = captureLogs();
    const admin = await scene.person();
    const teamId = await scene.team([admin]);
    await scene.putBanking(teamId, admin, scene.body('Club Account', ACCOUNT_A));
    const sessionId = await paidDraft(teamId);
    await database.pool.query(`UPDATE teams SET payout_blocked_at = now() WHERE id = $1`, [teamId]);
    expect(await configured(teamId)).toBe(false);

    const result = await h.db
      .transaction()
      .execute((trx) =>
        checkTeamCanPublishPaidSession(trx, gateInput(teamId, PAID, { log: logs.logger })),
      );
    expect(result).toEqual({ ok: false, reason: 'payout_blocked' });
    expect(refusalLines(logs)[0]).toMatchObject({ teamId, reason: 'payout_blocked' });
    expectRefusal(((await gateAttempt(teamId)) as { refused: unknown }).refused);
    await expectPgError(publishRaw(sessionId), '23514', 'game_sessions_paid_requires_payout');

    // The save lifts the block (even with unchanged values: R3), so the same session now publishes.
    const saved = await scene.putBanking(teamId, admin, scene.body('Club Account', ACCOUNT_A));
    expect(saved.statusCode).toBe(200);
    expect((await scene.row(teamId)).payout_blocked_at).toBeNull();
    expect(await gateAttempt(teamId)).toEqual({ ok: true });
    await publishRaw(sessionId);
    expect(await statusOf(sessionId)).toBe('PUBLISHED');
  });
});

function sessionFor(row: PaidSessionCase): Parameters<typeof insertSession>[2] {
  return {
    pricing: row.pricingStructure,
    flat: row.fees.feeFlat,
    male: row.fees.feeMale,
    female: row.fees.feeFemale,
    other: row.fees.feeOther,
    beginner: row.fees.feeBeginner,
    intermediate: row.fees.feeIntermediate,
    advanced: row.fees.feeAdvanced,
  };
}

describe('AC-VERIFY-8 and AC-INTEGRATION-2: isPaidSession is the twin of game_session_is_paid', () => {
  it('agrees with the SQL function on every matrix row, evaluated in one query, and with the hand-written expectation', async () => {
    const payload = PAID_SESSION_MATRIX.map((row, i) => ({
      i,
      ps: row.pricingStructure,
      ...row.fees,
    }));
    const { rows } = await database.pool.query<{ i: number; paid: boolean }>(
      `SELECT t.i, game_session_is_paid(t.ps::pricing_type, t."feeFlat"::numeric(10,2),
                t."feeMale"::numeric(10,2), t."feeFemale"::numeric(10,2), t."feeOther"::numeric(10,2),
                t."feeBeginner"::numeric(10,2), t."feeIntermediate"::numeric(10,2),
                t."feeAdvanced"::numeric(10,2)) AS paid
         FROM jsonb_to_recordset($1::jsonb) AS t(i int, ps text, "feeFlat" text, "feeMale" text,
              "feeFemale" text, "feeOther" text, "feeBeginner" text, "feeIntermediate" text,
              "feeAdvanced" text)
        ORDER BY t.i`,
      [JSON.stringify(payload)],
    );
    expect(rows).toHaveLength(PAID_SESSION_MATRIX.length);
    const disagree = rows
      .filter((row) => {
        const matrixRow = PAID_SESSION_MATRIX[row.i];
        return (
          matrixRow === undefined ||
          row.paid !== isPaidSession(matrixRow.pricingStructure, matrixRow.fees) ||
          row.paid !== matrixRow.expectedPaid
        );
      })
      .map((row) => PAID_SESSION_MATRIX[row.i]?.name);
    expect(disagree).toEqual([]);
  });

  it('publishes every publishable matrix row as a real session through the trigger: refused for an unconfigured team exactly when isPaidSession says paid, accepted for a configured one; the other insertable rows are refused by the D-77 CHECK', async () => {
    const bare = await insertTeam(database.pool);
    const ready = await insertTeam(database.pool, { payoutConfigured: true });
    const insertable = PAID_SESSION_MATRIX.filter((row) => row.insertable);
    expect(insertable).toHaveLength(65);
    const rows = insertable.filter((row) => row.publishable);
    expect(rows).toHaveLength(10);
    const wrong: string[] = [];
    const constraintOf = async (sessionId: string): Promise<string | undefined> =>
      (
        await publishRaw(sessionId).then(
          () => undefined,
          (error: unknown) => ({ constraint: (error as { constraint?: string }).constraint }),
        )
      )?.constraint;
    for (const row of rows) {
      const paid = isPaidSession(row.pricingStructure, row.fees);
      const refusedSession = await insertSession(database.pool, bare, sessionFor(row));
      const refused = (await constraintOf(refusedSession)) === 'game_sessions_paid_requires_payout';
      if (refused !== paid || (refused && (await statusOf(refusedSession)) !== 'DRAFT')) {
        wrong.push(`bare: ${row.name}`);
      }
      if (!refused && (await statusOf(refusedSession)) !== 'PUBLISHED')
        wrong.push(`bare: ${row.name}`);
      const okSession = await insertSession(database.pool, ready, sessionFor(row));
      await publishRaw(okSession);
      if ((await statusOf(okSession)) !== 'PUBLISHED') wrong.push(`ready: ${row.name}`);
    }
    // Insertable but incomplete for a live session (FLAT without fee_flat, BY_SKILL_LEVEL without all three skill
    // fees): D-77 refuses the publish even for a configured team, and the session stays a DRAFT.
    for (const row of insertable.filter((candidate) => !candidate.publishable)) {
      const sessionId = await insertSession(database.pool, ready, sessionFor(row));
      const expected =
        row.pricingStructure === 'FLAT'
          ? 'game_sessions_flat_fee_when_live'
          : 'game_sessions_skill_fees_when_live';
      if ((await constraintOf(sessionId)) !== expected || (await statusOf(sessionId)) !== 'DRAFT') {
        wrong.push(`incomplete: ${row.name}`);
      }
    }
    expect(wrong).toEqual([]);
  });
});

describe('AC-VERIFY-9: publish, removal and payment races (no sleeps, no deadlock)', () => {
  /** A publisher that has run the gate and the publishing UPDATE and now holds `teams FOR KEY SHARE` uncommitted. */
  async function heldGatedPublish(
    teamId: string,
    sessionId: string,
  ): Promise<{ commit: () => Promise<void> }> {
    let proceed!: () => void;
    const proceeding = new Promise<void>((resolve) => {
      proceed = resolve;
    });
    let reached!: () => void;
    const reachedPoint = new Promise<void>((resolve) => {
      reached = resolve;
    });
    const run = h.db.transaction().execute(async (trx) => {
      await assertTeamCanPublishPaidSession(trx, gateInput(teamId));
      await trx
        .updateTable('game_sessions')
        .set({ status: 'PUBLISHED' })
        .where('id', '=', sessionId)
        .execute();
      reached();
      await proceeding;
    });
    // A refused gate rejects `run` before `reached`, so the race fails loudly instead of hanging.
    await Promise.race([reachedPoint, run]);
    return {
      commit: async () => {
        proceed();
        await run;
      },
    };
  }

  /** An open raw transaction holding the trigger's `KEY SHARE` after `work` ran. */
  async function heldRaw(
    work: (client: pg.PoolClient) => Promise<unknown>,
  ): Promise<{ settle: (how: 'COMMIT' | 'ROLLBACK') => Promise<unknown> }> {
    const client = await database.pool.connect();
    let outcome: unknown;
    let released = false;
    try {
      await client.query('BEGIN');
      outcome = await work(client).then(
        () => undefined,
        (error: unknown) => error,
      );
    } catch (error) {
      client.release();
      throw error;
    }
    return {
      settle: async (how) => {
        if (!released) {
          released = true;
          try {
            await client.query(how);
          } finally {
            client.release();
          }
        }
        return outcome;
      },
    };
  }

  const noDeadlock = (value: unknown): void => {
    expect((value as { code?: unknown } | null | undefined)?.code).not.toBe('40P01');
  };

  describe('removal queued behind a publisher (the publish commits first)', () => {
    it('gate: the gated publish commits, the removal then re-checks and answers 409 banking_in_use', async () => {
      const admin = await scene.person();
      const teamId = await scene.team([admin], { payoutConfigured: true });
      const sessionId = await paidDraft(teamId);
      const publisher = await heldGatedPublish(teamId, sessionId);
      try {
        const removal = scene.deleteBanking(teamId, admin);
        await waitForLockWaiters(database.pool, 1, 'removal blocked behind the gated publish');
        await publisher.commit();
        const response = await removal;
        expect(response.statusCode).toBe(409);
        expect(json<ErrorBody>(response).error.code).toBe('banking_in_use');
      } finally {
        await publisher.commit().catch(() => undefined);
      }
      expect(await statusOf(sessionId)).toBe('PUBLISHED');
      expect(await configured(teamId)).toBe(true);
      expect(await strandedPaidSessions(teamId)).toBe(0);
    });

    it('raw UPDATE to PUBLISHED: the trigger holds KEY SHARE, the removal waits and then refuses', async () => {
      const admin = await scene.person();
      const teamId = await scene.team([admin], { payoutConfigured: true });
      const sessionId = await paidDraft(teamId);
      const publisher = await heldRaw((client) =>
        client.query(`UPDATE game_sessions SET status = 'PUBLISHED' WHERE id = $1`, [sessionId]),
      );
      try {
        const removal = scene.deleteBanking(teamId, admin);
        await waitForLockWaiters(database.pool, 1, 'removal blocked behind the raw publish');
        expect(await publisher.settle('COMMIT')).toBeUndefined();
        const response = await removal;
        expect(response.statusCode).toBe(409);
        expect(json<ErrorBody>(response).error.code).toBe('banking_in_use');
      } finally {
        await publisher.settle('ROLLBACK');
      }
      expect(await statusOf(sessionId)).toBe('PUBLISHED');
      expect(await strandedPaidSessions(teamId)).toBe(0);
    });

    it('raw INSERT as PUBLISHED cannot commit today (the failed statement aborts the transaction and drops its lock at once), so there is nothing to race and nothing is stranded', async () => {
      const admin = await scene.person();
      const teamId = await scene.team([admin], { payoutConfigured: true });
      const publisher = await heldRaw((client) => insertPublishedRaw(client, teamId, '17.00'));
      try {
        // An error aborts the transaction and releases its row locks immediately, so the removal does not queue.
        expect((await scene.deleteBanking(teamId, admin)).statusCode).toBe(200);
        expect(await publisher.settle('ROLLBACK')).toMatchObject({
          code: '23514',
          constraint: 'game_sessions_instants_when_live',
        });
      } finally {
        await publisher.settle('ROLLBACK');
      }
      expect(await countSessions(teamId)).toBe(0);
      expect(await strandedPaidSessions(teamId)).toBe(0);
    });

    it('raw-SQL removal (trigger self-upgrade to FOR UPDATE) waits for the gated publish and is then refused teams_banking_in_use', async () => {
      const teamId = await insertTeam(database.pool, { payoutConfigured: true });
      const sessionId = await paidDraft(teamId);
      const publisher = await heldGatedPublish(teamId, sessionId);
      try {
        const removal = pgError(database.pool.query(CLEAR_BANKING, [teamId]));
        await waitForLockWaiters(database.pool, 1, 'raw removal blocked behind the gated publish');
        await publisher.commit();
        const info = await removal;
        noDeadlock(info);
        expect(info).toMatchObject({ code: '23514', constraint: 'teams_banking_in_use' });
      } finally {
        await publisher.commit().catch(() => undefined);
      }
      expect(await configured(teamId)).toBe(true);
      expect(await strandedPaidSessions(teamId)).toBe(0);
    });
  });

  describe('publish queued behind a removal (the removal commits first)', () => {
    it('gate: after the removal commits, the gated publish is refused payout_not_configured', async () => {
      const teamId = await insertTeam(database.pool, { payoutConfigured: true });
      const sessionId = await paidDraft(teamId);
      const [outcome] = await raceUnderTeamLock(
        database.pool,
        teamId,
        [() => gateAttempt(teamId)],
        {
          beforeRelease: async (lock) => {
            await lock.query(CLEAR_BANKING, [teamId]);
          },
        },
      );
      expect(outcome).toHaveProperty('refused');
      const refused = (outcome as { refused: unknown }).refused;
      noDeadlock(refused);
      expectRefusal(refused);
      expect(await statusOf(sessionId)).toBe('DRAFT');
      expect(await configured(teamId)).toBe(false);
    });

    it('raw UPDATE to PUBLISHED: the trigger waits for the removal, re-reads the committed row and refuses 23514', async () => {
      const teamId = await insertTeam(database.pool, { payoutConfigured: true });
      const sessionId = await paidDraft(teamId);
      const [info] = await raceUnderTeamLock(
        database.pool,
        teamId,
        [() => pgError(publishRaw(sessionId))],
        {
          beforeRelease: async (lock) => {
            await lock.query(CLEAR_BANKING, [teamId]);
          },
        },
      );
      noDeadlock(info);
      expect(info).toMatchObject({
        code: '23514',
        constraint: 'game_sessions_paid_requires_payout',
      });
      expect(await statusOf(sessionId)).toBe('DRAFT');
      expect(await strandedPaidSessions(teamId)).toBe(0);
    });

    it('raw INSERT as PUBLISHED: refused by the payout trigger (which fires before the instants CHECK) after the removal commits', async () => {
      const teamId = await insertTeam(database.pool, { payoutConfigured: true });
      const [info] = await raceUnderTeamLock(
        database.pool,
        teamId,
        [() => pgError(insertPublishedRaw(database.pool, teamId, '17.00'))],
        {
          beforeRelease: async (lock) => {
            await lock.query(CLEAR_BANKING, [teamId]);
          },
        },
      );
      noDeadlock(info);
      expect(info).toMatchObject({
        code: '23514',
        constraint: 'game_sessions_paid_requires_payout',
      });
      expect(await countSessions(teamId)).toBe(0);
    });

    it('API removal holds FOR UPDATE first: a gated publish started during it waits and is then refused', async () => {
      // The held transaction is exactly what the service takes first (FOR UPDATE), then clears the block.
      const admin = await scene.person();
      const teamId = await scene.team([admin], { payoutConfigured: true });
      const sessionId = await paidDraft(teamId);
      const lock = await holdTeamLock(database.pool, teamId);
      try {
        await lock.query(CLEAR_BANKING, [teamId]);
        const gate = gateAttempt(teamId);
        await waitForLockWaiters(database.pool, 1, 'gate blocked behind the removal');
        await lock.release();
        const outcome = await gate;
        expect(outcome).toHaveProperty('refused');
        expectRefusal((outcome as { refused: unknown }).refused);
      } finally {
        await lock.release();
      }
      expect(await statusOf(sessionId)).toBe('DRAFT');
    });
  });

  describe('R4 C-BIL-PAY: a payment for an already COMPLETED session races a removal', () => {
    /** A configured team whose paid session was published, registered for, and COMPLETED. */
    async function completedSessionScene() {
      const admin = await scene.person();
      const teamId = await scene.team([admin], { payoutConfigured: true });
      const sessionId = await paidDraft(teamId);
      await publishRaw(sessionId);
      const userId = await insertUser(database.pool);
      const registrationId = await insertRegistration(database.pool, { sessionId, teamId, userId });
      await setStatus(sessionId, 'COMPLETED');
      return {
        admin,
        teamId,
        payment: { userId, teamId, registrationId, amount: '17.00' } as const,
      };
    }

    const paymentCount = async (teamId: string): Promise<number> => {
      const { rows } = await database.pool.query<{ n: number }>(
        'SELECT count(*)::int AS n FROM payments WHERE team_id = $1',
        [teamId],
      );
      return rows[0]?.n ?? 0;
    };

    it('payment first: the removal waits, then refuses banking_in_use because the payment is PENDING', async () => {
      const { admin, teamId, payment } = await completedSessionScene();
      const client = await database.pool.connect();
      let finished = false;
      try {
        await client.query('BEGIN');
        await createStandInPayment(client, payment);
        const removal = scene.deleteBanking(teamId, admin);
        await waitForLockWaiters(database.pool, 1, 'removal blocked behind the payment');
        await client.query('COMMIT');
        finished = true;
        const response = await removal;
        expect(response.statusCode).toBe(409);
        expect(json<ErrorBody>(response).error.code).toBe('banking_in_use');
      } finally {
        if (!finished) await client.query('ROLLBACK').catch(() => undefined);
        client.release();
      }
      expect(await paymentCount(teamId)).toBe(1);
      expect(await configured(teamId)).toBe(true);
    });

    it('removal first: the stand-in waits, finds no banking and fails cleanly with payout_not_configured, inserting nothing', async () => {
      const { teamId, payment } = await completedSessionScene();
      const [outcome] = await raceUnderTeamLock(
        database.pool,
        teamId,
        [() => attemptStandInPayment(database.pool, payment)],
        {
          beforeRelease: async (lock) => {
            await lock.query(CLEAR_BANKING, [teamId]);
          },
        },
      );
      expect(outcome).toHaveProperty('refused');
      const refused = (outcome as { refused: unknown }).refused;
      noDeadlock(refused);
      expectRefusal(refused);
      expect(await paymentCount(teamId)).toBe(0);
      expect(await configured(teamId)).toBe(false);
    });

    it('a stand-in payment on an already removed destination is refused at once', async () => {
      const { teamId, payment } = await completedSessionScene();
      await database.pool.query(CLEAR_BANKING, [teamId]);
      const outcome = await attemptStandInPayment(database.pool, payment);
      expect(outcome).toHaveProperty('refused');
      expectRefusal((outcome as { refused: unknown }).refused);
      expect(await paymentCount(teamId)).toBe(0);
    });
  });
});
