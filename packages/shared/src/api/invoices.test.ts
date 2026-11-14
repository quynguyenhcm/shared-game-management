import { describe, expect, it } from 'vitest';
import { ErrorCode } from './errors.ts';
import { parseLocalDate } from '../time/time.ts';
import {
  GST_CADENCE_WIRE,
  INCOME_EXPORT_ROW_COUNT_HEADER,
  INVOICE_FIELD_MESSAGES,
  IncomeExportPeriodsResponse,
  IncomeExportQuery,
  IncomeExportQueryString,
  PaymentDocumentRef,
  futurePeriodIssue,
} from './invoices.ts';

function issues(schema: { safeParse(v: unknown): unknown }, value: unknown) {
  const result = schema.safeParse(value) as {
    success: boolean;
    error?: { issues: { path: PropertyKey[]; message: string }[] };
  };
  if (result.success) throw new Error('expected a failure');
  return (result.error?.issues ?? []).map((i) => ({ path: i.path.join('.'), message: i.message }));
}

describe('IncomeExportQuery (AC-ERROR-3: one range semantics, resolved on the server)', () => {
  it('resolves the three period types to one local date range plus the format', () => {
    expect(
      IncomeExportQuery.parse({
        format: 'csv',
        period: 'custom',
        from: '2027-06-01',
        to: '2027-06-15',
      }),
    ).toEqual({
      format: 'csv',
      period: { kind: 'custom', range: { from: '2027-06-01', to: '2027-06-15' } },
    });
    expect(
      IncomeExportQuery.parse({ format: 'xlsx', period: 'gst', cadence: '2m-odd', end: '2027-05' }),
    ).toEqual({
      format: 'xlsx',
      period: {
        kind: 'gst',
        cadence: 'TWO_MONTHLY_ODD',
        range: { from: '2027-04-01', to: '2027-05-31' },
      },
    });
    expect(IncomeExportQuery.parse({ format: 'xlsx', period: 'fy', year: '2026-27' })).toEqual({
      format: 'xlsx',
      period: { kind: 'fy', startYear: 2026 },
    });
    expect(Object.keys(GST_CADENCE_WIRE).sort()).toEqual(['2m-even', '2m-odd', '6m-mar-sep']);
  });

  it('refuses unknown keys, formats, periods, cadences, impossible dates, a non-end month and a non-consecutive financial year, each on its field', () => {
    const base = { format: 'csv', period: 'custom', from: '2027-06-01', to: '2027-06-15' };
    expect(issues(IncomeExportQuery, { ...base, extra: 'x' }).length).toBeGreaterThan(0);
    expect(issues(IncomeExportQuery, { ...base, format: 'pdf' }).map((i) => i.path)).toContain(
      'format',
    );
    expect(issues(IncomeExportQuery, { ...base, period: 'weekly' }).length).toBeGreaterThan(0);
    expect(
      issues(IncomeExportQuery, {
        format: 'csv',
        period: 'gst',
        cadence: '1m',
        end: '2027-05',
      }).map((i) => i.path),
    ).toContain('cadence');
    const only = (value: unknown): { path: string; message: string } => {
      const found = issues(IncomeExportQuery, value);
      expect(found).toHaveLength(1);
      return found[0] ?? { path: '', message: '' };
    };
    const badStart = only({ ...base, from: '2027-02-30' });
    expect(badStart.path).toBe('from');
    expect(badStart.message).toMatch(/start date/i);
    const badEnd = only({ format: 'csv', period: 'gst', cadence: '2m-odd', end: '2027-04' });
    expect(badEnd.path).toBe('end');
    expect(badEnd.message).toMatch(/period/i);
    const badYear = only({ format: 'csv', period: 'fy', year: '2026-28' });
    expect(badYear.path).toBe('year');
    expect(badYear.message).toMatch(/financial year/i);
  });

  it('refuses a financial year or GST period end outside 2000..2099 on its field, never with a throw (a five-digit end date)', () => {
    const fieldOf = (value: unknown): string[] =>
      issues(IncomeExportQuery, value).map((issue) => issue.path);
    // 9999-00 is a well-formed label, but 31 March 10000 is not a date: a 422 on `year`, not a 500.
    expect(fieldOf({ format: 'csv', period: 'fy', year: '9999-00' })).toEqual(['year']);
    expect(fieldOf({ format: 'csv', period: 'fy', year: '2100-01' })).toEqual(['year']);
    expect(
      IncomeExportQuery.parse({ format: 'csv', period: 'fy', year: '2099-00' }).period,
    ).toEqual({ kind: 'fy', startYear: 2099 });
    for (const end of ['9999-11', '2100-01', '1999-11']) {
      expect(fieldOf({ format: 'csv', period: 'gst', cadence: '2m-odd', end }), end).toEqual([
        'end',
      ]);
    }
    expect(
      IncomeExportQuery.parse({ format: 'csv', period: 'gst', cadence: '2m-odd', end: '2099-11' })
        .period,
    ).toMatchObject({ kind: 'gst', range: { from: '2099-10-01', to: '2099-11-30' } });
  });
});

