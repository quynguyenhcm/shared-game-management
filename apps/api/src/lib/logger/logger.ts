import {
  pino,
  stdSerializers,
  transport,
  type DestinationStream,
  type Logger,
  type TransportTargetOptions,
} from 'pino';
import type { Config } from '../config/config.ts';
import { currentTrace } from '../telemetry/trace-context.ts';

export type { Logger } from 'pino';

export interface LoggerOptions {
  readonly service: string;
  readonly version: string;
  readonly environment: string;
  readonly level: string;
  readonly format: 'json' | 'text';
  readonly output: 'stdout' | 'file' | 'both';
  readonly filePath?: string;
  readonly redactPatterns: readonly string[];
}

export const REDACTED = '[REDACTED]';

/** Exact-path redaction for HTTP headers (pino `redact`). */
const REDACT_PATHS = [
  'req.headers.authorization',
  'req.headers.cookie',
  'req.headers["x-sgm-client-ip"]',
  'req.headers["x-sgm-internal-auth"]',
  'req.headers["x-pending-signup"]',
  'req.headers["set-cookie"]',
];

/**
 * Query parameters masked by exact (decoded) name: OAuth `code` and `state` and the like. Exact, not a key
 * pattern, because the substring `code` would also mask `statusCode` and `providerCode`.
 */
const EXACT_QUERY_NAMES: ReadonlySet<string> = new Set([
  'code',
  'state',
  'token',
  'error_description',
  // `/login?returnTo=/teams/join?code=...` carries a team invite code through the sign-in round trip.
  'returnto',
]);

/** Key patterns redacted at any depth (architecture: Observability > Logging > Redaction). */
const BASE_KEY_PATTERNS: readonly RegExp[] = [
  /^authorization$/i,
  /^cookie$/i,
  /^set-cookie$/i,
  /^x-api-key$/i,
  /^proxy-authorization$/i,
  // The web-to-API hop: the shared secret and the (personal) client address.
  /^x-sgm-(internal-auth|client-ip)$/i,
  // OAuth pending sign-up handle: a bearer credential for POST /auth/oauth/complete.
  /^x-pending-signup$/i,
  /password/i,
  // snake_case and camelCase credentials: access_token, pendingToken, sessionToken, resetToken ...
  /token$/i,
  // The browser cookies the web owns, as keys of a logged cookie map.
  /sgm_(session|pending|oauth|flash)$/i,
  // OAuth client credentials and PKCE material.
  /client_?secret/i,
  /code_?verifier/i,
  // Team invite codes (bearer capability to ask to join): inviteCode / invite_code, exact key only.
  /^invite_?code$/i,
  /^bank_account_/i,
  // The banking API body keys (accountName / accountNumber and their snake_case and bank-prefixed spellings),
  // anchored so `accountId`, `accountNumberLast4` and the like stay readable (keys are matched globally).
  /^(bank_?)?account_?(name|number)$/i,
  /^ird_number$/i,
  /^akahu_/i,
  /^encryptionKeys$/i,
  // Connection strings: DATABASE_URL / smtpUrl / dsn / connection_string and the like.
  /(database|db|smtp|redis|amqp)_?url$/i,
  /^dsn$/i,
  /connection_?string/i,
];

/**
 * Keys redacted by exact name only, for log fields and bound request data (not for `err` objects, whose `code`
 * is a harmless SQLSTATE or Node error code). `code` is the invite lookup body key (`POST /teams/invite/lookup`);
 * a substring pattern would also mask `statusCode` and `providerCode`.
 */
const EXACT_BODY_KEY_PATTERNS: readonly RegExp[] = [/^code$/i];

/** `scheme://user:pass@host` credentials inside any string value (e.g. a URL logged under another key). */
const URL_USERINFO = /(?<![a-z0-9+.-])([a-z][a-z0-9+.-]{0,31}:\/\/)[^/\s@]{0,512}@/gi;

