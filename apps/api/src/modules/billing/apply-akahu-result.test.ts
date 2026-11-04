/**
 * The pure decision table of the single apply funnel (algorithm doc E/T3, CR-2, CR-3, CR-25, CR-27, B3). Table-driven: local
 * intent state x fresh provider outcome x (amount matches, absorbable) -> one decision. Database effects are proved in
 * `test/integration/akahu-apply.int.test.ts`.
 */
import { describe, expect, it } from 'vitest';
import { parseMoney } from '@sgm/shared';
import type { GatewayOutcome } from '../../lib/akahu/gateway.ts';
import { mapAkahuStatus } from '../../lib/akahu/status.ts';
import {
  decideApply,
  decideResolution,
  mirrorRank,
  type ApplyDecision,
  type ApplyFacts,
  type IntentKind,
  type IntentStatus,
  type ResolutionFacts,
} from './apply-akahu-result.ts';

const view = (status: string, reason: string | null = null) => ({
  outcome: mapAkahuStatus(status, reason),
  providerStatus: status,
});

const facts = (
  kind: IntentKind,
  status: IntentStatus,
  provider: { outcome: GatewayOutcome; providerStatus: string },
  options: { mirror?: string | null; amountMatches?: boolean; absorbable?: boolean } = {},
): ApplyFacts => ({
  kind,
  status,
  mirror: options.mirror === undefined ? 'READY' : options.mirror,
  view: provider,
  amountMatches: options.amountMatches ?? true,
  absorbable: options.absorbable ?? true,
});

describe('decideApply: SENT (CR-2, B3)', () => {
  it.each<[IntentKind, IntentStatus, boolean, boolean, ApplyDecision]>([
    // local, amount matches, absorbable -> decision
    ['TOP_UP', 'OPEN', true, true, { kind: 'APPLY' }],
    ['ATTEMPT', 'OPEN', true, true, { kind: 'APPLY' }],
    ['TOP_UP', 'OPEN', true, false, { kind: 'UNAPPLY', reason: 'OVER_CAP' }],
    ['ATTEMPT', 'OPEN', true, false, { kind: 'UNAPPLY', reason: 'DUPLICATE' }],
    ['TOP_UP', 'OPEN', false, true, { kind: 'HOLD', reason: 'AMOUNT_MISMATCH' }],
    ['ATTEMPT', 'OPEN', false, false, { kind: 'HOLD', reason: 'AMOUNT_MISMATCH' }],
    // HELD -> a SENT re-read resolves the hold (CR-25); a mismatch stays held for a person.
    ['TOP_UP', 'HELD', true, true, { kind: 'APPLY' }],
    ['ATTEMPT', 'HELD', true, true, { kind: 'APPLY' }],
    ['TOP_UP', 'HELD', true, false, { kind: 'UNAPPLY', reason: 'OVER_CAP' }],
    ['ATTEMPT', 'HELD', true, false, { kind: 'UNAPPLY', reason: 'DUPLICATE' }],
    ['ATTEMPT', 'HELD', false, true, { kind: 'NOOP', warn: 'held_amount_mismatch' }],
    // CLOSED with a provider id: a late SENT is absorbed if it still fits, otherwise recorded (A8 -> B3).
    ['ATTEMPT', 'CLOSED', true, true, { kind: 'APPLY' }],
    ['TOP_UP', 'CLOSED', true, true, { kind: 'APPLY' }],
    ['ATTEMPT', 'CLOSED', true, false, { kind: 'UNAPPLY', reason: 'DUPLICATE' }],
    ['TOP_UP', 'CLOSED', true, false, { kind: 'UNAPPLY', reason: 'LATE' }],
    ['TOP_UP', 'CLOSED', false, true, { kind: 'UNAPPLY', reason: 'AMOUNT_MISMATCH' }],
    ['ATTEMPT', 'CLOSED', false, true, { kind: 'UNAPPLY', reason: 'AMOUNT_MISMATCH' }],
    // Terminal and pre-provider states never move again: a replay is a no-op.
    ['TOP_UP', 'APPLIED', true, true, { kind: 'NOOP' }],
    ['ATTEMPT', 'APPLIED', true, false, { kind: 'NOOP' }],
    ['ATTEMPT', 'UNAPPLIED', true, true, { kind: 'NOOP' }],
    ['TOP_UP', 'CREATING', true, true, { kind: 'NOOP' }],
  ])('%s %s, amount matches %s, absorbable %s -> %j', (kind, status, amount, absorbable, out) => {
    expect(
      decideApply(facts(kind, status, view('SENT'), { amountMatches: amount, absorbable })),
    ).toEqual(out);
  });
});

