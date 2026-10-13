/**
 * OpenTelemetry tracing for the api and worker processes (architecture: Observability > Tracing).
 *
 * - Tracer provider: `@opentelemetry/sdk-trace-node` with the AsyncLocalStorage context manager and
 *   the W3C TraceContext propagator (`traceparent` / `tracestate`).
 * - Instrumentation: `@fastify/otel` only (request + handler spans; it honours an incoming
 *   `traceparent`). pg and http client instrumentation need ESM loader hooks and are not wired.
 * - Exporter: none by default, so spans are created (trace ids reach logs and job payloads) but never
 *   leave the process. `console` on request; OTLP/HTTP only when `OTEL_EXPORTER_OTLP_ENDPOINT` is set.
 * - `OTEL_SDK_DISABLED=true` registers nothing (trace ids then come from the jobs fallback only).
 */
import { propagation, trace, context, type TextMapPropagator } from '@opentelemetry/api';
import { W3CTraceContextPropagator } from '@opentelemetry/core';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { resourceFromAttributes } from '@opentelemetry/resources';
import {
  AlwaysOffSampler,
  AlwaysOnSampler,
  BatchSpanProcessor,
  ConsoleSpanExporter,
  NodeTracerProvider,
  ParentBasedSampler,
  SimpleSpanProcessor,
  TraceIdRatioBasedSampler,
  type Sampler,
  type SpanProcessor,
} from '@opentelemetry/sdk-trace-node';
import { ATTR_SERVICE_NAME, ATTR_SERVICE_VERSION } from '@opentelemetry/semantic-conventions';
import { FastifyOtelInstrumentation } from '@fastify/otel';
import type { Config } from '../config/config.ts';

export interface TelemetryOptions {
  readonly serviceName: string;
  readonly serviceVersion: string;
  readonly disabled: boolean;
  readonly tracesExporter: Config['otel']['tracesExporter'];
  readonly otlpEndpoint: string | undefined;
  readonly sampler: Config['otel']['sampler'];
  readonly samplerArg: number;
}

export interface TelemetryDependencies {
  /** Test seam: extra span processors (e.g. an in-memory exporter). */
  readonly spanProcessors?: readonly SpanProcessor[];
}

export interface Telemetry {
  readonly enabled: boolean;
  /** Flushes pending spans and unregisters the global provider, propagator and context manager. */
  shutdown(): Promise<void>;
}

/** `otlp` only ever runs with an endpoint; anything else falls back to no exporter. */
export function resolveTraceExporter(
  options: Pick<TelemetryOptions, 'tracesExporter' | 'otlpEndpoint'>,
): 'none' | 'console' | 'otlp' {
  if (options.tracesExporter === 'otlp') return options.otlpEndpoint ? 'otlp' : 'none';
  return options.tracesExporter;
}

function buildSampler(name: TelemetryOptions['sampler'], ratio: number): Sampler {
  switch (name) {
    case 'always_on':
      return new AlwaysOnSampler();
    case 'always_off':
      return new AlwaysOffSampler();
    case 'traceidratio':
      return new TraceIdRatioBasedSampler(ratio);
    case 'parentbased_always_on':
      return new ParentBasedSampler({ root: new AlwaysOnSampler() });
    case 'parentbased_always_off':
      return new ParentBasedSampler({ root: new AlwaysOffSampler() });
    case 'parentbased_traceidratio':
      return new ParentBasedSampler({ root: new TraceIdRatioBasedSampler(ratio) });
  }
}

function exporterProcessors(options: TelemetryOptions): SpanProcessor[] {
  switch (resolveTraceExporter(options)) {
    case 'console':
      return [new SimpleSpanProcessor(new ConsoleSpanExporter())];
    case 'otlp':
      // The OTLP/HTTP exporter appends `/v1/traces` to the base endpoint, per the OTel spec.
      return [
        new BatchSpanProcessor(
          new OTLPTraceExporter({
            url: `${String(options.otlpEndpoint).replace(/\/+$/, '')}/v1/traces`,
          }),
        ),
      ];
    case 'none':
      return [];
  }
}

const DISABLED: Telemetry = { enabled: false, shutdown: () => Promise.resolve() };

export function startTelemetry(
  options: TelemetryOptions,
  dependencies: TelemetryDependencies = {},
): Telemetry {
  if (options.disabled) return DISABLED;

  const provider = new NodeTracerProvider({
    resource: resourceFromAttributes({
      [ATTR_SERVICE_NAME]: options.serviceName,
      [ATTR_SERVICE_VERSION]: options.serviceVersion,
    }),
    sampler: buildSampler(options.sampler, options.samplerArg),
    spanProcessors: [...exporterProcessors(options), ...(dependencies.spanProcessors ?? [])],
  });
  const propagator: TextMapPropagator = new W3CTraceContextPropagator();
  provider.register({ propagator });

  // Hooks into `fastify.initialization`, so it only has to be enabled before `Fastify()` runs.
  // Lifecycle-hook spans are off: request + handler spans are enough and keep the active span stable.
  const fastifyInstrumentation = new FastifyOtelInstrumentation({
    registerOnInitialization: true,
    instrumentHooks: false,
  });
  fastifyInstrumentation.setTracerProvider(provider);
  fastifyInstrumentation.enable();

  return {
    enabled: true,
    async shutdown() {
      fastifyInstrumentation.disable();
      await provider.shutdown();
      trace.disable();
      propagation.disable();
      context.disable();
    },
  };
}

/** Maps validated config to telemetry options; the service name defaults per process. */
export function telemetryOptionsFromConfig(
  config: Pick<Config, 'otel' | 'serviceVersion'>,
  defaultServiceName: string,
): TelemetryOptions {
  return {
    serviceName: config.otel.serviceName ?? defaultServiceName,
    serviceVersion: config.serviceVersion,
    disabled: config.otel.disabled,
    tracesExporter: config.otel.tracesExporter,
    otlpEndpoint: config.otel.otlpEndpoint,
    sampler: config.otel.sampler,
    samplerArg: config.otel.samplerArg,
  };
}
