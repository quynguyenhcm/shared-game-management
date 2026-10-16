/**
 * team-banking-and-gst, Phase 1: the staged upgrade of a PRE-FEATURE database (R5, ledger D-53).
 *
 * The old schema let a team hold a partial banking block, `gst_registered = true` without a number and
 * any text in `gst_number`. The migration must clean those rows up (never fail on them), add the new CHECKs
 * NOT VALID then VALIDATE them, and keep valid rows byte-identical. The same file proves the DOWN
 * migration restores a plain `is_payout_configured` column.
 */
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes, randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  findMigrationsDir,
  migrateToLatest,
  rollbackMigrations,
} from '../../src/lib/db/migrate.ts';
import { payoutBlockFor } from '../helpers/factories.ts';
import { createTestDatabase, type TestDatabase } from '../helpers/test-db.ts';

const LAST_PRE_FEATURE = '20261013000100000';
const FEATURE_MIGRATION = '20261016000100000_team_banking_and_gst_invariants.sql';

let preFeatureDir: string;
beforeAll(() => {
  const source = findMigrationsDir();
  preFeatureDir = mkdtempSync(join(tmpdir(), 'sgm-pre-feature-migrations-'));
  mkdirSync(preFeatureDir, { recursive: true });
  for (const file of readdirSync(source).filter((name) => name.endsWith('.sql'))) {
    if (file.slice(0, LAST_PRE_FEATURE.length) <= LAST_PRE_FEATURE) {
      copyFileSync(join(source, file), join(preFeatureDir, file));
    }
  }
});
afterAll(() => {
  rmSync(preFeatureDir, { recursive: true, force: true });
});

interface Seeded {
  readonly valid: string;
  readonly validBlockOnly: string;
  readonly partialName: string;
  readonly partialNumberLast4: string;
  readonly partialLast4: string;
  readonly partialNameNumber: string;
  readonly flagOnly: string;
  readonly registeredNoNumber: string;
  readonly registeredBadNumber: string;
  readonly unregisteredBadNumber: string;
  readonly registeredLetters: string;
  readonly unregisteredValidNumber: string;
}

