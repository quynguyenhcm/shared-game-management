import { generateKeyPairSync, sign, type KeyObject } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { createManualClock } from '../clock.ts';
import { GatewayUnavailableError } from './gateway.ts';
import { createWebhookKeyResolver } from './key-cache.ts';
import { parseSignatureHeaders, verifyWebhookSignature } from './webhook-signature.ts';

const newKeyPair = () => generateKeyPairSync('rsa', { modulusLength: 2048 });
const signed = (body: Buffer, privateKey: KeyObject): string =>
  sign('sha256', body, privateKey).toString('base64');

describe('verifyWebhookSignature (A4: RSA-SHA256 over the raw bytes)', () => {
  const { publicKey, privateKey } = newKeyPair();
  const body = Buffer.from('{"type":"ONE_OFF_PAYMENT_STATUS_UPDATE","_payment":"pay_1"}');

  it('accepts a genuine signature and rejects a tampered body, a wrong key and garbage', () => {
    const header = signed(body, privateKey);
    const parsed = parseSignatureHeaders(header, 'key_1');
    if (!parsed.ok) throw new Error('expected headers to parse');
    expect(verifyWebhookSignature(body, parsed.signature, publicKey)).toBe(true);
    expect(
      verifyWebhookSignature(Buffer.from(`${body.toString()} `), parsed.signature, publicKey),
    ).toBe(false);
    expect(verifyWebhookSignature(body, parsed.signature, newKeyPair().publicKey)).toBe(false);
    expect(verifyWebhookSignature(body, Buffer.alloc(256, 1), publicKey)).toBe(false);
    expect(verifyWebhookSignature(body, Buffer.alloc(3, 1), publicKey)).toBe(false);
  });
});

describe('parseSignatureHeaders', () => {
  const goodSignature = Buffer.alloc(256, 7).toString('base64');

  it('accepts well-formed headers and names the first failure otherwise', () => {
    expect(parseSignatureHeaders(goodSignature, 'abc_DEF-123')).toMatchObject({
      ok: true,
      keyId: 'abc_DEF-123',
    });
    expect(parseSignatureHeaders(undefined, 'k')).toEqual({ ok: false, reason: 'missing_header' });
    expect(parseSignatureHeaders(goodSignature, undefined)).toEqual({
      ok: false,
      reason: 'missing_header',
    });
    for (const badId of ['../keys', 'a b', 'k\nx', '', 'x'.repeat(129), 'é']) {
      expect(parseSignatureHeaders(goodSignature, badId)).toEqual({
        ok: false,
        reason: 'bad_key_id',
      });
    }
    for (const badSignature of ['not base64!!', 'AAAA', 'A'.repeat(5000), ['a', 'b']]) {
      expect(parseSignatureHeaders(badSignature, 'k')).toEqual({
        ok: false,
        reason: 'bad_signature_format',
      });
    }
  });
});

describe('createWebhookKeyResolver (bounded LRU, single flight, token bucket)', () => {
  const { publicKey } = newKeyPair();
  const setup = (
    fetchKey = vi.fn((_id: string) => Promise.resolve(publicKey as KeyObject | 'unknown')),
  ) => {
    const clock = createManualClock(new Date('2026-11-02T00:00:00Z'));
    const resolver = createWebhookKeyResolver({ fetchKey, clock, fetchCapPerMinute: 1000 });
    return { fetchKey, clock, resolver };
  };

  it('caches a key for 24 h and an unknown id for 10 min', async () => {
    const { fetchKey, clock, resolver } = setup(
      vi.fn((id: string) => Promise.resolve(id === 'good' ? publicKey : ('unknown' as const))),
    );
    await resolver.resolve('good');
    await resolver.resolve('good');
    expect(await resolver.resolve('nope')).toBe('unknown');
    await resolver.resolve('nope');
    expect(fetchKey).toHaveBeenCalledTimes(2);
    clock.advance(10 * 60_000 + 1);
    await resolver.resolve('nope');
    await resolver.resolve('good');
    expect(fetchKey).toHaveBeenCalledTimes(3);
    clock.advance(24 * 3_600_000);
    await resolver.resolve('good');
    expect(fetchKey).toHaveBeenCalledTimes(4);
  });

  it('collapses concurrent resolves of one key id into one fetch', async () => {
    const { fetchKey, resolver } = setup();
    const results = await Promise.all(Array.from({ length: 5 }, () => resolver.resolve('same')));
    expect(fetchKey).toHaveBeenCalledTimes(1);
    expect(results.every((result) => result === publicKey)).toBe(true);
  });

  it('surfaces a transient fetch failure as GatewayUnavailableError and does not cache it', async () => {
    const fetchKey = vi
      .fn<(id: string) => Promise<KeyObject | 'unknown'>>()
      .mockRejectedValueOnce(new Error('socket hang up'))
      .mockResolvedValue(publicKey);
    const { resolver } = setup(fetchKey);
    await expect(resolver.resolve('k')).rejects.toBeInstanceOf(GatewayUnavailableError);
    expect(await resolver.resolve('k')).toBe(publicKey);
    expect(fetchKey).toHaveBeenCalledTimes(2);
  });

  it('caps fetches per minute with a token bucket and refills with time', async () => {
    const fetchKey = vi.fn((_id: string) => Promise.resolve(publicKey as KeyObject | 'unknown'));
    const clock = createManualClock(new Date('2026-11-02T00:00:00Z'));
    const resolver = createWebhookKeyResolver({ fetchKey, clock, fetchCapPerMinute: 6 });
    for (let i = 0; i < 6; i += 1) await resolver.resolve(`id-${i}`);
    await expect(resolver.resolve('id-6')).rejects.toMatchObject({ reason: 'key_fetch_capped' });
    expect(fetchKey).toHaveBeenCalledTimes(6);
    clock.advance(10_001);
    expect(await resolver.resolve('id-6')).toBe(publicKey);
  });

  it('bounds the positive cache at 32 entries, evicting the least recently used', async () => {
    const { fetchKey, resolver } = setup();
    for (let i = 0; i < 32; i += 1) await resolver.resolve(`id-${i}`);
    await resolver.resolve('id-0'); // refresh id-0: id-1 is now the oldest
    await resolver.resolve('id-32'); // evicts id-1
    expect(fetchKey).toHaveBeenCalledTimes(33);
    await resolver.resolve('id-0');
    expect(fetchKey).toHaveBeenCalledTimes(33);
    await resolver.resolve('id-1');
    expect(fetchKey).toHaveBeenCalledTimes(34);
  });
});
