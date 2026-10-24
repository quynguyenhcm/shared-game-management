import type { RegistrationReadResponse } from '@sgm/shared';
import {
  AUTO_ENROL_LABEL,
  CANCELLED_MESSAGE,
  FIRST_IN_LINE,
  NO_PUBLIC_PLACES_MESSAGE,
  PROMOTED_AFTER_DEADLINE,
  closedText,
  debtMessage,
  groupLine,
  guestLine,
  passedOverLine,
  promotedLine,
  registeredHeadline,
  waitlistHeadline,
  withdrawnText,
} from '../../lib/registrations/labels.ts';
import type { PanelView } from '../../lib/registrations/view.ts';

const CARD = 'flex flex-col gap-1 rounded-md border-2 border-slate-900 p-4 text-base';

/**
 * The player's current state in words (UI/UX "OutcomeCard"): a headline plus detail lines, never colour alone. Everything it
 * says is a field of the read model: `me.registration` (status, `waitlistRank`, guests, `promotedAt`, `source`,
 * `withdrawalKind`, `withdrawalFeeDue`), `me.estimatedTotal`, `me.overdueCount` and `session` (status, `seatsLeft`). The
 * panel renders it inside the persistent status region. `null` when the player has nothing to be told (an open session).
 */
export function OutcomeCard({ view, data }: { view: PanelView; data: RegistrationReadResponse }) {
  const { session, me } = data;
  const registration = me.registration;
  const withdrawn =
    registration?.status === 'WITHDRAWN'
      ? withdrawnText({
          kind: registration.withdrawalKind,
          feeDue: registration.withdrawalFeeDue,
          fee: me.estimatedTotal,
          guestCount: registration.guestCount,
        })
      : null;

  switch (view.kind) {
    case 'open':
      return null;
    case 'cancelled':
      return (
        <div className={CARD}>
          <p className="text-lg font-semibold">{CANCELLED_MESSAGE}</p>
        </div>
      );
    case 'closed':
      return (
        <div className={CARD}>
          {withdrawn === null ? null : <p>{withdrawn}</p>}
          {closedText({ status: session.status, registration: registration?.status ?? null }).map(
            (line, index) => (
              <p
                key={line}
                className={index === 0 && withdrawn === null ? 'text-lg font-semibold' : ''}
              >
                {line}
              </p>
            ),
          )}
        </div>
      );
    case 'no_places':
      return (
        <div className={CARD}>
          <p className="text-lg font-semibold">{NO_PUBLIC_PLACES_MESSAGE}</p>
        </div>
      );
    case 'debt_blocked':
      return (
        <div className={CARD}>
          {withdrawn === null ? null : <p>{withdrawn}</p>}
          <p className="font-semibold">{debtMessage(me.overdueCount)}</p>
        </div>
      );
    case 'withdrawn':
      return (
        <div className={CARD}>
          <p className="font-semibold">{withdrawn}</p>
        </div>
      );
    case 'confirmed':
    case 'waitlisted': {
      if (registration === null) return null;
      const confirmed = view.kind === 'confirmed';
      const promotedLate =
        confirmed &&
        registration.promotedAt !== null &&
        session.cancellationDeadline !== null &&
        new Date(registration.promotedAt).getTime() >
          new Date(session.cancellationDeadline).getTime();
      return (
        <div className={CARD}>
          <p className="text-lg font-semibold">
            {confirmed ? registeredHeadline : waitlistHeadline(registration.waitlistRank)}
          </p>
          {registration.source === 'AUTO_ENROL' ? <p>{AUTO_ENROL_LABEL}</p> : null}
          {!confirmed && registration.waitlistRank === 1 ? <p>{FIRST_IN_LINE}</p> : null}
          {!confirmed && session.seatsLeft >= 1 ? <p>{passedOverLine()}</p> : null}
          {confirmed && registration.promotedAt !== null ? (
            <p>{promotedLine(registration.promotedAt)}</p>
          ) : null}
          {promotedLate ? <p>{PROMOTED_AFTER_DEADLINE}</p> : null}
          <p>{groupLine(registration.guestCount)}</p>
          {registration.guests.length > 0 ? (
            <ul className="list-disc pl-5">
              {registration.guests.map((guest) => (
                <li key={guest.position} className="break-words">
                  {guestLine(guest)}
                </li>
              ))}
            </ul>
          ) : null}
        </div>
      );
    }
  }
}
