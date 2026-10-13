/**
 * The OAuth decision table (algorithm doc, Q3/Q4). Pure: the service gathers the facts with indexed lookups
 * and this file only decides, so each row S1-S5, C3-C5 and L0-L4 has one unit test. No row ever signs in or
 * links on an email match alone (3A'), and nothing here reads `email_verified_at` (rule R1/D1).
 */
import type { OAuthProviderName } from './providers/provider.ts';

export type OAuthRejection =
  'oauth_email_missing' | 'oauth_email_unverified' | 'oauth_account_exists';

/** Facts about one provider assertion `(P, S, E, V)` and what the database already holds. */
export interface AssertionFacts {
  readonly provider: OAuthProviderName;
  /** Owner of identity `(P, S)` if one exists. */
  readonly identityOwnerId: string | null;
  /** `E` after normalisation (S1-b); `null` when the provider shared none or it does not normalise. */
  readonly email: string | null;
  /** `V`: true only for Google with `email_verified=true`. */
  readonly emailVerified: boolean;
  /** `M`: the local user whose `users.email = E`, if any. */
  readonly emailOwnerId: string | null;
}

export type SignInDecision =
  | { readonly row: 'S1'; readonly kind: 'signed_in'; readonly userId: string }
  | { readonly row: 'S2' | 'S3' | 'S4'; readonly kind: 'rejected'; readonly code: OAuthRejection }
  | { readonly row: 'S5'; readonly kind: 'pending_signup' };

/** Intent `signin` (rows S1-S5). */
export function decideSignIn(facts: AssertionFacts): SignInDecision {
  if (facts.identityOwnerId !== null) {
    return { row: 'S1', kind: 'signed_in', userId: facts.identityOwnerId };
  }
  if (facts.email === null) return { row: 'S2', kind: 'rejected', code: 'oauth_email_missing' };
  if (facts.provider === 'GOOGLE' && !facts.emailVerified) {
    return { row: 'S3', kind: 'rejected', code: 'oauth_email_unverified' };
  }
  if (facts.emailOwnerId !== null) {
    return { row: 'S4', kind: 'rejected', code: 'oauth_account_exists' };
  }
  return { row: 'S5', kind: 'pending_signup' };
}

export type CompleteDecision =
  | { readonly row: 'C3'; readonly kind: 'signed_in'; readonly userId: string }
  | { readonly row: 'C4'; readonly kind: 'rejected'; readonly code: 'oauth_account_exists' }
  | { readonly row: 'C5'; readonly kind: 'create' };

/** Inside the completion transaction, after the pending row is consumed (rows C3-C5; C1/C2 are the service's). */
export function decideComplete(facts: {
  readonly identityOwnerId: string | null;
  readonly emailOwnerId: string | null;
}): CompleteDecision {
  if (facts.identityOwnerId !== null) {
    return { row: 'C3', kind: 'signed_in', userId: facts.identityOwnerId };
  }
  if (facts.emailOwnerId !== null) {
    return { row: 'C4', kind: 'rejected', code: 'oauth_account_exists' };
  }
  return { row: 'C5', kind: 'create' };
}

export interface LinkFacts {
  /** `oauth_states.link_user_id`. */
  readonly linkUserId: string;
  /** The live session presented at callback: its user, or `null` when none or dead. */
  readonly currentUserId: string | null;
  /** Owner of identity `(P, S)` if one exists. */
  readonly identityOwnerId: string | null;
  /** Whether the target user already has an identity for this provider. */
  readonly userHasProvider: boolean;
}

export type LinkDecision =
  | {
      readonly row: 'L0';
      readonly kind: 'rejected';
      readonly code: 'session_expired' | 'link_session_mismatch';
    }
  | { readonly row: 'L1'; readonly kind: 'already_linked' }
  | { readonly row: 'L2'; readonly kind: 'rejected'; readonly code: 'identity_in_use' }
  | { readonly row: 'L3'; readonly kind: 'rejected'; readonly code: 'provider_already_connected' }
  | { readonly row: 'L4'; readonly kind: 'link' };

/** Intent `link` (rows L0-L4). */
export function decideLink(facts: LinkFacts): LinkDecision {
  if (facts.currentUserId === null) return { row: 'L0', kind: 'rejected', code: 'session_expired' };
  if (facts.currentUserId !== facts.linkUserId) {
    return { row: 'L0', kind: 'rejected', code: 'link_session_mismatch' };
  }
  if (facts.identityOwnerId !== null) {
    return facts.identityOwnerId === facts.linkUserId
      ? { row: 'L1', kind: 'already_linked' }
      : { row: 'L2', kind: 'rejected', code: 'identity_in_use' };
  }
  if (facts.userHasProvider)
    return { row: 'L3', kind: 'rejected', code: 'provider_already_connected' };
  return { row: 'L4', kind: 'link' };
}
