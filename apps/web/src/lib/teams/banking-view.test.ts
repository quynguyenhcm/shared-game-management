import { BANKING_FIELD_MESSAGES, GST_RATE_BPS } from '@sgm/shared';
import { describe, expect, it } from 'vitest';
import {
  bankingErrorLines,
  bankingNotice,
  bankingPageUrl,
  bankingReturnTo,
  bankingStatus,
  editHref,
  formatLastChanged,
  gstHelperText,
  gstSummaryRows,
  hasSavedBanking,
  hasSavedGst,
  parseEditParam,
  validateBankingForm,
  validateGstForm,
  viewHref,
} from './banking-view.ts';

const TEAM_ID = '7f3c2b1a-1111-4222-8333-444455556666';
const OTHER_ID = '8a4d3c2b-2222-4333-8444-555566667777';
const VALID_ACCOUNT = '01-0902-0068389-00';

const banking = (over: Record<string, unknown> = {}) => ({
  isPayoutConfigured: false,
  payoutBlocked: false,
  unreadable: false,
  accountNumberLast4: null as string | null,
  ...over,
});

describe('bankingStatus (text-led status line; R3 blocked and R7 unreadable)', () => {
  it('not set up: names the consequence and never mentions Akahu (R1)', () => {
    const status = bankingStatus(banking());
    expect(status.kind).toBe('not_set_up');
    expect(status.lead).toBe('Not set up.');
    expect(status.body).toBe(
      "Paid sessions can't be published until you add your bank account details.",
    );
    expect(`${status.lead} ${status.body}`).not.toMatch(/akahu/i);
  });

  it('configured: "Set up. Paid sessions can be published." (nothing is verified with Akahu)', () => {
    const status = bankingStatus(banking({ isPayoutConfigured: true, accountNumberLast4: '8389' }));
    expect(status).toMatchObject({
      kind: 'ready',
      lead: 'Set up.',
      body: 'Paid sessions can be published.',
    });
  });

  it('blocked wins over configured and names the account ending (R3)', () => {
    const status = bankingStatus(
      banking({ isPayoutConfigured: false, payoutBlocked: true, accountNumberLast4: '8389' }),
    );
    expect(status.kind).toBe('blocked');
    expect(status.lead).toBe('Needs attention.');
    expect(status.body).toBe(
      'Payments to the account ending 8389 failed. Check the account number and save it again.',
    );
  });

  it('unreadable (R7) wins over everything and asks for name and number again', () => {
    const status = bankingStatus(
      banking({ unreadable: true, payoutBlocked: true, accountNumberLast4: '8389' }),
    );
    expect(status.kind).toBe('unreadable');
    expect(status.lead).toBe('Needs attention.');
    expect(status.body).toContain("couldn't read your saved bank details");
    expect(status.body).toContain('account name and number');
  });
});

describe('bankingNotice (R6 notice codes; codes in, fixed text out)', () => {
  it.each([
    ['banking_saved', {}, 'Banking details saved. Paid sessions can now be published.'],
    ['banking_updated', {}, 'Banking details updated.'],
    [
      'banking_account_changed',
      { last4: '7800' },
      'Banking details updated. Payments now go to the account ending 7800.',
    ],
    [
      'banking_removed',
      {},
      "Banking details removed. Paid sessions can't be published until you add them again.",
    ],
    ['gst_saved', {}, 'GST settings saved.'],
  ])('%s', (code, context, first) => {
    expect(bankingNotice(code, context)?.lines[0]).toBe(first);
  });

  it('an account change with no readable ending falls back to the plain updated line', () => {
    expect(bankingNotice('banking_account_changed', {})?.lines[0]).toBe('Banking details updated.');
  });

  it('adds the change-email line only to notices that always change something', () => {
    const email = "We've emailed the team's admins about this change.";
    expect(bankingNotice('banking_saved', {})?.lines).toContain(email);
    expect(bankingNotice('banking_removed', {})?.lines).toContain(email);
    expect(bankingNotice('gst_saved', {})?.lines).toEqual(['GST settings saved.']);
    // A removal that found nothing saved emailed nobody, so it says only that.
    expect(bankingNotice('banking_nothing_removed', {})?.lines).toEqual([
      'There were no banking details to remove.',
    ]);
  });

  it('renders nothing for an unknown, missing or hostile code', () => {
    expect(bankingNotice('<script>', {})).toBeNull();
    expect(bankingNotice(undefined, {})).toBeNull();
    expect(bankingNotice(null, {})).toBeNull();
  });
});

