/**
 * The allocation scenario matrix as data (algorithm doc, Testing Strategy; plan anti-drift rule). One list, two consumers:
 * `modules/registrations/allocation.test.ts` runs every row through the pure `decideAllocation`, and
 * `registrations-allocator.int.test.ts` seeds the same rows as real registrations and runs the allocator, so the SQL
 * path and the TypeScript decision cannot drift apart. Parties are named; sizes are 1..3 (registrant plus guests).
 *
 * Waitlist positions are 1..n in listed order; owed late withdrawals are listed oldest first. A request that names a
 * party in `owed` is that party re-registering into its own WITHDRAWN row (R3).
 */
import type {
  AllocationDecision,
  AllocationInput,
  PartyRef,
  PartySize,
  WithdrawalKind,
} from '../../src/modules/registrations/allocation.ts';

export interface MatrixParty {
  readonly name: string;
  readonly size: PartySize;
}

export type MatrixRequest =
  | { readonly kind: 'register'; readonly name: string; readonly size: PartySize }
  | { readonly kind: 'withdraw'; readonly name: string; readonly withdrawalKind: WithdrawalKind }
  | { readonly kind: 'rebalance' };

export interface MatrixOutcome {
  /** Set when the request is refused; the state then must not change. */
  readonly refused?: string;
  /** Party names CONFIRMED after the step, sorted. */
  readonly confirmed: readonly string[];
  /** Party names WAITLISTED after the step, in queue order. */
  readonly waitlist: readonly string[];
  /** Party names whose late-withdrawal fee is still owed after the step, oldest first. */
  readonly owed: readonly string[];
}

export interface MatrixScenario {
  readonly name: string;
  readonly capacity: number;
  readonly confirmed: readonly MatrixParty[];
  readonly waitlist: readonly MatrixParty[];
  readonly owed?: readonly MatrixParty[];
  readonly request: MatrixRequest;
  readonly expected: MatrixOutcome;
}

const p = (name: string, size: PartySize): MatrixParty => ({ name, size });

