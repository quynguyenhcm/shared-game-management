// Console output is allowed here (see eslint.config.mjs): this script writes the spec to stdout.
import { fileURLToPath } from 'node:url';
import { buildApp } from './app.ts';
import { systemClock } from './lib/clock.ts';
import { loadConfig } from './lib/config/config.ts';
import { createCrypto } from './lib/crypto/crypto.ts';
import { keyProviderFromConfig } from './lib/crypto/keyring.ts';
import { createKysely } from './lib/db/kysely.ts';
import { createPool } from './lib/db/pool.ts';
import { createLogger } from './lib/logger/logger.ts';
import { buildOAuthProviders } from './modules/auth/providers/registry.ts';
import { createPasswordHasher } from './modules/auth/password.ts';
import { createLoginThrottle } from './modules/auth/throttle.ts';

/** Builds the app with inert dependencies and returns its OpenAPI document as YAML. */
export async function generateOpenApiYaml(): Promise<string> {
  const logger = createLogger({
    service: 'openapi',
    version: 'openapi',
    environment: 'test',
    level: 'silent',
    format: 'json',
    output: 'stdout',
    redactPatterns: [],
  });
  // Inert dependencies: the routes, not the deps, define the document. The pool never connects.
  const config = loadConfig({
    NODE_ENV: 'test',
    DATABASE_URL: 'postgres://openapi:openapi@localhost:5432/openapi',
    ENCRYPTION_KEYS: `openapi:${Buffer.alloc(32).toString('base64')}`,
    ENCRYPTION_ACTIVE_KEY_ID: 'openapi',
  });
  const pool = createPool({ connectionString: config.databaseUrl, max: 1 });
  const db = createKysely(pool);
  const keys = keyProviderFromConfig(config);
  const app = await buildApp({
    logger,
    version: 'openapi',
    checkDb: () => Promise.resolve(true),
    db,
    jobs: { enqueue: () => Promise.resolve(null) },
    clock: systemClock,
    crypto: createCrypto(keys),
    auth: config.auth,
    internalAuthSecret: config.internalAuthSecret,
    // Cheapest legal cost: the document does not depend on it and the hasher self-tests on creation.
    passwordHasher: createPasswordHasher({ memoryKiB: 19_456, passes: 2 }),
    loginThrottle: createLoginThrottle({ db, keys, config: config.auth }),
    oauthProviders: buildOAuthProviders({ auth: config.auth }),
  });
  try {
    return app.swagger({ yaml: true });
  } finally {
    await app.close();
    await pool.end();
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  process.stdout.write(await generateOpenApiYaml());
}
