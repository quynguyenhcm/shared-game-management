/**
 * AC-VERIFY-4 as a property test (algorithm doc invariants I1-I13). No dependency: a seeded mulberry32 PRNG drives random
 * sequences of registers (re-registrations of withdrawn rows included), withdrawals of every kind, and capacity raises
 * and cuts followed by a rebalance. The model state advances ONLY through `decideAllocation`; after every applied step the
 * invariants are recomputed from the model. A failure prints the seed; `ALLOCATOR_PROPERTY_SEED` re-runs one sequence.
 */
import { describe, expect, it } from 'vitest';
import {
  decideAllocation,
  type AllocationDecision,
  type PartySize,
  type WithdrawalKind,
} from './allocation.ts';
import { canTransition } from './transitions.ts';

function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

type Status = 'CONFIRMED' | 'WAITLISTED' | 'WITHDRAWN';
interface Row {
  id: string;
  size: PartySize;
  status: Status;
  position: number | null;
  owed: boolean;
  withdrawnAt: number;
}

interface Model {
  capacity: number;
  rows: Map<string, Row>;
  tick: number;
  everCut: boolean;
}

const taken = (model: Model): number =>
  [...model.rows.values()].filter((r) => r.status === 'CONFIRMED').reduce((s, r) => s + r.size, 0);
const waitlist = (model: Model): Row[] =>
  [...model.rows.values()]
    .filter((r) => r.status === 'WAITLISTED')
    .sort((a, b) => (a.position ?? 0) - (b.position ?? 0));
const owedRows = (model: Model): Row[] =>
  [...model.rows.values()]
    .filter((r) => r.status === 'WITHDRAWN' && r.owed)
    .sort((a, b) => a.withdrawnAt - b.withdrawnAt || a.id.localeCompare(b.id));

type Step =
  | { kind: 'register'; id: string; size: PartySize }
  | { kind: 'withdraw'; id: string; withdrawalKind: WithdrawalKind }
  | { kind: 'rebalance' };

function decide(model: Model, step: Step): AllocationDecision {
  let liabilities = owedRows(model);
  let request;
  if (step.kind === 'register') {
    const own = model.rows.get(step.id);
    const prior = own?.status === 'WITHDRAWN' && own.owed ? own.size : null;
    liabilities = liabilities.filter((r) => r.id !== step.id);
    request = {
      kind: 'register' as const,
      registrationId: step.id,
      partySize: step.size,
      liablePriorPartySize: prior,
    };
  } else if (step.kind === 'withdraw') {
    request = {
      kind: 'withdraw' as const,
      registrationId: step.id,
      withdrawalKind: step.withdrawalKind,
    };
  } else {
    request = { kind: 'rebalance' as const };
  }
  return decideAllocation({
    publicCapacity: model.capacity,
    confirmedParties: [...model.rows.values()]
      .filter((r) => r.status === 'CONFIRMED')
      .map((r) => ({ registrationId: r.id, partySize: r.size })),
    waitlist: waitlist(model).map((r) => ({
      registrationId: r.id,
      partySize: r.size,
      queuePosition: r.position ?? 0,
    })),
    openLiabilities: liabilities.map((r) => ({ registrationId: r.id, partySize: r.size })),
    request,
  });
}

function move(row: Row, to: Status): void {
  if (row.status !== to) expect(canTransition(row.status, to), `${row.status} -> ${to}`).toBe(true);
  row.status = to;
}

/** Applies an applied decision to the model the way the allocator applies it to the rows. */
function apply(
  model: Model,
  step: Step,
  decision: Extract<AllocationDecision, { outcome: 'applied' }>,
): void {
  model.tick += 1;
  if (decision.withdrawn !== null) {
    const row = model.rows.get(decision.withdrawn.registrationId);
    if (row === undefined) throw new Error('withdrew an unknown row');
    move(row, 'WITHDRAWN');
    row.position = null;
    row.owed = decision.withdrawn.feeDue;
    row.withdrawnAt = model.tick;
  }
  for (const promotion of decision.promotions) {
    const row = model.rows.get(promotion.registrationId);
    if (row === undefined) throw new Error('promoted an unknown row');
    move(row, 'CONFIRMED');
    row.position = null;
  }
  if (decision.newcomer !== null) {
    const size = step.kind === 'register' ? step.size : 1;
    const existing = model.rows.get(decision.newcomer.registrationId);
    const row: Row = existing ?? {
      id: decision.newcomer.registrationId,
      size,
      status: 'WITHDRAWN',
      position: null,
      owed: false,
      withdrawnAt: 0,
    };
    if (existing === undefined) {
      // A brand-new row is inserted directly in its first status.
      row.status = decision.newcomer.status;
      model.rows.set(row.id, row);
    } else {
      move(row, decision.newcomer.status);
    }
    row.size = size;
    row.owed = false;
    row.position =
      decision.newcomer.status === 'WAITLISTED' ? decision.newcomer.queuePosition : null;
  }
  for (const id of decision.releasedLiabilities) {
    const row = model.rows.get(id);
    if (row === undefined || !row.owed) throw new Error('released a row that was not owed');
    row.owed = false;
  }
}