export const ALLOCATION_MATRIX: readonly MatrixScenario[] = [
  {
    name: 'a solo registrant takes a free seat',
    capacity: 4,
    confirmed: [p('A', 1)],
    waitlist: [],
    request: { kind: 'register', name: 'B', size: 1 },
    expected: { confirmed: ['A', 'B'], waitlist: [], owed: [] },
  },
  {
    name: 'a registrant on a full session is waitlisted',
    capacity: 2,
    confirmed: [p('A', 1), p('B', 1)],
    waitlist: [],
    request: { kind: 'register', name: 'C', size: 1 },
    expected: { confirmed: ['A', 'B'], waitlist: ['C'], owed: [] },
  },
  {
    name: 'a party of 3 is never split across 2 free seats (AC-HAPPY-3)',
    capacity: 4,
    confirmed: [p('A', 1), p('B', 1)],
    waitlist: [],
    request: { kind: 'register', name: 'C', size: 3 },
    expected: { confirmed: ['A', 'B'], waitlist: ['C'], owed: [] },
  },
  {
    name: 'a late registrant queues behind the existing waitlist (AC-HAPPY-3)',
    capacity: 10,
    confirmed: [p('A', 3), p('B', 3), p('C', 3)],
    waitlist: [p('W', 2), p('X', 2)],
    request: { kind: 'register', name: 'N', size: 2 },
    expected: { confirmed: ['A', 'B', 'C'], waitlist: ['W', 'X', 'N'], owed: [] },
  },
  {
    name: 'a party that can never fit is refused (AC-ERROR-4)',
    capacity: 2,
    confirmed: [],
    waitlist: [],
    request: { kind: 'register', name: 'C', size: 3 },
    expected: { refused: 'party_exceeds_capacity', confirmed: [], waitlist: [], owed: [] },
  },
  {
    name: 'a session with no public places refuses everyone',
    capacity: 0,
    confirmed: [],
    waitlist: [],
    request: { kind: 'register', name: 'C', size: 1 },
    expected: { refused: 'party_exceeds_capacity', confirmed: [], waitlist: [], owed: [] },
  },
  {
    name: 'a newcomer that fits takes the seat ahead of a larger waitlisted head',
    capacity: 4,
    confirmed: [p('A', 3)],
    waitlist: [p('H', 3)],
    request: { kind: 'register', name: 'N', size: 1 },
    expected: { confirmed: ['A', 'N'], waitlist: ['H'], owed: [] },
  },
  {
    name: 'a register heals a state where a waitlisted party fits (the newcomer goes behind)',
    capacity: 4,
    confirmed: [p('A', 3)],
    waitlist: [p('H', 1)],
    request: { kind: 'register', name: 'N', size: 1 },
    expected: { confirmed: ['A', 'H'], waitlist: ['N'], owed: [] },
  },
  {
    name: 'an early withdrawal promotes the waitlist in FIFO order (AC-HAPPY-4)',
    capacity: 3,
    confirmed: [p('A', 1), p('B', 1), p('C', 1)],
    waitlist: [p('X', 1), p('Y', 1)],
    request: { kind: 'withdraw', name: 'A', withdrawalKind: 'EARLY' },
    expected: { confirmed: ['B', 'C', 'X'], waitlist: ['Y'], owed: [] },
  },
  {
    name: 'first-fit passes a head that does not fit and promotes the next that does (AC-HAPPY-9)',
    capacity: 4,
    confirmed: [p('A', 1), p('B', 1), p('C', 1), p('D', 1)],
    waitlist: [p('H', 3), p('M', 1), p('N', 1)],
    request: { kind: 'withdraw', name: 'A', withdrawalKind: 'EARLY' },
    expected: { confirmed: ['B', 'C', 'D', 'M'], waitlist: ['H', 'N'], owed: [] },
  },
  {
    name: 'three freed seats go to the head of the queue first (AC-HAPPY-9)',
    capacity: 3,
    confirmed: [p('A', 3)],
    waitlist: [p('H', 3), p('M', 1)],
    request: { kind: 'withdraw', name: 'A', withdrawalKind: 'EARLY' },
    expected: { confirmed: ['H'], waitlist: ['M'], owed: [] },
  },
  {
    name: 'a late withdrawal with a waiting party hands the fee to the promoted party (AC-HAPPY-5)',
    capacity: 2,
    confirmed: [p('A', 1), p('B', 1)],
    waitlist: [p('X', 1)],
    request: { kind: 'withdraw', name: 'A', withdrawalKind: 'LATE' },
    expected: { confirmed: ['B', 'X'], waitlist: [], owed: [] },
  },
  {
    name: 'a late withdrawal with an empty waitlist leaves the withdrawer owing (AC-HAPPY-6)',
    capacity: 3,
    confirmed: [p('A', 3)],
    waitlist: [],
    request: { kind: 'withdraw', name: 'A', withdrawalKind: 'LATE' },
    expected: { confirmed: [], waitlist: [], owed: ['A'] },
  },
  {
    name: 'a late withdrawal where only larger parties wait leaves the withdrawer owing (AC-HAPPY-6)',
    capacity: 3,
    confirmed: [p('A', 1), p('B', 1), p('C', 1)],
    waitlist: [p('H', 3)],
    request: { kind: 'withdraw', name: 'A', withdrawalKind: 'LATE' },
    expected: { confirmed: ['B', 'C'], waitlist: ['H'], owed: ['A'] },
  },
  {
    name: 'a party of 3 refilled by a single is not liable (algorithm Q3a)',
    capacity: 3,
    confirmed: [p('A', 3)],
    waitlist: [p('X', 1)],
    request: { kind: 'withdraw', name: 'A', withdrawalKind: 'LATE' },
    expected: { confirmed: ['X'], waitlist: [], owed: [] },
  },
  {
    name: 'leaving the waitlist late is free and keeps the order (AC-HAPPY-7)',
    capacity: 1,
    confirmed: [p('A', 1)],
    waitlist: [p('X', 1), p('Y', 1), p('Z', 1)],
    request: { kind: 'withdraw', name: 'Y', withdrawalKind: 'LATE' },
    expected: { confirmed: ['A'], waitlist: ['X', 'Z'], owed: [] },
  },
  {
    name: 'a ban withdrawal promotes the waitlist and is never liable',
    capacity: 1,
    confirmed: [p('A', 1)],
    waitlist: [p('X', 1)],
    request: { kind: 'withdraw', name: 'A', withdrawalKind: 'BANNED' },
    expected: { confirmed: ['X'], waitlist: [], owed: [] },
  },
  {
    name: 'a ban withdrawal with nobody waiting is not liable',
    capacity: 1,
    confirmed: [p('A', 1)],
    waitlist: [],
    request: { kind: 'withdraw', name: 'A', withdrawalKind: 'BANNED' },
    expected: { confirmed: [], waitlist: [], owed: [] },
  },
  {
    name: 'a confirmed newcomer releases the oldest owed fee first (R2)',
    capacity: 3,
    confirmed: [],
    waitlist: [],
    owed: [p('P', 1), p('Q', 1)],
    request: { kind: 'register', name: 'N', size: 1 },
    expected: { confirmed: ['N'], waitlist: [], owed: ['Q'] },
  },
  {
    name: 'a newcomer of 3 releases three owed singles (R2)',
    capacity: 3,
    confirmed: [],
    waitlist: [],
    owed: [p('P', 1), p('Q', 1), p('R', 1)],
    request: { kind: 'register', name: 'N', size: 3 },
    expected: { confirmed: ['N'], waitlist: [], owed: [] },
  },
  {
    name: 'a newcomer of 1 releases an owed party of 3 whole (rounding favours the player)',
    capacity: 3,
    confirmed: [],
    waitlist: [],
    owed: [p('P', 3)],
    request: { kind: 'register', name: 'N', size: 1 },
    expected: { confirmed: ['N'], waitlist: [], owed: [] },
  },
  {
    name: 'a waitlisted newcomer releases nothing (R2)',
    capacity: 1,
    confirmed: [p('A', 1)],
    waitlist: [],
    owed: [p('P', 1)],
    request: { kind: 'register', name: 'N', size: 1 },
    expected: { confirmed: ['A'], waitlist: ['N'], owed: ['P'] },
  },
  {
    name: 'two late withdrawals: the second promotes the party of 2 and releases the first (AC-INTEGRATION-1c)',
    capacity: 2,
    confirmed: [p('B', 1)],
    waitlist: [p('W', 2)],
    owed: [p('A', 1)],
    request: { kind: 'withdraw', name: 'B', withdrawalKind: 'LATE' },
    expected: { confirmed: ['W'], waitlist: [], owed: [] },
  },
  {
    name: 'a capacity raise promotes first-fit (rebalance)',
    capacity: 4,
    confirmed: [p('A', 1), p('B', 1)],
    waitlist: [p('H', 3), p('M', 1), p('N', 1)],
    request: { kind: 'rebalance' },
    expected: { confirmed: ['A', 'B', 'M', 'N'], waitlist: ['H'], owed: [] },
  },
  {
    name: 'a capacity cut demotes nobody and promotes nobody (rebalance)',
    capacity: 1,
    confirmed: [p('A', 1), p('B', 1)],
    waitlist: [p('X', 1)],
    request: { kind: 'rebalance' },
    expected: { confirmed: ['A', 'B'], waitlist: ['X'], owed: [] },
  },
  {
    name: 'a promotion by capacity edit releases an owed fee (R2)',
    capacity: 3,
    confirmed: [p('A', 1)],
    waitlist: [p('X', 1)],
    owed: [p('P', 2)],
    request: { kind: 'rebalance' },
    expected: { confirmed: ['A', 'X'], waitlist: [], owed: [] },
  },
  {
    name: 're-registering an owed fee into a confirmed place at least as large takes the place over (R3)',
    capacity: 4,
    confirmed: [p('A', 1)],
    waitlist: [],
    owed: [p('P', 2)],
    request: { kind: 'register', name: 'P', size: 3 },
    expected: { confirmed: ['A', 'P'], waitlist: [], owed: [] },
  },
  {
    name: 're-registering an owed fee onto the waitlist is refused (R3)',
    capacity: 1,
    confirmed: [p('A', 1)],
    waitlist: [],
    owed: [p('P', 1)],
    request: { kind: 'register', name: 'P', size: 1 },
    expected: { refused: 'late_withdrawal_fee_due', confirmed: ['A'], waitlist: [], owed: ['P'] },
  },
  {
    name: 're-registering an owed fee with a smaller group is refused (R3)',
    capacity: 4,
    confirmed: [],
    waitlist: [],
    owed: [p('P', 2)],
    request: { kind: 'register', name: 'P', size: 1 },
    expected: { refused: 'late_withdrawal_fee_due', confirmed: [], waitlist: [], owed: ['P'] },
  },
  {
    name: 'registering twice is refused (AC-ERROR-3)',
    capacity: 4,
    confirmed: [p('A', 1)],
    waitlist: [],
    request: { kind: 'register', name: 'A', size: 1 },
    expected: { refused: 'already_registered', confirmed: ['A'], waitlist: [], owed: [] },
  },
  {
    name: 'withdrawing without an active registration is refused (AC-ERROR-6)',
    capacity: 4,
    confirmed: [p('A', 1)],
    waitlist: [],
    request: { kind: 'withdraw', name: 'Z', withdrawalKind: 'EARLY' },
    expected: { refused: 'not_registered', confirmed: ['A'], waitlist: [], owed: [] },
  },
  {
    name: 'a late withdrawal from an over-capacity session frees no seat and is owed',
    capacity: 1,
    confirmed: [p('A', 1), p('B', 1)],
    waitlist: [p('X', 1)],
    request: { kind: 'withdraw', name: 'A', withdrawalKind: 'LATE' },
    expected: { confirmed: ['B'], waitlist: ['X'], owed: ['A'] },
  },
];

