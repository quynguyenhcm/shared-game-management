/** AC-INTEGRATION-3: adapters parse recorded provider payloads and reject bad tokens (no real network). */
import { createHmac } from 'node:crypto';
import { SignJWT, createLocalJWKSet, exportJWK, generateKeyPair, type JWK } from 'jose';
import { beforeAll, describe, expect, it } from 'vitest';
import facebookNoEmail from './fixtures/facebook-no-email.json' with { type: 'json' };
import facebookToken from './fixtures/facebook-token.json' with { type: 'json' };
import facebookWithEmail from './fixtures/facebook-with-email.json' with { type: 'json' };
import googleUnverified from './fixtures/google-unverified.json' with { type: 'json' };
import googleVerified from './fixtures/google-verified.json' with { type: 'json' };
import { GRAPH_VERSION, appSecretProof, createFacebookProvider } from './facebook.ts';
import { createFakeProvider, fakeCode } from './fake.ts';
import { createGoogleProvider } from './google.ts';
import { codeChallengeS256 } from './pkce.ts';
import { ProviderError, type FetchLike } from './provider.ts';
import { buildOAuthProviders } from './registry.ts';

const CLIENT_ID = 'client-id.apps.googleusercontent.com';
const NONCE = 'nonce-123';
const REDIRECT = 'https://games.example.nz/auth/callback/google';

type SigningKey = Awaited<ReturnType<typeof generateKeyPair>>['privateKey'];
let privateKey: SigningKey;
let otherPrivateKey: SigningKey;
let jwks: ReturnType<typeof createLocalJWKSet>;

beforeAll(async () => {
  const pair = await generateKeyPair('RS256');
  const other = await generateKeyPair('RS256');
  privateKey = pair.privateKey;
  otherPrivateKey = other.privateKey;
  const jwk: JWK = { ...(await exportJWK(pair.publicKey)), kid: 'k1', alg: 'RS256', use: 'sig' };
  jwks = createLocalJWKSet({ keys: [jwk] });
});

async function idToken(
  claims: Record<string, unknown>,
  options: { key?: SigningKey; iss?: string; aud?: string; exp?: string | number } = {},
): Promise<string> {
  return new SignJWT({ nonce: NONCE, ...claims })
    .setProtectedHeader({ alg: 'RS256', kid: 'k1' })
    .setIssuer(options.iss ?? 'https://accounts.google.com')
    .setAudience(options.aud ?? CLIENT_ID)
    .setIssuedAt()
    .setExpirationTime(options.exp ?? '5m')
    .sign(options.key ?? privateKey);
}

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

function googleWith(token: string, status = 200) {
  const calls: { url: string; body: string }[] = [];
  const fetchStub: FetchLike = (url, init) => {
    calls.push({
      url: String(url),
      body: init?.body instanceof URLSearchParams ? init.body.toString() : '',
    });
    return Promise.resolve(
      status === 200 ? json({ id_token: token, access_token: 'x' }) : json({}, status),
    );
  };
  const provider = createGoogleProvider({
    clientId: CLIENT_ID,
    clientSecret: 'secret',
    jwks,
    fetch: fetchStub,
  });
  return { provider, calls };
}
const exchange = (
  provider: ReturnType<typeof googleWith>['provider'],
  nonce: string | undefined = NONCE,
) =>
  provider.exchange({
    code: 'c',
    redirectUri: REDIRECT,
    codeVerifier: 'v'.repeat(43),
    ...(nonce === undefined ? {} : { nonce }),
  });