describe('bankingReturnTo (ADR 0016: safeReturnTo, same-team prefix, never the banking page itself)', () => {
  it.each([
    [`/teams/${TEAM_ID}/sessions/abc/edit`, `/teams/${TEAM_ID}/sessions/abc/edit`],
    [`/teams/${TEAM_ID}/manage`, `/teams/${TEAM_ID}/manage`],
  ])('accepts %s', (raw, expected) => {
    expect(bankingReturnTo(TEAM_ID, raw)).toBe(expected);
  });

  it.each([
    ['https://evil.example/', 'off-site'],
    ['//evil.example/x', 'protocol-relative'],
    [`/teams/${OTHER_ID}/sessions/x`, 'another team'],
    [`/teams/${TEAM_ID}/../${OTHER_ID}/x`, 'dot segments into another team'],
    [`/teams/${TEAM_ID}/manage/banking`, 'the banking page itself'],
    [`/teams/${TEAM_ID}/manage/banking?edit=banking`, 'the banking page with a query'],
    [`/teams/${TEAM_ID}`, 'no trailing slash prefix'],
    ['/account', 'not a team path'],
    ['', 'empty'],
    [undefined, 'missing'],
  ])('drops %s (%s) silently', (raw, _reason) => {
    expect(bankingReturnTo(TEAM_ID, raw)).toBeUndefined();
  });
});

describe('page URLs and the edit param', () => {
  it('parseEditParam accepts only the closed list', () => {
    expect(parseEditParam('banking')).toBe('banking');
    expect(parseEditParam('gst')).toBe('gst');
    expect(parseEditParam('people')).toBeNull();
    expect(parseEditParam(undefined)).toBeNull();
  });

  it('bankingPageUrl keeps only the given params', () => {
    expect(bankingPageUrl({ teamId: TEAM_ID })).toBe(`/teams/${TEAM_ID}/manage/banking`);
    expect(
      bankingPageUrl({ teamId: TEAM_ID, notice: 'banking_saved', returnTo: '/teams/x/y' }),
    ).toBe(`/teams/${TEAM_ID}/manage/banking?notice=banking_saved&returnTo=%2Fteams%2Fx%2Fy`);
  });

  it('editHref sets ?edit= and lands on the section fragment, carrying returnTo', () => {
    expect(editHref(TEAM_ID, 'banking')).toBe(
      `/teams/${TEAM_ID}/manage/banking?edit=banking#banking`,
    );
    expect(editHref(TEAM_ID, 'gst', '/teams/x/y')).toBe(
      `/teams/${TEAM_ID}/manage/banking?edit=gst&returnTo=%2Fteams%2Fx%2Fy#gst`,
    );
  });
});

describe('validateBankingForm (same shared messages as the API; blank number allowed only when one is saved)', () => {
  it('passes a valid name and number', () => {
    expect(
      validateBankingForm(
        { accountName: 'Rosedale Badminton Club', accountNumber: VALID_ACCOUNT },
        { requireNumber: true },
      ),
    ).toEqual({});
  });

  it('requires the name, and the number when none is saved or the saved one is unreadable', () => {
    expect(
      validateBankingForm({ accountName: '  ', accountNumber: '' }, { requireNumber: true }),
    ).toEqual({
      accountName: [BANKING_FIELD_MESSAGES.accountNameRequired],
      accountNumber: [BANKING_FIELD_MESSAGES.accountNumberRequired],
    });
  });

  it('a blank number keeps the saved one when requireNumber is false', () => {
    expect(
      validateBankingForm({ accountName: 'Club', accountNumber: '' }, { requireNumber: false }),
    ).toEqual({});
  });

  it('reports a malformed number, an unknown bank and a failed check digit with the copy-deck text', () => {
    const run = (accountNumber: string) =>
      validateBankingForm({ accountName: 'Club', accountNumber }, { requireNumber: false })
        .accountNumber?.[0];
    expect(run('12-3456-789')).toBe(BANKING_FIELD_MESSAGES.accountNumberFormat);
    expect(run('99-0902-0068389-00')).toBe(BANKING_FIELD_MESSAGES.accountNumberUnknownBank);
    expect(run('01-0902-0068388-00')).toBe(BANKING_FIELD_MESSAGES.accountNumberCheckDigit);
  });

  it('flags a name over 100 characters and never echoes the typed value in any message', () => {
    const errors = validateBankingForm(
      { accountName: 'x'.repeat(101), accountNumber: '01-0902-0068388-00' },
      { requireNumber: false },
    );
    expect(errors.accountName).toEqual([BANKING_FIELD_MESSAGES.accountNameTooLong]);
    expect(JSON.stringify(errors)).not.toContain('0068388');
  });
});

