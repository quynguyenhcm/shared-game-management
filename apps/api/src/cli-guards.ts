import { AssignableGlobalRole, normaliseEmail } from '@sgm/shared';
import type { Config } from './lib/config/config.ts';
import { RecurrenceRulePayload, recurrenceRuleKey } from './jobs/recurrence-rule.ts';
import { SessionAutoEnrolPayload, sessionAutoEnrolKey } from './jobs/session-auto-enrol.ts';
import { MemberBannedPayload, memberBannedSingletonKey } from './modules/teams/ban-hook.ts';

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

export type MemberBannedTrigger =
  | { readonly payload: MemberBannedPayload; readonly singletonKey: string }
  | { readonly error: string };

/**
 * Validates the JSON of `jobs trigger member-banned '<json>'` (Architecture A12, the operator's re-run path for a
 * failed ban job) with the same strict schema the job handler uses, so a typo can never enqueue a job that only
 * fails later. The job is keyed like the one the ban enqueues; the handler re-reads the membership, so a hand-typed
 * payload for a membership that is not BANNED fails without effect.
 */
export function parseMemberBannedTrigger(raw: string | undefined): MemberBannedTrigger {
  const usage =
    'Usage: jobs trigger member-banned \'{"teamId":…,"userId":…,"membershipId":…,"bannedBy":…,"bannedAt":…}\'';
  if (raw === undefined) return { error: usage };
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    return { error: `The payload is not valid JSON. ${usage}` };
  }
  const parsed = MemberBannedPayload.safeParse(json);
  if (!parsed.success) {
    // Field paths only: the input is not echoed.
    const fields = [
      ...new Set(parsed.error.issues.map((issue) => issue.path.join('.') || '(root)')),
    ];
    return { error: `Invalid member-banned payload (${fields.join(', ')}). ${usage}` };
  }
  return {
    payload: parsed.data,
    singletonKey: memberBannedSingletonKey(parsed.data.membershipId),
  };
}

export type SessionJobTrigger<T> =
  { readonly payload: T; readonly singletonKey: string } | { readonly error: string };

function parseKeyed<T>(
  raw: string | undefined,
  schema: {
    safeParse(
      input: unknown,
    ):
      | { success: true; data: T }
      | { success: false; error: { issues: readonly { path: readonly PropertyKey[] }[] } };
  },
  keyOf: (payload: T) => string,
  name: string,
  usage: string,
): SessionJobTrigger<T> {
  if (raw === undefined) return { error: usage };
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    return { error: `The payload is not valid JSON. ${usage}` };
  }
  const parsed = schema.safeParse(json);
  if (!parsed.success) {
    // Field paths only: the input is not echoed.
    const fields = [
      ...new Set(parsed.error.issues.map((issue) => issue.path.map(String).join('.') || '(root)')),
    ];
    return { error: `Invalid ${name} payload (${fields.join(', ')}). ${usage}` };
  }
  return { payload: parsed.data, singletonKey: keyOf(parsed.data) };
}

/**
 * Validates `jobs trigger recurrence-rule '<json>'` (re-run one series' materialisation) with the handler's own strict schema, and
 * keys the job like the ones series create and edit enqueue, so a hand-typed trigger and a queued run collapse into one.
 */
export function parseRecurrenceRuleTrigger(
  raw: string | undefined,
): SessionJobTrigger<RecurrenceRulePayload> {
  return parseKeyed(
    raw,
    RecurrenceRulePayload,
    (payload) => recurrenceRuleKey(payload.ruleId),
    'recurrence-rule',
    'Usage: jobs trigger recurrence-rule \'{"ruleId":…,"teamId":…,"trigger":"manual"}\'',
  );
}

/** Validates `jobs trigger session-auto-enrol '<json>'` (re-offer one session's auto-enrol), keyed like a publish's job. */
export function parseSessionAutoEnrolTrigger(
  raw: string | undefined,
): SessionJobTrigger<SessionAutoEnrolPayload> {
  return parseKeyed(
    raw,
    SessionAutoEnrolPayload,
    (payload) => sessionAutoEnrolKey(payload.sessionId),
    'session-auto-enrol',
    'Usage: jobs trigger session-auto-enrol \'{"sessionId":…,"teamId":…,"trigger":"manual"}\'',
  );
}
