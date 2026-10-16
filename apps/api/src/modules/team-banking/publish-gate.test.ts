import { describe, expect, it } from 'vitest';
import type { Database } from '../../lib/db/kysely.ts';
import { PAID_SESSION_MATRIX } from '../../../test/fixtures/paid-session-matrix.ts';
import {
  assertTeamCanPublishPaidSession,
  checkTeamCanPublishPaidSession,
  isPaidSession,
} from './publish-gate.ts';

const NO_FEES = {
  feeFlat: null,
  feeMale: null,
  feeFemale: null,
  feeOther: null,
  feeBeginner: null,
  feeIntermediate: null,
  feeAdvanced: null,
} as const;

/** A transaction handle that fails the test on any query: proves a path takes no lock. */
const untouchableTrx = {
  isTransaction: true,
  selectFrom: () => {
    throw new Error('the gate must not query for this session');
  },
} as unknown as Database;

describe('isPaidSession (TS twin of game_session_is_paid)', () => {
  it('matches the hand-written expectation on every parity-matrix row', () => {
    expect(PAID_SESSION_MATRIX).toHaveLength(117);
    const wrong = PAID_SESSION_MATRIX.filter(
      (row) => isPaidSession(row.pricingStructure, row.fees) !== row.expectedPaid,
    ).map((row) => row.name);
    expect(wrong).toEqual([]);
  });

  it('pins the rule with literal cases: NULL is 0, negative is not paid, inapplicable columns never count', () => {
    expect(isPaidSession('FLAT', { ...NO_FEES, feeFlat: '17.00' })).toBe(true);
    expect(isPaidSession('FLAT', { ...NO_FEES, feeFlat: '0.00' })).toBe(false);
    expect(isPaidSession('FLAT', NO_FEES)).toBe(false);
    expect(isPaidSession('FLAT', { ...NO_FEES, feeFlat: '-3.00' })).toBe(false);
    expect(isPaidSession('FLAT', { ...NO_FEES, feeMale: '5.00' })).toBe(false);
    expect(isPaidSession('BY_SEX', { ...NO_FEES, feeOther: '0.01' })).toBe(true);
    expect(isPaidSession('BY_SEX', { ...NO_FEES, feeAdvanced: '9.00' })).toBe(false);
    expect(isPaidSession('BY_SKILL_LEVEL', { ...NO_FEES, feeAdvanced: '0.01' })).toBe(true);
    expect(isPaidSession('BY_SKILL_LEVEL', { ...NO_FEES, feeBeginner: '-5.00' })).toBe(false);
  });

  it('fails closed: an unparsable applicable fee or an unknown structure counts as paid', () => {
    expect(isPaidSession('FLAT', { ...NO_FEES, feeFlat: 'abc' })).toBe(true);
    expect(isPaidSession('FLAT', { ...NO_FEES, feeFlat: '1e3' })).toBe(true);
    // An unparsable value in a column that does not apply is ignored, like any other inapplicable column.
    expect(isPaidSession('FLAT', { ...NO_FEES, feeFlat: '0.00', feeMale: 'abc' })).toBe(false);
    expect(isPaidSession('PER_HOUR' as never, NO_FEES)).toBe(true);
    // Prototype keys are not structures.
    expect(isPaidSession('constructor' as never, NO_FEES)).toBe(true);
    expect(isPaidSession('toString' as never, NO_FEES)).toBe(true);
  });
});

describe('gate preconditions', () => {
  it('lets a free session through without a query, for both the check and the assert form', async () => {
    const input = {
      teamId: '00000000-0000-4000-8000-000000000001',
      pricingStructure: 'FLAT',
      fees: { ...NO_FEES, feeFlat: '0.00' },
    } as const;
    await expect(checkTeamCanPublishPaidSession(untouchableTrx, input)).resolves.toEqual({
      ok: true,
    });
    await expect(assertTeamCanPublishPaidSession(untouchableTrx, input)).resolves.toBeUndefined();
  });

  it('refuses to run outside a transaction (a programming error, not a 409)', async () => {
    const plain = { isTransaction: false } as unknown as Database;
    const input = {
      teamId: '00000000-0000-4000-8000-000000000001',
      pricingStructure: 'FLAT',
      fees: { ...NO_FEES, feeFlat: '17.00' },
    } as const;
    await expect(checkTeamCanPublishPaidSession(plain, input)).rejects.toThrow(/transaction/);
    await expect(assertTeamCanPublishPaidSession(plain, input)).rejects.toThrow(/transaction/);
  });
});
