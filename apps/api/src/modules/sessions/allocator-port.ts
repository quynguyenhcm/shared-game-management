/**
 * The seam toward registration-and-waitlist's seat allocator (architecture SA-4, binding T-13). This feature OWNS the
 * port; registration owns the adapter that implements it (ADR 0015 precedent) and may import ONLY this file from the
 * sessions module (`boundaries.test.ts`). It is structurally compatible with registration's `Allocator`:
 * `promoteWaitlist(ctx, { teamId, sessionId })` and `autoEnrolInSession` with the R16 `entries` input.
 *
 * Everything here is types plus the safe default; the composition function that picks the implementation is
 * `apps/api/src/session-allocator.ts`.
 */
import type { Transaction } from 'kysely';
import type { DB } from '../../lib/db/types.generated.ts';
import type { Logger } from '../../lib/logger/logger.ts';

/** The caller's transaction and clock reading. The allocator asserts `trx.isTransaction`. */
export interface SessionAllocatorContext {
  readonly trx: Transaction<DB>;
  /** Read by the caller after its own locks (capacity edit: after the session FOR UPDATE). */
  readonly now: Date;
  readonly log: Pick<Logger, 'info' | 'warn' | 'error'>;
}

/** One `selectAutoEnrollees` row, passed in the returned order (R16; supersedes C-SAE-1's `userIds`). */
export interface AutoEnrolEntry {
  readonly userId: string;
  /** `auto_enroll_assigned_at` as selected; the allocator re-checks it at millisecond precision (R16). */
  readonly assignedAt: Date;
  /** Pass-through for the allocator's logs; optional (R16 "callers may pass through"). */
  readonly membershipId?: string;
}

export type AutoEnrolSkipReason =
  | 'overdue_payments'
  | 'forbidden'
  | 'already_registered'
  | 'auto_enroll_changed'
  | 'not_found'
  | 'session_not_open'
  | 'party_exceeds_capacity'
  /** O5: `now` is past the locked session's `cancellation_deadline`; auto-enrol adds nobody (manual registration is unaffected). */
  | 'deadline_passed';

export type AutoEnrolEntryOutcome =
  | { readonly ok: true; readonly status: 'CONFIRMED' | 'WAITLISTED' }
  | { readonly ok: false; readonly reason: AutoEnrolSkipReason };

export interface PromotedSeat {
  readonly registrationId: string;
  readonly userId: string;
  readonly promotedAt: Date;
}

export interface SessionAllocatorPort {
  /** Logged as `allocator` (e.g. `noop`, `registrations`). */
  readonly name: string;
  /**
   * True only for an implementation that really registers members. While false (the no-op), the auto-enrol
   * follow-up leaves `game_sessions.auto_enrolled_at` NULL so a later run with a real allocator enrols the session.
   */
  readonly enrols: boolean;
  /**
   * C-SSE-3: called after the caller's `SELECT … FROM game_sessions … FOR UPDATE` and capacity `UPDATE`, in the same
   * transaction, only when public capacity (max_players − reserved_seats) rose on a PUBLISHED, not-started session.
   * Takes the D-14 lock itself (re-entrant). Returns the promoted seats; [] when nothing changed.
   */
  promoteWaitlist(
    ctx: SessionAllocatorContext,
    input: { readonly teamId: string; readonly sessionId: string },
  ): Promise<readonly PromotedSeat[]>;
  /**
   * C-SAE-1/2 as amended by R16: once per PUBLISHED session, in a transaction that holds no lock on that session or
   * its rule; gates every member (team_members FOR SHARE + opt-out re-check) before taking the session lock; parties
   * have no guests; refusals are returned per entry, never thrown; never called with an empty `entries`.
   */
  autoEnrolInSession(
    ctx: SessionAllocatorContext,
    input: {
      readonly teamId: string;
      readonly sessionId: string;
      readonly entries: readonly AutoEnrolEntry[];
    },
  ): Promise<readonly { readonly userId: string; readonly outcome: AutoEnrolEntryOutcome }[]>;
}

/** Safe default until registration-and-waitlist ships: logs and changes nothing. */
export const noopSessionAllocator: SessionAllocatorPort = {
  name: 'noop',
  enrols: false,
  promoteWaitlist(ctx, input) {
    ctx.log.info(
      { event: 'session.allocator.promote_noop', teamId: input.teamId, sessionId: input.sessionId },
      'no allocator wired: waitlist promotion skipped',
    );
    return Promise.resolve([]);
  },
  autoEnrolInSession() {
    return Promise.resolve([]);
  },
};
