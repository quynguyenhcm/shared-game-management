/**
 * A minimal in-house XLSX (Office Open XML spreadsheet) writer on `fflate` (tax-invoices-and-exports architecture E4,
 * AC-HAPPY-9, AC-INTEGRATION-3). It writes exactly the parts a workbook needs: `[Content_Types].xml`, `_rels/.rels`,
 * `xl/workbook.xml`, `xl/_rels/workbook.xml.rels`, `xl/styles.xml` and one `xl/worksheets/sheetN.xml` per sheet.
 *
 * - Text cells are inline strings (`t="inlineStr"`, no shared-strings table), neutralised like the CSV and XML-escaped, with
 *   characters XML cannot carry removed. Number cells are `<v>` elements copied from their exact decimal text (P2: no JS
 *   number), styled `0.00` (money, built-in format 2) or `0` (integer, built-in format 1). The header row is bold.
 * - It can write no formula, external link, macro or defined name: there is no API for them.
 * - Sheets are streamed: each `writeRows` page is encoded and deflated into the zip at once, so the uncompressed XML is never
 *   held; only the encoded file is. Those encoded bytes (what this writer holds and will send) are counted against `maxBytes`
 *   as the zip emits them, and checked after every write; past the cap the writer throws `TabularTooLargeError` and never
 *   produces a file (CR-3). Zip entry times are fixed, so equal input gives equal bytes.
 */
import { Zip, ZipDeflate, strToU8 } from 'fflate';
import {
  ByteBudget,
  neutraliseText,
  numberText,
  type TabularCell,
  type TabularRow,
  type TabularWriter,
} from './cells.ts';

export interface XlsxWriterOptions {
  readonly maxBytes: number;
}

export interface XlsxWriter extends TabularWriter {
  readonly extension: 'xlsx';
  /** Ends the current sheet (if any) and starts a new one with a bold header row. Sheets keep this order. */
  startSheet(name: string, header: readonly string[]): void;
  /** Appends rows to the current sheet. */
  writeRows(rows: readonly TabularRow[]): void;
  /** Ends the last sheet and returns the complete workbook. Throws if the cap was ever exceeded. */
  finish(): Uint8Array;
}

const MAIN_NS = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main';
const REL_NS = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const PKG_REL_NS = 'http://schemas.openxmlformats.org/package/2006/relationships';
const XML_HEAD = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n';
/** Fixed zip entry time (DOS time has no zone and starts in 1980), so the same input always gives the same bytes. */
const ENTRY_TIME = new Date(2000, 0, 1, 0, 0, 0);
const DEFLATE_LEVEL = 6;
const COLUMN_WIDTH = 18;

const STYLE = { text: 0, money: 1, header: 2, integer: 3 } as const;

