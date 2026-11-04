import type { ReactNode } from 'react';
import { FOCUS_RING } from '../auth/styles.ts';

/**
 * One section of a billing page: a labelled region with an `h2` (a focus target, so a link or a script can land on it), as the
 * manage sections do. Status regions live inside the section's own content (the processing notice, the form banners), not here.
 */
export function BillingSection({
  id,
  title,
  children,
}: {
  id: string;
  title: string;
  children: ReactNode;
}) {
  return (
    <section id={id} aria-labelledby={`${id}-heading`} className="flex scroll-mt-4 flex-col gap-3">
      <h2
        id={`${id}-heading`}
        tabIndex={-1}
        className={`min-w-0 break-words text-lg font-semibold outline-none ${FOCUS_RING}`}
      >
        {title}
      </h2>
      {children}
    </section>
  );
}
