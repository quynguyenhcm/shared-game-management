/**
 * The money journeys in a real browser (AC-INTEGRATION-4) with axe scans, no horizontal scroll, 44 px targets and the field
 * and status-tag checks (AC-VERIFY-9), run on a desktop and a 360 x 740 project against the Compose stack with the worker
 * running and Mailpit. The stack uses the FAKE Akahu adapter (`PAYMENTS_ADAPTER=fake`, the default outside production): nothing
 * here calls Akahu and no credentials are involved. Not part of `pnpm run ci`.
 *
 *   AUTH_FAKE_OAUTH=true docker compose up -d --build --wait && pnpm run test:e2e apps/web/e2e/billing.spec.ts
 *
 * How the fake adapter is driven (apps/api/src/lib/akahu/fake-adapter.ts). It is stateless and id-encoded, so the outcome of a
 * payment is chosen by its AMOUNT, exactly like Akahu's Demo Bank, and there is no scripting hook across processes:
 *   any other amount -> approved instantly (SENT) ........ the journey completes
 *   $5.03 / $5.04    -> BANK_ERROR / BANK_ERROR_INDETERMINATE (the second is the "under review" hold)
 *   $5.15            -> REJECTED (declined, nothing charged)
 *   $5.20            -> SUBMITTED forever (processing)
 * The payer's return to the site enqueues an `akahu-sync` job that the worker runs; the page refreshes itself until it lands.
 *
 * Nothing the app can create is seeded (R27): users, teams, banking, memberships, sessions, registrations, top-ups, payments,
 * reminders and the payout block all go through the public API or the browser. Three things only the passing of time can do are
 * done with the smallest honest fixture, each named where it is used:
 *   - `endSession`: moves a published session's date to yesterday (the database derives `ends_at`), because the sessions API
 *     refuses a past date and the worker's sweep only bills ended sessions;
 *   - `makeDue`: moves one PENDING payment's `due_date` to three days ago (CR-27 lets a due date move), because `daily-overdue`
 *     reads the real clock;
 *   - `triggerJob` / `makeGlobalAdmin`: run the stack's own CLI (`jobs trigger`, `users set-role`) inside the Compose containers
 *     (`E2E_WORKER_CONTAINER`, `E2E_API_CONTAINER`) instead of waiting for the 5-minute sweep or the 04:00 schedule.
 */
import { execFile } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { promisify } from 'node:util';
import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Browser, type Locator, type Page } from '@playwright/test';

const run = promisify(execFile);

const PASSWORD = 'kowhai-court-27';
const API_URL = process.env.E2E_API_URL ?? 'http://localhost:4000';
const DATABASE_URL = process.env.E2E_DATABASE_URL ?? 'postgres://sgm:sgm@localhost:5432/sgm';
const MAILPIT_API_URL = process.env.MAILPIT_API_URL ?? 'http://localhost:8025';
const WORKER_CONTAINER = process.env.E2E_WORKER_CONTAINER ?? 'sgm-worker-1';
const API_CONTAINER = process.env.E2E_API_CONTAINER ?? 'sgm-api-1';
const ACCOUNT_NUMBER = '01-0902-0068389-00';

// ---------------------------------------------------------------------------------------------
// Helpers: scans
// ---------------------------------------------------------------------------------------------

let counter = 0;
function unique(tag: string): string {
  counter += 1;
  return `${tag}-${Date.now().toString(36)}${counter}${randomBytes(2).toString('hex')}`;
}

/** AC-VERIFY-9: no axe violation of impact critical or serious, no horizontal scroll, every target at least 44 px. */
async function scan(page: Page, label: string): Promise<void> {
  const results = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'])
    .analyze();
  const blocking = results.violations
    .filter((violation) => violation.impact === 'critical' || violation.impact === 'serious')
    .map(
      (violation) =>
        `${violation.id} (${violation.impact ?? ''}): ${violation.help} -> ${violation.nodes
          .slice(0, 3)
          .map((node) => node.target.join(' '))
          .join(' | ')}`,
    );
  expect(results.passes.length, `axe ran its rules on ${label}`).toBeGreaterThan(10);
  expect(blocking, `axe critical or serious violations on ${label}`).toEqual([]);
  await expectNoHorizontalScroll(page, label);
  await expectTapTargets(page, label);
  await expectNoColourOnlyStatus(page, label);
}

