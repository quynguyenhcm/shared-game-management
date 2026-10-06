import type { Metadata } from 'next';
import { AuthCard } from '../../components/auth/auth-card.tsx';
import { FormBanner } from '../../components/auth/form-banner.tsx';
import { SignInMethods } from '../../components/auth/sign-in-methods.tsx';
import { LINK_CLASS } from '../../components/auth/styles.ts';
import { StripAuthParams } from '../../components/flash-notice.tsx';
import { SignOutButton } from '../../components/sign-out-button.tsx';
import { forgotPasswordUrl } from '../../lib/auth/landing.ts';
import { noticeMessage, urlErrorMessage } from '../../lib/auth/messages.ts';
import { firstParam, type SearchParams } from '../../lib/auth/page-params.ts';
import { requireUser } from '../../lib/auth/session.ts';

export const metadata: Metadata = { title: 'Your account' };
export const dynamic = 'force-dynamic';

export default async function AccountPage({ searchParams }: { searchParams: SearchParams }) {
  const user = await requireUser('/account');
  const params = await searchParams;
  const provider = firstParam(params, 'provider');
  const notice = noticeMessage(firstParam(params, 'notice'), { provider });
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
        <SignInMethods />
        <div className="flex flex-col">
          <a href={forgotPasswordUrl({ returnTo: '/account' })} className={LINK_CLASS}>
            Set a password
          </a>
          <p className="text-sm text-slate-700">We&apos;ll email you a link to set one.</p>
        </div>
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
