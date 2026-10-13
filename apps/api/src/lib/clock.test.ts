import { describe, expect, it } from 'vitest';
import { createManualClock, systemClock } from './clock.ts';

describe('clock', () => {
  it('systemClock returns the current time', () => {
    const before = Date.now();
    const now = systemClock.now().getTime();
    expect(now).toBeGreaterThanOrEqual(before);
    expect(now).toBeLessThanOrEqual(Date.now());
  });

  it('manual clock stands still until advanced and never leaks its internal Date', () => {
    const clock = createManualClock(new Date('2026-10-06T00:00:00Z'));
    expect(clock.now().toISOString()).toBe('2026-10-06T00:00:00.000Z');
    clock.advance(7 * 24 * 60 * 60 * 1000);
    expect(clock.now().toISOString()).toBe('2026-10-13T00:00:00.000Z');
    clock.now().setFullYear(1999);
    expect(clock.now().toISOString()).toBe('2026-10-13T00:00:00.000Z');
    clock.set(new Date('2027-01-01T00:00:00Z'));
    expect(clock.now().getUTCFullYear()).toBe(2027);
  });
});
