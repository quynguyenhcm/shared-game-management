/**
 * The player dashboard's read queries (player-dashboard Phase 1): plain SELECTs, no locks, no writes (the structural guard in
 * `boundaries.test.ts` fails on any). Every query is scoped by the authenticated caller's id: `r.user_id = caller` for
 * registrations, and for sessions only through the caller's own APPROVED `team_members` row, so another player's registration,
 * guest or payment is simply never selected. No email address, bank detail or payment token is selected.
 */
import { sql, type Kysely, type Transaction } from 'kysely';
import type { FeePerson, SessionFeeColumns } from '@sgm/shared';
import type { DB, PaymentStatus, RegistrationStatus } from '../../lib/db/types.generated.ts';
import { KEYSET_TIME_FORMAT, type KeysetPosition } from '../../lib/http/cursor.ts';
import { feeColumnsOf } from '../registrations/read-model.ts';

type Trx = Transaction<DB> | Kysely<DB>;

export interface OpenSessionRecord {
  readonly id: string;
  readonly teamId: string;
  readonly teamName: string;
  readonly location: string;
  readonly address: string;
  readonly startsAt: Date;
  readonly endsAt: Date | null;
  readonly maxPlayers: number;
  readonly reservedSeats: number;
  readonly fees: SessionFeeColumns;
  /** The caller's current sex and level in this team: the pricing person when they hold no snapshot. */
  readonly person: FeePerson;
}

/** The next `limit + 1` PUBLISHED, not-started sessions of the teams where the caller is APPROVED (soonest first, ties by id). */
export async function readOpenSessions(
  trx: Trx,
  input: { readonly userId: string; readonly now: Date; readonly limit: number },
): Promise<OpenSessionRecord[]> {
  const rows = await trx
    .selectFrom('game_sessions as s')
    .innerJoin('teams as t', 't.id', 's.team_id')
    .innerJoin('team_members as tm', (join) =>
      join
        .onRef('tm.team_id', '=', 's.team_id')
        .on('tm.user_id', '=', input.userId)
        .on('tm.status', '=', 'APPROVED'),
    )
    .innerJoin('users as u', 'u.id', 'tm.user_id')
    .select([
      's.id',
      's.team_id',
      't.name as team_name',
      's.location',
      's.address',
      's.starts_at',
      's.ends_at',
      's.max_players',
      's.reserved_seats',
      's.pricing_structure',
      's.fee_flat',
      's.fee_male',
      's.fee_female',
      's.fee_other',
      's.fee_beginner',
      's.fee_intermediate',
      's.fee_advanced',
      'u.sex as user_sex',
      'tm.skill_level as member_skill_level',
    ])
    .where('s.status', '=', 'PUBLISHED')
    .where('s.starts_at', '>', input.now)
    .orderBy('s.starts_at')
    .orderBy('s.id')
    .limit(input.limit + 1)
    .execute();
  return rows.map((row) => ({
    id: row.id,
    teamId: row.team_id,
    teamName: row.team_name,
    location: row.location,
    address: row.address,
    startsAt: row.starts_at as Date,
    endsAt: row.ends_at,
    maxPlayers: row.max_players,
    reservedSeats: row.reserved_seats,
    fees: feeColumnsOf(row),
    person: { sex: row.user_sex, skillLevel: row.member_skill_level },
  }));
}

export interface SessionCounts {
  readonly taken: number;
  readonly waiting: number;
}

/** Seats taken (every CONFIRMED party member) and parties waiting, per session, in one query. */
export async function readSessionCounts(
  trx: Trx,
  sessionIds: readonly string[],
): Promise<Map<string, SessionCounts>> {
  const counts = new Map<string, SessionCounts>();
  if (sessionIds.length === 0) return counts;
  const rows = await trx
    .selectFrom('registrations')
    .select([
      'session_id',
      sql<string>`coalesce(sum(1 + guest_count) filter (where status = 'CONFIRMED'), 0)`.as(
        'taken',
      ),
      sql<string>`count(*) filter (where status = 'WAITLISTED')`.as('waiting'),
    ])
    .where('session_id', 'in', [...sessionIds])
    .groupBy('session_id')
    .execute();
  for (const row of rows) {
    counts.set(row.session_id, { taken: Number(row.taken), waiting: Number(row.waiting) });
  }
  return counts;
}

