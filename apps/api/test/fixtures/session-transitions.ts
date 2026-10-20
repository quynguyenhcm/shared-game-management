/**
 * The session lifecycle as hand-written data (architecture doc SA-7; Binding Reconciliation T-11).
 * One list, three consumers, so the SQL trigger, the shared TS table and the API decision cannot drift:
 *   - `sessions-schema.int.test.ts` replays every `(from, to)` pair as a raw `UPDATE` against
 *     `game_sessions_guard_update` (success, or SQLSTATE 23000 `game_sessions_status_transition`);
 *   - `packages/shared/src/sessions/lifecycle.test.ts` replays it against `SESSION_TRANSITIONS`;
 *   - `apps/api/src/modules/sessions/transitions.test.ts` replays the action rows against `decideSessionAction`.
 *
 * Expected values are written out from the rules below, never computed by production code:
 *   DRAFT -> PUBLISHED | CANCELLED;  PUBLISHED -> CANCELLED | COMPLETED;  COMPLETED and CANCELLED are terminal.
 *   Every edit, capacity change, publish and cancel is refused once `starts_at <= now` (409 session_started),
 *   and refused outright on a COMPLETED or CANCELLED session (409 session_not_editable).
 * Any change to the matrix changes the SQL, the TS and this file in one commit (the ADR 0016 discipline).
 */
export type SessionStatusName = 'DRAFT' | 'PUBLISHED' | 'COMPLETED' | 'CANCELLED';

export interface StatusTransitionRow {
  readonly from: SessionStatusName;
  readonly to: SessionStatusName;
  /**
   * For `from === to` the row is a same-status write: it is not a transition, so the trigger accepts it
   * (`allowed: true`) and `SESSION_TRANSITIONS` does not list it. All 12 other pairs are real moves.
   */
  readonly allowed: boolean;
}

/** All 16 ordered pairs. */
export const SESSION_TRANSITION_MATRIX: readonly StatusTransitionRow[] = [
  { from: 'DRAFT', to: 'DRAFT', allowed: true },
  { from: 'DRAFT', to: 'PUBLISHED', allowed: true },
  { from: 'DRAFT', to: 'COMPLETED', allowed: false },
  { from: 'DRAFT', to: 'CANCELLED', allowed: true },
  { from: 'PUBLISHED', to: 'DRAFT', allowed: false },
  { from: 'PUBLISHED', to: 'PUBLISHED', allowed: true },
  { from: 'PUBLISHED', to: 'COMPLETED', allowed: true },
  { from: 'PUBLISHED', to: 'CANCELLED', allowed: true },
  { from: 'COMPLETED', to: 'DRAFT', allowed: false },
  { from: 'COMPLETED', to: 'PUBLISHED', allowed: false },
  { from: 'COMPLETED', to: 'COMPLETED', allowed: true },
  { from: 'COMPLETED', to: 'CANCELLED', allowed: false },
  { from: 'CANCELLED', to: 'DRAFT', allowed: false },
  { from: 'CANCELLED', to: 'PUBLISHED', allowed: false },
  { from: 'CANCELLED', to: 'COMPLETED', allowed: false },
  { from: 'CANCELLED', to: 'CANCELLED', allowed: true },
];

export type SessionActionName = 'edit' | 'publish' | 'cancel' | 'capacity';
/** Where `now` sits against the session's `starts_at` (`no_start`: no court yet, so `starts_at` is NULL). */
export type StartTiming = 'before_start' | 'at_start' | 'after_start' | 'no_start';
export type SessionActionError =
  'session_not_editable' | 'session_started' | 'session_state_conflict';

export type ExpectedDecision =
  | { readonly ok: true; readonly next: SessionStatusName }
  | { readonly ok: false; readonly error: SessionActionError };

export interface ActionRow {
  readonly action: SessionActionName;
  readonly status: SessionStatusName;
  readonly timing: StartTiming;
  readonly expected: ExpectedDecision;
}

