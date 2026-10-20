/**
 * Composition root for the sessions allocator port (architecture SA-4, binding T-13). `main.ts` passes the result to
 * `buildApp` and `worker.ts` passes it to `registerJobs`; both parameters are REQUIRED, so an entrypoint that forgets
 * it does not compile, and `session-allocator.test.ts` proves both call this function.
 *
 * registration-and-waitlist changes exactly ONE thing: the body of `createSessionAllocator`, to return
 * `createRegistrationsSessionAllocator(createAllocator({ jobs, webBaseUrl }))` (an adapter that adds
 * `name: 'registrations'` and `enrols: true`). Nothing else is edited, and no environment variable picks the adapter.
 */
import type { Clock } from './lib/clock.ts';
import type { Database } from './lib/db/kysely.ts';
import type { JobRunner } from './lib/jobs/jobs.ts';
import {
  noopSessionAllocator,
  type SessionAllocatorPort,
} from './modules/sessions/allocator-port.ts';

export interface SessionAllocatorDeps {
  readonly db: Database;
  /** API: the producer runner; worker: the worker runner (allocator emails go on the caller's transaction). */
  readonly jobs: Pick<JobRunner, 'enqueue'>;
  readonly clock: Clock;
  readonly webBaseUrl: string;
}

export function createSessionAllocator(deps: SessionAllocatorDeps): SessionAllocatorPort {
  void deps;
  return noopSessionAllocator;
}
