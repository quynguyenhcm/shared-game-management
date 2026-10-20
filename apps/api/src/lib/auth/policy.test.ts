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
    // OAuth (AC-VERIFY-3): the callback reads an optional session (link intent); authorize, pending and complete are public.
    expect(byRoute.get('POST /auth/oauth/:provider/callback')).toBe('optionalSession');
    expect(byRoute.get('POST /auth/oauth/:provider/authorize')).toBe('public');
    expect(byRoute.get('GET /auth/oauth/pending')).toBe('public');
    expect(byRoute.get('POST /auth/oauth/complete')).toBe('public');
    expect(byRoute.get('GET /auth/identities')).toBe('authenticated');
    expect(byRoute.get('POST /auth/identities/:provider/link')).toBe('authenticated');
    expect(byRoute.get('DELETE /auth/identities/:provider')).toBe('authenticated');
    expect(byRoute.get('GET /auth/me')).toBe('authenticated');
    for (const policy of byRoute.values()) {
      expect(['public', 'optionalSession', 'authenticated', 'globalRole', 'teamRole']).toContain(
        policy,
      );
    }
    await app.close();
  });

  it('declares the documented policy on every /teams route and no team route is public (AC-VERIFY-1)', async () => {
    const app = await buildApp(inertAppDeps(logger));
    const teamRoutes = listRoutePolicies(app).filter(
      (entry) => entry.method !== 'HEAD' && entry.url.startsWith('/teams'),
    );
    const byRoute = new Map(
      teamRoutes.map((entry) => [`${entry.method} ${entry.url}`, entry.policy]),
    );
    for (const route of [
      'POST /teams',
      'GET /teams/mine',
      'POST /teams/invite/lookup',
      'POST /teams/:teamId/join-requests',
    ]) {
      expect(byRoute.get(route), route).toEqual({ kind: 'authenticated' });
    }
    for (const route of ['GET /teams/find', 'GET /teams/:teamId']) {
      expect(byRoute.get(route), route).toEqual({ kind: 'optionalSession' });
    }
    for (const route of [
      'GET /teams/:teamId/invite-code',
      'POST /teams/:teamId/invite-code/regenerate',
      'GET /teams/:teamId/members',
      'POST /teams/:teamId/members/:userId/approve',
      'POST /teams/:teamId/members/:userId/reject',
      'POST /teams/:teamId/members/:userId/promote',
      'POST /teams/:teamId/members/:userId/demote',
      'POST /teams/:teamId/members/:userId/ban',
      // team-banking-and-gst (AC-VERIFY-5): the five banking and GST routes.
      'GET /teams/:teamId/banking',
      'PUT /teams/:teamId/banking',
      'DELETE /teams/:teamId/banking',
      'GET /teams/:teamId/gst',
      'PUT /teams/:teamId/gst',
      // skill-levels-and-auto-enroll (AC-VERIFY-7): the override and Auto Enroll routes.
      'PUT /teams/:teamId/members/:userId/skill-level',
      'PUT /teams/:teamId/members/:userId/auto-enroll',
      // session-scheduling-engine (AC-ERROR-8): the one-off session routes. The member routes
      // (`GET /teams/:teamId/sessions/upcoming`, registration) are reserved for registration-and-waitlist.
      'GET /teams/:teamId/sessions',
      'POST /teams/:teamId/sessions',
      'GET /teams/:teamId/sessions/:sessionId',
      'PUT /teams/:teamId/sessions/:sessionId',
      'POST /teams/:teamId/sessions/:sessionId/publish',
      'POST /teams/:teamId/sessions/:sessionId/cancel',
      // ...and the five series routes (create, read, edit, End series, Publish drafts now).
      'POST /teams/:teamId/session-series',
      'GET /teams/:teamId/session-series/:ruleId',
      'PUT /teams/:teamId/session-series/:ruleId',
      'POST /teams/:teamId/session-series/:ruleId/end',
      'POST /teams/:teamId/session-series/:ruleId/publish-drafts',
    ]) {
      expect(byRoute.get(route), route).toEqual({
        kind: 'teamRole',
        role: 'TEAM_ADMIN',
        teamIdParam: 'teamId',
        allowGlobalAdmin: false,
      });
    }
    // Exactly the 32 documented team routes exist (14 + five banking and GST + two skill-levels + six sessions + five series), none public.
    expect(byRoute.size).toBe(32);
    for (const policy of byRoute.values()) expect(policy.kind).not.toBe('public');
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
