/**
 * Financial-year, GST-period and custom-range helpers (tax-invoices-and-exports, algorithm D1; AC-HAPPY-7, AC-HAPPY-8,
 * AC-VERIFY-3). Every boundary is a Pacific/Auckland wall-clock date converted through the one `toInstantRange`, so the
 * partition properties below prove no payment is counted twice or dropped, including across the DST weekends.
 */
import { describe, expect, it } from 'vitest';
import { instantToLocal, parseLocalDate, type LocalDate } from '../time/time.ts';
import {
  GST_CADENCES,
  MAX_RANGE_DAYS,
  describePeriod,
  financialYear,
  financialYearOf,
  formatFinancialYear,
  gstPeriodContaining,
  gstPeriodEndingIn,
  inclusiveDays,
  listFinancialYears,
  listGstPeriods,
  parseFinancialYear,
  previousGstPeriod,
  toInstantRange,
  validateExportRange,
  type GstCadence,
  type LocalDateRange,
} from './periods.ts';

const d = (value: string): LocalDate => parseLocalDate(value);
const range = (from: string, to: string): LocalDateRange => ({ from: d(from), to: d(to) });
const iso = (instant: Date): string => instant.toISOString();
const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;

const CADENCES: readonly [string, GstCadence][] = [
  ['TWO_MONTHLY_ODD', GST_CADENCES.TWO_MONTHLY_ODD],
  ['TWO_MONTHLY_EVEN', GST_CADENCES.TWO_MONTHLY_EVEN],
  ['SIX_MONTHLY_MAR_SEP', GST_CADENCES.SIX_MONTHLY_MAR_SEP],
];

describe('financial year (1 April to 31 March)', () => {
  it('names, formats and parses the year, and refuses a label that does not describe consecutive years', () => {
    expect(financialYear(2026)).toEqual(range('2026-04-01', '2027-03-31'));
    expect(financialYearOf(d('2027-03-31'))).toBe(2026);
    expect(financialYearOf(d('2027-04-01'))).toBe(2027);
    expect(formatFinancialYear(2026)).toBe('2026-27');
    expect(formatFinancialYear(1999)).toBe('1999-00');
    expect(formatFinancialYear(2099)).toBe('2099-00');
    expect(parseFinancialYear('2026-27')).toBe(2026);
    expect(parseFinancialYear('2099-00')).toBe(2099);
    for (const bad of [
      '2026-28',
      '2026/27',
      '26-27',
      '1999-00',
      '2026-2027',
      '',
      '2100-01',
      '9999-00',
    ]) {
      expect(() => parseFinancialYear(bad), bad).toThrow(/financial year/i);
    }
  });

  it('puts 31 March 23:59:59 NZDT in 2026-27 and 1 April 00:00 NZDT in 2027-28 (AC-HAPPY-8)', () => {
    const fy2026 = toInstantRange(financialYear(2026));
    const fy2027 = toInstantRange(financialYear(2027));
    expect(iso(fy2026.from)).toBe('2026-03-31T11:00:00.000Z');
    expect(iso(fy2026.to)).toBe('2027-03-31T11:00:00.000Z');
    expect(iso(fy2027.from)).toBe('2027-03-31T11:00:00.000Z');
    const lastSecond = new Date('2027-03-31T10:59:59.000Z');
    const firstSecond = new Date('2027-03-31T11:00:00.000Z');
    expect(lastSecond >= fy2026.from && lastSecond < fy2026.to).toBe(true);
    expect(firstSecond >= fy2026.to).toBe(true);
    expect(firstSecond >= fy2027.from && firstSecond < fy2027.to).toBe(true);
  });
});

