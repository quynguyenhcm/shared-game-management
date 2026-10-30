/**
 * The seat allocator (architecture Q2, option 2A). The only code that changes seats: register, auto-enrol, withdraw
 * and promote, each in the CALLER's transaction under the D-14 session lock.
 */
import { randomUUID } from 'node:crypto';
import type { Transaction } from 'kysely';
import type { SessionStatus, SkillTier, UserSex } from '@sgm/shared';
import { enqueueEmail } from '../../jobs/send-email.ts';
import { AppError } from '../../lib/http/errors.ts';
import type { DB } from '../../lib/db/types.generated.ts';
import type { JobRunner } from '../../lib/jobs/jobs.ts';
import type { Logger } from '../../lib/logger/logger.ts';
import { assertApprovedMember } from '../teams/membership.ts';
import {
  decideAllocation,
  type AllocationDecision,
  type PartyRef,
  type PartySize,
  type WaitlistEntry,
  type WithdrawalKind,
} from './allocation.ts';
import { classifyWithdrawal, isRegistrationOpen } from './deadline.ts';
import { buildAutoEnrolEmail, buildPromotionEmail, type RegistrationEmailInput } from './emails.ts';
import {
  countOverdueByUser,
  insertRegistrationRow,
  lockSessionRow,
  promoteRegistrations,
  reactivateRegistration,
  readEmailContexts,
  readMemberFacts,
  readOwnRegistration,
  readSessionHeader,
  readSessionRegistrations,
  RegistrationInvariantError,
  type SessionRegistrationRow,
  releaseOwedFees,
  replaceGuests,
  withdrawRegistration,
  type EmailContext,
  type LockedSession,
  type SessionRow,
} from './repo.ts';

export interface AllocatorDeps {
  readonly jobs: Pick<JobRunner, 'enqueue'>;
  readonly webBaseUrl: string;
}

export interface AllocatorContext {
  readonly trx: Transaction<DB>;
  readonly now: Date;
  readonly log: Pick<Logger, 'info' | 'warn' | 'error'>;
}

export interface GuestInput {
  readonly sex: UserSex;
  readonly skillLevel: SkillTier;
  readonly displayName: string | null;
}

export interface PromotedRegistration {
  readonly registrationId: string;
  readonly userId: string;
  readonly promotedAt: Date;
}

export type RegisterRefusal =
  | 'not_found'
  | 'forbidden'
  | 'overdue_payments'
  | 'session_not_open'
  | 'already_registered'
  | 'party_exceeds_capacity'
  | 'late_withdrawal_fee_due';

export type RegisterOutcome =
  | {
      readonly ok: true;
      readonly registrationId: string;
      readonly status: 'CONFIRMED' | 'WAITLISTED';
      readonly queuePosition: number | null;
      readonly waitlistRank: number | null;
      readonly reRegistration: boolean;
      readonly promoted: readonly PromotedRegistration[];
      readonly liabilitiesReleased: number;
    }
  | {
      readonly ok: false;
      readonly reason: RegisterRefusal;
      readonly overdueCount?: number;
      readonly publicCapacity?: number;
    };

export type WithdrawCause = 'player' | 'ban';

export type WithdrawOutcome =
  | {
      readonly ok: true;
      readonly registrationId: string;
      readonly withdrawalKind: 'EARLY' | 'LATE' | 'BANNED';
      readonly feeDue: boolean;
      readonly wasConfirmed: boolean;
      readonly promoted: readonly PromotedRegistration[];
      readonly liabilitiesReleased: number;
    }
  | {
      readonly ok: false;
      readonly reason:
        'not_found' | 'session_not_open' | 'not_registered' | 'cancellation_terms_changed';
    };

export type AutoEnrolReason =
  | 'overdue_payments'
  | 'forbidden'
  | 'already_registered'
  | 'auto_enroll_changed'
  | 'not_found'
  | 'session_not_open'
  | 'party_exceeds_capacity'
  | 'deadline_passed';

export type AutoEnrolOutcome =
  | { readonly ok: true; readonly status: 'CONFIRMED' | 'WAITLISTED' }
  | { readonly ok: false; readonly reason: AutoEnrolReason };

