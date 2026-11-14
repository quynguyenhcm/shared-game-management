import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { ExportFormValues } from '../../lib/invoices/export-view.ts';
import { IncomeExportForm } from './income-export-form.tsx';

/**
 * The Income exports form (tax-invoices-and-exports Phase 4; AC-ENTRY-2, AC-ERROR-3, 4; UI/UX surface B): a plain GET form that
 * works with no JavaScript, period types revealed by CSS from their radio, visible labels, errors tied to their fields.
 */

const TEAM = '7f3c2b1a-1111-4222-8333-444455556666';
const FY = [
  { value: '2027-28', label: '2027-28 (1 April 2027 to 31 March 2028) (not finished)' },
  { value: '2026-27', label: '2026-27 (1 April 2026 to 31 March 2027)' },
];
const GST = [
  {
    label: 'Two-monthly, ending January, March, May, July, September and November',
    options: [{ value: '2m-odd/2027-05', label: '1 April 2027 to 31 May 2027' }],
  },
  {
    label: 'Six-monthly, ending March and September',
    options: [{ value: '6m-mar-sep/2027-03', label: '1 October 2026 to 31 March 2027' }],
  },
];
const VALUES: ExportFormValues = {
  period: 'fy',
  format: 'xlsx',
  from: '',
  to: '',
  gst: '2m-odd/2027-05',
  year: '2027-28',
};

const render = (
  overrides: Partial<{
    values: ExportFormValues;
    errors: Record<string, string[]>;
    formError: string | null;
  }> = {},
) =>
  renderToStaticMarkup(
    <IncomeExportForm
      teamId={TEAM}
      values={overrides.values ?? VALUES}
      errors={overrides.errors ?? {}}
      formError={overrides.formError ?? null}
      financialYears={FY}
      gstGroups={GST}
    />,
  );

const tagOf = (html: string, pattern: RegExp): string => pattern.exec(html)?.[0] ?? '';

describe('IncomeExportForm: works without JavaScript', () => {
  it('is a GET form to the download route with no client-side submit, browser validation off', () => {
    const html = render();
    const form = tagOf(html, /<form[^>]*>/);
    expect(form).toContain('method="get"');
    expect(form).toContain(`action="/teams/${TEAM}/manage/exports/income"`);
    expect(form).toContain('noValidate=""');
    expect(html).toMatch(/<button[^>]*type="submit"[^>]*>Download<\/button>/);
  });

  it('offers the three period types as radios, each controlling its panel, the selected one checked; every group submits', () => {
    const html = render();
    expect(html).toContain('<legend');
    for (const [value, label, panel] of [
      ['custom', 'Custom range', 'export-panel-custom'],
      ['gst', 'GST period', 'export-panel-gst'],
      ['fy', 'Financial year', 'export-panel-fy'],
    ] as const) {
      const radio = tagOf(html, new RegExp(`<input[^>]*name="period"[^>]*value="${value}"[^>]*>`));
      expect(radio).toContain('type="radio"');
      expect(radio).toContain(`aria-controls="${panel}"`);
      expect(radio.includes('checked=""')).toBe(value === 'fy');
      expect(html).toContain(label);
      // The panel is hidden by CSS only while its radio is not checked (no JS; without :has support it stays visible).
      expect(tagOf(html, new RegExp(`<div[^>]*id="${panel}"[^>]*>`))).toContain(
        'group-has-[[name=period]:not(:checked)]:hidden',
      );
    }
    expect(tagOf(html, /<input[^>]*name="from"[^>]*>/)).toContain('type="date"');
    expect(tagOf(html, /<input[^>]*name="to"[^>]*>/)).toContain('type="date"');
    expect(html).toContain('<select');
    expect(html).toContain('name="gst"');
    expect(html).toContain('name="year"');
  });

  it('lists GST periods grouped by cadence (R2) and financial years, the current values selected', () => {
    const html = render();
    expect(html).toContain(
      '<optgroup label="Two-monthly, ending January, March, May, July, September and November">',
    );
    expect(html).toContain('<optgroup label="Six-monthly, ending March and September">');
    expect(tagOf(html, /<option[^>]*value="2m-odd\/2027-05"[^>]*>/)).toContain('selected=""');
    expect(tagOf(html, /<option[^>]*value="2027-28"[^>]*>/)).toContain('selected=""');
    expect(html).toContain('2026-27 (1 April 2026 to 31 March 2027)');
  });

  it('defaults to Excel with a CSV option, both with a visible hint', () => {
    const html = render();
    expect(tagOf(html, /<input[^>]*value="xlsx"[^>]*>/)).toContain('checked=""');
    expect(tagOf(html, /<input[^>]*value="csv"[^>]*>/)).not.toContain('checked=""');
    expect(html).toContain('Excel (.xlsx)');
    expect(html).toContain('CSV (.csv)');
    expect(html).toContain('File format');
  });

  it('gives every control a visible label and a 44 px target', () => {
    const html = render();
    for (const id of ['field-from', 'field-to', 'field-gst', 'field-year']) {
      expect(html).toContain(`for="${id}"`);
      expect(tagOf(html, new RegExp(`<(input|select)[^>]*id="${id}"[^>]*>`))).toContain('min-h-11');
    }
    expect(html.match(/<label class="flex min-h-11/g)?.length).toBeGreaterThanOrEqual(5);
    expect(tagOf(html, /<button[^>]*>/)).toContain('min-h-11');
  });
});

describe('IncomeExportForm: errors', () => {
  it('ties a field error to its input, keeps the entered values and lists it in the focused summary', () => {
    const html = render({
      values: { ...VALUES, period: 'custom', from: '2027-06-15', to: '2027-06-01' },
      errors: { to: ["The end date can't be before the start date"] },
    });
    const to = tagOf(html, /<input[^>]*name="to"[^>]*>/);
    expect(to).toContain('aria-invalid="true"');
    expect(to).toMatch(/aria-describedby="[^"]*field-to-error/);
    expect(to).toContain('value="2027-06-01"');
    expect(tagOf(html, /<input[^>]*name="from"[^>]*>/)).toContain('value="2027-06-15"');
    expect(html).toContain('id="field-to-error"');
    expect(html).toContain('href="#field-to"');
    expect(html).toContain('role="alert"');
    expect(tagOf(html, /<input[^>]*name="period"[^>]*value="custom"[^>]*>/)).toContain(
      'checked=""',
    );
  });

  it('shows a refusal that is not about one field (too large, busy) as an alert above the form', () => {
    const html = render({
      formError: 'Another export is being prepared. Try again in a moment.',
    });
    expect(html).toMatch(/role="alert"[^>]*>.*Another export is being prepared/);
    expect(html).not.toContain('aria-invalid');
  });
});
