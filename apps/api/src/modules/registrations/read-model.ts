/**
 * Reads for the registration routes: the session read model, the caller's own registration and the upcoming list. Plain
 * SELECTs, no locks, no writes (the structural guard in `boundaries.test.ts` keeps writes in `repo.ts`). The money-table read of
 * the debt count stays in `repo.ts`, where it is the one allowed mention.
 *
 * A session is only ever resolved together with its team (`WHERE id = $1 AND team_id = $2`): another team's id, a DRAFT and a
 * session that never had a court are all simply absent, so the caller cannot tell them apart (O2, AC-ENTRY-2).
 */
import { sql, type Selectable, type Transaction } from 'kysely';
import {
  UPCOMING_SESSIONS_LIMIT,
  estimateTotal,
  toIsoInstant,
  toMoneyString,
  unitFee,
  type FeePerson,
  type MoneyString,
  type MyRegistration,
  type RegistrationReadResponse,
  type SessionFeeColumns,
  type UpcomingSessionsResponse,
} from '@sgm/shared';
import type { DB, GameSessions } from '../../lib/db/types.generated.ts';
import { decideAccess, waitlistRankOf } from './access.ts';
import { isRegistrationOpen } from './deadline.ts';
import { countOverdueByUser } from './repo.ts';

type Trx = Transaction<DB>;
type SessionRecord = Selectable<GameSessions>;

/** A session the caller may see: not a DRAFT and with a start (a cancelled draft never had one). */
export type VisibleSession = SessionRecord & { readonly starts_at: Date };

const feeColumnsOf = (session: SessionRecord): SessionFeeColumns => ({
  pricing: session.pricing_structure,
  flat: session.fee_flat,
  male: session.fee_male,
  female: session.fee_female,
  other: session.fee_other,
  beginner: session.fee_beginner,
  intermediate: session.fee_intermediate,
  advanced: session.fee_advanced,
});

const moneyOrNull = (money: ReturnType<typeof unitFee>): MoneyString | null =>
  money === null ? null : toMoneyString(money);

export async function readVisibleSession(
  trx: Trx,
  input: { readonly teamId: string; readonly sessionId: string },
): Promise<VisibleSession | undefined> {
  const session = await trx
    .selectFrom('game_sessions')
    .selectAll()
    .where('id', '=', input.sessionId)
    .where('team_id', '=', input.teamId)
    .where('status', '<>', 'DRAFT')
    .executeTakeFirst();
  return session === undefined || session.starts_at === null
    ? undefined
    : (session as VisibleSession);
}

/** Seats taken (every CONFIRMED party member) and parties waiting, in one query. */
async function readCounts(
  trx: Trx,
  sessionId: string,
): Promise<{ readonly taken: number; readonly waiting: number }> {
  const row = await trx
    .selectFrom('registrations')
    .select([
      sql<string>`coalesce(sum(1 + guest_count) filter (where status = 'CONFIRMED'), 0)`.as(
        'taken',
      ),
      sql<string>`count(*) filter (where status = 'WAITLISTED')`.as('waiting'),
    ])
    .where('session_id', '=', sessionId)
    .executeTakeFirst();
  return { taken: Number(row?.taken ?? 0), waiting: Number(row?.waiting ?? 0) };
}

interface OwnRow {
  readonly id: string;
  readonly status: 'CONFIRMED' | 'WAITLISTED' | 'WITHDRAWN';
  readonly queuePosition: number | null;
  readonly registrantSex: FeePerson['sex'] | null;
  readonly registrantSkillLevel: FeePerson['skillLevel'] | null;
}

interface OwnRegistration {
  readonly response: MyRegistration;
  readonly row: OwnRow;
  readonly guests: readonly FeePerson[];
}

