import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  teamDetail: vi.fn(),
  teamBanking: vi.fn(),
  teamGst: vi.fn(),
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
vi.mock('next/cache', () => ({ revalidatePath: () => undefined }));
vi.mock('../../../../../lib/auth/session.ts', () => ({
  requireUser: () => Promise.resolve({ id: 'user-1' }),
}));
vi.mock('../../../../../lib/auth/cookies.ts', () => ({
  readCookie: () => Promise.resolve('session-token'),
}));
vi.mock('../../../../../lib/log.ts', () => ({
  log: { info: vi.fn(), warn: mocks.warn, error: vi.fn() },
}));
vi.mock('../../../../../lib/api-client.ts', () => ({
  apiClient: {
    teamDetail: mocks.teamDetail,
    teamBanking: mocks.teamBanking,
    teamGst: mocks.teamGst,
  },
}));

const page = await import('./page.tsx');
const BankingPage = page.default;

const TEAM_ID = '7f3c2b1a-1111-4222-8333-444455556666';
const OTHER_ID = '8a4d3c2b-2222-4333-8444-555566667777';
const RETURN_TO = `/teams/${TEAM_ID}/sessions/abc/edit`;

const ok = <T,>(data: T) => ({ ok: true as const, status: 200, data });
const fail = (status: number, code = 'internal_error') => ({
  ok: false as const,
  status,
  error: { code, message: 'x' },
});

const TEAM = ok({ team: { id: TEAM_ID, name: 'Rosedale Badminton', memberCount: 12 } });
const bankingBody = (over: Record<string, unknown> = {}) =>
  ok({
    banking: {
      isPayoutConfigured: false,
      payoutBlocked: false,
      accountName: null,
      unreadable: false,
      accountNumberLast4: null,
      lastChanged: null,
      ...over,
    },
  });
const SAVED = {
  isPayoutConfigured: true,
  accountName: 'Rosedale Badminton Club',
  accountNumberLast4: '8389',
  lastChanged: { at: '2026-10-16T01:00:00.000Z', by: { fullName: 'Aroha Ngata' } },
};
const GST_NONE = ok({ gst: { gstRegistered: false, gstNumber: null } });
const GST_ON = ok({ gst: { gstRegistered: true, gstNumber: '136410132' } });

async function render(
  query: Record<string, string> = {},
  results: { detail?: unknown; banking?: unknown; gst?: unknown } = {},
  teamId = TEAM_ID,
): Promise<string> {
  mocks.teamDetail.mockResolvedValue(results.detail ?? TEAM);
  mocks.teamBanking.mockResolvedValue(results.banking ?? bankingBody());
  mocks.teamGst.mockResolvedValue(results.gst ?? GST_NONE);
  const element = await BankingPage({
    params: Promise.resolve({ teamId }),
    searchParams: Promise.resolve(query),
  });
  return renderToStaticMarkup(element);
}

beforeEach(() => {
  mocks.teamDetail.mockReset();
  mocks.teamBanking.mockReset();
  mocks.teamGst.mockReset();
  mocks.warn.mockReset();
});

describe('banking page: shell (AC-ENTRY-1, AC-ENTRY-3, noindex, no-store)', () => {
  it('exports noindex metadata and force-dynamic', () => {
    expect(page.metadata).toMatchObject({ robots: { index: false } });
    expect(page.dynamic).toBe('force-dynamic');
  });

  it('sets the title and H1 from the team name, renders the nav with Banking and GST current, and both sections', async () => {
    const html = await render();
    expect(html).toContain(
      '<title>Banking and GST – Rosedale Badminton – Shared Game Management</title>',
    );
    expect(html).toContain('Banking and GST for Rosedale Badminton</h1>');
    expect(html.match(/aria-current="page"/g)).toHaveLength(1);
    expect(/<a[^>]*aria-current="page"[^>]*>([^<]*)</.exec(html)?.[1]).toBe('Banking and GST');
    expect(html).toContain('id="banking"');
    expect(html).toContain('id="gst"');
    expect(html).toContain(
      'Only team admins can see this page. We show only part of your account number.',
    );
  });

  it('has no My-teams hint and no Akahu or IRD wording anywhere (R1, R2, R6)', async () => {
    const html = await render();
    expect(html).not.toMatch(/akahu|merchant|token|\bird number \(optional\)/i);
  });
});

