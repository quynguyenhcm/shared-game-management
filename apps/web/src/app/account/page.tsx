import type { Metadata } from 'next';
import { AuthCard } from '../../components/auth/auth-card.tsx';
import { FormBanner } from '../../components/auth/form-banner.tsx';
import { SignInMethods } from '../../components/auth/sign-in-methods.tsx';
import { StripAuthParams } from '../../components/flash-notice.tsx';
import { SignOutButton } from '../../components/sign-out-button.tsx';
import { headers } from 'next/headers';
import { apiClient } from '../../lib/api-client.ts';
import { readCookie } from '../../lib/auth/cookies.ts';
import { noticeMessage, urlErrorMessage } from '../../lib/auth/messages.ts';
import { firstParam, type SearchParams } from '../../lib/auth/page-params.ts';
import { SessionUnavailableError, requireUser } from '../../lib/auth/session.ts';

export const metadata: Metadata = { title: 'Your account' };
export const dynamic = 'force-dynamic';

export default async function AccountPage({ searchParams }: { searchParams: SearchParams }) {
  const user = await requireUser('/account');
  const params = await searchParams;
  // `requireUser` just proved the session is live; an API that cannot answer now shows E-PAGE-1.
  const token = await readCookie('session');
  const identities =
    token === null ? null : await apiClient.identities(token, { incoming: await headers() });
  if (identities === null || !identities.ok) throw new SessionUnavailableError();
  const provider = firstParam(params, 'provider');
  const noticeCode = firstParam(params, 'notice');
  // `welcome` belongs to the layout's FlashNotice (shown once on whatever page the user lands on);
  // rendering it here too showed the banner twice after a sign-up that returns to /account.
  const notice = noticeCode === 'welcome' ? null : noticeMessage(noticeCode, { provider });
  const errorLines = urlErrorMessage(firstParam(params, 'error'), { provider, intent: 'link' });

  return (
    <AuthCard title="Your account">
      <StripAuthParams />
      {notice !== null ? <FormBanner kind="notice" lines={[notice]} /> : null}
      {errorLines !== null ? <FormBanner kind="error" lines={errorLines} /> : null}

      <section aria-labelledby="details-heading" className="flex flex-col gap-2">
        <h2 id="details-heading" className="text-lg font-semibold">
          Details
        </h2>
        <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-base">
          <dt className="font-medium">Name</dt>
          <dd className="min-w-0 break-words">{user.fullName}</dd>
          <dt className="font-medium">Email</dt>
          <dd className="min-w-0 break-words">{user.email}</dd>
          <dt className="font-medium">Sex</dt>
          <dd>{user.sex.charAt(0) + user.sex.slice(1).toLowerCase()}</dd>
        </dl>
        {user.role === 'GLOBAL_ADMIN' ? (
          <p className="text-base font-medium">Platform admin</p>
        ) : null}
      </section>

      <section aria-labelledby="methods-heading" className="flex flex-col gap-2">
        <h2 id="methods-heading" className="text-lg font-semibold">
          Sign-in methods
        </h2>
        <SignInMethods
          identities={identities.data.identities}
          enabledProviders={identities.data.enabledProviders}
        />
      </section>

      <section aria-labelledby="signout-heading" className="flex flex-col gap-2">
        <h2 id="signout-heading" className="text-lg font-semibold">
          Sign out
        </h2>
        <SignOutButton variant="page" />
      </section>
    </AuthCard>
  );
}
