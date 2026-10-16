import swagger from '@fastify/swagger';
import Fastify, {
  LogController,
  type FastifyBaseLogger,
  type FastifyInstance,
  type FastifyPluginAsync,
} from 'fastify';
import {
  jsonSchemaTransform,
  serializerCompiler,
  validatorCompiler,
} from 'fastify-type-provider-zod';
import type { Clock } from './lib/clock.ts';
import type { AuthConfig } from './lib/config/config.ts';
import type { FieldCrypto } from './lib/crypto/crypto.ts';
import type { Database } from './lib/db/kysely.ts';
import { registerAuthPlatform } from './lib/auth/policy.ts';
import { registerTeamRefusalLogging } from './lib/auth/team-refusals.ts';
import { registerErrorHandling } from './lib/http/errors.ts';
import { registerInternalAuth } from './lib/http/internal-auth.ts';
import { registerOriginCheck } from './lib/http/origin.ts';
import type { JobRunner } from './lib/jobs/jobs.ts';
import type { Logger } from './lib/logger/logger.ts';
import { currentTrace } from './lib/telemetry/trace-context.ts';
import { createAddressMissingWarning } from './modules/auth/address-warning.ts';
import type { PasswordHasher } from './modules/auth/password.ts';
import { createCommonPasswordBlocklist } from './modules/auth/password-policy.ts';
import { createResetService } from './modules/auth/reset-service.ts';
import { authRoutes } from './modules/auth/routes.ts';
import { createOAuthService } from './modules/auth/oauth-service.ts';
import type { OAuthProviderRegistry } from './modules/auth/providers/provider.ts';
import { createAuthService } from './modules/auth/service.ts';
import { createSessionService } from './modules/auth/sessions.ts';
import type { LoginThrottle } from './modules/auth/throttle.ts';
import { teamBankingRoutes } from './modules/team-banking/routes.ts';
import { createTeamBankingService } from './modules/team-banking/service.ts';
import { teamsRoutes } from './modules/teams/routes.ts';
import { createTeamsService } from './modules/teams/service.ts';
import { registerHealthRoute, type HealthDeps } from './routes/health.ts';

export interface AppDeps extends HealthDeps {
  readonly logger: Logger;
  /** Kysely handle over the shared pool (`lib/db/kysely.ts`). */
  readonly db: Database;
  /** Job-runner producer: enqueues (for example the reset email, in the caller's transaction). */
  readonly jobs: Pick<JobRunner, 'enqueue'>;
  /** Time source; tests move it to exercise session and throttle expiry. */
  readonly clock: Clock;
  /** Field encryption over the keyring (the OAuth PKCE verifier). */
  readonly crypto: FieldCrypto;
  /** `config.auth`: web origin, provider credentials, lifetimes and throttle limits. */
  readonly auth: AuthConfig;
  /** `API_INTERNAL_SHARED_SECRET`; `null` when unset (only allowed outside production). */
  readonly internalAuthSecret: string | null;
  /** argon2id hasher with its boot self-test already passed (`createPasswordHasher`). */
  readonly passwordHasher: PasswordHasher;
  /** Postgres-backed sign-in and forgot-password throttle (`createLoginThrottle`). */
  readonly loginThrottle: LoginThrottle;
  /** Enabled Google/Facebook adapters (`buildOAuthProviders`), or both fakes in `AUTH_FAKE_OAUTH` mode. */
  readonly oauthProviders: OAuthProviderRegistry;
  /** Test seam: extra plugins registered after the auth module (guard fixture routes). They need a policy too. */
  readonly extraPlugins?: readonly FastifyPluginAsync[];
}

/**
 * Binds the request span's traceId/spanId to the request and reply loggers, so every request log
 * line (including "request completed") carries the trace. The span comes from `@fastify/otel`,
 * which continues an incoming W3C `traceparent`; without the SDK nothing is bound.
 */
