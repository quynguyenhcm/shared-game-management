/**
 * team-management Phase 1 (AC-VERIFY-2): the membership rules are enforced by the database, reversibly and
 * ledgered. Every rule is proven with raw SQL: CHECKs raise 23514, the transition and key-immutability
 * trigger raises 23000, the deferred last-admin triggers raise 23514 at COMMIT (D-40..D-46).
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { migrateToLatest, rollbackMigrations } from '../../src/lib/db/migrate.ts';
import { STATUS_TRANSITION_MATRIX } from '../fixtures/membership-transitions.ts';
import { insertTeam, insertTeamMember, insertUser } from '../helpers/factories.ts';
import { catalogSnapshot } from '../helpers/schema-dump.ts';
import {
  createTestDatabase,
  expectPgError,
  inRollback,
  trySql,
  type PgErrorInfo,
  type Queryable,
  type TestDatabase,
} from '../helpers/test-db.ts';

const DEVIATIONS_FILE = fileURLToPath(
  new URL('../../../../db/schema-deviations.md', import.meta.url),
);

let db: TestDatabase;
beforeAll(async () => {
  db = await createTestDatabase();
});
afterAll(async () => {
  await db.close();
});

type Status = 'PENDING' | 'APPROVED' | 'REJECTED' | 'BANNED';

const INSERT_MEMBER = `INSERT INTO team_members
  (team_id, user_id, role, status, approved_at, approved_by, banned_at, banned_by, ban_reason)
  VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`;

interface StampOverrides {
  approvedAt?: Date | null;
  approvedBy?: string | null;
  bannedAt?: Date | null;
  bannedBy?: string | null;
  banReason?: string | null;
}

/**
 * INSERT parameters whose stamp columns are consistent with `status`, so only the rule under test can
 * fail; `overrides` break exactly one thing.
 */
function memberParams(
  teamId: string,
  userId: string,
  role: 'TEAM_ADMIN' | 'MEMBER',
  status: Status,
  overrides: StampOverrides = {},
): unknown[] {
  const approved = status === 'APPROVED' || status === 'BANNED';
  const banned = status === 'BANNED';
  return [
    teamId,
    userId,
    role,
    status,
    overrides.approvedAt === undefined ? (approved ? new Date() : null) : overrides.approvedAt,
    overrides.approvedBy === undefined ? (approved ? userId : null) : overrides.approvedBy,
    overrides.bannedAt === undefined ? (banned ? new Date() : null) : overrides.bannedAt,
    overrides.bannedBy === undefined ? (banned ? userId : null) : overrides.bannedBy,
    overrides.banReason === undefined ? null : overrides.banReason,
  ];
}

async function team(): Promise<string> {
  return insertTeam(db.pool);
}

async function insertRaw(
  client: Queryable,
  teamId: string,
  userId: string,
  role: 'TEAM_ADMIN' | 'MEMBER',
  status: Status,
  overrides: StampOverrides = {},
): Promise<void> {
  await client.query(INSERT_MEMBER, memberParams(teamId, userId, role, status, overrides));
}

/** Tries one INSERT for a fresh user inside a savepoint and returns its error, if any. */
async function probe(
  client: pg.PoolClient,
  teamId: string,
  role: 'TEAM_ADMIN' | 'MEMBER',
  status: Status,
  overrides: StampOverrides = {},
): Promise<PgErrorInfo | undefined> {
  const userId = await insertUser(client);
  return trySql(client, INSERT_MEMBER, memberParams(teamId, userId, role, status, overrides));
}