export interface OwnRegistrationRecord {
  readonly sessionId: string;
  readonly status: RegistrationStatus;
  readonly waitlistRank: number | null;
  readonly withdrawalFeeDue: boolean;
  readonly registrantSex: FeePerson['sex'] | null;
  readonly registrantSkillLevel: FeePerson['skillLevel'] | null;
}

/** The caller's own rows (any status) for these sessions, with the waitlist rank (`1 + the waiting parties ahead`). */
export async function readOwnRegistrations(
  trx: Trx,
  input: { readonly userId: string; readonly sessionIds: readonly string[] },
): Promise<Map<string, OwnRegistrationRecord>> {
  const own = new Map<string, OwnRegistrationRecord>();
  if (input.sessionIds.length === 0) return own;
  const rows = await trx
    .selectFrom('registrations as r')
    .select([
      'r.session_id',
      'r.status',
      'r.withdrawal_fee_due',
      'r.registrant_sex',
      'r.registrant_skill_level',
      sql<string | null>`CASE WHEN r.status = 'WAITLISTED' THEN (
          SELECT count(*) FROM registrations w
           WHERE w.session_id = r.session_id AND w.status = 'WAITLISTED'
             AND w.queue_position < r.queue_position) END`.as('waiting_ahead'),
    ])
    .where('r.user_id', '=', input.userId)
    .where('r.session_id', 'in', [...input.sessionIds])
    .execute();
  for (const row of rows) {
    own.set(row.session_id, {
      sessionId: row.session_id,
      status: row.status,
      waitlistRank: row.waiting_ahead === null ? null : Number(row.waiting_ahead) + 1,
      withdrawalFeeDue: row.withdrawal_fee_due,
      registrantSex: row.registrant_sex,
      registrantSkillLevel: row.registrant_skill_level,
    });
  }
  return own;
}

export interface RegistrationListRecord {
  readonly registrationId: string;
  readonly sessionId: string;
  readonly teamId: string;
  readonly teamName: string;
  readonly location: string;
  readonly address: string;
  readonly startsAt: Date;
  readonly endsAt: Date | null;
  readonly sessionStatus: 'PUBLISHED' | 'DRAFT' | 'COMPLETED' | 'CANCELLED';
  readonly status: RegistrationStatus;
  readonly waitlistRank: number | null;
  readonly guestCount: number;
  readonly withdrawalFeeDue: boolean;
  readonly fees: SessionFeeColumns;
  readonly snapshot: FeePerson | null;
  /** The caller's current sex and level in the team; null when they hold no membership row any more. */
  readonly current: FeePerson | null;
  readonly payment: {
    readonly id: string;
    readonly amount: string;
    readonly status: PaymentStatus;
    readonly billingType:
      'PER_GAME' | 'PREPAID_CREDIT' | 'MONTHLY_SUBSCRIPTION' | 'QUARTERLY_SUBSCRIPTION';
    readonly dueDate: Date;
    readonly paidAt: Date | null;
    readonly onHold: boolean;
    readonly payoutBlocked: boolean;
  } | null;
  /** Exact `starts_at` text for the keyset cursor. */
  readonly startsCursor: string;
}

/**
 * The caller's registrations, `upcoming` (a PUBLISHED session that has not started) or `past` (everything else). A free (EARLY)
 * withdrawal is never listed; a late one is, and so is any row that was billed. Past is newest start first and keyset-paged;
 * upcoming is soonest first.
 */
