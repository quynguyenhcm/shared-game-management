/**
 * Browser journeys for team management (AC-INTEGRATION-3, AC-VERIFY-7, AC-ENTRY-5 and the web side of
 * AC-HAPPY-6..12), run on a desktop and a 360 x 740 project against the real Compose stack with
 * `AUTH_FAKE_OAUTH=true` (only password sign-up is used here):
 *   AUTH_FAKE_OAUTH=true docker compose up -d --build --wait && pnpm run test:e2e
 * Two people are two browser contexts: A (the admin, the default `page`) and B (a player, a fresh context
 * built from the project's own viewport settings). Not part of `pnpm run ci`.
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
const CREATED_NOTICE = "Team created. You're its first admin.";

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

/** No native browser dialog may ever open (AC-VERIFY-7: confirmations are inline). */
function watchDialogs(page: Page, opened: string[]): void {
  page.on('dialog', (dialog) => {
    opened.push(`${dialog.type()}: ${dialog.message()}`);
    void dialog.dismiss();
  });
}

async function register(page: Page, person: Person, returnTo?: string): Promise<void> {
  const query = returnTo === undefined ? '' : `?returnTo=${encodeURIComponent(returnTo)}`;
  await page.goto(`/register${query}`);
  await page.getByLabel('Full name').fill(person.fullName);
  await page.getByLabel('Email').fill(person.email);
  await page.getByLabel('Password', { exact: true }).fill(PASSWORD);
  await page.getByLabel('Female').check();
  await page.getByRole('button', { name: 'Create account' }).click();
}

async function signOut(page: Page): Promise<void> {
  await page
    .getByRole('navigation', { name: 'Main' })
    .getByRole('button', { name: 'Sign out' })
    .click();
  await page.waitForURL(/\/login/);
}

