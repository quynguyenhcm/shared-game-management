import { describe, expect, it } from 'vitest';
import { isInAppBrowser } from './in-app-browser.ts';

describe('isInAppBrowser (AC-VERIFY-13)', () => {
  it.each([
    'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148 [FBAN/FBIOS;FBAV/430.0.0.0]',
    'Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 Chrome/120 Mobile Safari/537.36 [FB_IAB/FB4A;FBAV/440.0.0.0]',
    'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) Mobile/15E148 Instagram 320.0.0.0',
    'Mozilla/5.0 (iPhone) Mobile/15E148 [FBAN/MessengerForiOS;FBAV/430.0]',
  ])('flags the Facebook, Messenger and Instagram in-app browsers: %s', (userAgent) => {
    expect(isInAppBrowser(userAgent)).toBe(true);
  });

  it.each([
    'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Version/17.0 Mobile/15E148 Safari/604.1',
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0 Safari/537.36',
    '',
  ])('does not flag ordinary browsers: %s', (userAgent) => {
    expect(isInAppBrowser(userAgent)).toBe(false);
  });

  it('treats a missing user agent as an ordinary browser', () => {
    expect(isInAppBrowser(null)).toBe(false);
    expect(isInAppBrowser(undefined)).toBe(false);
  });
});
