import type { FastifyPluginAsync, FastifyRequest } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import {
  CreateTeamRequest,
  CreateTeamResponse,
  ErrorResponse,
  FindTeamsQuery,
  FindTeamsResponse,
  InviteCodeResponse,
  InviteLookupRequest,
  InviteLookupResponse,
  JoinRequestRequest,
  JoinRequestResponse,
  MineTeamsResponse,
  TeamDetailResponse,
  TeamIdParams,
} from '@sgm/shared';
import { authenticated, optionalSession, requireTeamRole } from '../../lib/auth/policy.ts';
import { requireAuth } from '../../lib/auth/request-auth.ts';
import type { TeamsContext, TeamsService } from './service.ts';

export interface TeamsRoutesOptions {
  readonly service: TeamsService;
}

const contextOf = (request: FastifyRequest): TeamsContext => ({ log: request.log });

/**
 * `/teams/*` Phase 2 endpoints (the moderation routes arrive in Phase 3). The invite code is in no response except
 * the two `TEAM_ADMIN` invite-code routes and travels in the lookup and join request bodies only.
 */
export const teamsRoutes: FastifyPluginAsync<TeamsRoutesOptions> = (app, options) => {
  const { service } = options;
  const typed = app.withTypeProvider<ZodTypeProvider>();

  typed.post(
    '',
    {
      config: { policy: authenticated() },
      schema: {
        summary: 'Create a team',
        description:
          'The creator becomes an approved TEAM_ADMIN with the skill level they chose. The body is strict (no `inviteCode`, `role`, `createdBy`). `idempotencyKey` is a UUID v4 the form generates once per render: a replay of the same key by the same user answers 200 with the team that already exists instead of 201, and never creates a second team.',
        operationId: 'createTeam',
        body: CreateTeamRequest,
        response: {
          200: CreateTeamResponse,
          201: CreateTeamResponse,
          422: ErrorResponse,
        },
      },
    },
    async (request, reply) => {
      const outcome = await service.create(
        requireAuth(request).userId,
        request.body,
        contextOf(request),
      );
      return reply.code(outcome.created ? 201 : 200).send(outcome.body);
    },
  );

  typed.get(
    '/find',
    {
      config: { policy: optionalSession() },
      schema: {
        summary: 'Find a team',
        description:
          "PUBLIC teams only. `q` is a case-insensitive substring match on name or description (`%`, `_` and `\\` are literal); results are ordered by (lower(name), id), 20 per page, with opaque keyset cursors in both directions. `myStatus` is the signed-in caller's own PENDING, APPROVED or REJECTED row, null otherwise (and for BANNED).",
        operationId: 'findTeams',
        querystring: FindTeamsQuery,
        response: { 200: FindTeamsResponse, 422: ErrorResponse },
      },
    },
    async (request) => service.find(request.auth?.userId ?? null, request.query),
  );

  typed.get(
    '/mine',
    {
      config: { policy: authenticated() },
      schema: {
        summary: 'My teams',
        description:
          "The caller's teams with their role and status; BANNED rows are omitted. Rows where the caller is an approved admin carry `pendingRequestCount`; rows with waiting requests come first.",
        operationId: 'listMyTeams',
        response: { 200: MineTeamsResponse },
      },
    },
    async (request) => service.mine(requireAuth(request).userId),
  );

  typed.post(
    '/invite/lookup',
    {
      config: { policy: authenticated() },
      schema: {
        summary: 'Look up a team by invite code',
        description:
          'POST so the code never appears in a URL the API logs. An unknown, malformed or regenerated code is 404 `invite_invalid`; a caller banned from the team gets 403 `banned_from_team` and no team preview.',
        operationId: 'lookupTeamInvite',
        body: InviteLookupRequest,
        response: {
          200: InviteLookupResponse,
          403: ErrorResponse,
          404: ErrorResponse,
          422: ErrorResponse,
        },
      },
    },
    async (request) =>
      service.lookupInvite(requireAuth(request).userId, request.body.code, contextOf(request)),
  );

  typed.get(
    '/:teamId',
    {
      config: { policy: optionalSession() },
      schema: {
        summary: 'Team detail',
        description:
          "A PUBLIC team, or a PRIVATE team only for a caller with a non-banned membership row; otherwise 404 `not_found`, identical to a team that does not exist. `myStatus` and `myRole` are the caller's own row (BANNED included).",
        operationId: 'getTeam',
        params: TeamIdParams,
        response: { 200: TeamDetailResponse, 404: ErrorResponse, 422: ErrorResponse },
      },
    },
    async (request) => service.detail(request.params.teamId, request.auth?.userId ?? null),
  );

  typed.post(
    '/:teamId/join-requests',
    {
      config: { policy: authenticated() },
      schema: {
        summary: 'Ask to join a team',
        description:
          'Creates a PENDING membership with the required self-assessed `skillLevel` (a REJECTED row returns to PENDING). A PRIVATE team is joined only with its current `inviteCode`; without it the answer is 404 `not_found`, identical to an unknown team. A PUBLIC team with a stale `inviteCode` is 404 `invite_invalid`. 409 `already_requested` / `already_member`; 403 `banned_from_team`.',
        operationId: 'requestToJoinTeam',
        params: TeamIdParams,
        body: JoinRequestRequest,
        response: {
          201: JoinRequestResponse,
          403: ErrorResponse,
          404: ErrorResponse,
          409: ErrorResponse,
          422: ErrorResponse,
        },
      },
    },
    async (request, reply) => {
      const body = await service.join(
        request.params.teamId,
        requireAuth(request).userId,
        request.body,
        contextOf(request),
      );
      return reply.code(201).send(body);
    },
  );

  typed.get(
    '/:teamId/invite-code',
    {
      config: { policy: requireTeamRole('TEAM_ADMIN') },
      schema: {
        summary: 'The team invite code',
        description:
          'TEAM_ADMIN of this team only (`allowGlobalAdmin` is off); the guard answers 403 before anything else. The only responses that carry the code are this one and regenerate.',
        operationId: 'getTeamInviteCode',
        params: TeamIdParams,
        response: { 200: InviteCodeResponse, 404: ErrorResponse },
      },
    },
    async (request, reply) => {
      void reply.header('cache-control', 'no-store');
      return service.getInviteCode(request.params.teamId);
    },
  );

  typed.post(
    '/:teamId/invite-code/regenerate',
    {
      config: { policy: requireTeamRole('TEAM_ADMIN') },
      schema: {
        summary: 'Regenerate the team invite code',
        description:
          'TEAM_ADMIN of this team only. Replaces the code under a team-row lock: the old code fails immediately for lookups and joins; pending requests and members are unaffected.',
        operationId: 'regenerateTeamInviteCode',
        params: TeamIdParams,
        response: { 200: InviteCodeResponse, 404: ErrorResponse },
      },
    },
    async (request, reply) => {
      void reply.header('cache-control', 'no-store');
      return service.regenerateInviteCode(
        request.params.teamId,
        requireAuth(request).userId,
        contextOf(request),
      );
    },
  );

  return Promise.resolve();
};
