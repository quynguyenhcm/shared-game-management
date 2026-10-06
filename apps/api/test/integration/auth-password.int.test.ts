/**
 * Password auth over the real app and a real cloned Postgres (AC-INTEGRATION-2): register, login, me,
 * logout, validation, enumeration resistance, Origin check and session lifetime with an injected clock.
 */
import { createHash } from 'node:crypto';
import { AuthSuccessResponse, ErrorResponse, FIELD_MESSAGES, MeResponse } from '@sgm/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  bearer,
  buildAuthTestApp,
  createPasswordUser,
  login,
  sessionFor,
  STRONG_PASSWORD,
  type AuthTestApp,
} from '../helpers/auth-app.ts';
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

const registerBody = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  fullName: 'Aroha Ngata',
  email: 'Aroha.Ngata@Example.com',
  password: STRONG_PASSWORD,
  sex: 'FEMALE',
  ...overrides,
});

async function count(table: string, where = 'true', values: unknown[] = []): Promise<number> {
  const { rows } = await database.pool.query<{ n: string }>(
    `SELECT count(*)::text AS n FROM ${table} WHERE ${where}`,
    values,
  );
  return Number(rows[0]?.n);
}

describe('POST /auth/register', () => {
  it('creates the user, a PASSWORD identity with an argon2id hash and a session, then signs in (AC-HAPPY-1)', async () => {
    const response = await h.app.inject({
      method: 'POST',
      url: '/auth/register',
      payload: registerBody(),
    });
    expect(response.statusCode).toBe(201);
    const body = AuthSuccessResponse.parse(response.json());
    expect(body.user).toMatchObject({
      email: 'aroha.ngata@example.com',
      fullName: 'Aroha Ngata',
      sex: 'FEMALE',
      role: 'PLAYER',
    });
    expect(response.headers['set-cookie']).toBeUndefined(); // the API sets no cookies

    const { rows: users } = await database.pool.query(
      `SELECT id, email, sex, role FROM users WHERE email = 'aroha.ngata@example.com'`,
    );
    expect(users).toHaveLength(1);
    const { rows: identities } = await database.pool.query<{
      provider: string;
      provider_subject: string;
      password_hash: string;
    }>(`SELECT provider, provider_subject, password_hash FROM auth_identities WHERE user_id = $1`, [
      body.user.id,
    ]);
    expect(identities).toHaveLength(1);
    expect(identities[0]).toMatchObject({
      provider: 'PASSWORD',
      provider_subject: 'aroha.ngata@example.com',
    });
    expect(identities[0]?.password_hash.startsWith('$argon2id$')).toBe(true);

    // Only the SHA-256 of the token is stored, and the session's expiry is its absolute expiry.
    const { rows: sessions } = await database.pool.query<{
      token_hash: Buffer;
      absolute_expires_at: Date;
    }>(`SELECT token_hash, absolute_expires_at FROM auth_sessions WHERE user_id = $1`, [
      body.user.id,
    ]);
    expect(sessions).toHaveLength(1);
    expect(
      sessions[0]?.token_hash.equals(createHash('sha256').update(body.session.token).digest()),
    ).toBe(true);
    expect(sessions[0]?.absolute_expires_at.toISOString()).toBe(body.session.expiresAt);

    const me = await h.app.inject({
      method: 'GET',
      url: '/auth/me',
      headers: bearer(body.session.token),
    });
    expect(me.statusCode).toBe(200);
    expect(MeResponse.parse(me.json()).user.id).toBe(body.user.id);
  });

  it('answers 409 email_taken for the same address in another letter case and creates nothing (AC-ERROR-1)', async () => {
    const before = await count('users');
    const response = await h.app.inject({
      method: 'POST',
      url: '/auth/register',
      payload: registerBody({ email: 'AROHA.NGATA@example.com', fullName: 'Someone Else' }),
    });
    expect(response.statusCode).toBe(409);
    expect(ErrorResponse.parse(response.json()).error.code).toBe('email_taken');
    expect(await count('users')).toBe(before);
    expect(await count('auth_identities', `provider_subject = 'aroha.ngata@example.com'`)).toBe(1);
  });

  it('rejects invalid input with 422 fieldErrors per field and creates nothing (AC-ERROR-2)', async () => {
    const before = await count('users');
    const cases: [Record<string, unknown>, string, string][] = [
      [{ sex: undefined }, 'sex', FIELD_MESSAGES.sexRequired],
      [{ email: 'not-an-email' }, 'email', FIELD_MESSAGES.emailInvalid],
      [{ password: 'short1' }, 'password', FIELD_MESSAGES.passwordTooShort],
      [{ password: 'x'.repeat(129) }, 'password', FIELD_MESSAGES.passwordTooLong],
      [{ password: 'password123' }, 'password', FIELD_MESSAGES.passwordCommon],
      [
        { password: 'new.person@example.com', email: 'new.person@example.com' },
        'password',
        FIELD_MESSAGES.passwordCommon,
      ],
      [
        { password: 'new.person', email: 'new.person@example.com' },
        'password',
        FIELD_MESSAGES.passwordCommon,
      ],
    ];
    for (const [overrides, field, message] of cases) {
      const response = await h.app.inject({
        method: 'POST',
        url: '/auth/register',
        payload: registerBody({ email: 'fresh@example.com', ...overrides }),
      });
      expect(response.statusCode, JSON.stringify(overrides)).toBe(422);
      const error = ErrorResponse.parse(response.json()).error;
      expect(error.code).toBe('validation_failed');
      expect(error.fieldErrors?.[field]).toContain(message);
    }
    // A client can never self-assign a role: unknown fields are refused.
    const withRole = await h.app.inject({
      method: 'POST',
      url: '/auth/register',
      payload: registerBody({ email: 'fresh@example.com', role: 'GLOBAL_ADMIN' }),
    });
    expect(withRole.statusCode).toBe(422);
    expect(await count('users')).toBe(before);
  });

  it('refuses a foreign Origin on a mutating request before doing anything (AC-ERROR-15)', async () => {
    const before = await count('users');
    const response = await h.app.inject({
      method: 'POST',
      url: '/auth/register',
      headers: { origin: 'https://evil.example' },
      payload: registerBody({ email: 'csrf@example.com' }),
    });
    expect(response.statusCode).toBe(403);
    expect(response.json()).toMatchObject({ error: { code: 'cross_origin_request' } });
    expect(await count('users')).toBe(before);
  });
});

