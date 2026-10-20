/**
 * The pure rules of a one-off session write (architecture SA-6; recurrence algorithm A5, conflicts 6 and 10; binding
 * T-7..T-10). No database, no clock: the service feeds it the request and the stored row and gets back what to
 * write, what changed and whether it matters to registered players. Money is `Money` and `MoneyString` only.
 */
import {
  DST_POLICY,
  SESSION_FIELD_MESSAGES,
  SessionFieldCode,
  defaultCancellationDeadline,
  defaultFeeOther,
  finalFlatRate,
  instantToLocal,
  localToInstant,
  parseLocalTime,
  parseMoney,
  resolveLocal,
  suggestedRate,
  toMoneyString,
  type CreateSessionRequest,
  type DeadlineInput,
  type DstOptionsEntry,
  type LocalDate,
  type LocalTime,
  type Money,
  type MoneyString,
  type PricingType,
  type SessionFees,
} from '@sgm/shared';

const M = SESSION_FIELD_MESSAGES;

export interface StoredCourt {
  readonly identifier: string;
  /** `HH:MM`, or `24:00` for an end at midnight. */
  readonly startTime: string;
  readonly endTime: string;
}

/** `HH:MM:SS` (PostgreSQL `time`) to `HH:MM`; `24:00:00` to `24:00`. */
export function trimTime(time: string): string {
  return time.slice(0, 5);
}

const courtNameOrder = new Intl.Collator('en', { numeric: true });

/** Court names in the order an admin reads them: "Court 2" before "Court 10". */
export function sortCourts<T extends { readonly identifier: string }>(courts: readonly T[]): T[] {
  return [...courts].sort((a, b) => courtNameOrder.compare(a.identifier, b.identifier));
}

// ---------------------------------------------------------------------------------------------
// Times: DST-safe court and deadline resolution (T-10)
// ---------------------------------------------------------------------------------------------

export type CourtRequest = CreateSessionRequest['courts'][number];

export interface ResolvedDeadline {
  readonly kind: 'default' | 'explicit';
  readonly instant: Date;
}

export type TimeResolution =
  | {
      readonly ok: true;
      readonly courts: StoredCourt[];
      readonly startsAt: Date;
      readonly endsAt: Date;
      readonly deadline: ResolvedDeadline;
    }
  | {
      readonly ok: false;
      readonly fieldErrors: Record<string, string[]>;
      readonly dstOptions: DstOptionsEntry[];
    };

type Collector = { fieldErrors: Record<string, string[]>; dstOptions: DstOptionsEntry[] };

const localTimeOf = (instant: Date): string => instantToLocal(instant).time;

/**
 * One admin-entered wall time (`DST_POLICY.USER_INPUT` = reject): a real time resolves; a gap time is refused with both
 * real neighbours; an overlap time is refused unless the caller accepts a choice. `accept` lists the disambiguations the
 * field can store: a court time can only be the earlier one (`compatible`), a deadline either, since it is an instant.
 */
function resolveEntered(
  field: string,
  date: LocalDate,
  time: LocalTime,
  chosen: 'earlier' | 'later' | undefined,
  offered: readonly ('earlier' | 'later')[],
  into: Collector,
): Date | undefined {
  const resolution = resolveLocal(date, time);
  if (resolution.kind === 'unique') return resolution.instant;
  if (resolution.kind === 'ambiguous') {
    if (chosen !== undefined && offered.includes(chosen)) return resolution[chosen];
    into.fieldErrors[field] = [SessionFieldCode.enum.local_time_ambiguous];
    into.dstOptions.push({
      field,
      date,
      time,
      kind: 'ambiguous',
      options: offered.map((choice) => ({
        choice,
        localTime: localTimeOf(resolution[choice]),
        instant: resolution[choice].toISOString(),
      })),
    });
    return undefined;
  }
  into.fieldErrors[field] = [SessionFieldCode.enum.local_time_nonexistent];
  into.dstOptions.push({
    field,
    date,
    time,
    kind: 'nonexistent',
    options: [
      {
        choice: 'shiftedForward',
        localTime: localTimeOf(resolution.shiftedForward),
        instant: resolution.shiftedForward.toISOString(),
      },
      {
        choice: 'shiftedBackward',
        localTime: localTimeOf(resolution.shiftedBackward),
        instant: resolution.shiftedBackward.toISOString(),
      },
    ],
  });
  return undefined;
}

