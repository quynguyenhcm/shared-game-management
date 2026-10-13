import { describe, expect, it } from 'vitest';
import {
  validateForgotPassword,
  validateLogin,
  validateRegister,
  validateResetPassword,
} from './validation.ts';

const VALID_REGISTER = {
  fullName: 'Aroha Ngata',
  email: 'Aroha.Ngata@Example.com',
  password: 'kowhai-court-27',
  sex: 'FEMALE',
};

describe('client validation (same shared zod messages as the API)', () => {
  it('blocks registration without a sex and says so (AC-ENTRY-3, X9)', () => {
    expect(validateRegister({ ...VALID_REGISTER, sex: undefined })).toEqual({
      sex: ['Select your sex to continue.'],
    });
    expect(validateRegister({ ...VALID_REGISTER, sex: '' })).toEqual({
      sex: ['Select your sex to continue.'],
    });
    expect(validateRegister({ ...VALID_REGISTER, sex: 'ROBOT' })).toHaveProperty('sex');
    expect(validateRegister(VALID_REGISTER)).toEqual({});
  });

  it('reports every invalid registration field with the copy-deck text (AC-ERROR-2)', () => {
    expect(validateRegister({ fullName: ' ', email: '', password: 'short', sex: 'MALE' })).toEqual({
      fullName: ['Enter your name.'],
      email: ['Enter your email address.'],
      password: ['Use at least 10 characters.'],
    });
    expect(validateRegister({ ...VALID_REGISTER, email: 'aroha@gmail' }).email).toEqual([
      'Enter a valid email address.',
    ]);
    expect(validateRegister({ ...VALID_REGISTER, password: 'x'.repeat(129) }).password).toEqual([
      'Use at most 128 characters.',
    ]);
  });

  it('checks email syntax and a non-empty password on sign-in without a password policy (X10)', () => {
    expect(validateLogin({ email: 'a@example.com', password: 'whatever' })).toEqual({});
    expect(validateLogin({ email: 'aroha@gmail', password: '' })).toEqual({
      email: ['Enter a valid email address.'],
      password: ['Enter your password.'],
    });
  });

  it('checks the forgot email and the reset password', () => {
    expect(validateForgotPassword({ email: '' })).toEqual({ email: ['Enter your email address.'] });
    expect(validateForgotPassword({ email: 'a@example.com' })).toEqual({});
    expect(validateResetPassword({ password: 'short' })).toEqual({
      password: ['Use at least 10 characters.'],
    });
    expect(validateResetPassword({ password: 'a-long-enough-one' })).toEqual({});
  });
});
