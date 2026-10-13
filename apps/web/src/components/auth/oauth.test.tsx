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

const { CompleteSignupForm } = await import('./complete-signup-form.tsx');
const { OAuthButtons, TryFacebookAgain } = await import('./oauth-buttons.tsx');
const { SignInMethods } = await import('./sign-in-methods.tsx');
const { validateCompleteSignup } = await import('../../lib/auth/validation.ts');

const BOTH = { google: true, facebook: true };
const HINT =
  'Google sign-in doesn&#x27;t work inside the Facebook or Instagram app. Open this page in your browser (use the app&#x27;s menu, then &quot;Open in browser&quot;), or use another sign-in method.';
const UNAVAILABLE =
  'Sign-in is having trouble right now. Google and Facebook buttons will be back shortly. You can still try email and password.';

describe('OAuth buttons (AC-ENTRY-2, AC-ERROR-10, AC-ERROR-18, AC-VERIFY-13)', () => {
  it('shows Continue with Google then Facebook, carrying provider and returnTo', () => {
    const html = renderToStaticMarkup(
      <OAuthButtons providers={BOTH} unavailable={false} returnTo="/account" />,
    );
    expect(html.indexOf('Continue with Google')).toBeGreaterThan(-1);
    expect(html.indexOf('Continue with Google')).toBeLessThan(
      html.indexOf('Continue with Facebook'),
    );
    const buttons = html.match(/<button[^>]*>/g) ?? [];
    expect(buttons).toHaveLength(2);
    expect(buttons[0]).toContain('value="google"');
    expect(buttons[1]).toContain('value="facebook"');
    for (const button of buttons) expect(button).toContain('name="provider"');
    expect(html).toMatch(/<input[^>]*type="hidden"[^>]*name="returnTo"[^>]*value="\/account"/);
    expect(html).not.toContain(HINT);
  });

  it('hides a disabled provider and renders nothing when neither is enabled', () => {
    const facebookOnly = renderToStaticMarkup(
      <OAuthButtons providers={{ google: false, facebook: true }} unavailable={false} />,
    );
    expect(facebookOnly).not.toContain('Google');
    expect(facebookOnly).toContain('Continue with Facebook');
    expect(
      renderToStaticMarkup(
        <OAuthButtons providers={{ google: false, facebook: false }} unavailable={false} />,
      ),
    ).toBe('');
  });

  it('puts the in-app browser hint directly above Continue with Google, and only when Google is enabled', () => {
    const html = renderToStaticMarkup(
      <OAuthButtons providers={BOTH} unavailable={false} inAppBrowser />,
    );
    const hint = html.indexOf(HINT);
    const google = html.indexOf('Continue with Google');
    expect(hint).toBeGreaterThan(-1);
    expect(hint).toBeLessThan(google);
    // Nothing but the hint's own closing tag sits between it and the Google button.
    const firstButton = html.indexOf('<button', hint);
    expect(html.slice(hint, firstButton).endsWith('</p>')).toBe(true);
    expect(html.slice(firstButton)).toMatch(/^<button[^>]*>Continue with Google/);
    expect(html.indexOf('Continue with Facebook')).toBeGreaterThan(google);
    const noGoogle = renderToStaticMarkup(
      <OAuthButtons
        providers={{ google: false, facebook: true }}
        unavailable={false}
        inAppBrowser
      />,
    );
    expect(noGoogle).not.toContain('Open in browser');
  });

  it('replaces the buttons with the trouble hint when the providers call failed', () => {
    const html = renderToStaticMarkup(<OAuthButtons providers={BOTH} unavailable />);
    expect(html).toContain(UNAVAILABLE);
    expect(html).not.toContain('Continue with');
  });

  it('offers "Try Facebook again" as a form that restarts authorize with rerequest', () => {
    const html = renderToStaticMarkup(<TryFacebookAgain returnTo="/account" />);
    expect(html).toContain('Try Facebook again');
    expect(html).toMatch(/<input[^>]*name="provider"[^>]*value="facebook"/);
    expect(html).toMatch(/<input[^>]*name="rerequest"[^>]*value="true"/);
    expect(html).toMatch(/<input[^>]*name="returnTo"[^>]*value="\/account"/);
  });
});