/** Buttons, links, radio rows and text fields in the page content are at least 44 px high (AC-VERIFY-9). */
async function expectTapTargets(page: Page, label: string): Promise<void> {
  const short = await page.evaluate(() => {
    const found: string[] = [];
    const targets = document.querySelectorAll(
      'main button, main a[href], main label:has(input[type=radio]), main input[type=text]',
    );
    for (const target of targets) {
      const box = target.getBoundingClientRect();
      if (box.width === 0 || box.height === 0) continue;
      // Height for every target; width too for buttons (a link may be a short inline word).
      const narrow = target.tagName === 'BUTTON' && box.width < 43.5;
      if (box.height < 43.5 || narrow) {
        found.push(
          `${target.tagName.toLowerCase()} "${(target.textContent ?? '').trim().slice(0, 30)}" is ${Math.round(box.width)} x ${Math.round(box.height)} px`,
        );
      }
    }
    return found;
  });
  expect(short, `${label}: targets under 44 px`).toEqual([]);
}

/** No horizontal page scroll at the current viewport (AC-VERIFY-9). */
async function expectNoHorizontalScroll(page: Page, label: string): Promise<void> {
  const overflow = await page.evaluate(() => ({
    scroll: document.documentElement.scrollWidth,
    client: document.documentElement.clientWidth,
  }));
  expect(
    overflow.scroll,
    `${label}: scrollWidth ${overflow.scroll} must not exceed clientWidth ${overflow.client}`,
  ).toBeLessThanOrEqual(overflow.client);
}

/** A status tag always carries its state as words (AC-VERIFY-9): a bordered tag with no text would be colour only. */
async function expectNoColourOnlyStatus(page: Page, label: string): Promise<void> {
  const empty = await page.evaluate(() =>
    [
      ...document.querySelectorAll(
        'main [class*="border-green-800"], main [class*="border-red-800"]',
      ),
    ]
      .filter((tag) => (tag.textContent ?? '').trim().length === 0)
      .map((tag) => tag.outerHTML.slice(0, 80)),
  );
  expect(empty, `${label}: status tags without text`).toEqual([]);
}

/** The top-up field has a visible label and, after an error, `aria-invalid` plus an `aria-describedby` that names the message. */
async function expectFieldError(input: Locator, message: RegExp): Promise<void> {
  await expect(input).toHaveAttribute('aria-invalid', 'true');
  const texts = await input.evaluate((element) =>
    (element.getAttribute('aria-describedby') ?? '')
      .split(' ')
      .filter((id) => id !== '')
      .map((id) => document.getElementById(id)?.textContent ?? ''),
  );
  expect(texts.join(' '), 'aria-describedby text of the field').toMatch(message);
}

// ---------------------------------------------------------------------------------------------
// Helpers: dates and the API
// ---------------------------------------------------------------------------------------------

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

/** A fresh team with its own admin and saved banking (a paid session cannot be published without it). */
async function newScene(): Promise<Scene> {
  const admin = await newPerson('admin');
  const teamName = `E2E Billing ${unique('t')}`;
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
  return { admin, teamId: created.team.id, teamName };
}

/** A person who requested to join and was approved by the admin. */
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

