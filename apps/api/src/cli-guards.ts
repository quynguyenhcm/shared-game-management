import type { Config } from './lib/config/config.ts';

/** Hosts `db reset` may target without `--force`. A leading `/` is a local Unix-socket directory. */
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]', 'postgres']);

const isLocalHost = (host: string): boolean => LOCAL_HOSTS.has(host) || host.startsWith('/');

/** Every host the pg driver may connect to: the URL host plus any `?host=` override. */
function targetHosts(databaseUrl: string): string[] {
  const url = new URL(databaseUrl);
  const overrides = url.searchParams.getAll('host').flatMap((value) => value.split(','));
  return [url.hostname, ...overrides].map((host) => host.trim()).filter((host) => host !== '');
}

/** Why `db rollback` must not run, or `undefined` when it may. Down migrations drop data. */
export function rollbackRefusal(config: Pick<Config, 'nodeEnv'>): string | undefined {
  return config.nodeEnv === 'production'
    ? 'db rollback is refused when NODE_ENV=production'
    : undefined;
}

/** Why `db reset` must not run, or `undefined` when it may. */
export function resetRefusal(
  config: Pick<Config, 'nodeEnv' | 'databaseUrl'>,
  flags: readonly string[],
): string | undefined {
  if (config.nodeEnv === 'production') return 'db reset is refused when NODE_ENV=production';
  if (flags.includes('--force')) return undefined;
  const remote = targetHosts(config.databaseUrl).find((host) => !isLocalHost(host));
  return remote === undefined
    ? undefined
    : `db reset is refused for non-local host "${remote}" without --force`;
}
