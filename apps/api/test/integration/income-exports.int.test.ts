/**
 * Income exports over HTTP on a real PostgreSQL (tax-invoices-and-exports Phase 4; AC-HAPPY-6, 7, 8, 9, AC-ERROR-2, 3, 4, 5,
 * AC-VERIFY-2, 5, 6, AC-INTEGRATION-3; CR-3). Rows are exactly the team's PAID payments whose `paid_at` falls in the NZ-local
 * inclusive range, ordered by `paid_at`, invoice number (nulls last) and id; the Summary reconciles to a direct SQL SUM; the XLSX
 * reads back equal to the CSV; refusals return JSON and never a partial file. Concurrency and cancellation are ordered with
 * `waitForLockWaiters` on a held ACCESS EXCLUSIVE lock, never sleeps.
 */
import { request as httpRequest } from 'node:http';
import type { AddressInfo } from 'node:net';
import { strFromU8, unzipSync } from 'fflate';
import type { LightMyRequestResponse } from 'fastify';
import readXlsxFile from 'read-excel-file/node';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  INCOME_EXPORT_COLUMNS,
  addLocalDays,
  parseLocalDate,
  type IncomeExportPeriodsResponse,
} from '@sgm/shared';
import { createPool } from '../../src/lib/db/pool.ts';
import { createExportSemaphore } from '../../src/modules/income-exports/semaphore.ts';
import { createIncomeExportService } from '../../src/modules/income-exports/service.ts';
import { bearer, buildAuthTestApp, type AuthTestApp } from '../helpers/auth-app.ts';
import {
  insertAuthSession,
  insertPayment,
  insertPaymentAttempt,
  insertPublishedSession,
  insertRegistration,
  insertTeam,
  insertTeamMember,
  insertUser,
  insertWallet,
  issueDocument,
  setPaymentStatusUnchecked,
} from '../helpers/factories.ts';
import { countLockWaiters, waitForLockWaiters } from '../helpers/lock-waiters.ts';
import { errorOf } from '../helpers/registrations-http.ts';
import { createTestDatabase, inTransaction, type TestDatabase } from '../helpers/test-db.ts';
import { waitFor } from '../helpers/wait-for.ts';

/** 10 July 2027, 12:00 NZST: after every range below, so none is "in the future". */
const TODAY = new Date('2027-07-10T00:00:00.000Z');
const GST_NUMBER = '49091850';
const LIMITS = { maxRows: 50_000, maxBytes: 33_554_432, maxConcurrent: 2 } as const;

let database: TestDatabase;
let h: AuthTestApp;

beforeAll(async () => {
  database = await createTestDatabase({ poolMax: 20 });
  h = await buildAuthTestApp(database.pool, { incomeExports: LIMITS });
});
afterAll(async () => {
  await h.close();
  await database.close();
});
beforeEach(() => {
  h.clock.set(TODAY);
});

// ---------------------------------------------------------------------------------------------
// Scene
// ---------------------------------------------------------------------------------------------

interface Person {
  readonly userId: string;
  readonly token: string;
}

async function person(
  teamId: string | null,
  role: 'TEAM_ADMIN' | 'MEMBER' | null,
  options: { fullName?: string; globalAdmin?: boolean } = {},
): Promise<Person> {
  const userId = await insertUser(database.pool);
  if (options.fullName !== undefined) {
    await database.pool.query('UPDATE users SET full_name = $2 WHERE id = $1', [
      userId,
      options.fullName,
    ]);
  }
  if (options.globalAdmin === true) {
    await database.pool.query("UPDATE users SET role = 'GLOBAL_ADMIN' WHERE id = $1", [userId]);
  }
  if (teamId !== null && role !== null) {
    await insertTeamMember(database.pool, { teamId, userId, role });
  }
  const { token } = await insertAuthSession(database.pool, userId, {
    createdAt: TODAY,
    idleDays: 90,
    absoluteDays: 180,
  });
  return { userId, token };
}

interface Team {
  readonly teamId: string;
  readonly sessionId: string;
  readonly admin: Person;
}

async function team(options: { name?: string; gst?: boolean } = {}): Promise<Team> {
  const gst = options.gst ?? true;
  const teamId = await insertTeam(database.pool, {
    name: options.name ?? 'Hōkio Badminton Club',
    payoutConfigured: true,
    gstRegistered: gst,
    ...(gst ? { gstNumber: GST_NUMBER } : {}),
  });
  const { sessionId } = await insertPublishedSession(database.pool, teamId, {
    now: new Date('2027-05-28T00:00:00.000Z'),
    flat: '23.00',
  });
  await database.pool.query(
    "UPDATE game_sessions SET location = 'Hōkio Sports Hall' WHERE id = $1",
    [sessionId],
  );
  return { teamId, sessionId, admin: await person(teamId, 'TEAM_ADMIN') };
}

interface PaymentOptions {
  readonly paidAt: Date;
  readonly amount?: string;
  readonly status?: 'PENDING' | 'PAID' | 'OVERDUE';
  readonly gst?: boolean;
  readonly payerName?: string;
}

