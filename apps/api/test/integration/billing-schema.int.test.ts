/**
 * wallet-and-akahu-billing, Phase 1 (database half): the P1 backstops of migration
 * `20261102000100000_wallet_and_billing.sql` (ledger D-87..D-98), driven from raw SQL (AC-VERIFY-2, AC-VERIFY-5 schema
 * half). Decision records: memory-bank/creative/wallet-and-akahu-billing-billing-architecture.md (Q2, Q4a, Q4f) and
 * -algorithm.md (state machines), overridden where the task file's Creative Reconciliation (CR-1..CR-27) says so.
 *
 *  - the `payments.status` guard (D-87) and the intent-status guard (CR-1), replayed from the hand-written fixtures;
 *  - the ledger (CR-5): chain check, ledger-only balance, append-only, no REFUND, one TOPUP per Akahu payment;
 *  - one blocking intent per payment and per wallet (partial uniques), stamps and sealed URL (CR-6);
 *  - `payments.gst_number` (D-88) and `payments.payment_reference` (CR-7);
 *  - `team_banking_in_use` widened (CR-10), checked against the removal trigger as well;
 *  - the small append-only and claim tables (CR-8, CR-9, D-96);
 *  - the one-step rollback / migrate round trip.
 */
import { randomBytes, randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  BLOCKING_INTENT_STATUSES,
  INTENT_TRANSITION_MATRIX,
  type IntentStatusName,
} from '../fixtures/intent-transitions.ts';
import {
  PAYMENT_INSERT_STATUS_MATRIX,
  PAYMENT_TRANSITION_MATRIX,
} from '../fixtures/payment-transitions.ts';
import {
  insertPayment,
  insertRegistration,
  insertSession,
  insertTeam,
  insertUser,
  insertWallet,
} from '../helpers/factories.ts';
import { catalogSnapshot } from '../helpers/schema-dump.ts';
import {
  createTestDatabase,
  expectPgError,
  pgError,
  type PgErrorInfo,
  type TestDatabase,
} from '../helpers/test-db.ts';

const API_ROOT = fileURLToPath(new URL('../../', import.meta.url));

let db: TestDatabase;
beforeAll(async () => {
  db = await createTestDatabase({ poolMax: 8 });
});
afterAll(async () => {
  await db.close();
});

// ---------------------------------------------------------------------------------------------
// Local fixtures (raw SQL on purpose: these tests pin the schema, not a factory)
// ---------------------------------------------------------------------------------------------

const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
function reference(): string {
  const bytes = randomBytes(8);
  return `SGM${Array.from(bytes, (b) => CROCKFORD[b % 32]).join('')}`;
}
/** A syntactically valid FieldCrypto envelope (the CHECK pins the shape; the crypto itself is tested elsewhere). */
const ENVELOPE = 'v1.dev1.AAAAAAAAAAAAAAAA.c2VhbGVk.AAAAAAAAAAAAAAAAAAAAAA';

type Kind = 'payment_attempts' | 'wallet_top_ups';
const KINDS: readonly Kind[] = ['payment_attempts', 'wallet_top_ups'];

async function freshPayment(): Promise<{ paymentId: string; teamId: string; userId: string }> {
  const teamId = await insertTeam(db.pool, { payoutConfigured: true });
  const userId = await insertUser(db.pool);
  const paymentId = await insertPayment(db.pool, {
    userId,
    teamId,
    registrationId: null,
    amount: '17.00',
  });
  return { paymentId, teamId, userId };
}

async function paymentIn(status: 'PENDING' | 'OVERDUE' | 'PAID'): Promise<string> {
  const { paymentId } = await freshPayment();
  if (status !== 'PENDING') await movePayment(paymentId, status);
  return paymentId;
}

function movePayment(paymentId: string, to: string): Promise<unknown> {
  return db.pool.query(
    `UPDATE payments SET status = $2::payment_status,
            paid_at = CASE WHEN $2::text = 'PAID' THEN now() END WHERE id = $1`,
    [paymentId, to],
  );
}

interface Owner {
  readonly paymentId?: string;
  readonly userId?: string;
  readonly teamId?: string;
}

async function freshOwner(kind: Kind): Promise<Owner> {
  if (kind === 'payment_attempts') return { paymentId: (await freshPayment()).paymentId };
  return {
    userId: await insertUser(db.pool),
    teamId: await insertTeam(db.pool, { payoutConfigured: true }),
  };
}

