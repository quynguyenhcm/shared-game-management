import { Suspense } from 'react';
import { getSessionState } from '../lib/auth/session.ts';
import { SiteHeaderLinks, type HeaderState } from './site-header-links.tsx';

function headerState(session: Awaited<ReturnType<typeof getSessionState>>): HeaderState {
  switch (session.kind) {
    case 'signed_in':
      return { kind: 'signed_in', fullName: session.user.fullName };
    case 'unavailable':
      return { kind: 'unavailable' };
    default:
      // Anonymous, and a dead cookie (cleared later by /auth/session-expired or the next sign-in).
      return { kind: 'anonymous' };
  }
}

/** Mounted in the root layout. The links are a client component so they can read the current URL. */
export async function SiteHeader() {
  const state = headerState(await getSessionState());
  return (
    <header className="border-b border-slate-300">
      <div className="mx-auto max-w-3xl px-4 py-1">
        <Suspense fallback={null}>
          <SiteHeaderLinks state={state} />
        </Suspense>
      </div>
    </header>
  );
}
