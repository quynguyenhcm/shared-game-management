import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  teamDetail: vi.fn(),
  incomeExportPeriods: vi.fn(),
  warn: vi.fn(),
}));

vi.mock('next/headers', () => ({
  cookies: () => Promise.resolve({ get: () => undefined, set: () => undefined }),
  headers: () => Promise.resolve(new Headers()),
}));
vi.mock('next/navigation', () => ({
  redirect: (url: string) => {
    throw new Error(`REDIRECT:${url}`);
  },
  notFound: () => {
    throw new Error('NOT_FOUND');
  },
  RedirectType: { replace: 'replace' },
}));
vi.mock('../../../../../lib/auth/session.ts', () => ({
  requireUser: () => Promise.resolve({ id: 'user-1', role: 'PLAYER' }),
}));
vi.mock('../../../../../lib/auth/cookies.ts', () => ({
  readCookie: () => Promise.resolve('session-token'),
}));
vi.mock('../../../../../lib/log.ts', () => ({
  log: { info: vi.fn(), warn: mocks.warn, error: vi.fn() },
}));
vi.mock('../../../../../lib/api-client.ts', () => ({
  apiClient: { teamDetail: mocks.teamDetail, incomeExportPeriods: mocks.incomeExportPeriods },
}));

const page = await import('./page.tsx');
const ExportsPage = page.default;

/**
 * The "Income exports" manage area (tax-invoices-and-exports AC-ENTRY-2, AC-ERROR-3, 4; CR-3): the API decides access (a plain
 * MEMBER, another team's admin and a GLOBAL_ADMIN who is not this team's admin all get its 403, rendered as the no-access page
 * with none of the area), and a refused download lands here with its sentence and the entered values.
 */

const TEAM = '7f3c2b1a-1111-4222-8333-444455556666';
const ok = <T,>(data: T) => ({ ok: true as const, status: 200, data });
const fail = (status: number, code = 'internal_error') => ({
  ok: false as const,
  status,
  error: { code, message: 'x' },
});
const PERIODS = ok({
  today: '2027-06-20',
  firstPaidDate: '2027-01-15',
  financialYearsWithPayments: [2026],
  maxRows: 50_000,
  maxRangeDays: 2557,
});
/** The whole opening tag holding `marker`, so attribute order does not matter. */
const tagWith = (html: string, marker: string): string =>
  new RegExp(`<[a-z]+[^>]*${marker.replace(/[/.]/g, '\\$&')}[^>]*>`).exec(html)?.[0] ?? '';

const DETAIL = ok({
  team: { id: TEAM, name: 'Hōkio Badminton Club', memberCount: 12 },
  myStatus: 'APPROVED',
  myRole: 'TEAM_ADMIN',
});

async function render(
  query: Record<string, string | string[]> = {},
  results: { detail?: unknown; periods?: unknown } = {},
  teamId = TEAM,
): Promise<string> {
  mocks.teamDetail.mockResolvedValue(results.detail ?? DETAIL);
  mocks.incomeExportPeriods.mockResolvedValue(results.periods ?? PERIODS);
  const element = await ExportsPage({
    params: Promise.resolve({ teamId }),
    searchParams: Promise.resolve(query),
  });
  return renderToStaticMarkup(element);
}

beforeEach(() => {
  mocks.teamDetail.mockReset();
  mocks.incomeExportPeriods.mockReset();
  mocks.warn.mockReset();
});

describe('Income exports page: a team admin (AC-ENTRY-2)', () => {
  it('is noindex and dynamic; title, h1, the nav with Income exports current, the help and the form', async () => {
    expect(page.metadata).toMatchObject({ robots: { index: false } });
    expect(page.dynamic).toBe('force-dynamic');
    const html = await render();
    expect(mocks.incomeExportPeriods).toHaveBeenCalledWith(
      TEAM,
      expect.objectContaining({ session: 'session-token' }),
    );
    expect(html).toContain(
      '<title>Income exports – Hōkio Badminton Club – Shared Game Management</title>',
    );
    expect(html).toContain('Income exports for Hōkio Badminton Club</h1>');
    expect(/<a[^>]*aria-current="page"[^>]*>([^<]*)</.exec(html)?.[1]).toBe('Income exports');
    expect(html).toContain('What&#x27;s in the file');
    expect(html).toContain('Paid by');
    expect(html).toContain(`action="/teams/${TEAM}/manage/exports/income"`);
    expect(html).toContain('2027-28 (1 April 2027 to 31 March 2028) (not finished)');
    expect(html).not.toContain('role="alert"');
  });
});

describe('Income exports page: access', () => {
  it('a 403 (plain member, other team, global admin who is not a team admin) is the no-access page with none of the area', async () => {
    const html = await render({}, { periods: fail(403, 'forbidden') });
    expect(html).toContain('No access');
    expect(html).not.toContain('Income exports');
    expect(html).not.toContain('<form');
  });

  it('a dead session goes to session-expired; a malformed team id is not found; an API failure throws', async () => {
    await expect(render({}, { periods: fail(401, 'session_expired') })).rejects.toThrow(
      /REDIRECT:\/auth\/session-expired/,
    );
    await expect(render({}, {}, 'nope')).rejects.toThrow('NOT_FOUND');
    await expect(render({}, { periods: fail(500) })).rejects.toThrow();
  });
});

describe('Income exports page: a refused download lands here (AC-ERROR-3, 4, CR-3)', () => {
  it('too large asks for a shorter range (row or byte cap alike); busy asks to try again; both keep the entered values', async () => {
    const tooLarge = await render({
      period: 'gst',
      gst: '2m-odd/2027-03',
      format: 'csv',
      download_error: 'export_too_large',
    });
    expect(tooLarge).toContain('That export is too large to prepare. Choose a shorter range.');
    expect(tagWith(tooLarge, 'value="2m-odd/2027-03"')).toContain('selected=""');
    expect(tagWith(tooLarge, 'value="csv"')).toContain('checked=""');

    const busy = await render({ period: 'fy', year: '2026-27', download_error: 'export_busy' });
    expect(busy).toContain('Another export is being prepared. Try again in a moment.');
  });

  it('a 422 shows the field message next to the field with the values kept', async () => {
    const html = await render({
      period: 'custom',
      from: '2027-06-15',
      to: '2027-06-01',
      format: 'csv',
      download_error: 'validation_failed',
      field: 'to',
    });
    expect(html).toContain('The end date can&#x27;t be before the start date');
    expect(tagWith(html, 'name="to"')).toContain('aria-invalid="true"');
    expect(tagWith(html, 'name="from"')).toContain('value="2027-06-15"');
  });

  it('an unknown code renders no notice', async () => {
    expect(await render({ download_error: '<script>' })).not.toContain('role="alert"');
  });
});
