/**
 * Kysely queries for teams, discovery and joining. Services decide; this file reads and writes rows.
 * The invite code is selected only by `getInviteCode`, `lockTeam` (the join and regenerate checks) and the lookup
 * by code; no list or detail query ever selects it, so a response cannot leak it by accident.
 */
import { sql, type RawBuilder, type UpdateResult } from 'kysely';
import {
  FIND_PAGE_SIZE,
  MEMBERS_PAGE_SIZE,
  type FindCursorPayload,
  type MemberListStatus,
  type MembershipStatus,
  type SkillTier,
  type TeamMemberRow,
  type TeamRole,
  type TeamVisibility,
} from '@sgm/shared';
import type { Database } from '../../lib/db/kysely.ts';
import { memberColumns, memberJoins, toMemberRows, type MemberSqlRow } from './member-read.ts';
import type { MembersCursor } from './members-cursor.ts';

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
 * conflicts with `update` (regenerate) and with `noKeyUpdate` (moderation), so a join either sees the rotated code
 * or makes the rotation wait. `noKeyUpdate` is the per-team moderation mutex: it does not block foreign-key
 * inserts that reference the team (which take KEY SHARE), unlike `update`.
 */
export async function lockTeam(
  trx: Database,
  teamId: string,
  mode: 'share' | 'update' | 'noKeyUpdate',
): Promise<LockedTeam | undefined> {
  const query = trx
    .selectFrom('teams')
    .select(['id', 'visibility', 'invite_code'])
    .where('id', '=', teamId);
  const locked =
    mode === 'share'
      ? query.forShare()
      : mode === 'update'
        ? query.forUpdate()
        : query.forNoKeyUpdate();
  const row = await locked.executeTakeFirst();
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

/** Moved to the module's public `admin-lock.ts` (team-banking shares it); re-exported so teams code is unchanged. */
export { findApprovedRole } from './admin-lock.ts';

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

// ---------------------------------------------------------------------------------------------
// Moderation (Phase 3). Lock order everywhere: teams, then team_members.
// ---------------------------------------------------------------------------------------------

export interface LockedTarget {
  readonly id: string;
  readonly role: TeamRole;
  readonly status: MembershipStatus;
}

/**
 * The target's row `FOR UPDATE`, always looked up by `(team_id, user_id)` and never by user id alone, so another
 * team's member is simply absent (IDOR-safe).
 */
export async function lockTarget(
  trx: Database,
  teamId: string,
  userId: string,
): Promise<LockedTarget | undefined> {
  return trx
    .selectFrom('team_members')
    .select(['id', 'role', 'status'])
    .where('team_id', '=', teamId)
    .where('user_id', '=', userId)
    .forUpdate()
    .executeTakeFirst();
}

/** Approved admins of the team; exact under the team lock. */
export async function countApprovedAdmins(db: Database, teamId: string): Promise<number> {
  const row = await db
    .selectFrom('team_members')
    .select((eb) => eb.fn.countAll<string>().as('n'))
    .where('team_id', '=', teamId)
    .where('role', '=', 'TEAM_ADMIN')
    .where('status', '=', 'APPROVED')
    .executeTakeFirstOrThrow();
  return Number(row.n);
}

/** What a guarded moderation UPDATE changes; stamps are written from the injected clock, not by a trigger. */
export type MembershipChange =
  | { readonly kind: 'approve'; readonly actorId: string; readonly now: Date }
  | { readonly kind: 'reject' }
  | { readonly kind: 'promote' }
  | { readonly kind: 'demote' }
  | {
      readonly kind: 'ban';
      readonly actorId: string;
      readonly now: Date;
      readonly reason: string | null;
    };

/**
 * One guarded `UPDATE ... WHERE id = $id AND status = $expected [AND role = $expected]`. Returns false when the row
 * no longer matches (defensive: the row lock makes that unreachable while the caller holds it).
 */
export async function applyMembershipChange(
  trx: Database,
  membershipId: string,
  change: MembershipChange,
): Promise<boolean> {
  const base = trx.updateTable('team_members').where('id', '=', membershipId);
  let result: UpdateResult;
  switch (change.kind) {
    case 'approve':
      result = await base
        .set({ status: 'APPROVED', approved_at: change.now, approved_by: change.actorId })
        .where('status', '=', 'PENDING')
        .executeTakeFirst();
      break;
    case 'reject':
      result = await base
        .set({ status: 'REJECTED' })
        .where('status', '=', 'PENDING')
        .executeTakeFirst();
      break;
    case 'promote':
      result = await base
        .set({ role: 'TEAM_ADMIN' })
        .where('status', '=', 'APPROVED')
        .where('role', '=', 'MEMBER')
        .executeTakeFirst();
      break;
    case 'demote':
      result = await base
        .set({ role: 'MEMBER' })
        .where('status', '=', 'APPROVED')
        .where('role', '=', 'TEAM_ADMIN')
        .executeTakeFirst();
      break;
    case 'ban':
      result = await base
        .set({
          status: 'BANNED',
          banned_at: change.now,
          banned_by: change.actorId,
          ban_reason: change.reason,
          // Auto Enroll exists only on APPROVED rows (D-59), so the same statement that bans clears it. A
          // racing "Save Auto Enroll" then finds a non-APPROVED row and gets 409 (AC-ERROR-5).
          is_auto_enroll: false,
          auto_enroll_until: null,
          auto_enroll_assigned_at: null,
        })
        .where('status', '=', 'APPROVED')
        .where('role', '=', 'MEMBER')
        .executeTakeFirst();
      break;
  }
  return result.numUpdatedRows > 0n;
}

/**
 * The `TeamMemberRow` mapper lives in the public `member-read.ts` (skill-levels-and-auto-enroll adds fields every
 * member endpoint must carry); re-exported so teams code is unchanged.
 */
export { getMemberRow } from './member-read.ts';

export interface MemberListPage {
  readonly members: readonly TeamMemberRow[];
  /** The cursor for the row after the last one returned, or `null` when this is the last page. */
  readonly next: MembersCursor | null;
}

/**
 * One section of the admin lists, 50 rows (51 fetched; the extra one only signals "more"), keyset-paged, mapped by
 * `member-read.ts` (one extra grouped count for the page's progress lines, at `now`):
 *  PENDING  oldest request first      (requested_at, user_id)
 *  APPROVED admins first, then name   (role rank, lower(full_name), user_id)
 *  BANNED   newest ban first          (banned_at, user_id) descending
 * Sort keys are read and compared as text/typed parameters so microsecond timestamps and the database collation
 * are exact. `ban_reason` is selected only for BANNED rows.
 */
export async function listMembers(
  db: Database,
  teamId: string,
  status: MemberListStatus,
  cursor: MembersCursor | null,
  now: Date,
): Promise<MemberListPage> {
  const filters: RawBuilder<unknown>[] = [
    sql`m.team_id = ${teamId}::uuid`,
    sql`m.status = ${status}::membership_status`,
  ];
  let order: RawBuilder<unknown>;
  if (status === 'PENDING') {
    if (cursor?.s === 'PENDING') {
      filters.push(
        sql`(m.requested_at, m.user_id) > (${cursor.t}::timestamptz, ${cursor.i}::uuid)`,
      );
    }
    order = sql`m.requested_at ASC, m.user_id ASC`;
  } else if (status === 'BANNED') {
    if (cursor?.s === 'BANNED') {
      filters.push(sql`(m.banned_at, m.user_id) < (${cursor.t}::timestamptz, ${cursor.i}::uuid)`);
    }
    order = sql`m.banned_at DESC, m.user_id DESC`;
  } else {
    if (cursor?.s === 'APPROVED') {
      filters.push(
        sql`(CASE WHEN m.role = 'TEAM_ADMIN' THEN 0 ELSE 1 END, lower(u.full_name), m.user_id) > (${cursor.r}::int, ${cursor.n}::text, ${cursor.i}::uuid)`,
      );
    }
    order = sql`CASE WHEN m.role = 'TEAM_ADMIN' THEN 0 ELSE 1 END ASC, lower(u.full_name) ASC, m.user_id ASC`;
  }
  const { rows } = await sql<
    MemberSqlRow & { sort_time: string; sort_name: string; sort_rank: number }
  >`
    SELECT ${memberColumns({ withBanReason: status === 'BANNED' })},
           ${status === 'BANNED' ? sql`m.banned_at::text` : sql`m.requested_at::text`} AS sort_time,
           lower(u.full_name) AS sort_name,
           CASE WHEN m.role = 'TEAM_ADMIN' THEN 0 ELSE 1 END AS sort_rank
      FROM team_members m
      ${memberJoins()}
     WHERE ${sql.join(filters, sql` AND `)}
     ORDER BY ${order}
     LIMIT ${MEMBERS_PAGE_SIZE + 1}`.execute(db);
  const page = rows.slice(0, MEMBERS_PAGE_SIZE);
  const last = page.at(-1);
  let next: MembersCursor | null = null;
  if (rows.length > MEMBERS_PAGE_SIZE && last !== undefined) {
    next =
      status === 'APPROVED'
        ? {
            v: 1,
            s: 'APPROVED',
            r: last.sort_rank === 0 ? 0 : 1,
            n: last.sort_name,
            i: last.user_id,
          }
        : { v: 1, s: status, t: last.sort_time, i: last.user_id };
  }
  return { members: await toMemberRows(db, teamId, page, now), next };
}

/** The ban job's re-read: just enough of the row to check it still matches the payload. */
export async function findMembershipById(
  db: Database,
  membershipId: string,
): Promise<{ teamId: string; userId: string; status: MembershipStatus } | undefined> {
  const row = await db
    .selectFrom('team_members')
    .select(['team_id', 'user_id', 'status'])
    .where('id', '=', membershipId)
    .executeTakeFirst();
  return row === undefined
    ? undefined
    : { teamId: row.team_id, userId: row.user_id, status: row.status };
}