export interface AutoEnrolInputEntry {
  readonly userId: string;
  readonly assignedAt: Date;
  readonly membershipId?: string;
}

export interface Allocator {
  registerInSession(
    ctx: AllocatorContext,
    input: {
      readonly teamId: string;
      readonly sessionId: string;
      readonly userId: string;
      readonly guests: readonly GuestInput[];
    },
  ): Promise<RegisterOutcome>;
  autoEnrolInSession(
    ctx: AllocatorContext,
    input: {
      readonly teamId: string;
      readonly sessionId: string;
      readonly entries: readonly AutoEnrolInputEntry[];
      /** O8: false places as usual but queues no R17 auto-enrol email (`game_sessions.auto_enrol_notify`, D-86). */
      readonly notify: boolean;
    },
  ): Promise<readonly { readonly userId: string; readonly outcome: AutoEnrolOutcome }[]>;
  withdrawFromSession(
    ctx: AllocatorContext,
    input: {
      readonly teamId: string;
      readonly sessionId: string;
      readonly userId: string;
      readonly cause: WithdrawCause;
      /** R9: the caller's view of the terms; a LATE classification with `false` is refused. */
      readonly expectLate?: boolean;
    },
  ): Promise<WithdrawOutcome>;
  promoteWaitlist(
    ctx: AllocatorContext,
    input: { readonly teamId: string; readonly sessionId: string },
  ): Promise<readonly PromotedRegistration[]>;
}

/** Three OVERDUE payments or more block a new registration (workflows section 1). */
export const DEBT_LIMIT = 3;

type Trx = Transaction<DB>;
type Applied = Extract<AllocationDecision, { outcome: 'applied' }>;
type PromoteCause = 'withdrawal' | 'ban' | 'capacity' | 'register' | 'auto_enrol';

export interface SessionState {
  readonly confirmed: PartyRef[];
  readonly waitlist: (WaitlistEntry & { readonly userId: string })[];
  /** Owed late withdrawals, oldest first. */
  readonly owed: (PartyRef & { readonly userId: string })[];
  /**
   * The highest queue position held by ANY waitlisted row, including a banned member's not yet withdrawn: a new position must
   * clear it, or the unique `(session_id, queue_position)` index would refuse the insert.
   */
  readonly maxQueuePosition: number;
}

const partySizeOf = (row: SessionRow): PartySize => {
  const size = 1 + row.guestCount;
  if (!Number.isInteger(size) || size < 1 || size > 3) {
    throw new RegistrationInvariantError(
      `registration ${row.id} has a party size of ${size} (guest_count ${row.guestCount}), outside 1..3`,
      row.id,
    );
  }
  return size as PartySize;
};

/** A WAITLISTED row always holds a queue position (CHECK in the schema); a null here is a broken invariant, never a 0. */
const queuePositionOf = (row: SessionRow): number => {
  if (row.queuePosition === null) {
    throw new RegistrationInvariantError(
      `waitlisted registration ${row.id} has no queue position`,
      row.id,
    );
  }
  return row.queuePosition;
};

/** The session's registrations as the pure decision wants them (rows read under the D-14 lock). */
export function buildSessionState(rows: readonly SessionRegistrationRow[]): SessionState {
  return {
    confirmed: rows
      .filter((row) => row.status === 'CONFIRMED')
      .map((row) => ({ registrationId: row.id, partySize: partySizeOf(row) })),
    // A banned member's waitlisted row stays until the ban handler withdraws it: it keeps its place and can be withdrawn, but
    // is never promoted meanwhile (`eligible: false`).
    waitlist: rows
      .filter((row) => row.status === 'WAITLISTED')
      .map((row) => ({
        registrationId: row.id,
        partySize: partySizeOf(row),
        queuePosition: queuePositionOf(row),
        userId: row.userId,
        eligible: row.memberApproved,
      })),
    owed: rows
      .filter((row) => row.status === 'WITHDRAWN' && row.feeDue)
      .sort(
        (a, b) =>
          (a.withdrawnAt?.getTime() ?? 0) - (b.withdrawnAt?.getTime() ?? 0) ||
          a.id.localeCompare(b.id),
      )
      .map((row) => ({ registrationId: row.id, partySize: partySizeOf(row), userId: row.userId })),
    maxQueuePosition: rows.reduce(
      (max, row) => (row.status === 'WAITLISTED' ? Math.max(max, queuePositionOf(row)) : max),
      0,
    ),
  };
}

