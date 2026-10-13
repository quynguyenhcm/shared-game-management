import { Writable } from 'node:stream';
import Fastify, { type FastifyBaseLogger } from 'fastify';
import { InMemorySpanExporter, SimpleSpanProcessor } from '@opentelemetry/sdk-trace-node';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { buildApp, registerRequestTracing } from '../../app.ts';
import { inertAppDeps } from '../../../test/helpers/app-deps.ts';
import { createJobRunner, type BossLike } from '../jobs/jobs.ts';
import { createLogger, type Logger } from '../logger/logger.ts';
import { resolveTraceExporter, startTelemetry, type Telemetry } from './telemetry.ts';

const TRACE_ID = '4bf92f3577b34da6a3ce929d0e0e4736';
const PARENT_SPAN_ID = '00f067aa0ba902b7';
const TRACEPARENT = `00-${TRACE_ID}-${PARENT_SPAN_ID}-01`;

function captureLogger(): { logger: Logger; lines: () => Record<string, unknown>[] } {
  const chunks: string[] = [];
  const stream = new Writable({
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

describe('resolveTraceExporter', () => {
  it('exports nothing by default, OTLP only with an endpoint, console on request', () => {
    expect(resolveTraceExporter({ tracesExporter: 'none', otlpEndpoint: undefined })).toBe('none');
    expect(
      resolveTraceExporter({ tracesExporter: 'otlp', otlpEndpoint: 'http://collector:4318' }),
    ).toBe('otlp');
    expect(resolveTraceExporter({ tracesExporter: 'otlp', otlpEndpoint: undefined })).toBe('none');
    expect(resolveTraceExporter({ tracesExporter: 'console', otlpEndpoint: undefined })).toBe(
      'console',
    );
  });
});

describe('startTelemetry kill switch', () => {
  it('registers nothing when OTEL_SDK_DISABLED is set', async () => {
    const telemetry = startTelemetry({
      serviceName: 'sgm-test',
      serviceVersion: 'test',
      disabled: true,
      tracesExporter: 'none',
      otlpEndpoint: undefined,
      sampler: 'parentbased_traceidratio',
      samplerArg: 1,
    });
    expect(telemetry.enabled).toBe(false);
    await telemetry.shutdown();
  });
});

describe('trace propagation (web -> API -> job)', () => {
  const exporter = new InMemorySpanExporter();
  let telemetry: Telemetry;

  beforeAll(() => {
    telemetry = startTelemetry(
      {
        serviceName: 'sgm-test',
        serviceVersion: 'test',
        disabled: false,
        tracesExporter: 'none',
        otlpEndpoint: undefined,
        sampler: 'parentbased_traceidratio',
        samplerArg: 1,
      },
      { spanProcessors: [new SimpleSpanProcessor(exporter)] },
    );
  });

  afterAll(async () => {
    await telemetry.shutdown();
  });

  it('an API request carrying traceparent logs that traceId and records a child server span', async () => {
    expect(telemetry.enabled).toBe(true);
    const { logger, lines } = captureLogger();
    const app = await buildApp(inertAppDeps(logger, { version: 't' }));
    const response = await app.inject({
      method: 'GET',
      url: '/health',
      headers: { traceparent: TRACEPARENT },
    });
    expect(response.statusCode).toBe(200);
    await app.close();

    const completed = lines().find((line) => line.message === 'request completed');
    expect(completed).toMatchObject({ traceId: TRACE_ID });
    expect(completed?.spanId).toMatch(/^[0-9a-f]{16}$/);
    expect(completed?.spanId).not.toBe(PARENT_SPAN_ID);

    const requestSpan = exporter
      .getFinishedSpans()
      .find((span) => span.spanContext().traceId === TRACE_ID && span.name === 'request');
    expect(requestSpan?.parentSpanContext?.spanId).toBe(PARENT_SPAN_ID);
  });

  it('a job enqueued inside a request carries its trace id into _meta and the worker handler logs it', async () => {
    const { logger, lines } = captureLogger();
    const sent: { data: Record<string, unknown> }[] = [];
    let workHandler:
      ((jobs: Record<string, unknown>[]) => Promise<{ id: string; status: string }[]>) | undefined;
    const boss = {
      on: vi.fn(),
      send: vi.fn((_queue: string, data: Record<string, unknown>) => {
        sent.push({ data });
        return Promise.resolve('job-1');
      }),
      work: vi.fn((_queue: string, _options: unknown, handler: typeof workHandler) => {
        workHandler = handler;
        return Promise.resolve('worker-1');
      }),
    } as unknown as BossLike;
    const producer = createJobRunner({
      databaseUrl: 'postgres://x',
      logger,
      role: 'producer',
      boss,
    });
    const worker = createJobRunner({ databaseUrl: 'postgres://x', logger, role: 'worker', boss });

    const loggerInstance: FastifyBaseLogger = logger;
    const app = Fastify({ loggerInstance });
    registerRequestTracing(app);
    app.post('/enqueue', async () => {
      await producer.enqueue('trace-queue', { n: 1 });
      return { ok: true };
    });
    await app.ready();
    const response = await app.inject({
      method: 'POST',
      url: '/enqueue',
      headers: { traceparent: TRACEPARENT },
    });
    expect(response.statusCode).toBe(200);
    await app.close();

    const meta = sent[0]?.data._meta as { traceparent: string } | undefined;
    expect(meta?.traceparent).toMatch(new RegExp(`^00-${TRACE_ID}-[0-9a-f]{16}-01$`));

    await worker.work('trace-queue', async (_data, ctx) => {
      ctx.logger.info({ event: 'handler.ran' }, 'handler ran');
      return Promise.resolve();
    });
    const results = await workHandler?.([
      {
        id: 'job-1',
        name: 'trace-queue',
        retryCount: 0,
        retryLimit: 3,
        signal: new AbortController().signal,
        data: sent[0]?.data,
      },
    ]);
    expect(results).toEqual([{ id: 'job-1', status: 'completed' }]);
    const handlerLine = lines().find((line) => line.event === 'handler.ran');
    expect(handlerLine).toMatchObject({ traceId: TRACE_ID, jobId: 'job-1' });

    const jobSpan = exporter.getFinishedSpans().find((span) => span.name === 'trace-queue process');
    expect(jobSpan?.spanContext().traceId).toBe(TRACE_ID);
  });
});
