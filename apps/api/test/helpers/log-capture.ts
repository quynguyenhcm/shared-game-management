import { Writable } from 'node:stream';
import { createLogger, type Logger } from '../../src/lib/logger/logger.ts';

export interface CapturedLogs {
  readonly logger: Logger;
  lines(): Record<string, unknown>[];
}

/** A real pino logger (same redaction and shape as production) writing into memory. */
export function captureLogs(): CapturedLogs {
  const chunks: string[] = [];
  const stream = new Writable({
    write(chunk: Buffer, _encoding, callback) {
      chunks.push(chunk.toString());
      callback();
    },
  });
  const logger = createLogger(
    {
      service: 'worker',
      version: 'test',
      environment: 'test',
      level: 'debug',
      format: 'json',
      output: 'stdout',
      redactPatterns: [],
    },
    stream,
  );
  return {
    logger,
    lines: () =>
      chunks
        .join('')
        .split('\n')
        .filter((line) => line.length > 0)
        .map((line) => JSON.parse(line) as Record<string, unknown>),
  };
}
