import { z } from 'zod';

/** Thrown by `loadConfig` for any invalid configuration. Messages never contain the offending value. */
export class ConfigError extends Error {
  readonly issues: readonly string[];

  constructor(issues: readonly string[]) {
    super(issues.join('\n'));
    this.name = 'ConfigError';
    this.issues = issues;
  }
}

/** The throwaway secret shipped in `.env.example` and docker-compose; never acceptable in production. */
const DEV_PLACEHOLDER_INTERNAL_SECRET = 'dev-only-internal-secret-change-me-0123456789';
const KEY_ID_PATTERN = /^[a-z0-9-]{1,16}$/;
const BASE64_PATTERN = /^[A-Za-z0-9+/]+={0,2}$/;

export interface KeyringEntry {
  readonly id: string;
  readonly key: Buffer;
}

/**
 * Parses `ENCRYPTION_KEYS` (`<id>:<base64 of 32 bytes>[,<id>:<base64>...]`).
 * Returns issue strings that never echo key material. Pure helper, reusable by the Phase 4 keyring.
 */
export function parseEncryptionKeys(raw: string): { keys: KeyringEntry[]; issues: string[] } {
  const keys: KeyringEntry[] = [];
  const issues: string[] = [];
  const entries = raw
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
  if (entries.length === 0) {
    issues.push('must contain at least one "<id>:<base64 key>" entry');
  }
  entries.forEach((entry, index) => {
    const position = index + 1;
    const separator = entry.indexOf(':');
    const id = separator === -1 ? '' : entry.slice(0, separator);
    const encoded = separator === -1 ? '' : entry.slice(separator + 1);
    if (!KEY_ID_PATTERN.test(id)) {
      issues.push(`entry ${position} must have an id matching ^[a-z0-9-]{1,16}$ before ":"`);
      return;
    }
    if (keys.some((existing) => existing.id === id)) {
      issues.push(`entry ${position} repeats key id "${id}"`);
      return;
    }
    const key = BASE64_PATTERN.test(encoded) ? Buffer.from(encoded, 'base64') : Buffer.alloc(0);
    if (key.length !== 32) {
      issues.push(`key "${id}" must be valid base64 that decodes to exactly 32 bytes`);
      return;
    }
    keys.push({ id, key });
  });
  return { keys, issues };
}

const urlString = z.string().refine((value) => URL.canParse(value), 'must be a valid URL');

const port = z.coerce.number().int().min(1).max(65535);
/** An empty value (`VAR=` in an env file) counts as unset. */
const blankAsUnset = (value: unknown): unknown => (value === '' ? undefined : value);
const optionalString = z.preprocess(blankAsUnset, z.string().optional());
const intInRange = (min: number, max: number, fallback: number) =>
  z.coerce.number().int().min(min).max(max).default(fallback);
