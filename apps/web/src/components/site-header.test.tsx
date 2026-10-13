import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

const nav = vi.hoisted(() => ({ pathname: '/', search: '' }));

vi.mock('next/navigation', () => ({
  usePathname: () => nav.pathname,
  useSearchParams: () => new URLSearchParams(nav.search),
  redirect: () => undefined,
  RedirectType: { replace: 'replace' },
}));
vi.mock('next/headers', () => ({
  cookies: () => Promise.resolve({ get: () => undefined, set: () => undefined }),
  headers: () => Promise.resolve(new Headers()),
}));

const { SiteHeaderLinks, headerReturnTo } = await import('./site-header-links.tsx');

function render(state: Parameters<typeof SiteHeaderLinks>[0]['state'], path = '/', search = '') {
  nav.pathname = path;
  nav.search = search;
  return renderToStaticMarkup(<SiteHeaderLinks state={state} />);
}

describe('headerReturnTo (AC-ENTRY-1)', () => {
  it('is empty on / and carries the current path and query on ordinary pages', () => {
    expect(headerReturnTo('/', new URLSearchParams())).toBeNull();
    expect(headerReturnTo('/teams/7', new URLSearchParams('tab=games'))).toBe('/teams/7?tab=games');
  });

  it('carries the existing returnTo on auth pages and drops notice and error codes', () => {
    expect(
      headerReturnTo('/login', new URLSearchParams('returnTo=%2Faccount&notice=signed_out')),
    ).toBe('/account');
    expect(headerReturnTo('/register', new URLSearchParams())).toBeNull();
    expect(
      headerReturnTo('/login', new URLSearchParams('returnTo=https%3A%2F%2Fevil.example')),
    ).toBeNull();
    expect(
      headerReturnTo('/account', new URLSearchParams('notice=linked&provider=google&x=1')),
    ).toBe('/account?x=1');
  });
});

describe('SiteHeader states', () => {
  it('anonymous: brand, Sign in and Create account with no returnTo on /', () => {
    const html = render({ kind: 'anonymous' });
    expect(html).toContain('Shared Game Management');
    expect(html).toMatch(/<a[^>]*href="\/login"[^>]*>Sign in<\/a>/);
    expect(html).toMatch(/<a[^>]*href="\/register"[^>]*>Create account<\/a>/);
    expect(html).not.toContain('Sign out');
  });

  it('anonymous on a login redirect: both links carry returnTo (AC-ENTRY-1)', () => {
    const html = render({ kind: 'anonymous' }, '/login', 'returnTo=%2Faccount');
    expect(html).toContain('href="/register?returnTo=%2Faccount"');
    expect(html).toContain('href="/login?returnTo=%2Faccount"');
    expect(html).toMatch(/aria-current="page"[^>]*>Sign in/);
  });

  it('signed in: "Signed in as", Account link and Sign out button, no Sign in', () => {
    const html = render({ kind: 'signed_in', fullName: 'Aroha Ngata' }, '/account');
    expect(html).toContain('Signed in as Aroha Ngata');
    expect(html).toMatch(/<a[^>]*href="\/account"[^>]*>Account<\/a>/);
    expect(html).toMatch(/<button[^>]*>Sign out<\/button>/);
    expect(html).not.toContain('Sign in<');
    expect(html).not.toContain('Create account');
  });

  it('API unreachable with a cookie: brand and Account only, never Sign in (AC-ERROR-18)', () => {
    const html = render({ kind: 'unavailable' });
    expect(html).toContain('Shared Game Management');
    expect(html).toMatch(/>Account<\/a>/);
    expect(html).not.toContain('Sign in');
    expect(html).not.toContain('Create account');
  });
});

describe('SiteHeader team links (AC-ENTRY-1)', () => {
  it('anonymous: "Find a team" is a link to /teams/find and there is no "My teams"', () => {
    const html = render({ kind: 'anonymous' });
    expect(html).toMatch(/<a[^>]*href="\/teams\/find"[^>]*>Find a team<\/a>/);
    expect(html).not.toContain('My teams');
  });

  it('signed in: Find a team, My teams and Account, in tab order before the signed-in text and Sign out', () => {
    const html = render({ kind: 'signed_in', fullName: 'Aroha Ngata' });
    expect(html).toMatch(/<a[^>]*href="\/teams\/find"[^>]*>Find a team<\/a>/);
    expect(html).toMatch(/<a[^>]*href="\/teams"[^>]*>My teams<\/a>/);
    const order = ['Find a team', 'My teams', 'Account', 'Signed in as', 'Sign out'].map((text) =>
      html.indexOf(text),
    );
    expect(order.every((index) => index >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
  });

  it('unavailable: keeps Find a team (a public page) but not My teams', () => {
    const html = render({ kind: 'unavailable' });
    expect(html).toMatch(/<a[^>]*href="\/teams\/find"[^>]*>Find a team<\/a>/);
    expect(html).not.toContain('My teams');
  });

  it('marks only the exact current page with aria-current', () => {
    const onFind = render({ kind: 'signed_in', fullName: 'A' }, '/teams/find');
    expect(onFind).toMatch(/aria-current="page"[^>]*>Find a team</);
    expect(onFind).not.toMatch(/aria-current="page"[^>]*>My teams</);
    const onMine = render({ kind: 'signed_in', fullName: 'A' }, '/teams');
    expect(onMine).toMatch(/aria-current="page"[^>]*>My teams</);
    expect(onMine).not.toMatch(/aria-current="page"[^>]*>Find a team</);
  });

  it('keeps 44 px tap targets and a wrapping layout so 360 px never scrolls sideways', () => {
    for (const state of [
      { kind: 'anonymous' },
      { kind: 'signed_in', fullName: 'Aroha Ngata' },
      { kind: 'unavailable' },
    ] as const) {
      const html = render(state);
      expect(html).toContain('flex-wrap');
      expect(html).toMatch(/<a[^>]*class="[^"]*min-h-11[^"]*"[^>]*>Find a team<\/a>/);
    }
    const signedIn = render({ kind: 'signed_in', fullName: 'A very long name '.repeat(5) });
    expect(signedIn).toContain('truncate');
    expect(signedIn).toMatch(/<a[^>]*class="[^"]*min-h-11[^"]*"[^>]*>My teams<\/a>/);
  });
});
