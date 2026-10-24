/**
 * Building one dated session instance from a series template (algorithm doc "Instance building"). Pure: the
 * materialiser and the series-save reconciliation both call `buildInstance`, so an instance created today and
 * one reconciled tomorrow come out identical. Wall-clock times are resolved with `DST_POLICY.DERIVED`
 * (`compatible`), exactly what the D-08 `game_sessions_derive_instants` trigger will compute from the stored
 * court times, so `startsAt` here equals the stored `starts_at`.
 */
import type { Money } from '../money/money.ts';
import {
  DST_POLICY,
  defaultCancellationDeadline,
  instantToLocal,
  localToInstant,
  parseLocalTime,
  resolveLocal,
  type LocalDate,
  type LocalTime,
} from '../time/time.ts';
import { finalFlatRate, suggestedRate, type SessionFees } from './costing.ts';

export interface RuleCourtTemplate {
  readonly courtIdentifier: string;
  readonly startTime: LocalTime;
  /** '24:00' is allowed as an end-of-day marker. */
  readonly endTime: LocalTime;
}

/** The series defaults every instance starts from (the editable content of a session). */
export interface SeriesTemplate extends SessionFees {
  readonly location: string;
  readonly address: string;
  readonly maxPlayers: number;
  readonly reservedSeats: number;
  readonly courtCost: Money;
  readonly extraExpenses: Money;
  /** null: follow the suggestion. A value pins the FLAT rate. */
  readonly customPlayerRate: Money | null;
}

export interface InstancePlan extends SeriesTemplate {
  readonly date: LocalDate;
  readonly calculatedRatePerPlayer: Money;
  readonly courts: readonly RuleCourtTemplate[];
  readonly startsAt: Date;
  readonly cancellationDeadline: Date;
  readonly deadlineIsDefault: boolean;
  readonly isInstanceOverridden: boolean;
}

/**
 * A derived (template) wall-clock time in the spring-forward gap is rewritten to the real wall time of its
 * resolved instant (02:30 becomes 03:30 on 2026-09-27). An overlap time is stored unchanged and resolves to the
 * earlier instant, so materialisation never fails on a DST day (AC-ASYNC-1).
 */
export function normaliseDerived(date: LocalDate, time: LocalTime): LocalTime {
  const resolution = resolveLocal(date, time);
  return resolution.kind === 'nonexistent' ? instantToLocal(resolution.shiftedForward).time : time;
}

const TWO_AM = 120;
const THREE_AM = 180;

function minutesOf(time: LocalTime): number {
  const [h, m] = time.split(':').map(Number) as [number, number];
  return h * 60 + m;
}

/**
 * True when a template court lies wholly inside 02:00-03:00. NZ's gap is always that hour, and on the DST-start
 * day such a court would have no real duration once normalised, so the rule save refuses it (T9).
 */
export function isCourtWhollyInDstGap(
  court: Pick<RuleCourtTemplate, 'startTime' | 'endTime'>,
): boolean {
  return minutesOf(court.startTime) >= TWO_AM && minutesOf(court.endTime) <= THREE_AM;
}

/** The fee columns that belong to the structure; the other models' columns are cleared. */
function feesFor(template: SeriesTemplate, flat: Money): SessionFees {
  const none = { feeFlat: null, feeMale: null, feeFemale: null, feeOther: null } as const;
  const noSkill = { feeBeginner: null, feeIntermediate: null, feeAdvanced: null } as const;
  switch (template.pricingStructure) {
    case 'FLAT':
      return { pricingStructure: 'FLAT', ...none, ...noSkill, feeFlat: flat };
    case 'BY_SEX':
      return {
        pricingStructure: 'BY_SEX',
        ...none,
        ...noSkill,
        feeMale: template.feeMale,
        feeFemale: template.feeFemale,
        feeOther: template.feeOther,
      };
    case 'BY_SKILL_LEVEL':
      return {
        pricingStructure: 'BY_SKILL_LEVEL',
        ...none,
        feeBeginner: template.feeBeginner,
        feeIntermediate: template.feeIntermediate,
        feeAdvanced: template.feeAdvanced,
      };
  }
}

/** What the materialiser inserts (and a series save reconciles to) for one date of the series. */
export function buildInstance(
  template: SeriesTemplate,
  courts: readonly RuleCourtTemplate[],
  date: LocalDate,
): InstancePlan {
  if (courts.length === 0) throw new RangeError('a series needs at least one court');

  const planned = courts.map((c) => {
    const startTime = normaliseDerived(date, c.startTime);
    return {
      courtIdentifier: c.courtIdentifier,
      startTime,
      endTime: c.endTime === '24:00' ? c.endTime : normaliseDerived(date, c.endTime),
    };
  });
  const startsAt = planned
    .map((c) => localToInstant(date, parseLocalTime(c.startTime), DST_POLICY.DERIVED))
    .reduce((earliest, next) => (next < earliest ? next : earliest));

  const calculated = suggestedRate(template.courtCost, template.extraExpenses, template.maxPlayers);
  return {
    ...template,
    ...feesFor(template, finalFlatRate(template.customPlayerRate, calculated)),
    date,
    calculatedRatePerPlayer: calculated,
    courts: planned,
    startsAt,
    cancellationDeadline: defaultCancellationDeadline(startsAt),
    deadlineIsDefault: true,
    isInstanceOverridden: false,
  };
}
