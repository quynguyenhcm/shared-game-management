import swagger from '@fastify/swagger';
import Fastify, { LogController, type FastifyBaseLogger, type FastifyInstance } from 'fastify';
import {
  jsonSchemaTransform,
  serializerCompiler,
  validatorCompiler,
} from 'fastify-type-provider-zod';
import type { Clock } from './lib/clock.ts';
import type { AuthConfig } from './lib/config/config.ts';
import type { FieldCrypto } from './lib/crypto/crypto.ts';
import type { Database } from './lib/db/kysely.ts';
import { registerErrorHandling } from './lib/http/errors.ts';
import { registerOriginCheck } from './lib/http/origin.ts';
import type { JobRunner } from './lib/jobs/jobs.ts';
import type { Logger } from './lib/logger/logger.ts';
import { currentTrace } from './lib/telemetry/trace-context.ts';
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
    done();
  });
}

/** Fastify factory. Every dependency is injected so tests can build the app without a database. */
export async function buildApp(deps: AppDeps): Promise<FastifyInstance> {
  // Widen pino's Logger to Fastify's logger interface so Fastify's generics stay at their defaults.
  const loggerInstance: FastifyBaseLogger = deps.logger;
  const app = Fastify({
    loggerInstance,
    logController: new LogController({ requestIdLogLabel: 'requestId' }),
  });
  registerRequestTracing(app);
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  registerErrorHandling(app);
  registerOriginCheck(app, deps.auth.webBaseUrl);
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
  await app.ready();
  return app;
}
