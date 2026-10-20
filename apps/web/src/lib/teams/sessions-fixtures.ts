import type { SeriesInstanceResponse, SeriesResponse, SessionResponse } from '@sgm/shared';

/**
 * Wire-shaped fixtures for the Sessions action, page and component tests. They are the exact JSON the API
 * answers (money as strings, instants as ISO text), so a test that passes them through the web api-client
 * also exercises the shared response schemas.
 */

export const TEAM_ID = '7f3c2b1a-1111-4222-8333-444455556666';
export const SESSION_ID = '11111111-1111-4111-8111-111111111111';
export const RULE_ID = '41111111-1111-4111-8111-111111111111';
export const CREATE_KEY = '2f6c1c1e-7a64-4c0e-9d61-3c1f0c1f0a11';

/** Overrides are plain wire values (money as text), so they are not held to the branded `MoneyString` type. */
type Overrides<T> = Partial<Record<keyof T, unknown>>;

export function sessionFixture(overrides: Overrides<SessionResponse> = {}): SessionResponse {
  return {
    id: SESSION_ID,
    teamId: TEAM_ID,
    recurringRuleId: null,
    status: 'DRAFT',
    phase: 'upcoming',
    date: '2026-11-04',
    location: 'Rosedale',
    address: '1 Court Rd',
    maxPlayers: 18,
    reservedSeats: 2,
    courtCost: '180.00',
    extraExpenses: '20.00',
    calculatedRatePerPlayer: '12.00',
    customPlayerRate: null,
    pricingStructure: 'FLAT',
    feeFlat: '12.00',
    feeMale: null,
    feeFemale: null,
    feeOther: null,
    feeBeginner: null,
    feeIntermediate: null,
    feeAdvanced: null,
    startsAt: '2026-11-03T19:00:00.000Z',
    endsAt: '2026-11-03T21:00:00.000Z',
    cancellationDeadline: '2026-11-01T19:00:00.000Z',
    deadlineIsDefault: true,
    isInstanceOverridden: false,
    draftReason: 'admin',
    seriesName: null,
    version: 3,
    activeRegistrationCount: 0,
    feesLocked: 'none',
    courts: [
      {
        id: '21111111-1111-4111-8111-111111111111',
        identifier: 'Court 1',
        startTime: '08:00',
        endTime: '10:00',
      },
      {
        id: '21111111-1111-4111-8111-222222222222',
        identifier: 'Court 2',
        startTime: '08:00',
        endTime: '10:00',
      },
    ],
    ...overrides,
  } as SessionResponse;
}

export function instanceFixture(
  overrides: Partial<SeriesInstanceResponse> = {},
): SeriesInstanceResponse {
  return {
    id: '61111111-1111-4111-8111-111111111111',
    date: '2026-11-04',
    startsAt: '2026-11-03T19:00:00.000Z',
    endsAt: '2026-11-03T21:00:00.000Z',
    status: 'PUBLISHED',
    phase: 'upcoming',
    draftReason: null,
    isInstanceOverridden: false,
    activeRegistrationCount: 0,
    version: 1,
    seriesChangeEffect: 'will_update',
    ...overrides,
  };
}

export function seriesFixture(overrides: Overrides<SeriesResponse> = {}): SeriesResponse {
  return {
    id: RULE_ID,
    teamId: TEAM_ID,
    name: 'Wednesdays at Rosedale',
    frequency: 'WEEKLY',
    dayOfWeek: 3,
    startsOn: '2026-11-04',
    monthlyWeek: null,
    recurUntil: null,
    isActive: true,
    version: 2,
    materialising: false,
    location: 'Rosedale',
    address: '1 Court Rd',
    maxPlayers: 18,
    reservedSeats: 0,
    courtCost: '180.00',
    extraExpenses: '20.00',
    calculatedRatePerPlayer: '12.00',
    customPlayerRate: null,
    pricingStructure: 'FLAT',
    feeFlat: '12.00',
    feeMale: null,
    feeFemale: null,
    feeOther: null,
    feeBeginner: null,
    feeIntermediate: null,
    feeAdvanced: null,
    courts: [
      { identifier: 'Court 1', startTime: '08:00', endTime: '10:00' },
      { identifier: 'Court 2', startTime: '08:00', endTime: '10:00' },
    ],
    isPayoutConfigured: true,
    bankingDrafts: 0,
    editedDrafts: 0,
    instances: [instanceFixture()],
    ...overrides,
  } as SeriesResponse;
}
