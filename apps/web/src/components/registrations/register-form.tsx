'use client';

import { useState } from 'react';
import type { RegistrationReadResponse } from '@sgm/shared';
import { registerAction } from '../../lib/registrations/actions.ts';
import {
  GUEST_GROUP_HINT,
  LATE_REGISTRATION_HINT,
  PARTY_HINT,
  PARTY_LEGEND,
  PARTY_OPTIONS,
  WAITLIST_PREDICTION,
  partyOptionHint,
  submitLabel,
  submitPendingLabel,
} from '../../lib/registrations/labels.ts';
import { partyTotal, totalLine } from '../../lib/registrations/total.ts';
import {
  guestFieldNames,
  validateGuests,
  type GuestValues,
} from '../../lib/registrations/validation.ts';
import type { FieldErrors } from '../../lib/auth/validation.ts';
import { ErrorSummary } from '../auth/error-summary.tsx';
import { BUTTON_CLASS } from '../auth/styles.ts';
import { ChoiceGroup } from './choice-group.tsx';
import { GuestFieldset } from './guest-fieldset.tsx';
import { useRegistrationAction } from './registration-shell.tsx';

const EMPTY_GUEST: GuestValues = { sex: '', skillLevel: '', displayName: '' };

/**
 * The register form (UI/UX option 1): party size, one fieldset per guest, one submit. Party and every guest field live in
 * state and are put into the submitted data from it, so React 19's form reset after an action never clears what was typed.
 * "Just me" is the only preselection; guest sex and level start empty. Focus never moves when a fieldset appears (it would break
 * arrow-key selection in the party group): the fieldsets are the next siblings, so the next Tab stop is Guest 1. On a failed
 * submit focus goes to the error summary. The only arithmetic is an estimate: the total line (shared fee rule over the
 * server's `me.unitFee` and `session.fees`) and the waitlist prediction (party size against the server's `seatsLeft`).
 * The API decides CONFIRMED or WAITLISTED; the result note says so if it differs from the button.
 */
export function RegisterForm({
  teamId,
  sessionId,
  publicCapacity,
  seatsLeft,
  pricing,
  fees,
  unitFee,
  deadlinePassed = false,
  initialParty = 0,
  initialGuests,
}: {
  teamId: string;
  sessionId: string;
  /** `session.publicCapacity`: a party option bigger than this can never fit and is disabled. */
  publicCapacity: number;
  /** `session.seatsLeft`: a party bigger than this is predicted to be waitlisted (the API decides). */
  seatsLeft: number;
  /** `session.pricingStructure`, `session.fees` and `me.unitFee`: the only inputs of the pre-submit total. */
  pricing: RegistrationReadResponse['session']['pricingStructure'];
  fees: RegistrationReadResponse['session']['fees'];
  unitFee: string | null;
  /** The server clock is past `session.cancellationDeadline`: say so above the button (AC-ERROR-2). */
  deadlinePassed?: boolean;
  /** The party the form opens with (tests); the page always renders "Just me". */
  initialParty?: 0 | 1 | 2;
  /** Guest values the form opens with (tests). */
  initialGuests?: readonly GuestValues[];
}) {
  const [party, setParty] = useState<string>(String(initialParty));
  const [guests, setGuests] = useState<[GuestValues, GuestValues]>([
    initialGuests?.[0] ?? EMPTY_GUEST,
    initialGuests?.[1] ?? EMPTY_GUEST,
  ]);
  const [clientErrors, setClientErrors] = useState<FieldErrors | null>(null);
  const [failures, setFailures] = useState(0);
  const { state, dispatch, pending } = useRegistrationAction(registerAction);

  const guestCount = Number(party);
  // A prediction from the server's `seatsLeft`; the API decides CONFIRMED or WAITLISTED and the result note says so.
  const waitlist = guestCount + 1 > seatsLeft;
  const total = totalLine(
    partyTotal({ pricing, fees, unitFee, guests: guests.slice(0, guestCount) }),
    pricing,
  );
  const errors: FieldErrors = clientErrors ?? state?.fieldErrors ?? {};

  const submit = (formData: FormData): void => {
    if (pending) return;
    const chosen = guests.slice(0, guestCount);
    const found = validateGuests(chosen);
    if (Object.keys(found).length > 0) {
      setClientErrors(found);
      setFailures((count) => count + 1);
      return;
    }
    setClientErrors(null);
    formData.set('party', party);
    chosen.forEach((guest, index) => {
      formData.set(`guest${index + 1}Sex`, guest.sex);
      formData.set(`guest${index + 1}Skill`, guest.skillLevel);
      formData.set(`guest${index + 1}Name`, guest.displayName);
    });
    dispatch(formData);
  };

  const partyChoices = PARTY_OPTIONS.map((option) => {
    const size = option.guests + 1;
    const never = size > publicCapacity;
    return {
      value: option.value,
      label: option.label,
      disabled: never,
      ...(never ? { hint: partyOptionHint(publicCapacity, size) } : {}),
    };
  });

  return (
    <form action={submit} noValidate className="flex flex-col gap-4">
      <input type="hidden" name="teamId" value={teamId} />
      <input type="hidden" name="sessionId" value={sessionId} />
      <input type="hidden" name="intent" value={waitlist ? 'waitlist' : 'register'} />
      <ErrorSummary
        errors={errors}
        order={['guests', ...guestFieldNames(2)]}
        focusToken={clientErrors === null ? state : failures}
      />
      <ChoiceGroup
        name="party"
        legend={PARTY_LEGEND}
        hint={PARTY_HINT}
        options={partyChoices}
        value={party}
        onChange={setParty}
      />
      {guestCount > 0 ? <p className="text-sm text-slate-700">{GUEST_GROUP_HINT}</p> : null}
      {guests.slice(0, guestCount).map((values, index) => (
        <GuestFieldset
          key={index}
          n={index + 1}
          values={values}
          onChange={(next) => {
            setGuests((current) => {
              const copy: [GuestValues, GuestValues] = [current[0], current[1]];
              copy[index] = next;
              return copy;
            });
          }}
          errors={{
            sex: errors[`guest${index + 1}Sex`]?.[0],
            skill: errors[`guest${index + 1}Skill`]?.[0],
            name: errors[`guest${index + 1}Name`]?.[0],
          }}
        />
      ))}
      {total === null ? null : (
        <p role="status" className="text-base font-medium">
          {total}
        </p>
      )}
      {waitlist ? <p className="text-base">{WAITLIST_PREDICTION}</p> : null}
      {deadlinePassed ? <p className="text-base">{LATE_REGISTRATION_HINT}</p> : null}
      <button
        type="submit"
        aria-disabled={pending ? 'true' : undefined}
        onClick={(event) => {
          if (pending) event.preventDefault();
        }}
        className={`${BUTTON_CLASS} sm:w-auto`}
      >
        {pending ? submitPendingLabel(waitlist) : submitLabel(waitlist)}
      </button>
    </form>
  );
}
