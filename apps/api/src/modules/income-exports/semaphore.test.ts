import { describe, expect, it } from 'vitest';
import { createExportSemaphore } from './semaphore.ts';

describe('createExportSemaphore (CR-3: per team 1, global N)', () => {
  it('admits one export per team and at most N overall, and frees a slot on release (once)', () => {
    const semaphore = createExportSemaphore({ maxConcurrent: 2 });
    const a = semaphore.tryAcquire('team-a');
    expect(a).not.toBeNull();
    expect(semaphore.tryAcquire('team-a')).toBeNull(); // the same team is busy
    const b = semaphore.tryAcquire('team-b');
    expect(b).not.toBeNull();
    expect(semaphore.tryAcquire('team-c')).toBeNull(); // the global limit is reached
    expect(semaphore.inFlight()).toBe(2);
    a?.();
    a?.(); // releasing twice frees one slot only
    expect(semaphore.inFlight()).toBe(1);
    expect(semaphore.tryAcquire('team-a')).not.toBeNull();
    expect(semaphore.tryAcquire('team-c')).toBeNull();
    b?.();
    expect(semaphore.tryAcquire('team-c')).not.toBeNull();
  });
});
