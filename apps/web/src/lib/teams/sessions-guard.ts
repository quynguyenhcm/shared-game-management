import { RedirectType, notFound, redirect } from 'next/navigation';
import type { ApiResult } from '../api-client.ts';
import { sessionExpiredUrl } from '../auth/landing.ts';
import { log } from '../log.ts';

type Failure = Extract<ApiResult<unknown>, { ok: false }>;

/**
 * The guard every Sessions page runs after its parallel load, the same order as the banking page: any 401
 * redirects to sign-in (returning to `here`), any 403 is the no-access page (the API answers a non-admin, an
 * unknown team and another team's session or series id alike, so nothing is revealed), a 404 or 422 is "not found" (an unknown id or
 * a malformed one), and any other failure throws to the error page and logs the status and code only. `optional`
 * results (a read the page can do without) can still sign the user out or revoke access, but a 5xx from one is
 * not fatal.
 */
export function guardResults(
  required: readonly ApiResult<unknown>[],
  input: { here: string; action: string; optional?: readonly ApiResult<unknown>[] },
): 'ok' | 'no_access' {
  const failures = (results: readonly ApiResult<unknown>[]): Failure[] =>
    results.filter((result): result is Failure => !result.ok);
  const required_ = failures(required);
  const all = [...required_, ...failures(input.optional ?? [])];
  if (all.some((result) => result.status === 401)) {
    return redirect(sessionExpiredUrl(input.here), RedirectType.replace);
  }
  if (all.some((result) => result.status === 403)) return 'no_access';
  if (required_.some((result) => result.status === 404 || result.status === 422)) notFound();
  const failed = required_[0];
  if (failed !== undefined) {
    log.warn('web.teams.api_failure', {
      action: input.action,
      status: failed.status,
      code: failed.error.code,
    });
    throw new Error('The sessions page could not be loaded because the API is unavailable.');
  }
  return 'ok';
}
