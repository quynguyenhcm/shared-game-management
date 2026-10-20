'use client';

import type { Dispatch } from 'react';
import type { FieldErrors } from '../../lib/auth/validation.ts';
import {
  RATE_FIELD_ID,
  feeOtherText,
  lockedFeeErrors,
  rateFieldText,
  type FeeField,
  type SessionFormAction,
  type SessionFormState,
} from '../../lib/teams/session-form-state.ts';
import {
  FEES_LOCKED_MESSAGE,
  PRICING_COPY,
  PRICING_MODEL_LABELS,
  PRICING_OPTIONS,
} from '../../lib/teams/sessions-view.ts';
import { FOCUS_RING, SECONDARY_BUTTON_CLASS } from '../auth/styles.ts';
import { SessionField } from './session-field.tsx';

const FEE_LABELS: Readonly<Record<FeeField, string>> = {
  feeMale: 'Male',
  feeFemale: 'Female',
  feeOther: 'Other',
  feeBeginner: 'Beginner',
  feeIntermediate: 'Intermediate',
  feeAdvanced: 'Advanced',
};

/**
 * Pricing (UI/UX D2 option A): the model radios first, then only that model's inputs, so the form never shows an
 * unused field. Flat rate follows the suggestion until typed (then it is pinned, and sent), with "Use suggested
 * rate" while pinned. By sex and By skill level reveal one input per fee, pre-filled from the final rate on
 * first reveal, with one fill button. On a session with registrations the model is static text and no fee may
 * go up (T-7); the API still refuses a raise.
 */
export function PricingFieldset({
  state,
  errors,
  dispatch,
}: {
  state: SessionFormState;
  errors: FieldErrors;
  dispatch: Dispatch<SessionFormAction>;
}) {
  const { pricing } = state;
  const all = { ...errors, ...lockedFeeErrors(state) };
  const pinned = pricing.rateMode === 'pinned';
  return (
    <fieldset className="flex min-w-0 flex-col gap-4">
      <legend className="text-lg font-semibold">{PRICING_COPY.legend}</legend>
      {pricing.locked ? (
        <>
          <input type="hidden" name="pricingStructure" value={pricing.model} />
          <p className="text-base font-medium">{`Pricing: ${PRICING_MODEL_LABELS[pricing.model]}`}</p>
          <p className="text-sm text-slate-700">{FEES_LOCKED_MESSAGE}</p>
        </>
      ) : (
        <div className="flex flex-col">
          {PRICING_OPTIONS.map((option, index) => {
            const helpId = `pricing-${option.value.toLowerCase()}-help`;
            return (
              <div key={option.value}>
                <label className="flex min-h-11 items-center gap-3 text-base">
                  <input
                    type="radio"
                    name="pricingStructure"
                    value={option.value}
                    id={index === 0 ? 'field-pricingStructure' : undefined}
                    checked={pricing.model === option.value}
                    aria-describedby={helpId}
                    onChange={() => {
                      dispatch({ type: 'set_model', model: option.value });
                    }}
                    className={`size-5 ${FOCUS_RING}`}
                  />
                  {option.label}
                </label>
                <p id={helpId} className="pb-1 pl-8 text-sm text-slate-700">
                  {option.help}
                </p>
              </div>
            );
          })}
        </div>
      )}

      {pricing.model === 'FLAT' ? (
        <div className="flex flex-col gap-2">
          <SessionField
            id={RATE_FIELD_ID}
            name={pinned ? 'customPlayerRate' : undefined}
            label={PRICING_COPY.flatRate}
            money
            value={rateFieldText(state)}
            error={all.customPlayerRate?.[0]}
            describedBy="pricing-rate-status"
            onChange={(value) => {
              dispatch({ type: 'type_rate', value });
            }}
          />
          <p id="pricing-rate-status" className="text-sm text-slate-700">
            {pinned ? PRICING_COPY.pinned : PRICING_COPY.following}
          </p>
          {pinned ? (
            <button
              type="button"
              onClick={() => {
                dispatch({ type: 'use_suggested_rate' });
              }}
              className={`${SECONDARY_BUTTON_CLASS} sm:w-auto sm:self-start`}
            >
              {PRICING_COPY.useSuggested}
            </button>
          ) : null}
        </div>
      ) : (
        <div className="flex flex-col gap-3">
          <div className="grid gap-3 sm:grid-cols-3">
            {(pricing.model === 'BY_SEX'
              ? (['feeMale', 'feeFemale', 'feeOther'] as const)
              : (['feeBeginner', 'feeIntermediate', 'feeAdvanced'] as const)
            ).map((field) => (
              <SessionField
                key={field}
                name={field}
                label={FEE_LABELS[field]}
                money
                hint={field === 'feeOther' ? PRICING_COPY.otherHint : undefined}
                value={field === 'feeOther' ? feeOtherText(state) : pricing[field]}
                error={all[field]?.[0]}
                onChange={(value) => {
                  dispatch({ type: 'set_fee', field, value });
                }}
              />
            ))}
          </div>
          {pricing.locked ? null : (
            <button
              type="button"
              onClick={() => {
                dispatch({ type: 'fill_all' });
              }}
              className={`${SECONDARY_BUTTON_CLASS} sm:w-auto sm:self-start`}
            >
              {PRICING_COPY.fillAll}
            </button>
          )}
        </div>
      )}
    </fieldset>
  );
}
