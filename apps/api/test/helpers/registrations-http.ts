/**
 * Scaffolding for the registration HTTP integration tests: members with a live session token, the four registration
 * requests through `buildAuthTestApp`, and typed readers for the error envelope and the read model. Nothing here knows
 * the routes' implementation; it only speaks HTTP.
 */
import type { LightMyRequestResponse } from 'fastify';
import type {
  RegistrationReadResponse,
  SessionRegisterRequest,
  SessionRegisterResponse,
  SessionWithdrawResponse,
  UpcomingSessionsResponse,
} from '@sgm/shared';
import { bearer, type AuthTestApp } from './auth-app.ts';
import { insertAuthSession, insertUser } from './factories.ts';
import { insertMember } from './registration-scene.ts';

export interface HttpMember {
  readonly userId: string;
  readonly token: string;
}

/** An APPROVED (or other status) member of `teamId` with a signed-in session token. */
export async function httpMember(
  h: AuthTestApp,
  teamId: string,
  options: Parameters<typeof insertMember>[2] = {},
): Promise<HttpMember> {
  const userId = await insertMember(h.pool, teamId, options);
  const { token } = await insertAuthSession(h.pool, userId, {
    createdAt: h.clock.now(),
    idleDays: 90,
    absoluteDays: 180,
  });
  return { userId, token };
}

/** A signed-in user who belongs to no team. */
export async function httpOutsider(h: AuthTestApp): Promise<HttpMember> {
  const userId = await insertUser(h.pool, 'FEMALE');
  const { token } = await insertAuthSession(h.pool, userId, {
    createdAt: h.clock.now(),
    idleDays: 90,
    absoluteDays: 180,
  });
  return { userId, token };
}

export const sessionUrl = (teamId: string, sessionId: string): string =>
  `/teams/${teamId}/sessions/${sessionId}`;

export function call(
  h: AuthTestApp,
  method: 'GET' | 'POST',
  url: string,
  token: string | null,
  payload?: unknown,
): Promise<LightMyRequestResponse> {
  return h.app.inject({
    method,
    url,
    ...(token === null ? {} : { headers: bearer(token) }),
    ...(payload === undefined ? {} : { payload: payload as Record<string, unknown> }),
  });
}

export const registerAs = (
  h: AuthTestApp,
  who: HttpMember,
  teamId: string,
  sessionId: string,
  body: SessionRegisterRequest | Record<string, unknown> = { guests: [] },
): Promise<LightMyRequestResponse> =>
  call(h, 'POST', `${sessionUrl(teamId, sessionId)}/registrations`, who.token, body);

export const withdrawAs = (
  h: AuthTestApp,
  who: HttpMember,
  teamId: string,
  sessionId: string,
  body: Record<string, unknown> = { expectLate: false },
): Promise<LightMyRequestResponse> =>
  call(h, 'POST', `${sessionUrl(teamId, sessionId)}/registrations/me/withdraw`, who.token, body);

export const readAs = (
  h: AuthTestApp,
  who: HttpMember,
  teamId: string,
  sessionId: string,
): Promise<LightMyRequestResponse> =>
  call(h, 'GET', `${sessionUrl(teamId, sessionId)}/registration`, who.token);

export const upcomingAs = (
  h: AuthTestApp,
  who: HttpMember,
  teamId: string,
): Promise<LightMyRequestResponse> =>
  call(h, 'GET', `/teams/${teamId}/sessions/upcoming`, who.token);

export interface ApiErrorBody {
  error: { code: string; message: string; fieldErrors?: Record<string, string[]> };
}
export const errorOf = (res: LightMyRequestResponse): ApiErrorBody['error'] =>
  res.json<ApiErrorBody>().error;
export const registeredOf = (
  res: LightMyRequestResponse,
): SessionRegisterResponse['registration'] => res.json<SessionRegisterResponse>().registration;
export const withdrawnOf = (res: LightMyRequestResponse): SessionWithdrawResponse =>
  res.json<SessionWithdrawResponse>();
export const readModelOf = (res: LightMyRequestResponse): RegistrationReadResponse =>
  res.json<RegistrationReadResponse>();
export const upcomingOf = (res: LightMyRequestResponse): UpcomingSessionsResponse =>
  res.json<UpcomingSessionsResponse>();
