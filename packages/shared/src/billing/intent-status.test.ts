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
  isBlockingIntent,
} from './intent-status.ts';

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
