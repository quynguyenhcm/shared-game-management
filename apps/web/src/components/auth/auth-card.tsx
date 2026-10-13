import type { ReactNode } from 'react';

/** One task per page: a single column, one H1, 16 px gutters (the reference layout for later forms). */
export function AuthCard({ title, children }: { title: string; children: ReactNode }) {
  return (
    <main className="mx-auto flex w-full max-w-sm flex-col gap-5 px-4 py-8">
      <h1 className="text-2xl font-semibold">{title}</h1>
      {children}
    </main>
  );
}
