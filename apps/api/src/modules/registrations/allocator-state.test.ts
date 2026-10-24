import { describe, expect, it } from 'vitest';
import { buildSessionState } from './allocator.ts';
import { RegistrationInvariantError, type SessionRegistrationRow } from './repo.ts';

const row = (overrides: Partial<SessionRegistrationRow> = {}): SessionRegistrationRow => ({
  id: 'r1',
  userId: 'u1',
  status: 'CONFIRMED',
  guestCount: 0,
  queuePosition: null,
  withdrawnAt: null,
  feeDue: false,
  memberApproved: true,
  ...overrides,
});

describe('buildSessionState (M1: malformed rows are typed invariant errors, never silent defaults)', () => {
  it('keeps an unapproved waitlisted row, marked ineligible, with its queue position', () => {
    const state = buildSessionState([
      row({ id: 'w1', status: 'WAITLISTED', queuePosition: 3, memberApproved: false }),
      row({ id: 'w2', status: 'WAITLISTED', queuePosition: 4 }),
    ]);
    expect(state.waitlist).toMatchObject([
      { registrationId: 'w1', queuePosition: 3, eligible: false },
      { registrationId: 'w2', queuePosition: 4, eligible: true },
    ]);
    expect(state.maxQueuePosition).toBe(4);
  });

  it.each([-1, 3])(
    'throws RegistrationInvariantError carrying the id for guest_count %i',
    (guestCount) => {
      const call = () => buildSessionState([row({ id: 'bad-row', guestCount })]);
      expect(call).toThrow(RegistrationInvariantError);
      expect(call).toThrow(/bad-row/);
      try {
        call();
      } catch (error) {
        expect((error as RegistrationInvariantError).registrationId).toBe('bad-row');
      }
    },
  );

  it('throws RegistrationInvariantError for a WAITLISTED row with no queue position', () => {
    const call = () => buildSessionState([row({ id: 'no-pos', status: 'WAITLISTED' })]);
    expect(call).toThrow(RegistrationInvariantError);
    expect(call).toThrow(/no-pos/);
  });
});
