import Fastify, { LogController, type FastifyBaseLogger, type FastifyInstance } from 'fastify';
import { serializerCompiler, validatorCompiler } from 'fastify-type-provider-zod';
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
  registerHealthRoute(app, { version: deps.version, checkDb: deps.checkDb });
  await app.ready();
  return app;
}
