'use client';

import type { Dispatch } from 'react';
import type { FieldErrors } from '../../lib/auth/validation.ts';
import type { SessionFormAction, SessionFormState } from '../../lib/teams/session-form-state.ts';
import { CAPACITY_HINT, FIXED_DATE_HINT, formatDay } from '../../lib/teams/sessions-view.ts';
import { SessionField } from './session-field.tsx';

/**
 * Details (Location, Address, Date). A one-off session edits its date; a series date shows it as text with the
 * "cancel it and create a one-off" hint (an instance's date cannot move); a series form has no date here.
 */
export function DetailsFieldset({
  state,
  errors,
  dispatch,
  date,
}: {
  state: SessionFormState;
  errors: FieldErrors;
  dispatch: Dispatch<SessionFormAction>;
  date: 'input' | 'fixed' | 'none';
}) {
  return (
    <fieldset className="flex min-w-0 flex-col gap-4">
      <legend className="text-lg font-semibold">Details</legend>
      <div className="grid gap-3 sm:grid-cols-2">
        <SessionField
          name="location"
          label="Location"
          value={state.details.location}
          error={errors.location?.[0]}
          onChange={(value) => {
            dispatch({ type: 'set_details', field: 'location', value });
          }}
        />
        <SessionField
          name="address"
          label="Address"
          value={state.details.address}
          error={errors.address?.[0]}
          onChange={(value) => {
            dispatch({ type: 'set_details', field: 'address', value });
          }}
        />
      </div>
      {date === 'input' ? (
        <SessionField
          name="date"
          type="date"
          label="Date"
          value={state.details.date}
          error={errors.date?.[0]}
          onChange={(value) => {
            dispatch({ type: 'set_details', field: 'date', value });
          }}
        />
      ) : null}
      {date === 'fixed' ? (
        <div className="flex flex-col gap-1">
          <p className="text-base font-medium">Date</p>
          <p className="text-base text-slate-900">{formatDay(state.details.date)}</p>
          <p className="text-sm text-slate-700">{FIXED_DATE_HINT}</p>
          <input type="hidden" name="date" value={state.details.date} />
        </div>
      ) : null}
    </fieldset>
  );
}

/** Places: "Max players" and "Reserved host seats"; a published session says lowering never removes anyone. */
export function PlacesFieldset({
  state,
  errors,
  dispatch,
  published,
}: {
  state: SessionFormState;
  errors: FieldErrors;
  dispatch: Dispatch<SessionFormAction>;
  published: boolean;
}) {
  return (
    <fieldset className="flex min-w-0 flex-col gap-4">
      <legend className="text-lg font-semibold">Places</legend>
      <div className="grid gap-3 sm:grid-cols-2">
        <SessionField
          name="maxPlayers"
          label="Max players"
          inputMode="numeric"
          hint={published ? CAPACITY_HINT : undefined}
          value={state.places.maxPlayers}
          error={errors.maxPlayers?.[0]}
          onChange={(value) => {
            dispatch({ type: 'set_places', field: 'maxPlayers', value });
          }}
        />
        <SessionField
          name="reservedSeats"
          label="Reserved host seats"
          inputMode="numeric"
          value={state.places.reservedSeats}
          error={errors.reservedSeats?.[0]}
          onChange={(value) => {
            dispatch({ type: 'set_places', field: 'reservedSeats', value });
          }}
        />
      </div>
    </fieldset>
  );
}
