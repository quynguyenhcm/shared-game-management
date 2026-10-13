/**
 * Declarative, default-deny route authorization (architecture Q5). Every route declares exactly one policy in
 * `config.policy`; an `onRoute` hook refuses to register a route without one, so the app cannot boot with an
 * unprotected route. One global `onRequest` hook then enforces the declared policy: it authenticates (401)
 * and checks the role or team membership (403), all before the body is parsed or validated, so an
 * unauthorised caller can never be answered with a 422 first (AC-ERROR-11).
 */
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { AssignableGlobalRole, TeamRole } from '@sgm/shared';
import { ErrorResponse } from '@sgm/shared';
import type { Database } from '../db/kysely.ts';
import type { SessionService } from '../../modules/auth/sessions.ts';
import { AppError } from '../http/errors.ts';
import { authenticate, checkGlobalRole, checkTeamRole, resolveOptional } from './guards.ts';
import './request-auth.ts';

export type RoutePolicy =
  | { readonly kind: 'public' }
  | { readonly kind: 'optionalSession' }
  | { readonly kind: 'authenticated' }
  | { readonly kind: 'globalRole'; readonly roles: readonly AssignableGlobalRole[] }
  | {
      readonly kind: 'teamRole';
      readonly role: TeamRole;
      readonly teamIdParam: string;
      readonly allowGlobalAdmin: boolean;
    };

/** No session is read or required (health, register, login, providers). */
export const publicRoute = (): RoutePolicy => ({ kind: 'public' });
/** A live session identifies the caller when present; a missing or dead token never fails the request. */
export const optionalSession = (): RoutePolicy => ({ kind: 'optionalSession' });
/** Any signed-in user. */
export const authenticated = (): RoutePolicy => ({ kind: 'authenticated' });
/** Signed in with one of `roles`, read from the database on this request. */
export const requireGlobalRole = (...roles: AssignableGlobalRole[]): RoutePolicy => ({
  kind: 'globalRole',
  roles,
});
/**
 * Signed in with an APPROVED membership of the team in `:<teamIdParam>` (default `teamId`) whose role is
 * `role` (TEAM_ADMIN satisfies MEMBER). GLOBAL_ADMIN passes only with `allowGlobalAdmin: true`.
 */
export const requireTeamRole = (
  role: TeamRole,
  options: { teamIdParam?: string; allowGlobalAdmin?: boolean } = {},
): RoutePolicy => ({
  kind: 'teamRole',
  role,
  teamIdParam: options.teamIdParam ?? 'teamId',
  allowGlobalAdmin: options.allowGlobalAdmin ?? false,
});

export interface RoutePolicyEntry {
  readonly method: string;
  readonly url: string;
  readonly policy: RoutePolicy;
}

const registries = new WeakMap<FastifyInstance, RoutePolicyEntry[]>();

/** Every `{ method, url, policy }` registered so far (AC-VERIFY-3's enumeration). */
export function listRoutePolicies(app: FastifyInstance): readonly RoutePolicyEntry[] {
  return registries.get(app) ?? [];
}

export interface AuthPlatformDeps {
  readonly sessions: Pick<SessionService, 'resolve'>;
  readonly db: Database;
}

const errorResponse = ErrorResponse;

/** Adds the bearer security requirement and the 401/403 responses to a route's OpenAPI schema. */
function withAuthDocs(
  schema: Record<string, unknown> | undefined,
  policy: RoutePolicy,
): Record<string, unknown> | undefined {
  if (policy.kind === 'public') return schema;
  const base = schema ?? {};
  const response = (base.response ?? {}) as Record<string, unknown>;
  const guarded = policy.kind === 'globalRole' || policy.kind === 'teamRole';
  return {
    ...base,
    security:
      policy.kind === 'optionalSession' ? [{ sessionToken: [] }, {}] : [{ sessionToken: [] }],
    response: {
      ...(policy.kind === 'optionalSession' ? {} : { 401: errorResponse }),
      ...(guarded ? { 403: errorResponse } : {}),
      ...response,
    },
  };
}

/**
 * Installs the registry and the enforcement hooks. Call before any route is registered (and before swagger,
 * so the documented schema includes the security requirement).
 */
export function registerAuthPlatform(app: FastifyInstance, deps: AuthPlatformDeps): void {
  const entries: RoutePolicyEntry[] = [];
  registries.set(app, entries);
  app.decorateRequest('auth', null);
  app.decorateRequest('teamMembership', null);

  app.addHook('onRoute', (routeOptions) => {
    const methods = Array.isArray(routeOptions.method)
      ? routeOptions.method
      : [routeOptions.method];
    const label = `${methods.join(',')} ${routeOptions.url}`;
    const policy = routeOptions.config?.policy;
    if (policy === undefined) {
      throw new Error(`route ${label} declares no auth policy`);
    }
    if (policy.kind === 'teamRole' && !routeOptions.url.includes(`:${policy.teamIdParam}`)) {
      throw new Error(
        `route ${label} uses a team policy but its URL has no :${policy.teamIdParam}`,
      );
    }
    for (const method of methods) entries.push({ method, url: routeOptions.url, policy });
    const documented = withAuthDocs(
      routeOptions.schema as Record<string, unknown> | undefined,
      policy,
    );
    if (documented !== undefined) routeOptions.schema = documented;
  });

  app.addHook('onRequest', async (request: FastifyRequest) => {
    // Requests that match no route (404) have no policy and fall through to the not-found handler.
    const policy = request.routeOptions.config.policy;
    if (policy === undefined || policy.kind === 'public') return;
    if (policy.kind === 'optionalSession') {
      request.auth = await resolveOptional(deps.sessions, request);
      return;
    }
    try {
      const auth = await authenticate(deps.sessions, request);
      request.auth = auth;
      // The role and team checks run here too, not in preHandler: route params are already routed in
      // onRequest, and answering 403 before the body is parsed or validated means an unauthorised caller
      // never sees a 422 (which would leak the route's body shape).
      if (policy.kind === 'globalRole') checkGlobalRole(policy, auth);
      else if (policy.kind === 'teamRole') await checkTeamRole(deps.db, policy, request, auth);
    } catch (error) {
      if (error instanceof AppError) {
        request.log.debug({
          event: 'auth.authz.denied',
          policy: policy.kind,
          status: error.status,
        });
      }
      throw error;
    }
  });
}
