/**
 * The invoice journey in a real browser (tax-invoices-and-exports Phase 5; AC-INTEGRATION-2, AC-VERIFY-8): a player pays a
 * payment on the FAKE Akahu adapter, downloads the tax invoice (a real PDF), the team admin downloads the same document from the
 * payments table and then exports the income as CSV and XLSX, on a desktop and a 360 x 740 project, with axe, no horizontal
 * scroll and 44 px targets. Nothing calls Akahu and no credentials are involved. Not part of `pnpm run ci`.
 *
 * It needs the worker running. The team is set up through the public API (banking, GST registration, a
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

test('a player pays, downloads the tax invoice, and the team admin downloads it and exports the income (AC-INTEGRATION-2, AC-VERIFY-8)', async ({
  browser,
}) => {
  test.setTimeout(300_000);
  const scene = await newScene();
  const payer = await newMember(scene, 'payer');
  const session = await publishSession(scene, '10.00');
  await api('POST', `/teams/${scene.teamId}/sessions/${session.id}/registrations`, payer.token, {
    guests: [],
  });
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

  // The player pays through the fake Akahu and lands back on a paid payment.
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
  expect(mine.bytes.subarray(0, 5).toString('latin1')).toBe('%PDF-');
  expect(mine.bytes.length).toBeGreaterThan(2_000);
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

  // The team admin finds the same document in the payments table and the exports area.
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
  await adminPage.getByRole('radio', { name: 'Financial year' }).check();
  await adminPage.getByRole('radio', { name: 'CSV (.csv)' }).check();
  const csv = await downloadFile(adminPage, () =>
    adminPage.getByRole('button', { name: 'Download' }).click(),
  );
  expect(csv.name).toMatch(/\.csv$/);
  const csvText = csv.bytes.toString('utf8');
  expect(csvText.charCodeAt(0)).toBe(0xfeff);
  expect(csvText).toMatch(/INV-\d{6}/);
  expect(csvText).toContain('10.00');

  await adminPage.getByRole('radio', { name: /Excel/ }).check();
  const xlsx = await downloadFile(adminPage, () =>
    adminPage.getByRole('button', { name: 'Download' }).click(),
  );
  expect(xlsx.name).toMatch(/\.xlsx$/);
  expect(xlsx.bytes.subarray(0, 2).toString('latin1')).toBe('PK');
  await adminPage.context().close();
});
