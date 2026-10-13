'use client';

import { useState } from 'react';
import { FieldError, describedBy } from './field-message.tsx';
import { FOCUS_RING, INPUT_CLASS } from './styles.ts';

export interface PasswordFieldProps {
  name?: string;
  label?: string;
  hint?: string;
  error?: string;
  autoComplete: 'current-password' | 'new-password';
}

/** Password input with a "Show password" toggle. Never given a value: passwords are not echoed back. */
export function PasswordField({
  name = 'password',
  label = 'Password',
  hint,
  error,
  autoComplete,
}: PasswordFieldProps) {
  const [shown, setShown] = useState(false);
  const id = `field-${name}`;
  return (
    <div className="flex flex-col gap-1">
      <label htmlFor={id} className="text-base font-medium">
        {label}
      </label>
      {hint ? (
        <p id={`${id}-hint`} className="text-sm text-slate-700">
          {hint}
        </p>
      ) : null}
      {error ? <FieldError id={`${id}-error`} message={error} /> : null}
      <div className="flex gap-2">
        <input
          id={id}
          name={name}
          type={shown ? 'text' : 'password'}
          autoComplete={autoComplete}
          autoCapitalize="none"
          autoCorrect="off"
          spellCheck={false}
          aria-invalid={error ? true : undefined}
          aria-describedby={describedBy(id, { hint, error })}
          className={INPUT_CLASS}
        />
        <button
          type="button"
          aria-pressed={shown}
          onClick={() => {
            setShown((value) => !value);
          }}
          className={`min-h-11 shrink-0 rounded-md border border-slate-500 px-3 text-base ${FOCUS_RING}`}
        >
          {shown ? 'Hide password' : 'Show password'}
        </button>
      </div>
    </div>
  );
}