/** A PUBLISHED one-off FLAT session charging `rate` per player, created and published through the admin API. */
async function publishSession(scene: Scene, rate: string): Promise<PublishedSession> {
  const location = `Billing Hall ${unique('l')}`;
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

async function register(scene: Scene, session: PublishedSession, person: Person): Promise<void> {
  await api('POST', `/teams/${scene.teamId}/sessions/${session.id}/registrations`, person.token, {
    guests: [],
  });
}

interface WalletRead {
  readonly wallet: { readonly balance: string };
}

async function balanceOf(scene: Scene, person: Person): Promise<string> {
  const read = await api<WalletRead>('GET', `/teams/${scene.teamId}/wallet`, person.token);
  return read.wallet.balance;
}

/** Tops the wallet up through the API (the page journey is its own test); reading it with `topUp` asks for the Akahu re-read. */
async function fundWallet(scene: Scene, person: Person, amount: string): Promise<void> {
  const started = await api<{ topUp: { id: string } }>(
    'POST',
    `/teams/${scene.teamId}/wallet/top-ups`,
    person.token,
    { amount, idempotencyKey: randomUUID() },
  );
  await expect
    .poll(
      async () => {
        const read = await api<WalletRead>(
          'GET',
          `/teams/${scene.teamId}/wallet?topUp=${started.topUp.id}`,
          person.token,
        );
        return read.wallet.balance;
      },
      { timeout: 45_000, intervals: [500, 1000, 1000], message: `wallet funded with ${amount}` },
    )
    .toBe(amount);
}

interface PaymentRow {
  readonly id: string;
  readonly status: string;
  readonly location: string;
  readonly onHold: boolean;
}

async function paymentFor(
  scene: Scene,
  person: Person,
  session: PublishedSession,
): Promise<PaymentRow | null> {
  const list = await api<{ payments: PaymentRow[] }>(
    'GET',
    `/teams/${scene.teamId}/payments/me`,
    person.token,
  );
  return list.payments.find((row) => row.location === session.location) ?? null;
}

/** Waits for the worker to bill the session and returns the player's payment. */
async function waitForPayment(
  scene: Scene,
  person: Person,
  session: PublishedSession,
  status?: string,
): Promise<PaymentRow> {
  let found: PaymentRow | null = null;
  await expect
    .poll(
      async () => {
        found = await paymentFor(scene, person, session);
        return found !== null && (status === undefined || found.status === status);
      },
      { timeout: 60_000, intervals: [500, 1000, 1000], message: `payment for ${session.location}` },
    )
    .toBe(true);
  if (found === null) throw new Error('payment not found');
  return found;
}

// ---------------------------------------------------------------------------------------------
// Helpers: time, jobs and roles (the three named fixtures)
// ---------------------------------------------------------------------------------------------

interface DbClient {
  connect(): Promise<void>;
  query(text: string, values?: unknown[]): Promise<{ rows: Record<string, unknown>[] }>;
  end(): Promise<void>;
}

/** `pg` belongs to the API workspace, so it is resolved from there. */
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

/** The session "ends": its date moves to yesterday and the database derives `starts_at` and `ends_at` from its courts. */
async function endSession(session: PublishedSession): Promise<void> {
  await withDb((db) =>
    db.query('UPDATE game_sessions SET date = $2::date WHERE id = $1', [
      session.id,
      addDays(nzToday(), -1),
    ]),
  );
}

/** The payment's due date passes (three days ago); `daily-overdue` then flips it. */
async function makeDue(paymentId: string): Promise<void> {
  await withDb((db) =>
    db.query(
      `UPDATE payments SET due_date = now() - interval '3 days' WHERE id = $1 AND status = 'PENDING'`,
      [paymentId],
    ),
  );
}

/** Runs the stack's own `jobs trigger` CLI in the worker container (instead of waiting for the sweep or the schedule). */
async function triggerJob(name: 'post-game-billing' | 'daily-overdue'): Promise<void> {
  await run('docker', ['exec', WORKER_CONTAINER, 'node', 'dist/cli.js', 'jobs', 'trigger', name]);
}

/** Grants the global admin role through the stack's own CLI. */
async function makeGlobalAdmin(person: Person): Promise<void> {
  await run('docker', [
    'exec',
    API_CONTAINER,
    'node',
    'dist/cli.js',
    'users',
    'set-role',
    person.email,
    'GLOBAL_ADMIN',
  ]);
}

/** Ends the sessions, runs the sweep and waits until each player has a payment (any status). */
async function billSessions(
  scene: Scene,
  entries: readonly { person: Person; session: PublishedSession }[],
): Promise<Record<string, PaymentRow>> {
  for (const entry of entries) await endSession(entry.session);
  await triggerJob('post-game-billing');
  const rows: Record<string, PaymentRow> = {};
  for (const entry of entries) {
    rows[entry.session.id] = await waitForPayment(scene, entry.person, entry.session);
  }
  return rows;
}

// ---------------------------------------------------------------------------------------------
// Helpers: Mailpit
// ---------------------------------------------------------------------------------------------

/** Polls Mailpit until a message to `to` whose subject starts with `subjectStart` arrives; returns its text body. */
async function waitForEmailText(to: string, subjectStart: string): Promise<string> {
  let text = '';
  await expect
    .poll(
      async () => {
        const search = await fetch(
          `${MAILPIT_API_URL}/api/v1/search?query=${encodeURIComponent(`to:${to}`)}`,
        );
        const body = (await search.json()) as { messages?: { ID: string; Subject: string }[] };
        const hit = (body.messages ?? []).find((message) =>
          message.Subject.startsWith(subjectStart),
        );
        if (hit === undefined) return false;
        const full = await fetch(`${MAILPIT_API_URL}/api/v1/message/${hit.ID}`);
        text = ((await full.json()) as { Text?: string }).Text ?? '';
        return true;
      },
      {
        timeout: 60_000,
        intervals: [500, 1000, 1000],
        message: `email "${subjectStart}..." to ${to}`,
      },
    )
    .toBe(true);
  return text;
}

/** The `/payments/<id>` path in an email (the origin is the stack's own and is dropped, so the page opens on the test's base URL). */
function paymentPathIn(emailText: string): string {
  const match = /\/payments\/([0-9a-f-]{36})/.exec(emailText);
  if (match === null) throw new Error('no payment link in the email');
  return `/payments/${match[1] ?? ''}`;
}

// ---------------------------------------------------------------------------------------------
// Helpers: the browser
// ---------------------------------------------------------------------------------------------

const openedDialogs = new WeakMap<Page, string[]>();

/** A fresh browser context (one person) with the viewport and touch settings of the running project. */
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
  // No native browser dialog may ever open: confirmations are inline. Collected here, asserted in `closePerson`.
  const dialogs: string[] = [];
  openedDialogs.set(page, dialogs);
  page.on('dialog', (dialog) => {
    dialogs.push(`${dialog.type()}: ${dialog.message()}`);
    void dialog.dismiss();
  });
  return page;
}

