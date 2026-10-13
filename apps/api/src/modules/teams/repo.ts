/**
 * Kysely queries for teams, discovery and joining. Services decide; this file reads and writes rows.
 * The invite code is selected only by `getInviteCode`, `lockTeam` (the join and regenerate checks) and the lookup
 * by code; no list or detail query ever selects it, so a response cannot leak it by accident.
 */
import { sql, type RawBuilder } from 'kysely';
import {
  FIND_PAGE_SIZE,
  type FindCursorPayload,
  type MembershipStatus,
  type SkillTier,
  type TeamRole,
  type TeamVisibility,
} from '@sgm/shared';
import type { Database } from '../../lib/db/kysely.ts';

export interface TeamRow {
  readonly id: string;
  readonly name: string;
  readonly description: string | null;
  readonly visibility: TeamVisibility;
}

export interface MembershipRow {
  readonly id: string;
  readonly role: TeamRole;
  readonly status: MembershipStatus;
  readonly skillLevel: SkillTier;
}

export interface TeamWithCount extends TeamRow {
  readonly memberCount: number;
  readonly myStatus: MembershipStatus | null;
  readonly myRole: TeamRole | null;
}

// ---------------------------------------------------------------------------------------------
// Create
// ---------------------------------------------------------------------------------------------

/**
 * Inserts the team, or returns `undefined` when this creator already used the idempotency key (the unique
 * constraint `uq_teams_created_by_idempotency_key` arbitrates, so concurrent submits cannot both insert: the
 * second waits for the first to commit and then does nothing). Run in a transaction with `insertApprovedAdmin`.
 */
export async function insertTeam(
  db: Database,
  input: {
    name: string;
    description: string | undefined;
    visibility: TeamVisibility;
    inviteCode: string;
    createdBy: string;
    idempotencyKey: string;
  },
): Promise<TeamRow | undefined> {
  const row = await db
    .insertInto('teams')
    .values({
      name: input.name,
      description: input.description ?? null,
      visibility: input.visibility,
      invite_code: input.inviteCode,
      created_by: input.createdBy,
      create_idempotency_key: input.idempotencyKey,
    })
    .onConflict((conflict) =>
      conflict.columns(['created_by', 'create_idempotency_key']).doNothing(),
    )
    .returning(['id', 'name', 'description', 'visibility'])
    .executeTakeFirst();
  return row;
}

export async function insertApprovedAdmin(
  db: Database,
  input: { teamId: string; userId: string; skillLevel: SkillTier; now: Date },
): Promise<void> {
  await db
    .insertInto('team_members')
    .values({
      team_id: input.teamId,
      user_id: input.userId,
      role: 'TEAM_ADMIN',
      status: 'APPROVED',
      skill_level: input.skillLevel,
      requested_at: input.now,
      approved_at: input.now,
      approved_by: input.userId,
    })
    .execute();
}

/** The team a creator already made with `key`, with the creator's membership (the replay answer). */
export async function findCreatedTeam(
  db: Database,
  createdBy: string,
  key: string,
): Promise<{ team: TeamRow; membership: MembershipRow } | undefined> {
  const row = await db
    .selectFrom('teams as t')
    .innerJoin('team_members as m', (join) =>
      join.onRef('m.team_id', '=', 't.id').onRef('m.user_id', '=', 't.created_by'),
    )
    .select([
      't.id',
      't.name',
      't.description',
      't.visibility',
      'm.id as membership_id',
      'm.role',
      'm.status',
      'm.skill_level',
    ])
    .where('t.created_by', '=', createdBy)
    .where('t.create_idempotency_key', '=', key)
    .executeTakeFirst();
  if (row === undefined) return undefined;
  return {
    team: { id: row.id, name: row.name, description: row.description, visibility: row.visibility },
    membership: {
      id: row.membership_id,
      role: row.role,
      status: row.status,
      skillLevel: row.skill_level,
    },
  };
}

// ---------------------------------------------------------------------------------------------
// Find a team (Architecture Q5)
// ---------------------------------------------------------------------------------------------

export interface FindParams {
  /** The signed-in caller, for `myStatus`; `null` for an anonymous visitor. */
  readonly callerId: string | null;
  /** `%escaped term%`, or `null` for no text filter. */
  readonly pattern: string | null;
  readonly cursor: Pick<FindCursorPayload, 'n' | 'i' | 'd'> | null;
}

export interface FindRow {
  readonly id: string;
  readonly name: string;
  readonly description: string | null;
  readonly sort_name: string;
  readonly member_count: number;
  readonly my_status: MembershipStatus | null;
}

