/**
 * Request and response contracts for the sessions and series routes, shared by the Fastify routes and the web
 * api-client. Requests are strict, so a client can never set what the server owns (status, version, `fee_flat`,
 * the override flag, the derived instants). Validation messages are the copy deck of the UI/UX document and never
 * echo input. Responses are plain objects (a newer server may add fields an older client ignores).
 *
 * Decisions encoded here: memory-bank/creative/session-scheduling-engine-binding-reconciliation.md (P-3 fixed
 * pattern, T-5 series save counts, T-7 fee lock, T-10 DST options, T-12 `expectedVersion` and `createKey`) and the
 * recurrence algorithm doc (A5 costing, conflict 6 DST). Money crosses the wire as 2-dp strings and is parsed to
 * exact `Money`; amounts are never JS numbers.
 */
import { z } from 'zod';
import { isNegative, parseMoney, ZERO, type Money } from '../money/money.ts';
import { moneyStringSchema } from '../money/zod.ts';
import { isCourtWhollyInDstGap } from '../sessions/instance.ts';
import {
  RecurrenceRuleError,
  assertRecurrenceRule,
  type MonthlyWeek,
} from '../sessions/recurrence.ts';
import { parseLocalDate, parseLocalTime, type LocalDate, type LocalTime } from '../time/time.ts';
import { PricingType, RecurrenceFrequency, SessionStatus } from '../types/enums.ts';
import { ErrorResponse } from './errors.ts';

export const SESSION_LOCATION_MAX_LENGTH = 255;
export const SESSION_ADDRESS_MAX_LENGTH = 500;
export const COURT_IDENTIFIER_MAX_LENGTH = 50;
export const MAX_COURTS = 50;
export const MAX_PLAYERS_LIMIT = 1000;

/** `fieldErrors` entries that are codes the web maps to copy (they carry options or a series rule). */
export const SessionFieldCode = z.enum([
  'local_time_nonexistent',
  'local_time_ambiguous',
  'series_pattern_fixed',
]);
export type SessionFieldCode = z.infer<typeof SessionFieldCode>;

export const SESSION_FIELD_MESSAGES = {
  dateInvalid: 'Enter a valid date.',
  timeInvalid: 'Enter a time like 18:30.',
  locationRequired: 'Enter a location.',
  locationTooLong: 'Use 255 characters or fewer.',
  addressRequired: 'Enter an address.',
  addressTooLong: 'Use 500 characters or fewer.',
  maxPlayersInvalid: 'Enter a whole number of 1 or more.',
  reservedSeatsInvalid: 'Enter a whole number of 0 or more.',
  reservedAboveMax: "Reserved seats can't be more than max players.",
  amountFormat: 'Enter an amount like 12.00.',
  amountNegative: "Amount can't be negative.",
  courtNameRequired: 'Enter a court name.',
  courtNameTooLong: 'Use 50 characters or fewer.',
  courtNamesDuplicate: 'Court names must be different.',
  courtsRequired: 'Add at least one court.',
  courtEndBeforeStart: 'End must be after start.',
  templateCourtInDstGap:
    "A court that runs only between 2 and 3 am can't be set up as a series, because that hour is skipped when clocks go forward. Choose different times.",
  monthlyWeekInvalid: 'Choose which week of the month.',
  dayOfWeekInvalid: 'Choose a day of the week.',
  startsOnMismatch: 'Choose a first date that falls on the chosen day and week.',
  recurUntilBeforeStart: "The last date can't be before the first date.",
  shortenUseEndSeries: 'To stop the series sooner, use End series.',
  patternFixed: 'To change the day or how often it repeats, end this series and start a new one.',
  reloadAndRetry: 'Reload the page and try again.',
  datePast: "Choose today's date or a later one.",
  datePatternFixed: 'To move this night, cancel it and create a one-off session.',
  deadlineAfterStart: 'The deadline must be before the first court starts.',
} as const;

const M = SESSION_FIELD_MESSAGES;

