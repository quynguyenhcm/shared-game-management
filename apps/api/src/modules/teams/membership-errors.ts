/**
 * Maps the database's membership guards (migration D-40..D-43) to the shared error codes. It keys on SQLSTATE plus
 * `err.constraint`, never on message text, so a reworded trigger message cannot silently change an answer. These
 * are the backstops: the service normally refuses first through `transitions.decide`, and the deferred last-admin
 * trigger surfaces at COMMIT, so the mapping wraps the whole transaction.
 */
import { AppError } from '../../lib/http/errors.ts';

function pgDetails(error: unknown): { code?: unknown; constraint?: unknown } | undefined {
  return error instanceof Error
    ? (error as Error & { code?: unknown; constraint?: unknown })
    : undefined;
}

/** An `AppError` for a known membership guard violation, otherwise the error unchanged. */
export function mapMembershipDbError(error: unknown): unknown {
  const details = pgDetails(error);
  if (details === undefined) return error;
  const { code, constraint } = details;
  if (code === '23514' && constraint === 'team_members_admin_approved') {
    return new AppError('team_admin_cannot_be_banned', { cause: error });
  }
  if (code === '23514' && constraint === 'team_members_last_admin') {
    return new AppError('last_team_admin', { cause: error });
  }
  if (
    code === '23000' &&
    (constraint === 'team_members_status_transition' ||
      constraint === 'team_members_keys_immutable')
  ) {
    return new AppError('membership_state_conflict', { cause: error });
  }
  return error;
}
