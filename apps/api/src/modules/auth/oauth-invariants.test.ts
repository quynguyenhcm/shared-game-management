/** Defensive invariants of the OAuth service: states the database CHECKs and the decision table make unreachable. */
import { describe, expect, it } from 'vitest';
import { requireLinkUserId, requireProviderEmail } from './oauth-invariants.ts';

describe('requireLinkUserId', () => {
  it('returns the user of a link-intent state', () => {
    expect(requireLinkUserId({ intent: 'link', linkUserId: 'user-1' })).toBe('user-1');
  });

  it('throws for a link-intent state that has no user (never falls back to an empty id)', () => {
    expect(() => requireLinkUserId({ intent: 'link', linkUserId: null })).toThrow(
      /link-intent OAuth state without a user/,
    );
  });
});

describe('requireProviderEmail', () => {
  it('returns the email when the decision table guaranteed one', () => {
    expect(requireProviderEmail('aroha@example.com', 'S4')).toBe('aroha@example.com');
  });

  it('throws when the email is missing instead of substituting an empty string', () => {
    expect(() => requireProviderEmail(null, 'S5')).toThrow(/S5 .* no provider email/);
  });
});
