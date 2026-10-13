'use client';

import { useActionState, useMemo, useState } from 'react';
import type { FormAction, FormState } from '../../lib/auth/form-state.ts';
import { withOfflineFallback } from '../../lib/auth/form-state.ts';
import type { FieldErrors } from '../../lib/auth/validation.ts';

type Values = Record<string, string | undefined>;

export interface AuthForm {
  state: FormState;
  /** Pass to `<form action>`: validates in the browser first, then runs the Server Action. */
  submit: (formData: FormData) => void;
  /** Client-side errors win until the next valid submit; otherwise the server's field errors. */
  fieldErrors: FieldErrors;
  /** Values to refill (never a password). */
  values: Record<string, string>;
  /** Changes on every failed client validation, so the error summary takes focus again. */
  clientFailure: FieldErrors | null;
}

/**
 * Shared behaviour of the auth forms: progressive-enhancement Server Action, client validation with the
 * same shared messages (X9: the button stays enabled and the error summary explains), kept inputs
 * except passwords, and the offline fallback.
 */
export function useAuthForm(
  action: FormAction,
  validate: (values: Values) => FieldErrors,
  secretFields: readonly string[] = ['password'],
): AuthForm {
  const guarded = useMemo(() => withOfflineFallback(action), [action]);
  const [state, dispatch] = useActionState(guarded, {});
  const [clientFailure, setClientFailure] = useState<FieldErrors | null>(null);
  const [clientValues, setClientValues] = useState<Record<string, string>>({});

  const submit = (formData: FormData): void => {
    const values: Record<string, string> = {};
    for (const [name, value] of formData.entries()) {
      if (typeof value === 'string' && !secretFields.includes(name)) values[name] = value;
    }
    const errors = validate(Object.fromEntries(formData.entries()) as Values);
    if (Object.keys(errors).length > 0) {
      setClientFailure(errors);
      setClientValues(values);
      return;
    }
    setClientFailure(null);
    dispatch(formData);
  };

  return {
    state,
    submit,
    fieldErrors: clientFailure ?? state.fieldErrors ?? {},
    values: clientFailure ? clientValues : (state.values ?? {}),
    clientFailure,
  };
}
