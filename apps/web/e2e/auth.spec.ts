/**
 * Browser journeys for authentication (AC-INTEGRATION-4 and the browser half of AC-VERIFY-11/12), run on a
 * desktop and a 360 x 740 project against the real Compose stack (postgres, mailpit, api, worker, web) with
 * `AUTH_FAKE_OAUTH=true`:
 *   AUTH_FAKE_OAUTH=true docker compose up -d --build --wait && pnpm run test:e2e
 * Google and Facebook are played by the fake provider: the API hands out an authorize URL on the reserved
 * host `oauth.fake.invalid`, and `context.route` plays the consent screen by redirecting to the web's own
 * callback with a `fake.<payload>` code. Axe critical or serious violations fail the run.
 */
import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import AxeBuilder from '@axe-core/playwright';
import { expect, test, type BrowserContext, type Locator, type Page } from '@playwright/test';

const MAILPIT_API_URL = process.env.MAILPIT_API_URL ?? 'http://localhost:8025';
const REPO_ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const PASSWORD = 'kowhai-court-27';
const NEW_PASSWORD = 'tui-and-bellbird-91';

// ---------------------------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------------------------

let counter = 0;
/** A unique, lower-case address per call, so reruns and both projects never collide. */
function uniqueEmail(tag: string): string {
  counter += 1;
  return `e2e-${tag}-${Date.now().toString(36)}${counter}${randomBytes(2).toString('hex')}@example.test`;
}

const mainNav = (page: Page): Locator => page.getByRole('navigation', { name: 'Main' });

async function expectSignedInAs(page: Page, fullName: string): Promise<void> {
  await expect(mainNav(page)).toContainText(`Signed in as ${fullName}`);
}

async function expectSignedOut(page: Page): Promise<void> {
  await expect(mainNav(page).getByRole('link', { name: 'Sign in' })).toBeVisible();
  await expect(mainNav(page).getByRole('link', { name: 'Create account' })).toBeVisible();
}

async function register(
  page: Page,
  input: { fullName: string; email: string; sex?: 'Male' | 'Female' | 'Other'; returnTo?: string },
): Promise<void> {
  const query =
    input.returnTo === undefined ? '' : `?returnTo=${encodeURIComponent(input.returnTo)}`;
  await page.goto(`/register${query}`);
  await page.getByLabel('Full name').fill(input.fullName);
  await page.getByLabel('Email').fill(input.email);
  await page.getByLabel('Password', { exact: true }).fill(PASSWORD);
  await page.getByLabel(input.sex ?? 'Female').check();
  await page.getByRole('button', { name: 'Create account' }).click();
}

async function signIn(
  page: Page,
  email: string,
  password: string,
  returnTo?: string,
): Promise<void> {
  const query = returnTo === undefined ? '' : `?returnTo=${encodeURIComponent(returnTo)}`;
  await page.goto(`/login${query}`);
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password', { exact: true }).fill(password);
  await page.getByRole('button', { name: 'Sign in' }).click();
}

async function signOut(page: Page): Promise<void> {
  await mainNav(page).getByRole('button', { name: 'Sign out' }).click();
  await page.waitForURL(/\/login/);
}

// ---- Mailpit ---------------------------------------------------------------------------------

interface MailpitSearch {
  messages?: { ID: string; Subject: string }[];
}

/** Polls Mailpit until the reset email for `email` has arrived (the worker delivers it, AC-ASYNC-1) and returns the link. */
async function resetLinkFor(email: string): Promise<{ link: URL; subject: string; text: string }> {
  let found: { link: URL; subject: string; text: string } | undefined;
  await expect
    .poll(
      async () => {
        const search = await fetch(
          `${MAILPIT_API_URL}/api/v1/search?query=${encodeURIComponent(`to:${email}`)}`,
        );
        const body = (await search.json()) as MailpitSearch;
        const message = body.messages?.[0];
        if (message === undefined) return false;
        const detail = (await (
          await fetch(`${MAILPIT_API_URL}/api/v1/message/${message.ID}`)
        ).json()) as { Text: string; Subject: string };
        const match = /https?:\/\/\S+\/reset-password\?token=[\w-]+/.exec(detail.Text);
        if (match === null) return false;
        found = { link: new URL(match[0]), subject: detail.Subject, text: detail.Text };
        return true;
      },
      { timeout: 30_000, intervals: [500, 1000, 1000] },
    )
    .toBe(true);
  if (found === undefined) throw new Error('reset email not found');
  return found;
}

