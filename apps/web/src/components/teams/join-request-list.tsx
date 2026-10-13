import type { TeamMemberRow } from '@sgm/shared';
import { EMPTY_REQUESTS, requestedLine } from '../../lib/teams/labels.ts';
import { approveMemberAction, rejectMemberAction } from '../../lib/teams/actions.ts';
import { ModerationButton } from './moderation-button.tsx';

/**
 * Pending rows, oldest first (the API orders them). Approve and Reject are one-tap: Reject needs no
 * confirmation because a rejected person can ask again (AC-HAPPY-8).
 */
export function JoinRequestList({
  teamId,
  requests,
}: {
  teamId: string;
  requests: readonly TeamMemberRow[];
}) {
  if (requests.length === 0) return <p className="text-base">{EMPTY_REQUESTS}</p>;
  return (
    <ul aria-labelledby="requests-heading" className="flex flex-col gap-3">
      {requests.map((person) => {
        const fields = { teamId, userId: person.userId, fullName: person.fullName };
        return (
          <li
            key={person.userId}
            className="flex flex-col gap-3 rounded-md border border-slate-300 p-4 sm:flex-row sm:items-start sm:justify-between"
          >
            <div className="min-w-0">
              <p className="break-words text-base font-medium">{person.fullName}</p>
              <p className="text-base">
                <time dateTime={person.requestedAt}>
                  {requestedLine(person.skillLevel, person.requestedAt)}
                </time>
              </p>
            </div>
            <div className="flex flex-wrap gap-2">
              <ModerationButton
                kind="approve"
                action={approveMemberAction}
                fields={fields}
                label="Approve"
                ariaLabel={`Approve ${person.fullName}`}
                pendingLabel="Approving…"
                variant="primary"
              />
              <ModerationButton
                kind="reject"
                action={rejectMemberAction}
                fields={fields}
                label="Reject"
                ariaLabel={`Reject ${person.fullName}`}
                pendingLabel="Rejecting…"
              />
            </div>
          </li>
        );
      })}
    </ul>
  );
}
