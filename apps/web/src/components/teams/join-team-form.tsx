'use client';

import { joinTeamAction } from '../../lib/teams/actions.ts';
import { SKILL_HINT_JOIN, isTerminalJoinError } from '../../lib/teams/labels.ts';
import { validateJoinRequest } from '../../lib/teams/validation.ts';
import { ErrorSummary } from '../auth/error-summary.tsx';
import { SubmitButton } from '../auth/submit-button.tsx';
import { useAuthForm } from '../auth/use-auth-form.ts';
import { SkillLevelField } from './skill-level-field.tsx';
import { TeamFormBanner } from './team-form-banner.tsx';
import { TeamStateLinks } from './team-state-links.tsx';

/**
 * "Request to join" on the team page and the invite page. `inviteCode` is a hidden field only on the
 * invite page. A terminal API answer (already asked, already a member, banned, invalid invite, not
 * found) replaces the form with the matching status, so the user never retries something that cannot work.
 */
export function JoinTeamForm({
  teamId,
  teamName,
  inviteCode,
  returnTo,
}: {
  teamId: string;
  teamName: string;
  inviteCode?: string | undefined;
  returnTo: string;
}) {
  const form = useAuthForm(joinTeamAction, validateJoinRequest);
  const { fieldErrors, values } = form;
  const code = form.state.error?.code;

  if (isTerminalJoinError(code)) {
    return (
      <div className="flex flex-col gap-3">
        <TeamFormBanner state={form.state} />
        <TeamStateLinks code={code ?? ''} />
      </div>
    );
  }

  return (
    <form action={form.submit} noValidate className="flex flex-col gap-5">
      <h2 className="text-lg font-semibold">Ask to join {teamName}</h2>
      <ErrorSummary
        errors={fieldErrors}
        order={['skillLevel']}
        focusToken={form.clientFailure ?? form.state}
      />
      <TeamFormBanner state={form.state} />
      <input type="hidden" name="teamId" value={teamId} />
      <input type="hidden" name="returnTo" value={returnTo} />
      {inviteCode === undefined ? null : (
        <input type="hidden" name="inviteCode" value={inviteCode} />
      )}
      <SkillLevelField
        hint={SKILL_HINT_JOIN}
        error={fieldErrors.skillLevel?.[0]}
        defaultValue={values.skillLevel}
      />
      <SubmitButton label="Request to join" pendingLabel="Sending request…" />
    </form>
  );
}
