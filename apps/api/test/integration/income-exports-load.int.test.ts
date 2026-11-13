/**
 * Load test for the bounded income exports (tax-invoices-and-exports CR-3): concurrent worst-case-width CSV and XLSX exports
 * through the API, and the row cap at its production ceiling. Rows are bulk-inserted with `generate_series` in this file's own
 * cloned database. Wall-clock numbers are PRINTED, never asserted tightly (PR #9 lesson): the only budgets are the explicit
 * test timeouts and a loose heap bound, so a loaded CI host cannot make this flaky.
 */
import { strFromU8, unzipSync } from 'fflate';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { bearer, buildAuthTestApp, type AuthTestApp } from '../helpers/auth-app.ts';
import {
  insertAuthSession,
  insertTeam,
  insertTeamMember,
  insertUser,
} from '../helpers/factories.ts';
import { errorOf } from '../helpers/registrations-http.ts';
import { createTestDatabase, type TestDatabase } from '../helpers/test-db.ts';

const TODAY = new Date('2027-07-10T00:00:00.000Z');
const FIRST_PAID = new Date('2026-04-01T00:00:00.000Z');
const QUERY = 'format=FORMAT&period=fy&year=2026-27';
/** 255 characters (the column maximum) of 2-byte letters, quotes and commas, starting with a formula trigger. */
const WIDE_NAME = `=${'Hōhepa "Ō", Wīremu; '.repeat(20)}`.slice(0, 255).trimEnd();

let database: TestDatabase;
let h: AuthTestApp;
let referenceOffset = 0;

beforeAll(async () => {
  database = await createTestDatabase({ poolMax: 20 });
  h = await buildAuthTestApp(database.pool, {
    incomeExports: { maxRows: 50_000, maxBytes: 33_554_432, maxConcurrent: 4 },
  });
  h.clock.set(TODAY);
});
afterAll(async () => {
  await h.close();
  await database.close();
});

interface LoadTeam {
  readonly teamId: string;
  readonly token: string;
}

/** A team, its admin and `rows` PAID payments (one payer named `payerName`, no registration) spread across FY 2026-27. */
async function loadTeam(rows: number, payerName: string): Promise<LoadTeam> {
  const teamId = await insertTeam(database.pool, {
    name: `Load ${'Ō'.repeat(30)} Club`,
    gstRegistered: true,
    gstNumber: '49091850',
  });
  const adminId = await insertUser(database.pool);
  await insertTeamMember(database.pool, { teamId, userId: adminId, role: 'TEAM_ADMIN' });
  const payerId = await insertUser(database.pool);
  await database.pool.query('UPDATE users SET full_name = $2 WHERE id = $1', [payerId, payerName]);
  await insertTeamMember(database.pool, { teamId, userId: payerId, role: 'MEMBER' });
  await addPayments(teamId, payerId, rows);
  const { token } = await insertAuthSession(database.pool, adminId, {
    createdAt: TODAY,
    idleDays: 90,
    absoluteDays: 180,
  });
  return { teamId, token };
}

async function addPayments(teamId: string, payerId: string, rows: number): Promise<void> {
  const offset = referenceOffset;
  referenceOffset += rows;
  await database.pool.query(
    `INSERT INTO payments (user_id, team_id, registration_id, pricing_structure, gst_registered, gst_rate_bps,
                           amount, payment_reference, gst_number, due_date, status, paid_at)
     SELECT $1, $2, NULL, 'FLAT', true, 1500, ((g % 9000) + 100)::numeric(10,2) / 100,
            'SGM' || lpad(upper(to_hex(g + $4)), 8, '0'), '49091850', $5, 'PAID',
            $5::timestamptz + (g % 525000) * interval '1 minute'
       FROM generate_series(1, $3) AS g`,
    [payerId, teamId, rows, offset, FIRST_PAID],
  );
}

const exportOf = (t: LoadTeam, format: 'csv' | 'xlsx') =>
  h.app.inject({
    method: 'GET',
    url: `/teams/${t.teamId}/exports/income?${QUERY.replace('FORMAT', format)}`,
    headers: bearer(t.token),
  });

function heapSampler(): { stop: () => number } {
  const base = process.memoryUsage().heapUsed;
  let peak = base;
  const timer = setInterval(() => {
    peak = Math.max(peak, process.memoryUsage().heapUsed);
  }, 25);
  return {
    stop() {
      clearInterval(timer);
      return Math.max(peak, process.memoryUsage().heapUsed) - base;
    },
  };
}

describe('income export load (CR-3)', () => {
  it('serves four concurrent worst-case-width exports (two CSV, two XLSX) completely, with bounded memory', async () => {
    const teams = [];
    for (let i = 0; i < 4; i += 1) teams.push(await loadTeam(8_000, WIDE_NAME));
    const formats = ['csv', 'xlsx', 'csv', 'xlsx'] as const;
    const heap = heapSampler();
    const started = performance.now();
    const results = await Promise.all(teams.map((t, i) => exportOf(t, formats[i] ?? 'csv')));
    const elapsedMs = performance.now() - started;
    const heapGrowth = heap.stop();
    for (const [i, res] of results.entries()) {
      expect(res.statusCode, formats[i]).toBe(200);
      expect(res.headers['x-export-row-count']).toBe('8000');
      expect(res.headers['content-length']).toBe(String(res.rawPayload.length));
    }
    const csv = results[0]?.rawPayload.toString('utf8') ?? '';
    // Header plus 8,000 rows, every name neutralised and quoted.
    expect(csv.split('\r\n').filter((line) => line.length > 0)).toHaveLength(8_001);
    expect(csv).toContain(`"'=Hōhepa ""Ō"", Wīremu;`);
    const sheet = strFromU8(
      unzipSync(new Uint8Array(results[1]?.rawPayload ?? Buffer.alloc(0)))[
        'xl/worksheets/sheet1.xml'
      ] ?? new Uint8Array(),
    );
    expect(sheet.match(/<row /g)).toHaveLength(8_001);
    // Loose, load-insensitive: the four files are about 40 MB of XML and CSV in total.
    expect(heapGrowth).toBeLessThan(768 * 1024 * 1024);
    // Informational only (never asserted): visible in the test output for the ADR's measured ceiling.
    console.info(
      JSON.stringify({
        event: 'test.income_export.load',
        elapsedMs: Math.round(elapsedMs),
        heapGrowthMiB: Math.round(heapGrowth / 1048576),
        bytes: results.map((res) => res.rawPayload.length),
      }),
    );
  }, 240_000);

  it('exports exactly the production ceiling of 50,000 rows in both formats, and refuses one row more', async () => {
    const t = await loadTeam(50_000, 'Aroha Ngata');
    for (const format of ['csv', 'xlsx'] as const) {
      const started = performance.now();
      const res = await exportOf(t, format);
      expect(res.statusCode, format).toBe(200);
      expect(res.headers['x-export-row-count']).toBe('50000');
      console.info(
        JSON.stringify({
          event: 'test.income_export.ceiling',
          format,
          elapsedMs: Math.round(performance.now() - started),
          bytes: res.rawPayload.length,
        }),
      );
    }
    const { rows } = await database.pool.query<{ id: string }>(
      `SELECT user_id AS id FROM payments WHERE team_id = $1 LIMIT 1`,
      [t.teamId],
    );
    await addPayments(t.teamId, rows[0]?.id ?? '', 1);
    const refused = await exportOf(t, 'csv');
    expect(refused.statusCode).toBe(422);
    expect(errorOf(refused).code).toBe('export_too_large');
  }, 240_000);
});
