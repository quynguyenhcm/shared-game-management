/**
 * Browser journey for skill levels and Auto Enroll (AC-ENTRY-1..3, AC-HAPPY-1/2/7..11 UI half, AC-HAPPY-12,
 * AC-ERROR-3, AC-ERROR-6, AC-NAV-1, AC-VERIFY-8), run on a desktop and a 360 x 740 project against the real
 * Compose stack with `AUTH_FAKE_OAUTH=true` (only password sign-up is used here):
 *   AUTH_FAKE_OAUTH=true docker compose up -d --build --wait && pnpm run test:e2e
 * Two people are two browser contexts: A (the team admin, the default `page`) and B (a player, a fresh
 * context built from the project's own viewport settings). Not part of `pnpm run ci`.
 *
 * No game or session rows can be written through the app yet, so every progress line honestly reads
 * "0 of 40"; automatic promotion is proven by the API integration tests, not here.
 */
import { randomBytes } from 'node:crypto';
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
const NO_ACCESS = "You don't have access to manage this team.";
const SAVE_UNCONFIRMED =
  "We couldn't confirm that was saved. Try again; saving the same change twice is safe.";

// ---------------------------------------------------------------------------------------------
// Helpers (the same conventions as teams.spec.ts)
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

/** No native browser dialog may ever open (confirmations and panels are inline). */
function watchDialogs(page: Page, opened: string[]): void {
  page.on('dialog', (dialog) => {
    opened.push(`${dialog.type()}: ${dialog.message()}`);
    void dialog.dismiss();
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

async function createPublicTeam(page: Page, name: string): Promise<string> {
  await page.goto('/teams/new');
  await page.getByLabel('Team name').fill(name);
  await page.getByLabel('Description (optional)').fill('');
  await page.getByLabel('Public', { exact: true }).check();
  await page.getByLabel('Intermediate', { exact: true }).check();
  await page.getByRole('button', { name: 'Create team' }).click();
  await page.waitForURL(/\/teams\/[0-9a-f-]{36}\/manage/);
  const teamId = /\/teams\/([0-9a-f-]{36})\/manage/.exec(page.url())?.[1];
  if (teamId === undefined) throw new Error('team id not found in the manage URL');
  return teamId;
}

const section = (page: Page, name: string): Locator =>
  page.getByRole('region', { name, exact: true });
const rowOf = (page: Page, sectionName: string, person: string): Locator =>
  section(page, sectionName).getByRole('listitem').filter({ hasText: person });

/** AC-VERIFY-8: no axe violation of impact serious or critical. */
async function expectNoSeriousViolations(page: Page, label: string): Promise<void> {
  const results = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'])
    .analyze();
  const blocking = results.violations
    .filter((violation) => violation.impact === 'serious' || violation.impact === 'critical')
    .map(
      (violation) =>
        `${violation.impact ?? ''} ${violation.id}: ${violation.help} -> ${violation.nodes
          .slice(0, 3)
          .map((node) => node.target.join(' '))
          .join(' | ')}`,
    );
  expect(blocking, `axe serious or critical violations on ${label}`).toEqual([]);
}

/** No horizontal scroll, and buttons, links and radio rows in the page content are at least 44 px high. */
async function expectLayoutOk(page: Page, label: string): Promise<void> {
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(overflow, `${label}: horizontal overflow`).toBeLessThanOrEqual(0);
  const short = await page.evaluate(() => {
    const found: string[] = [];
    const targets = document.querySelectorAll(
      'main button, main a[href], main label:has(input[type=radio]), main label:has(input[type=checkbox])',
    );
    for (const target of targets) {
      const box = target.getBoundingClientRect();
      if (box.width === 0 || box.height === 0) continue;
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

/** Today's calendar date in Pacific/Auckland, `YYYY-MM-DD` (the same clock the page uses for `min`). */
function nzToday(): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Pacific/Auckland' }).format(new Date());
}

function plusDays(date: string, days: number): string {
  const moved = new Date(`${date}T00:00:00Z`);
  moved.setUTCDate(moved.getUTCDate() + days);
  return moved.toISOString().slice(0, 10);
}

/** `2026-11-30` -> `30 Nov 2026`, the way the page shows a calendar date. */
function calendarText(date: string): string {
  return new Intl.DateTimeFormat('en-NZ', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    timeZone: 'UTC',
  })
    .format(new Date(`${date}T00:00:00Z`))
    .replace('Sept', 'Sep');
}

// ---------------------------------------------------------------------------------------------
// The admin journey
// ---------------------------------------------------------------------------------------------

test.describe('skill levels and Auto Enroll (admin journey)', () => {
  test('override a level, set and clear Auto Enroll, a validation error, no native dialog (AC-VERIFY-8)', async ({
    page,
    browser,
  }) => {
    test.setTimeout(240_000);
    const dialogs: string[] = [];
    watchDialogs(page, dialogs);

    const admin: Person = { fullName: 'Aroha Ngata', email: uniqueEmail('skill-admin') };
    const player: Person = { fullName: 'Hine Walker', email: uniqueEmail('skill-player') };
    const teamName = `E2E Skill ${unique('t')}`;

    await register(page, admin);
    const teamId = await createPublicTeam(page, teamName);

    // B joins a public team as a Beginner; A sees the request, which has no skill controls (AC-ENTRY-2).
    const other = await newPersonContext(browser);
    const bPage = await other.newPage();
    watchDialogs(bPage, dialogs);
    await register(bPage, player);
    await bPage.goto(`/teams/${teamId}`);
    await bPage.getByLabel('Beginner', { exact: true }).check();
    await bPage.getByRole('button', { name: 'Request to join' }).click();
    await expect(bPage.getByText('Pending approval')).toBeVisible();

    await page.goto(`/teams/${teamId}/manage`);
    const request = rowOf(page, 'Join requests', player.fullName);
    await expect(request).toBeVisible();
    await expect(request.getByRole('button', { name: /Skill and Auto Enroll/ })).toHaveCount(0);
    await request.getByRole('button', { name: 'Approve' }).click();
    await expect(page.locator('#requests-status')).toHaveText('Hine Walker has been approved.');

    // AC-ENTRY-1: the approved row shows the read-only lines and the trigger, yours included.
    const row = rowOf(page, 'Members', player.fullName);
    await expect(row).toContainText('Beginner');
    await expect(row).toContainText('Self-assessed');
    await expect(row).toContainText('0 of 40 games toward Intermediate');
    await expect(row).not.toContainText('Auto Enroll until');
    await expect(
      rowOf(page, 'Members', admin.fullName).getByRole('button', {
        name: 'Skill and Auto Enroll, Aroha Ngata',
      }),
    ).toBeVisible();

    const trigger = row.getByRole('button', { name: 'Skill and Auto Enroll, Hine Walker' });
    await expect(trigger).toHaveAttribute('aria-expanded', 'false');
    await trigger.click();
    const panel = row.getByRole('group', { name: 'Skill and Auto Enroll for Hine Walker' });
    await expect(trigger).toHaveAttribute('aria-expanded', 'true');
    await expect(
      panel.getByRole('heading', { name: 'Skill and Auto Enroll for Hine Walker' }),
    ).toBeFocused();
    // AC-HAPPY-12: the rule and consequence lines are visible before saving.
    await expect(panel).toContainText('0 of 40 toward Intermediate');
    await expect(panel).toContainText('Saving a different level restarts the count at 0');
    await expect(panel).toContainText('keep their fee');
    await expect(panel).toContainText('charged like any other player');
    await expectNoSeriousViolations(page, 'manage (skill panel open)');
    await expectLayoutOk(page, 'manage (skill panel open)');

    // Escape closes and returns focus to the trigger; reopening works.
    await page.keyboard.press('Escape');
    await expect(panel).toHaveCount(0);
    await expect(trigger).toBeFocused();
    await expect(trigger).toHaveAttribute('aria-expanded', 'false');
    await trigger.click();
    await expect(panel).toBeVisible();

    // Raise the level (AC-HAPPY-1): the message sits in the panel, the Members region stays empty, the
    // panel stays open and the pressed button keeps focus; the row updates.
    await panel.getByLabel('Advanced', { exact: true }).check();
    const saveSkill = panel.getByRole('button', { name: 'Save skill level' });
    await saveSkill.click();
    await expect(
      panel.getByRole('status').filter({ hasText: 'Skill level for Hine Walker set to Advanced.' }),
    ).toBeVisible();
    await expect(page.locator('#members-status')).toHaveText('');
    await expect(panel).toBeVisible();
    await expect(saveSkill).toBeFocused();
    await expect(row).toContainText('Advanced');
    await expect(row).toContainText('Set by Aroha Ngata');
    await expect(row).toContainText('Highest level');
    await expect(row).not.toContainText('Self-assessed');

    // Lower it (AC-HAPPY-2): the count restarts toward Advanced, and the row is the second member's own
    // values, not the first save's (anti-stub).
    await panel.getByLabel('Intermediate', { exact: true }).check();
    await saveSkill.click();
    await expect(
      panel
        .getByRole('status')
        .filter({ hasText: 'Skill level for Hine Walker set to Intermediate.' }),
    ).toBeVisible();
    await expect(row).toContainText('0 of 40 games toward Advanced');
    await expect(row).not.toContainText('Highest level');

    // The same level again is a no-op with its own message (AC-HAPPY-3).
    await saveSkill.click();
    await expect(
      panel.getByRole('status').filter({ hasText: 'Hine Walker is already Intermediate.' }),
    ).toBeVisible();

    // Auto Enroll: the date is only offered once the box is ticked.
    const box = panel.getByRole('checkbox', { name: 'Auto Enroll' });
    const until = panel.getByLabel('Until (optional)');
    const saveEnroll = panel.getByRole('button', { name: 'Save Auto Enroll' });
    await expect(box).not.toBeChecked();
    await expect(until).toBeHidden();
    await box.check();
    await expect(until).toBeVisible();
    await expect(until).toHaveAttribute('min', nzToday());

    // AC-ERROR-3: a past date shows a field error, keeps what was typed, sends nothing, panel stays open.
    await until.fill('2020-01-01');
    await saveEnroll.click();
    const untilError = panel.getByText('Choose today or a later date.');
    await expect(untilError).toBeVisible();
    await expect(until).toHaveAttribute('aria-invalid', 'true');
    await expect(until).toBeFocused();
    await expect(until).toHaveValue('2020-01-01');
    await expect(box).toBeChecked();
    await expect(row).not.toContainText('Auto Enroll until');
    await expectNoSeriousViolations(page, 'manage (date error)');
    await expectLayoutOk(page, 'manage (date error)');

    // A date today or later saves (AC-HAPPY-7); the tag changes and the order key is set by the API.
    const later = plusDays(nzToday(), 30);
    await until.fill(later);
    await saveEnroll.click();
    await expect(
      panel
        .getByRole('status')
        .filter({ hasText: `Auto Enroll on for Hine Walker until ${calendarText(later)}.` }),
    ).toBeVisible();
    await expect(row).toContainText(`Auto Enroll until ${calendarText(later)}`);
    await expect(saveEnroll).toBeFocused();
    await expect(page.locator('#members-status')).toHaveText('');

    // Clear date returns focus to the field; saving it empty is "no end date" (AC-HAPPY-8).
    await panel.getByRole('button', { name: 'Clear date' }).click();
    await expect(until).toBeFocused();
    await expect(until).toHaveValue('');
    await expect(panel.getByRole('button', { name: 'Clear date' })).toHaveCount(0);
    await saveEnroll.click();
    await expect(
      panel
        .getByRole('status')
        .filter({ hasText: 'Auto Enroll on for Hine Walker, with no end date.' }),
    ).toBeVisible();
    await expect(row).toContainText('Auto Enroll, no end date');

    // Unticking states the cost, and saving turns it off (AC-HAPPY-10).
    await box.uncheck();
    await expect(panel).toContainText("Turning this off removes Hine Walker's place");
    await saveEnroll.click();
    await expect(
      panel.getByRole('status').filter({ hasText: 'Auto Enroll turned off for Hine Walker.' }),
    ).toBeVisible();
    await expect(row).not.toContainText('Auto Enroll, no end date');
    await expect(row).not.toContainText('Auto Enroll until');

    // AC-ERROR-6: with no connection nothing is claimed, the panel stays open with the typed values.
    await box.check();
    await page.context().setOffline(true);
    await saveEnroll.click();
    await expect(page.getByRole('alert').filter({ hasText: SAVE_UNCONFIRMED })).toBeVisible();
    await expect(panel).toBeVisible();
    await expect(box).toBeChecked();
    await page.context().setOffline(false);

    // Close returns focus to the trigger.
    await panel.getByRole('button', { name: 'Close' }).click();
    await expect(panel).toHaveCount(0);
    await expect(trigger).toBeFocused();

    // AC-NAV-1: an open panel with unsaved typing closes on reload; the saved row persists.
    await trigger.click();
    await panel.getByLabel('Beginner', { exact: true }).check();
    await page.reload();
    await expect(panel).toHaveCount(0);
    await expect(row).toContainText('Intermediate');
    await expect(row).toContainText('Set by Aroha Ngata');

    // Opening the Ban confirm closes this panel (one panel or confirm open per section).
    await trigger.click();
    await expect(panel).toBeVisible();
    await row.getByRole('button', { name: 'Ban Hine Walker' }).click();
    await expect(panel).toHaveCount(0);
    await expect(row.getByRole('group', { name: /^Ban Hine Walker\?/ })).toBeVisible();

    // AC-ENTRY-3: a plain member gets the no-access page, never the lists.
    await bPage.goto(`/teams/${teamId}/manage`);
    await expect(bPage.getByRole('heading', { name: NO_ACCESS })).toBeVisible();
    await expect(bPage.getByRole('button', { name: /Skill and Auto Enroll/ })).toHaveCount(0);

    expect(dialogs, 'native browser dialogs opened').toEqual([]);
    await other.close();
  });
});
