/**
 * The admin member-list cursor (Architecture guideline 7, A13): opaque base64url JSON, versioned, strict, and bound
 * to the section it was issued for. Sort keys come back from Postgres as text (`requested_at::text` keeps full
 * microsecond precision, which a JS `Date` would lose) and go back into the query as typed parameters.
 *
 *   PENDING   (requested_at, user_id) ascending       -> { t, i }
 *   APPROVED  (role rank, lower(name), user_id) asc   -> { r, n, i }   (r: 0 admin, 1 member)
 *   BANNED    (banned_at, user_id) descending         -> { t, i }
 */
import { z } from 'zod';
import type { MemberListStatus } from '@sgm/shared';

/** What Postgres prints for a timestamptz cast to text, in any session time zone. */
const TIMESTAMP_TEXT = /^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}(\.\d{1,6})?(Z|[+-]\d{2}(:\d{2})?)$/;

const timestamp = z.string().max(40).regex(TIMESTAMP_TEXT);

export const MembersCursor = z.discriminatedUnion('s', [
  z.strictObject({ v: z.literal(1), s: z.literal('PENDING'), t: timestamp, i: z.uuid() }),
  z.strictObject({
    v: z.literal(1),
    s: z.literal('APPROVED'),
    r: z.union([z.literal(0), z.literal(1)]),
    n: z.string().max(300),
    i: z.uuid(),
  }),
  z.strictObject({ v: z.literal(1), s: z.literal('BANNED'), t: timestamp, i: z.uuid() }),
]);
export type MembersCursor = z.infer<typeof MembersCursor>;

export function encodeMembersCursor(cursor: MembersCursor): string {
  return Buffer.from(JSON.stringify(cursor), 'utf8').toString('base64url');
}

/** The cursor, or `null` when it is malformed, from another version, or was issued for a different section. */
export function decodeMembersCursor(value: string, status: MemberListStatus): MembersCursor | null {
  try {
    const json: unknown = JSON.parse(Buffer.from(value, 'base64url').toString('utf8'));
    const parsed = MembersCursor.safeParse(json);
    return parsed.success && parsed.data.s === status ? parsed.data : null;
  } catch {
    return null;
  }
}
