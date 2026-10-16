/**
 * Domain schema: migrate round trip (AC-VERIFY-5), conformance to database-design.md plus the
 * deviations record (AC-INTEGRATION-1), auth identities (AC-VERIFY-6), wallet balance range
 * (AC-VERIFY-10), financial retention (AC-VERIFY-11) and recurrence uniqueness (AC-VERIFY-12).
 */
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { EXPECTED_ENUMS, EXPECTED_INDEXES, EXPECTED_TABLES } from '../fixtures/expected-schema.ts';
import {
  insertPasswordIdentity,
  insertPayment,
  insertRegistration,
  insertSession,
  insertTeam,
  insertUser,
  insertWallet,
} from '../helpers/factories.ts';
import { catalogSnapshot, pgDumpSnapshot } from '../helpers/schema-dump.ts';
import {
  createTestDatabase,
  expectPgError,
  inRollback,
  trySql,
  type TestDatabase,
} from '../helpers/test-db.ts';

const API_ROOT = fileURLToPath(new URL('../../', import.meta.url));
const DEVIATIONS_FILE = fileURLToPath(
  new URL('../../../../db/schema-deviations.md', import.meta.url),
);

let db: TestDatabase;
beforeAll(async () => {
  db = await createTestDatabase();
});
afterAll(async () => {
  await db.close();
});

function runCli(databaseUrl: string, ...args: string[]): { status: number | null; output: string } {
  const result = spawnSync(process.execPath, ['--import', 'tsx', 'src/cli.ts', ...args], {
    cwd: API_ROOT,
    env: { ...process.env, DATABASE_URL: databaseUrl, LOG_LEVEL: 'silent' },
    encoding: 'utf8',
    timeout: 60_000,
  });
  return { status: result.status, output: `${result.stdout}\n${result.stderr}` };
}

describe('migrations (AC-VERIFY-5)', () => {
  it('migrate, rollback --all, migrate from empty all exit 0 and leave an identical public schema', async () => {
    const empty = await createTestDatabase({ empty: true });
    try {
      const startedAt = Date.now();
      const first = runCli(empty.url, 'db', 'migrate');
      const firstMigrateMs = Date.now() - startedAt;
      expect(first, first.output).toMatchObject({ status: 0 });
      expect(firstMigrateMs).toBeLessThanOrEqual(30_000);
      const afterFirst = await catalogSnapshot(empty.pool);
      const dumpFirst = pgDumpSnapshot(empty.url, empty.name);
      expect(afterFirst.some((line) => line.startsWith('column payments.team_id'))).toBe(true);
      // The five auth migrations (AC-VERIFY-5) are part of the round trip.
      for (const prefix of [
        'column auth_sessions.token_hash',
        'column password_reset_tokens.used_at',
        'column oauth_states.link_user_id',
        'column oauth_pending_signups.full_name',
        'column auth_throttle.attempts',
        'column users.email_verified_at',
        // team-management membership invariants (D-40..D-46).
        'column teams.create_idempotency_key',
        // team-banking-and-gst invariants (D-47..D-53); is_payout_configured is a STORED generated column.
        'column teams.payout_blocked_at',
        'column teams.banking_updated_at',
        'column teams.banking_updated_by',
      ]) {
        expect(
          afterFirst.some((line) => line.startsWith(prefix)),
          prefix,
        ).toBe(true);
      }
      expect(
        afterFirst.filter((line) => line.includes('FUNCTION public.auth_throttle_')),
      ).toHaveLength(2);
      expect(
        afterFirst.filter((line) => line.includes('FUNCTION public.team_members_')),
      ).toHaveLength(2);
      for (const trigger of [
        'team_members_guard_update',
        'team_members_last_admin_on_update',
        'team_members_last_admin_on_delete',
      ]) {
        expect(
          afterFirst.some((line) => line.startsWith('trigger') && line.includes(trigger)),
          trigger,
        ).toBe(true);
      }
      expect(
        afterFirst.some(
          (line) =>
            line.startsWith('column teams.is_payout_configured') && line.endsWith('generated=s'),
        ),
      ).toBe(true);
      for (const fn of ['game_session_is_paid', 'team_banking_in_use']) {
        expect(
          afterFirst.some(
            (line) => line.startsWith('function') && line.includes(`FUNCTION public.${fn}(`),
          ),
          fn,
        ).toBe(true);
      }
      for (const trigger of ['game_sessions_paid_requires_payout', 'teams_guard_banking_removal']) {
        expect(
          afterFirst.some((line) => line.startsWith('trigger') && line.includes(trigger)),
          trigger,
        ).toBe(true);
      }
      // Core gen_random_uuid(), never uuid-ossp.
      expect(afterFirst).not.toContain('extension uuid-ossp');

      const rollback = runCli(empty.url, 'db', 'rollback', '--all');
      expect(rollback, rollback.output).toMatchObject({ status: 0 });
      const { rows: leftover } = await empty.pool.query<{ relname: string }>(
        `SELECT relname FROM pg_class
          WHERE relnamespace = 'public'::regnamespace AND relkind = 'r' AND relname <> 'pgmigrations'`,
      );
      expect(leftover).toEqual([]);
      const { rows: leftoverTypes } = await empty.pool.query(
        `SELECT typname FROM pg_type WHERE typnamespace = 'public'::regnamespace AND typtype = 'e'`,
      );
      expect(leftoverTypes).toEqual([]);

      const again = runCli(empty.url, 'db', 'migrate');
      expect(again, again.output).toMatchObject({ status: 0 });
      expect(await catalogSnapshot(empty.pool)).toEqual(afterFirst);
      if (dumpFirst !== undefined) {
        expect(pgDumpSnapshot(empty.url, empty.name)).toEqual(dumpFirst);
      }
    } finally {
      await empty.close();
    }
  }, 120_000);
});

