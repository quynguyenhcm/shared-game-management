import { describe, expect, it } from 'vitest';
import { validateEmailMessage } from '../../lib/notifications/notifier.ts';
import { buildIdentityLinkedEmail, buildPasswordResetEmail } from './emails.ts';

const input = {
  to: 'aroha.ngata@example.com',
  fullName: 'Aroha Ngata',
  token: 'Zm9vYmFyLXRva2VuXzEyMw',
  tokenId: '0b9f5f64-4f8a-4a52-9d73-6e1d3f0c2a11',
  webBaseUrl: 'https://games.example.nz',
  expiryMinutes: 60,
} as const;

describe('password-reset email (AC-INTEGRATION-1 copy, AC-ASYNC-1 key)', () => {
  it('uses the copy-deck subject, the 60-minute expiry, the ignore line and a /reset-password link', () => {
    const message = buildPasswordResetEmail(input);
    expect(message.to).toBe('aroha.ngata@example.com');
    expect(message.subject).toBe('Reset your Shared Game Management password');
    expect(message.text).toContain('Hi Aroha Ngata,');
    expect(message.text).toContain(
      'https://games.example.nz/reset-password?token=Zm9vYmFyLXRva2VuXzEyMw',
    );
    expect(message.text).toContain('This link expires in 60 minutes and can be used once.');
    expect(message.text).toContain("If you didn't request this, ignore this email.");
    // The reset also disconnects Google and Facebook (D1): the email says so before the click.
    expect(message.text).toContain('disconnects any Google or Facebook sign-in');
  });

  it('keys the job by token id and tags the template, and passes the shared message validation', () => {
    const message = buildPasswordResetEmail(input);
    expect(message.idempotencyKey).toBe(`password-reset:${input.tokenId}`);
    expect(message.tags).toEqual({ template: 'password-reset' });
    expect(() => {
      validateEmailMessage(message, 'test');
    }).not.toThrow();
  });

  it('states the configured expiry rather than a hard-coded one, and escapes the token in the URL', () => {
    const message = buildPasswordResetEmail({ ...input, expiryMinutes: 15, token: 'a b&c' });
    expect(message.text).toContain('expires in 15 minutes');
    expect(message.text).toContain('/reset-password?token=a%20b%26c');
  });
});

describe('identity-linked email (AC-ASYNC-5)', () => {
  const linked = {
    to: 'aroha.ngata@example.com',
    fullName: 'Aroha\nNgata',
    provider: 'GOOGLE',
    identityId: '5d2f4e0a-3b1c-4d6e-8f70-1a2b3c4d5e6f',
  } as const;

  it('uses the copy-deck subject and sentence, keys the job by identity id and passes message validation', () => {
    const message = buildIdentityLinkedEmail(linked);
    expect(message.subject).toBe('Google sign-in connected to your Shared Game Management account');
    expect(message.text).toContain("If this wasn't you, reset your password now");
    expect(message.text).toContain('Hi Aroha Ngata,'); // a line break in the name cannot forge body lines
    expect(message.idempotencyKey).toBe(`identity-linked:${linked.identityId}`);
    expect(message.tags).toEqual({ template: 'identity-linked' });
    expect(buildIdentityLinkedEmail({ ...linked, provider: 'FACEBOOK' }).subject).toMatch(
      /^Facebook sign-in/,
    );
    expect(() => {
      validateEmailMessage(message, 'test');
    }).not.toThrow();
  });
});