/** Column values of a valid intent row in `status`, including the stamps each status requires. */
function intentValues(
  kind: Kind,
  owner: Owner,
  status: IntentStatusName,
  withProviderId = true,
): Record<string, unknown> {
  const base: Record<string, unknown> =
    kind === 'payment_attempts'
      ? { payment_id: owner.paymentId, idempotency_key: randomUUID(), amount: '17.00' }
      : {
          user_id: owner.userId,
          team_id: owner.teamId,
          idempotency_key: randomUUID(),
          amount: '17.00',
          reference: reference(),
        };
  const provider = { akahu_payment_id: `pmt_${randomUUID()}` };
  switch (status) {
    case 'CREATING':
      return { ...base, status };
    case 'OPEN':
      return {
        ...base,
        status,
        ...provider,
        akahu_status: 'READY',
        authorisation_url_enc: ENVELOPE,
        expires_at: new Date(Date.now() + 1_800_000),
      };
    case 'HELD':
      return { ...base, status, ...provider, hold_reason: 'INDETERMINATE', held_at: new Date() };
    case 'APPLIED':
      return { ...base, status, ...provider };
    case 'UNAPPLIED':
      return { ...base, status, ...provider, unapplied_reason: 'DUPLICATE', closed_at: new Date() };
    case 'CLOSED':
      return {
        ...base,
        status,
        ...(withProviderId ? provider : {}),
        close_reason: 'test',
        closed_at: new Date(),
      };
  }
}

async function insertIntent(
  kind: Kind,
  owner: Owner,
  status: IntentStatusName,
  withProviderId = true,
): Promise<string> {
  const values = intentValues(kind, owner, status, withProviderId);
  const columns = Object.keys(values);
  const { rows } = await db.pool.query<{ id: string }>(
    `INSERT INTO ${kind} (${columns.join(', ')})
     VALUES (${columns.map((_, i) => `$${i + 1}`).join(', ')}) RETURNING id`,
    columns.map((column) => values[column]),
  );
  const id = rows[0]?.id;
  if (id === undefined) throw new Error('no intent id');
  return id;
}

/** The SET clause (and parameters after `$2`) that moves an intent to `to` while satisfying the stamp CHECKs. */
function moveClause(to: IntentStatusName, current: IntentStatusName): [string, unknown[]] {
  if (to === current) return ['last_synced_at = now()', []];
  switch (to) {
    case 'OPEN':
      return [
        `akahu_payment_id = coalesce(akahu_payment_id, $3), akahu_status = 'READY',
         authorisation_url_enc = $4, expires_at = now() + interval '30 minutes'`,
        [`pmt_${randomUUID()}`, ENVELOPE],
      ];
    case 'HELD':
      return [`hold_reason = 'INDETERMINATE', held_at = now()`, []];
    case 'UNAPPLIED':
      return [`unapplied_reason = 'DUPLICATE', closed_at = now()`, []];
    case 'CLOSED':
      return [`close_reason = 'test', closed_at = now()`, []];
    default:
      return ['last_synced_at = now()', []];
  }
}

async function moveIntent(
  kind: Kind,
  id: string,
  from: IntentStatusName,
  to: IntentStatusName,
): Promise<PgErrorInfo | undefined> {
  const [clause, extra] = moveClause(to, from);
  // Parameters are positional: $1 id, $2 status, $3.. extras.
  const text = `UPDATE ${kind} SET status = $2::payment_intent_status, ${clause} WHERE id = $1`;
  // `pgError` rejects when the statement succeeds, which here means "the move was accepted".
  return pgError(db.pool.query(text, [id, to, ...extra])).catch(() => undefined);
}

async function balanceOf(userId: string, teamId: string): Promise<string | undefined> {
  const { rows } = await db.pool.query<{ balance: string }>(
    `SELECT balance FROM player_credits WHERE user_id = $1 AND team_id = $2`,
    [userId, teamId],
  );
  return rows[0]?.balance;
}

async function appliedTopUp(userId: string, teamId: string, amount = '10.00'): Promise<string> {
  const { rows } = await db.pool.query<{ id: string }>(
    `INSERT INTO wallet_top_ups (user_id, team_id, amount, idempotency_key, reference, status, akahu_payment_id)
     VALUES ($1, $2, $3, $4, $5, 'APPLIED', $6) RETURNING id`,
    [userId, teamId, amount, randomUUID(), reference(), `pmt_${randomUUID()}`],
  );
  return rows[0]?.id ?? '';
}

// ---------------------------------------------------------------------------------------------
// D-87: payments.status guard
// ---------------------------------------------------------------------------------------------