/** The fixed clock of every action row. */
export const FIXTURE_NOW = new Date('2026-10-20T08:00:00.000Z');
/** `starts_at` for each timing against `FIXTURE_NOW` (null for `no_start`). */
export const FIXTURE_STARTS_AT: Readonly<Record<StartTiming, Date | null>> = {
  before_start: new Date('2026-10-21T06:00:00.000Z'),
  at_start: new Date('2026-10-20T08:00:00.000Z'),
  after_start: new Date('2026-10-19T06:00:00.000Z'),
  no_start: null,
};

// Compact cell codes, in the order [before_start, at_start, after_start, no_start].
type Cell = 'to:DRAFT' | 'to:PUBLISHED' | 'to:CANCELLED' | 'started' | 'conflict' | 'closed';
const TIMINGS: readonly StartTiming[] = ['before_start', 'at_start', 'after_start', 'no_start'];

function decode(cell: Cell): ExpectedDecision {
  switch (cell) {
    case 'to:DRAFT':
      return { ok: true, next: 'DRAFT' };
    case 'to:PUBLISHED':
      return { ok: true, next: 'PUBLISHED' };
    case 'to:CANCELLED':
      return { ok: true, next: 'CANCELLED' };
    case 'started':
      return { ok: false, error: 'session_started' };
    case 'conflict':
      return { ok: false, error: 'session_state_conflict' };
    case 'closed':
      return { ok: false, error: 'session_not_editable' };
  }
}

function rows(
  action: SessionActionName,
  status: SessionStatusName,
  cells: readonly [Cell, Cell, Cell, Cell],
): ActionRow[] {
  return TIMINGS.map((timing, index) => ({
    action,
    status,
    timing,
    expected: decode(cells[index] as Cell),
  }));
}

export const SESSION_ACTION_ROWS: readonly ActionRow[] = [
  // DRAFT: editable and publishable until it starts; a draft with no court yet has no start to pass.
  ...rows('edit', 'DRAFT', ['to:DRAFT', 'started', 'started', 'to:DRAFT']),
  ...rows('capacity', 'DRAFT', ['to:DRAFT', 'started', 'started', 'to:DRAFT']),
  ...rows('publish', 'DRAFT', ['to:PUBLISHED', 'started', 'started', 'to:PUBLISHED']),
  ...rows('cancel', 'DRAFT', ['to:CANCELLED', 'started', 'started', 'to:CANCELLED']),
  // PUBLISHED: editable and cancellable until it starts; publishing again is a state conflict at any time.
  ...rows('edit', 'PUBLISHED', ['to:PUBLISHED', 'started', 'started', 'to:PUBLISHED']),
  ...rows('capacity', 'PUBLISHED', ['to:PUBLISHED', 'started', 'started', 'to:PUBLISHED']),
  ...rows('publish', 'PUBLISHED', ['conflict', 'conflict', 'conflict', 'conflict']),
  ...rows('cancel', 'PUBLISHED', ['to:CANCELLED', 'started', 'started', 'to:CANCELLED']),
  // COMPLETED and CANCELLED: closed whatever the action and whatever the clock.
  ...rows('edit', 'COMPLETED', ['closed', 'closed', 'closed', 'closed']),
  ...rows('capacity', 'COMPLETED', ['closed', 'closed', 'closed', 'closed']),
  ...rows('publish', 'COMPLETED', ['closed', 'closed', 'closed', 'closed']),
  ...rows('cancel', 'COMPLETED', ['closed', 'closed', 'closed', 'closed']),
  ...rows('edit', 'CANCELLED', ['closed', 'closed', 'closed', 'closed']),
  ...rows('capacity', 'CANCELLED', ['closed', 'closed', 'closed', 'closed']),
  ...rows('publish', 'CANCELLED', ['closed', 'closed', 'closed', 'closed']),
  ...rows('cancel', 'CANCELLED', ['closed', 'closed', 'closed', 'closed']),
];
