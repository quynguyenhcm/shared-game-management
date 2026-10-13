import { createHash, timingSafeEqual } from 'node:crypto';
import { isIP } from 'node:net';
import type { FastifyInstance } from 'fastify';

declare module 'fastify' {
  interface FastifyRequest {
    /**
     * The browser's address as relayed by the web server, trusted only over a request that carried the
     * right `x-sgm-internal-auth`. `null` otherwise. There is deliberately no fallback to `request.ip`:
     * behind the web that is the web container, which would put every player in one throttle bucket.
     */
    clientAddress: string | null;
  }
}

const UNTRUSTED_WARNING_INTERVAL_MS = 60_000;

const digest = (value: string): Buffer => createHash('sha256').update(value).digest();

/**
 * Authenticates the web-to-API hop (AC-VERIFY-14): `x-sgm-internal-auth` is compared in constant time
 * (over SHA-256 digests, so lengths never leak) with `API_INTERNAL_SHARED_SECRET`. Only on a match is
 * `x-sgm-client-ip` (re-validated with `net.isIP`) copied to `request.clientAddress`. A request without the
 * secret is still served, since bearer sessions remain the authority; it only loses the address dimension.
 */
export function registerInternalAuth(app: FastifyInstance, secret: string | null): void {
  const secretDigest = secret === null ? null : digest(secret);
  let lastWarning = 0;
  app.decorateRequest('clientAddress', null);
  app.addHook('onRequest', (request, _reply, done) => {
    const presented = request.headers['x-sgm-internal-auth'];
    const claimed = request.headers['x-sgm-client-ip'];
    const trusted =
      secretDigest !== null &&
      typeof presented === 'string' &&
      timingSafeEqual(digest(presented), secretDigest);
    if (trusted && typeof claimed === 'string' && isIP(claimed) !== 0) {
      request.clientAddress = claimed;
    } else if (!trusted && claimed !== undefined) {
      const now = Date.now();
      if (now - lastWarning >= UNTRUSTED_WARNING_INTERVAL_MS) {
        lastWarning = now;
        request.log.warn(
          { event: 'auth.client_address.untrusted' },
          'x-sgm-client-ip ignored: missing or invalid x-sgm-internal-auth',
        );
      }
    }
    done();
  });
}
