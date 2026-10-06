/**
 * Login-vs-reset race (AC-ERROR-16, algorithm D1): a password reset that commits between the login's
 * verify step and its session issue must not leave a session behind. The seam is the spy hasher: the
 * test commits a real reset (HTTP) right after the real `verify` returns.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  buildAuthTestApp,
  createPasswordUser,
  login,
  type AuthTestApp,
} from '../helpers/auth-app.ts';
import { insertResetToken } from '../helpers/factories.ts';
import { createTestDatabase, type TestDatabase } from '../helpers/test-db.ts';

let database: TestDatabase;
let h: AuthTestApp;
beforeAll(async () => {
  database = await createTestDatabase();
  h = await buildAuthTestApp(database.pool);
});
afterAll(async () => {
  await h.close();
  await database.close();
});

const countSessions = async (userId: string): Promise<number> => {
  const { rows } = await database.pool.query<{ n: string }>(
    `SELECT count(*)::text AS n FROM auth_sessions WHERE user_id = $1`,
    [userId],
  );
  return Number(rows[0]?.n ?? '0');
};

describe('login racing a committed password reset', () => {
  it('answers the generic 401 and issues no session when the hash changed after verify', async () => {
    const user = await createPasswordUser(h, { email: 'race.loginreset@example.com' });
    const { token } = await insertResetToken(database.pool, user.id, { createdAt: h.clock.now() });
    const mutableHasher = h.hasher as { verify: typeof h.hasher.verify };
    const realVerify = h.hasher.verify.bind(h.hasher);
    let resetStatus = 0;
    mutableHasher.verify = async (phc, password) => {
      const result = await realVerify(phc, password);
      if (resetStatus === 0) {
        const reset = await h.app.inject({
          method: 'POST',
          url: '/auth/password/reset',
          payload: { token, password: 'a-brand-new-password-91-tui' },
        });
        resetStatus = reset.statusCode;
      }
      return result;
    };
    let response;
    try {
      response = await login(h, user.email, user.password);
    } finally {
      mutableHasher.verify = realVerify;
    }

    expect(resetStatus).toBe(200);
    expect(response.statusCode).toBe(401);
    expect(response.body).toMatchObject({ error: { code: 'invalid_credentials' } });
    expect(await countSessions(user.id)).toBe(0);
  });
});