describe('validateGstForm (a registered team needs a number somewhere)', () => {
  it('registering with no typed number and none saved is an error', () => {
    expect(
      validateGstForm({ gstRegistered: 'on', gstNumber: '' }, { hasSavedGstNumber: false }),
    ).toEqual({ gstNumber: [BANKING_FIELD_MESSAGES.gstNumberRequired] });
  });

  it('registering with a saved number and a blank field keeps it', () => {
    expect(
      validateGstForm({ gstRegistered: 'on', gstNumber: '' }, { hasSavedGstNumber: true }),
    ).toEqual({});
  });

  it('turning GST off needs no number', () => {
    expect(
      validateGstForm({ gstRegistered: 'off', gstNumber: undefined }, { hasSavedGstNumber: false }),
    ).toEqual({});
  });

  it('checks format and check digit with the copy-deck messages', () => {
    expect(
      validateGstForm({ gstRegistered: 'on', gstNumber: '12' }, { hasSavedGstNumber: false })
        .gstNumber?.[0],
    ).toBe(BANKING_FIELD_MESSAGES.gstNumberFormat);
    expect(
      validateGstForm(
        { gstRegistered: 'on', gstNumber: '49-091-851' },
        { hasSavedGstNumber: false },
      ).gstNumber?.[0],
    ).toBe(BANKING_FIELD_MESSAGES.gstNumberCheckDigit);
    expect(
      validateGstForm(
        { gstRegistered: 'on', gstNumber: '49-091-850' },
        { hasSavedGstNumber: false },
      ),
    ).toEqual({});
  });
});

describe('GST copy and summary', () => {
  it('derives 3/23 from the rate constant, never typed (UI/UX amendment 8)', () => {
    expect(GST_RATE_BPS).toBe(1500);
    const on = gstHelperText(true);
    expect(on).toContain('GST is worked out as 3/23 of the price.');
    expect(on).toContain("Players' prices include GST.");
    expect(on).toContain(
      'existing payments and invoices keep the GST treatment they were charged with',
    );
  });

  it('the toggle-off helper does not claim prices include GST', () => {
    const off = gstHelperText(false);
    expect(off).toMatch(/^Turn this on if your team is registered for GST\./);
    expect(off).not.toContain('prices include GST');
    expect(off).toContain('only affects payments taken after you save');
  });

  it('summary rows: registered shows the formatted number; off keeps a saved number labelled as unused', () => {
    expect(gstSummaryRows({ gstRegistered: true, gstNumber: '136410132' })).toEqual([
      { label: 'GST', value: 'Registered' },
      { label: 'GST number', value: '136-410-132' },
    ]);
    expect(gstSummaryRows({ gstRegistered: false, gstNumber: '49091850' })).toEqual([
      { label: 'GST', value: 'Not registered' },
      { label: 'Saved GST number', value: '49-091-850', note: 'Not used while GST is off.' },
    ]);
    expect(gstSummaryRows({ gstRegistered: false, gstNumber: null })).toEqual([
      { label: 'GST', value: 'Not registered' },
    ]);
  });
});

describe('bankingErrorLines (AC-ERROR-13: a generic outage line, values still in the form)', () => {
  it('maps a lost role and a missing team, and everything else is the outage line', () => {
    expect(bankingErrorLines('forbidden')).toEqual(["You don't have access to manage this team."]);
    expect(bankingErrorLines('not_found')).toEqual(["We couldn't find that team."]);
    expect(bankingErrorLines('service_unavailable')).toEqual([
      'Something went wrong on our side. Your details are still here. Try again in a minute.',
    ]);
    expect(bankingErrorLines('offline')).toEqual(bankingErrorLines('service_unavailable'));
  });
});

describe('saved-state predicates', () => {
  it('banking: a readable last4 is a summary; unreadable or empty is a form (R7, R6)', () => {
    expect(hasSavedBanking({ unreadable: false, accountNumberLast4: '8389' })).toBe(true);
    expect(hasSavedBanking({ unreadable: true, accountNumberLast4: '8389' })).toBe(false);
    expect(hasSavedBanking({ unreadable: false, accountNumberLast4: null })).toBe(false);
  });

  it('GST: registered or a kept number is saved; neither is nothing saved', () => {
    expect(hasSavedGst({ gstRegistered: true, gstNumber: '49091850' })).toBe(true);
    expect(hasSavedGst({ gstRegistered: false, gstNumber: '49091850' })).toBe(true);
    expect(hasSavedGst({ gstRegistered: false, gstNumber: null })).toBe(false);
  });

  it('viewHref is the summary link (edit cleared, returnTo kept)', () => {
    expect(viewHref(TEAM_ID, 'gst')).toBe(`/teams/${TEAM_ID}/manage/banking#gst`);
  });
});

describe('formatLastChanged (R8)', () => {
  it('names who and when in Pacific/Auckland NZ style', () => {
    expect(
      formatLastChanged({ at: '2026-10-16T01:00:00.000Z', by: { fullName: 'Aroha Ngata' } }),
    ).toBe('Last changed by Aroha Ngata on 16 Oct 2026');
  });

  it('omits the name after the actor account is deleted, and renders nothing without an audit stamp', () => {
    expect(formatLastChanged({ at: '2026-10-16T01:00:00.000Z', by: null })).toBe(
      'Last changed on 16 Oct 2026',
    );
    expect(formatLastChanged(null)).toBeNull();
  });
});
