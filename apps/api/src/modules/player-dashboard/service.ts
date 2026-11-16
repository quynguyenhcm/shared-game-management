/**
 * The player dashboard's two read models (player-dashboard Phase 1): `GET /me/sessions/open` and `GET /me/registrations`.
 *
 * Read-only by construction: each call runs in one REPEATABLE READ, read-only snapshot, so counts, own rows and the debt count
 * agree. The fee, access and deadline rules are the registrations module's (`feeColumnsOf`, `unitFee`, `estimateTotal`,
 * `decideAccess`, `isRegistrationOpen`, `countOverdueByUser`), never re-derived here, so a card and the session page it links to
 * can never disagree. Formatting (dates, wording) is the web's job: this layer returns instants, money strings and enums.
 */
import type { Transaction } from 'kysely';
import {
  OPEN_SESSIONS_LIMIT,
  REGISTRATIONS_PAGE_SIZE,
  estimateTotal,
  parseMoney,
  toIsoInstant,
  toMoneyString,
  unitFee,
  type DashboardRegistrationRow,
  type DashboardRegistrationsQuery,
  type DashboardRegistrationsResponse,
  type FeePerson,
  type MoneyString,
  type OpenSessionRow,
  type OpenSessionsResponse,
} from '@sgm/shared';
import type { Clock } from '../../lib/clock.ts';
import type { Database } from '../../lib/db/kysely.ts';
import type { DB } from '../../lib/db/types.generated.ts';
import { decodeKeysetCursor, encodeKeysetCursor } from '../../lib/http/cursor.ts';
import { decideAccess } from '../registrations/access.ts';
import { isRegistrationOpen } from '../registrations/deadline.ts';
import { countOverdueByUser } from '../registrations/repo.ts';
import {
  readGuestsByRegistration,
  readOpenSessions,
  readOwnRegistrations,
  readRegistrationList,
  readSessionCounts,
  type RegistrationListRecord,
} from './repo.ts';

export interface PlayerDashboardServiceDeps {
  readonly db: Database;
  readonly clock: Clock;
}

export interface PlayerDashboardService {
  openSessions(userId: string): Promise<OpenSessionsResponse>;
  registrations(
    userId: string,
    query: DashboardRegistrationsQuery,
  ): Promise<DashboardRegistrationsResponse>;
}

const moneyOrNull = (money: ReturnType<typeof unitFee>): MoneyString | null =>
  money === null ? null : toMoneyString(money);

/** The person a registration is priced as: the snapshot for a CONFIRMED row or a late fee still owed, else who they are now. */
function pricingPerson(
  status: string,
  feeDue: boolean,
  snapshot: FeePerson | null,
  current: FeePerson | null,
): FeePerson | null {
  return snapshot !== null && (status === 'CONFIRMED' || feeDue) ? snapshot : current;
}

