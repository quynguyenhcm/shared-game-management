'use client';

import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { DEFAULT_REFRESH_DELAYS_MS, waitingView } from '../../lib/teams/pending-view.ts';
import { LINK_CLASS } from '../auth/styles.ts';

/**
 * The waiting state of anything the server finishes in the background (a series being materialised, a top-up or a payment
 * waiting for the bank). It refreshes the server-rendered page at about 2, 5 and 10 seconds after it mounts (skipping a
 * refresh while the tab is hidden), never moves focus, and then stops: if the state is still pending the text becomes
 * `slowText`. The "Refresh" link is a plain link to the same URL, so it works without script and is always there. When the
 * pending state flips off it announces `doneText` politely (when given). The words come from the caller (CR-22).
 */
export function RefreshWhilePending({
  pending,
  href,
  pendingText,
  slowText,
  doneText,
  delaysMs = DEFAULT_REFRESH_DELAYS_MS,
}: {
  pending: boolean;
  href: string;
  pendingText: string;
  slowText: string;
  /** Announced once when `pending` flips from true to false. */
  doneText?: string;
  delaysMs?: readonly number[];
}) {
  const router = useRouter();
  const [refreshes, setRefreshes] = useState(0);
  const [wasPending, setWasPending] = useState(pending);
  const [announcement, setAnnouncement] = useState('');

  if (wasPending !== pending) {
    setWasPending(pending);
    if (wasPending && !pending && doneText !== undefined) setAnnouncement(doneText);
  }

  useEffect(() => {
    if (!pending) return;
    const timers = delaysMs.map((delay, index) =>
      setTimeout(() => {
        if (typeof document === 'undefined' || !document.hidden) router.refresh();
        setRefreshes(index + 1);
      }, delay),
    );
    return () => {
      for (const timer of timers) clearTimeout(timer);
    };
  }, [pending, router, delaysMs]);

  const view = waitingView({ pending, refreshesDone: refreshes, pendingText, slowText, delaysMs });
  return (
    <div role="status" aria-live="polite" className="flex flex-col gap-1 text-base">
      {view.kind === 'done' ? (
        <p>{announcement}</p>
      ) : (
        <p>
          {view.text}{' '}
          <a href={href} className={LINK_CLASS}>
            Refresh
          </a>
        </p>
      )}
    </div>
  );
}
