'use client';

import { useState } from 'react';
import type { ModerationResult } from '../../lib/teams/moderation.ts';

/**
 * The idempotency key of a start form (top-up, payment attempt). The page generates one per render and hands it in, so a
 * double click or a second submit of the same render reuses it (the API returns the same intent). After any failed result
 * (`failed`) a new one is issued for the retry, so a refused or unreachable attempt never poisons the next one. Never derived
 * from the amount or the time. `crypto.randomUUID` runs only in the browser, after a result: the server render uses the prop.
 */
export function useIdempotencyKey(initial: string, result: unknown, failed: boolean): string {
  const [key, setKey] = useState(initial);
  const [seen, setSeen] = useState(result);
  if (seen !== result) {
    setSeen(result);
    if (failed) setKey(crypto.randomUUID());
  }
  return key;
}

/**
 * The `changeKey` of an admin confirm (reminder, hold resolution, payout block): generated when the panel opens and kept
 * until the action succeeds, so a retry of the same decision replays instead of repeating; a success clears it, so the next
 * decision is a new one.
 */
export function useChangeKey(result: ModerationResult | null): {
  key: string;
  ensure: () => void;
} {
  const [key, setKey] = useState('');
  const [seen, setSeen] = useState(result);
  if (seen !== result) {
    setSeen(result);
    if (result?.ok === true) setKey('');
  }
  return {
    key,
    ensure: () => {
      setKey((current) => (current === '' ? crypto.randomUUID() : current));
    },
  };
}
