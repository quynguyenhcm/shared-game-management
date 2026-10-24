import { NOT_MEMBER_LINK, NOT_MEMBER_MESSAGE } from '../../lib/registrations/labels.ts';
import { teamPagePath } from '../../lib/registrations/paths.ts';
import { LINK_CLASS } from '../auth/styles.ts';

/**
 * The 403 state of the session page (AC-ENTRY-2): a non-member, a PENDING, REJECTED or banned caller, another team's admin and
 * a GLOBAL_ADMIN who is not a member all see the same words, no session details and no form.
 */
export function NotMember({ teamId }: { teamId: string }) {
  return (
    <>
      <title>Registration – Shared Game Management</title>
      <h1 className="text-2xl font-semibold">{NOT_MEMBER_MESSAGE}</h1>
      <a href={teamPagePath(teamId)} className={`${LINK_CLASS} self-start`}>
        {NOT_MEMBER_LINK}
      </a>
    </>
  );
}