describe('Google adapter', () => {
  it('extracts subject, email, verification flag and name from a verified ID token, sending PKCE and the secret', async () => {
    const { provider, calls } = googleWith(await idToken(googleVerified));
    expect(await exchange(provider)).toEqual({
      provider: 'GOOGLE',
      subject: googleVerified.sub,
      email: 'aroha.ngata@example.com',
      emailVerified: true,
      fullName: 'Aroha Ngata',
    });
    expect(calls[0]?.body).toContain('code_verifier=');
    expect(calls[0]?.body).toContain('grant_type=authorization_code');
  });

  it('reports email_verified=false (and no email) faithfully', async () => {
    const { provider } = googleWith(await idToken(googleUnverified));
    expect(await exchange(provider)).toMatchObject({
      emailVerified: false,
      email: 'unverified.person@example.com',
    });
    const { provider: noEmail } = googleWith(await idToken({ sub: '1' }));
    expect(await exchange(noEmail)).toMatchObject({ email: null, emailVerified: false });
  });

  it('rejects a bad signature, wrong audience, wrong issuer, wrong nonce and an expired token', async () => {
    const cases: [string, string][] = [
      ['signature', await idToken(googleVerified, { key: otherPrivateKey })],
      ['audience', await idToken(googleVerified, { aud: 'someone-else' })],
      ['issuer', await idToken(googleVerified, { iss: 'https://evil.example' })],
      ['expired', await idToken(googleVerified, { exp: Math.floor(Date.now() / 1000) - 3600 })],
    ];
    for (const [label, token] of cases) {
      await expect(exchange(googleWith(token).provider), label).rejects.toMatchObject({
        kind: 'invalid_response',
      });
    }
    await expect(
      exchange(googleWith(await idToken(googleVerified)).provider, 'another-nonce'),
    ).rejects.toMatchObject({
      kind: 'invalid_response',
    });
    await expect(
      googleWith(await idToken(googleVerified)).provider.exchange({
        code: 'c',
        redirectUri: REDIRECT,
      }),
    ).rejects.toBeInstanceOf(ProviderError);
  });

  it('maps provider outages to unavailable and refusals to rejected; builds a PKCE S256 URL', async () => {
    await expect(exchange(googleWith('', 503).provider)).rejects.toMatchObject({
      kind: 'unavailable',
    });
    await expect(exchange(googleWith('', 400).provider)).rejects.toMatchObject({
      kind: 'rejected',
    });
    const failing = createGoogleProvider({
      clientId: CLIENT_ID,
      clientSecret: 's',
      jwks,
      fetch: () => Promise.reject(new Error('socket hang up')),
    });
    await expect(exchange(failing)).rejects.toMatchObject({ kind: 'unavailable' });
    const url = googleWith('').provider.authorizationUrl({
      state: 's',
      redirectUri: REDIRECT,
      nonce: NONCE,
      codeChallenge: codeChallengeS256('v'.repeat(43)),
    });
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
    expect(url.searchParams.get('scope')).toBe('openid email profile');
    expect(url.searchParams.get('nonce')).toBe(NONCE);
  });

  it('does not keep a transport error (whose message may embed the token-exchange URL) as the cause', async () => {
    const secretUrl = `${'https://graph.facebook.com/v26.0/oauth/access_token'}?client_secret=APP-SECRET-X&code=CODE-X`;
    const facebook = createFacebookProvider({
      appId: '1',
      appSecret: 'APP-SECRET-X',
      fetch: () => Promise.reject(new TypeError(`fetch failed: ${secretUrl}`)),
    });
    const error = await facebook
      .exchange({ code: 'CODE-X', redirectUri: 'https://games.example.nz/cb' })
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ProviderError);
    const text = JSON.stringify(error, Object.getOwnPropertyNames(error)) + String(error);
    expect(text).not.toContain('APP-SECRET-X');
    expect(text).not.toContain('CODE-X');
    expect((error as ProviderError).cause).toBeUndefined();
  });
});

