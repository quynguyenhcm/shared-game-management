import type { Metadata } from 'next';
import { ForgotPasswordForm } from '../../components/auth/forgot-password-form.tsx';
import { carriedReturnTo, type SearchParams } from '../../lib/auth/page-params.ts';
import { getCurrentUser } from '../../lib/auth/session.ts';

export const metadata: Metadata = { title: 'Reset your password' };
export const dynamic = 'force-dynamic';

export default async function ForgotPasswordPage({ searchParams }: { searchParams: SearchParams }) {
  const returnTo = carriedReturnTo(await searchParams);
  // Signed in (for example "Set a password" from /account): prefill their own email.
  const user = await getCurrentUser();
  return <ForgotPasswordForm returnTo={returnTo} defaultEmail={user?.email} />;
}