describe('POST /auth/login', () => {
  it('signs in with the email in any letter case, issues a new session and stamps last_used_at (AC-HAPPY-2)', async () => {
    const user = await createPasswordUser(h, { email: 'login.happy@example.com' });
    const first = await login(h, 'LOGIN.Happy@Example.COM', user.password);
    expect(first.statusCode).toBe(200);
    const firstSession = AuthSuccessResponse.parse(first.body).session;
    expect(first.headers['set-cookie']).toBeUndefined();

    const { rows } = await database.pool.query<{ last_used_at: Date | null }>(
      `SELECT last_used_at FROM auth_identities WHERE user_id = $1 AND provider = 'PASSWORD'`,
      [user.id],
    );
    expect(rows[0]?.last_used_at).not.toBeNull();

    // Signing in again while presenting the first session replaces it.
    const second = await login(h, user.email, user.password, bearer(firstSession.token));
    expect(second.statusCode).toBe(200);
    const { rows: revoked } = await database.pool.query<{ revoked_reason: string | null }>(
      `SELECT revoked_reason FROM auth_sessions WHERE token_hash = $1`,
      [createHash('sha256').update(firstSession.token).digest()],
    );
    expect(revoked[0]?.revoked_reason).toBe('replaced');
    expect(await count('auth_sessions', `user_id = $1 AND revoked_at IS NULL`, [user.id])).toBe(1);
  });

  it('gives one generic 401 for an unknown email, a wrong password and an OAuth-only account (AC-ERROR-3)', async () => {
    const known = await createPasswordUser(h, { email: 'generic.known@example.com' });
    const oauthOnly = await createPasswordUser(h, { email: 'generic.oauth@example.com' });
    await database.pool.query(
      `INSERT INTO auth_identities (user_id, provider, provider_subject) VALUES ($1, 'GOOGLE', 'g-sub-1')`,
      [oauthOnly.id],
    );
    await database.pool.query(
      `DELETE FROM auth_identities WHERE user_id = $1 AND provider = 'PASSWORD'`,
      [oauthOnly.id],
    );
    const sessionsBefore = await count('auth_sessions');

    const attempts = [
      ['nobody.here@example.com', 'whatever-password-1'],
      [known.email, 'the-wrong-password-1'],
      [oauthOnly.email, STRONG_PASSWORD],
      ['not even an email', 'whatever-password-1'],
    ] as const;
    const bodies: unknown[] = [];
    for (const [email, password] of attempts) {
      const result = await login(h, email, password);
      expect(result.statusCode, email).toBe(401);
      bodies.push(result.body);
    }
    for (const body of bodies) expect(body).toEqual(bodies[0]);
    expect(ErrorResponse.parse(bodies[0]).error.code).toBe('invalid_credentials');
    expect(await count('auth_sessions')).toBe(sessionsBefore);
  });

  it('verifies against the dummy hash for an unknown email, so timing does not reveal registration (AC-VERIFY-10)', async () => {
    const known = await createPasswordUser(h, { email: 'dummy.known@example.com' });
    h.hasher.resetCalls();
    await login(h, 'dummy.unknown@example.com', 'whatever-password-1');
    expect(h.hasher.verifyCalls).toEqual([expect.objectContaining({ isDummy: true })]);

    h.hasher.resetCalls();
    await login(h, known.email, 'the-wrong-password-1');
    expect(h.hasher.verifyCalls).toHaveLength(1);
    expect(h.hasher.verifyCalls[0]?.isDummy).toBe(false);
  });

  it('refuses a foreign Origin on login with 403 before touching credentials (AC-ERROR-15)', async () => {
    const user = await createPasswordUser(h, { email: 'origin.login@example.com' });
    const result = await login(h, user.email, user.password, { origin: 'https://evil.example' });
    expect(result.statusCode).toBe(403);
    expect(result.body).toMatchObject({ error: { code: 'cross_origin_request' } });
  });
});

