/**
 * The registrations adapter for session-scheduling-engine's allocator port (R19, ADR 0018, ADR 0019 §8). It is a thin wrapper:
 * these tests pin what it adds (`name`, `enrols`, the transaction assertion), that it maps the allocator's results to the port's
 * shapes without inventing or dropping anything, and that it never opens a transaction or touches the clock itself. The
 * database behaviour is proven through SSE's own code paths in `registrations-adapter.int.test.ts`.
 */
import type { Transaction } from 'kysely';
import { describe, expect, it, vi } from 'vitest';
import type { DB } from '../../lib/db/types.generated.ts';
import type { SessionAllocatorPort } from '../sessions/allocator-port.ts';
import type { Allocator, AutoEnrolOutcome } from './allocator.ts';
import { createRegistrationsSessionAllocator } from './session-allocator-adapter.ts';

const NOW = new Date('2026-10-25T01:00:00.000Z');
const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
const ids = { teamId: 'team-1', sessionId: 'session-1' };

const ctxIn = (isTransaction: boolean) => ({
  trx: { isTransaction } as unknown as Transaction<DB>,
  now: NOW,
  log,
});

function fakeAllocator(
  impl: {
    promote?: Allocator['promoteWaitlist'];
    autoEnrol?: Allocator['autoEnrolInSession'];
  } = {},
) {
  const promote = vi.fn<Allocator['promoteWaitlist']>(impl.promote ?? (() => Promise.resolve([])));
  const autoEnrol = vi.fn<Allocator['autoEnrolInSession']>(
    impl.autoEnrol ?? (() => Promise.resolve([])),
  );
  return {
    allocator: { promoteWaitlist: promote, autoEnrolInSession: autoEnrol },
    promote,
    autoEnrol,
  };
}

describe('createRegistrationsSessionAllocator', () => {
  it('is the real allocator on the port: named registrations, and enrols is true so SSE stamps the D-80 marker', () => {
    const port: SessionAllocatorPort = createRegistrationsSessionAllocator(
      fakeAllocator().allocator,
    );
    expect(port.name).toBe('registrations');
    expect(port.enrols).toBe(true);
  });

  it('promoteWaitlist hands the caller context and ids to the allocator and returns the promoted seats', async () => {
    const promoted = [{ registrationId: 'r1', userId: 'u1', promotedAt: NOW }];
    const fake = fakeAllocator({ promote: () => Promise.resolve(promoted) });
    const port = createRegistrationsSessionAllocator(fake.allocator);
    const ctx = ctxIn(true);

    await expect(port.promoteWaitlist(ctx, ids)).resolves.toEqual(promoted);
    expect(fake.promote).toHaveBeenCalledWith(ctx, ids);
  });

  it('autoEnrolInSession passes the entries through in order and maps every outcome, reasons included (R19, R21)', async () => {
    const outcomes: Record<string, AutoEnrolOutcome> = {
      a: { ok: true, status: 'CONFIRMED' },
      b: { ok: true, status: 'WAITLISTED' },
      c: { ok: false, reason: 'already_registered' },
      d: { ok: false, reason: 'auto_enroll_changed' },
      e: { ok: false, reason: 'overdue_payments' },
      f: { ok: false, reason: 'forbidden' },
      g: { ok: false, reason: 'not_found' },
      h: { ok: false, reason: 'session_not_open' },
      i: { ok: false, reason: 'party_exceeds_capacity' },
      j: { ok: false, reason: 'deadline_passed' },
    };
    const fake = fakeAllocator({
      autoEnrol: (_ctx, input) =>
        Promise.resolve(
          input.entries.map((entry) => ({
            userId: entry.userId,
            outcome: outcomes[entry.userId] ?? { ok: false as const, reason: 'not_found' as const },
          })),
        ),
    });
    const port = createRegistrationsSessionAllocator(fake.allocator);
    const entries = Object.keys(outcomes).map((userId) => ({
      userId,
      assignedAt: NOW,
      membershipId: `m-${userId}`,
    }));
    const ctx = ctxIn(true);

    // O8: `notify` passes through untouched (false is the silent backlog).
    const results = await port.autoEnrolInSession(ctx, { ...ids, entries, notify: false });

    expect(fake.autoEnrol).toHaveBeenCalledWith(ctx, { ...ids, entries, notify: false });
    expect(results.map((result) => result.userId)).toEqual(Object.keys(outcomes));
    expect(results.map((result) => result.outcome)).toEqual(Object.values(outcomes));
  });

  it('asserts the caller transaction before it touches the allocator, on both methods', async () => {
    const fake = fakeAllocator();
    const port = createRegistrationsSessionAllocator(fake.allocator);
    const entries = [{ userId: 'u1', assignedAt: NOW }];

    await expect(port.promoteWaitlist(ctxIn(false), ids)).rejects.toThrow(/transaction/);
    await expect(
      port.autoEnrolInSession(ctxIn(false), { ...ids, entries, notify: true }),
    ).rejects.toThrow(/transaction/);
    expect(fake.promote).not.toHaveBeenCalled();
    expect(fake.autoEnrol).not.toHaveBeenCalled();
  });

  it('lets an allocator error reach SSE untouched, so SSE rolls back and its retry policy applies', async () => {
    const failure = Object.assign(new Error('deadlock'), { code: '40P01' });
    const port = createRegistrationsSessionAllocator(
      fakeAllocator({ promote: () => Promise.reject(failure) }).allocator,
    );
    await expect(port.promoteWaitlist(ctxIn(true), ids)).rejects.toBe(failure);
  });
});
