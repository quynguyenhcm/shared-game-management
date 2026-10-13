/**
 * Google adapter: authorization-code flow with PKCE (S256) and a nonce. The ID token from the token endpoint
 * is verified with `jose` (signature via the injected JWKS resolver, `iss`, `aud`, `exp`) and its nonce is
 * checked here. Only `sub`, `email`, `email_verified` and `name` are read; the access token is discarded.
 */
import { jwtVerify, type JWTVerifyGetKey } from 'jose';
import { z } from 'zod';
import {
  ProviderError,
  failFromStatus,
  providerFetch,
  type AuthorizationInput,
  type ExchangeInput,
  type FetchLike,
  type OAuthProvider,
  type ProviderProfile,
} from './provider.ts';

export const GOOGLE_AUTHORIZATION_ENDPOINT = 'https://accounts.google.com/o/oauth2/v2/auth';
export const GOOGLE_TOKEN_ENDPOINT = 'https://oauth2.googleapis.com/token';
export const GOOGLE_JWKS_URI = 'https://www.googleapis.com/oauth2/v3/certs';
export const GOOGLE_ISSUERS = ['https://accounts.google.com', 'accounts.google.com'];

const TokenResponse = z.object({ id_token: z.string().min(1) });

const GoogleClaims = z.object({
  sub: z.string().min(1).max(255),
  email: z.string().min(1).optional(),
  email_verified: z.union([z.boolean(), z.enum(['true', 'false'])]).optional(),
  name: z.string().optional(),
  nonce: z.string().optional(),
});
export type GoogleClaims = z.infer<typeof GoogleClaims>;

/** Normalises verified ID-token claims (or a fixture of them) into a profile. Throws `invalid_response`. */
export function profileFromGoogleClaims(claims: unknown): ProviderProfile {
  const parsed = GoogleClaims.safeParse(claims);
  if (!parsed.success) throw new ProviderError('invalid_response', 'unexpected Google claims');
  const { sub, email, email_verified, name } = parsed.data;
  return {
    provider: 'GOOGLE',
    subject: sub,
    email: email === undefined ? null : email.toLowerCase(),
    emailVerified: email_verified === true || email_verified === 'true',
    fullName: name === undefined || name.trim() === '' ? null : name.trim(),
  };
}

export interface GoogleProviderOptions {
  readonly clientId: string;
  readonly clientSecret: string;
  readonly fetch?: FetchLike;
  /** Resolves signing keys: `createRemoteJWKSet(GOOGLE_JWKS_URI)` in production, a local set in tests. */
  readonly jwks: JWTVerifyGetKey;
}

export function createGoogleProvider(options: GoogleProviderOptions): OAuthProvider {
  const fetchImpl = options.fetch ?? fetch;
  return {
    name: 'GOOGLE',
    usesPkce: true,
    authorizationUrl(input: AuthorizationInput): URL {
      const url = new URL(GOOGLE_AUTHORIZATION_ENDPOINT);
      url.searchParams.set('client_id', options.clientId);
      url.searchParams.set('redirect_uri', input.redirectUri);
      url.searchParams.set('response_type', 'code');
      url.searchParams.set('scope', 'openid email profile');
      url.searchParams.set('state', input.state);
      if (input.nonce !== undefined) url.searchParams.set('nonce', input.nonce);
      if (input.codeChallenge !== undefined) {
        url.searchParams.set('code_challenge', input.codeChallenge);
        url.searchParams.set('code_challenge_method', 'S256');
      }
      return url;
    },
    async exchange(input: ExchangeInput): Promise<ProviderProfile> {
      const body = new URLSearchParams({
        code: input.code,
        client_id: options.clientId,
        client_secret: options.clientSecret,
        redirect_uri: input.redirectUri,
        grant_type: 'authorization_code',
      });
      if (input.codeVerifier !== undefined) body.set('code_verifier', input.codeVerifier);
      const response = await providerFetch(fetchImpl, GOOGLE_TOKEN_ENDPOINT, {
        method: 'POST',
        headers: {
          'content-type': 'application/x-www-form-urlencoded',
          accept: 'application/json',
        },
        body,
      });
      if (!response.ok) failFromStatus(response.status);
      const token = TokenResponse.safeParse(await response.json().catch(() => null));
      if (!token.success)
        throw new ProviderError('invalid_response', 'no id_token in token response');
      let claims: unknown;
      try {
        const verified = await jwtVerify(token.data.id_token, options.jwks, {
          issuer: GOOGLE_ISSUERS,
          audience: options.clientId,
          algorithms: ['RS256'],
        });
        claims = verified.payload;
      } catch (error) {
        throw new ProviderError('invalid_response', 'id_token failed verification', {
          cause: error,
        });
      }
      const nonce = (claims as { nonce?: unknown }).nonce;
      if (input.nonce === undefined || nonce !== input.nonce) {
        throw new ProviderError('invalid_response', 'id_token nonce mismatch');
      }
      return profileFromGoogleClaims(claims);
    },
  };
}
