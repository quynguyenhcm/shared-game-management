/** Builds the enabled providers from config; `AUTH_FAKE_OAUTH` swaps in both fakes (refused in production). */
import { createRemoteJWKSet, type JWTVerifyGetKey } from 'jose';
import type { AuthConfig } from '../../../lib/config/config.ts';
import { createFacebookProvider } from './facebook.ts';
import { createFakeProvider } from './fake.ts';
import { GOOGLE_JWKS_URI, createGoogleProvider } from './google.ts';
import type {
  FetchLike,
  OAuthProvider,
  OAuthProviderName,
  OAuthProviderRegistry,
} from './provider.ts';

export interface RegistryOptions {
  readonly auth: Pick<AuthConfig, 'google' | 'facebook' | 'fakeOAuth'>;
  readonly nodeEnv?: string;
  readonly fetch?: FetchLike;
  /** Test seam: replaces Google's remote JWKS. */
  readonly googleJwks?: JWTVerifyGetKey;
}

export function buildOAuthProviders(options: RegistryOptions): OAuthProviderRegistry {
  const providers = new Map<OAuthProviderName, OAuthProvider>();
  if (options.auth.fakeOAuth) {
    if (options.nodeEnv === 'production') {
      throw new Error('AUTH_FAKE_OAUTH must not be enabled in production');
    }
    providers.set('GOOGLE', createFakeProvider('GOOGLE'));
    providers.set('FACEBOOK', createFakeProvider('FACEBOOK'));
  } else {
    const { google, facebook } = options.auth;
    if (google !== null) {
      providers.set(
        'GOOGLE',
        createGoogleProvider({
          clientId: google.clientId,
          clientSecret: google.clientSecret,
          jwks: options.googleJwks ?? createRemoteJWKSet(new URL(GOOGLE_JWKS_URI)),
          ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
        }),
      );
    }
    if (facebook !== null) {
      providers.set(
        'FACEBOOK',
        createFacebookProvider({
          appId: facebook.appId,
          appSecret: facebook.appSecret,
          ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
        }),
      );
    }
  }
  return {
    get: (name) => providers.get(name),
    enabled: () => ({ google: providers.has('GOOGLE'), facebook: providers.has('FACEBOOK') }),
  };
}