/**
 * One statement per page: PUBLIC teams only (the predicate is a SQL literal so the partial index
 * `idx_teams_public_name` matches), ILIKE on name or description, keyset on `(lower(name), id)` in the cursor's
 * direction, 21 rows (the extra one only signals "more"), the member count as one LATERAL aggregate and the
 * caller's own status as one join. Exposed so the integration test can EXPLAIN exactly this SQL.
 */
export function buildFindQuery(params: FindParams): RawBuilder<FindRow> {
  const backward = params.cursor?.d === 'b';
  const filters: RawBuilder<unknown>[] = [sql`t.visibility = 'PUBLIC'`];
  if (params.pattern !== null) {
    filters.push(sql`(t.name ILIKE ${params.pattern} OR t.description ILIKE ${params.pattern})`);
  }
  if (params.cursor !== null) {
    const { n, i } = params.cursor;
    filters.push(
      backward
        ? sql`(lower(t.name), t.id) < (${n}::text, ${i}::uuid)`
        : sql`(lower(t.name), t.id) > (${n}::text, ${i}::uuid)`,
    );
  }
  const direction = sql.raw(backward ? 'DESC' : 'ASC');
  return sql<FindRow>`
    SELECT t.id, t.name, t.description, lower(t.name) AS sort_name,
           mc.n AS member_count, m.status AS my_status
      FROM teams t
      LEFT JOIN LATERAL (
        SELECT count(*)::int AS n FROM team_members c
         WHERE c.team_id = t.id AND c.status = 'APPROVED'
      ) mc ON true
      LEFT JOIN team_members m ON m.team_id = t.id AND m.user_id = ${params.callerId}::uuid
     WHERE ${sql.join(filters, sql` AND `)}
     ORDER BY lower(t.name) ${direction}, t.id ${direction}
     LIMIT ${FIND_PAGE_SIZE + 1}`;
}

export async function findTeams(db: Database, params: FindParams): Promise<readonly FindRow[]> {
  const { rows } = await buildFindQuery(params).execute(db);
  return rows;
}

// ---------------------------------------------------------------------------------------------
// My teams, detail, invite lookup
// ---------------------------------------------------------------------------------------------

export interface MineRow {
  readonly id: string;
  readonly name: string;
  readonly visibility: TeamVisibility;
  readonly role: TeamRole;
  readonly status: Exclude<MembershipStatus, 'BANNED'>;
  /** Only for approved admins of the team; `null` for everyone else. */
  readonly pending_count: number | null;
}

/** The caller's non-banned teams, rows with waiting join requests first, then by name. */
export async function listMine(db: Database, userId: string): Promise<readonly MineRow[]> {
  const { rows } = await sql<MineRow>`
    SELECT * FROM (
      SELECT t.id, t.name, t.visibility, m.role, m.status,
             CASE WHEN m.role = 'TEAM_ADMIN' AND m.status = 'APPROVED'
                  THEN (SELECT count(*)::int FROM team_members p
                         WHERE p.team_id = t.id AND p.status = 'PENDING')
             END AS pending_count
        FROM team_members m
        JOIN teams t ON t.id = m.team_id
       WHERE m.user_id = ${userId}::uuid AND m.status <> 'BANNED'
    ) r
    ORDER BY (coalesce(r.pending_count, 0) > 0) DESC, lower(r.name), r.id`.execute(db);
  return rows;
}

interface TeamWithCountRow {
  readonly id: string;
  readonly name: string;
  readonly description: string | null;
  readonly visibility: TeamVisibility;
  readonly member_count: number;
  readonly my_status: MembershipStatus | null;
  readonly my_role: TeamRole | null;
}

function toTeamWithCount(row: TeamWithCountRow): TeamWithCount {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    visibility: row.visibility,
    memberCount: row.member_count,
    myStatus: row.my_status,
    myRole: row.my_role,
  };
}

/** A team by id with its approved-member count and the caller's own row; `undefined` when no such team. */
export async function getTeamWithCaller(
  db: Database,
  teamId: string,
  callerId: string | null,
): Promise<TeamWithCount | undefined> {
  const { rows } = await sql<TeamWithCountRow>`
    SELECT t.id, t.name, t.description, t.visibility,
           (SELECT count(*)::int FROM team_members c
             WHERE c.team_id = t.id AND c.status = 'APPROVED') AS member_count,
           m.status AS my_status, m.role AS my_role
      FROM teams t
      LEFT JOIN team_members m ON m.team_id = t.id AND m.user_id = ${callerId}::uuid
     WHERE t.id = ${teamId}::uuid`.execute(db);
  const row = rows[0];
  return row === undefined ? undefined : toTeamWithCount(row);
}

