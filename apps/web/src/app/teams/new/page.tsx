import type { Metadata } from 'next';
import { randomUUID } from 'node:crypto';
import { CreateTeamForm } from '../../../components/teams/create-team-form.tsx';
import { TeamShell } from '../../../components/teams/team-shell.tsx';
import { requireUser } from '../../../lib/auth/session.ts';

export const metadata: Metadata = { title: 'Create a team' };
export const dynamic = 'force-dynamic';

export default async function NewTeamPage() {
  await requireUser('/teams/new');
  return (
    <TeamShell>
      <h1 className="text-2xl font-semibold">Create a team</h1>
      <p className="text-base">You&apos;ll be the team&apos;s first admin.</p>
      {/* A new key per render: a retry of this form (same render) reuses it, a fresh visit gets a new one. */}
      <CreateTeamForm idempotencyKey={randomUUID()} />
    </TeamShell>
  );
}
