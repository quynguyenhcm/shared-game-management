import { z } from 'zod';

/**
 * The authoritative HTTP error codes (architecture doc, "Shared HTTP error shape"). Web and API both
 * import this list; `apps/api/src/lib/http/errors.ts` maps every code to a status and a safe message.
 */
export const ErrorCode = [
  // generic
  'validation_failed',
  'unauthenticated',
  'session_expired',
  'forbidden',
  'cross_origin_request',
  'not_found',
  'conflict',
  'internal_error',
  'service_unavailable',
  // password auth and reset
  'email_taken',
  'invalid_credentials',
  'too_many_attempts',
  'too_many_requests',
  'invalid_or_expired_token',
  // OAuth sign-in and sign-up
  'provider_not_enabled',
  'provider_unavailable',
  'oauth_state_invalid',
  'oauth_cancelled',
  'oauth_email_missing',
  'oauth_email_unverified',
  'oauth_account_exists',
  'signup_expired',
  // identities (link and unlink)
  'identity_in_use',
  'provider_already_connected',
  'link_session_mismatch',
  'last_sign_in_method',
  // teams: join, invite and moderation (team-management)
  'invite_invalid',
  'already_requested',
  'already_member',
  'banned_from_team',
  'team_admin_cannot_be_banned',
  'last_team_admin',
  'membership_state_conflict',
  // team banking: publish gate and removal guard (team-banking-and-gst)
  'payout_not_configured',
  'banking_in_use',
  // skill levels: optimistic concurrency on an admin override (skill-levels-and-auto-enroll, decision 4)
  'skill_level_stale',
  // ...and on an Auto Enroll save (final review: a stale panel must not re-enrol a member another admin turned off)
  'auto_enroll_stale',
  // session scheduling (session-scheduling-engine, Binding Reconciliation T-7, T-11, T-12; architecture SA-6, SA-7)
  'session_stale',
  'series_stale',
  'series_ended',
  'session_started',
  'session_not_editable',
  'session_state_conflict',
  'session_fee_locked',
  // registration and waitlist (registration-and-waitlist AC-VERIFY-7, R3, R9)
  'overdue_payments',
  'session_not_open',
  'already_registered',
  'not_registered',
  'party_exceeds_capacity',
  'late_withdrawal_fee_due',
  'cancellation_terms_changed',
] as const;
export type ErrorCode = (typeof ErrorCode)[number];

/** Every non-2xx API body: `{ error: { code, message, fieldErrors? } }`. */
export const ErrorResponse = z.object({
  error: z.object({
    code: z.enum(ErrorCode),
    /** Safe, user-presentable, never echoes input. */
    message: z.string(),
    /** Per-field messages (422 `validation_failed`); the same text the web shows beside the field. */
    fieldErrors: z.record(z.string(), z.array(z.string())).optional(),
    /** Only with `oauth_account_exists`; read by the web server, never rendered from a URL. */
    email: z.string().optional(),
  }),
});
export type ErrorResponse = z.infer<typeof ErrorResponse>;
