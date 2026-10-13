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

  const findTeam = (
    <a href="/teams/find" aria-current={current('/teams/find')} className={LINK_CLASS}>
      Find a team
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
        <div className="order-3 flex basis-full flex-wrap items-center gap-x-4 sm:order-2 sm:basis-auto">
          {findTeam}
          <a href={loginUrl({ returnTo })} aria-current={current('/login')} className={LINK_CLASS}>
            Sign in
          </a>
        </div>
      </nav>
    );
  }

  if (state.kind === 'unavailable') {
    return (
      <nav aria-label="Main" className="flex flex-wrap items-center justify-between gap-x-4">
        {brand}
        <div className="flex flex-wrap items-center gap-x-4">
          {findTeam}
          <a href="/account" aria-current={current('/account')} className={LINK_CLASS}>
            Account
          </a>
        </div>
      </nav>
    );
  }

  // Signed in. Tab order: brand, links, signed-in text, Sign out. At 360 px: row 1 brand and Sign out,
  // row 2 the links (they wrap), row 3 the truncated name; from `sm` everything shares one wrapping row.
  return (
    <nav aria-label="Main" className="flex flex-wrap items-center gap-x-4">
      {brand}
      <div className="order-3 flex basis-full flex-wrap items-center gap-x-4 sm:order-2 sm:basis-auto">
        {findTeam}
        <a href="/teams" aria-current={current('/teams')} className={LINK_CLASS}>
          My teams
        </a>
        <a href="/account" aria-current={current('/account')} className={LINK_CLASS}>
          Account
        </a>
      </div>
      <span className="order-4 min-w-0 basis-full truncate text-base sm:order-3 sm:ml-auto sm:basis-auto">
        Signed in as {state.fullName}
      </span>
      <div className="order-2 ml-auto sm:order-4 sm:ml-0">
        <SignOutButton />
      </div>
    </nav>
  );
}
