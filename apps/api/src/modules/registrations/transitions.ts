/**
 * The registration status transition table as a pure function (architecture doc Q2 sub-decision). It is the TypeScript
 * half of the state machine: the database trigger `registrations_guard_update` (D-64) is the enforcement, and this table
 * gives callers the same answer without a round trip. The two encodings are kept aligned by the shared matrix fixture
 * (`test/fixtures/registration-transitions.ts`), replayed against the trigger in `registrations-schema.int.test.ts`.
 *
 * Only legality of the status move lives here: the allocator's decisions (who is promoted, who owes a fee) are a later
 * phase.
 */
import type { RegistrationStatus } from '@sgm/shared';

/** The only status moves the trigger allows. `CONFIRMED -> WAITLISTED` (a demotion) is never one of them. */
export const ALLOWED_TRANSITIONS: readonly (readonly [RegistrationStatus, RegistrationStatus])[] = [
  ['WAITLISTED', 'CONFIRMED'],
  ['CONFIRMED', 'WITHDRAWN'],
  ['WAITLISTED', 'WITHDRAWN'],
  ['WITHDRAWN', 'CONFIRMED'],
  ['WITHDRAWN', 'WAITLISTED'],
];

/** Whether an update from `from` to `to` is legal. A same-status update is not a transition and is always allowed. */
export function canTransition(from: RegistrationStatus, to: RegistrationStatus): boolean {
  return from === to || ALLOWED_TRANSITIONS.some(([a, b]) => a === from && b === to);
}
