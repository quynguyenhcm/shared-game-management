/**
 * Races resolved by the database (AC-INTEGRATION-5, Phase 2 part): 20 concurrent registrations for one
 * email in different letter cases, and 20 concurrent wrong-password sign-ins for one email.
 * The pool is larger than the parallelism so no request waits for a connection.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  buildAuthTestApp,
  createPasswordUser,
  login,
  STRONG_PASSWORD,
  type AuthTestApp,
} from '../helpers/auth-app.ts';
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
