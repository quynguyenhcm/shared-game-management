import { describe, expect, it } from 'vitest';
import { HealthResponse } from '@sgm/shared';
import { buildApp, type AppDeps } from './app.ts';
import { createLogger } from './lib/logger/logger.ts';
import { inertAppDeps } from '../test/helpers/app-deps.ts';

const logger = createLogger({
  service: 'api',
  version: 'test',
  environment: 'test',
  level: 'silent',
  format: 'json',
  output: 'stdout',
  redactPatterns: [],
});

function deps(overrides: Partial<AppDeps> = {}): AppDeps {
  return inertAppDeps(logger, { version: '9.9.9', ...overrides });
}

describe('GET /health', () => {
  it('returns 200 with a schema-valid body when the database check passes', async () => {
    const app = await buildApp(deps());
    const response = await app.inject({ method: 'GET', url: '/health' });
    expect(response.statusCode).toBe(200);
    expect(HealthResponse.parse(response.json())).toEqual({
      status: 'ok',
      db: 'ok',
      version: '9.9.9',
    });
    await app.close();
  });

  it('returns 503 marking the database unreachable when the check fails or throws', async () => {
    const app = await buildApp(
      deps({ checkDb: () => Promise.reject(new Error('connection refused')) }),
    );
    const response = await app.inject({ method: 'GET', url: '/health' });
    expect(response.statusCode).toBe(503);
    expect(response.json()).toEqual({ status: 'degraded', db: 'unreachable', version: '9.9.9' });
    await app.close();
  });
});

describe('buildApp dependency injection (auth wiring)', () => {
  it('registers the shared error shape: unknown routes answer 404 not_found', async () => {
    const app = await buildApp(deps());
    const response = await app.inject({ method: 'GET', url: '/nope' });
    expect(response.statusCode).toBe(404);
    expect(response.json()).toMatchObject({ error: { code: 'not_found' } });
    await app.close();
  });

  it('refuses a foreign Origin on a mutating request using the configured web origin', async () => {
    const app = await buildApp(deps());
    const foreign = await app.inject({
      method: 'POST',
      url: '/health',
      headers: { origin: 'https://evil.example' },
    });
    expect(foreign.statusCode).toBe(403);
    expect(foreign.json()).toMatchObject({ error: { code: 'cross_origin_request' } });
    const own = await app.inject({
      method: 'POST',
      url: '/health',
      headers: { origin: 'https://games.example.nz' },
    });
    expect(own.statusCode).toBe(404);
    await app.close();
  });

  it('documents the bearer sessionToken security scheme', async () => {
    const app = await buildApp(deps());
    const document = app.swagger() as {
      components?: { securitySchemes?: Record<string, unknown> };
    };
    expect(document.components?.securitySchemes?.sessionToken).toEqual({
      type: 'http',
      scheme: 'bearer',
    });
    await app.close();
  });
});
