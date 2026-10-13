/**
 * "No trusted client address" warning, rate-limited to one per minute of injected-clock time so a flood of
 * address-less requests cannot flood the log. Every service that applies a per-address limit shares one
 * instance, so the warning is shared too. The clock is injected (never `Date.now()`) so tests can move time.
 */
import type { FastifyBaseLogger } from 'fastify';
import type { Clock } from '../../lib/clock.ts';

const ADDRESS_MISSING_WARNING_INTERVAL_MS = 60_000;

export type AddressWarningLogger = Pick<FastifyBaseLogger, 'warn'>;

/** Returns `warn(log, message)`: logs `auth.throttle.address_missing` at most once per interval. */
export function createAddressMissingWarning(
  clock: Clock,
): (log: AddressWarningLogger, message: string) => void {
  let last: number | null = null;
  return (log, message) => {
    const now = clock.now().getTime();
    if (last !== null && now - last < ADDRESS_MISSING_WARNING_INTERVAL_MS) return;
    last = now;
    log.warn({ event: 'auth.throttle.address_missing' }, message);
  };
}
