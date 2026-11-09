import { describe, expect, it } from 'vitest';
import { parseMoney } from '@sgm/shared';
import type { ProviderPayment } from '../../lib/akahu/gateway.ts';
import { mapAkahuStatus } from '../../lib/akahu/status.ts';
import { decideOverdue, type LocalAttempt } from './overdue.ts';

const AMOUNT = parseMoney('17.00');

const read = (status: string, reason: string | null = null, amount = AMOUNT): ProviderPayment => ({
  providerPaymentId: 'fake_ok_1700_1_abcd',
  amount,
  providerStatus: status,
  providerStatusReason: reason,
  outcome: mapAkahuStatus(status, reason),
});

const open = (akahuStatus: string | null = 'READY'): LocalAttempt => ({
  status: 'OPEN',
  akahuPaymentId: 'fake_ok_1700_1_abcd',
  akahuStatus,
});

describe('decideOverdue (CR-27, ruling H1)', () => {
  it('flips a payment with no blocking attempt, and one whose attempt is only CREATING', () => {
    expect(decideOverdue(null, null)).toEqual({ kind: 'flip' });
    expect(
      decideOverdue({ status: 'CREATING', akahuPaymentId: null, akahuStatus: null }, null),
    ).toEqual({
      kind: 'flip',
    });
  });

  it('skips a HELD attempt without looking at Akahu', () => {
    expect(
      decideOverdue({ status: 'HELD', akahuPaymentId: 'x', akahuStatus: 'FAILED' }, null),
    ).toEqual({ kind: 'skip', reason: 'held' });
  });

  it('applies an OPEN attempt still awaiting the payer, then flips it (a READY link does not protect the debt)', () => {
    expect(decideOverdue(open(), read('READY'))).toEqual({ kind: 'apply', then: 'flip' });
  });

  it('applies an in-flight read through the funnel (mirror) and then skips the payment', () => {
    for (const status of ['AUTHORISED', 'SUBMITTED', 'SETTLEMENT_IN_PROGRESS']) {
      expect(decideOverdue(open('READY'), read(status))).toEqual({
        kind: 'apply',
        then: 'skip_in_flight',
      });
    }
  });

  it('applies a SENT read through the funnel (PAID, or HELD on a mismatch) and never flips it', () => {
    expect(decideOverdue(open(), read('SENT'))).toEqual({
      kind: 'apply',
      then: 'skip_settled',
    });
    expect(decideOverdue(open(), read('SENT', null, parseMoney('16.99')))).toEqual({
      kind: 'apply',
      then: 'skip_settled',
    });
  });

  it('applies an INDETERMINATE read through the funnel (HELD) and skips the payment', () => {
    expect(decideOverdue(open(), read('FAILED', 'BANK_ERROR_INDETERMINATE'))).toEqual({
      kind: 'apply',
      then: 'skip_indeterminate',
    });
  });

  it('applies a NOT_CHARGED read (the funnel writes any 24 h grace) and flips unless the grace moved the due date', () => {
    expect(decideOverdue(open('READY'), read('CANCELLED', 'USER_CANCELLED'))).toEqual({
      kind: 'apply',
      then: 'flip_unless_grace',
    });
    expect(decideOverdue(open('AUTHORISED'), read('FAILED', 'REJECTED'))).toEqual({
      kind: 'apply',
      then: 'flip_unless_grace',
    });
  });

  it('defers, never flips, when the provider cannot tell us: unrecognised, not found or unreadable', () => {
    expect(decideOverdue(open(), read('WEIRD'))).toEqual({
      kind: 'defer',
      reason: 'unrecognised',
    });
    expect(decideOverdue(open(), 'not_found')).toEqual({
      kind: 'defer',
      reason: 'not_found',
    });
    expect(decideOverdue(open(), 'unavailable')).toEqual({
      kind: 'defer',
      reason: 'unavailable',
    });
    expect(decideOverdue(open(), null)).toEqual({ kind: 'defer', reason: 'unavailable' });
  });
});
