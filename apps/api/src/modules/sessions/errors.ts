/**
 * Database error handling for the sessions module. `mapSessionDbError` turns the guards of the session schema
 * (architecture SA-7 table) into the shared API errors; `classifySessionError` says whether a failure is worth retrying,
 * which the materialiser uses to choose between a retried and a permanently failed job (AC-ERROR-9). Both key on SQLSTATE
 * plus `err.constraint`, never on message text, and never copy database text into a response.
 */
import { SESSION_FIELD_MESSAGES } from '@sgm/shared';
import { AppError } from '../../lib/http/errors.ts';
import { mapPublishGateDbError } from '../team-banking/publish-gate.ts';

const M = SESSION_FIELD_MESSAGES;

const invalid = (fieldErrors: Record<string, string[]>, error: Error): AppError =>
  new AppError('validation_failed', { fieldErrors, cause: error });

/** An `AppError` for a known session guard violation, otherwise the error unchanged. */
export function mapSessionDbError(error: unknown): unknown {
  if (!(error instanceof Error)) return error;
  const { constraint } = error as Error & { constraint?: unknown };
  switch (constraint) {
    case 'game_sessions_status_transition':
      return new AppError('session_state_conflict', { cause: error });
    case 'game_sessions_closed_immutable':
    case 'session_courts_closed_immutable':
      return new AppError('session_not_editable', { cause: error });
    case 'game_sessions_keys_immutable':
      return invalid({ date: [M.datePatternFixed] }, error);
    case 'game_sessions_deadline_before_start':
      return invalid({ cancellationDeadline: [M.deadlineAfterStart] }, error);
    case 'uq_session_courts_session_identifier':
      return invalid({ courts: [M.courtNamesDuplicate] }, error);
    case 'game_sessions_instants_when_live':
      return invalid({ courts: [M.courtsRequired] }, error);
    case 'game_sessions_skill_fees_when_live':
      return invalid(
        {
          feeBeginner: [M.amountFormat],
          feeIntermediate: [M.amountFormat],
          feeAdvanced: [M.amountFormat],
        },
        error,
      );
    case 'game_sessions_flat_fee_when_live':
      return invalid({ customPlayerRate: [M.amountFormat] }, error);
    case 'game_sessions_fee_raise_locked':
      return new AppError('session_fee_locked', { cause: error });
    default:
      return mapPublishGateDbError(error);
  }
}

export interface FailureClass {
  /** True when a retry may succeed (lock conflicts, serialisation failures, connection trouble, anything unknown). */
  readonly transient: boolean;
  readonly sqlState: string | undefined;
  /** The SQLSTATE when there is one, else the error's name: a code, never the message (it may echo row data). */
  readonly errorCode: string;
}

const SQLSTATE = /^[0-9A-Z]{5}$/;

export function classifySessionError(error: unknown): FailureClass {
  const code = error instanceof Error ? (error as Error & { code?: unknown }).code : undefined;
  const sqlState = typeof code === 'string' && SQLSTATE.test(code) ? code : undefined;
  const errorCode = sqlState ?? (error instanceof Error ? error.name : 'unknown');
  // Constraint (23xxx) and data (22xxx) errors repeat on every retry; everything else may be a passing condition.
  const permanent =
    sqlState !== undefined && (sqlState.startsWith('23') || sqlState.startsWith('22'));
  return { transient: !permanent, sqlState, errorCode };
}
