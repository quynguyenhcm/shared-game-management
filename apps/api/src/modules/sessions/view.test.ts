/**
 * The admin view of a session row (task spec "API": `phase` from the API clock, `draftReason`, `feesLocked`,
 * money and times as the contract prints them). Pure: no database.
 */
import { SessionResponse, type LocalDate, type LocalTime, type MoneyString } from '@sgm/shared';
import { describe, expect, it } from 'vitest';
import { draftReasonOf, phaseOf, toSessionResponse, type SessionRow } from './view.ts';

const at = (iso: string): Date => new Date(iso);
const money = (value: string) => value as MoneyString;

function row(over: Partial<SessionRow> = {}): SessionRow {
  return {
    id: '0b6f0a5e-5d0b-4a52-9d52-0d9a0f0b1c11',
    team_id: '3b241101-e2bb-4255-8caf-4136c566a962',
    recurring_rule_id: null,
    is_instance_overridden: false,
    location: 'Rosedale Hall',
    address: '1 Hall Rd, Auckland',
    date: '2026-11-04' as LocalDate,
    cancellation_deadline: at('2026-11-01T19:00:00Z'),
    max_players: 12,
    reserved_seats: 0,
    total_court_cost: money('120.00'),
    extra_expenses: money('12.00'),
    calculated_rate_per_player: money('11.00'),
    custom_player_rate: null,
    pricing_structure: 'FLAT',
    fee_flat: money('11.00'),
    fee_male: null,
    fee_female: null,
    fee_other: null,
    fee_beginner: null,
    fee_intermediate: null,
    fee_advanced: null,
    status: 'DRAFT',
    starts_at: at('2026-11-03T19:00:00Z'),
    ends_at: at('2026-11-03T21:00:00Z'),
    created_at: at('2026-10-06T00:00:00Z'),
    updated_at: at('2026-10-06T00:00:00Z'),
    version: 1,
    create_key: null,
    deadline_is_default: true,
    auto_enrol_required: true,
    auto_enrolled_at: null,
    ...over,
  };
}

const courts = [
  {
    id: '5c7f6a4e-0000-4000-8000-000000000002',
    court_identifier: 'Court 10',
    start_time: '08:00:00' as LocalTime,
    end_time: '10:00:00' as LocalTime,
  },
  {
    id: '5c7f6a4e-0000-4000-8000-000000000001',
    court_identifier: 'Court 2',
    start_time: '08:00:00' as LocalTime,
    end_time: '09:00:00' as LocalTime,
  },
];

describe('phaseOf', () => {
  const starts = at('2026-11-03T19:00:00Z');
  const ends = at('2026-11-03T21:00:00Z');
  it('is upcoming before the first start, started until the last end, then ended (the end is ended)', () => {
    expect(phaseOf(starts, ends, at('2026-11-03T18:59:59Z'))).toBe('upcoming');
    expect(phaseOf(starts, ends, starts)).toBe('started');
    expect(phaseOf(starts, ends, at('2026-11-03T20:59:59Z'))).toBe('started');
    expect(phaseOf(starts, ends, ends)).toBe('ended');
    expect(phaseOf(null, null, at('2030-01-01T00:00:00Z'))).toBe('upcoming');
  });
});

describe('draftReasonOf', () => {
  it('names why a draft is a draft, and is null for every other status', () => {
    expect(
      draftReasonOf({ status: 'DRAFT', recurring_rule_id: null, is_instance_overridden: false }),
    ).toBe('admin');
    expect(
      draftReasonOf({ status: 'DRAFT', recurring_rule_id: 'r', is_instance_overridden: true }),
    ).toBe('edited');
    expect(
      draftReasonOf({ status: 'DRAFT', recurring_rule_id: 'r', is_instance_overridden: false }),
    ).toBe('banking');
    expect(
      draftReasonOf({ status: 'PUBLISHED', recurring_rule_id: 'r', is_instance_overridden: false }),
    ).toBeNull();
  });
});

describe('toSessionResponse', () => {
  it('prints the contract: wall times without seconds, numeric court order, ISO instants, camelCase', () => {
    const response = toSessionResponse(row(), courts, {
      now: at('2026-10-06T00:00:00Z'),
      activeRegistrationCount: 0,
      seriesName: null,
    });
    expect(SessionResponse.safeParse(response).success).toBe(true);
    expect(response.seriesName).toBeNull();
    expect(response).toMatchObject({
      status: 'DRAFT',
      phase: 'upcoming',
      draftReason: 'admin',
      date: '2026-11-04',
      startsAt: '2026-11-03T19:00:00.000Z',
      endsAt: '2026-11-03T21:00:00.000Z',
      cancellationDeadline: '2026-11-01T19:00:00.000Z',
      deadlineIsDefault: true,
      maxPlayers: 12,
      courtCost: '120.00',
      calculatedRatePerPlayer: '11.00',
      customPlayerRate: null,
      feeFlat: '11.00',
      version: 1,
      feesLocked: 'none',
      activeRegistrationCount: 0,
      seriesName: null,
    });
    expect(response.courts.map((c) => [c.identifier, c.startTime, c.endTime])).toEqual([
      ['Court 2', '08:00', '09:00'],
      ['Court 10', '08:00', '10:00'],
    ]);
  });

  it('carries the series name it is given', () => {
    const response = toSessionResponse(row(), courts, {
      now: at('2026-10-06T00:00:00Z'),
      activeRegistrationCount: 0,
      seriesName: 'Wednesdays at Hall',
    });
    expect(response.seriesName).toBe('Wednesdays at Hall');
  });

  it('locks fees only on a PUBLISHED session with an active registration, and reports a null start without courts', () => {
    const published = toSessionResponse(row({ status: 'PUBLISHED' }), courts, {
      now: at('2026-10-06T00:00:00Z'),
      activeRegistrationCount: 2,
      seriesName: null,
    });
    expect(published.feesLocked).toBe('raise_only_blocked');
    expect(published.draftReason).toBeNull();
    const none = toSessionResponse(row({ status: 'PUBLISHED' }), courts, {
      now: at('2026-10-06T00:00:00Z'),
      activeRegistrationCount: 0,
      seriesName: null,
    });
    expect(none.feesLocked).toBe('none');
    const draftWithPlayers = toSessionResponse(row(), courts, {
      now: at('2026-10-06T00:00:00Z'),
      activeRegistrationCount: 2,
      seriesName: null,
    });
    expect(draftWithPlayers.feesLocked).toBe('none');
    const empty = toSessionResponse(row({ starts_at: null, ends_at: null }), [], {
      now: at('2026-10-06T00:00:00Z'),
      activeRegistrationCount: 0,
      seriesName: null,
    });
    expect(empty).toMatchObject({ startsAt: null, endsAt: null, phase: 'upcoming', courts: [] });
  });
});
