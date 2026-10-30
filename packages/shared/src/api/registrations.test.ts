import { describe, expect, it } from 'vitest';
import {
  AllocationRefusalReason,
  MAX_GUESTS,
  MyRegistration,
  REGISTRATION_FIELD_MESSAGES,
  SessionRegisterRequest,
  SessionRegisterResponse,
  RegistrationReadResponse,
  UpcomingSessionsResponse,
  SessionWithdrawRequest,
  SessionWithdrawResponse,
} from './registrations.ts';

const SESSION_ID = '3b241101-e2bb-4255-8caf-4136c566a962';
const TEAM_ID = '7c1c8b8e-5f0e-4c36-9a0d-0f5d9a1b2c3d';
const REG_ID = '0b5f1c3e-9d3a-4f7b-8a55-6f2f4d5e6a7b';

function issues(schema: { safeParse(v: unknown): unknown }, value: unknown) {
  const result = schema.safeParse(value) as {
    success: boolean;
    error?: { issues: { path: PropertyKey[]; message: string; code: string }[] };
  };
  if (result.success) throw new Error('expected a failure');
  return result.error?.issues ?? [];
}

const guest = { sex: 'FEMALE', skillLevel: 'ADVANCED' } as const;

describe('SessionRegisterRequest', () => {
  it('accepts no guests, one guest and two guests; trims names and turns an empty one into undefined', () => {
    expect(SessionRegisterRequest.parse({ guests: [] })).toEqual({ guests: [] });
    const parsed = SessionRegisterRequest.parse({
      guests: [
        { ...guest, displayName: '  Sam  ' },
        { sex: 'MALE', skillLevel: 'BEGINNER', displayName: '   ' },
      ],
    });
    expect(parsed.guests[0]?.displayName).toBe('Sam');
    expect(parsed.guests[1]?.displayName).toBeUndefined();
    expect(MAX_GUESTS).toBe(2);
  });

  it('rejects three guests and a missing guests array', () => {
    expect(issues(SessionRegisterRequest, { guests: [guest, guest, guest] })[0]?.path).toEqual([
      'guests',
    ]);
    expect(issues(SessionRegisterRequest, {}).length).toBeGreaterThan(0);
  });

  it('names the guest field for a missing or invalid sex and skill level', () => {
    const found = issues(SessionRegisterRequest, {
      guests: [guest, { sex: 'robot', displayName: 'x' }],
    });
    const byPath = Object.fromEntries(found.map((i) => [i.path.join('.'), i.message]));
    expect(byPath['guests.1.sex']).toBe(REGISTRATION_FIELD_MESSAGES.sexRequired);
    expect(byPath['guests.1.skillLevel']).toBe(REGISTRATION_FIELD_MESSAGES.skillLevelRequired);
  });

  it('rejects a name over 100 characters after trimming, with the copy-deck message', () => {
    expect(
      SessionRegisterRequest.safeParse({ guests: [{ ...guest, displayName: 'a'.repeat(100) }] })
        .success,
    ).toBe(true);
    const found = issues(SessionRegisterRequest, {
      guests: [{ ...guest, displayName: 'a'.repeat(101) }],
    });
    expect(found[0]?.path).toEqual(['guests', 0, 'displayName']);
    expect(found[0]?.message).toBe('Use 100 characters or fewer.');
  });

  it.each(['status', 'queuePosition', 'userId', 'teamId'])(
    'rejects the unknown key %s at the top level and on a guest',
    (key) => {
      expect(issues(SessionRegisterRequest, { guests: [], [key]: 'x' })[0]?.code).toBe(
        'unrecognized_keys',
      );
      expect(issues(SessionRegisterRequest, { guests: [{ ...guest, [key]: 'x' }] })[0]?.code).toBe(
        'unrecognized_keys',
      );
    },
  );
});

describe('SessionWithdrawRequest', () => {
  it('requires a boolean expectLate and nothing else', () => {
    expect(SessionWithdrawRequest.parse({ expectLate: true })).toEqual({ expectLate: true });
    expect(SessionWithdrawRequest.safeParse({}).success).toBe(false);
    expect(SessionWithdrawRequest.safeParse({ expectLate: 'yes' }).success).toBe(false);
    expect(
      SessionWithdrawRequest.safeParse({ expectLate: false, userId: SESSION_ID }).success,
    ).toBe(false);
  });
});

const registration = {
  id: REG_ID,
  status: 'CONFIRMED',
  guestCount: 1,
  guests: [{ position: 1, sex: 'FEMALE', skillLevel: 'ADVANCED', displayName: null }],
  waitlistRank: null,
  registeredAt: '2026-10-24T01:00:00.000Z',
  promotedAt: null,
  withdrawnAt: null,
  withdrawalKind: null,
  withdrawalFeeDue: false,
  source: 'MEMBER',
  registrantSkillLevel: 'INTERMEDIATE',
};

const session = {
  id: SESSION_ID,
  teamId: TEAM_ID,
  location: 'Highbury Courts',
  address: '1 Court Rd',
  startsAt: '2026-11-01T06:00:00.000Z',
  endsAt: '2026-11-01T08:00:00.000Z',
  cancellationDeadline: '2026-10-31T06:00:00.000Z',
  status: 'PUBLISHED',
  publicCapacity: 10,
  seatsTaken: 4,
  seatsLeft: 6,
  waitlistLength: 0,
  pricingStructure: 'FLAT',
  fees: {
    flat: '12.00',
    male: null,
    female: null,
    other: null,
    beginner: null,
    intermediate: null,
    advanced: null,
  },
};

