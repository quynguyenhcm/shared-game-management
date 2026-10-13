import { FieldError, describedBy } from './field-message.tsx';
import { FOCUS_RING } from './styles.ts';

const OPTIONS = [
  { value: 'MALE', label: 'Male' },
  { value: 'FEMALE', label: 'Female' },
  { value: 'OTHER', label: 'Other' },
] as const;

const HINT = 'Some teams set session prices by sex.';

/**
 * Sex is required once per user and has no default: a fieldset with legend "Sex" and three radios, none
 * preselected. The first radio carries id `field-sex` so the error summary can link to the group.
 */
export function SexField({ error, defaultValue }: { error?: string; defaultValue?: string }) {
  return (
    <fieldset
      aria-describedby={describedBy('field-sex', { hint: HINT, error })}
      className="flex flex-col gap-1"
    >
      <legend className="text-base font-medium">Sex</legend>
      <p id="field-sex-hint" className="text-sm text-slate-700">
        {HINT}
      </p>
      {error ? <FieldError id="field-sex-error" message={error} /> : null}
      <div className="flex flex-col">
        {OPTIONS.map((option, index) => (
          <label key={option.value} className="flex min-h-11 items-center gap-3 text-base">
            <input
              type="radio"
              name="sex"
              value={option.value}
              id={index === 0 ? 'field-sex' : undefined}
              defaultChecked={defaultValue === option.value}
              className={`size-5 ${FOCUS_RING}`}
            />
            {option.label}
          </label>
        ))}
      </div>
    </fieldset>
  );
}
