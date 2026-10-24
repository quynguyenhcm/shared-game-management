import { describe, expect, it } from 'vitest';
import { AppError } from '../../lib/http/errors.ts';
import { registerRefusalError, withdrawRefusalError } from './errors.ts';

describe('registerRefusalError', () => {
  it.each([
    ['not_found', 404, 'not_found'],
    ['forbidden', 403, 'forbidden'],
    ['session_not_open', 409, 'session_not_open'],
    ['already_registered', 409, 'already_registered'],
    ['late_withdrawal_fee_due', 409, 'late_withdrawal_fee_due'],
  ] as const)('maps %s to %i %s', (reason, status, code) => {
    const error = registerRefusalError({ ok: false, reason }, 1);
    expect(error).toBeInstanceOf(AppError);
    expect(error).toMatchObject({ status, code });
  });

  it('says how many payments are overdue, from the count and never from input', () => {
    const error = registerRefusalError(
      { ok: false, reason: 'overdue_payments', overdueCount: 4 },
      1,
    );
    expect(error).toMatchObject({ status: 403, code: 'overdue_payments' });
    expect(error.message).toBe(
      'You have 4 overdue payments. Pay them before registering for more sessions.',
    );
  });

  it('closed sessions say registration is closed (AC-ERROR-2)', () => {
    expect(registerRefusalError({ ok: false, reason: 'session_not_open' }, 1).message).toBe(
      'Registration for this session is closed.',
    );
  });

  it('names the public capacity and the party size when a party can never fit (AC-ERROR-4)', () => {
    const error = registerRefusalError(
      { ok: false, reason: 'party_exceeds_capacity', publicCapacity: 2 },
      3,
    );
    expect(error).toMatchObject({ status: 422, code: 'party_exceeds_capacity' });
    expect(error.message).toBe("This session has 2 public places, so a group of 3 can't register.");
  });

  it('uses the default message when the capacity is not known', () => {
    const error = registerRefusalError({ ok: false, reason: 'party_exceeds_capacity' }, 3);
    expect(error.message).toBe(
      "Your group is bigger than this session's places, so it can never fit.",
    );
  });
});

describe('withdrawRefusalError', () => {
  it.each([
    ['not_found', 404, 'not_found'],
    ['session_not_open', 409, 'session_not_open'],
    ['not_registered', 409, 'not_registered'],
    ['cancellation_terms_changed', 409, 'cancellation_terms_changed'],
  ] as const)('maps %s to %i %s', (reason, status, code) => {
    expect(withdrawRefusalError({ ok: false, reason })).toMatchObject({ status, code });
  });

  it('closed sessions say registration is closed', () => {
    expect(withdrawRefusalError({ ok: false, reason: 'session_not_open' }).message).toBe(
      'Registration for this session is closed.',
    );
  });
});
