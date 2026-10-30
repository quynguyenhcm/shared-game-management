/**
 * The registration status transition matrix as data (architecture doc Q2 sub-decision, same pattern as
 * `membership-transitions.ts`). One list, two consumers: `registrations-schema.int.test.ts` replays every pair as raw
 * SQL against the `registrations_guard_update` trigger (D-64), and `modules/registrations/transitions.test.ts` replays
 * it against the pure TypeScript table, so the SQL and TS encodings cannot drift apart.
 *
 * Only moves that change `status` appear; a same-status update is not a transition and is always allowed.
 */
import { RegistrationStatus } from '@sgm/shared';

export type RegistrationStatusName = (typeof RegistrationStatus)[number];

export interface RegistrationStatusTransition {
  readonly from: RegistrationStatusName;
  readonly to: RegistrationStatusName;
  readonly allowed: boolean;
}

/** The only moves the trigger allows. `CONFIRMED -> WAITLISTED` (a demotion) is never one of them. */
export const ALLOWED_REGISTRATION_TRANSITIONS: readonly (readonly [
  RegistrationStatusName,
  RegistrationStatusName,
])[] = [
  ['WAITLISTED', 'CONFIRMED'],
  ['CONFIRMED', 'WITHDRAWN'],
  ['WAITLISTED', 'WITHDRAWN'],
  ['WITHDRAWN', 'CONFIRMED'],
  ['WITHDRAWN', 'WAITLISTED'],
];

/** All 6 ordered pairs of distinct statuses, each marked allowed or refused. */
export const REGISTRATION_TRANSITION_MATRIX: readonly RegistrationStatusTransition[] =
  RegistrationStatus.flatMap((from) =>
    RegistrationStatus.filter((to) => to !== from).map((to) => ({
      from,
      to,
      allowed: ALLOWED_REGISTRATION_TRANSITIONS.some(([a, b]) => a === from && b === to),
    })),
  );