// ---- Fake OAuth provider ---------------------------------------------------------------------

type FakePayload =
  | {
      fixture:
        'google-verified' | 'google-unverified' | 'facebook-with-email' | 'facebook-no-email';
      sub?: string;
      email?: string;
      name?: string;
    }
  | { error: string };

/** The consent screen: `respondWith` sets what the next authorize redirect answers with. */
async function installFakeConsent(
  context: BrowserContext,
): Promise<{ respondWith: (payload: FakePayload) => void }> {
  let next: FakePayload = { error: 'access_denied' };
  await context.route('https://oauth.fake.invalid/**', async (route) => {
    const authorize = new URL(route.request().url());
    const redirectUri = authorize.searchParams.get('redirect_uri');
    const state = authorize.searchParams.get('state');
    if (redirectUri === null || state === null) {
      await route.fulfill({ status: 400, body: 'bad authorize request' });
      return;
    }
    const callback = new URL(redirectUri);
    callback.searchParams.set('state', state);
    if ('error' in next) callback.searchParams.set('error', next.error);
    else {
      callback.searchParams.set(
        'code',
        `fake.${Buffer.from(JSON.stringify(next)).toString('base64url')}`,
      );
    }
    await route.fulfill({ status: 302, headers: { location: callback.toString() } });
  });
  return {
    respondWith: (payload) => {
      next = payload;
    },
  };
}

/** From `/login`, "Continue with Google", through the fake consent, to `/register/complete`. */
async function startGoogleSignup(
  page: Page,
  consent: { respondWith: (payload: FakePayload) => void },
  profile: { email: string; name: string },
  returnTo?: string,
): Promise<void> {
  consent.respondWith({
    fixture: 'google-verified',
    sub: `g-${randomBytes(6).toString('hex')}`,
    email: profile.email,
    name: profile.name,
  });
  const query = returnTo === undefined ? '' : `?returnTo=${encodeURIComponent(returnTo)}`;
  await page.goto(`/login${query}`);
  await page.getByRole('button', { name: 'Continue with Google' }).click();
  await page.waitForURL('**/register/complete');
}

// ---- Accessibility ---------------------------------------------------------------------------

/** AC-VERIFY-11: no axe critical or serious violation (WCAG 2.x A and AA rules). */
async function expectNoBlockingViolations(page: Page, label: string): Promise<void> {
  const results = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'])
    .analyze();
  const blocking = results.violations
    .filter((violation) => violation.impact === 'critical' || violation.impact === 'serious')
    .map(
      (violation) =>
        `${violation.id} (${violation.impact ?? '?'}): ${violation.help} -> ${violation.nodes
          .slice(0, 3)
          .map((node) => node.target.join(' '))
          .join(' | ')}`,
    );
  expect(blocking, `axe violations on ${label}`).toEqual([]);
}

const errorSummary = (page: Page): Locator =>
  page.getByRole('alert').filter({ has: page.getByRole('heading', { name: "There's a problem" }) });

// ---------------------------------------------------------------------------------------------
// Journeys
// ---------------------------------------------------------------------------------------------

