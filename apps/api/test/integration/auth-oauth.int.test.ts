/**
 * OAuth sign-in, pending sign-up and identity linking over the real app and real Postgres, with the fake
 * provider (AC-HAPPY-3/4/5/11/12, AC-ERROR-7/8/9/10/14/17/20, AC-ASYNC-5, AC-VERIFY-6 for the callback,
 * AC-ENTRY-8). Provider adapters have their own fixture tests (providers.test.ts); here the provider is the
 * fake, driven through `code=fake.<base64url JSON>`.
 */
import { createHash, randomUUID } from 'node:crypto';
import {
  ErrorResponse,
  IdentitiesResponse,
  OAUTH_STATE_PATTERN,
  OAuthAuthorizeResponse,
  OAuthCallbackResponse,
  OAuthCompleteResponse,
  OAuthPendingResponse,
} from '@sgm/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { registerJobs } from '../../src/jobs/bootstrap.ts';
import { createKysely } from '../../src/lib/db/kysely.ts';
import { createJobRunner, type JobRunner } from '../../src/lib/jobs/jobs.ts';
import { createInMemoryNotifier } from '../../src/lib/notifications/adapters/in-memory.ts';
import { ENVELOPE_PATTERN } from '../../src/lib/crypto/crypto.ts';
import { fakeCode, type FakeCode } from '../../src/modules/auth/providers/fake.ts';
import {
  TEST_INTERNAL_SECRET,
  bearer,
  buildAuthTestApp,
  createPasswordUser,
  sessionFor,
  type AuthTestApp,
} from '../helpers/auth-app.ts';
import { insertAuthSession, insertOAuthIdentity, insertUser } from '../helpers/factories.ts';
import { testCrypto } from '../helpers/app-deps.ts';
import { captureLogs } from '../helpers/log-capture.ts';
import { createTestDatabase, type TestDatabase } from '../helpers/test-db.ts';
import { waitFor } from '../helpers/wait-for.ts';

const MINUTE = 60_000;
type Provider = 'google' | 'facebook';

let database: TestDatabase;
let h: AuthTestApp;
let off: AuthTestApp; // providers not configured
let producer: JobRunner;
let worker: JobRunner;
const memory = createInMemoryNotifier();
let failEnqueue = false;

beforeAll(async () => {
  database = await createTestDatabase({ poolMax: 20 });
  producer = createJobRunner({
    databaseUrl: database.url,
    logger: captureLogs().logger,
    role: 'producer',
  });
  worker = createJobRunner({
    databaseUrl: database.url,
    logger: captureLogs().logger,
    role: 'worker',
    pollingIntervalSeconds: 0.5,
    superviseIntervalSeconds: 2,
  });
  await producer.start();
  await worker.start();
  await registerJobs({
    runner: worker,
    notifier: memory,
    crypto: testCrypto(),
    db: createKysely(database.pool),
  });
  h = await buildAuthTestApp(database.pool, {
    env: { AUTH_FAKE_OAUTH: 'true', API_INTERNAL_SHARED_SECRET: TEST_INTERNAL_SECRET },
    jobs: {
      enqueue: (...args) =>
        failEnqueue ? Promise.reject(new Error('queue down')) : producer.enqueue(...args),
    },
  });
  off = await buildAuthTestApp(database.pool);
});
afterAll(async () => {
  await h.close();
  await off.close();
  await producer.stop();
  await worker.stop();
  await database.close();
});

const uniqueEmail = (label: string) => `${label}-${randomUUID().slice(0, 8)}@example.test`;
const sha256 = (value: string) => createHash('sha256').update(value).digest();

async function authorize(
  provider: Provider,
  body: Record<string, unknown> = {},
  app: AuthTestApp = h,
) {
  return app.app.inject({
    method: 'POST',
    url: `/auth/oauth/${provider}/authorize`,
    payload: body,
  });
}

