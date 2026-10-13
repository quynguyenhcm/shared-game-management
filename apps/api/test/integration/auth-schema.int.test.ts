/**
 * Auth schema (Phase 1; AC-VERIFY-4, AC-VERIFY-5): CHECKs, UNIQUEs, the composite PASSWORD-subject FK,
 * the deferred last-method trigger, the four token/state tables and the `auth_throttle` functions,
 * all against real PostgreSQL 17. The migrate / rollback / migrate round trip lives in
 * schema.int.test.ts; the deviations ledger completeness check is at the end of this file.
 */
import { randomBytes, randomUUID } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { AssignableGlobalRole, DB_ENUMS } from '@sgm/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { insertOAuthIdentity, insertPasswordIdentity, insertUser } from '../helpers/factories.ts';
import {
  createTestDatabase,
  expectPgError,
  inTransaction,
  pgError,
  type TestDatabase,
} from '../helpers/test-db.ts';

const REPO_ROOT = fileURLToPath(new URL('../../../../', import.meta.url));

let db: TestDatabase;
beforeAll(async () => {
  db = await createTestDatabase();
});
afterAll(async () => {
  await db.close();
});

const hash = (): Buffer => randomBytes(32);

async function scalar<T>(text: string, values: unknown[] = []): Promise<T> {
  const { rows } = await db.pool.query<Record<string, T>>(text, values);
  return Object.values(rows[0] ?? {})[0] as T;
}

describe('users checks (AC-VERIFY-4)', () => {
  const insert = `INSERT INTO users (email, full_name, sex, role) VALUES ($1, 'T', 'MALE', $2)`;

  it('rejects the draft TEAM_ADMIN global role on insert and update with 23514', async () => {
    await expectPgError(
      db.pool.query(insert, [`ta-${randomUUID()}@example.test`, 'TEAM_ADMIN']),
      '23514',
      'users_role_not_team_admin',
    );
    const userId = await insertUser(db.pool);
    await expectPgError(
      db.pool.query(`UPDATE users SET role = 'TEAM_ADMIN' WHERE id = $1`, [userId]),
      '23514',
      'users_role_not_team_admin',
    );
    await db.pool.query(`UPDATE users SET role = 'GLOBAL_ADMIN' WHERE id = $1`, [userId]);
    expect(await scalar(`SELECT role FROM users WHERE id = $1`, [userId])).toBe('GLOBAL_ADMIN');
  });

  it('exposes only GLOBAL_ADMIN and PLAYER as assignable, both valid in the database enum', () => {
    expect([...AssignableGlobalRole]).toEqual(['GLOBAL_ADMIN', 'PLAYER']);
    for (const role of AssignableGlobalRole) expect(DB_ENUMS.global_role).toContain(role);
  });

  it('rejects mixed-case, non-ASCII, malformed and over-long emails with 23514 users_email_normalised', async () => {
    for (const email of [
      'A@B.com',
      'Aroha.Ngata@example.com',
      'jürgen@example.com',
      'player@exämple.com',
      'no-at-sign.example.com',
      'two@@example.com',
      'a@b@example.com',
      'has space@example.com',
      `${'a'.repeat(243)}@example.com`,
    ]) {
      await expectPgError(
        db.pool.query(insert, [email, 'PLAYER']),
        '23514',
        'users_email_normalised',
      );
    }
    await db.pool.query(insert, [`ok-${randomUUID()}@example.test`, 'PLAYER']);
  });

  it('adds a nullable email_verified_at timestamptz', async () => {
    const row = await db.pool.query<{ type: string; notnull: boolean }>(
      `SELECT format_type(atttypid, atttypmod) AS type, attnotnull AS notnull FROM pg_attribute
        WHERE attrelid = 'users'::regclass AND attname = 'email_verified_at'`,
    );
    expect(row.rows[0]).toEqual({ type: 'timestamp with time zone', notnull: false });
  });
});

