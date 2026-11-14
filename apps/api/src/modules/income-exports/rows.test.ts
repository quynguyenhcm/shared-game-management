import { describe, expect, it } from 'vitest';
import {
  INCOME_EXPORT_COLUMNS,
  describePeriod,
  parseLocalDate,
  type MoneyString,
} from '@sgm/shared';
import { moneyCell } from '../../lib/tabular/cells.ts';
import {
  Reconciler,
  exportFilename,
  summaryRows,
  toExportRow,
  type ExportSourceRow,
  type ExportSummary,
} from './rows.ts';

const m = (value: string): MoneyString => value as MoneyString;

function source(overrides: Partial<ExportSourceRow> = {}): ExportSourceRow {
  return {
    id: '00000000-0000-4000-8000-000000000001',
    numberDisplay: 'INV-000007',
    paidAt: new Date('2027-03-31T11:00:00.000Z'),
    gameStartsAt: new Date('2027-03-30T06:30:00.000Z'),
    payerName: 'Aroha Ngata',
    location: 'Hōkio Sports Hall',
    chargeReason: 'GAME_FEE',
    guests: 0,
    amount: m('23.00'),
    subtotalAmount: m('20.00'),
    gstAmount: m('3.00'),
    gstRegistered: true,
    billingType: 'PER_GAME',
    paymentReference: 'SGM0000ABCD',
    ...overrides,
  };
}

describe('toExportRow (algorithm "Export columns": stored values, never recomputed)', () => {
  it('builds the 11 cells in column order, NZ-local dates, stored money as number cells', () => {
    const row = toExportRow(source());
    expect(row).toHaveLength(INCOME_EXPORT_COLUMNS.length);
    expect(row).toEqual([
      'INV-000007',
      // 2027-03-31T11:00Z is 1 April 00:00 NZDT: the paid date is NZ local, never the UTC date.
      '2027-04-01',
      '2027-03-30',
      'Aroha Ngata',
      'Game fee, Hōkio Sports Hall, 30 March 2027',
      moneyCell(m('20.00')),
      moneyCell(m('3.00')),
      moneyCell(m('23.00')),
      'Yes',
      'Bank',
      'SGM0000ABCD',
    ]);
  });

  it('shows wallet payments, late-withdrawal wording, guests, receipts and an unregistered team as they are', () => {
    const row = toExportRow(
      source({
        numberDisplay: 'RCT-000002',
        billingType: 'PREPAID_CREDIT',
        chargeReason: 'LATE_WITHDRAWAL',
        guests: 1,
        gstRegistered: false,
        subtotalAmount: m('23.00'),
        gstAmount: m('0.00'),
      }),
    );
    expect(row[0]).toBe('RCT-000002');
    expect(row[4]).toBe('Late withdrawal fee, Hōkio Sports Hall, 30 March 2027, with 1 guest');
    expect(row[6]).toEqual(moneyCell(m('0.00')));
    expect(row[8]).toBe('No');
    expect(row[9]).toBe('Wallet');
  });

  it('lists a $0.00 payment with an empty number and an empty "Paid by" (AC-ERROR-5), and a payment with no game', () => {
    const zero = toExportRow(
      source({
        numberDisplay: null,
        amount: m('0.00'),
        subtotalAmount: m('0.00'),
        gstAmount: m('0.00'),
      }),
    );
    expect(zero[0]).toBe('');
    expect(zero[7]).toEqual(moneyCell(m('0.00')));
    expect(zero[9]).toBe('');
    const noGame = toExportRow(source({ gameStartsAt: null, location: null }));
    expect(noGame[2]).toBe('');
    expect(noGame[4]).toBe('Payment');
  });
});

describe('Reconciler (the Summary equals the row sums)', () => {
  it('sums count and the three money columns exactly, and throws on any mismatch with the preflight', () => {
    const reconciler = new Reconciler();
    reconciler.add(source());
    reconciler.add(
      source({ amount: m('37.00'), subtotalAmount: m('32.17'), gstAmount: m('4.83') }),
    );
    const summary: Pick<ExportSummary, 'rows' | 'total' | 'subtotal' | 'gst'> = {
      rows: 2,
      total: m('60.00'),
      subtotal: m('52.17'),
      gst: m('7.83'),
    };
    expect(() => reconciler.assertEquals(summary)).not.toThrow();
    expect(() => reconciler.assertEquals({ ...summary, gst: m('7.82') })).toThrow(/reconcile/i);
    expect(() => reconciler.assertEquals({ ...summary, rows: 3 })).toThrow(/reconcile/i);
  });
});

describe('summaryRows and the file name', () => {
  const period = describePeriod({
    kind: 'custom',
    range: { from: parseLocalDate('2027-06-01'), to: parseLocalDate('2027-06-15') },
  });
  const summary: ExportSummary = {
    rows: 3,
    numbered: 2,
    zero: 1,
    awaiting: 0,
    total: m('46.00'),
    subtotal: m('40.00'),
    gst: m('6.00'),
    gstNumbers: ['49091850'],
  };

  it('labels every Summary value (team, GST number, period, counts, totals) without a formula', () => {
    const rows = summaryRows({
      teamName: 'Hōkio Badminton Club',
      period,
      summary,
      generatedAt: new Date('2027-06-20T00:00:00.000Z'),
    });
    expect(rows).toEqual(
      expect.arrayContaining([
        ['Team', 'Hōkio Badminton Club'],
        ['GST number', '49-091-850'],
        ['Period', '01/06/2027 to 15/06/2027'],
        ['Generated', '20/06/2027 12:00 pm'],
        ['Payments', { number: '3', format: 'integer' }],
        ['$0.00 payments (no document)', { number: '1', format: 'integer' }],
        ['Subtotal (excluding GST)', moneyCell(m('40.00'))],
        ['GST', moneyCell(m('6.00'))],
        ['Total (including GST)', moneyCell(m('46.00'))],
      ]),
    );
    const unregistered = summaryRows({
      teamName: 'X',
      period,
      summary: { ...summary, gstNumbers: [] },
      generatedAt: new Date('2027-06-20T00:00:00.000Z'),
    });
    expect(unregistered).toEqual(expect.arrayContaining([['GST number', 'Not registered']]));
  });

  it('names the file after the team slug, the period and the format, ASCII only', () => {
    expect(exportFilename('Hōkio Badminton Club', period, 'csv')).toBe(
      'income_hokio-badminton-club_2027-06-01_to_2027-06-15.csv',
    );
    const fy = describePeriod({ kind: 'fy', startYear: 2026 });
    expect(exportFilename('Whangārei "Shuttlers" & Co!', fy, 'xlsx')).toBe(
      'income_whangarei-shuttlers-co_fy_2026-27.xlsx',
    );
    expect(exportFilename('ŌŌŌ', fy, 'csv')).toBe('income_ooo_fy_2026-27.csv');
    expect(exportFilename('日本', fy, 'csv')).toBe('income_team_fy_2026-27.csv');
    expect(exportFilename('a'.repeat(80), fy, 'csv')).toBe(
      `income_${'a'.repeat(40)}_fy_2026-27.csv`,
    );
  });
});
