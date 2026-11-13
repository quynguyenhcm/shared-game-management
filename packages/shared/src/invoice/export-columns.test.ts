import { describe, expect, it } from 'vitest';
import {
  INCOME_EXPORT_COLUMNS,
  INCOME_EXPORT_NO_GAME_DESCRIPTION,
  PAID_BY_LABELS,
  incomeExportDescription,
} from './export-columns.ts';

describe('income export columns (UI/UX A6: one shared list, so the help text cannot drift from the file)', () => {
  it('lists the 11 columns in file order (algorithm ColumnSpec plus the R4 Reference column), each with help text', () => {
    expect(INCOME_EXPORT_COLUMNS.map((column) => column.header)).toEqual([
      'Invoice number',
      'Paid date',
      'Game date',
      'Player',
      'Description',
      'Subtotal',
      'GST',
      'Total',
      'GST registered',
      'Paid by',
      'Reference',
    ]);
    for (const column of INCOME_EXPORT_COLUMNS) expect(column.help.length).toBeGreaterThan(10);
    expect(PAID_BY_LABELS).toEqual({ WALLET: 'Wallet', BANK: 'Bank' });
  });

  it('describes a game fee, a late-withdrawal fee (AC-ERROR-6 wording) and guests, with a fallback for a payment with no game', () => {
    expect(
      incomeExportDescription({
        reason: 'GAME_FEE',
        location: 'Hōkio Sports Hall',
        gameDay: '3 June 2027',
        guests: 0,
      }),
    ).toBe('Game fee, Hōkio Sports Hall, 3 June 2027');
    expect(
      incomeExportDescription({
        reason: 'LATE_WITHDRAWAL',
        location: 'Hōkio Sports Hall',
        gameDay: '3 June 2027',
        guests: 0,
      }),
    ).toBe('Late withdrawal fee, Hōkio Sports Hall, 3 June 2027');
    expect(
      incomeExportDescription({
        reason: 'GAME_FEE',
        location: 'Hall',
        gameDay: '3 June 2027',
        guests: 1,
      }),
    ).toBe('Game fee, Hall, 3 June 2027, with 1 guest');
    expect(
      incomeExportDescription({
        reason: 'LATE_WITHDRAWAL',
        location: 'Hall',
        gameDay: '3 June 2027',
        guests: 2,
      }),
    ).toBe('Late withdrawal fee, Hall, 3 June 2027, with 2 guests');
    expect(INCOME_EXPORT_NO_GAME_DESCRIPTION).toBe('Payment');
  });
});