describe('auth_identities invariants (AC-VERIFY-5)', () => {
  it('allows one identity per provider per user: a second GOOGLE row for a user is 23505', async () => {
    const userId = await insertUser(db.pool);
    await insertOAuthIdentity(db.pool, userId, 'GOOGLE');
    await expectPgError(
      db.pool.query(
        `INSERT INTO auth_identities (user_id, provider, provider_subject) VALUES ($1, 'GOOGLE', $2)`,
        [userId, `other-${randomUUID()}`],
      ),
      '23505',
      'uq_auth_identities_user_provider',
    );
  });

  it('keeps the PASSWORD subject equal to users.email: a different or mixed-case subject is rejected', async () => {
    const userId = await insertUser(db.pool);
    const insert = `INSERT INTO auth_identities (user_id, provider, provider_subject, password_hash)
                    VALUES ($1, 'PASSWORD', $2, '$argon2id$x')`;
    await expectPgError(db.pool.query(insert, [userId, `someone-else@example.test`]), '23503');
    const email = await scalar<string>(`SELECT email FROM users WHERE id = $1`, [userId]);
    await expectPgError(
      db.pool.query(insert, [userId, email.toUpperCase()]),
      '23514',
      'auth_identities_password_subject_lowercase',
    );
    await db.pool.query(insert, [userId, email]);
  });

  it('refuses an email change that would orphan the PASSWORD subject, unless both rows move in one transaction', async () => {
    const userId = await insertUser(db.pool);
    await insertPasswordIdentity(db.pool, userId);
    const next = `changed-${randomUUID()}@example.test`;
    await expectPgError(
      db.pool.query(`UPDATE users SET email = $2 WHERE id = $1`, [userId, next]),
      '23503',
    );
    await inTransaction(db.pool, async (client) => {
      await client.query('SET CONSTRAINTS ALL DEFERRED');
      await client.query(`UPDATE users SET email = $2 WHERE id = $1`, [userId, next]);
      await client.query(
        `UPDATE auth_identities SET provider_subject = $2 WHERE user_id = $1 AND provider = 'PASSWORD'`,
        [userId, next],
      );
    });
    expect(
      await scalar(`SELECT provider_subject FROM auth_identities WHERE user_id = $1`, [userId]),
    ).toBe(next);
  });

  it('fails at commit with 23514 auth_identities_last_method when the last identity is deleted', async () => {
    const userId = await insertUser(db.pool);
    const google = await insertOAuthIdentity(db.pool, userId, 'GOOGLE');
    const facebook = await insertOAuthIdentity(db.pool, userId, 'FACEBOOK');
    await db.pool.query(`DELETE FROM auth_identities WHERE id = $1`, [google]);
    await expectPgError(
      db.pool.query(`DELETE FROM auth_identities WHERE id = $1`, [facebook]),
      '23514',
      'auth_identities_last_method',
    );
    expect(
      await scalar(`SELECT count(*)::int FROM auth_identities WHERE user_id = $1`, [userId]),
    ).toBe(1);
  });

  it('allows swapping methods in one transaction (the reset path) and deleting a whole user', async () => {
    const userId = await insertUser(db.pool);
    await insertOAuthIdentity(db.pool, userId, 'GOOGLE');
    await inTransaction(db.pool, async (client) => {
      await client.query(`DELETE FROM auth_identities WHERE user_id = $1`, [userId]);
      await client.query(
        `INSERT INTO auth_identities (user_id, provider, provider_subject, password_hash)
         SELECT id, 'PASSWORD', email, '$argon2id$x' FROM users WHERE id = $1`,
        [userId],
      );
    });
    await db.pool.query(`DELETE FROM users WHERE id = $1`, [userId]);
    expect(
      await scalar(`SELECT count(*)::int FROM auth_identities WHERE user_id = $1`, [userId]),
    ).toBe(0);
    // A user created without identities (factories) is unaffected: the trigger only fires on DELETE.
    await insertUser(db.pool);
  });

  it('holds under two concurrent disconnects: the second commit loses', async () => {
    const userId = await insertUser(db.pool);
    const google = await insertOAuthIdentity(db.pool, userId, 'GOOGLE');
    const facebook = await insertOAuthIdentity(db.pool, userId, 'FACEBOOK');
    const [first, second] = [await db.pool.connect(), await db.pool.connect()];
    try {
      await first.query('BEGIN');
      await second.query('BEGIN');
      await first.query(`DELETE FROM auth_identities WHERE id = $1`, [google]);
      await second.query(`DELETE FROM auth_identities WHERE id = $1`, [facebook]);
      await first.query('COMMIT');
      const failure = await pgError(second.query('COMMIT'));
      expect(failure.code).toBe('23514');
      expect(failure.constraint).toBe('auth_identities_last_method');
    } finally {
      await second.query('ROLLBACK').catch(() => undefined);
      first.release();
      second.release();
    }
    expect(
      await scalar(`SELECT count(*)::int FROM auth_identities WHERE user_id = $1`, [userId]),
    ).toBe(1);
  });
});

