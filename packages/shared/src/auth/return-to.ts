/** `oauth_states.return_to` and the `sgm_oauth` cookie payload are limited to 512 characters. */
export const RETURN_TO_MAX_LENGTH = 512;

const FALLBACK = '/';
function hasControlOrBackslash(value: string): boolean {
  return [...value].some((char) => {
    const code = char.charCodeAt(0);
    return char === '\\' || code <= 0x1f || code === 0x7f;
  });
}
/** Auth pages (and everything under `/auth`) are never a valid landing: redirecting there loops. */
const AUTH_PATHS: ReadonlySet<string> = new Set([
  '/login',
  '/register',
  '/register/complete',
  '/forgot-password',
  '/reset-password',
]);

function isAuthPath(pathname: string): boolean {
  const path = pathname.toLowerCase().replace(/\/+$/, '');
  return AUTH_PATHS.has(path) || path === '/auth' || path.startsWith('/auth/');
}

/**
 * Validates a post-auth redirect target and returns a same-origin path (with its query string) or `/`.
 * Accepted: a single leading `/`, at most 512 characters, no backslash or control character, no `//`
 * once percent-decoded, and not an auth page. The fragment is dropped. Applied by the web before every
 * redirect and by the API before storing a `returnTo` (AC-ERROR-13).
 */
export function safeReturnTo(raw: string | null | undefined): string {
  if (typeof raw !== 'string' || raw === '' || raw.length > RETURN_TO_MAX_LENGTH) return FALLBACK;
  if (!raw.startsWith('/') || raw.startsWith('//') || hasControlOrBackslash(raw)) return FALLBACK;
  let decoded: string;
  try {
    decoded = decodeURIComponent(raw);
  } catch {
    return FALLBACK;
  }
  if (decoded.startsWith('//') || hasControlOrBackslash(decoded)) return FALLBACK;
  let url: URL;
  try {
    url = new URL(raw, 'http://return-to.invalid');
  } catch {
    return FALLBACK;
  }
  if (url.origin !== 'http://return-to.invalid') return FALLBACK;
  let pathname: string;
  try {
    pathname = decodeURIComponent(url.pathname);
  } catch {
    return FALLBACK;
  }
  if (isAuthPath(pathname)) return FALLBACK;
  // Dot segments (`/.//evil.example`) can normalise to a protocol-relative URL: re-validate the result.
  const target = `${url.pathname}${url.search}`;
  if (target.length > RETURN_TO_MAX_LENGTH) return FALLBACK;
  if (!/^\/($|[^/\\])/.test(target) || hasControlOrBackslash(target)) return FALLBACK;
  return target;
}
