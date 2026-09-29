import { randomBytes } from 'node:crypto';
import { Writable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { createLogger } from '../logger/logger.ts';
import {
  DecryptionError,
  ENVELOPE_PATTERN,
  createCrypto,
  deriveBankAccountLast4,
  type EncryptionContext,
} from './crypto.ts';
import { KeyringError, createKeyProvider, keyProviderFromEnv } from './keyring.ts';

const PLAINTEXT = '12-3456-7890123-00';
const ctx: EncryptionContext = { table: 'teams', column: 'bank_account_number', rowId: 'row-1' };

const key1 = randomBytes(32);
const key2 = randomBytes(32);
const provider1 = createKeyProvider([{ id: 'k1', key: key1 }], 'k1');
const crypto1 = createCrypto(provider1);

function failure(fn: () => unknown): DecryptionError {
  try {
    fn();
  } catch (error) {
    expect(error).toBeInstanceOf(DecryptionError);
    return error as DecryptionError;
  }
  throw new Error('expected a DecryptionError');
}

/** Flips the first character of one envelope segment (1=keyId 2=iv 3=ciphertext 4=tag). */
function tamper(envelope: string, segment: number): string {
  const parts = envelope.split('.');
  const value = parts[segment] ?? '';
  parts[segment] = (value[0] === 'A' ? 'B' : 'A') + value.slice(1);
  return parts.join('.');
}

describe('encrypt / decrypt', () => {
  it('round-trips text (including unicode and empty) in the v1.<keyId>.<iv>.<ct>.<tag> envelope', () => {
    for (const text of [PLAINTEXT, 'test_akahu_token_ABC123', 'Māori Café 🏸', '']) {
      const envelope = crypto1.encrypt(text, ctx);
      expect(envelope).toMatch(ENVELOPE_PATTERN);
      expect(envelope.startsWith('v1.k1.')).toBe(true);
      expect(crypto1.decrypt(envelope, ctx)).toBe(text);
    }
    // The pattern is the exact CHECK pattern used by the teams migration.
    expect(ENVELOPE_PATTERN.source).toBe(
      '^v1\\.[a-z0-9-]{1,16}\\.[A-Za-z0-9_-]{16}\\.[A-Za-z0-9_-]*\\.[A-Za-z0-9_-]{22}$',
    );
  });

  it('uses a fresh random IV so the same plaintext never yields the same ciphertext', () => {
    const a = crypto1.encrypt(PLAINTEXT, ctx);
    const b = crypto1.encrypt(PLAINTEXT, ctx);
    expect(a).not.toBe(b);
    expect(a.split('.')[2]).not.toBe(b.split('.')[2]);
    expect(crypto1.decrypt(a, ctx)).toBe(crypto1.decrypt(b, ctx));
  });

  it('binds table, column and row id via AAD: a ciphertext moved elsewhere fails authentication', () => {
    const envelope = crypto1.encrypt(PLAINTEXT, ctx);
    for (const moved of [
      { ...ctx, rowId: 'row-2' },
      { ...ctx, column: 'ird_number' },
      { ...ctx, table: 'users' },
    ]) {
      expect(failure(() => crypto1.decrypt(envelope, moved)).reason).toBe('auth_failed');
    }
  });

  it('detects tampering with the iv, ciphertext or tag', () => {
    const envelope = crypto1.encrypt(PLAINTEXT, ctx);
    for (const segment of [2, 3, 4]) {
      expect(failure(() => crypto1.decrypt(tamper(envelope, segment), ctx)).reason).toBe(
        'auth_failed',
      );
    }
  });

  it('reports malformed envelopes, unknown key ids and wrong key material with typed reasons', () => {
    const envelope = crypto1.encrypt(PLAINTEXT, ctx);
    for (const bad of [
      PLAINTEXT,
      '',
      'v2.k1.a.b.c',
      envelope.replace('v1.', 'v0.'),
      envelope.slice(0, -3),
    ]) {
      expect(failure(() => crypto1.decrypt(bad, ctx)).reason).toBe('malformed');
    }
    expect(failure(() => crypto1.decrypt(envelope.replace('.k1.', '.zz.'), ctx)).reason).toBe(
      'unknown_key',
    );
    const wrongKey = createCrypto(createKeyProvider([{ id: 'k1', key: key2 }], 'k1'));
    expect(failure(() => wrongKey.decrypt(envelope, ctx)).reason).toBe('auth_failed');
    expect(() => crypto1.encrypt(42 as never, ctx)).toThrow(TypeError);
    expect(() => crypto1.encrypt(PLAINTEXT, { ...ctx, rowId: '' })).toThrow(TypeError);
  });

  it('errors and log lines never contain plaintext, ciphertext or key material', () => {
    const chunks: string[] = [];
    const sink = new Writable({
      write(chunk: Buffer, _encoding, callback) {
        chunks.push(chunk.toString());
        callback();
      },
    });
    const logger = createLogger(
      {
        service: 'api',
        version: 'test',
        environment: 'test',
        level: 'debug',
        format: 'json',
        output: 'stdout',
        redactPatterns: [],
      },
      sink,
    );
    const envelope = crypto1.encrypt(PLAINTEXT, ctx);
    const wrongKey = createCrypto(createKeyProvider([{ id: 'k1', key: key2 }], 'k1'));
    const errors = [
      failure(() => wrongKey.decrypt(envelope, ctx)),
      failure(() => crypto1.decrypt(tamper(envelope, 3), ctx)),
      failure(() => crypto1.decrypt(envelope.replace('.k1.', '.zz.'), ctx)),
      failure(() => crypto1.decrypt(`x${envelope}`, ctx)),
    ];
    for (const error of errors) {
      logger.error({ err: error, teamId: 'row-1' }, 'could not decrypt team banking details');
    }
    const output = chunks.join('') + errors.map((e) => `${e.message}\n${e.stack ?? ''}`).join('\n');
    expect(output).toContain('could not decrypt');
    const secrets = [
      PLAINTEXT,
      '1234567890123',
      Buffer.from(PLAINTEXT).toString('base64'),
      key1.toString('base64'),
      key1.toString('hex'),
      key2.toString('base64'),
      key2.toString('hex'),
      envelope,
      envelope.split('.')[3] ?? 'x',
    ];
    for (const secret of secrets) expect(output).not.toContain(secret);
  });
});

describe('key rotation', () => {
  it('decrypts with the old key id and encrypts with the active key', () => {
    const old = crypto1.encrypt(PLAINTEXT, ctx);
    const rotated = createCrypto(
      createKeyProvider(
        [
          { id: 'k1', key: key1 },
          { id: 'k2', key: key2 },
        ],
        'k2',
      ),
    );
    expect(rotated.decrypt(old, ctx)).toBe(PLAINTEXT);
    expect(rotated.needsRotation(old)).toBe(true);
    expect(rotated.encrypt(PLAINTEXT, ctx).startsWith('v1.k2.')).toBe(true);

    const fresh = rotated.reencrypt(old, ctx);
    expect(fresh.startsWith('v1.k2.')).toBe(true);
    expect(rotated.needsRotation(fresh)).toBe(false);
    // Once the old key is retired, only re-encrypted values remain readable.
    const onlyNew = createCrypto(createKeyProvider([{ id: 'k2', key: key2 }], 'k2'));
    expect(onlyNew.decrypt(fresh, ctx)).toBe(PLAINTEXT);
    expect(failure(() => onlyNew.decrypt(old, ctx)).reason).toBe('unknown_key');
    expect(failure(() => onlyNew.needsRotation('not-an-envelope')).reason).toBe('malformed');
  });
});

describe('keyring', () => {
  const env = (keys: string, active: string): NodeJS.ProcessEnv => ({
    ENCRYPTION_KEYS: keys,
    ENCRYPTION_ACTIVE_KEY_ID: active,
  });

  it('builds from ENCRYPTION_KEYS / ENCRYPTION_ACTIVE_KEY_ID and serves keys by id', () => {
    const provider = keyProviderFromEnv(
      env(`a1:${key1.toString('base64')}, b2:${key2.toString('base64')}`, 'b2'),
    );
    expect(provider.activeKeyId).toBe('b2');
    expect(provider.getKey('a1')?.equals(key1)).toBe(true);
    expect(provider.getKey('b2')?.equals(key2)).toBe(true);
    expect(provider.getKey('nope')).toBeUndefined();
  });

  it('fails fast without echoing key material', () => {
    const secretB64 = randomBytes(16).toString('base64'); // wrong length
    const cases = [
      env(`a1:${secretB64}`, 'a1'),
      env(`a1:${key1.toString('base64')}`, 'missing'),
      env('', 'a1'),
      { ENCRYPTION_KEYS: `a1:${key1.toString('base64')}` },
    ];
    for (const bad of cases) {
      let caught: unknown;
      try {
        keyProviderFromEnv(bad);
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(KeyringError);
      const message = (caught as KeyringError).message;
      expect(message).not.toContain(secretB64);
      expect(message).not.toContain(key1.toString('base64'));
    }
    expect(() => createKeyProvider([{ id: 'k1', key: randomBytes(16) }], 'k1')).toThrow(
      KeyringError,
    );
  });
});

describe('deriveBankAccountLast4', () => {
  it('returns the last four digits of an account number, ignoring separators', () => {
    expect(deriveBankAccountLast4(PLAINTEXT)).toBe('2300');
    expect(deriveBankAccountLast4('01-0123-0456789-000')).toBe('9000');
    expect(() => deriveBankAccountLast4('12-3')).toThrow(RangeError);
  });
});
