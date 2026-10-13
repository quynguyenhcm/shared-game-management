import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

vi.mock('next/headers', () => ({
  cookies: () => Promise.resolve({ get: () => undefined, set: () => undefined }),
  headers: () => Promise.resolve(new Headers()),
}));
vi.mock('next/navigation', () => ({
  redirect: () => undefined,
  RedirectType: { replace: 'replace' },
}));

const { ErrorSummary } = await import('./error-summary.tsx');
const { ForgotPasswordForm } = await import('./forgot-password-form.tsx');
const { LoginForm } = await import('./login-form.tsx');
const { RegisterForm } = await import('./register-form.tsx');
const { ResetPasswordForm } = await import('./reset-password-form.tsx');
const { SexField } = await import('./sex-field.tsx');
const { TextField } = await import('./text-field.tsx');

const NO_PROVIDERS = { google: false, facebook: false };

function tag(html: string, pattern: RegExp): string {
  const match = pattern.exec(html);
  if (match === null) throw new Error(`no match for ${String(pattern)} in ${html}`);
  return match[0];
}

describe('register form (AC-ENTRY-3, AC-VERIFY-12)', () => {
  const html = renderToStaticMarkup(<RegisterForm returnTo="/account" />);

  it('renders the copy-deck labels, hints and button', () => {
    for (const text of [
      'Full name',
      'As your team will see it.',
      'Email',
      'We&#x27;ll send password reset links here.',
      'Password',
      'At least 10 characters. Avoid common passwords.',
      'Some teams set session prices by sex.',
      'Show password',
      'Create account',
    ]) {
      expect(html, text).toContain(text);
    }
    expect(html).toMatch(/<legend[^>]*>Sex<\/legend>/);
    expect(html).toContain('Already have an account?');
    expect(html).toContain('href="/login?returnTo=%2Faccount"');
  });

  it('offers Male, Female and Other with none preselected (AC-ENTRY-3)', () => {
    const radios = html.match(/<input[^>]*type="radio"[^>]*>/g) ?? [];
    expect(radios).toHaveLength(3);
    expect(radios.map((r) => /value="(\w+)"/.exec(r)?.[1])).toEqual(['MALE', 'FEMALE', 'OTHER']);
    for (const radio of radios) {
      expect(radio).toContain('name="sex"');
      expect(radio).not.toContain('checked');
    }
    expect(html).toMatch(/>Male</);
    expect(html).toMatch(/>Female</);
    expect(html).toMatch(/>Other</);
  });

  it('carries the phone input attributes and no autofocus (AC-VERIFY-12)', () => {
    const name = tag(html, /<input[^>]*name="fullName"[^>]*>/);
    expect(name).toContain('autoComplete="name"');
    expect(name).toContain('autoCapitalize="words"');
    const email = tag(html, /<input[^>]*name="email"[^>]*>/);
    expect(email).toContain('type="email"');
    expect(email).toContain('inputMode="email"');
    expect(email).toContain('autoComplete="email"');
    expect(email).toContain('autoCapitalize="none"');
    expect(email).toContain('autoCorrect="off"');
    expect(email).toContain('spellCheck="false"');
    expect(tag(html, /<input[^>]*name="password"[^>]*>/)).toContain('autoComplete="new-password"');
    expect(html).not.toMatch(/autofocus/i);
    expect(html).toMatch(/<input[^>]*type="hidden"[^>]*name="returnTo"[^>]*value="\/account"/);
  });
});

describe('login, forgot and reset forms', () => {
  it('login uses username and current-password autofill and links to reset with returnTo', () => {
    const html = renderToStaticMarkup(<LoginForm returnTo="/account" providers={NO_PROVIDERS} />);
    expect(tag(html, /<input[^>]*name="email"[^>]*>/)).toContain('autoComplete="username"');
    expect(tag(html, /<input[^>]*name="password"[^>]*>/)).toContain(
      'autoComplete="current-password"',
    );
    expect(html).toContain('Forgot your password?');
    expect(html).toContain('href="/forgot-password?returnTo=%2Faccount"');
    expect(html).toContain('Don&#x27;t have an account?');
    expect(html).toContain('Create one');
    expect(html).toContain('>Sign in<');
  });

  it("forgot-password prefills a signed-in user's email and has the Send reset link button", () => {
    const html = renderToStaticMarkup(<ForgotPasswordForm defaultEmail="aroha@example.com" />);
    expect(html).toContain('value="aroha@example.com"');
    expect(html).toContain('Send reset link');
  });

  it('reset form posts the token from a hidden field and warns about disconnecting providers (R1)', () => {
    const html = renderToStaticMarkup(<ResetPasswordForm token="tok-123" />);
    expect(html).toMatch(/<input[^>]*type="hidden"[^>]*name="token"[^>]*value="tok-123"/);
    expect(tag(html, /<input[^>]*name="password"[^>]*>/)).toContain('autoComplete="new-password"');
    expect(html).toContain('New password');
    expect(html).toContain(
      'Setting a new password signs you out on all your devices and disconnects any Google or Facebook sign-in.',
    );
    expect(html).toContain('Set new password');
  });
});

describe('accessibility primitives (AC-VERIFY-11)', () => {
  it('ties an invalid field to its hint and message with aria-invalid and aria-describedby', () => {
    const html = renderToStaticMarkup(
      <TextField
        name="email"
        label="Email"
        type="email"
        hint="We'll send links here."
        error="Enter a valid email address."
      />,
    );
    const input = tag(html, /<input[^>]*>/);
    expect(input).toContain('id="field-email"');
    expect(input).toContain('aria-invalid="true"');
    expect(input).toContain('aria-describedby="field-email-hint field-email-error"');
    expect(html).toContain('id="field-email-error"');
    expect(html).toMatch(/Error:<\/span>/);
    const clean = renderToStaticMarkup(<TextField name="email" label="Email" type="email" />);
    expect(clean).not.toContain('aria-invalid');
    expect(clean).not.toContain('aria-describedby');
  });

  it('gives the sex radio group a fieldset, legend, described-by error and a first radio the summary can target', () => {
    const html = renderToStaticMarkup(<SexField error="Select your sex to continue." />);
    expect(html).toMatch(/<fieldset[^>]*aria-describedby="field-sex-hint field-sex-error"/);
    expect(html).toMatch(/<legend[^>]*>Sex<\/legend>/);
    expect(tag(html, /<input[^>]*value="MALE"[^>]*>/)).toContain('id="field-sex"');
    expect(html).toContain('Select your sex to continue.');
  });

  it('renders an error summary that takes focus and links to each invalid field', () => {
    const html = renderToStaticMarkup(
      <ErrorSummary
        errors={{ sex: ['Select your sex to continue.'], email: ['Enter your email address.'] }}
        order={['fullName', 'email', 'password', 'sex']}
      />,
    );
    expect(html).toContain('role="alert"');
    expect(html).toContain('tabindex="-1"');
    expect(html).toContain('There&#x27;s a problem');
    const links = [...html.matchAll(/<a href="([^"]+)"[^>]*>([^<]+)<\/a>/g)].map((m) => [
      m[1],
      m[2],
    ]);
    expect(links).toEqual([
      ['#field-email', 'Enter your email address.'],
      ['#field-sex', 'Select your sex to continue.'],
    ]);
  });

  it('renders nothing for an empty summary', () => {
    expect(renderToStaticMarkup(<ErrorSummary errors={{}} order={[]} />)).toBe('');
  });
});
