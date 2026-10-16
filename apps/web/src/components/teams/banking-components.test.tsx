import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

vi.mock('next/headers', () => ({
  cookies: () => Promise.resolve({ get: () => undefined, set: () => undefined }),
  headers: () => Promise.resolve(new Headers()),
}));
vi.mock('next/navigation', () => ({
  redirect: () => undefined,
  RedirectType: { replace: 'replace' },
}));
vi.mock('next/cache', () => ({ revalidatePath: () => undefined }));

const { ManageAreaNav } = await import('./manage-area-nav.tsx');
const { NoAccess } = await import('./no-access.tsx');
const { BankingSection } = await import('./banking-section.tsx');
const { GstSection } = await import('./gst-section.tsx');
const { InlineConfirm } = await import('./inline-confirm.tsx');
const { removeBankingAction } = await import('../../lib/teams/banking-actions.ts');

const TEAM_ID = '7f3c2b1a-1111-4222-8333-444455556666';
const KEY = '2f6c1c1e-7a64-4c0e-9d61-3c1f0c1f0a11';
const RETURN_TO = `/teams/${TEAM_ID}/sessions/abc/edit`;

const banking = (over: Record<string, unknown> = {}) => ({
  isPayoutConfigured: false,
  payoutBlocked: false,
  accountName: null as string | null,
  unreadable: false,
  accountNumberLast4: null as string | null,
  lastChanged: null as { at: string; by: { fullName: string } | null } | null,
  ...over,
});
const savedBanking = (over: Record<string, unknown> = {}) =>
  banking({
    isPayoutConfigured: true,
    accountName: 'Rosedale Badminton Club',
    accountNumberLast4: '8389',
    lastChanged: { at: '2026-10-16T01:00:00.000Z', by: { fullName: 'Aroha Ngata' } },
    ...over,
  });

const inputTag = (html: string, name: string): string =>
  new RegExp(`<input[^>]*name="${name}"[^>]*>`).exec(html)?.[0] ?? '';

describe('ManageAreaNav (per-page, current as a prop; AC-ENTRY-1, AC-ENTRY-3)', () => {
  it.each([
    ['people', 'People'],
    ['banking', 'Banking and GST'],
  ])('marks exactly one link aria-current=page for current=%s', (current, label) => {
    const html = renderToStaticMarkup(<ManageAreaNav teamId={TEAM_ID} current={current} />);
    expect(html).toContain('<nav aria-label="Team admin areas"');
    expect(html.match(/aria-current="page"/g)).toHaveLength(1);
    const currentLink = /<a[^>]*aria-current="page"[^>]*>([^<]*)<\/a>/.exec(html);
    expect(currentLink?.[1]).toBe(label);
    expect(html).toContain(`href="/teams/${TEAM_ID}/manage"`);
    expect(html).toContain(`href="/teams/${TEAM_ID}/manage/banking"`);
  });

  it('marks the current link with more than colour (bold and a thicker underline)', () => {
    const html = renderToStaticMarkup(<ManageAreaNav teamId={TEAM_ID} current="banking" />);
    const link = /<a[^>]*aria-current="page"[^>]*>/.exec(html)?.[0] ?? '';
    expect(link).toContain('font-semibold');
    expect(link).toContain('decoration-2');
  });
});

describe('NoAccess (extracted; AC-ENTRY-2: no nav, no banking content)', () => {
  it('shows the heading and the way back, and no area nav', () => {
    const html = renderToStaticMarkup(<NoAccess />);
    expect(html).toContain('You don&#x27;t have access to manage this team.');
    expect(html).toContain('href="/teams"');
    expect(html).not.toContain('<nav');
    expect(html).not.toContain('Banking and GST');
  });
});