async function loadState(trx: Trx, sessionId: string): Promise<SessionState> {
  return buildSessionState(await readSessionRegistrations(trx, sessionId));
}

const capacityOf = (session: LockedSession): number => session.max_players - session.reserved_seats;

function assertTransaction(ctx: AllocatorContext): void {
  if (!ctx.trx.isTransaction) {
    throw new Error("the allocator must run inside the caller's transaction");
  }
}

/** `assertApprovedMember` throws `forbidden` after a successful query, so catching it cannot abort the transaction. */
async function gate(
  trx: Trx,
  teamId: string,
  userId: string,
): Promise<{ readonly skillLevel: SkillTier } | null> {
  try {
    const member = await assertApprovedMember(trx, teamId, userId);
    return { skillLevel: member.skillLevel };
  } catch (error) {
    if (error instanceof AppError && error.code === 'forbidden') return null;
    throw error;
  }
}

function toEmailInput(
  context: EmailContext,
  at: Date,
  webBaseUrl: string,
  person: { sex: UserSex; skillLevel: SkillTier } | null,
): RegistrationEmailInput | null {
  if (context.startsAt === null) return null;
  const s = context.session;
  return {
    to: context.to,
    teamId: context.teamId,
    teamName: context.teamName,
    sessionId: context.sessionId,
    registrationId: context.registrationId,
    location: context.location,
    address: context.address,
    startsAt: context.startsAt,
    cancellationDeadline: context.cancellationDeadline,
    at,
    fees: {
      pricing: s.pricing_structure,
      flat: s.fee_flat,
      male: s.fee_male,
      female: s.fee_female,
      other: s.fee_other,
      beginner: s.fee_beginner,
      intermediate: s.fee_intermediate,
      advanced: s.fee_advanced,
    },
    person,
    webBaseUrl,
  };
}

