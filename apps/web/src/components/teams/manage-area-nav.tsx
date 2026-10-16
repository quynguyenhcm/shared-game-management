import { manageAreaLinks } from '../../lib/teams/manage-areas.ts';
import { LINK_CLASS } from '../auth/styles.ts';

/**
 * The team-admin area nav (UI/UX Sub-decision A). Each area page renders it itself, after its guard
 * passes, with its own `current` id: a server component, no client JS, correct on first byte, and never
 * shown on the no-access page. The current link is bold with a thicker underline so it is not colour-only.
 */
export function ManageAreaNav({ teamId, current }: { teamId: string; current: string }) {
  const areas = manageAreaLinks(teamId, undefined, current);
  if (areas.length === 0) return null;
  return (
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
  );
}
