'use client';

import { useFormStatus } from 'react-dom';
import { SECONDARY_BUTTON_CLASS } from './styles.ts';

/**
 * A secondary submit button for the small per-row forms on /account (Connect, Disconnect). While its form
 * runs it shows the pending label, stays focusable (`aria-disabled`) and ignores clicks (no double submit).
 */
export function ActionButton({
  label,
  pendingLabel,
  ariaLabel,
}: {
  label: string;
  pendingLabel: string;
  /** Accessible name when the visible label is shared by several rows ("Disconnect Google"). */
  ariaLabel?: string;
}) {
  const { pending } = useFormStatus();
  return (
    <button
      type="submit"
      aria-disabled={pending}
      aria-label={ariaLabel}
      onClick={(event) => {
        if (pending) event.preventDefault();
      }}
      className={SECONDARY_BUTTON_CLASS}
    >
      {pending ? pendingLabel : label}
    </button>
  );
}