describe('BankingSection: nothing saved shows the form directly (R6)', () => {
  const html = renderToStaticMarkup(
    <BankingSection
      teamId={TEAM_ID}
      banking={banking()}
      editing={false}
      changeKey={KEY}
      returnTo={RETURN_TO}
    />,
  );

  it('has the section heading and exactly the name and number inputs (R1: no Akahu fields)', () => {
    expect(html).toContain('id="banking-heading"');
    expect(html).toContain('Bank account');
    expect(inputTag(html, 'accountName')).not.toBe('');
    expect(inputTag(html, 'accountNumber')).not.toBe('');
    expect(html).not.toMatch(/akahu|merchant|token|\bird\b/i);
  });

  it('account number: numeric keyboard, autocomplete off, no maxlength, no input mask (AC-VERIFY-13)', () => {
    const tag = inputTag(html, 'accountNumber');
    expect(tag).toContain('inputMode="numeric"');
    expect(tag).toContain('autoComplete="off"');
    expect(tag).toContain('spellCheck="false"');
    expect(tag).not.toContain('maxLength');
    expect(tag).not.toContain('value=');
  });

  it('every input has a visible label and its hint tied by aria-describedby', () => {
    expect(html).toContain('<label for="field-accountName"');
    expect(html).toContain('<label for="field-accountNumber"');
    expect(inputTag(html, 'accountNumber')).toContain(
      'aria-describedby="field-accountNumber-hint"',
    );
    expect(html).toContain('Format 00-0000-0000000-00. Hyphens and spaces are optional.');
    expect(html).toContain('The name on the bank account. Up to 100 characters.');
  });

  it('carries the per-render changeKey, wasConfigured=false and the validated returnTo as hidden inputs', () => {
    expect(inputTag(html, 'changeKey')).toContain(`value="${KEY}"`);
    expect(inputTag(html, 'changeKey')).toContain('type="hidden"');
    expect(inputTag(html, 'wasConfigured')).toContain('value="false"');
    expect(inputTag(html, 'returnTo')).toContain(`value="${RETURN_TO}"`);
    expect(inputTag(html, 'teamId')).toContain(`value="${TEAM_ID}"`);
  });

  it('offers no Change link, no Remove control and no summary list', () => {
    expect(html).not.toContain('Change banking details');
    expect(html).not.toContain('Remove banking details');
    expect(html).not.toContain('<dl');
    expect(html).toContain('Save banking details');
  });
});

