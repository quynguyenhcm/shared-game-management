import { buildApp } from './app.ts';
import { systemClock } from './lib/clock.ts';
import { loadConfigOrExit } from './lib/config/config.ts';
import { createCrypto } from './lib/crypto/crypto.ts';
import { keyProviderFromConfig } from './lib/crypto/keyring.ts';
import { createKysely } from './lib/db/kysely.ts';
import { checkDatabase, createPool } from './lib/db/pool.ts';
import { createJobRunner } from './lib/jobs/jobs.ts';
import { createLogger, loggerOptionsFromConfig } from './lib/logger/logger.ts';
import { createPasswordHasher } from './modules/auth/password.ts';
import { createLoginThrottle } from './modules/auth/throttle.ts';

// Boot order (AC-ERROR-1): config validation first; nothing binds a port before it passes.
const config = loadConfigOrExit();
const logger = createLogger(loggerOptionsFromConfig(config, 'api'));

const pool = createPool({
  connectionString: config.databaseUrl,
  max: config.databasePoolMax,
  logger,
});
const db = createKysely(pool);
// The keyring is validated at boot, as in the worker: a bad key fails here, not on the first OAuth call.
const keys = keyProviderFromConfig(config);
const crypto = createCrypto(keys);
// argon2id hasher: its known-answer self-test runs here, so an unsuitable Node build stops boot (P7).
const passwordHasher = createPasswordHasher();
const loginThrottle = createLoginThrottle({ db, keys, config: config.auth });
// Producer only: the API enqueues jobs (for example the reset email) and never works them.
const jobs = createJobRunner({
  databaseUrl: config.databaseUrl,
  logger,
  role: 'producer',
  poolMax: 2,
});
await jobs.start();

const app = await buildApp({
  logger,
  version: config.serviceVersion,
  checkDb: () => checkDatabase(pool),
  db,
  jobs,
  clock: systemClock,
  crypto,
  auth: config.auth,
  internalAuthSecret: config.internalAuthSecret,
  passwordHasher,
  loginThrottle,
});

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => {
    logger.info({ signal }, 'shutting down');
    void app
      .close()
      .then(() => jobs.stop())
      .then(() => pool.end())
      .then(() => process.exit(0));
  });
}

await app.listen({ port: config.apiPort, host: '0.0.0.0' });
