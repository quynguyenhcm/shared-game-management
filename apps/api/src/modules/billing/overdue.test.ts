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
    expect(decideOverdue(null, null, AMOUNT)).toEqual({ kind: 'flip' });
    expect(
      decideOverdue({ status: 'CREATING', akahuPaymentId: null, akahuStatus: null }, null, AMOUNT),
    ).toEqual({
      kind: 'flip',
    });
  });

  it('skips a HELD attempt without looking at Akahu', () => {
    expect(
      decideOverdue({ status: 'HELD', akahuPaymentId: 'x', akahuStatus: 'FAILED' }, null, AMOUNT),
    ).toEqual({ kind: 'skip', reason: 'held' });
  });

  it('flips an OPEN attempt that is still awaiting the payer (a READY link does not protect the debt)', () => {
    expect(decideOverdue(open(), read('READY'), AMOUNT)).toEqual({ kind: 'flip' });
  });

  it('skips an attempt that is in flight at the bank, whatever the stale mirror says', () => {
    for (const status of ['AUTHORISED', 'SUBMITTED', 'SETTLEMENT_IN_PROGRESS']) {
      expect(decideOverdue(open('READY'), read(status), AMOUNT)).toEqual({
        kind: 'skip',
        reason: 'in_flight',
      });
    }
  });

  it('applies a SENT payment of the exact amount as paid, never as overdue', () => {
    expect(decideOverdue(open(), read('SENT'), AMOUNT)).toEqual({ kind: 'apply_paid' });
  });

  it('holds a SENT payment whose amount differs and touches nothing else', () => {
    expect(decideOverdue(open(), read('SENT', null, parseMoney('16.99')), AMOUNT)).toEqual({
      kind: 'hold_mismatch',
    });
  });

  it('leaves an INDETERMINATE payment untouched this run', () => {
    expect(decideOverdue(open(), read('FAILED', 'BANK_ERROR_INDETERMINATE'), AMOUNT)).toEqual({
      kind: 'skip',
      reason: 'indeterminate',
    });
  });

  it('flips a NOT_CHARGED payment unless the payer had authorised it (that failure owns a 24 h grace)', () => {
    expect(decideOverdue(open('READY'), read('CANCELLED', 'USER_CANCELLED'), AMOUNT)).toEqual({
      kind: 'flip',
    });
    for (const mirror of ['AUTHORISED', 'SUBMITTED', 'SETTLEMENT_IN_PROGRESS']) {
      expect(decideOverdue(open(mirror), read('FAILED', 'REJECTED'), AMOUNT)).toEqual({
        kind: 'skip',
        reason: 'post_authorisation_failure',
      });
    }
  });

  it('defers, never flips, when the provider cannot tell us: unrecognised, not found or unreadable', () => {
    expect(decideOverdue(open(), read('WEIRD'), AMOUNT)).toEqual({
      kind: 'defer',
      reason: 'unrecognised',
    });
    expect(decideOverdue(open(), 'not_found', AMOUNT)).toEqual({
      kind: 'defer',
      reason: 'not_found',
    });
    expect(decideOverdue(open(), 'unavailable', AMOUNT)).toEqual({
      kind: 'defer',
      reason: 'unavailable',
    });
    expect(decideOverdue(open(), null, AMOUNT)).toEqual({ kind: 'defer', reason: 'unavailable' });
  });
});
