/**
 * Injectable time source. Session, token and throttle code reads time only through a `Clock`, so tests
 * can move time (idle and absolute expiry, throttle windows) without sleeping or faking global timers.
 */
export interface Clock {
  now(): Date;
}

export const systemClock: Clock = { now: () => new Date() };

export interface ManualClock extends Clock {
  /** Moves time forward (or backward with a negative value) by `milliseconds`. */
  advance(milliseconds: number): void;
  set(instant: Date): void;
}

/** A clock that only moves when told to. Returns a fresh `Date` each call so callers cannot mutate it. */
export function createManualClock(start: Date = new Date()): ManualClock {
  let current = start.getTime();
  return {
    now: () => new Date(current),
    advance: (milliseconds) => {
      current += milliseconds;
    },
    set: (instant) => {
      current = instant.getTime();
    },
  };
}
