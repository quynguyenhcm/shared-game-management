import { describe, expect, it } from 'vitest';
import { asciiFilename, attachmentDisposition } from './content-disposition.ts';

describe('asciiFilename', () => {
  it('keeps a safe name as it is', () => {
    expect(asciiFilename('tax-invoice-INV-000001.pdf')).toBe('tax-invoice-INV-000001.pdf');
  });

  it('strips diacritics and turns other runs into one hyphen (Hōkio becomes Hokio)', () => {
    expect(asciiFilename('Hōkio Badminton Club 2026-27.csv')).toBe(
      'Hokio-Badminton-Club-2026-27.csv',
    );
  });

  it('never yields a path separator, a quote, a leading dot, control characters or an empty name', () => {
    for (const hostile of [
      '../../etc/passwd',
      '..\\x.pdf',
      '".pdf',
      'a\r\nSet-Cookie: x=1.pdf',
      '.hidden',
      '',
    ]) {
      const name = asciiFilename(hostile);
      expect(name).toMatch(/^[A-Za-z0-9][A-Za-z0-9._-]*$/);
      expect(name).not.toMatch(/\.\./);
    }
    expect(asciiFilename('')).toBe('download');
    expect(asciiFilename('日本語.pdf')).toBe('download.pdf');
  });

  it('limits the base name but keeps the extension', () => {
    const name = asciiFilename(`${'a'.repeat(300)}.xlsx`);
    expect(name.endsWith('.xlsx')).toBe(true);
    expect(name.length).toBe(120 + '.xlsx'.length);
  });
});

describe('attachmentDisposition (RFC 6266 and RFC 5987)', () => {
  it('is always an attachment with a quoted ASCII filename', () => {
    expect(attachmentDisposition('receipt-RCT-000012.pdf')).toBe(
      'attachment; filename="receipt-RCT-000012.pdf"',
    );
  });

  it('adds the percent-encoded UTF-8 form when the wanted name has macrons, with a safe ASCII fallback', () => {
    const header = attachmentDisposition('income-Whangārei.csv');
    expect(header).toBe(
      `attachment; filename="income-Whangarei.csv"; filename*=UTF-8''income-Whang%C4%81rei.csv`,
    );
  });

  it('cannot be used to inject a header parameter or a line break', () => {
    const header = attachmentDisposition('x"; filename="evil.exe\r\nX-Injected: 1');
    expect(header).not.toMatch(/[\r\n]/);
    expect(header.match(/filename="/g)).toHaveLength(1);
    expect(header).toMatch(
      /^attachment; filename="[A-Za-z0-9._-]+"; filename\*=UTF-8''[A-Za-z0-9%._-]+$/,
    );
  });

  it('does not throw on a lone surrogate', () => {
    expect(() => attachmentDisposition('a\ud800b.pdf')).not.toThrow();
  });
});
