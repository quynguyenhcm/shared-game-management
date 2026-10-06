import type { Metadata } from 'next';
import { RedirectType, redirect } from 'next/navigation';
import { AuthCard } from '../../components/auth/auth-card.tsx';
import { FormBanner } from '../../components/auth/form-banner.tsx';
import { LoginForm } from '../../components/auth/login-form.tsx';
import { StripAuthParams } from '../../components/flash-notice.tsx';
import { readCookie } from '../../lib/auth/cookies.ts';
import { errorLinks } from '../../lib/auth/landing.ts';
import { noticeMessage, urlErrorMessage } from '../../lib/auth/messages.ts';
import {
  carriedReturnTo,
  firstParam,
  loadProviders,
  type SearchParams,
} from '../../lib/auth/page-params.ts';
import { getSessionState } from '../../lib/auth/session.ts';

export const metadata: Metadata = { title: 'Sign in' };
export const dynamic = 'force-dynamic';

export default async function LoginPage({ searchParams }: { searchParams: SearchParams }) {
  const params = await searchParams;
  const returnTo = carriedReturnTo(params);

  // "Signed in" is a real API check (X7): a dead cookie falls through and gets the form.
  const session = await getSessionState();
  if (session.kind === 'signed_in') redirect(returnTo ?? '/', RedirectType.replace);

  const providers = await loadProviders();
  const provider = firstParam(params, 'provider');
  const errorCode = firstParam(params, 'error');
  const flashEmail = errorCode === 'oauth_account_exists' ? await readCookie('flash') : null;
  const errorLines = urlErrorMessage(errorCode, {
    provider,
    email: flashEmail,
    intent: 'signin',
    providers,
  });
  const notice = noticeMessage(firstParam(params, 'notice'), {
    provider,
    removed: firstParam(params, 'removed'),
  });

  return (
    <AuthCard title="Sign in">
      <StripAuthParams />
      {notice !== null ? <FormBanner kind="notice" lines={[notice]} /> : null}
      {errorLines !== null && errorCode !== undefined ? (
        <FormBanner kind="error" lines={errorLines} links={errorLinks(errorCode, returnTo)} />
      ) : null}
      {returnTo !== undefined && notice === null && errorLines === null ? (
        <p className="text-base">Sign in to continue.</p>
      ) : null}
      <LoginForm returnTo={returnTo} providers={providers} />
    </AuthCard>
  );
}