describe('payments status guard (AC-VERIFY-2, D-87, B4)', () => {
  it('payment_status_transition_allowed equals the shared fixture for all 16 ordered pairs', async () => {
    const mismatches: string[] = [];
    for (const row of PAYMENT_TRANSITION_MATRIX) {
      const { rows } = await db.pool.query<{ ok: boolean }>(
        `SELECT payment_status_transition_allowed($1::payment_status, $2::payment_status) AS ok`,
        [row.from, row.to],
      );
      if (rows[0]?.ok !== row.allowed) mismatches.push(`${row.from}>${row.to}`);
    }
    expect(mismatches).toEqual([]);
  });

  it('refuses every illegal move on a real row with 23000 payments_status_transition and accepts the legal ones', async () => {
    const mismatches: string[] = [];
    for (const row of PAYMENT_TRANSITION_MATRIX) {
      if (row.from === 'FAILED') continue; // unreachable: nothing enters FAILED, so no row can start there
      const paymentId = await paymentIn(row.from);
      const outcome = await pgError(movePayment(paymentId, row.to)).catch(() => undefined);
      if (row.allowed) {
        if (outcome !== undefined)
          mismatches.push(`${row.from}>${row.to} refused: ${outcome.message}`);
      } else if (outcome?.code !== '23000' || outcome.constraint !== 'payments_status_transition') {
        mismatches.push(`${row.from}>${row.to} not refused as a transition (${outcome?.code})`);
      }
    }
    expect(mismatches).toEqual([]);
  });

  it('keeps PAID terminal (the row and its paid_at survive) and refuses to insert FAILED', async () => {
    const paymentId = await paymentIn('PAID');
    await expectPgError(
      db.pool.query(`UPDATE payments SET status = 'PENDING', paid_at = NULL WHERE id = $1`, [
        paymentId,
      ]),
      '23000',
      'payments_status_transition',
    );
    const { rows } = await db.pool.query<{ status: string; paid_at: Date | null }>(
      `SELECT status, paid_at FROM payments WHERE id = $1`,
      [paymentId],
    );
    expect(rows[0]).toMatchObject({ status: 'PAID' });
    expect(rows[0]?.paid_at).toBeInstanceOf(Date);

    for (const { status, allowed } of PAYMENT_INSERT_STATUS_MATRIX) {
      const teamId = await insertTeam(db.pool);
      const userId = await insertUser(db.pool);
      const insert = db.pool.query(
        `INSERT INTO payments (user_id, team_id, registration_id, pricing_structure, gst_registered, gst_rate_bps,
                               amount, payment_reference, due_date, status, paid_at)
         VALUES ($1, $2, NULL, 'FLAT', false, 0, '17.00', $3, now(), $4::payment_status,
                 CASE WHEN $4::text = 'PAID' THEN now() END)`,
        [userId, teamId, reference(), status],
      );
      if (allowed) await insert;
      else await expectPgError(insert, '23000', 'payments_status_transition');
    }
  });

  it('lets a PENDING payment keep its price snapshot while due_date is raised (CR-27 grace), and nothing else moves', async () => {
    const paymentId = await paymentIn('PENDING');
    await db.pool.query(
      `UPDATE payments SET due_date = due_date + interval '24 hours' WHERE id = $1`,
      [paymentId],
    );
    await expectPgError(
      db.pool.query(`UPDATE payments SET amount = '99.00' WHERE id = $1`, [paymentId]),
      '23000',
    );
  });
});

// ---------------------------------------------------------------------------------------------
// D-88 and CR-7: gst_number, payment_reference
// ---------------------------------------------------------------------------------------------

