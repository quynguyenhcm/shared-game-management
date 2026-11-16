import type {
  DashboardRegistrationRow,
  DashboardRegistrationsResponse,
  OpenSessionRow,
  OpenSessionsResponse,
} from '@sgm/shared';

/**
 * Wire-shaped fixtures of the two dashboard read models for the web tests. They are JSON (money as plain text), so they are
 * asserted into the branded response types, the way the API client delivers them.
 */

export const TEAM_A = '7f3c2b1a-1111-4222-8333-444455556666';
export const TEAM_B = '8a4d3c2b-2222-4333-8444-555566667777';
export const SESSION_1 = '11111111-1111-4111-8111-111111111111';
export const SESSION_2 = '22222222-2222-4222-8222-222222222222';
export const REGISTRATION_1 = '33333333-3333-4333-8333-333333333333';
export const PAYMENT_1 = '44444444-4444-4444-8444-444444444444';

export const STARTS_AT = '2026-10-07T07:00:00.000Z'; // Wed 7 Oct, 8:00 pm NZDT
export const ENDS_AT = '2026-10-07T09:00:00.000Z'; // 10:00 pm NZDT
export const DUE_AT = '2026-10-09T22:00:00.000Z'; // Sat 10 Oct

export const openRow = (change: Record<string, unknown> = {}): OpenSessionRow =>
  ({
    sessionId: SESSION_1,
    teamId: TEAM_A,
    teamName: 'Rosedale Badminton',
    location: 'Rosedale Hall',
    address: '12 Rosedale Road, Albany, Auckland',
    startsAt: STARTS_AT,
    endsAt: ENDS_AT,
    pricingStructure: 'FLAT',
    unitFee: '12.00',
    feeLevel: null,
    publicCapacity: 8,
    seatsLeft: 3,
    waitlistLength: 2,
    me: null,
    canRegister: true,
    blockedReason: null,
    ...change,
  }) as OpenSessionRow;

export const openBody = (
  sessions: OpenSessionRow[],
  overdueCount = 0,
  hasMore = false,
): OpenSessionsResponse => ({ sessions, hasMore, overdueCount });

export const registrationRow = (change: Record<string, unknown> = {}): DashboardRegistrationRow =>
  ({
    registrationId: REGISTRATION_1,
    sessionId: SESSION_1,
    teamId: TEAM_A,
    teamName: 'Rosedale Badminton',
    location: 'Rosedale Hall',
    address: '12 Rosedale Road, Albany, Auckland',
    startsAt: STARTS_AT,
    endsAt: ENDS_AT,
    sessionStatus: 'PUBLISHED',
    status: 'CONFIRMED',
    waitlistRank: null,
    guestCount: 0,
    withdrawalFeeDue: false,
    estimatedTotal: '24.00',
    payment: null,
    ...change,
  }) as DashboardRegistrationRow;

export const paymentOf = (change: Record<string, unknown> = {}) => ({
  id: PAYMENT_1,
  amount: '24.00',
  status: 'PENDING',
  billingType: 'PER_GAME',
  dueDate: DUE_AT,
  paidAt: null,
  onHold: false,
  payoutBlocked: false,
  ...change,
});

export const registrationsBody = (
  upcoming: DashboardRegistrationRow[],
  past: DashboardRegistrationRow[] = [],
  nextCursor: string | null = null,
): DashboardRegistrationsResponse => ({ upcoming, past, nextCursor });
