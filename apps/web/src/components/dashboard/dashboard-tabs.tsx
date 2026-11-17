import { LINK_CLASS } from '../auth/styles.ts';
import { NAV_LABEL, TAB_LABELS } from '../../lib/dashboard/labels.ts';
import { tabPath, type DashboardTab } from '../../lib/dashboard/paths.ts';

const ORDER: readonly DashboardTab[] = ['opening', 'registrations', 'payments'];

/**
 * The three dashboard tabs as plain links, rendered like `ManageAreaNav` (server component, `<ul>` of `<a>`, no client JS, no
 * `role="tab"`): the current tab is bold with a thicker underline so it is not colour-only, and `aria-current="page"` says it
 * to a screen reader. Reload and back/forward return to the same tab because the tab is the URL.
 */
export function DashboardTabs({ current }: { current: DashboardTab }) {
  return (
    <nav aria-label={NAV_LABEL}>
      <ul className="flex flex-wrap gap-x-4">
        {ORDER.map((tab) => (
          <li key={tab}>
            <a
              href={tabPath(tab)}
              aria-current={tab === current ? 'page' : undefined}
              className={`${LINK_CLASS}${tab === current ? ' font-semibold decoration-2' : ''}`}
            >
              {TAB_LABELS[tab]}
            </a>
          </li>
        ))}
      </ul>
    </nav>
  );
}
