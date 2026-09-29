import { buildApp } from './app.ts';
import { loadConfigOrExit } from './lib/config/config.ts';
import { checkDatabase, createPool } from './lib/db/pool.ts';
import { createLogger, loggerOptionsFromConfig } from './lib/logger/logger.ts';

// Boot order (AC-ERROR-1): config validation first; nothing binds a port before it passes.
const config = loadConfigOrExit();
const logger = createLogger(loggerOptionsFromConfig(config, 'api'));

const pool = createPool({
  connectionString: config.databaseUrl,
  max: config.databasePoolMax,
  logger,
});

const app = await buildApp({
  logger,
  version: config.serviceVersion,
  checkDb: () => checkDatabase(pool),
});

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => {
    logger.info({ signal }, 'shutting down');
    void app
      .close()
      .then(() => pool.end())
      .then(() => process.exit(0));
  });
}

await app.listen({ port: config.apiPort, host: '0.0.0.0' });