describe('GET /auth/me, POST /auth/logout, GET /auth/providers', () => {
  it('distinguishes no token (unauthenticated) from an unknown or malformed token (session_expired) (AC-ERROR-11)', async () => {
    const none = await h.app.inject({ method: 'GET', url: '/auth/me' });
    expect(none.statusCode).toBe(401);
    expect(none.json()).toMatchObject({ error: { code: 'unauthenticated' } });
    for (const authorization of ['Bearer ' + 'a'.repeat(43), 'Bearer nonsense!', 'Basic abc']) {
      const response = await h.app.inject({
        method: 'GET',
        url: '/auth/me',
        headers: { authorization },
      });
      expect(response.statusCode, authorization).toBe(401);
      expect(response.json()).toMatchObject({ error: { code: 'session_expired' } });
    }
  });

  it('logout revokes the session with reason logout, is 204 for a dead or absent session, and the old token is expired (AC-HAPPY-7)', async () => {
    const user = await createPasswordUser(h, { email: 'logout@example.com' });
    const token = await sessionFor(h, user);
    const out = await h.app.inject({ method: 'POST', url: '/auth/logout', headers: bearer(token) });
    expect(out.statusCode).toBe(204);
    const { rows } = await database.pool.query<{
      revoked_reason: string | null;
      revoked_at: Date | null;
    }>(`SELECT revoked_reason, revoked_at FROM auth_sessions WHERE token_hash = $1`, [
      createHash('sha256').update(token).digest(),
    ]);
    expect(rows[0]?.revoked_reason).toBe('logout');
    expect(rows[0]?.revoked_at).not.toBeNull();

    const replay = await h.app.inject({ method: 'GET', url: '/auth/me', headers: bearer(token) });
    expect(replay.statusCode).toBe(401);
    expect(replay.json()).toMatchObject({ error: { code: 'session_expired' } });

    const again = await h.app.inject({
      method: 'POST',
      url: '/auth/logout',
      headers: bearer(token),
    });
    expect(again.statusCode).toBe(204);
    const anonymous = await h.app.inject({ method: 'POST', url: '/auth/logout' });
    expect(anonymous.statusCode).toBe(204);
  });

  it('lists both OAuth providers as disabled until credentials are configured', async () => {
    const response = await h.app.inject({ method: 'GET', url: '/auth/providers' });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ google: false, facebook: false });
  });
});