async function startFlow(
  provider: Provider,
  body: Record<string, unknown> = {},
  headers: Record<string, string> = {},
): Promise<string> {
  const response = await h.app.inject({
    method: 'POST',
    url: `/auth/oauth/${provider}/authorize`,
    headers,
    payload: body,
  });
  expect(response.statusCode).toBe(200);
  return OAuthAuthorizeResponse.parse(response.json()).state;
}

const callback = (
  provider: Provider,
  state: string,
  extra: { code?: FakeCode | string; error?: string },
  headers: Record<string, string> = {},
) =>
  h.app.inject({
    method: 'POST',
    url: `/auth/oauth/${provider}/callback`,
    headers,
    payload:
      extra.error === undefined
        ? {
            state,
            code: typeof extra.code === 'string' ? extra.code : fakeCode(extra.code as FakeCode),
          }
        : { state, error: extra.error },
  });

const errorOf = (response: { json(): unknown }) => ErrorResponse.parse(response.json()).error;

/** Starts a sign-in flow and returns the pending token for a first-time user. */
async function pendingFor(provider: Provider, code: FakeCode, returnTo?: string): Promise<string> {
  const state = await startFlow(provider, returnTo === undefined ? {} : { returnTo });
  const response = await callback(provider, state, { code });
  expect(response.statusCode).toBe(200);
  const body = OAuthCallbackResponse.parse(response.json());
  if (body.outcome !== 'pending_signup')
    throw new Error(`expected pending_signup, got ${body.outcome}`);
  return body.pendingToken;
}

const complete = (pendingToken: string, payload: Record<string, unknown> = {}) =>
  h.app.inject({
    method: 'POST',
    url: '/auth/oauth/complete',
    payload: { pendingToken, fullName: 'Aroha Ngata', sex: 'FEMALE', ...payload },
  });

const count = async (sql: string, values: unknown[] = []) =>
  Number((await database.pool.query<{ n: string }>(sql, values)).rows[0]?.n);

describe('authorize', () => {
  it('stores a hashed single-use state, encrypts the Google PKCE verifier and returns the provider URL', async () => {
    const response = await authorize('google', { returnTo: '/account?tab=1' });
    expect(response.statusCode).toBe(200);
    const { authorizationUrl, state } = OAuthAuthorizeResponse.parse(response.json());
    expect(state).toMatch(OAUTH_STATE_PATTERN);
    expect(new URL(authorizationUrl).searchParams.get('state')).toBe(state);
    const { rows } = await database.pool.query<{
      provider: string;
      intent: string;
      return_to: string;
      code_verifier_enc: string | null;
      nonce: string | null;
      link_user_id: string | null;
      expires_at: Date;
      created_at: Date;
    }>(`SELECT * FROM oauth_states WHERE state_hash = $1`, [sha256(state)]);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      provider: 'GOOGLE',
      intent: 'signin',
      return_to: '/account?tab=1',
      link_user_id: null,
    });
    expect(rows[0]?.code_verifier_enc).toMatch(ENVELOPE_PATTERN);
    expect(rows[0]?.nonce).not.toBeNull();
    expect(rows[0]!.expires_at.getTime() - rows[0]!.created_at.getTime()).toBeLessThanOrEqual(
      10 * MINUTE,
    );
    const facebook = OAuthAuthorizeResponse.parse(
      (await authorize('facebook', { returnTo: 'https://evil.example/', rerequest: true })).json(),
    );
    const fbRow = await database.pool.query<{
      code_verifier_enc: string | null;
      return_to: string | null;
    }>(`SELECT code_verifier_enc, return_to FROM oauth_states WHERE state_hash = $1`, [
      sha256(facebook.state),
    ]);
    expect(fbRow.rows[0]).toEqual({ code_verifier_enc: null, return_to: '/' });
    expect(new URL(facebook.authorizationUrl).searchParams.get('auth_type')).toBe('rerequest');
  });

  it('answers 404 provider_not_enabled for a provider with no credentials, and /auth/providers reflects it (AC-ERROR-10)', async () => {
    const response = await authorize('google', {}, off);
    expect(response.statusCode).toBe(404);
    expect(errorOf(response).code).toBe('provider_not_enabled');
    expect((await off.app.inject({ method: 'GET', url: '/auth/providers' })).json()).toEqual({
      google: false,
      facebook: false,
    });
    expect((await h.app.inject({ method: 'GET', url: '/auth/providers' })).json()).toEqual({
      google: true,
      facebook: true,
    });
    const cb = await off.app.inject({
      method: 'POST',
      url: '/auth/oauth/facebook/callback',
      payload: { state: 'x', error: 'access_denied' },
    });
    expect(cb.statusCode).toBe(404);
  });

  it('rejects an unknown body field and an unknown provider with 422', async () => {
    expect((await authorize('google', { role: 'GLOBAL_ADMIN' })).statusCode).toBe(422);
    const unknown = await h.app.inject({
      method: 'POST',
      url: '/auth/oauth/twitter/authorize',
      payload: {},
    });
    expect(unknown.statusCode).toBe(422);
  });
});

