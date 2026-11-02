/**
 * Stateless, id-encoded fake `PaymentsGateway` (architecture Q1b). The API and the worker are separate processes, so
 * the outcome is derived from the provider payment id and the injected clock, never from memory:
 * `fake_<scenario>_<amountCents>_<createdAtMs>_<rand>`. Scenario follows Akahu's Demo Bank amounts. An in-process
 * `FakeControl` overlay (tests only) scripts results, injects failures and records calls.
 * Recorded calls never hold the payee name or the full account number (`payeeAccountLast4` only).
 */
import { randomBytes, type KeyObject } from 'node:crypto';
import { moneyFromCents, toCents, type Money } from '@sgm/shared';
import { systemClock, type Clock } from '../clock.ts';
import {
  GatewayUnavailableError,
  type CreatePaymentInput,
  type CreatePaymentResult,
  type CreateRefusalCode,
  type PaymentsGateway,
  type ProviderPayment,
} from './gateway.ts';
import { mapAkahuStatus } from './status.ts';

export interface RecordedCreateCall {
  readonly amount: Money;
  readonly reference: string;
  readonly redirectUri: string;
  readonly webhookUri: string;
  readonly payeeAccountLast4: string;
}

export type FakeFailure = 'timeout' | '5xx' | 'network';

export interface ScriptedStatus {
  readonly providerStatus: string;
  readonly providerStatusReason: string | null;
}

export interface FakeControl {
  readonly calls: readonly RecordedCreateCall[];
  /** Runs before every create, ahead of any injected failure (proves "no lock held during create"). */
  beforeCreate: ((input: CreatePaymentInput) => void | Promise<void>) | null;
  failNextCreate(failure: FakeFailure | { readonly refused: CreateRefusalCode }): void;
  failNextGet(failure: FakeFailure): void;
  /** Successive `getPayment` answers for an id; the last one repeats. */
  scriptGet(providerPaymentId: string, results: readonly ScriptedStatus[]): void;
  reset(): void;
}

interface ControlInternals {
  readonly calls: RecordedCreateCall[];
  readonly scripts: Map<string, ScriptedStatus[]>;
  takeCreateFailure(): FakeFailure | { readonly refused: CreateRefusalCode } | null;
  takeGetFailure(): FakeFailure | null;
}
const controlInternals = new WeakMap<FakeControl, ControlInternals>();

export function createFakeControl(): FakeControl {
  const calls: RecordedCreateCall[] = [];
  const scripts = new Map<string, ScriptedStatus[]>();
  let createFailure: FakeFailure | { readonly refused: CreateRefusalCode } | null = null;
  let getFailure: FakeFailure | null = null;
  const control = {
    get calls() {
      return calls;
    },
    beforeCreate: null as FakeControl['beforeCreate'],
    failNextCreate: (failure: FakeFailure | { readonly refused: CreateRefusalCode }) => {
      createFailure = failure;
    },
    failNextGet: (failure: FakeFailure) => {
      getFailure = failure;
    },
    scriptGet: (id: string, results: readonly ScriptedStatus[]) => {
      scripts.set(id, [...results]);
    },
    reset: () => {
      calls.length = 0;
      scripts.clear();
      createFailure = null;
      getFailure = null;
      control.beforeCreate = null;
    },
  };
  // Internal hooks the adapter uses; not part of the public `FakeControl` surface.
  controlInternals.set(control, {
    calls,
    scripts,
    takeCreateFailure: () => {
      const failure = createFailure;
      createFailure = null;
      return failure;
    },
    takeGetFailure: () => {
      const failure = getFailure;
      getFailure = null;
      return failure;
    },
  });
  return control;
}

const SCENARIO_BY_CENTS: Readonly<Record<string, string>> = {
  '503': 'be',
  '504': 'bei',
  '515': 'rej',
  '520': 'proc',
  '530': 'can',
};

const SCENARIO_STATUS: Readonly<Record<string, ScriptedStatus>> = {
  ok: { providerStatus: 'SENT', providerStatusReason: null },
  be: { providerStatus: 'FAILED', providerStatusReason: 'BANK_ERROR' },
  bei: { providerStatus: 'FAILED', providerStatusReason: 'BANK_ERROR_INDETERMINATE' },
  rej: { providerStatus: 'FAILED', providerStatusReason: 'REJECTED' },
  proc: { providerStatus: 'SUBMITTED', providerStatusReason: null },
  can: { providerStatus: 'CANCELLED', providerStatusReason: 'USER_CANCELLED' },
};

