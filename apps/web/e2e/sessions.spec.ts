/**
 * The admin Sessions journey in a real browser (AC-INTEGRATION-3) with axe scans, the court-row semantics and the
 * 360 px pass (AC-VERIFY-8), run on a desktop and a 360 x 740 project against the Compose stack with the worker
 * running (the materialiser and the publish retry are worker jobs) and Mailpit. Not part of `pnpm run ci`.
 *
 *   AUTH_FAKE_OAUTH=true docker compose up -d --build --wait && pnpm run test:e2e apps/web/e2e/sessions.spec.ts
 *
 * Database assertions read the stack's Postgres with `E2E_DATABASE_URL` (default `postgres://sgm:sgm@localhost:5432/sgm`,
 * the Compose database). Sessions are created through the admin UI only; nothing is seeded, so this run is the
 * "a PUBLISHED session seeded through the session-scheduling-engine admin flow" path registration-and-waitlist's E2E
 * can copy. Dates are relative to today in Pacific/Auckland, so the run does not go stale.
 */
import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { createRequire } from 'node:module';
import { promisify } from 'node:util';
import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Locator, type Page } from '@playwright/test';

const PASSWORD = 'kowhai-court-27';
const DATABASE_URL = process.env.E2E_DATABASE_URL ?? 'postgres://sgm:sgm@localhost:5432/sgm';
const MAILPIT_API_URL = process.env.MAILPIT_API_URL ?? 'http://localhost:8025';
const ACCOUNT = '01-0902-0068389-00';

// ---------------------------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------------------------

let counter = 0;
function unique(tag: string): string {
  counter += 1;
  return `${tag}-${Date.now().toString(36)}${counter}${randomBytes(2).toString('hex')}`;
}

async function register(page: Page, fullName: string, email: string): Promise<void> {
  await page.goto('/register');
  await page.getByLabel('Full name').fill(fullName);
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password', { exact: true }).fill(PASSWORD);
  await page.getByLabel('Female').check();
  await page.getByRole('button', { name: 'Create account' }).click();
  await page.waitForURL((url) => url.pathname === '/');
}

async function createTeam(page: Page, name: string): Promise<string> {
  await page.goto('/teams/new');
  await page.getByLabel('Team name').fill(name);
  await page.getByLabel('Public', { exact: true }).check();
  await page.getByLabel('Intermediate', { exact: true }).check();
  await page.getByRole('button', { name: 'Create team' }).click();
  await page.waitForURL(/\/teams\/[0-9a-f-]{36}\/manage/);
  const teamId = /\/teams\/([0-9a-f-]{36})\/manage/.exec(page.url())?.[1];
  if (teamId === undefined) throw new Error('team id not found in the manage URL');
  return teamId;
}

/** AC-VERIFY-8: no axe violation of impact critical or serious. */
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

const notice = (page: Page, text: string | RegExp): Locator =>
  page.getByRole('status').filter({ hasText: text });

// ---- Dates (Pacific/Auckland) -----------------------------------------------------------------

function nzToday(): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Pacific/Auckland',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date());
  return parts;
}

function addDays(ymd: string, days: number): string {
  const [y, m, d] = ymd.split('-').map(Number) as [number, number, number];
  return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10);
}

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** `Wed 4 Nov` */
function dayShort(ymd: string): string {
  const [y, m, d] = ymd.split('-').map(Number) as [number, number, number];
  const weekday = new Date(Date.UTC(y, m - 1, d)).getUTCDay();
  return `${WEEKDAYS[weekday]} ${d} ${MONTHS[m - 1]}`;
}

/** `4 Nov 2026` */
function dateLong(ymd: string): string {
  const [y, m, d] = ymd.split('-').map(Number) as [number, number, number];
  return `${d} ${MONTHS[m - 1]} ${y}`;
}

/** The first Sunday on or after `from` in `month` (1-12) of `year`, or the last Sunday when `last`. */
function sundayOf(year: number, month: number, last: boolean): string {
  if (last) {
    const end = new Date(Date.UTC(year, month, 0));
    end.setUTCDate(end.getUTCDate() - end.getUTCDay());
    return end.toISOString().slice(0, 10);
  }
  const start = new Date(Date.UTC(year, month - 1, 1));
  start.setUTCDate(start.getUTCDate() + ((7 - start.getUTCDay()) % 7));
  return start.toISOString().slice(0, 10);
}

/** The next NZ clock-forward day (last Sunday of September, 2:00 am jumps to 3:00 am) after `from`. */
function nextGapDay(from: string): string {
  const year = Number(from.slice(0, 4));
  return [sundayOf(year, 9, true), sundayOf(year + 1, 9, true)].find((day) => day > from) as string;
}

/** The next NZ clock-back day (first Sunday of April, 3:00 am returns to 2:00 am) after `from`. */
function nextOverlapDay(from: string): string {
  const year = Number(from.slice(0, 4));
  return [sundayOf(year, 4, false), sundayOf(year + 1, 4, false)].find(
    (day) => day > from,
  ) as string;
}

