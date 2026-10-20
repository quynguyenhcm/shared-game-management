import type { FastifyPluginAsync, FastifyRequest } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import {
  CancelSessionResponse,
  CreateSessionRequest,
  ErrorResponse,
  ListSessionsQuery,
  SessionCommandRequest,
  SessionDetailResponse,
  SessionErrorResponse,
  SessionIdParams,
  SessionListResponse,
  SessionWriteResponse,
  TeamIdParams,
  UpdateSessionRequest,
} from '@sgm/shared';
import { requireTeamRole } from '../../lib/auth/policy.ts';
import { requireAuth } from '../../lib/auth/request-auth.ts';
import type { SessionsContext, SessionsService } from './service.ts';

export interface SessionsRoutesOptions {
  readonly service: SessionsService;
}

const contextOf = (request: FastifyRequest): SessionsContext => ({ log: request.log });

/**
 * The guard answers 401 and 403 in `onRequest`, before the body is parsed; the service answers 404, 409 and 422. A 409 or
 * 422 may carry what only session routes add to the shared error body: `current`, `raisedFields`, `dstOptions`.
 */
const ERRORS = {
  401: ErrorResponse,
  403: ErrorResponse,
  404: ErrorResponse,
  409: SessionErrorResponse,
  422: SessionErrorResponse,
} as const;

const SHAPE =
  'TEAM_ADMIN of this team only (`allowGlobalAdmin` is off); a session of another team is 404 `not_found`. The actor is re-checked as an approved admin under a row lock inside every write (403 when demoted meanwhile). Every write carries `expectedVersion`: a stale one is 409 `session_stale` with the latest row in `error.current`, and nothing is written.';

/**
 * `/teams/:teamId/sessions` (session-scheduling-engine, one-off sessions): the admin list, create with replay, read, edit,
 * publish and cancel. Strict shared bodies; `cache-control: no-store` on every answer, errors included. The member routes
 * `GET /teams/:teamId/sessions/upcoming` and `…/:sessionId/registration*` are reserved for registration-and-waitlist.
 */
