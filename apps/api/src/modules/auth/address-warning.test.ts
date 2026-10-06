import { describe, expect, it } from 'vitest';
import { createManualClock } from '../../lib/clock.ts';
import { createAddressMissingWarning } from './address-warning.ts';

function recordingLog(): { warn: (fields: Record<string, unknown>) => void; events: unknown[] } {
  const events: unknown[] = [];
  return {
    events,
    warn: (fields) => {
      events.push(fields);
    },
  };
}

describe('address-missing warning throttle (injected clock)', () => {
  it('warns once, stays quiet for 60 s of clock time, then warns again', () => {
    const clock = createManualClock(new Date('2026-10-06T00:00:00Z'));
    const warn = createAddressMissingWarning(clock);
    const log = recordingLog();

    warn(log as never, 'no trusted client address');
    warn(log as never, 'no trusted client address');
    clock.advance(59_999);
    warn(log as never, 'no trusted client address');
    expect(log.events).toHaveLength(1);
    expect(log.events[0]).toMatchObject({ event: 'auth.throttle.address_missing' });

    clock.advance(1);
    warn(log as never, 'no trusted client address');
    expect(log.events).toHaveLength(2);
  });

  it('reads the injected clock, never the wall clock (a clock far from now still warns first time)', () => {
    const clock = createManualClock(new Date('2001-01-01T00:00:00Z'));
    const warn = createAddressMissingWarning(clock);
    const log = recordingLog();
    warn(log as never, 'm');
    expect(log.events).toHaveLength(1);
  });

  it('keeps independent state per throttle instance', () => {
    const clock = createManualClock(new Date('2026-10-06T00:00:00Z'));
    const [a, b] = [createAddressMissingWarning(clock), createAddressMissingWarning(clock)];
    const log = recordingLog();
    a(log as never, 'm');
    b(log as never, 'm');
    expect(log.events).toHaveLength(2);
  });
});