describe('admin must be APPROVED (D-40, AC-ERROR-6)', () => {
  it('refuses a TEAM_ADMIN row that is PENDING, REJECTED or BANNED with 23514', async () => {
    const teamId = await team();
    await inRollback(db.pool, async (client) => {
      for (const status of ['PENDING', 'REJECTED', 'BANNED'] as const) {
        const error = await probe(client, teamId, 'TEAM_ADMIN', status);
        expect(error, status).toMatchObject({
          code: '23514',
          constraint: 'team_members_admin_approved',
        });
      }
    });
  });

  it('refuses to ban an approved admin until they are demoted', async () => {
    const teamId = await team();
    const [admin, other] = [await insertUser(db.pool), await insertUser(db.pool)];
    await insertTeamMember(db.pool, { teamId, userId: admin, role: 'TEAM_ADMIN' });
    await insertTeamMember(db.pool, { teamId, userId: other, role: 'TEAM_ADMIN' });
    await expectPgError(
      db.pool.query(
        `UPDATE team_members SET status = 'BANNED', banned_at = now(), banned_by = $2
          WHERE team_id = $1 AND user_id = $2`,
        [teamId, other],
      ),
      '23514',
      'team_members_admin_approved',
    );
    await db.pool.query(
      `UPDATE team_members SET role = 'MEMBER' WHERE team_id = $1 AND user_id = $2`,
      [teamId, other],
    );
    await db.pool.query(
      `UPDATE team_members SET status = 'BANNED', banned_at = now(), banned_by = $3
        WHERE team_id = $1 AND user_id = $2`,
      [teamId, other, admin],
    );
  });
});

describe('approval and ban stamps (D-41)', () => {
  const stampError = (error: PgErrorInfo | undefined, constraint: string): void =>
    expect(error).toMatchObject({ code: '23514', constraint });

  it('requires approved_at and approved_by for APPROVED and BANNED, and NULL for PENDING and REJECTED', async () => {
    const teamId = await team();
    await inRollback(db.pool, async (client) => {
      const approver = await insertUser(client);
      const wrong = 'team_members_approval_stamps';
      stampError(await probe(client, teamId, 'MEMBER', 'APPROVED', { approvedAt: null }), wrong);
      stampError(await probe(client, teamId, 'MEMBER', 'APPROVED', { approvedBy: null }), wrong);
      stampError(
        await probe(client, teamId, 'MEMBER', 'BANNED', { approvedAt: null, approvedBy: null }),
        wrong,
      );
      for (const status of ['PENDING', 'REJECTED'] as const) {
        stampError(
          await probe(client, teamId, 'MEMBER', status, {
            approvedAt: new Date(),
            approvedBy: approver,
          }),
          wrong,
        );
      }
      for (const status of ['APPROVED', 'BANNED', 'PENDING', 'REJECTED'] as const) {
        expect(await probe(client, teamId, 'MEMBER', status), status).toBeUndefined();
      }
    });
  });

  it('requires banned_at and banned_by exactly when BANNED, and ban_reason only then', async () => {
    const teamId = await team();
    await inRollback(db.pool, async (client) => {
      const actor = await insertUser(client);
      const wrong = 'team_members_ban_stamps';
      stampError(await probe(client, teamId, 'MEMBER', 'BANNED', { bannedAt: null }), wrong);
      stampError(await probe(client, teamId, 'MEMBER', 'BANNED', { bannedBy: null }), wrong);
      stampError(
        await probe(client, teamId, 'MEMBER', 'APPROVED', {
          bannedAt: new Date(),
          bannedBy: actor,
        }),
        wrong,
      );
      stampError(
        await probe(client, teamId, 'MEMBER', 'APPROVED', { banReason: 'reason on a live row' }),
        wrong,
      );
      expect(
        await probe(client, teamId, 'MEMBER', 'BANNED', { banReason: 'repeated no-shows' }),
      ).toBeUndefined();
    });
  });

  it('keeps ban_reason trimmed and 1 to 500 characters', async () => {
    const teamId = await team();
    await inRollback(db.pool, async (client) => {
      for (const banReason of ['', ' padded', 'padded ', 'r'.repeat(501)]) {
        stampError(
          await probe(client, teamId, 'MEMBER', 'BANNED', { banReason }),
          'team_members_ban_reason_length',
        );
      }
      expect(
        await probe(client, teamId, 'MEMBER', 'BANNED', { banReason: 'r'.repeat(500) }),
      ).toBeUndefined();
    });
  });
});