test.describe('journeys', () => {
  test('register, sign out, sign in, reset via Mailpit, sign in again (AC-HAPPY-1, 2, 6, 7; AC-INTEGRATION-1, 4)', async ({
    page,
    context,
  }) => {
    const email = uniqueEmail('journey');
    const fullName = 'Aroha Ngata';

    // Register with a returnTo; the welcome notice shows once and Back never shows the form again.
    await register(page, { fullName, email, returnTo: '/account' });
    await page.waitForURL('**/account');
    await expectSignedInAs(page, fullName);
    await expect(page.getByText('Welcome! Your account is ready.')).toBeVisible();
    await page.reload();
    await expect(page.getByText('Welcome! Your account is ready.')).toHaveCount(0);
    await page.goBack();
    await expect(page.getByLabel('Full name')).toHaveCount(0);
    await page.goto('/account');

    // The web owns the cookie: HttpOnly, SameSite=Lax, path / (AC-VERIFY-2).
    const sessionCookie = (await context.cookies()).find((cookie) =>
      cookie.name.endsWith('sgm_session'),
    );
    expect(sessionCookie).toMatchObject({ httpOnly: true, sameSite: 'Lax', path: '/' });
    expect(await page.evaluate(() => document.cookie)).not.toContain('sgm_session');

    // Sign out ends the session for real.
    await signOut(page);
    await expect(page.getByText("You've signed out.")).toBeVisible();
    await expectSignedOut(page);
    expect((await context.cookies()).some((cookie) => cookie.name.endsWith('sgm_session'))).toBe(
      false,
    );

    // Sign in again: the email is case-insensitive.
    await signIn(page, email.toUpperCase(), PASSWORD);
    await page.waitForURL((url) => url.pathname === '/');
    await expectSignedInAs(page, fullName);
    await signOut(page);

    // Forgot password from the login page, then the emailed link (delivered by the worker over SMTP).
    await page.getByRole('link', { name: 'Forgot your password?' }).click();
    await page.waitForURL('**/forgot-password**');
    await page.getByLabel('Email').fill(email);
    await page.getByRole('button', { name: 'Send reset link' }).click();
    await expect(page.getByRole('heading', { name: 'Check your email' })).toBeVisible();
    await expect(
      page.getByText("If an account exists for that email, we've sent a reset link."),
    ).toBeVisible();

    const { link, subject, text } = await resetLinkFor(email);
    expect(subject).toBe('Reset your Shared Game Management password');
    expect(text).toContain('expires in 60 minutes');
    expect(text).toContain("If you didn't request this, ignore this email.");
    const resetPath = `${link.pathname}${link.search}`;
    const resetResponse = await page.goto(resetPath);
    expect(resetResponse?.headers()['referrer-policy']).toBe('no-referrer');
    expect(resetResponse?.headers()['cache-control']).toContain('no-store');
    await page.getByLabel('New password').fill(NEW_PASSWORD);
    await page.getByRole('button', { name: 'Set new password' }).click();
    await page.waitForURL('**/login**');
    await expect(page.getByText('Password updated. Sign in with your new password.')).toBeVisible();

    // The old password no longer works; the new one does.
    await signIn(page, email, PASSWORD);
    await expect(page.getByText('Incorrect email or password.')).toBeVisible();
    await signIn(page, email, NEW_PASSWORD);
    await page.waitForURL((url) => url.pathname === '/');
    await expectSignedInAs(page, fullName);

    // The link works once.
    const other = await context.browser()?.newContext({ baseURL: page.url() });
    const fresh = await other?.newPage();
    if (fresh === undefined) throw new Error('could not open a second browser context');
    await fresh.goto(resetPath);
    await fresh.getByLabel('New password').fill('another-fine-passphrase-5');
    await fresh.getByRole('button', { name: 'Set new password' }).click();
    await expect(fresh.getByText(/This reset link is invalid or has expired\./)).toBeVisible();
    await other?.close();
  });

  test('anonymous visitor is sent to sign in and brought back (AC-ENTRY-1, 4, 5)', async ({
    page,
  }) => {
    const email = uniqueEmail('entry');
    await page.goto('/');
    await expectSignedOut(page);
    await expect(mainNav(page).getByRole('link', { name: 'Sign in' })).toHaveAttribute(
      'href',
      '/login',
    );

    await register(page, { fullName: 'Hine Walker', email });
    await page.waitForURL((url) => url.pathname === '/');
    await signOut(page);

    await page.goto('/account');
    await expect(page).toHaveURL(/\/login\?returnTo=%2Faccount/);
    await page.getByLabel('Email').fill(email);
    await page.getByLabel('Password', { exact: true }).fill(PASSWORD);
    await page.getByRole('button', { name: 'Sign in' }).click();
    await page.waitForURL('**/account');
    await expectSignedInAs(page, 'Hine Walker');

    // A signed-in user never sees the auth forms again.
    await page.goto('/login?returnTo=%2Faccount');
    await page.waitForURL('**/account');
    await page.goto('/register');
    await page.waitForURL((url) => url.pathname === '/');

    // An open-redirect returnTo is ignored.
    await signOut(page);
    await signIn(page, email, PASSWORD, 'https://evil.example/');
    await page.waitForURL((url) => url.pathname === '/');
    expect(new URL(page.url()).origin).not.toContain('evil');
  });

  test('first-time Google user must choose a sex before the account exists (AC-HAPPY-3, AC-ENTRY-3)', async ({
    page,
    context,
  }) => {
    const consent = await installFakeConsent(context);
    const email = uniqueEmail('google');
    const profile = { email, name: 'Wiremu Tane' };
    await startGoogleSignup(page, consent, profile, '/account');

    // The name comes prefilled; Sex is required and nothing is preselected.
    await expect(page.getByLabel('Full name')).toHaveValue('Wiremu Tane');
    await expect(page.getByRole('radio', { checked: true })).toHaveCount(0);
    await page.getByRole('button', { name: 'Finish sign-up' }).click();
    await expect(errorSummary(page)).toContainText('Select your sex to continue.');
    await page.getByLabel('Male', { exact: true }).check();
    await page.getByRole('button', { name: 'Finish sign-up' }).click();
    await page.waitForURL('**/account');
    await expectSignedInAs(page, 'Wiremu Tane');
    await expect(page.getByText('Welcome! Your account is ready.')).toBeVisible();

    // The account exists only now: the account page lists Google as connected.
    await page.goto('/account');
    const googleRow = page.getByRole('listitem').filter({ hasText: 'Google' });
    await expect(googleRow.getByText('Connected', { exact: true })).toBeVisible();
    const facebookRow = page.getByRole('listitem').filter({ hasText: 'Facebook' });
    await expect(facebookRow.getByText('Not connected', { exact: true })).toBeVisible();
  });

  test('returning Google user signs in directly (AC-HAPPY-5)', async ({ page, context }) => {
    const consent = await installFakeConsent(context);
    const email = uniqueEmail('google-return');
    const sub = `g-${randomBytes(6).toString('hex')}`;
    consent.respondWith({ fixture: 'google-verified', sub, email, name: 'Manu Rua' });
    await page.goto('/login');
    await page.getByRole('button', { name: 'Continue with Google' }).click();
    await page.waitForURL('**/register/complete');
    await page.getByLabel('Other').check();
    await page.getByRole('button', { name: 'Finish sign-up' }).click();
    await page.waitForURL((url) => url.pathname === '/');
    await expectSignedInAs(page, 'Manu Rua');
    await signOut(page);

    await page.getByRole('button', { name: 'Continue with Google' }).click();
    await page.waitForURL((url) => url.pathname === '/');
    await expectSignedInAs(page, 'Manu Rua');
    expect(page.url()).not.toContain('register/complete');
  });

  test('an OAuth email that matches a password account lands on a conflict page without the email in the URL (AC-ERROR-8, 20)', async ({
    page,
    context,
  }) => {
    const consent = await installFakeConsent(context);
    const email = uniqueEmail('conflict');
    await register(page, { fullName: 'Aroha Ngata', email });
    await page.waitForURL((url) => url.pathname === '/');
    await signOut(page);

    consent.respondWith({
      fixture: 'facebook-with-email',
      sub: `f-${randomBytes(6).toString('hex')}`,
      email,
      name: 'Aroha Ngata',
    });
    await page.goto('/login?returnTo=%2Faccount');
    await page.getByRole('button', { name: 'Continue with Facebook' }).click();
    await page.waitForURL('**/login**');
    await expect(page.getByRole('alert')).toContainText(`An account already exists for ${email}.`);
    // Only codes travel in the URL (the page strips them after render); never the address.
    expect(decodeURIComponent(page.url())).not.toContain(email);
    await expectSignedOut(page);
    await expect(page.getByRole('link', { name: 'Forgot your password?' }).first()).toBeVisible();

    // Signing in with the form on that page still lands on the original returnTo.
    await page.getByLabel('Email').fill(email);
    await page.getByLabel('Password', { exact: true }).fill(PASSWORD);
    await page.getByRole('button', { name: 'Sign in' }).click();
    await page.waitForURL('**/account');
  });

  test('cancelling consent returns to sign in with the returnTo kept (AC-ERROR-7)', async ({
    page,
    context,
  }) => {
    const consent = await installFakeConsent(context);
    consent.respondWith({ error: 'access_denied' });
    await page.goto('/login?returnTo=%2Faccount');
    await page.getByRole('button', { name: 'Continue with Google' }).click();
    await page.waitForURL('**/login**');
    await expect(page.getByRole('alert')).toContainText('Google sign-in was cancelled.');
    // The retry still lands on /account.
    expect(new URL(page.url()).searchParams.get('returnTo')).toBe('/account');
  });

  test('a sign-up finished in another tab resolves to the signed-in state (AC-ENTRY-8)', async ({
    page,
    context,
  }) => {
    const consent = await installFakeConsent(context);
    await startGoogleSignup(page, consent, { email: uniqueEmail('twotab'), name: 'Kiri Moana' });

    const tabB = await context.newPage();
    await tabB.goto('/register/complete');
    await expect(tabB.getByRole('button', { name: 'Finish sign-up' })).toBeVisible();

    await page.getByLabel('Female').check();
    await page.getByRole('button', { name: 'Finish sign-up' }).click();
    await page.waitForURL((url) => url.pathname === '/');
    await expectSignedInAs(page, 'Kiri Moana');

    // Tab B submits after tab A finished: signed in, no error, nothing used twice.
    await tabB.getByLabel('Male', { exact: true }).check();
    await tabB.getByRole('button', { name: 'Finish sign-up' }).click();
    await tabB.waitForURL((url) => url.pathname === '/');
    await expectSignedInAs(tabB, 'Kiri Moana');
    await expect(tabB.getByRole('alert').filter({ hasText: /expired|problem/i })).toHaveCount(0);

    // A used callback URL replayed in the signed-in browser goes home silently.
    await tabB.goto('/auth/callback/google?state=used&code=used');
    await tabB.waitForURL((url) => url.pathname === '/');
    await expect(tabB.getByRole('alert').filter({ hasText: /verify/i })).toHaveCount(0);
  });

  test('a duplicate email keeps the form and moves focus to the error banner (AC-ERROR-1)', async ({
    page,
  }) => {
    const email = uniqueEmail('dupe');
    await register(page, { fullName: 'Aroha Ngata', email });
    await page.waitForURL((url) => url.pathname === '/');
    await signOut(page);

    await page.goto('/register');
    await page.getByLabel('Full name').fill('Aroha Again');
    await page.getByLabel('Email').fill(email.toUpperCase());
    await page.getByLabel('Password', { exact: true }).fill(PASSWORD);
    await page.getByLabel('Male', { exact: true }).check();
    await page.getByRole('button', { name: 'Create account' }).click();

    const banner = page
      .getByRole('alert')
      .filter({ hasText: 'An account with this email already exists.' });
    await expect(banner).toBeVisible();
    await expect(banner).toBeFocused();
    await expect(banner.getByRole('link', { name: 'Sign in instead' })).toBeVisible();
    await expect(banner.getByRole('link', { name: 'Reset your password' })).toBeVisible();
    await expect(page.getByLabel('Full name')).toHaveValue('Aroha Again');
    await expect(page.getByLabel('Password', { exact: true })).toHaveValue('');
    await expect(page.getByLabel('Male', { exact: true })).toBeChecked();
  });
});