// ---- Database ----------------------------------------------------------------------------------

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

interface SessionRow {
  id: string;
  date: string;
  status: string;
  overridden: boolean;
  deadlineIsDefault: boolean;
  autoEnrolRequired: boolean;
  maxPlayers: number;
  startsAt: string | null;
  deadline: string;
  customRate: string | null;
  feeFlat: string | null;
  courts: { name: string; start: string; end: string }[];
}

const SESSION_SQL = `
  SELECT g.id, g.date::text AS date, g.status::text AS status,
         g.is_instance_overridden AS overridden, g.deadline_is_default AS "deadlineIsDefault",
         g.auto_enrol_required AS "autoEnrolRequired", g.max_players AS "maxPlayers",
         g.starts_at AS "startsAt", g.cancellation_deadline AS deadline,
         g.custom_player_rate::text AS "customRate", g.fee_flat::text AS "feeFlat",
         COALESCE((SELECT json_agg(json_build_object('name', c.court_identifier,
                                                      'start', to_char(c.start_time, 'HH24:MI'),
                                                      'end', to_char(c.end_time, 'HH24:MI'))
                                   ORDER BY c.court_identifier)
                     FROM session_courts c WHERE c.session_id = g.id), '[]'::json) AS courts
    FROM game_sessions g`;

async function seriesSessions(ruleId: string): Promise<SessionRow[]> {
  return withDb(async (db) => {
    const result = await db.query(`${SESSION_SQL} WHERE g.recurring_rule_id = $1 ORDER BY g.date`, [
      ruleId,
    ]);
    return result.rows as unknown as SessionRow[];
  });
}

async function teamSessions(teamId: string): Promise<SessionRow[]> {
  return withDb(async (db) => {
    const result = await db.query(
      `${SESSION_SQL} WHERE g.team_id = $1 AND g.recurring_rule_id IS NULL ORDER BY g.date`,
      [teamId],
    );
    return result.rows as unknown as SessionRow[];
  });
}

// ---- Mailpit -----------------------------------------------------------------------------------

async function waitForEmail(to: string, subject: string): Promise<void> {
  await expect
    .poll(
      async () => {
        const search = await fetch(
          `${MAILPIT_API_URL}/api/v1/search?query=${encodeURIComponent(`to:${to}`)}`,
        );
        const body = (await search.json()) as { messages?: { Subject: string }[] };
        return (body.messages ?? []).some((message) => message.Subject === subject);
      },
      { timeout: 45_000, intervals: [500, 1000, 1000], message: `email "${subject}" to ${to}` },
    )
    .toBe(true);
}

// ---- Worker ------------------------------------------------------------------------------------

/** `docker compose pause|unpause worker`; override the compose command with `E2E_COMPOSE_COMMAND`. */
async function workerCompose(action: 'pause' | 'unpause'): Promise<void> {
  const [file = 'docker', ...base] = (process.env.E2E_COMPOSE_COMMAND ?? 'docker compose').split(
    ' ',
  );
  await promisify(execFile)(file, [...base, action, 'worker'], { timeout: 30_000 });
}

// ---- Form helpers ------------------------------------------------------------------------------

const courtGroups = (page: Page): Locator =>
  page
    .locator('#field-courts')
    .getByRole('group')
    .filter({ has: page.getByLabel('Court name') });

async function fillCommonFields(
  page: Page,
  input: { location: string; address: string; maxPlayers: string; courtHire: string },
): Promise<void> {
  await page.getByLabel('Location', { exact: true }).fill(input.location);
  await page.getByLabel('Address', { exact: true }).fill(input.address);
  await page.getByLabel('Max players').fill(input.maxPlayers);
  await page.getByLabel('Court hire (total)').fill(input.courtHire);
}

/** Sets the default times, the number of courts (Enter must not submit) and applies the defaults to every row. */
async function setUpCourts(
  page: Page,
  count: number,
  start: string,
  end: string,
  pathPattern: RegExp,
): Promise<void> {
  await page.getByLabel('Default start').fill(start);
  await page.getByLabel('Default end').fill(end);
  const countInput = page.getByLabel('Number of courts');
  await countInput.fill(String(count));
  await countInput.press('Enter');
  // Enter in "Number of courts" commits the count and never submits the form.
  await expect(courtGroups(page)).toHaveCount(count);
  await expect(page).toHaveURL(pathPattern);
  await expect(page.getByText("There's a problem")).toHaveCount(0);
  await page.getByRole('button', { name: 'Apply to all courts' }).click();
  // One polite live region for the court table, announcing how many courts changed.
  const live = page.locator('#field-courts [role=status][aria-live=polite]');
  await expect(live).toHaveCount(1);
  await expect(live).toHaveText(`Times applied to ${count} courts.`);
  // ... and it is the only polite live region inside the form.
  await expect(page.locator('form [aria-live=polite]')).toHaveCount(1);
}

