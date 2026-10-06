/**
 * Races resolved by the database (AC-INTEGRATION-5): 20 concurrent registrations for one email in
 * different letter cases, 20 concurrent wrong-password sign-ins for one email, and 20 concurrent resets
 * consuming one token. The pool is larger than the parallelism so no request waits for a connection.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  buildAuthTestApp,
  createPasswordUser,
  login,
  STRONG_PASSWORD,
  type AuthTestApp,
} from '../helpers/auth-app.ts';
import { insertResetToken } from '../helpers/factories.ts';
import { createTestDatabase, type TestDatabase } from '../helpers/test-db.ts';

let database: TestDatabase;
let h: AuthTestApp;
beforeAll(async () => {
  database = await createTestDatabase({ poolMax: 40 });
  h = await buildAuthTestApp(database.pool);
});
afterAll(async () => {
  await h.close();
  await database.close();
});

/** `race@example.com` with letters upper-cased according to the bits of `n`. */
function caseVariant(n: number): string {
  const base = 'race.condition@example.com';
  return [...base]
    .map((char, index) => (n & (1 << (index % 20)) ? char.toUpperCase() : char))
    .join('');
}

describe('20-way registration race', () => {
  it('creates exactly one account: one 201, nineteen 409 email_taken (unique constraint, not an app check)', async () => {
    const responses = await Promise.all(
      Array.from({ length: 20 }, (_, n) =>
        h.app.inject({
          method: 'POST',
          url: '/auth/register',
          payload: {
            fullName: 'Race Runner',
            email: caseVariant(n),
            password: STRONG_PASSWORD,
            sex: 'OTHER',
          },
        }),
      ),
    );
    const statuses = responses.map((response) => response.statusCode);
    expect(statuses.filter((status) => status === 201)).toHaveLength(1);
    expect(statuses.filter((status) => status === 409)).toHaveLength(19);
    for (const response of responses.filter((r) => r.statusCode === 409)) {
      expect(response.json()).toMatchObject({ error: { code: 'email_taken' } });
    }
    const { rows } = await database.pool.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM users WHERE email = 'race.condition@example.com'`,
    );
    expect(rows[0]?.n).toBe('1');
    const identities = await database.pool.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM auth_identities WHERE provider_subject = 'race.condition@example.com'`,
    );
    expect(identities.rows[0]?.n).toBe('1');
    const sessions = await database.pool.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM auth_sessions`,
    );
    expect(sessions.rows[0]?.n).toBe('1');
  });
});

describe('20-way wrong-password race', () => {
  it('performs exactly 5 password verifications and answers 15 requests with 429', async () => {
    const user = await createPasswordUser(h, { email: 'race.login@example.com' });
    h.hasher.resetCalls();
    const results = await Promise.all(
      Array.from({ length: 20 }, () => login(h, user.email, 'the-wrong-password-1')),
    );
    const statuses = results.map((result) => result.statusCode);
    expect(statuses.filter((status) => status === 401)).toHaveLength(5);
    expect(statuses.filter((status) => status === 429)).toHaveLength(15);
    expect(h.hasher.verifyCalls).toHaveLength(5);
  });
});

describe('20-way reset race', () => {
  it('lets exactly one concurrent reset consume the token: one 200, nineteen 400, one new password', async () => {
    const user = await createPasswordUser(h, { email: 'race.reset@example.com' });
    const { token } = await insertResetToken(database.pool, user.id, { createdAt: h.clock.now() });
    const passwords = Array.from({ length: 20 }, (_, n) => `race-reset-password-${n}-tui`);

    const responses = await Promise.all(
      passwords.map((password) =>
        h.app.inject({
          method: 'POST',
          url: '/auth/password/reset',
          payload: { token, password },
        }),
      ),
    );
    const statuses = responses.map((response) => response.statusCode);
    expect(statuses.filter((status) => status === 200)).toHaveLength(1);
    expect(statuses.filter((status) => status === 400)).toHaveLength(19);
    for (const response of responses.filter((r) => r.statusCode === 400)) {
      expect(response.json()).toMatchObject({ error: { code: 'invalid_or_expired_token' } });
    }

    const winner = passwords[statuses.indexOf(200)] ?? '';
    const { rows: identities } = await database.pool.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM auth_identities WHERE user_id = $1 AND provider = 'PASSWORD'`,
      [user.id],
    );
    expect(identities[0]?.n).toBe('1');
    expect((await login(h, user.email, winner)).statusCode).toBe(200);
    for (const loser of passwords.filter((password) => password !== winner).slice(0, 3)) {
      expect((await login(h, user.email, loser)).statusCode).toBe(401);
    }
    const { rows: used } = await database.pool.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM password_reset_tokens WHERE user_id = $1 AND used_at IS NOT NULL`,
      [user.id],
    );
    expect(used[0]?.n).toBe('1');
  });
});
