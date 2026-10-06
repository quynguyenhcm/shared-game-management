import type { Metadata } from 'next';
import { RedirectType, redirect } from 'next/navigation';
import { AuthCard } from '../../components/auth/auth-card.tsx';
import { RegisterForm } from '../../components/auth/register-form.tsx';
import { carriedReturnTo, type SearchParams } from '../../lib/auth/page-params.ts';
import { getSessionState } from '../../lib/auth/session.ts';

export const metadata: Metadata = { title: 'Create account' };
export const dynamic = 'force-dynamic';

export default async function RegisterPage({ searchParams }: { searchParams: SearchParams }) {
  const returnTo = carriedReturnTo(await searchParams);
  const session = await getSessionState();
  if (session.kind === 'signed_in') redirect(returnTo ?? '/', RedirectType.replace);

  return (
    <AuthCard title="Create your account">
      <RegisterForm returnTo={returnTo} />
    </AuthCard>
  );
}