describe('conformance to database-design.md (AC-INTEGRATION-1)', () => {
  it('has every draft table, enum and index, and every difference is in the deviations record', async () => {
    const q = async <T extends object>(text: string): Promise<T[]> =>
      (await db.pool.query<T>(text)).rows;

    const columns = await q<{ table: string; column: string; type: string; notnull: boolean }>(
      `SELECT c.relname AS table, a.attname AS column, format_type(a.atttypid, a.atttypmod) AS type,
              a.attnotnull AS notnull
         FROM pg_attribute a JOIN pg_class c ON c.oid = a.attrelid
        WHERE c.relnamespace = 'public'::regnamespace AND c.relkind = 'r' AND a.attnum > 0
          AND NOT a.attisdropped AND c.relname <> 'pgmigrations'`,
    );
    const enums = await q<{ name: string; labels: string[] }>(
      `SELECT t.typname AS name, array_agg(e.enumlabel::text ORDER BY e.enumsortorder) AS labels
         FROM pg_type t JOIN pg_enum e ON e.enumtypid = t.oid
        WHERE t.typnamespace = 'public'::regnamespace GROUP BY t.typname`,
    );
    const fks = await q<{ table: string; columns: string[]; references: string; ondelete: string }>(
      `SELECT c.conrelid::regclass::text AS table, c.confrelid::regclass::text AS references,
              c.confdeltype::text AS ondelete,
              ARRAY(SELECT a.attname::text FROM unnest(c.conkey) WITH ORDINALITY k(attnum, ord)
                      JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = k.attnum
                     ORDER BY k.ord) AS columns
         FROM pg_constraint c WHERE c.contype = 'f' AND c.connamespace = 'public'::regnamespace`,
    );
    const indexes = await q<{ name: string; table: string; columns: string[] }>(
      `SELECT i.relname AS name, t.relname AS table,
              ARRAY(SELECT a.attname::text FROM unnest(x.indkey) WITH ORDINALITY k(attnum, ord)
                      JOIN pg_attribute a ON a.attrelid = t.oid AND a.attnum = k.attnum
                     ORDER BY k.ord) AS columns
         FROM pg_index x JOIN pg_class i ON i.oid = x.indexrelid JOIN pg_class t ON t.oid = x.indrelid
        WHERE t.relnamespace = 'public'::regnamespace`,
    );
    const functions = await q<{ name: string }>(
      `SELECT proname AS name FROM pg_proc
        WHERE pronamespace = 'public'::regnamespace AND prorettype <> 'trigger'::regtype`,
    );

    // All 10 draft tables, 13 draft enums (exact values, same order) and 11 draft indexes.
    const actualTables = new Set(columns.map((row) => row.table));
    expect([...Object.keys(EXPECTED_TABLES)].filter((t) => !actualTables.has(t))).toEqual([]);
    const enumMap = new Map(enums.map((row) => [row.name, row.labels]));
    for (const [name, labels] of Object.entries(EXPECTED_ENUMS)) {
      expect(enumMap.get(name), `enum ${name}`).toEqual(labels);
    }
    for (const [name, expected] of Object.entries(EXPECTED_INDEXES)) {
      const match = indexes.find(
        (index) =>
          index.table === expected.table &&
          expected.columns.every((column, i) => index.columns[i] === column),
      );
      expect(match, `index ${name} (or an equivalent on the same leading columns)`).toBeDefined();
    }

    // Money and time representation (P2, P3).
    const bad = columns.filter(
      (row) =>
        (row.type.startsWith('numeric') && row.type !== 'numeric(10,2)') ||
        ['real', 'double precision', 'timestamp without time zone'].includes(row.type),
    );
    expect(bad).toEqual([]);

    // Every difference from the draft, as deviation keys.
    const differences = new Set<string>();
    for (const table of actualTables) {
      if (!(table in EXPECTED_TABLES)) differences.add(`table:${table}`);
    }
    for (const row of columns) {
      const expected = EXPECTED_TABLES[row.table];
      if (!expected) continue;
      const draft = expected.columns[row.column];
      if (!draft) {
        differences.add(`column:${row.table}.${row.column}`);
        continue;
      }
      if (draft.type !== row.type) differences.add(`type:${row.table}.${row.column}`);
      if (draft.nullable === row.notnull) differences.add(`nullability:${row.table}.${row.column}`);
    }
    for (const [table, expected] of Object.entries(EXPECTED_TABLES)) {
      for (const column of Object.keys(expected.columns)) {
        if (!columns.some((row) => row.table === table && row.column === column)) {
          differences.add(`dropped:${table}.${column}`);
        }
      }
      for (const [column, fk] of Object.entries(expected.foreignKeys)) {
        const actual = fks.find(
          (row) =>
            row.table === table && row.columns[0] === column && row.references === fk.references,
        );
        if (!actual || actual.ondelete !== fk.onDelete) differences.add(`fk:${table}.${column}`);
      }
    }
    for (const name of enumMap.keys()) {
      if (!(name in EXPECTED_ENUMS)) differences.add(`enum:${name}`);
    }
    for (const { name } of functions) differences.add(`function:${name}`);

    const record = readFileSync(DEVIATIONS_FILE, 'utf8');
    const rows = record.split('\n').filter((line) => /^\|\s*D-\d+/.test(line));
    const recorded = new Set<string>();
    for (const line of rows) {
      const cells = line.split('|').map((cell) => cell.trim());
      const source = cells[4] ?? '';
      expect(source.length, `deviation without a source: ${line}`).toBeGreaterThan(0);
      for (const match of (cells[2] ?? '').matchAll(/`([a-z-]+:[a-z0-9_.]+)`/g)) {
        if (match[1]) recorded.add(match[1]);
      }
    }
    expect([...differences].filter((key) => !recorded.has(key)).sort()).toEqual([]);
    expect(differences.size).toBeGreaterThan(0);
  });
});

