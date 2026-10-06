/**
 * Transactional auth emails: the copy deck of the user-journey document, as `EmailMessage`s ready for
 * `enqueueEmail`. Plain text only. The raw reset token appears only inside the message body, never in a log
 * field, error or span.
 */
import type { EmailMessage } from '../../lib/notifications/notifier.ts';

export interface PasswordResetEmailInput {
  /** The account's normalised email: the only recipient. */
  readonly to: string;
  readonly fullName: string;
  /** The raw token (base64url); only its SHA-256 is stored. */
  readonly token: string;
  /** `password_reset_tokens.id`: the job's idempotency key is derived from it. */
  readonly tokenId: string;
  /** `config.auth.webBaseUrl`: origin of the web app, no trailing slash. */
  readonly webBaseUrl: string;
  /** `config.auth.resetTokenMinutes`: stated in the body so the copy never drifts from the setting. */
  readonly expiryMinutes: number;
}

/** AC-INTEGRATION-1: subject, expiry sentence, ignore sentence and a `/reset-password?token=` link. */
export function buildPasswordResetEmail(input: PasswordResetEmailInput): EmailMessage {
  const link = `${input.webBaseUrl}/reset-password?token=${encodeURIComponent(input.token)}`;
  // A name is user input: fold any line breaks so it cannot forge extra lines in the body.
  const name = input.fullName.replace(/\s+/g, ' ').trim();
  const text = [
    `Hi ${name},`,
    '',
    'We received a request to reset the password for your Shared Game Management account.',
    '',
    'Set a new password:',
    link,
    '',
    `This link expires in ${input.expiryMinutes} minutes and can be used once. Setting a new password signs you out on all your devices and disconnects any Google or Facebook sign-in from your account.`,
    '',
    "If you didn't request this, ignore this email. Your password won't change.",
    '',
    'Shared Game Management',
    '',
  ].join('\n');
  return {
    to: input.to,
    subject: 'Reset your Shared Game Management password',
    text,
    idempotencyKey: `password-reset:${input.tokenId}`,
    tags: { template: 'password-reset' },
  };
}
