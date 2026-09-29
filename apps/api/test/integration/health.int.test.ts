import { afterAll, describe, expect, it } from 'vitest';
import { HealthResponse } from '@sgm/shared';
import { buildApp } from '../../src/app.ts';
import { loadConfig } from '../../src/lib/config/config.ts';
import { checkDatabase, createPool } from '../../src/lib/db/pool.ts';
import { createLogger } from '../../src/lib/logger/logger.ts';

const config = loadConfig();
const logger = createLogger({
  service: 'api',
  version: 'test',
  environment: 'test',
  level: 'silent',
  format: 'json',
  output: 'stdout',
  redactPatterns: [],
});

const pools: ReturnType<typeof createPool>[] = [];
function poolFor(connectionString: string): ReturnType<typeof createPool> {
  const pool = createPool({ connectionString, max: 2, logger });
  pools.push(pool);
  return pool;
}
afterAll(async () => {
  await Promise.all(pools.map((pool) => pool.end()));
});

describe('GET /health against a real database', () => {
  it('returns 200 with db ok when PostgreSQL answers', async () => {
    const pool = poolFor(config.databaseUrl);
    const app = await buildApp({
      logger,
      version: 'int-test',
      checkDb: () => checkDatabase(pool),
    });
    const response = await app.inject({ method: 'GET', url: '/health' });
    expect(response.statusCode).toBe(200);
    expect(HealthResponse.parse(response.json())).toEqual({
      status: 'ok',
      db: 'ok',
      version: 'int-test',
    });
    await app.close();
  });

  it('returns 503 within 3 s with db unreachable when the database is down', async () => {
    // Nothing listens on port 1, which is the same observable outcome as a stopped container.
    const unreachable = new URL(config.databaseUrl);
    unreachable.hostname = '127.0.0.1';
    unreachable.port = '1';
    const pool = poolFor(unreachable.toString());
    const app = await buildApp({
      logger,
      version: 'int-test',
      checkDb: () => checkDatabase(pool),
    });
    const startedAt = Date.now();
    const response = await app.inject({ method: 'GET', url: '/health' });
    expect(Date.now() - startedAt).toBeLessThan(3000);
    expect(response.statusCode).toBe(503);
    expect(response.json()).toEqual({ status: 'degraded', db: 'unreachable', version: 'int-test' });
    await app.close();
  });
});

describe('database pool', () => {
  it('returns NUMERIC, INT8 and DATE as strings and runs in UTC', async () => {
    const pool = poolFor(config.databaseUrl);
    const { rows } = await pool.query<{
      amount: unknown;
      big: unknown;
      day: unknown;
      tz: unknown;
    }>(
      `SELECT 99999999.99::numeric(10,2) AS amount, 9007199254740993::bigint AS big,
              DATE '2026-09-27' AS day, current_setting('TimeZone') AS tz`,
    );
    expect(rows[0]).toEqual({
      amount: '99999999.99',
      big: '9007199254740993',
      day: '2026-09-27',
      tz: 'UTC',
    });
  });

  it('abandons a hung probe after the timeout instead of waiting for the query', async () => {
    const slow = { query: () => new Promise<never>(() => undefined) };
    const startedAt = Date.now();
    await expect(checkDatabase(slow as never, 50)).resolves.toBe(false);
    expect(Date.now() - startedAt).toBeLessThan(1000);
  });
});