describe('first-time sign-up: pending then complete (AC-HAPPY-3, AC-HAPPY-4, AC-ENTRY-8)', () => {
  it('Google: creates only a pending sign-up, then user + identity + session on completion with a required sex', async () => {
    const email = uniqueEmail('google-new');
    const sub = `g-${randomUUID()}`;
    const users = await count(`SELECT count(*) AS n FROM users`);
    const pendingToken = await pendingFor(
      'google',
      { fixture: 'google-verified', sub, email, name: 'Aroha Ngata' },
      '/account',
    );
    expect(await count(`SELECT count(*) AS n FROM users`)).toBe(users); // no users row before the submit

    const pending = await h.app.inject({
      method: 'GET',
      url: '/auth/oauth/pending',
      headers: { 'x-pending-signup': pendingToken },
    });
    expect(OAuthPendingResponse.parse(pending.json())).toMatchObject({
      provider: 'GOOGLE',
      email,
      fullName: 'Aroha Ngata',
      returnTo: '/account',
    });
    // Sex is required and a 422 does not consume the pending sign-up.
    const noSex = await complete(pendingToken, { sex: undefined });
    expect(noSex.statusCode).toBe(422);
    expect(errorOf(noSex).fieldErrors).toHaveProperty('sex');
    expect(
      (
        await h.app.inject({
          method: 'GET',
          url: '/auth/oauth/pending',
          headers: { 'x-pending-signup': pendingToken },
        })
      ).statusCode,
    ).toBe(200);

    const done = await complete(pendingToken, { sex: 'FEMALE', fullName: 'Aroha N.' });
    expect(done.statusCode).toBe(201);
    const body = OAuthCompleteResponse.parse(done.json());
    expect(body).toMatchObject({
      returnTo: '/account',
      user: { email, fullName: 'Aroha N.', sex: 'FEMALE', role: 'PLAYER' },
    });
    const row = await database.pool.query<{ email_verified_at: Date | null }>(
      `SELECT email_verified_at FROM users WHERE id = $1`,
      [body.user.id],
    );
    expect(row.rows[0]?.email_verified_at).not.toBeNull(); // Google asserted email_verified
    const identity = await database.pool.query(
      `SELECT provider, provider_subject, password_hash FROM auth_identities WHERE user_id = $1`,
      [body.user.id],
    );
    expect(identity.rows).toEqual([
      { provider: 'GOOGLE', provider_subject: sub, password_hash: null },
    ]);
    const me = await h.app.inject({
      method: 'GET',
      url: '/auth/me',
      headers: bearer(body.session.token),
    });
    expect(me.statusCode).toBe(200);

    // Second tab (AC-ENTRY-8): the used pending sign-up does nothing a second time.
    const again = await complete(pendingToken);
    expect(again.statusCode).toBe(400);
    expect(errorOf(again).code).toBe('signup_expired');
    expect(await count(`SELECT count(*) AS n FROM users WHERE email = $1`, [email])).toBe(1);
  });

  it('Facebook: with an email creates the user on completion; email_verified_at stays null (no verification claim)', async () => {
    const email = uniqueEmail('fb-new');
    const sub = `fb-${randomUUID()}`;
    const token = await pendingFor('facebook', { fixture: 'facebook-with-email', sub, email });
    const done = await complete(token, { sex: 'OTHER' });
    expect(done.statusCode).toBe(201);
    const { user } = OAuthCompleteResponse.parse(done.json());
    const row = await database.pool.query<{ email_verified_at: Date | null }>(
      `SELECT email_verified_at FROM users WHERE id = $1`,
      [user.id],
    );
    expect(row.rows[0]?.email_verified_at).toBeNull();
    expect(
      await count(
        `SELECT count(*) AS n FROM auth_identities WHERE provider = 'FACEBOOK' AND provider_subject = $1`,
        [sub],
      ),
    ).toBe(1);
  });

  it('an expired pending sign-up leaves no user and answers 400 signup_expired everywhere (AC-ERROR-14)', async () => {
    const email = uniqueEmail('expiring');
    const token = await pendingFor('facebook', {
      fixture: 'facebook-with-email',
      sub: `fb-${randomUUID()}`,
      email,
    });
    h.clock.advance(16 * MINUTE);
    const pending = await h.app.inject({
      method: 'GET',
      url: '/auth/oauth/pending',
      headers: { 'x-pending-signup': token },
    });
    expect(pending.statusCode).toBe(400);
    expect(errorOf(pending).code).toBe('signup_expired');
    const done = await complete(token);
    expect(errorOf(done).code).toBe('signup_expired');
    expect(await count(`SELECT count(*) AS n FROM users WHERE email = $1`, [email])).toBe(0);
    const missing = await h.app.inject({ method: 'GET', url: '/auth/oauth/pending' });
    expect(missing.statusCode).toBe(422); // header is required by the contract; the web treats a missing cookie as expired itself
  });

  it('completion when the email was taken meanwhile is a 409 oauth_account_exists carrying the email (C4); when the identity appeared meanwhile it signs in (C3)', async () => {
    const email = uniqueEmail('late-conflict');
    const token = await pendingFor('google', {
      fixture: 'google-verified',
      sub: `g-${randomUUID()}`,
      email,
    });
    await createPasswordUser(h, { email });
    const conflict = await complete(token);
    expect(conflict.statusCode).toBe(409);
    expect(errorOf(conflict)).toMatchObject({ code: 'oauth_account_exists', email });

    const sub = `g-${randomUUID()}`;
    const email2 = uniqueEmail('twin-tabs');
    const tabA = await pendingFor('google', { fixture: 'google-verified', sub, email: email2 });
    const tabB = await pendingFor('google', { fixture: 'google-verified', sub, email: email2 });
    expect((await complete(tabA)).statusCode).toBe(201);
    const second = await complete(tabB);
    expect(second.statusCode).toBe(200); // C3: signed in as the identity's owner, nothing created twice
    expect(OAuthCompleteResponse.parse(second.json()).user.email).toBe(email2);
    expect(await count(`SELECT count(*) AS n FROM users WHERE email = $1`, [email2])).toBe(1);
  });
});