/** Closes a person's context after asserting that no native dialog opened. */
async function closePerson(page: Page): Promise<void> {
  expect(openedDialogs.get(page) ?? [], 'native browser dialogs').toEqual([]);
  await page.context().close();
}

/** Signs in through the real `/login` form; every person goes through it, never a cookie or token injection. */
async function signIn(page: Page, person: Person): Promise<void> {
  await page.goto('/login');
  await page.getByLabel('Email').fill(person.email);
  await page.getByLabel('Password', { exact: true }).fill(PASSWORD);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await page.waitForURL((url) => !url.pathname.startsWith('/login'));
}

async function signedIn(browser: Browser, person: Person): Promise<Page> {
  const page = await personPage(browser);
  await signIn(page, person);
  return page;
}

const walletUrl = (scene: Scene): string => `/teams/${scene.teamId}/wallet`;
const main = (page: Page): Locator => page.locator('main');
const amountField = (page: Page): Locator => page.getByLabel('Top-up amount (NZD)');

/** Types an amount into the wallet form and submits it (the Server Action sends the browser to the fake Akahu and back). */
async function submitTopUp(page: Page, amount: string): Promise<void> {
  await amountField(page).fill(amount);
  await page.getByRole('button', { name: 'Top up with Akahu' }).click();
}