describe('auth identities (AC-VERIFY-6)', () => {
  it('lets one user hold PASSWORD, GOOGLE and FACEBOOK identities; a reused provider subject is 23505', async () => {
    const userId = await insertUser(db.pool);
    const subject = `google-${userId}`;
    await insertPasswordIdentity(db.pool, userId);
    await db.pool.query(
      `INSERT INTO auth_identities (user_id, provider, provider_subject) VALUES
         ($1, 'GOOGLE', $2),
         ($1, 'FACEBOOK', $3)`,
      [userId, subject, `fb-${userId}`],
    );
    const { rows } = await db.pool.query<{ provider: string }>(
      `SELECT provider FROM auth_identities WHERE user_id = $1 ORDER BY provider`,
      [userId],
    );
    expect(rows.map((row) => row.provider)).toEqual(['PASSWORD', 'GOOGLE', 'FACEBOOK']);

    const otherUser = await insertUser(db.pool);
    await expectPgError(
      db.pool.query(
        `INSERT INTO auth_identities (user_id, provider, provider_subject) VALUES ($1, 'GOOGLE', $2)`,
        [otherUser, subject],
      ),
      '23505',
    );
  });

  it('ties password_hash to the PASSWORD provider (23514), requires a user (23502) and fits a 255+ char hash', async () => {
    const userId = await insertUser(db.pool);
    const { rows: emailRows } = await db.pool.query<{ email: string }>(
      `SELECT email FROM users WHERE id = $1`,
      [userId],
    );
    const email = emailRows[0]?.email ?? '';
    await inRollback(db.pool, async (client) => {
      const insert = `INSERT INTO auth_identities (user_id, provider, provider_subject, password_hash)
                      VALUES ($1, $2, $3, $4)`;
      expect(await trySql(client, insert, [userId, 'PASSWORD', email, null])).toMatchObject({
        code: '23514',
      });
      expect(await trySql(client, insert, [userId, 'GOOGLE', `g-${userId}`, 'hash'])).toMatchObject(
        {
          code: '23514',
        },
      );
      expect(
        await trySql(client, insert, [userId, 'FACEBOOK', `f-${userId}`, 'hash']),
      ).toMatchObject({
        code: '23514',
      });
      expect(await trySql(client, insert, [null, 'GOOGLE', `g2-${userId}`, null])).toMatchObject({
        code: '23502',
      });
      expect(
        await trySql(client, insert, [userId, 'PASSWORD', email, 'x'.repeat(255)]),
      ).toBeUndefined();
    });
  });
});

