import { describe, expect, it } from 'vitest';
import {
  SIGNED_OUT_URL,
  errorLinks,
  forgotPasswordUrl,
  loginUrl,
  oauthErrorLanding,
  passwordResetLanding,
  sessionExpiredLanding,
  sessionExpiredUrl,
  withWelcome,
} from './landing.ts';
import { errorMessage } from './messages.ts';

describe('landing.ts: outcome to redirect URL (codes only, never text or emails)', () => {
  it('builds sign-out, session-expired and reset landings exactly as the journey specifies', () => {
    expect(SIGNED_OUT_URL).toBe('/login?notice=signed_out');
    expect(sessionExpiredUrl('/account')).toBe('/auth/session-expired?returnTo=%2Faccount');
    expect(sessionExpiredLanding('/account')).toBe(
      '/login?notice=session_expired&returnTo=%2Faccount',
    );
    expect(passwordResetLanding([])).toBe('/login?notice=password_updated');
    expect(passwordResetLanding(['FACEBOOK'])).toBe(
      '/login?notice=password_updated&removed=FACEBOOK&returnTo=%2Faccount',
    );
    expect(passwordResetLanding(['FACEBOOK', 'GOOGLE'])).toContain('removed=FACEBOOK%2CGOOGLE');
  });

  it('carries only a validated returnTo: absolute, protocol-relative, backslash and auth-page values are dropped (AC-ERROR-13)', () => {
    expect(loginUrl({ returnTo: '/account?tab=1' })).toBe('/login?returnTo=%2Faccount%3Ftab%3D1');
    for (const bad of [
      'https://evil.example/x',
      '//evil.example',
      '/\\evil.example',
      '/login',
      '/register?x=1',
      '/auth/callback/google',
      '/',
      '',
      undefined,
    ]) {
      expect(loginUrl({ returnTo: bad }), String(bad)).toBe('/login');
      expect(forgotPasswordUrl({ returnTo: bad }), String(bad)).toBe('/forgot-password');
    }
    expect(sessionExpiredLanding('//evil.example')).toBe('/login?notice=session_expired');
  });

  it('adds the one-time welcome notice to a destination, with or without a query', () => {
    expect(withWelcome('/')).toBe('/?notice=welcome');
    expect(withWelcome('/account')).toBe('/account?notice=welcome');
    expect(withWelcome('/teams?x=1')).toBe('/teams?x=1&notice=welcome');
  });

  it('keeps the OAuth conflict landing free of the email and pointed at /account', () => {
    const url = oauthErrorLanding({
      code: 'oauth_account_exists',
      provider: 'facebook',
      intent: 'signin',
      returnTo: '/teams/1',
    });
    expect(url).toBe('/login?error=oauth_account_exists&provider=facebook&returnTo=%2Faccount');
    expect(url).not.toContain('@');
  });

  it('keeps the original returnTo on sign-in errors and sends link errors to /account', () => {
    expect(
      oauthErrorLanding({
        code: 'oauth_cancelled',
        provider: 'google',
        intent: 'signin',
        returnTo: '/account',
      }),
    ).toBe('/login?error=oauth_cancelled&provider=google&returnTo=%2Faccount');
    expect(
      oauthErrorLanding({
        code: 'oauth_cancelled',
        provider: 'google',
        intent: 'link',
        returnTo: '/account',
      }),
    ).toBe('/account?error=oauth_cancelled&provider=google');
    expect(
      oauthErrorLanding({
        code: 'link_session_mismatch',
        provider: 'google',
        intent: 'link',
        returnTo: '/account',
      }),
    ).toBe('/login?error=link_session_mismatch&provider=google&returnTo=%2Faccount');
  });

  it('every landing in the table renders a message from messages.ts at its destination', () => {
    const signin = [
      'oauth_cancelled',
      'oauth_state_invalid',
      'provider_unavailable',
      'provider_not_enabled',
      'oauth_email_missing',
      'oauth_email_unverified',
      'oauth_account_exists',
      'signup_expired',
    ] as const;
    const link = [
      'oauth_cancelled',
      'oauth_state_invalid',
      'provider_unavailable',
      'link_session_mismatch',
      'identity_in_use',
      'provider_already_connected',
      'last_sign_in_method',
    ] as const;
    const cases = [
      ...signin.map((code) => ({ code, intent: 'signin' as const })),
      ...link.map((code) => ({ code, intent: 'link' as const })),
    ];
    for (const { code, intent } of cases) {
      const url = new URL(
        oauthErrorLanding({ code, provider: 'google', intent, returnTo: '/x' }),
        'http://w',
      );
      expect(['/login', '/account'], `${intent} ${code}`).toContain(url.pathname);
      expect(url.searchParams.get('error')).toBe(code);
      const landedIntent = url.pathname === '/account' ? 'link' : 'signin';
      expect(
        errorMessage(code, { provider: url.searchParams.get('provider'), intent: landedIntent }),
        `${intent} ${code}`,
      ).not.toBeNull();
    }
  });

  it('offers the recovery links the error table promises, carrying returnTo', () => {
    expect(errorLinks('email_taken', '/account')).toEqual([
      { label: 'Sign in instead', href: '/login?returnTo=%2Faccount' },
      { label: 'Reset your password', href: '/forgot-password?returnTo=%2Faccount' },
    ]);
    expect(errorLinks('too_many_attempts', undefined)).toEqual([
      { label: 'Reset your password', href: '/forgot-password' },
    ]);
    expect(errorLinks('invalid_or_expired_token', undefined)).toEqual([
      { label: 'Request a new link', href: '/forgot-password' },
      { label: 'Back to sign in', href: '/login' },
    ]);
    expect(errorLinks('invalid_credentials', undefined)).toEqual([]);
  });
});