export function registerRequestTracing(app: FastifyInstance): void {
  app.addHook('onRequest', (request, reply, done) => {
    const active = currentTrace();
    if (active) {
      const log = request.log.child({ traceId: active.traceId, spanId: active.spanId });
      request.log = log;
      reply.log = log;
    }
    // Fastify writes its own "incoming request" line before any hook runs, when no span exists yet
    // (`TracedLogController` suppresses it); emitting it here makes it carry the trace like every other line.
    request.log.info({ req: request }, 'incoming request');
    done();
  });
}

/** Fastify's log controller with the pre-hook "incoming request" line removed (`registerRequestTracing` logs it). */
class TracedLogController extends LogController {
  override incomingRequest(): void {
    // Intentionally empty.
  }
}

/** Fastify factory. Every dependency is injected so tests can build the app without a database. */
export async function buildApp(deps: AppDeps): Promise<FastifyInstance> {
  // Widen pino's Logger to Fastify's logger interface so Fastify's generics stay at their defaults.
  const loggerInstance: FastifyBaseLogger = deps.logger;
  const app = Fastify({
    loggerInstance,
    logController: new TracedLogController({ requestIdLogLabel: 'requestId' }),
  });
  registerRequestTracing(app);
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  registerErrorHandling(app);
  registerOriginCheck(app, deps.auth.webBaseUrl);
  registerInternalAuth(app, deps.internalAuthSecret);
  const sessions = createSessionService({
    db: deps.db,
    clock: deps.clock,
    config: deps.auth,
    logger: deps.logger,
  });
  // Before swagger and before any route: the onRoute registry refuses a route without a policy, and adds
  // the bearer requirement to each route's OpenAPI schema.
  registerAuthPlatform(app, { sessions, db: deps.db });
  // Once, at the root: every `requireTeamRole` route in every module logs its 403 as `team.action.refused`.
  registerTeamRefusalLogging(app);
  // Registered before the routes so the generated OpenAPI document (src/openapi.ts) sees every route.
  await app.register(swagger, {
    openapi: {
      openapi: '3.1.0',
      info: { title: 'Shared Game Management API', version: '0.1.0' },
      // The browser cookie belongs to the web app; the API only ever sees this bearer token.
      components: { securitySchemes: { sessionToken: { type: 'http', scheme: 'bearer' } } },
    },
    transform: jsonSchemaTransform,
  });
  registerHealthRoute(app, { version: deps.version, checkDb: deps.checkDb });
  const blocklist = createCommonPasswordBlocklist();
  // One instance so the register, sign-in and forgot-password paths share the "no client address" warning.
  const warnAddressMissing = createAddressMissingWarning(deps.clock);
  await app.register(authRoutes, {
    prefix: '/auth',
    service: createAuthService({
      db: deps.db,
      clock: deps.clock,
      config: deps.auth,
      sessions,
      hasher: deps.passwordHasher,
      throttle: deps.loginThrottle,
      blocklist,
      warnAddressMissing,
      providers: deps.oauthProviders,
    }),
    oauthService: createOAuthService({
      db: deps.db,
      clock: deps.clock,
      config: deps.auth,
      sessions,
      crypto: deps.crypto,
      jobs: deps.jobs,
      providers: deps.oauthProviders,
    }),
    resetService: createResetService({
      db: deps.db,
      clock: deps.clock,
      config: deps.auth,
      hasher: deps.passwordHasher,
      throttle: deps.loginThrottle,
      blocklist,
      jobs: deps.jobs,
      crypto: deps.crypto,
      warnAddressMissing,
    }),
  });
  await app.register(teamsRoutes, {
    prefix: '/teams',
    service: createTeamsService({ db: deps.db, clock: deps.clock, jobs: deps.jobs }),
  });
  await app.register(teamBankingRoutes, {
    prefix: '/teams',
    service: createTeamBankingService({
      db: deps.db,
      clock: deps.clock,
      crypto: deps.crypto,
      jobs: deps.jobs,
      webBaseUrl: deps.auth.webBaseUrl,
    }),
  });
  for (const plugin of deps.extraPlugins ?? []) await app.register(plugin);
  await app.ready();
  return app;
}
