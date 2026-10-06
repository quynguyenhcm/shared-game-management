import type { FastifyRequest } from 'fastify';
import type { TeamRole } from '@sgm/shared';
import { AppError } from '../http/errors.ts';
import type { RequestAuth } from '../../modules/auth/sessions.ts';
import type { RoutePolicy } from './policy.ts';

export type { RequestAuth } from '../../modules/auth/sessions.ts';

declare module 'fastify' {
  interface FastifyRequest {
    /** Set by the policy hooks for `optionalSession`, `authenticated`, `globalRole` and `teamRole` routes. */
    auth: RequestAuth | null;
    /** Set by the team guard: the caller's approved membership in `:teamId` (null when GLOBAL_ADMIN passed via opt-in). */
    teamMembership: { readonly teamId: string; readonly role: TeamRole } | null;
  }
  interface FastifyContextConfig {
    /** Every route must declare exactly one policy; the app refuses to boot otherwise (default deny). */
    policy?: RoutePolicy;
  }
}

/** What the request presented: nothing, or a bearer token (well-formed or not). */
export type PresentedToken =
  | { readonly kind: 'none' }
  | { readonly kind: 'malformed' }
  | { readonly kind: 'bearer'; readonly token: string };

const BEARER = /^Bearer ([A-Za-z0-9_-]{1,256})$/i;

/**
 * Reads `Authorization: Bearer <token>`. A header that is present but not a usable bearer token counts as
 * a presented, dead token (`session_expired`), distinct from no header at all (`unauthenticated`).
 */
export function presentedToken(request: FastifyRequest): PresentedToken {
  const header = request.headers.authorization;
  if (header === undefined) return { kind: 'none' };
  const match = BEARER.exec(header);
  return match?.[1] === undefined ? { kind: 'malformed' } : { kind: 'bearer', token: match[1] };
}

/**
 * Narrows `request.auth` in a handler. Throws if the route's policy does not guarantee a session, which
 * protects against a wiring mistake (a handler assuming auth under `public` or `optionalSession`).
 */
export function requireAuth(request: FastifyRequest): RequestAuth {
  if (request.auth === null) throw new AppError('unauthenticated');
  return request.auth;
}
