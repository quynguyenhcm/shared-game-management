/**
 * The pure seat decision (algorithm doc Q1/Q3; R1, R2). No I/O and no clock: every seat-changing path (register,
 * withdraw, ban withdrawal, capacity change, auto-enrol) feeds the locked session's state in and applies the result.
 */
export type PartySize = 1 | 2 | 3;
export type WithdrawalKind = 'EARLY' | 'LATE' | 'BANNED';

export interface PartyRef {
  readonly registrationId: string;
  readonly partySize: PartySize;
}
export interface WaitlistEntry extends PartyRef {
  readonly queuePosition: number;
  /**
   * False for a member who can no longer take a seat (banned, the ban handler has not withdrawn them yet). Default true. An
   * ineligible entry is never promoted, but it keeps its queue position, still counts toward the tail and can be withdrawn.
   */
  readonly eligible?: boolean;
}

export type AllocationRequest =
  | {
      readonly kind: 'register';
      readonly registrationId: string;
      readonly partySize: PartySize;
      /** Set iff the row being re-registered is WITHDRAWN with `withdrawal_fee_due` (R3). */
      readonly liablePriorPartySize: PartySize | null;
    }
  | {
      readonly kind: 'withdraw';
      readonly registrationId: string;
      readonly withdrawalKind: WithdrawalKind;
    }
  | { readonly kind: 'rebalance' };

export interface AllocationInput {
  readonly publicCapacity: number;
  readonly confirmedParties: readonly PartyRef[];
  readonly waitlist: readonly WaitlistEntry[];
  /** Owed late withdrawals, oldest first. The caller excludes a row that is itself re-registering. */
  readonly openLiabilities: readonly PartyRef[];
  readonly request: AllocationRequest;
  /** False at or after `starts_at`: no promotion and no release (R1, R2). Default true. */
  readonly promotionsOpen?: boolean;
}

export type AllocationRefusal =
  'already_registered' | 'not_registered' | 'party_exceeds_capacity' | 'late_withdrawal_fee_due';

export type Newcomer =
  | { readonly registrationId: string; readonly status: 'CONFIRMED' }
  | {
      readonly registrationId: string;
      readonly status: 'WAITLISTED';
      readonly queuePosition: number;
    };

export interface Promotion extends PartyRef {
  readonly fromQueuePosition: number;
}

export type AllocationDecision =
  | { readonly outcome: 'refused'; readonly reason: AllocationRefusal }
  | {
      readonly outcome: 'applied';
      readonly newcomer: Newcomer | null;
      readonly withdrawn: {
        readonly registrationId: string;
        readonly fromStatus: 'CONFIRMED' | 'WAITLISTED';
        readonly kind: WithdrawalKind;
        readonly feeDue: boolean;
      } | null;
      readonly promotions: readonly Promotion[];
      readonly releasedLiabilities: readonly string[];
      readonly seatsTaken: number;
      readonly seatsLeft: number;
    };

const PARTY_SIZES: ReadonlySet<number> = new Set([1, 2, 3]);

/** A programming error (malformed state from a caller): the transaction rolls back and the database would refuse it too. */
function validate(input: AllocationInput): void {
  if (!Number.isInteger(input.publicCapacity) || input.publicCapacity < 0) {
    throw new Error('publicCapacity must be a non-negative integer');
  }
  const ids = new Set<string>();
  const positions = new Set<number>();
  const seen = (party: PartyRef): void => {
    if (!PARTY_SIZES.has(party.partySize)) throw new Error('partySize must be 1, 2 or 3');
    if (ids.has(party.registrationId))
      throw new Error(`duplicate registration ${party.registrationId}`);
    ids.add(party.registrationId);
  };
  input.confirmedParties.forEach(seen);
  input.openLiabilities.forEach(seen);
  for (const entry of input.waitlist) {
    seen(entry);
    if (!Number.isInteger(entry.queuePosition) || entry.queuePosition < 1) {
      throw new Error('queuePosition must be an integer of at least 1');
    }
    if (positions.has(entry.queuePosition))
      throw new Error(`duplicate queue position ${entry.queuePosition}`);
    positions.add(entry.queuePosition);
  }
  const { request } = input;
  if (request.kind === 'register' && !PARTY_SIZES.has(request.partySize)) {
    throw new Error('partySize must be 1, 2 or 3');
  }
}

/**
 * First-fit (R1): scan `queue` in order with a seat budget; every party that fits is taken and the budget shrinks.
 * A party that does not fit is skipped and keeps its place.
 */
function firstFit<T extends PartyRef & { readonly eligible?: boolean }>(
  queue: readonly T[],
  free: number,
): T[] {
  const taken: T[] = [];
  let budget = free;
  for (const entry of queue) {
    if (budget < 1) break;
    if (entry.partySize <= budget && entry.eligible !== false) {
      taken.push(entry);
      budget -= entry.partySize;
    }
  }
  return taken;
}

/**
 * R2: owed late withdrawals are released oldest first, each whole, while the seat budget (the seats just confirmed)
 * is still positive, so rounding favours the player.
 */
function release(liabilities: readonly PartyRef[], seatsConfirmed: number): string[] {
  const out: string[] = [];
  let budget = seatsConfirmed;
  for (const liability of liabilities) {
    if (budget <= 0) break;
    out.push(liability.registrationId);
    budget -= liability.partySize;
  }
  return out;
}

