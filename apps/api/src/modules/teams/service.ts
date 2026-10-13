/**
 * Team use cases for Phase 2: create (idempotent), Find, My teams, detail, invite lookup, join requests and the
 * invite-code admin actions. Handlers stay thin; the rules live here. Decisions: Architecture Q4 and Q5, the task
 * file's "Creative Reconciliation" (create idempotency, invite rotation race) and Journey A2, A3, A4, A17.
 *
 * Lock order (shared with Phase 3's moderation): the team row first, then team_members rows. A join holds the team
 * row `FOR SHARE`, a regenerate holds it `FOR UPDATE`, so a rotation and a join serialise: the join compares the
 * supplied code to the stored one under the lock and a rotation that committed first makes the old code fail.
 */
import type { FastifyBaseLogger } from 'fastify';
import {
  FIND_PAGE_SIZE,
  decodeFindCursor,
  encodeFindCursor,
  type CreateTeamRequest,
  type CreateTeamResponse,
  type FindTeamsQuery,
  type FindTeamsResponse,
  type InviteCodeResponse,
  type InviteLookupResponse,
  type JoinRequestRequest,
  type JoinRequestResponse,
  type MineTeamsResponse,
  type TeamDetailResponse,
} from '@sgm/shared';
import type { Clock } from '../../lib/clock.ts';
import type { Database } from '../../lib/db/kysely.ts';
import { AppError } from '../../lib/http/errors.ts';
import { inviteCodesMatch, isWellFormedInviteCode, withInviteCodeRetry } from './invite-code.ts';
import * as repo from './repo.ts';
import { containsPattern } from './search.ts';

/** The subset of the request logger the service uses (`request.log`, which carries the trace ids). */
export type TeamsLogger = Pick<FastifyBaseLogger, 'info' | 'warn'>;

export interface TeamsContext {
  readonly log: TeamsLogger;
}

export interface TeamsServiceDeps {
  readonly db: Database;
  readonly clock: Clock;
}

export interface CreateOutcome {
  /** 201 for a new team, 200 for a replay of the same idempotency key. */
  readonly created: boolean;
  readonly body: CreateTeamResponse;
}

export interface TeamsService {
  create(actorId: string, input: CreateTeamRequest, ctx: TeamsContext): Promise<CreateOutcome>;
  find(callerId: string | null, query: FindTeamsQuery): Promise<FindTeamsResponse>;
  mine(userId: string): Promise<MineTeamsResponse>;
  detail(teamId: string, callerId: string | null): Promise<TeamDetailResponse>;
  lookupInvite(callerId: string, code: string, ctx: TeamsContext): Promise<InviteLookupResponse>;
  join(
    teamId: string,
    callerId: string,
    input: JoinRequestRequest,
    ctx: TeamsContext,
  ): Promise<JoinRequestResponse>;
  getInviteCode(teamId: string): Promise<InviteCodeResponse>;
  regenerateInviteCode(
    teamId: string,
    actorId: string,
    ctx: TeamsContext,
  ): Promise<InviteCodeResponse>;
}

/**
 * Logs one `team.action.refused` event (reason = the error code, never the input) for a domain refusal and
 * rethrows. The request logger already carries the traceId.
 */
async function refusing<T>(
  ctx: TeamsContext,
  fields: { action: string; actorId: string; teamId?: string },
  work: () => Promise<T>,
): Promise<T> {
  try {
    return await work();
  } catch (error) {
    if (error instanceof AppError) {
      const level = error.code === 'forbidden' ? 'warn' : 'info';
      ctx.log[level](
        { event: 'team.action.refused', ...fields, reason: error.code },
        'team action refused',
      );
    }
    throw error;
  }
}

function cursorOf(row: repo.FindRow, direction: 'f' | 'b'): string {
  return encodeFindCursor({ v: 1, n: row.sort_name, i: row.id, d: direction });
}