const ID_PATTERN = /^fake_([a-z]+)_(\d{1,10})_(\d{1,15})_([a-z0-9]{4,32})$/;

function parseFakeId(id: string): { scenario: string; cents: bigint; createdAtMs: number } | null {
  const match = ID_PATTERN.exec(id);
  if (match === null) return null;
  const [, scenario = '', cents = '', createdAt = ''] = match;
  if (!Object.hasOwn(SCENARIO_STATUS, scenario)) return null;
  return { scenario, cents: BigInt(cents), createdAtMs: Number(createdAt) };
}

export interface FakeGatewayOptions {
  readonly clock?: Clock;
  readonly control?: FakeControl;
  /** Static signing keys for the webhook key resolver, by key id. */
  readonly webhookKeys?: Readonly<Record<string, KeyObject>>;
}

function last4Digits(accountNumber: string): string {
  return accountNumber.replace(/\D/g, '').slice(-4);
}

export function createFakePaymentsGateway(options: FakeGatewayOptions = {}): PaymentsGateway {
  const clock = options.clock ?? systemClock;
  const internals = options.control ? controlInternals.get(options.control) : undefined;
  const keys = options.webhookKeys ?? {};

  const toProviderPayment = (
    id: string,
    amount: Money,
    status: ScriptedStatus,
  ): ProviderPayment => ({
    providerPaymentId: id,
    amount,
    providerStatus: status.providerStatus,
    providerStatusReason: status.providerStatusReason,
    outcome: mapAkahuStatus(status.providerStatus, status.providerStatusReason),
  });

  const readPayment = (providerPaymentId: string): ProviderPayment | 'not_found' => {
    const failure = internals?.takeGetFailure() ?? null;
    if (failure !== null) throw new GatewayUnavailableError('provider_unavailable');
    const parsed = parseFakeId(providerPaymentId);
    if (parsed === null) return 'not_found';
    const amount = moneyFromCents(parsed.cents);
    const script = internals?.scripts.get(providerPaymentId);
    if (script !== undefined && script.length > 0) {
      const next = script.length > 1 ? script.shift() : script[0];
      if (next !== undefined) return toProviderPayment(providerPaymentId, amount, next);
    }
    const status =
      clock.now().getTime() < parsed.createdAtMs
        ? { providerStatus: 'READY', providerStatusReason: null }
        : SCENARIO_STATUS[parsed.scenario];
    return status === undefined
      ? 'not_found'
      : toProviderPayment(providerPaymentId, amount, status);
  };

  return {
    adapter: 'fake',

    async createPayment(input): Promise<CreatePaymentResult> {
      await options.control?.beforeCreate?.(input);
      const failure = internals?.takeCreateFailure() ?? null;
      if (failure !== null) {
        return typeof failure === 'string'
          ? { ok: false, kind: 'unavailable' }
          : { ok: false, kind: 'refused', providerCode: failure.refused };
      }
      const cents = toCents(input.amount);
      const scenario = SCENARIO_BY_CENTS[String(cents)] ?? 'ok';
      const id = `fake_${scenario}_${cents}_${clock.now().getTime()}_${randomBytes(4).toString('hex')}`;
      internals?.calls.push({
        amount: input.amount,
        reference: input.reference,
        redirectUri: input.redirectUri,
        webhookUri: input.webhookUri,
        payeeAccountLast4: last4Digits(input.payee.accountNumber),
      });
      return {
        ok: true,
        // The consent step is "approved instantly": the payer is sent straight back.
        authorisationUrl: input.redirectUri,
        payment: toProviderPayment(id, input.amount, {
          providerStatus: 'READY',
          providerStatusReason: null,
        }),
      };
    },

    getPayment: (providerPaymentId) => Promise.resolve().then(() => readPayment(providerPaymentId)),

    cancelPayment(providerPaymentId) {
      const head = internals?.scripts.get(providerPaymentId)?.[0];
      return Promise.resolve(head?.providerStatus === 'READY' ? 'cancelled' : 'not_cancellable');
    },

    webhookKeys: {
      resolve(keyId) {
        return Promise.resolve(Object.hasOwn(keys, keyId) ? (keys[keyId] ?? 'unknown') : 'unknown');
      },
    },
  };
}
