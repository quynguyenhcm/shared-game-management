/**
 * The reconciliation sweep's own rules (architecture Q4 sweep S-a; AC-ASYNC-3), with the candidate read and the database
 * faked: it pages by keyset, rebuilds the `member-banned` payload from the membership row through the team module's helper,
 * counts a job that is already queued, and skips (never aborts on) a row that cannot make a valid payload. The SQL itself is
 * proven in `registrations-ban-reconcile.int.test.ts`.
 */
import { describe, expect, it } from 'vitest';
import { createManualClock } from '../../lib/clock.ts';
import type { Database } from '../../lib/db/kysely.ts';
import { MemberBannedPayload } from '../teams/ban-hook.ts';
import { reconcileBannedMembers } from './reconcile.ts';
import type { BannedCandidate } from './repo.ts';

const NOW = new Date('2026-10-25T17:45:00Z');
const uuid = (n: number): string => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

function candidate(n: number, overrides: Partial<BannedCandidate> = {}): BannedCandidate {
  return {
    membershipId: uuid(n),
    teamId: uuid(1000 + n),
    userId: uuid(2000 + n),
    bannedBy: uuid(3000 + n),
    bannedAt: new Date(`2026-10-0${String((n % 9) + 1)}T01:02:03.000Z`),
    ...overrides,
  };
}

function harness(all: readonly BannedCandidate[], alreadyQueued: ReadonlySet<string> = new Set()) {
  const enqueued: {
    queue: string;
    data: unknown;
    singletonKey: string | undefined;
    trx: boolean;
  }[] = [];
  const pages: { after: unknown; limit: number }[] = [];
  const trx = { fake: true };
  const db = {
    transaction: () => ({ execute: <T>(work: (t: unknown) => Promise<T>) => work(trx) }),
  } as unknown as Database;
  const run = (pageSize: number) =>
    reconcileBannedMembers({
      db,
      clock: createManualClock(NOW),
      pageSize,
      jobs: {
        enqueue: (
          queue: string,
          data: object,
          options?: { singletonKey?: string; trx?: unknown },
        ) => {
          enqueued.push({
            queue,
            data,
            singletonKey: options?.singletonKey,
            trx: options?.trx === trx,
          });
          return Promise.resolve(
            options?.singletonKey !== undefined && alreadyQueued.has(options.singletonKey)
              ? null
              : `job-${String(enqueued.length)}`,
          );
        },
      },
      listCandidates: (_trx, input) => {
        pages.push({ after: input.after, limit: input.limit });
        const start =
          input.after === undefined
            ? 0
            : all.findIndex((row) => row.membershipId === input.after?.membershipId) + 1;
        return Promise.resolve(all.slice(start, start + input.limit));
      },
    });
  return { run, enqueued, pages };
}

describe('reconcileBannedMembers', () => {
  it('enqueues one member-banned job per candidate, payload rebuilt from the row, singleton key by membership, inside the sweep transaction', async () => {
    const rows = [candidate(1), candidate(2)];
    const h = harness(rows);
    const counts = await h.run(10);
    expect(counts).toEqual({ scanned: 2, enqueued: 2, alreadyQueued: 0, invalid: 0 });
    expect(h.enqueued.map((job) => job.queue)).toEqual(['member-banned', 'member-banned']);
    expect(h.enqueued.every((job) => job.trx)).toBe(true);
    const first = h.enqueued[0];
    expect(first?.singletonKey).toBe(`member-banned:${uuid(1)}`);
    expect(MemberBannedPayload.parse(first?.data)).toEqual({
      teamId: uuid(1001),
      userId: uuid(2001),
      membershipId: uuid(1),
      bannedBy: uuid(3001),
      bannedAt: '2026-10-02T01:02:03.000Z',
    });
  });

  it('counts a job that is already queued or active, and does not duplicate it', async () => {
    const h = harness([candidate(1), candidate(2)], new Set([`member-banned:${uuid(2)}`]));
    expect(await h.run(10)).toEqual({ scanned: 2, enqueued: 1, alreadyQueued: 1, invalid: 0 });
  });

  it('skips a row that cannot make a valid payload and carries on', async () => {
    const h = harness([candidate(1, { bannedBy: null }), candidate(2)]);
    expect(await h.run(10)).toEqual({ scanned: 2, enqueued: 1, alreadyQueued: 0, invalid: 1 });
    expect(h.enqueued).toHaveLength(1);
  });

  it('pages by keyset so a candidate that never drops out cannot starve the ones behind it', async () => {
    const rows = [candidate(1), candidate(2), candidate(3), candidate(4), candidate(5)];
    const h = harness(rows);
    const counts = await h.run(2);
    expect(counts).toEqual({ scanned: 5, enqueued: 5, alreadyQueued: 0, invalid: 0 });
    expect(h.pages.map((page) => page.limit)).toEqual([2, 2, 2]);
    expect(h.pages[0]?.after).toBeUndefined();
    expect(h.pages[1]?.after).toMatchObject({ membershipId: uuid(2) });
  });

  it('does nothing when no banned member holds an active registration', async () => {
    const h = harness([]);
    expect(await h.run(10)).toEqual({ scanned: 0, enqueued: 0, alreadyQueued: 0, invalid: 0 });
    expect(h.enqueued).toEqual([]);
  });
});