describe('session lifetime with an injected clock (AC-ASYNC-4)', () => {
  const sessionRow = async (token: string) =>
    (
      await database.pool.query<{
        last_seen_at: Date;
        expires_at: Date;
        absolute_expires_at: Date;
      }>(
        `SELECT last_seen_at, expires_at, absolute_expires_at FROM auth_sessions WHERE token_hash = $1`,
        [createHash('sha256').update(token).digest()],
      )
    ).rows[0];
  const me = (token: string) =>
    h.app.inject({ method: 'GET', url: '/auth/me', headers: bearer(token) });
  const HOUR = 3_600_000;
  const DAY = 24 * HOUR;

  it('touches at most once an hour, never past the absolute expiry, and expires after 7 idle or 30 absolute days', async () => {
    const user = await createPasswordUser(h, { email: 'lifetime@example.com' });
    const t0 = h.clock.now();
    const token = await sessionFor(h, user);
    const created = await sessionRow(token);
    expect(created?.expires_at.getTime()).toBe(t0.getTime() + 7 * DAY);
    expect(created?.absolute_expires_at.getTime()).toBe(t0.getTime() + 30 * DAY);

    h.clock.advance(30 * 60_000);
    expect((await me(token)).statusCode).toBe(200);
    expect((await sessionRow(token))?.last_seen_at.getTime()).toBe(t0.getTime()); // inside the hour: no write

    h.clock.advance(31 * 60_000);
    expect((await me(token)).statusCode).toBe(200);
    const touched = await sessionRow(token);
    expect(touched?.last_seen_at.getTime()).toBe(t0.getTime() + 61 * 60_000);
    expect(touched?.expires_at.getTime()).toBe(t0.getTime() + 61 * 60_000 + 7 * DAY);

    // Daily use keeps the session alive but the expiry is capped at the absolute limit.
    for (let day = 1; day <= 28; day += 1) {
      h.clock.advance(DAY);
      expect((await me(token)).statusCode, `day ${day}`).toBe(200);
    }
    const capped = await sessionRow(token);
    expect(capped?.expires_at.getTime()).toBeLessThanOrEqual(
      capped?.absolute_expires_at.getTime() ?? 0,
    );
    h.clock.set(new Date(t0.getTime() + 30 * DAY + 1000));
    const expired = await me(token);
    expect(expired.statusCode).toBe(401);
    expect(expired.json()).toMatchObject({ error: { code: 'session_expired' } });
  });

  it('expires a session left idle for 7 days', async () => {
    const user = await createPasswordUser(h, { email: 'idle@example.com' });
    const token = await sessionFor(h, user);
    h.clock.advance(7 * DAY - 1000);
    expect((await me(token)).statusCode).toBe(200);
    const token2 = await sessionFor(h, user);
    h.clock.advance(7 * DAY + 1000);
    const response = await me(token2);
    expect(response.statusCode).toBe(401);
    expect(response.json()).toMatchObject({ error: { code: 'session_expired' } });
  });

  it('carries no role claim: the role is read from the database on every request (AC-VERIFY-4)', async () => {
    const { rows } = await database.pool.query(
      `SELECT column_name FROM information_schema.columns WHERE table_name = 'auth_sessions' AND column_name ILIKE '%role%'`,
    );
    expect(rows).toEqual([]); // revoked_reason is the only match for "role"-less names
    const user = await createPasswordUser(h, { email: 'role.fresh@example.com' });
    const token = await sessionFor(h, user);
    expect(MeResponse.parse((await me(token)).json()).user.role).toBe('PLAYER');
    await database.pool.query(`UPDATE users SET role = 'GLOBAL_ADMIN' WHERE id = $1`, [user.id]);
    expect(MeResponse.parse((await me(token)).json()).user.role).toBe('GLOBAL_ADMIN');
  });
});
