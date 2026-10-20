import { describe, expect, it } from 'vitest';
import { parseMoney } from '@sgm/shared';
import type { LockedRule } from './locks.ts';
import {
  buildSeriesExtras,
  existingInstanceOf,
  toSeriesListItem,
  toSeriesResponse,
} from './series-view.ts';
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

const NO_EXTRAS = {
  isPayoutConfigured: false,
  bankingDrafts: 0,
  editedDrafts: 0,
  instances: [],
};

describe('toSeriesResponse', () => {
  it('derives the name from the pattern and location and passes the extras through', () => {
    const response = toSeriesResponse(
      ruleRow(),
      [],
      { ...NO_EXTRAS, isPayoutConfigured: true, bankingDrafts: 2, editedDrafts: 1 },
      28,
    );
    expect(response).toMatchObject({
      name: 'Wednesdays at Hall',
      isPayoutConfigured: true,
      bankingDrafts: 2,
      editedDrafts: 1,
      instances: [],
    });
    expect(
      toSeriesResponse(ruleRow({ frequency: 'MONTHLY', monthly_week: -1 }), [], NO_EXTRAS, 28).name,
    ).toBe('Last Wednesday of the month at Hall');
  });

  it('reports materialising while the last run trails the version (or never ran), and not once it caught up', () => {
    expect(
      toSeriesResponse(ruleRow({ materialised_version: null }), [], NO_EXTRAS, 28).materialising,
    ).toBe(true);
    expect(
      toSeriesResponse(ruleRow({ materialised_version: 2 }), [], NO_EXTRAS, 28).materialising,
    ).toBe(true);
    expect(
      toSeriesResponse(ruleRow({ materialised_version: 3 }), [], NO_EXTRAS, 28).materialising,
    ).toBe(false);
  });

  it('lists the template courts in position order with HH:MM times and keeps the 24:00 end marker', () => {
    const response = toSeriesResponse(
      ruleRow(),
      [
        { court_identifier: 'Court 2', start_time: '18:00:00', end_time: '24:00:00', position: 2 },
        { court_identifier: 'Court 1', start_time: '19:00:00', end_time: '21:00:00', position: 1 },
      ],
      NO_EXTRAS,
      28,
    );
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

describe('the materialisation horizon and the list row', () => {
  it('reports the configured horizon on the series response', () => {
    expect(toSeriesResponse(ruleRow(), [], NO_EXTRAS, 56).horizonDays).toBe(56);
  });

  it('maps a rule to its list row: name, status flags, end date, no dates', () => {
    expect(toSeriesListItem(ruleRow({ materialised_version: 2 }))).toEqual({
      id: '11111111-1111-4111-8111-111111111111',
      name: 'Wednesdays at Hall',
      startsOn: '2026-10-07',
      recurUntil: null,
      isActive: true,
      version: 3,
      materialising: true,
    });
    expect(
      toSeriesListItem(
        ruleRow({ is_active: false, recur_until: '2026-12-16' as LockedRule['recur_until'] }),
      ),
    ).toMatchObject({ isActive: false, recurUntil: '2026-12-16', materialising: false });
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

describe('buildSeriesExtras', () => {
  const base = {
    id: '33333333-3333-4333-8333-333333333333',
    status: 'PUBLISHED',
    date: '2026-10-21',
    location: 'Hall',
    address: '1 Street',
    max_players: 24,
    reserved_seats: 2,
    total_court_cost: '240.00',
    extra_expenses: '0.00',
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
    ends_at: new Date('2026-10-21T08:00:00Z'),
    cancellation_deadline: new Date('2026-10-19T06:00:00Z'),
    deadline_is_default: true,
    is_instance_overridden: false,
    recurring_rule_id: '11111111-1111-4111-8111-111111111111',
    version: 4,
  };
  const row = (id: string, over: Record<string, unknown>): SessionRow =>
    ({ ...base, id, ...over }) as unknown as SessionRow;

  const build = (rows: SessionRow[], counts: Record<string, number> = {}) =>
    buildSeriesExtras({
      rule: ruleRow(),
      templateCourts: [
        { court_identifier: 'Court 1', start_time: '19:00:00', end_time: '21:00:00', position: 1 },
      ],
      rows,
      courtsByRow: new Map(),
      counts: new Map(Object.entries(counts)),
      draftCounts: { banking: 3, edited: 1 },
      isPayoutConfigured: true,
      now: new Date('2026-10-20T00:00:00Z'),
      today: '2026-10-20' as never,
    });

  it('gives each instance exactly one of the four series change effects, soonest first', () => {
    const extras = build(
      [
        row('a', { date: '2026-11-18', status: 'CANCELLED' }),
        row('b', { date: '2026-11-11', status: 'PUBLISHED', is_instance_overridden: true }),
        row('c', {
          date: '2026-11-04',
          status: 'PUBLISHED',
          starts_at: new Date('2026-11-04T06:00:00Z'),
          cancellation_deadline: new Date('2026-11-02T06:00:00Z'),
        }),
        row('d', {
          date: '2026-10-28',
          status: 'DRAFT',
          starts_at: new Date('2026-10-28T06:00:00Z'),
        }),
      ],
      { c: 2 },
    );
    expect(extras.instances.map((i) => [i.id, i.seriesChangeEffect])).toEqual([
      ['d', 'will_update'],
      ['c', 'has_registrations'],
      ['b', 'edited'],
      ['a', 'closed'],
    ]);
    expect(extras.instances[1]).toMatchObject({
      date: '2026-11-04',
      status: 'PUBLISHED',
      phase: 'upcoming',
      draftReason: null,
      isInstanceOverridden: false,
      activeRegistrationCount: 2,
      version: 4,
      startsAt: '2026-11-04T06:00:00.000Z',
      endsAt: '2026-10-21T08:00:00.000Z',
    });
    expect(extras.instances[0]?.draftReason).toBe('banking');
    expect(extras.bankingDrafts).toBe(3);
    expect(extras.editedDrafts).toBe(1);
    expect(extras.isPayoutConfigured).toBe(true);
  });

  it('marks a started instance and a past draft closed', () => {
    const extras = build([
      row('p', {
        date: '2026-10-13',
        status: 'DRAFT',
        starts_at: new Date('2026-10-13T06:00:00Z'),
      }),
      row('s', {
        date: '2026-10-20',
        status: 'PUBLISHED',
        starts_at: new Date('2026-10-19T23:00:00Z'),
      }),
    ]);
    expect(extras.instances.map((i) => [i.id, i.seriesChangeEffect])).toEqual([
      ['p', 'closed'],
      ['s', 'closed'],
    ]);
  });
});
