import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import {
  SERIES_PENDING_TEXT,
  SERIES_SLOW_TEXT,
  pendingView,
  sessionsAddedLine,
} from '../../lib/teams/sessions-view.ts';
import { DEFAULT_REFRESH_DELAYS_MS, waitingView } from '../../lib/teams/pending-view.ts';

vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: () => undefined }) }));

const { RefreshWhilePending } = await import('./refresh-while-pending.tsx');

describe('waitingView (CR-22: the generalised waiting state)', () => {
  const copy = { pendingText: 'Waiting.', slowText: 'Slow.' };

  it('is "done" when nothing is pending, "waiting" until every delay has fired, then "slow"', () => {
    expect(waitingView({ pending: false, refreshesDone: 0, ...copy })).toEqual({
      kind: 'done',
      text: '',
    });
    expect(waitingView({ pending: true, refreshesDone: 0, ...copy })).toEqual({
      kind: 'waiting',
      text: 'Waiting.',
    });
    expect(waitingView({ pending: true, refreshesDone: 2, ...copy }).kind).toBe('waiting');
    expect(waitingView({ pending: true, refreshesDone: 3, ...copy })).toEqual({
      kind: 'slow',
      text: 'Slow.',
    });
  });

  it('counts the caller-supplied delays, not a fixed three', () => {
    const delaysMs = [1000];
    expect(waitingView({ pending: true, refreshesDone: 0, delaysMs, ...copy }).kind).toBe(
      'waiting',
    );
    expect(waitingView({ pending: true, refreshesDone: 1, delaysMs, ...copy }).kind).toBe('slow');
    expect(DEFAULT_REFRESH_DELAYS_MS).toEqual([2000, 5000, 10000]);
  });

  it('the sessions copy constants are exactly what pendingView returned before (sessions behaviour unchanged)', () => {
    expect(pendingView({ pending: true, refreshesDone: 0 }).text).toBe(SERIES_PENDING_TEXT);
    expect(pendingView({ pending: true, refreshesDone: 3 }).text).toBe(SERIES_SLOW_TEXT);
    expect(SERIES_PENDING_TEXT).toBe(
      "We're adding the sessions in this series. Refresh in a moment.",
    );
  });
});

describe('RefreshWhilePending (copy as props)', () => {
  it('sessions caller: renders the series text with a plain Refresh link in a polite status region', () => {
    const html = renderToStaticMarkup(
      <RefreshWhilePending
        pending
        href="/teams/T/manage/sessions/series/R"
        pendingText={SERIES_PENDING_TEXT}
        slowText={SERIES_SLOW_TEXT}
        doneText={sessionsAddedLine(3)}
      />,
    );
    expect(html).toContain('We&#x27;re adding the sessions in this series. Refresh in a moment.');
    expect(html).toContain('href="/teams/T/manage/sessions/series/R"');
    expect(html).toContain('>Refresh<');
    expect(html).toMatch(/role="status"[^>]*aria-live="polite"/);
  });

  it('a billing caller supplies its own words, and none of the series words leak in', () => {
    const html = renderToStaticMarkup(
      <RefreshWhilePending
        pending
        href="/payments/P?return=1"
        pendingText="Processing your payment. This usually takes under a minute."
        slowText="Your bank hasn't confirmed yet. We'll email you when it does."
      />,
    );
    expect(html).toContain('Processing your payment. This usually takes under a minute.');
    expect(html).not.toContain('sessions');
    expect(html).toContain('href="/payments/P?return=1"');
  });

  it('when not pending: an empty live region (the announcement appears only on the pending-to-done flip)', () => {
    const html = renderToStaticMarkup(
      <RefreshWhilePending
        pending={false}
        href="/x"
        pendingText="Waiting."
        slowText="Slow."
        doneText="All done."
      />,
    );
    expect(html).toContain('role="status"');
    expect(html).not.toContain('Waiting.');
    expect(html).not.toContain('All done.');
  });
});
