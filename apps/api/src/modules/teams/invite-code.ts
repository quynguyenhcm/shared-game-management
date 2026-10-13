/**
 * Team invite codes (AC-VERIFY-3, Architecture Q4): 256 random bits from `crypto.randomBytes`, base64url (43
 * characters, inside the `teams_invite_code_format` CHECK). The code is a bearer capability to *ask* to join, so
 * it is compared exactly, never logged, and a collision on the unique constraint is retried with a new code.
 */
import { randomBytes, timingSafeEqual } from 'node:crypto';

const INVITE_CODE_BYTES = 32;
/** The `teams_invite_code_format` CHECK (migration D-44); input that fails it can never match a stored code. */
const INVITE_CODE_FORMAT = /^[A-Za-z0-9_-]{32,100}$/;
/** The unique constraint on `teams.invite_code` (Postgres' default name for the inline UNIQUE). */
const INVITE_CODE_CONSTRAINT = 'teams_invite_code_key';

/** Attempts (including the first) before a unique-violation streak is treated as a fault. */
export const INVITE_CODE_RETRY_LIMIT = 3;

export function generateInviteCode(): string {
  return randomBytes(INVITE_CODE_BYTES).toString('base64url');
}

/** False for anything the database could not hold, so malformed input never reaches a query (a NUL byte would be a 500). */
export function isWellFormedInviteCode(code: unknown): code is string {
  return typeof code === 'string' && INVITE_CODE_FORMAT.test(code);
}

/** Constant-time equality of two codes; different lengths are simply unequal. */
export function inviteCodesMatch(supplied: string, stored: string): boolean {
  const a = Buffer.from(supplied);
  const b = Buffer.from(stored);
  return a.length === b.length && timingSafeEqual(a, b);
}

/** A unique violation (23505) on `teams.invite_code`, as opposed to any other constraint. */
export function isInviteCodeCollision(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const { code, constraint } = error as Error & { code?: unknown; constraint?: unknown };
  return code === '23505' && constraint === INVITE_CODE_CONSTRAINT;
}

/**
 * Runs `attempt` with a fresh code, retrying with another code when the database reports a collision. Each
 * attempt must be its own transaction: a failed statement aborts the one it ran in. Any other error, and the
 * collision after the last attempt, is rethrown unchanged (the shared error mapper answers 409 or 500).
 */
export async function withInviteCodeRetry<T>(attempt: (code: string) => Promise<T>): Promise<T> {
  for (let tried = 1; ; tried += 1) {
    try {
      return await attempt(generateInviteCode());
    } catch (error) {
      if (!isInviteCodeCollision(error) || tried >= INVITE_CODE_RETRY_LIMIT) throw error;
    }
  }
}
