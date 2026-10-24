/**
 * What a series save (and End series) does to a series' existing instances (algorithm doc A3-c; Binding
 * Reconciliation T-5, T-6, P-3). Pure planning: the service executes each action in its own checks under the
 * session lock, re-running these same rules on fresh rows. There is deliberately no pattern-change plan: a
 * series' day, frequency, monthly week and first date are fixed after creation (P-3).
 *
 * The plan reconciles each future, unedited, not-started instance to the template as a whole (all of it or
 * none of it). The target is always computed from the current rule, so a retried save changes nothing more.
 */
import { feeRaised } from './costing.ts';
import {
  buildInstance,
  type InstancePlan,
  type RuleCourtTemplate,
  type SeriesTemplate,
} from './instance.ts';
import { assertRecurrenceRule, recurrenceDates, type RecurrenceRule } from './recurrence.ts';
import type { LocalDate } from '../time/time.ts';
import type { SessionStatus } from '../types/enums.ts';

export interface SeriesRule extends RecurrenceRule, SeriesTemplate {}

/** A persisted instance: its content as an `InstancePlan` plus identity, status and registration count. */
export interface ExistingInstance extends InstancePlan {
  readonly id: string;
  readonly status: SessionStatus;
  /** `game_session_has_active_registrations`, as a count; absent means none. */
  readonly activeRegistrationCount?: number;
}

/** In the order the checks run. */
export type SkipReason = 'closed' | 'started' | 'edited' | 'deadline_passed' | 'fee_locked';

export type ReconcileAction =
  | { readonly kind: 'unchanged'; readonly sessionId: string; readonly date: LocalDate }
  | {
      readonly kind: 'update';
      readonly sessionId: string;
      readonly date: LocalDate;
      readonly target: InstancePlan;
    }
  | { readonly kind: 'delete'; readonly sessionId: string; readonly date: LocalDate }
  | {
      readonly kind: 'keep_off_pattern';
      readonly sessionId: string;
      readonly date: LocalDate;
      readonly status: SessionStatus;
    }
  /** End series only: a PUBLISHED session after the last date, when the admin asked to cancel them. */
  | { readonly kind: 'cancel'; readonly sessionId: string; readonly date: LocalDate }
  | {
      readonly kind: 'skip';
      readonly sessionId: string;
      readonly date: LocalDate;
      readonly reason: SkipReason;
    };

export interface PlanInput {
  /** The rule as it will be after the save. */
  readonly rule: SeriesRule;
  /** The template courts after the save. */
  readonly courts: readonly RuleCourtTemplate[];
  readonly instances: readonly ExistingInstance[];
  /** NZ local date of `now`, read once per request. */
  readonly today: LocalDate;
  readonly now: Date;
}

const sameInstant = (a: Date, b: Date): boolean => a.getTime() === b.getTime();

function sortedCourts(courts: readonly RuleCourtTemplate[]): string[] {
  return courts.map((c) => `${c.courtIdentifier}|${c.startTime}|${c.endTime}`).sort();
}

/** True when the persisted instance already equals the target in every series-controlled field. */
function equalPersisted(a: InstancePlan, b: InstancePlan): boolean {
  return (
    a.location === b.location &&
    a.address === b.address &&
    a.maxPlayers === b.maxPlayers &&
    a.reservedSeats === b.reservedSeats &&
    a.courtCost === b.courtCost &&
    a.extraExpenses === b.extraExpenses &&
    a.calculatedRatePerPlayer === b.calculatedRatePerPlayer &&
    a.customPlayerRate === b.customPlayerRate &&
    a.pricingStructure === b.pricingStructure &&
    a.feeFlat === b.feeFlat &&
    a.feeMale === b.feeMale &&
    a.feeFemale === b.feeFemale &&
    a.feeOther === b.feeOther &&
    a.feeBeginner === b.feeBeginner &&
    a.feeIntermediate === b.feeIntermediate &&
    a.feeAdvanced === b.feeAdvanced &&
    sameInstant(a.startsAt, b.startsAt) &&
    sameInstant(a.cancellationDeadline, b.cancellationDeadline) &&
    sortedCourts(a.courts).join('\n') === sortedCourts(b.courts).join('\n')
  );
}