describe('status transitions and immutable keys (D-42)', () => {
  const targetSet: Record<Status, string> = {
    PENDING: `status = 'PENDING', approved_at = NULL, approved_by = NULL, banned_at = NULL, banned_by = NULL`,
    REJECTED: `status = 'REJECTED', approved_at = NULL, approved_by = NULL, banned_at = NULL, banned_by = NULL`,
    APPROVED: `status = 'APPROVED', approved_at = now(), approved_by = user_id, banned_at = NULL, banned_by = NULL`,
    BANNED: `status = 'BANNED', approved_at = now(), approved_by = user_id, banned_at = now(), banned_by = user_id`,
  };

  it('replays the shared matrix: only PENDING->APPROVED|REJECTED, REJECTED->PENDING, APPROVED->BANNED', async () => {
    expect(STATUS_TRANSITION_MATRIX).toHaveLength(12);
    expect(STATUS_TRANSITION_MATRIX.filter((pair) => pair.allowed)).toHaveLength(4);
    const teamId = await team();
    for (const { from, to, allowed } of STATUS_TRANSITION_MATRIX) {
      const userId = await insertUser(db.pool);
      await insertRaw(db.pool, teamId, userId, 'MEMBER', from);
      const update = db.pool.query(
        `UPDATE team_members SET ${targetSet[to]} WHERE team_id = $1 AND user_id = $2`,
        [teamId, userId],
      );
      if (allowed) {
        await update;
      } else {
        await expectPgError(update, '23000', 'team_members_status_transition');
      }
    }
  });

  it('makes team_id and user_id immutable (23000) but lets role and skill change freely', async () => {
    const [teamId, otherTeam] = [await team(), await team()];
    const [userId, otherUser] = [await insertUser(db.pool), await insertUser(db.pool)];
    await insertTeamMember(db.pool, { teamId, userId, role: 'TEAM_ADMIN' });
    await insertTeamMember(db.pool, { teamId, userId: otherUser, role: 'TEAM_ADMIN' });
    await expectPgError(
      db.pool.query(`UPDATE team_members SET team_id = $3 WHERE team_id = $1 AND user_id = $2`, [
        teamId,
        userId,
        otherTeam,
      ]),
      '23000',
      'team_members_keys_immutable',
    );
    await expectPgError(
      db.pool.query(`UPDATE team_members SET user_id = $3 WHERE team_id = $1 AND user_id = $2`, [
        teamId,
        userId,
        await insertUser(db.pool),
      ]),
      '23000',
      'team_members_keys_immutable',
    );
    await db.pool.query(
      `UPDATE team_members SET role = 'MEMBER', skill_level = 'ADVANCED' WHERE team_id = $1 AND user_id = $2`,
      [teamId, userId],
    );
  });
});