describe('callback: returning user, conflicts and failures', () => {
  it('signs a returning OAuth user in directly (AC-HAPPY-5): last_used_at updated, no new rows, a presented session is replaced', async () => {
    const userId = await insertUser(database.pool, 'MALE');
    const sub = `g-${randomUUID()}`;
    await database.pool.query(
      `INSERT INTO auth_identities (user_id, provider, provider_subject) VALUES ($1, 'GOOGLE', $2)`,
      [userId, sub],
    );
    const users = await count(`SELECT count(*) AS n FROM users`);
    const identities = await count(`SELECT count(*) AS n FROM auth_identities`);
    const state = await startFlow('google', { returnTo: '/teams' });
    const response = await callback('google', state, {
      code: { fixture: 'google-verified', sub, email: uniqueEmail('whatever') },
    });
    expect(response.statusCode).toBe(200);
    const body = OAuthCallbackResponse.parse(response.json());
    expect(body).toMatchObject({ outcome: 'signed_in', returnTo: '/teams' });
    expect(await count(`SELECT count(*) AS n FROM users`)).toBe(users);
    expect(await count(`SELECT count(*) AS n FROM auth_identities`)).toBe(identities);
    const used = await database.pool.query<{ last_used_at: Date | null }>(
      `SELECT last_used_at FROM auth_identities WHERE provider_subject = $1`,
      [sub],
    );
    expect(used.rows[0]?.last_used_at).not.toBeNull();
    if (body.outcome !== 'signed_in') throw new Error('unreachable');
    // Signing in again while holding that session replaces (revokes) it.
    const state2 = await startFlow('google');
    const second = await callback(
      'google',
      state2,
      { code: { fixture: 'google-verified', sub } },
      bearer(body.session.token),
    );
    expect(second.statusCode).toBe(200);
    const old = await h.app.inject({
      method: 'GET',
      url: '/auth/me',
      headers: bearer(body.session.token),
    });
    expect(old.statusCode).toBe(401);
    const revoked = await database.pool.query<{ revoked_reason: string }>(
      `SELECT revoked_reason FROM auth_sessions WHERE user_id = $1 AND revoked_at IS NOT NULL`,
      [userId],
    );
    expect(revoked.rows[0]?.revoked_reason).toBe('replaced');
  });

  it('never signs in or links on an email match: 409 oauth_account_exists with no session and no identity (AC-ERROR-8, AC-ERROR-20)', async () => {
    const existing = await createPasswordUser(h);
    for (const [provider, fixture] of [
      ['google', 'google-verified'],
      ['facebook', 'facebook-with-email'],
    ] as const) {
      const before = await count(`SELECT count(*) AS n FROM auth_identities WHERE user_id = $1`, [
        existing.id,
      ]);
      const state = await startFlow(provider);
      const response = await callback(provider, state, {
        code: { fixture, sub: `s-${randomUUID()}`, email: existing.email.toUpperCase() },
      });
      expect(response.statusCode).toBe(409);
      expect(errorOf(response)).toMatchObject({
        code: 'oauth_account_exists',
        email: existing.email,
      });
      expect(response.json()).not.toHaveProperty('session');
      expect(
        await count(`SELECT count(*) AS n FROM auth_identities WHERE user_id = $1`, [existing.id]),
      ).toBe(before);
      expect(
        await count(`SELECT count(*) AS n FROM auth_sessions WHERE user_id = $1`, [existing.id]),
      ).toBe(0);
    }
    expect(h.logs.lines().some((line) => line.event === 'auth.oauth.conflict')).toBe(true);
  });

  it('blocks a first-time Facebook user without an email, but a known Facebook identity still signs in (AC-ERROR-9)', async () => {
    const users = await count(`SELECT count(*) AS n FROM users`);
    const state = await startFlow('facebook');
    const blocked = await callback('facebook', state, {
      code: { fixture: 'facebook-no-email', sub: `fb-${randomUUID()}` },
    });
    expect(blocked.statusCode).toBe(422);
    expect(errorOf(blocked).code).toBe('oauth_email_missing');
    expect(await count(`SELECT count(*) AS n FROM users`)).toBe(users);

    const userId = await insertUser(database.pool, 'MALE');
    const sub = `fb-${randomUUID()}`;
    await database.pool.query(
      `INSERT INTO auth_identities (user_id, provider, provider_subject) VALUES ($1, 'FACEBOOK', $2)`,
      [userId, sub],
    );
    const known = await callback('facebook', await startFlow('facebook'), {
      code: { fixture: 'facebook-no-email', sub },
    });
    expect(known.statusCode).toBe(200);
    expect(OAuthCallbackResponse.parse(known.json()).outcome).toBe('signed_in');
  });

  it('blocks a Google account whose email is unverified with 422 oauth_email_unverified (AC-ERROR-9)', async () => {
    const response = await callback('google', await startFlow('google'), {
      code: { fixture: 'google-unverified', sub: `g-${randomUUID()}`, email: uniqueEmail('unv') },
    });
    expect(response.statusCode).toBe(422);
    expect(errorOf(response).code).toBe('oauth_email_unverified');
  });

  it('handles cancellation, unknown, replayed and expired states, and a refused code (AC-ERROR-7)', async () => {
    const cancelled = await callback('google', await startFlow('google'), {
      error: 'access_denied',
    });
    expect(cancelled.statusCode).toBe(400);
    expect(errorOf(cancelled).code).toBe('oauth_cancelled');

    const state = await startFlow('google');
    const code: FakeCode = {
      fixture: 'google-verified',
      sub: `g-${randomUUID()}`,
      email: uniqueEmail('replay'),
    };
    expect((await callback('google', state, { code })).statusCode).toBe(200);
    const replay = await callback('google', state, { code });
    expect(replay.statusCode).toBe(400);
    expect(errorOf(replay).code).toBe('oauth_state_invalid');

    const unknown = await callback('google', 'A'.repeat(43), { code });
    expect(errorOf(unknown).code).toBe('oauth_state_invalid');
    // A state issued for Google cannot be redeemed at the Facebook callback (and is then spent).
    const wrongProvider = await callback('facebook', await startFlow('google'), {
      code: { fixture: 'facebook-with-email' },
    });
    expect(errorOf(wrongProvider).code).toBe('oauth_state_invalid');

    const stale = await startFlow('google');
    h.clock.advance(11 * MINUTE);
    expect(errorOf(await callback('google', stale, { code })).code).toBe('oauth_state_invalid');

    const refused = await callback('google', await startFlow('google'), {
      code: 'not-a-fake-code',
    });
    expect(errorOf(refused).code).toBe('oauth_state_invalid');
  });

  it('consumes a state exactly once under concurrency (guarded UPDATE)', async () => {
    const state = await startFlow('google');
    const code: FakeCode = {
      fixture: 'google-verified',
      sub: `g-${randomUUID()}`,
      email: uniqueEmail('race'),
    };
    const results = await Promise.all(
      Array.from({ length: 8 }, () => callback('google', state, { code })),
    );
    expect(results.filter((r) => r.statusCode === 200)).toHaveLength(1);
    expect(results.filter((r) => r.statusCode === 400)).toHaveLength(7);
    expect(
      await count(`SELECT count(*) AS n FROM oauth_pending_signups WHERE email = $1`, [code.email]),
    ).toBe(1);
  });
});

