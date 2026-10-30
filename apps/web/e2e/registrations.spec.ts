/**
 * The player registration journeys in a real browser (AC-INTEGRATION-4) with axe scans and the 360 px pass (AC-VERIFY-8,
 * AC-VERIFY-9), run on a desktop and a 360 x 740 project against the Compose stack with the worker running (promotion
 * emails are worker jobs) and Mailpit. Not part of `pnpm run ci`.
 *
 *   AUTH_FAKE_OAUTH=true docker compose up -d --build --wait && pnpm run test:e2e apps/web/e2e/registrations.spec.ts
 *
 * Nothing is seeded by a script (R27): the team, its members and its sessions are created and published through the
 * session-scheduling-engine admin API (`POST /teams/:teamId/sessions`, `.../publish`, `.../cancel`) with the team admin's
 * bearer token, and every player signs in through the real sign-in form. The one thing the product cannot yet create is
 * an overdue payment (billing is a later feature), so the debt journey writes three OVERDUE `payments` rows to the stack's
 * Postgres (`E2E_DATABASE_URL`, default the Compose database). Dates are relative to today in Pacific/Auckland.
 */
import { randomBytes, randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Browser, type Locator, type Page } from '@playwright/test';

const PASSWORD = 'kowhai-court-27';
const API_URL = process.env.E2E_API_URL ?? 'http://localhost:4000';
const DATABASE_URL = process.env.E2E_DATABASE_URL ?? 'postgres://sgm:sgm@localhost:5432/sgm';
const MAILPIT_API_URL = process.env.MAILPIT_API_URL ?? 'http://localhost:8025';

// ---------------------------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------------------------

let counter = 0;
function unique(tag: string): string {
  counter += 1;
  return `${tag}-${Date.now().toString(36)}${counter}${randomBytes(2).toString('hex')}`;
}

/** AC-VERIFY-8: no axe violation of impact critical or serious, and no horizontal page scroll. */
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
}

/** Buttons, links and radio rows in the page content are at least 44 px high (AC-VERIFY-8). */
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

/** No horizontal page scroll at the current viewport (AC-VERIFY-8). */
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

// ---- Dates (Pacific/Auckland) -----------------------------------------------------------------

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

// ---- The API (the admin flow of session-scheduling-engine, bearer tokens) --------------------

interface Person {
  readonly fullName: string;
  readonly email: string;
  readonly userId: string;
  readonly token: string;
}

