import type { ReactNode } from 'react';
import { sectionHeadingId, type SectionId } from '../../lib/teams/manage-view.ts';
import { FOCUS_RING } from '../auth/styles.ts';
import { SectionStatus } from './manage-context.tsx';

/**
 * One section of the manage page: a labelled region whose `h2` is a focus target (after a row leaves its
 * list focus moves here, and the jump list lands here), with the section's persistent status region.
 */
export function ManageSection({
  id,
  title,
  children,
}: {
  id: SectionId;
  title: string;
  children: ReactNode;
}) {
  const headingId = sectionHeadingId(id);
  return (
    <section id={id} aria-labelledby={headingId} className="flex scroll-mt-4 flex-col gap-3">
      <h2
        id={headingId}
        tabIndex={-1}
        className={`min-w-0 break-words text-lg font-semibold outline-none ${FOCUS_RING}`}
      >
        {title}
      </h2>
      <SectionStatus section={id} />
      {children}
    </section>
  );
}
