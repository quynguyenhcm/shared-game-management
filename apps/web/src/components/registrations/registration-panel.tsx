import type { RegistrationReadResponse } from '@sgm/shared';
import { panelView } from '../../lib/registrations/view.ts';
import { OutcomeCard } from './outcome-card.tsx';
import { RegisterForm } from './register-form.tsx';
import { RegistrationDetails } from './registration-details.tsx';
import { RegistrationShell, REGISTRATION_HEADING_ID } from './registration-shell.tsx';
import { WithdrawConfirm } from './withdraw-confirm.tsx';

/**
 * The registration panel of the player session page (UI/UX option 1: one stacked, state-driven panel). A Server Component:
 * `panelView(data, now)` picks exactly one state from the read model the page fetched once, and this renders it as
 * heading, outcome card (inside the persistent status region), summary lines, then the action area. Only the register form,
 * the withdraw confirmation and the status shell are client islands. The controls are conveniences, not guards: the API
 * enforces every rule (a hidden form for a debtor or a closed session still gets a 403 or 409 from the route).
 *
 * `now` is the server clock, read once per render; it only decides the deadline wording, which the API re-checks (R9).
 */
export function RegistrationPanel({
  teamId,
  data,
  now,
}: {
  teamId: string;
  data: RegistrationReadResponse;
  now: Date;
}) {
  const view = panelView(data, now);
  const { session, me } = data;
  const registration = me.registration;

  return (
    <section aria-labelledby={REGISTRATION_HEADING_ID} className="flex flex-col gap-4">
      <RegistrationShell outcome={<OutcomeCard view={view} data={data} />}>
        {view.kind === 'cancelled' ? null : <RegistrationDetails view={view} data={data} />}
        {view.kind === 'open' || view.kind === 'withdrawn' ? (
          <RegisterForm
            teamId={teamId}
            sessionId={session.id}
            publicCapacity={session.publicCapacity}
            seatsLeft={session.seatsLeft}
            pricing={session.pricingStructure}
            fees={session.fees}
            unitFee={me.unitFee}
            deadlinePassed={view.deadlinePassed}
          />
        ) : null}
        {view.kind === 'confirmed' || view.kind === 'waitlisted' ? (
          <WithdrawConfirm
            teamId={teamId}
            sessionId={session.id}
            kind={view.kind === 'confirmed' ? 'withdraw' : 'leave'}
            late={view.deadlinePassed}
            waitlistLength={session.waitlistLength}
            fee={me.estimatedTotal}
            guestCount={registration?.guestCount ?? 0}
          />
        ) : null}
      </RegistrationShell>
    </section>
  );
}
