import { generateKeyPairSync } from 'node:crypto';
import { parseMoney, toMoneyString, type Money } from '@sgm/shared';
import { describe, expect, it } from 'vitest';
import { createManualClock } from '../clock.ts';
import { createPaymentsGateway, type PaymentsConfig } from './config.ts';
import { createFakePaymentsGateway, createFakeControl } from './fake-adapter.ts';
import {
  GatewayConfigurationError,
  GatewayUnavailableError,
  type PaymentsGateway,
} from './gateway.ts';

const NOW = new Date('2026-11-02T00:00:00Z');
const ACCOUNT_NUMBER = '12-3456-1234567-00';
const PAYEE_NAME = 'Quiet Badminton Club';

function input(amount: string, overrides: Record<string, unknown> = {}) {
  return {
    amount: parseMoney(amount),
    payee: { name: PAYEE_NAME, accountNumber: ACCOUNT_NUMBER },
    reference: 'SGM8H2K4N7Q',
    redirectUri: 'https://games.example.nz/payments/p1?return=1',
    webhookUri: 'https://api.example.nz/webhooks/akahu',
    expiresAt: new Date(NOW.getTime() + 30 * 60_000),
    ...overrides,
  };
}

function setup() {
  const clock = createManualClock(NOW);
  const control = createFakeControl();
  const { publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const gateway: PaymentsGateway = createFakePaymentsGateway({
    clock,
    control,
    webhookKeys: { 'fake-key': publicKey },
  });
  return { clock, control, gateway, publicKey };
}

async function createOk(gateway: PaymentsGateway, amount: string) {
  const result = await gateway.createPayment(input(amount));
  if (!result.ok) throw new Error('expected create to succeed');
  return result;
}

describe('fake PaymentsGateway (architecture Q1b)', () => {
  it('completes $17.00 as SUCCEEDED with the redirect as the authorisation URL', async () => {
    const { gateway } = setup();
    const created = await createOk(gateway, '17.00');
    expect(gateway.adapter).toBe('fake');
    expect(created.authorisationUrl).toBe('https://games.example.nz/payments/p1?return=1');
    expect(created.payment.amount).toBe(parseMoney('17.00'));
    const read = await gateway.getPayment(created.payment.providerPaymentId);
    expect(read).toMatchObject({
      providerStatus: 'SENT',
      providerStatusReason: null,
      outcome: { kind: 'SUCCEEDED' },
    });
  });

  it('derives declined, processing, indeterminate and cancelled outcomes from the amount', async () => {
    const { gateway } = setup();
    const expected: Array<[string, string, string | null, string]> = [
      ['5.15', 'FAILED', 'REJECTED', 'NOT_CHARGED'],
      ['5.03', 'FAILED', 'BANK_ERROR', 'NOT_CHARGED'],
      ['5.04', 'FAILED', 'BANK_ERROR_INDETERMINATE', 'INDETERMINATE'],
      ['5.20', 'SUBMITTED', null, 'OPEN'],
      ['5.30', 'CANCELLED', 'USER_CANCELLED', 'NOT_CHARGED'],
    ];
    for (const [amount, status, reason, kind] of expected) {
      const created = await createOk(gateway, amount);
      const read = await gateway.getPayment(created.payment.providerPaymentId);
      expect(read, amount).toMatchObject({
        providerStatus: status,
        providerStatusReason: reason,
        outcome: { kind },
      });
    }
  });

  it('is stateless across instances and answers not_found for unknown or malformed ids', async () => {
    const first = setup();
    const created = await createOk(first.gateway, '17.00');
    const second = createFakePaymentsGateway({ clock: first.clock });
    expect(await second.getPayment(created.payment.providerPaymentId)).toMatchObject({
      outcome: { kind: 'SUCCEEDED' },
    });
    expect(await second.getPayment('fake_ok_1700_notanumber_x')).toBe('not_found');
    expect(await second.getPayment('akahu_pay_123')).toBe('not_found');
  });

  it('records calls with the last four digits only, never the full number or the name', async () => {
    const { gateway, control } = setup();
    await createOk(gateway, '17.00');
    expect(control.calls).toHaveLength(1);
    const [call] = control.calls;
    expect(call).toMatchObject({
      amount: parseMoney('17.00'),
      reference: 'SGM8H2K4N7Q',
      redirectUri: 'https://games.example.nz/payments/p1?return=1',
      webhookUri: 'https://api.example.nz/webhooks/akahu',
      payeeAccountLast4: '6700',
    });
    expect(Object.keys(call ?? {}).sort()).toEqual([
      'amount',
      'payeeAccountLast4',
      'redirectUri',
      'reference',
      'webhookUri',
    ]);
    const serialised = JSON.stringify(control.calls, (_key, value: unknown) =>
      typeof value === 'bigint' ? value.toString() : value,
    );
    expect(serialised).not.toContain('1234567');
    expect(serialised).not.toContain(PAYEE_NAME);
  });

  it('injects create failures once (timeout, 5xx, network, refusal) and runs the beforeCreate probe first', async () => {
    const { gateway, control } = setup();
    const order: string[] = [];
    control.beforeCreate = (probed) => {
      order.push(`probe:${toMoneyString(probed.amount)}`);
    };
    for (const kind of ['timeout', '5xx', 'network'] as const) {
      control.failNextCreate(kind);
      expect(await gateway.createPayment(input('17.00'))).toEqual({
        ok: false,
        kind: 'unavailable',
      });
    }
    control.failNextCreate({ refused: 'invalid_payee' });
    expect(await gateway.createPayment(input('17.00'))).toEqual({
      ok: false,
      kind: 'refused',
      providerCode: 'invalid_payee',
    });
    expect((await gateway.createPayment(input('17.00'))).ok).toBe(true);
    expect(order).toHaveLength(5);
    expect(control.calls).toHaveLength(1);
  });

  it('scripts get results and failures per id, and resolves only configured webhook keys', async () => {
    const { gateway, control, publicKey } = setup();
    const created = await createOk(gateway, '17.00');
    const id = created.payment.providerPaymentId;
    const amount: Money = created.payment.amount;
    control.scriptGet(id, [
      { providerStatus: 'READY', providerStatusReason: null },
      { providerStatus: 'FAILED', providerStatusReason: 'BANK_ERROR_INDETERMINATE' },
    ]);
    expect(await gateway.getPayment(id)).toMatchObject({
      providerStatus: 'READY',
      amount,
      outcome: { kind: 'OPEN', phase: 'AWAITING_PAYER' },
    });
    expect(await gateway.getPayment(id)).toMatchObject({ outcome: { kind: 'INDETERMINATE' } });
    expect(await gateway.getPayment(id)).toMatchObject({ outcome: { kind: 'INDETERMINATE' } });
    control.failNextGet('5xx');
    await expect(gateway.getPayment(id)).rejects.toBeInstanceOf(GatewayUnavailableError);
    expect(await gateway.webhookKeys.resolve('fake-key')).toBe(publicKey);
    expect(await gateway.webhookKeys.resolve('other')).toBe('unknown');
  });
});

describe('createPaymentsGateway (CR-12, AC-VERIFY-8)', () => {
  const fakeConfig: PaymentsConfig = {
    adapter: 'fake',
    akahu: null,
    paymentExpiryMinutes: 30,
    reconcileOrphanAgeSeconds: 120,
    reconcileMinAgeSeconds: 300,
    reconcileStuckAfterSeconds: 21600,
    finalityHorizonHours: 168,
  };

  it('builds the fake outside production and refuses the fake in production and akahu in this build', () => {
    expect(createPaymentsGateway(fakeConfig, { nodeEnv: 'test' }).adapter).toBe('fake');
    expect(() => createPaymentsGateway(fakeConfig, { nodeEnv: 'production' })).toThrow(
      GatewayConfigurationError,
    );
    expect(() => createPaymentsGateway({ ...fakeConfig, adapter: 'akahu' })).toThrow(
      'PAYMENTS_ADAPTER=akahu is not available in this build',
    );
  });
});
