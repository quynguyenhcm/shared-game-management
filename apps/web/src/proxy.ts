import { NextResponse, type NextRequest } from 'next/server';
import { cookieName } from './lib/auth/cookies.ts';
import { loginUrl } from './lib/auth/landing.ts';
import { loadWebConfig } from './lib/config.ts';

/**
 * Next 16 `proxy.ts` (the renamed `middleware.ts`). It is not an auth boundary: it only redirects a
 * protected path that has no session cookie at all; `requireUser` in the page does the real check.
 */
const PROTECTED = ['/account', '/teams/new', '/teams/join'];
const NO_STORE_PREFIXES = [
  '/login',
  '/register',
  '/forgot-password',
  '/reset-password',
  '/account',
  '/auth/callback',
];
/** `/teams/<uuid>/manage` (the team-admin area; it embeds the invite code). */
const TEAM_MANAGE =
  /^\/teams\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\/manage(?:\/|$)/i;
const SAFE_METHODS: ReadonlySet<string> = new Set(['GET', 'HEAD', 'OPTIONS']);
const INTERNAL_HEADERS = ['x-sgm-client-ip', 'x-sgm-internal-auth'] as const;

function matchesPrefix(pathname: string, prefix: string): boolean {
  return pathname === prefix || pathname.startsWith(`${prefix}/`);
}

/** My teams (exactly `/teams`; Find and the team pages stay public), Create, the invite landing and manage. */
function isProtected(pathname: string): boolean {
  return (
    pathname === '/teams' ||
    TEAM_MANAGE.test(pathname) ||
    PROTECTED.some((prefix) => matchesPrefix(pathname, prefix))
  );
}

export function proxy(request: NextRequest): NextResponse {
  const config = loadWebConfig();
  const { pathname, search } = request.nextUrl;

  // Origin check on anything that can change state (route handlers; Server Actions have Next's own check).
  const origin = request.headers.get('origin');
  if (!SAFE_METHODS.has(request.method) && origin !== null && origin !== config.webBaseUrl) {
    return NextResponse.json(
      { error: { code: 'cross_origin_request', message: 'Cross-origin request refused.' } },
      { status: 403 },
    );
  }

  if (isProtected(pathname) && !request.cookies.has(cookieName('session', config.webBaseUrl))) {
    return NextResponse.redirect(
      new URL(loginUrl({ returnTo: `${pathname}${search}` }), config.webBaseUrl),
    );
  }

  // The browser must never be able to supply the headers the API trusts from the web hop.
  const forwarded = new Headers(request.headers);
  for (const name of INTERNAL_HEADERS) forwarded.delete(name);
  const response = NextResponse.next({ request: { headers: forwarded } });

  if (
    NO_STORE_PREFIXES.some((prefix) => matchesPrefix(pathname, prefix)) ||
    isProtected(pathname)
  ) {
    // Dynamic auth and per-user pages (My teams, the invite landing, the manage area with its invite
    // code) must not be served from the back/forward cache or a shared cache.
    response.headers.set('cache-control', 'no-store');
  }
  if (
    matchesPrefix(pathname, '/reset-password') ||
    matchesPrefix(pathname, '/auth/callback') ||
    matchesPrefix(pathname, '/teams/join')
  ) {
    // The reset token, the OAuth `code` and `state` or the team invite code are in the URL: never leak
    // them through the Referer header.
    response.headers.set('referrer-policy', 'no-referrer');
  }
  return response;
}

export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon.ico).*)'],
};
