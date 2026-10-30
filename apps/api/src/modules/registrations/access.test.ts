import { describe, expect, it } from 'vitest';
import { decideAccess, waitlistRankOf } from './access.ts';

const open = {
  sessionOpen: true,
  overdueCount: 0,
  hasActiveRegistration: false,
  publicCapacity: 10,
};

describe('decideAccess (what the read model says about registering)', () => {
  it('lets a member of an open session with room and no debt register', () => {
    expect(decideAccess(open)).toEqual({ canRegister: true, blockedReason: null });
  });

  it.each([
    ['a closed session', { sessionOpen: false }, 'session_not_open'],
    ['an active registration', { hasActiveRegistration: true }, 'already_registered'],
    ['three overdue payments', { overdueCount: 3 }, 'overdue_payments'],
    ['more overdue payments', { overdueCount: 9 }, 'overdue_payments'],
    ['no public places', { publicCapacity: 0 }, 'party_exceeds_capacity'],
  ] as const)('blocks on %s', (_label, over, reason) => {
    expect(decideAccess({ ...open, ...over })).toEqual({
      canRegister: false,
      blockedReason: reason,
    });
  });

  it('is not blocked by two overdue payments (the gate is >= 3 only)', () => {
    expect(decideAccess({ ...open, overdueCount: 2 }).canRegister).toBe(true);
  });

  it('reports a closed session first, then an existing registration, then debt, then capacity', () => {
    const all = {
      sessionOpen: false,
      overdueCount: 5,
      hasActiveRegistration: true,
      publicCapacity: 0,
    };
    expect(decideAccess(all).blockedReason).toBe('session_not_open');
    expect(decideAccess({ ...all, sessionOpen: true }).blockedReason).toBe('already_registered');
    expect(
      decideAccess({ ...all, sessionOpen: true, hasActiveRegistration: false }).blockedReason,
    ).toBe('overdue_payments');
    expect(
      decideAccess({ ...all, sessionOpen: true, hasActiveRegistration: false, overdueCount: 0 })
        .blockedReason,
    ).toBe('party_exceeds_capacity');
  });
});

describe('waitlistRankOf', () => {
  it('is 1 plus the waiting parties ahead, and null unless the row is WAITLISTED', () => {
    expect(waitlistRankOf('WAITLISTED', 0)).toBe(1);
    expect(waitlistRankOf('WAITLISTED', 4)).toBe(5);
    expect(waitlistRankOf('CONFIRMED', 4)).toBeNull();
    expect(waitlistRankOf('WITHDRAWN', 0)).toBeNull();
  });
});