// ---------------------------------------------------------------------------------------------
// Field building blocks
// ---------------------------------------------------------------------------------------------

/** A 0-2 dp amount at or above $0.00, parsed to exact `Money`. */
const amountInput = z.string({ error: M.amountFormat }).transform((raw, ctx): Money => {
  let parsed: Money;
  try {
    parsed = parseMoney(raw.trim());
  } catch {
    ctx.addIssue({ code: 'custom', message: M.amountFormat });
    return z.NEVER;
  }
  if (isNegative(parsed)) {
    ctx.addIssue({ code: 'custom', message: M.amountNegative });
    return z.NEVER;
  }
  return parsed;
});

/** Optional amount: omitted or null means unset. */
const optionalAmount = amountInput.nullable().default(null);

/** Court hire and extras: omitted or blank reads as $0.00 (a free session). */
const costAmount = z
  .string({ error: M.amountFormat })
  .transform((raw) => (raw.trim() === '' ? '0.00' : raw))
  .pipe(amountInput)
  .default(ZERO);

const localDateInput = z.string({ error: M.dateInvalid }).transform((raw, ctx): LocalDate => {
  try {
    return parseLocalDate(raw);
  } catch {
    ctx.addIssue({ code: 'custom', message: M.dateInvalid });
    return z.NEVER;
  }
});

/** `HH:MM` wall-clock time; only an end time may be the end-of-day marker 24:00. */
function timeInput(kind: 'start' | 'end') {
  return z.string({ error: M.timeInvalid }).transform((raw, ctx): LocalTime => {
    try {
      if (!/^\d{2}:\d{2}$/.test(raw)) throw new Error('shape');
      const time = parseLocalTime(raw);
      if (kind === 'start' && time === '24:00') throw new Error('start of day');
      return time;
    } catch {
      ctx.addIssue({ code: 'custom', message: M.timeInvalid });
      return z.NEVER;
    }
  });
}

const minutes = (time: LocalTime): number => {
  const [h, m] = time.split(':').map(Number) as [number, number];
  return h * 60 + m;
};

const expectedVersion = z
  .number({ error: M.reloadAndRetry })
  .int(M.reloadAndRetry)
  .min(1, M.reloadAndRetry);
const createKey = z.uuid({ error: M.reloadAndRetry });

const courtIdentifier = z
  .string({ error: M.courtNameRequired })
  .trim()
  .min(1, M.courtNameRequired)
  .max(COURT_IDENTIFIER_MAX_LENGTH, M.courtNameTooLong);

const noDuplicateCourtNames = (
  courts: readonly { identifier: string }[],
  ctx: { addIssue(issue: { code: 'custom'; message: string; path: (string | number)[] }): void },
): void => {
  const seen = new Set<string>();
  courts.forEach((court, index) => {
    if (seen.has(court.identifier)) {
      ctx.addIssue({ code: 'custom', message: M.courtNamesDuplicate, path: [index, 'identifier'] });
    }
    seen.add(court.identifier);
  });
};

/** A court on a one-off session. `*Disambiguation: 'earlier'` is transient (never stored): DST overlap only. */
export const CourtInput = z
  .strictObject({
    identifier: courtIdentifier,
    startTime: timeInput('start'),
    endTime: timeInput('end'),
    startDisambiguation: z.literal('earlier').optional(),
    endDisambiguation: z.literal('earlier').optional(),
  })
  .superRefine((court, ctx) => {
    if (minutes(court.endTime) <= minutes(court.startTime)) {
      ctx.addIssue({ code: 'custom', message: M.courtEndBeforeStart, path: ['endTime'] });
    }
  });

/** A court in a series template (always the derived, `compatible` policy; a gap time is normalised later). */
export const TemplateCourtInput = z
  .strictObject({
    identifier: courtIdentifier,
    startTime: timeInput('start'),
    endTime: timeInput('end'),
  })
  .superRefine((court, ctx) => {
    if (minutes(court.endTime) <= minutes(court.startTime)) {
      ctx.addIssue({ code: 'custom', message: M.courtEndBeforeStart, path: ['endTime'] });
    } else if (isCourtWhollyInDstGap(court)) {
      ctx.addIssue({ code: 'custom', message: M.templateCourtInDstGap, path: ['startTime'] });
    }
  });

