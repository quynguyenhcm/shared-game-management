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

/** Which OAuth providers are enabled; none when the API cannot say (the buttons arrive in Phase 5). */
export async function loadProviders(): Promise<EnabledProviders> {
  const result = await apiClient.providers({ incoming: await headers() });
  return result.ok ? result.data : { google: false, facebook: false };
}