describe('/register/complete form (AC-HAPPY-3/4, AC-ERROR-14)', () => {
  const html = renderToStaticMarkup(
    <CompleteSignupForm
      provider="google"
      email="aroha.ngata@example.com"
      fullName="Aroha Ngata"
      returnTo="/account"
    />,
  );

  it('prefills the name, names the provider and email, and has both buttons', () => {
    expect(html).toContain('You&#x27;re signing up with Google as aroha.ngata@example.com.');
    expect(html).toMatch(/<input[^>]*name="fullName"[^>]*value="Aroha Ngata"/);
    expect(html).toContain('Finish sign-up');
    expect(html).toContain('Use a different account');
    expect(html).toMatch(/<input[^>]*type="hidden"[^>]*name="returnTo"[^>]*value="\/account"/);
    expect(html).not.toMatch(/autofocus/i);
  });

  it('offers Sex as a required fieldset with no radio preselected, and the client blocks an empty choice', () => {
    expect(html).toMatch(/<legend[^>]*>Sex<\/legend>/);
    const radios = html.match(/<input[^>]*type="radio"[^>]*>/g) ?? [];
    expect(radios).toHaveLength(3);
    for (const radio of radios) expect(radio).not.toContain('checked');
    expect(validateCompleteSignup({ fullName: 'Aroha Ngata', sex: undefined })).toEqual({
      sex: ['Select your sex to continue.'],
    });
    expect(validateCompleteSignup({ fullName: ' ', sex: 'FEMALE' })).toEqual({
      fullName: ['Enter your name.'],
    });
    expect(validateCompleteSignup({ fullName: 'Aroha Ngata', sex: 'FEMALE' })).toEqual({});
  });
});

describe('/account sign-in methods (AC-HAPPY-11/12, AC-ERROR-17)', () => {
  const identity = (provider: 'PASSWORD' | 'GOOGLE' | 'FACEBOOK') => ({
    provider,
    connectedAt: '2026-10-01T00:00:00.000Z',
    lastUsedAt: null,
  });

  it('lists methods in order with Connect for an enabled provider that is not connected', () => {
    const html = renderToStaticMarkup(
      <SignInMethods
        identities={[identity('PASSWORD'), identity('GOOGLE')]}
        enabledProviders={BOTH}
      />,
    );
    const order = ['Email and password', 'Google', 'Facebook'].map((name) =>
      html.indexOf(`>${name}<`),
    );
    expect(order.every((index) => index > -1)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    expect(html).toContain('Connect Facebook');
    expect(html).toMatch(/aria-label="Disconnect Google"/);
    expect(html).not.toMatch(/aria-disabled="true"/);
    expect(html).not.toContain('Set a password');
    expect(html).not.toContain('You need at least one way to sign in.');
  });

  it('hides a disabled, unconnected provider but keeps a connected one even when disabled', () => {
    const html = renderToStaticMarkup(
      <SignInMethods
        identities={[identity('PASSWORD'), identity('FACEBOOK')]}
        enabledProviders={{ google: false, facebook: false }}
      />,
    );
    expect(html).not.toContain('>Google<');
    expect(html).toContain('>Facebook<');
    expect(html).toContain('Connected');
  });

  it('makes the last method aria-disabled with the note, and warns before Set a password', () => {
    const html = renderToStaticMarkup(
      <SignInMethods identities={[identity('GOOGLE')]} enabledProviders={BOTH} />,
    );
    expect(html).toMatch(/<button[^>]*aria-disabled="true"[^>]*aria-label="Disconnect Google"/);
    expect(html).toContain('You need at least one way to sign in.');
    expect(html).toContain('href="/forgot-password?returnTo=%2Faccount"');
    expect(html).toContain('Set a password');
    expect(html).toContain(
      'For your security, setting a password this way also disconnects Google. You can reconnect it straight after.',
    );
  });

  it('keeps Email and password as the only, non-removable method when nothing else is connected', () => {
    const html = renderToStaticMarkup(
      <SignInMethods
        identities={[identity('PASSWORD')]}
        enabledProviders={{ google: true, facebook: false }}
      />,
    );
    expect(html).toMatch(/aria-disabled="true"/);
    expect(html).toContain('You need at least one way to sign in.');
    expect(html).toContain('Connect Google');
    expect(html).not.toContain('Facebook');
  });
});
