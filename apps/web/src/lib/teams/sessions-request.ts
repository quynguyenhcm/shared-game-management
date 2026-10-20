import {
  CreateSeriesRequest,
  CreateSessionRequest,
  UpdateSeriesRequest,
  UpdateSessionRequest,
} from '@sgm/shared';
import type { z } from 'zod';
import type { FieldErrors } from '../auth/validation.ts';
import type {
  CreateSeriesBody,
  CreateSessionBody,
  UpdateSeriesBody,
  UpdateSessionBody,
} from '../api-client.ts';
import { FEE_OVER_LIMIT_MESSAGE, weekdayIndex } from './sessions-view.ts';

/**
 * Turns the posted form of the Sessions pages into the strict wire bodies of the API, and refuses with the
 * shared copy before anything is sent. Pure and free of Next, so the Server Actions stay thin and every field
 * rule is tested once. The body that is sent is the wire (input) form: money stays a string, because the
 * parsed `Money` the schemas output is a bigint and cannot be JSON. The schemas are used to validate only.
 */

export type Intent = 'draft' | 'publish' | 'save';

export type Parsed<T> = { ok: true; body: T } | { ok: false; fieldErrors: FieldErrors };

/** A posted text field, or undefined when it is missing or not text (a file part). */
export function formField(formData: FormData, name: string): string | undefined {
  const value = formData.get(name);
  return typeof value === 'string' ? value : undefined;
}

/** The submitter's intent, or the fallback for a form posted without one. Anything else is ignored. */
export function readIntent(formData: FormData, fallback: Intent): Intent {
  const value = formField(formData, 'intent');
  return value === 'draft' || value === 'publish' || value === 'save' ? value : fallback;
}

/** A whole number from a field; blank or missing is undefined (the schema's default or its error applies). */
function numberOf(formData: FormData, name: string): number | undefined {
  const value = formField(formData, name);
  return value === undefined || value.trim() === '' ? undefined : Number(value);
}

/** An optional amount: blank or missing is null (follow the suggestion, or no fee). */
function amountOf(formData: FormData, name: string): string | null {
  const value = formField(formData, name);
  return value === undefined || value.trim() === '' ? null : value;
}

const FEE_FIELDS = [
  'feeMale',
  'feeFemale',
  'feeOther',
  'feeBeginner',
  'feeIntermediate',
  'feeAdvanced',
] as const;

const COURT_KEY =
  /^courts\.(\d+)\.(identifier|startTime|endTime|startDisambiguation|endDisambiguation)$/;

/** The court rows in row order. Only a one-off keeps the DST "earlier" flags (a template has none). */
function courtsOf(formData: FormData, keepDisambiguation: boolean): Record<string, string>[] {
  const rows = new Map<number, Record<string, string>>();
  for (const [name, value] of formData.entries()) {
    const match = COURT_KEY.exec(name);
    if (match === null || typeof value !== 'string') continue;
    const field = match[2] as string;
    if (field.endsWith('Disambiguation') && (!keepDisambiguation || value !== 'earlier')) continue;
    const index = Number(match[1]);
    rows.set(index, { ...rows.get(index), [field]: value });
  }
  return [...rows].sort(([a], [b]) => a - b).map(([, row]) => row);
}

/** The fields a session and a series share: content, costing, pricing and the court rows. */
function contentOf(formData: FormData, keepDisambiguation: boolean): Record<string, unknown> {
  const body: Record<string, unknown> = {
    location: formField(formData, 'location'),
    address: formField(formData, 'address'),
    maxPlayers: numberOf(formData, 'maxPlayers'),
    pricingStructure: formField(formData, 'pricingStructure'),
    customPlayerRate: amountOf(formData, 'customPlayerRate'),
    courts: courtsOf(formData, keepDisambiguation),
  };
  const reservedSeats = numberOf(formData, 'reservedSeats');
  if (reservedSeats !== undefined) body.reservedSeats = reservedSeats;
  for (const name of ['courtCost', 'extraExpenses'] as const) {
    const value = formField(formData, name);
    if (value !== undefined) body[name] = value;
  }
  // Only the active model's fee inputs are posted; a posted blank is "no fee" (null).
  for (const name of FEE_FIELDS) {
    if (formData.has(name)) body[name] = amountOf(formData, name);
  }
  return body;
}

