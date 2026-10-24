'use client';

import { useState, type ReactNode } from 'react';
import type { ModerationAction } from '../../lib/teams/moderation.ts';
import type { SectionId } from '../../lib/teams/manage-view.ts';
import { INPUT_CLASS } from '../auth/styles.ts';
import { ConfirmDisclosure, ConfirmPanel } from './confirm-disclosure.tsx';
import { useManage } from './manage-context.tsx';
import { useModerationAction } from './use-moderation-action.ts';

// Sessions forms import the presentational panel from here; it now lives in `confirm-disclosure.tsx` (R11).
export { ConfirmPanel };

export interface ReasonField {
  name: string;
  label: string;
  maxLength: number;
}

/**
 * The one confirmation pattern of the manage area (UI/UX "Interactions"): a disclosure, not a dialog, built on the
 * context-free `ConfirmDisclosure` (the registration panel uses the same core). The trigger is a button with `aria-expanded`
 * and `aria-controls`; the panel is a `ConfirmPanel` under the row, so the rest of the page stays reachable and nothing
 * is mistaken for a native browser dialog (a UAT blocker). Opening moves focus to the prompt; the dismiss button and Escape close
 * the panel and return focus to the trigger. Only one confirm is open per section (the manage context holds which). A 5xx keeps
 * the panel open with what was typed. Needs JavaScript (accepted: the safe failure is "cannot do the destructive thing").
 * `section` is the status region and confirm slot it reports to, so any area of the manage page can use
 * it. `dismissLabel` defaults to "Cancel" (People and Banking); Sessions always passes an explicit one.
 * `children` render inside the confirm's form, between the hidden fields and the buttons, and are
 * submitted with the action (the End series date and checkbox).
 */
export function InlineConfirm({
  id,
  section,
  action,
  fields,
  triggerLabel,
  triggerAriaLabel,
  prompt,
  confirmLabel,
  pendingLabel,
  dismissLabel = 'Cancel',
  destructive = false,
  reasonField,
  describedBy,
  focusOnSuccess,
  defaultOpen = false,
  children,
}: {
  id: string;
  section: SectionId;
  action: ModerationAction;
  fields: Record<string, string>;
  triggerLabel: string;
  triggerAriaLabel?: string;
  prompt: string;
  confirmLabel: string;
  pendingLabel: string;
  dismissLabel?: string;
  destructive?: boolean;
  reasonField?: ReasonField;
  describedBy?: string;
  focusOnSuccess?: string;
  /** Render the panel open on first render (tests, and a panel that must be visible without script). */
  defaultOpen?: boolean;
  children?: ReactNode;
}) {
  const { state: manage, dispatch } = useManage();
  const { state, formAction, pending } = useModerationAction(section, action, focusOnSuccess);
  const [reason, setReason] = useState('');
  const open = defaultOpen || manage.open[section] === id;
  const reasonId = `${id}-reason`;
  const reasonError = state?.fieldErrors?.reason?.[0];

  return (
    <ConfirmDisclosure
      id={id}
      open={open}
      onOpenChange={(next) => {
        dispatch(next ? { type: 'open', section, id } : { type: 'close', section, id });
        if (!next) setReason('');
      }}
      triggerLabel={triggerLabel}
      triggerAriaLabel={triggerAriaLabel}
      describedBy={describedBy}
      prompt={prompt}
      confirmLabel={confirmLabel}
      pendingLabel={pendingLabel}
      dismissLabel={dismissLabel}
      destructive={destructive}
      pending={pending}
      formAction={formAction}
    >
      {Object.entries(fields).map(([name, value]) => (
        <input key={name} type="hidden" name={name} value={value} />
      ))}
      {reasonField === undefined ? null : (
        <div className="flex flex-col gap-1">
          <label htmlFor={reasonId} className="text-base font-medium">
            {reasonField.label}
          </label>
          <textarea
            id={reasonId}
            name={reasonField.name}
            rows={3}
            maxLength={reasonField.maxLength}
            value={reason}
            aria-invalid={reasonError === undefined ? undefined : 'true'}
            aria-describedby={reasonError === undefined ? undefined : `${reasonId}-error`}
            onChange={(event) => {
              setReason(event.target.value);
            }}
            className={INPUT_CLASS}
          />
          {reasonError === undefined ? null : (
            <p id={`${reasonId}-error`} className="text-base text-red-800">
              {reasonError}
            </p>
          )}
        </div>
      )}
      {children}
    </ConfirmDisclosure>
  );
}
