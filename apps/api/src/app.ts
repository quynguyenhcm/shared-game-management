import swagger from '@fastify/swagger';
import Fastify, { LogController, type FastifyBaseLogger, type FastifyInstance } from 'fastify';
import {
  jsonSchemaTransform,
  serializerCompiler,
  validatorCompiler,
} from 'fastify-type-provider-zod';
import type { Logger } from './lib/logger/logger.ts';
import { currentTrace } from './lib/telemetry/trace-context.ts';
import { registerHealthRoute, type HealthDeps } from './routes/health.ts';

export interface AppDeps extends HealthDeps {
  readonly logger: Logger;
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
  // Registered before the routes so the generated OpenAPI document (src/openapi.ts) sees every route.
  await app.register(swagger, {
    openapi: {
      openapi: '3.1.0',
      info: { title: 'Shared Game Management API', version: '0.1.0' },
    },
    transform: jsonSchemaTransform,
  });
  registerHealthRoute(app, { version: deps.version, checkDb: deps.checkDb });
  await app.ready();
  return app;
}
