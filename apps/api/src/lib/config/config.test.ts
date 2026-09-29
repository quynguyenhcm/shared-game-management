import { randomBytes } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { ConfigError, loadConfig, loadConfigOrExit, parseEncryptionKeys } from './config.ts';

const validKey = randomBytes(32).toString('base64');

function validEnv(overrides: Record<string, string | undefined> = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    NODE_ENV: 'test',
    DATABASE_URL: 'postgres://sgm:supersecretpw@localhost:5432/sgm',
    ENCRYPTION_KEYS: `dev1:${validKey}`,
    ENCRYPTION_ACTIVE_KEY_ID: 'dev1',
    ...overrides,
  };
  for (const [name, value] of Object.entries(overrides)) {
    if (value === undefined) delete env[name];
  }
  return env;
}

function issuesFor(env: NodeJS.ProcessEnv): readonly string[] {
  try {
    loadConfig(env);
  } catch (error) {
    expect(error).toBeInstanceOf(ConfigError);
    return (error as ConfigError).issues;
  }
  throw new Error('expected loadConfig to throw');
}

describe('loadConfig', () => {
  it('returns typed config with defaults for a valid environment', () => {
    const config = loadConfig(validEnv());
    expect(config.apiPort).toBe(4000);
    expect(config.workerHealthPort).toBe(4001);
    expect(config.encryptionKeys).toHaveLength(1);
    expect(config.encryptionKeys[0]?.key.length).toBe(32);
    expect(config.encryptionActiveKeyId).toBe('dev1');
    expect(config.log).toMatchObject({ level: 'info', format: 'json', output: 'stdout' });
  });

  it('fails naming DATABASE_URL when it is missing', () => {
    const issues = issuesFor(validEnv({ DATABASE_URL: undefined }));
    expect(issues).toContain('Invalid configuration: DATABASE_URL — is required');
  });

  it('fails naming ENCRYPTION_KEYS without leaking key material when a key is not 32 bytes', () => {
    const shortKey = randomBytes(16).toString('base64');
    const issues = issuesFor(validEnv({ ENCRYPTION_KEYS: `dev1:${shortKey}` }));
    const text = issues.join('\n');
    expect(text).toContain('Invalid configuration: ENCRYPTION_KEYS');
    expect(text).toContain('32 bytes');
    expect(text).not.toContain(shortKey);
  });

  it('fails naming ENCRYPTION_ACTIVE_KEY_ID when it is missing', () => {
    const issues = issuesFor(validEnv({ ENCRYPTION_ACTIVE_KEY_ID: undefined }));
    expect(issues).toContain('Invalid configuration: ENCRYPTION_ACTIVE_KEY_ID — is required');
  });

  it('fails naming ENCRYPTION_ACTIVE_KEY_ID when it is not in the keyring, never printing secrets', () => {
    const issues = issuesFor(validEnv({ ENCRYPTION_ACTIVE_KEY_ID: 'prod9' }));
    const text = issues.join('\n');
    expect(text).toContain('Invalid configuration: ENCRYPTION_ACTIVE_KEY_ID');
    expect(text).not.toContain(validKey);
    expect(text).not.toContain('supersecretpw');
  });

  it('requires sslmode in production and never echoes the connection string', () => {
    const issues = issuesFor(validEnv({ NODE_ENV: 'production' }));
    const text = issues.join('\n');
    expect(text).toContain('Invalid configuration: DATABASE_URL');
    expect(text).toContain('sslmode');
    expect(text).not.toContain('supersecretpw');
  });

  it('requires LOG_FILE_PATH when LOG_OUTPUT includes file', () => {
    const issues = issuesFor(validEnv({ LOG_OUTPUT: 'both' }));
    expect(issues.join('\n')).toContain('Invalid configuration: LOG_FILE_PATH');
  });
});

describe('configuration edge cases', () => {
  it('reports every problem in one pass without echoing invalid values', () => {
    const issues = issuesFor({
      NODE_ENV: 'test',
      API_PORT: 'not-a-port',
      LOG_FORMAT: 'xml',
      OTEL_SDK_DISABLED: 'maybe',
      DATABASE_URL: 'not a url with secret-token-123',
    });
    const text = issues.join('\n');
    for (const variable of [
      'API_PORT',
      'LOG_FORMAT',
      'OTEL_SDK_DISABLED',
      'DATABASE_URL',
      'ENCRYPTION_KEYS',
      'ENCRYPTION_ACTIVE_KEY_ID',
    ]) {
      expect(text).toContain(`Invalid configuration: ${variable} — `);
    }
    expect(text).not.toContain('secret-token-123');
    expect(text).not.toContain('not-a-port');
  });

  it('parses multiple keys and rejects malformed ids, duplicates and non-base64 keys', () => {
    const other = randomBytes(32).toString('base64');
    const ok = parseEncryptionKeys(`dev1:${validKey}, prod-2:${other}`);
    expect(ok.issues).toEqual([]);
    expect(ok.keys.map((entry) => entry.id)).toEqual(['dev1', 'prod-2']);

    expect(parseEncryptionKeys('').issues).toHaveLength(1);
    expect(parseEncryptionKeys(`BAD_ID:${validKey}`).issues[0]).toContain('id matching');
    expect(parseEncryptionKeys(validKey).issues[0]).toContain('id matching');
    expect(parseEncryptionKeys(`a:${validKey},a:${other}`).issues[0]).toContain('repeats key id');
    expect(parseEncryptionKeys('a:not*base64!').issues[0]).toContain('32 bytes');
  });

  it('derives the log level from NODE_ENV and parses observability settings', () => {
    expect(loadConfig(validEnv({ NODE_ENV: 'development' })).log.level).toBe('debug');
    expect(loadConfig(validEnv({ LOG_LEVEL: 'warn' })).log.level).toBe('warn');
    const config = loadConfig(
      validEnv({
        METRICS_ENABLED: 'true',
        OTEL_SDK_DISABLED: 'true',
        LOG_OUTPUT: 'file',
        LOG_FILE_PATH: '/tmp/sgm.log',
        LOG_REDACT_PATTERNS: 'foo, bar',
      }),
    );
    expect(config.metrics.enabled).toBe(true);
    expect(config.otel.disabled).toBe(true);
    expect(config.log.filePath).toBe('/tmp/sgm.log');
    expect(config.log.redactPatterns).toEqual(['foo', 'bar']);
  });

  it('accepts sslmode=require in production', () => {
    const config = loadConfig(
      validEnv({
        NODE_ENV: 'production',
        DATABASE_URL: 'postgres://u:p@db.internal:5432/sgm?sslmode=require',
      }),
    );
    expect(config.nodeEnv).toBe('production');
  });

  it('loadConfigOrExit prints value-free issues to stderr and exits 1', () => {
    const write = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const exit = vi.spyOn(process, 'exit').mockImplementation(() => {
      throw new Error('exit called');
    });
    try {
      expect(() => loadConfigOrExit(validEnv({ DATABASE_URL: undefined }))).toThrow('exit called');
      expect(exit).toHaveBeenCalledWith(1);
      expect(String(write.mock.calls[0]?.[0])).toContain('DATABASE_URL');
    } finally {
      write.mockRestore();
      exit.mockRestore();
    }
  });
});
