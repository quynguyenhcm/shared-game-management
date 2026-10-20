/**
 * `AppDeps` for tests that build the app without touching a database or a queue: the Kysely handle is
 * over a pool that never connects, jobs are a no-op producer, the clock is manual. Override only what
 * the test cares about (for example `checkDb`, or a real `db` in an integration test).
 */
import type { AppDeps } from '../../src/app.ts';
import { createManualClock } from '../../src/lib/clock.ts';
import { loadConfig, type Config } from '../../src/lib/config/config.ts';
import { createCrypto, type FieldCrypto } from '../../src/lib/crypto/crypto.ts';
import { keyProviderFromConfig } from '../../src/lib/crypto/keyring.ts';
import { createKysely } from '../../src/lib/db/kysely.ts';
import { createPool } from '../../src/lib/db/pool.ts';
import type { Logger } from '../../src/lib/logger/logger.ts';
import { noopSessionAllocator } from '../../src/modules/sessions/allocator-port.ts';
import { buildOAuthProviders } from '../../src/modules/auth/providers/registry.ts';
import { createPasswordHasher } from '../../src/modules/auth/password.ts';
import { createLoginThrottle } from '../../src/modules/auth/throttle.ts';

export const TEST_WEB_BASE_URL = 'https://games.example.nz';

/** A valid config for unit tests (no environment needed). */
export function testConfig(overrides: Record<string, string> = {}): Config {
  return loadConfig({
    NODE_ENV: 'test',
    DATABASE_URL: 'postgres://sgm:sgm@localhost:5432/sgm',
    ENCRYPTION_KEYS: `dev1:${Buffer.alloc(32, 1).toString('base64')}`,
    ENCRYPTION_ACTIVE_KEY_ID: 'dev1',
    WEB_BASE_URL: TEST_WEB_BASE_URL,
    ...overrides,
  });
}

/** Field crypto over the fixed test keyring: the API, the worker and the tests all seal and open with it. */
export function testCrypto(): FieldCrypto {
  return createCrypto(keyProviderFromConfig(testConfig()));
}

export function inertAppDeps(logger: Logger, overrides: Partial<AppDeps> = {}): AppDeps {
  const config = testConfig();
  // Never queried: pg opens connections lazily on checkout.
  const db = createKysely(createPool({ connectionString: config.databaseUrl, max: 1 }));
  return {
    logger,
    version: 'test',
    checkDb: () => Promise.resolve(true),
    db,
    jobs: { enqueue: () => Promise.resolve(null) },
    clock: createManualClock(new Date('2026-10-06T00:00:00Z')),
    crypto: createCrypto(keyProviderFromConfig(config)),
    auth: config.auth,
    internalAuthSecret: config.internalAuthSecret,
    // OWASP-minimum cost keeps the boot self-test and dummy hash cheap in unit tests.
    passwordHasher: createPasswordHasher({ memoryKiB: 19456, passes: 2 }),
    loginThrottle: createLoginThrottle({
      db,
      keys: keyProviderFromConfig(config),
      config: config.auth,
    }),
    oauthProviders: buildOAuthProviders({ auth: config.auth }),
    sessionAllocator: noopSessionAllocator,
    ...overrides,
  };
}