describe('BankingSection: saved shows a read-only summary with Change and Remove (R6, R8)', () => {
  const html = renderToStaticMarkup(
    <BankingSection
      teamId={TEAM_ID}
      banking={savedBanking()}
      editing={false}
      changeKey={KEY}
      returnTo={RETURN_TO}
    />,
  );

  it('renders dt/dd pairs: the name, "ending {last4}", never the full number', () => {
    expect(html).toContain('<dl');
    expect(html).toMatch(/<dt[^>]*>Account name<\/dt>\s*<dd[^>]*>Rosedale Badminton Club<\/dd>/);
    expect(html).toMatch(/<dt[^>]*>Account number<\/dt>\s*<dd[^>]*>ending 8389<\/dd>/);
    expect(html).not.toMatch(/0068389|01-0902/);
  });

  it('shows who changed it and when (R8)', () => {
    expect(html).toContain('Last changed by Aroha Ngata on 16 Oct 2026');
  });

  it('"Change banking details" is a link to ?edit=banking#banking that keeps returnTo', () => {
    const link = /<a[^>]*>Change banking details<\/a>/.exec(html)?.[0] ?? '';
    expect(link).toContain(
      `href="/teams/${TEAM_ID}/manage/banking?edit=banking&amp;returnTo=${encodeURIComponent(RETURN_TO)}#banking"`,
    );
  });

  it('"Remove banking details" is an InlineConfirm disclosure trigger (no native dialog), closed by default', () => {
    const trigger = /<button[^>]*aria-expanded="false"[^>]*>Remove banking details<\/button>/.exec(
      html,
    );
    expect(trigger).not.toBeNull();
    expect(html).not.toContain('role="group"');
    expect(html).not.toMatch(/confirm\(|alert\(/);
  });

  it('has no form inputs while viewing', () => {
    expect(inputTag(html, 'accountNumber')).toBe('');
    expect(html).not.toContain('Save banking details');
  });
});

describe('BankingSection: edit mode (?edit=banking)', () => {
  const html = renderToStaticMarkup(
    <BankingSection
      teamId={TEAM_ID}
      banking={savedBanking()}
      editing
      changeKey={KEY}
      returnTo={undefined}
    />,
  );

  it('prefills the name, leaves the number blank with the keep hint, and sends wasConfigured=true', () => {
    expect(inputTag(html, 'accountName')).toContain('value="Rosedale Badminton Club"');
    expect(inputTag(html, 'accountNumber')).not.toContain('value=');
    expect(html).toContain(
      'Leave blank to keep the saved value. To replace it, use the format 00-0000-0000000-00.',
    );
    expect(inputTag(html, 'wasConfigured')).toContain('value="true"');
  });

  it('hides Remove (it never sits beside Save) and offers Cancel back to the summary', () => {
    expect(html).not.toContain('Remove banking details');
    const cancel = /<a[^>]*>Cancel<\/a>/.exec(html)?.[0] ?? '';
    expect(cancel).toContain(`href="/teams/${TEAM_ID}/manage/banking#banking"`);
  });
});

describe('BankingSection: unreadable saved details (R7, AC-ERROR-12)', () => {
  const html = renderToStaticMarkup(
    <BankingSection
      teamId={TEAM_ID}
      banking={banking({ unreadable: true, accountNumberLast4: '8389' })}
      editing={false}
      changeKey={KEY}
      returnTo={undefined}
    />,
  );

  it('shows the form with name and number required: no summary values, no keep-the-saved-value hint', () => {
    expect(inputTag(html, 'accountName')).not.toBe('');
    expect(inputTag(html, 'accountNumber')).not.toBe('');
    expect(html).not.toContain('<dl');
    expect(html).not.toContain('Leave blank to keep');
    expect(html).not.toContain('ending 8389');
    expect(html).not.toContain('Remove banking details');
  });
});

describe('GstSection (R2: one GST number field)', () => {
  const none = { gstRegistered: false, gstNumber: null as string | null };

  it('nothing saved shows the form directly: toggle off, no number field yet, off-state helper', () => {
    const html = renderToStaticMarkup(
      <GstSection teamId={TEAM_ID} gst={none} editing={false} returnTo={undefined} />,
    );
    expect(html).toContain('id="gst-heading"');
    expect(html).toContain('This team is registered for GST');
    expect(inputTag(html, 'gstRegistered')).not.toContain('checked');
    expect(inputTag(html, 'gstNumber')).toBe('');
    expect(html).toContain('Turn this on if your team is registered for GST.');
    expect(html).not.toContain('<dl');
    expect(html).toContain('Save GST settings');
  });

  it('saved and registered shows a dl summary with the formatted number and a Change link', () => {
    const html = renderToStaticMarkup(
      <GstSection
        teamId={TEAM_ID}
        gst={{ gstRegistered: true, gstNumber: '136410132' }}
        editing={false}
        returnTo={RETURN_TO}
      />,
    );
    expect(html).toMatch(/<dt[^>]*>GST<\/dt>\s*<dd[^>]*>Registered<\/dd>/);
    expect(html).toMatch(/<dt[^>]*>GST number<\/dt>\s*<dd[^>]*>136-410-132<\/dd>/);
    expect(html).toContain(
      `href="/teams/${TEAM_ID}/manage/banking?edit=gst&amp;returnTo=${encodeURIComponent(RETURN_TO)}#gst"`,
    );
    expect(inputTag(html, 'gstNumber')).toBe('');
  });

  it('edit mode while registered: toggle ticked, number prefilled formatted, IRD hint, numeric keyboard, on-state helper with 3/23', () => {
    const html = renderToStaticMarkup(
      <GstSection
        teamId={TEAM_ID}
        gst={{ gstRegistered: true, gstNumber: '136410132' }}
        editing
        returnTo={undefined}
      />,
    );
    expect(inputTag(html, 'gstRegistered')).toContain('checked');
    const number = inputTag(html, 'gstNumber');
    expect(number).toContain('value="136-410-132"');
    expect(number).toContain('inputMode="numeric"');
    expect(number).toContain('autoComplete="off"');
    expect(html).toContain('This is your IRD number.');
    expect(html).toContain('GST is worked out as 3/23 of the price.');
    expect(html).not.toMatch(/irdNumber|IRD number \(optional\)|Remove the saved IRD/);
    expect(html).toMatch(/<a[^>]*>Cancel<\/a>/);
  });

  it('the toggle has its label as the accessible name and its helper linked by aria-describedby', () => {
    const html = renderToStaticMarkup(
      <GstSection teamId={TEAM_ID} gst={none} editing={false} returnTo={undefined} />,
    );
    expect(html).toContain('<label for="field-gstRegistered"');
    expect(inputTag(html, 'gstRegistered')).toContain(
      'aria-describedby="field-gstRegistered-hint"',
    );
    expect(html).toContain('id="field-gstRegistered-hint"');
  });
});

describe('InlineConfirm generalised to a section id (UI/UX amendment 11)', () => {
  it('takes any SectionId, including banking, and renders the same disclosure pattern', () => {
    const html = renderToStaticMarkup(
      <InlineConfirm
        id="remove-banking"
        section="banking"
        action={removeBankingAction}
        fields={{ teamId: TEAM_ID }}
        triggerLabel="Remove banking details"
        prompt="Remove banking details? Paid sessions can't be published until you add them again."
        confirmLabel="Remove banking details"
        pendingLabel="Removing…"
        destructive
        defaultOpen
      />,
    );
    expect(html).toMatch(
      /<button[^>]*aria-expanded="true"[^>]*aria-controls="remove-banking-panel"/,
    );
    const panel = /<div[^>]*role="group"[^>]*>/.exec(html)?.[0] ?? '';
    expect(panel).toContain('aria-labelledby="remove-banking-prompt"');
    expect(html).toContain('name="teamId"');
    expect(html).toContain('Cancel');
  });
});
