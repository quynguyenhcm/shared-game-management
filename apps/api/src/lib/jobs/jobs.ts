/**
 * Job runner: a thin wrapper over pg-boss (architecture Q4). Domain code never imports pg-boss.
 *
 * DELIVERY GUARANTEE: AT-LEAST-ONCE.
 *   - A job may run more than once: a worker killed mid-job, a job that outlives its
 *     `expireInSeconds`, or a replay enqueued after completion all reach the handler again.
 *   - `singletonKey` suppresses only CONCURRENT duplicates (the queue must use the `exclusive`
 *     policy so a queued or active job with the same key blocks the newcomer). A duplicate
 *     enqueued after the first job completed runs again.
 *   - Therefore EVERY handler must be idempotent through a durable guard of its own: a database
 *     unique constraint or a guarded status transition
 *     (`UPDATE ... SET status = 'X' WHERE status = 'Y' RETURNING`), never `singletonKey` alone.
 *
 * Roles: the `producer` (api process) only enqueues; the `worker` also supervises expired jobs,
 * runs the cron scheduler and works queues. Neither role runs DDL: `db:migrate` owns the
 * `pgboss` schema, so pg-boss starts with `migrate: false, createSchema: false`.
 *
 * Trace context travels in the job payload under the reserved `_meta` key (W3C `traceparent`, taken
 * from the active OTel span, e.g. the API request). The worker restores it as the parent of a
 * `"{queue} process"` consumer span around the handler, so logs and follow-up enqueues share the
 * originating trace.
 */
import { ROOT_CONTEXT, SpanKind, SpanStatusCode, trace as otelTrace } from '@opentelemetry/api';
import { CompiledQuery, type Kysely } from 'kysely';
import {
  PgBoss,
  type ConstructorOptions,
  type Db,
  type JobResult,
  type JobWithMetadata,
  type Queue,
  type QueuePolicy,
  type SendOptions,
  type UpdateQueueOptions,
} from 'pg-boss';
import type { Logger } from '../logger/logger.ts';
import {
  childOf,
  currentTrace,
  fromSpanContext,
  newTraceContext,
  parseTraceparent,
  runWithTrace,
  toSpanContext,
  type TraceContext,
} from '../telemetry/trace-context.ts';

/** Completed jobs are kept at least this long so failures stay debuggable. */
export const MIN_RETENTION_DAYS = 7;
const SECONDS_PER_DAY = 24 * 60 * 60;
const STOP_TIMEOUT_MS = 10_000;
const TRACER_NAME = '@sgm/api/jobs';

export type JobRole = 'producer' | 'worker';

/** One queue, declared once in `src/jobs/registry.ts`. */
export interface QueueDefinition {
  readonly name: string;
  /** `exclusive` makes `singletonKey` suppress queued/active duplicates; see the header comment. */
  readonly policy: QueuePolicy;
  readonly retryLimit: number;
  /** Seconds; with `retryBackoff` this is the base of an exponential delay. */
  readonly retryDelay: number;
  readonly retryBackoff: boolean;
  /** Seconds a job may stay active before it is considered lost and retried or failed. */
  readonly expireInSeconds: number;
  readonly retentionDays: number;
}

// ---------------------------------------------------------------------------------------------
// Trace context
// ---------------------------------------------------------------------------------------------

export {
  currentTrace,
  newTraceContext,
  parseTraceparent,
  runWithTrace,
  type TraceContext,
} from '../telemetry/trace-context.ts';

/** Adds `_meta.traceparent` (ambient trace, else a new root trace) to a job payload. */
export function injectTraceMeta<T extends object>(
  data: T,
  trace: TraceContext = currentTrace() ?? newTraceContext(),
): T & { _meta: { traceparent: string } } {
  return { ...data, _meta: { traceparent: trace.traceparent } };
}

/** Splits `_meta` off a payload; the handler only ever sees the clean data. */
export function extractTraceMeta<T extends object>(
  payload: T,
): { data: Omit<T, '_meta'>; trace: TraceContext | undefined } {
  const { _meta: meta, ...data } = payload as T & { _meta?: unknown };
  const traceparent =
    typeof meta === 'object' && meta !== null
      ? (meta as { traceparent?: unknown }).traceparent
      : undefined;
  return { data: data, trace: parseTraceparent(traceparent) };
}

// ---------------------------------------------------------------------------------------------
// Option mapping
// ---------------------------------------------------------------------------------------------