// ---------------------------------------------------------------------------------------------
// Trace continuity (AC-INTEGRATION-4)
// ---------------------------------------------------------------------------------------------

test.describe('trace continuity web to API', () => {
  const traceId = randomBytes(16).toString('hex');
  test.use({
    extraHTTPHeaders: { traceparent: `00-${traceId}-${randomBytes(8).toString('hex')}-01` },
  });

  test('the API log line for POST /auth/login carries the traceparent of the web request', async ({
    page,
  }) => {
    const email = uniqueEmail('trace');
    await register(page, { fullName: 'Tama Ririnui', email });
    await page.waitForURL((url) => url.pathname === '/');
    await signOut(page);
    await signIn(page, email, PASSWORD);
    await page.waitForURL((url) => url.pathname === '/');

    const command = (
      process.env.E2E_API_LOG_COMMAND ?? 'docker compose logs --no-log-prefix --since 15m api'
    ).split(' ');
    const [file, ...args] = command;
    let logs: string;
    try {
      logs = (
        await promisify(execFile)(file ?? 'docker', args, {
          cwd: REPO_ROOT,
          maxBuffer: 256 * 1024 * 1024,
        })
      ).stdout;
    } catch (error) {
      test.skip(
        true,
        `API logs are not readable (${String(error).slice(0, 120)}); set E2E_API_LOG_COMMAND`,
      );
      return;
    }
    const lines = logs
      .split('\n')
      .filter((line) => line.startsWith('{'))
      .map((line) => {
        try {
          return JSON.parse(line) as {
            traceId?: string;
            event?: string;
            message?: string;
            req?: { method?: string; url?: string };
          };
        } catch {
          return {};
        }
      })
      .filter((line) => line.traceId === traceId);
    expect(
      lines.some(
        (line) =>
          line.message === 'incoming request' &&
          line.req?.method === 'POST' &&
          line.req.url === '/auth/login',
      ),
      'incoming POST /auth/login line with the web traceId',
    ).toBe(true);
    expect(lines.some((line) => line.event === 'auth.login.succeeded')).toBe(true);
  });
});