describe('payments.gst_number and payment_reference (D-88, CR-7, AC-VERIFY-5 schema half)', () => {
  async function rawPayment(overrides: {
    gstRegistered: boolean;
    gstNumber: string | null;
    reference?: string;
  }): Promise<unknown> {
    const teamId = await insertTeam(db.pool);
    const userId = await insertUser(db.pool);
    return db.pool.query(
      `INSERT INTO payments (user_id, team_id, registration_id, pricing_structure, gst_registered, gst_rate_bps,
                             amount, payment_reference, gst_number, due_date)
       VALUES ($1, $2, NULL, 'FLAT', $3, $4, '17.00', $5, $6, now()) RETURNING id`,
      [
        userId,
        teamId,
        overrides.gstRegistered,
        overrides.gstRegistered ? 1500 : 0,
        overrides.reference ?? reference(),
        overrides.gstNumber,
      ],
    );
  }

  it('ties gst_number to gst_registered and to the 8-9 digit format (23514 payments_gst_number_iff_registered)', async () => {
    for (const [gstRegistered, gstNumber] of [
      [true, null],
      [false, '123456789'],
      [true, '12'],
      [true, '012345678'],
      [true, '12345678A'],
    ] as const) {
      await expectPgError(
        rawPayment({ gstRegistered, gstNumber }),
        '23514',
        'payments_gst_number_iff_registered',
      );
    }
    await rawPayment({ gstRegistered: true, gstNumber: '123456789' });
    await rawPayment({ gstRegistered: true, gstNumber: '12345678' });
    await rawPayment({ gstRegistered: false, gstNumber: null });
  });

  it('freezes gst_number with the rest of the snapshot, so a later team change alters no payment', async () => {
    const teamId = await insertTeam(db.pool, { gstRegistered: true, gstNumber: '123456789' });
    const userId = await insertUser(db.pool);
    const paymentId = await insertPayment(db.pool, {
      userId,
      teamId,
      registrationId: null,
      amount: '17.00',
      gstRegistered: true,
      gstNumber: '123456789',
    });
    await expectPgError(
      db.pool.query(`UPDATE payments SET gst_number = '987654321' WHERE id = $1`, [paymentId]),
      '23000',
    );
    await db.pool.query(
      `UPDATE teams SET gst_registered = false, gst_number = NULL WHERE id = $1`,
      [teamId],
    );
    const { rows } = await db.pool.query(
      `SELECT gst_registered, gst_rate_bps, gst_number FROM payments WHERE id = $1`,
      [paymentId],
    );
    expect(rows[0]).toEqual({ gst_registered: true, gst_rate_bps: 1500, gst_number: '123456789' });
  });

  it('renames payment_link_token to payment_reference: SGM + 8 Crockford characters, unique and immutable', async () => {
    const { rows: columns } = await db.pool.query<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns
        WHERE table_name = 'payments' AND column_name IN ('payment_link_token', 'payment_reference')`,
    );
    expect(columns.map((c) => c.column_name)).toEqual(['payment_reference']);

    for (const bad of ['sgm7k2qh4x9', 'SGM7K2QH4XI', 'SGM7K2QH4', 'XYZ7K2QH4X9', 'SGM7K2QH4X9Z']) {
      await expectPgError(
        rawPayment({ gstRegistered: false, gstNumber: null, reference: bad }),
        '23514',
        'payments_payment_reference_format',
      );
    }
    const taken = reference();
    await rawPayment({ gstRegistered: false, gstNumber: null, reference: taken });
    await expectPgError(
      rawPayment({ gstRegistered: false, gstNumber: null, reference: taken }),
      '23505',
      'payments_payment_reference_key',
    );
    const paymentId = await paymentIn('PENDING');
    await expectPgError(
      db.pool.query(`UPDATE payments SET payment_reference = $2 WHERE id = $1`, [
        paymentId,
        reference(),
      ]),
      '23000',
    );
  });
});

// ---------------------------------------------------------------------------------------------
// CR-5: the ledger
// ---------------------------------------------------------------------------------------------

describe('wallet ledger (AC-VERIFY-2, CR-5)', () => {
  const CREDIT = `INSERT INTO credit_transactions (user_id, team_id, amount, transaction_type, akahu_payment_id,
                                                     wallet_top_up_id, registration_id, resulting_balance)
                  VALUES ($1, $2, $3, $4::credit_transaction_type, $5, $6, $7, $8)`;

  async function wallet(balance = '10.00'): Promise<{ userId: string; teamId: string }> {
    const userId = await insertUser(db.pool);
    const teamId = await insertTeam(db.pool);
    await insertWallet(db.pool, userId, teamId, balance);
    return { userId, teamId };
  }

  it('moves a funded test wallet through the ledger: one TOPUP row whose resulting balance is the wallet balance', async () => {
    const { userId, teamId } = await wallet('10.00');
    const { rows } = await db.pool.query(
      `SELECT transaction_type, amount, resulting_balance, wallet_top_up_id IS NOT NULL AS has_intent
         FROM credit_transactions WHERE user_id = $1 AND team_id = $2`,
      [userId, teamId],
    );
    expect(rows).toEqual([
      { transaction_type: 'TOPUP', amount: '10.00', resulting_balance: '10.00', has_intent: true },
    ]);
    expect(await balanceOf(userId, teamId)).toBe('10.00');
  });

  it('refuses a resulting_balance that is not the previous balance plus the amount (23514 credit_transactions_balance_chain)', async () => {
    const { userId, teamId } = await wallet('10.00');
    const intent = await appliedTopUp(userId, teamId, '5.00');
    await expectPgError(
      db.pool.query(CREDIT, [
        userId,
        teamId,
        '5.00',
        'TOPUP',
        `pmt_${randomUUID()}`,
        intent,
        null,
        '20.00',
      ]),
      '23514',
      'credit_transactions_balance_chain',
    );
    expect(await balanceOf(userId, teamId)).toBe('10.00');
    // The right arithmetic is accepted and moves the balance, from the trigger.
    await db.pool.query(CREDIT, [
      userId,
      teamId,
      '5.00',
      'TOPUP',
      `pmt_${randomUUID()}`,
      intent,
      null,
      '15.00',
    ]);
    expect(await balanceOf(userId, teamId)).toBe('15.00');
  });

  it('refuses a direct balance write, a non-zero wallet insert and a wallet delete (23000 player_credits_balance_ledger_only)', async () => {
    const { userId, teamId } = await wallet('10.00');
    await expectPgError(
      db.pool.query(
        `UPDATE player_credits SET balance = '50.00' WHERE user_id = $1 AND team_id = $2`,
        [userId, teamId],
      ),
      '23000',
      'player_credits_balance_ledger_only',
    );
    await expectPgError(
      db.pool.query(
        `INSERT INTO player_credits (user_id, team_id, balance) VALUES ($1, $2, '5.00')`,
        [await insertUser(db.pool), teamId],
      ),
      '23000',
      'player_credits_balance_ledger_only',
    );
    await expectPgError(
      db.pool.query(`DELETE FROM player_credits WHERE user_id = $1 AND team_id = $2`, [
        userId,
        teamId,
      ]),
      '23000',
    );
    await expectPgError(
      db.pool.query(`UPDATE player_credits SET user_id = $3 WHERE user_id = $1 AND team_id = $2`, [
        userId,
        teamId,
        await insertUser(db.pool),
      ]),
      '23000',
    );
    expect(await balanceOf(userId, teamId)).toBe('10.00');
  });

  it('allows one TOPUP per Akahu payment and per intent (23505), and never a REFUND in v1 (23514)', async () => {
    const { userId, teamId } = await wallet('10.00');
    const intentA = await appliedTopUp(userId, teamId, '5.00');
    const intentB = await appliedTopUp(userId, teamId, '5.00');
    const akahuId = `pmt_${randomUUID()}`;
    await db.pool.query(CREDIT, [userId, teamId, '5.00', 'TOPUP', akahuId, intentA, null, '15.00']);
    await expectPgError(
      db.pool.query(CREDIT, [userId, teamId, '5.00', 'TOPUP', akahuId, intentB, null, '20.00']),
      '23505',
      'uq_credit_tx_topup_akahu_payment',
    );
    await expectPgError(
      db.pool.query(CREDIT, [
        userId,
        teamId,
        '5.00',
        'TOPUP',
        `pmt_${randomUUID()}`,
        intentA,
        null,
        '20.00',
      ]),
      '23505',
      'uq_credit_tx_topup_intent',
    );
    await expectPgError(
      db.pool.query(CREDIT, [userId, teamId, '-1.00', 'REFUND', null, null, null, '14.00']),
      '23514',
      'credit_transactions_no_refund',
    );
    expect(await balanceOf(userId, teamId)).toBe('15.00');
  });

  it('accepts an AUTO_DEDUCTION tied to its registration, refuses wrong type shapes, and keeps the cap and floor', async () => {
    const teamId = await insertTeam(db.pool);
    const sessionId = await insertSession(db.pool, teamId);
    const userId = await insertUser(db.pool);
    const registrationId = await insertRegistration(db.pool, { sessionId, teamId, userId });
    await insertWallet(db.pool, userId, teamId, '10.00');

    await expectPgError(
      db.pool.query(CREDIT, [userId, teamId, '-3.00', 'AUTO_DEDUCTION', null, null, null, '7.00']),
      '23514',
      'credit_transactions_type_shape',
    );
    await expectPgError(
      db.pool.query(CREDIT, [
        userId,
        teamId,
        '3.00',
        'TOPUP',
        `pmt_${randomUUID()}`,
        null,
        null,
        '13.00',
      ]),
      '23514',
      'credit_transactions_type_shape',
    );
    await expectPgError(
      db.pool.query(CREDIT, [
        userId,
        teamId,
        '-20.00',
        'AUTO_DEDUCTION',
        null,
        null,
        registrationId,
        '-10.00',
      ]),
      '23514',
    );
    await db.pool.query(CREDIT, [
      userId,
      teamId,
      '-3.00',
      'AUTO_DEDUCTION',
      null,
      null,
      registrationId,
      '7.00',
    ]);
    expect(await balanceOf(userId, teamId)).toBe('7.00');
    await expectPgError(
      db.pool.query(CREDIT, [
        userId,
        teamId,
        '-3.00',
        'AUTO_DEDUCTION',
        null,
        null,
        registrationId,
        '4.00',
      ]),
      '23505',
      'uq_credit_tx_auto_deduction_per_registration',
    );
  });

  it('keeps credit_transactions append-only (23000 on UPDATE and DELETE)', async () => {
    const { userId, teamId } = await wallet('10.00');
    await expectPgError(
      db.pool.query(
        `UPDATE credit_transactions SET resulting_balance = '11.00' WHERE user_id = $1`,
        [userId],
      ),
      '23000',
    );
    await expectPgError(
      db.pool.query(`DELETE FROM credit_transactions WHERE user_id = $1 AND team_id = $2`, [
        userId,
        teamId,
      ]),
      '23000',
    );
  });
});

// ---------------------------------------------------------------------------------------------
// CR-1, CR-2, CR-6, CR-26: intents
// ---------------------------------------------------------------------------------------------

describe.each(KINDS)('%s intents (CR-1, CR-6, CR-26)', (kind) => {
  it('payment_intent_transition_allowed equals the shared fixture for all 36 pairs, with and without a provider id', async () => {
    const mismatches: string[] = [];
    for (const row of INTENT_TRANSITION_MATRIX) {
      for (const hasProviderId of [true, false]) {
        const expected = row.allowed && (row.needsProviderId !== true || hasProviderId);
        const { rows } = await db.pool.query<{ ok: boolean }>(
          `SELECT payment_intent_transition_allowed($1::payment_intent_status, $2::payment_intent_status, $3) AS ok`,
          [row.from, row.to, hasProviderId],
        );
        if (rows[0]?.ok !== expected) mismatches.push(`${row.from}>${row.to} id=${hasProviderId}`);
      }
    }
    expect(mismatches).toEqual([]);
  });

  it('applies the matrix to real rows: legal moves commit, illegal ones are 23000 <table>_status_transition', async () => {
    const mismatches: string[] = [];
    for (const row of INTENT_TRANSITION_MATRIX) {
      const variants = row.needsProviderId === true ? [true, false] : [true];
      for (const withProviderId of variants) {
        const owner = await freshOwner(kind);
        const id = await insertIntent(kind, owner, row.from, withProviderId);
        const outcome = await moveIntent(kind, id, row.from, row.to);
        const shouldPass = row.allowed && (row.needsProviderId !== true || withProviderId);
        if (shouldPass) {
          if (outcome !== undefined)
            mismatches.push(`${row.from}>${row.to} refused: ${outcome.message}`);
        } else if (
          outcome?.code !== '23000' ||
          outcome.constraint !== `${kind}_status_transition`
        ) {
          mismatches.push(
            `${row.from}>${row.to} id=${withProviderId} not refused (${outcome?.code})`,
          );
        }
      }
    }
    expect(mismatches).toEqual([]);
  });

  it('allows one blocking intent (CREATING, OPEN, HELD) per owner and any number of finished ones', async () => {
    const mismatches: string[] = [];
    for (const status of ['CREATING', 'OPEN', 'HELD', 'APPLIED', 'UNAPPLIED', 'CLOSED'] as const) {
      const owner = await freshOwner(kind);
      await insertIntent(kind, owner, status);
      const blocked = await pgError(insertIntent(kind, owner, 'CREATING')).catch(() => undefined);
      const shouldBlock = BLOCKING_INTENT_STATUSES.includes(status);
      if (
        shouldBlock &&
        (blocked?.code !== '23505' || blocked.constraint !== `uq_${kind}_one_blocking`)
      ) {
        mismatches.push(`${status} should block (${blocked?.code})`);
      }
      if (!shouldBlock && blocked !== undefined) mismatches.push(`${status} should not block`);
    }
    expect(mismatches).toEqual([]);

    // A different owner is unaffected, and an idempotency key is unique per owner (replay by key).
    const first = await freshOwner(kind);
    const second = await freshOwner(kind);
    await insertIntent(kind, first, 'OPEN');
    await insertIntent(kind, second, 'OPEN');
    const key = randomUUID();
    const owner = await freshOwner(kind);
    const values = intentValues(kind, owner, 'CLOSED');
    const columns = Object.keys(values);
    const fresh: Record<string, () => unknown> = {
      idempotency_key: () => key,
      akahu_payment_id: () => `pmt_${randomUUID()}`,
      reference,
    };
    const insertWithKey = (): Promise<unknown> =>
      db.pool.query(
        `INSERT INTO ${kind} (${columns.join(', ')}) VALUES (${columns.map((_, i) => `$${i + 1}`).join(', ')})`,
        columns.map((c) => fresh[c]?.() ?? values[c]),
      );
    await insertWithKey();
    await expectPgError(
      insertWithKey(),
      '23505',
      kind === 'payment_attempts'
        ? 'uq_payment_attempts_payment_key'
        : 'uq_wallet_top_ups_owner_key',
    );
  });

  it('seals the authorisation URL, ties stamps to statuses, sets the provider id once and freezes amount and owner', async () => {
    const owner = await freshOwner(kind);
    const open = intentValues(kind, owner, 'OPEN');
    const insertRaw = (values: Record<string, unknown>): Promise<unknown> => {
      const columns = Object.keys(values);
      return db.pool.query(
        `INSERT INTO ${kind} (${columns.join(', ')}) VALUES (${columns.map((_, i) => `$${i + 1}`).join(', ')})`,
        columns.map((c) => values[c]),
      );
    };
    // A plaintext URL is refused: only a FieldCrypto envelope is stored (P4, CR-6).
    await expectPgError(
      insertRaw({ ...open, authorisation_url_enc: 'https://my.akahu.test/pay/abc' }),
      '23514',
      `${kind}_authorisation_url_envelope`,
    );
    // OPEN needs the URL and expiry; past CREATING a provider id is required; UNAPPLIED names its reason; HELD its hold.
    await expectPgError(insertRaw({ ...open, expires_at: null }), '23514');
    await expectPgError(
      insertRaw({ ...open, akahu_payment_id: null }),
      '23514',
      `${kind}_provider_id_stamp`,
    );
    await expectPgError(
      insertRaw({ ...intentValues(kind, owner, 'UNAPPLIED'), unapplied_reason: null }),
      '23514',
      `${kind}_unapplied_stamp`,
    );
    // a terminal UNAPPLIED intent needs its close time (the wallet read model serialises it)
    await expectPgError(
      insertRaw({ ...intentValues(kind, owner, 'UNAPPLIED'), closed_at: null }),
      '23514',
      `${kind}_closed_stamp`,
    );
    await expectPgError(
      insertRaw({ ...intentValues(kind, owner, 'HELD'), hold_reason: null }),
      '23514',
      `${kind}_hold_stamp`,
    );
    await expectPgError(
      insertRaw({ ...intentValues(kind, owner, 'CLOSED'), close_reason: null }),
      '23514',
      `${kind}_closed_stamp`,
    );

    const id = await insertIntent(kind, owner, 'OPEN');
    await expectPgError(
      db.pool.query(`UPDATE ${kind} SET akahu_payment_id = $2 WHERE id = $1`, [
        id,
        `pmt_${randomUUID()}`,
      ]),
      '23000',
    );
    await expectPgError(
      db.pool.query(`UPDATE ${kind} SET amount = '5.00' WHERE id = $1`, [id]),
      '23000',
    );
    await expectPgError(
      db.pool.query(`UPDATE ${kind} SET idempotency_key = $2 WHERE id = $1`, [id, randomUUID()]),
      '23000',
    );
  });
});

describe('wallet_top_ups specifics (B1, D-92)', () => {
  it('limits the amount to $1.00-$100.00 and gives every top-up a unique SGM reference', async () => {
    const owner = await freshOwner('wallet_top_ups');
    for (const amount of ['0.99', '100.01', '0.00']) {
      await expectPgError(
        db.pool.query(
          `INSERT INTO wallet_top_ups (user_id, team_id, amount, idempotency_key, reference)
           VALUES ($1, $2, $3, $4, $5)`,
          [owner.userId, owner.teamId, amount, randomUUID(), reference()],
        ),
        '23514',
      );
    }
    await expectPgError(
      db.pool.query(
        `INSERT INTO wallet_top_ups (user_id, team_id, amount, idempotency_key, reference)
         VALUES ($1, $2, '10.00', $3, 'sgm7k2qh4x9')`,
        [owner.userId, owner.teamId, randomUUID()],
      ),
      '23514',
      'wallet_top_ups_reference_format',
    );
  });
});

// ---------------------------------------------------------------------------------------------
// CR-10: team_banking_in_use
// ---------------------------------------------------------------------------------------------

describe('team_banking_in_use is widened to blocking intents (CR-10, AC-VERIFY-11)', () => {
  async function inUse(teamId: string): Promise<boolean> {
    const { rows } = await db.pool.query<{ in_use: boolean }>(
      `SELECT team_banking_in_use($1) AS in_use`,
      [teamId],
    );
    return rows[0]?.in_use ?? false;
  }

  it('is true exactly while a top-up or payment attempt of the team is CREATING, OPEN or HELD', async () => {
    const mismatches: string[] = [];
    for (const kind of KINDS) {
      for (const status of [
        'CREATING',
        'OPEN',
        'HELD',
        'APPLIED',
        'UNAPPLIED',
        'CLOSED',
      ] as const) {
        let teamId: string;
        let owner: Owner;
        if (kind === 'payment_attempts') {
          // A PAID payment, so the existing "unsettled payment" clause cannot be what answers.
          const payment = await freshPayment();
          await movePayment(payment.paymentId, 'PAID');
          teamId = payment.teamId;
          owner = { paymentId: payment.paymentId };
        } else {
          owner = await freshOwner(kind);
          teamId = owner.teamId ?? '';
        }
        expect(await inUse(teamId), `${kind} baseline`).toBe(false);
        await insertIntent(kind, owner, status);
        if ((await inUse(teamId)) !== BLOCKING_INTENT_STATUSES.includes(status)) {
          mismatches.push(`${kind} ${status}`);
        }
      }
    }
    expect(mismatches).toEqual([]);
  });

  it('feeds the removal trigger too: raw-SQL removal is refused 23514 teams_banking_in_use while a top-up is open', async () => {
    const owner = await freshOwner('wallet_top_ups');
    await insertIntent('wallet_top_ups', owner, 'OPEN');
    await expectPgError(
      db.pool.query(
        `UPDATE teams SET bank_account_name = NULL, bank_account_number = NULL, bank_account_last4 = NULL
          WHERE id = $1`,
        [owner.teamId],
      ),
      '23514',
      'teams_banking_in_use',
    );
  });
});

// ---------------------------------------------------------------------------------------------
// CR-8, CR-9, D-96: small tables
// ---------------------------------------------------------------------------------------------

describe('reminders, payout-block events and billing blocks (CR-8, CR-9, D-96)', () => {
  it('payment_reminders is append-only with one change_key per payment, and payments carry no reminder columns', async () => {
    const { paymentId, userId } = await freshPayment();
    const key = randomUUID();
    const insert = (changeKey: string): Promise<unknown> =>
      db.pool.query(
        `INSERT INTO payment_reminders (payment_id, actor_user_id, change_key) VALUES ($1, $2, $3)`,
        [paymentId, userId, changeKey],
      );
    await insert(key);
    await expectPgError(insert(key), '23505');
    await insert(randomUUID());
    await expectPgError(
      db.pool.query(`UPDATE payment_reminders SET created_at = now() WHERE payment_id = $1`, [
        paymentId,
      ]),
      '23000',
    );
    await expectPgError(
      db.pool.query(`DELETE FROM payment_reminders WHERE payment_id = $1`, [paymentId]),
      '23000',
    );
    const { rows } = await db.pool.query(
      `SELECT column_name FROM information_schema.columns
        WHERE table_name = 'payments' AND column_name IN ('last_reminder_at', 'reminder_count')`,
    );
    expect(rows).toEqual([]);
  });

  it('payout_block_events takes an enum reason and no free text, once per (team, change_key), append-only', async () => {
    const teamId = await insertTeam(db.pool);
    const actor = await insertUser(db.pool);
    const key = randomUUID();
    const insert = (reason: string, changeKey: string): Promise<unknown> =>
      db.pool.query(
        `INSERT INTO payout_block_events (team_id, actor_user_id, reason, change_key)
         VALUES ($1, $2, $3::payout_block_reason, $4)`,
        [teamId, actor, reason, changeKey],
      );
    await insert('TEAM_REQUESTED', key);
    await expectPgError(insert('OTHER', key), '23505');
    // evidence is an Akahu payment id, never free text such as bank digits or a note
    await expectPgError(
      db.pool.query(
        `INSERT INTO payout_block_events (team_id, actor_user_id, reason, akahu_payment_id, change_key)
         VALUES ($1, $2, 'OTHER', '12 3456 7890123 00', $3)`,
        [teamId, actor, randomUUID()],
      ),
      '23514',
      'payout_block_events_akahu_payment_id_format',
    );
    await expectPgError(insert('because I said so', randomUUID()), '22P02');
    await expectPgError(
      db.pool.query(`UPDATE payout_block_events SET reason = 'OTHER' WHERE team_id = $1`, [teamId]),
      '23000',
    );
    const { rows } = await db.pool.query<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns WHERE table_name = 'payout_block_events'`,
    );
    expect(rows.map((r) => r.column_name)).not.toEqual(expect.arrayContaining(['note', 'comment']));
  });

  it('billing_session_blocks holds one claim per session and is the only place B8 writes', async () => {
    const teamId = await insertTeam(db.pool);
    const sessionId = await insertSession(db.pool, teamId);
    await db.pool.query(
      `INSERT INTO billing_session_blocks (session_id, team_id) VALUES ($1, $2)`,
      [sessionId, teamId],
    );
    await expectPgError(
      db.pool.query(`INSERT INTO billing_session_blocks (session_id, team_id) VALUES ($1, $2)`, [
        sessionId,
        teamId,
      ]),
      '23505',
    );
    // the block's team must be the session's own team
    const otherTeam = await insertTeam(db.pool);
    const otherSession = await insertSession(db.pool, teamId);
    await expectPgError(
      db.pool.query(`INSERT INTO billing_session_blocks (session_id, team_id) VALUES ($1, $2)`, [
        otherSession,
        otherTeam,
      ]),
      '23503',
    );
    await db.pool.query(
      `UPDATE billing_session_blocks SET notified_at = now() WHERE session_id = $1`,
      [sessionId],
    );
    const { rows } = await db.pool.query<{ notified_at: Date | null }>(
      `SELECT notified_at FROM billing_session_blocks WHERE session_id = $1`,
      [sessionId],
    );
    expect(rows[0]?.notified_at).toBeInstanceOf(Date);
  });
});

