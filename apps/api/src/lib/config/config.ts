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

const port = z.coerce.number().int().min(1).max(65535);
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
  SMTP_URL: z.string().default('smtp://localhost:1025'),
  EMAIL_FROM: z.string().default('Shared Game Management <no-reply@localhost>'),
  MAILPIT_API_URL: z.string().default('http://localhost:8025'),
  API_INTERNAL_URL: z.string().default('http://localhost:4000'),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).optional(),
  LOG_FORMAT: z.enum(['json', 'text']).default('json'),
  LOG_OUTPUT: z.enum(['stdout', 'file', 'both']).default('stdout'),
  LOG_FILE_PATH: z.string().min(1).optional(),
  LOG_REDACT_PATTERNS: z.string().default('password,secret,token,apiKey'),
  OTEL_SDK_DISABLED: booleanFlag.default(false),
  OTEL_TRACES_EXPORTER: z.enum(['none', 'console', 'otlp']).default('none'),
  OTEL_EXPORTER_OTLP_ENDPOINT: z.string().min(1).optional(),
  OTEL_TRACES_SAMPLER: z.string().default('parentbased_traceidratio'),
  OTEL_TRACES_SAMPLER_ARG: z.coerce.number().min(0).max(1).default(1),
  METRICS_ENABLED: booleanFlag.default(false),
  METRICS_PORT: port.default(9090),
  METRICS_PATH: z.string().startsWith('/').default('/metrics'),
});

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
  readonly log: {
    readonly level: string;
    readonly format: 'json' | 'text';
    readonly output: 'stdout' | 'file' | 'both';
    readonly filePath: string | undefined;
    readonly redactPatterns: readonly string[];
  };
  readonly otel: {
    readonly disabled: boolean;
    readonly tracesExporter: 'none' | 'console' | 'otlp';
    readonly otlpEndpoint: string | undefined;
    readonly sampler: string;
    readonly samplerArg: number;
  };
  readonly metrics: {
    readonly enabled: boolean;
    readonly port: number;
    readonly path: string;
  };
}

const formatIssue = (variable: string, issue: string): string =>
  `Invalid configuration: ${variable} — ${issue}`;

function databaseSslIssue(databaseUrl: string): string | undefined {
  const sslmode = new URL(databaseUrl).searchParams.get('sslmode');
  return sslmode === 'require' || sslmode === 'verify-full'
    ? undefined
    : 'must include sslmode=require or sslmode=verify-full in production';
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
    if ((data.LOG_OUTPUT === 'file' || data.LOG_OUTPUT === 'both') && !data.LOG_FILE_PATH) {
      issues.push(formatIssue('LOG_FILE_PATH', 'is required when LOG_OUTPUT includes file'));
    }
  }

  if (issues.length > 0 || !data) {
    throw new ConfigError(issues);
  }

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
      tracesExporter: data.OTEL_TRACES_EXPORTER,
      otlpEndpoint: data.OTEL_EXPORTER_OTLP_ENDPOINT,
      sampler: data.OTEL_TRACES_SAMPLER,
      samplerArg: data.OTEL_TRACES_SAMPLER_ARG,
    },
    metrics: { enabled: data.METRICS_ENABLED, port: data.METRICS_PORT, path: data.METRICS_PATH },
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
