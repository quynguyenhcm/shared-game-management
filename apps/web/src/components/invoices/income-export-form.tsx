import type { ReactNode } from 'react';
import type { FieldErrors } from '../../lib/auth/validation.ts';
import {
  incomeExportAction,
  type ExportFormValues,
  type ExportOption,
  type ExportOptionGroup,
  type ExportPeriodType,
} from '../../lib/invoices/export-view.ts';
import { EXPORT_COPY } from '../../lib/invoices/labels.ts';
import { ErrorSummary } from '../auth/error-summary.tsx';
import { FieldError } from '../auth/field-message.tsx';
import { FormBanner } from '../auth/form-banner.tsx';
import { BUTTON_CLASS, FOCUS_RING, INPUT_CLASS } from '../auth/styles.ts';

/**
 * The Income exports form (tax-invoices-and-exports Phase 4; UI/UX surface B, option B1; architecture D1). A plain GET form to
 * the download route, so it works with no JavaScript: the file downloads and the page stays, and a refusal comes back as a
 * `303` to the page with the entered values and the field names, which re-renders this form with its errors.
 *
 * Each period radio reveals its own panel by CSS alone (`:has()`; a browser without it shows every panel). Every panel's
 * fields are always submitted and the route uses only the selected type's. A field error is under its label and tied with
 * `aria-describedby`; the summary above the form takes focus after a failed submit (and links to each field), a refusal that
 * is not about one field (too large, busy, no access) is an alert that takes focus. Every target is at least 44 px.
 */

const CHOICE_ROW = 'flex min-h-11 items-center gap-3 text-base';
const RADIO = `size-5 shrink-0 ${FOCUS_RING}`;
/** Hides a panel while its radio is not checked: the wrapper is a `group` holding exactly one `period` radio. */
const PANEL = 'flex flex-col gap-3 pb-3 pl-8 group-has-[[name=period]:not(:checked)]:hidden';

const ERROR_ORDER = ['period', 'from', 'to', 'gst', 'year', 'format'] as const;

const errorOf = (errors: FieldErrors, name: string): string | undefined => errors[name]?.[0];

function describedBy(...ids: (string | false | undefined)[]): string | undefined {
  const present = ids.filter((id): id is string => typeof id === 'string' && id !== '');
  return present.length === 0 ? undefined : present.join(' ');
}

function DateField({
  name,
  label,
  value,
  error,
  hintId,
}: {
  name: string;
  label: string;
  value: string;
  error: string | undefined;
  hintId: string;
}) {
  const id = `field-${name}`;
  return (
    <div className="flex flex-col gap-1">
      <label htmlFor={id} className="text-base font-medium">
        {label}
      </label>
      {error === undefined ? null : <FieldError id={`${id}-error`} message={error} />}
      <input
        id={id}
        name={name}
        type="date"
        defaultValue={value}
        aria-invalid={error === undefined ? undefined : true}
        aria-describedby={describedBy(hintId, error !== undefined && `${id}-error`)}
        className={`${INPUT_CLASS} sm:max-w-xs`}
      />
    </div>
  );
}

function SelectField({
  name,
  label,
  hint,
  value,
  error,
  children,
}: {
  name: string;
  label: string;
  hint: string;
  value: string;
  error: string | undefined;
  children: ReactNode;
}) {
  const id = `field-${name}`;
  return (
    <div className="flex flex-col gap-1">
      <label htmlFor={id} className="text-base font-medium">
        {label}
      </label>
      <p id={`${id}-hint`} className="text-sm text-slate-700">
        {hint}
      </p>
      {error === undefined ? null : <FieldError id={`${id}-error`} message={error} />}
      <select
        id={id}
        name={name}
        defaultValue={value}
        aria-invalid={error === undefined ? undefined : true}
        aria-describedby={describedBy(`${id}-hint`, error !== undefined && `${id}-error`)}
        className={INPUT_CLASS}
      >
        {children}
      </select>
    </div>
  );
}

const optionsOf = (options: readonly ExportOption[]) =>
  options.map((option) => (
    <option key={option.value} value={option.value}>
      {option.label}
    </option>
  ));

function PeriodChoice({
  type,
  checked,
  first,
  children,
}: {
  type: ExportPeriodType;
  checked: boolean;
  first: boolean;
  children: ReactNode;
}) {
  const panel = `export-panel-${type}`;
  return (
    <div className="group flex flex-col">
      <label className={CHOICE_ROW}>
        <input
          type="radio"
          name="period"
          value={type}
          id={first ? 'field-period' : undefined}
          defaultChecked={checked}
          aria-controls={panel}
          className={RADIO}
        />
        {EXPORT_COPY.periodTypes[type]}
      </label>
      <div id={panel} className={PANEL}>
        {children}
      </div>
    </div>
  );
}