const sessionCourts = z
  .array(CourtInput, { error: M.courtsRequired })
  .min(1, M.courtsRequired)
  .max(MAX_COURTS)
  .superRefine(noDuplicateCourtNames);
const templateCourts = z
  .array(TemplateCourtInput, { error: M.courtsRequired })
  .min(1, M.courtsRequired)
  .max(MAX_COURTS)
  .superRefine(noDuplicateCourtNames);

/** An explicit cancellation deadline, local to the app time zone; `null` elsewhere means "use the default". */
export const DeadlineInput = z.strictObject({
  date: localDateInput,
  time: timeInput('start'),
  disambiguation: z.enum(['earlier', 'later']).optional(),
});
export type DeadlineInput = z.infer<typeof DeadlineInput>;

/** Fields shared by a session and a series' defaults. The server owns `fee_flat` and the suggested rate. */
const contentShape = {
  location: z
    .string({ error: M.locationRequired })
    .trim()
    .min(1, M.locationRequired)
    .max(SESSION_LOCATION_MAX_LENGTH, M.locationTooLong),
  address: z
    .string({ error: M.addressRequired })
    .trim()
    .min(1, M.addressRequired)
    .max(SESSION_ADDRESS_MAX_LENGTH, M.addressTooLong),
  maxPlayers: z
    .number({ error: M.maxPlayersInvalid })
    .int(M.maxPlayersInvalid)
    .min(1, M.maxPlayersInvalid)
    .max(MAX_PLAYERS_LIMIT, M.maxPlayersInvalid),
  reservedSeats: z
    .number({ error: M.reservedSeatsInvalid })
    .int(M.reservedSeatsInvalid)
    .min(0, M.reservedSeatsInvalid)
    .default(0),
  courtCost: costAmount,
  extraExpenses: costAmount,
  /** null follows the suggested rate; a value pins the FLAT rate. */
  customPlayerRate: optionalAmount,
  pricingStructure: z.enum(PricingType),
  feeMale: optionalAmount,
  feeFemale: optionalAmount,
  feeOther: optionalAmount,
  feeBeginner: optionalAmount,
  feeIntermediate: optionalAmount,
  feeAdvanced: optionalAmount,
};

type Capacity = { maxPlayers: number; reservedSeats: number };
function reservedWithinMax<T extends z.ZodType<Capacity>>(schema: T): T {
  return schema.superRefine((value, ctx) => {
    if (value.reservedSeats > value.maxPlayers) {
      ctx.addIssue({ code: 'custom', message: M.reservedAboveMax, path: ['reservedSeats'] });
    }
  });
}

// ---------------------------------------------------------------------------------------------
// One-off sessions and session commands
// ---------------------------------------------------------------------------------------------

const sessionBody = {
  date: localDateInput,
  ...contentShape,
  /** `null` means the default (48 hours before the first court starts). */
  cancellationDeadline: DeadlineInput.nullable().default(null),
  courts: sessionCourts,
};

export const CreateSessionRequest = reservedWithinMax(
  z.strictObject({ createKey, ...sessionBody }),
);
export type CreateSessionRequest = z.infer<typeof CreateSessionRequest>;

export const UpdateSessionRequest = reservedWithinMax(
  z.strictObject({ expectedVersion, ...sessionBody }),
);
export type UpdateSessionRequest = z.infer<typeof UpdateSessionRequest>;

/** Publish and cancel: a status change, with the stale-save guard and nothing else. */
export const SessionCommandRequest = z.strictObject({ expectedVersion });
export type SessionCommandRequest = z.infer<typeof SessionCommandRequest>;

// ---------------------------------------------------------------------------------------------
// Series
// ---------------------------------------------------------------------------------------------

const monthlyWeek = z.union(
  [z.literal(1), z.literal(2), z.literal(3), z.literal(4), z.literal(-1)],
  { error: M.monthlyWeekInvalid },
);

