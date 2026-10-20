/**
 * Payments: team routing, the immutable fee snapshot with generated GST, the ownership chain and
 * BY_SEX pricing for sex OTHER (AC-VERIFY-8).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  insertGuest,
  insertPayment,
  insertRegistration,
  insertSession,
  insertTeam,
  insertUser,
  insertWallet,
} from '../helpers/factories.ts';
import {
  createTestDatabase,
  expectPgError,
  inTransaction,
  type TestDatabase,
} from '../helpers/test-db.ts';

let db: TestDatabase;
beforeAll(async () => {
  db = await createTestDatabase();
});
afterAll(async () => {
  await db.close();
});

async function registered(
  fees: Parameters<typeof insertSession>[2] = {},
  sex: 'MALE' | 'FEMALE' | 'OTHER' = 'MALE',
): Promise<{ teamId: string; sessionId: string; userId: string; registrationId: string }> {
  const teamId = await insertTeam(db.pool);
  const sessionId = await insertSession(db.pool, teamId, fees);
  const userId = await insertUser(db.pool, sex);
  const registrationId = await insertRegistration(db.pool, { sessionId, teamId, userId });
  return { teamId, sessionId, userId, registrationId };
}

describe('payment team routing (AC-VERIFY-8)', () => {
  it('requires payments.team_id (23502) and indexes (team_id, paid_at, status)', async () => {
    const { userId, registrationId } = await registered();
    await expectPgError(
      db.pool.query(
        `INSERT INTO payments (user_id, team_id, registration_id, pricing_structure, gst_registered, gst_rate_bps,
                               amount, payment_link_token, due_date)
         VALUES ($1, NULL, $2, 'FLAT', true, 1500, '17.00', 'link-no-team', now())`,
        [userId, registrationId],
      ),
      '23502',
    );
    const { rows } = await db.pool.query<{ indexdef: string }>(
      `SELECT indexdef FROM pg_indexes WHERE tablename = 'payments'`,
    );
    expect(rows.map((row) => row.indexdef)).toContainEqual(
      expect.stringMatching(/ON public\.payments USING btree \(team_id, paid_at, status\)/),
    );
  });
});

describe('fee snapshot (AC-VERIFY-8)', () => {
  it('stores generated GST, survives session fee changes and cannot be edited, re-billed or deleted', async () => {
    const { teamId, sessionId, userId, registrationId } = await registered();
    const paymentId = await insertPayment(db.pool, {
      userId,
      teamId,
      registrationId,
      amount: '17.00',
    });

    await db.pool.query(`UPDATE game_sessions SET fee_flat = '25.00' WHERE id = $1`, [sessionId]);
    const { rows } = await db.pool.query(
      `SELECT p.amount, p.gst_amount, p.subtotal_amount, p.pricing_structure, p.gst_registered, p.gst_rate_bps,
              li.applied_basis, li.unit_fee
         FROM payments p JOIN payment_line_items li ON li.payment_id = p.id WHERE p.id = $1`,
      [paymentId],
    );
    expect(rows).toEqual([
      {
        amount: '17.00',
        gst_amount: '2.22',
        subtotal_amount: '14.78',
        pricing_structure: 'FLAT',
        gst_registered: true,
        gst_rate_bps: 1500,
        applied_basis: 'FLAT',
        unit_fee: '17.00',
      },
    ]);

    for (const update of [
      `UPDATE payments SET amount = '25.00' WHERE id = $1`,
      `UPDATE payments SET gst_rate_bps = 0, gst_registered = false WHERE id = $1`,
      `UPDATE payments SET pricing_structure = 'BY_SEX' WHERE id = $1`,
    ]) {
      await expectPgError(db.pool.query(update, [paymentId]), '23000');
    }
    await expectPgError(
      db.pool.query(`UPDATE payment_line_items SET unit_fee = '1.00' WHERE payment_id = $1`, [
        paymentId,
      ]),
      '23000',
    );
    await expectPgError(
      db.pool.query(`DELETE FROM payment_line_items WHERE payment_id = $1`, [paymentId]),
      '23000',
    );
    // Lifecycle columns stay writable.
    await db.pool.query(`UPDATE payments SET status = 'PAID', paid_at = now() WHERE id = $1`, [
      paymentId,
    ]);

    await expectPgError(
      insertPayment(db.pool, { userId, teamId, registrationId, amount: '17.00' }),
      '23505',
      'uq_payments_registration',
    );
    // A line sum that disagrees with the header amount fails at COMMIT.
    const second = await registered();
    await expectPgError(
      insertPayment(db.pool, {
        userId: second.userId,
        teamId: second.teamId,
        registrationId: second.registrationId,
        amount: '17.00',
        lines: [{ position: 0, basis: 'FLAT', sex: 'MALE', skill: 'BEGINNER', unitFee: '16.00' }],
      }),
      '23514',
      'payment_lines_match_header',
    );
  });
});

describe('ownership chain (AC-VERIFY-8)', () => {
  it("rejects a payment whose user_id is not the registration's user (23503)", async () => {
    const { teamId, registrationId } = await registered();
    const stranger = await insertUser(db.pool);
    await expectPgError(
      insertPayment(db.pool, { userId: stranger, teamId, registrationId, amount: '17.00' }),
      '23503',
      'fk_payments_registration_owner',
    );
  });

  it("rejects a payment whose team_id is not the registration's (session's) team (23503)", async () => {
    const { userId, registrationId } = await registered();
    const otherTeam = await insertTeam(db.pool);
    await expectPgError(
      insertPayment(db.pool, { userId, teamId: otherTeam, registrationId, amount: '17.00' }),
      '23503',
      'fk_payments_registration_owner',
    );
  });

  it("rejects a credit transaction whose user or team differs from its registration's (23503)", async () => {
    const { teamId, userId, registrationId } = await registered();
    const stranger = await insertUser(db.pool);
    const otherTeam = await insertTeam(db.pool);
    await insertWallet(db.pool, userId, teamId, '50.00');
    await insertWallet(db.pool, stranger, teamId, '50.00');
    await insertWallet(db.pool, userId, otherTeam, '50.00');
    const insert = `INSERT INTO credit_transactions (user_id, team_id, amount, transaction_type, registration_id,
                                                     resulting_balance)
                    VALUES ($1, $2, '-17.00', 'AUTO_DEDUCTION', $3, '33.00')`;
    await expectPgError(
      db.pool.query(insert, [stranger, teamId, registrationId]),
      '23503',
      'fk_credit_tx_registration_owner',
    );
    await expectPgError(
      db.pool.query(insert, [userId, otherTeam, registrationId]),
      '23503',
      'fk_credit_tx_registration_owner',
    );
    await db.pool.query(insert, [userId, teamId, registrationId]);
  });
});

describe('BY_SEX pricing and sex OTHER (AC-VERIFY-8)', () => {
  const bySex = { pricing: 'BY_SEX', male: '17.00', female: '16.00', other: '16.00' } as const;

  it('rejects a BY_SEX session or recurring rule without fee_male, fee_female or fee_other (23514)', async () => {
    const teamId = await insertTeam(db.pool);
    for (const missing of ['male', 'female', 'other'] as const) {
      await expectPgError(
        insertSession(db.pool, teamId, { ...bySex, [missing]: null }, { withCourt: false }),
        '23514',
        'game_sessions_by_sex_fees_present',
      );
    }
    await expectPgError(
      db.pool.query(
        `INSERT INTO recurring_session_rules (team_id, day_of_week, starts_on, default_location, default_address,
                                              default_max_players, default_start_time, default_end_time,
                                              pricing_structure, fee_male, fee_female)
         VALUES ($1, 3, '2026-10-07', 'Test Hall', '1 Test Street', 12, '19:00', '21:00', 'BY_SEX', '17.00', '16.00')`,
        [teamId],
      ),
      '23514',
      'recurring_session_rules_by_sex_fees_present',
    );
  });

  it('bills an OTHER registrant at fee_other with basis SEX_OTHER', async () => {
    const { teamId, userId, registrationId } = await registered(
      { ...bySex, other: '15.50' },
      'OTHER',
    );
    const paymentId = await insertPayment(db.pool, {
      userId,
      teamId,
      registrationId,
      amount: '15.50',
      pricing: 'BY_SEX',
      lines: [
        { position: 0, basis: 'SEX_OTHER', sex: 'OTHER', skill: 'BEGINNER', unitFee: '15.50' },
      ],
    });
    const { rows } = await db.pool.query(
      `SELECT applied_basis, party_sex, unit_fee FROM payment_line_items WHERE payment_id = $1`,
      [paymentId],
    );
    expect(rows).toEqual([{ applied_basis: 'SEX_OTHER', party_sex: 'OTHER', unit_fee: '15.50' }]);
    // A basis that does not match the party's sex is rejected.
    const again = await registered({ ...bySex, other: '15.50' }, 'OTHER');
    await expectPgError(
      insertPayment(db.pool, {
        userId: again.userId,
        teamId: again.teamId,
        registrationId: again.registrationId,
        amount: '17.00',
        pricing: 'BY_SEX',
        lines: [
          { position: 0, basis: 'SEX_MALE', sex: 'OTHER', skill: 'BEGINNER', unitFee: '17.00' },
        ],
      }),
      '23514',
      'payment_line_items_basis_matches',
    );
  });

  it('bills an OTHER guest at fee_other alongside the registrant; the amount is the line sum', async () => {
    const teamId = await insertTeam(db.pool);
    const sessionId = await insertSession(db.pool, teamId, { ...bySex, other: '15.50' });
    const userId = await insertUser(db.pool, 'FEMALE');
    const { registrationId, guestId } = await inTransaction(db.pool, async (client) => {
      const id = await insertRegistration(client, { sessionId, teamId, userId, guestCount: 1 });
      return { registrationId: id, guestId: await insertGuest(client, id, 1, 'OTHER', 'BEGINNER') };
    });
    const paymentId = await insertPayment(db.pool, {
      userId,
      teamId,
      registrationId,
      amount: '31.50',
      pricing: 'BY_SEX',
      lines: [
        {
          position: 0,
          basis: 'SEX_FEMALE',
          sex: 'FEMALE',
          skill: 'INTERMEDIATE',
          unitFee: '16.00',
        },
        {
          position: 1,
          basis: 'SEX_OTHER',
          sex: 'OTHER',
          skill: 'BEGINNER',
          unitFee: '15.50',
          guestId,
        },
      ],
    });
    const { rows } = await db.pool.query(
      `SELECT li.party_position, li.applied_basis, li.unit_fee, p.amount, p.gst_amount
         FROM payment_line_items li JOIN payments p ON p.id = li.payment_id
        WHERE li.payment_id = $1 ORDER BY li.party_position`,
      [paymentId],
    );
    expect(rows).toEqual([
      {
        party_position: 0,
        applied_basis: 'SEX_FEMALE',
        unit_fee: '16.00',
        amount: '31.50',
        gst_amount: '4.11',
      },
      {
        party_position: 1,
        applied_basis: 'SEX_OTHER',
        unit_fee: '15.50',
        amount: '31.50',
        gst_amount: '4.11',
      },
    ]);
  });
});
