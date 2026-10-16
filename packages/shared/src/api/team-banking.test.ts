import { describe, expect, it } from 'vitest';
import {
  BANKING_FIELD_MESSAGES,
  BankingResponse,
  GstResponse,
  PutBankingRequest,
  PutGstRequest,
} from './team-banking.ts';

const KEY = '3b241101-e2bb-4255-8caf-4136c566a962';
// IRD Ex 1 (s7): a valid account. See nz/bank-account.test.ts for the trace.
const VALID_NUMBER = '01-0902-0068389-00';

function errorsFor(
  schema: { safeParse(value: unknown): unknown },
  value: unknown,
): Record<string, string[]> {
  const result = schema.safeParse(value) as {
    success: boolean;
    error?: { issues: { path: PropertyKey[]; message: string }[] };
  };
  if (result.success) throw new Error('expected a failure');
  const out: Record<string, string[]> = {};
  for (const issue of result.error?.issues ?? []) {
    (out[String(issue.path[0] ?? '_form')] ??= []).push(issue.message);
  }
  return out;
}

describe('PutBankingRequest', () => {
  it('accepts a first-time save and canonicalises the number (padded suffix, trimmed name)', () => {
    const parsed = PutBankingRequest.parse({
      accountName: '  Rosedale Badminton Club ',
      accountNumber: VALID_NUMBER,
      changeKey: KEY,
    });
    expect(parsed).toEqual({
      accountName: 'Rosedale Badminton Club',
      accountNumber: '01-0902-0068389-000',
      changeKey: KEY,
    });
  });

  it('treats an omitted or blank account number as "keep the saved value"', () => {
    for (const body of [
      { accountName: 'Club', changeKey: KEY },
      { accountName: 'Club', accountNumber: '', changeKey: KEY },
      { accountName: 'Club', accountNumber: '   ', changeKey: KEY },
    ]) {
      expect(PutBankingRequest.parse(body).accountNumber).toBeUndefined();
    }
  });

  it('reports each number failure reason with its copy-deck message, never echoing input', () => {
    const cases: ReadonlyArray<[string, string]> = [
      ['1234', BANKING_FIELD_MESSAGES.accountNumberFormat],
      ['99-0001-0000001-00', BANKING_FIELD_MESSAGES.accountNumberUnknownBank],
      ['01-0902-0068388-00', BANKING_FIELD_MESSAGES.accountNumberCheckDigit],
      ['9'.repeat(41), BANKING_FIELD_MESSAGES.accountNumberFormat],
    ];
    for (const [number, message] of cases) {
      const errors = errorsFor(PutBankingRequest, {
        accountName: 'Club',
        accountNumber: number,
        changeKey: KEY,
      });
      expect(errors['accountNumber']).toEqual([message]);
      expect(message).not.toContain(number);
    }
  });

  it('validates the account name: required, at most 100 characters, no control characters', () => {
    expect(
      errorsFor(PutBankingRequest, { accountName: '   ', changeKey: KEY })['accountName'],
    ).toEqual([BANKING_FIELD_MESSAGES.accountNameRequired]);
    expect(errorsFor(PutBankingRequest, { changeKey: KEY })['accountName']).toEqual([
      BANKING_FIELD_MESSAGES.accountNameRequired,
    ]);
    expect(
      errorsFor(PutBankingRequest, { accountName: 'x'.repeat(101), changeKey: KEY })['accountName'],
    ).toEqual([BANKING_FIELD_MESSAGES.accountNameTooLong]);
    expect(
      PutBankingRequest.safeParse({ accountName: 'x'.repeat(100), changeKey: KEY }).success,
    ).toBe(true);
    expect(PutBankingRequest.safeParse({ accountName: 'a\u0000b', changeKey: KEY }).success).toBe(
      false,
    );
  });

  it('requires a UUID v4 changeKey', () => {
    expect(
      errorsFor(PutBankingRequest, { accountName: 'Club', changeKey: 'nope' })['changeKey'],
    ).toEqual([BANKING_FIELD_MESSAGES.changeKeyInvalid]);
    expect(PutBankingRequest.safeParse({ accountName: 'Club' }).success).toBe(false);
  });

  it('is strict: Akahu, IRD, payout flag and audit fields are unknown keys (R1, R2)', () => {
    for (const extra of [
      'akahuMerchantId',
      'akahuAppToken',
      'irdNumber',
      'isPayoutConfigured',
      'payoutBlocked',
      'bankingUpdatedBy',
    ]) {
      const result = PutBankingRequest.safeParse({
        accountName: 'Club',
        changeKey: KEY,
        [extra]: 'x',
      });
      expect(result.success).toBe(false);
    }
  });
});

