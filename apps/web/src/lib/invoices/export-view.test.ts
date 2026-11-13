import type { IncomeExportPeriodsResponse } from '@sgm/shared';
import { describe, expect, it } from 'vitest';
import {
  EXPORT_FIELD_FALLBACK,
  defaultExportValues,
  exportApiQuery,
  exportFieldErrors,
  exportLandingPath,
  financialYearOptions,
  gstPeriodGroups,
  readExportForm,
  type ExportFormValues,
} from './export-view.ts';

/**
 * The pure half of the Income exports form (tax-invoices-and-exports Phase 4; AC-HAPPY-6..8, AC-ERROR-3, R2): which fields a
 * plain GET form submits, which of them reach the API, where a refusal lands (with the entered values kept) and how the page
 * re-derives a 422's field messages from the shared rules instead of reading text out of the URL.
 */

const TEAM = '7f3c2b1a-1111-4222-8333-444455556666';
const PERIODS: IncomeExportPeriodsResponse = {
  today: '2027-06-20',
  firstPaidDate: '2027-01-15',
  financialYearsWithPayments: [2026],
  maxRows: 50_000,
  maxRangeDays: 2557,
};

const values = (overrides: Partial<ExportFormValues> = {}): ExportFormValues => ({
  period: 'custom',
  format: 'csv',
  from: '2027-06-01',
  to: '2027-06-15',
  gst: '2m-odd/2027-05',
  year: '2026-27',
  ...overrides,
});

const getter = (query: Record<string, string>) => (name: string) => query[name];

describe('reading the submitted form', () => {
  it('keeps the known period type and caps every value, so nothing long or unknown is echoed back', () => {
    expect(
      readExportForm(getter({ period: 'gst', format: 'xlsx', gst: '2m-even/2027-06' })),
    ).toEqual({
      period: 'gst',
      format: 'xlsx',
      from: '',
      to: '',
      gst: '2m-even/2027-06',
      year: '',
    });
    const odd = readExportForm(getter({ period: 'monthly', from: 'x'.repeat(500) }));
    expect(odd.period).toBeNull();
    expect(odd.from.length).toBeLessThanOrEqual(32);
  });
});

describe('the API query: only the selected period type is consumed', () => {
  it('custom forwards from and to; the GST and financial-year fields the no-JS form also sent are dropped', () => {
    expect(exportApiQuery(values())).toBe('format=csv&period=custom&from=2027-06-01&to=2027-06-15');
  });

  it('a GST period splits into cadence and end month (two-monthly odd and even, six-monthly)', () => {
    expect(exportApiQuery(values({ period: 'gst', format: 'xlsx' }))).toBe(
      'format=xlsx&period=gst&cadence=2m-odd&end=2027-05',
    );
    expect(exportApiQuery(values({ period: 'gst', gst: '6m-mar-sep/2027-03' }))).toBe(
      'format=csv&period=gst&cadence=6m-mar-sep&end=2027-03',
    );
  });

  it('a financial year forwards the year; an unknown period type is refused before any API call', () => {
    expect(exportApiQuery(values({ period: 'fy' }))).toBe('format=csv&period=fy&year=2026-27');
    expect(exportApiQuery(values({ period: null }))).toBeNull();
  });
});

describe('where a refusal lands', () => {
  it('back on the exports page with the selected values, the code and the API field names mapped to form fields', () => {
    expect(
      exportLandingPath(TEAM, values({ period: 'gst' }), 'validation_failed', [
        'end',
        'cadence',
        'bogus',
      ]),
    ).toBe(
      `/teams/${TEAM}/manage/exports?period=gst&gst=2m-odd%2F2027-05&format=csv&download_error=validation_failed&field=gst`,
    );
    expect(exportLandingPath(TEAM, values(), 'export_busy', [])).toBe(
      `/teams/${TEAM}/manage/exports?period=custom&from=2027-06-01&to=2027-06-15&format=csv&download_error=export_busy`,
    );
  });
});

describe('field messages are re-derived from the shared rules (never read from the URL)', () => {
  it('an end before the start, an impossible date, a year that has not started, a bad GST month', () => {
    expect(
      exportFieldErrors(values({ from: '2027-06-10', to: '2027-06-01' }), ['to'], PERIODS.today),
    ).toEqual({ to: ["The end date can't be before the start date"] });
    expect(exportFieldErrors(values({ from: '2027-02-30' }), ['from'], PERIODS.today)).toEqual({
      from: ['Enter a valid start date as YYYY-MM-DD.'],
    });
    expect(
      exportFieldErrors(values({ period: 'fy', year: '2028-29' }), ['year'], PERIODS.today),
    ).toEqual({ year: ['Choose a financial year that has started.'] });
    expect(
      exportFieldErrors(values({ period: 'gst', gst: '2m-odd/2027-06' }), ['gst'], PERIODS.today),
    ).toEqual({ gst: ['Choose a month that ends a GST period.'] });
  });

  it('a field the API flagged that the shared rules now accept still gets a message', () => {
    expect(exportFieldErrors(values(), ['from'], PERIODS.today)).toEqual({
      from: [EXPORT_FIELD_FALLBACK],
    });
  });
});

describe('the option lists', () => {
  it('financial years: newest first, the current one marked not finished', () => {
    expect(financialYearOptions(PERIODS)).toEqual([
      { value: '2027-28', label: '2027-28 (1 April 2027 to 31 March 2028) (not finished)' },
      { value: '2026-27', label: '2026-27 (1 April 2026 to 31 March 2027)' },
    ]);
  });

  it('GST periods (R2): two-monthly odd and even month-ends and six-monthly March/September, newest first', () => {
    const groups = gstPeriodGroups(PERIODS);
    expect(groups.map((group) => group.label)).toEqual([
      'Two-monthly, ending January, March, May, July, September and November',
      'Two-monthly, ending February, April, June, August, October and December',
      'Six-monthly, ending March and September',
    ]);
    expect(groups[0]?.options).toEqual([
      { value: '2m-odd/2027-07', label: '1 June 2027 to 31 July 2027 (not finished)' },
      { value: '2m-odd/2027-05', label: '1 April 2027 to 31 May 2027' },
      { value: '2m-odd/2027-03', label: '1 February 2027 to 31 March 2027' },
      { value: '2m-odd/2027-01', label: '1 December 2026 to 31 January 2027' },
    ]);
    expect(groups[1]?.options.map((option) => option.value)).toEqual([
      '2m-even/2027-06',
      '2m-even/2027-04',
      '2m-even/2027-02',
    ]);
    expect(groups[2]?.options.map((option) => option.value)).toEqual([
      '6m-mar-sep/2027-09',
      '6m-mar-sep/2027-03',
    ]);
  });

  it('defaults: the current financial year, the latest finished GST period, Excel, empty custom dates', () => {
    expect(defaultExportValues(PERIODS)).toEqual({
      period: 'fy',
      format: 'xlsx',
      from: '',
      to: '',
      gst: '2m-odd/2027-05',
      year: '2027-28',
    });
  });
});
