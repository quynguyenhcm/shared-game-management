/**
 * Invariants the OAuth service relies on. The database (`oauth_states_link_user_iff_link`) and the decision
 * table (S2 ends a missing email before S4 and S5) already make these states unreachable; the guards turn a
 * future regression into a loud failure instead of an empty-string user id or email.
 */

/** The user a link-intent OAuth state belongs to. */
export function requireLinkUserId(state: {
  readonly intent: 'signin' | 'link';
  readonly linkUserId: string | null;
}): string {
  if (state.linkUserId === null) {
    throw new Error(`invariant violated: ${state.intent}-intent OAuth state without a user`);
  }
  return state.linkUserId;
}

/** The provider email at a decision row that is only reached with one (`row` names it in the message). */
export function requireProviderEmail(email: string | null, row: string): string {
  if (email === null) {
    throw new Error(`invariant violated: ${row} decided with no provider email`);
  }
  return email;
}
