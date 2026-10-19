/**
 * skill-levels-and-auto-enroll Phase 1 (AC-VERIFY-1, AC-VERIFY-2, AC-ERROR-5 DB half): the override and Auto
 * Enroll invariants are enforced by the database on its own, reversibly and ledgered (D-55..D-61). Each CHECK
 * is proven with raw SQL that bypasses every service, one rule at a time, so only the rule under test can
 * fail; the valid neighbour of each case is accepted so a too-broad CHECK would fail the suite as well.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { migrateToLatest, rollbackMigrations } from '../../src/lib/db/migrate.ts';
import { insertTeam, insertTeamMember, insertUser } from '../helpers/factories.ts';
import { catalogSnapshot } from '../helpers/schema-dump.ts';
import {
  createTestDatabase,
  expectPgError,
  inRollback,
  trySql,
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

const T0 = new Date('2026-10-01T00:00:00.000Z');
const T1 = new Date('2026-10-02T00:00:00.000Z');

/** One approved member (and the admin who could have overridden them) ready for raw UPDATEs. */
async function approvedMember(
  client: Queryable = db.pool,
): Promise<{ teamId: string; userId: string; actorId: string }> {
  const teamId = await insertTeam(client);
  const [userId, actorId] = [await insertUser(client), await insertUser(client)];
  await insertTeamMember(client, { teamId, userId, actorId });
  return { teamId, userId, actorId };
}

async function setColumns(
  client: Queryable,
  who: { teamId: string; userId: string },
  assignments: string,
  params: unknown[] = [],
): Promise<unknown> {
  return client.query(
    `UPDATE team_members SET ${assignments} WHERE team_id = $1 AND user_id = $2`,
    [who.teamId, who.userId, ...params],
  );
}

describe('skill_level_changed_at (D-55)', () => {
  it('is a nullable timestamptz that defaults to NULL (self-assessed)', async () => {
    const { rows } = await db.pool.query<{ data_type: string; is_nullable: string; d: unknown }>(
      `SELECT data_type, is_nullable, column_default AS d FROM information_schema.columns
        WHERE table_name = 'team_members' AND column_name = 'skill_level_changed_at'`,
    );
    expect(rows).toEqual([{ data_type: 'timestamp with time zone', is_nullable: 'YES', d: null }]);
    const who = await approvedMember();
    const { rows: row } = await db.pool.query<{ skill_level_changed_at: Date | null }>(
      `SELECT skill_level_changed_at FROM team_members WHERE team_id = $1 AND user_id = $2`,
      [who.teamId, who.userId],
    );
    expect(row[0]?.skill_level_changed_at).toBeNull();
  });
});

