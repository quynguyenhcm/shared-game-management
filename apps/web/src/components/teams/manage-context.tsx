'use client';

import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useReducer,
  type Dispatch,
  type ReactNode,
} from 'react';
import {
  initialManageState,
  manageReducer,
  type ManageEvent,
  type ManageState,
} from '../../lib/teams/manage-state.ts';
import type { SectionId } from '../../lib/teams/manage-view.ts';
import { FormBanner } from '../auth/form-banner.tsx';

interface ManageContextValue {
  state: ManageState;
  dispatch: Dispatch<ManageEvent>;
}

/** Outside a provider (a component rendered on its own) the context is inert, so components never crash. */
const ManageContext = createContext<ManageContextValue>({
  state: initialManageState(),
  dispatch: () => undefined,
});

export function useManage(): ManageContextValue {
  return useContext(ManageContext);
}

/**
 * Holds the manage page's client state above the server-rendered lists. It survives a revalidation, so a
 * result is still announced (and focus still moves) after the acted-on row has left its list.
 */
export function ManageProvider({ children }: { children: ReactNode }) {
  const [state, dispatch] = useReducer(manageReducer, undefined, initialManageState);
  const value = useMemo(() => ({ state, dispatch }), [state]);

  // One-shot focus request (after a row leaves a list, or the invite URL changes). Waiting a frame lets
  // the revalidated tree commit first.
  useEffect(() => {
    if (state.focus === null) return;
    const { selector } = state.focus;
    const frame = requestAnimationFrame(() => {
      document.querySelector<HTMLElement>(selector)?.focus();
    });
    return () => {
      cancelAnimationFrame(frame);
    };
  }, [state.focus]);

  return <ManageContext.Provider value={value}>{children}</ManageContext.Provider>;
}

/**
 * The persistent status region of a section: present (and empty) from the first render so the first
 * announcement is read. A failure is also shown as a focused error banner. Messages stay until the next
 * action in the section (no auto-dismiss, WCAG 2.2.1).
 */
export function SectionStatus({ section }: { section: SectionId }) {
  const { state } = useManage();
  const status = state.status[section];
  return (
    <>
      <div role="status" id={`${section}-status`} className="text-base">
        {status?.ok === true ? <p className="font-medium">{status.message}</p> : null}
      </div>
      {status !== null && !status.ok ? (
        <FormBanner kind="error" lines={[status.message]} focusToken={status} />
      ) : null}
    </>
  );
}
