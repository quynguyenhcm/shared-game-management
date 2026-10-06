import Fastify from 'fastify';
import { describe, expect, it } from 'vitest';
import { buildApp } from '../../app.ts';
import { createLogger } from '../logger/logger.ts';
import { inertAppDeps } from '../../../test/helpers/app-deps.ts';
import {
  authenticated,
  listRoutePolicies,
  optionalSession,
  publicRoute,
  registerAuthPlatform,
  requireGlobalRole,
  requireTeamRole,
} from './policy.ts';

const logger = createLogger({
  service: 'api',
  version: 'test',
  environment: 'test',
  level: 'silent',
  format: 'json',
  output: 'stdout',
  redactPatterns: [],
});

// The platform never touches these in the tests below (no authenticated request reaches a database).
const platformDeps = {
  sessions: { resolve: () => Promise.reject(new Error('unexpected session lookup')) },
  db: {} as never,
};

describe('route policy registry (AC-VERIFY-3)', () => {
  it('refuses to register a route that declares no policy', () => {
    const app = Fastify();
    registerAuthPlatform(app, platformDeps);
    expect(() => app.get('/unprotected', () => ({ ok: true }))).toThrow(
      /GET \/unprotected declares no auth policy/,
    );
  });

  it('makes buildApp reject when a plugin route has no policy', async () => {
    await expect(
      buildApp(
        inertAppDeps(logger, {
          extraPlugins: [
            // Async so the registration error rejects `ready()` instead of escaping the plugin loader.
            async (app) => {
              await Promise.resolve();
              app.get('/sneaky', () => ({ ok: true }));
            },
          ],
        }),
      ),
    ).rejects.toThrow(/declares no auth policy/);
  });

  it('refuses a team policy whose URL lacks the named team id parameter', () => {
    const app = Fastify();
    registerAuthPlatform(app, platformDeps);
    expect(() =>
      app.get('/teams/settings', { config: { policy: requireTeamRole('TEAM_ADMIN') } }, () => ({})),
    ).toThrow(/:teamId/);
  });

  it('gives every route of the real app an explicit policy of the documented kind', async () => {
    const app = await buildApp(inertAppDeps(logger));
    const byRoute = new Map(
      listRoutePolicies(app)
        .filter((entry) => entry.method !== 'HEAD')
        .map((entry) => [`${entry.method} ${entry.url}`, entry.policy.kind]),
    );
    expect(byRoute.get('GET /health')).toBe('public');
    expect(byRoute.get('POST /auth/register')).toBe('public');
    expect(byRoute.get('POST /auth/login')).toBe('public');
    expect(byRoute.get('GET /auth/providers')).toBe('public');
    expect(byRoute.get('POST /auth/password/forgot')).toBe('public');
    expect(byRoute.get('POST /auth/password/reset')).toBe('public');
    expect(byRoute.get('POST /auth/logout')).toBe('optionalSession');
    expect(byRoute.get('GET /auth/me')).toBe('authenticated');
    for (const policy of byRoute.values()) {
      expect(['public', 'optionalSession', 'authenticated', 'globalRole', 'teamRole']).toContain(
        policy,
      );
    }
    await app.close();
  });

  it('denies a protected route called without credentials by default and leaves unknown paths as 404', async () => {
    const app = await buildApp(
      inertAppDeps(logger, {
        extraPlugins: [
          (instance) => {
            instance.get('/_t/public', { config: { policy: publicRoute() } }, () => ({ ok: 1 }));
            instance.get('/_t/optional', { config: { policy: optionalSession() } }, () => ({
              ok: 2,
            }));
            instance.get('/_t/authed', { config: { policy: authenticated() } }, () => ({ ok: 3 }));
            instance.get(
              '/_t/admin',
              { config: { policy: requireGlobalRole('GLOBAL_ADMIN') } },
              () => ({ ok: 4 }),
            );
            return Promise.resolve();
          },
        ],
      }),
    );
    for (const url of ['/_t/authed', '/_t/admin']) {
      const response = await app.inject({ method: 'GET', url });
      expect(response.statusCode).toBe(401);
      expect(response.json()).toMatchObject({ error: { code: 'unauthenticated' } });
    }
    expect((await app.inject({ method: 'GET', url: '/_t/public' })).statusCode).toBe(200);
    expect((await app.inject({ method: 'GET', url: '/_t/optional' })).statusCode).toBe(200);
    expect((await app.inject({ method: 'GET', url: '/nope' })).statusCode).toBe(404);
    await app.close();
  });

  it('answers HEAD on a protected GET route with 401 too (Fastify auto-HEAD inherits the policy)', async () => {
    const app = await buildApp(
      inertAppDeps(logger, {
        extraPlugins: [
          (instance) => {
            instance.get('/_t/authed', { config: { policy: authenticated() } }, () => ({ ok: 3 }));
            instance.get(
              '/_t/admin',
              { config: { policy: requireGlobalRole('GLOBAL_ADMIN') } },
              () => ({ ok: 4 }),
            );
            return Promise.resolve();
          },
        ],
      }),
    );
    for (const url of ['/_t/authed', '/_t/admin', '/auth/me']) {
      const response = await app.inject({ method: 'HEAD', url });
      expect(response.statusCode, `HEAD ${url}`).toBe(401);
    }
    await app.close();
  });
});
