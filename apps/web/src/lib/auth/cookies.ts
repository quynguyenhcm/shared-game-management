import { cookies } from 'next/headers';
import { loadWebConfig } from '../config.ts';

/**
 * Cookies are owned by the web (the API never sets one). Secure and the `__Host-` prefix follow the
 * scheme of `WEB_BASE_URL`, not `NODE_ENV`: the Compose stack runs the production build over http.
 * Names for the OAuth cookies exist here so Phase 5 only has to use them.
 */
export type CookieKind = 'session' | 'oauth' | 'pending' | 'flash';

const BASE_NAMES: Record<CookieKind, string> = {
  session: 'sgm_session',
  oauth: 'sgm_oauth',
  pending: 'sgm_pending',
  flash: 'sgm_flash',
};

/** Max-Age in seconds; the session cookie instead lives until its absolute expiry. */
const MAX_AGE_SECONDS: Partial<Record<CookieKind, number>> = {
  oauth: 600,
  pending: 900,
  flash: 60,
};

export interface CookieOptions {
  httpOnly: true;
  sameSite: 'lax';
  path: '/';
  secure: boolean;
  expires?: Date;
  maxAge?: number;
}

export interface CookieSpec {
  name: string;
  value: string;
  options: CookieOptions;
}

const isHttps = (webBaseUrl: string): boolean => webBaseUrl.startsWith('https:');

export function cookieName(kind: CookieKind, webBaseUrl: string): string {
  return `${isHttps(webBaseUrl) ? '__Host-' : ''}${BASE_NAMES[kind]}`;
}

function baseOptions(webBaseUrl: string): CookieOptions {
  return { httpOnly: true, sameSite: 'lax', path: '/', secure: isHttps(webBaseUrl) };
}

/** A cookie to set. `expiresAt` (ISO) is for the session cookie; the others carry their own Max-Age. */
export function cookieSpec(
  kind: CookieKind,
  webBaseUrl: string,
  input: { value: string; expiresAt?: string },
): CookieSpec {
  const options = baseOptions(webBaseUrl);
  const maxAge = MAX_AGE_SECONDS[kind];
  if (maxAge !== undefined) options.maxAge = maxAge;
  if (input.expiresAt !== undefined) options.expires = new Date(input.expiresAt);
  return { name: cookieName(kind, webBaseUrl), value: input.value, options };
}

/** Deletion = same name, path and Secure flag, empty value, already expired. */
export function expiredCookieSpec(kind: CookieKind, webBaseUrl: string): CookieSpec {
  return {
    name: cookieName(kind, webBaseUrl),
    value: '',
    options: { ...baseOptions(webBaseUrl), maxAge: 0, expires: new Date(0) },
  };
}

export async function readCookie(kind: CookieKind): Promise<string | null> {
  const store = await cookies();
  const value = store.get(cookieName(kind, loadWebConfig().webBaseUrl))?.value;
  return value === undefined || value === '' ? null : value;
}

export async function setCookie(
  kind: CookieKind,
  value: string,
  expiresAt?: string,
): Promise<void> {
  const spec = cookieSpec(kind, loadWebConfig().webBaseUrl, { value, expiresAt });
  (await cookies()).set(spec.name, spec.value, spec.options);
}

export async function clearCookie(kind: CookieKind): Promise<void> {
  const spec = expiredCookieSpec(kind, loadWebConfig().webBaseUrl);
  (await cookies()).set(spec.name, spec.value, spec.options);
}
