/**
 * The waiting state shared by every "we're working on it, the page will refresh itself" notice: the series page, the wallet's
 * open top-up and the payment page after Akahu (CR-22). Pure and copy-free: the caller supplies its words.
 */

/** Absolute delays, from mount, of the three bounded refreshes (UI/UX "Waiting state": about 2, 5 and 10 seconds). */
export const DEFAULT_REFRESH_DELAYS_MS: readonly number[] = [2000, 5000, 10000];

export type PendingView =
  { kind: 'waiting'; text: string } | { kind: 'slow'; text: string } | { kind: 'done'; text: '' };

/** "waiting" until every refresh has fired, then "slow" while the state is still pending, "done" once it is not. */
export function waitingView(input: {
  pending: boolean;
  refreshesDone: number;
  pendingText: string;
  slowText: string;
  delaysMs?: readonly number[];
}): PendingView {
  if (!input.pending) return { kind: 'done', text: '' };
  const delays = input.delaysMs ?? DEFAULT_REFRESH_DELAYS_MS;
  return input.refreshesDone < delays.length
    ? { kind: 'waiting', text: input.pendingText }
    : { kind: 'slow', text: input.slowText };
}
