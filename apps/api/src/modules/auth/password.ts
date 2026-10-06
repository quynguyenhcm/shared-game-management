/**
 * Password hashing with `node:crypto` argon2id (Node >= 24.7, OpenSSL >= 3.2); architecture Q1-H.
 * Hashes are standard PHC strings, so any argon2 library (including `@node-rs/argon2`, the documented
 * fallback) verifies them. Passwords are NFKC-normalised before hashing and before verifying.
 */
import * as nodeCrypto from 'node:crypto';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { trace } from '@opentelemetry/api';
import { AppError } from '../../lib/http/errors.ts';

type Argon2Sync = typeof nodeCrypto.argon2Sync;

/** Production cost: m=64 MiB, t=3, p=1 (above the OWASP minimum m=19 MiB, t=2, p=1; RFC 9106 second option). */
export const ARGON2_DEFAULTS = {
  memoryKiB: 65_536,
  passes: 3,
  parallelism: 1,
  tagLength: 32,
  saltLength: 16,
} as const;

/** Hard ceiling on parameters read back from a stored hash, so a corrupt row cannot exhaust memory. */
const MAX_MEMORY_KIB = 1_048_576;
const MAX_PASSES = 20;
const MAX_PARALLELISM = 16;
const DEFAULT_MAX_CONCURRENCY = 2;
const DEFAULT_MAX_QUEUE = 100;
const DUMMY_PASSWORD = 'dummy-password-for-constant-time-verification';

export interface PasswordHasher {
  /** PHC string for `password` (NFKC-normalised first). */
  hash(password: string): Promise<string>;
  /** Never throws on a malformed hash: that is simply `ok: false`. */
  verify(phc: string, password: string): Promise<{ ok: boolean; needsRehash: boolean }>;
  /**
   * A valid hash of a throwaway password, computed once. Unknown accounts still call
   * `verify(dummyHash, password)` so response time does not reveal whether an email is registered.
   */
  readonly dummyHash: string;
}

export interface PasswordHasherOptions {
  readonly memoryKiB?: number;
  readonly passes?: number;
  /** At most this many hashes or verifications run at once per process (bounds transient memory). */
  readonly maxConcurrency?: number;
  /** At most this many callers wait for a free slot; further ones fail fast with 503 (default 100). */
  readonly maxQueue?: number;
}

const tracer = trace.getTracer('sgm-api');

const encodeB64 = (bytes: Buffer): string => bytes.toString('base64').replace(/=+$/, '');
const decodeB64 = (text: string): Buffer => Buffer.from(text, 'base64');

/** RFC 9106 section 5.3: argon2id with secret and associated data (m=32, t=3, p=4). */
const KNOWN_ANSWER = {
  message: Buffer.alloc(32, 0x01),
  nonce: Buffer.alloc(16, 0x02),
  secret: Buffer.alloc(8, 0x03),
  associatedData: Buffer.alloc(12, 0x04),
  expected: '0d640df58d78766c08c037a34a8b53c9d01ef0452d75b65eb52520e96b01e659',
} as const;

/**
 * Boot self-test (P7): `crypto.argon2Sync` exists and reproduces the RFC 9106 argon2id vector. It catches a
 * Node build linked against an OpenSSL without argon2, before the first sign-in.
 */
export function selfTestArgon2(
  deps: { readonly argon2Sync: Argon2Sync | undefined } = { argon2Sync: nodeCrypto.argon2Sync },
): void {
  const failure = new Error(
    'Invalid configuration: runtime — node:crypto argon2 unavailable (Node >= 24.7 with OpenSSL >= 3.2 required)',
  );
  if (typeof deps.argon2Sync !== 'function') throw failure;
  let tag: Buffer;
  try {
    tag = deps.argon2Sync('argon2id', {
      message: KNOWN_ANSWER.message,
      nonce: KNOWN_ANSWER.nonce,
      secret: KNOWN_ANSWER.secret,
      associatedData: KNOWN_ANSWER.associatedData,
      parallelism: 4,
      tagLength: 32,
      memory: 32,
      passes: 3,
    });
  } catch (error) {
    throw new Error(failure.message, { cause: error });
  }
  if (tag.toString('hex') !== KNOWN_ANSWER.expected) throw failure;
}

interface ParsedPhc {
  readonly memoryKiB: number;
  readonly passes: number;
  readonly parallelism: number;
  readonly salt: Buffer;
  readonly tag: Buffer;
}

const PHC_PATTERN =
  /^\$argon2id\$v=19\$m=(\d{1,8}),t=(\d{1,3}),p=(\d{1,3})\$([A-Za-z0-9+/]{11,86})\$([A-Za-z0-9+/]{16,86})$/;

