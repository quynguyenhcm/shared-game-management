/**
 * team-banking-and-gst, Phase 1 (database half): the P1 backstops of migration
 * `20261016000100000_team_banking_and_gst_invariants.sql` (ledger D-47..D-53), driven from raw SQL.
 *
 *  - the all-or-none payout block, the GST CHECKs and the banking audit pair (23514, named constraints);
 *  - `is_payout_configured` as a generated column, including `payout_blocked_at`;
 *  - `game_session_is_paid` over the shared parity matrix (hand-written expectations);
 *  - the `game_sessions_paid_requires_payout` publish trigger (INSERT and UPDATE);
 *  - `team_banking_in_use` and the `teams_banking_in_use` removal backstop, including the raw-SQL
 *    self-upgrade race against a publisher.
 *
 * The pre-feature upgrade path is in `team-banking-upgrade.int.test.ts`.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  FEE_KEYS,
  PAID_SESSION_MATRIX,
  type PaidSessionCase,
} from '../fixtures/paid-session-matrix.ts';
import {
  insertPayment,
  insertSession,
  insertTeam,
  insertUser,
  payoutBlockFor,
} from '../helpers/factories.ts';
import { waitForLockWaiters } from '../helpers/lock-waiters.ts';
import {
  createTestDatabase,
  expectPgError,
  inRollback,
  pgError,
  trySql,
  type TestDatabase,
} from '../helpers/test-db.ts';

let db: TestDatabase;
beforeAll(async () => {
  db = await createTestDatabase({ poolMax: 8 });
});
afterAll(async () => {
  await db.close();
});

const ZERO_BLOCK =
  'bank_account_name = NULL, bank_account_number = NULL, bank_account_last4 = NULL';

async function configured(teamId: string): Promise<boolean> {
  const { rows } = await db.pool.query<{ is_payout_configured: boolean }>(
    'SELECT is_payout_configured FROM teams WHERE id = $1',
    [teamId],
  );
  return rows[0]?.is_payout_configured ?? false;
}

function publish(sessionId: string): Promise<unknown> {
  return db.pool.query(`UPDATE game_sessions SET status = 'PUBLISHED' WHERE id = $1`, [sessionId]);
}

describe('payout block and audit CHECKs', () => {
  it('rejects every partial name/number/last4 combination with teams_payout_details_all_or_none', async () => {
    const teamId = await insertTeam(db.pool);
    const block = payoutBlockFor(teamId);
    const parts = [
      ['bank_account_name', block.name],
      ['bank_account_number', block.number],
      ['bank_account_last4', block.last4],
    ] as const;
    await inRollback(db.pool, async (client) => {
      for (let mask = 1; mask <= 6; mask += 1) {
        const set = parts.filter((_, i) => (mask & (1 << i)) !== 0);
        const assignments = set.map(([column], i) => `${column} = $${i + 2}`).join(', ');
        const error = await trySql(client, `UPDATE teams SET ${assignments} WHERE id = $1`, [
          teamId,
          ...set.map(([, value]) => value),
        ]);
        expect(error, `mask ${mask}`).toMatchObject({
          code: '23514',
          constraint: 'teams_payout_details_all_or_none',
        });
      }
      // All three, and none, are allowed.
      expect(
        await trySql(
          client,
          `UPDATE teams SET bank_account_name = $2, bank_account_number = $3, bank_account_last4 = $4
            WHERE id = $1`,
          [teamId, block.name, block.number, block.last4],
        ),
      ).toBeUndefined();
      expect(
        await trySql(client, `UPDATE teams SET ${ZERO_BLOCK} WHERE id = $1`, [teamId]),
      ).toBeUndefined();
    });
  });

  it('keeps the plaintext-envelope CHECKs reporting first and leaves the Akahu columns alone', async () => {
    const teamId = await insertTeam(db.pool);
    await expectPgError(
      db.pool.query(`UPDATE teams SET bank_account_name = 'plain text' WHERE id = $1`, [teamId]),
      '23514',
      'teams_bank_account_name_envelope',
    );
    // R1: no Akahu constraint was added; the columns are still free-form and independent of the block.
    await db.pool.query(`UPDATE teams SET akahu_merchant_id = 'anything goes' WHERE id = $1`, [
      teamId,
    ]);
    const { rows } = await db.pool.query<{ conname: string }>(
      `SELECT conname FROM pg_constraint
        WHERE conrelid = 'teams'::regclass AND conname ILIKE '%akahu%' ORDER BY conname`,
    );
    expect(rows.map((row) => row.conname)).toEqual(['teams_akahu_app_token_envelope']);
  });

  it('enforces the GST number format and gst_registered requires a number', async () => {
    const teamId = await insertTeam(db.pool);
    await inRollback(db.pool, async (client) => {
      const set = (registered: boolean, number: string | null): Promise<unknown> =>
        trySql(client, `UPDATE teams SET gst_registered = $2, gst_number = $3 WHERE id = $1`, [
          teamId,
          registered,
          number,
        ]);
      for (const bad of [
        '049091850',
        '1234567',
        '1234567890',
        '12a45678',
        '',
        '49-091-850',
        ' 49091850',
      ]) {
        expect(await set(false, bad), `format ${JSON.stringify(bad)}`).toMatchObject({
          code: '23514',
          constraint: 'teams_gst_number_format',
        });
      }
      expect(await set(true, null)).toMatchObject({
        code: '23514',
        constraint: 'teams_gst_registered_requires_gst_number',
      });
      // A bad number on a registered team reports the format first (name order).
      expect(await set(true, '012345678')).toMatchObject({ constraint: 'teams_gst_number_format' });
      // Valid shapes: 8 and 9 digits, registered or not, and a number kept after switching GST off.
      expect(await set(true, '49091850')).toBeUndefined();
      expect(await set(true, '136410132')).toBeUndefined();
      expect(await set(false, '136410132')).toBeUndefined();
      expect(await set(false, null)).toBeUndefined();
    });
  });

  it('requires banking_updated_at whenever banking_updated_by is set, and keeps the stamp when the user is deleted', async () => {
    const teamId = await insertTeam(db.pool);
    const actor = await insertUser(db.pool);
    await expectPgError(
      db.pool.query(`UPDATE teams SET banking_updated_by = $2 WHERE id = $1`, [teamId, actor]),
      '23514',
      'teams_banking_updated_pair',
    );
    // The timestamp alone is allowed (the actor may be gone), and so is the pair.
    await db.pool.query(`UPDATE teams SET banking_updated_at = now() WHERE id = $1`, [teamId]);
    await db.pool.query(`UPDATE teams SET banking_updated_by = $2 WHERE id = $1`, [teamId, actor]);
    await db.pool.query('DELETE FROM users WHERE id = $1', [actor]);
    const { rows } = await db.pool.query<{ by: string | null; at: Date | null }>(
      `SELECT banking_updated_by AS by, banking_updated_at AS at FROM teams WHERE id = $1`,
      [teamId],
    );
    expect(rows[0]?.by).toBeNull();
    expect(rows[0]?.at).toBeInstanceOf(Date);
  });
});

describe('is_payout_configured (generated)', () => {
  it('is false without a block, true with a full block, and false while payout_blocked_at is set', async () => {
    const bare = await insertTeam(db.pool);
    const ready = await insertTeam(db.pool, { payoutConfigured: true });
    const blocked = await insertTeam(db.pool, {
      payoutConfigured: true,
      payoutBlockedAt: new Date(),
    });
    expect(await configured(bare)).toBe(false);
    expect(await configured(ready)).toBe(true);
    expect(await configured(blocked)).toBe(false);

    // Clearing the block (a save) turns it back on; setting it (billing) turns it off; removal turns it off.
    await db.pool.query(`UPDATE teams SET payout_blocked_at = NULL WHERE id = $1`, [blocked]);
    expect(await configured(blocked)).toBe(true);
    await db.pool.query(`UPDATE teams SET payout_blocked_at = now() WHERE id = $1`, [blocked]);
    expect(await configured(blocked)).toBe(false);
    await db.pool.query(`UPDATE teams SET payout_blocked_at = NULL, ${ZERO_BLOCK} WHERE id = $1`, [
      blocked,
    ]);
    expect(await configured(blocked)).toBe(false);
  });

  it('cannot be written: an INSERT or UPDATE of the column fails with 428C9', async () => {
    const teamId = await insertTeam(db.pool);
    await expectPgError(
      db.pool.query(`UPDATE teams SET is_payout_configured = true WHERE id = $1`, [teamId]),
      '428C9',
    );
    await expectPgError(
      db.pool.query(
        `INSERT INTO teams (name, invite_code, is_payout_configured) VALUES ('x', repeat('a', 43), true)`,
      ),
      '428C9',
    );
    const { rows } = await db.pool.query<{
      attgenerated: string;
      attnotnull: boolean;
      type: string;
    }>(
      `SELECT attgenerated, attnotnull, format_type(atttypid, atttypmod) AS type FROM pg_attribute
        WHERE attrelid = 'teams'::regclass AND attname = 'is_payout_configured'`,
    );
    expect(rows[0]).toEqual({ attgenerated: 's', attnotnull: true, type: 'boolean' });
  });
});

describe('game_session_is_paid (parity matrix)', () => {
  it('matches the hand-written expectation on every matrix row, evaluated in one query', async () => {
    // 105 single-fee rows (M1) plus 12 combination rows (M2 to M6), per the algorithm doc.
    expect(PAID_SESSION_MATRIX).toHaveLength(117);
    const payload = PAID_SESSION_MATRIX.map((row, i) => ({
      i,
      ps: row.pricingStructure,
      ...row.fees,
    }));
    const { rows } = await db.pool.query<{ i: number; paid: boolean }>(
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
    const wrong = rows
      .filter((row) => row.paid !== PAID_SESSION_MATRIX[row.i]?.expectedPaid)
      .map((row) => PAID_SESSION_MATRIX[row.i]?.name);
    expect(wrong).toEqual([]);
  });

  it('pins the rule with hand-written literal cases, independent of the matrix generator', async () => {
    const cases: readonly [string, string, (string | null)[], boolean][] = [
      ['FLAT paid', 'FLAT', ['17.00', null, null, null, null, null, null], true],
      ['FLAT free', 'FLAT', ['0.00', null, null, null, null, null, null], false],
      ['FLAT NULL', 'FLAT', [null, null, null, null, null, null, null], false],
      ['FLAT with only a male fee', 'FLAT', [null, '5.00', null, null, null, null, null], false],
      ['BY_SEX other fee only', 'BY_SEX', [null, '0.00', '0.00', '0.01', null, null, null], true],
      [
        'BY_SEX with a skill fee',
        'BY_SEX',
        [null, '0.00', '0.00', '0.00', '9.00', null, null],
        false,
      ],
      [
        'BY_SKILL_LEVEL advanced',
        'BY_SKILL_LEVEL',
        [null, null, null, null, null, null, '3.00'],
        true,
      ],
      [
        'BY_SKILL_LEVEL negative',
        'BY_SKILL_LEVEL',
        [null, null, null, null, '-1.00', null, null],
        false,
      ],
    ];
    for (const [label, ps, fees, expected] of cases) {
      const { rows } = await db.pool.query<{ paid: boolean }>(
        `SELECT game_session_is_paid($1::pricing_type, $2::numeric, $3::numeric, $4::numeric, $5::numeric,
                                     $6::numeric, $7::numeric, $8::numeric) AS paid`,
        [ps, ...fees],
      );
      expect(rows[0]?.paid, label).toBe(expected);
    }
    // Fails closed on an unknown (NULL) structure.
    const { rows } = await db.pool.query<{ paid: boolean }>(
      `SELECT game_session_is_paid(NULL, 0, 0, 0, 0, 0, 0, 0) AS paid`,
    );
    expect(rows[0]?.paid).toBe(true);
    expect(FEE_KEYS).toHaveLength(7);
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

describe('game_sessions_paid_requires_payout (publish trigger)', () => {
  it('refuses to publish a paid session for a team without payout details (UPDATE)', async () => {
    const teamId = await insertTeam(db.pool);
    const sessionId = await insertSession(db.pool, teamId, { flat: '17.00' });
    const error = await expectPgError(
      publish(sessionId),
      '23514',
      'game_sessions_paid_requires_payout',
    );
    expect(error.message).not.toMatch(/v1\.|bank/i);
    const { rows } = await db.pool.query<{ status: string }>(
      'SELECT status FROM game_sessions WHERE id = $1',
      [sessionId],
    );
    expect(rows[0]?.status).toBe('DRAFT');
  });

  it('refuses a paid session inserted as PUBLISHED for an unconfigured team (INSERT)', async () => {
    const teamId = await insertTeam(db.pool);
    const insert = (flat: string): Promise<unknown> =>
      db.pool.query(
        `INSERT INTO game_sessions (team_id, location, address, date, cancellation_deadline, max_players,
                                    pricing_structure, fee_flat, status)
         VALUES ($1, 'Hall', '1 Street', '2026-10-07', '2026-10-05T06:00:00Z', 12, 'FLAT', $2, 'PUBLISHED')`,
        [teamId, flat],
      );
    await expectPgError(insert('17.00'), '23514', 'game_sessions_paid_requires_payout');
    // A free insert gets past the trigger and meets the (unrelated) instants CHECK instead.
    await expectPgError(insert('0.00'), '23514', 'game_sessions_instants_when_live');
    // So does a configured team's paid insert: the payout rule is satisfied.
    const ready = await insertTeam(db.pool, { payoutConfigured: true });
    await expectPgError(
      db.pool.query(
        `INSERT INTO game_sessions (team_id, location, address, date, cancellation_deadline, max_players,
                                    pricing_structure, fee_flat, status)
         VALUES ($1, 'Hall', '1 Street', '2026-10-07', '2026-10-05T06:00:00Z', 12, 'FLAT', '17.00', 'PUBLISHED')`,
        [ready],
      ),
      '23514',
      'game_sessions_instants_when_live',
    );
  });

  it('publishes a paid session once the team is configured, and refuses again while payout_blocked_at is set', async () => {
    const ready = await insertTeam(db.pool, { payoutConfigured: true });
    await publish(await insertSession(db.pool, ready, { flat: '17.00' }));

    const blocked = await insertTeam(db.pool, {
      payoutConfigured: true,
      payoutBlockedAt: new Date(),
    });
    const sessionId = await insertSession(db.pool, blocked, { flat: '17.00' });
    await expectPgError(publish(sessionId), '23514', 'game_sessions_paid_requires_payout');
    await db.pool.query(`UPDATE teams SET payout_blocked_at = NULL WHERE id = $1`, [blocked]);
    await publish(sessionId);
  });

  it('lets free sessions through for an unconfigured team and ignores non-published statuses', async () => {
    const teamId = await insertTeam(db.pool);
    await publish(await insertSession(db.pool, teamId, { flat: '0.00' }));
    // No fee at all counts as free for the payout rule, but a FLAT session cannot go live without its rate
    // (C-SSE-1, D-77): the refusal is that CHECK, never the payout trigger.
    await expectPgError(
      publish(await insertSession(db.pool, teamId, { flat: null })),
      '23514',
      'game_sessions_flat_fee_when_live',
    );
    await publish(
      await insertSession(db.pool, teamId, {
        pricing: 'BY_SEX',
        flat: null,
        male: '0.00',
        female: '0.00',
        other: '0.00',
      }),
    );
    const paidDraft = await insertSession(db.pool, teamId, { flat: '17.00' });
    await db.pool.query(`UPDATE game_sessions SET status = 'CANCELLED' WHERE id = $1`, [paidDraft]);
  });

  it('checks a published free session that turns paid, and does not recheck one that stays paid', async () => {
    const teamId = await insertTeam(db.pool);
    const sessionId = await insertSession(db.pool, teamId, { flat: '0.00' });
    await publish(sessionId);
    await expectPgError(
      db.pool.query(`UPDATE game_sessions SET fee_flat = '5.00' WHERE id = $1`, [sessionId]),
      '23514',
      'game_sessions_paid_requires_payout',
    );
    // Switching to a structure whose applicable fees are free stays free.
    await db.pool.query(
      `UPDATE game_sessions SET pricing_structure = 'BY_SEX', fee_male = '0.00', fee_female = '0.00',
              fee_other = '0.00' WHERE id = $1`,
      [sessionId],
    );

    // Published and paid on a configured team: later fee edits take no payout check (transition rule).
    const ready = await insertTeam(db.pool, { payoutConfigured: true });
    const paid = await insertSession(db.pool, ready, { flat: '17.00' });
    await publish(paid);
    await db.pool.query(`UPDATE game_sessions SET fee_flat = '20.00' WHERE id = $1`, [paid]);
    await db.pool.query(`UPDATE game_sessions SET status = 'COMPLETED' WHERE id = $1`, [paid]);
  });

  it('applies the matrix rule to a real publish: paid rows are refused, free rows pass', async () => {
    const teamId = await insertTeam(db.pool);
    const rows = PAID_SESSION_MATRIX.filter(
      (row) =>
        row.insertable &&
        (row.name.startsWith('M2') ||
          row.name.startsWith('M4') ||
          row.name.startsWith('M5') ||
          row.name.startsWith('M6') ||
          row.name.startsWith('M3 FLAT') ||
          row.name.startsWith('M1 FLAT feeFlat') ||
          row.name.startsWith('M1 BY_SKILL_LEVEL feeBeginner') ||
          row.name.startsWith('M1 BY_SKILL_LEVEL feeIntermediate') ||
          row.name.startsWith('M1 BY_SKILL_LEVEL feeAdvanced')),
    );
    expect(rows.length).toBeGreaterThanOrEqual(20);
    for (const row of rows) {
      const sessionId = await insertSession(db.pool, teamId, sessionFor(row));
      if (!row.publishable) {
        // Incomplete for C-SSE-1 (D-77): the live-session CHECK refuses it. The payout trigger fires first, so
        // a paid row on this unconfigured team is refused by the gate instead; either way it never goes live.
        const info = await pgError(publish(sessionId));
        const live =
          row.pricingStructure === 'FLAT'
            ? 'game_sessions_flat_fee_when_live'
            : 'game_sessions_skill_fees_when_live';
        expect({ name: row.name, constraint: info.constraint }).toEqual({
          name: row.name,
          constraint: row.expectedPaid ? 'game_sessions_paid_requires_payout' : live,
        });
      } else if (row.expectedPaid) {
        const info = await pgError(publish(sessionId));
        expect({ name: row.name, constraint: info.constraint }).toEqual({
          name: row.name,
          constraint: 'game_sessions_paid_requires_payout',
        });
      } else {
        await publish(sessionId);
      }
    }
  });
});

async function publishedPaidSession(teamId: string): Promise<string> {
  const sessionId = await insertSession(db.pool, teamId, { flat: '17.00' });
  await publish(sessionId);
  return sessionId;
}

async function inUse(teamId: string): Promise<boolean> {
  const { rows } = await db.pool.query<{ in_use: boolean }>(
    'SELECT team_banking_in_use($1) AS in_use',
    [teamId],
  );
  return rows[0]?.in_use ?? false;
}

async function addPayment(
  teamId: string,
  status: 'PENDING' | 'OVERDUE' | 'FAILED' | 'PAID',
): Promise<void> {
  const userId = await insertUser(db.pool);
  const paymentId = await insertPayment(db.pool, {
    userId,
    teamId,
    registrationId: null,
    amount: '17.00',
  });
  if (status !== 'PENDING') {
    await db.pool.query(
      `UPDATE payments SET status = $2::payment_status,
            paid_at = CASE WHEN $2::text = 'PAID' THEN now() END WHERE id = $1`,
      [paymentId, status],
    );
  }
}

describe('team_banking_in_use', () => {
  it('is false for a team with nothing that needs the destination', async () => {
    const teamId = await insertTeam(db.pool, { payoutConfigured: true });
    expect(await inUse(teamId)).toBe(false);
    const free = await insertSession(db.pool, teamId, { flat: '0.00' });
    await publish(free);
    const draftPaid = await insertSession(db.pool, teamId, { flat: '17.00' });
    expect(draftPaid).toBeTruthy();
    expect(await inUse(teamId)).toBe(false);
    expect(await inUse('00000000-0000-4000-8000-000000000000')).toBe(false);
  });

  it('is true for a PUBLISHED paid session, false once it is COMPLETED or CANCELLED', async () => {
    const teamId = await insertTeam(db.pool, { payoutConfigured: true });
    const sessionId = await publishedPaidSession(teamId);
    expect(await inUse(teamId)).toBe(true);
    await db.pool.query(`UPDATE game_sessions SET status = 'COMPLETED' WHERE id = $1`, [sessionId]);
    expect(await inUse(teamId)).toBe(false);
    const second = await publishedPaidSession(teamId);
    await db.pool.query(`UPDATE game_sessions SET status = 'CANCELLED' WHERE id = $1`, [second]);
    expect(await inUse(teamId)).toBe(false);
  });

  it('is true for a PENDING or OVERDUE payment and false for FAILED or PAID ones', async () => {
    const pending = await insertTeam(db.pool, { payoutConfigured: true });
    await addPayment(pending, 'PENDING');
    expect(await inUse(pending)).toBe(true);

    const overdue = await insertTeam(db.pool, { payoutConfigured: true });
    await addPayment(overdue, 'OVERDUE');
    expect(await inUse(overdue)).toBe(true);

    const settled = await insertTeam(db.pool, { payoutConfigured: true });
    await addPayment(settled, 'PAID');
    await addPayment(settled, 'FAILED');
    expect(await inUse(settled)).toBe(false);
  });
});

describe('teams_banking_in_use (removal backstop)', () => {
  it('refuses to clear the block while a published paid session depends on it, and keeps the row intact', async () => {
    const teamId = await insertTeam(db.pool, { payoutConfigured: true });
    await publishedPaidSession(teamId);
    await expectPgError(
      db.pool.query(`UPDATE teams SET ${ZERO_BLOCK} WHERE id = $1`, [teamId]),
      '23514',
      'teams_banking_in_use',
    );
    expect(await configured(teamId)).toBe(true);
  });

  it('refuses removal for an unsettled payment, with or without a session', async () => {
    const teamId = await insertTeam(db.pool, { payoutConfigured: true });
    await addPayment(teamId, 'OVERDUE');
    await expectPgError(
      db.pool.query(`UPDATE teams SET ${ZERO_BLOCK} WHERE id = $1`, [teamId]),
      '23514',
      'teams_banking_in_use',
    );
  });

  it('allows removal when nothing depends on it, and allows replacing the details while in use', async () => {
    const free = await insertTeam(db.pool, { payoutConfigured: true });
    await publish(await insertSession(db.pool, free, { flat: '0.00' }));
    await db.pool.query(`UPDATE teams SET ${ZERO_BLOCK} WHERE id = $1`, [free]);
    expect(await configured(free)).toBe(false);

    const busy = await insertTeam(db.pool, { payoutConfigured: true });
    await publishedPaidSession(busy);
    const next = payoutBlockFor(busy, { accountName: 'New Name', last4: '1234' });
    await db.pool.query(
      `UPDATE teams SET bank_account_name = $2, bank_account_number = $3, bank_account_last4 = $4 WHERE id = $1`,
      [busy, next.name, next.number, next.last4],
    );
    expect(await configured(busy)).toBe(true);
  });

  it('serialises a raw-SQL removal behind a publisher: the removal waits, then sees the publish and is refused', async () => {
    const teamId = await insertTeam(db.pool, { payoutConfigured: true });
    const sessionId = await insertSession(db.pool, teamId, { flat: '17.00' });
    const publisher = await db.pool.connect();
    const remover = await db.pool.connect();
    try {
      // The publisher's trigger holds teams FOR KEY SHARE until COMMIT.
      await publisher.query('BEGIN');
      await publisher.query(`UPDATE game_sessions SET status = 'PUBLISHED' WHERE id = $1`, [
        sessionId,
      ]);
      // The removal (NO KEY UPDATE from its own UPDATE, then the trigger's FOR UPDATE upgrade) must wait.
      const removal = pgError(
        remover.query(`UPDATE teams SET ${ZERO_BLOCK} WHERE id = $1`, [teamId]),
      );
      await waitForLockWaiters(db.pool, 1, 'removal blocked behind the publisher');
      await publisher.query('COMMIT');
      const info = await removal;
      expect(info).toMatchObject({ code: '23514', constraint: 'teams_banking_in_use' });
    } finally {
      await publisher.query('ROLLBACK').catch(() => undefined);
      await remover.query('ROLLBACK').catch(() => undefined);
      publisher.release();
      remover.release();
    }
    expect(await configured(teamId)).toBe(true);
  });

  it('lets a raw-SQL removal win when it commits first, and the publish is then refused', async () => {
    const teamId = await insertTeam(db.pool, { payoutConfigured: true });
    const sessionId = await insertSession(db.pool, teamId, { flat: '17.00' });
    const remover = await db.pool.connect();
    const publisher = await db.pool.connect();
    try {
      await remover.query('BEGIN');
      await remover.query(`UPDATE teams SET ${ZERO_BLOCK} WHERE id = $1`, [teamId]);
      const publishing = pgError(
        publisher.query(`UPDATE game_sessions SET status = 'PUBLISHED' WHERE id = $1`, [sessionId]),
      );
      await waitForLockWaiters(db.pool, 1, 'publish blocked behind the removal');
      await remover.query('COMMIT');
      expect(await publishing).toMatchObject({
        code: '23514',
        constraint: 'game_sessions_paid_requires_payout',
      });
    } finally {
      await remover.query('ROLLBACK').catch(() => undefined);
      await publisher.query('ROLLBACK').catch(() => undefined);
      remover.release();
      publisher.release();
    }
  });
});
