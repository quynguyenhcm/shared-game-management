/**
 * W3C trace context shared by the API, the job runner and the logger.
 *
 * The OpenTelemetry context is the source of truth: inside a Fastify request (`@fastify/otel`) or a
 * job span, `currentTrace()` returns the active span. An AsyncLocalStorage copy is kept as a fallback
 * so trace ids still flow through jobs and logs when the SDK is disabled (`OTEL_SDK_DISABLED=true`,
 * unit tests), where the OTel API has no context manager.
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import { randomBytes } from 'node:crypto';
import {
  context,
  isSpanContextValid,
  trace,
  TraceFlags,
  type Span,
  type SpanContext,
} from '@opentelemetry/api';

export interface TraceContext {
  readonly traceId: string;
  readonly spanId: string;
  readonly flags: string;
  /** W3C header value: `00-<traceId>-<spanId>-<flags>`. */
  readonly traceparent: string;
}

const TRACEPARENT = /^00-([0-9a-f]{32})-([0-9a-f]{16})-([0-9a-f]{2})$/;
const traceStorage = new AsyncLocalStorage<TraceContext>();

function buildTrace(traceId: string, spanId: string, flags: string): TraceContext {
  return { traceId, spanId, flags, traceparent: `00-${traceId}-${spanId}-${flags}` };
}

export function newTraceContext(): TraceContext {
  return buildTrace(randomBytes(16).toString('hex'), randomBytes(8).toString('hex'), '01');
}

/** Same trace, fresh span id. */
export function childOf(parent: TraceContext): TraceContext {
  return buildTrace(parent.traceId, randomBytes(8).toString('hex'), parent.flags);
}

export function parseTraceparent(value: unknown): TraceContext | undefined {
  if (typeof value !== 'string') return undefined;
  const match = TRACEPARENT.exec(value);
  if (!match) return undefined;
  const [, traceId, spanId, flags] = match as unknown as [string, string, string, string];
  if (/^0+$/.test(traceId) || /^0+$/.test(spanId)) return undefined;
  return buildTrace(traceId, spanId, flags);
}

export function fromSpanContext(spanContext: SpanContext): TraceContext {
  const flags = (spanContext.traceFlags & 0xff).toString(16).padStart(2, '0');
  return buildTrace(spanContext.traceId, spanContext.spanId, flags);
}

/** A remote parent span context, as if extracted from a `traceparent` header. */
export function toSpanContext(value: TraceContext): SpanContext {
  return {
    traceId: value.traceId,
    spanId: value.spanId,
    traceFlags: Number.parseInt(value.flags, 16) || TraceFlags.NONE,
    isRemote: true,
  };
}

/** The active trace: the OTel active span when there is one, else the AsyncLocalStorage fallback. */
export function currentTrace(): TraceContext | undefined {
  const spanContext = trace.getSpanContext(context.active());
  if (spanContext && isSpanContextValid(spanContext)) return fromSpanContext(spanContext);
  return traceStorage.getStore();
}

/**
 * Runs `fn` with `value` as the active trace. `span` (a real SDK span) becomes the active OTel span;
 * without one the trace ids are wrapped in a non-recording span so OTel-aware code sees them too.
 */
export function runWithTrace<T>(value: TraceContext, fn: () => T, span?: Span): T {
  const active = span ?? trace.wrapSpanContext({ ...toSpanContext(value), isRemote: false });
  return traceStorage.run(value, () => context.with(trace.setSpan(context.active(), active), fn));
}
