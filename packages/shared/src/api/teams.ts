/**
 * Request and response contracts for `/teams/*`, shared by the Fastify routes and the web api-client.
 * Request bodies and queries are strict: an unknown field (`role`, `status`, `inviteCode` on create,
 * `createdBy`, ...) is a 422, so a client can never set what the server owns. Field messages are the
 * copy deck of the user-journey document, so the web and the API show the same text.
 *
 * Decisions this file encodes: memory-bank/creative/team-management-membership-architecture.md (Q4, Q5,
 * Spec amendments A8, A13) and the task file's "Creative Reconciliation" (page sizes, extra response fields,
 * create idempotency).
 */
import { z } from 'zod';
import { MembershipStatus, SkillTier, TeamRole, TeamVisibility } from '../types/enums.ts';

export const TEAM_NAME_MAX_LENGTH = 100;
export const TEAM_DESCRIPTION_MAX_LENGTH = 1000;
export const BAN_REASON_MAX_LENGTH = 500;
export const FIND_QUERY_MAX_LENGTH = 100;
/** Find a team: 20 per page. */
export const FIND_PAGE_SIZE = 20;
/** Admin member lists: 50 per section (Architecture A13 owns the API contract). */
export const MEMBERS_PAGE_SIZE = 50;
export const CURSOR_MAX_LENGTH = 700;
/** A join or lookup code is any bounded string: a malformed code must answer `invite_invalid`, not 422. */
const INVITE_CODE_INPUT_MAX_LENGTH = 200;

export const TEAM_FIELD_MESSAGES = {
  nameRequired: 'Enter a team name.',
  nameTooLong: 'Use 100 characters or fewer.',
  descriptionTooLong: 'Use 1000 characters or fewer.',
  visibilityRequired: 'Choose who can find your team.',
  skillLevelRequired: 'Select your skill level to continue.',
  idempotencyKeyInvalid: 'Reload the page and try again.',
  reasonTooLong: 'Use 500 characters or fewer.',
  searchTooLong: 'Use 100 characters or fewer.',
  cursorInvalid: 'That page link is not valid.',
} as const;

// ---------------------------------------------------------------------------------------------
// Field schemas
// ---------------------------------------------------------------------------------------------

/** The self-assessed level; no default, because the database default (`BEGINNER`) must never apply. */
export const SkillLevelInput = z.enum(SkillTier, { error: TEAM_FIELD_MESSAGES.skillLevelRequired });

const VisibilityInput = z.enum(TeamVisibility, { error: TEAM_FIELD_MESSAGES.visibilityRequired });

/** Optional free text: trimmed, a blank value is the same as absent. */
function optionalText(maxLength: number, tooLong: string) {
  return z
    .string()
    .trim()
    .max(maxLength, tooLong)
    .transform((value) => (value === '' ? undefined : value))
    .optional();
}

/** An opaque keyset cursor as it travels in a query string: URL-safe and bounded. */
export const OpaqueCursor = z
  .string()
  .max(CURSOR_MAX_LENGTH, TEAM_FIELD_MESSAGES.cursorInvalid)
  .regex(/^[A-Za-z0-9_-]+$/, TEAM_FIELD_MESSAGES.cursorInvalid);

// ---------------------------------------------------------------------------------------------
// Find a team cursor: base64url(JSON {"v":1,"n":<lower(name)>,"i":<uuid>,"d":"f"|"b"}) (Architecture Q5)
// ---------------------------------------------------------------------------------------------

export const FindCursorPayload = z.strictObject({
  v: z.literal(1),
  /** `lower(name)` exactly as Postgres returned it, so the comparison uses the database collation. */
  n: z.string().max(300),
  i: z.uuid(),
  /** `f` = the page after this row, `b` = the page before it. */
  d: z.enum(['f', 'b']),
});
export type FindCursorPayload = z.infer<typeof FindCursorPayload>;

function toBase64Url(text: string): string {
  let binary = '';
  for (const byte of new TextEncoder().encode(text)) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
}

function fromBase64Url(value: string): string {
  const padded = value.replaceAll('-', '+').replaceAll('_', '/');
  const binary = atob(padded.padEnd(Math.ceil(padded.length / 4) * 4, '='));
  const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
  return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
}

export function encodeFindCursor(payload: FindCursorPayload): string {
  return toBase64Url(JSON.stringify(payload));
}

