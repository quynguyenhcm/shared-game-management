import { describe, expect, it } from 'vitest';
import { ErrorCode } from './errors.ts';
import {
  GST_CADENCE_WIRE,
  IncomeExportPeriodsResponse,
  IncomeExportQuery,
  PaymentDocumentRef,
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
      }),
    ).toMatchObject({ today: '2027-06-20' });
    expect(ErrorCode).toEqual(
      expect.arrayContaining(['invoice_not_available', 'invoice_pending', 'export_too_large']),
    );
  });
});
