/**
 * The invoice journey in a real browser (tax-invoices-and-exports Phase 5; AC-INTEGRATION-2, AC-VERIFY-8): a player pays a
 * payment on the FAKE Akahu adapter, downloads the tax invoice (a real PDF), the team admin downloads the same document from the
 * payments table and then exports the income as CSV and XLSX, on a desktop and a 360 x 740 project, with axe, no horizontal
 * scroll and 44 px targets. Nothing calls Akahu and no credentials are involved. Not part of `pnpm run ci`.
 *
 * Two players are billed: one pays on the fake Akahu, one from a funded wallet. It needs the worker running. The team is set up through the public API (banking, GST registration, a
 * published session, a registration); the only fixtures are the named ones borrowed from `billing.spec.ts` (`endSession`, the
 * `post-game-billing` sweep trigger). Point it at a stack with the E2E_* variables (see docs/getting-started.md):
 *
 *   E2E_API_URL, E2E_DATABASE_URL, E2E_WORKER_CONTAINER, WEB_BASE_URL
 */
import { execFile } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Browser, type Page } from '@playwright/test';

const run = promisify(execFile);

const PASSWORD = 'kowhai-court-27';
const API_URL = process.env.E2E_API_URL ?? 'http://localhost:4000';
const DATABASE_URL = process.env.E2E_DATABASE_URL ?? 'postgres://sgm:sgm@localhost:5432/sgm';
const WORKER_CONTAINER = process.env.E2E_WORKER_CONTAINER ?? 'sgm-worker-1';
const ACCOUNT_NUMBER = '01-0902-0068389-00';
/** A valid IRD number (it passes the check-digit rules the API applies). */
const GST_NUMBER = '049-091-850';

let counter = 0;
function unique(tag: string): string {
  counter += 1;
  return `${tag}-${Date.now().toString(36)}${counter}${randomBytes(2).toString('hex')}`;
}

async function scan(page: Page, label: string): Promise<void> {
  const results = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'])
    .analyze();
  const blocking = results.violations
    .filter((violation) => violation.impact === 'critical' || violation.impact === 'serious')
    .map((violation) => `${violation.id} (${violation.impact ?? ''}): ${violation.help}`);
  expect(results.passes.length, `axe ran its rules on ${label}`).toBeGreaterThan(10);
  expect(blocking, `axe critical or serious violations on ${label}`).toEqual([]);
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(overflow, `${label}: horizontal overflow`).toBeLessThanOrEqual(0);
  const short = await page.evaluate(() =>
    [...document.querySelectorAll('main button, main a[href], main select, main input')]
      .filter((target) => (target as HTMLInputElement).type !== 'radio')
      .map((target) => ({ target, box: target.getBoundingClientRect() }))
      .filter(({ box }) => box.width > 0 && box.height > 0 && box.height < 43.5)
      .map(({ target, box }) => `${target.tagName.toLowerCase()} is ${Math.round(box.height)}px`),
  );
  expect(short, `${label}: targets under 44 px`).toEqual([]);
}

function nzToday(): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Pacific/Auckland',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date());
}

function addDays(ymd: string, days: number): string {
  const [y, m, d] = ymd.split('-').map(Number) as [number, number, number];
  return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10);
}

interface Person {
  readonly fullName: string;
  readonly email: string;
  readonly userId: string;
  readonly token: string;
}

