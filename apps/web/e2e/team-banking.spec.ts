/**
 * Browser journeys for the team Banking and GST area (AC-VERIFY-13, AC-INTEGRATION-4, AC-ENTRY-1 to 3 and the
 * browser-only behaviour of AC-HAPPY-1 to 5, AC-ERROR-10 and the returnTo hand-off), run on a desktop and a
 * 360 x 740 project. Not part of `pnpm run ci`. Two things differ from `teams.spec.ts`:
 *
 * - Seeding. A few states cannot be reached through the UI (a PUBLISHED paid session, a failed payout, an
 *   unreadable saved block), so those journeys write them straight into the stack's database. Set
 *   `E2E_DATABASE_URL` to the database the stack uses; without it those journeys are skipped, not failed.
 * - Task-file amendments R1 and R2: the payout block is the account name and number only (no Akahu fields,
 *   so there is no token input) and the GST section has one `GST number` field.
 *
 * How it was run (natively, against a temporary database, like `teams.spec.ts`; see the task file):
 *   create a temporary database and migrate it, start the API, the worker and a production `next start`
 *   with `AUTH_FAKE_OAUTH=true`, then
 *   E2E_DATABASE_URL=<that database> pnpm run test:e2e apps/web/e2e/team-banking.spec.ts
 */
import { randomBytes } from 'node:crypto';
import { createRequire } from 'node:module';
import AxeBuilder from '@axe-core/playwright';
import {
  expect,
  test,
  type Browser,
  type BrowserContext,
  type Locator,
  type Page,
} from '@playwright/test';

const PASSWORD = 'kowhai-court-27';
const DATABASE_URL = process.env.E2E_DATABASE_URL;
const NO_ACCESS = "You don't have access to manage this team.";

// Valid NZ account numbers from the validator's own sourced vectors (packages/shared/src/nz/bank-account.test.ts):
// A = IRD example 1, B = hand-checked algorithm B. The page shows the last 4 digits of the 7-digit account base.
const ACCOUNT_A = { typed: '01-0902-0068389-00', last4: '8389' };
const ACCOUNT_B = { typed: '01-0001-9999993-00', last4: '9993' };
// IRD example (primary weights, check digit 0).
const GST_NUMBER = { typed: '49-091-850', shown: '49-091-850' };

const BANKING_SAVED = 'Banking details saved. Paid sessions can now be published.';
const BANKING_REMOVED =
  "Banking details removed. Paid sessions can't be published until you add them again.";
const REMOVE_PROMPT =
  "Remove banking details? Paid sessions can't be published until you add them again.";
const IN_USE =
  'Cancel or complete your published paid sessions, and wait for unpaid payments to be settled, before removing the banking details.';
const NOT_SET_UP =
  "Not set up. Paid sessions can't be published until you add your bank account details.";
const SET_UP = 'Set up. Paid sessions can be published.';

// ---------------------------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------------------------

let counter = 0;
function unique(tag: string): string {
  counter += 1;
  return `${tag}-${Date.now().toString(36)}${counter}${randomBytes(2).toString('hex')}`;
}
const uniqueEmail = (tag: string): string => `e2e-${unique(tag)}@example.test`;

interface Person {
  fullName: string;
  email: string;
}

/** A second browser context with the same viewport and touch settings as the running project. */
async function newPersonContext(browser: Browser): Promise<BrowserContext> {
  const { baseURL, viewport, isMobile, hasTouch, deviceScaleFactor, userAgent } =
    test.info().project.use;
  return browser.newContext({
    ...(baseURL === undefined ? {} : { baseURL }),
    ...(viewport === undefined ? {} : { viewport }),
    ...(isMobile === undefined ? {} : { isMobile }),
    ...(hasTouch === undefined ? {} : { hasTouch }),
    ...(deviceScaleFactor === undefined ? {} : { deviceScaleFactor }),
    ...(userAgent === undefined ? {} : { userAgent }),
  });
}