export function IncomeExportForm({
  teamId,
  values,
  errors,
  formError,
  financialYears,
  gstGroups,
}: {
  teamId: string;
  values: ExportFormValues;
  errors: FieldErrors;
  /** A refusal that is not about one field (`export_too_large`, `export_busy`, no access, a failure). */
  formError: string | null;
  financialYears: readonly ExportOption[];
  gstGroups: readonly ExportOptionGroup[];
}) {
  const periodError = errorOf(errors, 'period');
  const formatError = errorOf(errors, 'format');
  const format = values.format === 'csv' ? 'csv' : 'xlsx';
  return (
    <div className="flex flex-col gap-4">
      {formError === null ? null : <FormBanner kind="error" lines={[formError]} />}
      <ErrorSummary errors={errors} order={ERROR_ORDER} />
      <form
        method="get"
        action={incomeExportAction(teamId)}
        noValidate
        className="flex flex-col gap-6"
      >
        <fieldset
          aria-describedby={periodError === undefined ? undefined : 'field-period-error'}
          className="flex min-w-0 flex-col gap-1"
        >
          <legend className="text-lg font-semibold">{EXPORT_COPY.periodLegend}</legend>
          {periodError === undefined ? null : (
            <FieldError id="field-period-error" message={periodError} />
          )}
          <PeriodChoice type="custom" checked={values.period === 'custom'} first>
            <p id="export-custom-hint" className="text-sm text-slate-700">
              {EXPORT_COPY.customHint}
            </p>
            <DateField
              name="from"
              label={EXPORT_COPY.startDate}
              value={values.from}
              error={errorOf(errors, 'from')}
              hintId="export-custom-hint"
            />
            <DateField
              name="to"
              label={EXPORT_COPY.endDate}
              value={values.to}
              error={errorOf(errors, 'to')}
              hintId="export-custom-hint"
            />
          </PeriodChoice>
          <PeriodChoice type="gst" checked={values.period === 'gst'} first={false}>
            <SelectField
              name="gst"
              label={EXPORT_COPY.gstLabel}
              hint={EXPORT_COPY.gstHint}
              value={values.gst}
              error={errorOf(errors, 'gst')}
            >
              {gstGroups.map((group) => (
                <optgroup key={group.label} label={group.label}>
                  {optionsOf(group.options)}
                </optgroup>
              ))}
            </SelectField>
          </PeriodChoice>
          <PeriodChoice type="fy" checked={values.period === 'fy'} first={false}>
            <SelectField
              name="year"
              label={EXPORT_COPY.fyLabel}
              hint={EXPORT_COPY.fyHint}
              value={values.year}
              error={errorOf(errors, 'year')}
            >
              {optionsOf(financialYears)}
            </SelectField>
          </PeriodChoice>
        </fieldset>

        <fieldset
          aria-describedby={formatError === undefined ? undefined : 'field-format-error'}
          className="flex min-w-0 flex-col gap-1"
        >
          <legend className="text-lg font-semibold">{EXPORT_COPY.formatLegend}</legend>
          {formatError === undefined ? null : (
            <FieldError id="field-format-error" message={formatError} />
          )}
          {(['xlsx', 'csv'] as const).map((value, index) => (
            <div key={value}>
              <label className={CHOICE_ROW}>
                <input
                  type="radio"
                  name="format"
                  value={value}
                  id={index === 0 ? 'field-format' : undefined}
                  defaultChecked={format === value}
                  aria-describedby={`export-format-${value}-hint`}
                  className={RADIO}
                />
                {EXPORT_COPY.formats[value].label}
              </label>
              <p id={`export-format-${value}-hint`} className="pb-1 pl-8 text-sm text-slate-700">
                {EXPORT_COPY.formats[value].hint}
              </p>
            </div>
          ))}
        </fieldset>

        <div className="flex flex-col gap-2">
          <button
            type="submit"
            aria-describedby="export-download-hint"
            className={`${BUTTON_CLASS} sm:w-auto sm:self-start`}
          >
            {EXPORT_COPY.download}
          </button>
          <p id="export-download-hint" className="text-sm text-slate-700">
            {EXPORT_COPY.downloadHint}
          </p>
        </div>
      </form>
    </div>
  );
}
