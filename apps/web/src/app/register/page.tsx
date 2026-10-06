import type { Metadata } from 'next';
import { headers } from 'next/headers';
import { RedirectType, redirect } from 'next/navigation';
import { AuthCard } from '../../components/auth/auth-card.tsx';
import { OAuthButtons } from '../../components/auth/oauth-buttons.tsx';
import { RegisterForm } from '../../components/auth/register-form.tsx';
import { isInAppBrowser } from '../../lib/auth/in-app-browser.ts';
import {
  carriedReturnTo,
  loadProviderStatus,
  type SearchParams,
} from '../../lib/auth/page-params.ts';
import { getSessionState } from '../../lib/auth/session.ts';

export const metadata: Metadata = { title: 'Create account' };
export const dynamic = 'force-dynamic';

export default async function RegisterPage({ searchParams }: { searchParams: SearchParams }) {
  const returnTo = carriedReturnTo(await searchParams);
  const session = await getSessionState();
  if (session.kind === 'signed_in') redirect(returnTo ?? '/', RedirectType.replace);

  const { providers, unavailable } = await loadProviderStatus();
  const inAppBrowser = isInAppBrowser((await headers()).get('user-agent'));

  return (
    <AuthCard title="Create your account">
      <OAuthButtons
        providers={providers}
        unavailable={unavailable}
        returnTo={returnTo}
        inAppBrowser={inAppBrowser}
      />
      <RegisterForm returnTo={returnTo} />
    </AuthCard>
  );
}
