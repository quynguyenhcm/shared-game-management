import { NO_ACCESS_HEADING } from '../../lib/teams/labels.ts';
import { LINK_CLASS } from '../auth/styles.ts';

/**
 * The 403 state of every manage page: the heading and the way back, with no area nav and none of the
 * area's content (AC-ENTRY-2).
 */
export function NoAccess() {
  return (
    <>
      <title>No access – Shared Game Management</title>
      <h1 className="text-2xl font-semibold">{NO_ACCESS_HEADING}</h1>
      <a href="/teams" className={LINK_CLASS}>
        Back to My teams
      </a>
    </>
  );
}