describe('override stamps travel together and the baseline follows them (D-56, D-57, AC-VERIFY-2)', () => {
  it('refuses an override actor without a time, and a time without an actor, with team_members_override_stamps_paired', async () => {
    await inRollback(db.pool, async (client) => {
      const who = await approvedMember(client);
      const paired = 'team_members_override_stamps_paired';
      expect(
        await trySql(
          client,
          `UPDATE team_members SET skill_level_override_by = $3, skill_level_changed_at = $4
            WHERE team_id = $1 AND user_id = $2`,
          [who.teamId, who.userId, who.actorId, T0],
        ),
      ).toMatchObject({ code: '23514', constraint: paired });
      expect(
        await trySql(
          client,
          `UPDATE team_members SET skill_level_override_at = $3, skill_level_changed_at = $3
            WHERE team_id = $1 AND user_id = $2`,
          [who.teamId, who.userId, T0],
        ),
      ).toMatchObject({ code: '23514', constraint: paired });
    });
  });

  it('refuses a baseline earlier than the override with team_members_changed_after_override', async () => {
    await inRollback(db.pool, async (client) => {
      const who = await approvedMember(client);
      expect(
        await trySql(
          client,
          `UPDATE team_members SET skill_level_override_by = $3, skill_level_override_at = $4,
                                   skill_level_changed_at = $5
            WHERE team_id = $1 AND user_id = $2`,
          [who.teamId, who.userId, who.actorId, T1, T0],
        ),
      ).toMatchObject({ code: '23514', constraint: 'team_members_changed_after_override' });
    });
  });

  it('also refuses an override with no baseline at all (provenance would be ambiguous)', async () => {
    await inRollback(db.pool, async (client) => {
      const who = await approvedMember(client);
      expect(
        await trySql(
          client,
          `UPDATE team_members SET skill_level_override_by = $3, skill_level_override_at = $4
            WHERE team_id = $1 AND user_id = $2`,
          [who.teamId, who.userId, who.actorId, T0],
        ),
      ).toMatchObject({ code: '23514', constraint: 'team_members_changed_after_override' });
    });
  });

  it('accepts the valid shapes: no override, an override with an equal baseline, and a later automatic baseline', async () => {
    await inRollback(db.pool, async (client) => {
      const who = await approvedMember(client);
      // A promotion with no override ever (baseline alone).
      await setColumns(client, who, `skill_level = 'INTERMEDIATE', skill_level_changed_at = $3`, [
        T0,
      ]);
      // An override: both stamps and the baseline from one instant.
      await setColumns(
        client,
        who,
        `skill_level = 'ADVANCED', skill_level_override_by = $3, skill_level_override_at = $4,
         skill_level_changed_at = $4`,
        [who.actorId, T0],
      );
      // Automatic progression later moves only the baseline forward; the override stamps stay.
      await setColumns(client, who, `skill_level_changed_at = $3`, [T1]);
      const { rows } = await client.query<{ by: string | null; at: Date; changed: Date }>(
        `SELECT skill_level_override_by AS by, skill_level_override_at AS at,
                skill_level_changed_at AS changed
           FROM team_members WHERE team_id = $1 AND user_id = $2`,
        [who.teamId, who.userId],
      );
      expect(rows[0]).toEqual({ by: who.actorId, at: T0, changed: T1 });
    });
  });
});

describe('Auto Enroll fields are cleared when it is off (D-58, AC-VERIFY-2)', () => {
  const cleared = 'team_members_auto_enroll_cleared_when_off';

  it('refuses auto_enroll_until, or auto_enroll_assigned_at, with is_auto_enroll = false', async () => {
    await inRollback(db.pool, async (client) => {
      const who = await approvedMember(client);
      expect(
        await trySql(
          client,
          `UPDATE team_members SET auto_enroll_until = '2026-11-30' WHERE team_id = $1 AND user_id = $2`,
          [who.teamId, who.userId],
        ),
      ).toMatchObject({ code: '23514', constraint: cleared });
      expect(
        await trySql(
          client,
          `UPDATE team_members SET auto_enroll_assigned_at = $3 WHERE team_id = $1 AND user_id = $2`,
          [who.teamId, who.userId, T0],
        ),
      ).toMatchObject({ code: '23514', constraint: cleared });
    });
  });

  it('keeps the draft rule: on without an assignment time still fails team_members_auto_enroll_assigned (D-05)', async () => {
    await inRollback(db.pool, async (client) => {
      const who = await approvedMember(client);
      expect(
        await trySql(
          client,
          `UPDATE team_members SET is_auto_enroll = true WHERE team_id = $1 AND user_id = $2`,
          [who.teamId, who.userId],
        ),
      ).toMatchObject({ code: '23514', constraint: 'team_members_auto_enroll_assigned' });
    });
  });

  it('accepts on with and without an end date, then off with everything cleared', async () => {
    await inRollback(db.pool, async (client) => {
      const who = await approvedMember(client);
      await setColumns(
        client,
        who,
        `is_auto_enroll = true, auto_enroll_until = '2026-11-30', auto_enroll_assigned_at = $3`,
        [T0],
      );
      await setColumns(client, who, `auto_enroll_until = NULL`);
      await setColumns(
        client,
        who,
        `is_auto_enroll = false, auto_enroll_until = NULL, auto_enroll_assigned_at = NULL`,
      );
    });
  });
});

