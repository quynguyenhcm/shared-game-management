import { describe, expect, it } from 'vitest';
import {
  ALLOCATION_MATRIX,
  outcomeOf,
  toAllocationInput,
} from '../../../test/fixtures/allocation-matrix.ts';
import { decideAllocation, type AllocationInput, type PartyRef } from './allocation.ts';

const party = (id: string, partySize: 1 | 2 | 3): PartyRef => ({ registrationId: id, partySize });
const queued = (id: string, partySize: 1 | 2 | 3, queuePosition: number) => ({
  registrationId: id,
  partySize,
  queuePosition,
});

function applied(input: AllocationInput) {
  const decision = decideAllocation(input);
  if (decision.outcome !== 'applied') throw new Error(`refused: ${decision.reason}`);
  return decision;
}

describe('the allocation matrix (shared with the integration seeding)', () => {
  it.each(ALLOCATION_MATRIX.map((scenario) => [scenario.name, scenario] as const))(
    '%s',
    (_name, scenario) => {
      const decision = decideAllocation(toAllocationInput(scenario));
      expect(outcomeOf(scenario, decision)).toEqual(scenario.expected);
    },
  );

  it('keeps first-fit maximal: after every applied row, no waitlisted party fits the free seats (AC-VERIFY-4)', () => {
    for (const scenario of ALLOCATION_MATRIX) {
      const decision = decideAllocation(toAllocationInput(scenario));
      if (decision.outcome !== 'applied') continue;
      const after = outcomeOf(scenario, decision);
      const everyone = [...scenario.confirmed, ...scenario.waitlist, ...(scenario.owed ?? [])];
      const request = scenario.request;
      const sizeOf = (name: string): number =>
        everyone.find((one) => one.name === name)?.size ??
        (request.kind === 'register' && request.name === name ? request.size : 0);
      const taken = after.confirmed.reduce((sum, name) => sum + sizeOf(name), 0);
      // Only a state that began within capacity is held to the invariant (a capacity cut may leave it over).
      const before = scenario.confirmed.reduce((sum, one) => sum + one.size, 0);
      if (before > scenario.capacity) continue;
      const free = scenario.capacity - taken;
      for (const name of after.waitlist) {
        expect(sizeOf(name), `${scenario.name}: ${name}`).toBeGreaterThan(free);
      }
    }
  });
});

