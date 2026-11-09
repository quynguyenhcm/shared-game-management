import { describe, expect, it } from 'vitest';
import {
  PAYMENT_INSERT_STATUS_MATRIX,
  PAYMENT_TRANSITION_MATRIX,
} from '../../../../apps/api/test/fixtures/payment-transitions.ts';
import { PaymentStatus } from '../types/enums.ts';
import {
  PAYMENT_INSERT_STATUSES,
  PAYMENT_STATUS_TRANSITIONS,
  canTransitionPayment,
  isPaymentTerminal,
} from './payment-status.ts';

describe('PAYMENT_STATUS_TRANSITIONS (AC-VERIFY-2, D-87)', () => {
  it('has a fixture row for every ordered pair of statuses', () => {
    expect(PAYMENT_TRANSITION_MATRIX).toHaveLength(16);
    const pairs = PaymentStatus.flatMap((from) => PaymentStatus.map((to) => `${from}>${to}`));
    expect(PAYMENT_TRANSITION_MATRIX.map((r) => `${r.from}>${r.to}`).sort()).toEqual(pairs.sort());
  });

  it.each(PAYMENT_TRANSITION_MATRIX.map((r) => [`${r.from} -> ${r.to}`, r] as const))(
    '%s agrees with the shared fixture',
    (_name, row) => {
      expect(canTransitionPayment(row.from, row.to)).toBe(row.allowed);
      // A same-status write is not a transition: never listed, always accepted.
      expect(PAYMENT_STATUS_TRANSITIONS[row.from].includes(row.to)).toBe(
        row.from === row.to ? false : row.allowed,
      );
    },
  );

  it('allows exactly PENDING>PAID, PENDING>OVERDUE and OVERDUE>PAID; PAID is terminal and nothing enters FAILED', () => {
    const moves = PaymentStatus.flatMap((from) =>
      PAYMENT_STATUS_TRANSITIONS[from].map((to) => `${from}>${to}`),
    );
    expect(moves.sort()).toEqual(['OVERDUE>PAID', 'PENDING>OVERDUE', 'PENDING>PAID']);
    expect(PaymentStatus.filter(isPaymentTerminal).sort()).toEqual(['FAILED', 'PAID']);
    for (const from of PaymentStatus) {
      if (from !== 'FAILED') expect(canTransitionPayment(from, 'FAILED')).toBe(false);
    }
  });

  it('lists the insertable statuses from the fixture (FAILED is refused, OVERDUE stays seedable)', () => {
    for (const { status, allowed } of PAYMENT_INSERT_STATUS_MATRIX) {
      expect(PAYMENT_INSERT_STATUSES.includes(status)).toBe(allowed);
    }
  });
});
