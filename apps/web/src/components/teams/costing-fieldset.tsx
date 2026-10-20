'use client';

import { formatNZD } from '@sgm/shared';
import type { Dispatch } from 'react';
import type { FieldErrors } from '../../lib/auth/validation.ts';
import {
  suggestionOf,
  type SessionFormAction,
  type SessionFormState,
} from '../../lib/teams/session-form-state.ts';
import { COSTING_COPY, suggestionLine } from '../../lib/teams/sessions-view.ts';
import { SessionField } from './session-field.tsx';

/**
 * Costing (UI/UX D2 option A): "Court hire (total)", "Extra expenses" and the read-only suggestion line. The
 * suggestion comes from the shared `suggestedRate`, so web and API agree to the cent. It is not a live region
 * (it would chatter on each keystroke). A blank court hire means $0.00, a free session.
 */
export function CostingFieldset({
  state,
  errors,
  dispatch,
}: {
  state: SessionFormState;
  errors: FieldErrors;
  dispatch: Dispatch<SessionFormAction>;
}) {
  const suggestion = suggestionOf(state);
  const maxPlayers = Number(state.places.maxPlayers);
  const reserved = Number(state.places.reservedSeats);
  const lockedWhileFollowing =
    state.pricing.locked && state.pricing.model === 'FLAT' && state.pricing.rateMode === 'follow';
  return (
    <fieldset className="flex min-w-0 flex-col gap-4">
      <legend className="text-lg font-semibold">{COSTING_COPY.legend}</legend>
      <div className="grid gap-3 sm:grid-cols-2">
        <SessionField
          name="courtCost"
          label={COSTING_COPY.courtHire}
          hint={COSTING_COPY.courtHireHint}
          money
          value={state.costing.courtCost}
          error={errors.courtCost?.[0]}
          onChange={(value) => {
            dispatch({ type: 'set_costing', field: 'courtCost', value });
          }}
        />
        <SessionField
          name="extraExpenses"
          label={COSTING_COPY.extras}
          money
          value={state.costing.extraExpenses}
          error={errors.extraExpenses?.[0]}
          onChange={(value) => {
            dispatch({ type: 'set_costing', field: 'extraExpenses', value });
          }}
        />
      </div>
      <p id="costing-suggestion" className="text-base text-slate-900">
        {suggestion === null
          ? COSTING_COPY.incomplete
          : suggestionLine(formatNZD(suggestion), maxPlayers)}
      </p>
      {suggestion !== null && reserved > 0 ? (
        <p className="text-sm text-slate-700">{COSTING_COPY.hostSeatCaveat}</p>
      ) : null}
      {lockedWhileFollowing ? (
        <p className="text-sm text-slate-700">{COSTING_COPY.locked}</p>
      ) : null}
    </fieldset>
  );
}