/** The reference first-fit: what a scan of `queue` with `free` seats must promote. */
function referenceFirstFit(queue: { id: string; size: number }[], free: number): string[] {
  const out: string[] = [];
  for (const entry of queue) {
    if (free < 1) break;
    if (entry.size <= free) {
      out.push(entry.id);
      free -= entry.size;
    }
  }
  return out;
}

function randomSize(random: () => number): PartySize {
  const roll = random();
  return roll < 0.6 ? 1 : roll < 0.85 ? 2 : 3;
}

interface Stats {
  confirmedNewcomers: number;
  waitlistedNewcomers: number;
  promotions: number;
  feeDue: number;
  released: number;
  refused: number;
  cuts: number;
}

/** What a first-fit scan must do for `step`, computed from the model BEFORE the decision (the reference implementation). */
function reference(
  model: Model,
  step: Step,
): { promoted: string[]; newcomerConfirmed: boolean | null } {
  const queue = waitlist(model).map((r) => ({ id: r.id, size: r.size }));
  let free = model.capacity - taken(model);
  if (step.kind === 'withdraw') {
    const row = model.rows.get(step.id);
    if (row?.status === 'CONFIRMED') free += row.size;
    const rest = queue.filter((entry) => entry.id !== step.id);
    return { promoted: referenceFirstFit(rest, free), newcomerConfirmed: null };
  }
  if (step.kind === 'register') {
    const scanned = referenceFirstFit([...queue, { id: '__tail__', size: step.size }], free);
    return {
      promoted: scanned.filter((id) => id !== '__tail__'),
      newcomerConfirmed: scanned.includes('__tail__'),
    };
  }
  return { promoted: referenceFirstFit(queue, free), newcomerConfirmed: null };
}

