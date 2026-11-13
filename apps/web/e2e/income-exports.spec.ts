/**
 * Browser journey for the Income exports area (tax-invoices-and-exports Phase 4; AC-ENTRY-2, AC-HAPPY-8, AC-ERROR-3; UI/UX
 * surface B), run on the desktop and the 360 x 740 project. Not part of `pnpm run ci`; run it like `team-banking.spec.ts`
 * against a running stack (API, worker and `next start`):
 *
 *   pnpm run test:e2e apps/web/e2e/income-exports.spec.ts
 *
 * A fresh team has no paid payments, so the file is headings only; the row content, reconciliation and the Excel read-back are
 * proven by the API's integration tests. This spec covers what only a browser can: the no-JS GET form and its CSS reveal, the
 * download leaving the page in place, a 422 landing back with the values and a focused error summary, and axe plus 44 px
 * targets and no horizontal scroll at both widths.
 */
import { randomBytes } from 'node:crypto';
import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';

const PASSWORD = 'kowhai-court-27';

const unique = (tag: string): string =>
  `${tag}-${Date.now().toString(36)}${randomBytes(2).toString('hex')}`;

async function register(page: Page): Promise<void> {
  await page.goto('/register');
  await page.getByLabel('Full name').fill('Aroha Ngata');
  await page.getByLabel('Email').fill(`e2e-${unique('exports')}@example.test`);
  await page.getByLabel('Password', { exact: true }).fill(PASSWORD);
  await page.getByLabel('Female').check();
  await page.getByRole('button', { name: 'Create account' }).click();
  await page.waitForURL((url) => url.pathname === '/');
}

/** Creates a public team (the creator is its first TEAM_ADMIN) and returns its id. */
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

async function expectNoSeriousViolations(page: Page, label: string): Promise<void> {
  const results = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'])
    .analyze();
  const blocking = results.violations
    .filter((violation) => violation.impact === 'critical' || violation.impact === 'serious')
    .map((violation) => `${violation.id}: ${violation.help}`);
  expect(blocking, `axe critical or serious violations on ${label}`).toEqual([]);
}

/** No horizontal scroll; every visible button, link, select and text input is at least 44 px high (radios: their row). */
async function expectLayoutOk(page: Page, label: string): Promise<void> {
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(overflow, `${label}: horizontal overflow`).toBeLessThanOrEqual(0);
  const short = await page.evaluate(() =>
    [
      ...document.querySelectorAll(
        'main button, main a[href], main select, main input, main summary',
      ),
    ]
      .filter((target) => (target as HTMLInputElement).type !== 'radio')
      .map((target) => ({ target, box: target.getBoundingClientRect() }))
      .filter(({ box }) => box.width > 0 && box.height > 0 && box.height < 43.5)
      .map(({ target, box }) => `${target.tagName.toLowerCase()} is ${Math.round(box.height)}px`),
  );
  expect(short, `${label}: targets under 44 px`).toEqual([]);
}

test('a team admin finds Income exports, downloads a file and gets a field error back with the values kept', async ({
  page,
}) => {
  const teamName = `E2E Exports ${unique('t')}`;
  await register(page);
  const teamId = await createTeam(page, teamName);

  // AC-ENTRY-2: the nav link, current on its page.
  await page
    .getByRole('navigation', { name: 'Team admin areas' })
    .getByRole('link', { name: 'Income exports' })
    .click();
  await page.waitForURL(`**/teams/${teamId}/manage/exports`);
  await expect(page.getByRole('heading', { level: 1 })).toHaveText(
    `Income exports for ${teamName}`,
  );
  await expect(page.getByRole('link', { name: 'Income exports' })).toHaveAttribute(
    'aria-current',
    'page',
  );
  await expectNoSeriousViolations(page, 'exports idle');
  await expectLayoutOk(page, 'exports idle');

  // The CSS reveal: only the selected period type's fields are shown.
  await expect(page.getByLabel('Financial year', { exact: true }).last()).toBeVisible();
  await expect(page.getByLabel('Start date')).toBeHidden();
  await page.getByRole('radio', { name: 'Custom range' }).check();
  await expect(page.getByLabel('Start date')).toBeVisible();
  await expect(page.getByLabel('GST return period')).toBeHidden();
  await page.getByRole('radio', { name: 'GST period' }).check();
  await expect(page.getByLabel('GST return period')).toBeVisible();
  await expectNoSeriousViolations(page, 'exports GST panel');

  // AC-HAPPY-8: the current financial year as CSV downloads and the page stays.
  await page.getByRole('radio', { name: 'Financial year' }).check();
  await page.getByRole('radio', { name: 'CSV (.csv)' }).check();
  const downloading = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Download' }).click();
  const download = await downloading;
  expect(download.suggestedFilename()).toMatch(/^income_[a-z0-9-]+_fy_\d{4}-\d{2}\.csv$/);
  await expect(page).toHaveURL(new RegExp(`/teams/${teamId}/manage/exports$`));

  // AC-ERROR-3: an end before the start lands back with the message next to the field and the values kept.
  await page.getByRole('radio', { name: 'Custom range' }).check();
  await page.getByLabel('Start date').fill('2026-06-15');
  await page.getByLabel('End date').fill('2026-06-01');
  await page.getByRole('button', { name: 'Download' }).click();
  await page.waitForURL(/download_error=validation_failed/);
  const summary = page.getByRole('alert').filter({ hasText: "There's a problem" });
  await expect(summary).toBeFocused();
  await expect(page.getByLabel('End date')).toHaveAttribute('aria-invalid', 'true');
  await expect(page.getByLabel('End date')).toHaveAccessibleDescription(
    /The end date can't be before the start date/,
  );
  await expect(page.getByLabel('Start date')).toHaveValue('2026-06-15');
  await expectNoSeriousViolations(page, 'exports with errors');
  await expectLayoutOk(page, 'exports with errors');
});
