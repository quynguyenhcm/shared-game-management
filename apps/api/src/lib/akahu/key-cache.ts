/**
 * Webhook signing-key resolver (A4): bounded LRU (positive and negative), single-flight per key id, token-bucket
 * fetch cap, injected clock. A transient fetch failure or an exhausted cap is a `GatewayUnavailableError` (the
 * webhook answers 503 so Akahu retries); an 'unknown' key is cached briefly so hostile ids cannot drive fetches.
 */
import type { KeyObject } from 'node:crypto';
import type { Clock } from '../clock.ts';
import {
  KEY_CACHE_NEGATIVE_MAX,
  KEY_CACHE_POSITIVE_MAX,
  KEY_CACHE_TTL_MS,
  KEY_FETCH_CAP_PER_MINUTE,
  NEGATIVE_KEY_CACHE_TTL_MS,
} from './constants.ts';
import { GatewayUnavailableError, type WebhookKeyResolver } from './gateway.ts';

export interface WebhookKeyResolverOptions {
  /** Resolves to a key or `'unknown'` (404/4xx); any throw is treated as transient. */
  readonly fetchKey: (keyId: string) => Promise<KeyObject | 'unknown'>;
  readonly clock: Clock;
  readonly fetchCapPerMinute?: number;
  readonly positiveMax?: number;
  readonly negativeMax?: number;
  readonly positiveTtlMs?: number;
  readonly negativeTtlMs?: number;
}

interface Entry<T> {
  readonly value: T;
  readonly expiresAt: number;
}

/** Map-ordered LRU with per-entry expiry. */
class LruCache<T> {
  private readonly entries = new Map<string, Entry<T>>();

  constructor(private readonly max: number) {}

  get(key: string, now: number): T | undefined {
    const entry = this.entries.get(key);
    if (entry === undefined) return undefined;
    this.entries.delete(key);
    if (entry.expiresAt <= now) return undefined;
    this.entries.set(key, entry);
    return entry.value;
  }

  set(key: string, value: T, expiresAt: number): void {
    this.entries.delete(key);
    this.entries.set(key, { value, expiresAt });
    while (this.entries.size > this.max) {
      const oldest = this.entries.keys().next();
      if (oldest.done) break;
      this.entries.delete(oldest.value);
    }
  }
}

export function createWebhookKeyResolver(options: WebhookKeyResolverOptions): WebhookKeyResolver {
  const capacity = options.fetchCapPerMinute ?? KEY_FETCH_CAP_PER_MINUTE;
  const positiveTtl = options.positiveTtlMs ?? KEY_CACHE_TTL_MS;
  const negativeTtl = options.negativeTtlMs ?? NEGATIVE_KEY_CACHE_TTL_MS;
  const positive = new LruCache<KeyObject>(options.positiveMax ?? KEY_CACHE_POSITIVE_MAX);
  const negative = new LruCache<true>(options.negativeMax ?? KEY_CACHE_NEGATIVE_MAX);
  const inFlight = new Map<string, Promise<KeyObject | 'unknown'>>();
  let tokens = capacity;
  let refilledAt = options.clock.now().getTime();

  const takeToken = (now: number): boolean => {
    tokens = Math.min(capacity, tokens + ((now - refilledAt) * capacity) / 60_000);
    refilledAt = now;
    if (tokens < 1) return false;
    tokens -= 1;
    return true;
  };

  const fetchAndCache = async (keyId: string): Promise<KeyObject | 'unknown'> => {
    let result: KeyObject | 'unknown';
    try {
      result = await options.fetchKey(keyId);
    } catch (error) {
      throw new GatewayUnavailableError('key_fetch_failed', { cause: error });
    }
    const now = options.clock.now().getTime();
    if (result === 'unknown') negative.set(keyId, true, now + negativeTtl);
    else positive.set(keyId, result, now + positiveTtl);
    return result;
  };

  return {
    async resolve(keyId) {
      const now = options.clock.now().getTime();
      const cached = positive.get(keyId, now);
      if (cached !== undefined) return cached;
      if (negative.get(keyId, now) !== undefined) return 'unknown';
      const pending = inFlight.get(keyId);
      if (pending !== undefined) return pending;
      if (!takeToken(now)) throw new GatewayUnavailableError('key_fetch_capped');
      const started = fetchAndCache(keyId).finally(() => inFlight.delete(keyId));
      inFlight.set(keyId, started);
      return started;
    },
  };
}