const booleanFlag = z.enum(['true', 'false']).transform((value) => value === 'true');

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  SERVICE_VERSION: z.string().min(1).default('0.0.0-dev'),
  API_PORT: port.default(4000),
  WORKER_HEALTH_PORT: port.default(4001),
  DATABASE_URL: z
    .string()
    .min(1, 'is required')
    .pipe(z.string().refine((value) => URL.canParse(value), 'must be a valid URL')),
  DATABASE_POOL_MAX: z.coerce.number().int().min(1).max(200).default(10),
  ENCRYPTION_KEYS: z.string().min(1, 'is required'),
  ENCRYPTION_ACTIVE_KEY_ID: z.string().min(1, 'is required'),
  NOTIFIER_ADAPTER: z.enum(['smtp', 'memory']).default('smtp'),
  SMTP_URL: urlString.default('smtp://localhost:1025'),
  EMAIL_FROM: z.string().default('Shared Game Management <no-reply@localhost>'),
  MAILPIT_API_URL: urlString.default('http://localhost:8025'),
  API_INTERNAL_URL: urlString.default('http://localhost:4000'),
  // Auth (AC-VERIFY-7). Rules that depend on other variables are checked in `loadConfig`.
  WEB_BASE_URL: optionalString,
  GOOGLE_OAUTH_CLIENT_ID: optionalString,
  GOOGLE_OAUTH_CLIENT_SECRET: optionalString,
  FACEBOOK_OAUTH_APP_ID: optionalString,
  FACEBOOK_OAUTH_APP_SECRET: optionalString,
  AUTH_FAKE_OAUTH: booleanFlag.default(false),
  AUTH_SESSION_IDLE_DAYS: intInRange(1, 30, 7),
  AUTH_SESSION_ABSOLUTE_DAYS: intInRange(1, 90, 30),
  AUTH_RESET_TOKEN_MINUTES: intInRange(10, 1440, 60),
  AUTH_LOGIN_MAX_FAILURES_PER_EMAIL: intInRange(3, 20, 5),
  AUTH_LOGIN_MAX_FAILURES_PER_ADDRESS: intInRange(5, 200, 20),
  AUTH_LOGIN_WINDOW_MINUTES: intInRange(5, 60, 15),
  AUTH_FORGOT_MAX_PER_ADDRESS: intInRange(3, 100, 10),
  API_INTERNAL_SHARED_SECRET: z.preprocess(
    blankAsUnset,
    z.string().min(32, 'must be at least 32 characters').optional(),
  ),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).optional(),
  LOG_FORMAT: z.enum(['json', 'text']).default('json'),
  LOG_OUTPUT: z.enum(['stdout', 'file', 'both']).default('stdout'),
  LOG_FILE_PATH: z.string().min(1).optional(),
  LOG_REDACT_PATTERNS: z.string().default('password,secret,token,apiKey'),
  OTEL_SDK_DISABLED: booleanFlag.default(false),
  OTEL_SERVICE_NAME: z.string().min(1).optional(),
  // Unset: `otlp` when an endpoint is configured, otherwise `none` (no exporter, spans stay in-process).
  OTEL_TRACES_EXPORTER: z.enum(['none', 'console', 'otlp']).optional(),
  OTEL_EXPORTER_OTLP_ENDPOINT: z
    .string()
    .refine(
      (value) => URL.canParse(value) && /^https?:$/.test(new URL(value).protocol),
      'must be an http(s) URL',
    )
    .optional(),
  OTEL_TRACES_SAMPLER: z
    .enum([
      'always_on',
      'always_off',
      'traceidratio',
      'parentbased_always_on',
      'parentbased_always_off',
      'parentbased_traceidratio',
    ])
    .default('parentbased_traceidratio'),
  OTEL_TRACES_SAMPLER_ARG: z.coerce.number().min(0).max(1).default(1),
  METRICS_ENABLED: booleanFlag.default(false),
  METRICS_PORT: port.default(9090),
  METRICS_PATH: z.string().startsWith('/').default('/metrics'),
  // Job runner tuning. The overrides exist so integration tests can shorten expiry (SIGKILL recovery).
  JOBS_EXPIRE_SECONDS_OVERRIDE: z.coerce.number().int().min(1).optional(),
  JOBS_SUPERVISE_INTERVAL_SECONDS: z.coerce.number().int().min(1).default(60),
  JOBS_POLL_INTERVAL_SECONDS: z.coerce.number().min(0.5).default(2),
});

export type OtelSampler = z.infer<typeof envSchema>['OTEL_TRACES_SAMPLER'];

/** Auth settings (`config.auth`), injected into `buildApp` as one value. */
export interface AuthConfig {
  /** Origin of the web app, no trailing slash. The API's only trusted browser origin. */
  readonly webBaseUrl: string;
  /** Both variables set, otherwise `null` (the provider is disabled). */
  readonly google: { readonly clientId: string; readonly clientSecret: string } | null;
  readonly facebook: { readonly appId: string; readonly appSecret: string } | null;
  /** Env-selected fake OAuth providers for E2E; refused in production. */
  readonly fakeOAuth: boolean;
  readonly sessionIdleDays: number;
  readonly sessionAbsoluteDays: number;
  readonly resetTokenMinutes: number;
  readonly loginMaxFailuresPerEmail: number;
  readonly loginMaxFailuresPerAddress: number;
  readonly loginWindowMinutes: number;
  readonly forgotMaxPerAddress: number;
}

