/**
 * Log hygiene for the password flows (AC-VERIFY-6): register, login (success and failure), throttling,
 * logout and a request carrying OAuth-style query parameters leave no secret in any log line, the auth.*
 * events carry the documented fields and no email, and every request-scoped line carries the request's
 * traceId. (Fastify's own "incoming request" line is written before any hook runs, so it cannot carry one.)
 */
import type { InjectOptions } from 'fastify';
import { InMemorySpanExporter, SimpleSpanProcessor } from '@opentelemetry/sdk-trace-node';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startTelemetry, type Telemetry } from '../../src/lib/telemetry/telemetry.ts';
import {
  bearer,
  buildAuthTestApp,
  createPasswordUser,
  internalHeaders,
  TEST_INTERNAL_SECRET,
  type AuthTestApp,
} from '../helpers/auth-app.ts';
import { createTestDatabase, type TestDatabase } from '../helpers/test-db.ts';

const TRACE_ID = '4bf92f3577b34da6a3ce929d0e0e4736';
const TRACEPARENT = `00-${TRACE_ID}-00f067aa0ba902b7-01`;

let database: TestDatabase;
let h: AuthTestApp;
let telemetry: Telemetry;
beforeAll(async () => {
  telemetry = startTelemetry(
    {
      serviceName: 'sgm-test',
      serviceVersion: 'test',
      disabled: false,
      tracesExporter: 'none',
      otlpEndpoint: undefined,
      sampler: 'parentbased_traceidratio',
      samplerArg: 1,
    },
    { spanProcessors: [new SimpleSpanProcessor(new InMemorySpanExporter())] },
  );
  database = await createTestDatabase();
  h = await buildAuthTestApp(database.pool, {
    env: { API_INTERNAL_SHARED_SECRET: TEST_INTERNAL_SECRET },
  });
});
afterAll(async () => {
  await h.close();
  await database.close();
  await telemetry.shutdown();
});

const PASSWORD = 'Tr1cky-passphrase-for-logs';
const IP = '203.0.113.99';

describe('password flows leave no secrets in logs', () => {
  it('logs auth events with userId/provider/reason only and never a password, token, secret, address or key hash', async () => {
    const inject = (options: InjectOptions) => h.app.inject(options);
    const headers = {
      'user-agent': 'LogTest/1.0',
      traceparent: TRACEPARENT,
      ...internalHeaders(IP),
    };

    const registered = await inject({
      method: 'POST',
      url: '/auth/register',
      headers,
      payload: {
        fullName: 'Log Person',
        email: 'log.person@example.com',
        password: PASSWORD,
        sex: 'MALE',
      },
    });
    expect(registered.statusCode).toBe(201);
    const token = registered.json<{ session: { token: string } }>().session.token;
    await createPasswordUser(h, { email: 'log.other@example.com', password: PASSWORD });

    const ok = await inject({
      method: 'POST',
      url: '/auth/login',
      headers,
      payload: { email: 'log.other@example.com', password: PASSWORD },
    });
    expect(ok.statusCode).toBe(200);
    const wrongPassword = 'Wr0ng-passphrase-for-logs';
    for (let i = 0; i < 6; i += 1) {
      await inject({
        method: 'POST',
        url: '/auth/login',
        headers,
        payload: { email: 'log.person@example.com', password: wrongPassword },
      });
    }
    await inject({
      method: 'GET',
      url: '/auth/providers?code=SECRETCODE123&state=SECRETSTATE456',
      headers,
    });
    await inject({ method: 'GET', url: '/auth/me', headers: { ...headers, ...bearer(token) } });
    await inject({
      method: 'POST',
      url: '/auth/logout',
      headers: { ...headers, ...bearer(token) },
    });

    const lines = h.logs.lines();
    const text = JSON.stringify(lines);
    const { rows } = await database.pool.query<{ key_hash: Buffer }>(
      `SELECT key_hash FROM auth_throttle`,
    );
    const ok2 = ok.json<{ session: { token: string } }>().session.token;
    const secrets = [
      PASSWORD,
      wrongPassword,
      token,
      ok2,
      TEST_INTERNAL_SECRET,
      IP,
      'SECRETCODE123',
      'SECRETSTATE456',
      'log.person@example.com',
      'log.other@example.com',
      ...rows.flatMap((row) => [row.key_hash.toString('hex'), row.key_hash.toString('base64')]),
    ];
    for (const secret of secrets)
      expect(text, `log contains ${secret.slice(0, 12)}`).not.toContain(secret);

    const events = lines.filter((line) => typeof line.event === 'string');
    const byEvent = (name: string) => events.filter((line) => line.event === name);
    expect(byEvent('auth.register')).toHaveLength(1);
    expect(byEvent('auth.register')[0]).toMatchObject({ provider: 'PASSWORD' });
    expect(byEvent('auth.login.succeeded')[0]).toMatchObject({ provider: 'PASSWORD' });
    expect(typeof byEvent('auth.login.succeeded')[0]?.userId).toBe('string');
    const failed = byEvent('auth.login.failed');
    expect(failed.map((line) => line.reason)).toEqual([
      'invalid_credentials',
      'invalid_credentials',
      'invalid_credentials',
      'invalid_credentials',
      'invalid_credentials',
      'throttled_email',
    ]);
    for (const line of failed) expect(Object.keys(line)).not.toContain('email');
    expect(byEvent('auth.session.revoked')[0]).toMatchObject({ reason: 'logout' });

    // The business events and "request completed" carry the request's trace.
    const scoped = lines.filter(
      (line) => typeof line.event === 'string' || line.message === 'request completed',
    );
    expect(scoped.length).toBeGreaterThan(10);
    for (const line of scoped)
      expect(line.traceId, JSON.stringify(line).slice(0, 200)).toBe(TRACE_ID);
  });
});
