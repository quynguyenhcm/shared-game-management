import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  OAUTH_BINDING_MAX_BYTES,
  OAUTH_STATE_PATTERN,
  bindingMatchesState,
  constantTimeEqual,
  encodeOAuthBinding,
  parseOAuthBinding,
} from './oauth-binding.ts';

// Same construction as the API's `newToken()` (32 random bytes, base64url): the interop fixture.
const apiState = (): string => randomBytes(32).toString('base64url');
const b64 = (value: unknown): string => Buffer.from(JSON.stringify(value)).toString('base64url');

describe('sgm_oauth binding codec', () => {
  it('round-trips a state generated the way the API generates it', () => {
    const state = apiState();
    expect(state).toMatch(OAUTH_STATE_PATTERN);
    const parsed = parseOAuthBinding(
      encodeOAuthBinding(state, { returnTo: '/account', intent: 'link' }),
    );
    expect(parsed).toEqual({ ok: true, state, ctx: { returnTo: '/account', intent: 'link' } });
  });

  it('sanitises returnTo on encode and again on parse (an edited ctx cannot smuggle a redirect)', () => {
    const state = apiState();
    const encoded = encodeOAuthBinding(state, {
      returnTo: 'https://evil.example/',
      intent: 'signin',
    });
    expect(parseOAuthBinding(encoded)).toMatchObject({ ok: true, ctx: { returnTo: '/' } });
    const edited = `${state}.${b64({ v: 1, r: '//evil.example', i: 'signin' })}`;
    expect(parseOAuthBinding(edited)).toMatchObject({ ok: true, ctx: { returnTo: '/' } });
  });

  it('treats a missing or empty cookie as missing and an oversized one as oversized (before decoding)', () => {
    expect(parseOAuthBinding(undefined)).toEqual({ ok: false, reason: 'missing' });
    expect(parseOAuthBinding('')).toEqual({ ok: false, reason: 'missing' });
    const huge = `${apiState()}.${'A'.repeat(OAUTH_BINDING_MAX_BYTES)}`;
    expect(parseOAuthBinding(huge)).toEqual({ ok: false, reason: 'oversized' });
  });

  it('rejects malformed values: separators, bad state shape, bad base64url or JSON, unknown keys, bad intent or version', () => {
    const state = apiState();
    const good = b64({ v: 1, r: '/', i: 'signin' });
    const cases = [
      state, // no ctx
      `${state}.${good}.x`, // two dots
      `short.${good}`,
      `${state}.%%%`,
      `${state}.${Buffer.from('not json').toString('base64url')}`,
      `${state}.${b64({ v: 1, r: '/', i: 'signin', extra: 1 })}`,
      `${state}.${b64({ v: 1, r: '/', i: 'admin' })}`,
      `${state}.${b64({ v: 2, r: '/', i: 'signin' })}`,
      `${state}.${b64({ v: 1, r: 'x'.repeat(513), i: 'signin' })}`,
    ];
    for (const value of cases) {
      expect(parseOAuthBinding(value), value).toMatchObject({ ok: false, reason: 'malformed' });
    }
  });

  it('compares only the state component, in constant time, against a well-formed query state', () => {
    const state = apiState();
    const binding = parseOAuthBinding(
      encodeOAuthBinding(state, { returnTo: '/a', intent: 'signin' }),
    );
    expect(bindingMatchesState(binding, state)).toBe(true);
    expect(bindingMatchesState(binding, apiState())).toBe(false);
    expect(bindingMatchesState(binding, `${state}x`)).toBe(false);
    expect(bindingMatchesState(binding, null)).toBe(false);
    expect(bindingMatchesState({ ok: false, reason: 'missing' }, state)).toBe(false);
    // An edited ctx does not change the match: the state component is what is compared.
    const edited = parseOAuthBinding(`${state}.${b64({ v: 1, r: '/other', i: 'link' })}`);
    expect(bindingMatchesState(edited, state)).toBe(true);
    expect(constantTimeEqual('abc', 'abc')).toBe(true);
    expect(constantTimeEqual('abc', 'abd')).toBe(false);
    expect(constantTimeEqual('abc', 'abcd')).toBe(false);
  });

  it('refuses to encode a state that does not match the pattern', () => {
    expect(() => encodeOAuthBinding('nope', { intent: 'signin' })).toThrow(RangeError);
  });
});
