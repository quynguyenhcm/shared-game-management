/** Shared Tailwind class strings for the auth forms. 16 px text keeps iOS from zooming; 44 px (`min-h-11`) tap targets. */
export const FOCUS_RING =
  'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-700';

export const INPUT_CLASS = `min-h-11 w-full rounded-md border border-slate-500 bg-white px-3 py-2 text-base text-slate-900 ${FOCUS_RING}`;

export const BUTTON_CLASS = `inline-flex min-h-11 w-full items-center justify-center rounded-md bg-slate-900 px-4 py-2 text-base font-medium text-white aria-disabled:cursor-not-allowed aria-disabled:opacity-60 ${FOCUS_RING}`;

export const SECONDARY_BUTTON_CLASS = `inline-flex min-h-11 w-full items-center justify-center rounded-md border border-slate-500 bg-white px-4 py-2 text-base font-medium text-slate-900 aria-disabled:cursor-not-allowed aria-disabled:opacity-60 ${FOCUS_RING}`;

export const LINK_CLASS = `inline-flex min-h-11 items-center text-base text-blue-800 underline ${FOCUS_RING}`;
