import type { PublicUser } from '@sgm/shared';
import { headers } from 'next/headers';
import { redirect } from 'next/navigation';
import { cache } from 'react';
import { apiClient, type ApiResult } from '../api-client.ts';
import { loginUrl, sessionExpiredUrl } from './landing.ts';
import { readCookie } from './cookies.ts';

/**
 * What the web knows about the visitor (user journey, "Header states"). "Signed in" is a real
 * `GET /auth/me`, never cookie presence (X7): a dead cookie must still get the sign-in form.
 */
export type SessionState =
  | { kind: 'anonymous' }
  | { kind: 'dead_cookie' }
  | { kind: 'signed_in'; user: PublicUser }
  | { kind: 'unavailable' };

/** Thrown by `requireUser` when the API cannot answer: the page's `error.tsx` shows E-PAGE-1. */
export class SessionUnavailableError extends Error {
  constructor() {
    super('The session could not be checked because the API is unavailable.');
    this.name = 'SessionUnavailableError';
  }
}

export function sessionStateFrom(
  hasCookie: boolean,
  me: ApiResult<{ user: PublicUser }> | null,
): SessionState {
  if (!hasCookie || me === null) return { kind: 'anonymous' };
  if (me.ok) return { kind: 'signed_in', user: me.data.user };
  if (me.status === 401) return { kind: 'dead_cookie' };
  return { kind: 'unavailable' };
}

/** One `GET /auth/me` per render (React `cache`). */
export const getSessionState = cache(async (): Promise<SessionState> => {
  const token = await readCookie('session');
  if (token === null) return sessionStateFrom(false, null);
  return sessionStateFrom(true, await apiClient.me(token, { incoming: await headers() }));
});

/** The signed-in user, or `null` for anyone else (including an unreachable API). */
export async function getCurrentUser(): Promise<PublicUser | null> {
  const state = await getSessionState();
  return state.kind === 'signed_in' ? state.user : null;
}

/**
 * Guard for protected pages. No cookie: sign in. A cookie the API rejects: `/auth/session-expired`
 * (it clears the cookie only after confirming the 401). API down: throw, never sign the user out.
 */
export async function requireUser(returnTo: string): Promise<PublicUser> {
  const state = await getSessionState();
  switch (state.kind) {
    case 'signed_in':
      return state.user;
    case 'dead_cookie':
      return redirect(sessionExpiredUrl(returnTo));
    case 'unavailable':
      throw new SessionUnavailableError();
    case 'anonymous':
      return redirect(loginUrl({ returnTo }));
  }
}