export async function readRegistrationList(
  trx: Trx,
  input: {
    readonly userId: string;
    readonly now: Date;
    readonly section: 'upcoming' | 'past';
    readonly after?: KeysetPosition | undefined;
    readonly limit?: number | undefined;
  },
): Promise<RegistrationListRecord[]> {
  const nowText = input.now.toISOString();
  const notStarted = sql<boolean>`(s.status = 'PUBLISHED' AND s.starts_at > ${nowText}::timestamptz)`;
  let query = trx
    .selectFrom('registrations as r')
    .innerJoin('game_sessions as s', 's.id', 'r.session_id')
    .innerJoin('teams as t', 't.id', 'r.team_id')
    .leftJoin('payments as p', 'p.registration_id', 'r.id')
    .leftJoin('team_members as tm', (join) =>
      join.onRef('tm.team_id', '=', 'r.team_id').onRef('tm.user_id', '=', 'r.user_id'),
    )
    .leftJoin('users as u', 'u.id', 'r.user_id')
    .select([
      'r.id as registration_id',
      'r.session_id',
      'r.team_id',
      't.name as team_name',
      't.is_payout_configured',
      's.location',
      's.address',
      's.starts_at',
      's.ends_at',
      's.status as session_status',
      's.pricing_structure',
      's.fee_flat',
      's.fee_male',
      's.fee_female',
      's.fee_other',
      's.fee_beginner',
      's.fee_intermediate',
      's.fee_advanced',
      'r.status',
      'r.guest_count',
      'r.withdrawal_fee_due',
      'r.registrant_sex',
      'r.registrant_skill_level',
      'u.sex as user_sex',
      'tm.skill_level as member_skill_level',
      'p.id as payment_id',
      'p.amount as payment_amount',
      'p.status as payment_status',
      'p.billing_type',
      'p.due_date',
      'p.paid_at',
      sql<boolean>`EXISTS (SELECT 1 FROM payment_attempts a WHERE a.payment_id = p.id AND a.status = 'HELD')`.as(
        'on_hold',
      ),
      sql<string | null>`CASE WHEN r.status = 'WAITLISTED' THEN (
          SELECT count(*) FROM registrations w
           WHERE w.session_id = r.session_id AND w.status = 'WAITLISTED'
             AND w.queue_position < r.queue_position) END`.as('waiting_ahead'),
      sql<string>`to_char(s.starts_at AT TIME ZONE 'UTC', ${KEYSET_TIME_FORMAT})`.as(
        'starts_cursor',
      ),
    ])
    .where('r.user_id', '=', input.userId)
    .where(sql<boolean>`(r.status <> 'WITHDRAWN' OR r.withdrawal_fee_due OR p.id IS NOT NULL)`);

  if (input.section === 'upcoming') {
    query = query.where(notStarted).orderBy('s.starts_at').orderBy('r.id');
  } else {
    query = query.where(sql<boolean>`NOT ${notStarted}`);
    if (input.after !== undefined) {
      query = query.where(
        sql<boolean>`(s.starts_at, r.id) < (${input.after.at}::timestamptz, ${input.after.id}::uuid)`,
      );
    }
    query = query.orderBy('s.starts_at', 'desc').orderBy('r.id', 'desc');
  }
  if (input.limit !== undefined) query = query.limit(input.limit);
  const rows = await query.execute();
  return rows.map((row) => ({
    registrationId: row.registration_id,
    sessionId: row.session_id,
    teamId: row.team_id,
    teamName: row.team_name,
    location: row.location,
    address: row.address,
    startsAt: row.starts_at as Date,
    endsAt: row.ends_at,
    sessionStatus: row.session_status,
    status: row.status,
    waitlistRank: row.waiting_ahead === null ? null : Number(row.waiting_ahead) + 1,
    guestCount: row.guest_count,
    withdrawalFeeDue: row.withdrawal_fee_due,
    fees: feeColumnsOf(row),
    snapshot:
      row.registrant_sex === null || row.registrant_skill_level === null
        ? null
        : { sex: row.registrant_sex, skillLevel: row.registrant_skill_level },
    current:
      row.user_sex === null || row.member_skill_level === null
        ? null
        : { sex: row.user_sex, skillLevel: row.member_skill_level },
    payment:
      row.payment_id === null ||
      row.payment_amount === null ||
      row.payment_status === null ||
      row.billing_type === null ||
      row.due_date === null
        ? null
        : {
            id: row.payment_id,
            amount: row.payment_amount,
            status: row.payment_status,
            billingType: row.billing_type,
            dueDate: row.due_date,
            paidAt: row.paid_at,
            onHold: row.on_hold,
            payoutBlocked: !row.is_payout_configured,
          },
    startsCursor: row.starts_cursor,
  }));
}

/** The guests of these registrations (sex and level only: a guest's name never leaves the registrant's own read model). */
export async function readGuestsByRegistration(
  trx: Trx,
  registrationIds: readonly string[],
): Promise<Map<string, FeePerson[]>> {
  const guests = new Map<string, FeePerson[]>();
  if (registrationIds.length === 0) return guests;
  const rows = await trx
    .selectFrom('registration_guests')
    .select(['registration_id', 'sex', 'skill_level'])
    .where('registration_id', 'in', [...registrationIds])
    .orderBy('registration_id')
    .orderBy('position')
    .execute();
  for (const row of rows) {
    const list = guests.get(row.registration_id) ?? [];
    list.push({ sex: row.sex, skillLevel: row.skill_level });
    guests.set(row.registration_id, list);
  }
  return guests;
}
