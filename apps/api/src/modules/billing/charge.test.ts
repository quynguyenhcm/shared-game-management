import { describe, expect, it } from 'vitest';
import { parseMoney, toMoneyString, type MoneyString, type SessionFeeColumns } from '@sgm/shared';
import type { BillableRegistration } from '../registrations/billing-handoff.ts';
import { ChargeInvariantError, billingDueDate, computeCharge, decideSettlement } from './charge.ts';

const m = (value: string): MoneyString => value as MoneyString;
const money = (value: string) => parseMoney(value);

const NONE = {
  flat: null,
  male: null,
  female: null,
  other: null,
  beginner: null,
  intermediate: null,
  advanced: null,
} as const;

const FLAT: SessionFeeColumns = { ...NONE, pricing: 'FLAT', flat: m('17.00') };
const BY_SEX: SessionFeeColumns = {
  ...NONE,
  pricing: 'BY_SEX',
  male: m('15.00'),
  female: m('12.00'),
  other: m('13.00'),
};
const BY_SKILL: SessionFeeColumns = {
  ...NONE,
  pricing: 'BY_SKILL_LEVEL',
  beginner: m('10.00'),
  intermediate: m('14.00'),
  advanced: m('18.00'),
};

function registration(overrides: Partial<BillableRegistration> = {}): BillableRegistration {
  return {
    registrationId: 'reg-1',
    userId: 'user-1',
    teamId: 'team-1',
    reason: 'CONFIRMED',
    registrantSex: 'MALE',
    registrantSkillLevel: 'BEGINNER',
    guests: [],
    ...overrides,
  };
}

describe('computeCharge (C-BIL-1: per party, from the snapshot and the session fee columns)', () => {
  it.each([
    {
      name: 'FLAT, party of 3',
      fees: FLAT,
      reg: registration({
        guests: [
          { guestId: 'g1', position: 1, sex: 'FEMALE', skillLevel: 'ADVANCED' },
          { guestId: 'g2', position: 2, sex: 'OTHER', skillLevel: 'BEGINNER' },
        ],
      }),
      total: '51.00',
      lines: [
        [0, null, 'FLAT', '17.00'],
        [1, 'g1', 'FLAT', '17.00'],
        [2, 'g2', 'FLAT', '17.00'],
      ],
    },
    {
      name: 'BY_SEX: male registrant, female guest, OTHER guest',
      fees: BY_SEX,
      reg: registration({
        guests: [
          { guestId: 'g1', position: 1, sex: 'FEMALE', skillLevel: 'BEGINNER' },
          { guestId: 'g2', position: 2, sex: 'OTHER', skillLevel: 'BEGINNER' },
        ],
      }),
      total: '40.00',
      lines: [
        [0, null, 'SEX_MALE', '15.00'],
        [1, 'g1', 'SEX_FEMALE', '12.00'],
        [2, 'g2', 'SEX_OTHER', '13.00'],
      ],
    },
    {
      name: 'BY_SKILL_LEVEL: registrant snapshotted INTERMEDIATE',
      fees: BY_SKILL,
      reg: registration({ registrantSkillLevel: 'INTERMEDIATE' }),
      total: '14.00',
      lines: [[0, null, 'SKILL_INTERMEDIATE', '14.00']],
    },
    {
      name: 'single player under FLAT',
      fees: FLAT,
      reg: registration(),
      total: '17.00',
      lines: [[0, null, 'FLAT', '17.00']],
    },
  ])('$name', ({ fees, reg, total, lines }) => {
    const charge = computeCharge(fees, reg);
    expect(charge.total).toBe(money(total));
    expect(
      charge.lines.map((line) => [
        line.position,
        line.guestId,
        line.basis,
        toMoneyString(line.unitFee),
      ]),
    ).toEqual(lines);
  });

  it('carries the snapshotted sex and skill of each party on its line, never anything else', () => {
    const charge = computeCharge(
      BY_SKILL,
      registration({
        registrantSex: 'FEMALE',
        registrantSkillLevel: 'ADVANCED',
        guests: [{ guestId: 'g1', position: 1, sex: 'OTHER', skillLevel: 'BEGINNER' }],
      }),
    );
    expect(charge.lines.map((line) => [line.sex, line.skillLevel])).toEqual([
      ['FEMALE', 'ADVANCED'],
      ['OTHER', 'BEGINNER'],
    ]);
    expect(charge.total).toBe(money('28.00'));
  });

  it('throws an invariant error when a party has no fee to apply (the session CHECK makes it unreachable)', () => {
    const broken: SessionFeeColumns = { ...FLAT, flat: null };
    expect(() => computeCharge(broken, registration())).toThrow(ChargeInvariantError);
  });

  it('sums a free fee to $0.00 (B7 is decided by decideSettlement, not here)', () => {
    const free: SessionFeeColumns = { ...BY_SEX, male: m('0.00') };
    expect(computeCharge(free, registration()).total).toBe(money('0.00'));
  });
});

describe('decideSettlement (all-or-nothing, B5, B7)', () => {
  it.each([
    ['covers with room to spare', '30.00', '17.00', 'WALLET', '13.00', true],
    ['exactly equal drains to zero', '17.00', '17.00', 'WALLET', '0.00', true],
    ['leaves exactly 20.00: no low-credit', '37.00', '17.00', 'WALLET', '20.00', false],
    ['leaves 19.99: low-credit', '36.99', '17.00', 'WALLET', '19.99', true],
    ['leaves 19.00: low-credit', '36.00', '17.00', 'WALLET', '19.00', true],
    ['leaves 18.00: low-credit', '35.00', '17.00', 'WALLET', '18.00', true],
    ['large balance leaves well above 20.00', '100.00', '17.00', 'WALLET', '83.00', false],
  ])('%s', (_name, balance, total, kind, newBalance, lowCredit) => {
    expect(decideSettlement(money(balance), money(total))).toEqual({
      kind,
      newBalance: money(newBalance),
      lowCredit,
    });
  });

  it('links when the balance is one cent short (no partial deduction)', () => {
    expect(decideSettlement(money('16.99'), money('17.00'))).toEqual({ kind: 'LINK' });
  });

  it('links when there is no wallet row', () => {
    expect(decideSettlement(null, money('17.00'))).toEqual({ kind: 'LINK' });
  });

  it('B7: a $0.00 party is ZERO whatever the wallet holds, and never touches the balance', () => {
    expect(decideSettlement(money('50.00'), money('0.00'))).toEqual({ kind: 'ZERO' });
    expect(decideSettlement(null, money('0.00'))).toEqual({ kind: 'ZERO' });
  });
});

describe('billingDueDate (B2)', () => {
  it('is the billing instant plus 72 hours exactly, across a DST change', () => {
    const billedAt = new Date('2027-04-03T12:00:00.000Z'); // the Auckland DST end is the next local morning
    expect(billingDueDate(billedAt).toISOString()).toBe('2027-04-06T12:00:00.000Z');
  });
});
