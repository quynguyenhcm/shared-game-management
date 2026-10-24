import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  RULE_ID,
  SESSION_ID,
  TEAM_ID,
  sessionFixture,
} from '../../../../../../lib/teams/sessions-fixtures.ts';

const mocks = vi.hoisted(() => ({
  teamDetail: vi.fn(),
  getSession: vi.fn(),
  teamBanking: vi.fn(),
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
  useRouter: () => ({ refresh: () => undefined }),
}));
vi.mock('next/cache', () => ({ revalidatePath: () => undefined }));
vi.mock('../../../../../../lib/auth/session.ts', () => ({
  requireUser: () => Promise.resolve({ id: 'user-1' }),
}));
vi.mock('../../../../../../lib/auth/cookies.ts', () => ({
  readCookie: () => Promise.resolve('session-token'),
}));
vi.mock('../../../../../../lib/log.ts', () => ({
  log: { info: vi.fn(), warn: mocks.warn, error: vi.fn() },
}));
vi.mock('../../../../../../lib/api-client.ts', () => ({
  apiClient: {
    teamDetail: mocks.teamDetail,
    getSession: mocks.getSession,
    teamBanking: mocks.teamBanking,
  },
}));

const page = await import('./page.tsx');
const SessionPage = page.default;

const ok = <T,>(data: T) => ({ ok: true as const, status: 200, data });
const fail = (status: number, code = 'internal_error') => ({
  ok: false as const,
  status,
  error: { code, message: 'x' },
});
const TEAM = ok({ team: { id: TEAM_ID, name: 'Rosedale Badminton', memberCount: 12 } });
const banking = (isPayoutConfigured: boolean) =>
  ok({
    banking: {
      isPayoutConfigured,
      payoutBlocked: false,
      accountName: null,
      unreadable: false,
      accountNumberLast4: null,
      lastChanged: null,
    },
  });
const detail = (overrides = {}) => ok({ session: sessionFixture(overrides) });

const SESSION_URL = `/teams/${TEAM_ID}/manage/sessions/${SESSION_ID}`;

async function render(
  query: Record<string, string> = {},
  results: { detail?: unknown; session?: unknown; banking?: unknown } = {},
  ids: { teamId?: string; sessionId?: string } = {},
): Promise<string> {
  mocks.teamDetail.mockResolvedValue(results.detail ?? TEAM);
  mocks.getSession.mockResolvedValue(results.session ?? detail());
  mocks.teamBanking.mockResolvedValue(results.banking ?? banking(true));
  const element = await SessionPage({
    params: Promise.resolve({
      teamId: ids.teamId ?? TEAM_ID,
      sessionId: ids.sessionId ?? SESSION_ID,
    }),
    searchParams: Promise.resolve(query),
  });
  return renderToStaticMarkup(element);
}

beforeEach(() => {
  mocks.teamDetail.mockReset();
  mocks.getSession.mockReset();
  mocks.teamBanking.mockReset();
  mocks.warn.mockReset();
});

