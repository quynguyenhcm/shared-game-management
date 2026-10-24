import { SKILL_OPTIONS } from '../../lib/teams/labels.ts';
import { GUEST_NAME_HINT, GUEST_SKILL_HINT, SEX_OPTIONS } from '../../lib/registrations/labels.ts';
import type { GuestValues } from '../../lib/registrations/validation.ts';
import { FieldError, describedBy } from '../auth/field-message.tsx';
import { INPUT_CLASS } from '../auth/styles.ts';
import { ChoiceGroup } from './choice-group.tsx';

const SKILL_CHOICES = SKILL_OPTIONS.map((option) => ({ value: option.value, label: option.label }));

/**
 * One guest: a `fieldset` with legend "Guest {n}" holding the Sex group, the Skill level group and an optional name. Sex and
 * level have no default (the database needs both, and an invented one would be false data); the ids are `field-guest{n}Sex`,
 * `field-guest{n}Skill` and `field-guest{n}Name` so the error summary links straight to them. The name input has no
 * `maxlength`, so the 100-character message stays reachable.
 */
export function GuestFieldset({
  n,
  values,
  onChange,
  errors,
}: {
  n: number;
  values: GuestValues;
  onChange: (next: GuestValues) => void;
  errors: { sex?: string | undefined; skill?: string | undefined; name?: string | undefined };
}) {
  const nameId = `field-guest${n}Name`;
  return (
    <fieldset className="flex min-w-0 flex-col gap-3 rounded-md border border-slate-500 p-4">
      <legend className="px-1 text-base font-semibold">{`Guest ${n}`}</legend>
      <ChoiceGroup
        name={`guest${n}Sex`}
        legend="Sex"
        options={SEX_OPTIONS}
        value={values.sex}
        onChange={(sex) => {
          onChange({ ...values, sex });
        }}
        error={errors.sex}
      />
      <ChoiceGroup
        name={`guest${n}Skill`}
        legend="Skill level"
        options={SKILL_CHOICES}
        value={values.skillLevel}
        onChange={(skillLevel) => {
          onChange({ ...values, skillLevel });
        }}
        hint={GUEST_SKILL_HINT}
        error={errors.skill}
      />
      <div className="flex flex-col gap-1">
        <label htmlFor={nameId} className="text-base font-medium">
          Name (optional)
        </label>
        <p id={`${nameId}-hint`} className="text-sm text-slate-700">
          {GUEST_NAME_HINT}
        </p>
        {errors.name ? <FieldError id={`${nameId}-error`} message={errors.name} /> : null}
        <input
          id={nameId}
          name={`guest${n}Name`}
          type="text"
          value={values.displayName}
          autoComplete="off"
          aria-invalid={errors.name ? true : undefined}
          aria-describedby={describedBy(nameId, { hint: GUEST_NAME_HINT, error: errors.name })}
          onChange={(event) => {
            onChange({ ...values, displayName: event.target.value });
          }}
          className={`${INPUT_CLASS} break-words`}
        />
      </div>
    </fieldset>
  );
}