describe('auth_sessions', () => {
  let sessionUserId = '';
  beforeAll(async () => {
    sessionUserId = await insertUser(db.pool);
  });

  function session(overrides: Record<string, string | Buffer | null> = {}): Promise<unknown> {
    const row = {
      token_hash: hash(),
      created_at: '2026-10-06T00:00:00Z',
      last_seen_at: '2026-10-06T00:00:00Z',
      expires_at: '2026-10-13T00:00:00Z',
      absolute_expires_at: '2026-11-05T00:00:00Z',
      revoked_at: null,
      revoked_reason: null,
      ...overrides,
    };
    return db.pool.query(
      `INSERT INTO auth_sessions (user_id, token_hash, created_at, last_seen_at, expires_at,
                                  absolute_expires_at, revoked_at, revoked_reason, user_agent)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'vitest')`,
      [
        sessionUserId,
        row.token_hash,
        row.created_at,
        row.last_seen_at,
        row.expires_at,
        row.absolute_expires_at,
        row.revoked_at,
        row.revoked_reason,
      ],
    );
  }

  it('stores only a 32-byte token hash, unique, with a bounded lifetime', async () => {
    await session();
    const duplicate = hash();
    await session({ token_hash: duplicate });
    await expectPgError(session({ token_hash: duplicate }), '23505');
    await expectPgError(session({ token_hash: randomBytes(16) }), '23514');
    await expectPgError(session({ expires_at: '2026-12-01T00:00:00Z' }), '23514');
    await expectPgError(session({ last_seen_at: '2026-10-05T00:00:00Z' }), '23514');
    await expectPgError(session({ absolute_expires_at: '2026-10-05T00:00:00Z' }), '23514');
  });

  it('records revocation as a pair (revoked_at iff revoked_reason) with a known reason', async () => {
    await expectPgError(session({ revoked_at: '2026-10-07T00:00:00Z' }), '23514');
    await expectPgError(session({ revoked_reason: 'logout' }), '23514');
    await expectPgError(
      session({ revoked_at: '2026-10-07T00:00:00Z', revoked_reason: 'because' }),
      '23514',
    );
    for (const reason of ['logout', 'password_reset', 'replaced']) {
      await session({ revoked_at: '2026-10-07T00:00:00Z', revoked_reason: reason });
    }
  });

  it('cascades from users', async () => {
    const userId = await insertUser(db.pool);
    await db.pool.query(
      `INSERT INTO auth_sessions (user_id, token_hash, last_seen_at, expires_at, absolute_expires_at)
       VALUES ($1, $2, now(), now() + interval '1 day', now() + interval '2 days')`,
      [userId, hash()],
    );
    await db.pool.query(`DELETE FROM users WHERE id = $1`, [userId]);
    expect(
      await scalar(`SELECT count(*)::int FROM auth_sessions WHERE user_id = $1`, [userId]),
    ).toBe(0);
  });
});

