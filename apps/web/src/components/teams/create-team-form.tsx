'use client';

import { createTeamAction } from '../../lib/teams/actions.ts';
import { SKILL_HINT_CREATE, VISIBILITY_HINT, VISIBILITY_OPTIONS } from '../../lib/teams/labels.ts';
import { validateCreateTeam } from '../../lib/teams/validation.ts';
import { ErrorSummary } from '../auth/error-summary.tsx';
import { FieldError, describedBy } from '../auth/field-message.tsx';
import { INPUT_CLASS } from '../auth/styles.ts';
import { SubmitButton } from '../auth/submit-button.tsx';
import { TextField } from '../auth/text-field.tsx';
import { useAuthForm } from '../auth/use-auth-form.ts';
import { OptionFieldset } from './option-fieldset.tsx';
import { SkillLevelField } from './skill-level-field.tsx';
import { TeamFormBanner } from './team-form-banner.tsx';

const FIELD_ORDER = ['name', 'description', 'visibility', 'skillLevel', 'idempotencyKey'] as const;
const DESCRIPTION_HINT = 'Up to 1000 characters.';

/**
 * "Create a team". `idempotencyKey` is a UUID v4 the page generated for this render (AC-ERROR-15): a
 * retry after a lost response resends the same key and gets the same team. No input has `maxlength`: a
 * too-long value is explained (AC-ERROR-1) instead of silently truncated.
 */
export function CreateTeamForm({ idempotencyKey }: { idempotencyKey: string }) {
  const form = useAuthForm(createTeamAction, validateCreateTeam);
  const { fieldErrors, values } = form;
  const descriptionError = fieldErrors.description?.[0];
  return (
    <form action={form.submit} noValidate className="flex flex-col gap-5">
      <ErrorSummary
        errors={fieldErrors}
        order={FIELD_ORDER}
        focusToken={form.clientFailure ?? form.state}
      />
      <TeamFormBanner state={form.state} />
      <input type="hidden" name="idempotencyKey" value={idempotencyKey} />
      <TextField
        name="name"
        label="Team name"
        hint="Up to 100 characters."
        autoComplete="off"
        defaultValue={values.name}
        error={fieldErrors.name?.[0]}
      />
      <div className="flex flex-col gap-1">
        <label htmlFor="field-description" className="text-base font-medium">
          Description (optional)
        </label>
        <p id="field-description-hint" className="text-sm text-slate-700">
          {DESCRIPTION_HINT}
        </p>
        {descriptionError ? (
          <FieldError id="field-description-error" message={descriptionError} />
        ) : null}
        <textarea
          id="field-description"
          name="description"
          rows={4}
          defaultValue={values.description}
          aria-invalid={descriptionError ? true : undefined}
          aria-describedby={describedBy('field-description', {
            hint: DESCRIPTION_HINT,
            error: descriptionError,
          })}
          className={INPUT_CLASS}
        />
      </div>
      <OptionFieldset
        name="visibility"
        legend="Visibility"
        hint={VISIBILITY_HINT}
        error={fieldErrors.visibility?.[0]}
        options={VISIBILITY_OPTIONS}
        defaultValue={values.visibility}
      />
      <SkillLevelField
        hint={SKILL_HINT_CREATE}
        error={fieldErrors.skillLevel?.[0]}
        defaultValue={values.skillLevel}
      />
      <SubmitButton label="Create team" pendingLabel="Creating team…" />
    </form>
  );
}