describe('decideApply: not charged, indeterminate, unknown (A2, CR-27)', () => {
  it('closes an OPEN intent on NOT_CHARGED, flagging whether the payer had authorised it', () => {
    expect(decideApply(facts('ATTEMPT', 'OPEN', view('CANCELLED', 'USER_CANCELLED')))).toEqual({
      kind: 'CLOSE',
      afterAuthorisation: false,
    });
    for (const mirror of ['AUTHORISED', 'SUBMITTED', 'SETTLEMENT_IN_PROGRESS']) {
      expect(
        decideApply(facts('ATTEMPT', 'OPEN', view('CANCELLED', 'TIMED_OUT'), { mirror })),
      ).toEqual({ kind: 'CLOSE', afterAuthorisation: true });
    }
    // A bank-side FAILED is only reachable once the payer authorised the payment, whatever the stale mirror says.
    expect(decideApply(facts('TOP_UP', 'OPEN', view('FAILED', 'REJECTED')))).toEqual({
      kind: 'CLOSE',
      afterAuthorisation: true,
    });
  });

  it('holds an OPEN intent on INDETERMINATE and never re-holds or reopens a settled one', () => {
    const indeterminate = view('FAILED', 'BANK_ERROR_INDETERMINATE');
    expect(decideApply(facts('ATTEMPT', 'OPEN', indeterminate))).toEqual({
      kind: 'HOLD',
      reason: 'INDETERMINATE',
    });
    for (const status of ['HELD', 'CLOSED', 'APPLIED', 'UNAPPLIED'] as const) {
      expect(decideApply(facts('ATTEMPT', status, indeterminate))).toEqual({ kind: 'NOOP' });
      expect(decideApply(facts('TOP_UP', status, view('FAILED', 'REJECTED')))).toEqual({
        kind: 'NOOP',
      });
    }
  });

  it('leaves an OPEN intent open on an unrecognised status, and ignores it elsewhere', () => {
    expect(decideApply(facts('TOP_UP', 'OPEN', view('MYSTERY')))).toEqual({
      kind: 'MIRROR_UNKNOWN',
    });
    expect(decideApply(facts('TOP_UP', 'HELD', view('MYSTERY')))).toEqual({ kind: 'NOOP' });
  });
});

describe('decideApply: the OPEN mirror only moves forward (READY < AUTHORISED < SUBMITTED)', () => {
  it.each<[string | null, string, ApplyDecision]>([
    ['READY', 'AUTHORISED', { kind: 'MIRROR' }],
    ['READY', 'SUBMITTED', { kind: 'MIRROR' }],
    ['AUTHORISED', 'SUBMITTED', { kind: 'MIRROR' }],
    ['SUBMITTED', 'SETTLEMENT_IN_PROGRESS', { kind: 'MIRROR' }],
    [null, 'READY', { kind: 'MIRROR' }],
    ['SUBMITTED', 'READY', { kind: 'NOOP' }],
    ['SUBMITTED', 'AUTHORISED', { kind: 'NOOP' }],
    ['AUTHORISED', 'AUTHORISED', { kind: 'NOOP' }],
  ])('stored %s, fresh %s -> %j', (mirror, fresh, out) => {
    expect(decideApply(facts('ATTEMPT', 'OPEN', view(fresh), { mirror }))).toEqual(out);
  });

  it('ranks the provider statuses, unknown and missing lowest', () => {
    expect(mirrorRank('READY')).toBeLessThan(mirrorRank('AUTHORISED'));
    expect(mirrorRank('AUTHORISED')).toBeLessThan(mirrorRank('SUBMITTED'));
    expect(mirrorRank('SUBMITTED')).toBeLessThan(mirrorRank('SETTLEMENT_IN_PROGRESS'));
    expect(mirrorRank(null)).toBeLessThan(mirrorRank('READY'));
    expect(mirrorRank('MYSTERY')).toBeLessThan(mirrorRank('READY'));
  });

  it('an in-flight status on a non-OPEN intent changes nothing', () => {
    for (const status of ['HELD', 'CLOSED', 'APPLIED', 'UNAPPLIED', 'CREATING'] as const) {
      expect(decideApply(facts('TOP_UP', status, view('SUBMITTED')))).toEqual({ kind: 'NOOP' });
    }
  });
});

// ---------------------------------------------------------------------------------------------
// Hold resolution (CR-15, CR-26, H2): the forced decision the funnel applies under its own locks
// ---------------------------------------------------------------------------------------------

const resolution = (
  overrides: Partial<ResolutionFacts> & Pick<ResolutionFacts, 'outcome'>,
): ResolutionFacts => ({
  kind: 'ATTEMPT',
  status: 'HELD',
  holdReason: 'INDETERMINATE',
  storedResolution: null,
  observedAmount: null,
  intentAmount: parseMoney('17.00'),
  freshAmountMismatch: false,
  freshIndeterminate: true,
  absorbable: true,
  ...overrides,
});