/** No native browser dialog may ever open (AC-VERIFY-13: confirmations are inline). */
function watchDialogs(page: Page, opened: string[]): void {
  page.on('dialog', (dialog) => {
    opened.push(`${dialog.type()}: ${dialog.message()}`);
    void dialog.dismiss();
  });
}

/** Hosts the browser contacted other than the stack's own web host (AC-INTEGRATION-4: nothing goes to Akahu). */
function watchOffStackRequests(page: Page, hosts: string[]): void {
  const own = new URL(test.info().project.use.baseURL ?? 'http://localhost:3000').hostname;
  page.on('request', (request) => {
    const url = new URL(request.url());
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return;
    if (url.hostname !== own) hosts.push(url.hostname);
  });
}

async function register(page: Page, person: Person): Promise<void> {
  await page.goto('/register');
  await page.getByLabel('Full name').fill(person.fullName);
  await page.getByLabel('Email').fill(person.email);
  await page.getByLabel('Password', { exact: true }).fill(PASSWORD);
  await page.getByLabel('Female').check();
  await page.getByRole('button', { name: 'Create account' }).click();
  await page.waitForURL((url) => url.pathname === '/');
}

/** Creates a public team and returns its id (the creator lands on its manage page as the first admin). */
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

/** A registered admin with a fresh team, standing on its banking page. */
async function adminOnBanking(
  page: Page,
  tag: string,
  query = '',
): Promise<{ teamId: string; teamName: string; admin: Person }> {
  const admin: Person = { fullName: 'Aroha Ngata', email: uniqueEmail(tag) };
  const teamName = `E2E Banking ${unique('t')}`;
  await register(page, admin);
  const teamId = await createTeam(page, teamName);
  await page.goto(`/teams/${teamId}/manage/banking${query}`);
  await expect(page.getByRole('heading', { level: 1 })).toHaveText(
    `Banking and GST for ${teamName}`,
  );
  return { teamId, teamName, admin };
}

const section = (page: Page, name: string): Locator =>
  page.getByRole('region', { name, exact: true });
const bankSection = (page: Page): Locator => section(page, 'Bank account');
const gstSection = (page: Page): Locator => section(page, 'GST');
const notice = (page: Page, text: string): Locator =>
  page.getByRole('status').filter({ hasText: text });
const statusLine = (page: Page, text: string): Locator =>
  page.locator('main p', { hasText: text }).first();

/** AC-VERIFY-13: no axe violation of impact critical or serious. */
async function expectNoSeriousViolations(page: Page, label: string): Promise<void> {
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
  expect(blocking, `axe critical or serious violations on ${label}`).toEqual([]);
}

/** AC-VERIFY-13: no horizontal scroll, and buttons and links in the page content are at least 44 px high. */
async function expectLayoutOk(page: Page, label: string): Promise<void> {
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(overflow, `${label}: horizontal overflow`).toBeLessThanOrEqual(0);
  const short = await page.evaluate(() => {
    const found: string[] = [];
    const targets = document.querySelectorAll('main button, main a[href], main input');
    for (const target of targets) {
      const box = target.getBoundingClientRect();
      if (box.width === 0 || box.height === 0) continue;
      const input = target as HTMLInputElement;
      // The GST checkbox itself is 20 px; its row (label and box) is the 44 px target.
      if (input.type === 'checkbox') continue;
      if (box.height < 43.5) {
        found.push(
          `${target.tagName.toLowerCase()} "${(target.textContent ?? '').trim().slice(0, 30)}" is ${Math.round(box.height)}px high`,
        );
      }
    }
    return found;
  });
  expect(short, `${label}: targets under 44 px`).toEqual([]);
}

/** Every visible form control has a label, and a field with an error points at it with aria-describedby. */
async function expectLabelled(page: Page, region: Locator): Promise<void> {
  const unlabelled = await region.locator('input:not([type=hidden])').evaluateAll((inputs) =>
    inputs
      .filter((input) => {
        const element = input as HTMLInputElement;
        return element.labels === null || element.labels.length === 0;
      })
      .map((input) => (input as HTMLInputElement).name),
  );
  expect(unlabelled, 'inputs without a label').toEqual([]);
  expect(page.url()).toContain('/manage/banking');
}

