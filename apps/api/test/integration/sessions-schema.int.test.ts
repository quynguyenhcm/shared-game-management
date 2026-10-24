/**
 * session-scheduling-engine, Phase 1 (database half): migration `20261020000100000_session_scheduling.sql`
 * (ledger D-70..D-83 and D-85, D-84 reserved), driven from raw SQL so every rule is proved against ANY writer:
 *
 *  - the reversible round trip, the D-83 upgrade of a PRE-feature database and the documented trigger order;
 *  - the series anchor and monthly ordinal, the court template (checked at COMMIT) and rule fee/capacity CHECKs;
 *  - C-SSE-1 on live sessions, content limits, court uniqueness;
 *  - the lifecycle matrix, closed-row and key immutability (incl. session_courts), DRAFT-only deletion;
 *  - the version stamp, create keys, the DB-maintained 48 h default deadline;
 *  - the fee-raise lock (D-85), the banking-email claim (D-81) and the auto-enrol marker (D-80).
 *
 * The status matrix expectations are written out here by hand; the shared fixture
 * `test/fixtures/session-transitions.ts` pins the TypeScript twin separately.
 */
import { copyFileSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type pg from 'pg';
import { CANCELLATION_DEADLINE_DEFAULT_HOURS, defaultCancellationDeadline } from '@sgm/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  findMigrationsDir,
  migrateToLatest,
  rollbackMigrations,
} from '../../src/lib/db/migrate.ts';
import {
  insertRegistration,
  insertRule,
  insertRuleCourt,
  insertSession,
  insertTeam,
  insertUser,
  type SessionStatus,
} from '../helpers/factories.ts';
import { catalogSnapshot } from '../helpers/schema-dump.ts';
import {
  createTestDatabase,
  expectPgError,
  inRollback,
  inTransaction,
  pgError,
  type PgErrorInfo,
  type TestDatabase,
} from '../helpers/test-db.ts';

const DEVIATIONS_FILE = new URL('../../../../db/schema-deviations.md', import.meta.url);
const LAST_PRE_FEATURE = '20261017000100000';
const DAY_MS = 86_400_000;

let db: TestDatabase;
let teamId: string;
let paidTeamId: string;
beforeAll(async () => {
  db = await createTestDatabase({ poolMax: 8 });
  teamId = await insertTeam(db.pool);
  paidTeamId = await insertTeam(db.pool, { payoutConfigured: true });
}, 120_000);
afterAll(async () => {
  await db.close();
});

/** Runs `text` in a savepoint that is ALWAYS rolled back, so one transaction can probe many statements. */
async function probe(
  client: pg.PoolClient,
  text: string,
  values: readonly unknown[] = [],
): Promise<PgErrorInfo | undefined> {
  await client.query('SAVEPOINT always_back');
  try {
    await client.query(text, values as unknown[]);
    return undefined;
  } catch (error) {
    const { code, constraint } = error as { code?: string; constraint?: string };
    return { code, constraint, message: error instanceof Error ? error.message : String(error) };
  } finally {
    await client.query('ROLLBACK TO SAVEPOINT always_back');
  }
}

interface SessionRow {
  version: number;
  updated_at: Date;
  status: SessionStatus;
  cancellation_deadline: Date;
  starts_at: Date | null;
  deadline_is_default: boolean;
  auto_enrol_required: boolean;
  auto_enrolled_at: Date | null;
  recurring_rule_id: string | null;
  fee_flat: string | null;
}

async function readSession(id: string): Promise<SessionRow> {
  const { rows } = await db.pool.query<SessionRow>(
    `SELECT version, updated_at, status, cancellation_deadline, starts_at, deadline_is_default,
            auto_enrol_required, auto_enrolled_at, recurring_rule_id, fee_flat
       FROM game_sessions WHERE id = $1`,
    [id],
  );
  const row = rows[0];
  if (row === undefined) throw new Error(`session ${id} missing`);
  return row;
}

describe('migration round trip, trigger order and ledger (AC-VERIFY-1)', () => {
  it('rolls the migration back (every new object gone) and migrates forward to an identical schema', async () => {
    const empty = await createTestDatabase({ empty: true });
    try {
      await migrateToLatest({ databaseUrl: empty.url });
      const latest = await catalogSnapshot(empty.pool);
      expect(
        latest.some((line) => line.startsWith('column game_sessions.deadline_is_default')),
      ).toBe(true);
      expect(
        latest.some((line) => line.startsWith('column recurring_session_rules.starts_on')),
      ).toBe(true);

      // The registration lifecycle migration (D-62..D-69) sits on top and owns the widened D-85 function; SSE's migration
      // is the second one back.
      const reverted = await rollbackMigrations({ databaseUrl: empty.url, count: 2 });
      expect(reverted).toHaveLength(2);
      expect(reverted[0]).toContain('registration_lifecycle');
      expect(reverted[1]).toContain('session_scheduling');
      const before = await catalogSnapshot(empty.pool);
      for (const gone of [
        'recurring_rule_courts',
        'payout_notice_claims',
        'game_sessions_version_bump',
        'recurring_session_rules_version_bump',
        'game_sessions_fill_default_deadline',
        'game_sessions_guard_update',
        'game_sessions_guard_delete',
        'session_courts_guard_closed',
        'game_sessions_fee_raise_locked',
        'game_session_has_active_registrations',
        'recurrence_monthly_anchor_ok',
        'sessions_bump_version',
        'game_sessions_flat_fee_when_live',
        'uq_session_courts_session_identifier',
        'idx_game_sessions_auto_enrol_pending',
        'column game_sessions.version',
        'column game_sessions.create_key',
        'column game_sessions.auto_enrol_required',
        'column recurring_session_rules.starts_on',
        'column recurring_session_rules.monthly_week',
        'column recurring_session_rules.materialised_version',
      ]) {
        expect(
          before.filter((line) => line.includes(gone)),
          gone,
        ).toEqual([]);
      }
      // The older triggers are not ours to drop.
      for (const kept of ['game_sessions_derive_instants', 'game_sessions_paid_requires_payout']) {
        expect(
          before.some((line) => line.startsWith('trigger') && line.includes(kept)),
          kept,
        ).toBe(true);
      }

      await migrateToLatest({ databaseUrl: empty.url });
      expect(await catalogSnapshot(empty.pool)).toEqual(latest);
    } finally {
      await empty.close();
    }
  }, 120_000);

  it('fires the BEFORE UPDATE triggers on game_sessions in the documented order (name order)', async () => {
    const { rows } = await db.pool.query<{ tgname: string }>(
      `SELECT tgname FROM pg_trigger
        WHERE tgrelid = 'game_sessions'::regclass AND NOT tgisinternal
          AND (tgtype & 1) = 1 AND (tgtype & 2) = 2 AND (tgtype & 16) = 16
        ORDER BY tgname`,
    );
    expect(rows.map((row) => row.tgname)).toEqual([
      'game_sessions_derive_instants',
      'game_sessions_fee_raise_locked',
      'game_sessions_fill_default_deadline',
      'game_sessions_guard_update',
      'game_sessions_paid_requires_payout',
      'game_sessions_version_bump',
    ]);
  });

  it('records D-70..D-83 and D-85 with a Source and D-84 as reserved', () => {
    const record = readFileSync(DEVIATIONS_FILE, 'utf8');
    const rowFor = (n: number): string | undefined =>
      record.split('\n').find((line) => new RegExp(`^\\|\\s*D-${n}\\s*\\|`).test(line));
    for (const n of [...Array.from({ length: 14 }, (_, i) => 70 + i), 85]) {
      const row = rowFor(n);
      expect(row, `D-${n}`).toBeDefined();
      const cells = (row ?? '').split('|').map((cell) => cell.trim());
      expect((cells[4] ?? '').length, `D-${n} source`).toBeGreaterThan(0);
    }
    expect(rowFor(84)).toMatch(/reserved/i);
  });
});

