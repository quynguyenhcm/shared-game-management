/**
 * The ONE `TeamMemberRow` mapper (public teams file; skill-levels-and-auto-enroll seams architecture D1a). Every
 * endpoint that answers with a member uses it: the admin members list, the moderation actions, and the two
 * skill-levels `PUT` routes. It owns the member column list, the join for the override actor's name and the
 * additive skill and Auto Enroll fields.
 *
 * `skillProgress` comes from `skill-levels/games.ts`, the single definition of a qualifying game that the
 * progression job also uses, so the progress line matches what the next run decides (AC-HAPPY-11). A page is
 * counted with ONE grouped query for its APPROVED rows below ADVANCED (`countQualifyingGamesBatch`), never one
 * query per member.
 *
 * Import rule (enforced by `skill-levels/boundaries.test.ts`): this file may import only the platform and
 * `skill-levels/games.ts` (a leaf), never `teams/repo.ts` or anything that imports this file, so the module graph
 * stays acyclic at file level.
 */
import { sql, type RawBuilder } from 'kysely';
import {
  toSkillProgress,
  type LocalDate,
  type MembershipStatus,
  type SkillTier,
  type TeamMemberRow,
  type TeamRole,
} from '@sgm/shared';
import type { Database } from '../../lib/db/kysely.ts';
import { countQualifyingGamesBatch } from '../skill-levels/games.ts';

/** What `memberColumns` selects, as node-postgres returns it (timestamps as `Date`, the date as text). */
export interface MemberSqlRow {
  readonly user_id: string;
  readonly full_name: string;
  readonly role: TeamRole;
  readonly status: MembershipStatus;
  readonly skill_level: SkillTier;
  readonly requested_at: Date;
  readonly approved_at: Date | null;
  readonly banned_at: Date | null;
  readonly ban_reason: string | null;
  readonly override_by_name: string | null;
  readonly skill_level_override_at: Date | null;
  readonly skill_level_changed_at: Date | null;
  readonly is_auto_enroll: boolean;
  readonly auto_enroll_until: LocalDate | null;
  readonly auto_enroll_assigned_at: Date | null;
}

/**
 * The select list for a query over `team_members m` joined with `memberJoins()`. `ban_reason` is selected only
 * when asked for (the BANNED list and single-member answers), otherwise it is NULL.
 */
export function memberColumns(options: { readonly withBanReason: boolean }): RawBuilder<unknown> {
  return sql`m.user_id, u.full_name, m.role, m.status, m.skill_level, m.requested_at, m.approved_at,
             m.banned_at, ${options.withBanReason ? sql`m.ban_reason` : sql`NULL::text`} AS ban_reason,
             o.full_name AS override_by_name, m.skill_level_override_at, m.skill_level_changed_at,
             m.is_auto_enroll, m.auto_enroll_until, m.auto_enroll_assigned_at`;
}

/** The member's name, and the override actor's name (a LEFT JOIN: most rows were never overridden). */
export function memberJoins(): RawBuilder<unknown> {
  return sql`JOIN users u ON u.id = m.user_id
             LEFT JOIN users o ON o.id = m.skill_level_override_by`;
}

const iso = (value: Date | null): string | null => (value === null ? null : value.toISOString());

function toMemberRow(row: MemberSqlRow, games: number | undefined): TeamMemberRow {
  const overrideAt = row.skill_level_override_at;
  return {
    userId: row.user_id,
    fullName: row.full_name,
    role: row.role,
    status: row.status,
    skillLevel: row.skill_level,
    requestedAt: row.requested_at.toISOString(),
    approvedAt: iso(row.approved_at),
    bannedAt: iso(row.banned_at),
    banReason: row.ban_reason,
    // The CHECK team_members_override_stamps_paired pairs the actor and the time.
    skillOverride:
      overrideAt === null
        ? null
        : { byName: row.override_by_name ?? '', at: overrideAt.toISOString() },
    skillChangedAt: iso(row.skill_level_changed_at),
    autoEnroll: {
      enabled: row.is_auto_enroll,
      until: row.auto_enroll_until,
      assignedAt: iso(row.auto_enroll_assigned_at),
    },
    skillProgress:
      row.status === 'APPROVED' && games !== undefined
        ? toSkillProgress(row.skill_level, games)
        : null,
  };
}

/** Rows that get a progress line: APPROVED and below the highest level. */
const counted = (row: MemberSqlRow): boolean =>
  row.status === 'APPROVED' && toSkillProgress(row.skill_level, 0) !== null;

/** Maps one page of member rows of `teamId`, counting qualifying games for the whole page in one query. */
export async function toMemberRows(
  db: Database,
  teamId: string,
  rows: readonly MemberSqlRow[],
  now: Date,
): Promise<TeamMemberRow[]> {
  const userIds = rows.filter(counted).map((row) => row.user_id);
  const games = await countQualifyingGamesBatch(db, { teamId, userIds, now });
  return rows.map((row) => toMemberRow(row, games.get(row.user_id)));
}

/** One person as the admin lists show them (full name and skill; never an email). `db` may be a transaction. */
export async function getMemberRow(
  db: Database,
  teamId: string,
  userId: string,
  now: Date,
): Promise<TeamMemberRow | undefined> {
  const { rows } = await sql<MemberSqlRow>`
    SELECT ${memberColumns({ withBanReason: true })}
      FROM team_members m
      ${memberJoins()}
     WHERE m.team_id = ${teamId}::uuid AND m.user_id = ${userId}::uuid`.execute(db);
  const [member] = await toMemberRows(db, teamId, rows, now);
  return member;
}