export interface Config {
  readonly nodeEnv: 'development' | 'test' | 'production';
  readonly serviceVersion: string;
  readonly apiPort: number;
  readonly workerHealthPort: number;
  readonly databaseUrl: string;
  readonly databasePoolMax: number;
  readonly encryptionKeys: readonly KeyringEntry[];
  readonly encryptionActiveKeyId: string;
  readonly notifierAdapter: 'smtp' | 'memory';
  readonly smtpUrl: string;
  readonly emailFrom: string;
  readonly mailpitApiUrl: string;
  readonly apiInternalUrl: string;
  readonly auth: AuthConfig;
  /** Shared with the web (`x-sgm-internal-auth`); `null` when unset (only allowed outside production). */
  readonly internalAuthSecret: string | null;
  readonly log: {
    readonly level: string;
    readonly format: 'json' | 'text';
    readonly output: 'stdout' | 'file' | 'both';
    readonly filePath: string | undefined;
    readonly redactPatterns: readonly string[];
  };
  readonly otel: {
    readonly disabled: boolean;
    /** Unset in the env: set per process by `instrumentation.ts` (`sgm-api` / `sgm-worker`). */
    readonly serviceName: string | undefined;
    /** Effective exporter: `otlp` only ever runs with an endpoint. */
    readonly tracesExporter: 'none' | 'console' | 'otlp';
    readonly otlpEndpoint: string | undefined;
    readonly sampler: OtelSampler;
    readonly samplerArg: number;
  };
  readonly metrics: {
    readonly enabled: boolean;
    readonly port: number;
    readonly path: string;
  };
  readonly jobs: {
    /** When set, replaces every queue's expireInSeconds (test-only; production leaves it unset). */
    readonly expireSecondsOverride: number | undefined;
    /** How often pg-boss reclaims expired active jobs; bounds crash recovery (default 60 s). */
    readonly superviseIntervalSeconds: number;
    readonly pollIntervalSeconds: number;
  };
}

const formatIssue = (variable: string, issue: string): string =>
  `Invalid configuration: ${variable} — ${issue}`;

/**
 * Validates `WEB_BASE_URL`: an http(s) origin with no path, https in production (the API has no localhost
 * exception). Returns the origin without a trailing slash, or an issue that never contains the value.
 */
function parseWebBaseUrl(
  raw: string | undefined,
  production: boolean,
): { origin: string } | { issue: string } {
  if (raw === undefined) {
    return production ? { issue: 'is required' } : { origin: 'http://localhost:3000' };
  }
  const url = URL.canParse(raw) ? new URL(raw) : undefined;
  if (
    url === undefined ||
    !/^https?:$/.test(url.protocol) ||
    url.pathname !== '/' ||
    url.search !== '' ||
    url.hash !== '' ||
    url.username !== '' ||
    url.password !== ''
  ) {
    return { issue: 'must be an http(s) URL with no path' };
  }
  if (production && url.protocol !== 'https:') {
    return { issue: 'must use https in production' };
  }
  return { origin: url.origin };
}

function databaseSslIssue(databaseUrl: string): string | undefined {
  const sslmode = new URL(databaseUrl).searchParams.get('sslmode');
  return sslmode === 'require' || sslmode === 'verify-full'
    ? undefined
    : 'must include sslmode=require or sslmode=verify-full in production';
}

type EnvData = z.infer<typeof envSchema>;