/** Characters XML 1.0 cannot carry (C0 controls except tab, LF and CR; U+FFFE/U+FFFF; lone surrogates). */
const XML_INVALID =
  // eslint-disable-next-line no-control-regex -- matching the control characters XML forbids is the point: they are removed.
  /[\u0000-\u0008\u000B\u000C\u000E-\u001F\uFFFE\uFFFF]|[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g;

function escapeXml(text: string): string {
  return text
    .replace(XML_INVALID, '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll('\r', '&#13;');
}

/** `A`, `B`, ... `Z`, `AA`, ... for a zero-based column index. */
function columnName(index: number): string {
  let name = '';
  let rest = index + 1;
  while (rest > 0) {
    const digit = (rest - 1) % 26;
    name = String.fromCharCode(65 + digit) + name;
    rest = (rest - 1 - digit) / 26;
  }
  return name;
}

function cellXml(cell: TabularCell, ref: string, style: number): string {
  if (typeof cell === 'string') {
    return `<c r="${ref}" t="inlineStr"${style === STYLE.text ? '' : ` s="${style}"`}><is><t xml:space="preserve">${escapeXml(neutraliseText(cell))}</t></is></c>`;
  }
  const numberStyle = cell.format === 'money' ? STYLE.money : STYLE.integer;
  return `<c r="${ref}" s="${numberStyle}"><v>${numberText(cell)}</v></c>`;
}

function rowXml(row: TabularRow, rowNumber: number, style: number): string {
  const cells = row.map((cell, index) => cellXml(cell, `${columnName(index)}${rowNumber}`, style));
  return `<row r="${rowNumber}">${cells.join('')}</row>`;
}

const SHEET_NAME_INVALID = /[[\]:*?/\\]/;

const STYLES_XML =
  `${XML_HEAD}<styleSheet xmlns="${MAIN_NS}">` +
  '<fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><name val="Calibri"/></font></fonts>' +
  '<fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills>' +
  '<borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>' +
  '<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>' +
  '<cellXfs count="4">' +
  '<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>' +
  '<xf numFmtId="2" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>' +
  '<xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/>' +
  '<xf numFmtId="1" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>' +
  '</cellXfs>' +
  '<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>' +
  '</styleSheet>';

/** A deflated zip entry with the fixed entry time. */
function entry(name: string): ZipDeflate {
  const file = new ZipDeflate(name, { level: DEFLATE_LEVEL });
  file.mtime = ENTRY_TIME;
  return file;
}

interface OpenSheet {
  readonly file: ZipDeflate;
  nextRow: number;
}

export function createXlsxWriter(options: XlsxWriterOptions): XlsxWriter {
  const budget = new ByteBudget(options.maxBytes);
  const chunks: Uint8Array[] = [];
  let zipError: Error | null = null;
  let complete = false;
  const zip = new Zip((error, data, final) => {
    if (error !== null) {
      zipError = error;
      return;
    }
    chunks.push(data);
    if (final) complete = true;
    try {
      budget.take(data.length);
    } catch {
      // Never throw inside fflate's callback: the budget is now refused, and `write` reports it right after the push.
    }
  });
  const sheetNames: string[] = [];
  let current: OpenSheet | null = null;

  /** Deflates `xml` into `file`, then refuses if the encoded output has passed the cap. */
  function write(file: ZipDeflate, xml: string, final = false): void {
    budget.assertOpen();
    file.push(strToU8(xml), final);
    budget.assertOpen();
  }

  function addPart(name: string, xml: string): void {
    const file = entry(name);
    zip.add(file);
    write(file, xml, true);
  }

  function endSheet(): void {
    if (current === null) return;
    write(current.file, '</sheetData></worksheet>', true);
    current = null;
  }

  return {
    contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    extension: 'xlsx',
    bytesWritten: () => budget.bytes,

    startSheet(name, header) {
      budget.assertOpen();
      if (
        name.length < 1 ||
        name.length > 31 ||
        SHEET_NAME_INVALID.test(name) ||
        sheetNames.some((existing) => existing.toLowerCase() === name.toLowerCase())
      ) {
        throw new RangeError(
          'A sheet name must be 1 to 31 characters, unique, without [ ] : * ? / \\.',
        );
      }
      endSheet();
      sheetNames.push(name);
      const file = entry(`xl/worksheets/sheet${sheetNames.length}.xml`);
      zip.add(file);
      current = { file, nextRow: 2 };
      const cols =
        header.length === 0
          ? ''
          : `<cols><col min="1" max="${header.length}" width="${COLUMN_WIDTH}" customWidth="1"/></cols>`;
      write(
        file,
        `${XML_HEAD}<worksheet xmlns="${MAIN_NS}">${cols}<sheetData>${rowXml(header, 1, STYLE.header)}`,
      );
    },

    writeRows(rows) {
      budget.assertOpen();
      const sheet = current;
      if (sheet === null) throw new Error('Start a sheet before writing rows.');
      if (rows.length === 0) return;
      const xml = rows.map((row, index) => rowXml(row, sheet.nextRow + index, STYLE.text)).join('');
      write(sheet.file, xml);
      sheet.nextRow += rows.length;
    },

    finish() {
      budget.assertOpen();
      if (sheetNames.length === 0) throw new Error('A workbook needs at least one sheet.');
      endSheet();
      const sheets = sheetNames.map((name, index) => ({ name, n: index + 1 }));
      addPart(
        'xl/workbook.xml',
        `${XML_HEAD}<workbook xmlns="${MAIN_NS}" xmlns:r="${REL_NS}"><sheets>${sheets
          .map(({ name, n }) => `<sheet name="${escapeXml(name)}" sheetId="${n}" r:id="rId${n}"/>`)
          .join('')}</sheets></workbook>`,
      );
      addPart(
        'xl/_rels/workbook.xml.rels',
        `${XML_HEAD}<Relationships xmlns="${PKG_REL_NS}">${sheets
          .map(
            ({ n }) =>
              `<Relationship Id="rId${n}" Type="${REL_NS}/worksheet" Target="worksheets/sheet${n}.xml"/>`,
          )
          .join(
            '',
          )}<Relationship Id="rId${sheets.length + 1}" Type="${REL_NS}/styles" Target="styles.xml"/></Relationships>`,
      );
      addPart('xl/styles.xml', STYLES_XML);
      addPart(
        '_rels/.rels',
        `${XML_HEAD}<Relationships xmlns="${PKG_REL_NS}"><Relationship Id="rId1" Type="${REL_NS}/officeDocument" Target="xl/workbook.xml"/></Relationships>`,
      );
      addPart(
        '[Content_Types].xml',
        `${XML_HEAD}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">` +
          '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
          '<Default Extension="xml" ContentType="application/xml"/>' +
          '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>' +
          sheets
            .map(
              ({ n }) =>
                `<Override PartName="/xl/worksheets/sheet${n}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`,
            )
            .join('') +
          '<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>' +
          '</Types>',
      );
      zip.end();
      budget.assertOpen();
      if (zipError !== null) throw zipError;
      if (!complete) throw new Error('The workbook did not finish writing.');
      return Buffer.concat(chunks);
    },
  };
}