// ---------------------------------------------------------------------------------------------
// Pure helpers shared by the unit test and the integration seeding
// ---------------------------------------------------------------------------------------------

/** The `decideAllocation` input for a scenario: ids are party names; a re-registering owed party is excluded from the liabilities. */
export function toAllocationInput(scenario: MatrixScenario): AllocationInput {
  const owed = scenario.owed ?? [];
  const toRef = (party: MatrixParty): PartyRef => ({
    registrationId: party.name,
    partySize: party.size,
  });
  const request = scenario.request;
  let decisionRequest: AllocationInput['request'];
  let liabilities = owed;
  if (request.kind === 'register') {
    const prior = owed.find((party) => party.name === request.name);
    decisionRequest = {
      kind: 'register',
      registrationId: request.name,
      partySize: request.size,
      liablePriorPartySize: prior?.size ?? null,
    };
    liabilities = owed.filter((party) => party.name !== request.name);
  } else if (request.kind === 'withdraw') {
    decisionRequest = {
      kind: 'withdraw',
      registrationId: request.name,
      withdrawalKind: request.withdrawalKind,
    };
  } else {
    decisionRequest = { kind: 'rebalance' };
  }
  return {
    publicCapacity: scenario.capacity,
    confirmedParties: scenario.confirmed.map(toRef),
    waitlist: scenario.waitlist.map((party, index) => ({
      ...toRef(party),
      queuePosition: index + 1,
    })),
    openLiabilities: liabilities.map(toRef),
    request: decisionRequest,
  };
}