const patternShape = {
  frequency: z.enum(RecurrenceFrequency),
  /** 0 = Sunday .. 6 = Saturday. */
  dayOfWeek: z
    .number({ error: M.dayOfWeekInvalid })
    .int(M.dayOfWeekInvalid)
    .min(0, M.dayOfWeekInvalid)
    .max(6, M.dayOfWeekInvalid),
  startsOn: localDateInput,
  monthlyWeek: monthlyWeek.nullable().default(null),
  recurUntil: localDateInput.nullable().default(null),
};

const RULE_FIELD_MESSAGES = {
  dayOfWeek: M.dayOfWeekInvalid,
  startsOn: M.startsOnMismatch,
  monthlyWeek: M.monthlyWeekInvalid,
  recurUntil: M.recurUntilBeforeStart,
} as const;

type SeriesChecked = Capacity & {
  frequency: (typeof RecurrenceFrequency)[number];
  dayOfWeek: number;
  startsOn: LocalDate;
  monthlyWeek: MonthlyWeek | null;
  recurUntil: LocalDate | null;
  pricingStructure: (typeof PricingType)[number];
  feeMale: Money | null;
  feeFemale: Money | null;
  feeBeginner: Money | null;
  feeIntermediate: Money | null;
  feeAdvanced: Money | null;
};

/** The rule must be consistent (A1-4), the capacity sane and the pricing complete, so every instance is publishable. */
function seriesChecks<T extends z.ZodType<SeriesChecked>>(schema: T): T {
  return reservedWithinMax(schema).superRefine((rule, ctx) => {
    try {
      assertRecurrenceRule(rule);
    } catch (error) {
      if (!(error instanceof RecurrenceRuleError)) throw error;
      ctx.addIssue({
        code: 'custom',
        message: RULE_FIELD_MESSAGES[error.field],
        path: [error.field],
      });
    }
    const required: [string, Money | null][] =
      rule.pricingStructure === 'BY_SEX'
        ? [
            ['feeMale', rule.feeMale],
            ['feeFemale', rule.feeFemale],
          ]
        : rule.pricingStructure === 'BY_SKILL_LEVEL'
          ? [
              ['feeBeginner', rule.feeBeginner],
              ['feeIntermediate', rule.feeIntermediate],
              ['feeAdvanced', rule.feeAdvanced],
            ]
          : [];
    for (const [field, value] of required) {
      if (value === null) ctx.addIssue({ code: 'custom', message: M.amountFormat, path: [field] });
    }
  });
}

const seriesBody = { ...patternShape, ...contentShape, courts: templateCourts };

export const CreateSeriesRequest = seriesChecks(z.strictObject({ createKey, ...seriesBody }));
export type CreateSeriesRequest = z.infer<typeof CreateSeriesRequest>;

/** The whole series form is posted on save; the pattern fields must equal the saved ones (`checkSeriesPatternFixed`). */
export const UpdateSeriesRequest = seriesChecks(z.strictObject({ expectedVersion, ...seriesBody }));
export type UpdateSeriesRequest = z.infer<typeof UpdateSeriesRequest>;

export const EndSeriesRequest = z.strictObject({
  expectedVersion,
  /** The last session date (inclusive); it becomes `recur_until`. */
  lastDate: localDateInput,
  /** "Also cancel the published sessions after this date." */
  alsoCancelPublished: z.boolean().default(false),
});
export type EndSeriesRequest = z.infer<typeof EndSeriesRequest>;

export interface SeriesPattern {
  readonly frequency: string;
  readonly dayOfWeek: number;
  readonly startsOn: string;
  readonly monthlyWeek: number | null;
  readonly recurUntil: string | null;
}

/**
 * A series' day, frequency, monthly week and first date are fixed after creation, and `recur_until` can only
 * be extended or cleared; shortening goes through End series (P-3, T-6, AC-ERROR-12). Returns `fieldErrors`
 * (empty when the save is allowed).
 */
