import type { JobHandler } from '../lib/jobs/jobs.ts';

/** Foundation heartbeat: proves enqueue -> work -> complete end to end (AC-ASYNC-1). */
export const heartbeatHandler: JobHandler = (payload, context) => {
  context.logger.info({ event: 'heartbeat', payload }, 'heartbeat');
  return Promise.resolve();
};
