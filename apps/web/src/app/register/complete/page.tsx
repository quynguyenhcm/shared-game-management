import type { Metadata } from 'next';
import { headers } from 'next/headers';
import { RedirectType, redirect } from 'next/navigation';
import { AuthCard } from '../../../components/auth/auth-card.tsx';
import { CompleteSignupForm } from '../../../components/auth/complete-signup-form.tsx';
import { apiClient } from '../../../lib/api-client.ts';
import { readCookie } from '../../../lib/auth/cookies.ts';
import { loginUrl } from '../../../lib/auth/landing.ts';
import { getSessionState } from '../../../lib/auth/session.ts';

export const metadata: Metadata = { title: 'Finish signing up' };
export const dynamic = 'force-dynamic';

/** No pending sign-up: finished in another tab (a live session) or expired. Neither shows a form. */
async function leave(): Promise<never> {
  const session = await getSessionState();
  return redirect(
    session.kind === 'signed_in' ? '/' : loginUrl({ error: 'signup_expired' }),
    RedirectType.replace,
  );
}

/**
 * Step two of a first-time Google or Facebook sign-up. It is driven by the `sgm_pending` cookie alone
 * (the handle goes to the API in a header, never in a URL); nothing exists in the database until the
 * form is submitted.
 */
export default async function CompleteSignupPage() {
  const token = await readCookie('pending');
  if (token === null) return leave();

  const pending = await apiClient.oauthPending(token, { incoming: await headers() });
  if (!pending.ok) {
    // An outage is not an expiry: show the page error and keep the pending sign-up for a retry.
    if (pending.status === 0 || pending.status >= 500) {
      throw new Error('The pending sign-up could not be loaded because the API is unavailable.');
    }
    return leave();
  }

  const { provider, email, fullName, returnTo } = pending.data;
  return (
    <AuthCard title="Finish signing up">
      <CompleteSignupForm
        provider={provider === 'GOOGLE' ? 'google' : 'facebook'}
        email={email}
        fullName={fullName}
        returnTo={returnTo}
      />
    </AuthCard>
  );
}