describe('decideResolution: RECEIVED (CR-15, CR-26, B3)', () => {
  it('applies an INDETERMINATE hold confirmed as received, recording RECEIVED', () => {
    expect(decideResolution(resolution({ outcome: 'RECEIVED' }))).toEqual({
      kind: 'RESOLVE',
      decision: { kind: 'APPLY' },
      reason: 'RECEIVED',
    });
  });

  it('follows the cap and duplicate rules: never PAID twice, never over the cap', () => {
    expect(decideResolution(resolution({ outcome: 'RECEIVED', absorbable: false }))).toEqual({
      kind: 'RESOLVE',
      decision: { kind: 'UNAPPLY', reason: 'DUPLICATE' },
      reason: 'RECEIVED',
    });
    expect(
      decideResolution(resolution({ outcome: 'RECEIVED', kind: 'TOP_UP', absorbable: false })),
    ).toEqual({
      kind: 'RESOLVE',
      decision: { kind: 'UNAPPLY', reason: 'OVER_CAP' },
      reason: 'RECEIVED',
    });
  });

  it('needs an observed amount for an AMOUNT_MISMATCH hold (or a fresh SENT for another amount)', () => {
    expect(
      decideResolution(resolution({ outcome: 'RECEIVED', holdReason: 'AMOUNT_MISMATCH' })),
    ).toEqual({ kind: 'OBSERVED_AMOUNT_REQUIRED' });
    expect(
      decideResolution(resolution({ outcome: 'RECEIVED', freshAmountMismatch: true })),
    ).toEqual({ kind: 'OBSERVED_AMOUNT_REQUIRED' });
  });

  it('applies an AMOUNT_MISMATCH hold only when the observed amount equals the intent amount', () => {
    expect(
      decideResolution(
        resolution({
          outcome: 'RECEIVED',
          holdReason: 'AMOUNT_MISMATCH',
          observedAmount: parseMoney('17.00'),
        }),
      ),
    ).toEqual({ kind: 'RESOLVE', decision: { kind: 'APPLY' }, reason: 'RECEIVED' });
    expect(
      decideResolution(
        resolution({
          outcome: 'RECEIVED',
          holdReason: 'AMOUNT_MISMATCH',
          observedAmount: parseMoney('16.00'),
        }),
      ),
    ).toEqual({
      kind: 'RESOLVE',
      decision: { kind: 'UNAPPLY', reason: 'AMOUNT_MISMATCH' },
      reason: 'AMOUNT_MISMATCH',
    });
    // An observed amount on an INDETERMINATE hold is checked too: a different figure is never settled as the full charge.
    expect(
      decideResolution(resolution({ outcome: 'RECEIVED', observedAmount: parseMoney('5.00') })),
    ).toEqual({
      kind: 'RESOLVE',
      decision: { kind: 'UNAPPLY', reason: 'AMOUNT_MISMATCH' },
      reason: 'AMOUNT_MISMATCH',
    });
  });
});

describe('decideResolution: NOT_RECEIVED, replay and stale state', () => {
  it('closes the intent after a hold (grace and email 7 follow), naming what the fresh read said', () => {
    expect(decideResolution(resolution({ outcome: 'NOT_RECEIVED' }))).toEqual({
      kind: 'RESOLVE',
      decision: { kind: 'CLOSE', afterAuthorisation: true },
      reason: 'NOT_RECEIVED_INDETERMINATE',
    });
    expect(
      decideResolution(resolution({ outcome: 'NOT_RECEIVED', freshIndeterminate: false })),
    ).toEqual({
      kind: 'RESOLVE',
      decision: { kind: 'CLOSE', afterAuthorisation: true },
      reason: 'NOT_RECEIVED_NOT_SENT',
    });
  });

  it('answers a replay of the same outcome from the record and refuses a contradicting one', () => {
    expect(
      decideResolution(
        resolution({ outcome: 'RECEIVED', status: 'APPLIED', storedResolution: 'RECEIVED' }),
      ),
    ).toEqual({ kind: 'REPLAY' });
    expect(
      decideResolution(
        resolution({
          outcome: 'RECEIVED',
          status: 'UNAPPLIED',
          storedResolution: 'AMOUNT_MISMATCH',
        }),
      ),
    ).toEqual({ kind: 'REPLAY' });
    expect(
      decideResolution(
        resolution({
          outcome: 'NOT_RECEIVED',
          status: 'CLOSED',
          storedResolution: 'NOT_RECEIVED_NOT_SENT',
        }),
      ),
    ).toEqual({ kind: 'REPLAY' });
    expect(
      decideResolution(
        resolution({ outcome: 'NOT_RECEIVED', status: 'APPLIED', storedResolution: 'RECEIVED' }),
      ),
    ).toEqual({ kind: 'NOT_HELD' });
  });

  it('refuses an intent that is not held (the provider or another person settled it first)', () => {
    for (const status of ['OPEN', 'APPLIED', 'UNAPPLIED', 'CLOSED', 'CREATING'] as const) {
      expect(decideResolution(resolution({ outcome: 'RECEIVED', status }))).toEqual({
        kind: 'NOT_HELD',
      });
    }
  });
});