export function toQueueOptions(definition: QueueDefinition): Omit<Queue, 'name'> {
  if (definition.retentionDays < MIN_RETENTION_DAYS) {
    throw new Error(
      `queue ${definition.name}: retention must be at least ${MIN_RETENTION_DAYS} days`,
    );
  }
  return {
    policy: definition.policy,
    retryLimit: definition.retryLimit,
    retryDelay: definition.retryDelay,
    retryBackoff: definition.retryBackoff,
    expireInSeconds: definition.expireInSeconds,
    deleteAfterSeconds: definition.retentionDays * SECONDS_PER_DAY,
  };
}

export interface BossSettings {
  readonly databaseUrl: string;
  readonly role: JobRole;
  readonly poolMax?: number;
  readonly superviseIntervalSeconds?: number;
}

export function toBossOptions(settings: BossSettings): ConstructorOptions {
  const isWorker = settings.role === 'worker';
  return {
    connectionString: settings.databaseUrl,
    application_name: `sgm-${settings.role}`,
    max: settings.poolMax ?? (isWorker ? 6 : 3),
    options: '-c TimeZone=UTC',
    // No DDL from application processes: `db:migrate` installs and upgrades the pgboss schema.
    migrate: false,
    createSchema: false,
    supervise: isWorker,
    schedule: isWorker,
    // Expired active jobs (a killed worker's) are reclaimed by the supervise pass, but only for
    // queues whose monitor claim is older than monitorIntervalSeconds: tune both together.
    ...(settings.superviseIntervalSeconds === undefined
      ? {}
      : {
          superviseIntervalSeconds: settings.superviseIntervalSeconds,
          monitorIntervalSeconds: settings.superviseIntervalSeconds,
        }),
  };
}

/** A Kysely transaction (or instance): enough surface for pg-boss to run its INSERT inside it. */
export type TransactionLike = Pick<Kysely<never>, 'executeQuery'>;

export interface EnqueueOptions {
  /** Enqueue inside this transaction: the job exists only if the transaction commits. */
  readonly trx?: TransactionLike;
  /** Suppresses concurrent duplicates on `exclusive` queues (see the header comment). */
  readonly singletonKey?: string;
  /** A Date, or a number of seconds from now on the database clock (immune to host clock skew). */
  readonly startAfter?: Date | number | string;
}

function adaptTransaction(trx: TransactionLike): Db {
  return {
    async executeSql(text, values) {
      const result = await trx.executeQuery(CompiledQuery.raw(text, [...(values ?? [])]));
      return { rows: [...result.rows] };
    },
  };
}

export function toSendOptions(options: EnqueueOptions): SendOptions {
  return {
    ...(options.singletonKey === undefined ? {} : { singletonKey: options.singletonKey }),
    ...(options.startAfter === undefined ? {} : { startAfter: options.startAfter }),
    ...(options.trx === undefined ? {} : { db: adaptTransaction(options.trx) }),
  };
}

// ---------------------------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------------------------

/** Thrown by a handler to fail the job at once, without spending its remaining retries. */
export class NonRetryableJobError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'NonRetryableJobError';
  }
}

export interface JobContext {
  /** Child logger bound to jobId, queue and the job's trace. */
  readonly logger: Logger;
  readonly jobId: string;
  readonly queue: string;
  /** 0 on the first attempt. */
  readonly retryCount: number;
  readonly retryLimit: number;
  readonly trace: TraceContext;
  readonly signal: AbortSignal;
}

export type JobHandler<T extends object = Record<string, unknown>> = (
  data: T,
  context: JobContext,
) => Promise<void>;

export interface WorkOptions {
  readonly localConcurrency?: number;
}

// ---------------------------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------------------------

/** The slice of pg-boss the runner uses (also the unit-test seam). */
export type BossLike = Pick<
  PgBoss,
  | 'on'
  | 'start'
  | 'stop'
  | 'createQueue'
  | 'updateQueue'
  | 'send'
  | 'work'
  | 'schedule'
  | 'getSchedules'
  | 'getJobById'
  | 'previewSchedule'
>;

export interface JobRunnerOptions {
  readonly databaseUrl: string;
  readonly logger: Logger;
  readonly role: JobRole;
  readonly poolMax?: number;
  /** Worker only: how often expired active jobs are reclaimed (bounds crash recovery). */
  readonly superviseIntervalSeconds?: number;
  readonly pollingIntervalSeconds?: number;
  /** Test seam. */
  readonly boss?: BossLike;
}

export interface ScheduleInfo {
  readonly name: string;
  readonly key: string;
  readonly cron: string;
  readonly tz: string;
  readonly lastJobId: string | null;
}