/** The state a scenario ends in when `decision` is applied (the refusal leaves it unchanged). */
export function outcomeOf(scenario: MatrixScenario, decision: AllocationDecision): MatrixOutcome {
  if (decision.outcome === 'refused') {
    return {
      refused: decision.reason,
      confirmed: scenario.confirmed.map((party) => party.name).sort(),
      waitlist: scenario.waitlist.map((party) => party.name),
      owed: (scenario.owed ?? []).map((party) => party.name),
    };
  }
  const confirmed = new Set(scenario.confirmed.map((party) => party.name));
  let waitlist = scenario.waitlist.map((party) => party.name);
  let owed = (scenario.owed ?? []).map((party) => party.name);
  if (decision.withdrawn !== null) {
    confirmed.delete(decision.withdrawn.registrationId);
    waitlist = waitlist.filter((name) => name !== decision.withdrawn?.registrationId);
    if (decision.withdrawn.feeDue) owed = [...owed, decision.withdrawn.registrationId];
  }
  for (const promotion of decision.promotions) {
    confirmed.add(promotion.registrationId);
    waitlist = waitlist.filter((name) => name !== promotion.registrationId);
  }
  if (decision.newcomer !== null) {
    if (decision.newcomer.status === 'CONFIRMED') confirmed.add(decision.newcomer.registrationId);
    else waitlist = [...waitlist, decision.newcomer.registrationId];
    // A re-registering owed row stops being owed whether it is confirmed or refused earlier.
    owed = owed.filter((name) => name !== decision.newcomer?.registrationId);
  }
  owed = owed.filter((name) => !decision.releasedLiabilities.includes(name));
  return { confirmed: [...confirmed].sort(), waitlist, owed };
}
