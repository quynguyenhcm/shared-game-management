/**
 * `mapMembershipDbError` keys on SQLSTATE plus `err.constraint` (never on message text) and turns the three
 * membership guards into their shared error codes; anything else passes through unchanged.
 */
import { describe, expect, it } from 'vitest';
import { AppError } from '../../lib/http/errors.ts';
import { mapMembershipDbError } from './membership-errors.ts';

const pgError = (code: string, constraint: string | undefined, message = 'boom'): Error =>
  Object.assign(new Error(message), { code, ...(constraint === undefined ? {} : { constraint }) });

describe('mapMembershipDbError', () => {
  it.each([
    ['23514', 'team_members_admin_approved', 'team_admin_cannot_be_banned', 409],
    ['23514', 'team_members_last_admin', 'last_team_admin', 409],
    ['23000', 'team_members_status_transition', 'membership_state_conflict', 409],
    ['23000', 'team_members_keys_immutable', 'membership_state_conflict', 409],
  ])('maps %s %s to %s', (code, constraint, expected, status) => {
    const mapped = mapMembershipDbError(pgError(code, constraint));
    expect(mapped).toBeInstanceOf(AppError);
    expect(mapped).toMatchObject({ code: expected, status });
  });

  it('ignores the message text: only the constraint name decides', () => {
    const lookalike = pgError('23514', 'some_other_check', 'team_members_last_admin');
    expect(mapMembershipDbError(lookalike)).toBe(lookalike);
  });

  it('passes through a matching constraint under a different SQLSTATE, a plain error and a non-error', () => {
    const wrongState = pgError('23505', 'team_members_last_admin');
    expect(mapMembershipDbError(wrongState)).toBe(wrongState);
    const plain = new Error('x');
    expect(mapMembershipDbError(plain)).toBe(plain);
    expect(mapMembershipDbError('text')).toBe('text');
  });

  it('keeps an AppError as it is', () => {
    const own = new AppError('forbidden');
    expect(mapMembershipDbError(own)).toBe(own);
  });
});