/**
 * Resolves a session's courts and cancellation deadline against its date. Field keys follow the request
 * (`courts.<i>.startTime`, `cancellationDeadline`), so the form can put each message and each DST choice beside its input.
 */
export function resolveSessionTimes(input: {
  readonly date: LocalDate;
  readonly courts: readonly CourtRequest[];
  readonly cancellationDeadline: DeadlineInput | null;
}): TimeResolution {
  const errors: Collector = { fieldErrors: {}, dstOptions: [] };
  const starts: Date[] = [];
  const ends: Date[] = [];

  input.courts.forEach((court, index) => {
    const start = resolveEntered(
      `courts.${index}.startTime`,
      input.date,
      court.startTime,
      court.startDisambiguation,
      ['earlier'],
      errors,
    );
    if (start !== undefined) starts.push(start);
    // An end at 24:00 is the next midnight, which always exists.
    const end =
      court.endTime === '24:00'
        ? localToInstant(input.date, court.endTime, DST_POLICY.DERIVED)
        : resolveEntered(
            `courts.${index}.endTime`,
            input.date,
            court.endTime,
            court.endDisambiguation,
            ['earlier'],
            errors,
          );
    if (end !== undefined) ends.push(end);
  });

  const startsAt = starts.reduce<Date | undefined>(
    (first, next) => (first === undefined || next < first ? next : first),
    undefined,
  );
  const endsAt = ends.reduce<Date | undefined>(
    (last, next) => (last === undefined || next > last ? next : last),
    undefined,
  );

  let deadline: ResolvedDeadline | undefined;
  if (input.cancellationDeadline === null) {
    if (startsAt !== undefined) {
      deadline = { kind: 'default', instant: defaultCancellationDeadline(startsAt) };
    }
  } else {
    const given = input.cancellationDeadline;
    const instant = resolveEntered(
      'cancellationDeadline',
      given.date,
      given.time,
      given.disambiguation,
      ['earlier', 'later'],
      errors,
    );
    if (instant !== undefined) {
      if (startsAt !== undefined && instant > startsAt) {
        errors.fieldErrors.cancellationDeadline = [M.deadlineAfterStart];
      } else {
        deadline = { kind: 'explicit', instant };
      }
    }
  }

  if (
    Object.keys(errors.fieldErrors).length > 0 ||
    startsAt === undefined ||
    endsAt === undefined ||
    deadline === undefined
  ) {
    return { ok: false, fieldErrors: errors.fieldErrors, dstOptions: errors.dstOptions };
  }
  return {
    ok: true,
    courts: sortCourts(
      input.courts.map((court) => ({
        identifier: court.identifier,
        startTime: court.startTime,
        endTime: court.endTime,
      })),
    ),
    startsAt,
    endsAt,
    deadline,
  };
}

/**
 * The earliest court start on `date`, resolved as the database trigger does (`compatible`). Used to prove that no
 * intermediate state of a court rewrite can put an explicit deadline after the start.
 */
export function firstStartOn(date: LocalDate, courts: readonly StoredCourt[]): Date | undefined {
  return courts
    .map((court) => localToInstant(date, parseLocalTime(court.startTime), DST_POLICY.DERIVED))
    .reduce<Date | undefined>(
      (first, next) => (first === undefined || next < first ? next : first),
      undefined,
    );
}

// ---------------------------------------------------------------------------------------------
// Fees (A5, T-9)
// ---------------------------------------------------------------------------------------------

/** What the costing and fee columns of a session hold, as the database stores them. */
export interface FeeColumns {
  readonly totalCourtCost: MoneyString;
  readonly extraExpenses: MoneyString;
  readonly calculatedRatePerPlayer: MoneyString;
  readonly customPlayerRate: MoneyString | null;
  readonly pricingStructure: PricingType;
  readonly feeFlat: MoneyString | null;
  readonly feeMale: MoneyString | null;
  readonly feeFemale: MoneyString | null;
  readonly feeOther: MoneyString | null;
  readonly feeBeginner: MoneyString | null;
  readonly feeIntermediate: MoneyString | null;
  readonly feeAdvanced: MoneyString | null;
}

