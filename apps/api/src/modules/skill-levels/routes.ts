import type { FastifyPluginAsync, FastifyRequest } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import {
  ErrorResponse,
  MemberSkillChangeResponse,
  SetAutoEnrollRequest,
  SetSkillLevelRequest,
  SkillLevelConflictResponse,
  TeamMemberParams,
} from '@sgm/shared';
import { requireTeamRole } from '../../lib/auth/policy.ts';
import { requireAuth } from '../../lib/auth/request-auth.ts';
import { SkillLevelStaleError } from './errors.ts';
import type { MemberTarget, SkillLevelsContext, SkillLevelsService } from './service.ts';

export interface SkillLevelsRoutesOptions {
  readonly service: SkillLevelsService;
}

const contextOf = (request: FastifyRequest): SkillLevelsContext => ({ log: request.log });

const targetOf = (
  request: FastifyRequest,
  params: { readonly teamId: string; readonly userId: string },
): MemberTarget => ({
  teamId: params.teamId,
  actorId: requireAuth(request).userId,
  userId: params.userId,
});

/** Shared wording for both routes' OpenAPI descriptions. */
const SHAPE =
  'TEAM_ADMIN of this team only (`allowGlobalAdmin` is off): the guard answers 401/403 before the body is read, so an invalid body from a non-admin is still 403. The target is looked up by (team, user): a user with no row in this team is 404 `not_found`; a PENDING, REJECTED or BANNED target is 409 `membership_state_conflict`. The actor is re-checked as an approved admin under the team-row lock (403 when demoted meanwhile). Admins may change their own row. `changed: false` means nothing was written and no event was logged.';

/**
 * `PUT /teams/:teamId/members/:userId/{skill-level,auto-enroll}` (skill-levels-and-auto-enroll). Strict shared
 * bodies; `cache-control: no-store` on every answer. Registered under the `/teams` prefix in `buildApp`.
 */
export const skillLevelsRoutes: FastifyPluginAsync<SkillLevelsRoutesOptions> = (app, options) => {
  const { service } = options;
  const typed = app.withTypeProvider<ZodTypeProvider>();
  const policy = requireTeamRole('TEAM_ADMIN');

  // Member data for admins only: nothing here is cacheable, whatever the status.
  app.addHook('onSend', (_request, reply, payload, done) => {
    void reply.header('cache-control', 'no-store');
    done(null, payload);
  });

  typed.put(
    '/:teamId/members/:userId/skill-level',
    {
      config: { policy },
      schema: {
        summary: "Set a member's skill level",
        description: `Overrides an APPROVED member's level, up or down, recording who and when; it also restarts the member's count toward automatic progression (games before the override no longer count). Saving the level the member already has is a no-op. \`expectedSkillLevel\` and \`expectedChangedAt\` are the \`skillLevel\` and \`skillChangedAt\` the panel was showing: when either is no longer current (another admin saved, or the member was moved up automatically) the answer is 409 \`skill_level_stale\` with the current \`member\`, and nothing is written. Existing registrations keep their fee. ${SHAPE}`,
        operationId: 'setTeamMemberSkillLevel',
        params: TeamMemberParams,
        body: SetSkillLevelRequest,
        response: {
          200: MemberSkillChangeResponse,
          401: ErrorResponse,
          403: ErrorResponse,
          404: ErrorResponse,
          409: SkillLevelConflictResponse,
          422: ErrorResponse,
        },
      },
    },
    async (request, reply) => {
      try {
        return await service.setSkillLevel(
          targetOf(request, request.params),
          request.body,
          contextOf(request),
        );
      } catch (error) {
        if (error instanceof SkillLevelStaleError) {
          return reply.code(409).send({
            error: { code: error.code, message: error.message },
            member: error.member,
          });
        }
        throw error;
      }
    },
  );

  typed.put(
    '/:teamId/members/:userId/auto-enroll',
    {
      config: { policy },
      schema: {
        summary: "Set a member's Auto Enroll",
        description: `Turns Auto Enroll on (with an optional inclusive end date \`until\`, a Pacific/Auckland calendar date that must be today or later: 422 \`fieldErrors.until\` otherwise) or off. Turning it on puts the member at the back of the Auto Enroll order; changing only \`until\` keeps their place; an assignment that already ended (\`until\` before today) counts as off, so renewing it is a new place at the back. Off clears the end date and the place. \`until\` with \`enabled: false\` is 422. Auto Enroll applies to sessions selected after the save: nothing is registered or withdrawn now. ${SHAPE}`,
        operationId: 'setTeamMemberAutoEnroll',
        params: TeamMemberParams,
        body: SetAutoEnrollRequest,
        response: {
          200: MemberSkillChangeResponse,
          401: ErrorResponse,
          403: ErrorResponse,
          404: ErrorResponse,
          409: ErrorResponse,
          422: ErrorResponse,
        },
      },
    },
    async (request) =>
      service.setAutoEnroll(targetOf(request, request.params), request.body, contextOf(request)),
  );

  return Promise.resolve();
};
