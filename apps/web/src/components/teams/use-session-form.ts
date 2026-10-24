'use client';

import { useActionState, useEffect, useMemo, useReducer, useState } from 'react';
import { withOfflineFallback } from '../../lib/auth/form-state.ts';
import type { FieldErrors } from '../../lib/auth/validation.ts';
import {
  errorOrder,
  mapServerFieldErrors,
  sessionFormReducer,
  validateSessionForm,
  type SessionActionState,
  type SessionFormAction,
  type SessionFormState,
} from '../../lib/teams/session-form-state.ts';

export type SessionFormServerAction = (
  previous: SessionActionState,
  formData: FormData,
) => Promise<SessionActionState>;

export interface SessionForm {
  state: SessionFormState;
  dispatch: (action: SessionFormAction) => void;
  /** Pass to `<form action>`: validates in the browser first, then runs the Server Action. */
  submit: (formData: FormData) => void;
  /** Client errors win until the next valid submit; otherwise the server's, re-keyed to the form. */
  fieldErrors: FieldErrors;
  /** What the last Server Action returned in place (a page error, field errors, DST choices). */
  serverState: SessionActionState;
  /** Changes on every failed client validation, so the error summary takes focus again. */
  clientFailure: FieldErrors | null;
  /** Field names in page order for the error summary. */
  errorOrder: string[];
}

/**
 * Wires the pure form reducer to a Server Action: controlled state (React 19 resets uncontrolled fields after
 * a form action), client validation with the shared copy that blocks without disabling the button, the offline
 * fallback, DST choices from the API's 422 body, and the one-shot focus request (after add, remove, a DST
 * choice or "Use suggested rate"). A redirecting action leaves the page; an in-place result keeps what was typed.
 */
export function useSessionForm({
  initial,
  kind,
  action,
}: {
  initial: SessionFormState;
  kind: 'session' | 'series';
  action: SessionFormServerAction;
}): SessionForm {
  const [state, dispatch] = useReducer(sessionFormReducer, initial);
  const guarded = useMemo(() => withOfflineFallback(action), [action]);
  const [serverResult, runAction] = useActionState(guarded, {} as SessionActionState);
  const serverState = serverResult as SessionActionState;
  const [clientFailure, setClientFailure] = useState<FieldErrors | null>(null);
  const [seen, setSeen] = useState(serverState);

  // A new server answer replaces the DST choices (adjusting state while rendering, not in an effect).
  if (seen !== serverState) {
    setSeen(serverState);
    dispatch({ type: 'dst_errors', entries: serverState.dstOptions ?? [] });
  }

  const focusId = state.focus?.id;
  const focusSeq = state.focus?.seq;
  useEffect(() => {
    if (focusId === undefined) return;
    const frame = requestAnimationFrame(() => {
      document.getElementById(focusId)?.focus();
    });
    return () => {
      cancelAnimationFrame(frame);
    };
  }, [focusId, focusSeq]);

  const submit = (formData: FormData): void => {
    // The submitter's `name="intent"` rides in the form data: publishing needs every fee its model reads.
    const raw = formData.get('intent');
    const intent = raw === 'publish' || raw === 'draft' || raw === 'save' ? raw : undefined;
    const errors = validateSessionForm(state, kind, intent);
    if (Object.keys(errors).length > 0) {
      setClientFailure(errors);
      return;
    }
    setClientFailure(null);
    runAction(formData);
  };

  return {
    state,
    dispatch,
    submit,
    fieldErrors: clientFailure ?? mapServerFieldErrors(serverState.fieldErrors, state.courts.rows),
    serverState,
    clientFailure,
    errorOrder: errorOrder(state),
  };
}
