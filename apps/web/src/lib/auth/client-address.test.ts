import { describe, expect, it } from 'vitest';
import { deriveClientAddress } from './client-address.ts';

describe('deriveClientAddress (AC-VERIFY-14: client address trust boundary)', () => {
  it('is null with 0 trusted hops, whatever the header says (no fallback to a client-supplied entry)', () => {
    expect(deriveClientAddress('203.0.113.9', 0)).toBeNull();
    expect(deriveClientAddress('6.6.6.6, 203.0.113.9', 0)).toBeNull();
  });

  it('takes the last entry for 1 hop and ignores a spoofed leftmost entry', () => {
    expect(deriveClientAddress('203.0.113.9', 1)).toBe('203.0.113.9');
    expect(deriveClientAddress('6.6.6.6, 203.0.113.9', 1)).toBe('203.0.113.9');
  });

  it('takes the 2nd entry from the right for 2 hops (client-supplied entries stay ignored)', () => {
    expect(deriveClientAddress('6.6.6.6, 198.51.100.7, 10.0.0.2', 2)).toBe('198.51.100.7');
    expect(deriveClientAddress(' 198.51.100.7 ,10.0.0.2', 2)).toBe('198.51.100.7');
  });

  it('is null when the header is missing, has fewer entries than hops, or the entry is not an IP', () => {
    expect(deriveClientAddress(null, 1)).toBeNull();
    expect(deriveClientAddress(undefined, 1)).toBeNull();
    expect(deriveClientAddress('', 1)).toBeNull();
    expect(deriveClientAddress('203.0.113.9', 2)).toBeNull();
    expect(deriveClientAddress('203.0.113.9, not-an-ip', 1)).toBeNull();
    expect(deriveClientAddress('203.0.113.9, 999.1.1.1', 1)).toBeNull();
  });

  it('accepts IPv6', () => {
    expect(deriveClientAddress('2001:db8::1', 1)).toBe('2001:db8::1');
  });
});