describe('GST periods (two-monthly in both alignments, six-monthly, R2)', () => {
  it('returns the period containing a date for every month of 2026 to 2028, ending in the right month parity', () => {
    for (let year = 2026; year <= 2028; year += 1) {
      for (let month = 1; month <= 12; month += 1) {
        const date = d(`${year}-${String(month).padStart(2, '0')}-15`);
        const odd = gstPeriodContaining(date, GST_CADENCES.TWO_MONTHLY_ODD);
        const even = gstPeriodContaining(date, GST_CADENCES.TWO_MONTHLY_EVEN);
        expect(Number(odd.to.slice(5, 7)) % 2, date).toBe(1);
        expect(Number(even.to.slice(5, 7)) % 2, date).toBe(0);
        for (const found of [odd, even]) {
          expect(inclusiveDays(found)).toBeGreaterThanOrEqual(59);
          expect(inclusiveDays(found)).toBeLessThanOrEqual(62);
          expect(found.from <= date && date <= found.to).toBe(true);
        }
      }
    }
    // Dec-Jan under the odd alignment crosses the calendar year; April-May is the AC-HAPPY-7 period.
    expect(gstPeriodContaining(d('2026-12-20'), GST_CADENCES.TWO_MONTHLY_ODD)).toEqual(
      range('2026-12-01', '2027-01-31'),
    );
    expect(gstPeriodEndingIn('2027-05', GST_CADENCES.TWO_MONTHLY_ODD)).toEqual(
      range('2027-04-01', '2027-05-31'),
    );
    expect(gstPeriodContaining(d('2026-12-20'), GST_CADENCES.SIX_MONTHLY_MAR_SEP)).toEqual(
      range('2026-10-01', '2027-03-31'),
    );
    expect(gstPeriodContaining(d('2027-04-01'), GST_CADENCES.SIX_MONTHLY_MAR_SEP)).toEqual(
      range('2027-04-01', '2027-09-30'),
    );
    expect(() => gstPeriodEndingIn('2027-04', GST_CADENCES.TWO_MONTHLY_ODD)).toThrow(
      /does not end/i,
    );
    expect(
      previousGstPeriod(range('2027-04-01', '2027-05-31'), GST_CADENCES.TWO_MONTHLY_ODD),
    ).toEqual(range('2027-02-01', '2027-03-31'));
  });

  it('handles leap-year February: 29 February 2028 sits in Jan-Feb 2028, which ends one instant later than in 2027', () => {
    const leap = gstPeriodContaining(d('2028-02-29'), GST_CADENCES.TWO_MONTHLY_EVEN);
    expect(leap).toEqual(range('2028-01-01', '2028-02-29'));
    expect(iso(toInstantRange(leap).to)).toBe('2028-02-29T11:00:00.000Z');
    expect(gstPeriodContaining(d('2027-02-28'), GST_CADENCES.TWO_MONTHLY_EVEN).to).toBe(
      '2027-02-28',
    );
    expect(financialYear(2099).to).toBe('2100-03-31');
    expect(gstPeriodEndingIn('2100-02', GST_CADENCES.TWO_MONTHLY_EVEN).to).toBe('2100-02-28');
    expect(gstPeriodEndingIn('2000-02', GST_CADENCES.TWO_MONTHLY_EVEN).to).toBe('2000-02-29');
  });
});