describe('wallet balance range (AC-VERIFY-10)', () => {
  it('accepts 0.00 and 100.00', async () => {
    const [userId, teamId] = [await insertUser(db.pool), await insertTeam(db.pool)];
    const walletId = await insertWallet(db.pool, userId, teamId, '0.00');
    await db.pool.query(`UPDATE player_credits SET balance = '100.00' WHERE id = $1`, [walletId]);
    const { rows } = await db.pool.query<{ balance: string }>(
      `SELECT balance FROM player_credits WHERE id = $1`,
      [walletId],
    );
    expect(rows[0]?.balance).toBe('100.00');
  });

  it('rejects -0.01 and 100.01 with 23514', async () => {
    const [userId, teamId] = [await insertUser(db.pool), await insertTeam(db.pool)];
    const walletId = await insertWallet(db.pool, userId, teamId, '50.00');
    for (const balance of ['-0.01', '100.01']) {
      await expectPgError(
        db.pool.query(`UPDATE player_credits SET balance = $2 WHERE id = $1`, [walletId, balance]),
        '23514',
        'player_credits_balance_range',
      );
    }
  });
});

describe('financial retention (AC-VERIFY-11)', () => {
  async function financialFixture(): Promise<{ userId: string; teamId: string }> {
    const teamId = await insertTeam(db.pool);
    const userId = await insertUser(db.pool);
    const sessionId = await insertSession(db.pool, teamId);
    const registrationId = await insertRegistration(db.pool, { sessionId, teamId, userId });
    await insertPayment(db.pool, { userId, teamId, registrationId, amount: '17.00' });
    await insertWallet(db.pool, userId, teamId, '10.00');
    await db.pool.query(
      `INSERT INTO credit_transactions (user_id, team_id, amount, transaction_type, resulting_balance)
       VALUES ($1, $2, '10.00', 'TOPUP', '10.00')`,
      [userId, teamId],
    );
    return { userId, teamId };
  }

  it('refuses to delete a user who has payments and credit transactions (23503)', async () => {
    const { userId } = await financialFixture();
    await expectPgError(db.pool.query(`DELETE FROM users WHERE id = $1`, [userId]), '23503');
    const { rows } = await db.pool.query(
      `SELECT (SELECT count(*) FROM payments WHERE user_id = $1)::int AS payments,
              (SELECT count(*) FROM credit_transactions WHERE user_id = $1)::int AS credits`,
      [userId],
    );
    expect(rows[0]).toEqual({ payments: 1, credits: 1 });
  });

  it('refuses to delete a team that has payments and credit transactions (23503)', async () => {
    const { teamId } = await financialFixture();
    await expectPgError(db.pool.query(`DELETE FROM teams WHERE id = $1`, [teamId]), '23503');
  });

  it('declares every foreign key on financial tables ON DELETE RESTRICT', async () => {
    const { rows } = await db.pool.query<{ table: string; name: string; ondelete: string }>(
      `SELECT conrelid::regclass::text AS table, conname AS name, confdeltype::text AS ondelete
         FROM pg_constraint
        WHERE contype = 'f' AND conrelid::regclass::text IN
              ('payments', 'payment_line_items', 'credit_transactions', 'player_credits',
               'team_invoice_counters', 'registrations')`,
    );
    expect(rows.length).toBeGreaterThanOrEqual(12);
    expect(rows.filter((row) => row.ondelete !== 'r')).toEqual([]);
  });
});