export function checkSeriesPatternFixed(
  saved: SeriesPattern,
  next: SeriesPattern,
): Record<string, string[]> {
  const errors: Record<string, string[]> = {};
  for (const field of ['frequency', 'dayOfWeek', 'startsOn', 'monthlyWeek'] as const) {
    if (saved[field] !== next[field]) errors[field] = [SessionFieldCode.enum.series_pattern_fixed];
  }
  const shortened =
    next.recurUntil !== null && (saved.recurUntil === null || next.recurUntil < saved.recurUntil);
  if (shortened) errors.recurUntil = [M.shortenUseEndSeries];
  return errors;
}

// ---------------------------------------------------------------------------------------------
// Responses
// ---------------------------------------------------------------------------------------------

const isoInstant = z.iso.datetime();
const nullableMoney = moneyStringSchema.nullable();
const count = z.number().int().min(0);

export const SessionPhase = z.enum(['upcoming', 'started', 'ended']);
export const FeesLocked = z.enum(['none', 'raise_only_blocked']);
/** Why a DRAFT is a draft: a refused banking gate (series), an admin edit of a series date, or the admin's own draft. */
export const DraftReason = z.enum(['banking', 'edited', 'admin']);
export type DraftReason = z.infer<typeof DraftReason>;

export const SESSION_LIST_VIEWS = ['upcoming', 'drafts', 'past'] as const;
export const SESSION_LIST_DEFAULT_LIMIT = 25;
export const SESSION_LIST_MAX_LIMIT = 100;

export const SessionIdParams = z.object({ teamId: z.uuid(), sessionId: z.uuid() });
export type SessionIdParams = z.infer<typeof SessionIdParams>;

export const SeriesIdParams = z.object({ teamId: z.uuid(), ruleId: z.uuid() });
export type SeriesIdParams = z.infer<typeof SeriesIdParams>;

/** `GET /teams/:teamId/sessions`: one section of the admin list, keyset-paged (soonest first, past most recent first). */
export const ListSessionsQuery = z.strictObject({
  view: z.enum(SESSION_LIST_VIEWS),
  limit: z.coerce
    .number()
    .int()
    .min(1)
    .max(SESSION_LIST_MAX_LIMIT)
    .default(SESSION_LIST_DEFAULT_LIMIT),
  cursor: z.string().min(1).max(300).optional(),
});
export type ListSessionsQuery = z.infer<typeof ListSessionsQuery>;

export const SessionCourtResponse = z.object({
  id: z.uuid(),
  identifier: z.string(),
  startTime: z.string(),
  endTime: z.string(),
});

export const SessionResponse = z.object({
  id: z.uuid(),
  teamId: z.uuid(),
  recurringRuleId: z.uuid().nullable(),
  status: z.enum(SessionStatus),
  /** From the API clock, so every reader labels Started and Ended the same way (T-11). */
  phase: SessionPhase,
  date: z.string(),
  location: z.string(),
  address: z.string(),
  maxPlayers: z.number().int(),
  reservedSeats: z.number().int(),
  courtCost: moneyStringSchema,
  extraExpenses: moneyStringSchema,
  calculatedRatePerPlayer: nullableMoney,
  customPlayerRate: nullableMoney,
  pricingStructure: z.enum(PricingType),
  feeFlat: nullableMoney,
  feeMale: nullableMoney,
  feeFemale: nullableMoney,
  feeOther: nullableMoney,
  feeBeginner: nullableMoney,
  feeIntermediate: nullableMoney,
  feeAdvanced: nullableMoney,
  startsAt: isoInstant.nullable(),
  /** Latest court end; null while the session has no court. */
  endsAt: isoInstant.nullable(),
  cancellationDeadline: isoInstant.nullable(),
  deadlineIsDefault: z.boolean(),
  isInstanceOverridden: z.boolean(),
  /** Set only on a DRAFT. */
  draftReason: DraftReason.nullable(),
  /** Derived from the series rule (`seriesName`); null for a one-off session. */
  seriesName: z.string().nullable(),
  version: z.number().int().min(1),
  activeRegistrationCount: count,
  feesLocked: FeesLocked,
  courts: z.array(SessionCourtResponse),
});
export type SessionResponse = z.infer<typeof SessionResponse>;