describe('banking page: states', () => {
  it('empty: "Not set up." status and both forms shown directly with a per-render changeKey', async () => {
    const html = await render();
    expect(html).toContain('<strong>Not set up.</strong>');
    expect(html).toContain(
      'Paid sessions can&#x27;t be published until you add your bank account details.',
    );
    expect(html).toContain('Save banking details');
    expect(html).toContain('Save GST settings');
    expect(html).toMatch(
      /name="changeKey"[^>]*value="[0-9a-f-]{36}"|value="[0-9a-f-]{36}"[^>]*name="changeKey"/,
    );
  });

  it('configured: "Set up. Paid sessions can be published.", summary, Change and Remove', async () => {
    const html = await render({}, { banking: bankingBody(SAVED), gst: GST_ON });
    expect(html).toContain('<strong>Set up.</strong>');
    expect(html).toContain('Paid sessions can be published.');
    expect(html).toContain('ending 8389');
    expect(html).toContain('Change banking details');
    expect(html).toContain('Remove banking details');
    expect(html).toContain('136-410-132');
    expect(html).toContain('Change GST settings');
    expect(html).not.toContain('Save banking details');
  });

  it('?edit=banking shows the banking form (GST stays a summary); ?edit=gst the reverse; an unknown value is ignored', async () => {
    const results = { banking: bankingBody(SAVED), gst: GST_ON };
    const editBanking = await render({ edit: 'banking' }, results);
    expect(editBanking).toContain('Save banking details');
    expect(editBanking).not.toContain('Save GST settings');
    const editGst = await render({ edit: 'gst' }, results);
    expect(editGst).toContain('Save GST settings');
    expect(editGst).not.toContain('Save banking details');
    const ignored = await render({ edit: 'everything' }, results);
    expect(ignored).not.toContain('Save banking details');
    expect(ignored).not.toContain('Save GST settings');
  });

  it('blocked payout (R3): "Needs attention" with the account ending and the fix instruction', async () => {
    const html = await render(
      {},
      { banking: bankingBody({ ...SAVED, isPayoutConfigured: false, payoutBlocked: true }) },
    );
    expect(html).toContain('<strong>Needs attention.</strong>');
    expect(html).toContain(
      'Payments to the account ending 8389 failed. Check the account number and save it again.',
    );
  });

  it('unreadable details (R7): "Needs attention" and a form where name and number are both required', async () => {
    const html = await render(
      {},
      { banking: bankingBody({ unreadable: true, accountNumberLast4: '8389' }) },
    );
    expect(html).toContain('<strong>Needs attention.</strong>');
    expect(html).toContain('couldn&#x27;t read your saved bank details');
    expect(html).toContain('Save banking details');
    expect(html).not.toContain('Leave blank to keep');
  });

  it('shows "Last changed by {name} on {date}" in the summary (R8)', async () => {
    const html = await render({}, { banking: bankingBody(SAVED) });
    expect(html).toContain('Last changed by Aroha Ngata on 16 Oct 2026');
  });
});

describe('banking page: notices and the returnTo hand-off (R6, ADR 0016)', () => {
  const results = { banking: bankingBody(SAVED) };

  it('banking_saved shows the banner and, with a valid same-team returnTo, a "Back to your session" link', async () => {
    const html = await render({ notice: 'banking_saved', returnTo: RETURN_TO }, results);
    expect(html).toContain('Banking details saved. Paid sessions can now be published.');
    const link = /<a[^>]*href="([^"]*)"[^>]*>Back to your session<\/a>/.exec(html);
    expect(link?.[1]).toBe(RETURN_TO);
  });

  it.each([
    ['https://evil.example/'],
    [`/teams/${OTHER_ID}/sessions/x`],
    [`/teams/${TEAM_ID}/manage/banking`],
    ['//evil.example'],
  ])('drops an invalid returnTo %s silently: no link, no error', async (returnTo) => {
    const html = await render({ notice: 'banking_saved', returnTo }, results);
    expect(html).toContain('Banking details saved.');
    expect(html).not.toContain('Back to your session');
    expect(html).not.toContain('evil.example');
  });

  it('no link without a returnTo, and none for notices other than banking_saved', async () => {
    expect(await render({ notice: 'banking_saved' }, results)).not.toContain(
      'Back to your session',
    );
    expect(await render({ notice: 'gst_saved', returnTo: RETURN_TO }, results)).not.toContain(
      'Back to your session',
    );
  });

  it('banking_account_changed names the new ending read from the fresh page load', async () => {
    const html = await render({ notice: 'banking_account_changed' }, results);
    expect(html).toContain('Banking details updated. Payments now go to the account ending 8389.');
  });

  it('an unknown notice code renders nothing', async () => {
    const html = await render({ notice: '<script>alert(1)</script>' }, results);
    // (React's own form-replay <script> is in the markup; the hostile text must not be.)
    expect(html).not.toContain('alert(1)');
    expect(html).not.toContain('role="status" tabindex="-1"');
  });

  it('carries the validated returnTo into the forms so it survives a validation error and the save redirect', async () => {
    const html = await render({ returnTo: RETURN_TO });
    expect(html).toMatch(
      new RegExp(
        `name="returnTo"[^>]*value="${RETURN_TO}"|value="${RETURN_TO}"[^>]*name="returnTo"`,
      ),
    );
  });
});

describe('banking page: guards', () => {
  it('rejects a non-UUID team id as not found before any API call', async () => {
    await expect(render({}, {}, '../x')).rejects.toThrow('NOT_FOUND');
    expect(mocks.teamBanking).not.toHaveBeenCalled();
  });

  it('401 redirects to session-expired, returning to this page with the edit mode and a valid returnTo (no notice)', async () => {
    await expect(
      render(
        { edit: 'banking', notice: 'banking_saved', returnTo: RETURN_TO },
        { banking: fail(401, 'unauthenticated') },
      ),
    ).rejects.toThrow(
      `REDIRECT:/auth/session-expired?returnTo=${encodeURIComponent(
        `/teams/${TEAM_ID}/manage/banking?edit=banking&returnTo=${encodeURIComponent(RETURN_TO)}`,
      )}`,
    );
  });

  it('403 renders NoAccess: no nav, no banking or GST content', async () => {
    const html = await render({}, { banking: fail(403, 'forbidden'), gst: fail(403, 'forbidden') });
    expect(html).toContain('You don&#x27;t have access to manage this team.');
    expect(html).not.toContain('<nav');
    expect(html).not.toContain('Save banking details');
    expect(html).not.toContain('id="banking"');
  });

  it('a 422 (malformed id) is not found', async () => {
    await expect(render({}, { banking: fail(422, 'validation_failed') })).rejects.toThrow(
      'NOT_FOUND',
    );
  });

  it('an API 5xx throws to the error page and logs the failure without any value', async () => {
    await expect(render({}, { gst: fail(503, 'service_unavailable') })).rejects.toThrow(
      /API is unavailable/,
    );
    expect(mocks.warn).toHaveBeenCalledWith(
      'web.teams.api_failure',
      expect.objectContaining({ action: 'banking_load', status: 503 }),
    );
  });
});
