import { readCookie } from '../../lib/auth/cookies.ts';
import { getSessionState } from '../../lib/auth/session.ts';

/**
 * For the public team pages: the session token when the visitor is really signed in (a live
 * `GET /auth/me`), `null` for anonymous visitors and dead cookies. The API treats a missing token as
 * anonymous on optional-session routes, so a stale cookie never breaks a public page.
 */
export async function optionalSessionToken(): Promise<string | null> {
  const state = await getSessionState();
  return state.kind === 'signed_in' ? readCookie('session') : null;
}