describe('PutGstRequest', () => {
  it('accepts registered with a GST number and returns canonical digits', () => {
    expect(PutGstRequest.parse({ gstRegistered: true, gstNumber: '049-091-850' })).toEqual({
      gstRegistered: true,
      gstNumber: '49091850',
    });
    expect(PutGstRequest.parse({ gstRegistered: true, gstNumber: '136 410 132' }).gstNumber).toBe(
      '136410132',
    );
  });

  it('accepts turning GST off with no number, and treats a blank number as omitted (keep)', () => {
    expect(PutGstRequest.parse({ gstRegistered: false })).toEqual({ gstRegistered: false });
    expect(PutGstRequest.parse({ gstRegistered: true, gstNumber: '  ' }).gstNumber).toBeUndefined();
  });

  it('maps each number failure to a copy-deck message that does not echo input', () => {
    const cases: ReadonlyArray<[string, string]> = [
      ['1234567', BANKING_FIELD_MESSAGES.gstNumberFormat],
      ['12a45678', BANKING_FIELD_MESSAGES.gstNumberFormat],
      ['49091851', BANKING_FIELD_MESSAGES.gstNumberCheckDigit],
      ['200000005', BANKING_FIELD_MESSAGES.gstNumberCheckDigit], // check-valid but above 200,000,000
    ];
    for (const [number, message] of cases) {
      const errors = errorsFor(PutGstRequest, { gstRegistered: true, gstNumber: number });
      expect(errors['gstNumber']).toEqual([message]);
      expect(message).not.toContain(number);
    }
  });

  it('requires gstRegistered to be a boolean and is strict (no irdNumber, R2)', () => {
    expect(PutGstRequest.safeParse({}).success).toBe(false);
    expect(PutGstRequest.safeParse({ gstRegistered: 'yes' }).success).toBe(false);
    expect(PutGstRequest.safeParse({ gstRegistered: true, irdNumber: '49091850' }).success).toBe(
      false,
    );
    expect(PutGstRequest.safeParse({ gstRegistered: true, gstNumber: null }).success).toBe(false);
  });
});

describe('responses', () => {
  const configured = {
    banking: {
      isPayoutConfigured: true,
      payoutBlocked: false,
      accountName: 'Rosedale Badminton Club',
      unreadable: false,
      accountNumberLast4: '8389',
      lastChanged: { at: '2026-10-16T01:02:03.000Z', by: { fullName: 'Aroha Ngata' } },
    },
  };

  it('parses configured, unconfigured, blocked and unreadable banking states', () => {
    expect(BankingResponse.parse(configured)).toEqual(configured);
    expect(
      BankingResponse.safeParse({
        banking: {
          isPayoutConfigured: false,
          payoutBlocked: false,
          accountName: null,
          unreadable: false,
          accountNumberLast4: null,
          lastChanged: null,
        },
      }).success,
    ).toBe(true);
    // R3: blocked but the block is still present; R7: unreadable gives a null name; R8: by may be null.
    expect(
      BankingResponse.safeParse({
        banking: {
          ...configured.banking,
          isPayoutConfigured: false,
          payoutBlocked: true,
          accountName: null,
          unreadable: true,
          lastChanged: { at: '2026-10-16T01:02:03.000Z', by: null },
        },
      }).success,
    ).toBe(true);
  });

  it('never carries the full number or any Akahu or IRD field in its shape', () => {
    const keys = Object.keys(BankingResponse.shape.banking.shape);
    expect(keys.sort()).toEqual(
      [
        'accountName',
        'accountNumberLast4',
        'isPayoutConfigured',
        'lastChanged',
        'payoutBlocked',
        'unreadable',
      ].sort(),
    );
    const gstKeys = Object.keys(GstResponse.shape.gst.shape);
    expect(gstKeys.sort()).toEqual(['gstNumber', 'gstRegistered']);
  });

  it('rejects a malformed last4 and a non-canonical GST number', () => {
    expect(
      BankingResponse.safeParse({
        banking: { ...configured.banking, accountNumberLast4: '83890' },
      }).success,
    ).toBe(false);
    expect(
      GstResponse.safeParse({ gst: { gstRegistered: true, gstNumber: '049091850' } }).success,
    ).toBe(false);
    expect(
      GstResponse.safeParse({ gst: { gstRegistered: true, gstNumber: '49091850' } }).success,
    ).toBe(true);
    expect(GstResponse.safeParse({ gst: { gstRegistered: false, gstNumber: null } }).success).toBe(
      true,
    );
  });
});

describe('BANKING_FIELD_MESSAGES copy deck', () => {
  it('uses the UI/UX copy and carries no Akahu or IRD message (R1, R2)', () => {
    expect(BANKING_FIELD_MESSAGES.accountNameRequired).toBe('Enter the name on the bank account.');
    expect(BANKING_FIELD_MESSAGES.accountNumberRequired).toBe('Enter the account number.');
    expect(BANKING_FIELD_MESSAGES.accountNumberFormat).toBe(
      'Enter an NZ account number in the format 00-0000-0000000-00.',
    );
    expect(BANKING_FIELD_MESSAGES.gstNumberRequired).toBe(
      'Enter your GST number to register for GST.',
    );
    for (const key of Object.keys(BANKING_FIELD_MESSAGES)) {
      expect(key).not.toMatch(/akahu|ird|merchant|token/i);
    }
    for (const message of Object.values(BANKING_FIELD_MESSAGES)) {
      expect(message).not.toMatch(/akahu|IRD number|merchant|token/i);
    }
  });
});