/** The caller's own row in any status with its guests and rank; null when they never registered. */
async function readOwn(
  trx: Trx,
  sessionId: string,
  userId: string,
): Promise<OwnRegistration | null> {
  const row = await trx
    .selectFrom('registrations')
    .select([
      'id',
      'status',
      'queue_position',
      'guest_count',
      'registered_at',
      'promoted_at',
      'withdrawn_at',
      'withdrawal_kind',
      'withdrawal_fee_due',
      'source',
      'registrant_sex',
      'registrant_skill_level',
    ])
    .where('session_id', '=', sessionId)
    .where('user_id', '=', userId)
    .executeTakeFirst();
  if (row === undefined) return null;
  const guests = await trx
    .selectFrom('registration_guests')
    .select(['position', 'sex', 'skill_level', 'display_name'])
    .where('registration_id', '=', row.id)
    .orderBy('position')
    .execute();
  let waitingAhead = 0;
  if (row.status === 'WAITLISTED' && row.queue_position !== null) {
    const ahead = await trx
      .selectFrom('registrations')
      .select(sql<string>`count(*)`.as('n'))
      .where('session_id', '=', sessionId)
      .where('status', '=', 'WAITLISTED')
      .where('queue_position', '<', row.queue_position)
      .executeTakeFirst();
    waitingAhead = Number(ahead?.n ?? 0);
  }
  return {
    row: {
      id: row.id,
      status: row.status,
      queuePosition: row.queue_position,
      registrantSex: row.registrant_sex,
      registrantSkillLevel: row.registrant_skill_level,
    },
    guests: guests.map((guest) => ({ sex: guest.sex, skillLevel: guest.skill_level })),
    response: {
      id: row.id,
      status: row.status,
      guestCount: row.guest_count,
      guests: guests.map((guest) => ({
        position: guest.position,
        sex: guest.sex,
        skillLevel: guest.skill_level,
        displayName: guest.display_name,
      })),
      waitlistRank: waitlistRankOf(row.status, waitingAhead),
      registeredAt: toIsoInstant(row.registered_at),
      promotedAt: row.promoted_at === null ? null : toIsoInstant(row.promoted_at),
      withdrawnAt: row.withdrawn_at === null ? null : toIsoInstant(row.withdrawn_at),
      withdrawalKind: row.withdrawal_kind,
      withdrawalFeeDue: row.withdrawal_fee_due,
      source: row.source,
      registrantSkillLevel: row.registrant_skill_level,
    },
  };
}

/** The caller's registration for the response of a write, read inside the writing transaction. */
export async function readMyRegistration(
  trx: Trx,
  sessionId: string,
  userId: string,
): Promise<MyRegistration | null> {
  return (await readOwn(trx, sessionId, userId))?.response ?? null;
}

/**
 * What a withdrawing player would be charged: the party's fee at the pricing snapshot, only when the late fee is owed (nobody
 * took the seat). `null` fees (a session that was never fully priced) read as nothing owed here; billing decides the charge.
 */
export async function readOwedFeeEstimate(
  trx: Trx,
  session: SessionRecord,
  userId: string,
): Promise<MoneyString | null> {
  const own = await readOwn(trx, session.id, userId);
  if (own === null || !own.response.withdrawalFeeDue) return null;
  const { registrantSex, registrantSkillLevel } = own.row;
  if (registrantSex === null || registrantSkillLevel === null) return null;
  return moneyOrNull(
    estimateTotal(
      feeColumnsOf(session),
      { sex: registrantSex, skillLevel: registrantSkillLevel },
      own.guests,
    ),
  );
}

/** The pricing person for a caller who has no snapshot yet: their current sex and level in this team. */
async function readCurrentPerson(
  trx: Trx,
  teamId: string,
  userId: string,
): Promise<FeePerson | null> {
  const row = await trx
    .selectFrom('team_members as tm')
    .innerJoin('users as u', 'u.id', 'tm.user_id')
    .select(['u.sex', 'tm.skill_level'])
    .where('tm.team_id', '=', teamId)
    .where('tm.user_id', '=', userId)
    .executeTakeFirst();
  return row === undefined ? null : { sex: row.sex, skillLevel: row.skill_level };
}

