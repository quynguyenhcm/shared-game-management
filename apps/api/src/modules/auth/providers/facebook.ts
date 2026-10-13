/**
 * Facebook adapter: authorization-code flow (state + app secret, no PKCE), then Graph `/me?fields=id,name,email`
 * with `appsecret_proof` (HMAC-SHA256 of the access token keyed by the app secret). The access token travels
 * in the Authorization header (never in a URL we could log) and is discarded after the call. Facebook gives no
 * verification claim, so `emailVerified` is always false.
 *
 * GRAPH_VERSION: v26.0, released 2026-07-29 (latest per https://developers.facebook.com/docs/graph-api/changelog/versions/,
 * checked 2026-10-06; v25.0 expires 2028-07-29). Refresh within two years: versions expire about two years after release.
 */
import { createHmac } from 'node:crypto';
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

export const GRAPH_VERSION = 'v26.0';
export const GRAPH_HOST = 'https://graph.facebook.com';
export const FACEBOOK_DIALOG_HOST = 'https://www.facebook.com';

const TokenResponse = z.object({ access_token: z.string().min(1) });
const MeResponse = z.object({
  id: z.string().min(1).max(255),
  name: z.string().optional(),
  email: z.string().min(1).optional(),
});

export function appSecretProof(accessToken: string, appSecret: string): string {
  return createHmac('sha256', appSecret).update(accessToken).digest('hex');
}

/** Normalises a Graph `/me` body (or a fixture of one) into a profile. Throws `invalid_response`. */
export function profileFromGraphMe(body: unknown): ProviderProfile {
  const parsed = MeResponse.safeParse(body);
  if (!parsed.success) throw new ProviderError('invalid_response', 'unexpected Graph /me body');
  const { id, name, email } = parsed.data;
  return {
    provider: 'FACEBOOK',
    subject: id,
    email: email === undefined ? null : email.toLowerCase(),
    emailVerified: false,
    fullName: name === undefined || name.trim() === '' ? null : name.trim(),
  };
}

export interface FacebookProviderOptions {
  readonly appId: string;
  readonly appSecret: string;
  readonly fetch?: FetchLike;
}

export function createFacebookProvider(options: FacebookProviderOptions): OAuthProvider {
  const fetchImpl = options.fetch ?? fetch;
  return {
    name: 'FACEBOOK',
    usesPkce: false,
    authorizationUrl(input: AuthorizationInput): URL {
      const url = new URL(`${FACEBOOK_DIALOG_HOST}/${GRAPH_VERSION}/dialog/oauth`);
      url.searchParams.set('client_id', options.appId);
      url.searchParams.set('redirect_uri', input.redirectUri);
      url.searchParams.set('response_type', 'code');
      url.searchParams.set('scope', 'email,public_profile');
      url.searchParams.set('state', input.state);
      if (input.rerequest === true) url.searchParams.set('auth_type', 'rerequest');
      return url;
    },
    async exchange(input: ExchangeInput): Promise<ProviderProfile> {
      const tokenUrl = new URL(`${GRAPH_HOST}/${GRAPH_VERSION}/oauth/access_token`);
      tokenUrl.searchParams.set('client_id', options.appId);
      tokenUrl.searchParams.set('client_secret', options.appSecret);
      tokenUrl.searchParams.set('redirect_uri', input.redirectUri);
      tokenUrl.searchParams.set('code', input.code);
      const tokenResponse = await providerFetch(fetchImpl, tokenUrl, {
        headers: { accept: 'application/json' },
      });
      if (!tokenResponse.ok) failFromStatus(tokenResponse.status);
      const token = TokenResponse.safeParse(await tokenResponse.json().catch(() => null));
      if (!token.success)
        throw new ProviderError('invalid_response', 'no access_token in token response');

      const meUrl = new URL(`${GRAPH_HOST}/${GRAPH_VERSION}/me`);
      meUrl.searchParams.set('fields', 'id,name,email');
      meUrl.searchParams.set(
        'appsecret_proof',
        appSecretProof(token.data.access_token, options.appSecret),
      );
      const meResponse = await providerFetch(fetchImpl, meUrl, {
        headers: { accept: 'application/json', authorization: `Bearer ${token.data.access_token}` },
      });
      if (!meResponse.ok) failFromStatus(meResponse.status);
      return profileFromGraphMe(await meResponse.json().catch(() => null));
    },
  };
}