describe('a team keeps at least one approved admin (D-43, AC-ERROR-7)', () => {
  async function teamWithAdmins(count: number): Promise<{ teamId: string; admins: string[] }> {
    const teamId = await team();
    const admins: string[] = [];
    for (let i = 0; i < count; i += 1) {
      const userId = await insertUser(db.pool);
      await insertTeamMember(db.pool, { teamId, userId, role: 'TEAM_ADMIN' });
      admins.push(userId);
    }
    return { teamId, admins };
  }

  it('fails the COMMIT that demotes the only admin, and allows it when another admin remains', async () => {
    const { teamId, admins } = await teamWithAdmins(1);
    const demote = `UPDATE team_members SET role = 'MEMBER' WHERE team_id = $1 AND user_id = $2`;
    const client = await db.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(demote, [teamId, admins[0]]); // statement succeeds: the check is deferred
      await expectPgError(client.query('COMMIT'), '23514', 'team_members_last_admin');
    } finally {
      client.release();
    }
    const { rows } = await db.pool.query<{ role: string }>(
      `SELECT role FROM team_members WHERE team_id = $1`,
      [teamId],
    );
    expect(rows).toEqual([{ role: 'TEAM_ADMIN' }]);

    const second = await insertUser(db.pool);
    await insertTeamMember(db.pool, { teamId, userId: second, role: 'TEAM_ADMIN' });
    await db.pool.query(demote, [teamId, admins[0]]);
  });

  it('fails the COMMIT when two admins demote each other in one transaction; ALL IMMEDIATE raises in place', async () => {
    const { teamId } = await teamWithAdmins(2);
    const client = await db.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(`UPDATE team_members SET role = 'MEMBER' WHERE team_id = $1`, [teamId]);
      await expectPgError(
        client.query('SET CONSTRAINTS ALL IMMEDIATE'),
        '23514',
        'team_members_last_admin',
      );
    } finally {
      await client.query('ROLLBACK').catch(() => undefined);
      client.release();
    }
  });

  it('fails the COMMIT that deletes the last admin row, and counts a removed admin user the same way', async () => {
    const { teamId, admins } = await teamWithAdmins(1);
    const client = await db.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(`DELETE FROM team_members WHERE team_id = $1`, [teamId]);
      await expectPgError(client.query('COMMIT'), '23514', 'team_members_last_admin');
    } finally {
      client.release();
    }
    // Deleting the user cascades to the membership row and trips the same constraint.
    await expectPgError(
      db.pool.query(`DELETE FROM users WHERE id = $1`, [admins[0]]),
      '23514',
      'team_members_last_admin',
    );
  });

  it('is skipped when the team row itself is deleted (ON DELETE CASCADE)', async () => {
    const { teamId } = await teamWithAdmins(1);
    await db.pool.query(`DELETE FROM teams WHERE id = $1`, [teamId]);
    const { rows } = await db.pool.query(`SELECT 1 FROM team_members WHERE team_id = $1`, [teamId]);
    expect(rows).toEqual([]);
  });

  it('does not require an admin at team INSERT and ignores non-admin changes', async () => {
    const teamId = await team();
    const member = await insertUser(db.pool);
    await insertTeamMember(db.pool, { teamId, userId: member, role: 'MEMBER' });
    await db.pool.query(`DELETE FROM team_members WHERE team_id = $1`, [teamId]);
  });
});

describe('team content rules (D-44)', () => {
  const insertTeamRow = (
    name: string,
    description: string | null,
    code: string,
  ): Promise<unknown> =>
    db.pool.query(`INSERT INTO teams (name, description, invite_code) VALUES ($1, $2, $3)`, [
      name,
      description,
      code,
    ]);
  const code = (): string => `c${'x'.repeat(40)}${Math.random().toString(36).slice(2, 4)}`;

  it('keeps names trimmed and 1 to 100 characters', async () => {
    for (const name of ['', ' padded', 'padded ', 'n'.repeat(101)]) {
      await expectPgError(insertTeamRow(name, null, code()), '23514', 'teams_name_trimmed_length');
    }
    await insertTeamRow('n'.repeat(100), null, code());
  });

  it('keeps description NULL or 1 to 1000 characters', async () => {
    for (const description of ['', 'd'.repeat(1001)]) {
      await expectPgError(
        insertTeamRow('Description check', description, code()),
        '23514',
        'teams_description_length',
      );
    }
    await insertTeamRow('Description null', null, code());
    await insertTeamRow('Description max', 'd'.repeat(1000), code());
  });

  it('accepts only URL-safe invite codes of 32 to 100 characters', async () => {
    for (const bad of ['a'.repeat(31), `${'a'.repeat(31)}+`, `${'a'.repeat(31)} `]) {
      await expectPgError(
        insertTeamRow('Code check', null, bad),
        '23514',
        'teams_invite_code_format',
      );
    }
    // The varchar(100) column itself stops anything longer (22001) before the CHECK is evaluated.
    await expectPgError(insertTeamRow('Code check', null, 'a'.repeat(101)), '22001');
    await insertTeamRow('Code 32', null, 'A'.repeat(32));
    await insertTeamRow('Code 43', null, `${'b'.repeat(40)}-_9`);
    await insertTeamRow('Code 100', null, 'c'.repeat(100));
  });
});

