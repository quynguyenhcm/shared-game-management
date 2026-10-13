import { safeReturnTo } from '@sgm/shared';
import { type NextRequest, NextResponse } from 'next/server';
import { apiClient } from '../../../lib/api-client.ts';
import { loadWebConfig } from '../../../lib/config.ts';
import { cookieName, expiredCookieSpec } from '../../../lib/auth/cookies.ts';
import { sessionExpiredLanding } from '../../../lib/auth/landing.ts';

export const dynamic = 'force-dynamic';

/**
 * Dead-session cleanup (user journey X14). A GET that deleted the cookie unconditionally could be
 * triggered cross-site (`<img src>`), so the cookie goes only after `GET /auth/me` confirms 401. A live
 * session, or an API that cannot answer, just continues to `returnTo`.
 */
export async function GET(request: NextRequest): Promise<NextResponse> {
  const { webBaseUrl } = loadWebConfig();
  const returnTo = request.nextUrl.searchParams.get('returnTo');
  const toLogin = (): URL => new URL(sessionExpiredLanding(returnTo), webBaseUrl);

  const token = request.cookies.get(cookieName('session', webBaseUrl))?.value;
  if (token === undefined || token === '') return NextResponse.redirect(toLogin());

  const me = await apiClient.me(token, { incoming: request.headers });
  if (!me.ok && me.status === 401) {
    const response = NextResponse.redirect(toLogin());
    const spec = expiredCookieSpec('session', webBaseUrl);
    response.cookies.set(spec.name, spec.value, spec.options);
    return response;
  }
  return NextResponse.redirect(new URL(safeReturnTo(returnTo), webBaseUrl));
}
