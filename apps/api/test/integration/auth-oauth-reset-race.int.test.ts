/**
 * OAuth-vs-reset races (AC-ERROR-16 for the OAuth paths, algorithm D1): a password reset removes the OAuth
 * identities and revokes every session of the user in one transaction. An OAuth sign-in, a sign-up completion
 * that resolves to an existing identity (C3) or a link callback that was decided before that commit must not
 * leave a session or an identity behind. The seam is the user row lock: the test holds a reset-equivalent
 * transaction open (it has the lock and its writes are uncommitted), starts the OAuth request, waits until the
 * request either finishes (no lock taken: the bug) or queues behind the lock, then commits the reset.
 */
import { randomUUID } from 'node:crypto';
import { ErrorResponse, OAuthAuthorizeResponse, OAuthCallbackResponse } from '@sgm/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { fakeCode, type FakeCode } from '../../src/modules/auth/providers/fake.ts';
import {
  TEST_INTERNAL_SECRET,
  bearer,
  buildAuthTestApp,
  createPasswordUser,
  sessionFor,
  type AuthTestApp,
} from '../helpers/auth-app.ts';
import { createTestDatabase, type TestDatabase } from '../helpers/test-db.ts';
import { sleep } from '../helpers/wait-for.ts';

let database: TestDatabase;
let h: AuthTestApp;
beforeAll(async () => {
  database = await createTestDatabase({ poolMax: 20 });
  h = await buildAuthTestApp(database.pool, {
    env: { AUTH_FAKE_OAUTH: 'true', API_INTERNAL_SHARED_SECRET: TEST_INTERNAL_SECRET },
  });
});
afterAll(async () => {
  await h.close();
  await database.close();
});

/** What `reset()` does to the user, held uncommitted: the user row lock, no OAuth identity, no live session. */
async function beginReset(userId: string): Promise<{ commit(): Promise<void> }> {
  const client = await database.pool.connect();
  await client.query('BEGIN');
  await client.query(`SELECT id FROM users WHERE id = $1 FOR UPDATE`, [userId]);
  await client.query(
    `DELETE FROM auth_identities WHERE user_id = $1 AND provider IN ('GOOGLE', 'FACEBOOK')`,
    [userId],
  );
  await client.query(
    `UPDATE auth_sessions SET revoked_at = now(), revoked_reason = 'password_reset'
      WHERE user_id = $1 AND revoked_at IS NULL`,
    [userId],
  );
  return {
    commit: async () => {
      await client.query('COMMIT');
      client.release();
    },
  };
}

/** Resolves once `request` finished or some statement of this database waits on a lock (up to 5 s). */
async function untilFinishedOrBlocked(request: Promise<unknown>): Promise<void> {
  let finished = false;
  void request.then(
    () => (finished = true),
    () => (finished = true),
  );
  for (let i = 0; i < 100 && !finished; i += 1) {
    const { rows } = await database.pool.query(
      `SELECT 1 FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock'`,
    );
    if (rows.length > 0) return;
    await sleep(50);
  }
}

/** Runs `request` against a held reset: the reset commits only after the request is decided or queued. */
async function raceWithReset<T>(userId: string, start: () => Promise<T>): Promise<T> {
  const reset = await beginReset(userId);
  const request = start();
  await untilFinishedOrBlocked(request);
  await reset.commit();
  return request;
}

const countSessions = async (userId: string): Promise<number> =>
  Number(
    (
      await database.pool.query<{ n: string }>(
        `SELECT count(*)::text AS n FROM auth_sessions WHERE user_id = $1 AND revoked_at IS NULL`,
        [userId],
      )
    ).rows[0]?.n,
  );

const countIdentities = async (userId: string, provider: string): Promise<number> =>
  Number(
    (
      await database.pool.query<{ n: string }>(
        `SELECT count(*)::text AS n FROM auth_identities WHERE user_id = $1 AND provider = $2`,
        [userId, provider],
      )
    ).rows[0]?.n,
  );

const errorCode = (response: { json(): unknown }): string =>
  ErrorResponse.parse(response.json()).error.code;

const startFlow = async (path: string, headers: Record<string, string> = {}): Promise<string> => {
  const response = await h.app.inject({ method: 'POST', url: path, headers, payload: {} });
  expect(response.statusCode).toBe(200);
  return OAuthAuthorizeResponse.parse(response.json()).state;
};

const callback = (state: string, code: FakeCode, headers: Record<string, string> = {}) =>
  h.app.inject({
    method: 'POST',
    url: '/auth/oauth/google/callback',
    headers,
    payload: { state, code: fakeCode(code) },
  });

async function userWithGoogle(): Promise<{ userId: string; sub: string }> {
  const user = await createPasswordUser(h);
  const sub = `g-${randomUUID()}`;
  await database.pool.query(
    `INSERT INTO auth_identities (user_id, provider, provider_subject) VALUES ($1, 'GOOGLE', $2)`,
    [user.id, sub],
  );
  return { userId: user.id, sub };
}

describe('OAuth flows racing a committed password reset', () => {
  it('refuses a Google sign-in whose identity the reset removed and issues no session (S1)', async () => {
    const { userId, sub } = await userWithGoogle();
    const state = await startFlow('/auth/oauth/google/authorize');

    const response = await raceWithReset(userId, () =>
      callback(state, { fixture: 'google-verified', sub, email: 'whatever@example.test' }),
    );

    expect(response.statusCode).toBe(400);
    expect(errorCode(response)).toBe('oauth_state_invalid');
    expect(await countSessions(userId)).toBe(0);
  });

  it('refuses a sign-up completion that resolves to the identity the reset removed (C3)', async () => {
    const sub = `g-${randomUUID()}`;
    const pendingState = await startFlow('/auth/oauth/google/authorize');
    const pendingResponse = await callback(pendingState, {
      fixture: 'google-verified',
      sub,
      email: `late-${randomUUID().slice(0, 8)}@example.test`,
    });
    const pending = OAuthCallbackResponse.parse(pendingResponse.json());
    if (pending.outcome !== 'pending_signup') throw new Error('expected pending_signup');
    // The identity appears (a twin tab completed) after the pending row was made.
    const user = await createPasswordUser(h);
    await database.pool.query(
      `INSERT INTO auth_identities (user_id, provider, provider_subject) VALUES ($1, 'GOOGLE', $2)`,
      [user.id, sub],
    );

    const response = await raceWithReset(user.id, () =>
      h.app.inject({
        method: 'POST',
        url: '/auth/oauth/complete',
        payload: { pendingToken: pending.pendingToken, fullName: 'Aroha Ngata', sex: 'FEMALE' },
      }),
    );

    expect(response.statusCode).toBeGreaterThanOrEqual(400);
    expect(errorCode(response)).toBe('signup_expired');
    expect(await countSessions(user.id)).toBe(0);
  });

  it('refuses a link callback once the reset revoked the linking session and attaches nothing', async () => {
    const user = await createPasswordUser(h);
    const token = await sessionFor(h, user);
    const state = await startFlow('/auth/identities/google/link', bearer(token));

    const response = await raceWithReset(user.id, () =>
      callback(
        state,
        { fixture: 'google-verified', sub: `g-${randomUUID()}`, email: user.email },
        bearer(token),
      ),
    );

    expect(response.statusCode).toBe(401);
    expect(errorCode(response)).toBe('session_expired');
    expect(await countIdentities(user.id, 'GOOGLE')).toBe(0);
  });
});
