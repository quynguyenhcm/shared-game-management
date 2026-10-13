import { FieldError, describedBy } from '../auth/field-message.tsx';
import { FOCUS_RING } from '../auth/styles.ts';

export interface FieldsetOption {
  value: string;
  label: string;
  help: string;
}

/**
 * A required radio group with no default (a fieldset with a legend, a hint, and one line of help per
 * option). The first radio carries id `field-<name>` so the error summary can focus the group. Help text
 * sits outside each `<label>` and is tied to its radio with `aria-describedby`, so the accessible name
 * stays exactly the option's label.
 */
export function OptionFieldset({
  name,
  legend,
  hint,
  error,
  options,
  defaultValue,
}: {
  name: string;
  legend: string;
  hint: string;
  error?: string | undefined;
  options: readonly FieldsetOption[];
  defaultValue?: string | undefined;
}) {
  const id = `field-${name}`;
  return (
    <fieldset aria-describedby={describedBy(id, { hint, error })} className="flex flex-col gap-1">
      <legend className="text-base font-medium">{legend}</legend>
      <p id={`${id}-hint`} className="text-sm text-slate-700">
        {hint}
      </p>
      {error ? <FieldError id={`${id}-error`} message={error} /> : null}
      <div className="flex flex-col">
        {options.map((option, index) => {
          const helpId = `${name}-${option.value.toLowerCase()}-help`;
          return (
            <div key={option.value}>
              <label className="flex min-h-11 items-center gap-3 text-base">
                <input
                  type="radio"
                  name={name}
                  value={option.value}
                  id={index === 0 ? id : undefined}
                  defaultChecked={defaultValue === option.value}
                  aria-describedby={helpId}
                  className={`size-5 ${FOCUS_RING}`}
                />
                {option.label}
              </label>
              <p id={helpId} className="pb-1 pl-8 text-sm text-slate-700">
                {option.help}
              </p>
            </div>
          );
        })}
      </div>
    </fieldset>
  );
}
