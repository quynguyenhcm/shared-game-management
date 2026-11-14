/**
 * The team-admin area registry (UI/UX Q2, Option 3). Each area page renders `ManageAreaNav` itself after
 * its guard passes (so the no-access page never shows area links); a feature appends one entry here and
 * `manage-areas.test.ts` checks that its page renders the nav.
 */
export interface ManageArea {
  id: string;
  label: string;
  /** Path segment under `/teams/<id>/manage`; empty for the root area. */
  segment: string;
}

export const MANAGE_AREAS: readonly ManageArea[] = [
  { id: 'people', label: 'People', segment: '' },
  { id: 'banking', label: 'Banking and GST', segment: 'banking' },
  { id: 'sessions', label: 'Sessions', segment: 'sessions' },
  { id: 'payments', label: 'Payments', segment: 'payments' },
  // TEAM_ADMIN only (tax-invoices-and-exports AC-ENTRY-2, H9): not GLOBAL_ADMIN_AREA_ID, so a global admin who is not a
  // team admin never gets the link, and the API answers them 403 like a plain member.
  { id: 'exports', label: 'Income exports', segment: 'exports' },
];

/** The one area a GLOBAL_ADMIN who is not a team admin may open (CR-21): support reads Payments, nothing else. */
export const GLOBAL_ADMIN_AREA_ID = 'payments';

export interface ManageAreaLink {
  id: string;
  label: string;
  href: string;
  current: boolean;
}

function manageAreaHref(teamId: string, area: ManageArea): string {
  const root = `/teams/${teamId}/manage`;
  return area.segment === '' ? root : `${root}/${area.segment}`;
}

/**
 * The area nav links, or an empty list while there is a single area (a one-link nav is noise). A global admin who is not a
 * team admin (`globalAdminOnly`, CR-21) gets just the Payments link: with no other area to tell it from, it is kept.
 */
export function manageAreaLinks(
  teamId: string,
  areas: readonly ManageArea[] = MANAGE_AREAS,
  currentId = 'people',
  options: { globalAdminOnly?: boolean } = {},
): ManageAreaLink[] {
  const shown =
    options.globalAdminOnly === true
      ? areas.filter((area) => area.id === GLOBAL_ADMIN_AREA_ID)
      : areas;
  if (shown.length < 2 && options.globalAdminOnly !== true) return [];
  return shown.map((area) => ({
    id: area.id,
    label: area.label,
    href: manageAreaHref(teamId, area),
    current: area.id === currentId,
  }));
}