describe('response schemas', () => {
  it('parses the registration read model with money as strings and instants as ISO strings', () => {
    const body = {
      session,
      me: {
        registration,
        unitFee: '12.00',
        estimatedTotal: '24.00',
        feeLevel: 'INTERMEDIATE',
        overdueCount: 0,
      },
      canRegister: false,
      blockedReason: 'already_registered',
    };
    expect(RegistrationReadResponse.parse(body).me.estimatedTotal).toBe('24.00');
    expect(RegistrationReadResponse.parse(body).me.feeLevel).toBe('INTERMEDIATE');
    expect(
      RegistrationReadResponse.safeParse({ ...body, me: { ...body.me, feeLevel: 'EXPERT' } })
        .success,
    ).toBe(false);
    expect(
      RegistrationReadResponse.safeParse({ ...body, me: { ...body.me, estimatedTotal: 24 } })
        .success,
    ).toBe(false);
    expect(
      RegistrationReadResponse.safeParse({
        ...body,
        session: { ...session, startsAt: 'next tuesday' },
      }).success,
    ).toBe(false);
    expect(
      RegistrationReadResponse.parse({
        ...body,
        me: { ...body.me, registration: null },
        blockedReason: null,
      }).me.registration,
    ).toBeNull();
  });

  it('parses the register 201 body and rejects a WITHDRAWN status there', () => {
    expect(SessionRegisterResponse.parse({ registration }).registration.status).toBe('CONFIRMED');
    expect(
      SessionRegisterResponse.safeParse({ registration: { ...registration, status: 'WAITLISTED' } })
        .success,
    ).toBe(true);
    expect(
      SessionRegisterResponse.safeParse({ registration: { ...registration, status: 'WITHDRAWN' } })
        .success,
    ).toBe(false);
    // the read model still carries a withdrawn registration
    expect(MyRegistration.safeParse({ ...registration, status: 'WITHDRAWN' }).success).toBe(true);
  });

  it.each(['forbidden', 'not_found', 'auto_enroll_changed', 'not_registered'])(
    'rejects %s as a read-model blockedReason',
    (blockedReason) => {
      const body = {
        session,
        me: {
          registration: null,
          unitFee: null,
          estimatedTotal: null,
          feeLevel: null,
          overdueCount: 0,
        },
        canRegister: false,
        blockedReason,
      };
      expect(RegistrationReadResponse.safeParse(body).success).toBe(false);
    },
  );

  it.each([
    'overdue_payments',
    'session_not_open',
    'party_exceeds_capacity',
    'already_registered',
    'late_withdrawal_fee_due',
  ])('accepts %s as a read-model blockedReason', (blockedReason) => {
    const body = {
      session,
      me: {
        registration: null,
        unitFee: null,
        estimatedTotal: null,
        feeLevel: null,
        overdueCount: 0,
      },
      canRegister: false,
      blockedReason,
    };
    expect(RegistrationReadResponse.safeParse(body).success).toBe(true);
  });

  it('parses the withdraw 200 body and never names the promoted player', () => {
    const body = {
      registration: { status: 'WITHDRAWN', withdrawalKind: 'LATE', withdrawalFeeDue: true },
      replacedBy: 'nobody',
      feeEstimate: '12.00',
    };
    expect(SessionWithdrawResponse.parse(body).replacedBy).toBe('nobody');
    expect(SessionWithdrawResponse.safeParse({ ...body, replacedBy: 'someone' }).success).toBe(
      false,
    );
    expect(SessionWithdrawResponse.safeParse({ ...body, feeEstimate: 12 }).success).toBe(false);
  });

  it('parses the upcoming list (next 10, no guest names) with hasMore', () => {
    const row = {
      id: SESSION_ID,
      startsAt: '2026-11-01T06:00:00.000Z',
      endsAt: '2026-11-01T08:00:00.000Z',
      location: 'Highbury Courts',
      publicCapacity: 10,
      seatsLeft: 3,
      waitlistLength: 0,
      me: { status: 'WAITLISTED', waitlistRank: 2 },
    };
    const parsed = UpcomingSessionsResponse.parse({
      sessions: [row, { ...row, me: null }],
      hasMore: false,
    });
    expect(parsed.sessions).toHaveLength(2);
    expect(UpcomingSessionsResponse.safeParse({ sessions: [], hasMore: 'no' }).success).toBe(false);
  });
});

describe('AllocationRefusalReason', () => {
  it('is the closed union including auto_enroll_changed and the auto-enrol-only deadline_passed', () => {
    expect(AllocationRefusalReason.options).toEqual([
      'overdue_payments',
      'session_not_open',
      'already_registered',
      'party_exceeds_capacity',
      'not_registered',
      'forbidden',
      'late_withdrawal_fee_due',
      'cancellation_terms_changed',
      'auto_enroll_changed',
      'deadline_passed',
      'not_found',
    ]);
  });
});
