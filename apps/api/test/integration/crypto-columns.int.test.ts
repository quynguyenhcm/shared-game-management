/**
 * Encrypted team columns (architecture Q5): the database only ever holds the AES-256-GCM envelope,
 * AAD binds each ciphertext to its table/column/row, and the DDL CHECKs reject plaintext writes.
 */
import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  DecryptionError,
  createCrypto,
  type EncryptionContext,
} from '../../src/lib/crypto/crypto.ts';
import { createKeyProvider } from '../../src/lib/crypto/keyring.ts';
import { buildAuthTestApp } from '../helpers/auth-app.ts';
import { ACCOUNT_A, createBankingScene } from '../helpers/banking-scene.ts';
import { insertTeam } from '../helpers/factories.ts';
import { createTestDatabase, expectPgError, type TestDatabase } from '../helpers/test-db.ts';

const ACCOUNT = '12-3456-7890123-00';
// Hand-built: last 4 digits of the 7-digit account base (7890123), as the validators will derive it.
const LAST4 = '0123';
const ACCOUNT_NAME = 'Court Jesters Badminton Club';
// akahu_app_token keeps its envelope CHECK (R1: this feature never writes it, so only plaintext rejection is tested).
const ENCRYPTED_COLUMNS = [
  'bank_account_number',
  'akahu_app_token',
  'bank_account_name',
  'ird_number',
] as const;

const crypto = createCrypto(createKeyProvider([{ id: 'test1', key: randomBytes(32) }], 'test1'));
const ctxFor = (rowId: string, column: string): EncryptionContext => ({
  table: 'teams',
  column,
  rowId,
});

let db: TestDatabase;
beforeAll(async () => {
  db = await createTestDatabase();
});
afterAll(async () => {
  await db.close();
});

/** The payout block is all-or-none (teams_payout_details_all_or_none): name, number and last4 together. */
async function writeBanking(teamId: string): Promise<void> {
  await db.pool.query(
    `UPDATE teams SET bank_account_name = $2, bank_account_number = $3, bank_account_last4 = $4
     WHERE id = $1`,
    [
      teamId,
      crypto.encrypt(ACCOUNT_NAME, ctxFor(teamId, 'bank_account_name')),
      crypto.encrypt(ACCOUNT, ctxFor(teamId, 'bank_account_number')),
      LAST4,
    ],
  );
}

