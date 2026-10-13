/**
 * The OAuth provider seam (architecture Q1). An adapter builds the authorization URL and, on the callback,
 * exchanges the code for a normalised, provider-verified profile. No provider token is ever stored or logged.
 */
export type OAuthProviderName = 'GOOGLE' | 'FACEBOOK';

export interface ProviderProfile {
  readonly provider: OAuthProviderName;
  /** Google `sub` / Facebook `id`. */
  readonly subject: string;
  /** Lower-cased as received; `null` when the provider did not share one. Normalised by the service (S1-b). */
  readonly email: string | null;
  /** Google `email_verified`; Facebook never asserts verification, so always `false`. */
  readonly emailVerified: boolean;
  readonly fullName: string | null;
}

export type ProviderErrorKind = 'unavailable' | 'rejected' | 'invalid_response';

/** `unavailable`: network, timeout or 5xx. `rejected`: the provider refused the code. `invalid_response`: bad payload or token. */
export class ProviderError extends Error {
  readonly kind: ProviderErrorKind;

  constructor(kind: ProviderErrorKind, message: string, options: { cause?: unknown } = {}) {
    super(message, { cause: options.cause });
    this.name = 'ProviderError';
    this.kind = kind;
  }
}

export interface AuthorizationInput {
  readonly state: string;
  readonly redirectUri: string;
  /** PKCE S256 challenge (Google); ignored by Facebook. */
  readonly codeChallenge?: string;
  readonly nonce?: string;
  /** Facebook `auth_type=rerequest`; ignored by Google. */
  readonly rerequest?: boolean;
}

export interface ExchangeInput {
  readonly code: string;
  readonly redirectUri: string;
  readonly codeVerifier?: string;
  readonly nonce?: string;
}

export interface OAuthProvider {
  readonly name: OAuthProviderName;
  /** Whether the authorization request needs a PKCE verifier and nonce (Google) or not (Facebook). */
  readonly usesPkce: boolean;
  authorizationUrl(input: AuthorizationInput): URL;
  exchange(input: ExchangeInput): Promise<ProviderProfile>;
}

/** The enabled providers by name (config credentials, or both fakes in `AUTH_FAKE_OAUTH` mode). */
export interface OAuthProviderRegistry {
  get(name: OAuthProviderName): OAuthProvider | undefined;
  enabled(): { readonly google: boolean; readonly facebook: boolean };
}

/** Network timeout for every call to a provider (architecture constants). */
export const PROVIDER_TIMEOUT_MS = 5_000;

export type FetchLike = (input: string | URL, init?: RequestInit) => Promise<Response>;

/**
 * `fetch` with the 5 s timeout; any network or timeout failure is `unavailable`. The transport error is
 * deliberately NOT kept as `cause`: the Facebook token exchange carries `client_secret` and `code` in its
 * query string, and a transport error's message or stack can embed that URL. Only the error class survives.
 */
export async function providerFetch(
  fetchImpl: FetchLike,
  url: string | URL,
  init: RequestInit = {},
): Promise<Response> {
  try {
    return await fetchImpl(url, { ...init, signal: AbortSignal.timeout(PROVIDER_TIMEOUT_MS) });
  } catch (error) {
    const kind = error instanceof Error ? error.name : 'unknown';
    throw new ProviderError('unavailable', `provider request failed (${kind})`);
  }
}

/** Maps a non-2xx provider response: 5xx and 429 are an outage, other 4xx a refusal. */
export function failFromStatus(status: number): never {
  if (status >= 500 || status === 429) {
    throw new ProviderError('unavailable', `provider answered ${status}`);
  }
  throw new ProviderError('rejected', `provider answered ${status}`);
}