// ---------------------------------------------------------------------------------------------
// Accessibility (AC-VERIFY-11)
// ---------------------------------------------------------------------------------------------

test.describe('accessibility', () => {
  test('axe reports no critical or serious violations on the public auth pages', async ({
    page,
  }) => {
    for (const path of ['/login', '/register', '/forgot-password']) {
      await page.goto(path);
      await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
      await expectNoBlockingViolations(page, path);
    }
    await page.goto('/login?error=invalid_credentials&notice=signed_out');
    await expectNoBlockingViolations(page, '/login with banners');

    // Forgot-password, second state ("Check your email").
    await page.goto('/forgot-password');
    await page.getByLabel('Email').fill(uniqueEmail('axe'));
    await page.getByRole('button', { name: 'Send reset link' }).click();
    await expect(page.getByRole('heading', { name: 'Check your email' })).toBeVisible();
    await expectNoBlockingViolations(page, '/forgot-password (sent)');

    // Reset page: the form, and the dead-link state.
    await page.goto('/reset-password?token=not-a-real-token');
    await expect(page.getByLabel('New password')).toBeVisible();
    await expectNoBlockingViolations(page, '/reset-password');
    await page.goto('/reset-password');
    await expect(page.getByRole('main').getByRole('alert')).toBeVisible();
    await expectNoBlockingViolations(page, '/reset-password (no token)');
  });

  test('axe reports no critical or serious violations on /register/complete and /account', async ({
    page,
    context,
  }) => {
    const consent = await installFakeConsent(context);
    await startGoogleSignup(page, consent, { email: uniqueEmail('axe2'), name: 'Rangi Parata' });
    await expectNoBlockingViolations(page, '/register/complete');
    await page.getByRole('button', { name: 'Finish sign-up' }).click();
    await expect(errorSummary(page)).toBeVisible();
    await expectNoBlockingViolations(page, '/register/complete with errors');
    await page.getByLabel('Female').check();
    await page.getByRole('button', { name: 'Finish sign-up' }).click();
    await page.waitForURL((url) => url.pathname === '/');

    await page.goto('/account');
    await expect(page.getByRole('heading', { name: 'Sign-in methods' })).toBeVisible();
    await expectNoBlockingViolations(page, '/account');
  });

  test('validation failure moves focus to the error summary and wires every field (AC-VERIFY-11)', async ({
    page,
  }) => {
    await page.goto('/register');
    const requests: string[] = [];
    page.on('request', (request) => {
      if (request.method() === 'POST') requests.push(request.url());
    });
    await page.getByRole('button', { name: 'Create account' }).click();

    const summary = errorSummary(page);
    await expect(summary).toBeFocused();
    await expect(page).toHaveTitle(/^Error: /);
    // The submit button stayed enabled and nothing was sent.
    await expect(page.getByRole('button', { name: 'Create account' })).toBeEnabled();
    expect(requests).toEqual([]);

    for (const name of ['fullName', 'email', 'password']) {
      const input = page.locator(`#field-${name}`);
      await expect(input).toHaveAttribute('aria-invalid', 'true');
      const describedBy = (await input.getAttribute('aria-describedby')) ?? '';
      expect(describedBy).toContain(`field-${name}-error`);
      await expect(page.locator(`#field-${name}-error`)).not.toBeEmpty();
    }
    const fieldset = page.getByRole('group', { name: /^Sex/ });
    expect(await fieldset.getAttribute('aria-describedby')).toContain('field-sex-error');

    // Each summary item links to its field and moves focus there.
    await summary.getByRole('link', { name: 'Select your sex to continue.' }).click();
    await expect(page.locator('#field-sex')).toBeFocused();
    await summary.getByRole('link', { name: 'Enter your name.' }).click();
    await expect(page.locator('#field-fullName')).toBeFocused();

    // The radio group is operable with arrow keys.
    await page.locator('#field-sex').focus();
    await page.keyboard.press('ArrowDown');
    await expect(page.getByLabel('Female')).toBeChecked();
    await expect(page.getByLabel('Female')).toBeFocused();
    await page.keyboard.press('ArrowDown');
    await expect(page.getByLabel('Other')).toBeChecked();
  });

  test('/register/complete: missing sex focuses the summary and the title gets the Error prefix (AC-VERIFY-11)', async ({
    page,
    context,
  }) => {
    const consent = await installFakeConsent(context);
    await startGoogleSignup(page, consent, { email: uniqueEmail('focus'), name: 'Mere Hoani' });
    await page.getByRole('button', { name: 'Finish sign-up' }).click();
    await expect(errorSummary(page)).toBeFocused();
    await expect(page).toHaveTitle(/^Error: /);
    await expect(page.getByRole('group', { name: /^Sex/ })).toHaveAttribute(
      'aria-describedby',
      /field-sex-error/,
    );
    await page.getByRole('link', { name: 'Select your sex to continue.' }).click();
    await expect(page.locator('#field-sex')).toBeFocused();

    // "Use a different account" clears the pending sign-up and returns to /login without validation.
    await page.getByRole('button', { name: 'Use a different account' }).click();
    await page.waitForURL('**/login**');
    await page.goto('/register/complete');
    await page.waitForURL('**/login**');
    await expect(page.getByText('Your sign-up session expired. Please start again.')).toBeVisible();
  });

  test('a notice on load keeps focus on the page; an error on load takes focus once (AC-VERIFY-11)', async ({
    page,
  }) => {
    await page.goto('/login?notice=signed_out');
    const notice = page.getByRole('status').filter({ hasText: "You've signed out." });
    await expect(notice).toBeVisible();
    expect(await page.evaluate(() => document.activeElement?.tagName)).toBe('BODY');
    // The notice sits after the H1.
    const [h1, status] = await Promise.all([
      page.getByRole('heading', { level: 1 }).boundingBox(),
      notice.boundingBox(),
    ]);
    expect((status?.y ?? 0) > (h1?.y ?? 0)).toBe(true);

    await page.goto('/login?error=signup_expired');
    const alert = page.getByRole('alert').filter({ hasText: 'Your sign-up session expired.' });
    await expect(alert).toBeFocused();
  });

  test('Server errors move focus to the banner: wrong password on sign-in (AC-VERIFY-11, AC-ERROR-3)', async ({
    page,
  }) => {
    await signIn(page, uniqueEmail('nobody'), 'some-wrong-passphrase-1');
    const banner = page.getByRole('alert').filter({ hasText: 'Incorrect email or password.' });
    await expect(banner).toBeFocused();
    await expect(page.getByLabel('Password', { exact: true })).toHaveValue('');
  });
});

