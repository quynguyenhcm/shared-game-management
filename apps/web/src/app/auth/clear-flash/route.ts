import { NextResponse } from 'next/server';
import { expiredCookieSpec } from '../../../lib/auth/cookies.ts';
import { loadWebConfig } from '../../../lib/config.ts';

export const dynamic = 'force-dynamic';

/**
 * Deletes `sgm_flash` once /login has shown the conflicting email. A Server Component cannot delete a
 * cookie, and a Server Action would re-render the page (and lose the banner), so a tiny route handler does
 * it. `proxy.ts` refuses a foreign `Origin` on this POST like any other mutation.
 */
export function POST(): NextResponse {
  const response = new NextResponse(null, { status: 204 });
  response.headers.set('cache-control', 'no-store');
  const spec = expiredCookieSpec('flash', loadWebConfig().webBaseUrl);
  response.cookies.set(spec.name, spec.value, spec.options);
  return response;
}