/** Every court row is a group named by its court, with labelled start and end inputs (AC-VERIFY-8). */
async function expectCourtRowsSemantic(page: Page, names: string[]): Promise<void> {
  for (const name of names) {
    const row = page.locator('#field-courts').getByRole('group', { name, exact: true });
    await expect(row, `court row group "${name}"`).toHaveCount(1);
    await expect(row.getByLabel(`${name} start`, { exact: true })).toHaveCount(1);
    await expect(row.getByLabel(`${name} end`, { exact: true })).toHaveCount(1);
  }
}

/** No Sessions confirm panel has a dismiss button named "Cancel" (it would sit beside "Cancel session"). */
async function expectNoCancelDismiss(panel: Locator): Promise<void> {
  await expect(panel.getByRole('button', { name: 'Cancel', exact: true })).toHaveCount(0);
}

/**
 * The confirm panel contract (UI/UX "Interactions"): opening moves focus to the prompt, Escape closes it and returns
 * focus to its trigger, and the trigger's aria-expanded follows. Leaves the panel closed.
 */
async function expectEscapeReturnsFocus(
  trigger: Locator,
  panel: Locator,
  prompt: string | RegExp,
): Promise<void> {
  await trigger.click();
  await expect(trigger).toHaveAttribute('aria-expanded', 'true');
  await expect(panel.getByText(prompt)).toBeFocused();
  await trigger.page().keyboard.press('Escape');
  await expect(panel).toHaveCount(0);
  await expect(trigger).toBeFocused();
  await expect(trigger).toHaveAttribute('aria-expanded', 'false');
}

/** Reloads until `check` passes (the worker adds and publishes sessions asynchronously). */
async function reloadUntil(
  page: Page,
  label: string,
  check: () => Promise<boolean>,
): Promise<void> {
  await expect
    .poll(
      async () => {
        if (await check()) return true;
        await page.reload();
        return check();
      },
      { timeout: 60_000, intervals: [1000, 2000, 2000], message: label },
    )
    .toBe(true);
}

const instanceRow = (page: Page, date: string): Locator =>
  page
    .getByRole('listitem')
    .filter({ has: page.getByRole('link', { name: `Edit ${dayShort(date)}`, exact: true }) });

// ---------------------------------------------------------------------------------------------
// The journey
// ---------------------------------------------------------------------------------------------