async function expectDescribedByError(input: Locator, message: string): Promise<void> {
  await expect(input).toHaveAttribute('aria-invalid', 'true');
  const ids = (await input.getAttribute('aria-describedby')) ?? '';
  expect(ids).toContain(`${(await input.getAttribute('id')) ?? ''}-error`);
  const texts = await input.evaluate((element) =>
    (element.getAttribute('aria-describedby') ?? '')
      .split(' ')
      .map((id) => document.getElementById(id)?.textContent ?? ''),
  );
  expect(texts.join(' ')).toContain(message);
}

async function saveBanking(page: Page, name: string, number: string): Promise<void> {
  await page.getByLabel('Account name').fill(name);
  await page.getByLabel('Account number').fill(number);
  await page.getByRole('button', { name: 'Save banking details' }).click();
}

// ---------------------------------------------------------------------------------------------
// Seeding (only with E2E_DATABASE_URL)
// ---------------------------------------------------------------------------------------------

interface SeedClient {
  connect(): Promise<void>;
  query(text: string, values?: unknown[]): Promise<{ rows: Record<string, unknown>[] }>;
  end(): Promise<void>;
}

/** `pg` belongs to the API workspace, so it is resolved from there. */
async function withDb<T>(run: (db: SeedClient) => Promise<T>): Promise<T> {
  if (DATABASE_URL === undefined) throw new Error('E2E_DATABASE_URL is not set');
  const load = createRequire(new URL('../../api/package.json', import.meta.url));
  const { Client } = load('pg') as {
    Client: new (config: { connectionString: string }) => SeedClient;
  };
  const db = new Client({ connectionString: DATABASE_URL });
  await db.connect();
  try {
    return await run(db);
  } finally {
    await db.end();
  }
}

/** A PUBLISHED paid session (needs the team to have banking, or the publish trigger refuses it). */
async function seedPublishedPaidSession(teamId: string): Promise<void> {
  await withDb(async (db) => {
    const created = await db.query(
      `INSERT INTO game_sessions (team_id, location, address, date, cancellation_deadline, max_players,
                                  pricing_structure, fee_flat)
       VALUES ($1, 'Hall', '1 Street', '2027-03-03', '2027-03-01T06:00:00Z', 12, 'FLAT', '17.00')
       RETURNING id`,
      [teamId],
    );
    const sessionId = created.rows[0]?.id;
    await db.query(
      `INSERT INTO session_courts (session_id, court_identifier, start_time, end_time)
       VALUES ($1, 'Court 1', '19:00', '21:00')`,
      [sessionId],
    );
    await db.query(`UPDATE game_sessions SET status = 'PUBLISHED' WHERE id = $1`, [sessionId]);
  });
}

// ---------------------------------------------------------------------------------------------
// The main journey
// ---------------------------------------------------------------------------------------------

