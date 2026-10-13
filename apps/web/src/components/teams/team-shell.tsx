import type { ReactNode } from 'react';

/** One task per page: a single wrapping column with 16 px gutters (lists need more room than AuthCard). */
export function TeamShell({ children }: { children: ReactNode }) {
  return <main className="mx-auto flex w-full max-w-2xl flex-col gap-5 px-4 py-8">{children}</main>;
}

/** Small text pill (Private team, Public team): text, so meaning never depends on colour. */
export function Tag({ children }: { children: ReactNode }) {
  return (
    <span className="inline-flex items-center rounded-md border border-slate-500 px-2 py-0.5 text-sm">
      {children}
    </span>
  );
}
