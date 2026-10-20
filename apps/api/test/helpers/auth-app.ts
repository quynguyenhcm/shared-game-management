/**
 * Real `buildApp` over a real (cloned) Postgres for the auth integration tests: no mocked database.
 * The hasher is a recording wrapper over a real argon2id hasher at the OWASP minimum cost (fast enough for
 * many sign-ins per test file); the clock is manual so session and throttle windows can be moved.
 */
import { createHash } from 'node:crypto';
import type { FastifyInstance, FastifyPluginAsync } from 'fastify';
import type pg from 'pg';
import { buildApp, type AppDeps } from '../../src/app.ts';
import { createManualClock, type ManualClock } from '../../src/lib/clock.ts';
import { createCrypto } from '../../src/lib/crypto/crypto.ts';
import { keyProviderFromConfig } from '../../src/lib/crypto/keyring.ts';
import { createKysely, type Database } from '../../src/lib/db/kysely.ts';
import type { Logger } from '../../src/lib/logger/logger.ts';
import { noopSessionAllocator } from '../../src/modules/sessions/allocator-port.ts';
import { buildOAuthProviders } from '../../src/modules/auth/providers/registry.ts';
import { createPasswordHasher, type PasswordHasher } from '../../src/modules/auth/password.ts';
import { createLoginThrottle } from '../../src/modules/auth/throttle.ts';
import { testConfig } from './app-deps.ts';
import { captureLogs, type CapturedLogs } from './log-capture.ts';
import { insertPasswordIdentity, insertUser } from './factories.ts';

export const TEST_INTERNAL_SECRET = 'test-internal-secret-0123456789abcdef-xyz';
export const START_TIME = new Date('2026-10-06T00:00:00Z');
export const STRONG_PASSWORD = 'kowhai-court-27';

/** OWASP minimum argon2id cost: realistic parameters, about 30 ms per hash. */
export const FAST_HASHER_OPTIONS = { memoryKiB: 19456, passes: 2 } as const;

export interface SpyHasher extends PasswordHasher {
  /** Every `verify` call: the stored hash it was given and whether it was the dummy hash. */
  readonly verifyCalls: { phc: string; isDummy: boolean }[];
  /** How many times `hash` was called since the last `resetCalls` (a reset must not hash for a bad token). */
  hashCount(): number;
  resetCalls(): void;
}

export function createSpyHasher(): SpyHasher {
  const real = createPasswordHasher(FAST_HASHER_OPTIONS);
  const verifyCalls: SpyHasher['verifyCalls'] = [];
  let hashes = 0;
  return {
    dummyHash: real.dummyHash,
    hash: (password) => {
      hashes += 1;
      return real.hash(password);
    },
    verify: (phc, password) => {
      verifyCalls.push({ phc, isDummy: phc === real.dummyHash });
      return real.verify(phc, password);
    },
    verifyCalls,
    hashCount: () => hashes,
    resetCalls: () => {
      verifyCalls.length = 0;
      hashes = 0;
    },
  };
}

export interface AuthTestApp {
  readonly app: FastifyInstance;
  readonly db: Database;
  readonly pool: pg.Pool;
  readonly clock: ManualClock;
  readonly hasher: SpyHasher;
  readonly logs: CapturedLogs;
  close(): Promise<void>;
}

export interface AuthTestOptions {
  readonly env?: Record<string, string>;
  readonly extraPlugins?: readonly FastifyPluginAsync[];
  readonly logger?: Logger;
  /** Job producer; defaults to a no-op. Reset tests pass a real pg-boss producer or a failing one. */
  readonly jobs?: AppDeps['jobs'];
  /** The sessions allocator seam; defaults to the no-op. Sessions tests inject the recording double. */
  readonly sessionAllocator?: AppDeps['sessionAllocator'];
  /** A Kysely handle to use instead of one over `pool` (the sessions tests record executed statements). */
  readonly db?: Database;
}

