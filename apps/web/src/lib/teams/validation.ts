import { CreateTeamRequest, JoinRequestRequest } from '@sgm/shared';
import { z } from 'zod';
import type { FieldErrors } from '../auth/validation.ts';

type Values = Record<string, string | undefined>;

/** An unchosen radio group arrives as nothing or an empty string; both mean "not chosen". */
function chosen(value: string | undefined): string | undefined {
  return value === undefined || value === '' ? undefined : value;
}

function errorsOf(error: z.ZodError): FieldErrors {
  return z.flattenError(error).fieldErrors;
}

/**
 * Client-side checks for "Create team": the shared strict schema, so the web and the API show the same
 * messages. A missing key (a tampered form) surfaces as the schema's "Reload the page" message.
 */
export function validateCreateTeam(values: Values): FieldErrors {
  const result = CreateTeamRequest.safeParse({
    name: values.name ?? '',
    description: values.description ?? '',
    visibility: chosen(values.visibility),
    skillLevel: chosen(values.skillLevel),
    idempotencyKey: values.idempotencyKey,
  });
  return result.success ? {} : errorsOf(result.error);
}

/** "Request to join": the level is the only user input (AC-ERROR-2). */
export function validateJoinRequest(values: Values): FieldErrors {
  const result = JoinRequestRequest.pick({ skillLevel: true }).safeParse({
    skillLevel: chosen(values.skillLevel),
  });
  return result.success ? {} : errorsOf(result.error);
}
