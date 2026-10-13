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
