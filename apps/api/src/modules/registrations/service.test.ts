/**
 * Service behaviour the HTTP tests cannot reach: the DB CHECKs make a fee-due withdrawal without a priced snapshot
 * unreachable through real rows, so the allocator and the read model are stubbed here (review M1).
 */
import { describe, expect, it, vi } from 'vitest';
import type { Database } from '../../lib/db/kysely.ts';
import { createManualClock } from '../../lib/clock.ts';

const withdrawFromSession = vi.fn();
const readOwedFeeEstimate = vi.fn();

vi.mock('./allocator.ts', () => ({
  createAllocator: () => ({ withdrawFromSession, registerInSession: vi.fn() }),
}));
vi.mock('./tx.ts', () => ({
  HTTP_POLICY: {},
  runAllocatorTransaction: (
    _db: unknown,
    _policy: unknown,
    options: { clock: { now(): Date } },
    work: (ctx: { trx: unknown; now: Date }) => Promise<unknown>,
  ) => work({ trx: {}, now: options.clock.now() }),
}));
vi.mock('./read-model.ts', () => ({
  readMyRegistration: vi.fn(),
  readOwedFeeEstimate: (...args: unknown[]): Promise<unknown> =>
    readOwedFeeEstimate(...args) as Promise<unknown>,
  readRegistrationModel: vi.fn(),
  readUpcoming: vi.fn(),
  readVisibleSession: vi.fn(() => Promise.resolve({ id: 's' })),
}));

const { createRegistrationsService } = await import('./service.ts');

describe('withdraw feeEstimate when the fee is due but cannot be estimated', () => {
  it('answers "0.00" (best-effort: billing decides the charge) instead of failing the withdrawal', async () => {
    withdrawFromSession.mockResolvedValue({
      ok: true,
      feeDue: true,
      withdrawalKind: 'LATE',
      promoted: [],
    });
    readOwedFeeEstimate.mockResolvedValue(null);
    const service = createRegistrationsService({
      db: {} as Database,
      clock: createManualClock(new Date('2026-10-05T06:00:00.000Z')),
      jobs: { enqueue: vi.fn() },
      webBaseUrl: 'https://example.test',
    });
    const res = await service.withdraw('t', 's', 'u', { expectLate: true }, { log: console });
    expect(res).toEqual({
      registration: { status: 'WITHDRAWN', withdrawalKind: 'LATE', withdrawalFeeDue: true },
      replacedBy: 'nobody',
      feeEstimate: '0.00',
    });
  });
});