describe('decideAllocation: decisions in detail', () => {
  it('numbers a waitlisted newcomer max + 1 even when positions have gaps (D-14)', () => {
    const decision = applied({
      publicCapacity: 2,
      confirmedParties: [party('a', 2)],
      waitlist: [queued('x', 2, 4), queued('y', 2, 9)],
      openLiabilities: [],
      request: { kind: 'register', registrationId: 'n', partySize: 1, liablePriorPartySize: null },
    });
    expect(decision.newcomer).toEqual({
      registrationId: 'n',
      status: 'WAITLISTED',
      queuePosition: 10,
    });
    expect(decision.promotions).toEqual([]);
    expect(decision.seatsTaken).toBe(2);
    expect(decision.seatsLeft).toBe(0);
  });

  it('reports each promotion with the position it left, in ascending order, whatever order the waitlist arrives in', () => {
    const decision = applied({
      publicCapacity: 5,
      confirmedParties: [party('a', 1)],
      waitlist: [queued('late', 1, 7), queued('first', 2, 3), queued('mid', 1, 5)],
      openLiabilities: [],
      request: { kind: 'rebalance' },
    });
    expect(decision.promotions.map((one) => [one.registrationId, one.fromQueuePosition])).toEqual([
      ['first', 3],
      ['mid', 5],
      ['late', 7],
    ]);
    expect(decision.seatsTaken).toBe(5);
    expect(decision.seatsLeft).toBe(0);
  });

  it('describes the withdrawal: source status, kind and the liability flag', () => {
    const late = applied({
      publicCapacity: 3,
      confirmedParties: [party('a', 3)],
      waitlist: [],
      openLiabilities: [],
      request: { kind: 'withdraw', registrationId: 'a', withdrawalKind: 'LATE' },
    });
    expect(late.withdrawn).toEqual({
      registrationId: 'a',
      fromStatus: 'CONFIRMED',
      kind: 'LATE',
      feeDue: true,
    });
    const leaving = applied({
      publicCapacity: 1,
      confirmedParties: [party('a', 1)],
      waitlist: [queued('w', 1, 1)],
      openLiabilities: [],
      request: { kind: 'withdraw', registrationId: 'w', withdrawalKind: 'LATE' },
    });
    expect(leaving.withdrawn).toEqual({
      registrationId: 'w',
      fromStatus: 'WAITLISTED',
      kind: 'LATE',
      feeDue: false,
    });
  });

  it('releases owed fees oldest first, whole parties, while the seat budget lasts (R2)', () => {
    const decision = applied({
      publicCapacity: 4,
      confirmedParties: [],
      waitlist: [],
      openLiabilities: [party('old', 2), party('mid', 1), party('new', 1)],
      request: { kind: 'register', registrationId: 'n', partySize: 2, liablePriorPartySize: null },
    });
    // The newcomer of 2 confirms 2 seats: the oldest owed party (2) is released, the rest stay.
    expect(decision.releasedLiabilities).toEqual(['old']);
  });

  it('never releases when the requester is refused or only waitlisted', () => {
    const refused = decideAllocation({
      publicCapacity: 1,
      confirmedParties: [party('a', 1)],
      waitlist: [],
      openLiabilities: [party('p', 1)],
      request: { kind: 'register', registrationId: 'a', partySize: 1, liablePriorPartySize: null },
    });
    expect(refused).toEqual({ outcome: 'refused', reason: 'already_registered' });
  });

  it('promotes and releases nothing when promotions are closed (at or after starts_at)', () => {
    const decision = applied({
      publicCapacity: 4,
      confirmedParties: [party('a', 1)],
      waitlist: [queued('x', 1, 1)],
      openLiabilities: [party('p', 1)],
      request: { kind: 'rebalance' },
      promotionsOpen: false,
    });
    expect(decision.promotions).toEqual([]);
    expect(decision.releasedLiabilities).toEqual([]);
    expect(decision.seatsTaken).toBe(1);
  });

  it('is deterministic and a rebalance on a first-fit-maximal state is a no-op', () => {
    const input: AllocationInput = {
      publicCapacity: 3,
      confirmedParties: [party('a', 2)],
      waitlist: [queued('h', 3, 1), queued('m', 2, 2)],
      openLiabilities: [],
      request: { kind: 'rebalance' },
    };
    const first = applied(input);
    expect(applied(input)).toEqual(first);
    expect(first.promotions).toEqual([]);
    expect(first.releasedLiabilities).toEqual([]);
  });

  it('puts the largest-party-first rule nowhere: a skipped head is offered seats first next time', () => {
    const step1 = applied({
      publicCapacity: 4,
      confirmedParties: [party('a', 2), party('b', 2)],
      waitlist: [queued('head', 3, 1), queued('small', 1, 2)],
      openLiabilities: [],
      request: { kind: 'withdraw', registrationId: 'a', withdrawalKind: 'EARLY' },
    });
    // 2 seats free: the head (3) is skipped, the small party gets one.
    expect(step1.promotions.map((one) => one.registrationId)).toEqual(['small']);
    const step2 = applied({
      publicCapacity: 4,
      confirmedParties: [party('b', 2), party('small', 1)],
      waitlist: [queued('head', 3, 1)],
      openLiabilities: [],
      request: { kind: 'withdraw', registrationId: 'small', withdrawalKind: 'EARLY' },
    });
    // 2 seats free again: still not enough for the head, which keeps position 1.
    expect(step2.promotions).toEqual([]);
    const step3 = applied({
      publicCapacity: 4,
      confirmedParties: [],
      waitlist: [queued('head', 3, 1)],
      openLiabilities: [],
      request: { kind: 'rebalance' },
    });
    expect(step3.promotions.map((one) => one.registrationId)).toEqual(['head']);
  });
});

describe('decideAllocation: a liable re-registrant does not also release other fees (R2, R3)', () => {
  const reRegister = (overrides: Partial<AllocationInput> & { partySize?: 1 | 2 | 3 }) =>
    applied({
      publicCapacity: 2,
      confirmedParties: [],
      waitlist: [],
      openLiabilities: [party('a', 1)],
      request: {
        kind: 'register',
        registrationId: 'b',
        partySize: overrides.partySize ?? 1,
        liablePriorPartySize: 1,
      },
      ...overrides,
    });

  it('keeps the other fee owed when the re-registrant takes exactly the freed seats', () => {
    const decision = reRegister({ publicCapacity: 1 });
    expect(decision.newcomer).toEqual({ registrationId: 'b', status: 'CONFIRMED' });
    expect(decision.releasedLiabilities).toEqual([]);
  });

  it('releases the other fee when the re-registrant brings one more seat than it owed', () => {
    const decision = reRegister({ partySize: 2 });
    expect(decision.releasedLiabilities).toEqual(['a']);
  });

  it('releases the other fee when a waitlisted party is promoted in the same step', () => {
    const decision = applied({
      publicCapacity: 2,
      confirmedParties: [],
      waitlist: [queued('w', 1, 1)],
      openLiabilities: [party('a', 1)],
      request: { kind: 'register', registrationId: 'b', partySize: 1, liablePriorPartySize: 1 },
    });
    expect(decision.promotions.map((one) => one.registrationId)).toEqual(['w']);
    expect(decision.releasedLiabilities).toEqual(['a']);
  });

  it('is unchanged for a newcomer that owes nothing', () => {
    const decision = applied({
      publicCapacity: 1,
      confirmedParties: [],
      waitlist: [],
      openLiabilities: [party('a', 1)],
      request: { kind: 'register', registrationId: 'n', partySize: 1, liablePriorPartySize: null },
    });
    expect(decision.releasedLiabilities).toEqual(['a']);
  });
});