/** Cross-variable auth rules (AC-VERIFY-7). Messages name variables, never values. */
function authIssues(data: EnvData): string[] {
  const issues: string[] = [];
  const production = data.NODE_ENV === 'production';
  const pairs = [
    [
      'GOOGLE_OAUTH_CLIENT_ID',
      data.GOOGLE_OAUTH_CLIENT_ID,
      'GOOGLE_OAUTH_CLIENT_SECRET',
      data.GOOGLE_OAUTH_CLIENT_SECRET,
    ],
    [
      'FACEBOOK_OAUTH_APP_ID',
      data.FACEBOOK_OAUTH_APP_ID,
      'FACEBOOK_OAUTH_APP_SECRET',
      data.FACEBOOK_OAUTH_APP_SECRET,
    ],
  ] as const;
  for (const [idName, id, secretName, secret] of pairs) {
    if (id !== undefined && secret === undefined) {
      issues.push(formatIssue(secretName, `is required when ${idName} is set`));
    } else if (id === undefined && secret !== undefined) {
      issues.push(formatIssue(idName, `is required when ${secretName} is set`));
    }
  }
  if (production && data.AUTH_FAKE_OAUTH) {
    issues.push(formatIssue('AUTH_FAKE_OAUTH', 'must not be true in production'));
  }
  if (data.AUTH_SESSION_ABSOLUTE_DAYS < data.AUTH_SESSION_IDLE_DAYS) {
    issues.push(
      formatIssue('AUTH_SESSION_ABSOLUTE_DAYS', 'must be at least AUTH_SESSION_IDLE_DAYS'),
    );
  }
  if (production && data.API_INTERNAL_SHARED_SECRET === undefined) {
    issues.push(formatIssue('API_INTERNAL_SHARED_SECRET', 'is required in production'));
  }
  if (production && data.API_INTERNAL_SHARED_SECRET === DEV_PLACEHOLDER_INTERNAL_SECRET) {
    issues.push(
      formatIssue(
        'API_INTERNAL_SHARED_SECRET',
        'must not be the development placeholder in production',
      ),
    );
  }
  const base = parseWebBaseUrl(data.WEB_BASE_URL, production);
  if ('issue' in base) issues.push(formatIssue('WEB_BASE_URL', base.issue));
  return issues;
}