test.describe('admin sessions', () => {
  // Never leave the stack's worker frozen when a run fails between pause and unpause.
  test.afterEach(async () => {
    await workerCompose('unpause').catch(() => undefined);
  });

  test('a team admin sets up, edits and publishes sessions end to end (AC-INTEGRATION-3, AC-VERIFY-8)', async ({
    page,
  }) => {
    test.setTimeout(600_000);
    // A stuck step fails in half a minute instead of eating the whole journey budget.
    page.setDefaultTimeout(30_000);
    page.setDefaultNavigationTimeout(30_000);
    const dialogs: string[] = [];
    page.on('dialog', (dialog) => {
      dialogs.push(`${dialog.type()}: ${dialog.message()}`);
      void dialog.dismiss();
    });

    const admin = { fullName: 'Aroha Ngata', email: `e2e-${unique('sessions')}@example.test` };
    const teamName = `E2E Sessions ${unique('t')}`;
    await register(page, admin.fullName, admin.email);
    const teamId = await createTeam(page, teamName);

    const today = nzToday();
    // The series began last week (the confirm's "Last date" then opens on today, and ending it today ends it);
    // its first date still to come is three days away, the same weekday.
    const startsOn = addDays(today, -4);
    const firstDate = addDays(today, 3);
    const seriesName = new RegExp(
      '^(Mondays|Tuesdays|Wednesdays|Thursdays|Fridays|Saturdays|Sundays) at ',
    );

    // ===== 1. From the manage nav open Sessions; create a 3-court weekly paid series through the create confirm
    const nav = page.getByRole('navigation', { name: 'Team admin areas' });
    await nav.getByRole('link', { name: 'Sessions' }).click();
    await page.waitForURL(new RegExp(`/teams/${teamId}/manage/sessions$`));
    await expect(page).toHaveTitle(`Sessions – ${teamName} – Shared Game Management`);
    await expect(page.getByRole('heading', { level: 1 })).toHaveText(`Sessions for ${teamName}`);
    await expect(page.getByText('No recurring series yet.')).toBeVisible();
    await scan(page, 'list (empty)');

    await page.getByRole('link', { name: 'New recurring series' }).click();
    await page.waitForURL(/\/manage\/sessions\/series\/new$/);
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('New recurring series');
    const seriesNewPattern = /\/manage\/sessions\/series\/new$/;

    await page.getByRole('radio', { name: 'Weekly', exact: true }).check();
    await page.getByLabel('First session').fill(startsOn);
    await fillCommonFields(page, {
      location: 'Rosedale Hall',
      address: '1 Hall Road, Albany',
      maxPlayers: '12',
      courtHire: '90',
    });
    await setUpCourts(page, 3, '19:00', '21:00', seriesNewPattern);
    // Court 3 ends an hour early (the per-court override), shown as "Not default".
    await page.getByLabel('Court 3 end', { exact: true }).fill('20:00');
    await expectCourtRowsSemantic(page, ['Court 1', 'Court 2', 'Court 3']);
    await expect(
      page.locator('#field-courts').getByText('Not default', { exact: true }),
    ).toHaveCount(1);
    await expect(page.getByText('3 courts. 2 use the default times.')).toBeVisible();
    await expect(
      page.getByText('Suggested rate: $8.00 per player.', { exact: false }),
    ).toBeVisible();
    await scan(page, 'series form (new)');

    // The create confirm: a disclosure, prompt focused, no "Cancel" dismiss, Escape returns focus.
    const createTrigger = page.locator('button[aria-controls=create-series-panel]');
    const createPanel = page.locator('#create-series-panel');
    await expectEscapeReturnsFocus(createTrigger, createPanel, /^Create this series\?/);
    await createTrigger.click();
    await expect(createPanel.getByText(/^Create this series\?/)).toContainText(
      `Sessions from ${dayShort(startsOn)} are added now and published for registration.`,
    );
    await expect(createPanel.getByText(/^Create this series\?/)).toContainText(
      "Your team's bank account isn't set up, so the sessions will be saved as drafts until it is.",
    );
    await expect(createPanel.getByText(/^Create this series\?/)).toContainText(
      'Each player is charged after the game: $8.00 each.',
    );
    await expectNoCancelDismiss(createPanel);
    await expect(createPanel.getByRole('button', { name: 'Keep editing' })).toBeVisible();
    await scan(page, 'series form (create confirm open)');
    // The worker is paused only while the "adding sessions" states are checked, so they are observable; it is
    // resumed straight after and does the real work (materialise, notify) for the rest of the journey.
    await workerCompose('pause');
    await createPanel.getByRole('button', { name: 'Create series', exact: true }).click();

    // ===== 2. The waiting line, then drafts "Draft · bank account needed", the S2b notice and the admin email
    await page.waitForURL(/\/manage\/sessions\/series\/[0-9a-f-]{36}$/);
    const ruleId = /\/series\/([0-9a-f-]{36})/.exec(page.url())?.[1] as string;
    const seriesUrl = page.url();
    await expect(page.getByRole('heading', { level: 1 })).toHaveText(seriesName);
    await expect(notice(page, 'Series created.')).toBeVisible();
    await expect(
      notice(page, "We're adding the sessions in this series. Refresh in a moment."),
    ).toBeVisible();
    await scan(page, 'series page (waiting)');

    // The list shows the same series as "Adding sessions…" while the worker has not run yet.
    await page
      .getByRole('navigation', { name: 'Team admin areas' })
      .getByRole('link', { name: 'Sessions' })
      .click();
    await page.waitForURL(new RegExp(`/teams/${teamId}/manage/sessions$`));
    await expect(
      page.getByRole('region', { name: 'Series' }).getByText('Adding sessions…'),
    ).toBeVisible();
    await scan(page, 'list (series adding sessions)');
    await workerCompose('unpause');

    await page.goto(`/teams/${teamId}/manage/sessions/series/${ruleId}`);
    const draftLabel = page.getByText('Draft · bank account needed', { exact: true }).first();
    await reloadUntil(page, 'drafts appear on the series page', () => draftLabel.isVisible());
    const rows = await seriesSessions(ruleId);
    const total = rows.length;
    expect(total, 'the horizon adds more than two dates').toBeGreaterThan(2);
    expect(rows.map((row) => row.date)[0]).toBe(firstDate);
    for (const row of rows) {
      expect(row.status, `${row.date} is a draft (no banking)`).toBe('DRAFT');
      expect(row.overridden).toBe(false);
      expect(row.deadlineIsDefault).toBe(true);
      expect(row.autoEnrolRequired).toBe(true);
      expect(row.courts).toEqual([
        { name: 'Court 1', start: '19:00', end: '21:00' },
        { name: 'Court 2', start: '19:00', end: '21:00' },
        { name: 'Court 3', start: '19:00', end: '20:00' },
      ]);
    }
    await expect(page.getByText('Draft · bank account needed', { exact: true })).toHaveCount(total);
    await expect(
      page.getByText(
        `${total} sessions in this series were saved as drafts because your team's bank account isn't set up. Members can't register for them yet.`,
      ),
    ).toBeVisible();
    await expect(page.getByRole('link', { name: 'Set up banking and GST' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Publish drafts now' })).toHaveCount(0);
    await scan(page, 'series page (bank account needed)');
    await waitForEmail(admin.email, `Sessions not published for ${teamName}: bank account needed`);

    // The list now carries the page-level banking notice and the series row.
    await page.goto(`/teams/${teamId}/manage/sessions`);
    await expect(
      page.getByText(
        "Some sessions weren't published because your team's bank account isn't set up.",
      ),
    ).toBeVisible();
    await expect(page.getByRole('region', { name: 'Series' }).getByText('Active')).toBeVisible();
    await scan(page, 'list (drafts, banking notice)');
    await page.goto(seriesUrl);

    // ===== 3. "Set up banking and GST" from the series page, save banking, "Back to your session"
    await page.getByRole('link', { name: 'Set up banking and GST' }).click();
    await page.waitForURL(/\/manage\/banking/);
    await page.getByLabel('Account name').fill('Rosedale Badminton Club');
    await page.getByLabel('Account number').fill(ACCOUNT);
    await page.getByRole('button', { name: 'Save banking details' }).click();
    await expect(
      notice(page, 'Banking details saved. Paid sessions can now be published.'),
    ).toBeVisible();
    await page.getByRole('link', { name: 'Back to your session' }).click();
    await page.waitForURL(new RegExp(`/series/${ruleId}(\\?.*)?$`));

    // ===== 4. The S2r notice, "Publish drafts now", then every date "Published"
    await expect(
      page.getByText(
        `Your bank account is set up. ${total} sessions in this series are still drafts. They'll be published automatically overnight, or you can publish them now.`,
      ),
    ).toBeVisible();
    await expect(page.getByText('Draft · publishes overnight', { exact: true })).toHaveCount(total);
    await scan(page, 'series page (banking set up, drafts waiting)');
    await page.getByRole('button', { name: 'Publish drafts now' }).click();
    await expect(
      notice(page, "We're publishing the drafts in this series. Refresh in a moment."),
    ).toBeVisible();
    const published = page.getByText('Published', { exact: true });
    await reloadUntil(
      page,
      'every date is published',
      async () => (await published.count()) === total,
    );
    await expect(page.getByText(/^Draft ·/)).toHaveCount(0);
    for (const row of await seriesSessions(ruleId)) {
      expect(row.status, `${row.date} is published`).toBe('PUBLISHED');
      expect(row.overridden).toBe(false);
      expect(row.deadlineIsDefault).toBe(true);
      expect(row.autoEnrolRequired).toBe(true);
      expect(row.courts).toHaveLength(3);
    }
    await scan(page, 'series page (published)');

    // ===== 5. Edit one date's capacity and see it marked "Edited"
    const editedDate = firstDate;
    await page.getByRole('link', { name: `Edit ${dayShort(editedDate)}`, exact: true }).click();
    await page.waitForURL(/\/manage\/sessions\/[0-9a-f-]{36}$/);
    const editedSessionUrl = page.url();
    await expect(page.getByRole('heading', { level: 1 })).toHaveText(
      `Rosedale Hall, ${dayShort(editedDate)} ${editedDate.slice(0, 4)}`,
    );
    await expect(page.getByText(/^One date in .*Changes here apply to .* only\./)).toBeVisible();
    await expect(page.getByText('Published. Members can register.', { exact: true })).toBeVisible();
    await expect(page.getByText('No one has registered yet.')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Save changes' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Save draft' })).toHaveCount(0);
    await expectCourtRowsSemantic(page, ['Court 1', 'Court 2', 'Court 3']);
    await scan(page, 'session editor (published series date)');
    await page.getByLabel('Max players').fill('10');
    await page.getByRole('button', { name: 'Save changes' }).click();
    await expect(
      notice(page, `Changes saved for ${dayShort(editedDate)}. This date is now marked Edited.`),
    ).toBeVisible();
    await expect(
      page.getByText(
        /^Edited\. This date has its own details, so changes to .* don't apply to it\./,
      ),
    ).toBeVisible();
    await page.getByRole('link', { name: /^‹ Back to / }).click();
    await page.waitForURL(new RegExp(`/series/${ruleId}(\\?.*)?$`));
    await expect(instanceRow(page, editedDate).getByText('Edited', { exact: true })).toBeVisible();
    await expect(page.getByText('Edited', { exact: true })).toHaveCount(1);
    {
      const rowsNow = await seriesSessions(ruleId);
      const edited = rowsNow.find((row) => row.date === editedDate);
      expect(edited?.overridden).toBe(true);
      expect(edited?.maxPlayers).toBe(10);
      expect(edited?.status).toBe('PUBLISHED');
      for (const row of rowsNow.filter((candidate) => candidate.date !== editedDate)) {
        expect(row.overridden, `${row.date} is not edited`).toBe(false);
        expect(row.maxPlayers).toBe(12);
      }
    }

    // ===== 6. Change the series start time: "… 1 edited session kept its own details."
    await page.getByRole('link', { name: 'Change series details' }).click();
    await page.waitForURL(/\?edit=details/);
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('Change series details');
    for (const court of ['Court 1', 'Court 2', 'Court 3']) {
      await page.getByLabel(`${court} start`, { exact: true }).fill('19:30');
    }
    await expect(
      page.getByText(
        `Your changes will apply to ${total - 1} upcoming sessions and to sessions added later. 1 edited session keeps its own details.`,
        { exact: false },
      ),
    ).toBeVisible();
    await scan(page, 'series form (edit, effect line)');
    await page.getByRole('button', { name: 'Save series' }).click();
    await page.waitForURL(new RegExp(`/series/${ruleId}(\\?.*)?$`));
    await expect(
      notice(page, `Series saved. ${total - 1} upcoming sessions updated.`),
    ).toBeVisible();
    await expect(notice(page, '1 edited session kept its own details.')).toBeVisible();
    await scan(page, 'series page (series saved)');
    {
      const rowsNow = await seriesSessions(ruleId);
      for (const row of rowsNow) {
        const start = row.date === editedDate ? '19:00' : '19:30';
        expect(
          row.courts.map((court) => court.start),
          `${row.date} court starts`,
        ).toEqual([start, start, start]);
        expect(row.courts[2]?.end).toBe('20:00');
        expect(row.status).toBe('PUBLISHED');
      }
    }

    // ===== 7. Cancel one date: "Session cancelled. No one had registered."
    const rowsBeforeCancel = await seriesSessions(ruleId);
    const cancelledDate = rowsBeforeCancel[rowsBeforeCancel.length - 1]?.date as string;
    await page.getByRole('link', { name: `Edit ${dayShort(cancelledDate)}`, exact: true }).click();
    await page.waitForURL(/\/manage\/sessions\/[0-9a-f-]{36}$/);
    const cancelledSessionUrl = page.url();
    const cancelTrigger = page.locator('button[aria-controls=cancel-session-panel]');
    const cancelPanel = page.locator('#cancel-session-panel');
    await expectEscapeReturnsFocus(cancelTrigger, cancelPanel, /^Cancel this session\?/);
    await cancelTrigger.click();
    await expect(cancelPanel.getByText(/^Cancel this session\?/)).toContainText(
      "No one has registered yet. You can't undo this. The series won't add this date again.",
    );
    await expectNoCancelDismiss(cancelPanel);
    await expect(cancelPanel.getByRole('button', { name: 'Keep session' })).toBeVisible();
    await scan(page, 'session editor (cancel confirm open)');
    await cancelPanel.getByRole('button', { name: 'Cancel session', exact: true }).click();
    await expect(notice(page, 'Session cancelled.')).toBeVisible();
    await expect(notice(page, 'No one had registered.')).toBeVisible();
    // The cancelled date is now a read-only summary (no inputs, no Save, no Cancel).
    await expect(
      page.getByText("This session was cancelled, so it can't be changed."),
    ).toBeVisible();
    await expect(page.getByRole('button', { name: /Save|Publish|Cancel/ })).toHaveCount(0);
    await expect(page.getByRole('table')).toBeVisible();
    await scan(page, 'session editor (read-only, cancelled)');
    {
      const rowsNow = await seriesSessions(ruleId);
      expect(rowsNow.find((row) => row.date === cancelledDate)?.status).toBe('CANCELLED');
      expect(rowsNow.filter((row) => row.status === 'PUBLISHED')).toHaveLength(total - 1);
    }
    await page.goto(seriesUrl);
    await expect(
      page.getByRole('link', { name: `Edit ${dayShort(cancelledDate)}`, exact: true }),
    ).toHaveCount(0);
    await scan(page, 'series page (a date cancelled)');

    // ===== 8. A one-off with 9 courts (Court 7 ends early), a DST choice, rate pin and unpin, save a draft
    await page.goto(`/teams/${teamId}/manage/sessions`);
    await scan(page, 'list (published, edited, cancelled)');
    await page.getByRole('link', { name: 'New session', exact: true }).click();
    await page.waitForURL(/\/manage\/sessions\/new$/);
    const newSessionPattern = /\/manage\/sessions\/new$/;
    const gapDay = nextGapDay(today);
    const overlapDay = nextOverlapDay(today);
    await fillCommonFields(page, {
      location: 'Greenhithe Hall',
      address: '2 School Road, Greenhithe',
      maxPlayers: '18',
      courtHire: '135',
    });
    await page.getByLabel('Date', { exact: true }).fill(overlapDay);
    await setUpCourts(page, 9, '19:00', '21:00', newSessionPattern);
    await page.getByLabel('Court 7 end', { exact: true }).fill('20:00');
    await expectCourtRowsSemantic(
      page,
      Array.from({ length: 9 }, (_, index) => `Court ${index + 1}`),
    );
    await expect(page.getByText('9 courts. 8 use the default times.')).toBeVisible();
    await scan(page, 'session editor (new, 9 courts)');

    // DST overlap (clocks go back): a court takes the first 2:30 am; the choice is a labelled group.
    await page.getByLabel('Court 1 start', { exact: true }).fill('02:30');
    await page.getByRole('button', { name: 'Save draft' }).click();
    const overlap = page.getByRole('group', {
      name: new RegExp(`^2:30 am happens twice on .*, because clocks go back an hour at 3 am\\.`),
    });
    await expect(overlap).toBeVisible();
    await expect(overlap.getByRole('button')).toHaveCount(1);
    await expect(
      overlap.getByRole('button', { name: /^Use the first 2:30 am \(NZDT\)$/ }),
    ).toBeVisible();
    await expect(page.getByLabel('Court 1 start', { exact: true })).toHaveAccessibleDescription(
      /happens twice/,
    );
    await scan(page, 'session editor (DST overlap choice)');

    // DST gap (clocks go forward): 2:30 am does not exist; resolve it with a button.
    await page.getByLabel('Date', { exact: true }).fill(gapDay);
    await page.getByRole('button', { name: 'Save draft' }).click();
    const gap = page.getByRole('group', {
      name: /^2:30 am doesn't happen on .*, because clocks go forward an hour at 2 am\.$/,
    });
    await expect(gap).toBeVisible();
    await expect(gap.getByRole('button')).toHaveCount(2);
    await scan(page, 'session editor (DST gap choice)');
    await gap.getByRole('button', { name: /^Use 3:30 am$/ }).click();
    await expect(gap).toHaveCount(0);
    await expect(page.getByLabel('Court 1 start', { exact: true })).toHaveValue('03:30');
    await expect(
      page.locator('[role=status][aria-live=polite]').filter({
        hasText: 'Court 1 start set to 3:30 am. Save again to apply.',
      }),
    ).toHaveCount(1);

    // Rate follow, pin and unpin.
    const rate = page.getByLabel('Rate per player');
    await expect(rate).toHaveValue('8.00');
    await expect(
      page.getByText('Following the suggested rate. It changes when costs or max players change.'),
    ).toBeVisible();
    await scan(page, 'session editor (rate following)');
    await rate.fill('9.50');
    await expect(page.getByText("Custom rate. It won't change when costs change.")).toBeVisible();
    await scan(page, 'session editor (rate pinned)');
    await page.getByRole('button', { name: 'Use suggested rate' }).click();
    await expect(
      page.getByText('Following the suggested rate. It changes when costs or max players change.'),
    ).toBeVisible();
    await expect(rate).toHaveValue('8.00');
    await expect(rate).toBeFocused();

    // Save the draft.
    await page.getByRole('button', { name: 'Save draft' }).click();
    await page.waitForURL(/\/manage\/sessions\/[0-9a-f-]{36}$/);
    const draftUrl = page.url();
    await expect(notice(page, 'Draft saved.')).toBeVisible();
    await expect(
      page.getByText("Draft. Members can't see it until you publish it.", { exact: true }),
    ).toBeVisible();
    await expect(
      page.getByText(
        'One-off session. When you publish it, members on Auto Enroll are added to it.',
      ),
    ).toBeVisible();
    {
      const oneOffs = await teamSessions(teamId);
      expect(oneOffs).toHaveLength(1);
      const draft = oneOffs[0] as SessionRow;
      expect(draft.status).toBe('DRAFT');
      expect(draft.date).toBe(gapDay);
      expect(draft.overridden).toBe(false);
      expect(draft.deadlineIsDefault).toBe(true);
      expect(draft.autoEnrolRequired).toBe(true);
      expect(draft.customRate).toBeNull();
      expect(draft.courts).toHaveLength(9);
      expect(draft.courts.find((court) => court.name === 'Court 7')).toEqual({
        name: 'Court 7',
        start: '19:00',
        end: '20:00',
      });
      expect(draft.courts.find((court) => court.name === 'Court 1')?.start).toBe('03:30');
      expect(draft.courts.filter((court) => court.end === '21:00')).toHaveLength(8);
    }
    await scan(page, 'session editor (draft)');

    // The publish confirm (paid session, banking set up): focus, Escape, no "Cancel", axe. It is not confirmed.
    const publishTrigger = page.locator('button[aria-controls=publish-panel]');
    const publishPanel = page.locator('#publish-panel');
    await expectEscapeReturnsFocus(publishTrigger, publishPanel, /^Publish this session\?/);
    await publishTrigger.click();
    await expect(publishPanel.getByText(/^Publish this session\?/)).toContainText(
      'each player is charged after the game: $8.00 each',
    );
    await expectNoCancelDismiss(publishPanel);
    await expect(publishPanel.getByRole('button', { name: 'Keep editing' })).toBeVisible();
    await scan(page, 'session editor (publish confirm open)');
    await publishPanel.getByRole('button', { name: 'Keep editing' }).click();
    await expect(publishPanel).toHaveCount(0);
    await expect(publishTrigger).toBeFocused();

    // ===== The 360 px pass over every Sessions page and confirm (explicit 360 x 740 on both projects)
    const original = page.viewportSize();
    await page.setViewportSize({ width: 360, height: 740 });
    {
      const walk: [string, string][] = [
        [`/teams/${teamId}/manage/sessions`, 'list'],
        [`/teams/${teamId}/manage/sessions/new`, 'new session'],
        [`/teams/${teamId}/manage/sessions/series/new`, 'new series'],
        [seriesUrl, 'series page'],
        [`${seriesUrl}?edit=details`, 'series edit'],
        [editedSessionUrl, 'published editor'],
        [cancelledSessionUrl, 'read-only summary'],
        [draftUrl, 'draft editor'],
      ];
      for (const [url, label] of walk) {
        await page.goto(url);
        await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
        await scan(page, `360 px: ${label}`);
        const width = await page.evaluate(() => window.innerWidth);
        expect(width, `${label}: the pass really runs at 360 px`).toBe(360);
      }
      // The states with the most width pressure: 9 court rows with a DST choice, the confirms and End series.
      await page.goto(draftUrl);
      await page.getByLabel('Court 2 start', { exact: true }).fill('02:30');
      await page.getByLabel('Date', { exact: true }).fill(gapDay);
      await page.getByRole('button', { name: 'Save draft' }).click();
      await expect(page.getByRole('group', { name: /^2:30 am doesn't happen on / })).toBeVisible();
      await scan(page, '360 px: draft editor with a DST choice');
      await page.locator('button[aria-controls=publish-panel]').click();
      await expect(page.locator('#publish-panel')).toBeVisible();
      await scan(page, '360 px: publish confirm');
      await page.goto(`/teams/${teamId}/manage/sessions/series/new`);
      await page.locator('button[aria-controls=create-series-panel]').click();
      await expect(page.locator('#create-series-panel')).toBeVisible();
      await scan(page, '360 px: create confirm');
      const rowsNow = await seriesSessions(ruleId);
      const openDate = rowsNow.find((row) => row.status === 'PUBLISHED')?.date as string;
      await page.goto(seriesUrl);
      await page.getByRole('link', { name: `Edit ${dayShort(openDate)}`, exact: true }).click();
      await page.locator('button[aria-controls=cancel-session-panel]').click();
      await expect(page.locator('#cancel-session-panel')).toBeVisible();
      await scan(page, '360 px: cancel confirm');
    }
    if (original !== null) await page.setViewportSize(original);

    // ===== 9. End the series, also cancelling the published sessions after the date
    await page.goto(seriesUrl);
    const lastDate = today;
    const publishedAfter = (await seriesSessions(ruleId)).filter(
      (row) => row.status === 'PUBLISHED' && row.date > lastDate,
    ).length;
    expect(publishedAfter, 'published dates follow the last date').toBeGreaterThan(0);
    const publishedText = `${publishedAfter} published session${publishedAfter === 1 ? '' : 's'}`;
    const endTrigger = page.locator('button[aria-controls=end-series-panel]');
    const endPanel = page.locator('#end-series-panel');
    await expectEscapeReturnsFocus(
      endTrigger,
      endPanel,
      'End this series? No sessions will be added after the last date.',
    );
    await endTrigger.click();
    await expect(endPanel.getByLabel('Last date')).toHaveValue(lastDate);
    await expect(
      endPanel.getByText(`${publishedText} after this date will be kept.`),
    ).toBeVisible();
    await scan(page, 'series page (End series impact, unticked)');
    const alsoCancel = endPanel.getByLabel(`Also cancel the ${publishedText} after this date`);
    await alsoCancel.check();
    await expect(endPanel.getByText(`The ${publishedText} will be cancelled.`)).toBeVisible();
    await expectNoCancelDismiss(endPanel);
    await expect(endPanel.getByRole('button', { name: 'Keep series' })).toBeVisible();
    await scan(page, 'series page (End series impact, cancelling)');
    await endPanel.getByRole('button', { name: 'End series', exact: true }).click();
    await expect(
      notice(page, `Series ended. No new sessions will be added after ${dateLong(lastDate)}.`),
    ).toBeVisible();
    await expect(
      notice(
        page,
        `${publishedAfter} session${publishedAfter === 1 ? '' : 's'} after that date ${publishedAfter === 1 ? 'was' : 'were'} cancelled.`,
      ),
    ).toBeVisible();
    await expect(
      page.getByText(
        `Ended. Last session ${dateLong(lastDate)}. To run it again, create a new series.`,
      ),
    ).toBeVisible();
    {
      const rowsNow = await seriesSessions(ruleId);
      for (const row of rowsNow) {
        expect(row.status, `${row.date} after ending the series`).toBe(
          row.date > lastDate ? 'CANCELLED' : 'PUBLISHED',
        );
      }
      const rule = await withDb((db) =>
        db.query(
          `SELECT recur_until::text AS "recurUntil" FROM recurring_session_rules WHERE id = $1`,
          [ruleId],
        ),
      );
      expect(rule.rows[0]?.recurUntil).toBe(lastDate);
    }
    await scan(page, 'series page (ended)');
    await page.goto(`/teams/${teamId}/manage/sessions`);
    await expect(
      page.getByRole('region', { name: 'Series' }).getByText(`Ended ${dateLong(lastDate)}`),
    ).toBeVisible();
    await scan(page, 'list (series ended)');

    expect(dialogs, 'native browser dialogs opened').toEqual([]);
  });
});
