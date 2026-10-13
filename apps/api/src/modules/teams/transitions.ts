/**
 * The membership transition table as a pure function (Architecture Q3). It is the TypeScript half of the state
 * machine: the database (`team_members_guard_update`, the CHECKs and the deferred last-admin triggers, D-40..D-43)
 * is the enforcement, and this table gives the precise 409 for the normal path. The two encodings are kept aligned
 * by the shared matrix fixture (`test/fixtures/membership-transitions.ts`).
 *
 * Policy (all admins equal, so nothing here looks at who the actor is):
 *  - approve / reject: only a PENDING request. (Re-request after a rejection is the join upsert, not a moderation.)
 *  - promote: only an APPROVED MEMBER. demote: only an APPROVED TEAM_ADMIN, and never the last one (a self-demotion
 *    included).
 *  - ban: only an APPROVED MEMBER. An approved admin is refused with its own code until demoted. BANNED is terminal.
 */
import type { ErrorCode, MembershipStatus, TeamRole } from '@sgm/shared';

export const MODERATION_ACTIONS = ['approve', 'reject', 'promote', 'demote', 'ban'] as const;
export type ModerationAction = (typeof MODERATION_ACTIONS)[number];

export interface MembershipState {
  readonly status: (typeof MembershipStatus)[number];
  readonly role: (typeof TeamRole)[number];
}

export interface DecideContext {
  /** APPROVED admins of the team, counted under the team lock (exact). Only `demote` reads it. */
  readonly approvedAdminCount: number;
}

export type Decision =
  | { readonly ok: true; readonly next: MembershipState }
  | { readonly ok: false; readonly error: Extract<ErrorCode, RefusalCode> };

type RefusalCode = 'membership_state_conflict' | 'team_admin_cannot_be_banned' | 'last_team_admin';

const refuse = (error: RefusalCode): Decision => ({ ok: false, error });

export function decide(
  action: ModerationAction,
  target: MembershipState,
  context: DecideContext,
): Decision {
  const { status, role } = target;
  const approvedMember = status === 'APPROVED' && role === 'MEMBER';
  const approvedAdmin = status === 'APPROVED' && role === 'TEAM_ADMIN';
  switch (action) {
    case 'approve':
      return status === 'PENDING'
        ? { ok: true, next: { status: 'APPROVED', role: 'MEMBER' } }
        : refuse('membership_state_conflict');
    case 'reject':
      return status === 'PENDING'
        ? { ok: true, next: { status: 'REJECTED', role: 'MEMBER' } }
        : refuse('membership_state_conflict');
    case 'promote':
      return approvedMember
        ? { ok: true, next: { status: 'APPROVED', role: 'TEAM_ADMIN' } }
        : refuse('membership_state_conflict');
    case 'demote':
      if (!approvedAdmin) return refuse('membership_state_conflict');
      return context.approvedAdminCount <= 1
        ? refuse('last_team_admin')
        : { ok: true, next: { status: 'APPROVED', role: 'MEMBER' } };
    case 'ban':
      if (approvedAdmin) return refuse('team_admin_cannot_be_banned');
      return approvedMember
        ? { ok: true, next: { status: 'BANNED', role: 'MEMBER' } }
        : refuse('membership_state_conflict');
  }
}