/**
 * Validates the environment and returns typed config, or throws `ConfigError`.
 * Issue messages name the variable and never include its value (AC-ERROR-1).
 */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const issues: string[] = [];
  const parsed = envSchema.safeParse(env);

  if (!parsed.success) {
    for (const issue of parsed.error.issues) {
      const variable = String(issue.path[0] ?? 'environment');
      // Zod reports missing (undefined) values as "expected ..."; normalise to a value-free message.
      const message = env[variable] === undefined ? 'is required' : issue.message;
      issues.push(formatIssue(variable, message));
    }
    // Still validate the keyring so every problem is reported in a single pass.
  }

  const rawKeys = env.ENCRYPTION_KEYS;
  const keyring =
    rawKeys !== undefined && rawKeys !== ''
      ? parseEncryptionKeys(rawKeys)
      : { keys: [] as KeyringEntry[], issues: [] as string[] };
  for (const issue of keyring.issues) {
    issues.push(formatIssue('ENCRYPTION_KEYS', issue));
  }
  const activeId = env.ENCRYPTION_ACTIVE_KEY_ID;
  if (
    activeId !== undefined &&
    activeId !== '' &&
    keyring.issues.length === 0 &&
    rawKeys !== undefined &&
    !keyring.keys.some((entry) => entry.id === activeId)
  ) {
    issues.push(
      formatIssue('ENCRYPTION_ACTIVE_KEY_ID', 'does not match any id in ENCRYPTION_KEYS'),
    );
  }

  const data = parsed.success ? parsed.data : undefined;
  if (data) {
    if (data.NODE_ENV === 'production') {
      const sslIssue = databaseSslIssue(data.DATABASE_URL);
      if (sslIssue) issues.push(formatIssue('DATABASE_URL', sslIssue));
    }
    if (data.OTEL_TRACES_EXPORTER === 'otlp' && data.OTEL_EXPORTER_OTLP_ENDPOINT === undefined) {
      issues.push(
        formatIssue('OTEL_EXPORTER_OTLP_ENDPOINT', 'is required when OTEL_TRACES_EXPORTER=otlp'),
      );
    }
    issues.push(...authIssues(data));
    if ((data.LOG_OUTPUT === 'file' || data.LOG_OUTPUT === 'both') && !data.LOG_FILE_PATH) {
      issues.push(formatIssue('LOG_FILE_PATH', 'is required when LOG_OUTPUT includes file'));
    }
  }

  if (issues.length > 0 || !data) {
    throw new ConfigError(issues);
  }
  // Valid by now: `authIssues` reported every WEB_BASE_URL problem.
  const webBase = parseWebBaseUrl(data.WEB_BASE_URL, data.NODE_ENV === 'production');
  if ('issue' in webBase) throw new ConfigError([formatIssue('WEB_BASE_URL', webBase.issue)]);

  return {
    nodeEnv: data.NODE_ENV,
    serviceVersion: data.SERVICE_VERSION,
    apiPort: data.API_PORT,
    workerHealthPort: data.WORKER_HEALTH_PORT,
    databaseUrl: data.DATABASE_URL,
    databasePoolMax: data.DATABASE_POOL_MAX,
    encryptionKeys: keyring.keys,
    encryptionActiveKeyId: data.ENCRYPTION_ACTIVE_KEY_ID,
    notifierAdapter: data.NOTIFIER_ADAPTER,
    smtpUrl: data.SMTP_URL,
    emailFrom: data.EMAIL_FROM,
    mailpitApiUrl: data.MAILPIT_API_URL,
    apiInternalUrl: data.API_INTERNAL_URL,
    auth: {
      webBaseUrl: webBase.origin,
      google:
        data.GOOGLE_OAUTH_CLIENT_ID !== undefined && data.GOOGLE_OAUTH_CLIENT_SECRET !== undefined
          ? { clientId: data.GOOGLE_OAUTH_CLIENT_ID, clientSecret: data.GOOGLE_OAUTH_CLIENT_SECRET }
          : null,
      facebook:
        data.FACEBOOK_OAUTH_APP_ID !== undefined && data.FACEBOOK_OAUTH_APP_SECRET !== undefined
          ? { appId: data.FACEBOOK_OAUTH_APP_ID, appSecret: data.FACEBOOK_OAUTH_APP_SECRET }
          : null,
      fakeOAuth: data.AUTH_FAKE_OAUTH,
      sessionIdleDays: data.AUTH_SESSION_IDLE_DAYS,
      sessionAbsoluteDays: data.AUTH_SESSION_ABSOLUTE_DAYS,
      resetTokenMinutes: data.AUTH_RESET_TOKEN_MINUTES,
      loginMaxFailuresPerEmail: data.AUTH_LOGIN_MAX_FAILURES_PER_EMAIL,
      loginMaxFailuresPerAddress: data.AUTH_LOGIN_MAX_FAILURES_PER_ADDRESS,
      loginWindowMinutes: data.AUTH_LOGIN_WINDOW_MINUTES,
      forgotMaxPerAddress: data.AUTH_FORGOT_MAX_PER_ADDRESS,
    },
    internalAuthSecret: data.API_INTERNAL_SHARED_SECRET ?? null,
    log: {
      level: data.LOG_LEVEL ?? (data.NODE_ENV === 'development' ? 'debug' : 'info'),
      format: data.LOG_FORMAT,
      output: data.LOG_OUTPUT,
      filePath: data.LOG_FILE_PATH,
      redactPatterns: data.LOG_REDACT_PATTERNS.split(',')
        .map((pattern) => pattern.trim())
        .filter((pattern) => pattern.length > 0),
    },
    otel: {
      disabled: data.OTEL_SDK_DISABLED,
      serviceName: data.OTEL_SERVICE_NAME,
      tracesExporter:
        data.OTEL_TRACES_EXPORTER ??
        (data.OTEL_EXPORTER_OTLP_ENDPOINT === undefined ? 'none' : 'otlp'),
      otlpEndpoint: data.OTEL_EXPORTER_OTLP_ENDPOINT,
      sampler: data.OTEL_TRACES_SAMPLER,
      samplerArg: data.OTEL_TRACES_SAMPLER_ARG,
    },
    metrics: { enabled: data.METRICS_ENABLED, port: data.METRICS_PORT, path: data.METRICS_PATH },
    jobs: {
      expireSecondsOverride: data.JOBS_EXPIRE_SECONDS_OVERRIDE,
      superviseIntervalSeconds: data.JOBS_SUPERVISE_INTERVAL_SECONDS,
      pollIntervalSeconds: data.JOBS_POLL_INTERVAL_SECONDS,
    },
  };
}

/** Process-entry helper: prints every issue to stderr and exits 1 before anything binds. */
export function loadConfigOrExit(env: NodeJS.ProcessEnv = process.env): Config {
  try {
    return loadConfig(env);
  } catch (error) {
    const lines =
      error instanceof ConfigError ? error.issues : ['Invalid configuration: unexpected error'];
    process.stderr.write(`${lines.join('\n')}\n`);
    process.exit(1);
  }
}