export function createTeamsService(deps: TeamsServiceDeps): TeamsService {
  const { db, clock } = deps;

  return {
    async create(actorId, input, ctx) {
      const now = clock.now();
      // One transaction per attempt: a collision on the generated invite code aborts the one it ran in.
      const inserted = await withInviteCodeRetry((inviteCode) =>
        db.transaction().execute(async (trx) => {
          const team = await repo.insertTeam(trx, {
            name: input.name,
            description: input.description,
            visibility: input.visibility,
            inviteCode,
            createdBy: actorId,
            idempotencyKey: input.idempotencyKey,
          });
          if (team === undefined) return undefined;
          await repo.insertApprovedAdmin(trx, {
            teamId: team.id,
            userId: actorId,
            skillLevel: input.skillLevel,
            now,
          });
          return team;
        }),
      );
      if (inserted !== undefined) {
        ctx.log.info(
          { event: 'team.created', teamId: inserted.id, actorId, visibility: inserted.visibility },
          'team created',
        );
        return {
          created: true,
          body: {
            team: inserted,
            membership: { status: 'APPROVED', role: 'TEAM_ADMIN', skillLevel: input.skillLevel },
          },
        };
      }
      // The key was already used by this creator (a lost response, or a concurrent submit that committed first).
      const existing = await repo.findCreatedTeam(db, actorId, input.idempotencyKey);
      if (existing === undefined) {
        throw new Error('create idempotency conflict without a committed team');
      }
      return {
        created: false,
        body: {
          team: existing.team,
          membership: {
            status: existing.membership.status,
            role: existing.membership.role,
            skillLevel: existing.membership.skillLevel,
          },
        },
      };
    },

    async find(callerId, query) {
      const cursor = query.after === undefined ? null : decodeFindCursor(query.after);
      const rows = await repo.findTeams(db, {
        callerId,
        pattern: query.q === undefined ? null : containsPattern(query.q),
        cursor,
      });
      const backward = cursor?.d === 'b';
      const hasMore = rows.length > FIND_PAGE_SIZE;
      // A backward page is fetched nearest-first; the extra row is the farthest one, so trim before reversing.
      const page = rows.slice(0, FIND_PAGE_SIZE);
      if (backward) page.reverse();
      const first = page[0];
      const last = page.at(-1);
      let nextCursor: string | null = null;
      let prevCursor: string | null = null;
      if (first !== undefined && last !== undefined) {
        if (backward) {
          nextCursor = cursorOf(last, 'f');
          prevCursor = hasMore ? cursorOf(first, 'b') : null;
        } else {
          nextCursor = hasMore ? cursorOf(last, 'f') : null;
          prevCursor = cursor === null ? null : cursorOf(first, 'b');
        }
      }
      return {
        teams: page.map((row) => ({
          id: row.id,
          name: row.name,
          description: row.description,
          memberCount: row.member_count,
          // A banned caller is shown nothing on Find; the team page explains.
          myStatus: row.my_status === 'BANNED' ? null : row.my_status,
        })),
        nextCursor,
        prevCursor,
      };
    },

    async mine(userId) {
      const rows = await repo.listMine(db, userId);
      return {
        teams: rows.map((row) => ({
          id: row.id,
          name: row.name,
          visibility: row.visibility,
          role: row.role,
          status: row.status,
          ...(row.pending_count === null ? {} : { pendingRequestCount: row.pending_count }),
        })),
      };
    },

    async detail(teamId, callerId) {
      const team = await repo.getTeamWithCaller(db, teamId, callerId);
      // A private team is invisible to anyone without a non-banned membership row (no existence probe).
      if (
        team === undefined ||
        (team.visibility === 'PRIVATE' && (team.myStatus === null || team.myStatus === 'BANNED'))
      ) {
        throw new AppError('not_found');
      }
      return {
        team: {
          id: team.id,
          name: team.name,
          description: team.description,
          visibility: team.visibility,
          memberCount: team.memberCount,
        },
        myStatus: team.myStatus,
        myRole: team.myRole,
      };
    },

    lookupInvite(callerId, code, ctx) {
      return refusing(ctx, { action: 'invite_lookup', actorId: callerId }, async () => {
        if (!isWellFormedInviteCode(code)) throw new AppError('invite_invalid');
        const team = await repo.getTeamByInviteCode(db, code, callerId);
        if (team === undefined) throw new AppError('invite_invalid');
        // A banned caller learns nothing about the team (Journey A3).
        if (team.myStatus === 'BANNED') throw new AppError('banned_from_team');
        return {
          team: {
            id: team.id,
            name: team.name,
            description: team.description,
            visibility: team.visibility,
            memberCount: team.memberCount,
          },
          myStatus: team.myStatus,
        };
      });
    },

    join(teamId, callerId, input, ctx) {
      return refusing(ctx, { action: 'join', actorId: callerId, teamId }, async () => {
        const now = clock.now();
        const outcome = await db.transaction().execute(async (trx) => {
          const team = await repo.lockTeam(trx, teamId, 'share');
          if (team === undefined) throw new AppError('not_found');
          const existing = await repo.findMembership(trx, teamId, callerId);
          if (existing?.status === 'BANNED') throw new AppError('banned_from_team');
          const supplied = input.inviteCode;
          const codeMatches =
            supplied !== undefined &&
            isWellFormedInviteCode(supplied) &&
            inviteCodesMatch(supplied, team.inviteCode);
          if (team.visibility === 'PRIVATE') {
            // Only the invite link opens a private team; without it the team does not exist for the caller.
            if (!codeMatches) throw new AppError('not_found');
          } else if (supplied !== undefined && !codeMatches) {
            throw new AppError('invite_invalid');
          }
          const joined = await repo.upsertJoinRequest(trx, {
            teamId,
            userId: callerId,
            skillLevel: input.skillLevel,
            now,
          });
          if (joined === undefined) {
            const current = await repo.findMembership(trx, teamId, callerId);
            if (current?.status === 'PENDING') throw new AppError('already_requested');
            if (current?.status === 'APPROVED') throw new AppError('already_member');
            if (current?.status === 'BANNED') throw new AppError('banned_from_team');
            throw new AppError('membership_state_conflict');
          }
          return { joined, visibility: team.visibility, viaInvite: codeMatches };
        });
        ctx.log.info(
          {
            event: 'team.join.requested',
            teamId,
            actorId: callerId,
            visibility: outcome.visibility,
            viaInvite: outcome.viaInvite,
            rerequest: outcome.joined.rerequest,
          },
          'join requested',
        );
        return { membership: { status: 'PENDING', skillLevel: outcome.joined.skillLevel } };
      });
    },

    async getInviteCode(teamId) {
      const inviteCode = await repo.getInviteCode(db, teamId);
      if (inviteCode === undefined) throw new AppError('not_found');
      return { inviteCode };
    },

    regenerateInviteCode(teamId, actorId, ctx) {
      return refusing(ctx, { action: 'regenerate_invite', actorId, teamId }, async () => {
        const inviteCode = await withInviteCodeRetry((candidate) =>
          db.transaction().execute(async (trx) => {
            // Per-team mutex first (FOR UPDATE: the invite_code UPDATE needs the key lock), then the authority
            // re-check under it: the guard ran outside this transaction.
            const team = await repo.lockTeam(trx, teamId, 'update');
            if (team === undefined) throw new AppError('forbidden');
            if ((await repo.findApprovedRole(trx, teamId, actorId)) !== 'TEAM_ADMIN') {
              throw new AppError('forbidden');
            }
            await repo.setInviteCode(trx, teamId, candidate);
            return candidate;
          }),
        );
        ctx.log.info(
          { event: 'team.invite.regenerated', teamId, actorId },
          'invite code regenerated',
        );
        return { inviteCode };
      });
    },
  };
}
