import { apiClient } from '@/lib/api-client';

export const dynamic = 'force-dynamic';

export default async function HomePage() {
  const health = await apiClient.health();
  const label = health?.status === 'ok' ? 'API: ok' : 'API: unavailable';

  return (
    <main className="mx-auto flex max-w-xl flex-col gap-4 p-8">
      <h1 className="text-2xl font-semibold">Shared Game Management</h1>
      <p data-testid="api-status" className="rounded-md bg-slate-100 px-3 py-2 font-mono text-sm">
        {label}
      </p>
    </main>
  );
}
