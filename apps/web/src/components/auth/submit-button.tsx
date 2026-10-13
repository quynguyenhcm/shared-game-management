'use client';

import { useFormStatus } from 'react-dom';
import { BUTTON_CLASS } from './styles.ts';

/**
 * The form's primary button. While the action runs it shows the pending label, is `aria-disabled`
 * (so it stays focusable) and ignores clicks (no double submit); a polite live region announces it.
 */
export function SubmitButton({ label, pendingLabel }: { label: string; pendingLabel: string }) {
  const { pending } = useFormStatus();
  return (
    <>
      <button
        type="submit"
        aria-disabled={pending}
        onClick={(event) => {
          if (pending) event.preventDefault();
        }}
        className={BUTTON_CLASS}
      >
        {pending ? pendingLabel : label}
      </button>
      <span role="status" aria-live="polite" className="sr-only">
        {pending ? pendingLabel : ''}
      </span>
    </>
  );
}
