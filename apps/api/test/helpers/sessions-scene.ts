/**
 * Shared scaffolding for the session-scheduling-engine integration tests: a team with an approved admin and
 * member, and the recording allocator double that stands in for registration-and-waitlist's real allocator
 * (`enrols` is switchable, so the auto-enrol marker proof can flip a pending session to enrolled).
 */
import { randomUUID } from 'node:crypto';
import type {
  AutoEnrolEntry,
  AutoEnrolEntryOutcome,
  PromotedSeat,
  SessionAllocatorContext,
  SessionAllocatorPort,
} from '../../src/modules/sessions/allocator-port.ts';
import { insertTeam, insertTeamMember, insertUser, type TeamOptions } from './factories.ts';
import type { Queryable } from './test-db.ts';

export interface RecordedPromote {
  readonly teamId: string;
  readonly sessionId: string;
  readonly now: Date;
  /** True when the caller's transaction was passed (the allocator asserts `trx.isTransaction`). */
  readonly inTransaction: boolean;
}

export interface RecordedAutoEnrol {
  readonly teamId: string;
  readonly sessionId: string;
  readonly now: Date;
  readonly entries: readonly AutoEnrolEntry[];
  readonly inTransaction: boolean;
}

export interface RecordingAllocator extends SessionAllocatorPort {
  /** Switchable: a double with `enrols: false` behaves like the no-op for the pending-marker rules. */
  enrols: boolean;
  readonly promoteCalls: RecordedPromote[];
  readonly autoEnrolCalls: RecordedAutoEnrol[];
  /** What `promoteWaitlist` returns next (default none). */
  promoted: readonly PromotedSeat[];
  /** What each entry of `autoEnrolInSession` gets (default CONFIRMED). */
  outcome: AutoEnrolEntryOutcome;
  reset(): void;
}

export function createRecordingAllocator(options: { enrols?: boolean } = {}): RecordingAllocator {
  const allocator: RecordingAllocator = {
    name: 'recording',
    enrols: options.enrols ?? true,
    promoteCalls: [],
    autoEnrolCalls: [],
    promoted: [],
    outcome: { ok: true, status: 'CONFIRMED' },
    promoteWaitlist(ctx: SessionAllocatorContext, input) {
      allocator.promoteCalls.push({
        teamId: input.teamId,
        sessionId: input.sessionId,
        now: ctx.now,
        inTransaction: ctx.trx.isTransaction,
      });
      return Promise.resolve(allocator.promoted);
    },
    autoEnrolInSession(ctx: SessionAllocatorContext, input) {
      allocator.autoEnrolCalls.push({
        teamId: input.teamId,
        sessionId: input.sessionId,
        now: ctx.now,
        entries: input.entries,
        inTransaction: ctx.trx.isTransaction,
      });
      return Promise.resolve(
        input.entries.map((entry) => ({ userId: entry.userId, outcome: allocator.outcome })),
      );
    },
    reset() {
      allocator.promoteCalls.length = 0;
      allocator.autoEnrolCalls.length = 0;
    },
  };
  return allocator;
}

export interface SessionsScene {
  readonly teamId: string;
  readonly adminId: string;
  readonly memberId: string;
  /** Another team with its own admin: for "never another team's session" checks. */
  readonly otherTeamId: string;
  readonly otherAdminId: string;
}

/** A team (optionally payout-configured) with one approved TEAM_ADMIN and one approved MEMBER, plus a second team. */
export async function createSessionsScene(
  db: Queryable,
  options: Pick<TeamOptions, 'payoutConfigured'> = {},
): Promise<SessionsScene> {
  const label = randomUUID().slice(0, 8);
  const teamId = await insertTeam(db, { name: `Sessions Club ${label}`, ...options });
  const adminId = await insertUser(db, 'FEMALE');
  const memberId = await insertUser(db, 'MALE');
  await insertTeamMember(db, { teamId, userId: adminId, role: 'TEAM_ADMIN' });
  await insertTeamMember(db, { teamId, userId: memberId, role: 'MEMBER' });
  const otherTeamId = await insertTeam(db, { name: `Other Club ${label}` });
  const otherAdminId = await insertUser(db, 'FEMALE');
  await insertTeamMember(db, { teamId: otherTeamId, userId: otherAdminId, role: 'TEAM_ADMIN' });
  return { teamId, adminId, memberId, otherTeamId, otherAdminId };
}
