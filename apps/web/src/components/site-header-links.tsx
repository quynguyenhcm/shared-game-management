'use client';

import { safeReturnTo } from '@sgm/shared';
import { usePathname, useSearchParams } from 'next/navigation';
import { loginUrl, registerUrl } from '../lib/auth/landing.ts';
import { FOCUS_RING, LINK_CLASS } from './auth/styles.ts';
import { SignOutButton } from './sign-out-button.tsx';

export type HeaderState =
  | { kind: 'anonymous' }
  | { kind: 'signed_in'; fullName: string }
  /** A cookie is present but the API cannot answer: never show "Sign in" to a possibly signed-in user. */
  | { kind: 'unavailable' };

const AUTH_PAGES: ReadonlySet<string> = new Set([
  '/login',
  '/register',
  '/register/complete',
  '/forgot-password',
  '/reset-password',
]);
const FLASH_PARAMS = ['notice', 'error', 'provider', 'removed'];

/**
 * Where the header's Sign in and Create account links return to (AC-ENTRY-1): the page's own
 * `returnTo` on auth pages, the current path and query elsewhere (minus notice and error codes), and
 * nothing on `/`. Always validated.
 */
export function headerReturnTo(pathname: string, searchParams: URLSearchParams): string | null {
  if (pathname === '/') return null;
  let candidate: string;
  if (AUTH_PAGES.has(pathname)) {
    candidate = searchParams.get('returnTo') ?? '/';
  } else {
    const rest = new URLSearchParams(searchParams);
    for (const name of FLASH_PARAMS) rest.delete(name);
    const query = rest.toString();
    candidate = query === '' ? pathname : `${pathname}?${query}`;
  }
  const target = safeReturnTo(candidate);
  return target === '/' ? null : target;
}

const BRAND_CLASS = `inline-flex min-h-11 items-center text-base font-semibold ${FOCUS_RING}`;

export function SiteHeaderLinks({ state }: { state: HeaderState }) {
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const returnTo = headerReturnTo(pathname, searchParams);
  const current = (path: string) => (pathname === path ? ('page' as const) : undefined);

  const brand = (
    <a href="/" className={BRAND_CLASS}>
      Shared Game Management
    </a>
  );

  if (state.kind === 'anonymous') {
    return (
      <nav aria-label="Main" className="flex flex-wrap items-center justify-between gap-x-4">
        {brand}
        <a
          href={registerUrl({ returnTo })}
          aria-current={current('/register')}
          className={`order-2 inline-flex min-h-11 items-center rounded-md bg-slate-900 px-3 text-base font-medium text-white sm:order-3 ${FOCUS_RING}`}
        >
          Create account
        </a>
        <a
          href={loginUrl({ returnTo })}
          aria-current={current('/login')}
          className={`${LINK_CLASS} order-3 basis-full sm:order-2 sm:basis-auto`}
        >
          Sign in
        </a>
      </nav>
    );
  }

  if (state.kind === 'unavailable') {
    return (
      <nav aria-label="Main" className="flex flex-wrap items-center justify-between gap-x-4">
        {brand}
        <a href="/account" aria-current={current('/account')} className={LINK_CLASS}>
          Account
        </a>
      </nav>
    );
  }

  return (
    <nav aria-label="Main" className="flex flex-wrap items-center justify-between gap-x-4">
      {brand}
      <div className="order-2 sm:order-3">
        <SignOutButton />
      </div>
      <div className="order-3 flex min-w-0 basis-full items-center gap-4 sm:order-2 sm:basis-auto">
        <span className="min-w-0 truncate text-base">Signed in as {state.fullName}</span>
        <a href="/account" aria-current={current('/account')} className={LINK_CLASS}>
          Account
        </a>
      </div>
    </nav>
  );
}