async function api<T>(
  method: 'GET' | 'POST',
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

/** A fresh team with its own admin; nothing is shared between journeys, so each one can run in any order. */
async function newScene(): Promise<Scene> {
  const admin = await newPerson('admin');
  const teamName = `E2E Registrations ${unique('t')}`;
  const created = await api<{ team: { id: string } }>('POST', '/teams', admin.token, {
    name: teamName,
    description: '',
    visibility: 'PUBLIC',
    skillLevel: 'INTERMEDIATE',
    idempotencyKey: randomUUID(),
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
  readonly version: number;
}

/** Creates a free one-off session through the admin API and publishes it (nothing else makes it visible to players). */
async function publishSession(
  scene: Scene,
  input: {
    readonly daysAhead: number;
    readonly maxPlayers: number;
    readonly location: string;
    readonly deadline?: { date: string; time: string };
  },
): Promise<PublishedSession> {
  const created = await api<{ session: { id: string; version: number } }>(
    'POST',
    `/teams/${scene.teamId}/sessions`,
    scene.admin.token,
    {
      createKey: randomUUID(),
      date: addDays(nzToday(), input.daysAhead),
      location: input.location,
      address: '12B John Glenn Avenue, Rosedale, Auckland 0632',
      maxPlayers: input.maxPlayers,
      reservedSeats: 0,
      courtCost: '0.00',
      extraExpenses: '0.00',
      pricingStructure: 'FLAT',
      cancellationDeadline: input.deadline ?? null,
      courts: [{ identifier: 'Court 1', startTime: '19:00', endTime: '21:00' }],
    },
  );
  const published = await api<{ session: { version: number } }>(
    'POST',
    `/teams/${scene.teamId}/sessions/${created.session.id}/publish`,
    scene.admin.token,
    { expectedVersion: created.session.version },
  );
  return {
    id: created.session.id,
    location: input.location,
    version: published.session.version,
  };
}

// ---- Database (the debt journey only) ---------------------------------------------------------

interface DbClient {
  connect(): Promise<void>;
  query(text: string, values?: unknown[]): Promise<{ rows: Record<string, unknown>[] }>;
  end(): Promise<void>;
}

/** `pg` belongs to the API workspace, so it is resolved from there. */
async function withDb<T>(run: (db: DbClient) => Promise<T>): Promise<T> {
  const load = createRequire(new URL('../../api/package.json', import.meta.url));
  const { Client } = load('pg') as {
    Client: new (config: { connectionString: string }) => DbClient;
  };
  const db = new Client({ connectionString: DATABASE_URL });
  await db.connect();
  try {
    return await run(db);
  } finally {
    await db.end();
  }
}

/** Turns every registration of `userId` into an OVERDUE payment (header and its one line, in one transaction). */
async function makeOverdue(userId: string): Promise<number> {
  return withDb(async (db) => {
    const registrations = await db.query(
      'SELECT id, team_id AS "teamId" FROM registrations WHERE user_id = $1',
      [userId],
    );
    for (const row of registrations.rows) {
      await db.query('BEGIN');
      const payment = await db.query(
        `INSERT INTO payments (user_id, team_id, registration_id, pricing_structure, gst_registered, gst_rate_bps,
                               amount, payment_link_token, due_date, status)
         VALUES ($1, $2, $3, 'FLAT', true, 1500, '17.00', $4, now() - interval '3 days', 'OVERDUE')
         RETURNING id`,
        [userId, row.teamId, row.id, `link-${randomUUID()}`],
      );
      await db.query(
        `INSERT INTO payment_line_items (payment_id, party_position, pricing_structure, applied_basis,
                                         party_sex, party_skill_level, unit_fee)
         VALUES ($1, 0, 'FLAT', 'FLAT', 'FEMALE', 'INTERMEDIATE', '17.00')`,
        [payment.rows[0]?.id],
      );
      await db.query('COMMIT');
    }
    return registrations.rows.length;
  });
}

/** Reads the registration row's status directly, so the ban step can assert the handler's effect without the UI. */
async function registrationStatus(sessionId: string, userId: string): Promise<string | null> {
  return withDb(async (db) => {
    const result = await db.query(
      'SELECT status::text AS status FROM registrations WHERE session_id = $1 AND user_id = $2',
      [sessionId, userId],
    );
    return (result.rows[0]?.status as string | undefined) ?? null;
  });
}

// ---- Mailpit ----------------------------------------------------------------------------------

/** Polls Mailpit until a message to `to` whose subject starts with `subjectStart` has arrived (worker-sent email). */
async function waitForEmail(to: string, subjectStart: string): Promise<void> {
  await expect
    .poll(
      async () => {
        const search = await fetch(
          `${MAILPIT_API_URL}/api/v1/search?query=${encodeURIComponent(`to:${to}`)}`,
        );
        const body = (await search.json()) as { messages?: { Subject: string }[] };
        return (body.messages ?? []).some((message) => message.Subject.startsWith(subjectStart));
      },
      {
        timeout: 45_000,
        intervals: [500, 1000, 1000],
        message: `email "${subjectStart}..." to ${to}`,
      },
    )
    .toBe(true);
}

// ---- The browser ------------------------------------------------------------------------------

const openedDialogs = new WeakMap<Page, string[]>();

/** Closes a person's context after asserting that no native dialog opened. */
async function closePerson(page: Page): Promise<void> {
  expect(openedDialogs.get(page) ?? [], 'native browser dialogs').toEqual([]);
  await page.context().close();
}

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

/** Signs in through the real `/login` form; every player goes through it, never a cookie or token injection. */
async function signIn(page: Page, person: Person): Promise<void> {
  await page.goto('/login');
  await page.getByLabel('Email').fill(person.email);
  await page.getByLabel('Password', { exact: true }).fill(PASSWORD);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await page.waitForURL((url) => !url.pathname.startsWith('/login'));
}

const sessionUrl = (scene: Scene, session: PublishedSession): string =>
  `/teams/${scene.teamId}/sessions/${session.id}`;

/** The registration panel: the section the "Registration" heading names. */
const panel = (page: Page): Locator => page.getByRole('region', { name: 'Registration' });

/** The one polite status region of the panel (outcome card and the note of the last action). */
const statusRegion = (page: Page): Locator => panel(page).locator('div[role=status]');

/** A guest fieldset: sex, skill level and an optional name. */
async function fillGuest(
  page: Page,
  n: number,
  guest: { sex: string; skill: string; name?: string },
): Promise<void> {
  const fieldset = page.getByRole('group', { name: `Guest ${n}`, exact: true });
  await fieldset
    .getByRole('group', { name: 'Sex', exact: true })
    .getByLabel(guest.sex, { exact: true })
    .check();
  await fieldset
    .getByRole('group', { name: 'Skill level', exact: true })
    .getByLabel(guest.skill, { exact: true })
    .check();
  if (guest.name !== undefined) await fieldset.getByLabel('Name (optional)').fill(guest.name);
}

/** Opens the withdraw confirmation, returns it. */
async function openWithdraw(page: Page, trigger: string | RegExp): Promise<Locator> {
  await panel(page).getByRole('button', { name: trigger }).click();
  const confirm = panel(page).getByRole('group', { name: /Withdraw|Leave the waitlist/ });
  await expect(confirm).toBeVisible();
  return confirm;
}

// ---------------------------------------------------------------------------------------------
// The journeys
// ---------------------------------------------------------------------------------------------

test.describe('player registration', () => {
  test('register, waitlist a group of three, promote on an early withdrawal, email the promoted player (AC-INTEGRATION-4, AC-VERIFY-8, AC-VERIFY-9)', async ({
    browser,
  }) => {
    test.setTimeout(240_000);
    const scene = await newScene();
    const alone = await newMember(scene, 'pair');
    const group = await newMember(scene, 'group');
    // Three public places: a pair (player A and one guest) takes two, a party of three can then only wait.
    const session = await publishSession(scene, {
      daysAhead: 10,
      maxPlayers: 3,
      location: `Rosedale Hall ${unique('l')}`,
    });

    // ===== 1. Player A finds the session from the team page and registers with one guest
    const a = await personPage(browser);
    await signIn(a, alone);
    await a.goto(`/teams/${scene.teamId}`);
    const upcoming = a.getByRole('region', { name: 'Upcoming sessions' });
    await expect(upcoming).toContainText('3 of 3 places left');
    await scan(a, 'team page with upcoming sessions');
    await upcoming.getByRole('link', { name: new RegExp(session.location) }).click();
    await a.waitForURL(sessionUrl(scene, session));
    await expect(a.getByRole('heading', { level: 1 })).toHaveText(session.location);
    await expect(
      panel(a).getByRole('heading', { name: 'Registration', exact: true }),
    ).toBeVisible();
    await expect(panel(a).getByText('3 of 3 places left')).toBeVisible();
    await scan(a, 'session page, open');
    await panel(a).getByLabel('Me + 1 guest').check();
    await fillGuest(a, 1, { sex: 'Female', skill: 'Intermediate', name: 'Aroha' });
    await panel(a).getByRole('button', { name: 'Register', exact: true }).click();
    await expect(statusRegion(a).getByText("You're in.").first()).toBeVisible();
    await expect(statusRegion(a).getByText('Your group: you + 1 guest')).toBeVisible();
    await expect(panel(a).getByText('1 of 3 places left')).toBeVisible();
    await scan(a, 'session page, registered');

    // ===== 2. A party of three cannot fit in the one place left: it is predicted, then confirmed, as the waitlist
    const b = await personPage(browser);
    await signIn(b, group);
    await b.goto(sessionUrl(scene, session));
    await panel(b).getByLabel('Me + 2 guests').check();
    await fillGuest(b, 1, { sex: 'Male', skill: 'Beginner', name: 'Hemi' });
    await fillGuest(b, 2, { sex: 'Female', skill: 'Advanced' });
    await expect(
      panel(b).getByText(
        "This group goes on the waitlist. You're only charged if you get a place.",
      ),
    ).toBeVisible();
    await scan(b, 'session page, register form with two guests');
    await panel(b).getByRole('button', { name: 'Join waitlist', exact: true }).click();
    await expect(
      statusRegion(b)
        .getByText(/You're on the waitlist \(#1\)/)
        .first(),
    ).toBeVisible();
    await expect(statusRegion(b).getByText("You're first in line.")).toBeVisible();
    await expect(statusRegion(b).getByText('Your group: you + 2 guests')).toBeVisible();
    await expect(statusRegion(b).getByText('Guest 1: Hemi, Male, Beginner')).toBeVisible();
    await scan(b, 'session page, waitlisted with guests');

    // ===== 3. Player A withdraws the whole pair before the deadline; the waitlisted party is promoted
    const confirm = await openWithdraw(a, 'Withdraw from this session');
    await expect(
      confirm.getByText(/This withdraws your whole group \(you and 1 guest\)/),
    ).toBeVisible();
    await scan(a, 'withdraw confirmation');
    await confirm.getByRole('button', { name: 'Withdraw', exact: true }).click();
    await expect(
      statusRegion(a).getByText("You've withdrawn. You won't be charged.").first(),
    ).toBeVisible();
    await expect(statusRegion(a).getByText(/You withdrew from this session/)).toBeVisible();
    await scan(a, 'session page, withdrawn');

    // ===== 4. The promoted player sees "You're in." and gets the email
    await b.reload();
    await expect(statusRegion(b).getByText("You're in.").first()).toBeVisible();
    await expect(statusRegion(b).getByText(/You were moved off the waitlist on/)).toBeVisible();
    await expect(panel(b).getByText('Full · 0 on the waitlist')).toBeVisible();
    await scan(b, 'session page, promoted');
    await waitForEmail(group.email, "You're in:");

    // The withdrawn player now sees a full session (every place taken by the promoted party).
    await a.reload();
    await expect(panel(a).getByText('Full · 0 on the waitlist')).toBeVisible();
    await scan(a, 'session page, full');

    // ===== 5. An admin bans the promoted player; the ban handler withdraws their registration within 30 seconds
    await api(
      'POST',
      `/teams/${scene.teamId}/members/${group.userId}/ban`,
      scene.admin.token,
      {},
      [200],
    );
    await expect
      .poll(() => registrationStatus(session.id, group.userId), {
        timeout: 30_000,
        intervals: [500, 1000, 1000],
        message: 'the banned player registration is withdrawn',
      })
      .toBe('WITHDRAWN');
    await b.reload();
    await expect(b.getByText('You need to be a member of this team to register.')).toBeVisible();
    await scan(b, 'session page, banned player');

    await closePerson(a);
    await closePerson(b);
  });

  test('withdrawing after the deadline spells out the late terms (AC-ERROR-2, R9)', async ({
    browser,
  }) => {
    test.setTimeout(180_000);
    const scene = await newScene();
    const late = await newMember(scene, 'late');
    // Tomorrow's session whose free-cancellation deadline was at the start of today: already passed.
    const session = await publishSession(scene, {
      daysAhead: 1,
      maxPlayers: 6,
      location: `Albany Courts ${unique('l')}`,
      deadline: { date: nzToday(), time: '00:00' },
    });

    const page = await personPage(browser);
    await signIn(page, late);
    await page.goto(sessionUrl(scene, session));
    await expect(
      panel(page)
        .getByRole('listitem')
        .filter({ hasText: /^The free cancellation deadline has passed\.$/ }),
    ).toBeVisible();
    await expect(
      panel(page).getByText(
        'The free cancellation deadline has passed. If you withdraw later you may be charged.',
      ),
    ).toBeVisible();
    await scan(page, 'session page, open after the deadline');
    await panel(page).getByRole('button', { name: 'Register', exact: true }).click();
    await expect(statusRegion(page).getByText("You're in.").first()).toBeVisible();

    const confirm = await openWithdraw(page, 'Withdraw from this session');
    await expect(
      confirm.getByText(/The free cancellation deadline has passed and no one is waiting/),
    ).toBeVisible();
    await scan(page, 'late withdraw confirmation');
    await confirm.getByRole('button', { name: 'Withdraw', exact: true }).click();
    await expect(
      statusRegion(page)
        .getByText(/You've withdrawn/)
        .first(),
    ).toBeVisible();
    await scan(page, 'session page, withdrawn late');
    await closePerson(page);
  });

  test('three overdue payments block registration with the reason in words (AC-ERROR-1)', async ({
    browser,
  }) => {
    test.setTimeout(180_000);
    const scene = await newScene();
    const debtor = await newMember(scene, 'debtor');
    // Three sessions the debtor already played in, each now an OVERDUE payment, and the one they want to join.
    for (let day = 3; day <= 5; day += 1) {
      const earlier = await publishSession(scene, {
        daysAhead: day,
        maxPlayers: 6,
        location: `Past Hall ${unique('l')}`,
      });
      await api(
        'POST',
        `/teams/${scene.teamId}/sessions/${earlier.id}/registrations`,
        debtor.token,
        { guests: [] },
      );
    }
    expect(await makeOverdue(debtor.userId)).toBe(3);
    const session = await publishSession(scene, {
      daysAhead: 8,
      maxPlayers: 6,
      location: `Blocked Hall ${unique('l')}`,
    });

    const page = await personPage(browser);
    await signIn(page, debtor);
    await page.goto(sessionUrl(scene, session));
    await expect(
      statusRegion(page).getByText(/You have 3 overdue payments across your teams\./),
    ).toBeVisible();
    await expect(
      statusRegion(page).getByText('If you think this is wrong, ask your team admin.', {
        exact: false,
      }),
    ).toBeVisible();
    await expect(panel(page).getByRole('button', { name: /Register|Join waitlist/ })).toHaveCount(
      0,
    );
    await scan(page, 'session page, debt block');
    await closePerson(page);
  });

  test('a cancelled session is closed to registration (AC-ERROR-2)', async ({ browser }) => {
    test.setTimeout(180_000);
    const scene = await newScene();
    const player = await newMember(scene, 'cancelled');
    const session = await publishSession(scene, {
      daysAhead: 6,
      maxPlayers: 6,
      location: `Cancelled Hall ${unique('l')}`,
    });
    await api('POST', `/teams/${scene.teamId}/sessions/${session.id}/cancel`, scene.admin.token, {
      expectedVersion: session.version,
    });

    const page = await personPage(browser);
    await signIn(page, player);
    await page.goto(sessionUrl(scene, session));
    await expect(statusRegion(page).getByText('This session has been cancelled.')).toBeVisible();
    await expect(panel(page).getByRole('button', { name: /Register|Join waitlist/ })).toHaveCount(
      0,
    );
    await scan(page, 'session page, cancelled');
    await closePerson(page);
  });
});
