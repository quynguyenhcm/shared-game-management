/**
 * Seeding and reading helpers for the skill-progression integration suites (job end-to-end and races).
 * Everything goes through plain SQL and the shared factories: no application code writes registrations yet.
 * A "game" is a CONFIRMED registration in a COMPLETED session of the team (C-GAME-1); sessions are shared by
 * many members, so a scene seeds its sessions once and registers members against them.
 */
import { expect } from 'vitest';
import type { SkillTier } from '@sgm/shared';
import { advanceSessionsTo, insertSession, insertTeamMember, insertUser } from './factories.ts';
import type { Queryable } from './test-db.ts';

type SessionStatus = 'DRAFT' | 'PUBLISHED' | 'CANCELLED' | 'COMPLETED';

/** `YYYY-MM-DD` plus `days` (UTC arithmetic on a calendar date). */
export function addDays(date: string, days: number): string {
  const instant = Date.parse(`${date}T00:00:00Z`) + days * 86_400_000;
  return new Date(instant).toISOString().slice(0, 10);
}

/** `count` sessions of `teamId` on consecutive dates from `startDate`, all moved to `status`. */
export async function makeSessions(
  db: Queryable,
  teamId: string,
  count: number,
  startDate: string,
  status: SessionStatus = 'COMPLETED',
): Promise<string[]> {
  const ids: string[] = [];
  for (let index = 0; index < count; index += 1) {
    ids.push(
      await insertSession(db, teamId, { flat: '0.00' }, { date: addDays(startDate, index) }),
    );
  }
  await advanceSessionsTo(db, ids, status);
  return ids;
}

/** One registration per session for `userId`, in one statement. */
export async function register(
  db: Queryable,
  teamId: string,
  userId: string,
  sessionIds: readonly string[],
  status: 'CONFIRMED' | 'WITHDRAWN' = 'CONFIRMED',
): Promise<void> {
  if (sessionIds.length === 0) return;
  await db.query(
    `INSERT INTO registrations (session_id, team_id, user_id, status, queue_position, guest_count, withdrawn_at,
                                withdrawal_kind, registrant_sex, registrant_skill_level)
     SELECT unnest($1::uuid[]), $2, $3, $4::registration_status, NULL, 0,
            CASE WHEN $4::registration_status = 'WITHDRAWN' THEN now() END,
            CASE WHEN $4::registration_status = 'WITHDRAWN' THEN 'EARLY'::withdrawal_kind END,
            CASE WHEN $4::registration_status = 'CONFIRMED' THEN (SELECT sex FROM users WHERE id = $3) END,
            CASE WHEN $4::registration_status = 'CONFIRMED' THEN coalesce(
              (SELECT skill_level FROM team_members WHERE team_id = $2 AND user_id = $3), 'BEGINNER') END`,
    [sessionIds, teamId, userId, status],
  );
}

export interface SceneMember {
  readonly userId: string;
  readonly membershipId: string;
}

export async function addMember(
  db: Queryable,
  teamId: string,
  options: {
    skillLevel?: SkillTier;
    status?: 'APPROVED' | 'BANNED' | 'PENDING';
    role?: 'TEAM_ADMIN' | 'MEMBER';
  } = {},
): Promise<SceneMember> {
  const userId = await insertUser(db);
  const membershipId = await insertTeamMember(db, {
    teamId,
    userId,
    skillLevel: options.skillLevel ?? 'BEGINNER',
    status: options.status ?? 'APPROVED',
    role: options.role ?? 'MEMBER',
  });
  return { userId, membershipId };
}

export interface MemberState {
  readonly status: string;
  readonly role: string;
  readonly skillLevel: SkillTier;
  readonly changedAt: Date | null;
  readonly overrideBy: string | null;
  readonly overrideAt: Date | null;
}

export async function readMemberState(
  db: Queryable,
  teamId: string,
  userId: string,
): Promise<MemberState> {
  const { rows } = await db.query<{
    status: string;
    role: string;
    skill_level: SkillTier;
    skill_level_changed_at: Date | null;
    skill_level_override_by: string | null;
    skill_level_override_at: Date | null;
  }>(
    `SELECT status, role, skill_level, skill_level_changed_at, skill_level_override_by, skill_level_override_at
       FROM team_members WHERE team_id = $1 AND user_id = $2`,
    [teamId, userId],
  );
  const row = rows[0];
  if (row === undefined) throw new Error('member row not found');
  return {
    status: row.status,
    role: row.role,
    skillLevel: row.skill_level,
    changedAt: row.skill_level_changed_at,
    overrideBy: row.skill_level_override_by,
    overrideAt: row.skill_level_override_at,
  };
}

/** The CHECK-level invariants of AC-VERIFY-1 restated in TypeScript, for "the final row is always valid". */
export function expectInvariants(state: MemberState): void {
  expect(state.overrideBy === null, 'override stamps are paired').toBe(state.overrideAt === null);
  if (state.overrideAt !== null) {
    expect(state.changedAt, 'an override always sets the baseline').not.toBeNull();
    expect(state.changedAt?.getTime() ?? 0).toBeGreaterThanOrEqual(state.overrideAt.getTime());
  }
}

/** Sets the level as an admin override would (one `at` in all three stamps). */
export async function applyRawOverride(
  db: Queryable,
  teamId: string,
  userId: string,
  input: { to: SkillTier; actorId: string; at: Date },
): Promise<void> {
  await db.query(
    `UPDATE team_members
        SET skill_level = $3, skill_level_override_by = $4, skill_level_override_at = $5,
            skill_level_changed_at = $5
      WHERE team_id = $1 AND user_id = $2`,
    [teamId, userId, input.to, input.actorId, input.at],
  );
}
