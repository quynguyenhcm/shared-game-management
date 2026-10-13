import { AssignableGlobalRole, normaliseEmail } from '@sgm/shared';
import type { Config } from './lib/config/config.ts';

export type SetRoleArgs =
  { readonly email: string; readonly role: AssignableGlobalRole } | { readonly error: string };

/**
 * Validates `users set-role <email> <GLOBAL_ADMIN|PLAYER>` before any database access. `TEAM_ADMIN` is a
 * per-team role (derived from `team_members`) and is never a global role, so it is refused by name.
 */
export function parseSetRoleArgs(args: readonly string[]): SetRoleArgs {
  const [rawEmail, rawRole, ...extra] = args;
  const usage = 'Usage: users set-role <email> <GLOBAL_ADMIN|PLAYER>';
  if (rawEmail === undefined || rawRole === undefined || extra.length > 0) return { error: usage };
  if (rawRole === 'TEAM_ADMIN') {
    return {
      error:
        'TEAM_ADMIN is a per-team role (team_members) and cannot be assigned globally. Use GLOBAL_ADMIN or PLAYER.',
    };
  }
  const role = AssignableGlobalRole.find((candidate) => candidate === rawRole);
  if (role === undefined) return { error: `Unknown role "${rawRole}". ${usage}` };
  const email = normaliseEmail(rawEmail);
  if (email === null) return { error: `"${rawEmail}" is not a valid email address.` };
  return { email, role };
}

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
