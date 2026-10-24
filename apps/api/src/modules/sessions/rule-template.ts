/**
 * Row-to-domain mapping for a series rule: the pure `RecurrenceRule` (which dates), the `SeriesTemplate` (what each date
 * starts from) and the court template, built from the locked `recurring_session_rules` and `recurring_rule_courts` rows.
 * `buildInstance` and `recurrenceDates` (shared) do the real work, so the materialiser and the series-save reconciliation
 * produce identical instances from the same rule.
 */
import {
  ZERO,
  parseLocalTime,
  parseMoney,
  toMoneyString,
  type InstancePlan,
  type Money,
  type MonthlyWeek,
  type RecurrenceRule,
  type RuleCourtTemplate,
  type SeriesTemplate,
} from '@sgm/shared';
import type { Database } from '../../lib/db/kysely.ts';
import type { GameSessions } from '../../lib/db/types.generated.ts';
import type { Insertable, Selectable } from 'kysely';
import type { PublishGateFees } from '../team-banking/publish-gate.ts';
import type { LockedRule } from './locks.ts';

const money = (value: string | null): Money | null => (value === null ? null : parseMoney(value));

export function recurrenceRuleOf(rule: LockedRule): RecurrenceRule {
  return {
    frequency: rule.frequency,
    dayOfWeek: rule.day_of_week,
    startsOn: rule.starts_on,
    monthlyWeek: rule.monthly_week as MonthlyWeek | null,
    recurUntil: rule.recur_until,
  };
}

export function templateOf(rule: LockedRule): SeriesTemplate {
  return {
    pricingStructure: rule.pricing_structure,
    // The flat fee of an instance is rebuilt from costing (`finalFlatRate`); the stored rule fee mirrors it.
    feeFlat: money(rule.fee_flat),
    feeMale: money(rule.fee_male),
    feeFemale: money(rule.fee_female),
    feeOther: money(rule.fee_other),
    feeBeginner: money(rule.fee_beginner),
    feeIntermediate: money(rule.fee_intermediate),
    feeAdvanced: money(rule.fee_advanced),
    location: rule.default_location,
    address: rule.default_address,
    maxPlayers: rule.default_max_players,
    reservedSeats: rule.default_reserved_seats,
    courtCost: money(rule.default_total_court_cost) ?? ZERO,
    extraExpenses: money(rule.default_extra_expenses) ?? ZERO,
    customPlayerRate: money(rule.default_custom_player_rate),
  };
}

/** The rule's court template in display order (`position`), ready for `buildInstance`. */
export async function readTemplateCourts(
  db: Database,
  ruleId: string,
): Promise<RuleCourtTemplate[]> {
  const rows = await db
    .selectFrom('recurring_rule_courts')
    .select(['court_identifier', 'start_time', 'end_time'])
    .where('rule_id', '=', ruleId)
    .orderBy('position', 'asc')
    .execute();
  return rows.map((row) => ({
    courtIdentifier: row.court_identifier,
    // PostgreSQL `time` comes back as HH:MM:SS; the template uses HH:MM (and 24:00 for midnight).
    startTime: parseLocalTime(row.start_time.slice(0, 5)),
    endTime: row.end_time.startsWith('24:00')
      ? ('24:00' as RuleCourtTemplate['endTime'])
      : parseLocalTime(row.end_time.slice(0, 5)),
  }));
}

const str = (value: Money | null) => (value === null ? null : toMoneyString(value));

/** The fee columns as the publish gate reads them. */
export function gateFeesOfPlan(plan: InstancePlan): PublishGateFees {
  return {
    feeFlat: str(plan.feeFlat),
    feeMale: str(plan.feeMale),
    feeFemale: str(plan.feeFemale),
    feeOther: str(plan.feeOther),
    feeBeginner: str(plan.feeBeginner),
    feeIntermediate: str(plan.feeIntermediate),
    feeAdvanced: str(plan.feeAdvanced),
  };
}

/** The gate's view of an existing session row (a FLAT session's `fee_flat` already is the final rate). */
export function gateFeesOfRow(
  row: Pick<
    Selectable<GameSessions>,
    | 'fee_flat'
    | 'fee_male'
    | 'fee_female'
    | 'fee_other'
    | 'fee_beginner'
    | 'fee_intermediate'
    | 'fee_advanced'
  >,
): PublishGateFees {
  return {
    feeFlat: row.fee_flat,
    feeMale: row.fee_male,
    feeFemale: row.fee_female,
    feeOther: row.fee_other,
    feeBeginner: row.fee_beginner,
    feeIntermediate: row.fee_intermediate,
    feeAdvanced: row.fee_advanced,
  };
}

/**
 * The content columns of an instance: what the materialiser inserts and a series save writes onto an unedited instance, so the
 * two can never disagree. The deadline is the default one (`deadline_is_default`), kept at `starts_at - 48 h` by the database.
 */
export function instanceContentColumns(plan: InstancePlan) {
  return {
    location: plan.location,
    address: plan.address,
    max_players: plan.maxPlayers,
    reserved_seats: plan.reservedSeats,
    pricing_structure: plan.pricingStructure,
    fee_flat: str(plan.feeFlat),
    fee_male: str(plan.feeMale),
    fee_female: str(plan.feeFemale),
    fee_other: str(plan.feeOther),
    fee_beginner: str(plan.feeBeginner),
    fee_intermediate: str(plan.feeIntermediate),
    fee_advanced: str(plan.feeAdvanced),
    total_court_cost: toMoneyString(plan.courtCost),
    extra_expenses: toMoneyString(plan.extraExpenses),
    calculated_rate_per_player: toMoneyString(plan.calculatedRatePerPlayer),
    custom_player_rate: str(plan.customPlayerRate),
    // No courts yet on an insert, so the DB cannot derive the deadline; the court insert re-derives it while `deadline_is_default`.
    cancellation_deadline: plan.cancellationDeadline,
    deadline_is_default: plan.deadlineIsDefault,
  };
}

/** The `game_sessions` row for one date of a series: always a DRAFT (ADR 0016: never `INSERT … 'PUBLISHED'`). */
export function instanceRow(
  input: { readonly teamId: string; readonly ruleId: string },
  plan: InstancePlan,
): Insertable<GameSessions> {
  return {
    team_id: input.teamId,
    recurring_rule_id: input.ruleId,
    date: plan.date,
    status: 'DRAFT',
    ...instanceContentColumns(plan),
    is_instance_overridden: false,
    auto_enrol_required: true,
  };
}
