/**
 * Row-to-response and row-to-reconciliation mapping for series (binding T-5, T-6). Pure: no database, no clock. The series
 * response is the admin view of a locked or read `recurring_session_rules` row plus its court template, and
 * `existingInstanceOf` turns a stored instance into the shape `planSeriesReconciliation` / `planEndSeries` compare.
 */
import {
  ZERO,
  parseLocalTime,
  parseMoney,
  suggestedRate,
  toMoneyString,
  type ExistingInstance,
  type MoneyString,
  type RuleCourtTemplate,
  type SeriesResponse,
} from '@sgm/shared';
import { trimTime } from './content.ts';
import type { LockedRule } from './locks.ts';
import type { CourtRow, SessionRow } from './view.ts';

export interface RuleCourtRow {
  readonly court_identifier: string;
  readonly start_time: string;
  readonly end_time: string;
  readonly position: number;
}

const ZERO_MONEY = '0.00' as MoneyString;

/** True while the last per-rule run trails the rule's version (or never ran): "We're adding the sessions…". */
export const isMaterialising = (
  rule: Pick<LockedRule, 'version' | 'materialised_version'>,
): boolean => rule.materialised_version === null || rule.materialised_version < rule.version;

export function toSeriesResponse(
  rule: LockedRule,
  courts: readonly RuleCourtRow[],
): SeriesResponse {
  return {
    id: rule.id,
    teamId: rule.team_id,
    frequency: rule.frequency,
    dayOfWeek: rule.day_of_week,
    startsOn: rule.starts_on,
    monthlyWeek: rule.monthly_week,
    recurUntil: rule.recur_until,
    isActive: rule.is_active,
    version: rule.version,
    materialising: isMaterialising(rule),
    location: rule.default_location,
    address: rule.default_address,
    maxPlayers: rule.default_max_players,
    reservedSeats: rule.default_reserved_seats,
    courtCost: rule.default_total_court_cost ?? ZERO_MONEY,
    extraExpenses: rule.default_extra_expenses ?? ZERO_MONEY,
    // The suggestion is derived from costing, never stored on the rule; only the pinned rate is.
    calculatedRatePerPlayer: toMoneyString(
      suggestedRate(
        parseMoney(rule.default_total_court_cost ?? ZERO_MONEY),
        parseMoney(rule.default_extra_expenses ?? ZERO_MONEY),
        rule.default_max_players,
      ),
    ),
    customPlayerRate: rule.default_custom_player_rate,
    pricingStructure: rule.pricing_structure,
    feeFlat: rule.fee_flat,
    feeMale: rule.fee_male,
    feeFemale: rule.fee_female,
    feeOther: rule.fee_other,
    feeBeginner: rule.fee_beginner,
    feeIntermediate: rule.fee_intermediate,
    feeAdvanced: rule.fee_advanced,
    courts: [...courts]
      .sort((a, b) => a.position - b.position)
      .map((court) => ({
        identifier: court.court_identifier,
        startTime: trimTime(court.start_time),
        endTime: trimTime(court.end_time),
      })),
  };
}

const money = (value: string | null) => (value === null ? null : parseMoney(value));

/** Past the end of any real date: a session with no court yet has not started, and never equals a built start. */
const NEVER_STARTED = new Date(8.64e15);

function courtTemplateOf(court: CourtRow): RuleCourtTemplate {
  const end = trimTime(court.end_time);
  return {
    courtIdentifier: court.court_identifier,
    startTime: parseLocalTime(trimTime(court.start_time)),
    endTime: end === '24:00' ? ('24:00' as RuleCourtTemplate['endTime']) : parseLocalTime(end),
  };
}

/** A stored instance as the reconciliation reads it (`activeRegistrationCount` read under the session lock). */
export function existingInstanceOf(
  row: SessionRow,
  courts: readonly CourtRow[],
  activeRegistrationCount: number,
): ExistingInstance {
  return {
    id: row.id,
    status: row.status,
    date: row.date,
    location: row.location,
    address: row.address,
    maxPlayers: row.max_players,
    reservedSeats: row.reserved_seats,
    courtCost: money(row.total_court_cost) ?? ZERO,
    extraExpenses: money(row.extra_expenses) ?? ZERO,
    calculatedRatePerPlayer: money(row.calculated_rate_per_player) ?? ZERO,
    customPlayerRate: money(row.custom_player_rate),
    pricingStructure: row.pricing_structure,
    feeFlat: money(row.fee_flat),
    feeMale: money(row.fee_male),
    feeFemale: money(row.fee_female),
    feeOther: money(row.fee_other),
    feeBeginner: money(row.fee_beginner),
    feeIntermediate: money(row.fee_intermediate),
    feeAdvanced: money(row.fee_advanced),
    courts: courts.map(courtTemplateOf),
    startsAt: row.starts_at ?? NEVER_STARTED,
    cancellationDeadline: row.cancellation_deadline,
    deadlineIsDefault: row.deadline_is_default,
    isInstanceOverridden: row.is_instance_overridden,
    activeRegistrationCount,
  };
}