describe('Auto Enroll exists only on APPROVED rows (D-59, AC-VERIFY-2)', () => {
  const approvedOnly = 'team_members_auto_enroll_approved_only';
  const INSERT = `INSERT INTO team_members
    (team_id, user_id, status, approved_at, approved_by, banned_at, banned_by,
     is_auto_enroll, auto_enroll_assigned_at)
    VALUES ($1, $2, $3, $4, $5, $6, $7, true, $8)`;

  it('refuses is_auto_enroll = true on a PENDING, REJECTED or BANNED row', async () => {
    const teamId = await insertTeam(db.pool);
    for (const status of ['PENDING', 'REJECTED', 'BANNED'] as const) {
      await inRollback(db.pool, async (client) => {
        const userId = await insertUser(client);
        const banned = status === 'BANNED';
        expect(
          await trySql(client, INSERT, [
            teamId,
            userId,
            status,
            banned ? T0 : null,
            banned ? userId : null,
            banned ? T0 : null,
            banned ? userId : null,
            T0,
          ]),
          status,
        ).toMatchObject({ code: '23514', constraint: approvedOnly });
      });
    }
  });

  it('accepts the same flag on an APPROVED row', async () => {
    const teamId = await insertTeam(db.pool);
    await inRollback(db.pool, async (client) => {
      const userId = await insertUser(client);
      expect(
        await trySql(client, INSERT, [teamId, userId, 'APPROVED', T0, userId, null, null, T0]),
      ).toBeUndefined();
    });
  });

  it('refuses a raw ban of an auto-enrolled member that leaves the flag set (the service ban clears it, AC-ERROR-5)', async () => {
    const who = await approvedMember();
    await setColumns(
      db.pool,
      who,
      `is_auto_enroll = true, auto_enroll_until = '2026-11-30', auto_enroll_assigned_at = $3`,
      [T0],
    );
    await expectPgError(
      setColumns(db.pool, who, `status = 'BANNED', banned_at = now(), banned_by = $3`, [
        who.actorId,
      ]),
      '23514',
      approvedOnly,
    );
    // The same ban with the three columns cleared in the one statement succeeds.
    await setColumns(
      db.pool,
      who,
      `status = 'BANNED', banned_at = now(), banned_by = $3, is_auto_enroll = false,
       auto_enroll_until = NULL, auto_enroll_assigned_at = NULL`,
      [who.actorId],
    );
  });
});

describe('indexes (D-60, D-61)', () => {
  it('has the partial count index on registrations and the partial selection index on team_members, and keeps the draft index', async () => {
    const { rows } = await db.pool.query<{ indexname: string; indexdef: string }>(
      `SELECT indexname, indexdef FROM pg_indexes
        WHERE schemaname = 'public'
          AND indexname IN ('idx_registrations_confirmed_member', 'idx_team_members_auto_enroll_order',
                            'idx_team_members_auto_enroll')`,
    );
    const byName = Object.fromEntries(rows.map((row) => [row.indexname, row.indexdef]));
    expect(byName.idx_registrations_confirmed_member).toMatch(/\(team_id, user_id, session_id\)/);
    expect(byName.idx_registrations_confirmed_member).toMatch(
      /WHERE \(status = 'CONFIRMED'::registration_status\)/,
    );
    expect(byName.idx_team_members_auto_enroll_order).toMatch(
      /\(team_id, auto_enroll_assigned_at, id\) WHERE is_auto_enroll/,
    );
    expect(byName.idx_team_members_auto_enroll).toMatch(
      /\(team_id, is_auto_enroll, auto_enroll_until\)/,
    );
  });
});

