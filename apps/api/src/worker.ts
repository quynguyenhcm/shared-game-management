import { createServer } from 'node:http';
import { enqueueBootSweeps, registerJobs } from './jobs/bootstrap.ts';
import { loadConfigOrExit } from './lib/config/config.ts';
import { createCrypto } from './lib/crypto/crypto.ts';
import { keyProviderFromConfig } from './lib/crypto/keyring.ts';
import { createKysely } from './lib/db/kysely.ts';
import { checkDatabase, createPool } from './lib/db/pool.ts';
import { createJobRunner } from './lib/jobs/jobs.ts';
import { createLogger, loggerOptionsFromConfig } from './lib/logger/logger.ts';
import { createNotifier } from './lib/notifications/notifier.ts';
import { createRegistrationsBanHandler } from './modules/registrations/ban-handler.ts';
import { createSessionAllocator } from './session-allocator.ts';
import { systemClock } from './lib/clock.ts';

// Boot order (AC-ERROR-1): config validation first; nothing binds a port or takes jobs before it passes.
const config = loadConfigOrExit();
const logger = createLogger(loggerOptionsFromConfig(config, 'worker'));

// Small pool: the health probe and the job handlers' own queries (pg-boss keeps its own connections). The ban handler can hold
// a connection through a 5 s lock wait, so the pool is 5 and the health probe cannot starve (registration Q4, guideline 9).
const pool = createPool({ connectionString: config.databaseUrl, max: 5, logger });
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
  const db = createKysely(pool);
  await registerJobs({
    runner,
    notifier,
    // Opens the sealed reset emails; the keyring is validated here at boot, as in the API.
    crypto: createCrypto(keyProviderFromConfig(config)),
    db,
    sessionAllocator: createSessionAllocator({
      db,
      jobs: runner,
      clock: systemClock,
      webBaseUrl: config.auth.webBaseUrl,
    }),
    // ADR 0015: the real ban handler replaces the no-op, over the worker's runner so promotion emails commit with the withdrawal.
    memberBannedHandler: createRegistrationsBanHandler({
      db,
      jobs: runner,
      clock: systemClock,
      webBaseUrl: config.auth.webBaseUrl,
    }),
    recurrenceHorizonDays: config.recurrence.horizonDays,
    webBaseUrl: config.auth.webBaseUrl,
    expireSecondsOverride: config.jobs.expireSecondsOverride,
  });
  // Reconcile at every boot: series dates, pending auto-enrol (the sweep also runs at 03:00) and unhandled bans (05:45).
  await enqueueBootSweeps(runner, logger);
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