/** Seeds every shape the old schema allowed, using the PRE-feature columns only. */
async function seedPreFeature(pool: pg.Pool): Promise<Seeded> {
  const ids = {
    valid: randomUUID(),
    validBlockOnly: randomUUID(),
    partialName: randomUUID(),
    partialNumberLast4: randomUUID(),
    partialLast4: randomUUID(),
    partialNameNumber: randomUUID(),
    flagOnly: randomUUID(),
    registeredNoNumber: randomUUID(),
    registeredBadNumber: randomUUID(),
    unregisteredBadNumber: randomUUID(),
    registeredLetters: randomUUID(),
    unregisteredValidNumber: randomUUID(),
  } satisfies Seeded;

  const insert = (
    id: string,
    columns: {
      name?: boolean;
      number?: boolean;
      last4?: boolean;
      flag?: boolean;
      gstRegistered?: boolean;
      gstNumber?: string | null;
    },
  ): Promise<unknown> => {
    const block = payoutBlockFor(id);
    return pool.query(
      `INSERT INTO teams (id, name, invite_code, bank_account_name, bank_account_number, bank_account_last4,
                          is_payout_configured, gst_registered, gst_number)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [
        id,
        `Team ${id.slice(0, 8)}`,
        randomBytes(32).toString('base64url'),
        columns.name === true ? block.name : null,
        columns.number === true ? block.number : null,
        columns.last4 === true ? block.last4 : null,
        columns.flag ?? false,
        columns.gstRegistered ?? false,
        columns.gstNumber ?? null,
      ],
    );
  };

  await insert(ids.valid, {
    name: true,
    number: true,
    last4: true,
    flag: true,
    gstRegistered: true,
    gstNumber: '49091850',
  });
  await insert(ids.validBlockOnly, { name: true, number: true, last4: true, flag: false });
  await insert(ids.partialName, { name: true, flag: true });
  await insert(ids.partialNumberLast4, { number: true, last4: true, flag: true });
  await insert(ids.partialLast4, { last4: true });
  await insert(ids.partialNameNumber, { name: true, number: true, flag: true });
  await insert(ids.flagOnly, { flag: true });
  await insert(ids.registeredNoNumber, { gstRegistered: true });
  await insert(ids.registeredBadNumber, { gstRegistered: true, gstNumber: '049091850' });
  await insert(ids.unregisteredBadNumber, { gstNumber: '1234567' });
  await insert(ids.registeredLetters, { gstRegistered: true, gstNumber: 'ABC' });
  await insert(ids.unregisteredValidNumber, { gstNumber: '136410132' });
  return ids;
}

interface TeamRow {
  bank_account_name: string | null;
  bank_account_number: string | null;
  bank_account_last4: string | null;
  is_payout_configured: boolean;
  gst_registered: boolean;
  gst_number: string | null;
  payout_blocked_at: Date | null;
  banking_updated_at: Date | null;
  banking_updated_by: string | null;
}

async function readTeam(pool: pg.Pool, id: string): Promise<TeamRow> {
  const { rows } = await pool.query<TeamRow>(
    `SELECT bank_account_name, bank_account_number, bank_account_last4, is_payout_configured,
            gst_registered, gst_number, payout_blocked_at, banking_updated_at, banking_updated_by
       FROM teams WHERE id = $1`,
    [id],
  );
  const row = rows[0];
  if (row === undefined) throw new Error(`team ${id} missing`);
  return row;
}

const EMPTY_BLOCK = {
  bank_account_name: null,
  bank_account_number: null,
  bank_account_last4: null,
  is_payout_configured: false,
};

describe('upgrading a pre-feature database', () => {
  let db: TestDatabase;
  let seeded: Seeded;
  let before: Record<string, { name: string | null; number: string | null; last4: string | null }>;

  beforeAll(async () => {
    db = await createTestDatabase({ empty: true });
    await migrateToLatest({ databaseUrl: db.url, migrationsDir: preFeatureDir });
    seeded = await seedPreFeature(db.pool);
    const { rows } = await db.pool.query<{
      id: string;
      name: string | null;
      number: string | null;
      last4: string | null;
    }>(
      `SELECT id, bank_account_name AS name, bank_account_number AS number, bank_account_last4 AS last4 FROM teams`,
    );
    before = Object.fromEntries(rows.map((r) => [r.id, r]));
    // The feature migration, applied on top by the real runner.
    await migrateToLatest({ databaseUrl: db.url });
  }, 120_000);
  afterAll(async () => {
    await db.close();
  });

  it('sees every partial shape and the bad GST rows before the upgrade (the seed is meaningful)', () => {
    expect(Object.keys(before)).toHaveLength(Object.keys(seeded).length);
  });

  it('clears each partial payout block to all-NULL and recomputes the generated flag', async () => {
    for (const id of [
      seeded.partialName,
      seeded.partialNumberLast4,
      seeded.partialLast4,
      seeded.partialNameNumber,
    ]) {
      expect(await readTeam(db.pool, id), id).toMatchObject(EMPTY_BLOCK);
    }
    // A stale `true` flag with no block is now false, and there is no block to find.
    expect(await readTeam(db.pool, seeded.flagOnly)).toMatchObject(EMPTY_BLOCK);
  });

  it('keeps valid rows byte-identical: a full block stays and is configured, flag derived not copied', async () => {
    const valid = await readTeam(db.pool, seeded.valid);
    expect(valid).toMatchObject({
      bank_account_name: before[seeded.valid]?.name,
      bank_account_number: before[seeded.valid]?.number,
      bank_account_last4: before[seeded.valid]?.last4,
      is_payout_configured: true,
      gst_registered: true,
      gst_number: '49091850',
    });
    // The old flag was false for this valid block; the generated column now says true.
    expect(await readTeam(db.pool, seeded.validBlockOnly)).toMatchObject({
      bank_account_name: before[seeded.validBlockOnly]?.name,
      is_payout_configured: true,
    });
    expect(await readTeam(db.pool, seeded.unregisteredValidNumber)).toMatchObject({
      gst_registered: false,
      gst_number: '136410132',
    });
  });

  it('deregisters GST teams without a usable number and nulls malformed numbers', async () => {
    expect(await readTeam(db.pool, seeded.registeredNoNumber)).toMatchObject({
      gst_registered: false,
      gst_number: null,
    });
    for (const id of [seeded.registeredBadNumber, seeded.registeredLetters]) {
      expect(await readTeam(db.pool, id), id).toMatchObject({
        gst_registered: false,
        gst_number: null,
      });
    }
    expect(await readTeam(db.pool, seeded.unregisteredBadNumber)).toMatchObject({
      gst_registered: false,
      gst_number: null,
    });
  });

  it('adds the new columns empty and leaves every new CHECK validated', async () => {
    const row = await readTeam(db.pool, seeded.valid);
    expect(row).toMatchObject({
      payout_blocked_at: null,
      banking_updated_at: null,
      banking_updated_by: null,
    });
    const { rows } = await db.pool.query<{ conname: string; convalidated: boolean }>(
      `SELECT conname, convalidated FROM pg_constraint
        WHERE conrelid = 'teams'::regclass AND contype = 'c' AND conname = ANY($1) ORDER BY conname`,
      [
        [
          'teams_payout_details_all_or_none',
          'teams_gst_number_format',
          'teams_gst_registered_requires_gst_number',
          'teams_banking_updated_pair',
        ],
      ],
    );
    expect(rows).toEqual([
      { conname: 'teams_banking_updated_pair', convalidated: true },
      { conname: 'teams_gst_number_format', convalidated: true },
      { conname: 'teams_gst_registered_requires_gst_number', convalidated: true },
      { conname: 'teams_payout_details_all_or_none', convalidated: true },
    ]);
  });

  it('rolls back to a plain is_payout_configured column, recomputed from the block, and migrates forward again', async () => {
    await rollbackMigrations({ databaseUrl: db.url, count: 1 });
    const { rows } = await db.pool.query<{
      attgenerated: string;
      attnotnull: boolean;
      has_default: boolean;
    }>(
      `SELECT a.attgenerated, a.attnotnull, d.adbin IS NOT NULL AS has_default
         FROM pg_attribute a LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
        WHERE a.attrelid = 'teams'::regclass AND a.attname = 'is_payout_configured'`,
    );
    expect(rows[0]).toEqual({ attgenerated: '', attnotnull: true, has_default: true });
    const { rows: flags } = await db.pool.query<{ id: string; is_payout_configured: boolean }>(
      `SELECT id, is_payout_configured FROM teams WHERE id = ANY($1) ORDER BY id`,
      [[seeded.valid, seeded.validBlockOnly, seeded.partialName]],
    );
    const byId = Object.fromEntries(flags.map((f) => [f.id, f.is_payout_configured]));
    expect(byId).toEqual({
      [seeded.valid]: true,
      [seeded.validBlockOnly]: true,
      [seeded.partialName]: false,
    });
    const { rows: leftovers } = await db.pool.query<{ name: string }>(
      `SELECT proname AS name FROM pg_proc WHERE pronamespace = 'public'::regnamespace
          AND proname IN ('game_session_is_paid', 'team_banking_in_use', 'game_sessions_enforce_payout',
                          'teams_guard_banking_removal')
       UNION ALL SELECT tgname FROM pg_trigger WHERE NOT tgisinternal
          AND tgname IN ('game_sessions_paid_requires_payout', 'teams_guard_banking_removal')
       UNION ALL SELECT conname FROM pg_constraint WHERE conrelid = 'teams'::regclass
          AND conname IN ('teams_payout_details_all_or_none', 'teams_gst_number_format',
                          'teams_gst_registered_requires_gst_number', 'teams_banking_updated_pair')`,
    );
    expect(leftovers).toEqual([]);
    const { rows: gone } = await db.pool.query(
      `SELECT 1 FROM pg_attribute WHERE attrelid = 'teams'::regclass AND NOT attisdropped
          AND attname IN ('payout_blocked_at', 'banking_updated_at', 'banking_updated_by')`,
    );
    expect(gone).toEqual([]);

    await migrateToLatest({ databaseUrl: db.url });
    expect(await readTeam(db.pool, seeded.valid)).toMatchObject({ is_payout_configured: true });
  }, 60_000);
});

describe('migration NOTICE', () => {
  it('reports how many rows each cleanup stage changed', async () => {
    const empty = await createTestDatabase({ empty: true });
    try {
      await migrateToLatest({ databaseUrl: empty.url, migrationsDir: preFeatureDir });
      await seedPreFeature(empty.pool);
      const source = readFileSync(join(findMigrationsDir(), FEATURE_MIGRATION), 'utf8');
      const up = source.slice(0, source.indexOf('-- Down Migration'));
      const client = new pg.Client({ connectionString: empty.url });
      const notices: string[] = [];
      client.on('notice', (message) => notices.push(message.message ?? ''));
      await client.connect();
      try {
        await client.query(up);
      } finally {
        await client.end();
      }
      const text = notices.join('\n');
      expect(text).toMatch(/cleared 4 partial payout block/);
      expect(text).toMatch(/nulled 3 malformed gst_number/);
      expect(text).toMatch(/deregistered 3 GST team/);
    } finally {
      await empty.close();
    }
  }, 60_000);
});
