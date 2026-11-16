/**
 * The player dashboard in a real browser (player-dashboard Phase 3: AC-HAPPY-8 plus the end-to-end proof of AC-ENTRY-1,
 * AC-ENTRY-3, AC-HAPPY-2, AC-HAPPY-5, AC-ERROR-3 and AC-ERROR-4), on a desktop and a 360 x 740 project. Every state is scanned
 * with axe (no critical or serious violation), for horizontal scroll, for 44 px targets (links, buttons and `<summary>`) and for
 * status tags that carry no words.
 *
 * It runs ONLY against the separate `sgm-e2e` Compose project (web 3100, api 4100, Postgres 5532), never the development stack:
 * the defaults below are the e2e ports and `guardStack` refuses any other web or API origin. The stack uses the FAKE Akahu adapter
 * (`PAYMENTS_ADAPTER=fake`); nothing here calls Akahu. Not part of `pnpm run ci`.
 *
 *   docker compose -p sgm-e2e -f docker-compose.yml -f docker-compose.e2e.yml up -d --build --wait
 *   WEB_BASE_URL=http://localhost:3100 E2E_API_URL=http://localhost:4100 \
 *     E2E_DATABASE_URL=postgres://sgm:sgm@localhost:5532/sgm \
 *     E2E_WORKER_CONTAINER=sgm-e2e-worker-1 E2E_API_CONTAINER=sgm-e2e-api-1 \
 *     pnpm exec playwright test -c apps/web/playwright.config.ts apps/web/e2e/player-dashboard.spec.ts
 *
 * Setup goes through the public API or the browser (people sign in through the real form). The only direct database writes are
 * the two `billing.spec.ts` already uses: `endSession` (a session's date moves to yesterday so the worker's sweep bills it) and
 * `makeDue` (one PENDING payment's due date moves three days back so `daily-overdue` flips it). The fake adapter's outcome is
 * chosen by amount: $5.04 is the "under review" hold, any other amount is approved instantly.
 */
import { execFile } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { promisify } from 'node:util';
import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Browser, type Locator, type Page } from '@playwright/test';

const run = promisify(execFile);

const PASSWORD = 'kowhai-court-27';
const WEB_URL = process.env.WEB_BASE_URL ?? 'http://localhost:3100';
const API_URL = process.env.E2E_API_URL ?? 'http://localhost:4100';
const DATABASE_URL = process.env.E2E_DATABASE_URL ?? 'postgres://sgm:sgm@localhost:5532/sgm';
const WORKER_CONTAINER = process.env.E2E_WORKER_CONTAINER ?? 'sgm-e2e-worker-1';
const ACCOUNT_NUMBER = '01-0902-0068389-00';
const ADDRESS = '12B John Glenn Avenue, Rosedale, Auckland 0632';
const PAYMENTS_TAB = '/dashboard?tab=payments';

/** Only the sgm-e2e stack is allowed: localhost web 3100, api 4100, Postgres 5532. */
function guardStack(): void {
  const allowed: Array<[string, number]> = [
    [WEB_URL, 3100],
    [API_URL, 4100],
    [DATABASE_URL, 5532],
  ];
  const offending = allowed.filter(([url, port]) => {
    try {
      const parsed = new URL(url);
      return !(
        ['localhost', '127.0.0.1'].includes(parsed.hostname) && Number(parsed.port) === port
      );
    } catch {
      return true;
    }
  });
  if (offending.length > 0) {
    throw new Error(
      `player-dashboard e2e must target the sgm-e2e stack (localhost 3100/4100/5532), not ${offending
        .map(([url]) => url.replace(/\/\/[^@/]*@/, '//'))
        .join(', ')}`,
    );
  }
}
guardStack();

// ---------------------------------------------------------------------------------------------
// Helpers: scans (as billing.spec.ts, plus <summary> targets)
// ---------------------------------------------------------------------------------------------

let counter = 0;
function unique(tag: string): string {
  counter += 1;
  return `${tag}-${Date.now().toString(36)}${counter}${randomBytes(2).toString('hex')}`;
}

