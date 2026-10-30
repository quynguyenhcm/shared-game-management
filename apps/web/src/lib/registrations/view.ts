import type { RegistrationReadResponse } from '@sgm/shared';

/**
 * Which one state the panel is in (UI/UX "Panel states in words"; journey P3-P10). A pure function of the read model the
 * API answered and the server clock: every number the panel shows is a field of the response, and the only thing worked
 * out here is whether the cancellation deadline has passed (the same `now <= deadline` rule the API applies, so the
 * wording is a prediction and the API re-classifies inside its transaction, R9).
 *
 * - `cancelled`: the session was cancelled. It wins over an active registration, because SSE's cancel leaves every row as it
 *   was and emails nobody (P-2, R27), so this page is the player's only signal.
 * - `closed`: the read model says `session_not_open` (started, COMPLETED), whatever the caller's debt is.
 * - `confirmed` / `waitlisted`: an active registration, even with 3 or more overdue payments (withdrawal is never blocked).
 * - `debt_blocked`, `no_places`: `blockedReason` from the read model.
 * - `withdrawn`: the caller withdrew and may register again; `open`: nothing registered.
 */
export type PanelKind =
  | 'cancelled'
  | 'closed'
  | 'confirmed'
  | 'waitlisted'
  | 'debt_blocked'
  | 'no_places'
  | 'withdrawn'
  | 'open';

export interface PanelView {
  readonly kind: PanelKind;
  /** `now > session.cancellationDeadline`; false when the session has no deadline. */
  readonly deadlinePassed: boolean;
}

export function panelView(response: RegistrationReadResponse, now: Date): PanelView {
  const { session, me, blockedReason } = response;
  const deadline = session.cancellationDeadline;
  const deadlinePassed = deadline !== null && now.getTime() > new Date(deadline).getTime();
  const status = me.registration?.status ?? null;
  const view = (kind: PanelKind): PanelView => ({ kind, deadlinePassed });

  if (session.status === 'CANCELLED') return view('cancelled');
  if (blockedReason === 'session_not_open' || session.status === 'COMPLETED') return view('closed');
  if (status === 'CONFIRMED') return view('confirmed');
  if (status === 'WAITLISTED') return view('waitlisted');
  if (blockedReason === 'overdue_payments') return view('debt_blocked');
  if (blockedReason === 'party_exceeds_capacity') return view('no_places');
  if (status === 'WITHDRAWN' && response.canRegister) return view('withdrawn');
  return response.canRegister ? view('open') : view('closed');
}