function sessionBodyOf(formData: FormData): Record<string, unknown> {
  const specific = formField(formData, 'deadlineMode') === 'specific';
  const disambiguation = formField(formData, 'deadlineDisambiguation');
  return {
    date: formField(formData, 'date'),
    ...contentOf(formData, true),
    cancellationDeadline: specific
      ? {
          date: formField(formData, 'deadlineDate'),
          time: formField(formData, 'deadlineTime'),
          ...(disambiguation === 'earlier' || disambiguation === 'later' ? { disambiguation } : {}),
        }
      : null,
  };
}

function seriesBodyOf(formData: FormData): Record<string, unknown> {
  const startsOn = formField(formData, 'startsOn');
  const recurUntil = formField(formData, 'recurUntil');
  const dayOfWeek = startsOn === undefined ? null : weekdayIndex(startsOn);
  return {
    frequency: formField(formData, 'frequency'),
    // The weekday is derived from the first date, so the two can never disagree.
    dayOfWeek: dayOfWeek ?? undefined,
    startsOn,
    monthlyWeek: numberOf(formData, 'monthlyWeek') ?? null,
    recurUntil: recurUntil === undefined || recurUntil.trim() === '' ? null : recurUntil,
    ...contentOf(formData, false),
  };
}

/** Zod issues as the `fieldErrors` the forms render, keyed by the dotted path (`courts.1.identifier`). */
function zodFieldErrors(error: z.ZodError): FieldErrors {
  const errors: FieldErrors = {};
  for (const issue of error.issues) {
    const key = issue.path.map(String).join('.') || 'form';
    const messages = errors[key] ?? [];
    if (!messages.includes(issue.message)) messages.push(issue.message);
    errors[key] = messages;
  }
  return errors;
}

function parse<T>(schema: z.ZodType, wire: Record<string, unknown>): Parsed<T> {
  const result = schema.safeParse(wire);
  if (result.success) return { ok: true, body: wire as T };
  const errors = zodFieldErrors(result.error);
  // The weekday has no field of its own: when the first date is the problem, that is the one message.
  if (errors.startsOn !== undefined) delete errors.dayOfWeek;
  return { ok: false, fieldErrors: errors };
}

export function parseCreateSession(formData: FormData): Parsed<CreateSessionBody> {
  return parse(CreateSessionRequest, {
    createKey: formField(formData, 'createKey'),
    ...sessionBodyOf(formData),
  });
}

export function parseUpdateSession(formData: FormData): Parsed<UpdateSessionBody> {
  return parse(UpdateSessionRequest, {
    expectedVersion: numberOf(formData, 'expectedVersion'),
    ...sessionBodyOf(formData),
  });
}

export function parseCreateSeries(formData: FormData): Parsed<CreateSeriesBody> {
  return parse(CreateSeriesRequest, {
    createKey: formField(formData, 'createKey'),
    ...seriesBodyOf(formData),
  });
}

export function parseUpdateSeries(formData: FormData): Parsed<UpdateSeriesBody> {
  return parse(UpdateSeriesRequest, {
    expectedVersion: numberOf(formData, 'expectedVersion'),
    ...seriesBodyOf(formData),
  });
}

const RAISED_TO_FIELD: Readonly<Record<string, string>> = {
  fee_flat: 'customPlayerRate',
  fee_male: 'feeMale',
  fee_female: 'feeFemale',
  fee_other: 'feeOther',
  fee_beginner: 'feeBeginner',
  fee_intermediate: 'feeIntermediate',
  fee_advanced: 'feeAdvanced',
};

/** `session_fee_locked` names snake_case columns; each becomes the fee-over-the-limit copy under its input. */
export function fieldErrorsFromRaised(raised: readonly string[]): FieldErrors {
  const errors: FieldErrors = {};
  for (const column of raised) {
    const field = RAISED_TO_FIELD[column];
    if (field !== undefined) errors[field] = [FEE_OVER_LIMIT_MESSAGE];
  }
  return errors;
}
