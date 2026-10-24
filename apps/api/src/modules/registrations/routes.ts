import type { FastifyPluginAsync, FastifyRequest } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import {
  ErrorResponse,
  RegistrationReadResponse,
  SessionIdParams,
  SessionRegisterRequest,
  SessionRegisterResponse,
  SessionWithdrawRequest,
  SessionWithdrawResponse,
  TeamIdParams,
  UpcomingSessionsResponse,
} from '@sgm/shared';
import { requireTeamRole } from '../../lib/auth/policy.ts';
import { requireAuth } from '../../lib/auth/request-auth.ts';
import type { RegistrationsContext, RegistrationsService } from './service.ts';

export interface RegistrationsRoutesOptions {
  readonly service: RegistrationsService;
}

const contextOf = (request: FastifyRequest): RegistrationsContext => ({ log: request.log });

/**
 * The guard answers 401 and 403 in `onRequest`, before the body is parsed, so a non-member is never answered with a 422. The
 * service answers 404, 409 and 422.
 */
const GUARDED = { 401: ErrorResponse, 403: ErrorResponse } as const;
const SESSION_LOOKUP = { ...GUARDED, 404: ErrorResponse } as const;
const WRITE_ERRORS = { ...SESSION_LOOKUP, 409: ErrorResponse, 422: ErrorResponse } as const;

const ACCESS =
  "An APPROVED member of this team only (`allowGlobalAdmin` is off). A session id is always resolved together with the team in the path: another team's session, a DRAFT and an unknown id all answer the same 404 `not_found`.";

/**
 * `/teams/:teamId/sessions/upcoming` and `/teams/:teamId/sessions/:sessionId/registration*` (registration-and-waitlist):
 * the member-facing read model, register and withdraw. These routes are reserved in session-scheduling-engine's namespace
 * (ADR 0019 §8); its parametric `GET /teams/:teamId/sessions/:sessionId` is TEAM_ADMIN only, and `upcoming` is a static segment
 * that wins over it. Strict shared bodies; `cache-control: no-store` on every answer, errors included.
 */
export const registrationsRoutes: FastifyPluginAsync<RegistrationsRoutesOptions> = (
  app,
  options,
) => {
  const { service } = options;
  const typed = app.withTypeProvider<ZodTypeProvider>();
  const policy = requireTeamRole('MEMBER');

  // The numbers change with every registration: nothing here is cacheable.
  app.addHook('onSend', (_request, reply, payload, done) => {
    void reply.header('cache-control', 'no-store');
    done(null, payload);
  });

  typed.get(
    '/:teamId/sessions/upcoming',
    {
      config: { policy },
      schema: {
        summary: "List a team's upcoming sessions (member)",
        description: `The next 10 PUBLISHED sessions that have not started, soonest first, with seats left, the waitlist length and the caller's own status and waitlist rank (\`me\`, null when not registered); \`hasMore\` says there are more. ${ACCESS}`,
        operationId: 'listUpcomingTeamSessions',
        params: TeamIdParams,
        response: { 200: UpcomingSessionsResponse, ...GUARDED },
      },
    },
    async (request) => service.upcoming(request.params.teamId, requireAuth(request).userId),
  );

  typed.get(
    '/:teamId/sessions/:sessionId/registration',
    {
      config: { policy },
      schema: {
        summary: 'Read a session and my registration',
        description: `The session page's read model: the session summary with \`seatsTaken\`, \`seatsLeft\`, \`waitlistLength\` and the fees, the caller's own registration (guests, and \`waitlistRank\` = 1 + the waiting parties ahead), their per-person fee and the party estimate, how many payments are overdue, and whether they can register (\`canRegister\`, \`blockedReason\`). A CANCELLED, COMPLETED or started session is still returned, with \`canRegister: false\` and \`blockedReason: 'session_not_open'\`, so the page can say so; a DRAFT is 404. ${ACCESS}`,
        operationId: 'getSessionRegistration',
        params: SessionIdParams,
        response: { 200: RegistrationReadResponse, ...SESSION_LOOKUP },
      },
    },
    async (request) =>
      service.read(request.params.teamId, request.params.sessionId, requireAuth(request).userId),
  );

  typed.post(
    '/:teamId/sessions/:sessionId/registrations',
    {
      config: { policy },
      schema: {
        summary: 'Register for a session',
        description: `Registers the caller with 0 to 2 guests (sex and skill level required, name optional) and answers 201 with the registration: CONFIRMED when the whole party fits, otherwise WAITLISTED with \`waitlistRank\`. 403 \`overdue_payments\` at 3 or more overdue payments; 409 \`session_not_open\` (not PUBLISHED, or started), \`already_registered\` (an active registration exists) or \`late_withdrawal_fee_due\`; 422 \`party_exceeds_capacity\` when the party can never fit and \`validation_failed\` (with \`fieldErrors\` keyed \`guests.{i}.sex\`, \`guests.{i}.skillLevel\`, \`guests.{i}.displayName\`) for a bad body. The member gate runs inside the transaction before the session is locked: a member banned meanwhile is 403 \`forbidden\`. ${ACCESS}`,
        operationId: 'registerForSession',
        params: SessionIdParams,
        body: SessionRegisterRequest,
        response: { 201: SessionRegisterResponse, ...WRITE_ERRORS },
      },
    },
    async (request, reply) => {
      const response = await service.register(
        request.params.teamId,
        request.params.sessionId,
        requireAuth(request).userId,
        request.body,
        contextOf(request),
      );
      void reply.code(201);
      return response;
    },
  );

  typed.post(
    '/:teamId/sessions/:sessionId/registrations/me/withdraw',
    {
      config: { policy },
      schema: {
        summary: 'Withdraw my registration',
        description: `Withdraws the caller's active registration (CONFIRMED or WAITLISTED). Before the cancellation deadline it is free (EARLY); after it, LATE, and the fee is owed unless the waitlist takes the place (\`replacedBy\` 'waitlist' or 'nobody', never who). \`expectLate\` is the caller's view of the terms: a LATE withdrawal with \`expectLate: false\` is 409 \`cancellation_terms_changed\` and nothing changes. 409 \`not_registered\` when there is no active registration (also on a repeat), 409 \`session_not_open\` for a session that is not open. Debt never blocks a withdrawal. \`feeEstimate\` is the party fee when it is owed, otherwise 0.00. ${ACCESS}`,
        operationId: 'withdrawFromSession',
        params: SessionIdParams,
        body: SessionWithdrawRequest,
        response: { 200: SessionWithdrawResponse, ...WRITE_ERRORS },
      },
    },
    async (request) =>
      service.withdraw(
        request.params.teamId,
        request.params.sessionId,
        requireAuth(request).userId,
        request.body,
        contextOf(request),
      ),
  );

  return Promise.resolve();
};