describe('create idempotency (D-46, AC-ERROR-15)', () => {
  const KEY = '3f2b8c1e-9d4a-4e7b-8a61-5c0d2f9e7b14';
  const insertCreated = (creator: string | null, key: string | null): Promise<unknown> =>
    db.pool.query(
      `INSERT INTO teams (name, invite_code, created_by, create_idempotency_key) VALUES ('Idem', $1, $2, $3)`,
      [`${'k'.repeat(30)}${Math.random().toString(36).slice(2, 12)}`, creator, key],
    );

  it('is a nullable uuid column with a unique (created_by, key) pair', async () => {
    const { rows } = await db.pool.query<{ data_type: string; is_nullable: string }>(
      `SELECT data_type, is_nullable FROM information_schema.columns
        WHERE table_name = 'teams' AND column_name = 'create_idempotency_key'`,
    );
    expect(rows).toEqual([{ data_type: 'uuid', is_nullable: 'YES' }]);
    const [alice, bob] = [await insertUser(db.pool), await insertUser(db.pool)];
    await insertCreated(alice, KEY);
    await expectPgError(insertCreated(alice, KEY), '23505', 'uq_teams_created_by_idempotency_key');
    await insertCreated(bob, KEY); // the same key from a different user is an ordinary create
    await insertCreated(alice, '9a1d7e3c-2b5f-4c80-b1e6-0f4a8d6c2e57');
  });

  it('allows any number of rows without a key and refuses a non-uuid key', async () => {
    const user = await insertUser(db.pool);
    await insertCreated(user, null);
    await insertCreated(user, null);
    await insertCreated(null, null);
    await expectPgError(insertCreated(user, 'not-a-uuid'), '22P02');
  });
});

describe('indexes (D-45)', () => {
  it('has the partial Find index on (lower(name), id) for PUBLIC teams and the admin-list index', async () => {
    const { rows } = await db.pool.query<{ indexname: string; indexdef: string }>(
      `SELECT indexname, indexdef FROM pg_indexes
        WHERE schemaname = 'public'
          AND indexname IN ('idx_teams_public_name', 'idx_team_members_team_status_role', 'idx_teams_visibility')`,
    );
    const byName = Object.fromEntries(rows.map((row) => [row.indexname, row.indexdef]));
    expect(byName.idx_teams_public_name).toMatch(/\(lower\(\(name\)::text\), id\)/);
    expect(byName.idx_teams_public_name).toMatch(
      /WHERE \(visibility = 'PUBLIC'::team_visibility\)/,
    );
    expect(byName.idx_team_members_team_status_role).toMatch(/\(team_id, status, role\)/);
    expect(byName.idx_teams_visibility).toBeDefined(); // the draft index is kept
  });
});

