/**
 * Test-only provider selected by `AUTH_FAKE_OAUTH=true` (architecture Q8); the config refuses it in production
 * and the registry refuses it again. `code` grammar: `fake.<base64url JSON {fixture, sub?, email?, name?}>`.
 * Profiles come from the same recorded fixtures the real adapters' unit tests parse. The authorization URL
 * points at a reserved host that never resolves; Playwright plays the consent screen.
 */
import { z } from 'zod';
import facebookNoEmail from './fixtures/facebook-no-email.json' with { type: 'json' };
import facebookWithEmail from './fixtures/facebook-with-email.json' with { type: 'json' };
import googleUnverified from './fixtures/google-unverified.json' with { type: 'json' };
import googleVerified from './fixtures/google-verified.json' with { type: 'json' };
import { profileFromGraphMe } from './facebook.ts';
import { profileFromGoogleClaims } from './google.ts';
import {
  ProviderError,
  type AuthorizationInput,
  type ExchangeInput,
  type OAuthProvider,
  type OAuthProviderName,
  type ProviderProfile,
} from './provider.ts';

export const FAKE_AUTHORIZATION_HOST = 'https://oauth.fake.invalid/authorize';

const FakeCode = z.strictObject({
  fixture: z.enum([
    'google-verified',
    'google-unverified',
    'facebook-with-email',
    'facebook-no-email',
  ]),
  sub: z.string().min(1).max(255).optional(),
  email: z.string().min(1).optional(),
  name: z.string().optional(),
});
export type FakeCode = z.infer<typeof FakeCode>;

/** Builds a `code` the fake provider accepts (used by integration tests and Playwright). */
export function fakeCode(payload: FakeCode): string {
  return `fake.${Buffer.from(JSON.stringify(payload)).toString('base64url')}`;
}

function decode(code: string): FakeCode {
  const [prefix, body, ...rest] = code.split('.');
  if (prefix !== 'fake' || body === undefined || rest.length > 0) {
    throw new ProviderError('rejected', 'not a fake code');
  }
  try {
    return FakeCode.parse(JSON.parse(Buffer.from(body, 'base64url').toString('utf8')));
  } catch (error) {
    throw new ProviderError('rejected', 'malformed fake code', { cause: error });
  }
}

function profileFor(provider: OAuthProviderName, payload: FakeCode): ProviderProfile {
  const isGoogle = payload.fixture.startsWith('google');
  if (isGoogle !== (provider === 'GOOGLE')) {
    throw new ProviderError('rejected', 'fixture belongs to the other provider');
  }
  const base = (() => {
    switch (payload.fixture) {
      case 'google-verified':
        return profileFromGoogleClaims({
          ...googleVerified,
          ...(payload.sub === undefined ? {} : { sub: payload.sub }),
          ...(payload.email === undefined ? {} : { email: payload.email }),
          ...(payload.name === undefined ? {} : { name: payload.name }),
        });
      case 'google-unverified':
        return profileFromGoogleClaims({
          ...googleUnverified,
          ...(payload.sub === undefined ? {} : { sub: payload.sub }),
          ...(payload.email === undefined ? {} : { email: payload.email }),
          ...(payload.name === undefined ? {} : { name: payload.name }),
        });
      case 'facebook-with-email':
        return profileFromGraphMe({
          ...facebookWithEmail,
          ...(payload.sub === undefined ? {} : { id: payload.sub }),
          ...(payload.email === undefined ? {} : { email: payload.email }),
          ...(payload.name === undefined ? {} : { name: payload.name }),
        });
      case 'facebook-no-email':
        return profileFromGraphMe({
          ...facebookNoEmail,
          ...(payload.sub === undefined ? {} : { id: payload.sub }),
          ...(payload.name === undefined ? {} : { name: payload.name }),
        });
    }
  })();
  return base;
}

export function createFakeProvider(provider: OAuthProviderName): OAuthProvider {
  return {
    name: provider,
    usesPkce: provider === 'GOOGLE',
    authorizationUrl(input: AuthorizationInput): URL {
      const url = new URL(FAKE_AUTHORIZATION_HOST);
      url.searchParams.set('provider', provider.toLowerCase());
      url.searchParams.set('state', input.state);
      url.searchParams.set('redirect_uri', input.redirectUri);
      if (input.rerequest === true) url.searchParams.set('auth_type', 'rerequest');
      return url;
    },
    exchange(input: ExchangeInput): Promise<ProviderProfile> {
      try {
        return Promise.resolve(profileFor(provider, decode(input.code)));
      } catch (error) {
        return Promise.reject(error instanceof Error ? error : new Error('fake provider failed'));
      }
    },
  };
}
