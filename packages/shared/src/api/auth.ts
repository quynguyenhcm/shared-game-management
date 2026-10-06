/**
 * Request and response contracts for `/auth/*`, shared by the Fastify routes and the web api-client.
 * Request bodies are strict: an unknown field (for example `role`) is a 422, so a client can never
 * self-assign a role. Field messages are the copy deck of the user-journey document, so the web and the
 * API show the same text.
 */
import { z } from 'zod';
import { normaliseEmail } from '../auth/email.ts';
import { AssignableGlobalRole, AuthProvider, UserSex } from '../types/enums.ts';

export const FIELD_MESSAGES = {
  fullNameRequired: 'Enter your name.',
  fullNameTooLong: 'Use 255 characters or fewer.',
  emailRequired: 'Enter your email address.',
  emailInvalid: 'Enter a valid email address.',
  passwordRequired: 'Enter your password.',
  passwordTooShort: 'Use at least 10 characters.',
  passwordTooLong: 'Use at most 128 characters.',
  passwordCommon: 'This password is too common or too easy to guess. Choose a different one.',
  sexRequired: 'Select your sex to continue.',
} as const;

export const PASSWORD_MIN_LENGTH = 10;
export const PASSWORD_MAX_LENGTH = 128;
export const FULL_NAME_MAX_LENGTH = 255;
/** Sign-in and forgot accept any string up to this size; only set-password rules are enforced on write. */
const EMAIL_INPUT_MAX_LENGTH = 320;
const LOGIN_PASSWORD_MAX_LENGTH = 1024;
const TOKEN_MAX_LENGTH = 512;

// ---------------------------------------------------------------------------------------------
// Field schemas
// ---------------------------------------------------------------------------------------------

/** A registration or provider email: trimmed, normalised (S1-b) and validated. */
export const EmailInput = z
  .string({ error: FIELD_MESSAGES.emailRequired })
  .transform((value, ctx) => {
    if (value.trim() === '') {
      ctx.addIssue({ code: 'custom', message: FIELD_MESSAGES.emailRequired });
      return z.NEVER;
    }
    const email = normaliseEmail(value);
    if (email === null) {
      ctx.addIssue({ code: 'custom', message: FIELD_MESSAGES.emailInvalid });
      return z.NEVER;
    }
    return email;
  });

/**
 * An email on sign-in or forgot-password: only required. A malformed address still gets the generic
 * answer (401 or 202), never a 422 that would hint at account state; the service normalises it.
 */
export const EmailLookupInput = z
  .string({ error: FIELD_MESSAGES.emailRequired })
  .trim()
  .min(1, FIELD_MESSAGES.emailRequired)
  .max(EMAIL_INPUT_MAX_LENGTH, FIELD_MESSAGES.emailInvalid);

export const FullNameInput = z
  .string({ error: FIELD_MESSAGES.fullNameRequired })
  .trim()
  .min(1, FIELD_MESSAGES.fullNameRequired)
  .max(FULL_NAME_MAX_LENGTH, FIELD_MESSAGES.fullNameTooLong);

export const SexInput = z.enum(UserSex, { error: FIELD_MESSAGES.sexRequired });

/**
 * A password being set (register, reset): 10 to 128 code points after NFKC. The common-password and
 * equals-email checks need the email and the blocklist, so they live in the API (`password-policy.ts`).
 */
export const NewPasswordInput = z
  .string({ error: FIELD_MESSAGES.passwordRequired })
  .superRefine((value, ctx) => {
    const length = [...value.normalize('NFKC')].length;
    if (length < PASSWORD_MIN_LENGTH) {
      ctx.addIssue({ code: 'custom', message: FIELD_MESSAGES.passwordTooShort });
    } else if (length > PASSWORD_MAX_LENGTH) {
      ctx.addIssue({ code: 'custom', message: FIELD_MESSAGES.passwordTooLong });
    }
  });

/** A password being checked at sign-in: any non-empty value, no policy (legacy-proof), bounded size. */
export const LoginPasswordInput = z
  .string({ error: FIELD_MESSAGES.passwordRequired })
  .min(1, FIELD_MESSAGES.passwordRequired)
  .max(LOGIN_PASSWORD_MAX_LENGTH, FIELD_MESSAGES.passwordTooLong);

const TokenInput = z.string().min(1).max(TOKEN_MAX_LENGTH);
const ReturnToInput = z.string().max(512).optional();

// ---------------------------------------------------------------------------------------------
// Requests
// ---------------------------------------------------------------------------------------------

export const RegisterRequest = z.strictObject({
  fullName: FullNameInput,
  email: EmailInput,
  password: NewPasswordInput,
  sex: SexInput,
});
export type RegisterRequest = z.infer<typeof RegisterRequest>;

export const LoginRequest = z.strictObject({
  email: EmailLookupInput,
  password: LoginPasswordInput,
});
export type LoginRequest = z.infer<typeof LoginRequest>;

export const ForgotPasswordRequest = z.strictObject({ email: EmailLookupInput });
export type ForgotPasswordRequest = z.infer<typeof ForgotPasswordRequest>;

export const ResetPasswordRequest = z.strictObject({
  token: TokenInput,
  password: NewPasswordInput,
});
export type ResetPasswordRequest = z.infer<typeof ResetPasswordRequest>;

export const ResetPasswordCheckRequest = z.strictObject({ token: TokenInput });
export type ResetPasswordCheckRequest = z.infer<typeof ResetPasswordCheckRequest>;

