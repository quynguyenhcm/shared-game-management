import type { FastifyInstance } from 'fastify';
import { AppError } from './errors.ts';

const SAFE_METHODS: ReadonlySet<string> = new Set(['GET', 'HEAD', 'OPTIONS']);

/**
 * Refuses a mutating request that carries a foreign `Origin` header with 403 `cross_origin_request`
 * (AC-ERROR-15). The API is reached by the web server, which sends no `Origin`, so a request without the
 * header passes; a browser always sends one on a cross-site POST, and `Origin: null` (sandboxed frames)
 * is foreign too. Cookies are the web's concern (`SameSite=Lax`); this is the API-side backstop.
 */
export function registerOriginCheck(app: FastifyInstance, webBaseUrl: string): void {
  const allowed = new URL(webBaseUrl).origin;
  app.addHook('onRequest', (request, _reply, done) => {
    const origin = request.headers.origin;
    if (SAFE_METHODS.has(request.method) || origin === undefined || origin === allowed) {
      done();
      return;
    }
    done(new AppError('cross_origin_request'));
  });
}
