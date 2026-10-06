import { describe, expect, it } from 'vitest';
import {
  errorMessage,
  isUrlErrorCode,
  minutesLabel,
  noticeMessage,
  parseProvider,
  parseRemoved,
  urlErrorMessage,
} from './messages.ts';

const NONE = { google: false, facebook: false };
const BOTH = { google: true, facebook: true };

describe('messages.ts: copy deck (codes in, fixed text out)', () => {
  it('maps notice codes to the deck text and ignores unknown codes', () => {
    expect(noticeMessage('session_expired', {})).toBe('Your session has expired. Sign in again.');
    expect(noticeMessage('signed_out', {})).toBe("You've signed out.");
    expect(noticeMessage('password_updated', {})).toBe(
      'Password updated. Sign in with your new password.',
    );
    expect(noticeMessage('welcome', {})).toBe('Welcome! Your account is ready.');
    expect(noticeMessage('linked', { provider: 'google' })).toBe(
      'Google connected. You can now sign in with it.',
    );
    expect(noticeMessage('unlinked', { provider: 'facebook' })).toBe(
      'Facebook disconnected. You can connect it again at any time.',
    );
    expect(noticeMessage('<script>alert(1)</script>', {})).toBeNull();
    expect(noticeMessage(undefined, {})).toBeNull();
  });

  it('names the removed providers after a reset (R1)', () => {
    expect(noticeMessage('password_updated', { removed: 'FACEBOOK' })).toBe(
      'Password updated. For your security we disconnected Facebook from this account. Sign in and reconnect it from your Account page.',
    );
    expect(parseRemoved('GOOGLE,FACEBOOK')).toEqual(['Facebook', 'Google']);
    expect(noticeMessage('password_updated', { removed: 'GOOGLE,FACEBOOK' })).toContain(
      'disconnected Facebook and Google from',
    );
    expect(parseRemoved('EVIL,GOOGLE')).toEqual(['Google']);
  });

  it('only accepts the two enabled provider spellings', () => {
    expect(parseProvider('google')).toBe('Google');
    expect(parseProvider('facebook')).toBe('Facebook');
    expect(parseProvider('GOOGLE')).toBeNull();
    expect(parseProvider('github')).toBeNull();
    expect(parseProvider(undefined)).toBeNull();
  });

  it('uses singular "minute" for 1 and rounds Retry-After up (X4)', () => {
    expect(minutesLabel(1)).toBe('1 minute');
    expect(minutesLabel(60)).toBe('1 minute');
    expect(minutesLabel(61)).toBe('2 minutes');
    expect(minutesLabel(900)).toBe('15 minutes');
    expect(minutesLabel(undefined)).toBe('1 minute');
  });

  it('shows the provider hint on a failed sign-in only when a provider is enabled (E-LOGIN-1)', () => {
    expect(errorMessage('invalid_credentials', { providers: NONE })).toEqual([
      'Incorrect email or password.',
    ]);
    expect(errorMessage('invalid_credentials', { providers: BOTH })).toEqual([
      'Incorrect email or password.',
      'If you signed up with Google or Facebook, use those buttons instead.',
    ]);
  });

  it('builds the throttle messages with minutes and only names enabled providers (E-LOGIN-2, E-FORGOT-1)', () => {
    expect(errorMessage('too_many_attempts', { retryAfterSeconds: 840, providers: BOTH })).toEqual([
      'Too many sign-in attempts. Try again in 14 minutes.',
      'You can reset your password now, or continue with Google or Facebook.',
    ]);
    expect(errorMessage('too_many_attempts', { retryAfterSeconds: 30, providers: NONE })).toEqual([
      'Too many sign-in attempts. Try again in 1 minute.',
      'You can reset your password now.',
    ]);
    expect(errorMessage('too_many_requests', { retryAfterSeconds: 120 })).toEqual([
      'Too many requests. Try again in 2 minutes.',
    ]);
  });

  it('has an error message for every form-level and system code', () => {
    expect(errorMessage('email_taken', {})?.[0]).toMatch(
      /^An account with this email already exists\./,
    );
    expect(errorMessage('invalid_or_expired_token', {})?.[0]).toBe(
      'This reset link is invalid or has expired. If you just set a new password, try signing in with it.',
    );
    const generic =
      'Something went wrong on our side. Your details are still here. Try again in a minute.';
    for (const code of ['internal_error', 'service_unavailable', 'something_new']) {
      expect(errorMessage(code, {}), code).toEqual([generic]);
    }
    expect(errorMessage('offline', {})).toEqual([
      'You seem to be offline. Check your connection and try again.',
    ]);
    expect(errorMessage('cross_origin_request', {})?.[0]).toMatch(/didn't come from this site/);
    expect(errorMessage('forbidden', {})).toEqual(["You don't have permission to do that."]);
  });

  it('words OAuth landings by intent and provider; a landing with no valid provider renders nothing', () => {
    expect(errorMessage('oauth_cancelled', { provider: 'google' })).toEqual([
      'Google sign-in was cancelled.',
    ]);
    expect(errorMessage('oauth_cancelled', { provider: 'google', intent: 'link' })).toEqual([
      'Connecting Google was cancelled.',
    ]);
    expect(errorMessage('oauth_state_invalid', { provider: 'facebook' })).toHaveLength(2);
    expect(errorMessage('oauth_cancelled', {})).toBeNull();
    expect(errorMessage('oauth_cancelled', { provider: 'myspace' })).toBeNull();
    expect(errorMessage('last_sign_in_method', {})).toEqual([
      "You can't disconnect your only sign-in method. Connect another one first.",
    ]);
  });

  it('puts the conflicting email in the text only when the flash cookie supplied it (X2)', () => {
    expect(
      errorMessage('oauth_account_exists', {
        provider: 'facebook',
        email: 'aroha.ngata@example.com',
      }),
    ).toEqual([
      'An account already exists for aroha.ngata@example.com. Sign in with your existing method, then connect Facebook from your Account page.',
    ]);
    expect(errorMessage('oauth_account_exists', { provider: 'facebook' })?.[0]).toBe(
      'An account already exists for the email address on your Facebook account. Sign in with your existing method, then connect Facebook from your Account page.',
    );
  });
});

describe('messages.ts: codes allowed in a URL (Phase 5)', () => {
  it('renders generic outage codes from /account redirects and still ignores unknown ones', () => {
    expect(isUrlErrorCode('service_unavailable')).toBe(true);
    expect(isUrlErrorCode('identity_in_use')).toBe(true);
    expect(isUrlErrorCode('<script>')).toBe(false);
    expect(urlErrorMessage('service_unavailable', { intent: 'link' })?.[0]).toMatch(
      /^Something went wrong on our side/,
    );
    expect(urlErrorMessage('made_up_code', {})).toBeNull();
  });
});
