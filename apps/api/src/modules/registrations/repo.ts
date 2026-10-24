/**
 * SQL for the registrations module. This is the ONLY file that writes `registrations` and `registration_guests`
 * (structural guard: `boundaries.test.ts`); the allocator calls these functions under the D-14 session lock and nothing
 * else may. Every write takes the operation's single `now` as a bound parameter, never `now()` (P3), and every row
 * transition is guarded by the status it expects, so a lost race or a path that skipped the lock throws instead of
 * overwriting (P1).
 *
 * The only table outside the registration family this file touches is `payments`, read-only, for the OVERDUE debt count.
 */
import { sql, type Kysely, type Selectable, type Transaction } from 'kysely';
import type { LocalDate, SkillTier, UserSex } from '@sgm/shared';
import type { DB, GameSessions } from '../../lib/db/types.generated.ts';

type Trx = Transaction<DB>;

/** Thrown when a guarded write does not touch the rows the decision said it would: another path broke the lock contract. */
export class RegistrationInvariantError extends Error {
  constructor(
    message: string,
    readonly registrationId?: string,
  ) {
    super(message);
    this.name = 'RegistrationInvariantError';
  }
}

export type LockedSession = Selectable<GameSessions>;

// ---------------------------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------------------------

/** `SELECT ... FROM game_sessions WHERE id = $1 FOR UPDATE` (D-14), scoped to the team: another team's id is simply absent. */
export function lockSessionRow(
  trx: Trx,
  input: { readonly sessionId: string; readonly teamId: string },
): Promise<LockedSession | undefined> {
  return trx
    .selectFrom('game_sessions')
    .selectAll()
    .where('id', '=', input.sessionId)
    .where('team_id', '=', input.teamId)
    .forUpdate()
    .executeTakeFirst();
}

/** The session's calendar date and status without a lock (the auto-enrol re-check runs before the session lock). */
export function readSessionHeader(
  trx: Trx,
  input: { readonly sessionId: string; readonly teamId: string },
): Promise<{ readonly date: LocalDate; readonly status: LockedSession['status'] } | undefined> {
  return trx
    .selectFrom('game_sessions')
    .select(['date', 'status'])
    .where('id', '=', input.sessionId)
    .where('team_id', '=', input.teamId)
    .executeTakeFirst();
}

export interface SessionRow {
  readonly id: string;
  readonly userId: string;
  readonly status: 'CONFIRMED' | 'WAITLISTED' | 'WITHDRAWN';
  readonly guestCount: number;
  readonly queuePosition: number | null;
  readonly withdrawnAt: Date | null;
  readonly feeDue: boolean;
}

/** A session row plus whether its member is still APPROVED (a banned member's row lingers until the ban job withdraws it). */
export interface SessionRegistrationRow extends SessionRow {
  readonly memberApproved: boolean;
}

/**
 * The rows the decision needs, read under the session lock in one query: CONFIRMED and WAITLISTED rows plus the WITHDRAWN
 * rows whose late fee is still owed (`idx_registrations_session_status`, `idx_registrations_fee_due`). Each row says whether
 * its member is still APPROVED, so the allocator can keep a banned waitlisted member out of a promotion; the plain join
 * takes no lock.
 */
export async function readSessionRegistrations(
  trx: Trx,
  sessionId: string,
): Promise<SessionRegistrationRow[]> {
  const rows = await trx
    .selectFrom('registrations')
    .leftJoin('team_members', (join) =>
      join
        .onRef('team_members.team_id', '=', 'registrations.team_id')
        .onRef('team_members.user_id', '=', 'registrations.user_id'),
    )
    .select([
      'registrations.id',
      'registrations.user_id',
      'registrations.status',
      'registrations.guest_count',
      'registrations.queue_position',
      'registrations.withdrawn_at',
      'registrations.withdrawal_fee_due',
      'team_members.status as member_status',
    ])
    .where('registrations.session_id', '=', sessionId)
    .where((eb) =>
      eb.or([
        eb('registrations.status', 'in', ['CONFIRMED', 'WAITLISTED']),
        eb.and([
          eb('registrations.status', '=', 'WITHDRAWN'),
          eb('registrations.withdrawal_fee_due', '=', true),
        ]),
      ]),
    )
    .execute();
  return rows.map((row) => ({
    id: row.id,
    userId: row.user_id,
    status: row.status,
    guestCount: row.guest_count,
    queuePosition: row.queue_position,
    withdrawnAt: row.withdrawn_at,
    feeDue: row.withdrawal_fee_due,
    memberApproved: row.member_status === 'APPROVED',
  }));
}

