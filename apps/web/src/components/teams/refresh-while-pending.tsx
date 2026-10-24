'use client';

import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import {
  REFRESH_DELAYS_MS,
  pendingView,
  sessionsAddedLine,
} from '../../lib/teams/sessions-view.ts';
import { LINK_CLASS } from '../auth/styles.ts';

/**
 * The waiting state of a series ("We're adding the sessions in this series"). It refreshes the server-rendered
 * page three times, at about 2, 5 and 10 seconds after it mounts (skipping a refresh while the tab is hidden),
 * never moves focus, and then stops: if the series is still pending the text becomes the slow-path text. The
 * "Refresh" link is a plain link to the same URL, so it works without script and is always there. When the
 * pending state flips off it announces "{n} sessions added." politely.
 */
export function RefreshWhilePending({
  pending,
  href,
  sessionCount,
}: {
  pending: boolean;
  href: string;
  /** How many sessions the series has once it is no longer pending (for the announcement). */
  sessionCount?: number;
}) {
  const router = useRouter();
  const [refreshes, setRefreshes] = useState(0);
  const [wasPending, setWasPending] = useState(pending);
  const [announcement, setAnnouncement] = useState('');

  if (wasPending !== pending) {
    setWasPending(pending);
    if (wasPending && !pending && sessionCount !== undefined) {
      setAnnouncement(sessionsAddedLine(sessionCount));
    }
  }

  useEffect(() => {
    if (!pending) return;
    const timers = REFRESH_DELAYS_MS.map((delay, index) =>
      setTimeout(() => {
        if (typeof document === 'undefined' || !document.hidden) router.refresh();
        setRefreshes(index + 1);
      }, delay),
    );
    return () => {
      for (const timer of timers) clearTimeout(timer);
    };
  }, [pending, router]);

  const view = pendingView({ pending, refreshesDone: refreshes });
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
