import { describe, expect, it } from 'vitest';
import { AssignableGlobalRole } from '../types/enums.ts';
import {
  AuthSuccessResponse,
  ForgotPasswordRequest,
  LoginRequest,
  RegisterRequest,
  ResetPasswordRequest,
} from './auth.ts';
import { ErrorCode, ErrorResponse } from './errors.ts';

function fieldErrors(
  schema: { safeParse(value: unknown): unknown },
  value: unknown,
): Record<string, string[]> {
  const result = schema.safeParse(value) as {
    success: boolean;
    error?: { issues: { path: PropertyKey[]; message: string }[] };
  };
  expect(result.success).toBe(false);
  const map: Record<string, string[]> = {};
  for (const issue of result.error?.issues ?? []) {
    (map[issue.path.join('.') || '_form'] ??= []).push(issue.message);
  }
  return map;
}

const valid = {
  fullName: 'Aroha Ngata',
  email: 'Aroha.Ngata@Example.com',
  password: 'kowhai-court-27',
  sex: 'FEMALE',
};

describe('auth request schemas', () => {
  it('parses a registration, normalising the email and trimming the name', () => {
    expect(RegisterRequest.parse({ ...valid, fullName: '  Aroha Ngata ' })).toEqual({
      ...valid,
      email: 'aroha.ngata@example.com',
    });
  });

  it('uses the copy-deck message for each field (user-journey field errors)', () => {
    expect(fieldErrors(RegisterRequest, {})).toEqual({
      fullName: ['Enter your name.'],
      email: ['Enter your email address.'],
      password: ['Enter your password.'],
      sex: ['Select your sex to continue.'],
    });
    expect(
      fieldErrors(RegisterRequest, {
        ...valid,
        email: 'aroha@gmail',
        sex: 'ROBOT',
        fullName: 'x'.repeat(256),
      }),
    ).toEqual({
      fullName: ['Use 255 characters or fewer.'],
      email: ['Enter a valid email address.'],
      sex: ['Select your sex to continue.'],
    });
  });

  it('counts password length in code points after NFKC (10 to 128)', () => {
    expect(fieldErrors(RegisterRequest, { ...valid, password: 'ninechars' }).password).toEqual([
      'Use at least 10 characters.',
    ]);
    expect(fieldErrors(RegisterRequest, { ...valid, password: 'a'.repeat(129) }).password).toEqual([
      'Use at most 128 characters.',
    ]);
    // 10 emoji are 20 UTF-16 units but 10 code points; full-width digits fold to ASCII under NFKC.
    expect(RegisterRequest.safeParse({ ...valid, password: '😀'.repeat(10) }).success).toBe(true);
    expect(RegisterRequest.safeParse({ ...valid, password: '😀'.repeat(129) }).success).toBe(false);
    expect(RegisterRequest.safeParse({ ...valid, password: 'a'.repeat(128) }).success).toBe(true);
  });

  it('rejects role and any unknown field (strict), so a client cannot self-assign GLOBAL_ADMIN', () => {
    for (const extra of [{ role: 'GLOBAL_ADMIN' }, { isAdmin: true }]) {
      expect(RegisterRequest.safeParse({ ...valid, ...extra }).success).toBe(false);
    }
    expect(
      LoginRequest.safeParse({ email: 'a@b.co', password: 'x', role: 'GLOBAL_ADMIN' }).success,
    ).toBe(false);
    expect(ForgotPasswordRequest.safeParse({ email: 'a@b.co', extra: 1 }).success).toBe(false);
    expect(
      ResetPasswordRequest.safeParse({ token: 't', password: 'kowhai-court-27', x: 1 }).success,
    ).toBe(false);
  });

  it('login and forgot accept a malformed email (the API answers generically) but not an empty one', () => {
    expect(LoginRequest.safeParse({ email: 'not-an-email', password: 'x' }).success).toBe(true);
    expect(fieldErrors(LoginRequest, { email: '', password: '' })).toEqual({
      email: ['Enter your email address.'],
      password: ['Enter your password.'],
    });
    expect(ForgotPasswordRequest.safeParse({ email: 'nope' }).success).toBe(true);
  });
});

describe('auth response and error contracts', () => {
  it('exposes only GLOBAL_ADMIN and PLAYER as assignable roles', () => {
    expect([...AssignableGlobalRole]).toEqual(['GLOBAL_ADMIN', 'PLAYER']);
    const user = { id: crypto.randomUUID(), email: 'a@b.co', fullName: 'A', sex: 'MALE' };
    const session = { token: 't', expiresAt: '2026-10-07T00:00:00.000Z' };
    expect(
      AuthSuccessResponse.safeParse({ user: { ...user, role: 'PLAYER' }, session }).success,
    ).toBe(true);
    expect(
      AuthSuccessResponse.safeParse({ user: { ...user, role: 'TEAM_ADMIN' }, session }).success,
    ).toBe(false);
  });

  it('ErrorResponse carries fieldErrors and only known codes', () => {
    const body = {
      error: {
        code: 'validation_failed',
        message: 'Check the form.',
        fieldErrors: { email: ['Enter a valid email address.'] },
      },
    };
    expect(ErrorResponse.parse(body)).toEqual(body);
    expect(ErrorResponse.safeParse({ error: { code: 'nope', message: 'x' } }).success).toBe(false);
    expect(ErrorCode).toContain('last_sign_in_method');
  });
});