export interface FeeInput {
  readonly pricingStructure: PricingType;
  readonly courtCost: Money;
  readonly extraExpenses: Money;
  readonly maxPlayers: number;
  readonly customPlayerRate: Money | null;
  readonly feeMale: Money | null;
  readonly feeFemale: Money | null;
  readonly feeOther: Money | null;
  readonly feeBeginner: Money | null;
  readonly feeIntermediate: Money | null;
  readonly feeAdvanced: Money | null;
}

const asString = (value: Money | null): MoneyString | null =>
  value === null ? null : toMoneyString(value);

export type FeeResult =
  | { readonly ok: true; readonly fees: FeeColumns }
  | { readonly ok: false; readonly fieldErrors: Record<string, string[]> };

/**
 * The fee columns a save writes. The suggestion is always stored; FLAT's `fee_flat` is the final rate (a typed pin, else
 * the suggestion); the columns of the other models are NULL. BY_SEX needs male and female (the database requires all
 * three), `fee_other` defaulting to the lower of the two unless the stored row was already BY_SEX with a saved value.
 * BY_SKILL_LEVEL may be incomplete on a draft: publishing checks it.
 */
export function computeFeeColumns(
  input: FeeInput,
  stored: { readonly pricingStructure: PricingType; readonly feeOther: MoneyString | null } | null,
): FeeResult {
  const calculated = suggestedRate(input.courtCost, input.extraExpenses, input.maxPlayers);
  const common = {
    totalCourtCost: toMoneyString(input.courtCost),
    extraExpenses: toMoneyString(input.extraExpenses),
    calculatedRatePerPlayer: toMoneyString(calculated),
    pricingStructure: input.pricingStructure,
  };
  const none = {
    customPlayerRate: null,
    feeFlat: null,
    feeMale: null,
    feeFemale: null,
    feeOther: null,
    feeBeginner: null,
    feeIntermediate: null,
    feeAdvanced: null,
  } as const;

  switch (input.pricingStructure) {
    case 'FLAT':
      return {
        ok: true,
        fees: {
          ...common,
          ...none,
          customPlayerRate: asString(input.customPlayerRate),
          feeFlat: toMoneyString(finalFlatRate(input.customPlayerRate, calculated)),
        },
      };
    case 'BY_SEX': {
      const fieldErrors: Record<string, string[]> = {};
      if (input.feeMale === null) fieldErrors.feeMale = [M.amountFormat];
      if (input.feeFemale === null) fieldErrors.feeFemale = [M.amountFormat];
      if (input.feeMale === null || input.feeFemale === null) return { ok: false, fieldErrors };
      const other = defaultFeeOther({
        feeMale: input.feeMale,
        feeFemale: input.feeFemale,
        feeOther: input.feeOther,
        storedFeeOther:
          stored?.feeOther === null || stored === null ? null : parseMoney(stored.feeOther),
        wasBySex: stored?.pricingStructure === 'BY_SEX',
      });
      return {
        ok: true,
        fees: {
          ...common,
          ...none,
          feeMale: toMoneyString(input.feeMale),
          feeFemale: toMoneyString(input.feeFemale),
          feeOther: toMoneyString(other),
        },
      };
    }
    case 'BY_SKILL_LEVEL':
      return {
        ok: true,
        fees: {
          ...common,
          ...none,
          feeBeginner: asString(input.feeBeginner),
          feeIntermediate: asString(input.feeIntermediate),
          feeAdvanced: asString(input.feeAdvanced),
        },
      };
  }
}

const moneyOrNull = (value: MoneyString | null): Money | null =>
  value === null ? null : parseMoney(value);

/** The fee columns as exact money, for the fee-lock comparison (`feeRaised`). */
export function sessionFeesOf(fees: FeeColumns): SessionFees {
  return {
    pricingStructure: fees.pricingStructure,
    feeFlat: moneyOrNull(fees.feeFlat),
    feeMale: moneyOrNull(fees.feeMale),
    feeFemale: moneyOrNull(fees.feeFemale),
    feeOther: moneyOrNull(fees.feeOther),
    feeBeginner: moneyOrNull(fees.feeBeginner),
    feeIntermediate: moneyOrNull(fees.feeIntermediate),
    feeAdvanced: moneyOrNull(fees.feeAdvanced),
  };
}

