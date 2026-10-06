import { describe, expect, it } from 'vitest';
import { createPasswordHasher, selfTestArgon2 } from './password.ts';

const PHC = /^\$argon2id\$v=19\$m=(\d+),t=(\d+),p=(\d+)\$[A-Za-z0-9+/]+\$[A-Za-z0-9+/]+$/;

describe('password hasher (AC-VERIFY-1)', () => {
  it('hashes to an argon2id PHC string at or above the OWASP minimum, under 512 characters', async () => {
    const hasher = createPasswordHasher();
    const first = await hasher.hash('kowhai-court-27');
    const second = await hasher.hash('kowhai-court-27');
    const match = PHC.exec(first);
    expect(match).not.toBeNull();
    const [, memory, passes, parallelism] = (match ?? []).map(Number);
    expect(memory).toBeGreaterThanOrEqual(19_456);
    expect(passes).toBeGreaterThanOrEqual(2);
    expect(parallelism).toBeGreaterThanOrEqual(1);
    expect(first.length).toBeLessThanOrEqual(512);
    expect(second).not.toBe(first); // random salt
  });

  it('verifies the right password, rejects a wrong one, and treats NFKC-equal forms as equal', async () => {
    const hasher = createPasswordHasher({ memoryKiB: 19_456, passes: 2 });
    const phc = await hasher.hash('ｋｏｗｈａｉ-court-27'); // full-width letters fold to ASCII under NFKC
    await expect(hasher.verify(phc, 'kowhai-court-27')).resolves.toEqual({
      ok: true,
      needsRehash: false,
    });
    await expect(hasher.verify(phc, 'kowhai-court-28')).resolves.toMatchObject({ ok: false });
  });

  it('reports needsRehash for a hash made with weaker parameters and still verifies it', async () => {
    const weak = createPasswordHasher({ memoryKiB: 19_456, passes: 2 });
    const strong = createPasswordHasher();
    const phc = await weak.hash('kowhai-court-27');
    await expect(strong.verify(phc, 'kowhai-court-27')).resolves.toEqual({
      ok: true,
      needsRehash: true,
    });
  });

  it('never throws on malformed or non-argon2id strings and never verifies them', async () => {
    const hasher = createPasswordHasher({ memoryKiB: 19_456, passes: 2 });
    for (const bad of [
      '',
      'plaintext',
      '$argon2i$v=19$m=65536,t=3,p=1$c29tZXNhbHQ$aGFzaA',
      '$argon2id$v=19$m=65536,t=3,p=1$bad',
      `$argon2id$v=19$m=999999999,t=3,p=1$${'A'.repeat(22)}$${'A'.repeat(43)}`,
    ]) {
      await expect(hasher.verify(bad, 'kowhai-court-27')).resolves.toEqual({
        ok: false,
        needsRehash: false,
      });
    }
  });

  it('takes between 50 ms and 1 s per hash with the production parameters', async () => {
    const hasher = createPasswordHasher();
    const started = performance.now();
    await hasher.hash('kowhai-court-27');
    const elapsed = performance.now() - started;
    expect(elapsed).toBeGreaterThanOrEqual(50);
    expect(elapsed).toBeLessThan(1000);
  });

  it('provides a dummy hash that is a valid PHC string and verifies nothing', async () => {
    const hasher = createPasswordHasher({ memoryKiB: 19_456, passes: 2 });
    expect(hasher.dummyHash).toMatch(PHC);
    await expect(hasher.verify(hasher.dummyHash, 'anything-at-all')).resolves.toMatchObject({
      ok: false,
    });
  });
});

describe('hash limiter queue cap', () => {
  it('rejects with service_unavailable once the queue is full, and serves the queued work normally', async () => {
    const hasher = createPasswordHasher({
      memoryKiB: 19_456,
      passes: 2,
      maxConcurrency: 1,
      maxQueue: 1,
    });
    const first = hasher.hash('kowhai-court-27'); // runs
    const second = hasher.hash('kowhai-court-28'); // waits in the queue (size 1)
    const third = hasher.hash('kowhai-court-29'); // queue full: shed, not queued
    await expect(third).rejects.toMatchObject({ code: 'service_unavailable', status: 503 });
    await expect(first).resolves.toMatch(PHC);
    await expect(second).resolves.toMatch(PHC);
    // The limiter recovers: a later hash is accepted again.
    await expect(hasher.hash('kowhai-court-30')).resolves.toMatch(PHC);
  });

  it('sheds verifications too, so an unknown-account flood cannot grow the queue without bound', async () => {
    const hasher = createPasswordHasher({
      memoryKiB: 19_456,
      passes: 2,
      maxConcurrency: 1,
      maxQueue: 0,
    });
    const running = hasher.verify(hasher.dummyHash, 'a-password-123');
    await expect(hasher.verify(hasher.dummyHash, 'a-password-456')).rejects.toMatchObject({
      code: 'service_unavailable',
    });
    await running;
  });
});

describe('argon2 boot self-test', () => {
  it('passes the RFC 9106 argon2id known-answer vector on this runtime', () => {
    expect(() => {
      selfTestArgon2();
    }).not.toThrow();
  });

  it('fails boot with the documented message when argon2 is missing or wrong', () => {
    expect(() => {
      selfTestArgon2({ argon2Sync: () => Buffer.alloc(32) });
    }).toThrow(/node:crypto argon2 unavailable/);
    expect(() => {
      selfTestArgon2({ argon2Sync: undefined });
    }).toThrow(/node:crypto argon2 unavailable/);
  });
});
