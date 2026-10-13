/**
 * Encrypted team columns (architecture Q5): the database only ever holds the AES-256-GCM envelope,
 * AAD binds each ciphertext to its table/column/row, and the DDL CHECKs reject plaintext writes.
 */
import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  DecryptionError,
  createCrypto,
  deriveBankAccountLast4,
  type EncryptionContext,
} from '../../src/lib/crypto/crypto.ts';
import { createKeyProvider } from '../../src/lib/crypto/keyring.ts';
import { insertTeam } from '../helpers/factories.ts';
import { createTestDatabase, expectPgError, type TestDatabase } from '../helpers/test-db.ts';

const ACCOUNT = '12-3456-7890123-00';
const TOKEN = 'test_akahu_token_ABC123';
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

async function writeBanking(teamId: string): Promise<void> {
  await db.pool.query(
    `UPDATE teams SET bank_account_number = $2, bank_account_last4 = $3, akahu_app_token = $4
     WHERE id = $1`,
    [
      teamId,
      crypto.encrypt(ACCOUNT, ctxFor(teamId, 'bank_account_number')),
      deriveBankAccountLast4(ACCOUNT),
      crypto.encrypt(TOKEN, ctxFor(teamId, 'akahu_app_token')),
    ],
  );
}

describe('teams encrypted columns', () => {
  it('stores no plaintext, hex or base64 of the secrets, keeps last4 readable, and decrypts exactly', async () => {
    const teamId = await insertTeam(db.pool);
    await writeBanking(teamId);
    const { rows } = await db.pool.query<{
      bank_account_number: string;
      akahu_app_token: string;
      bank_account_last4: string;
      whole_row: string;
    }>(
      `SELECT bank_account_number, akahu_app_token, bank_account_last4, t::text AS whole_row
       FROM teams t WHERE id = $1`,
      [teamId],
    );
    const row = rows[0];
    if (row === undefined) throw new Error('team row missing');
    const raw = `${row.bank_account_number}\n${row.akahu_app_token}\n${row.whole_row}`;
    for (const secret of [ACCOUNT, TOKEN, '1234567890123', '7890123']) {
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
    expect(row.akahu_app_token.split('.')[1]).toBe('test1');
    expect(row.bank_account_last4).toBe('2300');
    expect(
      crypto.decrypt(row.bank_account_number as never, ctxFor(teamId, 'bank_account_number')),
    ).toBe(ACCOUNT);
    expect(crypto.decrypt(row.akahu_app_token as never, ctxFor(teamId, 'akahu_app_token'))).toBe(
      TOKEN,
    );
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
    // Other row, same column.
    await db.pool.query('UPDATE teams SET bank_account_number = $2 WHERE id = $1', [teamB, stolen]);
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
    // NULL stays allowed (banking not configured yet).
    await db.pool.query('UPDATE teams SET bank_account_number = NULL WHERE id = $1', [teamId]);
  });
});
