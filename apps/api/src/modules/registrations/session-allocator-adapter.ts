/**
 * The registrations side of session-scheduling-engine's allocator port (architecture SA-4, binding T-13; R19, ADR 0018,
 * ADR 0019 §8). SSE owns the port and calls it from its own transactions; this file is the adapter that turns those calls into
 * the real allocator. It adds exactly three things: the port's `name` and `enrols: true` (the second makes SSE stamp the D-80
 * marker after a placement), the `trx.isTransaction` assertion, and an exhaustive mapping of the allocator's results to the
 * port's shapes, so a reason the port does not know fails to compile instead of reaching SSE.
 *
 * It opens no transaction, sets no lock timeout, retries nothing and reads no clock: SSE's transaction policy and `ctx.now`
 * apply (R22), and every call is safe to run again when SSE retries the whole transaction. From the sessions module it may
 * import ONLY `allocator-port.ts` (`boundaries.test.ts`). The composition function (`apps/api/src/session-allocator.ts`)
 * wires it in Phase 3, once the promotion and the auto-enrol emails both exist.
 */
import type {
  AutoEnrolEntryOutcome,
  PromotedSeat,
  SessionAllocatorContext,
  SessionAllocatorPort,
} from '../sessions/allocator-port.ts';
import type { Allocator, AutoEnrolOutcome } from './allocator.ts';

function assertTransaction(ctx: SessionAllocatorContext): void {
  if (!ctx.trx.isTransaction) {
    throw new Error("the allocator must run inside the caller's transaction");
  }
}

/** The allocator and the port name the same refusals today; the switch keeps it that way at compile time. */
function toPortOutcome(outcome: AutoEnrolOutcome): AutoEnrolEntryOutcome {
  if (outcome.ok) return { ok: true, status: outcome.status };
  switch (outcome.reason) {
    case 'overdue_payments':
    case 'forbidden':
    case 'already_registered':
    case 'auto_enroll_changed':
    case 'not_found':
    case 'session_not_open':
    case 'party_exceeds_capacity':
      return { ok: false, reason: outcome.reason };
  }
}

export function createRegistrationsSessionAllocator(
  allocator: Pick<Allocator, 'promoteWaitlist' | 'autoEnrolInSession'>,
): SessionAllocatorPort {
  return {
    name: 'registrations',
    enrols: true,
    async promoteWaitlist(ctx, input) {
      assertTransaction(ctx);
      const promoted = await allocator.promoteWaitlist(ctx, input);
      return promoted.map((seat): PromotedSeat => ({
        registrationId: seat.registrationId,
        userId: seat.userId,
        promotedAt: seat.promotedAt,
      }));
    },
    async autoEnrolInSession(ctx, input) {
      assertTransaction(ctx);
      const results = await allocator.autoEnrolInSession(ctx, input);
      return results.map((result) => ({
        userId: result.userId,
        outcome: toPortOutcome(result.outcome),
      }));
    },
  };
}