describe('decideAllocation: malformed input is a programming error', () => {
  const base: AllocationInput = {
    publicCapacity: 2,
    confirmedParties: [party('a', 1)],
    waitlist: [queued('w', 1, 1)],
    openLiabilities: [],
    request: { kind: 'rebalance' },
  };

  it.each([
    ['a negative capacity', { ...base, publicCapacity: -1 }],
    ['a fractional capacity', { ...base, publicCapacity: 1.5 }],
    [
      'a party size outside 1..3',
      { ...base, confirmedParties: [{ registrationId: 'a', partySize: 4 }] },
    ],
    ['a duplicate id across the lists', { ...base, waitlist: [queued('a', 1, 1)] }],
    ['a duplicate queue position', { ...base, waitlist: [queued('w', 1, 1), queued('v', 1, 1)] }],
    ['a queue position below 1', { ...base, waitlist: [queued('w', 1, 0)] }],
  ])('throws on %s', (_label, input) => {
    expect(() => decideAllocation(input as unknown as AllocationInput)).toThrow();
  });
});

describe('decideAllocation: ineligible waitlist entries (B1, a banned member that is not yet withdrawn)', () => {
  const ineligible = (id: string, partySize: 1 | 2 | 3, queuePosition: number) => ({
    ...queued(id, partySize, queuePosition),
    eligible: false,
  });

  it('never promotes an ineligible entry, promotes the next eligible one, and leaves the ineligible one queued', () => {
    const decision = applied({
      publicCapacity: 2,
      confirmedParties: [party('c', 1)],
      waitlist: [ineligible('banned', 1, 1), queued('next', 1, 2)],
      openLiabilities: [],
      request: { kind: 'rebalance' },
    });
    expect(decision.promotions.map((one) => one.registrationId)).toEqual(['next']);
  });

  it('still counts an ineligible entry toward the queue tail, so a newcomer queues behind it', () => {
    const decision = applied({
      publicCapacity: 1,
      confirmedParties: [party('c', 1)],
      waitlist: [ineligible('banned', 1, 4)],
      openLiabilities: [],
      request: {
        kind: 'register',
        registrationId: 'new',
        partySize: 1,
        liablePriorPartySize: null,
      },
    });
    expect(decision.newcomer).toEqual({
      registrationId: 'new',
      status: 'WAITLISTED',
      queuePosition: 5,
    });
  });

  it('can withdraw an ineligible waitlisted entry (BANNED): from WAITLISTED, no fee, nobody promoted into a still-full session', () => {
    const decision = applied({
      publicCapacity: 1,
      confirmedParties: [party('c', 1)],
      waitlist: [ineligible('banned', 1, 1), queued('next', 1, 2)],
      openLiabilities: [],
      request: { kind: 'withdraw', registrationId: 'banned', withdrawalKind: 'BANNED' },
    });
    expect(decision.withdrawn).toEqual({
      registrationId: 'banned',
      fromStatus: 'WAITLISTED',
      kind: 'BANNED',
      feeDue: false,
    });
    expect(decision.promotions).toEqual([]);
  });

  it('property: over every mix of eligible flags no ineligible entry is ever promoted, and eligible-only behaviour is unchanged', () => {
    for (let mask = 0; mask < 32; mask += 1) {
      const waitlist = [1, 2, 3, 1, 2].map((size, index) => ({
        ...queued(`w${index}`, size as 1 | 2 | 3, index + 1),
        eligible: (mask & (1 << index)) === 0,
      }));
      for (const capacity of [1, 2, 3, 5, 9]) {
        const decision = applied({
          publicCapacity: capacity,
          confirmedParties: [],
          waitlist,
          openLiabilities: [],
          request: { kind: 'rebalance' },
        });
        const bannedIds = new Set(
          waitlist.filter((entry) => !entry.eligible).map((entry) => entry.registrationId),
        );
        for (const promotion of decision.promotions) {
          expect(bannedIds.has(promotion.registrationId)).toBe(false);
        }
        const plain = applied({
          publicCapacity: capacity,
          confirmedParties: [],
          waitlist: waitlist.filter((entry) => entry.eligible),
          openLiabilities: [],
          request: { kind: 'rebalance' },
        });
        expect(decision.promotions).toEqual(plain.promotions);
      }
    }
  });
});
