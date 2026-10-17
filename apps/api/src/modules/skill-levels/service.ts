/**
 * Skill-levels HTTP use cases: the admin override and the Auto Enroll save (skill-levels-and-auto-enroll Phase 3).
 * Both run the moderation transaction shape (seams architecture D2), in one transaction each:
 *
 *   1. `SET LOCAL lock_timeout = '2s'` (a save that cannot get its locks fails fast and writes nothing),
 *   2. `assertTeamAdminUnderLock(..., 'noKeyUpdate')`: the team row (the per-team mutex), then the actor re-check
 *      under it, because the route guard ran outside this transaction (403 when demoted or banned since),
 *   3. the member row `FOR NO KEY UPDATE` (404 when absent, 409 when not APPROVED),
 *   4. a pure decision (`decisions.ts`); a no-op writes nothing and logs nothing,
 *   5. a guarded `UPDATE ... WHERE status = 'APPROVED'`,
 *   6. the member re-read through `teams/member-read.ts` for the answer.
 *
 * Lock order is teams -> team_members everywhere, as in moderation; a ban and a save therefore serialise on the
 * team row (AC-ERROR-5). Instants come from the injected clock only, read after the locks. Nothing here writes registrations: Auto
 * Enroll applies to sessions selected after the save (not retroactive). Events carry ids, levels and booleans.
 */
import { sql } from 'kysely';
import {
  instantToLocal,
  SKILL_LEVELS_FIELD_MESSAGES,
  type MemberSkillChangeResponse,
  type SetAutoEnrollRequest,
  type SetSkillLevelRequest,
  type TeamMemberRow,
} from '@sgm/shared';
import { refusing, type RefusalLogger } from '../../lib/auth/team-refusals.ts';
import type { Clock } from '../../lib/clock.ts';
import type { Database } from '../../lib/db/kysely.ts';
import { AppError } from '../../lib/http/errors.ts';
import { assertTeamAdminUnderLock } from '../teams/admin-lock.ts';
import { getMemberRow } from '../teams/member-read.ts';
import { decideAutoEnrolChange, decideOverride } from './decisions.ts';
import { MemberStaleError, mapSkillLevelsDbError } from './errors.ts';
import * as repo from './repo.ts';

export interface SkillLevelsContext {
  /** `request.log`, which carries the traceId. */
  readonly log: RefusalLogger;
}

export interface SkillLevelsServiceDeps {
  readonly db: Database;
  readonly clock: Clock;
}

export interface MemberTarget {
  readonly teamId: string;
  readonly actorId: string;
  readonly userId: string;
}

export interface SkillLevelsService {
  setSkillLevel(
    target: MemberTarget,
    input: SetSkillLevelRequest,
    ctx: SkillLevelsContext,
  ): Promise<MemberSkillChangeResponse>;
  setAutoEnroll(
    target: MemberTarget,
    input: SetAutoEnrollRequest,
    ctx: SkillLevelsContext,
  ): Promise<MemberSkillChangeResponse>;
}

export function createSkillLevelsService(deps: SkillLevelsServiceDeps): SkillLevelsService {
  const { db, clock } = deps;

  /** Steps 1-3 of the shape, then `work` with the locked member; maps database refusals on the way out. */
  async function underMemberLock<T>(
    target: MemberTarget,
    work: (trx: Database, member: repo.LockedMember) => Promise<T>,
  ): Promise<T> {
    try {
      return await db.transaction().execute(async (trx) => {
        // The lock wait an admin save tolerates (an HTTP request must not queue for long; 55P03 maps to 503).
        await sql`SET LOCAL lock_timeout = '2s'`.execute(trx);
        await assertTeamAdminUnderLock(trx, target.teamId, target.actorId, 'noKeyUpdate');
        const member = await repo.lockMemberRow(trx, target.teamId, target.userId);
        if (member === undefined) throw new AppError('not_found');
        if (member.status !== 'APPROVED') throw new AppError('membership_state_conflict');
        return work(trx, member);
      });
    } catch (error) {
      throw mapSkillLevelsDbError(error);
    }
  }

  async function readMember(
    trx: Database,
    target: MemberTarget,
    now: Date,
  ): Promise<TeamMemberRow> {
    const row = await getMemberRow(trx, target.teamId, target.userId, now);
    if (row === undefined) throw new Error('membership vanished inside its own transaction');
    return row;
  }

  return {
    setSkillLevel(target, input, ctx) {
      const { teamId, actorId, userId } = target;
      return refusing(ctx.log, { action: 'skill_override', actorId, teamId }, async () => {
        const outcome = await underMemberLock(target, async (trx, member) => {
          // Read after the locks: a save that waited behind another writer stamps when it wrote, not when it
          // arrived.
          const now = clock.now();
          const decision = decideOverride(member, input);
          if (decision.kind === 'stale') {
            throw new MemberStaleError('skill_level_stale', await readMember(trx, target, now));
          }
          if (decision.kind === 'change') {
            const written = await repo.applyOverride(trx, member.id, {
              to: decision.to,
              actorId,
              now,
            });
            if (!written) throw new AppError('membership_state_conflict');
          }
          return { decision, member: await readMember(trx, target, now) };
        });
        if (outcome.decision.kind === 'change') {
          ctx.log.info(
            {
              event: 'team.member.skill_overridden',
              teamId,
              actorId,
              userId,
              from: outcome.decision.from,
              to: outcome.decision.to,
            },
            'member skill level overridden',
          );
        }
        return { member: outcome.member, changed: outcome.decision.kind === 'change' };
      });
    },

    setAutoEnroll(target, input, ctx) {
      const { teamId, actorId, userId } = target;
      return refusing(ctx.log, { action: 'auto_enroll', actorId, teamId }, async () => {
        const outcome = await underMemberLock(target, async (trx, member) => {
          // Read after the locks, so "today" and a new place in the order follow commit order: a save that
          // waited across NZ midnight cannot store an end date that is already past.
          const now = clock.now();
          const todayNz = instantToLocal(now).date;
          const decision = decideAutoEnrolChange(member.autoEnroll, input, { todayNz, now });
          if (decision.kind === 'invalid_until') {
            throw new AppError('validation_failed', {
              fieldErrors: { until: [SKILL_LEVELS_FIELD_MESSAGES.untilInvalid] },
            });
          }
          if (decision.kind === 'stale') {
            throw new MemberStaleError('auto_enroll_stale', await readMember(trx, target, now));
          }
          if (decision.kind === 'set') {
            if (!(await repo.applyAutoEnrol(trx, member.id, decision.next))) {
              throw new AppError('membership_state_conflict');
            }
          }
          return { decision, member: await readMember(trx, target, now) };
        });
        if (outcome.decision.kind === 'set') {
          // The date itself is not logged; whether there is one is enough.
          ctx.log.info(
            {
              event: 'team.member.auto_enroll_changed',
              teamId,
              actorId,
              userId,
              enabled: outcome.decision.next.enabled,
              hasUntil: outcome.decision.next.until !== null,
            },
            'member auto enroll changed',
          );
        }
        return { member: outcome.member, changed: outcome.decision.kind === 'set' };
      });
    },
  };
}
