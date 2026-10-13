import { jumpLinks } from '../../lib/teams/manage-view.ts';
import { LINK_CLASS } from '../auth/styles.ts';

/** "On this page": one tap to the invite link or any section on a phone. Anchors only, no script. */
export function ManageJumpNav({
  pendingCount,
  pendingHasMore,
}: {
  pendingCount: number;
  pendingHasMore: boolean;
}) {
  return (
    <nav aria-label="On this page" className="flex flex-col gap-1">
      <p className="text-base font-medium">On this page</p>
      <ul className="flex flex-wrap gap-x-4">
        {jumpLinks({ pendingCount, pendingHasMore }).map((link) => (
          <li key={link.id}>
            <a href={link.href} className={LINK_CLASS}>
              {link.label}
            </a>
          </li>
        ))}
      </ul>
    </nav>
  );
}
