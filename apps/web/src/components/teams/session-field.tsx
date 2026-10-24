import { FieldError } from '../auth/field-message.tsx';
import { INPUT_CLASS } from '../auth/styles.ts';

export interface SessionFieldProps {
  /** The posted name; omit for a control that must not be submitted (it still gets `id`). */
  name?: string | undefined;
  /** The DOM id; defaults to `field-<name>` (the error summary links there). */
  id?: string | undefined;
  label: string;
  value: string;
  onChange: (value: string) => void;
  type?: 'text' | 'date' | 'time';
  hint?: string | undefined;
  error?: string | undefined;
  inputMode?: 'numeric' | 'decimal' | 'text';
  /** A "$" shown inside the box before the value (decorative; the label carries the meaning). */
  money?: boolean;
  /** An accessible name that contains the visible label (court rows). */
  ariaLabel?: string | undefined;
  /** Hide the visible label from tablet width up (court rows keep it for screen readers). */
  labelSrOnlyFromSm?: boolean;
  /** Extra ids the input is described by (a DST message). */
  describedBy?: string | undefined;
  min?: string | undefined;
  onBlur?: () => void;
  onKeyDown?: (event: { key: string; preventDefault: () => void }) => void;
}

/**
 * A labelled, controlled input for the Sessions forms: React 19 resets uncontrolled fields after a form
 * action, so every value lives in the form reducer. The hint and error are tied to the input with
 * `aria-describedby`. 16 px text (`INPUT_CLASS`) keeps iOS from zooming; `autoComplete="off"` throughout.
 */
export function SessionField({
  name,
  id,
  label,
  value,
  onChange,
  type = 'text',
  hint,
  error,
  inputMode,
  money = false,
  ariaLabel,
  labelSrOnlyFromSm = false,
  describedBy,
  min,
  onBlur,
  onKeyDown,
}: SessionFieldProps) {
  const fieldId = id ?? `field-${name ?? label}`;
  const ids = [
    hint === undefined ? '' : `${fieldId}-hint`,
    error === undefined ? '' : `${fieldId}-error`,
    describedBy ?? '',
  ]
    .filter(Boolean)
    .join(' ');
  return (
    <div className="flex min-w-0 flex-col gap-1">
      <label
        htmlFor={fieldId}
        className={`text-base font-medium ${labelSrOnlyFromSm ? 'sm:sr-only' : ''}`}
      >
        {label}
      </label>
      {hint === undefined ? null : (
        <p id={`${fieldId}-hint`} className="text-sm text-slate-700">
          {hint}
        </p>
      )}
      {error === undefined ? null : <FieldError id={`${fieldId}-error`} message={error} />}
      <div className="relative">
        {money ? (
          <span
            aria-hidden="true"
            className="pointer-events-none absolute inset-y-0 left-3 flex items-center text-base text-slate-700"
          >
            $
          </span>
        ) : null}
        <input
          id={fieldId}
          name={name}
          type={type}
          value={value}
          min={min}
          autoComplete="off"
          inputMode={inputMode ?? (money ? 'decimal' : undefined)}
          aria-label={ariaLabel}
          aria-invalid={error === undefined ? undefined : true}
          aria-describedby={ids === '' ? undefined : ids}
          onChange={(event) => {
            onChange(event.target.value);
          }}
          onBlur={onBlur}
          onKeyDown={onKeyDown}
          className={`${INPUT_CLASS}${money ? ' pl-7' : ''}`}
        />
      </div>
    </div>
  );
}