describe('teams encrypted columns', () => {
  it('stores no plaintext, hex or base64 of the secrets, keeps last4 readable, and decrypts exactly', async () => {
    const teamId = await insertTeam(db.pool);
    await writeBanking(teamId);
    const { rows } = await db.pool.query<{
      bank_account_name: string;
      bank_account_number: string;
      bank_account_last4: string;
      whole_row: string;
    }>(
      `SELECT bank_account_name, bank_account_number, bank_account_last4, t::text AS whole_row
       FROM teams t WHERE id = $1`,
      [teamId],
    );
    const row = rows[0];
    if (row === undefined) throw new Error('team row missing');
    const raw = `${row.bank_account_name}\n${row.bank_account_number}\n${row.whole_row}`;
    for (const secret of [ACCOUNT, ACCOUNT_NAME, '1234567890123', '7890123']) {
      for (const form of [
        secret,
        Buffer.from(secret).toString('hex'),
        Buffer.from(secret).toString('base64'),
        Buffer.from(secret).toString('base64url'),
      ]) {
        expect(raw).not.toContain(form);
      }
    }
    // Key id is present in the envelope (readable for rotation queries).
    expect(row.bank_account_number.startsWith('v1.test1.')).toBe(true);
    expect(row.bank_account_name.split('.')[1]).toBe('test1');
    expect(row.bank_account_last4).toBe(LAST4);
    expect(
      crypto.decrypt(row.bank_account_number as never, ctxFor(teamId, 'bank_account_number')),
    ).toBe(ACCOUNT);
    expect(
      crypto.decrypt(row.bank_account_name as never, ctxFor(teamId, 'bank_account_name')),
    ).toBe(ACCOUNT_NAME);
    // The generated flag follows the block (R1/R3): no Akahu column takes part.
    const { rows: flag } = await db.pool.query<{ is_payout_configured: boolean }>(
      'SELECT is_payout_configured FROM teams WHERE id = $1',
      [teamId],
    );
    expect(flag[0]?.is_payout_configured).toBe(true);
  });

  it('encrypting the same plaintext twice stores different ciphertext, both decryptable', async () => {
    const teamId = await insertTeam(db.pool);
    const ctx = ctxFor(teamId, 'ird_number');
    const first = crypto.encrypt('123-456-789', ctx);
    const second = crypto.encrypt('123-456-789', ctx);
    expect(first).not.toBe(second);
    await db.pool.query('UPDATE teams SET ird_number = $2 WHERE id = $1', [teamId, first]);
    await db.pool.query('UPDATE teams SET ird_number = $2 WHERE id = $1', [teamId, second]);
    const { rows } = await db.pool.query<{ ird_number: string }>(
      'SELECT ird_number FROM teams WHERE id = $1',
      [teamId],
    );
    expect(rows[0]?.ird_number).toBe(second);
    expect(crypto.decrypt(second, ctx)).toBe('123-456-789');
  });

  it('a ciphertext copied to another row or another column passes the CHECK but fails authentication', async () => {
    const teamA = await insertTeam(db.pool);
    const teamB = await insertTeam(db.pool);
    await writeBanking(teamA);
    const { rows } = await db.pool.query<{ bank_account_number: string }>(
      'SELECT bank_account_number FROM teams WHERE id = $1',
      [teamA],
    );
    const stolen = rows[0]?.bank_account_number ?? '';
    // Other row, same column: team B gets a full block (all-or-none) whose number is team A's ciphertext.
    await db.pool.query(
      `UPDATE teams SET bank_account_name = $2, bank_account_number = $3, bank_account_last4 = $4
        WHERE id = $1`,
      [teamB, crypto.encrypt(ACCOUNT_NAME, ctxFor(teamB, 'bank_account_name')), stolen, LAST4],
    );
    // Same row, other column.
    await db.pool.query('UPDATE teams SET bank_account_name = $2 WHERE id = $1', [teamA, stolen]);
    const read = await db.pool.query<{
      id: string;
      bank_account_number: string;
      bank_account_name: string | null;
    }>('SELECT id, bank_account_number, bank_account_name FROM teams WHERE id IN ($1, $2)', [
      teamA,
      teamB,
    ]);
    const copiedRow = read.rows.find((r) => r.id === teamB);
    const copiedColumn = read.rows.find((r) => r.id === teamA);
    expect(() =>
      crypto.decrypt(copiedRow?.bank_account_number as never, ctxFor(teamB, 'bank_account_number')),
    ).toThrow(DecryptionError);
    expect(() =>
      crypto.decrypt(copiedColumn?.bank_account_name as never, ctxFor(teamA, 'bank_account_name')),
    ).toThrow(DecryptionError);
  });

  it('seals the name and number written through the real API: no readable secret in the row, active key id, and an envelope moved to another column fails authentication (AC-VERIFY-2)', async () => {
    const h = await buildAuthTestApp(db.pool);
    try {
      const scene = createBankingScene(h, db);
      const admin = await scene.person();
      const teamId = await scene.team([admin]);
      const saved = await scene.putBanking(
        teamId,
        admin,
        scene.body('Real API Holder Club', ACCOUNT_A),
      );
      expect(saved.statusCode).toBe(200);
      const { rows } = await db.pool.query<{ whole_row: string }>(
        `SELECT t::text AS whole_row FROM teams t WHERE id = $1`,
        [teamId],
      );
      const raw = rows[0]?.whole_row ?? '';
      for (const secret of ['Real API Holder Club', ACCOUNT_A.canonical, '0068389']) {
        for (const form of [
          secret,
          Buffer.from(secret).toString('hex'),
          Buffer.from(secret).toString('base64'),
          Buffer.from(secret).toString('base64url'),
        ]) {
          expect(raw).not.toContain(form);
        }
      }
      const stored = await scene.row(teamId);
      expect(stored.bank_account_name?.startsWith('v1.dev1.')).toBe(true);
      expect(stored.bank_account_number?.startsWith('v1.dev1.')).toBe(true);
      expect(await scene.opened(teamId)).toEqual({
        name: 'Real API Holder Club',
        number: ACCOUNT_A.canonical,
      });
      expect(() =>
        scene.crypto.decrypt(stored.bank_account_number as never, {
          table: 'teams',
          column: 'bank_account_name',
          rowId: teamId,
        }),
      ).toThrow(DecryptionError);
    } finally {
      await h.close();
    }
  });

  it('rejects a plaintext write to every encrypted column with SQLSTATE 23514', async () => {
    const teamId = await insertTeam(db.pool);
    for (const column of ENCRYPTED_COLUMNS) {
      await expectPgError(
        db.pool.query(`UPDATE teams SET ${column} = $2 WHERE id = $1`, [
          teamId,
          'plain text value',
        ]),
        '23514',
        `teams_${column}_envelope`,
      );
    }
    // NULL stays allowed (banking not configured yet): the whole block cleared together.
    await db.pool.query(
      `UPDATE teams SET bank_account_name = NULL, bank_account_number = NULL, bank_account_last4 = NULL
        WHERE id = $1`,
      [teamId],
    );
  });
});