export async function buildAuthTestApp(
  pool: pg.Pool,
  options: AuthTestOptions = {},
): Promise<AuthTestApp> {
  const config = testConfig(options.env ?? {});
  const clock = createManualClock(START_TIME);
  const logs = captureLogs();
  const db = options.db ?? createKysely(pool);
  const hasher = createSpyHasher();
  const deps: AppDeps = {
    logger: options.logger ?? logs.logger,
    version: 'test',
    checkDb: () => Promise.resolve(true),
    db,
    jobs: options.jobs ?? { enqueue: () => Promise.resolve(null) },
    clock,
    crypto: createCrypto(keyProviderFromConfig(config)),
    auth: config.auth,
    internalAuthSecret: config.internalAuthSecret,
    passwordHasher: hasher,
    loginThrottle: createLoginThrottle({
      db,
      keys: keyProviderFromConfig(config),
      config: config.auth,
    }),
    oauthProviders: buildOAuthProviders({ auth: config.auth }),
    sessionAllocator: options.sessionAllocator ?? noopSessionAllocator,
    ...(options.extraPlugins === undefined ? {} : { extraPlugins: options.extraPlugins }),
  };
  const app = await buildApp(deps);
  return {
    app,
    db,
    pool,
    clock,
    hasher,
    logs,
    // The Kysely handle shares `pool`, which the test database owns and ends.
    close: () => app.close(),
  };
}

export const bearer = (token: string): Record<string, string> => ({
  authorization: `Bearer ${token}`,
});

export const sha256Hex = (value: string): string =>
  createHash('sha256').update(value).digest('hex');

export const internalHeaders = (clientIp?: string): Record<string, string> => ({
  'x-sgm-internal-auth': TEST_INTERNAL_SECRET,
  ...(clientIp === undefined ? {} : { 'x-sgm-client-ip': clientIp }),
});

export interface TestUser {
  readonly id: string;
  readonly email: string;
  readonly password: string;
}

/** A user with a PASSWORD identity, created straight in the database. */
export async function createPasswordUser(
  harness: AuthTestApp,
  options: { email?: string; password?: string; role?: 'GLOBAL_ADMIN' | 'PLAYER' } = {},
): Promise<TestUser> {
  const password = options.password ?? STRONG_PASSWORD;
  const id = await insertUser(harness.pool, 'FEMALE', {
    ...(options.email === undefined ? {} : { email: options.email }),
  });
  await insertPasswordIdentity(harness.pool, id, await harness.hasher.hash(password));
  if (options.role !== undefined) {
    await harness.pool.query(`UPDATE users SET role = $2 WHERE id = $1`, [id, options.role]);
  }
  const { rows } = await harness.pool.query<{ email: string }>(
    `SELECT email FROM users WHERE id = $1`,
    [id],
  );
  return { id, email: rows[0]?.email ?? '', password };
}

export interface SignedIn {
  readonly token: string;
  readonly expiresAt: string;
}

export async function login(
  harness: AuthTestApp,
  email: string,
  password: string,
  headers: Record<string, string> = {},
): Promise<{
  statusCode: number;
  body: Record<string, unknown>;
  headers: Record<string, unknown>;
}> {
  const response = await harness.app.inject({
    method: 'POST',
    url: '/auth/login',
    headers,
    payload: { email, password },
  });
  return {
    statusCode: response.statusCode,
    body: response.json<Record<string, unknown>>(),
    headers: response.headers,
  };
}

/** Logs `user` in and returns the session token. */
export async function sessionFor(
  harness: AuthTestApp,
  user: TestUser,
  headers: Record<string, string> = {},
): Promise<string> {
  const result = await login(harness, user.email, user.password, headers);
  const session = result.body.session as SignedIn | undefined;
  if (result.statusCode !== 200 || session === undefined) {
    throw new Error(`sign-in failed in test setup: ${result.statusCode}`);
  }
  return session.token;
}
