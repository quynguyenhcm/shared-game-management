import {
  pino,
  stdSerializers,
  transport,
  type DestinationStream,
  type Logger,
  type TransportTargetOptions,
} from 'pino';
import type { Config } from '../config/config.ts';

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
const REDACT_PATHS = ['req.headers.authorization', 'req.headers.cookie'];

/** Key patterns redacted at any depth (architecture: Observability > Logging > Redaction). */
const BASE_KEY_PATTERNS: readonly RegExp[] = [
  /^authorization$/i,
  /^cookie$/i,
  /password/i,
  /_token$/i,
  /^bank_account_/i,
  /^ird_number$/i,
  /^akahu_/i,
  /^encryptionKeys$/i,
];

const MAX_DEPTH = 8;

interface RequestLike {
  method?: string;
  url?: string;
  headers?: Record<string, unknown>;
  ip?: string;
}

/** Fastify request shape (also passes raw Node requests through); headers stay so `redact` can mask secrets. */
function serializeRequest(request: RequestLike): Record<string, unknown> {
  return {
    method: request.method,
    url: request.url,
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
  if (value === null || typeof value !== 'object' || depth > MAX_DEPTH) return value;
  if (seen.has(value)) return '[Circular]';
  if (value instanceof Error || value instanceof Date || Buffer.isBuffer(value)) return value;
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
  const settings = {
    level: options.level,
    messageKey: 'message',
    base: { service: options.service, version: options.version, environment: options.environment },
    timestamp: () => `,"timestamp":"${new Date().toISOString()}"`,
    formatters: {
      level: (label: string) => ({ level: label }),
      // `req`/`res`/`err` are class instances that their serializers flatten later; they are
      // redacted there (see `serializers`), everything else is redacted here.
      log: (object: Record<string, unknown>) => {
        const { req, res, err, ...rest } = object;
        const redacted = redactDeep(rest, patterns, 0, new WeakSet()) as Record<string, unknown>;
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
        redactDeep(serializeRequest(request), patterns, 0, new WeakSet()),
      res: stdSerializers.res,
      err: stdSerializers.err,
    },
    redact: { paths: REDACT_PATHS, censor: REDACTED },
  };
  // A transport stream (not the `transport` option) is used so the level formatter stays allowed.
  return pino(settings, destination ?? transport({ targets: buildTransportTargets(options) }));
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
