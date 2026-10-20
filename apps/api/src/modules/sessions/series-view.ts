/**
 * Row-to-response and row-to-reconciliation mapping for series (binding T-5, T-6). Pure: no database, no clock. The series
 * response is the admin view of a locked or read `recurring_session_rules` row plus its court template, and
 * `existingInstanceOf` turns a stored instance into the shape `planSeriesReconciliation` / `planEndSeries` compare.
 */
import {
  ZERO,
  planSeriesReconciliation,
  seriesName,
  type LocalDate,
  type SeriesInstanceResponse,
  type SeriesRule,
  parseLocalTime,
  parseMoney,
  suggestedRate,
  toMoneyString,
  type ExistingInstance,
  type MoneyString,
  type RuleCourtTemplate,
  type SeriesListItem,
  type SeriesResponse,
} from '@sgm/shared';
import { trimTime } from './content.ts';
import type { LockedRule } from './locks.ts';
import { recurrenceRuleOf, templateOf } from './rule-template.ts';
import { draftReasonOf, phaseOf, type CourtRow, type SessionRow } from './view.ts';

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

/** The read-model parts of a series response that come from queries rather than from the rule row. */
export type SeriesViewExtras = Pick<
  SeriesResponse,
  'isPayoutConfigured' | 'bankingDrafts' | 'editedDrafts' | 'instances'
>;

export function seriesNameOf(
  rule: Pick<LockedRule, 'frequency' | 'day_of_week' | 'monthly_week' | 'default_location'>,
): string {
  return seriesName({
    frequency: rule.frequency,
    dayOfWeek: rule.day_of_week,
    monthlyWeek: rule.monthly_week,
    location: rule.default_location,
  });
}

/** One Series-section row of the Sessions page: the rule alone, no dates. */
export function toSeriesListItem(rule: LockedRule): SeriesListItem {
  return {
    id: rule.id,
    name: seriesNameOf(rule),
    startsOn: rule.starts_on,
    recurUntil: rule.recur_until,
    isActive: rule.is_active,
    version: rule.version,
    materialising: isMaterialising(rule),
  };
}

export function toSeriesResponse(
  rule: LockedRule,
  courts: readonly RuleCourtRow[],
  extras: SeriesViewExtras,
  horizonDays: number,
): SeriesResponse {
  return {
    id: rule.id,
    teamId: rule.team_id,
    name: seriesNameOf(rule),
    frequency: rule.frequency,
    dayOfWeek: rule.day_of_week,
    startsOn: rule.starts_on,
    monthlyWeek: rule.monthly_week,
    recurUntil: rule.recur_until,
    isActive: rule.is_active,
    version: rule.version,
    materialising: isMaterialising(rule),
    horizonDays,
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
    ...extras,
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

export interface SeriesExtrasInput {
  readonly rule: LockedRule;
  readonly templateCourts: readonly RuleCourtRow[];
  /** The rule's sessions from today forward plus any DRAFT, soonest first, already capped. */
  readonly rows: readonly SessionRow[];
  readonly courtsByRow: ReadonlyMap<string, readonly CourtRow[]>;
  readonly counts: ReadonlyMap<string, number>;
  readonly draftCounts: { readonly banking: number; readonly edited: number };
  readonly isPayoutConfigured: boolean;
  readonly now: Date;
  /** NZ local date of `now`. */
  readonly today: LocalDate;
}

type Effect = SeriesInstanceResponse['seriesChangeEffect'];

/**
 * The series page's read model. The effect of each instance is what the next series save would do to it, taken from
 * `planSeriesReconciliation` against the rule as it is now (no second copy of the rules): skipped instances are `edited`,
 * `closed` (closed, started, past deadline) or `has_registrations` (fee-locked); an instance a save would update is
 * `has_registrations` when it is PUBLISHED with players (its fees can then only go down), otherwise `will_update`.
 * Off-pattern instances are kept as they are (`edited`), and anything before today is `closed`.
 */
export function buildSeriesExtras(input: SeriesExtrasInput): SeriesViewExtras {
  const seriesRule: SeriesRule = { ...recurrenceRuleOf(input.rule), ...templateOf(input.rule) };
  const rows = [...input.rows].sort((a, b) =>
    a.date < b.date ? -1 : a.date > b.date ? 1 : a.id < b.id ? -1 : 1,
  );
  const instances = rows.map((row) =>
    existingInstanceOf(row, input.courtsByRow.get(row.id) ?? [], input.counts.get(row.id) ?? 0),
  );
  const actions = planSeriesReconciliation({
    rule: seriesRule,
    courts: [...input.templateCourts]
      .sort((a, b) => a.position - b.position)
      .map((court) =>
        courtTemplateOf({
          id: '',
          court_identifier: court.court_identifier,
          start_time: court.start_time,
          end_time: court.end_time,
        }),
      ),
    instances,
    today: input.today,
    now: input.now,
  });
  const actionOf = new Map(actions.map((action) => [action.sessionId, action]));

  const effectOf = (row: SessionRow, count: number): Effect => {
    const action = actionOf.get(row.id);
    if (action === undefined) return 'closed';
    switch (action.kind) {
      case 'skip':
        return action.reason === 'edited'
          ? 'edited'
          : action.reason === 'fee_locked'
            ? 'has_registrations'
            : 'closed';
      case 'keep_off_pattern':
        return 'edited';
      case 'update':
      case 'unchanged':
      case 'delete':
      case 'cancel':
        return row.status === 'PUBLISHED' && count > 0 ? 'has_registrations' : 'will_update';
    }
  };

  return {
    isPayoutConfigured: input.isPayoutConfigured,
    bankingDrafts: input.draftCounts.banking,
    editedDrafts: input.draftCounts.edited,
    instances: rows.map((row) => {
      const count = input.counts.get(row.id) ?? 0;
      return {
        id: row.id,
        date: row.date,
        startsAt: row.starts_at?.toISOString() ?? null,
        endsAt: row.ends_at?.toISOString() ?? null,
        status: row.status,
        phase: phaseOf(row.starts_at, row.ends_at, input.now),
        draftReason: draftReasonOf(row),
        isInstanceOverridden: row.is_instance_overridden,
        activeRegistrationCount: count,
        version: row.version,
        seriesChangeEffect: effectOf(row, count),
      };
    }),
  };
}
