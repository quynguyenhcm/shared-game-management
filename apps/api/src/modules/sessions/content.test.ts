/**
 * Pure rules of a one-off session write (architecture SA-6; recurrence algorithm A5, conflicts 6 and 10; binding
 * T-7..T-10): DST-safe court and deadline resolution, the fee columns, and what counts as a change or a material
 * change. No database, no clock: every vector is written out by hand from the design docs.
 */
import { describe, expect, it } from 'vitest';
import {
  parseLocalDate,
  parseLocalTime,
  parseMoney,
  type CreateSessionRequest,
  type LocalDate,
  type MoneyString,
} from '@sgm/shared';
import {
  computeFeeColumns,
  contentChange,
  sessionFeesOf,
  sortCourts,
  resolveSessionTimes,
  trimTime,
  type FeeColumns,
  type SessionContent,
} from './content.ts';

const date = (value: string): LocalDate => parseLocalDate(value);
const court = (
  identifier: string,
  start: string,
  end: string,
  extra: { startDisambiguation?: 'earlier'; endDisambiguation?: 'earlier' } = {},
): CreateSessionRequest['courts'][number] => ({
  identifier,
  startTime: parseLocalTime(start),
  endTime: parseLocalTime(end),
  ...extra,
});
const money = (value: string) => parseMoney(value);
const ms = (value: string): MoneyString => value as MoneyString;

describe('trimTime and sortCourts', () => {
  it('drops :00 seconds, keeps the end-of-day marker, and sorts court names numerically', () => {
    expect(trimTime('08:00:00')).toBe('08:00');
    expect(trimTime('19:30')).toBe('19:30');
    expect(trimTime('24:00:00')).toBe('24:00');
    expect(
      sortCourts([
        { identifier: 'Court 10' },
        { identifier: 'Court 2' },
        { identifier: 'Court 1' },
      ]),
    ).toEqual([{ identifier: 'Court 1' }, { identifier: 'Court 2' }, { identifier: 'Court 10' }]);
  });
});