/** Strict PHC parse; `null` for anything that is not an argon2id v19 hash with sane parameters. */
function parsePhc(phc: string): ParsedPhc | null {
  if (phc.length > 512) return null;
  const match = PHC_PATTERN.exec(phc);
  if (!match) return null;
  const [, m, t, p, salt, tag] = match as unknown as [
    string,
    string,
    string,
    string,
    string,
    string,
  ];
  const memoryKiB = Number(m);
  const passes = Number(t);
  const parallelism = Number(p);
  if (
    memoryKiB > MAX_MEMORY_KIB ||
    passes < 1 ||
    passes > MAX_PASSES ||
    parallelism < 1 ||
    parallelism > MAX_PARALLELISM ||
    memoryKiB < 8 * parallelism
  ) {
    return null;
  }
  return { memoryKiB, passes, parallelism, salt: decodeB64(salt), tag: decodeB64(tag) };
}

/**
 * A counting semaphore: callers beyond `limit` queue in arrival order, and once `maxQueue` callers are
 * already waiting the next one is shed with 503 `service_unavailable` instead of queueing without bound
 * (a flood of unknown-account sign-ins or registrations must not grow memory or latency forever).
 */
function createLimiter(limit: number, maxQueue: number): <T>(task: () => Promise<T>) => Promise<T> {
  let active = 0;
  const waiting: (() => void)[] = [];
  // A finishing task hands its slot straight to the next waiter (`active` stays), so a caller arriving
  // in between can never run alongside it and exceed `limit`.
  const release = (): void => {
    const next = waiting.shift();
    if (next === undefined) active -= 1;
    else next();
  };
  return async <T>(task: () => Promise<T>): Promise<T> => {
    if (active >= limit) {
      if (waiting.length >= maxQueue) {
        throw new AppError('service_unavailable', {
          message: 'Too many sign-ins are being processed right now. Try again shortly.',
        });
      }
      await new Promise<void>((resolve) => waiting.push(resolve));
    } else {
      active += 1;
    }
    try {
      return await task();
    } finally {
      release();
    }
  };
}

function derive(
  password: string,
  salt: Buffer,
  params: { memoryKiB: number; passes: number; parallelism: number; tagLength: number },
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    nodeCrypto.argon2(
      'argon2id',
      {
        message: Buffer.from(password.normalize('NFKC'), 'utf8'),
        nonce: salt,
        parallelism: params.parallelism,
        tagLength: params.tagLength,
        memory: params.memoryKiB,
        passes: params.passes,
      },
      (error, derivedKey) => {
        if (error) reject(error);
        else resolve(derivedKey);
      },
    );
  });
}

export function createPasswordHasher(options: PasswordHasherOptions = {}): PasswordHasher {
  selfTestArgon2();
  const current = {
    memoryKiB: options.memoryKiB ?? ARGON2_DEFAULTS.memoryKiB,
    passes: options.passes ?? ARGON2_DEFAULTS.passes,
    parallelism: ARGON2_DEFAULTS.parallelism,
    tagLength: ARGON2_DEFAULTS.tagLength,
  };
  const limited = createLimiter(
    options.maxConcurrency ?? DEFAULT_MAX_CONCURRENCY,
    options.maxQueue ?? DEFAULT_MAX_QUEUE,
  );

  const encode = (salt: Buffer, tag: Buffer): string =>
    `$argon2id$v=19$m=${current.memoryKiB},t=${current.passes},p=${current.parallelism}$${encodeB64(salt)}$${encodeB64(tag)}`;

  // Computed once at construction with the current parameters, so a dummy verify costs the same as a real one.
  const dummySalt = randomBytes(ARGON2_DEFAULTS.saltLength);
  const dummyHash = encode(
    dummySalt,
    nodeCrypto.argon2Sync('argon2id', {
      message: Buffer.from(DUMMY_PASSWORD, 'utf8'),
      nonce: dummySalt,
      parallelism: current.parallelism,
      tagLength: current.tagLength,
      memory: current.memoryKiB,
      passes: current.passes,
    }),
  );

  return {
    dummyHash,
    hash: (password) =>
      limited(() =>
        tracer.startActiveSpan('auth.password.hash', async (span) => {
          try {
            const salt = randomBytes(ARGON2_DEFAULTS.saltLength);
            return encode(salt, await derive(password, salt, current));
          } finally {
            span.end();
          }
        }),
      ),
    verify: (phc, password) =>
      limited(() =>
        tracer.startActiveSpan('auth.password.verify', async (span) => {
          try {
            const parsed = parsePhc(phc);
            if (parsed === null) return { ok: false, needsRehash: false };
            const tag = await derive(password, parsed.salt, {
              memoryKiB: parsed.memoryKiB,
              passes: parsed.passes,
              parallelism: parsed.parallelism,
              tagLength: parsed.tag.length,
            });
            const ok = tag.length === parsed.tag.length && timingSafeEqual(tag, parsed.tag);
            const needsRehash =
              ok &&
              (parsed.memoryKiB < current.memoryKiB ||
                parsed.passes < current.passes ||
                parsed.parallelism < current.parallelism ||
                parsed.tag.length < current.tagLength ||
                parsed.salt.length < ARGON2_DEFAULTS.saltLength);
            span.setAttribute('rehash', needsRehash);
            return { ok, needsRehash };
          } catch {
            // A parameter set the runtime rejects is a corrupt hash, not a server fault.
            return { ok: false, needsRehash: false };
          } finally {
            span.end();
          }
        }),
      ),
  };
}
