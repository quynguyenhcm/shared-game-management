/**
 * URLs of the player side (R23). The player session page is registration-and-waitlist's; the admin pages stay under
 * `/teams/[teamId]/manage/sessions` (`sessionPath` in `lib/teams/sessions-paths.ts`), so the two helpers must never be
 * mixed. Both take validated UUIDs only (pages and Server Actions check `z.uuid()` first) and do no encoding of their own.
 */
export const teamPagePath = (teamId: string): string => `/teams/${teamId}`;

export const playerSessionPath = (teamId: string, sessionId: string): string =>
  `${teamPagePath(teamId)}/sessions/${sessionId}`;