/** A payment of the team by a new member (one registration each), PAID at `paidAt` by default. */
async function payment(t: Team, options: PaymentOptions): Promise<{ id: string; payer: Person }> {
  const payer = await person(t.teamId, 'MEMBER', { fullName: options.payerName ?? 'Aroha Ngata' });
  const registrationId = await inTransaction(database.pool, (client) =>
    insertRegistration(client, { sessionId: t.sessionId, teamId: t.teamId, userId: payer.userId }),
  );
  const status = options.status ?? 'PAID';
  const id = await insertPayment(database.pool, {
    userId: payer.userId,
    teamId: t.teamId,
    registrationId,
    amount: options.amount ?? '23.00',
    gstRegistered: options.gst ?? true,
    gstNumber: GST_NUMBER,
    status,
    ...(status === 'PAID' ? { paidAt: options.paidAt } : { dueDate: options.paidAt }),
  });
  return { id, payer };
}

const nzNoon = (date: string): Date => new Date(`${date}T00:00:00.000Z`);

function exportUrl(teamId: string, query: Record<string, string>): string {
  return `/teams/${teamId}/exports/income?${new URLSearchParams(query).toString()}`;
}

const get = (who: Person | null, url: string): Promise<LightMyRequestResponse> =>
  h.app.inject({ method: 'GET', url, ...(who === null ? {} : { headers: bearer(who.token) }) });

const custom = (from: string, to: string, format = 'csv') => ({
  format,
  period: 'custom',
  from,
  to,
});

