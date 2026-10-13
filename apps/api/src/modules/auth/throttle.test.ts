import { describe, expect, it } from 'vitest';
import { deriveThrottleKey, deriveThrottleSecret, truncateAddress } from './throttle.ts';

describe('throttle key derivation (algorithm Q7)', () => {
  const secret = deriveThrottleSecret(Buffer.alloc(32, 1));

  it('derives a stable 32-byte keyed pseudonym per scope and value', () => {
    const key = deriveThrottleKey(secret, 'login_email', 'aroha@example.com');
    expect(key).toHaveLength(32);
    expect(deriveThrottleKey(secret, 'login_email', 'aroha@example.com').equals(key)).toBe(true);
    expect(deriveThrottleKey(secret, 'login_email', 'other@example.com').equals(key)).toBe(false);
    // The scope is part of the key, so the same value never collides across scopes.
    expect(deriveThrottleKey(secret, 'forgot_address', 'aroha@example.com').equals(key)).toBe(
      false,
    );
  });

  it('changes every key when the encryption key (and so the HKDF secret) changes', () => {
    const rotated = deriveThrottleSecret(Buffer.alloc(32, 2));
    expect(
      deriveThrottleKey(rotated, 'login_email', 'a@example.com').equals(
        deriveThrottleKey(secret, 'login_email', 'a@example.com'),
      ),
    ).toBe(false);
  });

  it('truncates addresses to IPv4 /32 and IPv6 /64 and rejects non-addresses', () => {
    expect(truncateAddress('203.0.113.7')).toBe('203.0.113.7');
    expect(truncateAddress('2001:db8:1:2:aaaa:bbbb:cccc:dddd')).toBe('2001:0db8:0001:0002::/64');
    expect(truncateAddress('2001:db8:1:2::9')).toBe('2001:0db8:0001:0002::/64');
    expect(truncateAddress('::ffff:203.0.113.7')).toBe('203.0.113.7');
    expect(truncateAddress('not-an-ip')).toBeNull();
    expect(truncateAddress('')).toBeNull();
  });
});
