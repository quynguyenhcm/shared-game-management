import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
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

const SECRET_32 = 's3cret-'.repeat(6);

function productionEnv(overrides: Record<string, string | undefined> = {}): NodeJS.ProcessEnv {
  return validEnv({
    NODE_ENV: 'production',
    DATABASE_URL: 'postgres://u:p@db.internal:5432/sgm?sslmode=require',
    WEB_BASE_URL: 'https://games.example.nz',
    API_INTERNAL_SHARED_SECRET: SECRET_32,
    ...overrides,
  });
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

  it('rejects non-URL SMTP_URL, MAILPIT_API_URL and API_INTERNAL_URL without echoing the values', () => {
    const issues = issuesFor(
      validEnv({
        SMTP_URL: 'not a url smtp-secret',
        MAILPIT_API_URL: 'mailpit-garbage',
        API_INTERNAL_URL: 'api-garbage',
      }),
    );
    for (const variable of ['SMTP_URL', 'MAILPIT_API_URL', 'API_INTERNAL_URL']) {
      expect(issues.some((issue) => issue.includes(variable) && issue.includes('valid URL'))).toBe(
        true,
      );
    }
    expect(issues.join('\n')).not.toMatch(/smtp-secret|mailpit-garbage|api-garbage/);
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
    const config = loadConfig(productionEnv());
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

describe('tracing configuration', () => {
  it('exports no traces by default and switches to OTLP when only the endpoint is set', () => {
    expect(loadConfig(validEnv()).otel).toMatchObject({
      tracesExporter: 'none',
      otlpEndpoint: undefined,
    });
    expect(
      loadConfig(validEnv({ OTEL_EXPORTER_OTLP_ENDPOINT: 'http://collector:4318' })).otel,
    ).toMatchObject({ tracesExporter: 'otlp', otlpEndpoint: 'http://collector:4318' });
  });

  it('rejects a non-http OTLP endpoint and an otlp exporter without an endpoint, by name', () => {
    expect(issuesFor(validEnv({ OTEL_EXPORTER_OTLP_ENDPOINT: 'not a url' }))).toEqual([
      expect.stringContaining('OTEL_EXPORTER_OTLP_ENDPOINT'),
    ]);
    expect(issuesFor(validEnv({ OTEL_EXPORTER_OTLP_ENDPOINT: 'ftp://collector' }))).toEqual([
      expect.stringContaining('OTEL_EXPORTER_OTLP_ENDPOINT'),
    ]);
    expect(issuesFor(validEnv({ OTEL_TRACES_EXPORTER: 'otlp' }))).toEqual([
      expect.stringContaining('OTEL_EXPORTER_OTLP_ENDPOINT — is required when'),
    ]);
    expect(issuesFor(validEnv({ OTEL_TRACES_SAMPLER: 'sometimes' }))).toEqual([
      expect.stringContaining('OTEL_TRACES_SAMPLER'),
    ]);
  });
});

describe('job runner tuning', () => {
  it('defaults to production-safe values with no expiry override', () => {
    const { jobs } = loadConfig(validEnv());
    expect(jobs).toEqual({
      expireSecondsOverride: undefined,
      superviseIntervalSeconds: 60,
      pollIntervalSeconds: 2,
    });
  });

  it('parses the test-only overrides and rejects invalid values by name', () => {
    const { jobs } = loadConfig(
      validEnv({
        JOBS_EXPIRE_SECONDS_OVERRIDE: '5',
        JOBS_SUPERVISE_INTERVAL_SECONDS: '2',
        JOBS_POLL_INTERVAL_SECONDS: '0.5',
      }),
    );
    expect(jobs).toEqual({
      expireSecondsOverride: 5,
      superviseIntervalSeconds: 2,
      pollIntervalSeconds: 0.5,
    });
    const issues = issuesFor(
      validEnv({ JOBS_EXPIRE_SECONDS_OVERRIDE: '0', JOBS_POLL_INTERVAL_SECONDS: '0.1' }),
    ).join('\n');
    expect(issues).toContain('JOBS_EXPIRE_SECONDS_OVERRIDE');
    expect(issues).toContain('JOBS_POLL_INTERVAL_SECONDS');
  });
});

describe('auth configuration (AC-VERIFY-7)', () => {
  const AUTH_VARIABLES = [
    'WEB_BASE_URL',
    'GOOGLE_OAUTH_CLIENT_ID',
    'GOOGLE_OAUTH_CLIENT_SECRET',
    'FACEBOOK_OAUTH_APP_ID',
    'FACEBOOK_OAUTH_APP_SECRET',
    'AUTH_FAKE_OAUTH',
    'AUTH_SESSION_IDLE_DAYS',
    'AUTH_SESSION_ABSOLUTE_DAYS',
    'AUTH_RESET_TOKEN_MINUTES',
    'AUTH_LOGIN_MAX_FAILURES_PER_EMAIL',
    'AUTH_LOGIN_MAX_FAILURES_PER_ADDRESS',
    'AUTH_LOGIN_WINDOW_MINUTES',
    'AUTH_FORGOT_MAX_PER_ADDRESS',
    'AUTH_REGISTER_MAX_PER_ADDRESS',
    'API_INTERNAL_SHARED_SECRET',
    'WEB_TRUSTED_PROXY_HOPS',
  ];

  it('applies the documented defaults and leaves providers disabled when neither variable is set', () => {
    const { auth, internalAuthSecret } = loadConfig(validEnv());
    expect(auth).toEqual({
      webBaseUrl: 'http://localhost:3000',
      google: null,
      facebook: null,
      fakeOAuth: false,
      sessionIdleDays: 7,
      sessionAbsoluteDays: 30,
      resetTokenMinutes: 60,
      loginMaxFailuresPerEmail: 5,
      loginMaxFailuresPerAddress: 20,
      loginWindowMinutes: 15,
      forgotMaxPerAddress: 10,
      registerMaxPerAddress: 20,
    });
    expect(internalAuthSecret).toBeNull();
  });

  it('enables a provider only when both of its variables are set; empty strings count as unset', () => {
    const both = loadConfig(
      validEnv({
        GOOGLE_OAUTH_CLIENT_ID: 'gid',
        GOOGLE_OAUTH_CLIENT_SECRET: 'gsecret',
        FACEBOOK_OAUTH_APP_ID: '',
        FACEBOOK_OAUTH_APP_SECRET: '',
      }),
    );
    expect(both.auth.google).toEqual({ clientId: 'gid', clientSecret: 'gsecret' });
    expect(both.auth.facebook).toBeNull();
  });

  it('fails a half-configured provider naming the missing variable and never the value', () => {
    const cases: [Record<string, string>, string][] = [
      [{ GOOGLE_OAUTH_CLIENT_ID: 'gid-value' }, 'GOOGLE_OAUTH_CLIENT_SECRET'],
      [{ GOOGLE_OAUTH_CLIENT_SECRET: 'gsecret-value' }, 'GOOGLE_OAUTH_CLIENT_ID'],
      [{ FACEBOOK_OAUTH_APP_ID: 'fid-value' }, 'FACEBOOK_OAUTH_APP_SECRET'],
      [{ FACEBOOK_OAUTH_APP_SECRET: 'fsecret-value' }, 'FACEBOOK_OAUTH_APP_ID'],
    ];
    for (const [env, missing] of cases) {
      const issues = issuesFor(validEnv(env));
      expect(issues, missing).toEqual([
        expect.stringContaining(`Invalid configuration: ${missing} — `),
      ]);
      expect(issues.join('\n')).not.toMatch(/-value/);
    }
  });

  it('rejects a non-http(s) or path-bearing WEB_BASE_URL and, in production, a non-https one', () => {
    for (const bad of [
      'ftp://games.example.nz',
      'not a url secret-host',
      'https://games.example.nz/app',
    ]) {
      const issues = issuesFor(validEnv({ WEB_BASE_URL: bad }));
      expect(issues).toEqual([expect.stringContaining('Invalid configuration: WEB_BASE_URL — ')]);
      expect(issues.join('\n')).not.toContain('secret-host');
    }
    expect(issuesFor(productionEnv({ WEB_BASE_URL: 'http://games.example.nz' }))).toEqual([
      expect.stringContaining('WEB_BASE_URL — must use https in production'),
    ]);
    // The API has no localhost exception: only the web does.
    expect(issuesFor(productionEnv({ WEB_BASE_URL: 'http://localhost:3000' }))).toEqual([
      expect.stringContaining('WEB_BASE_URL — must use https in production'),
    ]);
    expect(issuesFor(productionEnv({ WEB_BASE_URL: undefined }))).toEqual([
      expect.stringContaining('WEB_BASE_URL — is required'),
    ]);
    expect(loadConfig(productionEnv()).auth.webBaseUrl).toBe('https://games.example.nz');
  });

  it('normalises WEB_BASE_URL to an origin without a trailing slash', () => {
    expect(loadConfig(validEnv({ WEB_BASE_URL: 'http://localhost:3000/' })).auth.webBaseUrl).toBe(
      'http://localhost:3000',
    );
  });

  it('rejects out-of-range TTLs and throttle limits by name, and an absolute lifetime below the idle one', () => {
    const outOfRange: [string, string][] = [
      ['AUTH_SESSION_IDLE_DAYS', '0'],
      ['AUTH_SESSION_IDLE_DAYS', '31'],
      ['AUTH_SESSION_ABSOLUTE_DAYS', '91'],
      ['AUTH_RESET_TOKEN_MINUTES', '9'],
      ['AUTH_RESET_TOKEN_MINUTES', '1441'],
      ['AUTH_LOGIN_MAX_FAILURES_PER_EMAIL', '2'],
      ['AUTH_LOGIN_MAX_FAILURES_PER_EMAIL', '21'],
      ['AUTH_LOGIN_MAX_FAILURES_PER_ADDRESS', '4'],
      ['AUTH_LOGIN_MAX_FAILURES_PER_ADDRESS', '201'],
      ['AUTH_LOGIN_WINDOW_MINUTES', '4'],
      ['AUTH_LOGIN_WINDOW_MINUTES', '61'],
      ['AUTH_FORGOT_MAX_PER_ADDRESS', '2'],
      ['AUTH_FORGOT_MAX_PER_ADDRESS', '101'],
      ['AUTH_REGISTER_MAX_PER_ADDRESS', '2'],
      ['AUTH_REGISTER_MAX_PER_ADDRESS', '201'],
      ['AUTH_SESSION_IDLE_DAYS', 'seven'],
    ];
    for (const [name, value] of outOfRange) {
      const issues = issuesFor(validEnv({ [name]: value }));
      expect(issues, `${name}=${value}`).toEqual([
        expect.stringContaining(`Invalid configuration: ${name} — `),
      ]);
    }
    expect(
      issuesFor(validEnv({ AUTH_SESSION_IDLE_DAYS: '20', AUTH_SESSION_ABSOLUTE_DAYS: '10' })),
    ).toEqual([
      expect.stringContaining(
        'AUTH_SESSION_ABSOLUTE_DAYS — must be at least AUTH_SESSION_IDLE_DAYS',
      ),
    ]);
    const ok = loadConfig(
      validEnv({
        AUTH_SESSION_IDLE_DAYS: '30',
        AUTH_SESSION_ABSOLUTE_DAYS: '90',
        AUTH_LOGIN_WINDOW_MINUTES: '60',
      }),
    ).auth;
    expect([ok.sessionIdleDays, ok.sessionAbsoluteDays, ok.loginWindowMinutes]).toEqual([
      30, 90, 60,
    ]);
  });

  it('refuses AUTH_FAKE_OAUTH=true in production and allows it elsewhere', () => {
    expect(issuesFor(productionEnv({ AUTH_FAKE_OAUTH: 'true' }))).toEqual([
      expect.stringContaining('AUTH_FAKE_OAUTH — must not be true in production'),
    ]);
    expect(loadConfig(validEnv({ AUTH_FAKE_OAUTH: 'true' })).auth.fakeOAuth).toBe(true);
    expect(issuesFor(validEnv({ AUTH_FAKE_OAUTH: 'yes' }))).toEqual([
      expect.stringContaining('AUTH_FAKE_OAUTH'),
    ]);
  });

  it('requires API_INTERNAL_SHARED_SECRET (at least 32 characters) in production and checks length elsewhere when set', () => {
    expect(issuesFor(productionEnv({ API_INTERNAL_SHARED_SECRET: undefined }))).toEqual([
      expect.stringContaining('API_INTERNAL_SHARED_SECRET — is required in production'),
    ]);
    const short = issuesFor(productionEnv({ API_INTERNAL_SHARED_SECRET: 'too-short-secret' }));
    expect(short).toEqual([
      expect.stringContaining('API_INTERNAL_SHARED_SECRET — must be at least 32'),
    ]);
    expect(short.join('\n')).not.toContain('too-short-secret');
    expect(issuesFor(validEnv({ API_INTERNAL_SHARED_SECRET: 'short' }))).toHaveLength(1);
    expect(loadConfig(productionEnv()).internalAuthSecret).toBe(SECRET_32);
  });

  it('rejects the known dev placeholder API_INTERNAL_SHARED_SECRET in production, without echoing it', () => {
    const placeholder = 'dev-only-internal-secret-change-me-0123456789';
    const issues = issuesFor(productionEnv({ API_INTERNAL_SHARED_SECRET: placeholder }));
    expect(issues).toEqual([expect.stringContaining('API_INTERNAL_SHARED_SECRET')]);
    expect(issues.join('\n')).not.toContain(placeholder);
    expect(
      loadConfig(validEnv({ API_INTERNAL_SHARED_SECRET: placeholder })).internalAuthSecret,
    ).toBe(placeholder);
  });

  it('lists every new variable in .env.example and docs/getting-started.md', () => {
    const root = fileURLToPath(new URL('../../../../../', import.meta.url));
    const example = readFileSync(`${root}.env.example`, 'utf8');
    const guide = readFileSync(`${root}docs/getting-started.md`, 'utf8');
    for (const name of AUTH_VARIABLES) {
      expect(example, `.env.example ${name}`).toMatch(new RegExp(`^#?\\s*${name}=`, 'm'));
      expect(guide, `getting-started ${name}`).toContain(name);
    }
  });
});