// ---------------------------------------------------------------------------------------------
// What changed (SA-6 no-op rule, AC-HAPPY-13 material change)
// ---------------------------------------------------------------------------------------------

/** The editable content of a session in the one representation the stored row and a request are compared in. */
export interface SessionContent {
  readonly date: string;
  readonly location: string;
  readonly address: string;
  readonly maxPlayers: number;
  readonly reservedSeats: number;
  readonly fees: FeeColumns;
  readonly deadline: { readonly isDefault: boolean; readonly instant: Date };
  /** Sorted by `sortCourts`. */
  readonly courts: readonly StoredCourt[];
}

export interface ContentChange {
  /** Field groups that differ, in a stable order: for the log line and the no-op decision. */
  readonly changed: string[];
  /** Date, earliest start, latest end, location, address, deadline or fees: what players need to be told. */
  readonly material: boolean;
}

const FEE_FIELDS = [
  'pricingStructure',
  'feeFlat',
  'feeMale',
  'feeFemale',
  'feeOther',
  'feeBeginner',
  'feeIntermediate',
  'feeAdvanced',
] as const;

const sameCourts = (a: readonly StoredCourt[], b: readonly StoredCourt[]): boolean =>
  a.length === b.length &&
  a.every(
    (court, index) =>
      court.identifier === b[index]?.identifier &&
      court.startTime === b[index]?.startTime &&
      court.endTime === b[index]?.endTime,
  );

/** Earliest start and latest end by wall clock, `24:00` sorting after every real time. */
function courtRange(courts: readonly StoredCourt[]): { first: string; last: string } {
  return {
    first: courts.reduce(
      (first, court) => (court.startTime < first ? court.startTime : first),
      '99:99',
    ),
    last: courts.reduce((last, court) => (court.endTime > last ? court.endTime : last), '00:00'),
  };
}

export function contentChange(before: SessionContent, after: SessionContent): ContentChange {
  const changed: string[] = [];
  const when = (condition: boolean, field: string): boolean => {
    if (condition) changed.push(field);
    return condition;
  };
  const dateMoved = when(before.date !== after.date, 'date');
  const locationMoved = when(before.location !== after.location, 'location');
  const addressMoved = when(before.address !== after.address, 'address');
  when(before.maxPlayers !== after.maxPlayers, 'maxPlayers');
  when(before.reservedSeats !== after.reservedSeats, 'reservedSeats');
  when(before.fees.totalCourtCost !== after.fees.totalCourtCost, 'courtCost');
  when(before.fees.extraExpenses !== after.fees.extraExpenses, 'extraExpenses');
  when(
    before.fees.calculatedRatePerPlayer !== after.fees.calculatedRatePerPlayer,
    'calculatedRate',
  );
  when(before.fees.customPlayerRate !== after.fees.customPlayerRate, 'customRate');
  const feesMoved = when(
    FEE_FIELDS.some((field) => before.fees[field] !== after.fees[field]),
    'fees',
  );
  const deadlineMoved = before.deadline.instant.getTime() !== after.deadline.instant.getTime();
  when(
    deadlineMoved || before.deadline.isDefault !== after.deadline.isDefault,
    'cancellationDeadline',
  );
  const courtsMoved = when(!sameCourts(before.courts, after.courts), 'courts');

  const rangeMoved =
    courtsMoved &&
    (courtRange(before.courts).first !== courtRange(after.courts).first ||
      courtRange(before.courts).last !== courtRange(after.courts).last);
  return {
    changed,
    material:
      dateMoved || locationMoved || addressMoved || feesMoved || deadlineMoved || rangeMoved,
  };
}

/** Public capacity: seats players can take (host seats are not offered). */
export const publicCapacity = (
  content: Pick<SessionContent, 'maxPlayers' | 'reservedSeats'>,
): number => content.maxPlayers - content.reservedSeats;