describe('session page: a draft one-off session (E1)', () => {
  it('exports noindex and force-dynamic; the title and H1 are the location and date', async () => {
    expect(page.metadata).toMatchObject({ robots: { index: false } });
    expect(page.dynamic).toBe('force-dynamic');
    const html = await render();
    expect(html).toContain(
      '<title>Rosedale, Wed 4 Nov 2026 – Rosedale Badminton – Shared Game Management</title>',
    );
    expect(html).toContain('Rosedale, Wed 4 Nov 2026</h1>');
    expect(html.match(/aria-current="page"/g)).toHaveLength(1);
    expect(/<a[^>]*aria-current="page"[^>]*>([^<]*)</.exec(html)?.[1]).toBe('Sessions');
  });

  it('puts the scope line first after the H1, then the status line, then the form, then the cancel control', async () => {
    const html = await render();
    const scope = html.indexOf(
      'One-off session. When you publish it, members on Auto Enroll are added to it.',
    );
    const status = html.indexOf('Draft. Members can&#x27;t see it until you publish it.');
    const form = html.indexOf('<form');
    const cancel = html.indexOf('>Cancel session<');
    expect(html.indexOf('</h1>')).toBeLessThan(scope);
    expect(scope).toBeLessThan(status);
    expect(status).toBeLessThan(form);
    expect(form).toBeLessThan(cancel);
    expect(html).toContain('>Save draft<');
    expect(html).toContain('>Save and publish<');
  });

  it('a banking draft with banking missing says why and links to banking with this session as returnTo (AC-HAPPY-14)', async () => {
    const html = await render(
      {},
      { session: detail({ draftReason: 'banking' }), banking: banking(false) },
    );
    expect(html).toContain(
      'This session wasn&#x27;t published because your team&#x27;s bank account isn&#x27;t set up.',
    );
    const link = /<a[^>]*href="([^"]*banking[^"]*)"[^>]*>Set up banking and GST<\/a>/.exec(
      html,
    )?.[1];
    expect(link).toBe(
      `/teams/${TEAM_ID}/manage/banking?returnTo=${encodeURIComponent(SESSION_URL)}`,
    );
  });

  it('once banking is set up the draft says it will publish overnight or can be published now', async () => {
    const html = await render({}, { session: detail({ draftReason: 'banking' }) });
    expect(html).toContain(
      'This session is still a draft. It will be published overnight, or you can publish it now.',
    );
  });

  it('shows the banner for a notice and the just-published wording for ?notice=published', async () => {
    const banner = await render({ notice: 'draft_saved' });
    expect(banner).toContain('Draft saved.');
    const published = await render(
      { notice: 'published' },
      { session: detail({ status: 'PUBLISHED', draftReason: null }) },
    );
    expect(published).toContain('Session published. Members can now register.');
    expect(published).toContain(
      'Published. Members can register. Members on Auto Enroll are being added.',
    );
  });

  it('the banking refusal notice links back through banking to this session', async () => {
    const html = await render({ notice: 'publish_refused_banking' }, { banking: banking(false) });
    expect(html).toContain(
      'Add your team&#x27;s bank account details before publishing a paid session.',
    );
    expect(html).toContain('Your changes are saved as a draft.');
    expect(html).toContain(encodeURIComponent(SESSION_URL));
  });
});

describe('session page: a published session (E2)', () => {
  const published = (over = {}) =>
    detail({ status: 'PUBLISHED', draftReason: null, activeRegistrationCount: 12, ...over });

  it('shows the registered count, the "let them know" change notice and Save changes', async () => {
    const html = await render({}, { session: published() });
    expect(html).toContain('Published. Members can register.');
    expect(html).toContain('12 players are registered.');
    expect(html).toContain(
      '12 players are registered. We don&#x27;t email them about changes, so let them know if you change the date, times, place, cancellation deadline or fees.',
    );
    expect(html).toContain('>Save changes<');
    expect(html).not.toContain('>Save draft<');
  });

  it('with no registrations it says no one has registered and has no change notice', async () => {
    const html = await render({}, { session: published({ activeRegistrationCount: 0 }) });
    expect(html).toContain('No one has registered yet.');
    expect(html).not.toContain('We don&#x27;t email them');
  });
});

describe('session page: one date of a series', () => {
  it('has a back link to the series, the instance scope line, and marks Edited once overridden', async () => {
    const series = { recurringRuleId: RULE_ID, seriesName: 'Wednesdays at Rosedale' };
    const unedited = await render({}, { session: detail(series) });
    expect(unedited).toMatch(
      new RegExp(
        `<a[^>]*href="/teams/${TEAM_ID}/manage/sessions/series/${RULE_ID}"[^>]*>‹ Back to Wednesdays at Rosedale</a>`,
      ),
    );
    expect(unedited).toContain(
      'One date in Wednesdays at Rosedale. Changes here apply to Wed 4 Nov only. Once you save a change, this date is marked Edited and changes to the series won&#x27;t overwrite it.',
    );
    const edited = await render(
      {},
      { session: detail({ ...series, isInstanceOverridden: true, draftReason: 'edited' }) },
    );
    expect(edited).toContain(
      'Edited. This date has its own details, so changes to Wednesdays at Rosedale don&#x27;t apply to it.',
    );
    expect(edited).toContain(
      'This date has been edited, so it won&#x27;t be published automatically. Publish it when it&#x27;s ready.',
    );
  });
});