// ---------------------------------------------------------------------------------------------
// Phone layout (AC-VERIFY-12, 360 x 740 project only)
// ---------------------------------------------------------------------------------------------

test.describe('phone layout', () => {
  test.skip(({ isMobile }) => !isMobile, 'runs on the 360 x 740 project only');

  async function expectPhoneFriendly(page: Page, label: string): Promise<void> {
    const viewport = page.viewportSize();
    expect(viewport).toEqual({ width: 360, height: 740 });

    // No horizontal scroll.
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(overflow, `${label}: horizontal overflow`).toBeLessThanOrEqual(0);

    // No field is auto-focused (an error summary or banner may take focus: that is a message, not a field).
    expect(
      await page.evaluate(() => document.activeElement?.tagName),
      `${label}: autofocus`,
    ).not.toMatch(/^(INPUT|TEXTAREA|SELECT|BUTTON|A)$/);

    // Inputs use at least 16 px text; every tap target is at least 44 x 44 px.
    const problems = await page.evaluate(() => {
      const found: string[] = [];
      const visible = (element: Element): boolean => {
        const box = element.getBoundingClientRect();
        const style = getComputedStyle(element);
        return box.width > 0 && box.height > 0 && style.visibility !== 'hidden';
      };
      for (const input of document.querySelectorAll('input:not([type=hidden]):not([type=radio])')) {
        if (visible(input) && Number.parseFloat(getComputedStyle(input).fontSize) < 16) {
          found.push(`input#${input.id} font-size < 16px`);
        }
      }
      const targets = document.querySelectorAll(
        'button, a[href], input[type=radio], label:has(input[type=radio])',
      );
      for (const target of targets) {
        if (!visible(target)) continue;
        // A radio input is covered by its 44 px label; check the label, not the 20 px control.
        if (target instanceof HTMLInputElement) continue;
        const box = target.getBoundingClientRect();
        if (box.width < 44 || box.height < 44) {
          found.push(
            `${target.tagName.toLowerCase()} "${(target.textContent ?? '').trim().slice(0, 30)}" is ${Math.round(box.width)}x${Math.round(box.height)}`,
          );
        }
      }
      return found;
    });
    expect(problems, `${label}: input size and tap targets`).toEqual([]);

    // The OAuth buttons sit above the first email-form field.
    const google = page.getByRole('button', { name: 'Continue with Google' });
    const emailField = page.locator('#field-email, #field-fullName').first();
    if ((await google.count()) > 0) {
      const [g, f] = await Promise.all([google.boundingBox(), emailField.boundingBox()]);
      expect(
        (g?.y ?? Number.POSITIVE_INFINITY) < (f?.y ?? 0),
        `${label}: OAuth above the form`,
      ).toBe(true);
    }
  }

  test('/login and /register', async ({ page }) => {
    await page.goto('/login');
    await expectPhoneFriendly(page, '/login');
    const email = page.getByLabel('Email');
    await expect(email).toHaveAttribute('type', 'email');
    await expect(email).toHaveAttribute('autocapitalize', 'none');
    await expect(page.getByLabel('Password', { exact: true })).toHaveAttribute(
      'autocomplete',
      'current-password',
    );
    await expect(page.getByRole('button', { name: 'Show password' })).toBeVisible();

    await page.goto('/register');
    await expectPhoneFriendly(page, '/register');
    await expect(page.getByLabel('Email')).toHaveAttribute('type', 'email');
    await expect(page.getByLabel('Email')).toHaveAttribute('autocapitalize', 'none');
    await expect(page.getByLabel('Password', { exact: true })).toHaveAttribute(
      'autocomplete',
      'new-password',
    );
    await expect(page.getByRole('button', { name: 'Show password' })).toBeVisible();

    // Show password toggles the input type.
    await page.getByLabel('Password', { exact: true }).fill(PASSWORD);
    await page.getByRole('button', { name: 'Show password' }).click();
    await expect(page.getByLabel('Password', { exact: true })).toHaveAttribute('type', 'text');
  });

  test('/register/complete and its banners', async ({ page, context }) => {
    const consent = await installFakeConsent(context);
    await startGoogleSignup(page, consent, { email: uniqueEmail('phone'), name: 'Ana Pene' });
    await expectPhoneFriendly(page, '/register/complete');
    await page.getByRole('button', { name: 'Finish sign-up' }).click();
    await expect(errorSummary(page)).toBeVisible();
    await expectPhoneFriendly(page, '/register/complete (errors)');
  });

  test('banners with links keep 44 px targets', async ({ page }) => {
    await page.goto('/login?error=oauth_account_exists&provider=google&returnTo=%2Faccount');
    await expect(page.getByRole('alert').first()).toBeVisible();
    await expectPhoneFriendly(page, '/login (conflict banner)');
  });
});