describe('ledger and reversibility (AC-VERIFY-1)', () => {
  it('records D-55 to D-61, each with a Source', () => {
    const record = readFileSync(DEVIATIONS_FILE, 'utf8');
    for (let n = 55; n <= 61; n += 1) {
      const row = record.split('\n').find((line) => new RegExp(`^\\|\\s*D-${n}\\s*\\|`).test(line));
      expect(row, `D-${n}`).toBeDefined();
      const cells = (row ?? '').split('|').map((cell) => cell.trim());
      expect((cells[4] ?? '').length, `D-${n} source`).toBeGreaterThan(0);
    }
  });

  it('rolls back, migrates forward to an identical schema, and the rollback removes every new object', async () => {
    const empty = await createTestDatabase({ empty: true });
    try {
      await migrateToLatest({ databaseUrl: empty.url });
      const latest = await catalogSnapshot(empty.pool);
      expect(
        latest.some((line) => line.startsWith('column team_members.skill_level_changed_at')),
      ).toBe(true);

      const reverted = await rollbackMigrations({ databaseUrl: empty.url, count: 1 });
      expect(reverted).toHaveLength(1);
      expect(reverted[0]).toContain('skill_levels_and_auto_enroll');
      const before = await catalogSnapshot(empty.pool);
      for (const gone of [
        'skill_level_changed_at',
        'team_members_override_stamps_paired',
        'team_members_changed_after_override',
        'team_members_auto_enroll_cleared_when_off',
        'team_members_auto_enroll_approved_only',
        'idx_registrations_confirmed_member',
        'idx_team_members_auto_enroll_order',
      ]) {
        expect(
          before.filter((line) => line.includes(gone)),
          gone,
        ).toEqual([]);
      }
      // The draft index of the same stem is not ours to drop.
      expect(before.some((line) => line.includes('idx_team_members_auto_enroll '))).toBe(true);

      await migrateToLatest({ databaseUrl: empty.url });
      expect(await catalogSnapshot(empty.pool)).toEqual(latest);
    } finally {
      await empty.close();
    }
  }, 120_000);

  it('backfills the baseline from an existing override stamp, and names the other two pre-flight problems', async () => {
    const empty = await createTestDatabase({ empty: true });
    try {
      await migrateToLatest({ databaseUrl: empty.url });
      await rollbackMigrations({ databaseUrl: empty.url, count: 1 });
      const teamId = await insertTeam(empty.pool);
      const [userId, actorId] = [await insertUser(empty.pool), await insertUser(empty.pool)];
      await insertTeamMember(empty.pool, { teamId, userId, actorId });
      await empty.pool.query(
        `UPDATE team_members SET skill_level_override_by = $3, skill_level_override_at = $4
          WHERE team_id = $1 AND user_id = $2`,
        [teamId, userId, actorId, T1],
      );
      await migrateToLatest({ databaseUrl: empty.url });
      const { rows } = await empty.pool.query<{ skill_level_changed_at: Date }>(
        `SELECT skill_level_changed_at FROM team_members WHERE team_id = $1 AND user_id = $2`,
        [teamId, userId],
      );
      expect(rows[0]?.skill_level_changed_at).toEqual(T1);

      const broken: [string, RegExp][] = [
        [
          `auto_enroll_until = '2026-11-30'`,
          /auto_enroll_until or auto_enroll_assigned_at set while/,
        ],
        [
          `skill_level_override_by = '${actorId}', skill_level_override_at = NULL`,
          /override_by without/,
        ],
      ];
      // A failed migration leaves the schema one step behind, so roll back once and keep trying from there.
      await rollbackMigrations({ databaseUrl: empty.url, count: 1 });
      for (const [assignment, message] of broken) {
        await empty.pool.query(
          `UPDATE team_members SET skill_level_override_by = NULL, skill_level_override_at = NULL,
                                   auto_enroll_until = NULL`,
        );
        await empty.pool.query(`UPDATE team_members SET ${assignment}`);
        await expect(migrateToLatest({ databaseUrl: empty.url })).rejects.toThrow(message);
      }
    } finally {
      await empty.close();
    }
  }, 120_000);

  it('fails with a readable error, not a bare 23514, when a row from before this feature has Auto Enroll on a non-APPROVED row', async () => {
    const empty = await createTestDatabase({ empty: true });
    try {
      await migrateToLatest({ databaseUrl: empty.url });
      await rollbackMigrations({ databaseUrl: empty.url, count: 1 });
      const teamId = await insertTeam(empty.pool);
      const userId = await insertUser(empty.pool);
      await empty.pool.query(
        `INSERT INTO team_members (team_id, user_id, status, is_auto_enroll, auto_enroll_assigned_at)
         VALUES ($1, $2, 'PENDING', true, now())`,
        [teamId, userId],
      );
      await expect(migrateToLatest({ databaseUrl: empty.url })).rejects.toThrow(
        /Auto Enroll set on a row that is not APPROVED/,
      );
    } finally {
      await empty.close();
    }
  }, 120_000);
});
