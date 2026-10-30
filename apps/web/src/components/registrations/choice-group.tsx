import { FieldError, describedBy } from '../auth/field-message.tsx';
import { FOCUS_RING } from '../auth/styles.ts';

export interface Choice {
  value: string;
  label: string;
  /** Natively `disabled` (never `aria-disabled`: a radio that is only aria-disabled can still be picked with the arrow keys). */
  disabled?: boolean;
  /** Visible text under the option, tied to its radio with `aria-describedby` (why it is disabled). */
  hint?: string;
}

/**
 * A compact controlled radio group: `fieldset` and `legend`, options in a wrapping row (stacked below 640 px), every label at
 * least 44 px tall. The first radio carries id `field-<name>` so the error summary can focus the group; the hint and error are
 * tied to the fieldset with `aria-describedby`. `value` is the empty string until a choice is made: nothing is preselected unless
 * the caller says so.
 */
export function ChoiceGroup({
  name,
  legend,
  options,
  value,
  onChange,
  hint,
  error,
  legendClassName = 'text-base font-medium',
}: {
  name: string;
  legend: string;
  options: readonly Choice[];
  value: string;
  onChange: (value: string) => void;
  hint?: string | undefined;
  error?: string | undefined;
  legendClassName?: string;
}) {
  const id = `field-${name}`;
  return (
    <fieldset aria-describedby={describedBy(id, { hint, error })} className="flex flex-col gap-1">
      <legend className={legendClassName}>{legend}</legend>
      {hint ? (
        <p id={`${id}-hint`} className="text-sm text-slate-700">
          {hint}
        </p>
      ) : null}
      {error ? <FieldError id={`${id}-error`} message={error} /> : null}
      <div className="flex flex-col sm:flex-row sm:flex-wrap sm:gap-x-6">
        {options.map((option, index) => {
          const optionHintId = `${name}-${option.value}-hint`;
          return (
            <div key={option.value} className="flex flex-col">
              <label className="flex min-h-11 items-center gap-3 text-base">
                <input
                  type="radio"
                  name={name}
                  value={option.value}
                  id={index === 0 ? id : undefined}
                  checked={value === option.value}
                  disabled={option.disabled}
                  aria-describedby={option.hint === undefined ? undefined : optionHintId}
                  onChange={() => {
                    onChange(option.value);
                  }}
                  className={`size-5 ${FOCUS_RING}`}
                />
                {option.label}
              </label>
              {option.hint === undefined ? null : (
                <p id={optionHintId} className="pb-1 pl-8 text-sm text-slate-700">
                  {option.hint}
                </p>
              )}
            </div>
          );
        })}
      </div>
    </fieldset>
  );
}