describe('password_reset_tokens, oauth_states and oauth_pending_signups', () => {
  it('password_reset_tokens: 32-byte unique hash, expiry after creation, used_at not before creation', async () => {
    const userId = await insertUser(db.pool);
    const insert = (
      expires: string,
      used: string | null,
      token: Buffer = hash(),
    ): Promise<unknown> =>
      db.pool.query(
        `INSERT INTO password_reset_tokens (user_id, token_hash, created_at, expires_at, used_at)
         VALUES ($1, $2, '2026-10-06T00:00:00Z', $3, $4)`,
        [userId, token, expires, used],
      );
    const token = hash();
    await insert('2026-10-06T01:00:00Z', null, token);
    await expectPgError(insert('2026-10-06T01:00:00Z', null, token), '23505');
    await expectPgError(insert('2026-10-06T00:00:00Z', null), '23514');
    await expectPgError(insert('2026-10-06T01:00:00Z', '2026-10-05T00:00:00Z'), '23514');
    await expectPgError(insert('2026-10-06T01:00:00Z', null, randomBytes(8)), '23514');
    await insert('2026-10-06T01:00:00Z', '2026-10-06T00:30:00Z');
  });

  it('oauth_states: intent link needs link_user_id, providers exclude PASSWORD, return_to is a local path', async () => {
    const userId = await insertUser(db.pool);
    const insert = (
      provider: string,
      intent: string,
      linkUserId: string | null,
      returnTo: string | null,
    ): Promise<unknown> =>
      db.pool.query(
        `INSERT INTO oauth_states (state_hash, provider, intent, link_user_id, nonce, return_to, expires_at)
         VALUES ($1, $2, $3, $4, 'n', $5, now() + interval '10 minutes')`,
        [hash(), provider, intent, linkUserId, returnTo],
      );
    await insert('GOOGLE', 'signin', null, '/account');
    await insert('FACEBOOK', 'link', userId, null);
    await expectPgError(insert('GOOGLE', 'link', null, null), '23514');
    await expectPgError(insert('GOOGLE', 'signin', userId, null), '23514');
    await expectPgError(insert('PASSWORD', 'signin', null, null), '23514');
    await expectPgError(insert('GOOGLE', 'sneak', null, null), '23514');
    await expectPgError(insert('GOOGLE', 'signin', null, '//evil.example'), '23514');
    await expectPgError(insert('GOOGLE', 'signin', null, 'https://evil.example'), '23514');
  });

  it('oauth_pending_signups: normalised NOT NULL email, non-PASSWORD provider, local return_to', async () => {
    const insert = (
      provider: string,
      email: string | null,
      returnTo: string | null,
    ): Promise<unknown> =>
      db.pool.query(
        `INSERT INTO oauth_pending_signups (token_hash, provider, provider_subject, email, email_verified,
                                            full_name, return_to, expires_at)
         VALUES ($1, $2, $3, $4, true, 'Aroha', $5, now() + interval '15 minutes')`,
        [hash(), provider, `sub-${randomUUID()}`, email, returnTo],
      );
    await insert('GOOGLE', 'aroha@example.test', '/account');
    await expectPgError(insert('GOOGLE', null, null), '23502');
    await expectPgError(insert('GOOGLE', 'Aroha@Example.test', null), '23514');
    await expectPgError(insert('PASSWORD', 'aroha@example.test', null), '23514');
    await expectPgError(insert('FACEBOOK', 'aroha@example.test', '//evil.example'), '23514');
  });
});