export interface JobInfo {
  readonly id: string;
  readonly queue: string;
  readonly state: JobWithMetadata<object>['state'];
  readonly retryCount: number;
  readonly retryLimit: number;
  readonly output: unknown;
  readonly data: object;
  readonly singletonKey: string | null;
  readonly createdOn: Date;
  readonly startedOn: Date | null;
  readonly completedOn: Date | null;
}

export interface PreviewOptions {
  readonly tz?: string;
  readonly from?: Date;
  readonly count?: number;
}

export interface JobRunner {
  readonly role: JobRole;
  start(): Promise<void>;
  /** Graceful: waits (bounded) for running handlers, then closes the pool. */
  stop(): Promise<void>;
  /** Worker: creates the queue idempotently and converges its options. Producer: validates only. */
  defineQueue(definition: QueueDefinition): Promise<void>;
  /** Resolves to the job id, or `null` when a queued/active job with the same singletonKey exists. */
  enqueue<T extends object>(
    queue: string,
    data: T,
    options?: EnqueueOptions,
  ): Promise<string | null>;
  /** Worker only. The slot name is also the name of the queue its jobs land in. */
  schedule(slot: string, cron: string, data: object, options: { tz: string }): Promise<void>;
  /** Worker only. */
  work<T extends object = Record<string, unknown>>(
    queue: string,
    handler: JobHandler<T>,
    options?: WorkOptions,
  ): Promise<void>;
  /** Manual invocation of a queue's handler (`cli jobs trigger`, AC-ASYNC-2). */
  trigger(queue: string, data?: object): Promise<string | null>;
  listSchedules(): Promise<ScheduleInfo[]>;
  getJob(queue: string, id: string): Promise<JobInfo | null>;
  /** Next occurrences of a cron expression, evaluated by the same library the scheduler uses. */
  previewSchedule(cron: string, options?: PreviewOptions): Date[];
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function createJobRunner(options: JobRunnerOptions): JobRunner {
  const { logger, role } = options;
  const boss: BossLike =
    options.boss ??
    new PgBoss(
      toBossOptions({
        databaseUrl: options.databaseUrl,
        role,
        ...(options.poolMax === undefined ? {} : { poolMax: options.poolMax }),
        ...(options.superviseIntervalSeconds === undefined
          ? {}
          : { superviseIntervalSeconds: options.superviseIntervalSeconds }),
      }),
    );
  // pg-boss is an EventEmitter: an unhandled 'error' event would crash the process.
  boss.on('error', (error) => {
    logger.error({ event: 'jobs.runner.error', err: error }, 'pg-boss error');
  });

  const requireWorker = (operation: string): void => {
    if (role !== 'worker') throw new Error(`${operation} requires the worker role`);
  };

  async function enqueue<T extends object>(
    queue: string,
    data: T,
    enqueueOptions: EnqueueOptions = {},
  ): Promise<string | null> {
    const id = await boss.send(queue, injectTraceMeta(data), toSendOptions(enqueueOptions));
    logger.info(
      {
        event: 'job.enqueued',
        jobId: id,
        queue,
        singletonKey: enqueueOptions.singletonKey,
        deduplicated: id === null,
      },
      'job.enqueued',
    );
    return id;
  }

  /** A consumer span under the payload's trace; ids fall back to `childOf` when the SDK is off. */
  function startJobSpan(queue: string, jobId: string, parent: TraceContext | undefined) {
    const parentContext = parent
      ? otelTrace.setSpanContext(ROOT_CONTEXT, toSpanContext(parent))
      : ROOT_CONTEXT;
    const span = otelTrace.getTracer(TRACER_NAME).startSpan(
      `${queue} process`,
      {
        kind: SpanKind.CONSUMER,
        attributes: {
          'messaging.system': 'pg-boss',
          'messaging.operation.type': 'process',
          'messaging.destination.name': queue,
          'messaging.message.id': jobId,
        },
      },
      parentContext,
    );
    const spanContext = span.spanContext();
    // The no-op tracer (SDK disabled) hands back the parent's own ids; only a new span id is real.
    const isNewSpan =
      otelTrace.isSpanContextValid(spanContext) && spanContext.spanId !== parent?.spanId;
    const traceContext = isNewSpan
      ? fromSpanContext(spanContext)
      : parent
        ? childOf(parent)
        : newTraceContext();
    return { span: isNewSpan ? span : undefined, trace: traceContext };
  }

  function wrap<T extends object>(queue: string, handler: JobHandler<T>) {
    return async (jobs: JobWithMetadata<object>[]): Promise<JobResult[]> => {
      const results: JobResult[] = [];
      for (const job of jobs) {
        const { data, trace: parent } = extractTraceMeta(job.data);
        const { span, trace } = startJobSpan(queue, job.id, parent);
        // traceId/spanId come from the active trace via the logger mixin.
        const jobLogger = logger.child({ jobId: job.id, queue });
        const attempt = job.retryCount + 1;
        const startedAt = performance.now();
        const result = await runWithTrace(
          trace,
          async (): Promise<JobResult> => {
            jobLogger.info({ event: 'job.started', attempt }, 'job.started');
            try {
              await handler(data as T, {
                logger: jobLogger,
                jobId: job.id,
                queue,
                retryCount: job.retryCount,
                retryLimit: job.retryLimit,
                trace,
                signal: job.signal,
              });
              jobLogger.info(
                {
                  event: 'job.completed',
                  attempt,
                  durationMs: Math.round(performance.now() - startedAt),
                },
                'job.completed',
              );
              return { id: job.id, status: 'completed' };
            } catch (error) {
              const nonRetryable = error instanceof NonRetryableJobError;
              const willRetry = !nonRetryable && job.retryCount < job.retryLimit;
              span?.recordException(error instanceof Error ? error : String(error));
              span?.setStatus({ code: SpanStatusCode.ERROR, message: errorMessage(error) });
              jobLogger[willRetry ? 'warn' : 'error'](
                {
                  event: 'job.failed',
                  attempt,
                  retryLimit: job.retryLimit,
                  willRetry,
                  durationMs: Math.round(performance.now() - startedAt),
                  err: error,
                },
                'job.failed',
              );
              return {
                id: job.id,
                // `deadletter` ends the job terminally without retries (no dead-letter queue configured).
                status: nonRetryable ? 'deadletter' : 'failed',
                output: {
                  message: errorMessage(error),
                  name: error instanceof Error ? error.name : 'Error',
                  attempt,
                },
              };
            } finally {
              span?.end();
            }
          },
          span,
        );
        results.push(result);
      }
      return results;
    };
  }

  return {
    role,
    async start() {
      await boss.start();
    },
    async stop() {
      await boss.stop({ graceful: true, timeout: STOP_TIMEOUT_MS });
    },
    async defineQueue(definition) {
      const queueOptions = toQueueOptions(definition);
      if (role !== 'worker') return;
      await boss.createQueue(definition.name, queueOptions);
      // createQueue keeps an existing queue as is; converge retry/expiry/retention on redeploys
      // (the policy of an existing queue cannot change).
      const updatable: UpdateQueueOptions = {
        retryLimit: definition.retryLimit,
        retryDelay: definition.retryDelay,
        retryBackoff: definition.retryBackoff,
        expireInSeconds: definition.expireInSeconds,
        deleteAfterSeconds: queueOptions.deleteAfterSeconds,
      };
      await boss.updateQueue(definition.name, updatable);
    },
    enqueue,
    async schedule(slot, cron, data, scheduleOptions) {
      requireWorker('schedule()');
      await boss.schedule(slot, cron, data, { tz: scheduleOptions.tz });
    },
    async work(queue, handler, workOptions = {}) {
      requireWorker('work()');
      await boss.work(
        queue,
        {
          includeMetadata: true,
          perJobResults: true,
          batchSize: 1,
          localConcurrency: workOptions.localConcurrency ?? 1,
          ...(options.pollingIntervalSeconds === undefined
            ? {}
            : { pollingIntervalSeconds: options.pollingIntervalSeconds }),
        },
        wrap(queue, handler) as never,
      );
    },
    trigger(queue, data = {}) {
      return enqueue(queue, data);
    },
    async listSchedules() {
      const schedules = await boss.getSchedules();
      return schedules.map((schedule) => ({
        name: schedule.name,
        key: schedule.key,
        cron: schedule.cron,
        tz: schedule.timezone,
        lastJobId: schedule.lastJobId,
      }));
    },
    async getJob(queue, id) {
      const job = await boss.getJobById<object>(queue, id);
      if (!job) return null;
      return {
        id: job.id,
        queue: job.name,
        state: job.state,
        retryCount: job.retryCount,
        retryLimit: job.retryLimit,
        output: job.output,
        data: extractTraceMeta(job.data).data,
        singletonKey: job.singletonKey,
        createdOn: job.createdOn,
        startedOn: job.startedOn,
        completedOn: job.completedOn,
      };
    },
    previewSchedule(cron, previewOptions = {}) {
      return boss.previewSchedule(cron, {
        ...(previewOptions.tz === undefined ? {} : { tz: previewOptions.tz }),
        ...(previewOptions.from === undefined ? {} : { from: previewOptions.from }),
        ...(previewOptions.count === undefined ? {} : { count: previewOptions.count }),
      });
    },
  };
}
