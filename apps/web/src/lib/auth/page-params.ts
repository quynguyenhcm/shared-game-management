import { safeReturnTo } from '@sgm/shared';
import { headers } from 'next/headers';
import { apiClient } from '../api-client.ts';
import type { EnabledProviders } from './messages.ts';

export type SearchParams = Promise<Record<string, string | string[] | undefined>>;
export type ResolvedSearchParams = Record<string, string | string[] | undefined>;

/** The first value of a query parameter, or `undefined`. */
export function firstParam(params: ResolvedSearchParams, name: string): string | undefined {
  const value = params[name];
  return Array.isArray(value) ? value[0] : value;
}

/** A validated `returnTo` to carry through a page, or `undefined` when it is just `/`. */
export function carriedReturnTo(params: ResolvedSearchParams): string | undefined {
  const target = safeReturnTo(firstParam(params, 'returnTo'));
  return target === '/' ? undefined : target;
}

export interface ProviderStatus {
  providers: EnabledProviders;
  /** `GET /auth/providers` failed: the OAuth buttons are hidden and a hint says why (AC-ERROR-18). */
  unavailable: boolean;
}

/** Which OAuth providers are enabled; none, and `unavailable`, when the API cannot say. */
export async function loadProviderStatus(): Promise<ProviderStatus> {
  const result = await apiClient.providers({ incoming: await headers() });
  return result.ok
    ? { providers: result.data, unavailable: false }
    : { providers: { google: false, facebook: false }, unavailable: true };
}