/** The caller's own row in any status (`UNIQUE(session_id, user_id)` gives at most one). */
export async function readOwnRegistration(
  trx: Trx,
  sessionId: string,
  userId: string,
): Promise<SessionRow | undefined> {
  const row = await trx
    .selectFrom('registrations')
    .select([
      'id',
      'user_id',
      'status',
      'guest_count',
      'queue_position',
      'withdrawn_at',
      'withdrawal_fee_due',
    ])
    .where('session_id', '=', sessionId)
    .where('user_id', '=', userId)
    .executeTakeFirst();
  return row === undefined
    ? undefined
    : {
        id: row.id,
        userId: row.user_id,
        status: row.status,
        guestCount: row.guest_count,
        queuePosition: row.queue_position,
        withdrawnAt: row.withdrawn_at,
        feeDue: row.withdrawal_fee_due,
      };
}

/** OVERDUE payments per user, across every team (workflows section 1). The one read of a money table. */
export async function countOverdueByUser(
  trx: Trx,
  userIds: readonly string[],
): Promise<Map<string, number>> {
  const counts = new Map<string, number>();
  if (userIds.length === 0) return counts;
  const rows = await trx
    .selectFrom('payments')
    .select(['user_id', (eb) => eb.fn.countAll<string>().as('overdue')])
    .where('status', '=', 'OVERDUE')
    .where('user_id', 'in', [...userIds])
    .groupBy('user_id')
    .execute();
  for (const row of rows) counts.set(row.user_id, Number(row.overdue));
  return counts;
}

export interface MemberFacts {
  readonly sex: UserSex;
  readonly isAutoEnroll: boolean;
  readonly autoEnrollUntil: LocalDate | null;
  readonly autoEnrollAssignedAt: Date | null;
}

/**
 * The member's sex and Auto Enroll columns. A plain read taken AFTER the gate's `team_members FOR SHARE`, which keeps the
 * row from changing until COMMIT, so the values are the ones the gate saw (R15, R16).
 */
export async function readMemberFacts(
  trx: Trx,
  teamId: string,
  userId: string,
): Promise<MemberFacts | undefined> {
  const row = await trx
    .selectFrom('team_members as tm')
    .innerJoin('users as u', 'u.id', 'tm.user_id')
    .select(['u.sex', 'tm.is_auto_enroll', 'tm.auto_enroll_until', 'tm.auto_enroll_assigned_at'])
    .where('tm.team_id', '=', teamId)
    .where('tm.user_id', '=', userId)
    .executeTakeFirst();
  return row === undefined
    ? undefined
    : {
        sex: row.sex,
        isAutoEnroll: row.is_auto_enroll,
        autoEnrollUntil: row.auto_enroll_until,
        autoEnrollAssignedAt: row.auto_enroll_assigned_at,
      };
}

export interface EmailContext {
  readonly registrationId: string;
  readonly userId: string;
  readonly status: 'CONFIRMED' | 'WAITLISTED' | 'WITHDRAWN';
  readonly to: string;
  readonly teamId: string;
  readonly teamName: string;
  readonly sessionId: string;
  readonly location: string;
  readonly address: string;
  readonly startsAt: Date | null;
  readonly cancellationDeadline: Date;
  readonly session: LockedSessionFees;
  readonly snapshotSex: UserSex | null;
  readonly snapshotSkillLevel: SkillTier | null;
}

export type LockedSessionFees = Pick<
  LockedSession,
  | 'pricing_structure'
  | 'fee_flat'
  | 'fee_male'
  | 'fee_female'
  | 'fee_other'
  | 'fee_beginner'
  | 'fee_intermediate'
  | 'fee_advanced'
>;

