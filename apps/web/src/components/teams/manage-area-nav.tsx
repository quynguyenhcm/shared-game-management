import { manageAreaLinks } from '../../lib/teams/manage-areas.ts';
import { LINK_CLASS } from '../auth/styles.ts';

export const GLOBAL_ADMIN_VIEW_LINE = 'Viewing as a global admin';

/**
 * The team-admin area nav (UI/UX Sub-decision A). Each area page renders it itself, after its guard
 * passes, with its own `current` id: a server component, no client JS, correct on first byte, and never
 * shown on the no-access page. The current link is bold with a thicker underline so it is not colour-only.
 * `globalAdminOnly` (CR-21) is a GLOBAL_ADMIN who is not a team admin: only Payments is theirs to open, and
 * the page says whose view this is.
 */
export function ManageAreaNav({
  teamId,
  current,
  globalAdminOnly = false,
}: {
  teamId: string;
  current: string;
  globalAdminOnly?: boolean;
}) {
  const areas = manageAreaLinks(teamId, undefined, current, { globalAdminOnly });
  if (areas.length === 0) return null;
  return (
    <div className="flex flex-col gap-1">
      {globalAdminOnly ? <p className="text-base font-medium">{GLOBAL_ADMIN_VIEW_LINE}</p> : null}
      <nav aria-label="Team admin areas">
        <ul className="flex flex-wrap gap-x-4">
          {areas.map((area) => (
            <li key={area.id}>
              <a
                href={area.href}
                aria-current={area.current ? 'page' : undefined}
                className={`${LINK_CLASS}${area.current ? ' font-semibold decoration-2' : ''}`}
              >
                {area.label}
              </a>
            </li>
          ))}
        </ul>
      </nav>
    </div>
  );
}