async function api<T>(
  method: 'GET' | 'POST' | 'PUT',
  path: string,
  token: string | null,
  body?: unknown,
  expected: readonly number[] = [200, 201],
): Promise<T> {
  const response = await fetch(`${API_URL}${path}`, {
    method,
    headers: {
      'content-type': 'application/json',
      ...(token === null ? {} : { authorization: `Bearer ${token}` }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await response.text();
  if (!expected.includes(response.status)) {
    throw new Error(`${method} ${path} answered ${response.status}: ${text}`);
  }
  return (text === '' ? undefined : JSON.parse(text)) as T;
}

async function newPerson(tag: string): Promise<Person> {
  const fullName = `E2E ${tag} ${unique('p')}`;
  const email = `e2e-${unique(tag)}@example.test`;
  const result = await api<{ user: { id: string }; session: { token: string } }>(
    'POST',
    '/auth/register',
    null,
    { fullName, email, password: PASSWORD, sex: 'FEMALE' },
  );
  return { fullName, email, userId: result.user.id, token: result.session.token };
}

interface Scene {
  readonly admin: Person;
  readonly teamId: string;
  readonly teamName: string;
}

/** A fresh GST-registered team (so its documents are tax invoices) with banking saved. */
async function newScene(): Promise<Scene> {
  const admin = await newPerson('admin');
  const teamName = `E2E Invoices ${unique('t')}`;
  const created = await api<{ team: { id: string } }>('POST', '/teams', admin.token, {
    name: teamName,
    description: '',
    visibility: 'PUBLIC',
    skillLevel: 'INTERMEDIATE',
    idempotencyKey: randomUUID(),
  });
  await api('PUT', `/teams/${created.team.id}/banking`, admin.token, {
    accountName: 'Rosedale Badminton Club',
    accountNumber: ACCOUNT_NUMBER,
    changeKey: randomUUID(),
  });
  await api('PUT', `/teams/${created.team.id}/gst`, admin.token, {
    gstRegistered: true,
    gstNumber: GST_NUMBER,
    changeKey: randomUUID(),
  });
  return { admin, teamId: created.team.id, teamName };
}

async function newMember(scene: Scene, tag: string): Promise<Person> {
  const person = await newPerson(tag);
  await api('POST', `/teams/${scene.teamId}/join-requests`, person.token, {
    skillLevel: 'INTERMEDIATE',
  });
  await api(
    'POST',
    `/teams/${scene.teamId}/members/${person.userId}/approve`,
    scene.admin.token,
    {},
    [200],
  );
  return person;
}

interface PublishedSession {
  readonly id: string;
  readonly location: string;
}

async function publishSession(scene: Scene, rate: string): Promise<PublishedSession> {
  const location = `Invoice Hall ${unique('l')}`;
  const created = await api<{ session: { id: string; version: number } }>(
    'POST',
    `/teams/${scene.teamId}/sessions`,
    scene.admin.token,
    {
      createKey: randomUUID(),
      date: addDays(nzToday(), 3),
      location,
      address: '12B John Glenn Avenue, Rosedale, Auckland 0632',
      maxPlayers: 6,
      reservedSeats: 0,
      courtCost: '60.00',
      extraExpenses: '0.00',
      pricingStructure: 'FLAT',
      customPlayerRate: rate,
      cancellationDeadline: null,
      courts: [{ identifier: 'Court 1', startTime: '19:00', endTime: '21:00' }],
    },
  );
  await api(
    'POST',
    `/teams/${scene.teamId}/sessions/${created.session.id}/publish`,
    scene.admin.token,
    { expectedVersion: created.session.version },
  );
  return { id: created.session.id, location };
}

interface DbClient {
  connect(): Promise<void>;
  query(text: string, values?: unknown[]): Promise<{ rows: Record<string, unknown>[] }>;
  end(): Promise<void>;
}

async function withDb<T>(runQuery: (db: DbClient) => Promise<T>): Promise<T> {
  const load = createRequire(new URL('../../api/package.json', import.meta.url));
  const { Client } = load('pg') as {
    Client: new (config: { connectionString: string }) => DbClient;
  };
  const db = new Client({ connectionString: DATABASE_URL });
  await db.connect();
  try {
    return await runQuery(db);
  } finally {
    await db.end();
  }
}

/** The session "ends": its date moves to yesterday (the sessions API refuses a past date; the sweep bills only ended sessions). */
async function endSession(session: PublishedSession): Promise<void> {
  await withDb((db) =>
    db.query('UPDATE game_sessions SET date = $2::date WHERE id = $1', [
      session.id,
      addDays(nzToday(), -1),
    ]),
  );
}

async function waitForPaymentId(scene: Scene, person: Person, session: PublishedSession) {
  let id = '';
  await expect
    .poll(
      async () => {
        const list = await api<{ payments: { id: string; location: string }[] }>(
          'GET',
          `/teams/${scene.teamId}/payments/me`,
          person.token,
        );
        id = list.payments.find((row) => row.location === session.location)?.id ?? '';
        return id !== '';
      },
      { timeout: 60_000, intervals: [500, 1000, 1000], message: `payment for ${session.location}` },
    )
    .toBe(true);
  return id;
}

async function personPage(browser: Browser): Promise<Page> {
  const { baseURL, viewport, isMobile, hasTouch, deviceScaleFactor, userAgent } =
    test.info().project.use;
  const context = await browser.newContext({
    ...(baseURL === undefined ? {} : { baseURL }),
    ...(viewport === undefined ? {} : { viewport }),
    ...(isMobile === undefined ? {} : { isMobile }),
    ...(hasTouch === undefined ? {} : { hasTouch }),
    ...(deviceScaleFactor === undefined ? {} : { deviceScaleFactor }),
    ...(userAgent === undefined ? {} : { userAgent }),
  });
  const page = await context.newPage();
  page.setDefaultTimeout(30_000);
  page.setDefaultNavigationTimeout(30_000);
  return page;
}

async function signedIn(browser: Browser, person: Person): Promise<Page> {
  const page = await personPage(browser);
  await page.goto('/login');
  await page.getByLabel('Email').fill(person.email);
  await page.getByLabel('Password', { exact: true }).fill(PASSWORD);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await page.waitForURL((url) => !url.pathname.startsWith('/login'));
  return page;
}

/** Clicks a download control, returns the saved file's name and bytes. */
async function downloadFile(
  page: Page,
  click: () => Promise<void>,
): Promise<{ name: string; bytes: Buffer }> {
  const downloading = page.waitForEvent('download');
  await click();
  const download = await downloading;
  const path = await download.path();
  const file = { name: download.suggestedFilename(), bytes: await readFile(path) };
  // AC-VERIFY-9: with E2E_SPECIMEN_DIR set, the files this run produced are kept as the accountant's specimens (desktop run only).
  const specimens = process.env.E2E_SPECIMEN_DIR;
  if (specimens !== undefined && specimens !== '' && test.info().project.name === 'desktop') {
    await mkdir(specimens, { recursive: true });
    await writeFile(join(specimens, `e2e-${file.name.replace(/[^a-z0-9._-]/gi, '_')}`), file.bytes);
  }
  return file;
}

/** `fundWallet` as in billing.spec.ts: a top-up on the fake adapter, polled until the balance shows it. */
async function fundWallet(scene: Scene, person: Person, amount: string): Promise<void> {
  const started = await api<{ topUp: { id: string } }>(
    'POST',
    `/teams/${scene.teamId}/wallet/top-ups`,
    person.token,
    { amount, idempotencyKey: randomUUID() },
  );
  await expect
    .poll(
      async () =>
        (
          await api<{ wallet: { balance: string } }>(
            'GET',
            `/teams/${scene.teamId}/wallet?topUp=${started.topUp.id}`,
            person.token,
          )
        ).wallet.balance,
      { timeout: 45_000, intervals: [500, 1000, 1000], message: `wallet funded with ${amount}` },
    )
    .toBe(amount);
}

// The PDF and XLSX readers are the API package's own dependencies (unpdf, read-excel-file); the web package does not install them.
const apiRequire = createRequire(new URL('../../api/package.json', import.meta.url));

/** A PDF's text, whitespace collapsed to single spaces. */
async function pdfText(bytes: Buffer): Promise<string> {
  const lib = (await import(pathToFileURL(apiRequire.resolve('unpdf')).href)) as {
    getDocumentProxy(data: Uint8Array): Promise<unknown>;
    extractText(pdf: unknown, options: { mergePages: true }): Promise<{ text: string }>;
  };
  const pdf = await lib.getDocumentProxy(new Uint8Array(bytes));
  return (await lib.extractText(pdf, { mergePages: true })).text.replace(/\s+/g, ' ').trim();
}

const compact = (text: string): string => text.replace(/\s+/g, '');
const cents = (money: string): number => Number(money.replace(/[$,]/g, '').replace('.', ''));

interface InvoiceRead {
  readonly number: number;
  readonly total: number;
  readonly gst: number;
}

/** The invoice PDF shows the team, the buyer, the number, the GST number, GST and total (AC-INTEGRATION-2). */
async function expectInvoicePdf(bytes: Buffer, scene: Scene, buyer: Person): Promise<InvoiceRead> {
  expect(bytes.subarray(0, 5).toString('latin1')).toBe('%PDF-');
  const text = await pdfText(bytes);
  expect(text).toContain('Tax invoice');
  expect(compact(text)).toContain(compact(scene.teamName));
  expect(compact(text)).toContain(compact(buyer.fullName));
  expect(text).toContain('GST number 49-091-850');
  const number = /INV-(\d{6})/.exec(text);
  expect(number, 'the invoice number is printed').not.toBeNull();
  const gst = /GST \(15%\) \$([\d,.]+)/.exec(text);
  const total = /Total \(including GST\) \$([\d,.]+)/.exec(text);
  expect(gst?.[1], 'GST 10.00 x 3/23').toBe('1.30');
  expect(total?.[1]).toBe('10.00');
  expect(text).toContain('$8.70');
  return {
    number: Number(number?.[1]),
    gst: cents(gst?.[1] ?? ''),
    total: cents(total?.[1] ?? ''),
  };
}

/** RFC 4180 reader for the export CSV (a BOM, CRLF line ends, quoted fields). */
function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  const body = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  for (let at = 0; at < body.length; at += 1) {
    const c = body[at] as string;
    if (quoted) {
      if (c === '"' && body[at + 1] === '"') {
        field += '"';
        at += 1;
      } else if (c === '"') quoted = false;
      else field += c;
    } else if (c === '"') quoted = true;
    else if (c === ',') {
      row.push(field);
      field = '';
    } else if (c === '\r' || c === '\n') {
      if (c === '\r' && body[at + 1] === '\n') at += 1;
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else field += c;
  }
  if (field !== '' || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

async function readXlsx(bytes: Buffer): Promise<string[][]> {
  const lib = apiRequire('read-excel-file/node') as {
    default(
      input: Buffer,
      options: { parseNumber: (value: string) => string },
    ): Promise<{ sheet: string; data: (string | null)[][] }[]>;
  };
  const sheets = await lib.default(bytes, { parseNumber: (value) => value });
  expect(sheets.map((sheet) => sheet.sheet)).toEqual(['Payments', 'Summary']);
  return (sheets[0]?.data ?? []).map((row) => row.map((cell) => cell ?? ''));
}

/** The Payments table holds exactly the two payments, and its totals equal the two invoices' totals. */
function expectPaymentsTable(
  table: string[][],
  invoices: readonly InvoiceRead[],
  label: string,
): void {
  const header = table[0] ?? [];
  const col = (name: string): number => header.indexOf(name);
  expect(header.slice(0, 1), label).toEqual(['Invoice number']);
  const data = table.slice(1);
  expect(data, `${label}: both payments and nothing else`).toHaveLength(2);
  expect(data.map((row) => row[col('Invoice number')]).sort(), label).toEqual(
    invoices.map((invoice) => `INV-${String(invoice.number).padStart(6, '0')}`).sort(),
  );
  const sum = (name: string): number =>
    data.reduce((acc, row) => acc + cents(row[col(name)] ?? '0'), 0);
  expect(sum('Total'), `${label}: export total equals the invoices' totals`).toBe(
    invoices.reduce((acc, invoice) => acc + invoice.total, 0),
  );
  expect(sum('GST'), `${label}: export GST equals the invoices' GST`).toBe(
    invoices.reduce((acc, invoice) => acc + invoice.gst, 0),
  );
  expect(data.map((row) => row[col('Paid by')]).sort(), label).toEqual(['Bank', 'Wallet']);
}

test('a player pays and another is billed from a wallet, both download their invoice, and the team admin exports the income (AC-INTEGRATION-2, AC-VERIFY-8)', async ({
  browser,
}) => {
  test.setTimeout(360_000);
  const scene = await newScene();
  const payer = await newMember(scene, 'payer');
  const walletPayer = await newMember(scene, 'wallet');
  await fundWallet(scene, walletPayer, '20.00');
  const session = await publishSession(scene, '10.00');
  for (const person of [payer, walletPayer]) {
    await api('POST', `/teams/${scene.teamId}/sessions/${session.id}/registrations`, person.token, {
      guests: [],
    });
  }
  await endSession(session);
  await run('docker', [
    'exec',
    WORKER_CONTAINER,
    'node',
    'dist/cli.js',
    'jobs',
    'trigger',
    'post-game-billing',
  ]);
  const paymentId = await waitForPaymentId(scene, payer, session);
  const walletPaymentId = await waitForPaymentId(scene, walletPayer, session);

  // The first player pays through the fake Akahu and lands back on a paid payment.
  const page = await signedIn(browser, payer);
  await page.goto(`/payments/${paymentId}`);
  await page.getByRole('button', { name: 'Pay $10.00 with Akahu' }).click();
  await expect(page.locator('main').getByText(/^Paid on /)).toBeVisible({ timeout: 45_000 });

  // The invoice becomes available (issued by the job, or on demand by the download itself).
  const invoiceLink = page.getByRole('link', { name: /^Download tax invoice/ });
  await expect(invoiceLink).toBeVisible({ timeout: 45_000 });
  await scan(page, 'payment, paid, invoice available');
  const mine = await downloadFile(page, () => invoiceLink.click());
  expect(mine.name).toMatch(/\.pdf$/);
  expect(mine.bytes.length).toBeGreaterThan(2_000);
  const myInvoice = await expectInvoicePdf(mine.bytes, scene, payer);
  await expect(page).toHaveURL(new RegExp(`/payments/${paymentId}(\\?return=1)?$`));
  await page.reload(); // the number is read on the next view of the page
  await expect(page.locator('main').getByText(/INV-\d{6}/)).toBeVisible();
  // The wallet page's paid list and the payments list carry the same action (AC-VERIFY-8).
  await page.goto(`/teams/${scene.teamId}/wallet`);
  await expect(page.getByRole('link', { name: /^Download tax invoice/ }).first()).toBeVisible();
  await scan(page, 'wallet, paid list with invoice action');
  await page.goto('/payments');
  await scan(page, 'payments list with invoice action');
  await page.context().close();

  // The second player was billed from their wallet and downloads their own invoice.
  const walletPage = await signedIn(browser, walletPayer);
  await walletPage.goto(`/payments/${walletPaymentId}`);
  await expect(walletPage.locator('main').getByText('Paid from wallet')).toBeVisible({
    timeout: 45_000,
  });
  const walletLink = walletPage.getByRole('link', { name: /^Download tax invoice/ });
  await expect(walletLink).toBeVisible({ timeout: 45_000 });
  await scan(walletPage, 'payment, paid from the wallet, invoice available');
  const theirOwn = await downloadFile(walletPage, () => walletLink.click());
  expect(theirOwn.name).toMatch(/\.pdf$/);
  const walletInvoice = await expectInvoicePdf(theirOwn.bytes, scene, walletPayer);
  await walletPage.context().close();

  // Two payments, two numbers: consecutive, in the one series.
  expect(
    Math.abs(myInvoice.number - walletInvoice.number),
    'the two invoice numbers are consecutive',
  ).toBe(1);
  const invoices = [myInvoice, walletInvoice];

  // The team admin finds the same documents in the payments table and the exports area.
  const adminPage = await signedIn(browser, scene.admin);
  await adminPage.goto(`/teams/${scene.teamId}/manage/payments?status=paid`);
  const adminLink = adminPage.getByRole('link', { name: /^Invoice for / }).first();
  await expect(adminLink).toBeVisible();
  await scan(adminPage, 'admin payments with the invoice action');
  const theirs = await downloadFile(adminPage, () => adminLink.click());
  expect(theirs.bytes.subarray(0, 5).toString('latin1')).toBe('%PDF-');
  expect(theirs.bytes.length).toBeGreaterThan(2_000);

  await adminPage.goto(`/teams/${scene.teamId}/manage/exports`);
  await scan(adminPage, 'income exports');
  const today = nzToday();
  const monthStart = `${today.slice(0, 8)}01`;
  const periods = [
    {
      label: 'current month (custom range)',
      choose: async (): Promise<void> => {
        await adminPage.getByRole('radio', { name: 'Custom range' }).check();
        await adminPage.getByLabel('Start date').fill(monthStart);
        await adminPage.getByLabel('End date').fill(today);
      },
    },
    {
      label: 'financial year',
      choose: async (): Promise<void> => {
        await adminPage.getByRole('radio', { name: 'Financial year' }).check();
      },
    },
  ];
  for (const period of periods) {
    await period.choose();
    await adminPage.getByRole('radio', { name: 'CSV (.csv)' }).check();
    const csv = await downloadFile(adminPage, () =>
      adminPage.getByRole('button', { name: 'Download' }).click(),
    );
    expect(csv.name).toMatch(/\.csv$/);
    expect(csv.bytes.toString('utf8').charCodeAt(0)).toBe(0xfeff);
    const csvTable = parseCsv(csv.bytes.toString('utf8'));
    expectPaymentsTable(csvTable, invoices, `CSV, ${period.label}`);

    await adminPage.getByRole('radio', { name: /Excel/ }).check();
    const xlsx = await downloadFile(adminPage, () =>
      adminPage.getByRole('button', { name: 'Download' }).click(),
    );
    expect(xlsx.name).toMatch(/\.xlsx$/);
    expect(xlsx.bytes.subarray(0, 2).toString('latin1')).toBe('PK');
    const xlsxTable = await readXlsx(xlsx.bytes);
    expectPaymentsTable(xlsxTable, invoices, `XLSX, ${period.label}`);
    expect(xlsxTable, `${period.label}: the Excel file equals the CSV`).toEqual(csvTable);
  }
  await adminPage.context().close();
});
