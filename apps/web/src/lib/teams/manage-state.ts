import type { SectionId } from './manage-view.ts';

/**
 * Client state of the manage page: one persistent status region per section (so the first announcement
 * is read), at most one open inline confirm per section, and a one-shot focus request. A pure reducer, so
 * the rules are unit-tested without a DOM.
 */

export interface SectionStatusMessage {
  message: string;
  ok: boolean;
}

export interface FocusRequest {
  /** A CSS selector for the element to focus once the page has updated. */
  selector: string;
  nonce: number;
}

export interface ManageState {
  status: Record<SectionId, SectionStatusMessage | null>;
  open: Record<SectionId, string | null>;
  focus: FocusRequest | null;
}

export type ManageEvent =
  | { type: 'open'; section: SectionId; id: string }
  | { type: 'close'; section: SectionId; id: string }
  | {
      type: 'result';
      section: SectionId;
      message: string;
      ok: boolean;
      focus?: string;
      /** A failure that is final (the server state is known and unchanged) also closes the open confirm. */
      close?: boolean;
    };

const empty = <T>(value: T): Record<SectionId, T> => ({
  requests: value,
  members: value,
  invite: value,
  banned: value,
  banking: value,
  gst: value,
});

export function initialManageState(): ManageState {
  return {
    status: empty<SectionStatusMessage | null>(null),
    open: empty<string | null>(null),
    focus: null,
  };
}

export function manageReducer(state: ManageState, event: ManageEvent): ManageState {
  switch (event.type) {
    case 'open':
      return { ...state, open: { ...state.open, [event.section]: event.id } };
    case 'close':
      // A late close of a confirm that is no longer the open one must not close the current one.
      return state.open[event.section] === event.id
        ? { ...state, open: { ...state.open, [event.section]: null } }
        : state;
    case 'result':
      return {
        status: { ...state.status, [event.section]: { message: event.message, ok: event.ok } },
        // Success (or a terminal failure) closes the section's confirm; a 5xx keeps it open with what was typed.
        open:
          event.ok || event.close === true ? { ...state.open, [event.section]: null } : state.open,
        focus:
          event.focus === undefined
            ? state.focus
            : { selector: event.focus, nonce: (state.focus?.nonce ?? 0) + 1 },
      };
  }
}