/** AC-HAPPY-8: no critical or serious axe violation, no horizontal scroll, every target at least 44 px, no colour-only tag. */
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
  const overflow = await page.evaluate(() => ({
    scroll: document.documentElement.scrollWidth,
    client: document.documentElement.clientWidth,
  }));
  expect(
    overflow.scroll,
    `${label}: scrollWidth ${overflow.scroll} must not exceed clientWidth ${overflow.client}`,
  ).toBeLessThanOrEqual(overflow.client);
  const short = await page.evaluate(() => {
    const found: string[] = [];
    // The site header is part of the page too: every nav link and button is a target.
    const targets = document.querySelectorAll(
      'header a[href], header button, main button, main a[href], main summary',
    );
    for (const target of targets) {
      const box = target.getBoundingClientRect();
      if (box.width === 0 || box.height === 0) continue;
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

// ---------------------------------------------------------------------------------------------
// Helpers: dates and the API
// ---------------------------------------------------------------------------------------------

/** Captured once per worker so seeding and display expectations never straddle midnight. */
let frozenToday: string | undefined;
function nzToday(): string {
  frozenToday ??= nzTodayNow();
  return frozenToday;
}

function nzTodayNow(): string {
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

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** `Wed 7 Oct`: the day of a session `offset` days from today in Pacific/Auckland (what the dashboard prints). */
function dayText(offset: number): string {
  const [y, m, d] = addDays(nzToday(), offset).split('-').map(Number) as [number, number, number];
  const date = new Date(Date.UTC(y, m - 1, d));
  return `${WEEKDAYS[date.getUTCDay()] ?? ''} ${d} ${MONTHS[m - 1] ?? ''}`;
}

/** The courts below run 19:00 to 21:00, so the window reads `Wed 7 Oct, 7:00 pm to 9:00 pm`. */
const whenText = (offset: number): string => `${dayText(offset)}, 7:00 pm to 9:00 pm`;
/** The same session's start as the registration and payment lists print it. */
const startText = (offset: number): string => `${dayText(offset)}, 7:00 pm`;

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
  const teamName = `E2E Dashboard ${unique('t')}`;
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

/** The person requests to join `scene`'s team and its admin approves. */
async function joinTeam(scene: Scene, person: Person): Promise<void> {
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
}

async function newMember(scene: Scene, tag: string): Promise<Person> {
  const person = await newPerson(tag);
  await joinTeam(scene, person);
  return person;
}

interface PublishedSession {
  readonly id: string;
  readonly location: string;
  readonly offset: number;
  readonly scene: Scene;
}

/** A PUBLISHED one-off FLAT session `offset` days away charging `rate` per player, created through the admin API. */
async function publishSession(
  scene: Scene,
  rate: string,
  offset: number,
  tag = 'Hall',
  bySex = false,
): Promise<PublishedSession> {
  const location = `Dashboard ${tag} ${unique('l')}`;
  const created = await api<{ session: { id: string; version: number } }>(
    'POST',
    `/teams/${scene.teamId}/sessions`,
    scene.admin.token,
    {
      createKey: randomUUID(),
      date: addDays(nzToday(), offset),
      location,
      address: ADDRESS,
      maxPlayers: 6,
      reservedSeats: 0,
      courtCost: '60.00',
      extraExpenses: '0.00',
      // A party of $0.00 only exists in a paid session: BY_SEX with a $0.00 female fee (the people here are FEMALE).
      ...(bySex
        ? { pricingStructure: 'BY_SEX', feeMale: rate, feeFemale: '0.00', feeOther: rate }
        : { pricingStructure: 'FLAT', customPlayerRate: rate }),
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
  return { id: created.session.id, location, offset, scene };
}

async function register(session: PublishedSession, person: Person): Promise<void> {
  await api(
    'POST',
    `/teams/${session.scene.teamId}/sessions/${session.id}/registrations`,
    person.token,
    { guests: [] },
  );
}

interface WalletRead {
  readonly wallet: { readonly balance: string };
}

/** Tops the wallet up through the API (fake adapter, approved instantly) and waits for the balance. */
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
          await api<WalletRead>(
            'GET',
            `/teams/${scene.teamId}/wallet?topUp=${started.topUp.id}`,
            person.token,
          )
        ).wallet.balance,
      { timeout: 45_000, intervals: [500, 1000, 1000], message: `wallet funded with ${amount}` },
    )
    .toBe(amount);
}

interface PaymentApiRow {
  readonly id: string;
  readonly status: string;
  readonly location: string;
  readonly document: { readonly available: boolean };
}

async function paymentFor(
  session: PublishedSession,
  person: Person,
): Promise<PaymentApiRow | null> {
  const list = await api<{ payments: PaymentApiRow[] }>(
    'GET',
    `/teams/${session.scene.teamId}/payments/me`,
    person.token,
  );
  return list.payments.find((row) => row.location === session.location) ?? null;
}

/** Waits for the worker to bill the session and (optionally) for a status or an available document. */
async function waitForPayment(
  session: PublishedSession,
  person: Person,
  want: { status?: string; document?: boolean } = {},
): Promise<PaymentApiRow> {
  let found: PaymentApiRow | null = null;
  await expect
    .poll(
      async () => {
        found = await paymentFor(session, person);
        if (found === null) return false;
        if (want.status !== undefined && found.status !== want.status) return false;
        return want.document === undefined || found.document.available === want.document;
      },
      { timeout: 60_000, intervals: [500, 1000, 1000], message: `payment for ${session.location}` },
    )
    .toBe(true);
  if (found === null) throw new Error('payment not found');
  return found;
}

// ---------------------------------------------------------------------------------------------
// Helpers: time and jobs (the same fixtures billing.spec.ts names)
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

async function triggerJob(name: 'post-game-billing' | 'daily-overdue'): Promise<void> {
  await run('docker', ['exec', WORKER_CONTAINER, 'node', 'dist/cli.js', 'jobs', 'trigger', name]);
}

/** Ends the sessions and runs the sweep (the caller then waits for each payment). */
async function bill(sessions: readonly PublishedSession[]): Promise<void> {
  for (const session of sessions) await endSession(session);
  await triggerJob('post-game-billing');
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
    baseURL: baseURL ?? WEB_URL,
    ...(viewport === undefined ? {} : { viewport }),
    ...(isMobile === undefined ? {} : { isMobile }),
    ...(hasTouch === undefined ? {} : { hasTouch }),
    ...(deviceScaleFactor === undefined ? {} : { deviceScaleFactor }),
    ...(userAgent === undefined ? {} : { userAgent }),
  });
  const page = await context.newPage();
  page.setDefaultTimeout(30_000);
  page.setDefaultNavigationTimeout(30_000);
  const dialogs: string[] = [];
  openedDialogs.set(page, dialogs);
  page.on('dialog', (dialog) => {
    dialogs.push(`${dialog.type()}: ${dialog.message()}`);
    void dialog.dismiss();
  });
  return page;
}

async function closePerson(page: Page): Promise<void> {
  expect(openedDialogs.get(page) ?? [], 'native browser dialogs').toEqual([]);
  await page.context().close();
}

/** Signs in through the real `/login` form (optionally arriving with a `returnTo`). */
async function signIn(page: Page, person: Person, loginPath = '/login'): Promise<void> {
  await page.goto(loginPath);
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

const main = (page: Page): Locator => page.locator('main');

/** The card or row (`li`) of one session on a dashboard list, found by the location in its heading or text. */
const itemFor = (page: Page, location: string): Locator =>
  main(page).getByRole('listitem').filter({ hasText: location });

/** The three tabs (a `nav` named Dashboard) and which one is current. */
async function expectCurrentTab(page: Page, name: string): Promise<void> {
  const tabs = page.getByRole('navigation', { name: 'Dashboard', exact: true });
  await expect(tabs.getByRole('link')).toHaveText([
    'Currently Opening',
    'My Registration',
    'Payments & Wallet',
  ]);
  await expect(tabs.locator('[aria-current="page"]')).toHaveCount(1);
  await expect(tabs.getByRole('link', { name, exact: true })).toHaveAttribute(
    'aria-current',
    'page',
  );
}

const tabLink = (page: Page, name: string): Locator =>
  page
    .getByRole('navigation', { name: 'Dashboard', exact: true })
    .getByRole('link', { name, exact: true });

/** Link text in DOM order inside `main` (focus order follows the DOM: no positive tabindex anywhere). */
async function focusableTexts(page: Page): Promise<string[]> {
  const positive = await page
    .locator('[tabindex]:not([tabindex="0"]):not([tabindex="-1"])')
    .count();
  expect(positive, 'no positive tabindex').toBe(0);
  return page
    .locator('main a[href], main summary, main button')
    .evaluateAll((nodes) => nodes.map((node) => (node.textContent ?? '').trim()));
}

// ---------------------------------------------------------------------------------------------
// 1. Header -> Currently Opening -> Register -> "You're in" (AC-ENTRY-1, AC-HAPPY-2, AC-HAPPY-8)
// ---------------------------------------------------------------------------------------------

test.describe('player dashboard', () => {
  test('the header opens the dashboard, its cards register through the session page and show "You\'re in" (AC-ENTRY-1, AC-HAPPY-2, AC-HAPPY-8)', async ({
    browser,
  }) => {
    test.setTimeout(240_000);
    const sceneA = await newScene();
    const sceneB = await newScene();
    const player = await newPerson('opener');
    await joinTeam(sceneA, player);
    await joinTeam(sceneB, player);
    const a1 = await publishSession(sceneA, '12.00', 3, 'Alpha');
    const a2 = await publishSession(sceneA, '15.00', 4, 'Beta');
    const b1 = await publishSession(sceneB, '9.00', 5, 'Gamma');

    const page = await signedIn(browser, player);

    // AC-ENTRY-1: from any page the first link after the brand is Dashboard, a 44 px target.
    await page.goto('/teams');
    const header = page.getByRole('navigation', { name: 'Main', exact: true });
    await expect(header.getByRole('link')).toHaveText([
      'Shared Game Management',
      'Dashboard',
      'Find a team',
      'My teams',
      'Account',
    ]);
    const dashboardLink = header.getByRole('link', { name: 'Dashboard', exact: true });
    expect((await dashboardLink.boundingBox())?.height ?? 0).toBeGreaterThanOrEqual(43.5);
    await dashboardLink.click();
    await expect(page).toHaveURL(`${WEB_URL}/dashboard`);
    await expect(page.getByRole('heading', { level: 1, name: 'Dashboard' })).toBeVisible();
    await expectCurrentTab(page, 'Currently Opening');
    await expect(dashboardLink).toHaveAttribute('aria-current', 'page');

    // AC-HAPPY-1/2: exactly the three published sessions, soonest first, with the exact strings seeded above.
    await expect(main(page).getByRole('heading', { level: 3 })).toHaveText([
      a1.location,
      a2.location,
      b1.location,
    ]);
    const rows: [PublishedSession, string, string][] = [
      [a1, '$12.00 per person', sceneA.teamName],
      [a2, '$15.00 per person', sceneA.teamName],
      [b1, '$9.00 per person', sceneB.teamName],
    ];
    for (const [session, fee, team] of rows) {
      const card = itemFor(page, session.location);
      await expect(card.getByText(whenText(session.offset), { exact: true })).toBeVisible();
      await expect(card.getByText(ADDRESS, { exact: true })).toBeVisible();
      await expect(card.getByText(fee, { exact: true })).toBeVisible();
      await expect(card.getByText('6 of 6 places left', { exact: true })).toBeVisible();
      await expect(card.getByRole('link', { name: team, exact: true })).toHaveAttribute(
        'href',
        `/teams/${session.scene.teamId}`,
      );
      const register = card.getByRole('link', {
        name: `Register for ${session.location}, ${whenText(session.offset)}`,
        exact: true,
      });
      await expect(register).toHaveAttribute(
        'href',
        `/teams/${session.scene.teamId}/sessions/${session.id}`,
      );
      expect((await register.boundingBox())?.height ?? 0).toBeGreaterThanOrEqual(43.5);
    }
    await expect(main(page).getByText(/overdue payments/)).toHaveCount(0);
    expect(
      (await focusableTexts(page)).slice(0, 3),
      'focus order: the tabs come before the cards',
    ).toEqual(['Currently Opening', 'My Registration', 'Payments & Wallet']);
    await scan(page, 'dashboard, Currently Opening');

    // Register on the existing session page, then the card says so on the next load.
    await itemFor(page, a1.location)
      .getByRole('link', { name: /^Register for / })
      .click();
    await expect(page).toHaveURL(`${WEB_URL}/teams/${sceneA.teamId}/sessions/${a1.id}`);
    const panel = page.getByRole('region', { name: 'Registration' });
    await panel.getByRole('button', { name: 'Register', exact: true }).click();
    await expect(panel.locator('div[role=status]').getByText("You're in.").first()).toBeVisible();

    await page.goto('/dashboard');
    const done = itemFor(page, a1.location);
    await expect(done.getByText("You're in", { exact: true })).toBeVisible();
    await expect(
      done.getByRole('link', {
        name: `View registration for ${a1.location}, ${whenText(a1.offset)}`,
        exact: true,
      }),
    ).toHaveAttribute('href', `/teams/${sceneA.teamId}/sessions/${a1.id}`);
    await expect(
      itemFor(page, a2.location).getByRole('link', { name: /^Register for / }),
    ).toBeVisible();
    await scan(page, 'dashboard, Currently Opening after registering');
    await closePerson(page);
  });

  // -------------------------------------------------------------------------------------------
  // 2. Empty states (AC-ERROR-4, AC-HAPPY-8)
  // -------------------------------------------------------------------------------------------

  test('every empty state says what to do next, including the empty accordions (AC-ERROR-4, AC-HAPPY-8)', async ({
    browser,
  }) => {
    test.setTimeout(300_000);

    // A player with no team at all.
    const loner = await signedIn(browser, await newPerson('loner'));
    await loner.goto('/dashboard');
    await expect(main(loner).getByText('Join a team to see its open sessions here.')).toBeVisible();
    await expect(main(loner).getByRole('link', { name: 'Find a team' })).toHaveAttribute(
      'href',
      '/teams/find',
    );
    await scan(loner, 'Currently Opening, no team');
    await tabLink(loner, 'My Registration').click();
    await expect(loner).toHaveURL(`${WEB_URL}/dashboard?tab=registrations`);
    await expectCurrentTab(loner, 'My Registration');
    await expect(
      main(loner).getByText("You haven't registered for any sessions yet."),
    ).toBeVisible();
    await expect(main(loner).getByRole('link', { name: 'See open sessions' })).toHaveAttribute(
      'href',
      '/dashboard',
    );
    await scan(loner, 'My Registration, empty');
    await tabLink(loner, 'Payments & Wallet').click();
    await expectCurrentTab(loner, 'Payments & Wallet');
    await expect(main(loner).getByText('Join a team to get a wallet.')).toBeVisible();
    await expect(main(loner).getByRole('link', { name: 'Find a team' })).toHaveAttribute(
      'href',
      '/teams/find',
    );
    await scan(loner, 'Payments & Wallet, no team');
    await closePerson(loner);

    // Three members of one team: one never played, one funded wallet (paid only), one unfunded (pending only).
    const scene = await newScene();
    const idle = await newMember(scene, 'idle');
    const funded = await newMember(scene, 'funded');
    const unfunded = await newMember(scene, 'unfunded');
    const session = await publishSession(scene, '8.00', 3, 'Delta');
    await register(session, funded);
    await register(session, unfunded);
    await fundWallet(scene, funded, '20.00');
    await bill([session]);
    await waitForPayment(session, funded, { status: 'PAID' });
    await waitForPayment(session, unfunded, { status: 'PENDING' });

    const idlePage = await signedIn(browser, idle);
    await idlePage.goto('/dashboard');
    await expect(
      main(idlePage).getByText('No sessions are open for registration right now.'),
    ).toBeVisible();
    await scan(idlePage, 'Currently Opening, team without open sessions');
    await idlePage.goto('/dashboard?tab=payments');
    const card = main(idlePage).getByRole('listitem').filter({ hasText: scene.teamName });
    await expect(card.getByText('Balance: $0.00')).toBeVisible();
    await expect(
      card.getByText('You can top up to $100.00 more (wallet limit $100.00).'),
    ).toBeVisible();
    await expect(
      card.getByRole('link', { name: `Top up credit for ${scene.teamName}`, exact: true }),
    ).toHaveAttribute('href', `/teams/${scene.teamId}/wallet#wallet`);
    await expect(
      main(idlePage).getByText('No payments yet. Charges appear here after a game.'),
    ).toBeVisible();
    await expect(main(idlePage).locator('details')).toHaveCount(0);
    await scan(idlePage, 'Payments & Wallet, team without payments');
    await closePerson(idlePage);

    // Paid only: Overdue and Pending are empty accordions.
    const paidPage = await signedIn(browser, funded);
    await paidPage.goto('/dashboard?tab=payments');
    const accordions = main(paidPage).locator('details');
    await expect(accordions.locator('summary')).toHaveText([
      'Overdue (0)',
      'Pending (0)',
      'Paid (1)',
    ]);
    await expect(accordions.nth(0)).not.toHaveJSProperty('open', true);
    await accordions.nth(0).locator('summary').click();
    await accordions.nth(1).locator('summary').click();
    await expect(main(paidPage).getByText('Nothing overdue.')).toBeVisible();
    await expect(main(paidPage).getByText('Nothing pending.')).toBeVisible();
    await scan(paidPage, 'Payments & Wallet, empty Overdue and Pending open');
    await closePerson(paidPage);

    // Pending only: Overdue and Paid are empty accordions.
    const pendingPage = await signedIn(browser, unfunded);
    await pendingPage.goto('/dashboard?tab=payments');
    const pendingAccordions = main(pendingPage).locator('details');
    await expect(pendingAccordions.locator('summary')).toHaveText([
      'Overdue (0)',
      'Pending (1)',
      'Paid (0)',
    ]);
    await pendingAccordions.nth(0).locator('summary').click();
    await pendingAccordions.nth(2).locator('summary').click();
    await expect(main(pendingPage).getByText('Nothing overdue.')).toBeVisible();
    await expect(main(pendingPage).getByText('No paid games yet.')).toBeVisible();
    await scan(pendingPage, 'Payments & Wallet, empty Overdue and Paid open');
    await closePerson(pendingPage);
  });

  // -------------------------------------------------------------------------------------------
  // 3. The billed player: My Registration and Payments & Wallet (AC-HAPPY-5, AC-ERROR-3, AC-HAPPY-8)
  // -------------------------------------------------------------------------------------------

  test.describe('a player with billed games', () => {
    test.describe.configure({ mode: 'serial' });

    interface Billed {
      readonly player: Person;
      readonly sceneA: Scene;
      readonly sceneB: Scene;
      readonly wallet: PublishedSession;
      readonly overdue: PublishedSession;
      readonly pendingOne: PublishedSession;
      readonly pendingTwo: PublishedSession;
      readonly held: PublishedSession;
      readonly akahu: PublishedSession;
      readonly free: PublishedSession;
      readonly upcoming: PublishedSession;
      readonly closed: PublishedSession;
      readonly ids: Record<string, string>;
    }
    let billed: Billed;

    test.beforeAll(async ({ browser }) => {
      test.setTimeout(420_000);
      const sceneA = await newScene();
      const sceneB = await newScene();
      const player = await newPerson('billed');
      await joinTeam(sceneA, player);
      await joinTeam(sceneB, player);

      // Team A: one paid from the wallet ($7.50 of $20.00 leaves $12.50), one overdue, two pending (none covered by $12.50).
      const wallet = await publishSession(sceneA, '7.50', 1, 'Wallet');
      const overdue = await publishSession(sceneA, '15.00', 1, 'Overdue');
      const pendingOne = await publishSession(sceneA, '20.00', 1, 'PendingOne');
      const pendingTwo = await publishSession(sceneA, '25.00', 1, 'PendingTwo');
      // Team B (empty wallet): $5.04 is held under review, $6.00 is paid through Akahu, $0.00 needs no payment.
      const held = await publishSession(sceneB, '5.04', 1, 'Held');
      const akahu = await publishSession(sceneB, '6.00', 1, 'Akahu');
      const free = await publishSession(sceneB, '10.00', 1, 'Free', true);
      // Not billed yet, and a later open session that stays registerable with one overdue payment (the debt block is three).
      const upcoming = await publishSession(sceneA, '11.00', 4, 'Upcoming');
      const closed = await publishSession(sceneA, '13.00', 6, 'Closed');
      for (const session of [
        wallet,
        overdue,
        pendingOne,
        pendingTwo,
        held,
        akahu,
        free,
        upcoming,
      ]) {
        await register(session, player);
      }
      await fundWallet(sceneA, player, '20.00');

      await bill([wallet]);
      await waitForPayment(wallet, player, { status: 'PAID' });
      await bill([overdue, pendingOne, pendingTwo, held, akahu, free]);
      const ids: Record<string, string> = {};
      for (const [key, session] of Object.entries({
        overdue,
        pendingOne,
        pendingTwo,
        held,
        akahu,
        free,
      })) {
        ids[key] = (await waitForPayment(session, player)).id;
      }
      ids.wallet = (await waitForPayment(wallet, player, { status: 'PAID' })).id;
      await waitForPayment(free, player, { status: 'PAID' });

      // The player pays $6.00 and starts $5.04 through the real payment page, as billing.spec.ts does.
      const payer = await signedIn(browser, player);
      await payer.goto(`/payments/${ids.akahu ?? ''}`);
      await payer.getByRole('button', { name: 'Pay $6.00 with Akahu' }).click();
      await expect(main(payer).getByText(/^Paid on /)).toBeVisible({ timeout: 45_000 });
      await payer.goto(`/payments/${ids.held ?? ''}`);
      await payer.getByRole('button', { name: 'Pay $5.04 with Akahu' }).click();
      await expect(payer.getByText("We're checking this payment with your bank.")).toBeVisible({
        timeout: 45_000,
      });
      await closePerson(payer);
      await waitForPayment(akahu, player, { status: 'PAID', document: true });
      await waitForPayment(wallet, player, { status: 'PAID', document: true });

      await makeDue(ids.overdue ?? '');
      await triggerJob('daily-overdue');
      await waitForPayment(overdue, player, { status: 'OVERDUE' });
      billed = {
        player,
        sceneA,
        sceneB,
        wallet,
        overdue,
        pendingOne,
        pendingTwo,
        held,
        akahu,
        free,
        upcoming,
        closed,
        ids,
      };
    });

    test('My Registration lists every game with its payment state, and Currently Opening leads with the debt banner (AC-HAPPY-2, AC-HAPPY-8)', async ({
      browser,
    }) => {
      test.setTimeout(120_000);
      const page = await signedIn(browser, billed.player);

      // Currently Opening: the overdue banner above the list, then the cards; one overdue payment shows the banner but does not block Register (the block starts at three).
      await page.goto('/dashboard');
      const banner = main(page).getByRole('status').filter({ hasText: 'overdue payments' });
      await expect(banner).toContainText('You have 1 overdue payments across your teams.');
      await expect(banner.getByRole('link', { name: 'Go to Payments & Wallet' })).toHaveAttribute(
        'href',
        PAYMENTS_TAB,
      );
      const upcomingCard = itemFor(page, billed.upcoming.location);
      await expect(upcomingCard.getByText("You're in", { exact: true })).toBeVisible();
      await expect(
        upcomingCard.getByRole('link', { name: /^View registration for / }),
      ).toBeVisible();
      const laterLink = itemFor(page, billed.closed.location).getByRole('link', {
        name: `Register for ${billed.closed.location}, ${whenText(billed.closed.offset)}`,
        exact: true,
      });
      await expect(laterLink).toHaveAttribute(
        'href',
        `/teams/${billed.sceneA.teamId}/sessions/${billed.closed.id}`,
      );
      const order = await focusableTexts(page);
      const indexOf = (prefix: string): number =>
        order.findIndex((text) => text.startsWith(prefix));
      expect(indexOf('Currently Opening')).toBeGreaterThanOrEqual(0);
      expect(indexOf('Currently Opening')).toBeLessThan(indexOf('Go to Payments & Wallet'));
      expect(indexOf('Go to Payments & Wallet')).toBeLessThan(indexOf('View registration'));
      await scan(page, 'Currently Opening, debt banner');

      // My Registration.
      await tabLink(page, 'My Registration').click();
      await expect(page).toHaveURL(`${WEB_URL}/dashboard?tab=registrations`);
      await expectCurrentTab(page, 'My Registration');
      await expect(main(page).getByRole('heading', { level: 2 })).toHaveText(['Upcoming', 'Past']);

      const upcoming = itemFor(page, billed.upcoming.location);
      await expect(
        upcoming.getByText(startText(billed.upcoming.offset), { exact: true }),
      ).toBeVisible();
      await expect(upcoming.getByText('Not billed yet', { exact: true })).toBeVisible();
      await expect(upcoming.getByText('Estimated total: $11.00', { exact: true })).toBeVisible();
      await expect(upcoming.getByRole('link', { name: 'View payment' })).toHaveCount(0);

      const expectations: [PublishedSession, string, RegExp | string, string][] = [
        [billed.overdue, 'overdue', /^Overdue since \w{3} \d{1,2} \w{3}$/, 'Total fee: $15.00'],
        [billed.pendingOne, 'pendingOne', /^Due \w{3} \d{1,2} \w{3}$/, 'Total fee: $20.00'],
        [billed.wallet, 'wallet', 'Paid from wallet', 'Total fee: $7.50'],
        [billed.akahu, 'akahu', 'Paid', 'Total fee: $6.00'],
        [billed.held, 'held', 'Under review', 'Total fee: $5.04'],
        [billed.free, 'free', 'No charge', 'Total fee: $0.00'],
      ];
      for (const [session, key, tag, total] of expectations) {
        const card = itemFor(page, session.location);
        await expect(card.getByText(session.scene.teamName, { exact: true })).toBeVisible();
        await expect(card.getByText(ADDRESS, { exact: true })).toBeVisible();
        await expect(card.getByText("You're in", { exact: true })).toBeVisible();
        await expect(card.getByText(tag, { exact: typeof tag === 'string' }).first()).toBeVisible();
        await expect(card.getByText(total, { exact: true })).toBeVisible();
        await expect(card.getByRole('link', { name: 'View payment' })).toHaveAttribute(
          'href',
          `/payments/${billed.ids[key] ?? ''}`,
        );
        await expect(card.getByRole('link', { name: 'View session' })).toBeVisible();
      }
      await expect(
        itemFor(page, billed.held.location).getByText(
          "We're checking this payment with your bank.",
        ),
      ).toBeVisible();
      await scan(page, 'My Registration, billed games');
      await closePerson(page);
    });

    test('Payments & Wallet shows the wallet cards, the three accordions, Pay now links and the PDF download (AC-HAPPY-5, AC-ERROR-3, AC-HAPPY-8)', async ({
      browser,
    }) => {
      test.setTimeout(180_000);
      const { sceneA, sceneB, ids } = billed;
      const page = await signedIn(browser, billed.player);
      await page.goto(PAYMENTS_TAB);
      await expectCurrentTab(page, 'Payments & Wallet');

      // Wallet cards: team A $12.50 with headroom $87.50 and a top-up link; team B $0.00.
      const cardA = main(page).getByRole('listitem').filter({ hasText: sceneA.teamName }).first();
      await expect(cardA.getByText('Balance: $12.50')).toBeVisible();
      await expect(
        cardA.getByText('You can top up to $87.50 more (wallet limit $100.00).'),
      ).toBeVisible();
      await expect(
        cardA.getByRole('link', { name: `Top up credit for ${sceneA.teamName}`, exact: true }),
      ).toHaveAttribute('href', `/teams/${sceneA.teamId}/wallet#wallet`);
      const cardB = main(page).getByRole('listitem').filter({ hasText: sceneB.teamName }).first();
      await expect(cardB.getByText('Balance: $0.00')).toBeVisible();

      // The three accordions, in order, with counts; Overdue and Pending open, Paid closed.
      const details = main(page).locator('details');
      await expect(details.locator('summary')).toHaveText([
        'Overdue (1)',
        'Pending (3)',
        'Paid (3)',
      ]);
      await expect(details.nth(0)).toHaveJSProperty('open', true);
      await expect(details.nth(1)).toHaveJSProperty('open', true);
      await expect(details.nth(2)).toHaveJSProperty('open', false);
      await expect(details.nth(0).getByRole('heading', { level: 4 })).toHaveText([sceneA.teamName]);
      await expect(details.nth(1).getByRole('heading', { level: 4 })).toHaveText([
        sceneA.teamName,
        sceneB.teamName,
      ]);
      await scan(page, 'Payments & Wallet, default accordions');

      // Open Paid (all open), then close Overdue and Pending (Paid open): each state is scanned.
      await details.nth(2).locator('summary').click();
      await expect(details.nth(2)).toHaveJSProperty('open', true);
      // Paid is newest-paid first, so the two team groups are checked as a set.
      expect(
        (await details.nth(2).getByRole('heading', { level: 4 }).allTextContents()).sort(),
      ).toEqual([sceneA.teamName, sceneB.teamName].sort());
      await scan(page, 'Payments & Wallet, all accordions open');

      // Pay now: only on the three payable rows, to /payments/:id; never on Paid or the held row.
      const payNow = main(page).getByRole('link', { name: /^Pay now/ });
      await expect(payNow).toHaveCount(3);
      const overdueRow = details
        .nth(0)
        .getByRole('listitem')
        .filter({ hasText: billed.overdue.location });
      await expect(overdueRow.getByText(/^Overdue since /)).toBeVisible();
      await expect(overdueRow.getByText('$15.00', { exact: true })).toBeVisible();
      await expect(overdueRow.getByRole('link', { name: /^Pay now/ })).toHaveAttribute(
        'href',
        `/payments/${ids.overdue ?? ''}`,
      );
      for (const [session, key] of [
        [billed.pendingOne, 'pendingOne'],
        [billed.pendingTwo, 'pendingTwo'],
      ] as const) {
        await expect(
          details
            .nth(1)
            .getByRole('listitem')
            .filter({ hasText: session.location })
            .getByRole('link', { name: /^Pay now/ }),
        ).toHaveAttribute('href', `/payments/${ids[key] ?? ''}`);
      }
      const heldRow = details
        .nth(1)
        .getByRole('listitem')
        .filter({ hasText: billed.held.location });
      await expect(heldRow.getByText('Under review', { exact: true })).toBeVisible();
      await expect(heldRow.getByText("We're checking this payment with your bank.")).toBeVisible();
      await expect(heldRow.getByRole('link', { name: /^Pay now/ })).toHaveCount(0);
      await expect(details.nth(2).getByRole('link', { name: /^Pay now/ })).toHaveCount(0);

      // Paid rows: tags in words, and a download link exactly where a document is available (not the $0.00 row).
      const walletRow = details
        .nth(2)
        .getByRole('listitem')
        .filter({ hasText: billed.wallet.location });
      const akahuRow = details
        .nth(2)
        .getByRole('listitem')
        .filter({ hasText: billed.akahu.location });
      const freeRow = details
        .nth(2)
        .getByRole('listitem')
        .filter({ hasText: billed.free.location });
      await expect(walletRow.getByText('Paid from wallet', { exact: true })).toBeVisible();
      await expect(walletRow.getByText('$7.50', { exact: true })).toBeVisible();
      await expect(akahuRow.getByText('Paid', { exact: true })).toBeVisible();
      await expect(freeRow.getByText('No charge', { exact: true })).toBeVisible();
      await expect(main(page).getByRole('link', { name: /^Download / })).toHaveCount(2);
      await expect(freeRow.getByRole('link', { name: /^Download / })).toHaveCount(0);
      const walletLink = walletRow.getByRole('link', { name: /^Download / });
      const akahuLink = akahuRow.getByRole('link', { name: /^Download / });
      const walletHref = (await walletLink.getAttribute('href')) ?? '';
      const akahuHref = (await akahuLink.getAttribute('href')) ?? '';
      expect(new URL(walletHref, WEB_URL).pathname).toBe(`/payments/${ids.wallet ?? ''}/invoice`);
      expect(new URL(walletHref, WEB_URL).searchParams.get('returnTo')).toBe(PAYMENTS_TAB);
      expect(new URL(akahuHref, WEB_URL).pathname).toBe(`/payments/${ids.akahu ?? ''}/invoice`);

      // Following the link returns the PDF of that payment only.
      const walletPdf = await page.request.get(walletHref);
      expect(walletPdf.status()).toBe(200);
      expect(walletPdf.headers()['content-type']).toContain('application/pdf');
      expect(walletPdf.headers()['content-disposition']).toContain('attachment');
      const walletBytes = await walletPdf.body();
      expect(walletBytes.subarray(0, 5).toString('latin1')).toBe('%PDF-');
      const akahuPdf = await page.request.get(akahuHref);
      expect(akahuPdf.headers()['content-type']).toContain('application/pdf');
      expect((await akahuPdf.body()).equals(walletBytes), 'each link serves its own document').toBe(
        false,
      );

      // Close Overdue and Pending: the remaining state of the accordions.
      await details.nth(0).locator('summary').click();
      await details.nth(1).locator('summary').click();
      await expect(details.nth(0)).toHaveJSProperty('open', false);
      await expect(details.nth(1)).toHaveJSProperty('open', false);
      await scan(page, 'Payments & Wallet, Overdue and Pending closed');
      await details.nth(2).locator('summary').click();
      await scan(page, 'Payments & Wallet, all accordions closed');

      // AC-ERROR-3: a payment with no document lands back on this tab with the existing notice; the accordions stay intact.
      await page.goto(
        `/payments/${ids.free ?? ''}/invoice?returnTo=${encodeURIComponent(PAYMENTS_TAB)}`,
      );
      await expect(page).toHaveURL(
        `${WEB_URL}${PAYMENTS_TAB}&download_error=invoice_not_available`,
      );
      await expect(main(page).getByRole('alert')).toHaveText(
        'An invoice is available once the payment is paid.',
      );
      await expect(main(page).locator('details').locator('summary')).toHaveText([
        'Overdue (1)',
        'Pending (3)',
        'Paid (3)',
      ]);
      await expectCurrentTab(page, 'Payments & Wallet');
      await scan(page, 'Payments & Wallet, download error notice');
      await closePerson(page);
    });
  });

  // -------------------------------------------------------------------------------------------
  // 4. Signed out (AC-ENTRY-3)
  // -------------------------------------------------------------------------------------------

  test('a visitor with no session is sent to sign in and returned to the same tab (AC-ENTRY-3)', async ({
    browser,
  }) => {
    test.setTimeout(120_000);
    const returnTo = '%2Fdashboard%3Ftab%3Dpayments';
    const person = await newPerson('returning');
    const page = await personPage(browser);

    // No cookie: the proxy answers a redirect to /login with returnTo, uncached.
    const redirect = await page.request.get('/dashboard?tab=payments', { maxRedirects: 0 });
    expect([302, 303, 307, 308]).toContain(redirect.status());
    expect(redirect.headers().location ?? '').toMatch(
      new RegExp(`/login\\?returnTo=${returnTo.replace(/%/g, '%')}$`),
    );
    expect(redirect.headers()['cache-control']).toContain('no-store');

    // After signing in they land on that tab.
    await page.goto('/dashboard?tab=payments');
    await expect(page).toHaveURL(`${WEB_URL}/login?returnTo=${returnTo}`);
    await scan(page, 'login, arrived from the dashboard');
    await page.getByLabel('Email').fill(person.email);
    await page.getByLabel('Password', { exact: true }).fill(PASSWORD);
    await page.getByRole('button', { name: 'Sign in' }).click();
    await expect(page).toHaveURL(`${WEB_URL}${PAYMENTS_TAB}`);
    await expectCurrentTab(page, 'Payments & Wallet');
    await closePerson(page);

    // A dead cookie goes through the session-expired route, keeps the same returnTo and never shows an error page.
    const stale = await personPage(browser);
    await stale.context().addCookies([{ name: 'sgm_session', value: 'dead-token', url: WEB_URL }]);
    await stale.goto('/dashboard?tab=payments');
    await expect(stale).toHaveURL(new RegExp(`/login\\?.*returnTo=${returnTo}`));
    await expect(stale.getByRole('heading', { level: 1, name: /sign in/i })).toBeVisible();
    await closePerson(stale);
  });
});
