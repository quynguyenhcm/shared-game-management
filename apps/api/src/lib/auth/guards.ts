/**
 * The checks behind each route policy (architecture Q5). Nothing here caches: the global role comes from the
 * session resolve (a join on `users`) and the team role from `team_members` on every request, so a role or
 * membership change takes effect on the very next request (AC-HAPPY-8, AC-ERROR-12).
 */
import type { FastifyRequest } from 'fastify';
import type { Database } from '../db/kysely.ts';
import type { RequestAuth, SessionService } from '../../modules/auth/sessions.ts';
import { AppError } from '../http/errors.ts';
import type { RoutePolicy } from './policy.ts';
import { presentedToken } from './request-auth.ts';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type SessionResolver = Pick<SessionService, 'resolve'>;

/** 401 `unauthenticated` without a token, 401 `session_expired` for a presented token that is not live. */
export async function authenticate(
  sessions: SessionResolver,
  request: FastifyRequest,
): Promise<RequestAuth> {
  const presented = presentedToken(request);
  if (presented.kind === 'none') throw new AppError('unauthenticated');
  if (presented.kind === 'malformed') throw new AppError('session_expired');
  const resolved = await sessions.resolve(presented.token);
  if (resolved.status !== 'valid') throw new AppError('session_expired');
  return resolved.auth;
}

/** For `optionalSession` routes: the identity when the token is live, `null` otherwise. Never throws on a bad token. */
export async function resolveOptional(
  sessions: SessionResolver,
  request: FastifyRequest,
): Promise<RequestAuth | null> {
  const presented = presentedToken(request);
  if (presented.kind !== 'bearer') return null;
  const resolved = await sessions.resolve(presented.token);
  return resolved.status === 'valid' ? resolved.auth : null;
}

/** 403 `forbidden` unless the (freshly read) global role is one of the policy's roles. */
export function checkGlobalRole(
  policy: Extract<RoutePolicy, { kind: 'globalRole' }>,
  auth: RequestAuth,
): void {
  if (!policy.roles.includes(auth.role)) throw new AppError('forbidden');
}

/**
 * 403 `forbidden` unless the caller has an APPROVED `team_members` row in `:<teamIdParam>` with a role that
 * satisfies the policy (TEAM_ADMIN satisfies MEMBER). GLOBAL_ADMIN passes only when the route opts in with
 * `allowGlobalAdmin`, in which case `teamMembership` stays null.
 */
export async function checkTeamRole(
  db: Database,
  policy: Extract<RoutePolicy, { kind: 'teamRole' }>,
  request: FastifyRequest,
  auth: RequestAuth,
): Promise<void> {
  if (policy.allowGlobalAdmin && auth.role === 'GLOBAL_ADMIN') return;
  const params = request.params as Record<string, unknown> | undefined;
  const teamId = params?.[policy.teamIdParam];
  // A malformed id can never match a membership (and must not reach Postgres as a uuid cast error).
  if (typeof teamId !== 'string' || !UUID.test(teamId)) throw new AppError('forbidden');
  const membership = await db
    .selectFrom('team_members')
    .select('role')
    .where('team_id', '=', teamId)
    .where('user_id', '=', auth.userId)
    .where('status', '=', 'APPROVED')
    .executeTakeFirst();
  if (membership === undefined) throw new AppError('forbidden');
  if (policy.role === 'TEAM_ADMIN' && membership.role !== 'TEAM_ADMIN') {
    throw new AppError('forbidden');
  }
  request.teamMembership = { teamId, role: membership.role };
}