describe('local range to instant range (P3: the one conversion)', () => {
  it('places each boundary at 00:00 NZ local time, whatever the offset, as a half-open [from, to) pair', () => {
    const boundaries: readonly [string, string][] = [
      ['1 Jun 2027 00:00 NZST, odd boundary Apr-May / Jun-Jul', '2027-05-31T12:00:00.000Z'],
      ['1 Dec 2026 00:00 NZDT, odd boundary Oct-Nov / Dec-Jan', '2026-11-30T11:00:00.000Z'],
      ['1 Jan 2027 00:00 NZDT, even boundary Nov-Dec / Jan-Feb', '2026-12-31T11:00:00.000Z'],
    ];
    const starts = [d('2027-06-01'), d('2026-12-01'), d('2027-01-01')];
    boundaries.forEach(([label, expected], index) => {
      const start = starts[index] as LocalDate;
      expect(iso(toInstantRange({ from: start, to: start }).from), label).toBe(expected);
    });
    // A single-day range is exactly that local day: 23 h on the spring-forward day, 25 h on the fall-back day.
    const spring = toInstantRange({ from: d('2026-09-27'), to: d('2026-09-27') });
    const fall = toInstantRange({ from: d('2027-04-04'), to: d('2027-04-04') });
    expect((spring.to.getTime() - spring.from.getTime()) / HOUR_MS).toBe(23);
    expect((fall.to.getTime() - fall.from.getTime()) / HOUR_MS).toBe(25);
  });

  it('every financial year 2026 to 2035 spans exactly days x 24 h, and periods holding a DST change span days x 24 h -/+ 1 h', () => {
    for (let year = 2026; year <= 2035; year += 1) {
      const fy = financialYear(year);
      const instants = toInstantRange(fy);
      expect(instants.to.getTime() - instants.from.getTime(), String(year)).toBe(
        inclusiveDays(fy) * DAY_MS,
      );
    }
    // 26 Sep 2027 (spring forward, loses an hour) and 4 Apr 2027 (fall back, gains one).
    const springPeriod = gstPeriodContaining(d('2027-09-26'), GST_CADENCES.TWO_MONTHLY_ODD);
    const fallPeriod = gstPeriodContaining(d('2027-04-04'), GST_CADENCES.TWO_MONTHLY_ODD);
    const span = (r: LocalDateRange): number => {
      const instants = toInstantRange(r);
      return instants.to.getTime() - instants.from.getTime() - inclusiveDays(r) * DAY_MS;
    };
    expect(span(springPeriod)).toBe(-HOUR_MS);
    expect(span(fallPeriod)).toBe(HOUR_MS);
  });

  it(
    'partitions time: consecutive periods touch, and every sampled instant is in exactly one period of each kind, ' +
      'matching its NZ-local date (AC-VERIFY-3)',
    () => {
      type Series = { name: string; periodOf: (date: LocalDate) => LocalDateRange };
      const series: Series[] = [
        ...CADENCES.map(([name, cadence]) => ({
          name,
          periodOf: (date: LocalDate) => gstPeriodContaining(date, cadence),
        })),
        {
          name: 'FINANCIAL_YEAR',
          periodOf: (date: LocalDate) => financialYear(financialYearOf(date)),
        },
      ];
      // Instants: hourly 2026-2028, 15-minute steps around each DST weekend, and +/-1 ms around every period boundary.
      const samples = new Set<number>();
      const start = Date.parse('2026-01-01T00:00:00Z');
      for (let at = start; at < Date.parse('2029-01-01T00:00:00Z'); at += HOUR_MS) samples.add(at);
      for (const weekend of ['2026-09-26', '2027-04-03', '2027-09-25', '2028-04-01']) {
        const from = Date.parse(`${weekend}T00:00:00Z`);
        for (let at = from; at < from + 3 * DAY_MS; at += 15 * 60_000) samples.add(at);
      }
      for (const { periodOf } of series) {
        let cursor = periodOf(d('2026-01-01'));
        for (let step = 0; step < 40; step += 1) {
          const instants = toInstantRange(cursor);
          for (const edge of [instants.from.getTime(), instants.to.getTime()]) {
            samples.add(edge - 1);
            samples.add(edge);
          }
          const next = periodOf(
            parseLocalDate(
              new Date(Date.parse(`${cursor.to}T00:00:00Z`) + DAY_MS).toISOString().slice(0, 10),
            ),
          );
          // to(k) === from(k+1): the end instant of one period is the start instant of the next.
          expect(iso(toInstantRange(next).from)).toBe(iso(instants.to));
          cursor = next;
        }
      }
      const cache = new Map<string, { from: Date; to: Date }>();
      const instantsOf = (r: LocalDateRange): { from: Date; to: Date } => {
        const key = `${r.from}|${r.to}`;
        let value = cache.get(key);
        if (value === undefined) {
          value = toInstantRange(r);
          cache.set(key, value);
        }
        return value;
      };
      for (const { name, periodOf } of series) {
        for (const at of samples) {
          const instant = new Date(at);
          const local = instantToLocal(instant).date;
          const found = periodOf(local);
          const { from, to } = instantsOf(found);
          // The period chosen from the local date contains the instant, and the date test equals the half-open test.
          expect(instant >= from && instant < to, `${name} ${instant.toISOString()}`).toBe(true);
          expect(local >= found.from && local <= found.to).toBe(true);
        }
      }
    },
    60_000,
  );
});

