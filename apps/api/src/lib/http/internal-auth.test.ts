import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import { registerInternalAuth } from './internal-auth.ts';

const SECRET = 'a-shared-secret-of-at-least-32-characters-long';
let app: FastifyInstance | undefined;

async function build(secret: string | null): Promise<FastifyInstance> {
  const instance = Fastify();
  registerInternalAuth(instance, secret);
  instance.get('/who', (request) => ({ clientAddress: request.clientAddress }));
  await instance.ready();
  app = instance;
  return instance;
}

async function address(
  instance: FastifyInstance,
  headers: Record<string, string>,
): Promise<string | null> {
  const response = await instance.inject({
    method: 'GET',
    url: '/who',
    remoteAddress: '10.9.9.9',
    headers,
  });
  return response.json<{ clientAddress: string | null }>().clientAddress;
}

afterEach(async () => {
  await app?.close();
  app = undefined;
});

describe('internal-auth hook (AC-VERIFY-14)', () => {
  it('trusts x-sgm-client-ip only together with the right x-sgm-internal-auth', async () => {
    const instance = await build(SECRET);
    expect(
      await address(instance, { 'x-sgm-internal-auth': SECRET, 'x-sgm-client-ip': '203.0.113.7' }),
    ).toBe('203.0.113.7');
    expect(
      await address(instance, {
        'x-sgm-internal-auth': SECRET,
        'x-sgm-client-ip': '2001:db8::1',
      }),
    ).toBe('2001:db8::1');
  });

  it('ignores the address when the secret is missing, forged (same or different length) or empty', async () => {
    const instance = await build(SECRET);
    const ip = { 'x-sgm-client-ip': '203.0.113.7' };
    expect(await address(instance, ip)).toBeNull();
    expect(
      await address(instance, { ...ip, 'x-sgm-internal-auth': 'x'.repeat(SECRET.length) }),
    ).toBeNull();
    expect(await address(instance, { ...ip, 'x-sgm-internal-auth': 'short' })).toBeNull();
    expect(await address(instance, { ...ip, 'x-sgm-internal-auth': '' })).toBeNull();
  });

  it('never falls back to request.ip or X-Forwarded-For, and rejects an invalid address', async () => {
    const instance = await build(SECRET);
    expect(await address(instance, {})).toBeNull();
    expect(await address(instance, { 'x-forwarded-for': '198.51.100.9' })).toBeNull();
    expect(
      await address(instance, { 'x-sgm-internal-auth': SECRET, 'x-sgm-client-ip': 'not-an-ip' }),
    ).toBeNull();
    expect(await address(instance, { 'x-sgm-internal-auth': SECRET })).toBeNull();
  });

  it('with no secret configured the address is never trusted', async () => {
    const instance = await build(null);
    expect(
      await address(instance, { 'x-sgm-internal-auth': SECRET, 'x-sgm-client-ip': '203.0.113.7' }),
    ).toBeNull();
  });
});
