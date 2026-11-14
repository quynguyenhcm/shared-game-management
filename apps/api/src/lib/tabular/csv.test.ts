import { describe, expect, it } from 'vitest';
import type { MoneyString } from '@sgm/shared';
import { TabularTooLargeError, integerCell, moneyCell, neutraliseText } from './cells.ts';
import { createCsvWriter } from './csv.ts';

const m = (value: string): MoneyString => value as MoneyString;
const text = (bytes: Uint8Array): string =>
  new TextDecoder('utf-8', { ignoreBOM: true }).decode(bytes);

describe('neutraliseText (AC-VERIFY-5: formula injection, OWASP list plus full-width forms)', () => {
  it('prefixes every trigger with an apostrophe and leaves anything else alone', () => {
    for (const trigger of ['=', '+', '-', '@', '\t', '\r', '＝', '＋', '－', '＠']) {
      expect(neutraliseText(`${trigger}SUM(A1)`)).toBe(`'${trigger}SUM(A1)`);
    }
    expect(neutraliseText('Smith')).toBe('Smith');
    expect(neutraliseText(' =x')).toBe(' =x');
    expect(neutraliseText('')).toBe('');
  });
});

describe('createCsvWriter (RFC 4180, UTF-8 with BOM, CRLF)', () => {
  it('writes a BOM, a header row and CRLF rows, quoting only what needs it and keeping macrons', () => {
    const writer = createCsvWriter({
      header: ['Name', 'Note', 'Total', 'Count'],
      maxBytes: 10_000,
    });
    writer.writeRows([
      ['Hōhepa\'s, "Club"', 'line one\nline two', moneyCell(m('23.00')), integerCell(3)],
      [' padded ', 'plain', moneyCell(m('0.00')), integerCell(0)],
    ]);
    const bytes = writer.finish();
    expect([...bytes.slice(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);
    expect(writer.contentType).toBe('text/csv; charset=utf-8');
    expect(writer.extension).toBe('csv');
    expect(text(bytes.slice(3))).toBe(
      'Name,Note,Total,Count\r\n' +
        '"Hōhepa\'s, ""Club""","line one\nline two",23.00,3\r\n' +
        '" padded ",plain,0.00,0\r\n',
    );
    expect(writer.bytesWritten()).toBe(bytes.length);
  });

  it('neutralises text cells (header included) but never a number cell, and can omit the BOM', () => {
    const writer = createCsvWriter({ header: ['=Header'], maxBytes: 10_000, bom: false });
    writer.writeRows([
      ['=HYPERLINK("http://x","click")'],
      ['+1 Smith'],
      ['@cmd'],
      [moneyCell(m('-0.05'))],
    ]);
    expect(text(writer.finish())).toBe(
      `'=Header\r\n"'=HYPERLINK(""http://x"",""click"")"\r\n'+1 Smith\r\n'@cmd\r\n-0.05\r\n`,
    );
  });

  it('refuses a malformed number cell instead of writing it', () => {
    const writer = createCsvWriter({ header: ['Total'], maxBytes: 10_000 });
    for (const bad of ['1.5', '1e3', '23', ' 1.00', 'NaN']) {
      expect(() => writer.writeRows([[moneyCell(m(bad))]]), bad).toThrow(/money/i);
    }
    expect(() => integerCell(1.5)).toThrow(/integer/i);
  });

  it('refuses to grow past the byte cap while building, and accepts exactly the cap (CR-3)', () => {
    const header = ['A'];
    // BOM (3) + "A\r\n" (3) = 6 bytes; each "xxxx\r\n" row adds 6.
    const exact = createCsvWriter({ header, maxBytes: 18 });
    exact.writeRows([['xxxx'], ['xxxx']]);
    expect(exact.finish().length).toBe(18);

    const over = createCsvWriter({ header, maxBytes: 17 });
    over.writeRows([['xxxx']]);
    const refused = (() => {
      try {
        over.writeRows([['xxxx']]);
      } catch (error) {
        return error;
      }
      return undefined;
    })();
    expect(refused).toBeInstanceOf(TabularTooLargeError);
    expect((refused as TabularTooLargeError).maxBytes).toBe(17);
    // A refused writer never produces a file.
    expect(() => over.finish()).toThrow(TabularTooLargeError);
  });
});
