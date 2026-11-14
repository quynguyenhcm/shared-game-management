import { randomBytes } from 'node:crypto';
import { strFromU8, unzipSync } from 'fflate';
import readXlsxFile from 'read-excel-file/node';
import { describe, expect, it } from 'vitest';
import type { MoneyString } from '@sgm/shared';
import { TabularTooLargeError, integerCell, moneyCell } from './cells.ts';
import { createXlsxWriter } from './xlsx.ts';

const m = (value: string): MoneyString => value as MoneyString;
/** Numbers come back as the cell's own text, so no test turns money into a JS number. */
const readBack = (bytes: Uint8Array) =>
  readXlsxFile(Buffer.from(bytes), { parseNumber: (value: string) => value });

function sample(maxBytes = 100_000): Uint8Array {
  const writer = createXlsxWriter({ maxBytes });
  writer.startSheet('Payments', ['Player', 'Total', 'Count']);
  writer.writeRows([
    ['Tāne Wīremu', moneyCell(m('23.00')), integerCell(1)],
    ['=HYPERLINK("http://x","click")', moneyCell(m('-0.05')), integerCell(0)],
  ]);
  writer.writeRows([['A & B <c> "d" \u0007bell', moneyCell(m('9999999.99')), integerCell(42)]]);
  writer.startSheet('Summary', ['Item', 'Value']);
  writer.writeRows([
    ['Team', 'Hōkio Badminton Club'],
    ['Total', moneyCell(m('12.30'))],
  ]);
  return writer.finish();
}

describe('createXlsxWriter (in-house OOXML on fflate, architecture E4)', () => {
  it('reads back with an independent reader: sheets in order, numeric money cells, macrons, neutralised text', async () => {
    const sheets = await readBack(sample());
    expect(sheets.map((sheet) => sheet.sheet)).toEqual(['Payments', 'Summary']);
    expect(sheets[0]?.data).toEqual([
      ['Player', 'Total', 'Count'],
      ['Tāne Wīremu', '23.00', '1'],
      [`'=HYPERLINK("http://x","click")`, '-0.05', '0'],
      ['A & B <c> "d" bell', '9999999.99', '42'],
    ]);
    expect(sheets[1]?.data).toEqual([
      ['Item', 'Value'],
      ['Team', 'Hōkio Badminton Club'],
      ['Total', '12.30'],
    ]);
  });

  it('writes no formula, external link, macro or defined name, and formats money cells 0.00 (AC-INTEGRATION-3)', () => {
    const parts = unzipSync(sample());
    const names = Object.keys(parts).sort();
    expect(names).toEqual([
      '[Content_Types].xml',
      '_rels/.rels',
      'xl/_rels/workbook.xml.rels',
      'xl/styles.xml',
      'xl/workbook.xml',
      'xl/worksheets/sheet1.xml',
      'xl/worksheets/sheet2.xml',
    ]);
    const all = names.map((name) => strFromU8(parts[name] ?? new Uint8Array())).join('\n');
    expect(all).not.toMatch(/<f[\s>]|externalLink|vbaProject|definedName|macroEnabled/i);
    const sheet1 = strFromU8(parts['xl/worksheets/sheet1.xml'] ?? new Uint8Array());
    expect(sheet1).toContain('<c r="B2" s="1"><v>23.00</v></c>');
    expect(sheet1).toContain('<c r="C2" s="3"><v>1</v></c>');
    expect(strFromU8(parts['xl/styles.xml'] ?? new Uint8Array())).toContain('numFmtId="2"');
  });

  it('produces identical bytes for identical input (fixed zip times)', () => {
    expect(Buffer.from(sample()).equals(Buffer.from(sample()))).toBe(true);
  });

  it('counts the encoded file against the byte cap while rows are written and refuses past it (CR-3)', () => {
    const writer = createXlsxWriter({ maxBytes: 4_096 });
    writer.startSheet('Payments', ['Player']);
    // Random text barely compresses, so the zip output grows with every page.
    const refused = (() => {
      try {
        for (let i = 0; i < 200; i += 1) writer.writeRows([[randomBytes(600).toString('base64')]]);
      } catch (error) {
        return error;
      }
      return undefined;
    })();
    expect(refused).toBeInstanceOf(TabularTooLargeError);
    expect(writer.bytesWritten()).toBeLessThanOrEqual(4_096);
    expect(() => writer.writeRows([['x']])).toThrow(TabularTooLargeError);
    expect(() => writer.finish()).toThrow(TabularTooLargeError);
    // The same rows fit a large enough cap, and the counted bytes are the file's.
    const roomy = createXlsxWriter({ maxBytes: 1_000_000 });
    roomy.startSheet('Payments', ['Player']);
    roomy.writeRows([['x'.repeat(50)]]);
    expect(roomy.finish().length).toBe(roomy.bytesWritten());
  });

  it('refuses an invalid or duplicate sheet name, rows before a sheet, and an empty workbook', () => {
    const writer = createXlsxWriter({ maxBytes: 10_000 });
    expect(() => writer.writeRows([['x']])).toThrow(/sheet/i);
    expect(() => writer.startSheet('a/b', ['x'])).toThrow(/sheet name/i);
    expect(() => writer.startSheet('x'.repeat(32), ['x'])).toThrow(/sheet name/i);
    writer.startSheet('One', ['x']);
    expect(() => writer.startSheet('One', ['x'])).toThrow(/sheet name/i);
    expect(() => createXlsxWriter({ maxBytes: 10_000 }).finish()).toThrow(/sheet/i);
  });
});