/** What an email about these registrations needs: the recipient, the team and the session. Plain reads, no locks. */
export async function readEmailContexts(
  trx: Trx,
  registrationIds: readonly string[],
): Promise<EmailContext[]> {
  if (registrationIds.length === 0) return [];
  const rows = await trx
    .selectFrom('registrations as r')
    .innerJoin('users as u', 'u.id', 'r.user_id')
    .innerJoin('teams as t', 't.id', 'r.team_id')
    .innerJoin('game_sessions as s', 's.id', 'r.session_id')
    .select([
      'r.id as registration_id',
      'r.user_id',
      'r.status',
      'r.team_id',
      'r.session_id',
      'r.registrant_sex',
      'r.registrant_skill_level',
      'u.email',
      't.name as team_name',
      's.location',
      's.address',
      's.starts_at',
      's.cancellation_deadline',
      's.pricing_structure',
      's.fee_flat',
      's.fee_male',
      's.fee_female',
      's.fee_other',
      's.fee_beginner',
      's.fee_intermediate',
      's.fee_advanced',
    ])
    .where('r.id', 'in', [...registrationIds])
    .execute();
  return rows.map((row) => ({
    registrationId: row.registration_id,
    userId: row.user_id,
    status: row.status,
    to: row.email,
    teamId: row.team_id,
    teamName: row.team_name,
    sessionId: row.session_id,
    location: row.location,
    address: row.address,
    startsAt: row.starts_at,
    cancellationDeadline: row.cancellation_deadline,
    session: {
      pricing_structure: row.pricing_structure,
      fee_flat: row.fee_flat,
      fee_male: row.fee_male,
      fee_female: row.fee_female,
      fee_other: row.fee_other,
      fee_beginner: row.fee_beginner,
      fee_intermediate: row.fee_intermediate,
      fee_advanced: row.fee_advanced,
    },
    snapshotSex: row.registrant_sex,
    snapshotSkillLevel: row.registrant_skill_level,
  }));
}

// ---------------------------------------------------------------------------------------------
// Writes (every one is guarded by the status it expects)
// ---------------------------------------------------------------------------------------------

export interface PricingSnapshot {
  readonly skillLevel: SkillTier;
  readonly sex: UserSex;
}

export interface GuestRow {
  readonly sex: UserSex;
  readonly skillLevel: SkillTier;
  readonly displayName: string | null;
}

/** A first registration: INSERT the row (the snapshot rides the INSERT when it is CONFIRMED, R15). */
export async function insertRegistrationRow(
  trx: Trx,
  input: {
    readonly id: string;
    readonly sessionId: string;
    readonly teamId: string;
    readonly userId: string;
    readonly status: 'CONFIRMED' | 'WAITLISTED';
    readonly queuePosition: number | null;
    readonly guestCount: number;
    readonly source: 'MEMBER' | 'AUTO_ENROL';
    readonly now: Date;
    readonly snapshot: PricingSnapshot | null;
  },
): Promise<void> {
  await trx
    .insertInto('registrations')
    .values({
      id: input.id,
      session_id: input.sessionId,
      team_id: input.teamId,
      user_id: input.userId,
      status: input.status,
      queue_position: input.queuePosition,
      guest_count: input.guestCount,
      source: input.source,
      registered_at: input.now,
      updated_at: input.now,
      registrant_skill_level: input.snapshot?.skillLevel ?? null,
      registrant_sex: input.snapshot?.sex ?? null,
    })
    .execute();
}

/**
 * Re-registration reuses the one row `UNIQUE(session_id, user_id)` allows: WITHDRAWN -> CONFIRMED | WAITLISTED. One UPDATE
 * clears every withdrawal stamp and the owed fee, nulls `promoted_at` (a re-queued row is WAITLISTED, which forbids it, and a
 * re-take is not a promotion), takes the new guest count and source, and re-takes the pricing snapshot only when CONFIRMED.
 */
export async function reactivateRegistration(
  trx: Trx,
  input: {
    readonly id: string;
    readonly status: 'CONFIRMED' | 'WAITLISTED';
    readonly queuePosition: number | null;
    readonly guestCount: number;
    readonly source: 'MEMBER' | 'AUTO_ENROL';
    readonly now: Date;
    readonly snapshot: PricingSnapshot | null;
  },
): Promise<void> {
  const result = await trx
    .updateTable('registrations')
    .set({
      status: input.status,
      queue_position: input.queuePosition,
      guest_count: input.guestCount,
      source: input.source,
      registered_at: input.now,
      updated_at: input.now,
      promoted_at: null,
      withdrawn_at: null,
      withdrawal_kind: null,
      withdrawal_fee_due: false,
      ...(input.snapshot === null
        ? {}
        : {
            registrant_skill_level: input.snapshot.skillLevel,
            registrant_sex: input.snapshot.sex,
          }),
    })
    .where('id', '=', input.id)
    .where('status', '=', 'WITHDRAWN')
    .executeTakeFirst();
  if (Number(result.numUpdatedRows) !== 1) {
    throw new RegistrationInvariantError(
      `registration ${input.id} was not WITHDRAWN when re-registered`,
    );
  }
}

