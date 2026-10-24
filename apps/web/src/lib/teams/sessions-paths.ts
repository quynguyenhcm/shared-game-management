import { bankingPageUrl } from './banking-view.ts';

/**
 * The URLs of the Sessions area (UI/UX "Page inventory and URL grammar"). Pure, so the pages, the Server
 * Actions' redirects and the banking hand-off all build the same paths. Ids are always UUIDs the page has
 * already checked, so they are placed in the path as they are: every helper here takes validated UUIDs only
 * (pages and Server Actions check `z.uuid()` first) and does no encoding of its own, so never pass raw user input.
 */

export const sessionsPath = (teamId: string): string => `/teams/${teamId}/manage/sessions`;
export const newSessionPath = (teamId: string): string => `${sessionsPath(teamId)}/new`;
export const sessionPath = (teamId: string, sessionId: string): string =>
  `${sessionsPath(teamId)}/${sessionId}`;
export const newSeriesPath = (teamId: string): string => `${sessionsPath(teamId)}/series/new`;
export const seriesPath = (teamId: string, ruleId: string): string =>
  `${sessionsPath(teamId)}/series/${ruleId}`;
/** The series page in edit mode (`?edit=details`): form-first, with the effect line. */
export const seriesEditPath = (teamId: string, ruleId: string): string =>
  `${seriesPath(teamId, ruleId)}?edit=details`;

/**
 * The link to "Banking and GST" that brings the admin back to the page they started from (ADR 0016,
 * AC-HAPPY-14). `bankingReturnTo` on the banking page accepts any path under the team except banking itself,
 * so every Sessions path passes.
 */
export function bankingHandoff(teamId: string, returnTo: string): string {
  return bankingPageUrl({ teamId, returnTo });
}

export type ListCursorSection = 'upcoming' | 'drafts' | 'past';

const CURSOR_PARAM: Record<ListCursorSection, string> = {
  upcoming: 'upcoming',
  drafts: 'drafts',
  past: 'past',
};

/** The query parameter that holds one list section's keyset cursor. */
export function listCursorParam(section: ListCursorSection): string {
  return CURSOR_PARAM[section];
}

/**
 * "Next" and "Back to start" for one list section: each changes only its own cursor, keeps the other
 * sections' cursors, and ends with the section fragment so the page does not jump to the top.
 */
export function listPagerHrefs(input: {
  teamId: string;
  section: ListCursorSection;
  current: Record<string, string | undefined>;
  nextCursor: string | null;
}): { next: string | null; start: string | null } {
  const { teamId, section, current, nextCursor } = input;
  const param = CURSOR_PARAM[section];
  const build = (cursor: string | null): string => {
    const query = new URLSearchParams();
    for (const [name, value] of Object.entries(current)) {
      if (name !== param && value !== undefined && value !== '') query.set(name, value);
    }
    if (cursor !== null) query.set(param, cursor);
    const text = query.toString();
    return `${sessionsPath(teamId)}${text === '' ? '' : `?${text}`}#${section}`;
  };
  const onLaterPage = current[param] !== undefined && current[param] !== '';
  return {
    next: nextCursor === null ? null : build(nextCursor),
    start: onLaterPage ? build(null) : null,
  };
}
