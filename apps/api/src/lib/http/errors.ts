import type { FastifyError, FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { hasZodFastifySchemaValidationErrors } from 'fastify-type-provider-zod';
import type {
  DstOptionsEntry,
  ErrorCode,
  ErrorResponse,
  SeriesResponse,
  SessionErrorResponse,
  SessionResponse,
} from '@sgm/shared';

interface ErrorDefault {
  readonly status: number;
  /** Safe, user-presentable text. Never echoes input. */
  readonly message: string;
}

/** Status and default message per `ErrorCode` (architecture doc, "Shared HTTP error shape"). */
export const ERROR_DEFAULTS: Readonly<Record<ErrorCode, ErrorDefault>> = {
  validation_failed: { status: 422, message: 'Check the highlighted fields and try again.' },
  unauthenticated: { status: 401, message: 'Sign in to continue.' },
  session_expired: { status: 401, message: 'Your session has expired. Sign in again.' },
  forbidden: { status: 403, message: 'You do not have permission to do that.' },
  cross_origin_request: { status: 403, message: 'This request was refused.' },
  not_found: { status: 404, message: 'Not found.' },
  conflict: { status: 409, message: 'That conflicts with existing data.' },
  internal_error: { status: 500, message: 'Something went wrong on our side. Try again.' },
  service_unavailable: {
    status: 503,
    message: 'The service is temporarily unavailable. Try again shortly.',
  },
  email_taken: { status: 409, message: 'An account with this email already exists.' },
  invalid_credentials: { status: 401, message: 'Incorrect email or password.' },
  too_many_attempts: { status: 429, message: 'Too many sign-in attempts. Try again later.' },
  too_many_requests: { status: 429, message: 'Too many requests. Try again later.' },
  invalid_or_expired_token: { status: 400, message: 'This link is invalid or has expired.' },
  provider_not_enabled: { status: 404, message: 'That sign-in provider is not available.' },
  provider_unavailable: { status: 502, message: 'The sign-in provider is unavailable right now.' },
  oauth_state_invalid: { status: 400, message: 'We could not verify that sign-in attempt.' },
  oauth_cancelled: { status: 400, message: 'The sign-in was cancelled.' },
  oauth_email_missing: { status: 422, message: 'The provider did not share an email address.' },
  oauth_email_unverified: {
    status: 422,
    message: 'The provider says this email address is not verified.',
  },
  oauth_account_exists: {
    status: 409,
    message: 'An account already exists for this email address.',
  },
  signup_expired: { status: 400, message: 'Your sign-up session expired. Please start again.' },
  identity_in_use: {
    status: 409,
    message: 'That account is already connected to a different account.',
  },
  provider_already_connected: {
    status: 409,
    message: 'Your account already has a sign-in for that provider.',
  },
  link_session_mismatch: {
    status: 403,
    message: 'This connection attempt belongs to another session.',
  },
  last_sign_in_method: { status: 409, message: 'You need at least one way to sign in.' },
  invite_invalid: {
    status: 404,
    message: 'This invite link is no longer valid. Ask a team admin for a new one.',
  },
  already_requested: {
    status: 409,
    message: "You've already asked to join this team. A team admin will review it.",
  },
  already_member: { status: 409, message: "You're already a member of this team." },
  banned_from_team: { status: 403, message: "You can't join this team." },
  team_admin_cannot_be_banned: {
    status: 409,
    message: 'Remove admin rights from this member before banning them.',
  },
  last_team_admin: {
    status: 409,
    message: 'A team needs at least one admin. Make another member an admin first.',
  },
  membership_state_conflict: {
    status: 409,
    message: 'Someone else already handled this request. The list has been refreshed.',
  },
  payout_not_configured: {
    status: 409,
    message: "Add your team's bank account details before publishing a paid session.",
  },
  banking_in_use: {
    status: 409,
    message:
      'Cancel or complete your published paid sessions, and wait for unpaid payments to be settled, before removing the banking details.',
  },
  skill_level_stale: {
    status: 409,
    message: "This member's level changed since you opened the panel. Check it and save again.",
  },
  auto_enroll_stale: {
    status: 409,
    message:
      "This member's Auto Enroll changed since you opened the panel. Check it and save again.",
  },
  session_stale: {
    status: 409,
    message: 'This session changed since you opened it. Review the latest version and save again.',
  },
  series_stale: {
    status: 409,
    message: 'This series changed since you opened it. Review the latest version and save again.',
  },
  series_ended: {
    status: 409,
    message: 'This series has ended. To run it again, create a new series.',
  },
  session_started: {
    status: 409,
    message: "This session has started, so it can't be changed or cancelled.",
  },
  session_not_editable: { status: 409, message: "This session can't be changed any more." },
  session_state_conflict: {
    status: 409,
    message: 'This session was already published or cancelled. The page has been refreshed.',
  },
  session_fee_locked: {
    status: 409,
    message:
      'Fees can only be lowered: a player has registered or still owes a late-withdrawal fee.',
  },
  overdue_payments: {
    status: 403,
    message: 'You have overdue payments. Pay them before registering for more sessions.',
  },
  session_not_open: {
    status: 409,
    message: "This session isn't open for registration.",
  },
  already_registered: { status: 409, message: "You're already registered for this session." },
  not_registered: { status: 409, message: "You're not registered for this session." },
  party_exceeds_capacity: {
    status: 422,
    message: "Your group is bigger than this session's places, so it can never fit.",
  },
  late_withdrawal_fee_due: {
    status: 409,
    message:
      "You owe the late-withdrawal fee for this session. You can register again only if there's a place for your whole group right now.",
  },
  cancellation_terms_changed: {
    status: 409,
    message:
      'The cancellation deadline has passed since you opened this. Review the late-withdrawal terms and confirm again.',
  },
};

export interface AppErrorOptions {
  /** Overrides the default message (still must be safe to show). */
  readonly message?: string;
  readonly fieldErrors?: Readonly<Record<string, readonly string[]>>;
  /** Sets the `Retry-After` header (429 codes). */
  readonly retryAfterSeconds?: number;
  /** Only for `oauth_account_exists`. */
  readonly email?: string;
  /** Session routes: what a DST-gap or overlap time can be stored as instead (422 `validation_failed`). */
  readonly dstOptions?: readonly DstOptionsEntry[];
  /** Session routes: the fee fields the request tried to raise (409 `session_fee_locked`). */
  readonly raisedFields?: readonly string[];
  /** Session routes: the latest row on a stale save (409 `session_stale` / `series_stale`). */
  readonly current?: SessionResponse | SeriesResponse;
  readonly cause?: unknown;
}

/** A domain error carrying a shared `ErrorCode`; the error handler turns it into the response body. */
export class AppError extends Error {
  readonly code: ErrorCode;
  readonly status: number;
  readonly fieldErrors: Readonly<Record<string, readonly string[]>> | undefined;
  readonly retryAfterSeconds: number | undefined;
  readonly email: string | undefined;
  readonly dstOptions: readonly DstOptionsEntry[] | undefined;
  readonly raisedFields: readonly string[] | undefined;
  readonly current: SessionResponse | SeriesResponse | undefined;

  constructor(code: ErrorCode, options: AppErrorOptions = {}) {
    super(options.message ?? ERROR_DEFAULTS[code].message, { cause: options.cause });
    this.name = 'AppError';
    this.code = code;
    this.status = ERROR_DEFAULTS[code].status;
    this.fieldErrors = options.fieldErrors;
    this.retryAfterSeconds = options.retryAfterSeconds;
    this.email = options.email;
    this.dstOptions = options.dstOptions;
    this.raisedFields = options.raisedFields;
    this.current = options.current;
  }
}

const CONNECTION_ERROR_CODES: ReadonlySet<string> = new Set([
  'ECONNREFUSED',
  'ECONNRESET',
  'ETIMEDOUT',
  'EPIPE',
  'ENOTFOUND',
  'EAI_AGAIN',
  '53300', // too_many_connections
  '57P01', // admin_shutdown
  '57P02', // crash_shutdown
  '57P03', // cannot_connect_now
]);

/** True for connection-level database failures (outage, restart, pool exhaustion), not data errors. */
export function isDatabaseUnavailable(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const code = (error as Error & { code?: unknown }).code;
  if (typeof code === 'string' && (code.startsWith('08') || CONNECTION_ERROR_CODES.has(code)))
    return true;
  return /timeout exceeded when trying to connect|Connection terminated|connection timeout/i.test(
    error.message,
  );
}

function sqlState(error: unknown): string | undefined {
  const code = error instanceof Error ? (error as Error & { code?: unknown }).code : undefined;
  return typeof code === 'string' && /^[0-9A-Z]{5}$/.test(code) ? code : undefined;
}

/**
 * Field messages from a zod validation failure, keyed by field name. An unknown key in a strict body
 * is reported under `_form` without naming the key (it is client input).
 */
function toFieldErrors(
  validation: readonly { instancePath: string; keyword: string; message?: string | undefined }[],
): Record<string, string[]> {
  const fieldErrors: Record<string, string[]> = {};
  for (const issue of validation) {
    const field =
      issue.keyword === 'unrecognized_keys'
        ? '_form'
        : issue.instancePath.replace(/^\//, '').replaceAll('/', '.') || '_form';
    const message =
      issue.keyword === 'unrecognized_keys'
        ? 'Unexpected field.'
        : (issue.message ?? 'Invalid value.');
    const list = (fieldErrors[field] ??= []);
    if (!list.includes(message)) list.push(message);
  }
  return fieldErrors;
}

function send(
  reply: FastifyReply,
  code: ErrorCode,
  options: {
    message?: string;
    fieldErrors?: Record<string, readonly string[]>;
    email?: string;
    dstOptions?: readonly DstOptionsEntry[];
    raisedFields?: readonly string[];
    current?: SessionResponse | SeriesResponse;
  } = {},
  retryAfterSeconds?: number,
  status: number = ERROR_DEFAULTS[code].status,
): FastifyReply {
  const body: ErrorResponse | SessionErrorResponse = {
    error: {
      code,
      message: options.message ?? ERROR_DEFAULTS[code].message,
      ...(options.fieldErrors === undefined
        ? {}
        : { fieldErrors: { ...options.fieldErrors } as Record<string, string[]> }),
      ...(options.email === undefined ? {} : { email: options.email }),
      ...(options.dstOptions === undefined ? {} : { dstOptions: [...options.dstOptions] }),
      ...(options.raisedFields === undefined ? {} : { raisedFields: [...options.raisedFields] }),
      ...(options.current === undefined ? {} : { current: options.current }),
    },
  };
  if (retryAfterSeconds !== undefined) void reply.header('retry-after', String(retryAfterSeconds));
  return reply.code(status).send(body);
}

function handleError(
  error: FastifyError | Error,
  request: FastifyRequest,
  reply: FastifyReply,
): FastifyReply {
  if (error instanceof AppError) {
    if (error.status >= 500) {
      request.log.error(
        { event: 'http.error', err: error, errorCode: error.code },
        'request failed',
      );
    }
    return send(
      reply,
      error.code,
      {
        message: error.message,
        ...(error.fieldErrors === undefined ? {} : { fieldErrors: { ...error.fieldErrors } }),
        ...(error.email === undefined ? {} : { email: error.email }),
        ...(error.dstOptions === undefined ? {} : { dstOptions: error.dstOptions }),
        ...(error.raisedFields === undefined ? {} : { raisedFields: error.raisedFields }),
        ...(error.current === undefined ? {} : { current: error.current }),
      },
      error.retryAfterSeconds,
    );
  }
  if (hasZodFastifySchemaValidationErrors(error)) {
    return send(reply, 'validation_failed', { fieldErrors: toFieldErrors(error.validation) });
  }
  const fastifyCode = (error as FastifyError).code;
  const statusCode = (error as FastifyError).statusCode;
  // Malformed JSON, wrong content type, oversized body: client errors raised by Fastify itself.
  if (
    typeof fastifyCode === 'string' &&
    fastifyCode.startsWith('FST_') &&
    typeof statusCode === 'number' &&
    statusCode >= 400 &&
    statusCode < 500
  ) {
    return send(reply, 'validation_failed', {}, undefined, statusCode === 400 ? 422 : statusCode);
  }
  if (isDatabaseUnavailable(error)) {
    request.log.error({ event: 'http.db_unavailable', err: error }, 'database unavailable');
    return send(reply, 'service_unavailable');
  }
  if (sqlState(error) === '23505') {
    return send(reply, 'conflict');
  }
  if (
    sqlState(error) === '23514' &&
    (error as Error & { constraint?: unknown }).constraint === 'auth_identities_last_method'
  ) {
    return send(reply, 'last_sign_in_method');
  }
  request.log.error({ event: 'http.error', err: error }, 'unhandled request error');
  return send(reply, 'internal_error');
}

/** Installs the shared error mapper and the 404 handler. Call before registering routes. */
export function registerErrorHandling(app: FastifyInstance): void {
  app.setErrorHandler(handleError);
  app.setNotFoundHandler((_request, reply) => send(reply, 'not_found'));
}