const sum = (parties: readonly PartyRef[]): number =>
  parties.reduce((total, party) => total + party.partySize, 0);

export function decideAllocation(input: AllocationInput): AllocationDecision {
  validate(input);
  const { publicCapacity, request } = input;
  const open = input.promotionsOpen ?? true;
  const queue = [...input.waitlist].sort((a, b) => a.queuePosition - b.queuePosition);
  const confirmed = input.confirmedParties;
  let taken = sum(confirmed);
  const maxPosition = queue[queue.length - 1]?.queuePosition ?? 0;
  const done = (decision: {
    newcomer: Newcomer | null;
    withdrawn: Extract<AllocationDecision, { outcome: 'applied' }>['withdrawn'];
    promotions: readonly Promotion[];
    released: readonly string[];
  }): AllocationDecision => ({
    outcome: 'applied',
    newcomer: decision.newcomer,
    withdrawn: decision.withdrawn,
    promotions: decision.promotions,
    releasedLiabilities: decision.released,
    seatsTaken: taken,
    seatsLeft: Math.max(0, publicCapacity - taken),
  });
  const asPromotions = (entries: readonly WaitlistEntry[]): Promotion[] =>
    entries.map((entry) => ({
      registrationId: entry.registrationId,
      partySize: entry.partySize,
      fromQueuePosition: entry.queuePosition,
    }));

  if (request.kind === 'register') {
    if (
      confirmed.some((one) => one.registrationId === request.registrationId) ||
      queue.some((one) => one.registrationId === request.registrationId)
    ) {
      return { outcome: 'refused', reason: 'already_registered' };
    }
    if (request.partySize > publicCapacity)
      return { outcome: 'refused', reason: 'party_exceeds_capacity' };
    // The newcomer is the tail of the same scan, so a state left inconsistent by a path outside this module heals first.
    const tail: WaitlistEntry = {
      registrationId: request.registrationId,
      partySize: request.partySize,
      queuePosition: Number.POSITIVE_INFINITY,
    };
    const scanned = open ? firstFit([...queue, tail], publicCapacity - taken) : [];
    const confirmedNewcomer = scanned.includes(tail);
    if (
      request.liablePriorPartySize !== null &&
      (!confirmedNewcomer || request.partySize < request.liablePriorPartySize)
    ) {
      return { outcome: 'refused', reason: 'late_withdrawal_fee_due' };
    }
    const promoted = scanned.filter((entry) => entry !== tail);
    const seatsConfirmed = sum(scanned);
    taken += seatsConfirmed;
    // A liable re-registrant clears its own fee by taking over its prior seats, so those seats cannot also release
    // another owed fee; extra seats and simultaneous promotions still count.
    const budget = confirmedNewcomer
      ? Math.max(0, seatsConfirmed - (request.liablePriorPartySize ?? 0))
      : seatsConfirmed;
    return done({
      newcomer: confirmedNewcomer
        ? { registrationId: request.registrationId, status: 'CONFIRMED' }
        : {
            registrationId: request.registrationId,
            status: 'WAITLISTED',
            queuePosition: maxPosition + 1,
          },
      withdrawn: null,
      promotions: asPromotions(promoted),
      released: open ? release(input.openLiabilities, budget) : [],
    });
  }

  if (request.kind === 'withdraw') {
    const asConfirmed = confirmed.find((one) => one.registrationId === request.registrationId);
    const asWaiting = queue.find((one) => one.registrationId === request.registrationId);
    if (asConfirmed === undefined && asWaiting === undefined) {
      return { outcome: 'refused', reason: 'not_registered' };
    }
    const fromStatus = asConfirmed === undefined ? 'WAITLISTED' : 'CONFIRMED';
    const leaving = asConfirmed ?? asWaiting;
    const leavingSize = leaving?.partySize ?? 1;
    const rest = queue.filter((one) => one.registrationId !== request.registrationId);
    if (asConfirmed !== undefined) taken -= asConfirmed.partySize;
    const promoted = open ? firstFit(rest, publicCapacity - taken) : [];
    const seatsConfirmed = sum(promoted);
    taken += seatsConfirmed;
    // R2: only a LATE withdrawal of a CONFIRMED party can owe, and only when its own step promoted nobody.
    const liableKind = request.withdrawalKind === 'LATE' && fromStatus === 'CONFIRMED';
    const feeDue = liableKind && seatsConfirmed === 0;
    // The current withdrawer is first in line for its own step's budget; the rest releases older owed fees.
    const budget = liableKind ? seatsConfirmed - leavingSize : seatsConfirmed;
    return done({
      newcomer: null,
      withdrawn: {
        registrationId: request.registrationId,
        fromStatus,
        kind: request.withdrawalKind,
        feeDue,
      },
      promotions: asPromotions(promoted),
      released: open ? release(input.openLiabilities, budget) : [],
    });
  }

  const promoted = open ? firstFit(queue, publicCapacity - taken) : [];
  const seatsConfirmed = sum(promoted);
  taken += seatsConfirmed;
  return done({
    newcomer: null,
    withdrawn: null,
    promotions: asPromotions(promoted),
    released: open ? release(input.openLiabilities, seatsConfirmed) : [],
  });
}
