/**
 * The session status matrix (architecture doc SA-7). The TS twin of the `game_sessions_guard_update` trigger
 * (D-75): any change here changes the SQL and `apps/api/test/fixtures/session-transitions.ts` in the same commit.
 * PUBLISHED -> COMPLETED belongs to billing; this feature never performs it.
 */
import type { SessionStatus } from '../types/enums.ts';

export const SESSION_TRANSITIONS: Readonly<Record<SessionStatus, readonly SessionStatus[]>> = {
  DRAFT: ['PUBLISHED', 'CANCELLED'],
  PUBLISHED: ['CANCELLED', 'COMPLETED'],
  COMPLETED: [],
  CANCELLED: [],
};

/** COMPLETED and CANCELLED: no further moves, and the row is immutable. */
export function isTerminal(status: SessionStatus): boolean {
  return SESSION_TRANSITIONS[status].length === 0;
}
