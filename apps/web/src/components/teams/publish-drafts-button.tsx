'use client';

import { publishDraftsAction } from '../../lib/teams/sessions-actions.ts';
import { BUTTON_CLASS } from '../auth/styles.ts';
import { useModerationAction } from './use-moderation-action.ts';

/**
 * "Publish drafts now" (AC-ASYNC-7): queues one run that retries the series' banking-refused drafts through the
 * gate. A success redirects to the series page with the "we're publishing" notice; a failure is reported in
 * the series section's status region. The button stays focusable while it runs and ignores a second click.
 */
export function PublishDraftsButton({ teamId, ruleId }: { teamId: string; ruleId: string }) {
  const { formAction, pending } = useModerationAction('series', publishDraftsAction);
  return (
    <form action={formAction} className="flex">
      <input type="hidden" name="teamId" value={teamId} />
      <input type="hidden" name="ruleId" value={ruleId} />
      <button
        type="submit"
        aria-disabled={pending}
        onClick={(event) => {
          if (pending) event.preventDefault();
        }}
        className={`${BUTTON_CLASS} sm:w-auto`}
      >
        {pending ? 'Publishing…' : 'Publish drafts now'}
      </button>
    </form>
  );
}