/** The team whose current invite code is exactly `code` (never echoes the code), with the caller's own row. */
export async function getTeamByInviteCode(
  db: Database,
  code: string,
  callerId: string,
): Promise<TeamWithCount | undefined> {
  const { rows } = await sql<TeamWithCountRow>`
    SELECT t.id, t.name, t.description, t.visibility,
           (SELECT count(*)::int FROM team_members c
             WHERE c.team_id = t.id AND c.status = 'APPROVED') AS member_count,
           m.status AS my_status, m.role AS my_role
      FROM teams t
      LEFT JOIN team_members m ON m.team_id = t.id AND m.user_id = ${callerId}::uuid
     WHERE t.invite_code = ${code}`.execute(db);
  const row = rows[0];
  return row === undefined ? undefined : toTeamWithCount(row);
}

// ---------------------------------------------------------------------------------------------
// Joining and the invite code (the team row is the per-team mutex: FOR SHARE to join, FOR UPDATE to rotate)
// ---------------------------------------------------------------------------------------------

export interface LockedTeam {
  readonly id: string;
  readonly visibility: TeamVisibility;
  readonly inviteCode: string;
}

/**
 * Locks the team row for the rest of the transaction and reads its current code under that lock. `share` (join)
 * conflicts with `update` (regenerate), so a join either sees the rotated code or makes the rotation wait.
 */
export async function lockTeam(
  trx: Database,
  teamId: string,
  mode: 'share' | 'update',
): Promise<LockedTeam | undefined> {
  const query = trx
    .selectFrom('teams')
    .select(['id', 'visibility', 'invite_code'])
    .where('id', '=', teamId);
  const row = await (mode === 'share' ? query.forShare() : query.forUpdate()).executeTakeFirst();
  return row === undefined
    ? undefined
    : { id: row.id, visibility: row.visibility, inviteCode: row.invite_code };
}

export async function findMembership(
  db: Database,
  teamId: string,
  userId: string,
): Promise<MembershipRow | undefined> {
  const row = await db
    .selectFrom('team_members')
    .select(['id', 'role', 'status', 'skill_level'])
    .where('team_id', '=', teamId)
    .where('user_id', '=', userId)
    .executeTakeFirst();
  return row === undefined
    ? undefined
    : { id: row.id, role: row.role, status: row.status, skillLevel: row.skill_level };
}

/**
 * A join request: a new PENDING row, or a REJECTED row returning to PENDING with the new skill level and request
 * time (`UNIQUE (team_id, user_id)` is reused). Any other existing row is left alone and `undefined` is returned.
 */
export async function upsertJoinRequest(
  db: Database,
  input: { teamId: string; userId: string; skillLevel: SkillTier; now: Date },
): Promise<{ skillLevel: SkillTier; rerequest: boolean } | undefined> {
  const { rows } = await sql<{ skill_level: SkillTier; inserted: boolean }>`
    INSERT INTO team_members (team_id, user_id, role, status, skill_level, requested_at)
    VALUES (${input.teamId}::uuid, ${input.userId}::uuid, 'MEMBER', 'PENDING', ${input.skillLevel}::skill_tier, ${input.now})
    ON CONFLICT ON CONSTRAINT uq_team_members_team_user DO UPDATE
       SET status = 'PENDING', skill_level = EXCLUDED.skill_level, requested_at = EXCLUDED.requested_at,
           approved_at = NULL, approved_by = NULL
     WHERE team_members.status = 'REJECTED'
    RETURNING skill_level, (xmax = 0) AS inserted`.execute(db);
  const row = rows[0];
  return row === undefined ? undefined : { skillLevel: row.skill_level, rerequest: !row.inserted };
}

/** The caller's role when (and only when) approved: the authority re-check inside a locked transaction. */
export async function findApprovedRole(
  db: Database,
  teamId: string,
  userId: string,
): Promise<TeamRole | undefined> {
  const row = await db
    .selectFrom('team_members')
    .select('role')
    .where('team_id', '=', teamId)
    .where('user_id', '=', userId)
    .where('status', '=', 'APPROVED')
    .executeTakeFirst();
  return row?.role;
}

export async function getInviteCode(db: Database, teamId: string): Promise<string | undefined> {
  const row = await db
    .selectFrom('teams')
    .select('invite_code')
    .where('id', '=', teamId)
    .executeTakeFirst();
  return row?.invite_code;
}

export async function setInviteCode(db: Database, teamId: string, code: string): Promise<void> {
  await db.updateTable('teams').set({ invite_code: code }).where('id', '=', teamId).execute();
}
