/**
 * Web environment, validated once at boot by `instrumentation.ts` (AC-VERIFY-7). Messages name the
 * variable and never its value. The API validates the variables it shares (`WEB_BASE_URL`,
 * `API_INTERNAL_SHARED_SECRET`) with the same rules in `apps/api/src/lib/config/config.ts`.
 */

export class WebConfigError extends Error {
  readonly issues: readonly string[];

  constructor(issues: readonly string[]) {
    super(issues.join('\n'));
    this.name = 'WebConfigError';
    this.issues = issues;
  }
}

export interface WebConfig {
  readonly nodeEnv: 'development' | 'test' | 'production';
  /** Server-side URL of the API, no trailing slash. */
  readonly apiInternalUrl: string;
  /** Public origin of the web app, no trailing slash. */
  readonly webBaseUrl: string;
  /** Shared with the API (`x-sgm-internal-auth`); `null` only outside production. */
  readonly internalAuthSecret: string | null;
  /** Reverse proxies in front of the web that append to `X-Forwarded-For`. */
  readonly trustedProxyHops: number;
}

const MIN_SECRET_LENGTH = 32;
const MAX_PROXY_HOPS = 5;
/** The throwaway secret shipped in `.env.example` and docker-compose; never acceptable in production. */
const DEV_PLACEHOLDER_INTERNAL_SECRET = 'dev-only-internal-secret-change-me-0123456789';
const LOCALHOST_HOSTS: ReadonlySet<string> = new Set(['localhost', '127.0.0.1']);

const issue = (variable: string, message: string): string =>
  `Invalid configuration: ${variable} — ${message}`;

/** Unset and empty (`VAR=`) are the same. */
function read(env: NodeJS.ProcessEnv, name: string): string | undefined {
  const value = env[name];
  return value === undefined || value === '' ? undefined : value;
}

/** An http(s) URL with no path, query, fragment or credentials; returns its origin. */
function parseOrigin(raw: string): URL | undefined {
  if (!URL.canParse(raw)) return undefined;
  const url = new URL(raw);
  const plain =
    /^https?:$/.test(url.protocol) &&
    url.pathname === '/' &&
    url.search === '' &&
    url.hash === '' &&
    url.username === '' &&
    url.password === '';
  return plain ? url : undefined;
}

/** Validates the environment and returns typed config, or throws `WebConfigError`. */
export function loadWebConfig(env: NodeJS.ProcessEnv = process.env): WebConfig {
  const issues: string[] = [];
  const nodeEnv =
    env.NODE_ENV === 'production' || env.NODE_ENV === 'test' ? env.NODE_ENV : 'development';
  const production = nodeEnv === 'production';

  const apiRaw = read(env, 'API_INTERNAL_URL') ?? 'http://localhost:4000';
  const apiUrl = parseOrigin(apiRaw);
  if (apiUrl === undefined)
    issues.push(issue('API_INTERNAL_URL', 'must be an http(s) URL with no path'));

  const baseRaw = read(env, 'WEB_BASE_URL') ?? (production ? undefined : 'http://localhost:3000');
  let baseUrl: URL | undefined;
  if (baseRaw === undefined) {
    issues.push(issue('WEB_BASE_URL', 'is required'));
  } else {
    baseUrl = parseOrigin(baseRaw);
    if (baseUrl === undefined) {
      issues.push(issue('WEB_BASE_URL', 'must be an http(s) URL with no path'));
    } else if (
      production &&
      baseUrl.protocol !== 'https:' &&
      !LOCALHOST_HOSTS.has(baseUrl.hostname)
    ) {
      issues.push(
        issue('WEB_BASE_URL', 'must use https in production unless the host is localhost'),
      );
    }
  }
  const baseIsLocalhost = baseUrl !== undefined && LOCALHOST_HOSTS.has(baseUrl.hostname);

  const secret = read(env, 'API_INTERNAL_SHARED_SECRET');
  if (secret === undefined) {
    if (production) issues.push(issue('API_INTERNAL_SHARED_SECRET', 'is required in production'));
  } else if (secret.length < MIN_SECRET_LENGTH) {
    issues.push(
      issue('API_INTERNAL_SHARED_SECRET', `must be at least ${MIN_SECRET_LENGTH} characters`),
    );
  } else if (production && secret === DEV_PLACEHOLDER_INTERNAL_SECRET) {
    issues.push(
      issue('API_INTERNAL_SHARED_SECRET', 'must not be the development placeholder in production'),
    );
  }

  const hopsRaw = read(env, 'WEB_TRUSTED_PROXY_HOPS');
  let hops = 0;
  if (hopsRaw === undefined) {
    if (production) issues.push(issue('WEB_TRUSTED_PROXY_HOPS', 'is required in production'));
  } else if (!/^[0-9]+$/.test(hopsRaw) || Number(hopsRaw) > MAX_PROXY_HOPS) {
    issues.push(issue('WEB_TRUSTED_PROXY_HOPS', `must be an integer from 0 to ${MAX_PROXY_HOPS}`));
  } else {
    hops = Number(hopsRaw);
    if (production && hops === 0 && !baseIsLocalhost) {
      issues.push(
        issue(
          'WEB_TRUSTED_PROXY_HOPS',
          'must be at least 1 unless WEB_BASE_URL is localhost in production',
        ),
      );
    }
  }

  if (issues.length > 0 || apiUrl === undefined || baseUrl === undefined) {
    throw new WebConfigError(issues);
  }
  return {
    nodeEnv,
    apiInternalUrl: apiUrl.origin,
    webBaseUrl: baseUrl.origin,
    internalAuthSecret: secret ?? null,
    trustedProxyHops: hops,
  };
}

/** Process-entry helper: prints every issue to stderr and exits 1 before the server takes traffic. */
export function loadWebConfigOrExit(env: NodeJS.ProcessEnv = process.env): WebConfig {
  try {
    return loadWebConfig(env);
  } catch (error) {
    const lines =
      error instanceof WebConfigError ? error.issues : ['Invalid configuration: unexpected error'];
    process.stderr.write(`${lines.join('\n')}\n`);
    process.exit(1);
  }
}
