'use client';

import type { ModerationAction, ModerationKind } from '../../lib/teams/moderation.ts';
import { BUTTON_CLASS, SECONDARY_BUTTON_CLASS } from '../auth/styles.ts';
import { useModerationAction } from './use-moderation-action.ts';

/**
 * A one-tap action (Approve, Reject, Make admin, Remove admin): a plain `<form action>` so it also works
 * before hydration. The visible name is short; the accessible name starts with it and adds the person
 * (WCAG label-in-name). `aria-disabled` while pending keeps focus and ignores a second click.
 */
export function ModerationButton({
  kind,
  action,
  fields,
  label,
  ariaLabel,
  pendingLabel,
  variant = 'secondary',
  focus,
}: {
  kind: ModerationKind;
  action: ModerationAction;
  fields: Record<string, string>;
  label: string;
  ariaLabel: string;
  pendingLabel: string;
  variant?: 'primary' | 'secondary';
  /** Selector to focus after success; default is the section heading. */
  focus?: string;
}) {
  const { formAction, pending } = useModerationAction(kind, action, focus);
  const className = `${variant === 'primary' ? BUTTON_CLASS : SECONDARY_BUTTON_CLASS} sm:w-auto`;
  return (
    <form action={formAction} className="flex-1 sm:flex-none">
      {Object.entries(fields).map(([name, value]) => (
        <input key={name} type="hidden" name={name} value={value} />
      ))}
      <button
        type="submit"
        aria-label={ariaLabel}
        aria-disabled={pending ? 'true' : undefined}
        onClick={(event) => {
          if (pending) event.preventDefault();
        }}
        className={`${className} w-full`}
      >
        {pending ? pendingLabel : label}
      </button>
    </form>
  );
}