export function createAllocator(deps: AllocatorDeps): Allocator {
  /**
   * Applies the parts of a decision that every path shares, in the algorithm doc's order: promotions, then released fees,
   * then one promotion email per promoted registrant, all in the caller's transaction (P5). This is the ONLY promotion step:
   * every mutation ends here, and `promoteWaitlist` is its exported wrapper, so the first-fit invariant heals itself.
   */
  async function settle(
    ctx: AllocatorContext,
    session: LockedSession,
    decision: Applied,
    cause: PromoteCause,
  ): Promise<{ promoted: PromotedRegistration[]; released: number }> {
    const { trx, now, log } = ctx;
    const promotedRows = await promoteRegistrations(trx, {
      ids: decision.promotions.map((promotion) => promotion.registrationId),
      now,
    });
    await releaseOwedFees(trx, { ids: decision.releasedLiabilities, now });
    const promoted: PromotedRegistration[] = promotedRows.map((row) => ({
      registrationId: row.registrationId,
      userId: row.userId,
      promotedAt: row.promotedAt,
    }));
    if (promoted.length > 0) {
      const contexts = await readEmailContexts(
        trx,
        promoted.map((row) => row.registrationId),
      );
      for (const row of promoted) {
        const context = contexts.find(
          (candidate) => candidate.registrationId === row.registrationId,
        );
        const person =
          context?.snapshotSex != null && context.snapshotSkillLevel != null
            ? { sex: context.snapshotSex, skillLevel: context.snapshotSkillLevel }
            : null;
        const email =
          context === undefined ? null : toEmailInput(context, now, deps.webBaseUrl, person);
        if (email !== null) await enqueueEmail(deps.jobs, buildPromotionEmail(email), { trx });
        log.info(
          {
            event: 'registration.promoted',
            teamId: session.team_id,
            sessionId: session.id,
            registrationId: row.registrationId,
            userId: row.userId,
            cause,
            liabilitiesReleased: decision.releasedLiabilities.length,
          },
          'waitlisted registration promoted',
        );
      }
    }
    return { promoted, released: decision.releasedLiabilities.length };
  }

  function refuse<R extends string>(
    ctx: AllocatorContext,
    ids: { teamId: string; sessionId: string; userId?: string },
    reason: R,
    extra: Record<string, unknown> = {},
  ): { ok: false; reason: R } & Record<string, unknown> {
    const line = { event: 'registration.refused', ...ids, reason };
    // A refused gate is a security-relevant signal; the rest are ordinary outcomes.
    if (reason === 'forbidden') ctx.log.warn(line, 'registration refused');
    else ctx.log.info(line, 'registration refused');
    return { ok: false, reason, ...extra };
  }

  /** Places one party (the register decision applied): row write, guests, snapshot, then the shared promotion step. */
  async function place(
    ctx: AllocatorContext,
    session: LockedSession,
    state: SessionState,
    input: {
      readonly userId: string;
      readonly own: SessionRow | undefined;
      readonly guests: readonly GuestInput[];
      readonly source: 'MEMBER' | 'AUTO_ENROL';
      readonly snapshot: { skillLevel: SkillTier; sex: UserSex };
      readonly cause: PromoteCause;
    },
  ): Promise<
    | { ok: true; outcome: Extract<RegisterOutcome, { ok: true }>; registrationId: string }
    | {
        ok: false;
        reason: 'already_registered' | 'party_exceeds_capacity' | 'late_withdrawal_fee_due';
      }
  > {
    const { trx, now } = ctx;
    const { own } = input;
    const registrationId = own?.id ?? randomUUID();
    const partySize = (1 + input.guests.length) as PartySize;
    const owedElsewhere = state.owed.filter((row) => row.registrationId !== registrationId);
    const decision = decideAllocation({
      publicCapacity: capacityOf(session),
      confirmedParties: state.confirmed,
      waitlist: state.waitlist,
      openLiabilities: owedElsewhere,
      request: {
        kind: 'register',
        registrationId,
        partySize,
        liablePriorPartySize:
          own !== undefined && own.status === 'WITHDRAWN' && own.feeDue ? partySizeOf(own) : null,
      },
    });
    if (decision.outcome === 'refused') {
      // `not_registered` belongs to withdrawals; a register decision never returns it.
      if (decision.reason === 'not_registered')
        throw new Error('a register decision cannot be not_registered');
      return { ok: false, reason: decision.reason };
    }
    const newcomer = decision.newcomer;
    if (newcomer === null) throw new Error('a register decision always places the newcomer');

    const confirmed = newcomer.status === 'CONFIRMED';
    const queuePosition =
      newcomer.status === 'WAITLISTED'
        ? Math.max(newcomer.queuePosition, state.maxQueuePosition + 1)
        : null;
    const row = {
      status: newcomer.status,
      queuePosition,
      guestCount: input.guests.length,
      source: input.source,
      now,
      snapshot: confirmed ? input.snapshot : null,
    } as const;
    if (own === undefined) {
      await insertRegistrationRow(trx, {
        ...row,
        id: registrationId,
        sessionId: session.id,
        teamId: session.team_id,
        userId: input.userId,
      });
    } else {
      await reactivateRegistration(trx, { ...row, id: registrationId });
    }
    await replaceGuests(trx, registrationId, input.guests);
    const settled = await settle(ctx, session, decision, input.cause);
    const promotedIds = new Set(settled.promoted.map((one) => one.registrationId));
    // Rank = 1 + the waitlisted parties still waiting after this step. The newcomer joins at the tail, so each of them is ahead.
    const waitlistRank =
      newcomer.status === 'WAITLISTED'
        ? 1 + state.waitlist.filter((entry) => !promotedIds.has(entry.registrationId)).length
        : null;
    return {
      ok: true,
      registrationId,
      outcome: {
        ok: true,
        registrationId,
        status: newcomer.status,
        queuePosition,
        waitlistRank,
        reRegistration: own !== undefined,
        promoted: settled.promoted,
        liabilitiesReleased: settled.released,
      },
    };
  }

  function logCreated(
    ctx: AllocatorContext,
    session: LockedSession,
    userId: string,
    outcome: Extract<RegisterOutcome, { ok: true }>,
    partySize: number,
    source: 'MEMBER' | 'AUTO_ENROL',
  ): void {
    ctx.log.info(
      {
        event: 'registration.created',
        teamId: session.team_id,
        sessionId: session.id,
        userId,
        registrationId: outcome.registrationId,
        status: outcome.status,
        partySize,
        reRegistration: outcome.reRegistration,
        source,
        promotedCount: outcome.promoted.length,
        liabilitiesReleased: outcome.liabilitiesReleased,
      },
      'registration created',
    );
  }

  /** The not-open classification shared by every path that has the locked session: `not_found` (absent or DRAFT) or `session_not_open`. */
  function closedReason(
    session: LockedSession | undefined,
    now: Date,
  ): 'not_found' | 'session_not_open' | null {
    if (session === undefined || session.status === ('DRAFT' satisfies SessionStatus))
      return 'not_found';
    return isRegistrationOpen(now, { status: session.status, startsAt: session.starts_at })
      ? null
      : 'session_not_open';
  }

  return {
    async registerInSession(ctx, input) {
      assertTransaction(ctx);
      if (input.guests.length > 2) throw new Error('a party has at most 2 guests');
      const { trx, now } = ctx;
      const ids = { teamId: input.teamId, sessionId: input.sessionId, userId: input.userId };
      // 1. the debt read (no lock); 2. the member gate, before any session lock (ADR 0015).
      const overdueCount = (await countOverdueByUser(trx, [input.userId])).get(input.userId) ?? 0;
      const member = await gate(trx, input.teamId, input.userId);
      if (member === null) return refuse(ctx, ids, 'forbidden');
      if (overdueCount >= DEBT_LIMIT) return refuse(ctx, ids, 'overdue_payments', { overdueCount });
      const facts = await readMemberFacts(trx, input.teamId, input.userId);
      if (facts === undefined) return refuse(ctx, ids, 'forbidden');

      // 3. the D-14 lock
      const session = await lockSessionRow(trx, input);
      const closed = closedReason(session, now);
      if (closed !== null || session === undefined) return refuse(ctx, ids, closed ?? 'not_found');

      // 4. read, 5. decide, 6-8. write, promote, enqueue
      const state = await loadState(trx, session.id);
      const own = await readOwnRegistration(trx, session.id, input.userId);
      const placed = await place(ctx, session, state, {
        userId: input.userId,
        own,
        guests: input.guests,
        source: 'MEMBER',
        snapshot: { skillLevel: member.skillLevel, sex: facts.sex },
        cause: 'register',
      });
      if (!placed.ok) {
        return refuse(ctx, ids, placed.reason, {
          ...(placed.reason === 'party_exceeds_capacity'
            ? { publicCapacity: capacityOf(session) }
            : {}),
        });
      }
      logCreated(ctx, session, input.userId, placed.outcome, 1 + input.guests.length, 'MEMBER');
      return placed.outcome;
    },

    async autoEnrolInSession(ctx, input) {
      assertTransaction(ctx);
      const { trx, now } = ctx;
      const ids = { teamId: input.teamId, sessionId: input.sessionId };
      const outcomes = new Map<number, AutoEnrolOutcome>();
      const skip = (index: number, userId: string, reason: AutoEnrolReason): void => {
        refuse(ctx, { ...ids, userId }, reason, { source: 'AUTO_ENROL' });
        outcomes.set(index, { ok: false, reason });
      };
      const settleAll = (): readonly { userId: string; outcome: AutoEnrolOutcome }[] =>
        input.entries.map((entry, index) => ({
          userId: entry.userId,
          outcome: outcomes.get(index) ?? { ok: false, reason: 'not_found' },
        }));
      if (input.entries.length === 0) return [];

      // A missing or DRAFT session: nobody is gated and nobody is placed.
      const header = await readSessionHeader(trx, input);
      if (header === undefined || header.status === 'DRAFT') {
        input.entries.forEach((entry, index) => skip(index, entry.userId, 'not_found'));
        return settleAll();
      }

      // 1. debt counts for the whole batch (no lock); 2. every member gated, in caller order, before the session lock.
      const overdue = await countOverdueByUser(
        trx,
        input.entries.map((entry) => entry.userId),
      );
      const gated: {
        index: number;
        userId: string;
        skillLevel: SkillTier;
        sex: UserSex;
        autoEnrollUntil: typeof header.date | null;
      }[] = [];
      for (const [index, entry] of input.entries.entries()) {
        const member = await gate(trx, input.teamId, entry.userId);
        const facts =
          member === null ? undefined : await readMemberFacts(trx, input.teamId, entry.userId);
        if (member === null || facts === undefined) {
          skip(index, entry.userId, 'forbidden');
          continue;
        }
        // R16: the opt-out is re-checked under the member row lock the gate holds.
        const stillOn =
          facts.isAutoEnroll &&
          (facts.autoEnrollUntil === null || facts.autoEnrollUntil >= header.date) &&
          facts.autoEnrollAssignedAt !== null &&
          facts.autoEnrollAssignedAt.getTime() === entry.assignedAt.getTime();
        if (!stillOn) {
          skip(index, entry.userId, 'auto_enroll_changed');
          continue;
        }
        if ((overdue.get(entry.userId) ?? 0) >= DEBT_LIMIT) {
          skip(index, entry.userId, 'overdue_payments');
          continue;
        }
        gated.push({
          index,
          userId: entry.userId,
          skillLevel: member.skillLevel,
          sex: facts.sex,
          autoEnrollUntil: facts.autoEnrollUntil,
        });
      }
      if (gated.length === 0) return settleAll();

      // 3. the one session lock
      const session = await lockSessionRow(trx, input);
      const closed = closedReason(session, now);
      if (closed !== null || session === undefined) {
        for (const member of gated) skip(member.index, member.userId, closed ?? 'not_found');
        return settleAll();
      }

      // O5 (human ruling 2026-10-25): once the free-cancellation deadline has passed, auto-enrol adds nobody, CONFIRMED or
      // WAITLISTED, so no member is enrolled into a late-fee position. The LOCKED row is judged (a deadline edit may have
      // committed since the header read) and `now <= deadline` still enrols, matching `classifyWithdrawal`. Manual
      // registration and waitlist promotion are not affected.
      if (now.getTime() > session.cancellation_deadline.getTime()) {
        for (const member of gated) skip(member.index, member.userId, 'deadline_passed');
        return settleAll();
      }

      // 4-8. place each gated member in order, re-reading the state each time (a placement changes it)
      for (const member of gated) {
        // C1: `header.date` was read before the lock; a date edit may have committed since. The member's own flags are
        // held by the gate, so the only date-dependent fact left to re-validate is the expiry against the LOCKED date.
        if (member.autoEnrollUntil !== null && member.autoEnrollUntil < session.date) {
          skip(member.index, member.userId, 'auto_enroll_changed');
          continue;
        }
        const own = await readOwnRegistration(trx, session.id, member.userId);
        // R21: a row in ANY status means the member was here before: skip, never re-activate or relabel.
        if (own !== undefined) {
          skip(member.index, member.userId, 'already_registered');
          continue;
        }
        const state = await loadState(trx, session.id);
        const placed = await place(ctx, session, state, {
          userId: member.userId,
          own: undefined,
          guests: [],
          source: 'AUTO_ENROL',
          snapshot: { skillLevel: member.skillLevel, sex: member.sex },
          cause: 'auto_enrol',
        });
        if (!placed.ok) {
          // `late_withdrawal_fee_due` needs a prior row, which this path never has; the type system cannot say so.
          skip(
            member.index,
            member.userId,
            placed.reason === 'late_withdrawal_fee_due' ? 'already_registered' : placed.reason,
          );
          continue;
        }
        outcomes.set(member.index, { ok: true, status: placed.outcome.status });
        logCreated(ctx, session, member.userId, placed.outcome, 1, 'AUTO_ENROL');
        // O8 (human ruling 2026-10-26): the pre-deploy backlog is enrolled silently. The placement, its log line and the
        // "Added automatically (Auto Enroll)" label are unchanged; only the R17 email is not queued. SSE logs the count.
        if (!input.notify) continue;
        const [context] = await readEmailContexts(trx, [placed.registrationId]);
        const email =
          context === undefined
            ? null
            : toEmailInput(context, now, deps.webBaseUrl, {
                sex: member.sex,
                skillLevel: member.skillLevel,
              });
        if (email !== null) {
          await enqueueEmail(
            deps.jobs,
            buildAutoEnrolEmail({ ...email, status: placed.outcome.status }),
            { trx },
          );
        }
      }
      return settleAll();
    },

    async withdrawFromSession(ctx, input) {
      assertTransaction(ctx);
      const { trx, now } = ctx;
      const ids = { teamId: input.teamId, sessionId: input.sessionId, userId: input.userId };
      const session = await lockSessionRow(trx, input);
      const closed = closedReason(session, now);
      if (closed !== null || session === undefined) return refuse(ctx, ids, closed ?? 'not_found');

      const own = await readOwnRegistration(trx, session.id, input.userId);
      if (own === undefined || own.status === 'WITHDRAWN')
        return refuse(ctx, ids, 'not_registered');
      const kind: WithdrawalKind =
        input.cause === 'ban'
          ? 'BANNED'
          : classifyWithdrawal(now, { cancellationDeadline: session.cancellation_deadline });
      // R9: the deadline passed while the player's confirmation was open; they must see the late terms first.
      if (input.cause === 'player' && input.expectLate === false && kind === 'LATE') {
        return refuse(ctx, ids, 'cancellation_terms_changed');
      }
      const state = await loadState(trx, session.id);
      const decision = decideAllocation({
        publicCapacity: capacityOf(session),
        confirmedParties: state.confirmed,
        waitlist: state.waitlist,
        openLiabilities: state.owed,
        request: { kind: 'withdraw', registrationId: own.id, withdrawalKind: kind },
      });
      if (decision.outcome === 'refused' || decision.withdrawn === null)
        return refuse(ctx, ids, 'not_registered');

      await withdrawRegistration(trx, {
        id: own.id,
        from: decision.withdrawn.fromStatus,
        kind,
        feeDue: decision.withdrawn.feeDue,
        now,
      });
      const settled = await settle(
        ctx,
        session,
        decision,
        input.cause === 'ban' ? 'ban' : 'withdrawal',
      );
      ctx.log.info(
        {
          event: 'registration.withdrawn',
          ...ids,
          registrationId: own.id,
          withdrawalKind: kind,
          feeDue: decision.withdrawn.feeDue,
          wasConfirmed: decision.withdrawn.fromStatus === 'CONFIRMED',
          promotedCount: settled.promoted.length,
          liabilitiesReleased: settled.released,
        },
        'registration withdrawn',
      );
      return {
        ok: true,
        registrationId: own.id,
        withdrawalKind: kind,
        feeDue: decision.withdrawn.feeDue,
        wasConfirmed: decision.withdrawn.fromStatus === 'CONFIRMED',
        promoted: settled.promoted,
        liabilitiesReleased: settled.released,
      };
    },

    async promoteWaitlist(ctx, input) {
      assertTransaction(ctx);
      const { trx, now } = ctx;
      // Re-entrant: a caller that already holds the session lock (capacity edit, series propagation) takes it again for free.
      const session = await lockSessionRow(trx, input);
      if (
        session === undefined ||
        session.status !== 'PUBLISHED' ||
        !isRegistrationOpen(now, { status: session.status, startsAt: session.starts_at })
      ) {
        return [];
      }
      const state = await loadState(trx, session.id);
      const decision = decideAllocation({
        publicCapacity: capacityOf(session),
        confirmedParties: state.confirmed,
        waitlist: state.waitlist,
        openLiabilities: state.owed,
        request: { kind: 'rebalance' },
      });
      if (decision.outcome === 'refused') return [];
      return (await settle(ctx, session, decision, 'capacity')).promoted;
    },
  };
}