const isClosed = (status: SessionStatus): boolean =>
  status === 'COMPLETED' || status === 'CANCELLED';

function futureInstances(input: PlanInput): ExistingInstance[] {
  return input.instances
    .filter((i) => i.date >= input.today)
    .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
}

/**
 * One action per instance dated today or later, in date order. Instances before today are never mentioned.
 * Check order: closed, started, off the pattern (delete or keep), edited, unchanged, deadline passed, fee
 * locked, update.
 */
export function planSeriesReconciliation(input: PlanInput): ReconcileAction[] {
  const instances = futureInstances(input);
  const last = instances[instances.length - 1];
  if (last === undefined) return [];
  const generated = new Set<string>(
    recurrenceDates(input.rule, { from: input.today, to: last.date }),
  );

  return instances.map((i): ReconcileAction => {
    const base = { sessionId: i.id, date: i.date } as const;
    if (isClosed(i.status)) return { kind: 'skip', ...base, reason: 'closed' };
    if (i.startsAt.getTime() <= input.now.getTime()) {
      return { kind: 'skip', ...base, reason: 'started' };
    }
    if (!generated.has(i.date)) {
      return i.status === 'DRAFT' && !i.isInstanceOverridden
        ? { kind: 'delete', ...base }
        : { kind: 'keep_off_pattern', ...base, status: i.status };
    }
    if (i.isInstanceOverridden) return { kind: 'skip', ...base, reason: 'edited' };

    const target = buildInstance(input.rule, input.courts, i.date);
    if (equalPersisted(i, target)) return { kind: 'unchanged', ...base };
    if (
      i.status === 'PUBLISHED' &&
      (input.now.getTime() >= i.cancellationDeadline.getTime() ||
        target.cancellationDeadline.getTime() <= input.now.getTime())
    ) {
      return { kind: 'skip', ...base, reason: 'deadline_passed' };
    }
    if (
      i.status === 'PUBLISHED' &&
      (i.activeRegistrationCount ?? 0) > 0 &&
      feeRaised(i, target).length > 0
    ) {
      return { kind: 'skip', ...base, reason: 'fee_locked' };
    }
    return { kind: 'update', ...base, target };
  });
}

export interface ReconciliationSummary {
  readonly updated: number;
  readonly unchanged: number;
  /** Unedited off-pattern DRAFTs deleted. */
  readonly removed: number;
  /** Off-pattern sessions kept (edited drafts and PUBLISHED sessions). */
  readonly keptOffPattern: number;
  readonly skipped: {
    readonly edited: number;
    readonly started: number;
    readonly closed: number;
    readonly deadlinePassed: number;
    readonly feeLocked: number;
  };
}

/** The counts of the series-save response (T-5). */
export function summariseReconciliation(
  actions: readonly ReconcileAction[],
): ReconciliationSummary {
  const count = (test: (a: ReconcileAction) => boolean): number => actions.filter(test).length;
  const skipped = (reason: SkipReason): number =>
    count((a) => a.kind === 'skip' && a.reason === reason);
  return {
    updated: count((a) => a.kind === 'update'),
    unchanged: count((a) => a.kind === 'unchanged'),
    removed: count((a) => a.kind === 'delete'),
    keptOffPattern: count((a) => a.kind === 'keep_off_pattern'),
    skipped: {
      edited: skipped('edited'),
      started: skipped('started'),
      closed: skipped('closed'),
      deadlinePassed: skipped('deadline_passed'),
      feeLocked: skipped('fee_locked'),
    },
  };
}