describe('auth_throttle (Algorithm Q7)', () => {
  const WINDOW = '15 minutes';
  const T0 = '2026-10-06T00:00:00Z';
  const at = (seconds: number): string => new Date(Date.parse(T0) + seconds * 1000).toISOString();

  async function admit(
    scopes: string[],
    keys: Buffer[],
    limits: number[],
    now: string,
    window = WINDOW,
  ): Promise<{ admitted: boolean; retry_after_seconds: number }> {
    const { rows } = await db.pool.query<{ admitted: boolean; retry_after_seconds: number }>(
      `SELECT * FROM auth_throttle_admit($1::text[], $2::bytea[], $3::int[], $4::interval[], $5::timestamptz)`,
      [scopes, keys, limits, scopes.map(() => window), now],
    );
    return rows[0] ?? { admitted: false, retry_after_seconds: -1 };
  }

  const attempts = async (scope: string, key: Buffer): Promise<number> =>
    scalar<number>(
      `SELECT coalesce((SELECT cardinality(attempts) FROM auth_throttle WHERE scope = $1 AND key_hash = $2), -1)::int`,
      [scope, key],
    );

  it('exists with the documented shape and both functions', async () => {
    const columns = await db.pool.query<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns WHERE table_name = 'auth_throttle' ORDER BY ordinal_position`,
    );
    expect(columns.rows.map((row) => row.column_name)).toEqual([
      'scope',
      'key_hash',
      'attempts',
      'updated_at',
    ]);
    const functions = await db.pool.query<{ signature: string }>(
      `SELECT p.oid::regprocedure::text AS signature FROM pg_proc p
        WHERE p.pronamespace = 'public'::regnamespace AND p.proname LIKE 'auth_throttle_%' ORDER BY 1`,
    );
    expect(functions.rows.map((row) => row.signature)).toEqual([
      'auth_throttle_admit(text[],bytea[],integer[],interval[],timestamp with time zone)',
      'auth_throttle_settle(bytea,bytea,timestamp with time zone)',
    ]);
    // Row creation must also run in (scope, key) order, or two concurrent admits can deadlock on it.
    const definition = await db.pool.query<{ def: string }>(
      `SELECT pg_get_functiondef('auth_throttle_admit(text[],bytea[],integer[],interval[],timestamptz)'::regprocedure) AS def`,
    );
    const insertStatement = /INSERT INTO auth_throttle[\s\S]*?ON CONFLICT/.exec(
      definition.rows[0]?.def ?? '',
    )?.[0];
    expect(insertStatement).toMatch(/ORDER BY\s+t\.scope,\s*t\.key/);
    await expectPgError(
      db.pool.query(
        `INSERT INTO auth_throttle (scope, key_hash, updated_at) VALUES ('login_email', $1, now())`,
        [randomBytes(8)],
      ),
      '23514',
    );
    await expectPgError(
      db.pool.query(
        `INSERT INTO auth_throttle (scope, key_hash, updated_at) VALUES ('mystery', $1, now())`,
        [hash()],
      ),
      '23514',
    );
  });

  it('knows the register_address scope (Phase 3 migration) and runs the admit function over it', async () => {
    const key = hash();
    const verdicts = await Promise.all(
      Array.from({ length: 5 }, () => admit(['register_address'], [key], [3], at(0))),
    );
    expect(verdicts.filter((verdict) => verdict.admitted)).toHaveLength(3);
    expect(await attempts('register_address', key)).toBe(3);
  });

  it('admits up to the limit, then blocks with Retry-After and records nothing for blocked attempts', async () => {
    const key = hash();
    for (let i = 0; i < 5; i += 1) {
      expect(await admit(['login_email'], [key], [5], at(i * 10))).toEqual({
        admitted: true,
        retry_after_seconds: 0,
      });
    }
    // Oldest counted attempt was at +0 s, so it leaves the 900 s window at +900 s.
    const blocked = await admit(['login_email'], [key], [5], at(100));
    expect(blocked).toEqual({ admitted: false, retry_after_seconds: 800 });
    expect(await admit(['login_email'], [key], [5], at(101))).toMatchObject({ admitted: false });
    expect(await attempts('login_email', key)).toBe(5);
    // After the window the oldest attempts have expired: admitted again, pruned to the live ones.
    expect(await admit(['login_email'], [key], [5], at(905))).toMatchObject({ admitted: true });
    expect(await attempts('login_email', key)).toBe(5);
  });

  it('is all-or-nothing across keys: a blocked address leaves the email count untouched', async () => {
    const emailKey = hash();
    const addressKey = hash();
    const scopes = ['login_email', 'login_address'];
    for (let i = 0; i < 2; i += 1) {
      await admit(['login_address'], [addressKey], [2], at(i));
    }
    const verdict = await admit(scopes, [emailKey, addressKey], [5, 2], at(10));
    expect(verdict.admitted).toBe(false);
    expect(await attempts('login_email', emailKey)).toBeLessThanOrEqual(0);
    expect(await attempts('login_address', addressKey)).toBe(2);
  });

  it('settle clears the email row and refunds exactly one provisional address entry', async () => {
    const emailKey = hash();
    const addressKey = hash();
    const scopes = ['login_email', 'login_address'];
    await admit(['login_address'], [addressKey], [20], at(0));
    await admit(scopes, [emailKey, addressKey], [5, 20], at(5));
    await admit(scopes, [emailKey, addressKey], [5, 20], at(5));
    expect(await attempts('login_address', addressKey)).toBe(3);
    await db.pool.query(`SELECT auth_throttle_settle($1, $2, $3)`, [emailKey, addressKey, at(5)]);
    expect(await attempts('login_email', emailKey)).toBe(-1);
    expect(await attempts('login_address', addressKey)).toBe(2);
    await db.pool.query(`SELECT auth_throttle_settle($1, NULL, $2)`, [hash(), at(5)]);
  });

  it('serialises 20 concurrent admits for one key into exactly 5 admissions', async () => {
    const key = hash();
    const verdicts = await Promise.all(
      Array.from({ length: 20 }, () => admit(['login_email'], [key], [5], at(0))),
    );
    expect(verdicts.filter((verdict) => verdict.admitted)).toHaveLength(5);
    expect(await attempts('login_email', key)).toBe(5);
  });
});

describe('migration files and the deviations ledger (AC-VERIFY-5)', () => {
  const MIGRATIONS = [
    '20261006000100000_users_email_and_role_checks.sql',
    '20261006000200000_auth_sessions.sql',
    '20261006000300000_password_reset_tokens.sql',
    '20261006000400000_oauth_states_and_pending_signups.sql',
    '20261006000500000_auth_throttle.sql',
    '20261006000600000_auth_throttle_register_scope.sql',
  ];

  it('ships the six pinned migrations, each with an Up and a Down section', () => {
    const present = readdirSync(`${REPO_ROOT}db/migrations`);
    for (const name of MIGRATIONS) {
      expect(present, name).toContain(name);
      const sql = readFileSync(`${REPO_ROOT}db/migrations/${name}`, 'utf8');
      expect(sql).toContain('-- Up Migration');
      expect(sql).toContain('-- Down Migration');
    }
  });

  it('records every new table, column, constraint, trigger and function from D-27 onwards, each with a source', () => {
    const ledger = readFileSync(`${REPO_ROOT}db/schema-deviations.md`, 'utf8');
    const rows = ledger.split('\n').filter((line) => /^\|\s*D-(2[7-9]|[3-9]\d)\b/.test(line));
    expect(rows.length).toBeGreaterThanOrEqual(10);
    for (const row of rows) {
      const cells = row.split('|').map((cell) => cell.trim());
      expect(cells[4]?.length ?? 0, `no source: ${row}`).toBeGreaterThan(0);
    }
    const text = rows.join('\n');
    for (const key of [
      'column:users.email_verified_at',
      'constraint:users_email_normalised',
      'constraint:users_role_not_team_admin',
      'constraint:uq_users_id_email',
      'constraint:uq_auth_identities_user_provider',
      'constraint:auth_identities_password_subject_lowercase',
      'column:auth_identities.password_email',
      'constraint:fk_auth_identities_password_email',
      'trigger:auth_identities_last_method',
      'function:auth_identities_enforce_last_method',
      'table:auth_sessions',
      'table:password_reset_tokens',
      'table:oauth_states',
      'table:oauth_pending_signups',
      'table:auth_throttle',
      'function:auth_throttle_admit',
      'function:auth_throttle_settle',
    ]) {
      expect(text, key).toContain(`\`${key}\``);
    }
  });
});
