import swagger from '@fastify/swagger';
import Fastify, { LogController, type FastifyBaseLogger, type FastifyInstance } from 'fastify';
import {
  jsonSchemaTransform,
  serializerCompiler,
  validatorCompiler,
} from 'fastify-type-provider-zod';
import type { Logger } from './lib/logger/logger.ts';
import { registerHealthRoute, type HealthDeps } from './routes/health.ts';

export interface AppDeps extends HealthDeps {
  readonly logger: Logger;
}

/** Fastify factory. Every dependency is injected so tests can build the app without a database. */
export async function buildApp(deps: AppDeps): Promise<FastifyInstance> {
  // Widen pino's Logger to Fastify's logger interface so Fastify's generics stay at their defaults.
  const loggerInstance: FastifyBaseLogger = deps.logger;
  const app = Fastify({
    loggerInstance,
    logController: new LogController({ requestIdLogLabel: 'requestId' }),
  });
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