describe('ledger and reversibility (AC-VERIFY-2)', () => {
  it('records D-40 to D-46, each with a Source', () => {
    const record = readFileSync(DEVIATIONS_FILE, 'utf8');
    for (let n = 40; n <= 46; n += 1) {
      const row = record.split('\n').find((line) => new RegExp(`^\\|\\s*D-${n}\\s*\\|`).test(line));
      expect(row, `D-${n}`).toBeDefined();
      const cells = (row ?? '').split('|').map((cell) => cell.trim());
      expect((cells[4] ?? '').length, `D-${n} source`).toBeGreaterThan(0);
    }
  });

  it('rolls the migration back to the previous schema and migrates forward to an identical one', async () => {
    const empty = await createTestDatabase({ empty: true });
    try {
      await migrateToLatest({ databaseUrl: empty.url });
      const latest = await catalogSnapshot(empty.pool);
      expect(latest.some((line) => line.includes('team_members_last_admin_on_update'))).toBe(true);
      expect(latest.some((line) => line.startsWith('column teams.create_idempotency_key'))).toBe(
        true,
      );

      // Newest first: the registration lifecycle, the session scheduling schema, the skill-level invariants, the
      // banking change keys, then the banking invariants sit on top of the membership invariants.
      const reverted = await rollbackMigrations({ databaseUrl: empty.url, count: 6 });
      expect(reverted).toHaveLength(6);
      expect(reverted[0]).toContain('registration_lifecycle');
      expect(reverted[1]).toContain('session_scheduling');
      expect(reverted[2]).toContain('skill_levels_and_auto_enroll');
      expect(reverted[3]).toContain('team_banking_change_keys');
      expect(reverted[4]).toContain('team_banking_and_gst_invariants');
      expect(reverted[5]).toContain('team_membership_invariants');
      const before = await catalogSnapshot(empty.pool);
      for (const gone of [
        'team_members_admin_approved',
        'team_members_guard_update',
        'team_members_last_admin',
        'teams_invite_code_format',
        'idx_teams_public_name',
        'idx_team_members_team_status_role',
        'create_idempotency_key',
      ]) {
        expect(
          before.filter((line) => line.includes(gone)),
          gone,
        ).toEqual([]);
      }

      await migrateToLatest({ databaseUrl: empty.url });
      expect(await catalogSnapshot(empty.pool)).toEqual(latest);
    } finally {
      await empty.close();
    }
  }, 120_000);
});

describe('test factories keep rows consistent with the new rules', () => {
  it('insertTeam produces a valid invite code and insertTeamMember stamps approved_* and banned_* per status', async () => {
    const teamId = await team();
    const { rows: teamRows } = await db.pool.query<{ invite_code: string }>(
      `SELECT invite_code FROM teams WHERE id = $1`,
      [teamId],
    );
    expect(teamRows[0]?.invite_code).toMatch(/^[A-Za-z0-9_-]{32,100}$/);

    const actor = await insertUser(db.pool);
    const expectations: Record<Status, { approved: boolean; banned: boolean }> = {
      PENDING: { approved: false, banned: false },
      REJECTED: { approved: false, banned: false },
      APPROVED: { approved: true, banned: false },
      BANNED: { approved: true, banned: true },
    };
    for (const [status, expected] of Object.entries(expectations) as [
      Status,
      typeof expectations.PENDING,
    ][]) {
      const userId = await insertUser(db.pool);
      await insertTeamMember(db.pool, { teamId, userId, status, actorId: actor });
      const { rows } = await db.pool.query<{
        approved_at: Date | null;
        approved_by: string | null;
        banned_at: Date | null;
        banned_by: string | null;
      }>(
        `SELECT approved_at, approved_by, banned_at, banned_by FROM team_members
          WHERE team_id = $1 AND user_id = $2`,
        [teamId, userId],
      );
      const row = rows[0];
      expect(row?.approved_at !== null, `${status} approved_at`).toBe(expected.approved);
      expect(row?.approved_by, `${status} approved_by`).toBe(expected.approved ? actor : null);
      expect(row?.banned_at !== null, `${status} banned_at`).toBe(expected.banned);
      expect(row?.banned_by, `${status} banned_by`).toBe(expected.banned ? actor : null);
    }
    // An admin row is always APPROVED, whatever the caller asks for by default.
    const admin = await insertUser(db.pool);
    await insertTeamMember(db.pool, { teamId, userId: admin, role: 'TEAM_ADMIN' });
    const { rows } = await db.pool.query<{ status: string }>(
      `SELECT status FROM team_members WHERE team_id = $1 AND user_id = $2`,
      [teamId, admin],
    );
    expect(rows).toEqual([{ status: 'APPROVED' }]);
  });
});
