import type {
  MyRegistration,
  RegistrationReadResponse,
  UpcomingSessionsResponse,
} from '@sgm/shared';

/**
 * Wire-shaped fixtures for the registration panel tests: the exact JSON `GET .../registration` answers (money as text,
 * instants as ISO text), so a test that passes one through the web api-client also exercises the shared response schema.
 * Every number the panel shows is a field of this object: nothing is derived from it.
 */

export const TEAM_ID = '7f3c2b1a-1111-4222-8333-444455556666';
export const SESSION_ID = '11111111-1111-4111-8111-111111111111';
export const REGISTRATION_ID = '31111111-1111-4111-8111-111111111111';

/** 2026-11-03 19:00 UTC is Wed 4 Nov, 8:00 am in Pacific/Auckland; the deadline is 48 h earlier. */
export const STARTS_AT = '2026-11-03T19:00:00.000Z';
export const DEADLINE = '2026-11-01T19:00:00.000Z';
/** A clock before the deadline and one after it (and before the start). */
export const BEFORE_DEADLINE = new Date('2026-10-30T00:00:00.000Z');
export const AFTER_DEADLINE = new Date('2026-11-02T00:00:00.000Z');

type Overrides<T> = Partial<Record<keyof T, unknown>>;

export function registrationFixture(overrides: Overrides<MyRegistration> = {}): MyRegistration {
  return {
    id: REGISTRATION_ID,
    status: 'CONFIRMED',
    guestCount: 0,
    guests: [],
    waitlistRank: null,
    registeredAt: '2026-10-28T01:00:00.000Z',
    promotedAt: null,
    withdrawnAt: null,
    withdrawalKind: null,
    withdrawalFeeDue: false,
    source: 'MEMBER',
    registrantSkillLevel: null,
    ...overrides,
  } as MyRegistration;
}

interface ReadOverrides {
  session?: Record<string, unknown>;
  me?: Record<string, unknown>;
  canRegister?: boolean;
  blockedReason?: RegistrationReadResponse['blockedReason'];
}

/** An open FLAT $17.00 session with 3 of 10 places left, 2 on the waitlist, and a member with no registration. */
export function readFixture(overrides: ReadOverrides = {}): RegistrationReadResponse {
  return {
    session: {
      id: SESSION_ID,
      teamId: TEAM_ID,
      location: 'Rosedale Courts',
      address: '1 Court Rd, Albany',
      startsAt: STARTS_AT,
      endsAt: '2026-11-03T21:00:00.000Z',
      cancellationDeadline: DEADLINE,
      status: 'PUBLISHED',
      publicCapacity: 10,
      seatsTaken: 7,
      seatsLeft: 3,
      waitlistLength: 0,
      pricingStructure: 'FLAT',
      fees: {
        flat: '17.00',
        male: null,
        female: null,
        other: null,
        beginner: null,
        intermediate: null,
        advanced: null,
      },
      ...overrides.session,
    },
    me: {
      registration: null,
      unitFee: '17.00',
      estimatedTotal: '17.00',
      overdueCount: 0,
      ...overrides.me,
    },
    canRegister: overrides.canRegister ?? true,
    blockedReason: overrides.blockedReason ?? null,
  } as RegistrationReadResponse;
}

export function upcomingFixture(
  rows: readonly Record<string, unknown>[] = [],
  hasMore = false,
): UpcomingSessionsResponse {
  return {
    hasMore,
    sessions: rows.map((row, index) => ({
      id: `41111111-1111-4111-8111-11111111111${index}`,
      startsAt: STARTS_AT,
      endsAt: '2026-11-03T21:00:00.000Z',
      location: 'Rosedale Courts',
      publicCapacity: 10,
      seatsLeft: 3,
      waitlistLength: 0,
      me: null,
      ...row,
    })),
  };
}