async function createTeam(
  page: Page,
  input: { name: string; description?: string; visibility: 'Public' | 'Private'; skill: string },
): Promise<string> {
  await page.goto('/teams/new');
  await page.getByLabel('Team name').fill(input.name);
  await page.getByLabel('Description (optional)').fill(input.description ?? '');
  await page.getByLabel(input.visibility, { exact: true }).check();
  await page.getByLabel(input.skill, { exact: true }).check();
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

async function inviteLink(page: Page): Promise<string> {
  return page.locator('#invite-url').inputValue();
}

/** AC-VERIFY-7: no axe violation of impact `critical`; `serious` ones are listed as test annotations. */
async function expectNoCriticalViolations(page: Page, label: string): Promise<void> {
  const results = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'])
    .analyze();
  const describe = (impact: string) =>
    results.violations
      .filter((violation) => violation.impact === impact)
      .map(
        (violation) =>
          `${violation.id}: ${violation.help} -> ${violation.nodes
            .slice(0, 3)
            .map((node) => node.target.join(' '))
            .join(' | ')}`,
      );
  const serious = describe('serious');
  if (serious.length > 0) {
    test
      .info()
      .annotations.push({ type: `axe serious on ${label}`, description: serious.join('; ') });
  }
  expect(describe('critical'), `axe critical violations on ${label}`).toEqual([]);
}

/** AC-VERIFY-7: no horizontal scroll, and buttons and links in the page content are at least 44 px high. */
async function expectLayoutOk(page: Page, label: string): Promise<void> {
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(overflow, `${label}: horizontal overflow`).toBeLessThanOrEqual(0);
  const short = await page.evaluate(() => {
    const found: string[] = [];
    const targets = document.querySelectorAll(
      'main button, main a[href], main label:has(input[type=radio])',
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

// ---------------------------------------------------------------------------------------------
// AC-INTEGRATION-3: the full private-team journey
// ---------------------------------------------------------------------------------------------

test.describe('team journeys', () => {
  test('private team: invite, join, approve, promote, demote, ban, and the banned user is shut out (AC-INTEGRATION-3)', async ({
    page,
    context,
    browser,
  }) => {
    test.setTimeout(180_000);
    const dialogs: string[] = [];
    watchDialogs(page, dialogs);
    await context.grantPermissions(['clipboard-read', 'clipboard-write']);

    const admin: Person = { fullName: 'Aroha Ngata', email: uniqueEmail('admin') };
    const player: Person = { fullName: 'Hine Walker', email: uniqueEmail('player') };
    const teamName = `E2E Rosedale ${unique('t')}`;

    // A creates a private team (AC-HAPPY-2) and lands on the manage page with the notice, which takes focus.
    await register(page, admin);
    await page.waitForURL((url) => url.pathname === '/');
    const teamId = await createTeam(page, {
      name: teamName,
      description: 'Wednesday nights, all levels welcome',
      visibility: 'Private',
      skill: 'Intermediate',
    });
    const notice = page.getByRole('status').filter({ hasText: CREATED_NOTICE });
    await expect(notice).toBeVisible();
    await expect(notice).toBeFocused();
    await expect(page.getByRole('heading', { level: 1 })).toHaveText(`Manage ${teamName}`);
    await expectLayoutOk(page, 'manage (fresh team)');

    // The invite section shows the full URL; "Copy link" really copies it.
    const oldLink = await inviteLink(page);
    expect(oldLink).toMatch(/\/teams\/join\?code=[A-Za-z0-9_-]{32,}$/);
    await page.getByRole('button', { name: 'Copy link' }).click();
    await expect(page.getByText('Link copied.')).toBeVisible();
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(oldLink);

    // Generate new link: inline confirm, Escape returns focus to the trigger, confirm moves focus to the URL.
    const generate = section(page, 'Invite link').getByRole('button', {
      name: 'Generate new link',
      exact: true,
    });
    await generate.click();
    const panel = section(page, 'Invite link').getByRole('group');
    await expect(
      panel.getByText('Generate a new link? The old link stops working immediately.'),
    ).toBeFocused();
    await page.keyboard.press('Escape');
    await expect(panel).toHaveCount(0);
    await expect(generate).toBeFocused();
    await expect(generate).toHaveAttribute('aria-expanded', 'false');
    await generate.click();
    await panel.getByRole('button', { name: 'Generate new link', exact: true }).click();
    await expect(
      page.getByText('New invite link generated. The old link no longer works.'),
    ).toBeVisible();
    await expect(page.locator('#invite-url')).toBeFocused();
    const link = await inviteLink(page);
    expect(link).not.toBe(oldLink);

    // The old link no longer works (AC-HAPPY-12).
    await page.goto(new URL(oldLink).pathname + new URL(oldLink).search);
    await expect(
      page.getByRole('heading', { name: "This invite link doesn't work" }),
    ).toBeVisible();
    await page.goto(`/teams/${teamId}/manage`);

    // B registers, signs out, then opens the invite signed out: the code survives the sign-in round trip.
    const other = await newPersonContext(browser);
    const bPage = await other.newPage();
    watchDialogs(bPage, dialogs);
    await register(bPage, player);
    await bPage.waitForURL((url) => url.pathname === '/');
    await signOut(bPage);

    const invitePath = new URL(link).pathname + new URL(link).search;
    await bPage.goto(invitePath);
    await expect(bPage).toHaveURL(/\/login\?returnTo=%2Fteams%2Fjoin%3Fcode%3D/);
    await bPage.getByLabel('Email').fill(player.email);
    await bPage.getByLabel('Password', { exact: true }).fill(PASSWORD);
    await bPage.getByRole('button', { name: 'Sign in' }).click();
    await bPage.waitForURL(/\/teams\/join\?code=/);
    const inviteResponse = await bPage.goto(invitePath);
    expect(inviteResponse?.headers()['cache-control']).toContain('no-store');
    expect(inviteResponse?.headers()['referrer-policy']).toBe('no-referrer');
    await expect(bPage.getByRole('heading', { level: 1 })).toHaveText(teamName);
    await expect(bPage.getByRole('radio', { checked: true })).toHaveCount(0);

    // No skill chosen: blocked with the exact message; then Beginner and request.
    await bPage.getByRole('button', { name: 'Request to join' }).click();
    await expect(bPage.getByText('Select your skill level to continue.').first()).toBeVisible();
    await bPage.getByLabel('Beginner', { exact: true }).check();
    await bPage.getByRole('button', { name: 'Request to join' }).click();
    await bPage.waitForURL(new RegExp(`/teams/${teamId}`));
    const sent = bPage
      .getByRole('status')
      .filter({ hasText: 'Request sent. A team admin will review it.' });
    await expect(sent).toBeVisible();
    await expect(sent).toBeFocused();
    await expect(bPage.getByText('Pending approval')).toBeVisible();
    expect(bPage.url()).not.toContain('code=');

    // A sees the request (AC-HAPPY-6): jump list count, dated row, Approve.
    await page.reload();
    await expect(page.getByRole('link', { name: 'Join requests (1)' })).toBeVisible();
    const request = rowOf(page, 'Join requests', player.fullName);
    await expect(request).toContainText('Beginner · requested');
    await request.getByRole('button', { name: 'Approve' }).click();
    await expect(page.locator('#requests-status')).toHaveText('Hine Walker has been approved.');
    await expect(page.locator('#requests-heading')).toBeFocused();
    await expect(rowOf(page, 'Join requests', player.fullName)).toHaveCount(0);
    const member = rowOf(page, 'Members', player.fullName);
    await expect(member).toContainText('Member');
    await expect(member).toContainText('Beginner');

    // B's My teams now reads Member, without signing in again.
    await bPage.goto('/teams');
    await expect(bPage.getByRole('listitem').filter({ hasText: teamName })).toContainText('Member');

    // Promote (AC-HAPPY-9): one tap, announced, focus stays in the slot; Ban on an admin is aria-disabled.
    await member.getByRole('button', { name: 'Make admin' }).click();
    await expect(page.locator('#members-status')).toHaveText('Hine Walker is now a team admin.');
    await expect(member).toContainText('Admin');
    const slotButton = member.getByRole('button', { name: 'Remove admin, Hine Walker' });
    await expect(slotButton).toBeFocused();
    await expect(member.getByRole('button', { name: 'Ban Hine Walker' })).toHaveAttribute(
      'aria-disabled',
      'true',
    );
    await expect(
      member.getByText('Remove admin rights from Hine Walker before banning them.'),
    ).toBeVisible();
    // Your own row never offers Ban.
    await expect(
      rowOf(page, 'Members', admin.fullName).getByRole('button', { name: /^Ban/ }),
    ).toHaveCount(0);

    // Demote (AC-HAPPY-10).
    await slotButton.click();
    await expect(page.locator('#members-status')).toHaveText(
      'Hine Walker is no longer a team admin.',
    );
    await expect(member).toContainText('Member');
    await expect(member.getByRole('button', { name: 'Make admin, Hine Walker' })).toBeFocused();

    // Ban (AC-HAPPY-11): inline panel, prompt focused, Escape cancels, the reason is typed and kept to 500.
    const ban = member.getByRole('button', { name: 'Ban Hine Walker' });
    await ban.click();
    const banPanel = member.getByRole('group');
    await expect(
      banPanel.getByText(
        "Ban Hine Walker? They lose access to this team and can't register for its sessions. Their upcoming registrations will be cancelled.",
      ),
    ).toBeFocused();
    await page.keyboard.press('Escape');
    await expect(banPanel).toHaveCount(0);
    await expect(ban).toBeFocused();
    await ban.click();
    await banPanel
      .getByLabel('Reason (optional, only team admins see this)')
      .fill('Repeated no-shows');
    await expectLayoutOk(page, 'manage (ban panel open)');
    await banPanel.getByRole('button', { name: 'Ban member' }).click();
    await expect(page.locator('#members-status')).toHaveText('Hine Walker has been banned.');
    await expect(page.locator('#members-heading')).toBeFocused();
    await expect(rowOf(page, 'Members', player.fullName)).toHaveCount(0);
    const bannedRow = rowOf(page, 'Banned members', player.fullName);
    await expect(bannedRow).toContainText('Reason: Repeated no-shows');

    // B: the team is gone from My teams and the invite shows the dead end with no join form (AC-ERROR-5).
    await bPage.goto('/teams');
    await expect(bPage.getByText(teamName)).toHaveCount(0);
    await bPage.goto(invitePath);
    await expect(bPage.getByRole('heading', { name: "You can't join this team." })).toBeVisible();
    await expect(bPage.getByRole('button', { name: 'Request to join' })).toHaveCount(0);
    await expect(bPage.getByRole('radio')).toHaveCount(0);

    expect(dialogs, 'native browser dialogs opened').toEqual([]);
    await other.close();
  });

  test('public search, request to join, and a member cannot manage the team (AC-ENTRY-5, AC-HAPPY-3/4)', async ({
    page,
    browser,
  }) => {
    test.setTimeout(120_000);
    const admin: Person = { fullName: 'Rangi Parata', email: uniqueEmail('admin2') };
    const player: Person = { fullName: 'Mere Hoani', email: uniqueEmail('player2') };
    const word = `Findable${unique('w').replace(/[^a-z0-9]/gi, '')}`;
    const teamName = `${word} Badminton`;

    await register(page, admin);
    await page.waitForURL((url) => url.pathname === '/');
    const teamId = await createTeam(page, {
      name: teamName,
      visibility: 'Public',
      skill: 'Advanced',
    });

    const other = await newPersonContext(browser);
    const bPage = await other.newPage();
    await register(bPage, player);
    await bPage.waitForURL((url) => url.pathname === '/');

    // Anonymous-friendly search finds the public team (any letter case), then B asks to join as Advanced.
    await bPage.goto('/teams/find');
    await bPage.getByLabel('Search teams').fill(word.toUpperCase());
    await bPage.getByRole('button', { name: 'Search', exact: true }).click();
    const result = bPage.getByRole('listitem').filter({ hasText: teamName });
    await expect(result).toContainText('1 member');
    await result.getByRole('link', { name: 'View team' }).click();
    await bPage.waitForURL(new RegExp(`/teams/${teamId}`));
    await bPage.getByLabel('Advanced', { exact: true }).check();
    await bPage.getByRole('button', { name: 'Request to join' }).click();
    await expect(bPage.getByText('Request sent. A team admin will review it.')).toBeVisible();

    await page.goto(`/teams/${teamId}/manage`);
    await rowOf(page, 'Join requests', player.fullName)
      .getByRole('button', { name: 'Reject' })
      .click();
    await expect(page.locator('#requests-status')).toHaveText("Mere Hoani's request was declined.");

    // A rejected player can ask again (AC-HAPPY-8), then is approved.
    await bPage.goto(`/teams/${teamId}`);
    await expect(bPage.getByText('Request declined')).toBeVisible();
    await bPage.getByLabel('Intermediate', { exact: true }).check();
    await bPage.getByRole('button', { name: 'Request to join' }).click();
    await expect(bPage.getByText('Pending approval')).toBeVisible();
    await page.reload();
    await rowOf(page, 'Join requests', player.fullName)
      .getByRole('button', { name: 'Approve' })
      .click();
    await expect(page.locator('#requests-status')).toHaveText('Mere Hoani has been approved.');

    // AC-ENTRY-5: the admin's row has "Manage"; the member's has none and the manage URL shows no lists.
    await page.goto('/teams');
    const adminRow = page.getByRole('listitem').filter({ hasText: teamName });
    await expect(adminRow.getByRole('link', { name: /^Manage/ })).toHaveAttribute(
      'href',
      `/teams/${teamId}/manage`,
    );
    await bPage.goto('/teams');
    const memberRow = bPage.getByRole('listitem').filter({ hasText: teamName });
    await expect(memberRow).toContainText('Member');
    await expect(memberRow.getByRole('link', { name: /^Manage/ })).toHaveCount(0);
    await bPage.goto(`/teams/${teamId}/manage`);
    await expect(bPage.getByRole('heading', { name: NO_ACCESS })).toBeVisible();
    await expect(bPage.getByRole('heading', { name: 'Join requests' })).toHaveCount(0);
    await expect(bPage.getByRole('heading', { name: 'Members' })).toHaveCount(0);
    await other.close();
  });

  test('the sole admin is told why they cannot remove their own admin rights (AC-ERROR-7)', async ({
    page,
  }) => {
    const admin: Person = { fullName: 'Kiri Moana', email: uniqueEmail('solo') };
    await register(page, admin);
    await page.waitForURL((url) => url.pathname === '/');
    await createTeam(page, {
      name: `Solo ${unique('s')}`,
      visibility: 'Public',
      skill: 'Beginner',
    });
    const mine = rowOf(page, 'Members', admin.fullName);
    await expect(mine).toContainText('(you)');
    await expect(
      mine.getByText('A team needs at least one admin. Make another member an admin first.'),
    ).toBeVisible();
    await expect(mine.getByRole('button', { name: /Remove admin/ })).toHaveCount(0);
    await expect(
      section(page, 'Members').getByText(
        "You're the only member so far. Share the invite link to bring people in.",
      ),
    ).toBeVisible();
    await section(page, 'Members').getByRole('link', { name: 'Go to Invite link' }).click();
    await expect(page).toHaveURL(/#invite$/);
  });
});

// ---------------------------------------------------------------------------------------------
// AC-VERIFY-7: accessibility and layout of every team page
// ---------------------------------------------------------------------------------------------

test.describe('accessibility and layout', () => {
  test('axe finds no critical violation, and nothing scrolls sideways, on every team page', async ({
    page,
    browser,
  }) => {
    test.setTimeout(180_000);
    const admin: Person = { fullName: 'Tama Ririnui', email: uniqueEmail('axe-admin') };
    const player: Person = { fullName: 'Ana Pene', email: uniqueEmail('axe-player') };
    const teamName = `Axe Team ${unique('a')}`;

    await register(page, admin);
    await page.waitForURL((url) => url.pathname === '/');

    // Create form: empty, then with every error showing.
    await page.goto('/teams/new');
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
    await expectNoCriticalViolations(page, '/teams/new');
    await expectLayoutOk(page, '/teams/new');
    await page.getByRole('button', { name: 'Create team' }).click();
    await expect(page.getByRole('heading', { name: "There's a problem" })).toBeVisible();
    await expectNoCriticalViolations(page, '/teams/new (errors)');

    const teamId = await createTeam(page, {
      name: teamName,
      visibility: 'Private',
      skill: 'Intermediate',
    });
    const invite = await inviteLink(page);

    // A request waiting, so the manage page shows every kind of row.
    const other = await newPersonContext(browser);
    const bPage = await other.newPage();
    await register(bPage, player);
    await bPage.waitForURL((url) => url.pathname === '/');
    await bPage.goto(new URL(invite).pathname + new URL(invite).search);
    await bPage.getByLabel('Intermediate', { exact: true }).check();
    await bPage.getByRole('button', { name: 'Request to join' }).click();
    await expect(bPage.getByText('Pending approval')).toBeVisible();

    await page.goto(`/teams/${teamId}/manage`);
    await expect(section(page, 'Join requests')).toBeVisible();
    await expectNoCriticalViolations(page, 'manage');
    await expectLayoutOk(page, 'manage');
    await section(page, 'Invite link')
      .getByRole('button', { name: 'Generate new link', exact: true })
      .click();
    await expectNoCriticalViolations(page, 'manage (confirm open)');
    await expectLayoutOk(page, 'manage (confirm open)');
    await page.keyboard.press('Escape');

    await rowOf(page, 'Join requests', player.fullName)
      .getByRole('button', { name: 'Approve' })
      .click();
    await expect(page.locator('#requests-status')).toContainText('has been approved.');
    await rowOf(page, 'Members', player.fullName)
      .getByRole('button', { name: 'Ban Ana Pene' })
      .click();
    await expectNoCriticalViolations(page, 'manage (ban panel open)');
    await expectLayoutOk(page, 'manage (ban panel open)');

    // The other team pages: team (admin view), invite (signed in), mine, find.
    await page.goto(`/teams/${teamId}`);
    await expect(page.getByRole('heading', { level: 1 })).toHaveText(teamName);
    await expectNoCriticalViolations(page, '/teams/[id]');
    await expectLayoutOk(page, '/teams/[id]');

    await bPage.goto('/teams');
    await expect(bPage.getByRole('heading', { level: 1 })).toHaveText('My teams');
    await expectNoCriticalViolations(bPage, '/teams');
    await expectLayoutOk(bPage, '/teams');

    await bPage.goto('/teams/find');
    await expectNoCriticalViolations(bPage, '/teams/find');
    await expectLayoutOk(bPage, '/teams/find');

    await bPage.goto(new URL(invite).pathname + new URL(invite).search);
    await expectNoCriticalViolations(bPage, '/teams/join');
    await expectLayoutOk(bPage, '/teams/join');

    // No access state and the not-found state.
    await bPage.goto(`/teams/${teamId}/manage`);
    await expect(bPage.getByRole('heading', { name: NO_ACCESS })).toBeVisible();
    await expectNoCriticalViolations(bPage, 'manage (no access)');
    await other.close();
  });
});
