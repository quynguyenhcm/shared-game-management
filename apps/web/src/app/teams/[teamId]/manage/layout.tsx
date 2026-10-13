import type { ReactNode } from 'react';
import { LINK_CLASS } from '../../../../components/auth/styles.ts';
import { manageAreaLinks } from '../../../../lib/teams/manage-areas.ts';

/**
 * The team-admin area shell and the plug-in seam for later areas (banking, sessions): the area nav renders
 * only once `MANAGE_AREAS` holds two or more entries. Wider than `AuthCard`: lists need the room.
 */
export default async function ManageLayout({
  children,
  params,
}: {
  children: ReactNode;
  params: Promise<{ teamId: string }>;
}) {
  const { teamId } = await params;
  const areas = manageAreaLinks(teamId);
  return (
    <main className="mx-auto flex w-full max-w-3xl flex-col gap-8 px-4 py-8">
      {areas.length === 0 ? null : (
        <nav aria-label="Team admin areas">
          <ul className="flex flex-wrap gap-x-4">
            {areas.map((area) => (
              <li key={area.id}>
                <a
                  href={area.href}
                  aria-current={area.current ? 'page' : undefined}
                  className={LINK_CLASS}
                >
                  {area.label}
                </a>
              </li>
            ))}
          </ul>
        </nav>
      )}
      {children}
    </main>
  );
}
