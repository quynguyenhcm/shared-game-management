import { describe, expect, it } from 'vitest';
import { parseMoney } from '@sgm/shared';
import { testCrypto } from '../../../test/helpers/app-deps.ts';
import { RESUME_MIN_REMAINING_MS } from './constants.ts';
import type { CreatePaymentInput, CreatePaymentResult, PaymentsGateway } from './gateway.ts';
import {
  newStatementReference,
  paymentStartSettings,
  resumeUrl,
  sealAuthorisationUrl,
  startProviderPayment,
  type SealedPayee,
} from './start.ts';

const crypto = testCrypto();
const TEAM = '0b5f1c3e-9d3a-4f7b-8a55-6f2f4d5e6a7b';
const INTENT = '3b241101-e2bb-4255-8caf-4136c566a962';
const NOW = new Date('2026-11-10T00:00:00.000Z');
const SETTINGS = { expiryMinutes: 30, webhookUrl: 'https://api.example.nz/webhooks/akahu' };

const sealed = (name: string, number = '01-0902-0068389-000', teamId = TEAM): SealedPayee => ({
  teamId,
  nameEnvelope: crypto.encrypt(name, {
    table: 'teams',
    column: 'bank_account_name',
    rowId: teamId,
  }),
  numberEnvelope: crypto.encrypt(number, {
    table: 'teams',
    column: 'bank_account_number',
    rowId: teamId,
  }),
});

function spyGateway(answer: CreatePaymentResult | Error) {
  const calls: CreatePaymentInput[] = [];
  const gateway: Pick<PaymentsGateway, 'createPayment'> = {
    createPayment(input) {
      calls.push(input);
      return answer instanceof Error ? Promise.reject(answer) : Promise.resolve(answer);
    },
  };
  return { gateway, calls };
}

const CREATED: CreatePaymentResult = {
  ok: true,
  authorisationUrl: 'https://consent.example/abc',
  payment: {
    providerPaymentId: 'fake_ok_1700_1_abcd',
    amount: parseMoney('17.00'),
    providerStatus: 'READY',
    providerStatusReason: null,
    outcome: { kind: 'OPEN', phase: 'AWAITING_PAYER' },
  },
};

const input = (payee: SealedPayee) => ({
  amount: parseMoney('17.00'),
  reference: 'SGM0123ABCD',
  redirectUri: 'https://games.example.nz/payments/x?return=1',
  payee,
  now: NOW,
});

