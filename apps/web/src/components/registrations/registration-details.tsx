import type { RegistrationReadResponse } from '@sgm/shared';
import { deadlineLine, feeLine, feeListLines, seatsLine } from '../../lib/registrations/labels.ts';
import type { PanelView } from '../../lib/registrations/view.ts';

/**
 * The three summary lines (UI/UX "SessionSummary" of the panel, renamed so it is never confused with the admin `SessionSummary`):
 * places, fee and cancellation deadline. Places are `session.seatsLeft`, `publicCapacity` and `waitlistLength`; the fee is
 * `me.unitFee` or, with an active registration, `me.estimatedTotal`, plus every `session.fees` entry on a BY_SEX or
 * BY_SKILL_LEVEL session (the level named is `me.feeLevel`, R15). Nothing is derived.
 */
export function RegistrationDetails({
  view,
  data,
}: {
  view: PanelView;
  data: RegistrationReadResponse;
}) {
  const { session, me } = data;
  const registration = me.registration;
  const active = registration?.status === 'CONFIRMED' || registration?.status === 'WAITLISTED';
  const fee = feeLine({
    pricing: session.pricingStructure,
    unitFee: me.unitFee,
    estimatedTotal: me.estimatedTotal,
    guestCount: registration?.guestCount ?? 0,
    registered: active,
    waitlisted: registration?.status === 'WAITLISTED',
    level: me.feeLevel,
  });
  const list = feeListLines(session.pricingStructure, session.fees);
  const deadline = deadlineLine(session.cancellationDeadline, view.deadlinePassed);

  return (
    <ul aria-label="Registration details" className="flex flex-col gap-1 pl-5 text-base">
      <li className="list-disc">
        {seatsLine({
          seatsLeft: session.seatsLeft,
          publicCapacity: session.publicCapacity,
          waitlistLength: session.waitlistLength,
        })}
      </li>
      <li className="list-disc">
        {fee}
        {list === null ? null : (
          <>
            <span className="mt-1 block text-sm text-slate-700">{list.intro}</span>
            <ul className="pl-5">
              {list.rows.map((row) => (
                <li key={row} className="list-[circle] text-sm">
                  {row}
                </li>
              ))}
            </ul>
          </>
        )}
      </li>
      {deadline === null ? null : <li className="list-disc">{deadline}</li>}
    </ul>
  );
}