describe('option lists and range validation', () => {
  it('lists financial years (payment years plus the current one, newest first) and GST periods (newest first, contiguous, capped)', () => {
    expect(listFinancialYears({ today: d('2029-05-10'), yearsWithPayments: [2026, 2028] })).toEqual(
      [2029, 2028, 2026],
    );
    expect(listFinancialYears({ today: d('2026-11-13'), yearsWithPayments: [] })).toEqual([2026]);
    // 31 Mar 23:30 NZDT is still 2026-27; the NZ date decides, not the UTC date.
    expect(
      listFinancialYears({
        today: instantToLocal(new Date('2027-03-31T10:30:00Z')).date,
        yearsWithPayments: [],
      }),
    ).toEqual([2026]);

    const periods = listGstPeriods({
      today: d('2027-05-20'),
      firstPaidDate: d('2026-11-03'),
      cadence: GST_CADENCES.TWO_MONTHLY_ODD,
      maxRangeDays: MAX_RANGE_DAYS,
    });
    expect(periods.map((p) => `${p.from}..${p.to}`)).toEqual([
      '2027-04-01..2027-05-31',
      '2027-02-01..2027-03-31',
      '2026-12-01..2027-01-31',
      '2026-10-01..2026-11-30',
    ]);
    const capped = listGstPeriods({
      today: d('2027-05-20'),
      firstPaidDate: d('2000-01-01'),
      cadence: GST_CADENCES.TWO_MONTHLY_ODD,
      maxRangeDays: MAX_RANGE_DAYS,
    });
    expect(capped.length).toBeLessThanOrEqual(42);
    expect(capped[0]).toEqual(range('2027-04-01', '2027-05-31'));
  });

  it('validates a custom range in the documented order with the documented field messages (AC-ERROR-3)', () => {
    const today = d('2027-06-20');
    const ok = validateExportRange(range('2027-06-01', '2027-06-15'), today);
    expect(ok).toBeNull();
    expect(validateExportRange(range('2027-06-10', '2027-06-10'), today)).toBeNull();
    expect(validateExportRange(range('2027-06-15', '2027-06-01'), today)).toEqual({
      field: 'to',
      message: "The end date can't be before the start date",
    });
    expect(validateExportRange(range('2027-07-01', '2027-07-31'), today)).toEqual({
      field: 'from',
      message: "The start date can't be in the future",
    });
    // 2,557 inclusive days is accepted; 2,558 is refused (R3: 7 years).
    const longEnd = (days: number): LocalDate => {
      const from = Date.parse('2020-06-01T00:00:00Z');
      return parseLocalDate(new Date(from + (days - 1) * DAY_MS).toISOString().slice(0, 10));
    };
    expect(MAX_RANGE_DAYS).toBe(2557);
    expect(
      validateExportRange({ from: d('2020-06-01'), to: longEnd(2557) }, d('2027-12-31')),
    ).toBeNull();
    expect(
      validateExportRange({ from: d('2020-06-01'), to: longEnd(2558) }, d('2027-12-31')),
    ).toEqual({
      field: 'to',
      message: 'Choose a range of 7 years or less',
    });
  });

  it('describes each period with a label and a file-name stem (AC-HAPPY-7)', () => {
    expect(
      describePeriod({ kind: 'custom', range: range('2027-06-01', '2027-06-15') }),
    ).toMatchObject({
      kind: 'custom',
      fileStem: '2027-06-01_to_2027-06-15',
    });
    expect(
      describePeriod({
        kind: 'gst',
        cadence: 'TWO_MONTHLY_ODD',
        range: range('2027-04-01', '2027-05-31'),
      }),
    ).toMatchObject({ kind: 'gst', fileStem: 'gst_2027-04_to_2027-05' });
    const fy = describePeriod({ kind: 'fy', startYear: 2026 });
    expect(fy).toMatchObject({
      kind: 'fy',
      range: range('2026-04-01', '2027-03-31'),
      fileStem: 'fy_2026-27',
    });
    expect(fy.label).toContain('2026-27');
  });
});