describe('session page: read-only sessions (E3, AC-ERROR-11)', () => {
  it.each([
    [
      { status: 'PUBLISHED', phase: 'started', draftReason: null },
      'This session has started, so it can&#x27;t be changed or cancelled.',
    ],
    [
      { status: 'PUBLISHED', phase: 'ended', draftReason: null },
      'This session has ended, so it can&#x27;t be changed.',
    ],
    [
      { status: 'CANCELLED', draftReason: null },
      'This session was cancelled, so it can&#x27;t be changed.',
    ],
    [
      { status: 'COMPLETED', phase: 'ended', draftReason: null },
      'This session is complete, so it can&#x27;t be changed.',
    ],
    [
      { status: 'DRAFT', phase: 'ended' },
      'This draft&#x27;s start time passed before it was published, so it can&#x27;t be published or changed.',
    ],
  ])(
    '%j shows a summary with the reason and no form, save, publish or cancel',
    async (over, reason) => {
      const html = await render({}, { session: detail(over) });
      expect(html).toContain(reason);
      expect(html).toContain('<dl');
      expect(html).toContain('<table');
      expect(html).not.toContain('<form');
      expect(html).not.toContain('Save changes');
      expect(html).not.toContain('Save and publish');
      expect(html).not.toContain('Cancel session');
      expect(html).toContain('‹ Back to Sessions');
    },
  );

  it('a series date also links back to its series', async () => {
    const html = await render(
      {},
      {
        session: detail({
          status: 'CANCELLED',
          draftReason: null,
          recurringRuleId: RULE_ID,
          seriesName: 'Wednesdays at Rosedale',
        }),
      },
    );
    expect(html).toContain('‹ Back to Wednesdays at Rosedale');
  });

  it('a cancelled notice states the registered count so the admin can tell the players (P-2)', async () => {
    const html = await render(
      { notice: 'cancelled', registered: '12' },
      { session: detail({ status: 'CANCELLED', draftReason: null }) },
    );
    expect(html).toContain('Session cancelled.');
    expect(html).toContain('12 players were registered. Let them know it&#x27;s cancelled.');
  });

  it('a stale or started notice on the reloaded page is an error alert', async () => {
    const html = await render(
      { notice: 'session_started' },
      { session: detail({ phase: 'started', status: 'PUBLISHED', draftReason: null }) },
    );
    expect(html).toContain('role="alert"');
  });
});

describe('session page: guards (AC-ERROR-8)', () => {
  it('rejects non-UUID ids as not found before any API call', async () => {
    await expect(render({}, {}, { teamId: '../x' })).rejects.toThrow('NOT_FOUND');
    await expect(render({}, {}, { sessionId: 'new-ish' })).rejects.toThrow('NOT_FOUND');
    expect(mocks.getSession).not.toHaveBeenCalled();
  });

  it('401 redirects to session-expired, returning to this session', async () => {
    await expect(
      render({ notice: 'published' }, { session: fail(401, 'unauthenticated') }),
    ).rejects.toThrow(`REDIRECT:/auth/session-expired?returnTo=${encodeURIComponent(SESSION_URL)}`);
  });

  it('403 renders NoAccess: no nav and no session content', async () => {
    const html = await render(
      {},
      { session: fail(403, 'forbidden'), banking: fail(403, 'forbidden') },
    );
    expect(html).toContain('You don&#x27;t have access to manage this team.');
    expect(html).not.toContain('<nav');
    expect(html).not.toContain('Rosedale, Wed');
  });

  it("403 on the session alone (another team's id under this team the caller administers) renders NoAccess while the team and banking reads succeed (AC-ERROR-8)", async () => {
    const html = await render({}, { session: fail(403, 'forbidden') });
    expect(html).toContain('You don&#x27;t have access to manage this team.');
    expect(html).not.toContain('<nav');
    expect(html).not.toContain('Rosedale, Wed');
  });

  it('404 (an id that exists nowhere) and 422 are not found, with nothing revealed', async () => {
    await expect(render({}, { session: fail(404, 'not_found') })).rejects.toThrow('NOT_FOUND');
    await expect(render({}, { session: fail(422, 'validation_failed') })).rejects.toThrow(
      'NOT_FOUND',
    );
  });

  it('a 5xx throws to the error page; a failed banking read alone is not fatal (the draft text just assumes banking is missing)', async () => {
    await expect(render({}, { session: fail(503, 'service_unavailable') })).rejects.toThrow(
      /API is unavailable/,
    );
    expect(mocks.warn).toHaveBeenCalledWith(
      'web.teams.api_failure',
      expect.objectContaining({ action: 'session_load', status: 503 }),
    );
    const html = await render(
      {},
      { session: detail({ draftReason: 'banking' }), banking: fail(503, 'service_unavailable') },
    );
    expect(html).toContain('Set up banking and GST');
  });
});