describe('upgrading a pre-feature database (D-83 cleanup, CHECKs added NOT VALID then VALIDATEd)', () => {
  let preFeatureDir: string;
  let upgraded: TestDatabase;
  const ids = {
    rulePadded: randomUUID(),
    ruleMonthly: randomUUID(),
    ruleSkill: randomUUID(),
    ruleFlat: randomUUID(),
    skillLive: randomUUID(),
    flatMismatch: randomUUID(),
    flatNull: randomUUID(),
    duplicates: randomUUID(),
    liveOld: randomUUID(),
    draftOld: randomUUID(),
    customDeadline: randomUUID(),
    defaultDeadline: randomUUID(),
    negative: randomUUID(),
  };

  beforeAll(async () => {
    const source = findMigrationsDir();
    preFeatureDir = mkdtempSync(join(tmpdir(), 'sgm-pre-sessions-migrations-'));
    for (const file of readdirSync(source).filter((name) => name.endsWith('.sql'))) {
      if (file.slice(0, LAST_PRE_FEATURE.length) <= LAST_PRE_FEATURE) {
        copyFileSync(join(source, file), join(preFeatureDir, file));
      }
    }
    upgraded = await createTestDatabase({ empty: true });
    await migrateToLatest({ databaseUrl: upgraded.url, migrationsDir: preFeatureDir });
    const pool = upgraded.pool;
    const team = await insertTeam(pool, { payoutConfigured: true });

    const rule = (
      id: string,
      createdAt: string,
      columns: Record<string, string | number | null>,
    ): Promise<unknown> => {
      const base: Record<string, string | number | null> = {
        id,
        team_id: team,
        created_at: createdAt,
        default_location: 'Hall',
        default_address: '1 Street',
        default_max_players: 12,
        default_start_time: '19:00',
        default_end_time: '21:00',
        ...columns,
      };
      const keys = Object.keys(base);
      return pool.query(
        `INSERT INTO recurring_session_rules (${keys.join(', ')})
         VALUES (${keys.map((_, i) => `$${i + 1}`).join(', ')})`,
        keys.map((key) => base[key]),
      );
    };
    // Created Tue 2026-10-06 (NZ): the first Wednesday on or after is 2026-10-07. Padded text, a negative fee,
    // two remembered courts.
    await rule(ids.rulePadded, '2026-10-06T00:00:00Z', {
      day_of_week: 3,
      default_location: '  Padded Hall  ',
      default_court_count: 2,
      default_start_time: '18:00',
      default_end_time: '20:00',
      fee_flat: '-1.00',
    });
    // Created Mon 2026-10-26 (NZ): the first Friday is the 30th, a 5th Friday, stored as "last"; recur_until
    // before the anchor.
    await rule(ids.ruleMonthly, '2026-10-26T00:00:00Z', {
      day_of_week: 5,
      frequency: 'MONTHLY',
      recur_until: '2026-10-01',
      fee_flat: '17.00',
    });
    await rule(ids.ruleSkill, '2026-10-06T00:00:00Z', {
      day_of_week: 3,
      pricing_structure: 'BY_SKILL_LEVEL',
      fee_beginner: '10.00',
      default_max_players: 0,
      default_reserved_seats: 5,
    });
    await rule(ids.ruleFlat, '2026-10-06T00:00:00Z', { day_of_week: 3, fee_flat: null });

    const session = async (
      id: string,
      columns: Record<string, string | number | null>,
      options: { courts?: readonly string[]; status?: SessionStatus } = {},
    ): Promise<void> => {
      const base: Record<string, string | number | null> = {
        id,
        team_id: team,
        location: 'Hall',
        address: '1 Street',
        date: '2026-10-07',
        cancellation_deadline: '2026-10-05T06:00:00Z',
        max_players: 12,
        ...columns,
      };
      const keys = Object.keys(base);
      await pool.query(
        `INSERT INTO game_sessions (${keys.join(', ')}) VALUES (${keys.map((_, i) => `$${i + 1}`).join(', ')})`,
        keys.map((key) => base[key]),
      );
      for (const identifier of options.courts ?? ['Court 1']) {
        await pool.query(
          `INSERT INTO session_courts (session_id, court_identifier, start_time, end_time)
           VALUES ($1, $2, '19:00', '21:00')`,
          [id, identifier],
        );
      }
      if (options.status !== undefined && options.status !== 'DRAFT') {
        await pool.query(`UPDATE game_sessions SET status = $2 WHERE id = $1`, [
          id,
          options.status,
        ]);
      }
    };
    await session(
      ids.skillLive,
      { pricing_structure: 'BY_SKILL_LEVEL', fee_beginner: '5.00' },
      { status: 'PUBLISHED' },
    );
    await session(
      ids.flatMismatch,
      { fee_flat: '17.00', calculated_rate_per_player: '15.00' },
      { status: 'PUBLISHED' },
    );
    await session(ids.flatNull, { fee_flat: null }, { status: 'PUBLISHED' });
    await session(
      ids.duplicates,
      { location: ' Hall B ' },
      { courts: ['Court 1', 'Court 1', ' Court 2 '] },
    );
    await session(ids.liveOld, {}, { status: 'PUBLISHED' });
    await session(ids.draftOld, {});
    await session(ids.customDeadline, { cancellation_deadline: '2026-10-06T00:00:00Z' });
    await session(ids.defaultDeadline, {});
    await session(ids.negative, { total_court_cost: '-5.00', fee_flat: '-2.00' });

    await migrateToLatest({ databaseUrl: upgraded.url });
  }, 120_000);
  afterAll(async () => {
    await upgraded.close();
    rmSync(preFeatureDir, { recursive: true, force: true });
  });

  it('backfills each rule anchor on the rule weekday, a 5th weekday as "last", and clamps recur_until', async () => {
    const { rows } = await upgraded.pool.query<{
      id: string;
      starts_on: string;
      monthly_week: number | null;
      recur_until: string | null;
    }>(
      `SELECT id, starts_on::text, monthly_week, recur_until::text FROM recurring_session_rules WHERE id = ANY($1)`,
      [[ids.rulePadded, ids.ruleMonthly]],
    );
    const byId = Object.fromEntries(rows.map((row) => [row.id, row]));
    expect(byId[ids.rulePadded]).toMatchObject({ starts_on: '2026-10-07', monthly_week: null });
    expect(byId[ids.ruleMonthly]).toMatchObject({
      starts_on: '2026-10-30',
      monthly_week: -1,
      recur_until: '2026-10-30',
    });
  });

  it('trims text, zeroes negative amounts, completes rule fees and capacity, and gives every rule a court template', async () => {
    const { rows } = await upgraded.pool.query<Record<string, string | number | null>>(
      `SELECT id, default_location, fee_flat::text, fee_beginner::text, fee_intermediate::text,
              fee_advanced::text, default_max_players, default_reserved_seats,
              (SELECT count(*)::int FROM recurring_rule_courts c WHERE c.rule_id = r.id) AS courts
         FROM recurring_session_rules r WHERE id = ANY($1)`,
      [[ids.rulePadded, ids.ruleSkill, ids.ruleFlat]],
    );
    const byId = Object.fromEntries(rows.map((row) => [String(row['id']), row]));
    expect(byId[ids.rulePadded]).toMatchObject({
      default_location: 'Padded Hall',
      fee_flat: '0.00',
      courts: 2,
    });
    expect(byId[ids.ruleSkill]).toMatchObject({
      fee_beginner: '10.00',
      fee_intermediate: '0.00',
      fee_advanced: '0.00',
      default_max_players: 1,
      default_reserved_seats: 1,
      courts: 1,
    });
    expect(byId[ids.ruleFlat]).toMatchObject({ fee_flat: '0.00' });
    const { rows: template } = await upgraded.pool.query<{
      court_identifier: string;
      start_time: string;
      end_time: string;
    }>(
      `SELECT court_identifier, start_time::text, end_time::text FROM recurring_rule_courts
        WHERE rule_id = $1 ORDER BY position`,
      [ids.rulePadded],
    );
    expect(template).toEqual([
      { court_identifier: 'Court 1', start_time: '18:00:00', end_time: '20:00:00' },
      { court_identifier: 'Court 2', start_time: '18:00:00', end_time: '20:00:00' },
    ]);
  });

  it('repairs live sessions to C-SSE-1 (skill fees present, fee_flat = the final rate) and renumbers duplicate courts', async () => {
    const { rows } = await upgraded.pool.query<Record<string, string | null>>(
      `SELECT id, fee_beginner::text, fee_intermediate::text, fee_advanced::text, fee_flat::text, location,
              total_court_cost::text FROM game_sessions WHERE id = ANY($1)`,
      [[ids.skillLive, ids.flatMismatch, ids.flatNull, ids.duplicates, ids.negative]],
    );
    const byId = Object.fromEntries(rows.map((row) => [String(row['id']), row]));
    expect(byId[ids.skillLive]).toMatchObject({
      fee_beginner: '5.00',
      fee_intermediate: '0.00',
      fee_advanced: '0.00',
    });
    expect(byId[ids.flatMismatch]).toMatchObject({ fee_flat: '15.00' });
    expect(byId[ids.flatNull]).toMatchObject({ fee_flat: '0.00' });
    expect(byId[ids.duplicates]).toMatchObject({ location: 'Hall B' });
    expect(byId[ids.negative]).toMatchObject({ total_court_cost: '0.00', fee_flat: '0.00' });
    const { rows: courts } = await upgraded.pool.query<{ court_identifier: string }>(
      `SELECT court_identifier FROM session_courts WHERE session_id = $1 ORDER BY court_identifier`,
      [ids.duplicates],
    );
    expect(courts.map((row) => row.court_identifier)).toEqual([
      'Court 1',
      'Court 1 (2)',
      'Court 2',
    ]);
  });

  it('sets the auto-enrol obligation on drafts only (existing live sessions are not retroactive) and the deadline flag by equality', async () => {
    const { rows } = await upgraded.pool.query<{
      id: string;
      auto_enrol_required: boolean;
      deadline_is_default: boolean;
    }>(
      `SELECT id, auto_enrol_required, deadline_is_default FROM game_sessions WHERE id = ANY($1)`,
      [[ids.liveOld, ids.draftOld, ids.customDeadline, ids.defaultDeadline]],
    );
    const byId = Object.fromEntries(rows.map((row) => [row.id, row]));
    expect(byId[ids.liveOld]?.auto_enrol_required).toBe(false);
    expect(byId[ids.draftOld]?.auto_enrol_required).toBe(true);
    expect(byId[ids.customDeadline]?.deadline_is_default).toBe(false);
    expect(byId[ids.defaultDeadline]?.deadline_is_default).toBe(true);
  });

  it('leaves every new CHECK validated', async () => {
    const { rows } = await upgraded.pool.query<{ conname: string; convalidated: boolean }>(
      `SELECT conname, convalidated FROM pg_constraint
        WHERE contype = 'c' AND connamespace = 'public'::regnamespace
          AND (conname LIKE 'game_sessions\\_%' OR conname LIKE 'recurring\\_session\\_rules\\_%'
               OR conname LIKE 'session\\_courts\\_%')
          AND NOT convalidated`,
    );
    expect(rows).toEqual([]);
    const { rows: count } = await upgraded.pool.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM pg_constraint
        WHERE conname IN ('game_sessions_flat_fee_when_live', 'game_sessions_skill_fees_when_live',
                          'recurring_session_rules_anchor_weekday', 'recurring_session_rules_monthly_anchor',
                          'recurring_session_rules_fees_complete', 'session_courts_identifier_trimmed')`,
    );
    expect(count[0]?.n).toBe(6);
  });
});

describe('series anchor, monthly ordinal and court template (D-70, D-71)', () => {
  it('refuses an anchor whose weekday is not day_of_week, and recur_until before the anchor (23514)', async () => {
    await expectPgError(
      insertRule(db.pool, teamId, { dayOfWeek: 3, startsOn: '2026-10-08' }),
      '23514',
      'recurring_session_rules_anchor_weekday',
    );
    await expectPgError(
      insertRule(db.pool, teamId, { startsOn: '2026-10-07', recurUntil: '2026-10-06' }),
      '23514',
      'recurring_session_rules_until_after_anchor',
    );
    await insertRule(db.pool, teamId, { startsOn: '2026-10-07', recurUntil: '2026-10-07' });
  });

  it('requires monthly_week exactly for MONTHLY, in 1..4 or -1, and the anchor to be that weekday of its month', async () => {
    const monthly = (startsOn: string, monthlyWeek: number | null, dayOfWeek = 3) =>
      insertRule(db.pool, teamId, { frequency: 'MONTHLY', startsOn, monthlyWeek, dayOfWeek });
    await expectPgError(
      monthly('2026-10-07', null),
      '23514',
      'recurring_session_rules_monthly_week_iff_monthly',
    );
    await expectPgError(
      insertRule(db.pool, teamId, { frequency: 'WEEKLY', monthlyWeek: 1 }),
      '23514',
      'recurring_session_rules_monthly_week_iff_monthly',
    );
    // A 5th is outside the range, and no anchor is a "5th" either: both CHECKs fail, the first by name is reported.
    const fifth = await pgError(monthly('2026-10-07', 5));
    expect(fifth.code).toBe('23514');
    expect([
      'recurring_session_rules_monthly_week_range',
      'recurring_session_rules_monthly_anchor',
    ]).toContain(fifth.constraint);
    await expectPgError(
      monthly('2026-10-07', 2),
      '23514',
      'recurring_session_rules_monthly_anchor',
    );
    // 1st Wednesday of Oct 2026; the 4th AND last Wednesday (28th); a 5th Wednesday (Dec 30) is only "last".
    await monthly('2026-10-07', 1);
    await monthly('2026-10-28', 4);
    await monthly('2026-10-28', -1);
    await monthly('2026-12-30', -1);
    await expectPgError(
      monthly('2026-12-30', 4),
      '23514',
      'recurring_session_rules_monthly_anchor',
    );
    await expectPgError(
      monthly('2026-10-21', -1),
      '23514',
      'recurring_session_rules_monthly_anchor',
    );
  });

  it('checks at COMMIT that an active rule has a court, and lets an inactive rule go without one', async () => {
    const bare = (isActive: boolean): Promise<unknown> =>
      inTransaction(db.pool, (client) =>
        client.query(
          `INSERT INTO recurring_session_rules (team_id, day_of_week, starts_on, is_active, default_location,
                                                default_address, default_max_players, default_start_time,
                                                default_end_time, fee_flat)
           VALUES ($1, 3, '2026-10-07', $2, 'Hall', '1 Street', 12, '19:00', '21:00', '17.00')`,
          [teamId, isActive],
        ),
      );
    await expectPgError(bare(true), '23514', 'recurring_session_rules_courts_present');
    await bare(false);

    const ruleId = await insertRule(db.pool, teamId);
    await expectPgError(
      db.pool.query(`DELETE FROM recurring_rule_courts WHERE rule_id = $1`, [ruleId]),
      '23514',
      'recurring_session_rules_courts_present',
    );
    // Swapping the template inside one transaction is fine.
    await inTransaction(db.pool, async (client) => {
      await client.query(`DELETE FROM recurring_rule_courts WHERE rule_id = $1`, [ruleId]);
      await insertRuleCourt(client, ruleId, { identifier: 'Court A' });
    });
    // Deleting the rule cascades its template without tripping the check.
    await db.pool.query(`DELETE FROM recurring_session_rules WHERE id = $1`, [ruleId]);
    // The template's own rules: one court name and one position per rule, valid times.
    const other = await insertRule(db.pool, teamId);
    await expectPgError(
      insertRuleCourt(db.pool, other, { identifier: 'Court 1' }),
      '23505',
      'uq_recurring_rule_courts_identifier',
    );
    await expectPgError(
      insertRuleCourt(db.pool, other, { identifier: 'Court 2', start: '21:00', end: '20:00' }),
      '23514',
      'recurring_rule_courts_time_order',
    );
  });

  it('refuses a rule whose fees are incomplete for its structure, negative, over capacity or untrimmed (23514)', async () => {
    await expectPgError(
      insertRule(db.pool, teamId, { pricing: 'FLAT', flat: null }),
      '23514',
      'recurring_session_rules_fees_complete',
    );
    for (const missing of ['beginner', 'intermediate', 'advanced'] as const) {
      await expectPgError(
        insertRule(db.pool, teamId, { pricing: 'BY_SKILL_LEVEL', [missing]: null }),
        '23514',
        'recurring_session_rules_fees_complete',
      );
    }
    await expectPgError(
      insertRule(db.pool, teamId, { flat: '-0.01' }),
      '23514',
      'recurring_session_rules_amounts_non_negative',
    );
    await expectPgError(
      inTransaction(db.pool, (client) =>
        client.query(
          `INSERT INTO recurring_session_rules (team_id, day_of_week, starts_on, default_start_time,
                                                default_end_time, fee_flat, default_location, default_address,
                                                default_max_players, default_reserved_seats)
           VALUES ($1, 3, '2026-10-07', '19:00', '21:00', '17.00', 'Hall', '1 Street', 4, 5)`,
          [teamId],
        ),
      ),
      '23514',
      'recurring_session_rules_capacity',
    );
    await expectPgError(
      inTransaction(db.pool, (client) =>
        client.query(
          `INSERT INTO recurring_session_rules (team_id, day_of_week, starts_on, default_start_time,
                                                default_end_time, fee_flat, default_location, default_address,
                                                default_max_players)
           VALUES ($1, 3, '2026-10-07', '19:00', '21:00', '17.00', ' Hall', '1 Street', 12)`,
          [teamId],
        ),
      ),
      '23514',
      'recurring_session_rules_location_trimmed',
    );
  });
});

describe('live-session CHECKs, content limits and courts (D-77, D-78, D-79)', () => {
  it('refuses to publish BY_SKILL_LEVEL without all three skill fees (C-SSE-1)', async () => {
    for (const missing of ['beginner', 'intermediate', 'advanced'] as const) {
      const id = await insertSession(
        db.pool,
        paidTeamId,
        {
          pricing: 'BY_SKILL_LEVEL',
          beginner: '5.00',
          intermediate: '6.00',
          advanced: '7.00',
          [missing]: null,
        },
        {},
      );
      await expectPgError(
        db.pool.query(`UPDATE game_sessions SET status = 'PUBLISHED' WHERE id = $1`, [id]),
        '23514',
        'game_sessions_skill_fees_when_live',
      );
    }
    const complete = await insertSession(
      db.pool,
      paidTeamId,
      { pricing: 'BY_SKILL_LEVEL' },
      { status: 'PUBLISHED' },
    );
    expect((await readSession(complete)).status).toBe('PUBLISHED');
  });

  it('holds a live FLAT session to fee_flat = custom rate, else calculated rate, and refuses a missing fee_flat', async () => {
    const noFee = await insertSession(db.pool, paidTeamId, { flat: null }, {});
    await expectPgError(
      db.pool.query(`UPDATE game_sessions SET status = 'PUBLISHED' WHERE id = $1`, [noFee]),
      '23514',
      'game_sessions_flat_fee_when_live',
    );
    const drift = await insertSession(
      db.pool,
      paidTeamId,
      { flat: '17.00' },
      { calculatedRate: '15.00' },
    );
    await expectPgError(
      db.pool.query(`UPDATE game_sessions SET status = 'PUBLISHED' WHERE id = $1`, [drift]),
      '23514',
      'game_sessions_flat_fee_when_live',
    );
    await db.pool.query(`UPDATE game_sessions SET fee_flat = '15.00' WHERE id = $1`, [drift]);
    await db.pool.query(`UPDATE game_sessions SET status = 'PUBLISHED' WHERE id = $1`, [drift]);
    // Once live, a rate edit must move fee_flat in the same statement.
    await expectPgError(
      db.pool.query(`UPDATE game_sessions SET custom_player_rate = '9.00' WHERE id = $1`, [drift]),
      '23514',
      'game_sessions_flat_fee_when_live',
    );
    await db.pool.query(
      `UPDATE game_sessions SET custom_player_rate = '9.00', fee_flat = '9.00' WHERE id = $1`,
      [drift],
    );
    expect((await readSession(drift)).fee_flat).toBe('9.00');
  });

  it('refuses negative money, untrimmed or over-long text and a duplicate or untrimmed court name', async () => {
    await expectPgError(
      insertSession(db.pool, teamId, { flat: '-1.00' }),
      '23514',
      'game_sessions_amounts_non_negative',
    );
    const id = await insertSession(db.pool, teamId);
    await expectPgError(
      db.pool.query(`UPDATE game_sessions SET location = ' Hall' WHERE id = $1`, [id]),
      '23514',
      'game_sessions_location_trimmed',
    );
    await expectPgError(
      db.pool.query(`UPDATE game_sessions SET location = '' WHERE id = $1`, [id]),
      '23514',
      'game_sessions_location_trimmed',
    );
    await expectPgError(
      db.pool.query(`UPDATE game_sessions SET address = $2 WHERE id = $1`, [id, 'a'.repeat(501)]),
      '23514',
      'game_sessions_address_trimmed',
    );
    await expectPgError(
      db.pool.query(`UPDATE game_sessions SET total_court_cost = '-0.01' WHERE id = $1`, [id]),
      '23514',
      'game_sessions_amounts_non_negative',
    );
    await expectPgError(
      db.pool.query(
        `INSERT INTO session_courts (session_id, court_identifier, start_time, end_time)
         VALUES ($1, 'Court 1', '19:00', '21:00')`,
        [id],
      ),
      '23505',
      'uq_session_courts_session_identifier',
    );
    await expectPgError(
      db.pool.query(
        `INSERT INTO session_courts (session_id, court_identifier, start_time, end_time)
         VALUES ($1, ' Court 2', '19:00', '21:00')`,
        [id],
      ),
      '23514',
      'session_courts_identifier_trimmed',
    );
  });
});

describe('lifecycle matrix, immutability and DRAFT-only deletion (D-75, D-76; AC-ERROR-5, AC-ERROR-6)', () => {
  const STATUSES: readonly SessionStatus[] = ['DRAFT', 'PUBLISHED', 'COMPLETED', 'CANCELLED'];
  /** The whole matrix, by hand: only these four moves are legal; staying put is a no-op. */
  const ALLOWED: ReadonlySet<string> = new Set([
    'DRAFT>PUBLISHED',
    'DRAFT>CANCELLED',
    'PUBLISHED>CANCELLED',
    'PUBLISHED>COMPLETED',
  ]);

  it('accepts exactly DRAFT>PUBLISHED, DRAFT>CANCELLED, PUBLISHED>CANCELLED and PUBLISHED>COMPLETED; the rest is 23000 game_sessions_status_transition', async () => {
    const sessions: Record<string, string> = {};
    for (const from of STATUSES) {
      sessions[from] = await insertSession(db.pool, paidTeamId, {}, { status: from });
    }
    await inRollback(db.pool, async (client) => {
      for (const from of STATUSES) {
        for (const to of STATUSES) {
          const error = await probe(client, `UPDATE game_sessions SET status = $2 WHERE id = $1`, [
            sessions[from],
            to,
          ]);
          if (from === to || ALLOWED.has(`${from}>${to}`)) {
            expect(error, `${from} -> ${to}`).toBeUndefined();
          } else {
            expect(error, `${from} -> ${to}`).toMatchObject({
              code: '23000',
              constraint: 'game_sessions_status_transition',
            });
          }
        }
      }
    });
  });

  it('refuses every content change on a COMPLETED or CANCELLED session, but lets its series link be cut', async () => {
    const ruleId = await insertRule(db.pool, teamId);
    const closed: string[] = [];
    for (const status of ['COMPLETED', 'CANCELLED'] as const) {
      closed.push(await insertSession(db.pool, paidTeamId, {}, { status, recurringRuleId: null }));
    }
    const detachable = await insertSession(
      db.pool,
      teamId,
      {},
      { status: 'CANCELLED', recurringRuleId: ruleId },
    );
    for (const id of closed) {
      for (const change of [
        `location = 'Elsewhere'`,
        `max_players = 20`,
        `fee_flat = '1.00'`,
        `date = '2026-10-08'`,
        `auto_enrolled_at = now()`,
      ]) {
        await expectPgError(
          db.pool.query(`UPDATE game_sessions SET ${change} WHERE id = $1`, [id]),
          '23000',
          'game_sessions_closed_immutable',
        );
      }
    }
    await db.pool.query(`DELETE FROM recurring_session_rules WHERE id = $1`, [ruleId]);
    expect((await readSession(detachable)).recurring_rule_id).toBeNull();
  });

  it('refuses any session_courts insert, update or delete on a closed session, and allows them on a PUBLISHED one', async () => {
    for (const status of ['COMPLETED', 'CANCELLED'] as const) {
      const id = await insertSession(db.pool, paidTeamId, {}, { status });
      const { rows } = await db.pool.query<{ id: string }>(
        `SELECT id FROM session_courts WHERE session_id = $1`,
        [id],
      );
      const courtId = rows[0]?.id ?? '';
      for (const [text, values] of [
        [
          `INSERT INTO session_courts (session_id, court_identifier, start_time, end_time)
           VALUES ($1, 'Court 2', '19:00', '21:00')`,
          [id],
        ],
        [`UPDATE session_courts SET end_time = '22:00' WHERE id = $1`, [courtId]],
        [`DELETE FROM session_courts WHERE id = $1`, [courtId]],
      ] as const) {
        await expectPgError(
          db.pool.query(text, [...values]),
          '23000',
          'session_courts_closed_immutable',
        );
      }
    }
    const live = await insertSession(db.pool, paidTeamId, {}, { status: 'PUBLISHED' });
    await db.pool.query(
      `INSERT INTO session_courts (session_id, court_identifier, start_time, end_time)
       VALUES ($1, 'Court 2', '19:00', '22:00')`,
      [live],
    );
    await db.pool.query(`UPDATE session_courts SET end_time = '23:00' WHERE session_id = $1`, [
      live,
    ]);
  });

  it('keeps team_id fixed and the date of a series session fixed (23000 game_sessions_keys_immutable)', async () => {
    const ruleId = await insertRule(db.pool, teamId);
    const instance = await insertSession(db.pool, teamId, {}, { recurringRuleId: ruleId });
    const oneOff = await insertSession(db.pool, teamId);
    await expectPgError(
      db.pool.query(`UPDATE game_sessions SET team_id = $2 WHERE id = $1`, [oneOff, paidTeamId]),
      '23000',
      'game_sessions_keys_immutable',
    );
    await expectPgError(
      db.pool.query(`UPDATE game_sessions SET date = '2026-10-14' WHERE id = $1`, [instance]),
      '23000',
      'game_sessions_keys_immutable',
    );
    await db.pool.query(`UPDATE game_sessions SET date = '2026-10-14' WHERE id = $1`, [oneOff]);
  });

  it('deletes only a DRAFT (courts go with it); a deleted team still cascades through its live sessions', async () => {
    const draft = await insertSession(db.pool, teamId);
    await db.pool.query(`DELETE FROM game_sessions WHERE id = $1`, [draft]);
    const { rows } = await db.pool.query(`SELECT 1 FROM session_courts WHERE session_id = $1`, [
      draft,
    ]);
    expect(rows).toEqual([]);
    for (const status of ['PUBLISHED', 'COMPLETED', 'CANCELLED'] as const) {
      const id = await insertSession(db.pool, paidTeamId, {}, { status });
      await expectPgError(
        db.pool.query(`DELETE FROM game_sessions WHERE id = $1`, [id]),
        '23000',
        'game_sessions_delete_draft_only',
      );
    }
    const doomed = await insertTeam(db.pool, { payoutConfigured: true });
    await insertSession(db.pool, doomed, {}, { status: 'PUBLISHED' });
    await db.pool.query(`DELETE FROM teams WHERE id = $1`, [doomed]);
  });
});

describe('version stamp, create keys and the default deadline (D-72, D-73, D-74; AC-ERROR-7, AC-HAPPY-11)', () => {
  it('bumps version on a content change and stamps updated_at; not on a same-value write or a bookkeeping column; writers cannot set it', async () => {
    const id = await insertSession(db.pool, paidTeamId, {}, { status: 'PUBLISHED' });
    const first = await readSession(id);
    const base = first.version; // publishing it was one content change already

    await db.pool.query(`UPDATE game_sessions SET location = 'Test Hall' WHERE id = $1`, [id]);
    expect((await readSession(id)).version).toBe(base);

    await db.pool.query(
      `UPDATE game_sessions SET auto_enrolled_at = now(), auto_enrol_required = true WHERE id = $1`,
      [id],
    );
    expect((await readSession(id)).version).toBe(base);

    await db.pool.query(`UPDATE game_sessions SET max_players = 14 WHERE id = $1`, [id]);
    const second = await readSession(id);
    expect(second.version).toBe(base + 1);
    expect(second.updated_at.getTime()).toBeGreaterThan(first.updated_at.getTime());

    await db.pool.query(`UPDATE game_sessions SET version = 99 WHERE id = $1`, [id]);
    expect((await readSession(id)).version).toBe(base + 1);
    await db.pool.query(`UPDATE game_sessions SET version = 99, max_players = 15 WHERE id = $1`, [
      id,
    ]);
    expect((await readSession(id)).version).toBe(base + 2);

    // A rule bumps on content, not on its materialisation bookkeeping.
    const ruleId = await insertRule(db.pool, teamId);
    await db.pool.query(
      `UPDATE recurring_session_rules SET materialised_version = 1, materialised_at = now() WHERE id = $1`,
      [ruleId],
    );
    await db.pool.query(
      `UPDATE recurring_session_rules SET default_max_players = 14 WHERE id = $1`,
      [ruleId],
    );
    const { rows } = await db.pool.query<{ version: number }>(
      `SELECT version FROM recurring_session_rules WHERE id = $1`,
      [ruleId],
    );
    expect(rows[0]?.version).toBe(2);
  });

  it('makes (team_id, create_key) unique on sessions and rules, per team, with NULL keys unconstrained', async () => {
    const key = randomUUID();
    await insertSession(db.pool, teamId, {}, { createKey: key });
    await expectPgError(
      insertSession(db.pool, teamId, {}, { createKey: key }),
      '23505',
      'uq_game_sessions_team_create_key',
    );
    await insertSession(db.pool, paidTeamId, {}, { createKey: key });
    await insertSession(db.pool, teamId);
    await insertSession(db.pool, teamId);

    await insertRule(db.pool, teamId, { createKey: key });
    await expectPgError(
      insertRule(db.pool, teamId, { createKey: key }),
      '23505',
      'uq_recurring_session_rules_team_create_key',
    );
    await insertRule(db.pool, paidTeamId, { createKey: key });
  });

  it('keeps a default deadline at starts_at - 48 h when the start moves, and an explicit deadline as entered', async () => {
    const id = await insertSession(db.pool, teamId);
    const expected = async (): Promise<number> => {
      const row = await readSession(id);
      // The shared TypeScript default and the SQL literal agree (the `interval '48 hours'` parity).
      expect(CANCELLATION_DEADLINE_DEFAULT_HOURS).toBe(48);
      return defaultCancellationDeadline(row.starts_at ?? new Date(0)).getTime();
    };
    let row = await readSession(id);
    expect(row.deadline_is_default).toBe(true);
    expect(row.cancellation_deadline.getTime()).toBe(await expected());

    // The start moves (the earliest court starts at 17:00): the default follows.
    await db.pool.query(`UPDATE session_courts SET start_time = '17:00' WHERE session_id = $1`, [
      id,
    ]);
    row = await readSession(id);
    expect(row.cancellation_deadline.getTime()).toBe(await expected());

    // The date moves across the DST change of 2026-09-27: still exactly 48 absolute hours.
    await db.pool.query(`UPDATE game_sessions SET date = '2026-09-28' WHERE id = $1`, [id]);
    row = await readSession(id);
    expect(row.cancellation_deadline.getTime()).toBe(await expected());
    expect((row.starts_at?.getTime() ?? 0) - row.cancellation_deadline.getTime()).toBe(2 * DAY_MS);

    // An explicit deadline stays where the admin put it.
    await db.pool.query(
      `UPDATE game_sessions SET deadline_is_default = false, cancellation_deadline = $2 WHERE id = $1`,
      [id, new Date((row.starts_at?.getTime() ?? 0) - 3 * DAY_MS)],
    );
    await db.pool.query(`UPDATE session_courts SET start_time = '18:00' WHERE session_id = $1`, [
      id,
    ]);
    row = await readSession(id);
    expect(row.deadline_is_default).toBe(false);
    expect((row.starts_at?.getTime() ?? 0) - row.cancellation_deadline.getTime()).toBe(
      3 * DAY_MS + 3_600_000,
    );
  });
});

describe('fee-raise lock (D-85; AC-ERROR-10)', () => {
  async function publishedWith(
    status: 'CONFIRMED' | 'WAITLISTED' | 'WITHDRAWN' | null,
    fees: Parameters<typeof insertSession>[2] = {},
    options: { feeDue?: boolean } = {},
  ): Promise<string> {
    const id = await insertSession(db.pool, paidTeamId, fees, { status: 'PUBLISHED' });
    if (status !== null) {
      await insertRegistration(db.pool, {
        sessionId: id,
        teamId: paidTeamId,
        userId: await insertUser(db.pool),
        status,
        queuePosition: status === 'WAITLISTED' ? 1 : null,
        withdrawalFeeDue: options.feeDue ?? false,
      });
    }
    return id;
  }

  it('counts CONFIRMED, WAITLISTED and a WITHDRAWN row with a fee still owed as active, not a released one, WITHDRAWN or none (R20)', async () => {
    const active = async (id: string): Promise<boolean> => {
      const { rows } = await db.pool.query<{ active: boolean }>(
        `SELECT game_session_has_active_registrations($1) AS active`,
        [id],
      );
      return rows[0]?.active ?? false;
    };
    expect(await active(await publishedWith('CONFIRMED'))).toBe(true);
    expect(await active(await publishedWith('WAITLISTED'))).toBe(true);
    expect(await active(await publishedWith('WITHDRAWN'))).toBe(false);
    expect(await active(await publishedWith('WITHDRAWN', {}, { feeDue: true }))).toBe(true);
    expect(await active(await publishedWith(null))).toBe(false);
  });

  it('refuses a fee raise (23514 game_sessions_fee_raise_locked) and allows a decrease, once a player is registered', async () => {
    for (const status of ['CONFIRMED', 'WAITLISTED'] as const) {
      const id = await publishedWith(status);
      await expectPgError(
        db.pool.query(`UPDATE game_sessions SET fee_flat = '20.00' WHERE id = $1`, [id]),
        '23514',
        'game_sessions_fee_raise_locked',
      );
      await db.pool.query(`UPDATE game_sessions SET fee_flat = '15.00' WHERE id = $1`, [id]);
      await db.pool.query(`UPDATE game_sessions SET fee_flat = '15.00' WHERE id = $1`, [id]);
      expect((await readSession(id)).fee_flat).toBe('15.00');
    }
  });

  it('also refuses a pricing-model change, free to paid, and a BY_SKILL_LEVEL raise; a raise is fine with no active registration', async () => {
    const free = await publishedWith('CONFIRMED', { flat: '0.00' });
    await expectPgError(
      db.pool.query(`UPDATE game_sessions SET fee_flat = '5.00' WHERE id = $1`, [free]),
      '23514',
      'game_sessions_fee_raise_locked',
    );
    const model = await publishedWith('CONFIRMED');
    await expectPgError(
      db.pool.query(
        `UPDATE game_sessions SET pricing_structure = 'BY_SEX', fee_male = '1.00', fee_female = '1.00',
                                  fee_other = '1.00' WHERE id = $1`,
        [model],
      ),
      '23514',
      'game_sessions_fee_raise_locked',
    );
    const skill = await publishedWith('CONFIRMED', { pricing: 'BY_SKILL_LEVEL' });
    await expectPgError(
      db.pool.query(`UPDATE game_sessions SET fee_advanced = '18.00' WHERE id = $1`, [skill]),
      '23514',
      'game_sessions_fee_raise_locked',
    );
    await db.pool.query(`UPDATE game_sessions SET fee_advanced = '16.00' WHERE id = $1`, [skill]);

    for (const status of [null, 'WITHDRAWN'] as const) {
      const open = await publishedWith(status);
      await db.pool.query(`UPDATE game_sessions SET fee_flat = '20.00' WHERE id = $1`, [open]);
    }
    // A late withdrawal whose fee is still owed locks the fees (AC-VERIFY-12); once the fee is released the raise is fine.
    const owing = await publishedWith('WITHDRAWN', {}, { feeDue: true });
    await expectPgError(
      db.pool.query(`UPDATE game_sessions SET fee_flat = '20.00' WHERE id = $1`, [owing]),
      '23514',
      'game_sessions_fee_raise_locked',
    );
    await db.pool.query(
      `UPDATE registrations SET withdrawal_fee_due = false WHERE session_id = $1`,
      [owing],
    );
    await db.pool.query(`UPDATE game_sessions SET fee_flat = '20.00' WHERE id = $1`, [owing]);
    // A DRAFT is never locked.
    const draft = await insertSession(db.pool, paidTeamId);
    await db.pool.query(`UPDATE game_sessions SET fee_flat = '30.00' WHERE id = $1`, [draft]);
  });
});

describe('banking-email claim and auto-enrol marker (D-81, D-80)', () => {
  it('claims one row per (rule_id, window_start): a second claim returns nothing, and the claims go with the rule', async () => {
    const ruleId = await insertRule(db.pool, teamId);
    const claim = (windowStart: string): Promise<{ rowCount: number | null }> =>
      db.pool.query(
        `INSERT INTO payout_notice_claims (rule_id, window_start) VALUES ($1, $2)
         ON CONFLICT DO NOTHING RETURNING rule_id`,
        [ruleId, windowStart],
      );
    expect((await claim('2026-10-19')).rowCount).toBe(1);
    expect((await claim('2026-10-19')).rowCount).toBe(0);
    expect((await claim('2026-10-26')).rowCount).toBe(1);
    const info = await pgError(
      db.pool.query(
        `INSERT INTO payout_notice_claims (rule_id, window_start) VALUES ($1, '2026-10-19')`,
        [ruleId],
      ),
    );
    expect(info).toMatchObject({ code: '23505', constraint: 'payout_notice_claims_pkey' });

    await db.pool.query(`DELETE FROM recurring_session_rules WHERE id = $1`, [ruleId]);
    const { rows } = await db.pool.query(`SELECT 1 FROM payout_notice_claims WHERE rule_id = $1`, [
      ruleId,
    ]);
    expect(rows).toEqual([]);
  });

  it('requires auto-enrol by default, never stamps a session that does not require it, and indexes the pending ones', async () => {
    const id = await insertSession(db.pool, teamId);
    const row = await readSession(id);
    expect(row.auto_enrol_required).toBe(true);
    expect(row.auto_enrolled_at).toBeNull();
    await expectPgError(
      db.pool.query(
        `UPDATE game_sessions SET auto_enrol_required = false, auto_enrolled_at = now() WHERE id = $1`,
        [id],
      ),
      '23514',
      'game_sessions_auto_enrol_stamp',
    );
    const { rows } = await db.pool.query<{ indexdef: string }>(
      `SELECT indexdef FROM pg_indexes WHERE indexname = 'idx_game_sessions_auto_enrol_pending'`,
    );
    expect(rows[0]?.indexdef).toMatch(
      /WHERE .*status = 'PUBLISHED'.*auto_enrol_required.*auto_enrolled_at IS NULL/,
    );
  });
});
