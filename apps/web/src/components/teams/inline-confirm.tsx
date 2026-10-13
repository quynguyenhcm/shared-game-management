'use client';

import { useEffect, useRef, useState } from 'react';
import {
  sectionFor,
  type ModerationAction,
  type ModerationKind,
} from '../../lib/teams/moderation.ts';
import { FOCUS_RING, INPUT_CLASS, SECONDARY_BUTTON_CLASS } from '../auth/styles.ts';
import { useManage } from './manage-context.tsx';
import { useModerationAction } from './use-moderation-action.ts';

export interface ReasonField {
  name: string;
  label: string;
  maxLength: number;
}

/**
 * The one confirmation pattern of the manage area (UI/UX "Interactions"): a disclosure, not a dialog. The
 * trigger is a button with `aria-expanded` and `aria-controls`; the panel is a non-modal `role="group"` under
 * the row, so the rest of the page stays reachable and nothing is mistaken for a native browser dialog (a
 * UAT blocker). Opening moves focus to the prompt; Cancel and Escape close the panel and return focus
 * to the trigger. Only one confirm is open per section. A 5xx keeps the panel open with what was typed.
 * Needs JavaScript (accepted: the safe failure is "cannot do the destructive thing").
 */
export function InlineConfirm({
  id,
  kind,
  action,
  fields,
  triggerLabel,
  triggerAriaLabel,
  prompt,
  confirmLabel,
  pendingLabel,
  destructive = false,
  reasonField,
  describedBy,
  focusOnSuccess,
  defaultOpen = false,
}: {
  id: string;
  kind: ModerationKind;
  action: ModerationAction;
  fields: Record<string, string>;
  triggerLabel: string;
  triggerAriaLabel?: string;
  prompt: string;
  confirmLabel: string;
  pendingLabel: string;
  destructive?: boolean;
  reasonField?: ReasonField;
  describedBy?: string;
  focusOnSuccess?: string;
  /** Render the panel open on first render (tests, and a panel that must be visible without script). */
  defaultOpen?: boolean;
}) {
  const section = sectionFor(kind);
  const { state: manage, dispatch } = useManage();
  const { state, formAction, pending } = useModerationAction(kind, action, focusOnSuccess);
  const [reason, setReason] = useState('');
  const triggerRef = useRef<HTMLButtonElement>(null);
  const promptRef = useRef<HTMLParagraphElement>(null);
  const open = defaultOpen || manage.open[section] === id;
  const panelId = `${id}-panel`;
  const promptId = `${id}-prompt`;
  const reasonId = `${id}-reason`;
  const reasonError = state?.fieldErrors?.reason?.[0];

  useEffect(() => {
    if (open) promptRef.current?.focus();
  }, [open]);

  const cancel = (): void => {
    dispatch({ type: 'close', section, id });
    setReason('');
    triggerRef.current?.focus();
  };

  return (
    <div className="flex w-full flex-col gap-3 sm:w-auto">
      <button
        ref={triggerRef}
        type="button"
        aria-expanded={open}
        aria-controls={panelId}
        aria-label={triggerAriaLabel}
        aria-describedby={describedBy}
        onClick={() => {
          dispatch(open ? { type: 'close', section, id } : { type: 'open', section, id });
        }}
        className={`${SECONDARY_BUTTON_CLASS} sm:w-auto`}
      >
        {triggerLabel}
      </button>
      {open ? (
        <div
          id={panelId}
          role="group"
          aria-labelledby={promptId}
          onKeyDown={(event) => {
            if (event.key === 'Escape') {
              event.stopPropagation();
              cancel();
            }
          }}
          className="flex w-full flex-col gap-3 rounded-md border-2 border-slate-900 bg-slate-50 p-4 sm:min-w-80"
        >
          <p id={promptId} ref={promptRef} tabIndex={-1} className={`text-base ${FOCUS_RING}`}>
            {prompt}
          </p>
          <form action={formAction} className="flex flex-col gap-3">
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
            <div className="flex flex-col gap-2 sm:flex-row">
              <button
                type="submit"
                aria-disabled={pending ? 'true' : undefined}
                onClick={(event) => {
                  if (pending) event.preventDefault();
                }}
                className={`inline-flex min-h-11 w-full items-center justify-center rounded-md px-4 py-2 text-base font-medium text-white aria-disabled:cursor-not-allowed aria-disabled:opacity-60 sm:w-auto ${
                  destructive ? 'bg-red-800' : 'bg-slate-900'
                } ${FOCUS_RING}`}
              >
                {pending ? pendingLabel : confirmLabel}
              </button>
              <button
                type="button"
                onClick={cancel}
                className={`${SECONDARY_BUTTON_CLASS} sm:w-auto`}
              >
                Cancel
              </button>
            </div>
          </form>
        </div>
      ) : null}
    </div>
  );
}
