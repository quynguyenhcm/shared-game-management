import { buildApp } from './app.ts';
import { loadConfigOrExit } from './lib/config/config.ts';
import { createLogger, loggerOptionsFromConfig } from './lib/logger/logger.ts';

// Boot order (AC-ERROR-1): config validation first; nothing binds a port before it passes.
const config = loadConfigOrExit();
const logger = createLogger(loggerOptionsFromConfig(config, 'api'));

const app = await buildApp({
  logger,
  version: config.serviceVersion,
  // TODO(Phase 2): replace with a real `SELECT 1` against the pg pool (raced against a 1.5 s timeout).
  // Until the pool exists this reports true, so /health does not yet reflect database state.
  checkDb: () => Promise.resolve(true),
});

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => {
    logger.info({ signal }, 'shutting down');
    void app.close().then(() => process.exit(0));
  });
}

await app.listen({ port: config.apiPort, host: '0.0.0.0' });
