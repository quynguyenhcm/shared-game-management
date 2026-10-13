import { LINK_CLASS } from '../auth/styles.ts';

/** Where each terminal join answer sends the user next (journey error table). */
export function TeamStateLinks({ code }: { code: string }) {
  switch (code) {
    case 'already_requested':
    case 'already_member':
      return (
        <a href="/teams" className={LINK_CLASS}>
          Go to My teams
        </a>
      );
    case 'invite_invalid':
    case 'not_found':
      return (
        <p className="flex flex-wrap gap-x-4">
          <a href="/teams/find" className={LINK_CLASS}>
            Find a team
          </a>
          <a href="/teams" className={LINK_CLASS}>
            My teams
          </a>
        </p>
      );
    default:
      return null;
  }
}