export const SessionDetailResponse = z.object({ session: SessionResponse });
export type SessionDetailResponse = z.infer<typeof SessionDetailResponse>;

/**
 * An edit, a create or a publish. `promoted` is how many players the allocator moved off the waitlist because a
 * capacity edit raised public capacity (C-SSE-3); `material` says whether a field players care about changed
 * (date, earliest start, latest end, location, address, deadline or fees), so the admin is told to let them know.
 */
export const SessionWriteResponse = z.object({
  session: SessionResponse,
  promoted: count,
  material: z.boolean(),
});
export type SessionWriteResponse = z.infer<typeof SessionWriteResponse>;

export const SessionListResponse = z.object({
  sessions: z.array(SessionResponse),
  /** Keyset cursor for the next page, or null at the end. */
  nextCursor: z.string().nullable(),
  isPayoutConfigured: z.boolean(),
});
export type SessionListResponse = z.infer<typeof SessionListResponse>;

/** Cancelling leaves registrations alone, so the admin is told how many players to let know (P-2). */
export const CancelSessionResponse = z.object({
  session: SessionResponse,
  activeRegistrationCount: count,
});
export type CancelSessionResponse = z.infer<typeof CancelSessionResponse>;

export const SeriesCourtResponse = z.object({
  identifier: z.string(),
  startTime: z.string(),
  endTime: z.string(),
});

/** What a series save would do to one existing instance (UI/UX assumption 5; there is no `needs_banking`). */
export const SeriesChangeEffectValue = z.enum([
  'will_update',
  'edited',
  'closed',
  'has_registrations',
]);

/** One of the series' dates as the series page lists it: from today forward plus any DRAFT. */
export const SeriesInstanceResponse = z.object({
  id: z.uuid(),
  date: z.string(),
  startsAt: isoInstant.nullable(),
  endsAt: isoInstant.nullable(),
  status: z.enum(SessionStatus),
  phase: SessionPhase,
  draftReason: DraftReason.nullable(),
  isInstanceOverridden: z.boolean(),
  activeRegistrationCount: count,
  version: z.number().int().min(1),
  seriesChangeEffect: SeriesChangeEffectValue,
});
export type SeriesInstanceResponse = z.infer<typeof SeriesInstanceResponse>;

export const SeriesResponse = z.object({
  id: z.uuid(),
  teamId: z.uuid(),
  /** Derived from the pattern and location (`seriesName`), not stored. */
  name: z.string(),
  frequency: z.enum(RecurrenceFrequency),
  dayOfWeek: z.number().int(),
  startsOn: z.string(),
  monthlyWeek: z.number().int().nullable(),
  recurUntil: z.string().nullable(),
  isActive: z.boolean(),
  version: z.number().int().min(1),
  /** True while the last per-rule run trails `version` ("We're adding the sessions…"). */
  materialising: z.boolean(),
  /** How many days ahead the materialiser adds sessions (`RECURRENCE_HORIZON_DAYS`, 7-91): the web never keeps its own copy. */
  horizonDays: z.number().int().min(7).max(91),
  location: z.string(),
  address: z.string(),
  maxPlayers: z.number().int(),
  reservedSeats: z.number().int(),
  courtCost: moneyStringSchema,
  extraExpenses: moneyStringSchema,
  calculatedRatePerPlayer: nullableMoney,
  customPlayerRate: nullableMoney,
  pricingStructure: z.enum(PricingType),
  feeFlat: nullableMoney,
  feeMale: nullableMoney,
  feeFemale: nullableMoney,
  feeOther: nullableMoney,
  feeBeginner: nullableMoney,
  feeIntermediate: nullableMoney,
  feeAdvanced: nullableMoney,
  courts: z.array(SeriesCourtResponse),
  isPayoutConfigured: z.boolean(),
  /** The rule's DRAFT instances the materialiser could not publish (banking). */
  bankingDrafts: count,
  /** The rule's DRAFT instances the admin edited. */
  editedDrafts: count,
  /** Sessions from NZ-today forward plus any DRAFT, soonest first, at most 100. */
  instances: z.array(SeriesInstanceResponse),
});
export type SeriesResponse = z.infer<typeof SeriesResponse>;

