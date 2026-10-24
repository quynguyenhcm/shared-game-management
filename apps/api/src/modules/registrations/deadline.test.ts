import {
  addHours,
  defaultCancellationDeadline,
  localToInstant,
  parseLocalDate,
  parseLocalTime,
} from '@sgm/shared';
import { describe, expect, it } from 'vitest';
import { createManualClock } from '../../lib/clock.ts';
import { classifyWithdrawal, isRegistrationOpen } from './deadline.ts';

const STARTS = new Date('2026-10-07T06:00:00.000Z');
const DEADLINE = new Date('2026-10-05T06:00:00.000Z');

describe('classifyWithdrawal (workflows section 2: now <= deadline is free; AC-VERIFY-5)', () => {
  it('is EARLY 1 ms before the deadline and exactly at it, LATE 1 ms after', () => {
    const clock = createManualClock(new Date(DEADLINE.getTime() - 1));
    const session = { cancellationDeadline: DEADLINE };
    expect(classifyWithdrawal(clock.now(), session)).toBe('EARLY');
    clock.advance(1);
    expect(classifyWithdrawal(clock.now(), session)).toBe('EARLY');
    clock.advance(1);
    expect(classifyWithdrawal(clock.now(), session)).toBe('LATE');
  });

  it('compares instants only: the boundary is exact across both NZ daylight-saving changes', () => {
    // 2026-09-27 (clocks go forward) and 2027-04-04 (clocks go back): sessions on the following Sunday evening.
    for (const day of ['2026-09-27', '2027-04-04']) {
      const startsAt = localToInstant(parseLocalDate(day), parseLocalTime('19:00'), 'reject');
      const deadline = defaultCancellationDeadline(startsAt);
      expect(deadline.getTime()).toBe(addHours(startsAt, -48).getTime());
      const session = { cancellationDeadline: deadline };
      expect(classifyWithdrawal(new Date(deadline.getTime() - 1), session)).toBe('EARLY');
      expect(classifyWithdrawal(deadline, session)).toBe('EARLY');
      expect(classifyWithdrawal(new Date(deadline.getTime() + 1), session)).toBe('LATE');
    }
  });

  it('is LATE for any later instant before the start, and EARLY for any earlier one', () => {
    expect(
      classifyWithdrawal(new Date(STARTS.getTime() - 1), { cancellationDeadline: DEADLINE }),
    ).toBe('LATE');
    expect(
      classifyWithdrawal(new Date(DEADLINE.getTime() - 86_400_000), {
        cancellationDeadline: DEADLINE,
      }),
    ).toBe('EARLY');
  });
});

describe('isRegistrationOpen (the open check runs before classification)', () => {
  const published = { status: 'PUBLISHED' as const, startsAt: STARTS };

  it('is open while PUBLISHED and strictly before starts_at', () => {
    expect(isRegistrationOpen(new Date(STARTS.getTime() - 1), published)).toBe(true);
  });

  it('is closed exactly at starts_at and after it', () => {
    expect(isRegistrationOpen(STARTS, published)).toBe(false);
    expect(isRegistrationOpen(new Date(STARTS.getTime() + 1), published)).toBe(false);
  });

  it.each(['DRAFT', 'COMPLETED', 'CANCELLED'] as const)('is closed for a %s session', (status) => {
    expect(
      isRegistrationOpen(new Date(STARTS.getTime() - 3_600_000), { status, startsAt: STARTS }),
    ).toBe(false);
  });

  it('is closed when the start instant is unknown (no court yet)', () => {
    expect(isRegistrationOpen(DEADLINE, { status: 'PUBLISHED', startsAt: null })).toBe(false);
  });

  it('leaves no late window when the deadline equals the start: every open withdrawal is EARLY', () => {
    const session = { cancellationDeadline: STARTS };
    expect(isRegistrationOpen(new Date(STARTS.getTime() - 1), published)).toBe(true);
    expect(classifyWithdrawal(new Date(STARTS.getTime() - 1), session)).toBe('EARLY');
  });
});
