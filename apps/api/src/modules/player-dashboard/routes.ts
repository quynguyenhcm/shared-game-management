/**
 * The player dashboard's cross-team read routes (player-dashboard Phase 1):
 *
 *   GET /me/sessions/open ..... authenticated(): upcoming PUBLISHED sessions of the caller's APPROVED teams, with the caller's fee
 *   GET /me/registrations ..... authenticated(): every registration of the caller, Upcoming then Past (cursor-paged)
 *
 * Both answer only the caller's own data and never write. `cache-control: no-store` on every answer, errors included.
 */
import type { FastifyPluginAsync } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import {
  DashboardRegistrationsQuery,
  DashboardRegistrationsResponse,
  ErrorResponse,
  OpenSessionsResponse,
} from '@sgm/shared';
import { authenticated } from '../../lib/auth/policy.ts';
import { requireAuth } from '../../lib/auth/request-auth.ts';
import type { PlayerDashboardService } from './service.ts';

export interface PlayerDashboardRoutesOptions {
  readonly service: PlayerDashboardService;
}

export const playerDashboardRoutes: FastifyPluginAsync<PlayerDashboardRoutesOptions> = (
  app,
  options,
) => {
  const { service } = options;
  const typed = app.withTypeProvider<ZodTypeProvider>();

  // Seats, fees and what a person owes change with every registration and payment: nothing here is cacheable.
  app.addHook('onSend', (_request, reply, payload, done) => {
    void reply.header('cache-control', 'no-store');
    done(null, payload);
  });

  typed.get(
    '/me/sessions/open',
    {
      config: { policy: authenticated() },
      schema: {
        summary: "List the open sessions of the caller's teams",
        description:
          "The PUBLISHED sessions that have not started, in every team where the caller is APPROVED (a PENDING, REJECTED or BANNED membership contributes nothing), soonest first and ties by session id; one page of 50 (`hasMore`). Each row carries the team name, the place, the full address, the start and end instants, the caller's own per-person fee (`unitFee`, and `feeLevel` for BY_SKILL_LEVEL; null while the session is not fully priced), `seatsLeft` and `waitlistLength`, the caller's own status (`me`, null when not registered), and `canRegister` with its `blockedReason`. `overdueCount` is the caller's OVERDUE payments across all teams.",
        operationId: 'listMyOpenSessions',
        response: { 200: OpenSessionsResponse, 401: ErrorResponse },
      },
    },
    async (request) => service.openSessions(requireAuth(request).userId),
  );

  typed.get(
    '/me/registrations',
    {
      config: { policy: authenticated() },
      schema: {
        summary: "List the caller's registrations across teams",
        description:
          "Every registration of the caller (CONFIRMED, WAITLISTED, and WITHDRAWN where a late fee is owed or was billed; a free early withdrawal is never listed), with no membership filter: a removed or banned player still sees their own history. `upcoming` (a PUBLISHED session that has not started, soonest first) is returned on the first page only. `past` (everything else, including a cancelled session's registration) is newest first, 20 per page; `nextCursor` is opaque and is passed back as `cursor` (a cursor the API refuses is 422). Each row carries the place, the address, the registration state, the party size, the payment once billing has produced one (`payment`: amount, status, due date, `onHold`, `payoutBlocked`) and otherwise the party fee estimate (`estimatedTotal`).",
        operationId: 'listMyRegistrations',
        querystring: DashboardRegistrationsQuery,
        response: { 200: DashboardRegistrationsResponse, 401: ErrorResponse, 422: ErrorResponse },
      },
    },
    async (request) => service.registrations(requireAuth(request).userId, request.query),
  );

  return Promise.resolve();
};
