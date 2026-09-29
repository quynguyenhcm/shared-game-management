import { describe, expect, it } from 'vitest';
import { HealthResponse } from '@sgm/shared';
import { createLogger } from './lib/logger/logger.ts';
import { buildApp } from './app.ts';

const logger = createLogger({
  service: 'api',
  version: 'test',
  environment: 'test',
  level: 'silent',
  format: 'json',
  output: 'stdout',
  redactPatterns: [],
});

describe('GET /health', () => {
  it('returns 200 with a schema-valid body when the database check passes', async () => {
    const app = await buildApp({ logger, version: '9.9.9', checkDb: () => Promise.resolve(true) });
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
    const app = await buildApp({
      logger,
      version: '9.9.9',
      checkDb: () => Promise.reject(new Error('connection refused')),
    });
    const response = await app.inject({ method: 'GET', url: '/health' });
    expect(response.statusCode).toBe(503);
    expect(response.json()).toEqual({ status: 'degraded', db: 'unreachable', version: '9.9.9' });
    await app.close();
  });
});
