/**
 * The pure membership transition table (Architecture Q3, AC-HAPPY-6..11, AC-ERROR-6, 7 and 9). It is replayed
 * against the shared status matrix fixture that `teams-schema.int.test.ts` runs as raw SQL against the
 * `team_members_guard_update` trigger, so the SQL and TypeScript encodings of the state machine cannot drift.
 */
import { MembershipStatus, TeamRole } from '@sgm/shared';
import { describe, expect, it } from 'vitest';
import {
  ALLOWED_STATUS_TRANSITIONS,
  STATUS_TRANSITION_MATRIX,
  type MembershipStatusName,
} from '../../../test/fixtures/membership-transitions.ts';
import { MODERATION_ACTIONS, decide, type ModerationAction } from './transitions.ts';

type Role = (typeof TeamRole)[number];

const target = (status: MembershipStatusName, role: Role = 'MEMBER') => ({ status, role });

/** What each action does to a (status, role) target, written out independently of `decide`. */
const EXPECTED: Record<
  ModerationAction,
  (status: MembershipStatusName, role: Role, adminCount: number) => unknown
> = {
  approve: (status) =>
    status === 'PENDING'
      ? { ok: true, next: { status: 'APPROVED', role: 'MEMBER' } }
      : 'membership_state_conflict',
  reject: (status) =>
    status === 'PENDING'
      ? { ok: true, next: { status: 'REJECTED', role: 'MEMBER' } }
      : 'membership_state_conflict',
  promote: (status, role) =>
    status === 'APPROVED' && role === 'MEMBER'
      ? { ok: true, next: { status: 'APPROVED', role: 'TEAM_ADMIN' } }
      : 'membership_state_conflict',
  demote: (status, role, adminCount) => {
    if (status !== 'APPROVED' || role !== 'TEAM_ADMIN') return 'membership_state_conflict';
    return adminCount <= 1
      ? 'last_team_admin'
      : { ok: true, next: { status: 'APPROVED', role: 'MEMBER' } };
  },
  ban: (status, role) => {
    if (status === 'APPROVED' && role === 'TEAM_ADMIN') return 'team_admin_cannot_be_banned';
    return status === 'APPROVED'
      ? { ok: true, next: { status: 'BANNED', role: 'MEMBER' } }
      : 'membership_state_conflict';
  },
};

describe('decide() over every (action, status, role, adminCount) combination', () => {
  const cases = MODERATION_ACTIONS.flatMap((action) =>
    MembershipStatus.flatMap((status) =>
      TeamRole.flatMap((role) =>
        // The database forbids a non-APPROVED admin (D-40), but the table must still answer safely.
        [1, 2].map((adminCount) => ({ action, status, role, adminCount })),
      ),
    ),
  );

  it.each(cases)(
    '$action on $status/$role with $adminCount admin(s)',
    ({ action, status, role, adminCount }) => {
      const expected = EXPECTED[action](status, role, adminCount);
      const result = decide(action, target(status, role), { approvedAdminCount: adminCount });
      if (typeof expected === 'string') {
        expect(result).toEqual({ ok: false, error: expected });
      } else {
        expect(result).toEqual(expected);
      }
    },
  );
});

describe('agreement with the SQL status matrix (shared fixture)', () => {
  it('only ever moves status along an allowed edge, and BANNED is terminal', () => {
    const allowed = new Set(ALLOWED_STATUS_TRANSITIONS.map(([from, to]) => `${from}>${to}`));
    for (const action of MODERATION_ACTIONS) {
      for (const status of MembershipStatus) {
        for (const role of TeamRole) {
          const result = decide(action, target(status, role), { approvedAdminCount: 2 });
          if (result.ok && result.next.status !== status) {
            expect(allowed.has(`${status}>${result.next.status}`), `${action} ${status}`).toBe(
              true,
            );
          }
          if (status === 'BANNED') expect(result.ok).toBe(false);
        }
      }
    }
  });

  it('reaches every status move the matrix allows except REJECTED -> PENDING, which is a join request', () => {
    const reached = new Set<string>();
    for (const action of MODERATION_ACTIONS) {
      for (const { from } of STATUS_TRANSITION_MATRIX) {
        const result = decide(action, target(from), { approvedAdminCount: 2 });
        if (result.ok && result.next.status !== from) {
          reached.add(`${from}>${result.next.status}`);
        }
      }
    }
    const expected = STATUS_TRANSITION_MATRIX.filter(
      (move) => move.allowed && !(move.from === 'REJECTED' && move.to === 'PENDING'),
    ).map((move) => `${move.from}>${move.to}`);
    expect([...reached].sort()).toEqual(expected.sort());
  });
});