/** One row of the Sessions page's Series section: enough to name, status and link a series without loading its dates. */
export const SeriesListItem = z.object({
  id: z.uuid(),
  /** Derived from the pattern and location (`seriesName`), not stored. */
  name: z.string(),
  startsOn: z.string(),
  recurUntil: z.string().nullable(),
  isActive: z.boolean(),
  version: z.number().int().min(1),
  /** True while the last per-rule run trails `version` ("Adding sessions…"). */
  materialising: z.boolean(),
});
export type SeriesListItem = z.infer<typeof SeriesListItem>;

/** The team's series, active ones first; `horizonDays` is the materialisation horizon (see `SeriesResponse`). */
export const SeriesListResponse = z.object({
  series: z.array(SeriesListItem),
  horizonDays: z.number().int().min(7).max(91),
});
export type SeriesListResponse = z.infer<typeof SeriesListResponse>;

/** Read or create a series. */
export const SeriesDetailResponse = z.object({ series: SeriesResponse });
export type SeriesDetailResponse = z.infer<typeof SeriesDetailResponse>;

/** "Publish drafts now": `queued` is false when a run for this series was already waiting (it will read the latest rule). */
export const PublishDraftsResponse = z.object({ series: SeriesResponse, queued: z.boolean() });
export type PublishDraftsResponse = z.infer<typeof PublishDraftsResponse>;

/** The counts of a series save (T-5), from `summariseReconciliation`. */
export const SeriesSaveOutcome = z.object({
  updated: count,
  unchanged: count,
  skipped: z.object({
    edited: count,
    started: count,
    closed: count,
    deadlinePassed: count,
    feeLocked: count,
  }),
});

export const SeriesSaveResponse = z.object({ series: SeriesResponse, outcome: SeriesSaveOutcome });
export type SeriesSaveResponse = z.infer<typeof SeriesSaveResponse>;

export const EndSeriesResponse = z.object({
  series: SeriesResponse,
  removedDrafts: count,
  cancelledPublished: count,
  keptOffPattern: z.array(
    z.object({ sessionId: z.uuid(), date: z.string(), status: z.enum(SessionStatus) }),
  ),
  /** Players still registered on the sessions that were cancelled (P-2). */
  activeRegistrationCount: count,
});
export type EndSeriesResponse = z.infer<typeof EndSeriesResponse>;

// ---------------------------------------------------------------------------------------------
// Error envelope extras
// ---------------------------------------------------------------------------------------------

export const DstOptionChoice = z.enum(['shiftedForward', 'shiftedBackward', 'earlier', 'later']);

/** A wall-clock input that does not exist or happens twice, with what can be stored instead (T-10). */
export const DstOptionsEntry = z.object({
  field: z.string(),
  date: z.string(),
  time: z.string(),
  kind: z.enum(['nonexistent', 'ambiguous']),
  options: z.array(
    z.object({ choice: DstOptionChoice, localTime: z.string(), instant: isoInstant }),
  ),
});
export type DstOptionsEntry = z.infer<typeof DstOptionsEntry>;

/**
 * The shared error body plus what only session routes add: `dstOptions` on a 422, `raisedFields` on a
 * `session_fee_locked` 409, and the `current` row on a stale-save 409.
 */
export const SessionErrorResponse = z.object({
  error: ErrorResponse.shape.error.extend({
    dstOptions: z.array(DstOptionsEntry).optional(),
    raisedFields: z.array(z.string()).optional(),
    current: z.union([SessionResponse, SeriesResponse]).optional(),
  }),
});
export type SessionErrorResponse = z.infer<typeof SessionErrorResponse>;
