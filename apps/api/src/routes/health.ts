import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { HealthResponse } from '@sgm/shared';

export interface HealthDeps {
  readonly version: string;
  /** Resolves true when the database answers; rejection or false marks it unreachable. */
  readonly checkDb: () => Promise<boolean>;
}

export function registerHealthRoute(app: FastifyInstance, deps: HealthDeps): void {
  app.withTypeProvider<ZodTypeProvider>().get(
    '/health',
    {
      schema: {
        summary: 'Service and database health',
        operationId: 'getHealth',
        response: { 200: HealthResponse, 503: HealthResponse },
      },
    },
    async (_request, reply) => {
      const dbOk = await deps.checkDb().catch(() => false);
      const body: HealthResponse = {
        status: dbOk ? 'ok' : 'degraded',
        db: dbOk ? 'ok' : 'unreachable',
        version: deps.version,
      };
      return reply.code(dbOk ? 200 : 503).send(body);
    },
  );
}