/** Replaces a row's guests (re-registration) or writes its first ones. The deferred D-13 trigger checks the count at COMMIT. */
export async function replaceGuests(
  trx: Trx,
  registrationId: string,
  guests: readonly GuestRow[],
): Promise<void> {
  await trx
    .deleteFrom('registration_guests')
    .where('registration_id', '=', registrationId)
    .execute();
  if (guests.length === 0) return;
  await trx
    .insertInto('registration_guests')
    .values(
      guests.map((guest, index) => ({
        registration_id: registrationId,
        position: index + 1,
        sex: guest.sex,
        skill_level: guest.skillLevel,
        display_name: guest.displayName,
      })),
    )
    .execute();
}

/** CONFIRMED | WAITLISTED -> WITHDRAWN, stamped from `now`; `feeDue` is true only for a LATE withdrawal nobody replaced. */
export async function withdrawRegistration(
  trx: Trx,
  input: {
    readonly id: string;
    readonly from: 'CONFIRMED' | 'WAITLISTED';
    readonly kind: 'EARLY' | 'LATE' | 'BANNED';
    readonly feeDue: boolean;
    readonly now: Date;
  },
): Promise<void> {
  const result = await trx
    .updateTable('registrations')
    .set({
      status: 'WITHDRAWN',
      queue_position: null,
      withdrawn_at: input.now,
      withdrawal_kind: input.kind,
      withdrawal_fee_due: input.feeDue,
      updated_at: input.now,
    })
    .where('id', '=', input.id)
    .where('status', '=', input.from)
    .executeTakeFirst();
  if (Number(result.numUpdatedRows) !== 1) {
    throw new RegistrationInvariantError(
      `registration ${input.id} was not ${input.from} when withdrawn`,
    );
  }
}

export interface PromotedRow {
  readonly registrationId: string;
  readonly userId: string;
  readonly promotedAt: Date;
}

/**
 * WAITLISTED -> CONFIRMED for each id, stamped `promoted_at = now` with `queue_position` cleared. The R15 snapshot is read in
 * the same UPDATE from `team_members.skill_level` and `users.sex` (plain subselects: no lock, so the lock order is kept).
 * Only `allocator.ts` imports this: `promoteWaitlist` is the only promoter.
 */
export async function promoteRegistrations(
  trx: Trx,
  input: { readonly ids: readonly string[]; readonly now: Date },
): Promise<PromotedRow[]> {
  if (input.ids.length === 0) return [];
  const rows = await trx
    .updateTable('registrations')
    .set((eb) => ({
      status: 'CONFIRMED' as const,
      queue_position: null,
      promoted_at: input.now,
      updated_at: input.now,
      registrant_skill_level: eb
        .selectFrom('team_members')
        .select('team_members.skill_level')
        .whereRef('team_members.team_id', '=', 'registrations.team_id')
        .whereRef('team_members.user_id', '=', 'registrations.user_id'),
      registrant_sex: eb
        .selectFrom('users')
        .select('users.sex')
        .whereRef('users.id', '=', 'registrations.user_id'),
    }))
    .where('id', 'in', [...input.ids])
    .where('status', '=', 'WAITLISTED')
    .returning(['id', 'user_id'])
    .execute();
  if (rows.length !== input.ids.length) {
    throw new RegistrationInvariantError(
      `promoted ${rows.length} of ${input.ids.length} waitlisted registrations`,
    );
  }
  // RETURNING order is unspecified: hand the rows back in the decision's (queue) order.
  return input.ids.map((id) => {
    const row = rows.find((candidate) => candidate.id === id);
    if (row === undefined)
      throw new RegistrationInvariantError(`registration ${id} was not promoted`);
    return { registrationId: id, userId: row.user_id, promotedAt: input.now };
  });
}

