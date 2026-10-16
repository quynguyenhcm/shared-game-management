/**
 * The team-admin area registry (UI/UX Q2, Option 3). Each area page renders `ManageAreaNav` itself after
 * its guard passes (so the no-access page never shows area links); a later feature (sessions) appends one
 * entry here and `manage-areas.test.ts` checks that its page renders the nav.
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
];

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

/** The area nav links, or an empty list while there is a single area (a one-link nav is noise). */
export function manageAreaLinks(
  teamId: string,
  areas: readonly ManageArea[] = MANAGE_AREAS,
  currentId = 'people',
): ManageAreaLink[] {
  if (areas.length < 2) return [];
  return areas.map((area) => ({
    id: area.id,
    label: area.label,
    href: manageAreaHref(teamId, area),
    current: area.id === currentId,
  }));
}
