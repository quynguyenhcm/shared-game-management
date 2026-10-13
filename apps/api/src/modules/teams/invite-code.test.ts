/** Invite codes (AC-VERIFY-3): 256 random bits, URL-safe, inside the DB format CHECK, retried on a collision. */
import { describe, expect, it } from 'vitest';
import {
  generateInviteCode,
  INVITE_CODE_RETRY_LIMIT,
  inviteCodesMatch,
  isInviteCodeCollision,
  isWellFormedInviteCode,
  withInviteCodeRetry,
} from './invite-code.ts';

/** The `teams_invite_code_format` CHECK of migration D-44. */
const DB_FORMAT = /^[A-Za-z0-9_-]{32,100}$/;

function pgError(code: string, constraint: string): Error {
  return Object.assign(new Error('duplicate key'), { code, constraint });
}

describe('generateInviteCode', () => {
  it('is 43 base64url characters carrying 256 bits and satisfies the database format CHECK', () => {
    const code = generateInviteCode();
    expect(code).toHaveLength(43);
    expect(code).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(code).toMatch(DB_FORMAT);
    expect(Buffer.from(code, 'base64url')).toHaveLength(32);
  });

  it('never repeats across many generations', () => {
    const codes = new Set(Array.from({ length: 2000 }, () => generateInviteCode()));
    expect(codes.size).toBe(2000);
  });
});

describe('isWellFormedInviteCode and inviteCodesMatch', () => {
  it('accepts only DB-format strings, so a malformed or NUL-bearing code never reaches Postgres', () => {
    expect(isWellFormedInviteCode(generateInviteCode())).toBe(true);
    for (const bad of [
      '',
      'short',
      `${'a'.repeat(31)}`,
      'a'.repeat(101),
      `${'a'.repeat(40)}\u0000`,
    ]) {
      expect(isWellFormedInviteCode(bad), JSON.stringify(bad)).toBe(false);
    }
    expect(isWellFormedInviteCode(undefined)).toBe(false);
  });

  it('compares codes exactly (case-sensitive, length-safe)', () => {
    const code = generateInviteCode();
    expect(inviteCodesMatch(code, code)).toBe(true);
    expect(inviteCodesMatch(code, `${code}x`)).toBe(false);
    expect(
      inviteCodesMatch(code, code.toUpperCase() === code ? code.toLowerCase() : code.toUpperCase()),
    ).toBe(false);
  });
});

describe('withInviteCodeRetry', () => {
  it('recognises only a unique violation on the invite_code constraint as a collision', () => {
    expect(isInviteCodeCollision(pgError('23505', 'teams_invite_code_key'))).toBe(true);
    expect(isInviteCodeCollision(pgError('23505', 'uq_teams_created_by_idempotency_key'))).toBe(
      false,
    );
    expect(isInviteCodeCollision(pgError('23514', 'teams_invite_code_key'))).toBe(false);
    expect(isInviteCodeCollision(new Error('boom'))).toBe(false);
  });

  it('retries a collision with a brand-new code and returns the first success', async () => {
    const seen: string[] = [];
    const result = await withInviteCodeRetry((code) => {
      seen.push(code);
      if (seen.length < 3) return Promise.reject(pgError('23505', 'teams_invite_code_key'));
      return Promise.resolve(code);
    });
    expect(seen).toHaveLength(3);
    expect(new Set(seen).size).toBe(3);
    expect(result).toBe(seen[2]);
  });

  it('gives up after the retry limit and rethrows any other error immediately', async () => {
    let calls = 0;
    await expect(
      withInviteCodeRetry(() => {
        calls += 1;
        return Promise.reject(pgError('23505', 'teams_invite_code_key'));
      }),
    ).rejects.toThrow(/duplicate key/);
    expect(calls).toBe(INVITE_CODE_RETRY_LIMIT);

    calls = 0;
    await expect(
      withInviteCodeRetry(() => {
        calls += 1;
        return Promise.reject(new Error('disk full'));
      }),
    ).rejects.toThrow('disk full');
    expect(calls).toBe(1);
  });
});
