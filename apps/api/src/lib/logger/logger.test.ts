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

  it('redacts child-logger bindings, connection strings, URL userinfo, extra headers and Buffers', () => {
    const sink = capture();
    const logger = createLogger(baseOptions, sink.stream);
    logger
      .child({
        databaseUrl: 'postgres://sgm:dbpass-123@db:5432/sgm',
        smtpUrl: 'smtp://mailer:smtppass-456@mail:1025',
        apiKey: 'binding-api-key',
        tenant: 'acme',
      })
      .info(
        {
          target: 'postgres://user:inline-pass-789@host/db',
          harmless: 'http://localhost:4000/health',
          headers: {
            'set-cookie': 'sid=setcookie-value',
            'x-api-key': 'xkey-value',
            'proxy-authorization': 'Basic proxy-value',
          },
          rawKey: Buffer.from('buffer-secret-bytes'),
          typed: new Uint8Array([1, 2, 3]),
        },
        'binding redaction',
      );
    const [line] = sink.lines();
    const serialised = JSON.stringify(line);
    for (const secret of [
      'dbpass-123',
      'smtppass-456',
      'binding-api-key',
      'inline-pass-789',
      'setcookie-value',
      'xkey-value',
      'proxy-value',
      'buffer-secret-bytes',
    ]) {
      expect(serialised).not.toContain(secret);
    }
    expect(line).toMatchObject({
      tenant: 'acme',
      harmless: 'http://localhost:4000/health',
      target: 'postgres://[REDACTED]@host/db',
      rawKey: '[REDACTED]',
      typed: '[REDACTED]',
    });
  });

  it('redacts quickly on adversarial 20 KB header values and scrubs credentials inside errors', () => {
    const sink = capture();
    const logger = createLogger(baseOptions, sink.stream);
    const hostile = 'a.'.repeat(10_000);
    const startedAt = Date.now();
    logger.info({ req: { method: 'GET', url: '/', headers: { 'user-agent': hostile } } }, 'ua');
    expect(Date.now() - startedAt).toBeLessThan(200);
    logger.error({ err: new Error('connect failed postgres://u:err-pass-1@h/db') }, 'boom');
    const lines = sink.lines();
    expect(JSON.stringify(lines[1])).not.toContain('err-pass-1');
  });
});

describe('request url query-string masking', () => {
  it('masks secret query parameters in logged req.url and keeps the rest', () => {
    const sink = capture();
    const logger = createLogger(baseOptions, sink.stream);
    logger.info(
      {
        req: {
          method: 'GET',
          url: '/reset?token=abc123&page=2&apiKey=k-9&password=hunter2',
          headers: {},
        },
      },
      'request',
    );
    const url = (sink.lines()[0]?.req as { url: string }).url;
    expect(url).toBe('/reset?token=[REDACTED]&page=2&apiKey=[REDACTED]&password=[REDACTED]');
    expect(url).not.toContain('abc123');
    expect(url).not.toContain('hunter2');
  });

  it('leaves urls without a query string, or with an unparseable one, untouched', () => {
    const sink = capture();
    const logger = createLogger(baseOptions, sink.stream);
    logger.info({ req: { method: 'GET', url: '/health', headers: {} } }, 'plain');
    logger.info({ req: { method: 'GET', url: '/x?a=1', headers: {} } }, 'harmless');
    const [plain, harmless] = sink.lines();
    expect((plain?.req as { url: string }).url).toBe('/health');
    expect((harmless?.req as { url: string }).url).toBe('/x?a=1');
  });
});

describe('auth log hygiene (AC-VERIFY-6)', () => {
  it('masks the exact OAuth query parameters code, state, token and error_description, but not look-alikes', () => {
    const sink = capture();
    const logger = createLogger({ ...baseOptions, redactPatterns: [] }, sink.stream);
    logger.info(
      {
        req: {
          method: 'GET',
          url: '/auth/callback/google?code=4%2F0AbCd&state=st-123&error_description=denied&statusCode=7&providerCode=9',
          headers: {},
        },
      },
      'request',
    );
    const url = (sink.lines()[0]?.req as { url: string }).url;
    expect(url).toBe(
      '/auth/callback/google?code=[REDACTED]&state=[REDACTED]&error_description=[REDACTED]&statusCode=7&providerCode=9',
    );
  });

  it('redacts the internal-hop headers and set-cookie in logged requests', () => {
    const sink = capture();
    const logger = createLogger({ ...baseOptions, redactPatterns: [] }, sink.stream);
    logger.info(
      {
        req: {
          method: 'POST',
          url: '/auth/login',
          headers: {
            'x-sgm-internal-auth': 'internal-secret-value',
            'x-sgm-client-ip': '203.0.113.7',
            'set-cookie': 'sid=cookie-secret',
            'x-pending-signup': 'pending-handle-secret',
            accept: 'application/json',
          },
        },
      },
      'request',
    );
    const serialised = JSON.stringify(sink.lines()[0]);
    for (const secret of [
      'internal-secret-value',
      '203.0.113.7',
      'cookie-secret',
      'pending-handle-secret',
    ]) {
      expect(serialised).not.toContain(secret);
    }
    expect(serialised).toContain('application/json');
  });
});
