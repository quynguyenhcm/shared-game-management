import type { Metadata } from 'next';
import { AuthCard } from '../../components/auth/auth-card.tsx';
import { FormBanner } from '../../components/auth/form-banner.tsx';
import { ResetPasswordForm } from '../../components/auth/reset-password-form.tsx';
import { errorLinks } from '../../lib/auth/landing.ts';
import { errorMessage } from '../../lib/auth/messages.ts';
import { firstParam, type SearchParams } from '../../lib/auth/page-params.ts';

export const metadata: Metadata = { title: 'Set a new password', referrer: 'no-referrer' };
export const dynamic = 'force-dynamic';

/** The token is validated on submit (the optional reset/check endpoint is not built, AC-ERROR-19). */
export default async function ResetPasswordPage({ searchParams }: { searchParams: SearchParams }) {
  const token = firstParam(await searchParams, 'token');
  return (
    <AuthCard title="Set a new password">
      {token ? (
        <ResetPasswordForm token={token} />
      ) : (
        <FormBanner
          kind="error"
          lines={errorMessage('invalid_or_expired_token', {}) ?? []}
          links={errorLinks('invalid_or_expired_token', undefined)}
        />
      )}
    </AuthCard>
  );
}
