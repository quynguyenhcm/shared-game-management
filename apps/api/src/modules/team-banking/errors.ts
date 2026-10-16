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
