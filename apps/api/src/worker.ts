import { createServer } from 'node:http';
import { registerJobs } from './jobs/bootstrap.ts';
import { loadConfigOrExit } from './lib/config/config.ts';
import { createKysely } from './lib/db/kysely.ts';
import { checkDatabase, createPool } from './lib/db/pool.ts';
import { createJobRunner } from './lib/jobs/jobs.ts';
import { createLogger, loggerOptionsFromConfig } from './lib/logger/logger.ts';
import { createNotifier } from './lib/notifications/notifier.ts';

// Boot order (AC-ERROR-1): config validation first; nothing binds a port or takes jobs before it passes.
const config = loadConfigOrExit();
const logger = createLogger(loggerOptionsFromConfig(config, 'worker'));

// Small pool: only the health probe uses it; pg-boss keeps its own connections.
const pool = createPool({ connectionString: config.databaseUrl, max: 2, logger });
const notifier = createNotifier(config);
const runner = createJobRunner({
  databaseUrl: config.databaseUrl,
  logger,
  role: 'worker',
  superviseIntervalSeconds: config.jobs.superviseIntervalSeconds,
  pollingIntervalSeconds: config.jobs.pollIntervalSeconds,
});

const healthServer = createServer((request, response) => {
  if (request.method === 'GET' && request.url === '/health') {
    void checkDatabase(pool).then((dbOk) => {
      response.writeHead(dbOk ? 200 : 503, { 'content-type': 'application/json' });
      response.end(
        JSON.stringify({
          status: dbOk ? 'ok' : 'degraded',
          db: dbOk ? 'ok' : 'unreachable',
          version: config.serviceVersion,
        }),
      );
    });
    return;
  }
  response.writeHead(404).end();
});

let shuttingDown = false;
async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info({ signal }, 'worker shutting down');
  try {
    // Graceful: running handlers get a bounded window to finish, then pg-boss closes its pool.
    await runner.stop();
    await new Promise<void>((resolve) => healthServer.close(() => resolve()));
    await pool.end();
    process.exit(0);
  } catch (error) {
    logger.error({ err: error }, 'worker shutdown failed');
    process.exit(1);
  }
}
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => void shutdown(signal));
}

try {
  await runner.start();
  await registerJobs({
    runner,
    notifier,
    db: createKysely(pool),
    expireSecondsOverride: config.jobs.expireSecondsOverride,
  });
} catch (error) {
  logger.fatal({ err: error }, 'worker failed to start');
  process.exit(1);
}

healthServer.listen(config.workerHealthPort, '0.0.0.0', () => {
  logger.info(
    { port: config.workerHealthPort, notifier: config.notifierAdapter },
    'worker started',
  );
});
