'use client';

import {
  createContext,
  useActionState,
  useCallback,
  useContext,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import { OUTAGE_MESSAGE } from '../../lib/teams/labels.ts';
import type {
  RegistrationAction,
  RegistrationActionResult,
} from '../../lib/registrations/outcome.ts';
import { PANEL_HEADING } from '../../lib/registrations/labels.ts';

/** The heading focus returns to after a successful action (the form or the confirmation has just been replaced). */
export const REGISTRATION_HEADING_ID = 'registration-heading';

interface ShellContext {
  report: (result: RegistrationActionResult) => void;
}

const Context = createContext<ShellContext | null>(null);

interface Note {
  readonly message: string;
  readonly ok: boolean;
}

/**
 * The panel's thin client shell (UI/UX "Key components"): the heading, one persistent `role="status"` region that is mounted
 * from the first render (so the first change is announced) and holds only the outcome card and the transient note, and the
 * context the two islands report their action results to. The form and the buttons live outside the live region, so typing is
 * never announced. A note stays until the next action or navigation (WCAG 2.2.1: nothing auto-dismisses). After a success the
 * heading takes focus, because the form or confirmation the player used has been replaced by the new state.
 */
export function RegistrationShell({
  outcome,
  children,
}: {
  /** The server-rendered outcome card (or nothing), inside the live region. */
  outcome: ReactNode;
  children: ReactNode;
}) {
  const [note, setNote] = useState<Note | null>(null);

  const report = useCallback((result: RegistrationActionResult): void => {
    // A failed submit with field errors is announced by the error summary; the status region would only repeat it.
    setNote(result.fieldErrors === undefined ? { message: result.message, ok: result.ok } : null);
    if (result.ok) document.getElementById(REGISTRATION_HEADING_ID)?.focus();
  }, []);

  const value = useMemo(() => ({ report }), [report]);

  return (
    <Context.Provider value={value}>
      <h2
        id={REGISTRATION_HEADING_ID}
        tabIndex={-1}
        className="text-xl font-semibold focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-700"
      >
        {PANEL_HEADING}
      </h2>
      <div role="status" aria-live="polite" aria-atomic="false" className="flex flex-col gap-3">
        {note === null ? null : (
          <p
            className={`rounded-md border-2 p-3 text-base font-medium ${
              note.ok ? 'border-blue-800 bg-blue-50' : 'border-red-800 bg-red-50'
            }`}
          >
            {note.ok ? null : <span className="sr-only">Error: </span>}
            {note.message}
          </p>
        )}
        {outcome}
      </div>
      {children}
    </Context.Provider>
  );
}

/**
 * Runs a registration Server Action as a form action and reports its result to the shell. Reporting happens inside the action
 * (not in an effect), because a successful result revalidates the page and the form it came from unmounts. A rejected fetch (the
 * browser is offline) is an outage, not a crash; redirects are not caught here.
 */
export function useRegistrationAction(
  action: RegistrationAction,
  /** Called with each result inside the action (the withdraw island re-opens its confirmation from here). */
  onResult?: (result: RegistrationActionResult) => void,
): {
  state: RegistrationActionResult | null;
  dispatch: (formData: FormData) => void;
  pending: boolean;
} {
  const shell = useContext(Context);
  const [state, dispatch, pending] = useActionState<RegistrationActionResult | null, FormData>(
    async (previous, formData) => {
      let result: RegistrationActionResult;
      try {
        result = await action(previous, formData);
      } catch (error) {
        if (!(error instanceof TypeError)) throw error;
        result = { ok: false, code: 'offline', message: OUTAGE_MESSAGE, refresh: false };
      }
      shell?.report(result);
      onResult?.(result);
      return result;
    },
    null,
  );
  return { state, dispatch, pending };
}
