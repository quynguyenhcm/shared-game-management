'use client';

import { useEffect, useRef, type ReactNode } from 'react';
import { FOCUS_RING, SECONDARY_BUTTON_CLASS } from '../auth/styles.ts';

/**
 * The presentational half of the confirmation pattern: a non-modal `role="group"` labelled by its prompt.
 * The prompt takes focus when the panel mounts, Escape calls `onDismiss`, and the dismiss button always
 * carries an explicit label (Sessions never shows "Cancel" beside "Cancel session"). It owns no state and
 * reads no context, so it works both inside `ConfirmDisclosure` (which gives it a `formAction`, and the panel
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
 * The disclosure around a `ConfirmPanel`, free of any page context (extracted from `InlineConfirm`, R11): a button with
 * `aria-expanded` and `aria-controls` and, when open, the panel under it, so the rest of the page stays reachable and nothing
 * is mistaken for a native browser dialog (a UAT blocker). Opening moves focus to the prompt; the dismiss button and Escape close
 * the panel and return focus to the trigger. The open state belongs to the caller (`open`, `onOpenChange`): the manage area keeps
 * it in its context so only one confirm is open per section, the registration panel in a `useState`.
 */
export function ConfirmDisclosure({
  id,
  open,
  onOpenChange,
  triggerLabel,
  triggerAriaLabel,
  describedBy,
  prompt,
  confirmLabel,
  pendingLabel,
  dismissLabel = 'Cancel',
  destructive = false,
  pending = false,
  formAction,
  children,
}: {
  id: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  triggerLabel: string;
  triggerAriaLabel?: string;
  describedBy?: string;
  prompt: string;
  confirmLabel: string;
  pendingLabel: string;
  dismissLabel?: string;
  destructive?: boolean;
  pending?: boolean;
  formAction?: (formData: FormData) => void;
  children?: ReactNode;
}) {
  const triggerRef = useRef<HTMLButtonElement>(null);

  return (
    <div className="flex w-full flex-col gap-3 sm:w-auto">
      <button
        ref={triggerRef}
        type="button"
        aria-expanded={open}
        aria-controls={`${id}-panel`}
        aria-label={triggerAriaLabel}
        aria-describedby={describedBy}
        onClick={() => {
          onOpenChange(!open);
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
          onDismiss={() => {
            onOpenChange(false);
            triggerRef.current?.focus();
          }}
          destructive={destructive}
          pending={pending}
          formAction={formAction}
        >
          {children}
        </ConfirmPanel>
      ) : null}
    </div>
  );
}