describe('Facebook adapter', () => {
  function facebookWith(me: unknown, meStatus = 200) {
    const calls: { url: URL; headers: Record<string, string> }[] = [];
    const fetchStub: FetchLike = (url, init) => {
      const parsed = new URL(String(url));
      calls.push({ url: parsed, headers: (init?.headers ?? {}) as Record<string, string> });
      return Promise.resolve(
        parsed.pathname.endsWith('/oauth/access_token') ? json(facebookToken) : json(me, meStatus),
      );
    };
    return {
      provider: createFacebookProvider({ appId: 'app', appSecret: 'shh', fetch: fetchStub }),
      calls,
    };
  }

  it('parses /me, lower-cases the email and never claims verification; sends appsecret_proof on the pinned version', async () => {
    const { provider, calls } = facebookWith(facebookWithEmail);
    const profile = await provider.exchange({
      code: 'c',
      redirectUri: 'https://games.example.nz/auth/callback/facebook',
    });
    expect(profile).toEqual({
      provider: 'FACEBOOK',
      subject: facebookWithEmail.id,
      email: 'aroha.ngata@example.com',
      emailVerified: false,
      fullName: 'Aroha Ngata',
    });
    const me = calls[1]?.url;
    expect(GRAPH_VERSION).toMatch(/^v\d+\.\d+$/);
    expect(me?.pathname).toBe(`/${GRAPH_VERSION}/me`);
    expect(me?.searchParams.get('fields')).toBe('id,name,email');
    expect(me?.searchParams.get('appsecret_proof')).toBe(
      createHmac('sha256', 'shh').update(facebookToken.access_token).digest('hex'),
    );
    expect(me?.searchParams.get('appsecret_proof')).toBe(
      appSecretProof(facebookToken.access_token, 'shh'),
    );
    expect(me?.search).not.toContain(facebookToken.access_token); // the token is in the header, not the URL
  });

  it('returns a null email when Facebook shares none, and rejects a body without an id', async () => {
    const { provider } = facebookWith(facebookNoEmail);
    expect(await provider.exchange({ code: 'c', redirectUri: 'r' })).toMatchObject({
      email: null,
      subject: facebookNoEmail.id,
    });
    await expect(
      facebookWith({ name: 'x' }).provider.exchange({ code: 'c', redirectUri: 'r' }),
    ).rejects.toMatchObject({
      kind: 'invalid_response',
    });
    await expect(
      facebookWith({}, 500).provider.exchange({ code: 'c', redirectUri: 'r' }),
    ).rejects.toMatchObject({ kind: 'unavailable' });
  });

  it('adds auth_type=rerequest only when asked', () => {
    const { provider } = facebookWith({});
    const input = { state: 's', redirectUri: 'https://games.example.nz/auth/callback/facebook' };
    expect(provider.authorizationUrl(input).searchParams.get('auth_type')).toBeNull();
    expect(
      provider.authorizationUrl({ ...input, rerequest: true }).searchParams.get('auth_type'),
    ).toBe('rerequest');
    expect(provider.authorizationUrl(input).searchParams.get('scope')).toBe('email,public_profile');
  });
});

describe('fake provider and registry', () => {
  it('maps the shared fixtures, with per-run overrides, and refuses a fixture of the other provider', async () => {
    const google = createFakeProvider('GOOGLE');
    const profile = await google.exchange({
      code: fakeCode({ fixture: 'google-verified', sub: 'g-1', email: 'Fresh@Example.com' }),
      redirectUri: 'r',
    });
    expect(profile).toMatchObject({
      subject: 'g-1',
      email: 'fresh@example.com',
      emailVerified: true,
    });
    await expect(
      google.exchange({ code: fakeCode({ fixture: 'facebook-with-email' }), redirectUri: 'r' }),
    ).rejects.toMatchObject({ kind: 'rejected' });
    await expect(google.exchange({ code: 'garbage', redirectUri: 'r' })).rejects.toMatchObject({
      kind: 'rejected',
    });
  });

  it('enables providers from credentials, both fakes in fake mode, and refuses fake mode in production', () => {
    const none = buildOAuthProviders({ auth: { google: null, facebook: null, fakeOAuth: false } });
    expect(none.enabled()).toEqual({ google: false, facebook: false });
    const some = buildOAuthProviders({
      auth: { google: null, facebook: { appId: 'a', appSecret: 's' }, fakeOAuth: false },
    });
    expect(some.enabled()).toEqual({ google: false, facebook: true });
    expect(
      buildOAuthProviders({ auth: { google: null, facebook: null, fakeOAuth: true } }).enabled(),
    ).toEqual({ google: true, facebook: true });
    expect(() =>
      buildOAuthProviders({
        auth: { google: null, facebook: null, fakeOAuth: true },
        nodeEnv: 'production',
      }),
    ).toThrow();
  });
});