// ---------------------------------------------------------------------------------------------
// Journey 1: top up the wallet
// ---------------------------------------------------------------------------------------------

test.describe('wallet top-up', () => {
  test('a player tops up from the team page, sees the balance and the activity, and fills the wallet (AC-INTEGRATION-4, AC-VERIFY-9)', async ({
    browser,
  }) => {
    test.setTimeout(240_000);
    const scene = await newScene();
    const player = await newMember(scene, 'topup');
    const page = await signedIn(browser, player);

    // Entry: the team page's one-line wallet entry.
    await page.goto(`/teams/${scene.teamId}`);
    await page.getByRole('link', { name: /^Wallet/ }).click();
    await expect(page).toHaveURL(new RegExp(`/teams/${scene.teamId}/wallet`));
    await expect(page.getByText('Balance: $0.00')).toBeVisible();

    // The form state: a visible label, a hint, the trust lines. Then a validation error linked to the field.
    await expect(amountField(page)).toBeVisible();
    await expect(page.getByText(/Between \$1\.00 and \$100\.00/)).toBeVisible();
    await scan(page, 'wallet, empty form');
    await submitTopUp(page, '0.50');
    await expectFieldError(amountField(page), /\$1\.00|least/i);
    await expect(amountField(page)).toHaveValue('0.50');
    await scan(page, 'wallet, form with a field error');

    // Success: $20.00 is approved instantly by the fake adapter; the page refreshes itself until the balance lands.
    await submitTopUp(page, '20.00');
    await expect(page.getByText('Balance: $20.00')).toBeVisible({ timeout: 45_000 });
    await expect(main(page).getByText('Top-up').first()).toBeVisible();
    await scan(page, 'wallet, after a top-up');

    // Full: the cap is $100.00, so $80.00 more fills it and the form gives way to the "full" line.
    await submitTopUp(page, '80.00');
    await expect(page.getByText('Balance: $100.00')).toBeVisible({ timeout: 45_000 });
    await expect(page.getByText('Your wallet is full.')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Top up with Akahu' })).toHaveCount(0);
    await scan(page, 'wallet, full');
    await closePerson(page);
  });

  test('a top-up still with the bank is processing, a declined one says so, and an unclear one is held (AC-VERIFY-9)', async ({
    browser,
  }) => {
    test.setTimeout(240_000);
    const scene = await newScene();
    const slow = await newMember(scene, 'slow');
    const declined = await newMember(scene, 'declined');
    const held = await newMember(scene, 'held');

    // $5.20: Akahu's SUBMITTED for ever. Landing back shows the processing panel, then the plain wallet offers to continue.
    let page = await signedIn(browser, slow);
    await page.goto(walletUrl(scene));
    await submitTopUp(page, '5.20');
    await expect(page.getByText('Processing your top-up.', { exact: false })).toBeVisible();
    await scan(page, 'wallet, processing (returned from Akahu)');
    await page.goto(walletUrl(scene));
    await expect(page.getByText(/Top-up of \$5\.20 started/)).toBeVisible();
    await expect(page.getByRole('button', { name: 'Continue with Akahu' })).toBeVisible();
    await scan(page, 'wallet, processing (continue)');
    await closePerson(page);

    // $5.15: REJECTED. Nothing was charged, the form is back and a notice says so.
    page = await signedIn(browser, declined);
    await page.goto(walletUrl(scene));
    await submitTopUp(page, '5.15');
    await expect(
      page.getByText("Your top-up didn't go through. You haven't been charged."),
    ).toBeVisible({
      timeout: 45_000,
    });
    await expect(page.getByText('Balance: $0.00')).toBeVisible();
    await scan(page, 'wallet, declined');
    await closePerson(page);

    // $5.04: BANK_ERROR_INDETERMINATE. Nobody knows yet, so the wallet is held under review and says not to pay again.
    page = await signedIn(browser, held);
    await page.goto(walletUrl(scene));
    await submitTopUp(page, '5.04');
    await expect(page.getByText("We're checking your top-up with your bank.")).toBeVisible({
      timeout: 45_000,
    });
    await expect(page.getByRole('button', { name: 'Top up with Akahu' })).toHaveCount(0);
    await scan(page, 'wallet, held');
    await closePerson(page);
  });
});

// ---------------------------------------------------------------------------------------------
// Journey 2: the session ends and the fee comes out of the wallet
// ---------------------------------------------------------------------------------------------

test.describe('post-game billing', () => {
  test('the fee is deducted from a funded wallet when the session ends (AC-INTEGRATION-4)', async ({
    browser,
  }) => {
    test.setTimeout(240_000);
    const scene = await newScene();
    const player = await newMember(scene, 'funded');
    const session = await publishSession(scene, '10.00');
    await register(scene, session, player);
    await fundWallet(scene, player, '20.00');

    await billSessions(scene, [{ person: player, session }]);
    await expect
      .poll(() => balanceOf(scene, player), { timeout: 60_000, intervals: [500, 1000] })
      .toBe('10.00');
    const payment = await waitForPayment(scene, player, session, 'PAID');

    const page = await signedIn(browser, player);
    await page.goto(walletUrl(scene));
    await expect(page.getByText('Balance: $10.00')).toBeVisible();
    await expect(main(page).getByText(new RegExp(`Game fee, ${session.location}`))).toBeVisible();
    await expect(main(page).getByText('−$10.00')).toBeVisible();
    await scan(page, 'wallet, after a deduction');

    await page.goto(`/payments/${payment.id}`);
    await expect(main(page).getByText('Paid from wallet').first()).toBeVisible();
    await scan(page, 'payment, paid from wallet');

    await page.goto('/payments');
    await expect(page.getByText('You have no unpaid payments.')).toBeVisible();
    await scan(page, 'payments, none unpaid');
    await closePerson(page);
  });
});

// ---------------------------------------------------------------------------------------------
// Journey 3 and 4: a second player is billed, emailed, pays; another goes overdue
// ---------------------------------------------------------------------------------------------

test.describe('paying a payment', () => {
  test('a player with an empty wallet is billed, emailed, pays through the link and is thanked (AC-INTEGRATION-4)', async ({
    browser,
  }) => {
    test.setTimeout(240_000);
    const scene = await newScene();
    const funded = await newMember(scene, 'funded');
    const payer = await newMember(scene, 'payer');
    const session = await publishSession(scene, '10.00');
    await register(scene, session, funded);
    await register(scene, session, payer);
    await fundWallet(scene, funded, '20.00');

    await billSessions(scene, [{ person: payer, session }]);
    const pending = await waitForPayment(scene, payer, session, 'PENDING');
    // The funded player's fee came out of the wallet; the payer's did not (no credit), so it is a payment to pay.
    await expect
      .poll(() => balanceOf(scene, funded), { timeout: 60_000, intervals: [500, 1000] })
      .toBe('10.00');

    const emailText = await waitForEmailText(payer.email, 'Payment due:');
    const link = paymentPathIn(emailText);
    expect(link).toBe(`/payments/${pending.id}`);

    const page = await signedIn(browser, payer);
    await page.goto(link);
    await expect(page.getByRole('heading', { level: 1, name: /Payment for / })).toBeVisible();
    await expect(page.getByText(/Due \w{3} \d{1,2} \w{3}/).first()).toBeVisible();
    await scan(page, 'payment, pending');

    await page.goto('/payments');
    await expect(page.getByRole('heading', { level: 1, name: 'Your payments' })).toBeVisible();
    await expect(page.getByText(scene.teamName).first()).toBeVisible();
    await scan(page, 'payments, one unpaid');

    await page.goto(link);
    await page.getByRole('button', { name: 'Pay $10.00 with Akahu' }).click();
    // Back from the fake Akahu: the page refreshes itself until the worker has applied the result.
    await expect(main(page).getByText(/^Paid on /)).toBeVisible({ timeout: 45_000 });
    await expect(page.getByRole('button', { name: /Pay \$|Try again/ })).toHaveCount(0);
    await scan(page, 'payment, paid');
    await waitForEmailText(payer.email, 'Payment received:');
    await closePerson(page);
  });

  test('a payment that is not paid goes overdue and says so (AC-INTEGRATION-4)', async ({
    browser,
  }) => {
    test.setTimeout(240_000);
    const scene = await newScene();
    const debtor = await newMember(scene, 'debtor');
    const session = await publishSession(scene, '10.00');
    await register(scene, session, debtor);
    const rows = await billSessions(scene, [{ person: debtor, session }]);
    const pending = rows[session.id];
    if (pending === undefined) throw new Error('no payment');

    await makeDue(pending.id);
    await triggerJob('daily-overdue');
    await waitForPayment(scene, debtor, session, 'OVERDUE');
    await waitForEmailText(debtor.email, 'Overdue:');

    const page = await signedIn(browser, debtor);
    await page.goto(`/payments/${pending.id}`);
    await expect(
      main(page)
        .getByText(/Overdue since /)
        .first(),
    ).toBeVisible();
    await expect(page.getByRole('button', { name: 'Pay $10.00 with Akahu' })).toBeVisible();
    await scan(page, 'payment, overdue');

    await page.goto('/payments');
    await expect(
      main(page)
        .getByText(/Overdue since /)
        .first(),
    ).toBeVisible();
    await scan(page, 'payments, overdue');

    await page.goto(walletUrl(scene));
    await expect(
      main(page)
        .getByText(/Overdue since /)
        .first(),
    ).toBeVisible();
    await scan(page, 'wallet, with an overdue payment');
    await closePerson(page);
  });

  test('a payment still with the bank is processing, a declined one can be retried, an unclear one is held (AC-VERIFY-9)', async ({
    browser,
  }) => {
    test.setTimeout(300_000);
    const scene = await newScene();
    const slow = await newMember(scene, 'slow');
    const declined = await newMember(scene, 'declined');
    const held = await newMember(scene, 'held');
    // The fee is the lever on the fake adapter: $5.20 stays SUBMITTED, $5.15 is REJECTED, $5.04 is indeterminate.
    const slowSession = await publishSession(scene, '5.20');
    const declinedSession = await publishSession(scene, '5.15');
    const heldSession = await publishSession(scene, '5.04');
    await register(scene, slowSession, slow);
    await register(scene, declinedSession, declined);
    await register(scene, heldSession, held);
    const rows = await billSessions(scene, [
      { person: slow, session: slowSession },
      { person: declined, session: declinedSession },
      { person: held, session: heldSession },
    ]);

    let page = await signedIn(browser, slow);
    await page.goto(`/payments/${rows[slowSession.id]?.id ?? ''}`);
    await page.getByRole('button', { name: 'Pay $5.20 with Akahu' }).click();
    await expect(page.getByText('Processing your payment.', { exact: false })).toBeVisible({
      timeout: 45_000,
    });
    await scan(page, 'payment, processing');
    await closePerson(page);

    page = await signedIn(browser, declined);
    await page.goto(`/payments/${rows[declinedSession.id]?.id ?? ''}`);
    await page.getByRole('button', { name: 'Pay $5.15 with Akahu' }).click();
    await expect(
      page.getByText("Your payment didn't go through. You haven't been charged."),
    ).toBeVisible({ timeout: 45_000 });
    await expect(page.getByRole('button', { name: 'Try again' })).toBeVisible();
    await scan(page, 'payment, declined');
    await closePerson(page);

    page = await signedIn(browser, held);
    await page.goto(`/payments/${rows[heldSession.id]?.id ?? ''}`);
    await page.getByRole('button', { name: 'Pay $5.04 with Akahu' }).click();
    await expect(page.getByText("We're checking this payment with your bank.")).toBeVisible({
      timeout: 45_000,
    });
    await expect(page.getByRole('button', { name: /Pay \$|Try again/ })).toHaveCount(0);
    await expect(main(page).getByText('Under review').first()).toBeVisible();
    await scan(page, 'payment, held');
    await closePerson(page);

    // The team admin sees the held row as "waiting on the bank", with no reminder for it.
    page = await signedIn(browser, scene.admin);
    await page.goto(`/teams/${scene.teamId}/manage/payments`);
    await expect(page.getByText('Waiting on the bank. Nothing to do yet.')).toBeVisible();
    await scan(page, 'admin payments, a held row');
    await closePerson(page);
  });
});

// ---------------------------------------------------------------------------------------------
// Journey 5: the admin sends a reminder, then payments to the team are blocked
// ---------------------------------------------------------------------------------------------

test.describe('admin payments', () => {
  test('a team admin sends a reminder through the confirmation, and a payout block stops payments (AC-INTEGRATION-4, AC-VERIFY-9)', async ({
    browser,
  }) => {
    test.setTimeout(300_000);
    const scene = await newScene();
    const debtor = await newMember(scene, 'owes');
    const session = await publishSession(scene, '10.00');
    await register(scene, session, debtor);
    const rows = await billSessions(scene, [{ person: debtor, session }]);
    const payment = rows[session.id];
    if (payment === undefined) throw new Error('no payment');
    const firstName = debtor.fullName.split(' ')[0] ?? debtor.fullName;

    const admin = await signedIn(browser, scene.admin);
    await admin.goto(`/teams/${scene.teamId}/manage/payments`);
    await expect(admin.getByRole('heading', { level: 1, name: /Payments/ })).toBeVisible();
    // By text, not cell name: on the phone layout the cell's accessible name gains its "Player" column label.
    await expect(main(admin).getByText(debtor.fullName, { exact: true })).toBeVisible();
    await expect(admin.getByText('No reminder yet')).toBeVisible();
    await scan(admin, 'admin payments, one owing');

    // The confirmation is the inline disclosure, never a native dialog.
    const trigger = admin.getByRole('button', { name: /^Send reminder to / });
    await trigger.click();
    await expect(trigger).toHaveAttribute('aria-expanded', 'true');
    const confirm = admin.getByRole('group', { name: `Email ${firstName} a reminder for $10.00?` });
    await expect(confirm).toBeVisible();
    await scan(admin, 'admin payments, reminder confirmation open');
    await confirm.getByRole('button', { name: 'Send reminder', exact: true }).click();
    await expect(admin.getByText(`Reminder sent to ${firstName} for $10.00.`)).toBeVisible();
    await waitForEmailText(debtor.email, 'Reminder:');
    // Inside the 24-hour cooldown the trigger stays focusable but does nothing, and says when another may go.
    await expect(admin.getByText(/You can send another after /)).toBeVisible();
    await scan(admin, 'admin payments, after a reminder');
    await closePerson(admin);

    // A global admin records that payments to the team's bank account are failing (the one trigger there is).
    const operator = await newPerson('operator');
    await makeGlobalAdmin(operator);
    await api('POST', `/teams/${scene.teamId}/payout-block`, operator.token, {
      reason: 'OTHER',
      changeKey: randomUUID(),
    });

    const blockedAdmin = await signedIn(browser, scene.admin);
    await blockedAdmin.goto(`/teams/${scene.teamId}/manage/payments`);
    await expect(
      blockedAdmin.getByText(
        'Payments to your bank account are failing. Update your banking details.',
      ),
    ).toBeVisible();
    await expect(blockedAdmin.getByRole('button', { name: /^Send reminder/ })).toHaveCount(0);
    await scan(blockedAdmin, 'admin payments, payout blocked');
    await closePerson(blockedAdmin);

    const player = await signedIn(browser, debtor);
    await player.goto(`/payments/${payment.id}`);
    await expect(
      player.getByText("This team can't receive payments right now. We've told the team admins."),
    ).toBeVisible();
    await expect(player.getByRole('button', { name: /Pay \$/ })).toHaveCount(0);
    await scan(player, 'payment, payout blocked');
    await closePerson(player);
  });
});