export function createPlayerDashboardService(
  deps: PlayerDashboardServiceDeps,
): PlayerDashboardService {
  const { db, clock } = deps;

  /** One consistent snapshot for a read that joins several queries: REPEATABLE READ, read only. */
  const readOnly = <T>(work: (trx: Transaction<DB>) => Promise<T>): Promise<T> =>
    db.transaction().setIsolationLevel('repeatable read').setAccessMode('read only').execute(work);

  const toRegistrationRow = (
    record: RegistrationListRecord,
    guests: readonly FeePerson[],
  ): DashboardRegistrationRow => {
    const person = pricingPerson(
      record.status,
      record.withdrawalFeeDue,
      record.snapshot,
      record.current,
    );
    const estimated =
      record.payment !== null || person === null
        ? null
        : estimateTotal(record.fees, person, guests);
    return {
      registrationId: record.registrationId,
      sessionId: record.sessionId,
      teamId: record.teamId,
      teamName: record.teamName,
      location: record.location,
      address: record.address,
      startsAt: toIsoInstant(record.startsAt),
      endsAt: record.endsAt === null ? null : toIsoInstant(record.endsAt),
      sessionStatus: record.sessionStatus,
      status: record.status,
      waitlistRank: record.waitlistRank,
      guestCount: record.guestCount,
      withdrawalFeeDue: record.withdrawalFeeDue,
      estimatedTotal: moneyOrNull(estimated),
      payment:
        record.payment === null
          ? null
          : {
              id: record.payment.id,
              amount: toMoneyString(parseMoney(record.payment.amount)),
              status: record.payment.status,
              billingType: record.payment.billingType,
              dueDate: toIsoInstant(record.payment.dueDate),
              paidAt: record.payment.paidAt === null ? null : toIsoInstant(record.payment.paidAt),
              onHold: record.payment.onHold,
              payoutBlocked: record.payment.payoutBlocked,
            },
    };
  };

  return {
    openSessions(userId) {
      const now = clock.now();
      return readOnly(async (trx) => {
        const found = await readOpenSessions(trx, { userId, now, limit: OPEN_SESSIONS_LIMIT });
        const shown = found.slice(0, OPEN_SESSIONS_LIMIT);
        const ids = shown.map((session) => session.id);
        const counts = await readSessionCounts(trx, ids);
        const own = await readOwnRegistrations(trx, { userId, sessionIds: ids });
        const overdueCount = (await countOverdueByUser(trx, [userId])).get(userId) ?? 0;

        const sessions = shown.map((session): OpenSessionRow => {
          const seats = counts.get(session.id) ?? { taken: 0, waiting: 0 };
          const mine = own.get(session.id);
          const active = mine?.status === 'CONFIRMED' || mine?.status === 'WAITLISTED';
          const publicCapacity = Math.max(0, session.maxPlayers - session.reservedSeats);
          const snapshot: FeePerson | null =
            mine?.registrantSex != null && mine.registrantSkillLevel != null
              ? { sex: mine.registrantSex, skillLevel: mine.registrantSkillLevel }
              : null;
          const person =
            snapshot !== null && (mine?.status === 'CONFIRMED' || mine?.withdrawalFeeDue === true)
              ? snapshot
              : session.person;
          const access = decideAccess({
            sessionOpen: isRegistrationOpen(now, {
              status: 'PUBLISHED',
              startsAt: session.startsAt,
            }),
            overdueCount,
            hasActiveRegistration: active,
            publicCapacity,
          });
          return {
            sessionId: session.id,
            teamId: session.teamId,
            teamName: session.teamName,
            location: session.location,
            address: session.address,
            startsAt: toIsoInstant(session.startsAt),
            endsAt: session.endsAt === null ? null : toIsoInstant(session.endsAt),
            pricingStructure: session.fees.pricing,
            unitFee: moneyOrNull(unitFee(session.fees, person)),
            feeLevel: session.fees.pricing === 'BY_SKILL_LEVEL' ? person.skillLevel : null,
            publicCapacity,
            seatsLeft: Math.max(0, publicCapacity - seats.taken),
            waitlistLength: seats.waiting,
            me:
              mine === undefined || !active
                ? null
                : {
                    status: mine.status,
                    waitlistRank: mine.waitlistRank,
                  },
            canRegister: access.canRegister,
            blockedReason: access.blockedReason,
          };
        });
        return { sessions, hasMore: found.length > OPEN_SESSIONS_LIMIT, overdueCount };
      });
    },

    registrations(userId, query) {
      const now = clock.now();
      // A cursor is decoded before the snapshot opens: a bad one is a 422 and costs no query.
      const after = query.cursor === undefined ? undefined : decodeKeysetCursor(query.cursor);
      return readOnly(async (trx) => {
        const upcoming =
          after === undefined
            ? await readRegistrationList(trx, { userId, now, section: 'upcoming' })
            : [];
        const found = await readRegistrationList(trx, {
          userId,
          now,
          section: 'past',
          after,
          limit: REGISTRATIONS_PAGE_SIZE + 1,
        });
        const past = found.slice(0, REGISTRATIONS_PAGE_SIZE);
        const last = past[past.length - 1];
        const guests = await readGuestsByRegistration(
          trx,
          [...upcoming, ...past].map((row) => row.registrationId),
        );
        const rowOf = (record: RegistrationListRecord) =>
          toRegistrationRow(record, guests.get(record.registrationId) ?? []);
        return {
          upcoming: upcoming.map(rowOf),
          past: past.map(rowOf),
          nextCursor:
            found.length > REGISTRATIONS_PAGE_SIZE && last !== undefined
              ? encodeKeysetCursor({ at: last.startsCursor, id: last.registrationId })
              : null,
        };
      });
    },
  };
}
