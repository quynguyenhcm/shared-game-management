import type { ReactNode } from 'react';

/**
 * The team-admin area shell. The area nav is rendered by each area page after its own guard passes (so
 * the no-access page shows none). Wider than `AuthCard`: lists need the room.
 */
export default function ManageLayout({ children }: { children: ReactNode }) {
  return <main className="mx-auto flex w-full max-w-3xl flex-col gap-8 px-4 py-8">{children}</main>;
}
