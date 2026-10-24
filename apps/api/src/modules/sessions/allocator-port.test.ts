import { describe, expect, it, vi } from 'vitest';
import type { Transaction } from 'kysely';
import type { DB } from '../../lib/db/types.generated.ts';
import { noopSessionAllocator, type SessionAllocatorContext } from './allocator-port.ts';

function context(): SessionAllocatorContext {
  return {
    trx: {} as Transaction<DB>,
    now: new Date('2026-10-20T00:00:00Z'),
    log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  };
}

describe('noopSessionAllocator', () => {
  it('is named, does not enrol, and changes nothing', async () => {
    const ctx = context();
    expect(noopSessionAllocator.name).toBe('noop');
    expect(noopSessionAllocator.enrols).toBe(false);
    await expect(
      noopSessionAllocator.promoteWaitlist(ctx, { teamId: 't', sessionId: 's' }),
    ).resolves.toEqual([]);
    await expect(
      noopSessionAllocator.autoEnrolInSession(ctx, {
        teamId: 't',
        sessionId: 's',
        entries: [{ userId: 'u', assignedAt: new Date('2026-10-01T00:00:00Z') }],
      }),
    ).resolves.toEqual([]);
  });
});