/** `GET .../sessions/:sessionId/registration`; `undefined` when the session is not visible to this team (404). */
export async function readRegistrationModel(
  trx: Trx,
  input: {
    readonly teamId: string;
    readonly sessionId: string;
    readonly userId: string;
    readonly now: Date;
  },
): Promise<RegistrationReadResponse | undefined> {
  const session = await readVisibleSession(trx, input);
  if (session === undefined) return undefined;
  const counts = await readCounts(trx, session.id);
  const own = await readOwn(trx, session.id, input.userId);
  const overdue = await countOverdueByUser(trx, [input.userId]);
  const overdueCount = overdue.get(input.userId) ?? 0;
  const publicCapacity = Math.max(0, session.max_players - session.reserved_seats);
  const fees = feeColumnsOf(session);
  // The pricing snapshot is authoritative for a CONFIRMED row and a late fee still owed; otherwise price the person as they are.
  const snapshotApplies =
    own !== null &&
    own.row.registrantSex !== null &&
    own.row.registrantSkillLevel !== null &&
    (own.row.status === 'CONFIRMED' || own.response.withdrawalFeeDue);
  const person: FeePerson | null =
    snapshotApplies && own.row.registrantSex !== null && own.row.registrantSkillLevel !== null
      ? { sex: own.row.registrantSex, skillLevel: own.row.registrantSkillLevel }
      : await readCurrentPerson(trx, session.team_id, input.userId);
  const priced = person === null ? null : unitFee(fees, person);
  const partyCounts =
    own !== null && (own.row.status !== 'WITHDRAWN' || own.response.withdrawalFeeDue);
  const total =
    person === null ? null : partyCounts ? estimateTotal(fees, person, own.guests) : priced;
  const access = decideAccess({
    sessionOpen: isRegistrationOpen(input.now, {
      status: session.status,
      startsAt: session.starts_at,
    }),
    overdueCount,
    hasActiveRegistration: own?.row.status === 'CONFIRMED' || own?.row.status === 'WAITLISTED',
    publicCapacity,
  });
  return {
    session: {
      id: session.id,
      teamId: session.team_id,
      location: session.location,
      address: session.address,
      startsAt: toIsoInstant(session.starts_at),
      endsAt: session.ends_at === null ? null : toIsoInstant(session.ends_at),
      cancellationDeadline: toIsoInstant(session.cancellation_deadline),
      status: session.status,
      publicCapacity,
      seatsTaken: counts.taken,
      seatsLeft: Math.max(0, publicCapacity - counts.taken),
      waitlistLength: counts.waiting,
      pricingStructure: session.pricing_structure,
      fees: {
        flat: session.fee_flat,
        male: session.fee_male,
        female: session.fee_female,
        other: session.fee_other,
        beginner: session.fee_beginner,
        intermediate: session.fee_intermediate,
        advanced: session.fee_advanced,
      },
    },
    me: {
      registration: own?.response ?? null,
      unitFee: moneyOrNull(priced),
      estimatedTotal: moneyOrNull(total),
      feeLevel:
        session.pricing_structure === 'BY_SKILL_LEVEL' ? (person?.skillLevel ?? null) : null,
      overdueCount,
    },
    canRegister: access.canRegister,
    blockedReason: access.blockedReason,
  };
}

/** `GET /teams/:teamId/sessions/upcoming`: the next 10 PUBLISHED sessions that have not started (R8). */
export async function readUpcoming(
  trx: Trx,
  input: { readonly teamId: string; readonly userId: string; readonly now: Date },
): Promise<UpcomingSessionsResponse> {
  const rows = await trx
    .selectFrom('game_sessions')
    .select(['id', 'starts_at', 'ends_at', 'location', 'max_players', 'reserved_seats'])
    .where('team_id', '=', input.teamId)
    .where('status', '=', 'PUBLISHED')
    .where('starts_at', '>', input.now)
    .orderBy('starts_at')
    .orderBy('id')
    .limit(UPCOMING_SESSIONS_LIMIT + 1)
    .execute();
  const shown = rows.slice(0, UPCOMING_SESSIONS_LIMIT);
  const ids = shown.map((row) => row.id);
  const registrations =
    ids.length === 0
      ? []
      : await trx
          .selectFrom('registrations')
          .select(['session_id', 'user_id', 'status', 'queue_position', 'guest_count'])
          .where('session_id', 'in', ids)
          .where('status', 'in', ['CONFIRMED', 'WAITLISTED'])
          .execute();
  return {
    hasMore: rows.length > UPCOMING_SESSIONS_LIMIT,
    sessions: shown.map((row) => {
      const here = registrations.filter((one) => one.session_id === row.id);
      const publicCapacity = Math.max(0, row.max_players - row.reserved_seats);
      const taken = here
        .filter((one) => one.status === 'CONFIRMED')
        .reduce((total, one) => total + 1 + one.guest_count, 0);
      const waiting = here.filter((one) => one.status === 'WAITLISTED');
      const mine = here.find((one) => one.user_id === input.userId);
      return {
        id: row.id,
        startsAt: toIsoInstant(row.starts_at as Date),
        endsAt: row.ends_at === null ? null : toIsoInstant(row.ends_at),
        location: row.location,
        publicCapacity,
        seatsLeft: Math.max(0, publicCapacity - taken),
        waitlistLength: waiting.length,
        me:
          mine === undefined || mine.status === 'WITHDRAWN'
            ? null
            : {
                status: mine.status,
                waitlistRank: waitlistRankOf(
                  mine.status,
                  waiting.filter((one) => (one.queue_position ?? 0) < (mine.queue_position ?? 0))
                    .length,
                ),
              },
      };
    }),
  };
}
