/**
 * Maps the database's banking guard (migration D-50, the `teams_guard_banking_removal` trigger) to the shared error
 * code. It keys on SQLSTATE plus `err.constraint`, never on message text. This is the backstop for a removal that
 * raced past the service's own `team_banking_in_use` check; the service normally refuses first.
 */
import { AppError } from '../../lib/http/errors.ts';

/** An `AppError` for a known banking guard violation, otherwise the error unchanged. */
export function mapBankingDbError(error: unknown): unknown {
  if (!(error instanceof Error)) return error;
  const { code, constraint } = error as Error & { code?: unknown; constraint?: unknown };
  if (code === '23514' && constraint === 'teams_banking_in_use') {
    return new AppError('banking_in_use', { cause: error });
  }
  return error;
}

/**
 * Maps the database's publish backstop (migration D-49, the `game_sessions_paid_requires_payout` trigger) to the
 * same `payout_not_configured` error the TypeScript gate throws. Keyed on SQLSTATE plus `err.constraint`, never on
 * message text. Reaching this means a caller skipped `assertTeamCanPublishPaidSession`; never use it for flow
 * control.
 */
export function mapPublishGateDbError(error: unknown): unknown {
  if (!(error instanceof Error)) return error;
  const { code, constraint } = error as Error & { code?: unknown; constraint?: unknown };
  if (code === '23514' && constraint === 'game_sessions_paid_requires_payout') {
    return new AppError('payout_not_configured', { cause: error });
  }
  return error;
}
