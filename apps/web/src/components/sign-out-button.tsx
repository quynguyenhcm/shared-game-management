'use client';

import { useFormStatus } from 'react-dom';
import { signOutAction } from '../lib/auth/actions.ts';
import { FOCUS_RING } from './auth/styles.ts';

function Button({ className }: { className: string }) {
  const { pending } = useFormStatus();
  return (
    <button
      type="submit"
      aria-disabled={pending}
      onClick={(event) => {
        if (pending) event.preventDefault();
      }}
      className={className}
    >
      {pending ? 'Signing out…' : 'Sign out'}
    </button>
  );
}

/** A form posting the sign-out Server Action; used by the header and /account. */
export function SignOutButton({ variant = 'header' }: { variant?: 'header' | 'page' }) {
  const className =
    variant === 'header'
      ? `inline-flex min-h-11 items-center rounded-md bg-slate-900 px-3 text-base font-medium text-white aria-disabled:opacity-60 ${FOCUS_RING}`
      : `inline-flex min-h-11 items-center justify-center rounded-md border border-slate-500 px-4 text-base font-medium aria-disabled:opacity-60 ${FOCUS_RING}`;
  return (
    <form action={signOutAction}>
      <Button className={className} />
    </form>
  );
}
