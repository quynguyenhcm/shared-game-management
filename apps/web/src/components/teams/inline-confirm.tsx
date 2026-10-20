'use client';

import { useEffect, useRef, useState, type ReactNode } from 'react';
import type { ModerationAction } from '../../lib/teams/moderation.ts';
import type { SectionId } from '../../lib/teams/manage-view.ts';
import { FOCUS_RING, INPUT_CLASS, SECONDARY_BUTTON_CLASS } from '../auth/styles.ts';
import { useManage } from './manage-context.tsx';
import { useModerationAction } from './use-moderation-action.ts';

export interface ReasonField {
  name: string;
  label: string;
  maxLength: number;
}

/**
 * The presentational half of the confirmation pattern: a non-modal `role="group"` labelled by its prompt.
 * The prompt takes focus when the panel mounts, Escape calls `onDismiss`, and the dismiss button always
 * carries an explicit label (Sessions never shows "Cancel" beside "Cancel session"). It owns no state and
 * reads no context, so it works both inside `InlineConfirm` (which gives it a `formAction`, and the panel
 * then wraps its children and buttons in their own `<form>`) and inside a larger form (no `formAction`:
 * the confirm is a submit button of that form, with an optional `name` and `value`).
 */
export function ConfirmPanel({
  id,
  prompt,
  confirmLabel,
  pendingLabel,
  dismissLabel,
  onDismiss,
  destructive = false,
  pending = false,
  confirmName,
  confirmValue,
  formAction,
  children,
}: {
  id: string;
  prompt: string;
  confirmLabel: string;
  pendingLabel: string;
  dismissLabel: string;
  onDismiss: () => void;
  destructive?: boolean;
  pending?: boolean;
  confirmName?: string;
  confirmValue?: string;
  /** When given, the children and the buttons are wrapped in a form that runs this action. */
  formAction?: (formData: FormData) => void;
  children?: ReactNode;
}) {
  const promptRef = useRef<HTMLParagraphElement>(null);
  const promptId = `${id}-prompt`;

  useEffect(() => {
    promptRef.current?.focus();
  }, []);

  const body = (
    <>
      {children}
      <div className="flex flex-col gap-2 sm:flex-row">
        <button
          type="submit"
          name={confirmName}
          value={confirmValue}
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
        <button type="button" onClick={onDismiss} className={`${SECONDARY_BUTTON_CLASS} sm:w-auto`}>
          {dismissLabel}
        </button>
      </div>
    </>
  );

  return (
    <div
      id={`${id}-panel`}
      role="group"
      aria-labelledby={promptId}
      onKeyDown={(event) => {
        if (event.key === 'Escape') {
          event.stopPropagation();
          onDismiss();
        }
      }}
      className="flex w-full flex-col gap-3 rounded-md border-2 border-slate-900 bg-slate-50 p-4 sm:min-w-80"
    >
      <p id={promptId} ref={promptRef} tabIndex={-1} className={`text-base ${FOCUS_RING}`}>
        {prompt}
      </p>
      {formAction === undefined ? (
        <div className="flex flex-col gap-3">{body}</div>
      ) : (
        <form action={formAction} className="flex flex-col gap-3">
          {body}
        </form>
      )}
    </div>
  );
}

/**
 * The one confirmation pattern of the manage area (UI/UX "Interactions"): a disclosure, not a dialog. The
 * trigger is a button with `aria-expanded` and `aria-controls`; the panel is a `ConfirmPanel` under the
 * row, so the rest of the page stays reachable and nothing is mistaken for a native browser dialog (a
 * UAT blocker). Opening moves focus to the prompt; the dismiss button and Escape close the panel and
 * return focus to the trigger. Only one confirm is open per section. A 5xx keeps the panel open with what
 * was typed. Needs JavaScript (accepted: the safe failure is "cannot do the destructive thing").
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
  const triggerRef = useRef<HTMLButtonElement>(null);
  const open = defaultOpen || manage.open[section] === id;
  const panelId = `${id}-panel`;
  const reasonId = `${id}-reason`;
  const reasonError = state?.fieldErrors?.reason?.[0];

  const dismiss = (): void => {
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
        <ConfirmPanel
          id={id}
          prompt={prompt}
          confirmLabel={confirmLabel}
          pendingLabel={pendingLabel}
          dismissLabel={dismissLabel}
          onDismiss={dismiss}
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
        </ConfirmPanel>
      ) : null}
    </div>
  );
}
