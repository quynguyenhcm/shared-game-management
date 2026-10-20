import { describe, expect, it } from 'vitest';
import { parseMoney } from '@sgm/shared';
import type { LockedRule } from './locks.ts';
import { existingInstanceOf, toSeriesResponse } from './series-view.ts';
import type { SessionRow } from './view.ts';

const ruleRow = (over: Partial<LockedRule> = {}): LockedRule =>
  ({
    id: '11111111-1111-4111-8111-111111111111',
    team_id: '22222222-2222-4222-8222-222222222222',
    frequency: 'WEEKLY',
    day_of_week: 3,
    starts_on: '2026-10-07',
    monthly_week: null,
    recur_until: null,
    is_active: true,
    version: 3,
    materialised_version: 3,
    default_location: 'Hall',
    default_address: '1 Street',
    default_max_players: 24,
    default_reserved_seats: 2,
    default_total_court_cost: '240.00',
    default_extra_expenses: '0.00',
    default_custom_player_rate: null,
    pricing_structure: 'FLAT',
    fee_flat: '10.00',
    fee_male: null,
    fee_female: null,
    fee_other: null,
    fee_beginner: null,
    fee_intermediate: null,
    fee_advanced: null,
    ...over,
  }) as LockedRule;

describe('toSeriesResponse', () => {
  it('reports materialising while the last run trails the version (or never ran), and not once it caught up', () => {
    expect(toSeriesResponse(ruleRow({ materialised_version: null }), []).materialising).toBe(true);
    expect(toSeriesResponse(ruleRow({ materialised_version: 2 }), []).materialising).toBe(true);
    expect(toSeriesResponse(ruleRow({ materialised_version: 3 }), []).materialising).toBe(false);
  });

  it('lists the template courts in position order with HH:MM times and keeps the 24:00 end marker', () => {
    const response = toSeriesResponse(ruleRow(), [
      { court_identifier: 'Court 2', start_time: '18:00:00', end_time: '24:00:00', position: 2 },
      { court_identifier: 'Court 1', start_time: '19:00:00', end_time: '21:00:00', position: 1 },
    ]);
    expect(response.courts).toEqual([
      { identifier: 'Court 1', startTime: '19:00', endTime: '21:00' },
      { identifier: 'Court 2', startTime: '18:00', endTime: '24:00' },
    ]);
    expect(response).toMatchObject({
      id: '11111111-1111-4111-8111-111111111111',
      dayOfWeek: 3,
      reservedSeats: 2,
      courtCost: '240.00',
      feeFlat: '10.00',
    });
  });
});

describe('existingInstanceOf', () => {
  const sessionRow = (over: Partial<SessionRow> = {}): SessionRow =>
    ({
      id: '33333333-3333-4333-8333-333333333333',
      status: 'PUBLISHED',
      date: '2026-10-21',
      location: 'Hall',
      address: '1 Street',
      max_players: 24,
      reserved_seats: 0,
      total_court_cost: '240.00',
      extra_expenses: null,
      calculated_rate_per_player: '10.00',
      custom_player_rate: null,
      pricing_structure: 'FLAT',
      fee_flat: '10.00',
      fee_male: null,
      fee_female: null,
      fee_other: null,
      fee_beginner: null,
      fee_intermediate: null,
      fee_advanced: null,
      starts_at: new Date('2026-10-21T06:00:00Z'),
      cancellation_deadline: new Date('2026-10-19T06:00:00Z'),
      deadline_is_default: true,
      is_instance_overridden: false,
      ...over,
    }) as SessionRow;

  it('maps a stored row to the reconciliation shape with exact money, HH:MM courts and the registration count', () => {
    const instance = existingInstanceOf(
      sessionRow(),
      [{ id: 'c1', court_identifier: 'Court 1', start_time: '19:00:00', end_time: '21:00:00' }],
      3,
    );
    expect(instance).toMatchObject({
      id: '33333333-3333-4333-8333-333333333333',
      status: 'PUBLISHED',
      date: '2026-10-21',
      courtCost: parseMoney('240.00'),
      extraExpenses: parseMoney('0.00'),
      calculatedRatePerPlayer: parseMoney('10.00'),
      feeFlat: parseMoney('10.00'),
      feeMale: null,
      isInstanceOverridden: false,
      deadlineIsDefault: true,
      activeRegistrationCount: 3,
    });
    expect(instance.courts).toEqual([
      { courtIdentifier: 'Court 1', startTime: '19:00', endTime: '21:00' },
    ]);
    expect(instance.startsAt.toISOString()).toBe('2026-10-21T06:00:00.000Z');
  });

  it('treats a session with no court yet as not started, so it is reconciled rather than skipped', () => {
    const instance = existingInstanceOf(sessionRow({ starts_at: null }), [], 0);
    expect(instance.startsAt.getTime()).toBeGreaterThan(Date.UTC(9999, 0, 1));
    expect(instance.courts).toEqual([]);
  });
});