describe('resolveSessionTimes', () => {
  it('resolves courts to wall times, the first start, the last end and the 48 hour default deadline', () => {
    const result = resolveSessionTimes({
      date: date('2026-11-04'),
      courts: [court('Court 2', '08:00', '09:00'), court('Court 1', '08:00', '10:00')],
      cancellationDeadline: null,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // 2026-11-04 is NZDT (UTC+13): 08:00 is 19:00Z on the 3rd.
    expect(result.startsAt.toISOString()).toBe('2026-11-03T19:00:00.000Z');
    expect(result.endsAt.toISOString()).toBe('2026-11-03T21:00:00.000Z');
    expect(result.deadline).toEqual({
      kind: 'default',
      instant: new Date('2026-11-01T19:00:00.000Z'),
    });
    expect(result.courts).toEqual([
      { identifier: 'Court 1', startTime: '08:00', endTime: '10:00' },
      { identifier: 'Court 2', startTime: '08:00', endTime: '09:00' },
    ]);
  });

  it('T6: a start in the spring-forward gap is refused with both real times as options', () => {
    const result = resolveSessionTimes({
      date: date('2026-09-27'),
      courts: [court('Court 1', '02:30', '04:00')],
      cancellationDeadline: null,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.fieldErrors).toEqual({ 'courts.0.startTime': ['local_time_nonexistent'] });
    expect(result.dstOptions).toEqual([
      {
        field: 'courts.0.startTime',
        date: '2026-09-27',
        time: '02:30',
        kind: 'nonexistent',
        options: [
          { choice: 'shiftedForward', localTime: '03:30', instant: '2026-09-26T14:30:00.000Z' },
          { choice: 'shiftedBackward', localTime: '01:30', instant: '2026-09-26T13:30:00.000Z' },
        ],
      },
    ]);
  });

  it('T7: an overlap start offers only the first 2:30 and accepts it with a transient earlier flag', () => {
    const refused = resolveSessionTimes({
      date: date('2027-04-04'),
      courts: [court('Court 1', '02:30', '04:00')],
      cancellationDeadline: null,
    });
    expect(refused.ok).toBe(false);
    if (refused.ok) return;
    expect(refused.fieldErrors).toEqual({ 'courts.0.startTime': ['local_time_ambiguous'] });
    expect(refused.dstOptions[0]).toMatchObject({
      kind: 'ambiguous',
      options: [{ choice: 'earlier', localTime: '02:30', instant: '2027-04-03T13:30:00.000Z' }],
    });

    const accepted = resolveSessionTimes({
      date: date('2027-04-04'),
      courts: [court('Court 1', '02:30', '04:00', { startDisambiguation: 'earlier' })],
      cancellationDeadline: null,
    });
    expect(accepted.ok).toBe(true);
    if (!accepted.ok) return;
    expect(accepted.startsAt.toISOString()).toBe('2027-04-03T13:30:00.000Z');
    expect(accepted.courts[0]).toEqual({
      identifier: 'Court 1',
      startTime: '02:30',
      endTime: '04:00',
    });
  });

  it('a gap time is refused even with an earlier flag, and an end at 24:00 is never checked', () => {
    const gap = resolveSessionTimes({
      date: date('2026-09-27'),
      courts: [court('Court 1', '01:00', '02:30', { endDisambiguation: 'earlier' })],
      cancellationDeadline: null,
    });
    expect(gap.ok).toBe(false);
    if (!gap.ok)
      expect(gap.fieldErrors).toEqual({ 'courts.0.endTime': ['local_time_nonexistent'] });

    const midnight = resolveSessionTimes({
      date: date('2026-11-04'),
      courts: [court('Court 1', '22:00', '24:00')],
      cancellationDeadline: null,
    });
    expect(midnight.ok).toBe(true);
  });

  it('T8: an explicit deadline in the overlap offers earlier and later, both stored as given', () => {
    const base = {
      date: date('2027-04-10'),
      courts: [court('Court 1', '18:00', '20:00')],
    };
    const refused = resolveSessionTimes({
      ...base,
      cancellationDeadline: { date: date('2027-04-04'), time: parseLocalTime('02:30') },
    });
    expect(refused.ok).toBe(false);
    if (refused.ok) return;
    expect(refused.fieldErrors).toEqual({ cancellationDeadline: ['local_time_ambiguous'] });
    expect(refused.dstOptions).toEqual([
      {
        field: 'cancellationDeadline',
        date: '2027-04-04',
        time: '02:30',
        kind: 'ambiguous',
        options: [
          { choice: 'earlier', localTime: '02:30', instant: '2027-04-03T13:30:00.000Z' },
          { choice: 'later', localTime: '02:30', instant: '2027-04-03T14:30:00.000Z' },
        ],
      },
    ]);

    for (const [disambiguation, iso] of [
      ['earlier', '2027-04-03T13:30:00.000Z'],
      ['later', '2027-04-03T14:30:00.000Z'],
    ] as const) {
      const accepted = resolveSessionTimes({
        ...base,
        cancellationDeadline: {
          date: date('2027-04-04'),
          time: parseLocalTime('02:30'),
          disambiguation,
        },
      });
      expect(accepted.ok).toBe(true);
      if (accepted.ok)
        expect(accepted.deadline).toEqual({ kind: 'explicit', instant: new Date(iso) });
    }
  });

  it('refuses an explicit deadline in the gap and one after the first court starts', () => {
    const gap = resolveSessionTimes({
      date: date('2026-10-10'),
      courts: [court('Court 1', '18:00', '20:00')],
      cancellationDeadline: { date: date('2026-09-27'), time: parseLocalTime('02:30') },
    });
    expect(gap.ok).toBe(false);
    if (!gap.ok) {
      expect(gap.fieldErrors).toEqual({ cancellationDeadline: ['local_time_nonexistent'] });
      expect(gap.dstOptions[0]?.options.map((o) => o.choice)).toEqual([
        'shiftedForward',
        'shiftedBackward',
      ]);
    }

    const late = resolveSessionTimes({
      date: date('2026-11-04'),
      courts: [court('Court 1', '08:00', '10:00')],
      cancellationDeadline: { date: date('2026-11-04'), time: parseLocalTime('09:00') },
    });
    expect(late.ok).toBe(false);
    if (!late.ok) {
      expect(late.fieldErrors).toEqual({
        cancellationDeadline: ['The deadline must be before the first court starts.'],
      });
      expect(late.dstOptions).toEqual([]);
    }
  });
});

describe('computeFeeColumns', () => {
  const flat = {
    pricingStructure: 'FLAT' as const,
    courtCost: money('120.00'),
    extraExpenses: money('12.00'),
    maxPlayers: 12,
    customPlayerRate: null,
    feeMale: null,
    feeFemale: null,
    feeOther: null,
    feeBeginner: null,
    feeIntermediate: null,
    feeAdvanced: null,
  };

  it('FLAT follows the suggestion: $132 over 12 players is $11.00, stored as fee_flat, rate not pinned', () => {
    const result = computeFeeColumns(flat, null);
    expect(result).toMatchObject({
      ok: true,
      fees: {
        totalCourtCost: '120.00',
        extraExpenses: '12.00',
        calculatedRatePerPlayer: '11.00',
        customPlayerRate: null,
        pricingStructure: 'FLAT',
        feeFlat: '11.00',
        feeMale: null,
        feeBeginner: null,
      },
    });
  });

  it('a typed FLAT rate is pinned (even $0.00), and fee_flat is that final rate', () => {
    const pinned = computeFeeColumns({ ...flat, customPlayerRate: money('9.50') }, null);
    expect(pinned).toMatchObject({
      ok: true,
      fees: { calculatedRatePerPlayer: '11.00', customPlayerRate: '9.50', feeFlat: '9.50' },
    });
    const zero = computeFeeColumns({ ...flat, customPlayerRate: money('0.00') }, null);
    expect(zero).toMatchObject({ ok: true, fees: { customPlayerRate: '0.00', feeFlat: '0.00' } });
  });

  it('a free session costs $0.00: blank court hire and extras give a $0.00 rate', () => {
    const free = computeFeeColumns(
      { ...flat, courtCost: money('0.00'), extraExpenses: money('0.00') },
      null,
    );
    expect(free).toMatchObject({
      ok: true,
      fees: { calculatedRatePerPlayer: '0.00', feeFlat: '0.00' },
    });
  });

  it('BY_SEX defaults fee_other to the lower of male and female, keeps a saved one, and needs both rates', () => {
    const bySex = {
      ...flat,
      pricingStructure: 'BY_SEX' as const,
      feeMale: money('12.00'),
      feeFemale: money('10.00'),
    };
    expect(computeFeeColumns(bySex, null)).toMatchObject({
      ok: true,
      fees: { feeOther: '10.00', feeFlat: null, customPlayerRate: null, feeMale: '12.00' },
    });
    // The stored row was already BY_SEX with a saved other rate: never overwritten.
    expect(
      computeFeeColumns(bySex, { pricingStructure: 'BY_SEX', feeOther: ms('15.00') }),
    ).toMatchObject({ ok: true, fees: { feeOther: '15.00' } });
    // Stored as another model: the default applies again.
    expect(
      computeFeeColumns(bySex, { pricingStructure: 'FLAT', feeOther: ms('15.00') }),
    ).toMatchObject({ ok: true, fees: { feeOther: '10.00' } });
    // An explicit value always wins.
    expect(computeFeeColumns({ ...bySex, feeOther: money('8.00') }, null)).toMatchObject({
      ok: true,
      fees: { feeOther: '8.00' },
    });
    expect(computeFeeColumns({ ...bySex, feeFemale: null }, null)).toEqual({
      ok: false,
      fieldErrors: { feeFemale: ['Enter an amount like 12.00.'] },
    });
  });

  it('BY_SKILL_LEVEL stores what was entered (a draft may be incomplete) and clears the other models', () => {
    const result = computeFeeColumns(
      {
        ...flat,
        pricingStructure: 'BY_SKILL_LEVEL',
        customPlayerRate: money('5.00'),
        feeBeginner: money('8.00'),
        feeAdvanced: money('14.00'),
      },
      null,
    );
    expect(result).toMatchObject({
      ok: true,
      fees: {
        feeBeginner: '8.00',
        feeIntermediate: null,
        feeAdvanced: '14.00',
        feeFlat: null,
        customPlayerRate: null,
        feeMale: null,
      },
    });
  });

  it('sessionFeesOf reads fee columns as exact money for the fee-lock comparison', () => {
    const result = computeFeeColumns(flat, null);
    if (!result.ok) throw new Error('expected ok');
    expect(sessionFeesOf(result.fees)).toMatchObject({
      pricingStructure: 'FLAT',
      feeFlat: money('11.00'),
      feeMale: null,
    });
  });
});

describe('contentChange', () => {
  const fees: FeeColumns = {
    totalCourtCost: ms('120.00'),
    extraExpenses: ms('12.00'),
    calculatedRatePerPlayer: ms('11.00'),
    customPlayerRate: null,
    pricingStructure: 'FLAT',
    feeFlat: ms('11.00'),
    feeMale: null,
    feeFemale: null,
    feeOther: null,
    feeBeginner: null,
    feeIntermediate: null,
    feeAdvanced: null,
  };
  const before: SessionContent = {
    date: date('2026-11-04'),
    location: 'Rosedale',
    address: '1 Hall Rd',
    maxPlayers: 12,
    reservedSeats: 0,
    fees,
    deadline: { isDefault: true, instant: new Date('2026-11-01T19:00:00.000Z') },
    courts: [
      { identifier: 'Court 1', startTime: '08:00', endTime: '10:00' },
      { identifier: 'Court 2', startTime: '08:00', endTime: '10:00' },
    ],
  };

  it('identical content is no change at all', () => {
    expect(contentChange(before, structuredClone(before))).toEqual({
      changed: [],
      material: false,
    });
  });

  it('capacity and court-name edits are changes but not material', () => {
    const capacity = contentChange(before, { ...before, maxPlayers: 20 });
    expect(capacity).toEqual({ changed: ['maxPlayers'], material: false });
    const seats = contentChange(before, { ...before, reservedSeats: 2 });
    expect(seats).toEqual({ changed: ['reservedSeats'], material: false });
    const renamed = contentChange(before, {
      ...before,
      courts: [
        { identifier: 'Court 1', startTime: '08:00', endTime: '10:00' },
        { identifier: 'Court 3', startTime: '09:00', endTime: '10:00' },
      ],
    });
    expect(renamed).toEqual({ changed: ['courts'], material: false });
  });

  it('date, earliest start, latest end, place, deadline and fees are material', () => {
    const cases: [Partial<SessionContent>, string][] = [
      [{ date: date('2026-11-11') }, 'date'],
      [{ location: 'Elsewhere' }, 'location'],
      [{ address: '2 Hall Rd' }, 'address'],
      [
        {
          courts: [
            { identifier: 'Court 1', startTime: '07:00', endTime: '10:00' },
            { identifier: 'Court 2', startTime: '08:00', endTime: '10:00' },
          ],
        },
        'courts',
      ],
      [
        {
          courts: [
            { identifier: 'Court 1', startTime: '08:00', endTime: '11:00' },
            { identifier: 'Court 2', startTime: '08:00', endTime: '10:00' },
          ],
        },
        'courts',
      ],
      [
        { deadline: { isDefault: false, instant: new Date('2026-11-02T05:00:00.000Z') } },
        'cancellationDeadline',
      ],
      [{ fees: { ...fees, feeFlat: ms('12.00'), calculatedRatePerPlayer: ms('12.00') } }, 'fees'],
    ];
    for (const [patch, field] of cases) {
      const result = contentChange(before, { ...before, ...patch });
      expect(result.changed, field).toContain(field);
      expect(result.material, field).toBe(true);
    }
  });

  it('flipping the deadline to explicit at the same instant is a change that is not material; costs alone are not material', () => {
    const flag = contentChange(before, {
      ...before,
      deadline: { isDefault: false, instant: before.deadline.instant },
    });
    expect(flag).toEqual({ changed: ['cancellationDeadline'], material: false });
    // Court hire moves the suggestion, but a pinned rate keeps every fee: no fee changed.
    const costs = contentChange(before, {
      ...before,
      fees: {
        ...fees,
        totalCourtCost: ms('150.00'),
        calculatedRatePerPlayer: ms('14.00'),
        customPlayerRate: ms('11.00'),
      },
    });
    expect(costs).toEqual({
      changed: ['courtCost', 'calculatedRate', 'customRate'],
      material: false,
    });
  });
});