/** The payload, or `null` when the cursor is not a valid, current-version Find cursor. */
export function decodeFindCursor(cursor: string): FindCursorPayload | null {
  if (cursor.length > CURSOR_MAX_LENGTH) return null;
  try {
    const parsed = FindCursorPayload.safeParse(JSON.parse(fromBase64Url(cursor)));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------------------------
// Requests
// ---------------------------------------------------------------------------------------------

/** `POST /teams`. `idempotencyKey` is a UUID v4 the form generates once per render (AC-ERROR-15). */
export const CreateTeamRequest = z.strictObject({
  name: z
    .string({ error: TEAM_FIELD_MESSAGES.nameRequired })
    .trim()
    .min(1, TEAM_FIELD_MESSAGES.nameRequired)
    .max(TEAM_NAME_MAX_LENGTH, TEAM_FIELD_MESSAGES.nameTooLong),
  description: optionalText(TEAM_DESCRIPTION_MAX_LENGTH, TEAM_FIELD_MESSAGES.descriptionTooLong),
  visibility: VisibilityInput,
  skillLevel: SkillLevelInput,
  idempotencyKey: z.uuidv4({ error: TEAM_FIELD_MESSAGES.idempotencyKeyInvalid }),
});
export type CreateTeamRequest = z.infer<typeof CreateTeamRequest>;

/** `POST /teams/:teamId/join-requests`. `inviteCode` is required for a PRIVATE team (checked by the service). */
export const JoinRequestRequest = z.strictObject({
  skillLevel: SkillLevelInput,
  inviteCode: z.string().min(1).max(INVITE_CODE_INPUT_MAX_LENGTH).optional(),
});
export type JoinRequestRequest = z.infer<typeof JoinRequestRequest>;

/** `POST /teams/invite/lookup` (POST so the code never appears in a URL the API logs). */
export const InviteLookupRequest = z.strictObject({
  code: z.string().min(1).max(INVITE_CODE_INPUT_MAX_LENGTH),
});
export type InviteLookupRequest = z.infer<typeof InviteLookupRequest>;

/** `POST /teams/:teamId/members/:userId/ban`. The reason is visible to team admins only. */
export const BanMemberRequest = z.strictObject({
  reason: optionalText(BAN_REASON_MAX_LENGTH, TEAM_FIELD_MESSAGES.reasonTooLong),
});
export type BanMemberRequest = z.infer<typeof BanMemberRequest>;

/**
 * `GET /teams/find?q=&after=`. `q` is normalised (NFC, trim, collapsed whitespace); an empty `q` means no
 * text filter. `after` is the opaque cursor from `nextCursor` or `prevCursor` (its direction is inside it).
 */
export const FindTeamsQuery = z.strictObject({
  q: z
    .string()
    .transform((value) => value.normalize('NFC').trim().replace(/\s+/g, ' '))
    .pipe(z.string().max(FIND_QUERY_MAX_LENGTH, TEAM_FIELD_MESSAGES.searchTooLong))
    .transform((value) => (value === '' ? undefined : value))
    .optional(),
  after: OpaqueCursor.refine(
    (value) => decodeFindCursor(value) !== null,
    TEAM_FIELD_MESSAGES.cursorInvalid,
  ).optional(),
});
export type FindTeamsQuery = z.infer<typeof FindTeamsQuery>;

/** The statuses an admin lists (`REJECTED` people are not listed). */
export const MemberListStatus = z.enum(['PENDING', 'APPROVED', 'BANNED']);
export type MemberListStatus = z.infer<typeof MemberListStatus>;

/** `GET /teams/:teamId/members?status=&after=` (page size 50). */
export const MembersQuery = z.strictObject({
  status: MemberListStatus,
  after: OpaqueCursor.optional(),
});
export type MembersQuery = z.infer<typeof MembersQuery>;

export const TeamIdParams = z.object({ teamId: z.uuid() });
export const TeamMemberParams = z.object({ teamId: z.uuid(), userId: z.uuid() });

// ---------------------------------------------------------------------------------------------
// Responses (never contain an invite code except `InviteCodeResponse`)
// ---------------------------------------------------------------------------------------------

/** What the caller's own row may show on Find and the invite page (a banned caller is handled apart). */
const VisibleMyStatus = z.enum(['PENDING', 'APPROVED', 'REJECTED']);

export const TeamSummary = z.object({
  id: z.uuid(),
  name: z.string(),
  description: z.string().nullable(),
  visibility: z.enum(TeamVisibility),
});
export type TeamSummary = z.infer<typeof TeamSummary>;

export const MyMembership = z.object({
  status: z.enum(MembershipStatus),
  role: z.enum(TeamRole),
  skillLevel: z.enum(SkillTier),
});
export type MyMembership = z.infer<typeof MyMembership>;

/** `POST /teams`: 201 for a new team, 200 for a replay of the same idempotency key. */
export const CreateTeamResponse = z.object({ team: TeamSummary, membership: MyMembership });
export type CreateTeamResponse = z.infer<typeof CreateTeamResponse>;

export const FindTeamItem = z.object({
  id: z.uuid(),
  name: z.string(),
  description: z.string().nullable(),
  memberCount: z.number().int().min(0),
  /** `BANNED` is shown as null on Find. */
  myStatus: VisibleMyStatus.nullable(),
});
export const FindTeamsResponse = z.object({
  teams: z.array(FindTeamItem),
  nextCursor: z.string().nullable(),
  prevCursor: z.string().nullable(),
});
export type FindTeamsResponse = z.infer<typeof FindTeamsResponse>;

/** `GET /teams/mine`: `BANNED` rows are omitted; admin rows carry `pendingRequestCount`. */
export const MineTeamsResponse = z.object({
  teams: z.array(
    z.object({
      id: z.uuid(),
      name: z.string(),
      visibility: z.enum(TeamVisibility),
      role: z.enum(TeamRole),
      status: VisibleMyStatus,
      pendingRequestCount: z.number().int().min(0).optional(),
    }),
  ),
});
export type MineTeamsResponse = z.infer<typeof MineTeamsResponse>;

/** `GET /teams/:teamId`: the page shows a banned caller "You can't join this team." from `myStatus`. */
export const TeamDetailResponse = z.object({
  team: TeamSummary.extend({ memberCount: z.number().int().min(0) }),
  myStatus: z.enum(MembershipStatus).nullable(),
  myRole: z.enum(TeamRole).nullable(),
});
export type TeamDetailResponse = z.infer<typeof TeamDetailResponse>;

/** `POST /teams/invite/lookup` (a banned caller gets 403 `banned_from_team` and no preview). */
export const InviteLookupResponse = z.object({
  team: TeamSummary.extend({ memberCount: z.number().int().min(0) }),
  myStatus: VisibleMyStatus.nullable(),
});
export type InviteLookupResponse = z.infer<typeof InviteLookupResponse>;

export const JoinRequestResponse = z.object({
  membership: z.object({ status: z.literal('PENDING'), skillLevel: z.enum(SkillTier) }),
});
export type JoinRequestResponse = z.infer<typeof JoinRequestResponse>;

/**
 * One person in an admin list: full name and skill level only, never an email.
 *
 * The last four fields were added by skill-levels-and-auto-enroll (additive: no earlier field changed). They are
 * present on every row of every endpoint that returns a `TeamMemberRow`:
 * - `skillOverride`: who last set the level by hand and when (the actor's name is shown to team admins only).
 * - `skillChangedAt`: the last level change (override or automatic), the progression counting baseline; null
 *   while the level is still the self-assessed one. With `skillOverride` it derives the provenance line
 *   (`deriveSkillProvenance`).
 * - `autoEnroll`: the stored flag, end date (a Pacific/Auckland calendar date, inclusive) and order key. An
 *   assignment whose `until` is before today stays `enabled` here; the view derives "ended". Always
 *   `{ enabled: false, until: null, assignedAt: null }` off the APPROVED list (database CHECK).
 * - `skillProgress`: games toward the next level (`toSkillProgress`, capped at the threshold); null at ADVANCED
 *   and for every row that is not APPROVED.
 */
export const TeamMemberRow = z.object({
  userId: z.uuid(),
  fullName: z.string(),
  role: z.enum(TeamRole),
  status: z.enum(MembershipStatus),
  skillLevel: z.enum(SkillTier),
  requestedAt: z.iso.datetime(),
  approvedAt: z.iso.datetime().nullable(),
  bannedAt: z.iso.datetime().nullable(),
  /** Only in the BANNED list, and only for team admins. */
  banReason: z.string().nullable(),
  skillOverride: z.object({ byName: z.string(), at: z.iso.datetime() }).nullable(),
  skillChangedAt: z.iso.datetime().nullable(),
  autoEnroll: z.object({
    enabled: z.boolean(),
    until: z.iso.date().nullable(),
    assignedAt: z.iso.datetime().nullable(),
  }),
  skillProgress: z
    .object({
      games: z.number().int().min(0),
      required: z.number().int().min(1),
      nextLevel: z.enum(SkillTier),
    })
    .nullable(),
});
export type TeamMemberRow = z.infer<typeof TeamMemberRow>;

/** `adminCount` drives the proactive last-admin hint in the manage area. */
export const MembersResponse = z.object({
  members: z.array(TeamMemberRow),
  nextCursor: z.string().nullable(),
  adminCount: z.number().int().min(0),
});
export type MembersResponse = z.infer<typeof MembersResponse>;

/** Approve, reject, promote, demote and ban answer with the member after the change (includes `fullName`). */
export const ModerationResponse = z.object({ member: TeamMemberRow });
export type ModerationResponse = z.infer<typeof ModerationResponse>;

/** The two `TEAM_ADMIN` invite-code routes are the only responses that carry the code. */
export const InviteCodeResponse = z.object({ inviteCode: z.string() });
export type InviteCodeResponse = z.infer<typeof InviteCodeResponse>;
