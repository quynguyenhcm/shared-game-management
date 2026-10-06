import { z } from 'zod';
import {
  EmailInput,
  EmailLookupInput,
  FIELD_MESSAGES,
  FullNameInput,
  LoginPasswordInput,
  NewPasswordInput,
  SexInput,
  normaliseEmail,
} from '@sgm/shared';

/** Field name to messages, the shape `ErrorResponse.error.fieldErrors` and the forms share. */
export type FieldErrors = Record<string, string[]>;

type Values = Record<string, string | undefined>;

const RegisterValues = z.object({
  fullName: FullNameInput,
  email: EmailInput,
  password: NewPasswordInput,
  sex: SexInput,
});

function errorsOf(error: z.ZodError): FieldErrors {
  return z.flattenError(error).fieldErrors;
}

/** Client-side registration checks: the same shared zod messages as the API (X9: blocks, never disables). */
export function validateRegister(values: Values): FieldErrors {
  const result = RegisterValues.safeParse({
    fullName: values.fullName ?? '',
    email: values.email ?? '',
    password: values.password ?? '',
    sex: values.sex === '' ? undefined : values.sex,
  });
  return result.success ? {} : errorsOf(result.error);
}

/**
 * Sign-in: email syntax (X10) and a non-empty password. A syntax check says nothing about whether an
 * account exists, so it keeps the API's enumeration resistance while sparing a throttle slot on a typo.
 */
export function validateLogin(values: Values): FieldErrors {
  const errors: FieldErrors = {};
  const email = (values.email ?? '').trim();
  if (email === '') errors.email = [FIELD_MESSAGES.emailRequired];
  else if (normaliseEmail(email) === null) errors.email = [FIELD_MESSAGES.emailInvalid];
  const password = LoginPasswordInput.safeParse(values.password ?? '');
  if (!password.success) errors.password = [FIELD_MESSAGES.passwordRequired];
  return errors;
}

export function validateForgotPassword(values: Values): FieldErrors {
  const email = (values.email ?? '').trim();
  if (email === '') return { email: [FIELD_MESSAGES.emailRequired] };
  const lookup = EmailLookupInput.safeParse(email);
  if (!lookup.success || normaliseEmail(email) === null) {
    return { email: [FIELD_MESSAGES.emailInvalid] };
  }
  return {};
}

export function validateResetPassword(values: Values): FieldErrors {
  const result = NewPasswordInput.safeParse(values.password ?? '');
  return result.success ? {} : { password: result.error.issues.map((issue) => issue.message) };
}

const CompleteSignupValues = z.object({ fullName: FullNameInput, sex: SexInput });

/** `/register/complete`: the editable name and the required sex (the email comes from the provider). */
export function validateCompleteSignup(values: Values): FieldErrors {
  const result = CompleteSignupValues.safeParse({
    fullName: values.fullName ?? '',
    sex: values.sex === '' ? undefined : values.sex,
  });
  return result.success ? {} : errorsOf(result.error);
}
