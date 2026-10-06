import { isIP } from 'node:net';

/**
 * The client address for the API's throttle (architecture, "Client address trust boundary").
 * `trustedHops` is the number of reverse proxies in front of the web that each append the peer address
 * to `X-Forwarded-For`. The entry that many places from the right is the first one a trusted proxy wrote;
 * everything to its left was supplied by the client or an untrusted hop and is ignored. Returns `null`
 * (never a fallback) for 0 hops, a missing header, fewer entries than hops, or a value that is not an IP.
 */
export function deriveClientAddress(
  forwardedFor: string | null | undefined,
  trustedHops: number,
): string | null {
  if (!forwardedFor || trustedHops < 1) return null;
  const entries = forwardedFor.split(',').map((entry) => entry.trim());
  if (entries.length < trustedHops) return null;
  const candidate = entries[entries.length - trustedHops];
  return candidate !== undefined && isIP(candidate) !== 0 ? candidate : null;
}
