/**
 * Composition root for the sessions allocator port (architecture SA-4, binding T-13). `main.ts` passes the result to
 * `buildApp` and `worker.ts` passes it to `registerJobs`; both parameters are REQUIRED, so an entrypoint that forgets
 * it does not compile, and `session-allocator.test.ts` proves both call this function.
 *
 * registration-and-waitlist changed exactly ONE thing: the body of `createSessionAllocator` now returns
 * `createRegistrationsSessionAllocator(createAllocator({ jobs, webBaseUrl }))` (the adapter adds `name: 'registrations'` and
 * `enrols: true`), where it returned the no-op port. Nothing else is edited, and no environment variable picks the adapter.
 * With `enrols: true` SSE's sweep (03:00 Pacific/Auckland and every worker boot) enrols and stamps every pending PUBLISHED,
 * not-started session, and a capacity raise promotes the waitlist (ADR 0018, ADR 0019 §6, R19, R27).
 */
import type { Clock } from './lib/clock.ts';
import type { Database } from './lib/db/kysely.ts';
import type { JobRunner } from './lib/jobs/jobs.ts';
import { createAllocator } from './modules/registrations/allocator.ts';
import { createRegistrationsSessionAllocator } from './modules/registrations/session-allocator-adapter.ts';
import type { SessionAllocatorPort } from './modules/sessions/allocator-port.ts';

export interface SessionAllocatorDeps {
  readonly db: Database;
  /** API: the producer runner; worker: the worker runner (allocator emails go on the caller's transaction). */
  readonly jobs: Pick<JobRunner, 'enqueue'>;
  readonly clock: Clock;
  readonly webBaseUrl: string;
}

export function createSessionAllocator(deps: SessionAllocatorDeps): SessionAllocatorPort {
  return createRegistrationsSessionAllocator(
    createAllocator({ jobs: deps.jobs, webBaseUrl: deps.webBaseUrl }),
  );
}
