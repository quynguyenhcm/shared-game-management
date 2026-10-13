import { describe, expect, it } from 'vitest';
import { decideComplete, decideLink, decideSignIn, type AssertionFacts } from './oauth-decision.ts';

const base: AssertionFacts = {
  provider: 'FACEBOOK',
  identityOwnerId: null,
  email: 'aroha@example.com',
  emailVerified: false,
  emailOwnerId: null,
};

describe('OAuth decision table: sign-in (S1-S5)', () => {
  it('S1: a known identity signs in as its owner, whatever the email says', () => {
    expect(
      decideSignIn({ ...base, identityOwnerId: 'u1', email: null, emailOwnerId: 'u2' }),
    ).toEqual({
      row: 'S1',
      kind: 'signed_in',
      userId: 'u1',
    });
  });
  it('S2: no email is blocked (Facebook and Google)', () => {
    for (const provider of ['FACEBOOK', 'GOOGLE'] as const) {
      expect(decideSignIn({ ...base, provider, email: null, emailVerified: true })).toMatchObject({
        row: 'S2',
        code: 'oauth_email_missing',
      });
    }
  });
  it('S3: an unverified Google email is blocked before the conflict check', () => {
    expect(
      decideSignIn({ ...base, provider: 'GOOGLE', emailVerified: false, emailOwnerId: 'u9' }),
    ).toMatchObject({ row: 'S3', code: 'oauth_email_unverified' });
  });
  it('S4: an email owned by another account never signs in or links (Facebook, and verified Google)', () => {
    expect(decideSignIn({ ...base, emailOwnerId: 'u9' })).toMatchObject({
      row: 'S4',
      code: 'oauth_account_exists',
    });
    expect(
      decideSignIn({ ...base, provider: 'GOOGLE', emailVerified: true, emailOwnerId: 'u9' }),
    ).toMatchObject({ row: 'S4', code: 'oauth_account_exists' });
  });
  it('S5: a new email creates a pending sign-up (Facebook, and verified Google)', () => {
    expect(decideSignIn(base)).toEqual({ row: 'S5', kind: 'pending_signup' });
    expect(decideSignIn({ ...base, provider: 'GOOGLE', emailVerified: true })).toEqual({
      row: 'S5',
      kind: 'pending_signup',
    });
  });
});

describe('OAuth decision table: completion (C3-C5)', () => {
  it('C3: the identity now exists (second tab finished first): sign in as its owner', () => {
    expect(decideComplete({ identityOwnerId: 'u1', emailOwnerId: null })).toEqual({
      row: 'C3',
      kind: 'signed_in',
      userId: 'u1',
    });
  });
  it('C4: the email now belongs to someone else: conflict', () => {
    expect(decideComplete({ identityOwnerId: null, emailOwnerId: 'u2' })).toMatchObject({
      row: 'C4',
      code: 'oauth_account_exists',
    });
  });
  it('C5: otherwise create the user', () => {
    expect(decideComplete({ identityOwnerId: null, emailOwnerId: null })).toEqual({
      row: 'C5',
      kind: 'create',
    });
  });
});

describe('OAuth decision table: link (L0-L4)', () => {
  const link = {
    linkUserId: 'u1',
    currentUserId: 'u1',
    identityOwnerId: null,
    userHasProvider: false,
  };
  it('L0: a dead session is session_expired; another user is link_session_mismatch', () => {
    expect(decideLink({ ...link, currentUserId: null })).toMatchObject({
      row: 'L0',
      code: 'session_expired',
    });
    expect(decideLink({ ...link, currentUserId: 'u2' })).toMatchObject({
      row: 'L0',
      code: 'link_session_mismatch',
    });
  });
  it('L1: the identity already belongs to this user: no-op', () => {
    expect(decideLink({ ...link, identityOwnerId: 'u1', userHasProvider: true })).toEqual({
      row: 'L1',
      kind: 'already_linked',
    });
  });
  it('L2: the identity belongs to another user: identity_in_use', () => {
    expect(decideLink({ ...link, identityOwnerId: 'u2' })).toMatchObject({
      row: 'L2',
      code: 'identity_in_use',
    });
  });
  it('L3: the user already has this provider with another subject: provider_already_connected', () => {
    expect(decideLink({ ...link, userHasProvider: true })).toMatchObject({
      row: 'L3',
      code: 'provider_already_connected',
    });
  });
  it('L4: otherwise link', () => {
    expect(decideLink(link)).toEqual({ row: 'L4', kind: 'link' });
  });
});