/** RFC 4180 (quoted fields, doubled quotes, CRLF) without the BOM: enough to read our own files back in a test. */
function parseCsv(bytes: Buffer): string[][] {
  expect([...bytes.subarray(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);
  const input = bytes.subarray(3).toString('utf8');
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < input.length; i += 1) {
    const ch = input[i];
    if (quoted) {
      if (ch === '"' && input[i + 1] === '"') {
        field += '"';
        i += 1;
      } else if (ch === '"') quoted = false;
      else field += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ',') {
      row.push(field);
      field = '';
    } else if (ch === '\r' && input[i + 1] === '\n') {
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
      i += 1;
    } else field += ch;
  }
  expect(field).toBe('');
  return rows;
}

async function readXlsx(res: LightMyRequestResponse) {
  return readXlsxFile(Buffer.from(res.rawPayload), { parseNumber: (value: string) => value });
}

async function directSums(
  teamId: string,
  from: Date,
  to: Date,
): Promise<{ n: number; total: string; gst: string; subtotal: string }> {
  const { rows } = await database.pool.query<{
    n: number;
    total: string;
    gst: string;
    subtotal: string;
  }>(
    `SELECT count(*)::int AS n, coalesce(sum(amount), 0)::numeric(20,2)::text AS total,
            coalesce(sum(gst_amount), 0)::numeric(20,2)::text AS gst,
            coalesce(sum(subtotal_amount), 0)::numeric(20,2)::text AS subtotal
       FROM payments WHERE team_id = $1 AND status = 'PAID' AND paid_at >= $2 AND paid_at < $3`,
    [teamId, from, to],
  );
  const row = rows[0];
  if (row === undefined) throw new Error('no sums');
  return row;
}

const HEADER = INCOME_EXPORT_COLUMNS.map((column) => column.header);

function expectFileHeaders(res: LightMyRequestResponse, filename: string, rows: number): void {
  expect(res.statusCode).toBe(200);
  expect(res.headers['cache-control']).toBe('no-store');
  expect(res.headers['x-content-type-options']).toBe('nosniff');
  expect(res.headers['content-disposition']).toBe(`attachment; filename="${filename}"`);
  expect(res.headers['content-length']).toBe(String(res.rawPayload.length));
  expect(res.headers['x-export-row-count']).toBe(String(rows));
}

// ---------------------------------------------------------------------------------------------
// Happy paths, filter and reconciliation
// ---------------------------------------------------------------------------------------------

describe('GET /teams/:teamId/exports/income: rows, files and totals', () => {
  it('exports a custom range as CSV: PAID rows in range only, 11 columns, NZ dates, a named file (AC-HAPPY-6)', async () => {
    const t = await team();
    const june3 = await payment(t, { paidAt: nzNoon('2027-06-03') });
    const june10 = await payment(t, { paidAt: nzNoon('2027-06-10'), payerName: 'Tāne Wīremu' });
    await payment(t, { paidAt: nzNoon('2027-06-25') });
    await payment(t, { paidAt: nzNoon('2027-06-05'), status: 'PENDING' });
    await payment(t, { paidAt: nzNoon('2027-06-06'), status: 'OVERDUE' });
    await inTransaction(database.pool, (client) =>
      insertWallet(client, june3.payer.userId, t.teamId, '20.00'),
    );
    const { numberDisplay } = await issueDocument(database.pool, june3.id);

    const res = await get(t.admin, exportUrl(t.teamId, custom('2027-06-01', '2027-06-15')));
    expectFileHeaders(res, 'income_hokio-badminton-club_2027-06-01_to_2027-06-15.csv', 2);
    expect(res.headers['content-type']).toBe('text/csv; charset=utf-8');
    const rows = parseCsv(res.rawPayload);
    expect(rows[0]).toEqual(HEADER);
    expect(rows.slice(1)).toEqual([
      [
        numberDisplay,
        '2027-06-03',
        '2027-05-31',
        'Aroha Ngata',
        'Game fee, Hōkio Sports Hall, 31 May 2027',
        '20.00',
        '3.00',
        '23.00',
        'Yes',
        'Bank',
        expect.stringMatching(/^SGM[0-9A-Z]{8}$/),
      ],
      [
        '',
        '2027-06-10',
        '2027-05-31',
        'Tāne Wīremu',
        'Game fee, Hōkio Sports Hall, 31 May 2027',
        '20.00',
        '3.00',
        '23.00',
        'Yes',
        'Bank',
        expect.stringMatching(/^SGM[0-9A-Z]{8}$/),
      ],
    ]);
    expect(rows[2]?.[10]).not.toBe(rows[1]?.[10]);
    expect(june10.id).toBeDefined();
    // income_export.generated carries ids, kinds and the count only.
    const generated = h.logs.lines().filter((line) => line.event === 'income_export.generated');
    expect(generated.at(-1)).toMatchObject({
      teamId: t.teamId,
      periodType: 'custom',
      format: 'csv',
      rows: 2,
    });
    expect(JSON.stringify(generated.at(-1))).not.toMatch(/Aroha|23\.00|Hōkio/);
  });

  it('filters exactly by paid_at in [from 00:00 NZ, to + 1 day 00:00 NZ) and reconciles to a direct SQL SUM (AC-VERIFY-2)', async () => {
    const t = await team();
    const other = await team({ name: 'Other Club' });
    const from = new Date('2027-05-31T12:00:00.000Z'); // 1 June 00:00 NZST
    const to = new Date('2027-06-15T12:00:00.000Z'); // 16 June 00:00 NZST
    await payment(t, { paidAt: new Date(from.getTime() - 1) });
    const atFrom = await payment(t, { paidAt: from, amount: '37.00' });
    const beforeTo = await payment(t, { paidAt: new Date(to.getTime() - 1), amount: '12.00' });
    await payment(t, { paidAt: to });
    const failed = await payment(t, { paidAt: nzNoon('2027-06-07') });
    await setPaymentStatusUnchecked(database.pool, failed.id, 'FAILED');
    await payment(other, { paidAt: nzNoon('2027-06-07') });

    const csv = await get(t.admin, exportUrl(t.teamId, custom('2027-06-01', '2027-06-15')));
    const rows = parseCsv(csv.rawPayload).slice(1);
    expect(rows.map((row) => row[7])).toEqual(['37.00', '12.00']);
    expect(rows.map((row) => row[1])).toEqual(['2027-06-01', '2027-06-15']);
    expect(atFrom.id).not.toBe(beforeTo.id);

    const xlsx = await get(
      t.admin,
      exportUrl(t.teamId, custom('2027-06-01', '2027-06-15', 'xlsx')),
    );
    const summary = (await readXlsx(xlsx)).find((sheet) => sheet.sheet === 'Summary')?.data ?? [];
    const value = (label: string) => summary.find((row) => row[0] === label)?.[1];
    const sums = await directSums(t.teamId, from, to);
    expect(value('Payments')).toBe(String(sums.n));
    expect(value('Total (including GST)')).toBe(sums.total);
    expect(value('GST')).toBe(sums.gst);
    expect(value('Subtotal (excluding GST)')).toBe(sums.subtotal);
    expect(sums).toEqual({ n: 2, total: '49.00', gst: '6.40', subtotal: '42.60' });
  });

  it('orders rows by paid_at, then invoice number (nulls last), then id', async () => {
    const t = await team();
    const at = nzNoon('2027-06-04');
    const made = [];
    for (let i = 0; i < 5; i += 1) made.push(await payment(t, { paidAt: at }));
    const [p1, p2, p3, p4, p5] = made.map((p) => p.id) as [string, string, string, string, string];
    const n1 = (await issueDocument(database.pool, p2)).numberDisplay;
    const n2 = (await issueDocument(database.pool, p4)).numberDisplay;
    const n3 = (await issueDocument(database.pool, p1)).numberDisplay;
    const res = await get(t.admin, exportUrl(t.teamId, custom('2027-06-04', '2027-06-04')));
    const numbers = parseCsv(res.rawPayload)
      .slice(1)
      .map((row) => row[0]);
    expect(numbers).toEqual([n1, n2, n3, '', '']);
    const unnumbered = [p3, p5].sort();
    const { rows } = await database.pool.query<{ payment_reference: string }>(
      'SELECT payment_reference FROM payments WHERE id = ANY($1::uuid[]) ORDER BY id',
      [unnumbered],
    );
    expect(
      parseCsv(res.rawPayload)
        .slice(4)
        .map((row) => row[10]),
    ).toEqual(rows.map((row) => row.payment_reference));
  });

  it('a GST period equals the same dates as a custom range, and names the period in the file (AC-HAPPY-7)', async () => {
    const t = await team();
    await payment(t, { paidAt: nzNoon('2027-03-31') });
    await payment(t, { paidAt: nzNoon('2027-04-01') });
    await payment(t, { paidAt: new Date('2027-05-31T11:59:59.999Z') }); // 31 May 23:59:59.999 NZST
    await payment(t, { paidAt: new Date('2027-05-31T12:00:00.000Z') }); // 1 June 00:00 NZST: out
    const gst = await get(
      t.admin,
      exportUrl(t.teamId, { format: 'csv', period: 'gst', cadence: '2m-odd', end: '2027-05' }),
    );
    expectFileHeaders(gst, 'income_hokio-badminton-club_gst_2027-04_to_2027-05.csv', 2);
    const same = await get(t.admin, exportUrl(t.teamId, custom('2027-04-01', '2027-05-31')));
    expect(gst.rawPayload.equals(same.rawPayload)).toBe(true);
    const xlsx = await get(
      t.admin,
      exportUrl(t.teamId, { format: 'xlsx', period: 'gst', cadence: '2m-odd', end: '2027-05' }),
    );
    const summary = (await readXlsx(xlsx)).find((sheet) => sheet.sheet === 'Summary')?.data ?? [];
    expect(summary).toEqual(
      expect.arrayContaining([['Period', 'GST period 01/04/2027 to 31/05/2027']]),
    );
  });

  it('a financial year runs 1 April to 31 March in NZ time: 31 March 23:59:59.999 NZDT in, 1 April 00:00 NZDT out (AC-HAPPY-8)', async () => {
    const t = await team();
    await payment(t, { paidAt: new Date('2026-03-31T11:00:00.000Z') }); // 1 April 2026 00:00 NZDT: in
    await payment(t, { paidAt: new Date('2027-03-31T10:59:59.999Z'), amount: '12.00' }); // in
    await payment(t, { paidAt: new Date('2027-03-31T11:00:00.000Z'), amount: '37.00' }); // 2027-28
    const res = await get(
      t.admin,
      exportUrl(t.teamId, { format: 'csv', period: 'fy', year: '2026-27' }),
    );
    expectFileHeaders(res, 'income_hokio-badminton-club_fy_2026-27.csv', 2);
    expect(
      parseCsv(res.rawPayload)
        .slice(1)
        .map((row) => [row[1], row[7]]),
    ).toEqual([
      ['2026-04-01', '23.00'],
      ['2027-03-31', '12.00'],
    ]);
  });

  it('the XLSX Payments sheet equals the CSV row for row, money cells are numbers, and the workbook has no formula, link or macro (AC-HAPPY-9, AC-INTEGRATION-3)', async () => {
    const t = await team();
    await payment(t, { paidAt: nzNoon('2027-06-03'), payerName: '=HYPERLINK("http://x","click")' });
    const zero = await payment(t, { paidAt: nzNoon('2027-06-04'), amount: '0.00' });
    const issued = await payment(t, { paidAt: nzNoon('2027-06-05'), amount: '37.00' });
    await issueDocument(database.pool, issued.id);
    const csv = await get(t.admin, exportUrl(t.teamId, custom('2027-06-01', '2027-06-30')));
    const xlsx = await get(
      t.admin,
      exportUrl(t.teamId, custom('2027-06-01', '2027-06-30', 'xlsx')),
    );
    expectFileHeaders(xlsx, 'income_hokio-badminton-club_2027-06-01_to_2027-06-30.xlsx', 3);
    expect(xlsx.headers['content-type']).toBe(
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    );
    const sheets = await readXlsx(xlsx);
    expect(sheets.map((sheet) => sheet.sheet)).toEqual(['Payments', 'Summary']);
    // read-excel-file returns null for an empty cell; the CSV has an empty field there.
    const payments = (sheets[0]?.data ?? []).map((row) => row.map((cell) => cell ?? ''));
    expect(payments).toEqual(parseCsv(csv.rawPayload));
    // AC-ERROR-5: the $0.00 payment is listed with zero money, no number and no "Paid by".
    const zeroRow = payments.find((row) => row[7] === '0.00');
    expect(zeroRow?.[0]).toBe('');
    expect(zeroRow?.[9]).toBe('');
    expect(zero.id).toBeDefined();
    const summary = sheets[1]?.data ?? [];
    expect(summary).toEqual(
      expect.arrayContaining([
        ['Team', 'Hōkio Badminton Club'],
        ['GST number', '49-091-850'],
        ['Payments', '3'],
        ['With an invoice or receipt number', '1'],
        ['$0.00 payments (no document)', '1'],
        ['Awaiting an invoice or receipt number', '1'],
        ['Total (including GST)', '60.00'],
      ]),
    );
    const parts = unzipSync(new Uint8Array(xlsx.rawPayload));
    const xml = Object.values(parts)
      .map((part) => strFromU8(part))
      .join('\n');
    expect(xml).not.toMatch(/<f[\s>]|externalLink|vbaProject|definedName/i);
    expect(xml).toMatch(/<c r="H2" s="1"><v>23\.00<\/v><\/c>/);
  });

  it('a valid range with no PAID payments is a header-only CSV and a zero Summary, not an error (AC-ERROR-3)', async () => {
    const t = await team({ gst: false });
    const csv = await get(t.admin, exportUrl(t.teamId, custom('2027-01-01', '2027-01-31')));
    expectFileHeaders(csv, 'income_hokio-badminton-club_2027-01-01_to_2027-01-31.csv', 0);
    expect(parseCsv(csv.rawPayload)).toEqual([HEADER]);
    const xlsx = await get(
      t.admin,
      exportUrl(t.teamId, custom('2027-01-01', '2027-01-31', 'xlsx')),
    );
    const summary = (await readXlsx(xlsx)).find((sheet) => sheet.sheet === 'Summary')?.data ?? [];
    expect(summary).toEqual(
      expect.arrayContaining([
        ['GST number', 'Not registered'],
        ['Payments', '0'],
        ['Total (including GST)', '0.00'],
      ]),
    );
  });

  it("an empty export of a GST-registered team still prints the team's GST number on the Summary", async () => {
    const t = await team({ gst: true });
    const xlsx = await get(
      t.admin,
      exportUrl(t.teamId, custom('2027-01-01', '2027-01-31', 'xlsx')),
    );
    const summary = (await readXlsx(xlsx)).find((sheet) => sheet.sheet === 'Summary')?.data ?? [];
    expect(summary).toEqual(
      expect.arrayContaining([
        ['GST number', '49-091-850'],
        ['Payments', '0'],
      ]),
    );
  });

  it('a team registered now prints no GST number for a period it was not registered in, even with payments', async () => {
    const t = await team({ gst: true });
    await payment(t, { paidAt: nzNoon('2027-06-03'), gst: false });
    const xlsx = await get(
      t.admin,
      exportUrl(t.teamId, custom('2027-06-01', '2027-06-30', 'xlsx')),
    );
    const summary = (await readXlsx(xlsx)).find((sheet) => sheet.sheet === 'Summary')?.data ?? [];
    expect(summary).toEqual(
      expect.arrayContaining([
        ['GST number', 'Not registered'],
        ['Payments', '1'],
      ]),
    );
  });

  it('prints the issue-time snapshot name for an issued payment and the live name otherwise', async () => {
    const t = await team();
    const issued = await payment(t, { paidAt: nzNoon('2027-06-03'), payerName: 'Old Name' });
    const live = await payment(t, { paidAt: nzNoon('2027-06-04'), payerName: 'Old Live' });
    await issueDocument(database.pool, issued.id);
    await database.pool.query('UPDATE users SET full_name = $2 WHERE id = $1', [
      issued.payer.userId,
      'New Name',
    ]);
    await database.pool.query('UPDATE users SET full_name = $2 WHERE id = $1', [
      live.payer.userId,
      'New Live',
    ]);
    const res = await get(t.admin, exportUrl(t.teamId, custom('2027-06-01', '2027-06-30')));
    expect(
      parseCsv(res.rawPayload)
        .slice(1)
        .map((row) => row[3]),
    ).toEqual(['Old Name', 'New Live']);
  });

  it('neutralises formula-looking names in both formats, keeps macrons and quoting, and leaks no email, Akahu id or bank detail (AC-VERIFY-5)', async () => {
    const t = await team({ name: 'Hōhepa\'s, "Club"\nNorth' });
    const hostile = ['=HYPERLINK("http://x","click")', '+1 Smith', '@cmd', '-2+3'] as const;
    const made = [];
    for (const [i, name] of hostile.entries()) {
      made.push(await payment(t, { paidAt: nzNoon(`2027-06-0${i + 1}`), payerName: name }));
    }
    const first = made[0];
    if (first === undefined) throw new Error('no payment');
    await insertPaymentAttempt(database.pool, {
      paymentId: first.id,
      amount: '23.00',
      status: 'OPEN',
      akahuPaymentId: 'fake_success_2300_1_akahuleak',
    });
    const { rows: emails } = await database.pool.query<{ email: string }>(
      'SELECT u.email FROM users u JOIN payments p ON p.user_id = u.id WHERE p.team_id = $1',
      [t.teamId],
    );
    const { rows: banking } = await database.pool.query<{ last4: string }>(
      'SELECT bank_account_last4 AS last4 FROM teams WHERE id = $1',
      [t.teamId],
    );
    const csv = await get(t.admin, exportUrl(t.teamId, custom('2027-06-01', '2027-06-30')));
    const xlsx = await get(
      t.admin,
      exportUrl(t.teamId, custom('2027-06-01', '2027-06-30', 'xlsx')),
    );
    const csvRows = parseCsv(csv.rawPayload);
    expect(csvRows.slice(1).map((row) => row[3])).toEqual(hostile.map((name) => `'${name}`));
    const sheets = await readXlsx(xlsx);
    expect((sheets[0]?.data ?? []).slice(1).map((row) => row[3])).toEqual(
      hostile.map((name) => `'${name}`),
    );
    expect(sheets[1]?.data).toEqual(expect.arrayContaining([['Team', 'Hōhepa\'s, "Club"\nNorth']]));
    const xml = Object.values(unzipSync(new Uint8Array(xlsx.rawPayload)))
      .map((part) => strFromU8(part))
      .join('\n');
    for (const haystack of [csv.rawPayload.toString('utf8'), xml]) {
      for (const { email } of emails) expect(haystack).not.toContain(email);
      expect(haystack).not.toContain('akahuleak');
      expect(haystack).not.toMatch(new RegExp(`\\b${banking[0]?.last4 ?? 'none'}\\b`));
    }
  });
});

// ---------------------------------------------------------------------------------------------
// Refusals
// ---------------------------------------------------------------------------------------------

describe('refusals: 422 with field messages, row and byte caps, and the role matrix', () => {
  it('answers 422 with a field-level message and no file for each invalid input (AC-ERROR-3, R3: 7 years)', async () => {
    const t = await team();
    const today = parseLocalDate('2027-07-10');
    const cases: [Record<string, string>, string][] = [
      [custom('2027-06-15', '2027-06-01'), 'to'],
      [custom('2027-02-30', '2027-03-01'), 'from'],
      [custom('2027-07-11', '2027-07-20'), 'from'],
      [custom(addLocalDays(today, -2557), today), 'to'],
      [{ ...custom('2027-06-01', '2027-06-15'), format: 'pdf' }, 'format'],
      [{ format: 'csv', period: 'fy', year: '2026-28' }, 'year'],
      [{ format: 'csv', period: 'fy', year: '2028-29' }, 'year'],
      [{ format: 'csv', period: 'gst', cadence: '2m-odd', end: '2027-04' }, 'end'],
      [{ format: 'csv', period: 'gst', cadence: '2m-odd', end: '2027-09' }, 'end'],
      // Terminal dates: well-formed input whose range would end past 9999-12-31 is a 422, never a 500.
      [{ format: 'csv', period: 'fy', year: '9999-00' }, 'year'],
      [{ format: 'csv', period: 'gst', cadence: '2m-odd', end: '9999-11' }, 'end'],
      [custom('2027-06-01', '9999-12-31'), 'to'],
    ];
    for (const [query, field] of cases) {
      const res = await get(t.admin, exportUrl(t.teamId, query));
      const label = JSON.stringify(query);
      expect(res.statusCode, label).toBe(422);
      expect(res.headers['content-type'], label).toMatch(/application\/json/);
      expect(res.headers['cache-control'], label).toBe('no-store');
      expect(res.headers['content-disposition'], label).toBeUndefined();
      const error = errorOf(res);
      expect(error.code, label).toBe('validation_failed');
      expect(Object.keys(error.fieldErrors ?? {}), label).toContain(field);
    }
    const tooLong = errorOf(
      await get(t.admin, exportUrl(t.teamId, custom(addLocalDays(today, -2557), today))),
    );
    expect(tooLong.fieldErrors?.to).toEqual(['Choose a range of 7 years or less']);
    const backwards = errorOf(
      await get(t.admin, exportUrl(t.teamId, custom('2027-06-15', '2027-06-01'))),
    );
    expect(backwards.fieldErrors?.to).toEqual(["The end date can't be before the start date"]);
    // Exactly 2,557 days inclusive is allowed.
    const longest = await get(
      t.admin,
      exportUrl(t.teamId, custom(addLocalDays(today, -2556), today)),
    );
    expect(longest.statusCode).toBe(200);
    // An unknown key and an unknown period type are refused too.
    expect(
      (await get(t.admin, exportUrl(t.teamId, { ...custom('2027-06-01', '2027-06-02'), x: '1' })))
        .statusCode,
    ).toBe(422);
    expect(
      (await get(t.admin, exportUrl(t.teamId, { format: 'csv', period: 'weekly' }))).statusCode,
    ).toBe(422);
  });

  it('refuses a range over the row cap or the byte cap with 422 export_too_large and never a partial file (AC-ERROR-4, CR-3)', async () => {
    const capped = await buildAuthTestApp(database.pool, {
      incomeExports: { maxRows: 3, maxBytes: 33_554_432, maxConcurrent: 2 },
    });
    const tiny = await buildAuthTestApp(database.pool, {
      incomeExports: { maxRows: 50_000, maxBytes: 1_024, maxConcurrent: 2 },
    });
    try {
      capped.clock.set(TODAY);
      tiny.clock.set(TODAY);
      const t = await team();
      for (let day = 1; day <= 4; day += 1) {
        await payment(t, { paidAt: nzNoon(`2027-06-0${day}`), payerName: 'x'.repeat(200) });
      }
      const at = (app: AuthTestApp, query: Record<string, string>) =>
        app.app.inject({
          method: 'GET',
          url: exportUrl(t.teamId, query),
          headers: bearer(t.admin.token),
        });
      expect((await at(capped, custom('2027-06-01', '2027-06-03'))).statusCode).toBe(200);
      for (const format of ['csv', 'xlsx']) {
        const overRows = await at(capped, custom('2027-06-01', '2027-06-04', format));
        expect(overRows.statusCode).toBe(422);
        expect(errorOf(overRows)).toMatchObject({
          code: 'export_too_large',
          message: 'Choose a shorter range.',
        });
        expect(overRows.headers['content-disposition']).toBeUndefined();
        const overBytes = await at(tiny, custom('2027-06-01', '2027-06-04', format));
        expect(overBytes.statusCode, format).toBe(422);
        expect(errorOf(overBytes).code).toBe('export_too_large');
        expect(overBytes.headers['content-disposition']).toBeUndefined();
      }
      expect(capped.logs.lines().filter((line) => line.event === 'income_export.refused')).toEqual(
        expect.arrayContaining([expect.objectContaining({ teamId: t.teamId, reason: 'rows' })]),
      );
      expect(tiny.logs.lines().filter((line) => line.event === 'income_export.refused')).toEqual(
        expect.arrayContaining([expect.objectContaining({ teamId: t.teamId, reason: 'bytes' })]),
      );
    } finally {
      await capped.close();
      await tiny.close();
    }
  });

  it('answers 401 unauthenticated, 403 for a MEMBER, another team admin and a GLOBAL_ADMIN who is not a team admin, before any query (AC-ERROR-2, AC-VERIFY-6, H9)', async () => {
    const t = await team();
    const otherTeam = await team({ name: 'Other' });
    await payment(t, { paidAt: nzNoon('2027-06-03'), payerName: 'Secret Name' });
    const member = await person(t.teamId, 'MEMBER');
    const global = await person(null, null, { globalAdmin: true });
    for (const path of [
      exportUrl(t.teamId, custom('2027-06-01', '2027-06-30')),
      // Even an invalid query: the guard runs first, so nothing about the input is revealed.
      exportUrl(t.teamId, { format: 'pdf' }),
      `/teams/${t.teamId}/exports/income/periods`,
    ]) {
      const anonymous = await get(null, path);
      expect(anonymous.statusCode, path).toBe(401);
      expect(anonymous.headers['cache-control']).toBe('no-store');
      for (const who of [member, otherTeam.admin, global]) {
        const res = await get(who, path);
        expect(res.statusCode, path).toBe(403);
        expect(res.headers['cache-control']).toBe('no-store');
        expect(res.body).not.toContain('Secret Name');
        expect(errorOf(res).code).toBe('forbidden');
      }
    }
    // An unknown team is the same 403 (no team-existence oracle).
    expect(
      (
        await get(
          t.admin,
          exportUrl('00000000-0000-4000-8000-000000000000', custom('2027-06-01', '2027-06-02')),
        )
      ).statusCode,
    ).toBe(403);
  });
});

// ---------------------------------------------------------------------------------------------
// Period options
// ---------------------------------------------------------------------------------------------

describe('GET /teams/:teamId/exports/income/periods', () => {
  it("returns the API clock's today, the first paid date, the financial years with payments and the limits", async () => {
    const t = await team();
    await payment(t, { paidAt: new Date('2025-03-31T10:59:00.000Z') }); // 31 March 2025 NZDT: FY 2024-25
    await payment(t, { paidAt: nzNoon('2026-06-01') }); // FY 2026-27
    await payment(t, { paidAt: nzNoon('2024-01-01'), status: 'PENDING' }); // not PAID: ignored
    const res = await get(t.admin, `/teams/${t.teamId}/exports/income/periods`);
    expect(res.statusCode).toBe(200);
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.json<IncomeExportPeriodsResponse>()).toEqual({
      today: '2027-07-10',
      firstPaidDate: '2025-03-31',
      financialYearsWithPayments: [2024, 2026],
      maxRows: LIMITS.maxRows,
      maxRangeDays: 2557,
    });
    const empty = await team({ name: 'Empty' });
    expect(
      (await get(empty.admin, `/teams/${empty.teamId}/exports/income/periods`)).json(),
    ).toEqual({
      today: '2027-07-10',
      firstPaidDate: null,
      financialYearsWithPayments: [],
      maxRows: LIMITS.maxRows,
      maxRangeDays: 2557,
    });
  });
});