describe('startProviderPayment (A5, B10: decrypt late, forget early)', () => {
  it('decrypts the payee only for the call and sends the normalised name, the number, the reference and the expiry', async () => {
    const { gateway, calls } = spyGateway(CREATED);
    const result = await startProviderPayment(
      { gateway, crypto, settings: SETTINGS },
      input(sealed('  Tuesday   Smashers ✓ ')),
    );
    expect(result).toEqual({
      kind: 'created',
      providerPaymentId: 'fake_ok_1700_1_abcd',
      providerStatus: 'READY',
      providerStatusReason: null,
      authorisationUrl: 'https://consent.example/abc',
      expiresAt: new Date(NOW.getTime() + 30 * 60_000),
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toEqual({
      amount: parseMoney('17.00'),
      payee: { name: 'Tuesday Smashers', accountNumber: '01-0902-0068389-000' },
      reference: 'SGM0123ABCD',
      redirectUri: 'https://games.example.nz/payments/x?return=1',
      webhookUri: SETTINGS.webhookUrl,
      expiresAt: new Date(NOW.getTime() + 30 * 60_000),
    });
    // Nothing the caller gets back carries the payee.
    expect(JSON.stringify(result)).not.toMatch(/Smashers|0068389/);
  });

  it('refuses locally (payee_unusable, no provider call) when the payee cannot be opened or normalised', async () => {
    for (const payee of [
      { teamId: TEAM, nameEnvelope: null, numberEnvelope: null },
      // Sealed for another team's row, presented as this team's: the AAD does not match.
      { ...sealed('Club', '01-0902-0068389-000', INTENT), teamId: TEAM },
      sealed('!!'),
    ]) {
      const { gateway, calls } = spyGateway(CREATED);
      expect(
        await startProviderPayment({ gateway, crypto, settings: SETTINGS }, input(payee)),
      ).toEqual({ kind: 'refused', reason: 'payee_unusable', code: 'payee_unusable' });
      expect(calls).toHaveLength(0);
    }
  });

  it.each([
    ['invalid_payee', 'payee_unusable'],
    ['single_limit_exceeded', 'amount_over_bank_limit'],
    ['bank_limit_exceeded', 'amount_over_bank_limit'],
    ['invalid_payer', 'payer_bank_unavailable'],
    ['other', 'payer_bank_unavailable'],
  ] as const)('maps the provider refusal %s to %s', async (code, reason) => {
    const { gateway } = spyGateway({ ok: false, kind: 'refused', providerCode: code });
    expect(
      await startProviderPayment({ gateway, crypto, settings: SETTINGS }, input(sealed('Club'))),
    ).toEqual({ kind: 'refused', reason, code });
  });

  it('answers unavailable for an ambiguous create and for a thrown error (never retried)', async () => {
    for (const answer of [
      { ok: false, kind: 'unavailable' } as const,
      new Error('socket hang up'),
    ]) {
      const { gateway, calls } = spyGateway(answer);
      expect(
        await startProviderPayment({ gateway, crypto, settings: SETTINGS }, input(sealed('Club'))),
      ).toEqual({ kind: 'unavailable' });
      expect(calls).toHaveLength(1);
    }
  });
});

describe('resumeUrl (CR-6, RF-6)', () => {
  const url = 'https://consent.example/resume';
  const open = (overrides: Partial<Parameters<typeof resumeUrl>[2]> = {}) => ({
    id: INTENT,
    status: 'OPEN' as const,
    akahuStatus: 'READY',
    expiresAt: new Date(NOW.getTime() + RESUME_MIN_REMAINING_MS),
    authorisationUrlEnc: sealAuthorisationUrl(crypto, 'payment_attempts', INTENT, url),
    ...overrides,
  });

  it('returns the sealed URL while the payer is awaited and the link has at least the minimum left', () => {
    expect(RESUME_MIN_REMAINING_MS).toBe(120_000);
    expect(resumeUrl(crypto, 'payment_attempts', open(), NOW)).toBe(url);
  });

  it('returns null when the link is nearly expired, the payer has authorised, the intent is not OPEN, or the seal is not this row', () => {
    const nearly = new Date(NOW.getTime() + RESUME_MIN_REMAINING_MS - 1);
    expect(resumeUrl(crypto, 'payment_attempts', open({ expiresAt: nearly }), NOW)).toBeNull();
    expect(
      resumeUrl(crypto, 'payment_attempts', open({ akahuStatus: 'AUTHORISED' }), NOW),
    ).toBeNull();
    expect(resumeUrl(crypto, 'payment_attempts', open({ status: 'HELD' }), NOW)).toBeNull();
    expect(resumeUrl(crypto, 'wallet_top_ups', open(), NOW)).toBeNull();
    expect(
      resumeUrl(crypto, 'payment_attempts', open({ authorisationUrlEnc: null }), NOW),
    ).toBeNull();
  });
});

describe('paymentStartSettings and references', () => {
  it('uses AKAHU_WEBHOOK_URL with the live adapter and an inert URL with the fake', () => {
    const base = {
      paymentExpiryMinutes: 45,
      reconcileOrphanAgeSeconds: 120,
      reconcileMinAgeSeconds: 300,
      reconcileStuckAfterSeconds: 21600,
      finalityHorizonHours: 168,
    };
    expect(
      paymentStartSettings({
        ...base,
        adapter: 'akahu',
        akahu: {
          appToken: 't',
          appSecret: 's',
          paymentsApiUrl: 'https://api.payments.akahu.io',
          webhookUrl: 'https://api.example.nz/webhooks/akahu',
        },
      }),
    ).toEqual({ expiryMinutes: 45, webhookUrl: 'https://api.example.nz/webhooks/akahu' });
    const fake = paymentStartSettings({ ...base, adapter: 'fake', akahu: null });
    expect(fake.expiryMinutes).toBe(45);
    expect(URL.canParse(fake.webhookUrl)).toBe(true);
  });

  it('makes SGM + 8 Crockford base32 statement references', () => {
    for (let n = 0; n < 50; n += 1)
      expect(newStatementReference()).toMatch(/^SGM[0-9A-HJKMNP-TV-Z]{8}$/);
  });
});
