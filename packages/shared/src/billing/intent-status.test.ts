import { describe, expect, it } from 'vitest';
import {
  BLOCKING_INTENT_STATUSES as FIXTURE_BLOCKING,
  INTENT_TRANSITION_MATRIX,
} from '../../../../apps/api/test/fixtures/intent-transitions.ts';
import { PaymentIntentStatus } from '../types/enums.ts';
import {
  BLOCKING_INTENT_STATUSES,
  INTENT_STATUS_TRANSITIONS,
  canTransitionIntent,
  intentOutcome,
  isBlockingIntent,
} from './intent-status.ts';

describe('intentOutcome (CR-17 read model)', () => {
  it.each([
    ['no intent at all', null, 'none'],
    ['CREATING (create in flight)', { status: 'CREATING', closeReason: null }, 'processing'],
    ['OPEN', { status: 'OPEN', closeReason: null }, 'processing'],
    ['HELD', { status: 'HELD', closeReason: null }, 'held'],
    ['APPLIED (the status itself says paid)', { status: 'APPLIED', closeReason: null }, 'none'],
    ['UNAPPLIED (B3 notice elsewhere)', { status: 'UNAPPLIED', closeReason: null }, 'none'],
    [
      'CLOSED after a payer cancel',
      { status: 'CLOSED', closeReason: 'akahu:CANCELLED:USER_CANCELLED' },
      'cancelled',
    ],
    [
      'CLOSED by an expired link cancel',
      { status: 'CLOSED', closeReason: 'akahu:CANCELLED' },
      'cancelled',
    ],
    [
      'CLOSED abandoned at create (reconcile)',
      { status: 'CLOSED', closeReason: 'create_abandoned' },
      'cancelled',
    ],
    [
      'CLOSED after a bank decline',
      { status: 'CLOSED', closeReason: 'akahu:FAILED:REJECTED' },
      'failed',
    ],
    [
      'CLOSED because the provider was down at create',
      { status: 'CLOSED', closeReason: 'create_unavailable' },
      'failed',
    ],
    [
      'CLOSED because the provider refused the create',
      { status: 'CLOSED', closeReason: 'create_refused:payee_unusable' },
      'failed',
    ],
  ] as const)('%s -> %s', (_name, intent, expected) => {
    expect(intentOutcome(intent)).toBe(expected);
  });
});

describe('INTENT_STATUS_TRANSITIONS (CR-1)', () => {
  it('has a fixture row for every ordered pair of the six statuses', () => {
    expect(PaymentIntentStatus).toEqual([
      'CREATING',
      'OPEN',
      'HELD',
      'APPLIED',
      'UNAPPLIED',
      'CLOSED',
    ]);
    expect(INTENT_TRANSITION_MATRIX).toHaveLength(36);
    const pairs = PaymentIntentStatus.flatMap((from) =>
      PaymentIntentStatus.map((to) => `${from}>${to}`),
    );
    expect(INTENT_TRANSITION_MATRIX.map((r) => `${r.from}>${r.to}`).sort()).toEqual(pairs.sort());
  });

  it.each(INTENT_TRANSITION_MATRIX.map((r) => [`${r.from} -> ${r.to}`, r] as const))(
    '%s agrees with the shared fixture',
    (_name, row) => {
      // Conditional rows are refused without a provider id and allowed with one; every other row ignores it.
      expect(canTransitionIntent(row.from, row.to, { hasProviderId: true })).toBe(row.allowed);
      expect(canTransitionIntent(row.from, row.to, { hasProviderId: false })).toBe(
        row.allowed && row.needsProviderId !== true,
      );
    },
  );

  it('treats CREATING, OPEN and HELD as the blocking set, and APPLIED and UNAPPLIED as terminal', () => {
    expect([...BLOCKING_INTENT_STATUSES]).toEqual([...FIXTURE_BLOCKING]);
    expect(PaymentIntentStatus.filter(isBlockingIntent)).toEqual(['CREATING', 'OPEN', 'HELD']);
    expect(INTENT_STATUS_TRANSITIONS.APPLIED).toEqual([]);
    expect(INTENT_STATUS_TRANSITIONS.UNAPPLIED).toEqual([]);
  });
});