// ---------------------------------------------------------------------------------------------
// Snapshot, concurrency and cancellation (CR-3)
// ---------------------------------------------------------------------------------------------

/** Holds ACCESS EXCLUSIVE on `payments` in an open transaction, so an export's first read waits on a lock. */
async function holdPaymentsLock(): Promise<{ release: () => Promise<void> }> {
  const client = await database.pool.connect();
  await client.query('BEGIN');
  await client.query('LOCK TABLE payments IN ACCESS EXCLUSIVE MODE');
  let released = false;
  return {
    async release() {
      if (released) return;
      released = true;
      try {
        await client.query('COMMIT');
      } finally {
        client.release();
      }
    },
  };
}

describe('one snapshot, a bounded number of exports, and cancellation', () => {
  it('reads the preflight and the rows in one REPEATABLE READ snapshot: a payment committed in between is in neither', async () => {
    const t = await team();
    await payment(t, { paidAt: nzNoon('2027-06-03') });
    let inserted = '';
    const service = createIncomeExportService({
      db: h.db,
      clock: h.clock,
      limits: LIMITS,
      semaphore: createExportSemaphore({ maxConcurrent: 2 }),
      cancelBackend: () => Promise.resolve(),
      afterPreflight: async () => {
        inserted = (await payment(t, { paidAt: nzNoon('2027-06-04') })).id;
      },
    });
    const file = await service.exportIncome(
      t.teamId,
      {
        format: 'csv',
        period: {
          kind: 'custom',
          range: { from: parseLocalDate('2027-06-01'), to: parseLocalDate('2027-06-30') },
        },
      },
      { log: h.logs.logger, signal: new AbortController().signal },
    );
    expect(inserted).not.toBe('');
    expect(file.rows).toBe(1);
    expect(parseCsv(Buffer.from(file.bytes))).toHaveLength(2);
    // The next export sees it.
    const res = await get(t.admin, exportUrl(t.teamId, custom('2027-06-01', '2027-06-30')));
    expect(res.headers['x-export-row-count']).toBe('2');
  });

  it('answers 429 export_busy with a retry hint while the same team, or the global limit, is busy (CR-3)', async () => {
    const one = await buildAuthTestApp(database.pool, {
      incomeExports: { maxRows: 50_000, maxBytes: 33_554_432, maxConcurrent: 1 },
    });
    one.clock.set(TODAY);
    const a = await team();
    const b = await team({ name: 'B Club' });
    await payment(a, { paidAt: nzNoon('2027-06-03') });
    const lock = await holdPaymentsLock();
    try {
      const inject = (t: Team) =>
        one.app.inject({
          method: 'GET',
          url: exportUrl(t.teamId, custom('2027-06-01', '2027-06-30')),
          headers: bearer(t.admin.token),
        });
      const first = inject(a);
      await waitForLockWaiters(database.pool, 1, 'export blocked on the payments lock');
      for (const t of [a, b]) {
        const busy = await inject(t);
        expect(busy.statusCode).toBe(429);
        expect(busy.headers['retry-after']).toBe('10');
        expect(busy.headers['cache-control']).toBe('no-store');
        expect(errorOf(busy).code).toBe('export_busy');
      }
      await lock.release();
      expect((await first).statusCode).toBe(200);
      // Slots are released: both teams can export again.
      expect((await inject(a)).statusCode).toBe(200);
      expect((await inject(b)).statusCode).toBe(200);
    } finally {
      await lock.release();
      await one.close();
    }
  });

  it('cancels the Postgres statement and frees the slot when the client disconnects mid-export (CR-3)', async () => {
    const t = await team();
    await payment(t, { paidAt: nzNoon('2027-06-03') });
    await h.app.listen({ port: 0, host: '127.0.0.1' });
    const { port } = h.app.server.address() as AddressInfo;
    const lock = await holdPaymentsLock();
    try {
      const client = httpRequest({
        host: '127.0.0.1',
        port,
        path: exportUrl(t.teamId, custom('2027-06-01', '2027-06-30')),
        headers: bearer(t.admin.token),
      });
      client.on('error', () => {
        // The socket is destroyed on purpose.
      });
      client.end();
      await waitForLockWaiters(database.pool, 1, 'export blocked on the payments lock');
      client.destroy();
      // The export's statement is cancelled while the lock is still held: nobody waits on it any more.
      await waitFor(
        async () => ((await countLockWaiters(database.pool)) === 0 ? true : undefined),
        {
          label: 'the cancelled export to stop waiting',
          timeoutMs: 15_000,
        },
      );
      await waitFor(
        () =>
          Promise.resolve(
            h.logs
              .lines()
              .some((line) => line.event === 'income_export.cancelled' && line.teamId === t.teamId)
              ? true
              : undefined,
          ),
        { label: 'income_export.cancelled', timeoutMs: 15_000 },
      );
    } finally {
      await lock.release();
    }
    // The team's slot is free again.
    const res = await get(t.admin, exportUrl(t.teamId, custom('2027-06-01', '2027-06-30')));
    expect(res.statusCode).toBe(200);
  });

  it('cancels every export at the concurrency limit when the app pool is no bigger than the limit: the cancel never waits on the exhausted pool (CR-3)', async () => {
    // A pool of 2 and 2 exports at once: both connections are held by the blocked exports, so a cancel drawn from this pool
    // would wait for a connection that only the cancel itself could free.
    const { connectionString } = database.pool.options;
    if (connectionString === undefined) throw new Error('the test pool has no connection string');
    const small = createPool({ connectionString, max: 2 });
    const tight = await buildAuthTestApp(small, {
      incomeExports: { maxRows: 50_000, maxBytes: 33_554_432, maxConcurrent: 2 },
    });
    tight.clock.set(TODAY);
    const teams = [await team(), await team({ name: 'B Club' })];
    for (const t of teams) await payment(t, { paidAt: nzNoon('2027-06-03') });
    await tight.app.listen({ port: 0, host: '127.0.0.1' });
    const { port } = tight.app.server.address() as AddressInfo;
    const lock = await holdPaymentsLock();
    try {
      const clients = teams.map((t) => {
        const client = httpRequest({
          host: '127.0.0.1',
          port,
          path: exportUrl(t.teamId, custom('2027-06-01', '2027-06-30')),
          headers: bearer(t.admin.token),
        });
        client.on('error', () => {
          // The socket is destroyed on purpose.
        });
        client.end();
        return client;
      });
      await waitForLockWaiters(database.pool, 2, 'both exports blocked on the payments lock');
      for (const client of clients) client.destroy();
      // Both statements are cancelled while the lock is still held, so the pool's two connections come back.
      await waitFor(
        async () => ((await countLockWaiters(database.pool)) === 0 ? true : undefined),
        { label: 'both cancelled exports to stop waiting', timeoutMs: 10_000 },
      );
      await waitFor(
        () =>
          Promise.resolve(
            teams.every((t) =>
              tight.logs
                .lines()
                .some(
                  (line) => line.event === 'income_export.cancelled' && line.teamId === t.teamId,
                ),
            )
              ? true
              : undefined,
          ),
        { label: 'income_export.cancelled for both teams', timeoutMs: 10_000 },
      );
    } finally {
      await lock.release();
    }
    try {
      // The pool and both slots are free again.
      for (const t of teams) {
        const res = await tight.app.inject({
          method: 'GET',
          url: exportUrl(t.teamId, custom('2027-06-01', '2027-06-30')),
          headers: bearer(t.admin.token),
        });
        expect(res.statusCode).toBe(200);
      }
    } finally {
      await tight.close();
      await small.end();
    }
  });
});
