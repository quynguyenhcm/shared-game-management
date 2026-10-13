import type { FastifyPluginAsync, FastifyRequest } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import {
  BanMemberRequest,
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
  MembersQuery,
  MembersResponse,
  MineTeamsResponse,
  ModerationResponse,
  TeamDetailResponse,
  TeamIdParams,
  TeamMemberParams,
} from '@sgm/shared';
import { authenticated, optionalSession, requireTeamRole } from '../../lib/auth/policy.ts';
import { requireAuth } from '../../lib/auth/request-auth.ts';
import { AppError } from '../../lib/http/errors.ts';
import type { TeamsContext, TeamsService } from './service.ts';

export interface TeamsRoutesOptions {
  readonly service: TeamsService;
}

const contextOf = (request: FastifyRequest): TeamsContext => ({ log: request.log });

/** The moderation actions that take no body; ban takes an optional `{ reason }`. */
const SIMPLE_MODERATIONS = [
  {
    action: 'approve',
    summary: 'Approve a join request',
    description:
      'PENDING to APPROVED, stamping approver and time; the self-assessed skill level is unchanged. The requester passes `requireTeamRole(MEMBER)` on their very next request.',
  },
  {
    action: 'reject',
    summary: 'Reject a join request',
    description:
      'PENDING to REJECTED. The person keeps no access and may ask again later (the same row returns to PENDING).',
  },
  {
    action: 'promote',
    summary: 'Make a member a team admin',
    description:
      'An APPROVED MEMBER becomes TEAM_ADMIN (status stays APPROVED). All admins are equal.',
  },
  {
    action: 'demote',
    summary: 'Remove admin rights',
    description:
      'An approved TEAM_ADMIN becomes a MEMBER; allowed on oneself. 409 `last_team_admin` when it would leave the team with no admin.',
  },
] as const;

/**
 * `/teams/*` endpoints. The invite code is in no response except the two `TEAM_ADMIN` invite-code routes and
 * travels in the lookup and join request bodies only. Moderation routes are `TEAM_ADMIN` of the team in the path
 * (no global-admin override): the guard answers 401/403 in `onRequest`, before the body is parsed or validated.
 */
export const teamsRoutes: FastifyPluginAsync<TeamsRoutesOptions> = (app, options) => {
  const { service } = options;
  const typed = app.withTypeProvider<ZodTypeProvider>();

  // A guard refusal never reaches a handler, so the service cannot log it: record `team.action.refused` here for the
  // admin routes (ids and the route template only, never the body). A 401 has no actor and is not logged.
  app.addHook('onError', (request, _reply, error, done) => {
    const policy = request.routeOptions.config.policy;
    if (
      policy?.kind === 'teamRole' &&
      error instanceof AppError &&
      error.code === 'forbidden' &&
      request.auth !== null
    ) {
      const params = request.params as Record<string, unknown> | undefined;
      const teamId = params?.[policy.teamIdParam];
      request.log.warn(
        {
          event: 'team.action.refused',
          action: `${request.method} ${request.routeOptions.url ?? ''}`,
          actorId: request.auth.userId,
          ...(typeof teamId === 'string' && /^[0-9a-f-]{36}$/i.test(teamId) ? { teamId } : {}),
          reason: 'forbidden',
        },
        'team action refused',
      );
    }
    done();
  });

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

  typed.get(
    '/:teamId/members',
    {
      config: { policy: requireTeamRole('TEAM_ADMIN') },
      schema: {
        summary: 'List team members for admins',
        description:
          'One section per call (`status` is PENDING, APPROVED or BANNED), 50 per page with an opaque keyset cursor for the same section. PENDING: oldest request first. APPROVED: admins first, then by name. BANNED: newest first, with the ban reason (admins only). Full name and self-assessed skill only; never an email. `adminCount` counts approved admins and drives the last-admin hint.',
        operationId: 'listTeamMembers',
        params: TeamIdParams,
        querystring: MembersQuery,
        response: { 200: MembersResponse, 422: ErrorResponse },
      },
    },
    async (request, reply) => {
      void reply.header('cache-control', 'no-store');
      return service.listMembers(request.params.teamId, request.query);
    },
  );

  for (const { action, summary, description } of SIMPLE_MODERATIONS) {
    typed.post(
      `/:teamId/members/:userId/${action}`,
      {
        config: { policy: requireTeamRole('TEAM_ADMIN') },
        schema: {
          summary,
          description: `${description} The target is always looked up by (team, user): a user with no row in this team is 404 \`not_found\`. An action that no longer matches the row's current state is 409 \`membership_state_conflict\`. The actor is re-checked as an approved admin under the team-row lock.`,
          operationId: `${action}TeamMember`,
          params: TeamMemberParams,
          response: {
            200: ModerationResponse,
            404: ErrorResponse,
            409: ErrorResponse,
            422: ErrorResponse,
          },
        },
      },
      async (request, reply) => {
        void reply.header('cache-control', 'no-store');
        return service.moderate(
          request.params.teamId,
          requireAuth(request).userId,
          request.params.userId,
          action,
          contextOf(request),
        );
      },
    );
  }

  typed.post(
    '/:teamId/members/:userId/ban',
    {
      config: { policy: requireTeamRole('TEAM_ADMIN') },
      schema: {
        summary: 'Ban a member',
        description:
          "An APPROVED MEMBER becomes BANNED (terminal in v1) and a `member-banned` job is enqueued in the same transaction. Access and new registrations are blocked at commit; cancelling existing registrations is the job handler's business (registration-and-waitlist). `reason` is optional, at most 500 characters, visible to team admins only. An approved admin cannot be banned until demoted (409 `team_admin_cannot_be_banned`).",
        operationId: 'banTeamMember',
        params: TeamMemberParams,
        // Nullish: a body-less POST reaches validation as `null`.
        body: BanMemberRequest.nullish(),
        response: {
          200: ModerationResponse,
          404: ErrorResponse,
          409: ErrorResponse,
          422: ErrorResponse,
        },
      },
    },
    async (request, reply) => {
      void reply.header('cache-control', 'no-store');
      return service.ban(
        request.params.teamId,
        requireAuth(request).userId,
        request.params.userId,
        request.body?.reason,
        contextOf(request),
      );
    },
  );

  return Promise.resolve();
};
