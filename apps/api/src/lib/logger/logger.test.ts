import { Writable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { buildTransportTargets, createLogger, withTraceContext } from './logger.ts';

function capture(): { stream: Writable; lines: () => Record<string, unknown>[] } {
  const chunks: string[] = [];
  const stream = new Writable({
    write(chunk: Buffer, _encoding, callback) {
      chunks.push(chunk.toString());
      callback();
    },
  });
  return {
    stream,
    lines: () =>
      chunks
        .join('')
        .split('\n')
        .filter((line) => line.length > 0)
        .map((line) => JSON.parse(line) as Record<string, unknown>),
  };
}

const baseOptions = {
  service: 'api',
  version: '1.2.3',
  environment: 'test',
  level: 'info',
  format: 'json',
  output: 'stdout',
  redactPatterns: ['password', 'secret', 'token', 'apiKey'],
} as const;

describe('logger', () => {
  it('emits camelCase JSON with ISO timestamp, level label, message and trace fields', () => {
    const sink = capture();
    const logger = createLogger(baseOptions, sink.stream);
    const traced = withTraceContext(logger, { traceId: 'a'.repeat(32), spanId: 'b'.repeat(16) });
    traced.child({ requestId: 'req-1' }).info('hello');
    const [line] = sink.lines();
    expect(line).toMatchObject({
      level: 'info',
      message: 'hello',
      service: 'api',
      version: '1.2.3',
      environment: 'test',
      traceId: 'a'.repeat(32),
      spanId: 'b'.repeat(16),
      requestId: 'req-1',
    });
    expect(new Date(String(line?.timestamp)).toISOString()).toBe(line?.timestamp);
    expect(line).not.toHaveProperty('msg');
    expect(line).not.toHaveProperty('trace_id');
    expect(line).not.toHaveProperty('pid');
  });

  it('redacts sensitive keys with [REDACTED] and leaves other fields intact', () => {
    const sink = capture();
    const logger = createLogger(baseOptions, sink.stream);
    logger.info(
      {
        req: { headers: { authorization: 'Bearer abc', cookie: 'sid=1', accept: 'json' } },
        user: { password: 'hunter2', passwordHash: 'x', name: 'Ada' },
        team: {
          bank_account_number: '12-3456-7890123-00',
          ird_number: '123456789',
          akahu_app_token: 't',
        },
        encryptionKeys: 'dev1:secret',
        integration: { apiKey: 'k', userToken: 'tok-value-xyz' },
        note: 'plain',
      },
      'redaction check',
    );
    const [line] = sink.lines();
    const serialised = JSON.stringify(line);
    for (const secret of [
      'Bearer abc',
      'sid=1',
      'hunter2',
      '12-3456',
      '123456789',
      'dev1:secret',
      'tok-value-xyz',
    ]) {
      expect(serialised).not.toContain(secret);
    }
    expect(serialised).toContain('[REDACTED]');
    expect(line).toMatchObject({ note: 'plain', user: { name: 'Ada' } });
    expect((line?.req as { headers: { accept: string } }).headers.accept).toBe('json');
  });

  it('applies level and selects transport targets from format/output config', () => {
    const sink = capture();
    const logger = createLogger({ ...baseOptions, level: 'warn' }, sink.stream);
    logger.info('dropped');
    logger.warn('kept');
    expect(sink.lines().map((line) => line.message)).toEqual(['kept']);

    const json = buildTransportTargets(baseOptions);
    expect(json.map((target) => target.target)).toEqual(['pino/file']);
    const text = buildTransportTargets({ ...baseOptions, format: 'text' });
    expect(text.map((target) => target.target)).toEqual(['pino-pretty']);
    const both = buildTransportTargets({
      ...baseOptions,
      output: 'both',
      filePath: '/tmp/sgm.log',
    });
    expect(both.map((target) => target.target)).toEqual(['pino/file', 'pino/file']);
    expect(() => buildTransportTargets({ ...baseOptions, output: 'file' })).toThrow(
      /LOG_FILE_PATH/,
    );
  });
});