/** R2: releases owed late fees (true -> false, never back); the guard makes a row released twice an invariant error. */
export async function releaseOwedFees(
  trx: Trx,
  input: { readonly ids: readonly string[]; readonly now: Date },
): Promise<void> {
  if (input.ids.length === 0) return;
  const result = await trx
    .updateTable('registrations')
    .set({ withdrawal_fee_due: false, updated_at: input.now })
    .where('id', 'in', [...input.ids])
    .where('status', '=', 'WITHDRAWN')
    .where('withdrawal_fee_due', '=', true)
    .executeTakeFirst();
  if (Number(result.numUpdatedRows) !== input.ids.length) {
    throw new RegistrationInvariantError('released a late fee that was not owed');
  }
}

// ---------------------------------------------------------------------------------------------
// The ban handler's selection and the reconciliation sweep's scan (architecture Q4). Both read current state with no lock and
// both are served by `idx_registrations_active_member` (D-51); the withdrawal itself re-checks everything under the lock.
// ---------------------------------------------------------------------------------------------

export interface BanTarget {
  readonly sessionId: string;
  readonly startsAt: Date;
}

/**
 * The member's active registrations in the team's future PUBLISHED sessions, in `(starts_at, id)` order. A started, cancelled,
 * completed or draft session is never selected (P-2): the ban leaves those rows as they are.
 */
export async function listBanTargets(
  db: Kysely<DB>,
  input: { readonly teamId: string; readonly userId: string },
  now: Date,
): Promise<readonly BanTarget[]> {
  const rows = await db
    .selectFrom('registrations as r')
    .innerJoin('game_sessions as s', 's.id', 'r.session_id')
    .select(['s.id as session_id', 's.starts_at as starts_at'])
    .where('r.team_id', '=', input.teamId)
    .where('r.user_id', '=', input.userId)
    .where('r.status', 'in', ['CONFIRMED', 'WAITLISTED'])
    .where('s.team_id', '=', input.teamId)
    .where('s.status', '=', 'PUBLISHED')
    .where('s.starts_at', '>', now)
    .orderBy('s.starts_at')
    .orderBy('s.id')
    .execute();
  // `starts_at > now` already excludes a NULL; the guard only narrows the generated column type.
  return rows.flatMap((row) =>
    row.starts_at === null ? [] : [{ sessionId: row.session_id, startsAt: row.starts_at }],
  );
}

export interface BannedCandidate {
  readonly membershipId: string;
  readonly teamId: string;
  readonly userId: string;
  readonly bannedBy: string | null;
  readonly bannedAt: Date;
}

/**
 * BANNED memberships that still hold an active registration in a future PUBLISHED session of their own team, oldest ban first,
 * after the keyset `after` (`banned_at, id`). Handled members drop out of the set, so a page boundary is stable.
 */
export async function listBannedWithActive(
  db: Kysely<DB>,
  input: {
    readonly now: Date;
    readonly limit: number;
    readonly after?: { readonly bannedAt: Date; readonly membershipId: string } | undefined;
  },
): Promise<readonly BannedCandidate[]> {
  let query = db
    .selectFrom('team_members as tm')
    .select(['tm.id', 'tm.team_id', 'tm.user_id', 'tm.banned_by', 'tm.banned_at'])
    .where('tm.status', '=', 'BANNED')
    .where((eb) =>
      eb.exists(
        eb
          .selectFrom('registrations as r')
          .innerJoin('game_sessions as s', 's.id', 'r.session_id')
          .select(sql<number>`1`.as('one'))
          .whereRef('r.team_id', '=', 'tm.team_id')
          .whereRef('r.user_id', '=', 'tm.user_id')
          .where('r.status', 'in', ['CONFIRMED', 'WAITLISTED'])
          .whereRef('s.team_id', '=', 'tm.team_id')
          .where('s.status', '=', 'PUBLISHED')
          .where('s.starts_at', '>', input.now),
      ),
    );
  if (input.after !== undefined) {
    const { bannedAt, membershipId } = input.after;
    query = query.where(sql<boolean>`(tm.banned_at, tm.id) > (${bannedAt}, ${membershipId})`);
  }
  const rows = await query.orderBy('tm.banned_at').orderBy('tm.id').limit(input.limit).execute();
  // A BANNED row always carries `banned_at` (D-41); the guard only narrows the column's nullable type.
  return rows.flatMap((row) =>
    row.banned_at === null
      ? []
      : [
          {
            membershipId: row.id,
            teamId: row.team_id,
            userId: row.user_id,
            bannedBy: row.banned_by,
            bannedAt: row.banned_at,
          },
        ],
  );
}