describe('link, identities and unlink (AC-HAPPY-11, AC-HAPPY-12, AC-ERROR-17, AC-ASYNC-5)', () => {
  const linkFlow = async (provider: Provider, token: string) => {
    const response = await h.app.inject({
      method: 'POST',
      url: `/auth/identities/${provider}/link`,
      headers: bearer(token),
    });
    expect(response.statusCode).toBe(200);
    return OAuthAuthorizeResponse.parse(response.json()).state;
  };

  it('requires a session to start a link and a session of the same user to finish it', async () => {
    expect(
      (await h.app.inject({ method: 'POST', url: '/auth/identities/google/link' })).statusCode,
    ).toBe(401);
    const owner = await createPasswordUser(h);
    const other = await createPasswordUser(h);
    const ownerToken = await sessionFor(h, owner);
    const state = await linkFlow('google', ownerToken);
    const anonymous = await callback('google', state, {
      code: { fixture: 'google-verified', sub: `g-${randomUUID()}` },
    });
    expect(anonymous.statusCode).toBe(401);
    expect(errorOf(anonymous).code).toBe('session_expired');
    const state2 = await linkFlow('google', ownerToken);
    const mismatch = await callback(
      'google',
      state2,
      { code: { fixture: 'google-verified', sub: `g-${randomUUID()}` } },
      bearer(await sessionFor(h, other)),
    );
    expect(mismatch.statusCode).toBe(403);
    expect(errorOf(mismatch).code).toBe('link_session_mismatch');
    expect(
      await count(
        `SELECT count(*) AS n FROM auth_identities WHERE user_id = ANY($1) AND provider = 'GOOGLE'`,
        [[owner.id, other.id]],
      ),
    ).toBe(0);
  });

  it('links a second method, enqueues the security notice in the same transaction and is idempotent (already_linked)', async () => {
    const user = await createPasswordUser(h);
    const token = await sessionFor(h, user);
    const sub = `g-${randomUUID()}`;
    const code: FakeCode = { fixture: 'google-verified', sub, email: user.email };
    const linked = await callback(
      'google',
      await linkFlow('google', token),
      { code },
      bearer(token),
    );
    expect(
      linked.statusCode,
      JSON.stringify(h.logs.lines().filter((l) => l.level === 'error' || l.level === 50)),
    ).toBe(200);
    expect(OAuthCallbackResponse.parse(linked.json())).toEqual({
      outcome: 'linked',
      returnTo: '/account',
    });
    const identity = await database.pool.query<{ id: string }>(
      `SELECT id FROM auth_identities WHERE user_id = $1 AND provider = 'GOOGLE'`,
      [user.id],
    );
    expect(identity.rows).toHaveLength(1);
    expect(await count(`SELECT count(*) AS n FROM users WHERE email = $1`, [user.email])).toBe(1);
    const verified = await database.pool.query<{ email_verified_at: Date | null }>(
      `SELECT email_verified_at FROM users WHERE id = $1`,
      [user.id],
    );
    expect(verified.rows[0]?.email_verified_at).not.toBeNull();

    const job = await database.pool.query<{
      data: {
        to: string;
        subject: string;
        text: string;
        idempotencyKey: string;
        tags: { template: string };
      };
    }>(`SELECT data FROM pgboss.job WHERE name = 'send-email' AND singleton_key = $1`, [
      `notify:identity-linked:${identity.rows[0]?.id}`,
    ]);
    expect(job.rows).toHaveLength(1);
    expect(job.rows[0]?.data).toMatchObject({
      to: user.email,
      subject: 'Google sign-in connected to your Shared Game Management account',
      tags: { template: 'identity-linked' },
    });
    expect(job.rows[0]?.data.text).toContain("If this wasn't you, reset your password now");
    // The worker delivers it (Mailpit in the real stack; the in-memory notifier here).
    const delivered = await waitFor(
      () =>
        memory.sent.find(
          (mail) => mail.idempotencyKey === `identity-linked:${identity.rows[0]?.id}`,
        ),
      { label: 'identity-linked email' },
    );
    expect(delivered.to).toBe(user.email);

    const again = await callback(
      'google',
      await linkFlow('google', token),
      { code },
      bearer(token),
    );
    expect(OAuthCallbackResponse.parse(again.json()).outcome).toBe('already_linked');
    expect(
      await count(
        `SELECT count(*) AS n FROM pgboss.job WHERE name = 'send-email' AND singleton_key = $1`,
        [`notify:identity-linked:${identity.rows[0]?.id}`],
      ),
    ).toBe(1);
  });

  it('rolls the link back when the notice cannot be enqueued', async () => {
    const user = await createPasswordUser(h);
    const token = await sessionFor(h, user);
    const state = await linkFlow('facebook', token);
    failEnqueue = true;
    try {
      const response = await callback(
        'facebook',
        state,
        { code: { fixture: 'facebook-with-email', sub: `fb-${randomUUID()}` } },
        bearer(token),
      );
      expect(response.statusCode).toBe(500);
    } finally {
      failEnqueue = false;
    }
    expect(
      await count(
        `SELECT count(*) AS n FROM auth_identities WHERE user_id = $1 AND provider = 'FACEBOOK'`,
        [user.id],
      ),
    ).toBe(0);
  });

  it('refuses an identity already in use (identity_in_use) and a second account of the same provider (provider_already_connected)', async () => {
    const holder = await insertUser(database.pool, 'MALE');
    const heldSub = `g-${randomUUID()}`;
    await database.pool.query(
      `INSERT INTO auth_identities (user_id, provider, provider_subject) VALUES ($1, 'GOOGLE', $2)`,
      [holder, heldSub],
    );
    const user = await createPasswordUser(h);
    const token = await sessionFor(h, user);
    const inUse = await callback(
      'google',
      await linkFlow('google', token),
      { code: { fixture: 'google-verified', sub: heldSub } },
      bearer(token),
    );
    expect(inUse.statusCode).toBe(409);
    expect(errorOf(inUse).code).toBe('identity_in_use');
    expect(JSON.stringify(inUse.json())).not.toContain(holder);

    await insertOAuthIdentity(database.pool, user.id, 'FACEBOOK');
    const second = await callback(
      'facebook',
      await linkFlow('facebook', token),
      { code: { fixture: 'facebook-with-email', sub: `fb-${randomUUID()}` } },
      bearer(token),
    );
    expect(second.statusCode).toBe(409);
    expect(errorOf(second).code).toBe('provider_already_connected');
    expect(h.logs.lines().some((line) => line.event === 'auth.oauth.link_conflict')).toBe(true);
  });

  it('lists identities with enabled providers, unlinks one, and refuses the last method with 409 last_sign_in_method', async () => {
    expect((await h.app.inject({ method: 'GET', url: '/auth/identities' })).statusCode).toBe(401);
    const user = await createPasswordUser(h);
    await insertOAuthIdentity(database.pool, user.id, 'GOOGLE');
    const token = await sessionFor(h, user);
    const listed = IdentitiesResponse.parse(
      (
        await h.app.inject({ method: 'GET', url: '/auth/identities', headers: bearer(token) })
      ).json(),
    );
    expect(listed.identities.map((i) => i.provider).sort()).toEqual(['GOOGLE', 'PASSWORD']);
    expect(listed.enabledProviders).toEqual({ google: true, facebook: true });

    const removed = await h.app.inject({
      method: 'DELETE',
      url: '/auth/identities/google',
      headers: bearer(token),
    });
    expect(removed.statusCode).toBe(204);
    expect(
      await count(`SELECT count(*) AS n FROM auth_identities WHERE user_id = $1`, [user.id]),
    ).toBe(1);
    const missing = await h.app.inject({
      method: 'DELETE',
      url: '/auth/identities/google',
      headers: bearer(token),
    });
    expect(missing.statusCode).toBe(404);

    // Only the PASSWORD identity left: it cannot be removed through this endpoint at all, and an OAuth-only user keeps the last one.
    const oauthOnly = await insertUser(database.pool, 'MALE');
    await insertOAuthIdentity(database.pool, oauthOnly, 'FACEBOOK');
    const onlySession = await insertAuthSession(database.pool, oauthOnly, {
      createdAt: h.clock.now(),
    });
    const last = await h.app.inject({
      method: 'DELETE',
      url: '/auth/identities/facebook',
      headers: bearer(onlySession.token),
    });
    expect(last.statusCode).toBe(409);
    expect(errorOf(last).code).toBe('last_sign_in_method');
    expect(
      await count(`SELECT count(*) AS n FROM auth_identities WHERE user_id = $1`, [oauthOnly]),
    ).toBe(1);
  });
});

describe('log hygiene on the OAuth callback (AC-VERIFY-6)', () => {
  it('writes auth.oauth events with a traceable shape and no state, code, token, verifier or email', async () => {
    const email = uniqueEmail('hygiene');
    const state = await startFlow('google');
    const code = fakeCode({ fixture: 'google-verified', sub: `g-${randomUUID()}`, email });
    const response = await h.app.inject({
      method: 'POST',
      url: '/auth/oauth/google/callback',
      payload: { state, code },
    });
    const { pendingToken } = response.json<{ pendingToken: string }>();
    const done = await complete(pendingToken);
    const session = OAuthCompleteResponse.parse(done.json()).session.token;
    const text = h.logs
      .lines()
      .map((line) => JSON.stringify(line))
      .join('\n');
    for (const secret of [state, code, pendingToken, session, TEST_INTERNAL_SECRET, email]) {
      expect(text, `log leaked a secret of length ${secret.length}`).not.toContain(secret);
    }
    const events = new Set(h.logs.lines().map((line) => line.event));
    for (const event of ['auth.oauth.started', 'auth.oauth.pending.created', 'auth.register'])
      expect(events.has(event), event).toBe(true);
  });
});