export const sessionsRoutes: FastifyPluginAsync<SessionsRoutesOptions> = (app, options) => {
  const { service } = options;
  const typed = app.withTypeProvider<ZodTypeProvider>();
  const policy = requireTeamRole('TEAM_ADMIN');

  // Admin data that changes under the editor: nothing here is cacheable, whatever the status.
  app.addHook('onSend', (_request, reply, payload, done) => {
    void reply.header('cache-control', 'no-store');
    done(null, payload);
  });

  typed.get(
    '/:teamId/sessions',
    {
      config: { policy },
      schema: {
        summary: "List a team's sessions (admin)",
        description: `One section of the Sessions page per call: \`view=upcoming\` (PUBLISHED and not ended, soonest first), \`drafts\` (DRAFT with a future start, soonest first) or \`past\` (COMPLETED, CANCELLED, ended, and drafts whose start passed, most recent first), \`limit\` rows (default 25, at most 100) after the opaque \`cursor\`; \`nextCursor\` is null on the last page. Each row carries \`phase\` (from the API clock), \`draftReason\`, \`isInstanceOverridden\`, \`recurringRuleId\` and its courts; \`isPayoutConfigured\` lets the page show the banking notice. ${SHAPE}`,
        operationId: 'listTeamSessions',
        params: TeamIdParams,
        querystring: ListSessionsQuery,
        response: { 200: SessionListResponse, ...ERRORS },
      },
    },
    async (request) => service.list(request.params.teamId, request.query),
  );

  typed.post(
    '/:teamId/sessions',
    {
      config: { policy },
      schema: {
        summary: 'Create a one-off session (draft)',
        description: `Creates a DRAFT with its courts in one transaction; nothing is visible to members until it is published. \`createKey\` is a UUID the form generates once per render: a replay of a committed request answers 200 with the existing session and writes nothing. \`cancellationDeadline: null\` means the default, 48 hours before the first court starts, kept by the database when the start moves. Court and deadline times are Pacific/Auckland wall-clock times: one that does not exist or happens twice on a DST day is 422 with \`dstOptions\`. The date must not be in the past. A blank \`courtCost\` or \`extraExpenses\` is $0.00 (a free session). ${SHAPE}`,
        operationId: 'createTeamSession',
        params: TeamIdParams,
        body: CreateSessionRequest,
        response: { 200: SessionWriteResponse, 201: SessionWriteResponse, ...ERRORS },
      },
    },
    async (request, reply) => {
      const { replayed, response } = await service.create(
        request.params.teamId,
        requireAuth(request).userId,
        request.body,
        contextOf(request),
      );
      void reply.code(replayed ? 200 : 201);
      return response;
    },
  );

  typed.get(
    '/:teamId/sessions/:sessionId',
    {
      config: { policy },
      schema: {
        summary: 'Read one session (admin)',
        description: `The editor's view: \`version\`, \`deadlineIsDefault\`, \`activeRegistrationCount\` and \`feesLocked\` ('raise_only_blocked' once a PUBLISHED session has a registered player). ${SHAPE}`,
        operationId: 'getTeamSession',
        params: SessionIdParams,
        response: { 200: SessionDetailResponse, ...ERRORS },
      },
    },
    async (request) => service.get(request.params.teamId, request.params.sessionId),
  );

  typed.put(
    '/:teamId/sessions/:sessionId',
    {
      config: { policy },
      schema: {
        summary: 'Edit a session',
        description: `Replaces the editable content of a DRAFT or a not-started PUBLISHED session (a series date too: a real change marks it edited, its date can never move). A save that changes nothing is 200 and writes nothing. A started session is 409 \`session_started\`; a COMPLETED or CANCELLED one is 409 \`session_not_editable\`. Once a PUBLISHED session has an active registration, fees can only go down: a raise, a pricing-model change or free-to-paid is 409 \`session_fee_locked\` with \`raisedFields\`. Turning a PUBLISHED session from free to paid goes through the publish gate first (409 \`payout_not_configured\`). Raising public capacity calls the seat allocator once in the same transaction; the response carries \`promoted\` and \`material\` (a field players care about changed), and the session's \`activeRegistrationCount\`, so the admin can tell them. ${SHAPE}`,
        operationId: 'updateTeamSession',
        params: SessionIdParams,
        body: UpdateSessionRequest,
        response: { 200: SessionWriteResponse, ...ERRORS },
      },
    },
    async (request) =>
      service.update(
        request.params.teamId,
        request.params.sessionId,
        requireAuth(request).userId,
        request.body,
        contextOf(request),
      ),
  );

  typed.post(
    '/:teamId/sessions/:sessionId/publish',
    {
      config: { policy },
      schema: {
        summary: 'Publish a draft session',
        description: `DRAFT to PUBLISHED through the publish gate: a paid session needs the team's banking details (409 \`payout_not_configured\`, the draft is kept); the gate runs before the session is locked. A session without a court, or without every fee its pricing model reads, is 422 naming the field. A start that has passed is 409 \`session_started\`. Members on Auto Enroll are added once, in a follow-up job enqueued in this transaction. Publishing a PUBLISHED session is a 200 that writes and enqueues nothing. ${SHAPE}`,
        operationId: 'publishTeamSession',
        params: SessionIdParams,
        body: SessionCommandRequest,
        response: { 200: SessionWriteResponse, ...ERRORS },
      },
    },
    async (request) =>
      service.publish(
        request.params.teamId,
        request.params.sessionId,
        requireAuth(request).userId,
        request.body,
        contextOf(request),
      ),
  );

  typed.post(
    '/:teamId/sessions/:sessionId/cancel',
    {
      config: { policy },
      schema: {
        summary: 'Cancel a session',
        description: `DRAFT or not-started PUBLISHED to CANCELLED. Registrations are left exactly as they are and nobody is emailed; the answer's \`activeRegistrationCount\` is how many players the admin should let know. A cancelled series date keeps its row, so the series does not recreate it. A started session is 409 \`session_started\`; a closed one is 409 \`session_not_editable\`. ${SHAPE}`,
        operationId: 'cancelTeamSession',
        params: SessionIdParams,
        body: SessionCommandRequest,
        response: { 200: CancelSessionResponse, ...ERRORS },
      },
    },
    async (request) =>
      service.cancel(
        request.params.teamId,
        request.params.sessionId,
        requireAuth(request).userId,
        request.body,
        contextOf(request),
      ),
  );

  return Promise.resolve();
};
