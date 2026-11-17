import { describe, expect, it } from 'vitest';
import {
  DashboardRegistrationRow,
  DashboardRegistrationsQuery,
  DashboardRegistrationsResponse,
  OpenSessionRow,
  OpenSessionsResponse,
  REGISTRATIONS_PAGE_SIZE,
} from './dashboard.ts';
import { MyPaymentsQuery } from './billing.ts';

const ID = '3f1c8c52-6d0a-4f06-9a3e-2a5d1f0b7c11';
const TEAM = '8a2b4c6d-1e3f-4a5b-8c7d-9e0f1a2b3c4d';

const openRow = {
  sessionId: ID,
  teamId: TEAM,
  teamName: 'Tuesday Smashers',
  location: 'Kolmar Hall',
  address: '1 Test Street, Auckland',
  startsAt: '2026-10-07T07:00:00.000Z',
  endsAt: '2026-10-07T09:00:00.000Z',
  pricingStructure: 'BY_SKILL_LEVEL',
  unitFee: '12.00',
  feeLevel: 'INTERMEDIATE',
  publicCapacity: 8,
  seatsLeft: 3,
  waitlistLength: 2,
  me: null,
  canRegister: true,
  blockedReason: null,
};

const registrationRow = {
  registrationId: ID,
  sessionId: ID,
  teamId: TEAM,
  teamName: 'Tuesday Smashers',
  location: 'Kolmar Hall',
  address: '1 Test Street, Auckland',
  startsAt: '2026-10-07T07:00:00.000Z',
  endsAt: null,
  sessionStatus: 'PUBLISHED',
  status: 'CONFIRMED',
  waitlistRank: null,
  guestCount: 1,
  withdrawalFeeDue: false,
  estimatedTotal: '24.00',
  payment: null,
};

describe('dashboard response schemas', () => {
  it('round-trips an open-sessions response and rejects a money value that is not 2dp', () => {
    const body = { sessions: [openRow], hasMore: false, overdueCount: 1 };
    expect(OpenSessionsResponse.parse(body)).toEqual(body);
    expect(OpenSessionRow.safeParse({ ...openRow, unitFee: '12' }).success).toBe(false);
    expect(OpenSessionRow.safeParse({ ...openRow, email: 'x@y.nz' }).success).toBe(false);
  });

  it('round-trips a registrations response with and without a payment, and is strict', () => {
    const billed = {
      ...registrationRow,
      estimatedTotal: null,
      payment: {
        id: TEAM,
        amount: '24.00',
        status: 'OVERDUE',
        billingType: 'PER_GAME',
        dueDate: '2026-10-10T00:00:00.000Z',
        paidAt: null,
        onHold: false,
        payoutBlocked: false,
      },
    };
    const body = { upcoming: [registrationRow], past: [billed], nextCursor: null };
    expect(DashboardRegistrationsResponse.parse(body)).toEqual(body);
    expect(DashboardRegistrationRow.safeParse({ ...registrationRow, guests: [] }).success).toBe(
      false,
    );
    expect(
      DashboardRegistrationRow.safeParse({ ...registrationRow, startsAt: 'soon' }).success,
    ).toBe(false);
  });

  it('accepts an opaque cursor and refuses extra or empty query values', () => {
    expect(REGISTRATIONS_PAGE_SIZE).toBe(20);
    expect(DashboardRegistrationsQuery.parse({})).toEqual({});
    expect(DashboardRegistrationsQuery.parse({ cursor: 'abc' })).toEqual({ cursor: 'abc' });
    expect(DashboardRegistrationsQuery.safeParse({ cursor: '' }).success).toBe(false);
    expect(DashboardRegistrationsQuery.safeParse({ page: 2 }).success).toBe(false);
  });

  it('MyPaymentsQuery.status accepts PAID next to UNPAID and nothing else', () => {
    expect(MyPaymentsQuery.parse({ status: 'PAID' })).toEqual({ status: 'PAID' });
    expect(MyPaymentsQuery.parse({ status: 'UNPAID' })).toEqual({ status: 'UNPAID' });
    expect(MyPaymentsQuery.safeParse({ status: 'ALL' }).success).toBe(false);
  });
});