function runSequence(seed: number, steps: number, stats: Stats): void {
  const random = mulberry32(seed);
  const model: Model = {
    capacity: Math.floor(random() * 13),
    rows: new Map(),
    tick: 0,
    everCut: false,
  };
  let nextId = 0;
  const fail = (message: string): never => {
    throw new Error(`seed ${seed}: ${message}`);
  };

  for (let index = 0; index < steps; index += 1) {
    const roll = random();
    const rows = [...model.rows.values()];
    let step: Step;
    if (roll < 0.1) {
      // A capacity change, then the rebalance a real capacity edit triggers.
      const raise = random() < 0.5;
      const delta = 1 + Math.floor(random() * 3);
      if (raise) model.capacity += delta;
      else {
        model.capacity = Math.max(0, model.capacity - delta);
        model.everCut = true;
        stats.cuts += 1;
      }
      step = { kind: 'rebalance' };
    } else if (roll < 0.55) {
      const withdrawn = rows.filter((r) => r.status === 'WITHDRAWN');
      const again = withdrawn.length > 0 && random() < 0.3;
      const id = again
        ? (withdrawn[Math.floor(random() * withdrawn.length)] as Row).id
        : `r${(nextId += 1)}`;
      step = { kind: 'register', id, size: randomSize(random) };
    } else {
      const active = rows.filter((r) => r.status !== 'WITHDRAWN');
      if (active.length === 0) continue;
      const kinds: WithdrawalKind[] = ['EARLY', 'LATE', 'BANNED'];
      step = {
        kind: 'withdraw',
        id: (active[Math.floor(random() * active.length)] as Row).id,
        withdrawalKind: kinds[Math.floor(random() * 3)] as WithdrawalKind,
      };
    }

    const takenBefore = taken(model);
    const queueBefore = waitlist(model);
    const snapshot = JSON.stringify([...model.rows.values()]);
    const expected = reference(model, step);
    const decision = decide(model, step);
    if (JSON.stringify(decision) !== JSON.stringify(decide(model, step)))
      fail('I13 decideAllocation is not deterministic');

    if (decision.outcome === 'refused') {
      stats.refused += 1;
      if (JSON.stringify([...model.rows.values()]) !== snapshot)
        fail('I12 a refusal changed state');
      continue;
    }

    // I6 promotions are ascending and exactly the reference first-fit; I8 the newcomer is the tail of the same scan.
    const promotedIds = decision.promotions.map((one) => one.registrationId);
    for (let at = 1; at < decision.promotions.length; at += 1) {
      if (
        (decision.promotions[at]?.fromQueuePosition ?? 0) <=
        (decision.promotions[at - 1]?.fromQueuePosition ?? 0)
      )
        fail('I6 promotions out of order');
    }
    if (JSON.stringify(promotedIds) !== JSON.stringify(expected.promoted))
      fail(`I6 promotions ${promotedIds.join(',')} != first-fit ${expected.promoted.join(',')}`);
    if (expected.newcomerConfirmed !== null && decision.newcomer !== null) {
      if ((decision.newcomer.status === 'CONFIRMED') !== expected.newcomerConfirmed)
        fail('I8 newcomer placement');
    }

    apply(model, step, decision);
    const takenAfter = taken(model);
    const queueAfter = waitlist(model);
    const free = model.capacity - takenAfter;
    stats.promotions += promotedIds.length;
    stats.released += decision.releasedLiabilities.length;
    if (decision.withdrawn?.feeDue === true) stats.feeDue += 1;
    if (decision.newcomer?.status === 'CONFIRMED') stats.confirmedNewcomers += 1;
    if (decision.newcomer?.status === 'WAITLISTED') stats.waitlistedNewcomers += 1;

    // I1 capacity: a step never pushes seats taken above max(capacity, taken before).
    if (takenAfter > Math.max(model.capacity, takenBefore)) fail('I1 seats taken exceed capacity');
    // I2 seat accounting.
    if (decision.seatsTaken !== takenAfter)
      fail(`I2 seatsTaken ${decision.seatsTaken} != ${takenAfter}`);
    if (decision.seatsLeft !== Math.max(0, free)) fail('I2 seatsLeft');
    // I4 queue positions unique and >= 1; survivors keep theirs; a newcomer is behind everyone.
    const positions = queueAfter.map((r) => r.position ?? 0);
    if (new Set(positions).size !== positions.length || positions.some((pos) => pos < 1))
      fail('I4 positions');
    for (const survivor of queueAfter) {
      const was = queueBefore.find((r) => r.id === survivor.id);
      if (was !== undefined && was.position !== survivor.position)
        fail('I4 a position was renumbered');
      if (
        was === undefined &&
        queueBefore.some((r) => (r.position ?? 0) >= (survivor.position ?? 0))
      )
        fail('I4 a newcomer is not behind the existing queue');
    }
    // I5 first-fit maximality.
    for (const waiting of queueAfter) {
      if (waiting.size <= free)
        fail(`I5 waitlisted ${waiting.id} (${waiting.size}) fits ${free} free seats`);
    }
    // I9 liability creation: fee due iff LATE from CONFIRMED with nobody promoted.
    if (decision.withdrawn !== null) {
      const feeDue =
        decision.withdrawn.kind === 'LATE' &&
        decision.withdrawn.fromStatus === 'CONFIRMED' &&
        decision.promotions.length === 0;
      if (decision.withdrawn.feeDue !== feeDue) fail('I9 fee-due rule');
    }
    // I11 never charge twice (until a capacity cut can strand a liability).
    if (!model.everCut) {
      const liable = owedRows(model).reduce((sum, r) => sum + r.size, 0);
      if (liable > free) fail(`I11 owed seats ${liable} exceed free seats ${free}`);
    }
  }
}

describe('decideAllocation properties (AC-VERIFY-4, invariants I1-I13)', () => {
  const pinned = process.env.ALLOCATOR_PROPERTY_SEED;
  const fresh = (): Stats => ({
    confirmedNewcomers: 0,
    waitlistedNewcomers: 0,
    promotions: 0,
    feeDue: 0,
    released: 0,
    refused: 0,
    cuts: 0,
  });

  it('holds on 400 random sequences of up to 60 steps, and the generator reaches every rule', () => {
    const stats = fresh();
    if (pinned !== undefined) {
      runSequence(Number(pinned), 60, stats);
      return;
    }
    for (let seed = 1; seed <= 400; seed += 1) runSequence(seed, 60, stats);
    // Not vacuous: every branch of the decision was exercised.
    expect(stats.confirmedNewcomers).toBeGreaterThan(0);
    expect(stats.waitlistedNewcomers).toBeGreaterThan(0);
    expect(stats.promotions).toBeGreaterThan(0);
    expect(stats.feeDue).toBeGreaterThan(0);
    expect(stats.released).toBeGreaterThan(0);
    expect(stats.refused).toBeGreaterThan(0);
    expect(stats.cuts).toBeGreaterThan(0);
  });
});
