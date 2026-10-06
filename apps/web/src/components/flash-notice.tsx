'use client';

import { useSearchParams } from 'next/navigation';
import { useEffect, useState } from 'react';
import { noticeMessage } from '../lib/auth/messages.ts';
import { FOCUS_RING } from './auth/styles.ts';

function removeParams(names: readonly string[]): void {
  const url = new URL(window.location.href);
  const present = names.filter((name) => url.searchParams.has(name));
  for (const name of present) url.searchParams.delete(name);
  if (present.length > 0) window.history.replaceState(window.history.state as unknown, '', url);
}

/**
 * The one-time "Welcome! Your account is ready." notice (`notice=welcome`), shown on whatever page the
 * user lands on and then stripped from the address bar so a reload does not replay it.
 */
export function FlashNotice() {
  const welcome = useSearchParams().get('notice') === 'welcome';
  const [previous, setPrevious] = useState(false);
  const [open, setOpen] = useState(false);
  // Open on the rising edge of `welcome` only, so stripping the code later does not close the notice.
  if (welcome !== previous) {
    setPrevious(welcome);
    if (welcome) setOpen(true);
  }

  useEffect(() => {
    if (welcome) removeParams(['notice']);
  }, [welcome]);

  if (!open) return null;
  return (
    <div role="status" className="mx-auto mt-4 max-w-3xl px-4">
      <div className="flex items-center justify-between gap-3 rounded-md border-2 border-blue-800 bg-blue-50 p-3 text-base">
        <p className="font-medium">{noticeMessage('welcome', {})}</p>
        <button
          type="button"
          onClick={() => {
            setOpen(false);
          }}
          className={`min-h-11 shrink-0 rounded-md px-3 underline ${FOCUS_RING}`}
        >
          Dismiss
        </button>
      </div>
    </div>
  );
}

/** Auth pages render their own notice and error from the codes; this strips them after mount. */
export function StripAuthParams() {
  useEffect(() => {
    removeParams(['notice', 'error', 'provider', 'removed']);
  }, []);
  return null;
}
