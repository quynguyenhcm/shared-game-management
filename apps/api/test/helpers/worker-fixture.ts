/**
 * Child-process worker used by the AC-ASYNC-3(iii) test. It is the production job wiring
 * (`registerJobs`) plus one extra queue whose first attempt hangs, so the test can SIGKILL the
 * process mid-execution and prove the job is recovered by expiry. Timing comes from the same
 * JOBS_* environment variables the real worker reads.
 */
import { registerJobs } from '../../src/jobs/bootstrap.ts';
import { loadConfigOrExit } from '../../src/lib/config/config.ts';
import { createPool } from '../../src/lib/db/pool.ts';
import { createJobRunner } from '../../src/lib/jobs/jobs.ts';
import { createLogger, loggerOptionsFromConfig } from '../../src/lib/logger/logger.ts';
import { createInMemoryNotifier } from '../../src/lib/notifications/adapters/in-memory.ts';

export const CRASH_QUEUE = 'it-crash';

const config = loadConfigOrExit();
const logger = createLogger(loggerOptionsFromConfig(config, 'worker'));
const pool = createPool({ connectionString: config.databaseUrl, max: 2, logger });
const runner = createJobRunner({
  databaseUrl: config.databaseUrl,
  logger,
  role: 'worker',
  superviseIntervalSeconds: config.jobs.superviseIntervalSeconds,
  pollingIntervalSeconds: config.jobs.pollIntervalSeconds,
});
await runner.start();
await registerJobs({
  runner,
  notifier: createInMemoryNotifier(),
  expireSecondsOverride: config.jobs.expireSecondsOverride,
  extraQueues: [
    {
      definition: {
        name: CRASH_QUEUE,
        policy: 'standard',
        retryLimit: 3,
        retryDelay: 1,
        retryBackoff: false,
        expireInSeconds: 60,
        retentionDays: 7,
      },
      handler: async (_data, ctx) => {
        await pool.query('INSERT INTO job_effects (job_id, kind, attempt) VALUES ($1, $2, $3)', [
          ctx.jobId,
          'started',
          ctx.retryCount,
        ]);
        if (ctx.retryCount === 0) {
          // First attempt hangs until the test kills this process.
          await new Promise((resolve) => setTimeout(resolve, 120_000));
        }
        await pool.query('INSERT INTO job_effects (job_id, kind, attempt) VALUES ($1, $2, $3)', [
          ctx.jobId,
          'completed',
          ctx.retryCount,
        ]);
      },
    },
  ],
});
logger.info({ event: 'fixture.ready' }, 'fixture worker ready');

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => {
    void runner
      .stop()
      .then(() => pool.end())
      .then(() => process.exit(0));
  });
}
