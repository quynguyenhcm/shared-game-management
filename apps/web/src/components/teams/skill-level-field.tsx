import { SKILL_OPTIONS } from '../../lib/teams/labels.ts';
import { OptionFieldset } from './option-fieldset.tsx';

/**
 * The self-assessed level on the create and join forms (UI/UX Q6): legend "Your skill level", radios
 * Beginner, Intermediate, Advanced under `name="skillLevel"`, none preselected. A previous choice is
 * refilled after a failed submit through `defaultValue`; one is never invented.
 */
export function SkillLevelField({
  hint,
  error,
  defaultValue,
}: {
  hint: string;
  error?: string | undefined;
  defaultValue?: string | undefined;
}) {
  return (
    <OptionFieldset
      name="skillLevel"
      legend="Your skill level"
      hint={hint}
      error={error}
      options={SKILL_OPTIONS}
      defaultValue={defaultValue}
    />
  );
}