describe('invoice contracts shared with the billing and dashboard features', () => {
  it('declares the document reference, the periods response and the three new error codes', () => {
    expect(PaymentDocumentRef.parse({ kind: 'RECEIPT', available: true, number: null })).toEqual({
      kind: 'RECEIPT',
      available: true,
      number: null,
    });
    expect(
      issues(PaymentDocumentRef, { kind: 'INVOICE', available: true, number: 'INV-000001' }).length,
    ).toBeGreaterThan(0);
    expect(
      IncomeExportPeriodsResponse.parse({
        today: '2027-06-20',
        firstPaidDate: null,
        financialYearsWithPayments: [2026],
        maxRows: 50000,
        maxRangeDays: 2557,
      }),
    ).toMatchObject({ today: '2027-06-20', maxRows: 50000, maxRangeDays: 2557 });
    // The web reads the row cap from the API (it is env-configured), never from a copied constant.
    expect(
      issues(IncomeExportPeriodsResponse, {
        today: '2027-06-20',
        firstPaidDate: null,
        financialYearsWithPayments: [2026],
      }).map((i) => i.path),
    ).toEqual(expect.arrayContaining(['maxRows', 'maxRangeDays']));
    expect(ErrorCode).toEqual(
      expect.arrayContaining([
        'invoice_not_available',
        'invoice_pending',
        'export_too_large',
        'export_busy',
      ]),
    );
    expect(INCOME_EXPORT_ROW_COUNT_HEADER).toBe('x-export-row-count');
  });
});

describe('IncomeExportQueryString (the route querystring: flat for OpenAPI, then the same union)', () => {
  it('resolves exactly like IncomeExportQuery and refuses the same inputs on the same fields', () => {
    const custom = { format: 'csv', period: 'custom', from: '2027-06-01', to: '2027-06-15' };
    expect(IncomeExportQueryString.parse(custom)).toEqual(IncomeExportQuery.parse(custom));
    const fy = { format: 'xlsx', period: 'fy', year: '2026-27' };
    expect(IncomeExportQueryString.parse(fy)).toEqual(IncomeExportQuery.parse(fy));
    expect(issues(IncomeExportQueryString, { ...custom, from: '2027-02-30' })).toEqual([
      { path: 'from', message: INVOICE_FIELD_MESSAGES.startDateInvalid },
    ]);
    expect(
      issues(IncomeExportQueryString, { ...custom, period: 'weekly' }).map((i) => i.path),
    ).toEqual(['period']);
    expect(issues(IncomeExportQueryString, { ...custom, x: '1' }).length).toBeGreaterThan(0);
    // A key of another period type is refused too (the union members are strict).
    expect(issues(IncomeExportQueryString, { ...fy, from: '2027-06-01' }).length).toBeGreaterThan(
      0,
    );
  });
});

describe('export periods that have not started (AC-ERROR-3: future-only)', () => {
  it('refuses a financial year or a GST period that starts after today, on its own field', () => {
    const today = parseLocalDate('2027-06-20');
    expect(futurePeriodIssue({ kind: 'fy', startYear: 2027 }, today)).toBeNull();
    expect(futurePeriodIssue({ kind: 'fy', startYear: 2028 }, today)).toEqual({
      field: 'year',
      message: INVOICE_FIELD_MESSAGES.financialYearNotStarted,
    });
    const gst = (from: string, to: string) =>
      ({
        kind: 'gst',
        cadence: 'TWO_MONTHLY_ODD',
        range: { from: parseLocalDate(from), to: parseLocalDate(to) },
      }) as const;
    expect(futurePeriodIssue(gst('2027-06-01', '2027-07-31'), today)).toBeNull();
    expect(futurePeriodIssue(gst('2027-08-01', '2027-09-30'), today)).toEqual({
      field: 'end',
      message: INVOICE_FIELD_MESSAGES.periodNotStarted,
    });
    // A custom range is checked by `validateExportRange` (it has its own start-date message).
    const custom = {
      kind: 'custom',
      range: { from: parseLocalDate('2027-07-01'), to: parseLocalDate('2027-07-02') },
    } as const;
    expect(futurePeriodIssue(custom, today)).toBeNull();
  });
});