/** The two OAuth providers (`auth_provider` minus PASSWORD). */
export const OAuthProviderName = z.enum(['GOOGLE', 'FACEBOOK']);
export type OAuthProviderName = z.infer<typeof OAuthProviderName>;

export const OAuthAuthorizeRequest = z.strictObject({
  returnTo: ReturnToInput,
  /** Honoured for Facebook only (`auth_type=rerequest`). */
  rerequest: z.boolean().optional(),
});
export type OAuthAuthorizeRequest = z.infer<typeof OAuthAuthorizeRequest>;

export const OAuthCallbackRequest = z.union([
  z.strictObject({ state: z.string().min(1).max(256), code: z.string().min(1).max(2048) }),
  z.strictObject({ state: z.string().min(1).max(256), error: z.string().min(1).max(256) }),
]);
export type OAuthCallbackRequest = z.infer<typeof OAuthCallbackRequest>;

export const OAuthCompleteRequest = z.strictObject({
  pendingToken: TokenInput,
  fullName: FullNameInput,
  sex: SexInput,
});
export type OAuthCompleteRequest = z.infer<typeof OAuthCompleteRequest>;

// ---------------------------------------------------------------------------------------------
// Responses
// ---------------------------------------------------------------------------------------------

/** The signed-in user as every auth endpoint returns it. The role is read fresh on each request. */
export const PublicUser = z.object({
  id: z.uuid(),
  email: z.string(),
  fullName: z.string(),
  sex: z.enum(UserSex),
  role: z.enum(AssignableGlobalRole),
});
export type PublicUser = z.infer<typeof PublicUser>;

export const SessionInfo = z.object({
  /** Opaque bearer token, returned only in the JSON body to the web server (never a cookie). */
  token: z.string(),
  expiresAt: z.iso.datetime(),
});
export type SessionInfo = z.infer<typeof SessionInfo>;

export const AuthSuccessResponse = z.object({ user: PublicUser, session: SessionInfo });
export type AuthSuccessResponse = z.infer<typeof AuthSuccessResponse>;

export const MeResponse = z.object({ user: PublicUser });
export type MeResponse = z.infer<typeof MeResponse>;

export const ProvidersResponse = z.object({ google: z.boolean(), facebook: z.boolean() });
export type ProvidersResponse = z.infer<typeof ProvidersResponse>;

/** The one body `forgot` ever returns (202), so a response never reveals whether the account exists. */
export const ForgotPasswordResponse = z.object({ accepted: z.literal(true) });
export type ForgotPasswordResponse = z.infer<typeof ForgotPasswordResponse>;

export const ResetPasswordResponse = z.object({
  removedProviders: z.array(z.enum(['GOOGLE', 'FACEBOOK'])),
});
export type ResetPasswordResponse = z.infer<typeof ResetPasswordResponse>;

export const OAuthAuthorizeResponse = z.object({
  authorizationUrl: z.url(),
  state: z.string(),
});
export type OAuthAuthorizeResponse = z.infer<typeof OAuthAuthorizeResponse>;

export const OAuthCallbackResponse = z.discriminatedUnion('outcome', [
  z.object({
    outcome: z.literal('signed_in'),
    user: PublicUser,
    session: SessionInfo,
    returnTo: z.string(),
  }),
  z.object({
    outcome: z.literal('pending_signup'),
    pendingToken: z.string(),
    returnTo: z.string(),
  }),
  z.object({ outcome: z.literal('linked'), returnTo: z.literal('/account') }),
  z.object({ outcome: z.literal('already_linked'), returnTo: z.literal('/account') }),
]);
export type OAuthCallbackResponse = z.infer<typeof OAuthCallbackResponse>;

export const OAuthPendingResponse = z.object({
  provider: z.enum(['GOOGLE', 'FACEBOOK']),
  email: z.string(),
  fullName: z.string().nullable(),
  expiresAt: z.iso.datetime(),
  returnTo: z.string(),
});
export type OAuthPendingResponse = z.infer<typeof OAuthPendingResponse>;

export const OAuthCompleteResponse = z.object({
  user: PublicUser,
  session: SessionInfo,
  returnTo: z.string(),
});
export type OAuthCompleteResponse = z.infer<typeof OAuthCompleteResponse>;

export const IdentitiesResponse = z.object({
  identities: z.array(
    z.object({
      provider: z.enum(AuthProvider),
      connectedAt: z.iso.datetime(),
      lastUsedAt: z.iso.datetime().nullable(),
    }),
  ),
  enabledProviders: ProvidersResponse,
});
export type IdentitiesResponse = z.infer<typeof IdentitiesResponse>;

// ---------------------------------------------------------------------------------------------
// OAuth and identity linking path/header parameters
// ---------------------------------------------------------------------------------------------

/** `:provider` in `/auth/oauth/:provider/*` and `/auth/identities/:provider*`: lower case, enabled or not. */
export const OAuthProviderParams = z.strictObject({ provider: z.enum(['google', 'facebook']) });
export type OAuthProviderParams = z.infer<typeof OAuthProviderParams>;

/** `GET /auth/oauth/pending` carries the pending sign-up handle in a header, never in the URL. */
export const OAuthPendingHeaders = z.looseObject({
  'x-pending-signup': z.string().min(1).max(512),
});
export type OAuthPendingHeaders = z.infer<typeof OAuthPendingHeaders>;
