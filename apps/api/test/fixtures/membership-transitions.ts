/**
 * The membership status transition matrix as data (architecture doc, "Next Steps" item 2 and Trade-offs).
 * One list, two consumers: `teams-schema.int.test.ts` replays every pair as raw SQL against the
 * `team_members_guard_update` trigger (D-42), and Phase 3's `transitions.test.ts` replays it against the
 * pure TypeScript table, so the SQL and TS encodings cannot drift apart.
 *
 * Only moves that change `status` appear; a same-status update (for example promote or demote) is not a
 * transition and is always allowed by the trigger.
 */
import { MembershipStatus } from '@sgm/shared';

export type MembershipStatusName = (typeof MembershipStatus)[number];

export interface StatusTransition {
  readonly from: MembershipStatusName;
  readonly to: MembershipStatusName;
  readonly allowed: boolean;
}

/** The only moves v1 allows. `BANNED` is terminal. */
export const ALLOWED_STATUS_TRANSITIONS: readonly (readonly [
  MembershipStatusName,
  MembershipStatusName,
])[] = [
  ['PENDING', 'APPROVED'],
  ['PENDING', 'REJECTED'],
  ['REJECTED', 'PENDING'],
  ['APPROVED', 'BANNED'],
];

/** All 12 ordered pairs of distinct statuses, each marked allowed or refused. */
export const STATUS_TRANSITION_MATRIX: readonly StatusTransition[] = MembershipStatus.flatMap(
  (from) =>
    MembershipStatus.filter((to) => to !== from).map((to) => ({
      from,
      to,
      allowed: ALLOWED_STATUS_TRANSITIONS.some(([a, b]) => a === from && b === to),
    })),
);