describe('recurrence and auto-enrol (AC-VERIFY-12)', () => {
  it('rejects a second session for the same (recurring_rule_id, date) with 23505; one-offs are unconstrained', async () => {
    const teamId = await insertTeam(db.pool);
    const { rows } = await db.pool.query<{ id: string }>(
      `INSERT INTO recurring_session_rules (team_id, day_of_week, default_location, default_address,
                                            default_max_players, default_start_time, default_end_time, fee_flat)
       VALUES ($1, 3, 'Test Hall', '1 Test Street', 12, '19:00', '21:00', '17.00') RETURNING id`,
      [teamId],
    );
    const ruleId = rows[0]?.id ?? '';
    await insertSession(db.pool, teamId, {}, { recurringRuleId: ruleId, date: '2026-10-07' });
    await expectPgError(
      insertSession(db.pool, teamId, {}, { recurringRuleId: ruleId, date: '2026-10-07' }),
      '23505',
      'uq_game_sessions_rule_date',
    );
    await insertSession(db.pool, teamId, {}, { date: '2026-10-08' });
    await insertSession(db.pool, teamId, {}, { date: '2026-10-08' });
  });

  it('records when auto-enrol was assigned, so enrolment can be ordered by it', async () => {
    const teamId = await insertTeam(db.pool);
    const [first, second] = [await insertUser(db.pool), await insertUser(db.pool)];
    await db.pool.query(
      `INSERT INTO team_members (team_id, user_id, status, approved_at, approved_by, is_auto_enroll,
                                 auto_enroll_assigned_at) VALUES
         ($1, $2, 'APPROVED', now(), $2, true, '2026-09-01T00:00:00Z'),
         ($1, $3, 'APPROVED', now(), $3, true, '2026-08-01T00:00:00Z')`,
      [teamId, first, second],
    );
    const { rows } = await db.pool.query<{ user_id: string }>(
      `SELECT user_id FROM team_members WHERE team_id = $1 AND is_auto_enroll ORDER BY auto_enroll_assigned_at`,
      [teamId],
    );
    expect(rows.map((row) => row.user_id)).toEqual([second, first]);
    const { rows: type } = await db.pool.query<{ data_type: string }>(
      `SELECT data_type FROM information_schema.columns
        WHERE table_name = 'team_members' AND column_name = 'auto_enroll_assigned_at'`,
    );
    expect(type[0]?.data_type).toBe('timestamp with time zone');
    await expectPgError(
      db.pool.query(
        `INSERT INTO team_members (team_id, user_id, is_auto_enroll) VALUES ($1, $2, true)`,
        [teamId, await insertUser(db.pool)],
      ),
      '23514',
    );
  });
});