const MAX_DEPTH = 8;

interface RequestLike {
  method?: string;
  url?: string;
  headers?: Record<string, unknown>;
  ip?: string;
}

// Whitespace and quotes end a value so the same masking is safe on free text (error messages and stacks
// that embed a URL), not only on a bare request url.
const QUERY_PARAM = /([?&])([^=&#\s"']+)=([^&#\s"']*)/g;

/** Masks the value of every query parameter whose (decoded) name matches a redaction pattern. */
function maskQuerySecrets(
  url: string | undefined,
  patterns: readonly RegExp[],
): string | undefined {
  if (url === undefined || !url.includes('?')) return url;
  return url.replace(QUERY_PARAM, (whole, separator: string, name: string) => {
    let decoded = name;
    try {
      decoded = decodeURIComponent(name);
    } catch {
      // Keep the raw name when it is not valid percent-encoding.
    }
    return EXACT_QUERY_NAMES.has(decoded.toLowerCase()) ||
      patterns.some((pattern) => pattern.test(decoded))
      ? `${separator}${name}=${REDACTED}`
      : whole;
  });
}

function maskQueryText(text: string, patterns: readonly RegExp[]): string {
  return maskQuerySecrets(text, patterns) ?? text;
}

/** Fastify request shape (also passes raw Node requests through); headers stay so `redact` can mask secrets. */
function serializeRequest(
  request: RequestLike,
  patterns: readonly RegExp[],
): Record<string, unknown> {
  return {
    method: request.method,
    url: maskQuerySecrets(request.url, patterns),
    headers: request.headers,
    remoteAddress: request.ip,
  };
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function redactDeep(
  value: unknown,
  patterns: readonly RegExp[],
  depth: number,
  seen: WeakSet<object>,
): unknown {
  if (typeof value === 'string') {
    // Credentials in URL userinfo and secret query parameters of any URL inside a string (error messages,
    // stacks and `cause` chains of a failed OAuth token exchange).
    return maskQueryText(value.replace(URL_USERINFO, `$1${REDACTED}@`), patterns);
  }
  if (value === null || typeof value !== 'object' || depth > MAX_DEPTH) return value;
  // Raw bytes are almost always key material or ciphertext; never log them.
  if (ArrayBuffer.isView(value) || value instanceof ArrayBuffer) return REDACTED;
  if (seen.has(value)) return '[Circular]';
  if (value instanceof Error || value instanceof Date) return value;
  seen.add(value);
  if (Array.isArray(value)) {
    return value.map((item) => redactDeep(item, patterns, depth + 1, seen));
  }
  const result: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value)) {
    result[key] = patterns.some((pattern) => pattern.test(key))
      ? REDACTED
      : redactDeep(child, patterns, depth + 1, seen);
  }
  return result;
}

/**
 * Transport targets for the configured format/output. `text` uses pino-pretty (dev only, loaded lazily
 * by the transport worker); `json` writes one JSON object per line.
 */
export function buildTransportTargets(
  options: Pick<LoggerOptions, 'format' | 'output' | 'filePath'>,
): TransportTargetOptions[] {
  const targets: TransportTargetOptions[] = [];
  if (options.output === 'stdout' || options.output === 'both') {
    targets.push(
      options.format === 'text'
        ? {
            target: 'pino-pretty',
            level: 'trace',
            options: { messageKey: 'message', timestampKey: 'timestamp', colorize: true },
          }
        : { target: 'pino/file', level: 'trace', options: { destination: 1 } },
    );
  }
  if (options.output === 'file' || options.output === 'both') {
    if (!options.filePath) {
      throw new Error('LOG_FILE_PATH is required when LOG_OUTPUT includes file');
    }
    targets.push({
      target: 'pino/file',
      level: 'trace',
      options: { destination: options.filePath, mkdir: true },
    });
  }
  return targets;
}

/**
 * Creates the shared pino logger. `destination` is a test seam; when omitted, output goes through
 * the transports selected by LOG_FORMAT / LOG_OUTPUT.
 */
export function createLogger(options: LoggerOptions, destination?: DestinationStream): Logger {
  const patterns = [
    ...BASE_KEY_PATTERNS,
    ...options.redactPatterns.map((pattern) => new RegExp(escapeRegExp(pattern), 'i')),
  ];
  // Everything except `err` also masks the exact body key `code`.
  const fieldPatterns = [...patterns, ...EXACT_BODY_KEY_PATTERNS];
  const settings = {
    level: options.level,
    messageKey: 'message',
    base: { service: options.service, version: options.version, environment: options.environment },
    timestamp: () => `,"timestamp":"${new Date().toISOString()}"`,
    // Every line logged inside a request or job carries its trace ids, unless a child logger already
    // bound them (withTraceContext, the Fastify request logger).
    mixin: (_object: object, _level: number, instance: Logger) => {
      const active = currentTrace();
      if (!active || 'traceId' in instance.bindings()) return {};
      return { traceId: active.traceId, spanId: active.spanId };
    },
    formatters: {
      level: (label: string) => ({ level: label }),
      // `req`/`res`/`err` are class instances that their serializers flatten later; they are
      // redacted there (see `serializers`), everything else is redacted here.
      log: (object: Record<string, unknown>) => {
        const { req, res, err, ...rest } = object;
        const redacted = redactDeep(rest, fieldPatterns, 0, new WeakSet()) as Record<
          string,
          unknown
        >;
        return {
          ...redacted,
          ...(req === undefined ? {} : { req }),
          ...(res === undefined ? {} : { res }),
          ...(err === undefined ? {} : { err }),
        };
      },
    },
    serializers: {
      req: (request: RequestLike) =>
        redactDeep(serializeRequest(request, patterns), fieldPatterns, 0, new WeakSet()),
      res: (response: Parameters<typeof stdSerializers.res>[0]) =>
        redactDeep(stdSerializers.res(response), fieldPatterns, 0, new WeakSet()),
      err: (error: Parameters<typeof stdSerializers.err>[0]) =>
        redactDeep(stdSerializers.err(error), patterns, 0, new WeakSet()),
    },
    redact: { paths: REDACT_PATHS, censor: REDACTED },
  };
  // A transport stream (not the `transport` option) is used so the level formatter stays allowed.
  const logger = pino(
    settings,
    destination ?? transport({ targets: buildTransportTargets(options) }),
  );
  // pino resets the `bindings` formatter for children, so redact child bindings by wrapping `child`.
  // Children are created with Object.create(parent), so grandchildren inherit this override.
  // eslint-disable-next-line @typescript-eslint/unbound-method -- re-bound via `.call(this, ...)` below
  const originalChild = logger.child;
  logger.child = function child(
    this: Logger,
    bindings: Record<string, unknown>,
    childOptions?: Parameters<Logger['child']>[1],
  ) {
    const redacted = redactDeep(bindings, fieldPatterns, 0, new WeakSet()) as Record<
      string,
      unknown
    >;
    return originalChild.call(this, redacted, childOptions);
  } as Logger['child'];
  return logger;
}

export function loggerOptionsFromConfig(config: Config, service: 'api' | 'worker'): LoggerOptions {
  return {
    service,
    version: config.serviceVersion,
    environment: config.nodeEnv,
    level: config.log.level,
    format: config.log.format,
    output: config.log.output,
    ...(config.log.filePath === undefined ? {} : { filePath: config.log.filePath }),
    redactPatterns: config.log.redactPatterns,
  };
}

export function child(logger: Logger, bindings: Record<string, unknown>): Logger {
  return logger.child(bindings);
}

export function withTraceContext(
  logger: Logger,
  context: { traceId: string; spanId: string },
): Logger {
  return logger.child({ traceId: context.traceId, spanId: context.spanId });
}