/** UI/UX assumption 5: there is no `needs_banking` value, because T-5 refuses the whole edit instead. */
export type SeriesChangeEffectKind = 'will_update' | 'edited' | 'closed' | 'has_registrations';

export interface SeriesChangeEffect {
  readonly sessionId: string;
  readonly date: LocalDate;
  readonly effect: SeriesChangeEffectKind;
}

/**
 * The before-save effect line: for each instance the change would touch or leave behind, what will happen to
 * it. Unchanged and off-pattern instances are not listed. `closed` covers closed, started and past-deadline.
 */
export function seriesChangeEffect(input: PlanInput): SeriesChangeEffect[] {
  const out: SeriesChangeEffect[] = [];
  for (const action of planSeriesReconciliation(input)) {
    const base = { sessionId: action.sessionId, date: action.date } as const;
    switch (action.kind) {
      case 'update':
        out.push({ ...base, effect: 'will_update' });
        break;
      case 'skip':
        out.push({
          ...base,
          effect:
            action.reason === 'edited'
              ? 'edited'
              : action.reason === 'fee_locked'
                ? 'has_registrations'
                : 'closed',
        });
        break;
      default:
        break;
    }
  }
  return out;
}

export interface EndSeriesInput {
  readonly rule: SeriesRule;
  /** The chosen last date (inclusive); it becomes `recur_until`. */
  readonly lastDate: LocalDate;
  readonly instances: readonly ExistingInstance[];
  readonly today: LocalDate;
  readonly now: Date;
  /** The admin ticked "Also cancel the published sessions after this date". */
  readonly alsoCancelPublished: boolean;
}

export interface EndSeriesPlan {
  readonly recurUntil: LocalDate;
  /** False when the last date is today or earlier. */
  readonly isActive: boolean;
  readonly actions: ReconcileAction[];
  /** The numbers the confirm shows before the admin commits. */
  readonly counts: {
    readonly draftsToDelete: number;
    readonly publishedAfter: number;
    readonly editedDraftsKept: number;
  };
}

/**
 * End series (T-6): `recur_until` becomes the last date. Instances after it: unedited DRAFTs are deleted
 * (they can never have had registrations); edited DRAFTs and PUBLISHED sessions are kept, or the PUBLISHED ones
 * cancelled when asked. Closed and started instances, and instances on or before the last date, are untouched.
 */
export function planEndSeries(input: EndSeriesInput): EndSeriesPlan {
  assertRecurrenceRule({ ...input.rule, recurUntil: input.lastDate });

  const actions: ReconcileAction[] = [];
  for (const i of [...input.instances].sort((a, b) =>
    a.date < b.date ? -1 : a.date > b.date ? 1 : 0,
  )) {
    if (i.date <= input.lastDate || isClosed(i.status)) continue;
    if (i.startsAt.getTime() <= input.now.getTime()) continue;
    const base = { sessionId: i.id, date: i.date } as const;
    if (i.status === 'DRAFT') {
      actions.push(
        i.isInstanceOverridden
          ? { kind: 'keep_off_pattern', ...base, status: i.status }
          : { kind: 'delete', ...base },
      );
    } else {
      actions.push(
        input.alsoCancelPublished
          ? { kind: 'cancel', ...base }
          : { kind: 'keep_off_pattern', ...base, status: i.status },
      );
    }
  }

  const byId = new Map(input.instances.map((i) => [i.id, i]));
  const statusOf = (a: ReconcileAction): SessionStatus | undefined => byId.get(a.sessionId)?.status;
  return {
    recurUntil: input.lastDate,
    isActive: input.lastDate > input.today,
    actions,
    counts: {
      draftsToDelete: actions.filter((a) => a.kind === 'delete').length,
      publishedAfter: actions.filter((a) => statusOf(a) === 'PUBLISHED').length,
      editedDraftsKept: actions.filter(
        (a) => a.kind === 'keep_off_pattern' && statusOf(a) === 'DRAFT',
      ).length,
    },
  };
}
