import Fastify, { type FastifyInstance } from 'fastify';
import { ErrorResponse } from '@sgm/shared';
import { afterEach, describe, expect, it } from 'vitest';
import { registerErrorHandling } from './errors.ts';
import { registerOriginCheck } from './origin.ts';

const apps: FastifyInstance[] = [];
afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

function build(webBaseUrl = 'https://games.example.nz'): FastifyInstance {
  const app = Fastify({ logger: false });
  apps.push(app);
  registerErrorHandling(app);
  registerOriginCheck(app, webBaseUrl);
  app.get('/read', () => ({ ok: true }));
  app.post('/write', () => ({ ok: true }));
  app.delete('/write', () => ({ ok: true }));
  return app;
}

describe('registerOriginCheck (AC-ERROR-15)', () => {
  it('refuses a mutating request with a foreign Origin with 403 cross_origin_request', async () => {
    const app = build();
    for (const method of ['POST', 'DELETE'] as const) {
      const response = await app.inject({
        method,
        url: '/write',
        headers: { origin: 'https://evil.example' },
      });
      expect(response.statusCode, method).toBe(403);
      expect(ErrorResponse.parse(response.json()).error.code).toBe('cross_origin_request');
    }
    const nullOrigin = await app.inject({
      method: 'POST',
      url: '/write',
      headers: { origin: 'null' },
    });
    expect(nullOrigin.statusCode).toBe(403);
  });

  it('allows the web origin (with or without a trailing slash in config) and requests without Origin', async () => {
    const app = build('https://games.example.nz/');
    const same = await app.inject({
      method: 'POST',
      url: '/write',
      headers: { origin: 'https://games.example.nz' },
    });
    expect(same.statusCode).toBe(200);
    const none = await app.inject({ method: 'POST', url: '/write' });
    expect(none.statusCode).toBe(200);
  });

  it('never checks safe methods', async () => {
    const app = build();
    const response = await app.inject({
      method: 'GET',
      url: '/read',
      headers: { origin: 'https://evil.example' },
    });
    expect(response.statusCode).toBe(200);
  });
});