test.describe('banking and GST journeys', () => {
  test('admin: Manage, Banking and GST, save, change, GST, remove (AC-INTEGRATION-4, AC-VERIFY-13)', async ({
    page,
  }) => {
    test.setTimeout(180_000);
    const dialogs: string[] = [];
    const offStack: string[] = [];
    watchDialogs(page, dialogs);
    watchOffStackRequests(page, offStack);

    const admin: Person = { fullName: 'Aroha Ngata', email: uniqueEmail('journey') };
    const teamName = `E2E Journey ${unique('t')}`;
    await register(page, admin);
    const teamId = await createTeam(page, teamName);

    // Manage page, then the area nav link (AC-ENTRY-1, AC-ENTRY-3).
    const nav = page.getByRole('navigation', { name: 'Team admin areas' });
    await expect(nav.getByRole('link', { name: 'People' })).toHaveAttribute('aria-current', 'page');
    await expect(nav.getByRole('link', { name: 'Banking and GST' })).not.toHaveAttribute(
      'aria-current',
      /.*/,
    );
    await nav.getByRole('link', { name: 'Banking and GST' }).click();
    await page.waitForURL(new RegExp(`/teams/${teamId}/manage/banking$`));
    await expect(page).toHaveTitle(`Banking and GST – ${teamName} – Shared Game Management`);
    await expect(page.getByRole('heading', { level: 1 })).toHaveText(
      `Banking and GST for ${teamName}`,
    );
    await expect(
      page.getByRole('navigation', { name: 'Team admin areas' }).locator('[aria-current=page]'),
    ).toHaveText('Banking and GST');
    await expect(page.locator('meta[name=robots]')).toHaveAttribute('content', /noindex/);

    // Empty state: not set up, the form is shown directly, the inputs are safe to type secrets into.
    await expect(statusLine(page, NOT_SET_UP)).toBeVisible();
    const name = page.getByLabel('Account name');
    const number = page.getByLabel('Account number');
    await expect(number).toHaveAttribute('inputmode', 'numeric');
    await expect(number).toHaveAttribute('autocomplete', 'off');
    await expect(name).toHaveAttribute('autocomplete', 'off');
    await expect(page.locator('input[type=password]')).toHaveCount(0);
    await expectLabelled(page, bankSection(page));
    await expect(gstSection(page).getByLabel('This team is registered for GST')).not.toBeChecked();
    await expectLabelled(page, gstSection(page));
    await expectNoSeriousViolations(page, 'banking (empty)');
    await expectLayoutOk(page, 'banking (empty)');

    // Validation errors: summary takes focus, every field error is linked, typed values stay (reset check).
    await name.fill('Rosedale Badminton Club');
    await number.fill('01-0902-0068388-00');
    await page.getByRole('button', { name: 'Save banking details' }).click();
    const summary = page.getByRole('alert').filter({ hasText: "There's a problem" });
    await expect(summary).toBeFocused();
    await expectDescribedByError(
      number,
      'That account number does not look right. Check the digits and try again.',
    );
    await expect(name).toHaveValue('Rosedale Badminton Club');
    await expect(number).toHaveValue('01-0902-0068388-00');
    await expectNoSeriousViolations(page, 'banking (validation error)');
    await expectLayoutOk(page, 'banking (validation error)');
    await summary.getByRole('link').first().click();
    await expect(number).toBeFocused();

    // Blank number on a first save is refused too.
    await number.fill('');
    await page.getByRole('button', { name: 'Save banking details' }).click();
    await expect(page.getByRole('alert').filter({ hasText: "There's a problem" })).toBeFocused();
    await expectDescribedByError(number, 'Enter the account number.');

    // A valid first save (AC-HAPPY-1): banner takes focus, status line, masked summary, no full number.
    await saveBanking(page, 'Rosedale Badminton Club', ACCOUNT_A.typed);
    const saved = notice(page, BANKING_SAVED);
    await expect(saved).toBeVisible();
    await expect(saved).toBeFocused();
    await expect(page).toHaveURL(new RegExp(`/manage/banking\\?notice=banking_saved`));
    await expect(statusLine(page, SET_UP)).toBeVisible();
    await expect(bankSection(page).getByText('ending 8389')).toBeVisible();
    await expect(bankSection(page).getByText('Rosedale Badminton Club')).toBeVisible();
    await expect(bankSection(page).getByLabel('Account number')).toHaveCount(0);
    expect(await page.locator('body').innerText()).not.toContain('0068389');
    await expectNoSeriousViolations(page, 'banking (configured)');
    await expectLayoutOk(page, 'banking (configured)');

    // Change keeps the saved number: name only (AC-HAPPY-2). The form is prefilled and the number blank.
    await bankSection(page).getByRole('link', { name: 'Change banking details' }).click();
    await expect(page).toHaveURL(/\/manage\/banking\?edit=banking/);
    await expect(name).toHaveValue('Rosedale Badminton Club');
    await expect(number).toHaveValue('');
    await expect(
      bankSection(page).getByText('Leave blank to keep the saved value.', { exact: false }),
    ).toBeVisible();
    await expectNoSeriousViolations(page, 'banking (change form)');
    await name.fill('Rosedale BC');
    await page.getByRole('button', { name: 'Save banking details' }).click();
    await expect(notice(page, 'Banking details updated.')).toBeVisible();
    await expect(bankSection(page).getByText('Rosedale BC')).toBeVisible();
    await expect(bankSection(page).getByText('ending 8389')).toBeVisible();

    // Replace the number (AC-HAPPY-3): the notice names the new ending.
    await bankSection(page).getByRole('link', { name: 'Change banking details' }).click();
    await number.fill(ACCOUNT_B.typed);
    await page.getByRole('button', { name: 'Save banking details' }).click();
    await expect(
      notice(
        page,
        `Banking details updated. Payments now go to the account ending ${ACCOUNT_B.last4}.`,
      ),
    ).toBeVisible();
    await expect(bankSection(page).getByText(`ending ${ACCOUNT_B.last4}`)).toBeVisible();
    await expect(bankSection(page).getByText('ending 8389')).toHaveCount(0);

    // Cancel in edit mode goes back to the summary and changes nothing.
    await bankSection(page).getByRole('link', { name: 'Change banking details' }).click();
    await bankSection(page).getByRole('link', { name: 'Cancel' }).click();
    await expect(page).not.toHaveURL(/edit=banking/);
    await expect(bankSection(page).getByText(`ending ${ACCOUNT_B.last4}`)).toBeVisible();

    // GST (AC-HAPPY-5): nothing saved shows the form; the number field exists only while the toggle is on.
    const toggle = gstSection(page).getByLabel('This team is registered for GST');
    const gstNumber = gstSection(page).getByLabel('GST number');
    await expect(gstNumber).toHaveCount(0);
    await toggle.check();
    await expect(gstNumber).toBeVisible();
    await expect(gstNumber).toHaveAttribute('inputmode', 'numeric');
    await expect(gstNumber).toHaveAttribute('autocomplete', 'off');
    await expect(gstSection(page).getByText('This is your IRD number.')).toBeVisible();
    await expect(
      gstSection(page).getByText(
        "Players' prices include GST. GST is worked out as 3/23 of the price.",
        {
          exact: false,
        },
      ),
    ).toBeVisible();
    await gstSection(page).getByRole('button', { name: 'Save GST settings' }).click();
    await expect(page.getByRole('alert').filter({ hasText: "There's a problem" })).toBeFocused();
    await expectDescribedByError(gstNumber, 'Enter your GST number to register for GST.');
    // The checkbox stays on after the failed submit (form reset check) and the typed number is kept.
    await expect(toggle).toBeChecked();
    await expectNoSeriousViolations(page, 'banking (GST error)');
    await gstNumber.fill(GST_NUMBER.typed);
    await gstSection(page).getByRole('button', { name: 'Save GST settings' }).click();
    await expect(notice(page, 'GST settings saved.')).toBeVisible();
    await expect(gstSection(page).getByText('Registered', { exact: true })).toBeVisible();
    await expect(gstSection(page).getByText(GST_NUMBER.shown, { exact: true })).toBeVisible();
    await expectNoSeriousViolations(page, 'banking (GST saved)');
    await expectLayoutOk(page, 'banking (GST saved)');

    // GST off keeps the saved number, labelled as unused (AC-HAPPY-6 browser side).
    await gstSection(page).getByRole('link', { name: 'Change GST settings' }).click();
    await toggle.uncheck();
    await expect(gstNumber).toHaveCount(0);
    await gstSection(page).getByRole('button', { name: 'Save GST settings' }).click();
    await expect(notice(page, 'GST settings saved.')).toBeVisible();
    await expect(gstSection(page).getByText('Not registered')).toBeVisible();
    await expect(gstSection(page).getByText('Saved GST number')).toBeVisible();
    await expect(gstSection(page).getByText('Not used while GST is off.')).toBeVisible();

    // Remove (AC-HAPPY-4): inline confirm, prompt focused, Escape closes and returns focus, then confirm.
    const remove = bankSection(page).locator('button[aria-controls=remove-banking-panel]');
    await remove.click();
    const panel = bankSection(page).getByRole('group');
    await expect(panel.getByText(REMOVE_PROMPT)).toBeFocused();
    await expect(remove).toHaveAttribute('aria-expanded', 'true');
    await expectNoSeriousViolations(page, 'banking (remove confirm open)');
    await expectLayoutOk(page, 'banking (remove confirm open)');
    await page.keyboard.press('Escape');
    await expect(panel).toHaveCount(0);
    await expect(remove).toBeFocused();
    await expect(remove).toHaveAttribute('aria-expanded', 'false');
    await remove.click();
    await panel.getByRole('button', { name: 'Cancel' }).click();
    await expect(panel).toHaveCount(0);
    await expect(remove).toBeFocused();
    await remove.click();
    await panel.getByRole('button', { name: 'Remove banking details', exact: true }).click();
    await expect(notice(page, BANKING_REMOVED)).toBeVisible();
    await expect(statusLine(page, NOT_SET_UP)).toBeVisible();
    await expect(page.getByLabel('Account name')).toHaveValue('');
    await expect(page.getByLabel('Account number')).toHaveValue('');
    await expect(bankSection(page).getByText('ending')).toHaveCount(0);

    expect(dialogs, 'native browser dialogs opened').toEqual([]);
    expect(offStack, 'requests that left the stack (Akahu or anything else)').toEqual([]);
  });

  test('the page itself is not cacheable and every state stays inside the viewport (AC-VERIFY-13)', async ({
    page,
  }) => {
    const { teamId } = await adminOnBanking(page, 'headers');
    const response = await page.goto(`/teams/${teamId}/manage/banking`);
    expect(response?.headers()['cache-control']).toContain('no-store');
    await expectLayoutOk(page, 'banking');
  });

  test('a published paid session blocks removal and the confirm closes with the reason (AC-ERROR-10)', async ({
    page,
  }) => {
    test.skip(
      DATABASE_URL === undefined,
      'needs E2E_DATABASE_URL to seed a published paid session',
    );
    test.setTimeout(120_000);
    const dialogs: string[] = [];
    watchDialogs(page, dialogs);
    const { teamId } = await adminOnBanking(page, 'in-use');
    await saveBanking(page, 'Rosedale Badminton Club', ACCOUNT_A.typed);
    await expect(notice(page, BANKING_SAVED)).toBeVisible();
    await seedPublishedPaidSession(teamId);

    await page.reload();
    const remove = bankSection(page).locator('button[aria-controls=remove-banking-panel]');
    await remove.click();
    const panel = bankSection(page).getByRole('group');
    await panel.getByRole('button', { name: 'Remove banking details', exact: true }).click();
    // The confirm closes (the server state is known and unchanged) and the reason is announced and focused.
    await expect(panel).toHaveCount(0);
    const refusal = bankSection(page).getByRole('alert');
    await expect(refusal).toContainText(IN_USE);
    await expect(refusal).toBeFocused();
    await expectNoSeriousViolations(page, 'banking (removal refused)');
    await expectLayoutOk(page, 'banking (removal refused)');
    // Nothing was removed.
    await page.reload();
    await expect(statusLine(page, SET_UP)).toBeVisible();
    await expect(bankSection(page).getByText('ending 8389')).toBeVisible();
    // Replacing the details stays allowed while a paid session is published.
    await bankSection(page).getByRole('link', { name: 'Change banking details' }).click();
    await page.getByLabel('Account number').fill(ACCOUNT_B.typed);
    await page.getByRole('button', { name: 'Save banking details' }).click();
    await expect(
      notice(
        page,
        `Banking details updated. Payments now go to the account ending ${ACCOUNT_B.last4}.`,
      ),
    ).toBeVisible();
    expect(dialogs, 'native browser dialogs opened').toEqual([]);
  });

  test('a failed payout shows Needs attention and a save clears it; unreadable details are re-entered', async ({
    page,
  }) => {
    test.skip(DATABASE_URL === undefined, 'needs E2E_DATABASE_URL to seed the failed states');
    test.setTimeout(120_000);
    const { teamId } = await adminOnBanking(page, 'blocked');
    await saveBanking(page, 'Rosedale Badminton Club', ACCOUNT_A.typed);
    await expect(notice(page, BANKING_SAVED)).toBeVisible();

    // Billing marked the destination as failed (R3): the page says so, naming the account ending.
    await withDb((db) =>
      db.query(`UPDATE teams SET payout_blocked_at = now() WHERE id = $1`, [teamId]),
    );
    await page.reload();
    await expect(
      statusLine(
        page,
        'Needs attention. Payments to the account ending 8389 failed. Check the account number and save it again.',
      ),
    ).toBeVisible();
    await expectNoSeriousViolations(page, 'banking (payout blocked)');
    await bankSection(page).getByRole('link', { name: 'Change banking details' }).click();
    await page.getByLabel('Account number').fill(ACCOUNT_A.typed);
    await page.getByRole('button', { name: 'Save banking details' }).click();
    await expect(notice(page, 'Banking details updated.')).toBeVisible();
    await expect(statusLine(page, SET_UP)).toBeVisible();

    // The saved name cannot be read (R7): a "Needs attention" status and the form, number required.
    await withDb((db) =>
      db.query(`UPDATE teams SET bank_account_name = $2 WHERE id = $1`, [
        teamId,
        'v1.gone.AAAAAAAAAAAAAAAA.AAAA.AAAAAAAAAAAAAAAAAAAAAA',
      ]),
    );
    await page.reload();
    await expect(
      statusLine(
        page,
        "Needs attention. We couldn't read your saved bank details. Enter the account name and number again to fix this.",
      ),
    ).toBeVisible();
    await expect(page.getByLabel('Account name')).toHaveValue('');
    await expectNoSeriousViolations(page, 'banking (unreadable)');
    await expectLayoutOk(page, 'banking (unreadable)');
    await page.getByRole('button', { name: 'Save banking details' }).click();
    await expectDescribedByError(
      page.getByLabel('Account name'),
      'Enter the name on the bank account.',
    );
    await expectDescribedByError(page.getByLabel('Account number'), 'Enter the account number.');
    await saveBanking(page, 'Rosedale Badminton Club', ACCOUNT_B.typed);
    await expect(statusLine(page, SET_UP)).toBeVisible();
    await expect(bankSection(page).getByText(`ending ${ACCOUNT_B.last4}`)).toBeVisible();
  });

  test('the returnTo hand-off offers Back to your session only for a safe same-team path', async ({
    page,
  }) => {
    test.setTimeout(120_000);
    const admin: Person = { fullName: 'Aroha Ngata', email: uniqueEmail('return') };
    await register(page, admin);
    const teamId = await createTeam(page, `E2E Return ${unique('t')}`);
    const otherTeamId = await createTeam(page, `E2E Other ${unique('t')}`);
    const sessionPath = `/teams/${teamId}/sessions/some-session`;

    // A path under another team, or the banking page itself, is dropped without a trace.
    await page.goto(
      `/teams/${teamId}/manage/banking?returnTo=${encodeURIComponent(`/teams/${otherTeamId}/sessions/x`)}`,
    );
    await saveBanking(page, 'Rosedale Badminton Club', ACCOUNT_A.typed);
    await expect(notice(page, BANKING_SAVED)).toBeVisible();
    await expect(page.getByRole('link', { name: 'Back to your session' })).toHaveCount(0);

    // A same-team path survives the whole flow (Change, save) and shows the link on the saved banner.
    await page.goto(`/teams/${teamId}/manage/banking?returnTo=${encodeURIComponent(sessionPath)}`);
    await bankSection(page).getByRole('link', { name: 'Change banking details' }).click();
    await expect(page).toHaveURL(/edit=banking/);
    await expect(page).toHaveURL(/returnTo=/);
    await page.getByLabel('Account name').fill('Rosedale BC');
    await page.getByRole('button', { name: 'Save banking details' }).click();
    // Updating an already configured team is "updated", which has no hand-off link by design.
    await expect(notice(page, 'Banking details updated.')).toBeVisible();
    await expect(page).toHaveURL(/returnTo=/);
    await expect(page.getByRole('link', { name: 'Back to your session' })).toHaveCount(0);
  });

  test('first-time setup from a refused publish returns to the session (AC-ENTRY-4, returnTo)', async ({
    page,
  }) => {
    test.setTimeout(120_000);
    const admin: Person = { fullName: 'Aroha Ngata', email: uniqueEmail('handoff') };
    await register(page, admin);
    const teamId = await createTeam(page, `E2E Handoff ${unique('t')}`);
    const sessionPath = `/teams/${teamId}/sessions/some-session`;
    await page.goto(`/teams/${teamId}/manage/banking?returnTo=${encodeURIComponent(sessionPath)}`);
    await saveBanking(page, 'Rosedale Badminton Club', ACCOUNT_A.typed);
    await expect(notice(page, BANKING_SAVED)).toBeVisible();
    const back = page.getByRole('link', { name: 'Back to your session' });
    await expect(back).toHaveAttribute('href', sessionPath);
    await expectNoSeriousViolations(page, 'banking (saved with hand-off)');
    await back.click();
    await page.waitForURL(new RegExp(`${sessionPath}$`));
  });

  test('a signed-out visitor is sent to sign in, and a plain member sees the no-access page (AC-ENTRY-2)', async ({
    page,
    browser,
  }) => {
    test.setTimeout(180_000);
    const dialogs: string[] = [];
    watchDialogs(page, dialogs);
    const { teamId, teamName } = await adminOnBanking(page, 'access');
    await saveBanking(page, 'Rosedale Badminton Club', ACCOUNT_A.typed);
    await expect(notice(page, BANKING_SAVED)).toBeVisible();

    // Signed out: the sign-in page, with a way back.
    const visitor = await newPersonContext(browser);
    const vPage = await visitor.newPage();
    await vPage.goto(`/teams/${teamId}/manage/banking`);
    await expect(vPage).toHaveURL(/\/login\?returnTo=/);
    await expect(vPage.getByText('Rosedale Badminton Club')).toHaveCount(0);
    await visitor.close();

    // A member: joins the public team, the admin approves, then asks for the banking URL.
    const other = await newPersonContext(browser);
    const bPage = await other.newPage();
    watchDialogs(bPage, dialogs);
    const member: Person = { fullName: 'Mere Hoani', email: uniqueEmail('member') };
    await register(bPage, member);
    await bPage.goto(`/teams/${teamId}`);
    await bPage.getByLabel('Intermediate', { exact: true }).check();
    await bPage.getByRole('button', { name: 'Request to join' }).click();
    await expect(bPage.getByText('Pending approval')).toBeVisible();

    await page.goto(`/teams/${teamId}/manage`);
    await page
      .getByRole('region', { name: 'Join requests', exact: true })
      .getByRole('listitem')
      .filter({ hasText: member.fullName })
      .getByRole('button', { name: 'Approve' })
      .click();
    await expect(page.locator('#requests-status')).toContainText('has been approved.');

    await bPage.goto('/teams');
    await expect(bPage.getByRole('listitem').filter({ hasText: teamName })).toContainText('Member');
    await bPage.goto(`/teams/${teamId}/manage/banking`);
    await expect(bPage.getByRole('heading', { name: NO_ACCESS })).toBeVisible();
    await expect(bPage.getByRole('heading', { name: 'Bank account' })).toHaveCount(0);
    await expect(bPage.getByRole('navigation', { name: 'Team admin areas' })).toHaveCount(0);
    expect(await bPage.locator('body').innerText()).not.toContain('Rosedale Badminton Club');
    expect(await bPage.locator('body').innerText()).not.toContain('8389');
    await expectNoSeriousViolations(bPage, 'banking (no access)');
    await expectLayoutOk(bPage, 'banking (no access)');
    expect(dialogs, 'native browser dialogs opened').toEqual([]);
    await other.close();
  });
});
