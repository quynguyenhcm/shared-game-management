/**
 * The API-side lifecycle decision (architecture doc SA-7; Binding Reconciliation T-11). Pure: `now` is passed in,
 * read by the caller AFTER it holds the session lock, because time-relative rules stay out of SQL. The status
 * matrix itself lives in `@sgm/shared` (`SESSION_TRANSITIONS`, the TS twin of the `game_sessions_guard_update`
 * trigger); this adds the clock and the closed-row rule on top.
 *
 *   COMPLETED / CANCELLED          -> `session_not_editable` for every action (AC-ERROR-5)
 *   publish when already PUBLISHED -> `session_state_conflict` (not a legal move)
 *   starts_at <= now               -> `session_started` for every edit, capacity change, publish and cancel
 */
import { SESSION_TRANSITIONS, isTerminal, type SessionStatus } from '@sgm/shared';

export type SessionAction = 'edit' | 'publish' | 'cancel' | 'capacity';

export type SessionActionError =
  'session_not_editable' | 'session_started' | 'session_state_conflict';

export type SessionActionDecision =
  | { readonly ok: true; readonly next: SessionStatus }
  | { readonly ok: false; readonly error: SessionActionError };

export interface SessionActionState {
  readonly status: SessionStatus;
  /** NULL while the session has no court yet, so there is no start to pass. */
  readonly startsAt: Date | null;
}

const TARGET: Readonly<Record<'publish' | 'cancel', SessionStatus>> = {
  publish: 'PUBLISHED',
  cancel: 'CANCELLED',
};

export function decideSessionAction(
  action: SessionAction,
  state: SessionActionState,
  now: Date,
): SessionActionDecision {
  if (isTerminal(state.status)) return { ok: false, error: 'session_not_editable' };

  const next = action === 'publish' || action === 'cancel' ? TARGET[action] : state.status;
  if (next !== state.status && !SESSION_TRANSITIONS[state.status].includes(next)) {
    return { ok: false, error: 'session_state_conflict' };
  }
  if (action === 'publish' && next === state.status) {
    // PUBLISHED -> PUBLISHED is not a move; the service answers an already-published request as a 200 no-op
    // before it gets here, so reaching this point is a real conflict.
    return { ok: false, error: 'session_state_conflict' };
  }
  if (state.startsAt !== null && state.startsAt.getTime() <= now.getTime()) {
    return { ok: false, error: 'session_started' };
  }
  return { ok: true, next };
}