// ---------------------------------------------------------------------------------------------
// AC-VERIFY-2: reversibility
// ---------------------------------------------------------------------------------------------

describe('migration round trip (AC-VERIFY-2)', () => {
  function runCli(
    databaseUrl: string,
    ...args: string[]
  ): { status: number | null; output: string } {
    const result = spawnSync(process.execPath, ['--import', 'tsx', 'src/cli.ts', ...args], {
      cwd: API_ROOT,
      env: { ...process.env, DATABASE_URL: databaseUrl, LOG_LEVEL: 'silent' },
      encoding: 'utf8',
      timeout: 90_000,
    });
    return { status: result.status, output: `${result.stdout}\n${result.stderr}` };
  }

  it('db:rollback removes every billing object and restores the old function and column, and db:migrate gives an identical schema', async () => {
    const empty = await createTestDatabase({ empty: true });
    try {
      expect(runCli(empty.url, 'db', 'migrate')).toMatchObject({ status: 0 });
      const after = await catalogSnapshot(empty.pool);
      for (const table of [
        'payment_attempts',
        'wallet_top_ups',
        'payment_reminders',
        'payout_block_events',
        'billing_session_blocks',
      ]) {
        expect(
          after.some((line) => line.startsWith(`column ${table}.`)),
          table,
        ).toBe(true);
      }

      const rolledBack = runCli(empty.url, 'db', 'rollback');
      expect(rolledBack, rolledBack.output).toMatchObject({ status: 0 });
      const before = await catalogSnapshot(empty.pool);
      expect(
        before.filter((line) =>
          /payment_attempts|wallet_top_ups|payment_reminders|payout_block_events|billing_session_blocks|payment_intent_status|payout_block_reason|payment_hold_reason/.test(
            line,
          ),
        ),
      ).toEqual([]);
      expect(before.some((line) => line.startsWith('column payments.payment_link_token'))).toBe(
        true,
      );
      expect(before.some((line) => line.startsWith('column payments.gst_number'))).toBe(false);
      expect(
        before.some((line) => line.startsWith('column credit_transactions.wallet_top_up_id')),
      ).toBe(false);
      const fn = before.find(
        (line) =>
          line.startsWith('function') && line.includes('FUNCTION public.team_banking_in_use('),
      );
      expect(fn).toBeDefined();
      expect(fn).not.toMatch(/wallet_top_ups|payment_attempts/);

      expect(runCli(empty.url, 'db', 'migrate')).toMatchObject({ status: 0 });
      expect(await catalogSnapshot(empty.pool)).toEqual(after);
    } finally {
      await empty.close();
    }
  }, 120_000);
});
